import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createHmac } from 'node:crypto';
import { telegram, deriveTelegramSecretToken } from '../channels/adapters/telegram';
import { slack } from '../channels/adapters/slack';
import type { WebhookRequest } from '../channels/types';

function req(body: unknown, headers: Record<string, string> = {}): WebhookRequest {
  return {
    rawBody: typeof body === 'string' ? body : JSON.stringify(body),
    headers: new Headers(headers),
    url: 'https://app.example.com/channels/test',
  };
}

// ── Telegram ──

describe('telegram adapter', () => {
  const adapter = telegram({ botToken: '123:abc', secretToken: 's3cret' });

  test('verify rejects missing/wrong secret token, accepts correct one', () => {
    expect(adapter.verify(req({}))).toBeInstanceOf(Response);
    expect(
      adapter.verify(req({}, { 'x-telegram-bot-api-secret-token': 'wrong' })),
    ).toBeInstanceOf(Response);
    expect(
      adapter.verify(req({}, { 'x-telegram-bot-api-secret-token': 's3cret' })),
    ).toBe('ok');
  });

  test('parse normalizes a text message', async () => {
    const events = await adapter.parse(
      req({
        update_id: 42,
        message: {
          message_id: 7,
          text: 'hello there',
          chat: { id: 555 },
          from: { id: 99, is_bot: false, username: 'dani' },
        },
      }),
    );
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.provider).toBe('telegram');
    expect(ev.conversationId).toBe('555');
    expect(ev.externalUserId).toBe('99');
    expect(ev.userDisplayName).toBe('dani');
    expect(ev.text).toBe('hello there');
    expect(ev.dedupeKey).toBe('telegram:42');
  });

  test('parse drops bot echoes, non-text updates, and junk bodies', async () => {
    expect(
      await adapter.parse(
        req({ update_id: 1, message: { text: 'x', chat: { id: 1 }, from: { is_bot: true } } }),
      ),
    ).toHaveLength(0);
    expect(
      await adapter.parse(req({ update_id: 2, message: { chat: { id: 1 }, from: {} } })),
    ).toHaveLength(0);
    expect(await adapter.parse(req({ update_id: 3 }))).toHaveLength(0);
    expect(await adapter.parse(req('not json'))).toHaveLength(0);
  });

  test('constructor requires botToken; secretToken is derived when absent', () => {
    expect(() => telegram({ botToken: '' })).toThrow();

    const derived = deriveTelegramSecretToken('123:abc');
    expect(derived).toHaveLength(32);
    // Deterministic: same token → same secret across restarts.
    expect(deriveTelegramSecretToken('123:abc')).toBe(derived);

    const noExplicit = telegram({ botToken: '123:abc' });
    expect(
      noExplicit.verify(req({}, { 'x-telegram-bot-api-secret-token': derived })),
    ).toBe('ok');
    expect(noExplicit.verify(req({}))).toBeInstanceOf(Response);
  });
});

