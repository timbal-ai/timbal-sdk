import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createHmac } from 'node:crypto';
import { telegram, deriveTelegramSecretToken } from '../channels/adapters/telegram';
import { slack } from '../channels/adapters/slack';
import { whatsapp } from '../channels/adapters/whatsapp';
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

  test('parse drops bot echoes, contentless updates, and junk bodies', async () => {
    expect(
      await adapter.parse(
        req({ update_id: 1, message: { text: 'x', chat: { id: 1 }, from: { is_bot: true } } }),
      ),
    ).toHaveLength(0);
    // No text, no media (sticker/join/etc. subset) → nothing to act on.
    expect(
      await adapter.parse(req({ update_id: 2, message: { chat: { id: 1 }, from: {} } })),
    ).toHaveLength(0);
    expect(await adapter.parse(req({ update_id: 3 }))).toHaveLength(0);
    expect(await adapter.parse(req('not json'))).toHaveLength(0);
  });

  test('parse normalizes a photo message: caption as text, largest size, jpeg', async () => {
    const events = await adapter.parse(
      req({
        update_id: 43,
        message: {
          message_id: 8,
          caption: 'what is this?',
          chat: { id: 555 },
          from: { id: 99, is_bot: false, username: 'dani' },
          photo: [
            { file_id: 'small', file_unique_id: 'u1', file_size: 100 },
            { file_id: 'large', file_unique_id: 'u1', file_size: 9000 },
          ],
        },
      }),
    );
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.text).toBe('what is this?');
    expect(ev.attachments).toHaveLength(1);
    const att = ev.attachments![0]!;
    expect(att.kind).toBe('image');
    expect(att.fileName).toBe('photo_u1.jpg');
    expect(att.contentType).toBe('image/jpeg');
    expect(att.sizeBytes).toBe(9000);
  });

  test('parse keeps a bare photo (no caption) with empty text', async () => {
    const events = await adapter.parse(
      req({
        update_id: 44,
        message: {
          chat: { id: 555 },
          from: { id: 99 },
          photo: [{ file_id: 'f1', file_unique_id: 'u2' }],
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toBe('');
    expect(events[0]!.attachments).toHaveLength(1);
  });

  test('parse normalizes a document: name + mime, image mime → image kind', async () => {
    const pdf = await adapter.parse(
      req({
        update_id: 45,
        message: {
          chat: { id: 555 },
          from: { id: 99 },
          caption: 'read this',
          document: {
            file_id: 'doc1',
            file_unique_id: 'ud1',
            file_name: 'report.pdf',
            mime_type: 'application/pdf',
            file_size: 12345,
          },
        },
      }),
    );
    const att = pdf[0]!.attachments![0]!;
    expect(att.kind).toBe('document');
    expect(att.fileName).toBe('report.pdf');
    expect(att.contentType).toBe('application/pdf');
    expect(att.sizeBytes).toBe(12345);

    // Uncompressed image sent "as file" still classifies as image.
    const img = await adapter.parse(
      req({
        update_id: 46,
        message: {
          chat: { id: 555 },
          from: { id: 99 },
          document: { file_id: 'doc2', file_name: 'shot.png', mime_type: 'image/png' },
        },
      }),
    );
    expect(img[0]!.attachments![0]!.kind).toBe('image');
  });

  test('text-only events carry no attachments field', async () => {
    const events = await adapter.parse(
      req({
        update_id: 47,
        message: { text: 'plain', chat: { id: 555 }, from: { id: 99 } },
      }),
    );
    expect(events[0]!.attachments).toBeUndefined();
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

  test('delete posts deleteMessage against the ref', async () => {
    const delivery = adapter.delivery(event);
    await delivery.delete!(88);
    expect(requests[0]!.url).toBe('https://tg.test/bot123:abc/deleteMessage');
    expect(requests[0]!.body).toEqual({ chat_id: '555', message_id: 88 });

    await delivery.delete!(null); // no ref — no API call
    expect(requests).toHaveLength(1);
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

describe('telegram sendFile (mocked API)', () => {
  const originalFetch = globalThis.fetch;
  /** JSON calls record the parsed body; multipart calls record the FormData. */
  let calls: { url: string; json?: Record<string, unknown>; form?: FormData }[] = [];
  let failOnce: string | null = null;

  beforeEach(() => {
    calls = [];
    failOnce = null;
    globalThis.fetch = (async (url: string | Request, init?: RequestInit) => {
      const u = String(url);
      const entry: (typeof calls)[number] = { url: u };
      if (init?.body instanceof FormData) entry.form = init.body;
      else entry.json = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push(entry);
      if (failOnce && u.endsWith(failOnce)) {
        failOnce = null;
        return new Response(JSON.stringify({ ok: false, description: 'PHOTO_INVALID_DIMENSIONS' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
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
  const delivery = () =>
    adapter.delivery({ provider: 'telegram', conversationId: '555', text: '', raw: {} });

  test('image URL goes out as sendPhoto with the URL passed through', async () => {
    const ref = await delivery().sendFile!('https://cdn.test/chart.png');
    expect(ref).toBe(77);
    expect(calls[0]!.url).toBe('https://tg.test/bot123:abc/sendPhoto');
    expect(calls[0]!.json).toEqual({ chat_id: '555', photo: 'https://cdn.test/chart.png' });
  });

  test('non-image URL goes out as sendDocument', async () => {
    await delivery().sendFile!('https://cdn.test/report.pdf', { fileName: 'report.pdf' });
    expect(calls[0]!.url).toBe('https://tg.test/bot123:abc/sendDocument');
    expect(calls[0]!.json).toEqual({ chat_id: '555', document: 'https://cdn.test/report.pdf' });
  });

  test('fileName drives photo/document choice when the URL has no extension', async () => {
    await delivery().sendFile!('https://cdn.test/f/abc123', { fileName: 'pic.jpg' });
    expect(calls[0]!.url).toBe('https://tg.test/bot123:abc/sendPhoto');
  });

  test('data URL uploads bytes as multipart', async () => {
    const b64 = Buffer.from([1, 2, 3]).toString('base64');
    await delivery().sendFile!(`data:image/png;base64,${b64}`, { fileName: 'gen.png' });
    expect(calls[0]!.url).toBe('https://tg.test/bot123:abc/sendPhoto');
    const form = calls[0]!.form!;
    expect(form.get('chat_id')).toBe('555');
    const blob = form.get('photo') as globalThis.File;
    expect(blob.name).toBe('gen.png');
    expect(blob.type).toBe('image/png');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('rejected sendPhoto falls back to sendDocument', async () => {
    failOnce = '/sendPhoto';
    const ref = await delivery().sendFile!('https://cdn.test/huge.png');
    expect(ref).toBe(77);
    expect(calls.map((c) => c.url.split('/').pop())).toEqual(['sendPhoto', 'sendDocument']);
    expect(calls[1]!.json).toEqual({ chat_id: '555', document: 'https://cdn.test/huge.png' });
  });

  test('document failures propagate (no infinite fallback)', async () => {
    failOnce = '/sendDocument';
    expect(delivery().sendFile!('https://cdn.test/report.pdf')).rejects.toThrow(/sendDocument/);
  });
});

describe('telegram attachment download (mocked API)', () => {
  const originalFetch = globalThis.fetch;
  let requests: string[] = [];

  const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x00]); // JPEG-ish

  beforeEach(() => {
    requests = [];
    globalThis.fetch = (async (url: string | Request) => {
      const u = String(url);
      requests.push(u);
      if (u.includes('/getFile')) {
        return new Response(
          JSON.stringify({ ok: true, result: { file_path: 'photos/file_9.jpg' } }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }
      // The file-path download endpoint serves raw bytes.
      return new Response(BYTES, { headers: { 'Content-Type': 'image/jpeg' } });
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

  async function photoAttachment() {
    const events = await adapter.parse(
      req(
        {
          update_id: 50,
          message: {
            chat: { id: 555 },
            from: { id: 99 },
            photo: [{ file_id: 'f-large', file_unique_id: 'u9' }],
          },
        },
        { 'x-telegram-bot-api-secret-token': 's3cret' },
      ),
    );
    return events[0]!.attachments![0]!;
  }

  test('download exchanges file_id via getFile and fetches the file path', async () => {
    const att = await photoAttachment();
    const { data, contentType, fileName } = await att.download();
    expect(requests[0]).toBe('https://tg.test/bot123:abc/getFile');
    expect(requests[1]).toBe('https://tg.test/file/bot123:abc/photos/file_9.jpg');
    expect(data).toEqual(BYTES);
    expect(contentType).toBe('image/jpeg');
    expect(fileName).toBe('photo_u9.jpg');
  });

  test('download surfaces a missing file_path as an error', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, result: {} }), {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const att = await photoAttachment();
    expect(att.download()).rejects.toThrow(/file_path/);
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

// ── WhatsApp ──

const WA_APP_SECRET = 'wa-app-secret';
const WA_VERIFY_TOKEN = 'timbal-wa-verify';
const WA_PHONE_ID = '100000000000001';
const WA_WABA_ID = '200000000000001';
const WA_USER = '15550001111';
const WA_DISPLAY = '15550009999';

function signedWhatsAppReq(
  body: unknown,
  secret = WA_APP_SECRET,
  url = 'https://app.example.com/channels/joi/whatsapp',
): WebhookRequest {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const signature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return {
    rawBody,
    headers: new Headers({ 'x-hub-signature-256': signature }),
    url,
    method: 'POST',
  };
}

function waTextEnvelope(opts: {
  from?: string;
  body?: string;
  messageId?: string;
  phoneNumberId?: string;
  contactName?: string;
} = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WA_WABA_ID,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: WA_DISPLAY,
                phone_number_id: opts.phoneNumberId ?? WA_PHONE_ID,
              },
              contacts: [
                {
                  profile: { name: opts.contactName ?? 'Dani' },
                  wa_id: opts.from ?? WA_USER,
                },
              ],
              messages: [
                {
                  from: opts.from ?? WA_USER,
                  id: opts.messageId ?? 'wamid.TEST',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: opts.body ?? 'hola' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('whatsapp adapter', () => {
  const adapter = whatsapp({
    accessToken: 'tok',
    phoneNumberId: WA_PHONE_ID,
    appSecret: WA_APP_SECRET,
    verifyToken: WA_VERIFY_TOKEN,
  });

  test('verify answers the hub challenge on GET', async () => {
    const challengeReq: WebhookRequest = {
      rawBody: '',
      headers: new Headers(),
      url: `https://app.example.com/channels/joi/whatsapp?hub.mode=subscribe&hub.verify_token=${WA_VERIFY_TOKEN}&hub.challenge=12345`,
      method: 'GET',
    };
    const verdict = adapter.verify(challengeReq);
    expect(verdict).toBeInstanceOf(Response);
    expect((verdict as Response).status).toBe(200);
    expect(await (verdict as Response).text()).toBe('12345');
  });

  test('verify rejects a wrong hub verify token', () => {
    const challengeReq: WebhookRequest = {
      rawBody: '',
      headers: new Headers(),
      url: `https://app.example.com/channels/joi/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`,
      method: 'GET',
    };
    const verdict = adapter.verify(challengeReq);
    expect(verdict).toBeInstanceOf(Response);
    expect((verdict as Response).status).toBe(403);
  });

  test('verify accepts a valid signature and rejects bad/missing ones', () => {
    expect(adapter.verify(signedWhatsAppReq(waTextEnvelope()))).toBe('ok');

    const forged = signedWhatsAppReq(waTextEnvelope(), 'wrong-secret');
    expect(adapter.verify(forged)).toBeInstanceOf(Response);
    expect((adapter.verify(forged) as Response).status).toBe(401);

    expect(adapter.verify(req(waTextEnvelope()))).toBeInstanceOf(Response);
  });

  test('verify does not treat sticky hub.* query params on POST as a challenge', () => {
    const sticky =
      `https://app.example.com/channels/joi/whatsapp` +
      `?hub.mode=subscribe&hub.verify_token=${WA_VERIFY_TOKEN}&hub.challenge=stale`;
    // Would previously echo "stale" / 403 and never reach signature checks.
    expect(adapter.verify(signedWhatsAppReq(waTextEnvelope(), WA_APP_SECRET, sticky))).toBe(
      'ok',
    );
  });

  test('parse normalizes a text message', () => {
    const events = adapter.parse(signedWhatsAppReq(waTextEnvelope({ body: 'refund?' })));
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.provider).toBe('whatsapp');
    expect(ev.conversationId).toBe(WA_USER);
    expect(ev.externalUserId).toBe(WA_USER);
    expect(ev.userDisplayName).toBe('Dani');
    expect(ev.text).toBe('refund?');
    expect(ev.dedupeKey).toBe('whatsapp:wamid.TEST');
  });

  test('parse drops status callbacks, non-text, wrong phone id, and junk', () => {
    expect(
      adapter.parse(
        signedWhatsAppReq({
          object: 'whatsapp_business_account',
          entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'x' }] } }] }],
        }),
      ),
    ).toHaveLength(0);

    const imageOnly = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: WA_PHONE_ID },
                messages: [{ from: '1', id: 'wamid.IMG', type: 'image', image: {} }],
              },
            },
          ],
        },
      ],
    };
    expect(adapter.parse(signedWhatsAppReq(imageOnly))).toHaveLength(0);

    expect(adapter.parse(signedWhatsAppReq('not json'))).toHaveLength(0);
  });

  test('parse drops other phone ids only when expectedPhoneNumberId is set', () => {
    const strict = whatsapp({
      accessToken: 'tok',
      phoneNumberId: WA_PHONE_ID,
      appSecret: WA_APP_SECRET,
      verifyToken: WA_VERIFY_TOKEN,
      expectedPhoneNumberId: WA_PHONE_ID,
    });
    expect(
      strict.parse(signedWhatsAppReq(waTextEnvelope({ phoneNumberId: 'other-phone' }))),
    ).toHaveLength(0);
    expect(strict.parse(signedWhatsAppReq(waTextEnvelope()))).toHaveLength(1);
  });

  test('delivery posts to Graph messages endpoint', async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const event = adapter.parse(signedWhatsAppReq(waTextEnvelope()))[0]!;
      const ref = await adapter.delivery(event).send('hola de vuelta');
      expect(ref).toBe('wamid.OUT');
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toContain(`/${WA_PHONE_ID}/messages`);
      expect(requests[0]!.body).toEqual({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: WA_USER,
        type: 'text',
        text: { preview_url: false, body: 'hola de vuelta' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