describe('telegram delivery + registerWebhook (mocked API)', () => {
  const originalFetch = globalThis.fetch;
  let requests: { url: string; body: Record<string, unknown> }[] = [];
  let nextResponses: unknown[] = [];

  beforeEach(() => {
    requests = [];
    nextResponses = [];
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      const payload = nextResponses.shift() ?? { ok: true, result: {} };
      return new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const adapter = telegram({
    botToken: '123:abc',
    secretToken: 's3cret',
    apiBase: 'https://tg.test',
  });
  const event = {
    provider: 'telegram',
    conversationId: '555',
    text: 'hi',
    raw: {},
  };

  test('send posts sendMessage and returns the message_id ref', async () => {
    nextResponses.push({ ok: true, result: { message_id: 88 } });
    const delivery = adapter.delivery(event);
    const ref = await delivery.send('hello');
    expect(ref).toBe(88);
    expect(requests[0]!.url).toBe('https://tg.test/bot123:abc/sendMessage');
    expect(requests[0]!.body).toEqual({ chat_id: '555', text: 'hello' });
  });

  test('edit posts editMessageText and tolerates "message is not modified"', async () => {
    const delivery = adapter.delivery(event);
    await delivery.edit!(88, 'updated');
    expect(requests[0]!.url).toBe('https://tg.test/bot123:abc/editMessageText');
    expect(requests[0]!.body).toEqual({ chat_id: '555', message_id: 88, text: 'updated' });

    nextResponses.push({ ok: false, description: 'Bad Request: message is not modified' });
    await delivery.edit!(88, 'updated'); // must not throw
  });

  test('registerWebhook calls setWebhook with url + secret', async () => {
    await adapter.registerWebhook!('https://app.example.com/channels/telegram');
    expect(requests[0]!.url).toBe('https://tg.test/bot123:abc/setWebhook');
    expect(requests[0]!.body).toEqual({
      url: 'https://app.example.com/channels/telegram',
      secret_token: 's3cret',
      allowed_updates: ['message'],
    });
  });

  test('API errors surface with method and description', async () => {
    nextResponses.push({ ok: false, description: 'chat not found' });
    const delivery = adapter.delivery(event);
    expect(delivery.send('x')).rejects.toThrow(/sendMessage.*chat not found/);
  });
});

// ── Slack ──

const SIGNING_SECRET = 'test-signing-secret';

function signedSlackReq(body: unknown, atMs: number, secret = SIGNING_SECRET): WebhookRequest {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = String(Math.floor(atMs / 1000));
  const signature = `v0=${createHmac('sha256', secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex')}`;
  return req(rawBody, {
    'x-slack-request-timestamp': timestamp,
    'x-slack-signature': signature,
  });
}

describe('slack adapter', () => {
  const NOW = 1_700_000_000_000;
  const adapter = slack({
    signingSecret: SIGNING_SECRET,
    botToken: 'xoxb-test',
    now: () => NOW,
  });

  test('verify accepts a valid signature', async () => {
    expect(await adapter.verify(signedSlackReq({ type: 'event_callback' }, NOW))).toBe('ok');
  });

  test('verify rejects bad signature, missing headers, and stale timestamps', async () => {
    const forged = signedSlackReq({ type: 'event_callback' }, NOW, 'wrong-secret');
    expect(await adapter.verify(forged)).toBeInstanceOf(Response);
    expect(((await adapter.verify(forged)) as Response).status).toBe(401);

    expect(await adapter.verify(req({ type: 'event_callback' }))).toBeInstanceOf(Response);

    const stale = signedSlackReq({ type: 'event_callback' }, NOW - 10 * 60_000);
    expect(await adapter.verify(stale)).toBeInstanceOf(Response);
  });

  test('verify answers url_verification with the challenge', async () => {
    const verdict = await adapter.verify(
      signedSlackReq({ type: 'url_verification', challenge: 'chal-123' }, NOW),
    );
    expect(verdict).toBeInstanceOf(Response);
    const body = await (verdict as Response).json();
    expect(body).toEqual({ challenge: 'chal-123' });
  });

  test('parse normalizes a message event and strips the leading mention', async () => {
    const events = await adapter.parse(
      req({
        type: 'event_callback',
        event_id: 'Ev123',
        event: {
          type: 'app_mention',
          text: '<@U0BOT> what is our refund policy?',
          user: 'U0USER',
          channel: 'C0CHAN',
          ts: '1700000000.000100',
        },
      }),
    );
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.text).toBe('what is our refund policy?');
    expect(ev.conversationId).toBe('C0CHAN:1700000000.000100');
    expect(ev.externalUserId).toBe('U0USER');
    expect(ev.dedupeKey).toBe('slack:C0CHAN:1700000000.000100');
  });

  test('DM conversations key on the channel (memory across messages)', async () => {
    const dm = (ts: string) => ({
      type: 'event_callback',
      event: {
        type: 'message',
        channel_type: 'im',
        text: 'hey',
        user: 'U0USER',
        channel: 'D0DM',
        ts,
      },
    });
    const first = await adapter.parse(req(dm('1700000000.000100')));
    const second = await adapter.parse(req(dm('1700000005.000500')));
    // Same conversation across top-level DM messages — unlike channels.
    expect(first[0]!.conversationId).toBe('D0DM');
    expect(second[0]!.conversationId).toBe('D0DM');
  });

  test('a thread inside a DM is its own conversation', async () => {
    const events = await adapter.parse(
      req({
        type: 'event_callback',
        event: {
          type: 'message',
          channel_type: 'im',
          text: 'threaded follow-up',
          user: 'U0USER',
          channel: 'D0DM',
          ts: '1700000009.000900',
          thread_ts: '1700000000.000100',
        },
      }),
    );
    expect(events[0]!.conversationId).toBe('D0DM:1700000000.000100');
  });

  test('thread replies key the conversation on thread_ts', async () => {
    const events = await adapter.parse(
      req({
        type: 'event_callback',
        event: {
          type: 'message',
          text: 'follow-up',
          user: 'U0USER',
          channel: 'C0CHAN',
          ts: '1700000002.000200',
          thread_ts: '1700000000.000100',
        },
      }),
    );
    expect(events[0]!.conversationId).toBe('C0CHAN:1700000000.000100');
  });

  test('parse drops bot messages, subtypes, and non-event payloads', async () => {
    expect(
      await adapter.parse(
        req({
          type: 'event_callback',
          event: { type: 'message', text: 'x', channel: 'C', ts: '1', bot_id: 'B1' },
        }),
      ),
    ).toHaveLength(0);
    expect(
      await adapter.parse(
        req({
          type: 'event_callback',
          event: { type: 'message', subtype: 'message_changed', text: 'x', channel: 'C', ts: '1' },
        }),
      ),
    ).toHaveLength(0);
    expect(await adapter.parse(req({ type: 'url_verification' }))).toHaveLength(0);
    expect(await adapter.parse(req('junk'))).toHaveLength(0);
  });
});

describe('slack delivery (mocked API)', () => {
  const originalFetch = globalThis.fetch;
  let requests: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];

  beforeEach(() => {
    requests = [];
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        auth: new Headers(init?.headers).get('Authorization'),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({ ok: true, channel: 'C0CHAN', ts: '1700000009.000900' }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const adapter = slack({
    signingSecret: SIGNING_SECRET,
    botToken: 'xoxb-test',
    apiBase: 'https://slack.test/api',
  });

  const event = {
    provider: 'slack',
    conversationId: 'C0CHAN:1700000000.000100',
    text: 'hi',
    raw: {
      event: { channel: 'C0CHAN', ts: '1700000000.000100' },
    },
  };

  test('send posts chat.postMessage in-thread and returns {channel, ts}', async () => {
    const delivery = adapter.delivery(event);
    const ref = await delivery.send('answer');
    expect(requests[0]!.url).toBe('https://slack.test/api/chat.postMessage');
    expect(requests[0]!.auth).toBe('Bearer xoxb-test');
    expect(requests[0]!.body).toEqual({
      channel: 'C0CHAN',
      text: 'answer',
      thread_ts: '1700000000.000100',
    });
    expect(ref).toEqual({ channel: 'C0CHAN', ts: '1700000009.000900' });
  });

  test('edit posts chat.update against the ref', async () => {
    const delivery = adapter.delivery(event);
    await delivery.edit!({ channel: 'C0CHAN', ts: '1700000009.000900' }, 'longer answer');
    expect(requests[0]!.url).toBe('https://slack.test/api/chat.update');
    expect(requests[0]!.body).toEqual({
      channel: 'C0CHAN',
      ts: '1700000009.000900',
      text: 'longer answer',
    });
  });

  test('DMs reply top-level (no thread_ts)', async () => {
    const dmEvent = {
      provider: 'slack',
      conversationId: 'D0DM',
      text: 'hey',
      raw: {
        event: { channel: 'D0DM', channel_type: 'im', ts: '1700000000.000100' },
      },
    };
    await adapter.delivery(dmEvent).send('answer');
    expect(requests[0]!.body).toEqual({ channel: 'D0DM', text: 'answer' });
  });

  test('a DM thread keeps the reply in that thread', async () => {
    const dmThreadEvent = {
      provider: 'slack',
      conversationId: 'D0DM:1700000000.000100',
      text: 'hey',
      raw: {
        event: {
          channel: 'D0DM',
          channel_type: 'im',
          ts: '1700000009.000900',
          thread_ts: '1700000000.000100',
        },
      },
    };
    await adapter.delivery(dmThreadEvent).send('answer');
    expect(requests[0]!.body).toEqual({
      channel: 'D0DM',
      text: 'answer',
      thread_ts: '1700000000.000100',
    });
  });

  test('replyInThread: false posts top-level', async () => {
    const flat = slack({
      signingSecret: SIGNING_SECRET,
      botToken: 'xoxb-test',
      apiBase: 'https://slack.test/api',
      replyInThread: false,
    });
    await flat.delivery(event).send('answer');
    expect(requests[0]!.body).toEqual({ channel: 'C0CHAN', text: 'answer' });
  });
});
