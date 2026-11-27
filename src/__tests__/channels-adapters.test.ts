import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createHmac } from 'node:crypto';
import { telegram, deriveTelegramSecretToken } from '../channels/adapters/telegram';
import { slack } from '../channels/adapters/slack';
import {
  PLATFORM_MAX_SKEW_SECONDS,
  PLATFORM_SIGNATURE_HEADER,
  PLATFORM_TIMESTAMP_HEADER,
  verifyPlatformForward,
  whatsapp,
} from '../channels/adapters/whatsapp';
import type { ChannelEvent, WebhookRequest } from '../channels/types';
import { Elysia } from 'elysia';
import { timbalChannels } from '../elysia/channels';
import { unsupportedAttachmentNote } from '../channels/attachments';
import type { Timbal } from '../lib/timbal';
import { SDK_VERSION } from '../constants';

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

interface RecordedCall {
  url: string;
  auth: string | null;
  redirect: RequestRedirect | undefined;
}

/** Replace `fetch` with `handler`, recording each call; returns the calls and a restore. */
function mockFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { calls: RecordedCall[]; restore: () => void } {
  const calls: RecordedCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      auth: new Headers(init?.headers).get('authorization'),
      redirect: init?.redirect,
    });
    return handler(url, init);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe('slack files', () => {
  const PDF_URL = 'https://files.slack.com/files-pri/T0TEAM-F0PDF/download/invoice.pdf';
  const PDF = {
    id: 'F0PDF',
    name: 'invoice.pdf',
    title: 'invoice',
    mimetype: 'application/pdf',
    filetype: 'pdf',
    size: 4,
    mode: 'hosted',
    is_external: false,
    url_private: 'https://files.slack.com/files-pri/T0TEAM-F0PDF/invoice.pdf',
    url_private_download: PDF_URL,
  };
  const PNG = {
    id: 'F0PNG',
    name: 'image.png',
    mimetype: 'image/png',
    size: 70,
    mode: 'hosted',
    url_private: 'https://files.slack.com/files-pri/T0TEAM-F0PNG/image.png',
  };
  const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF

  const adapter = slack({
    signingSecret: SIGNING_SECRET,
    botToken: 'xoxb-test',
    apiBase: 'https://slack.test/api',
  });

  function fileShare(files: unknown[], overrides: Record<string, unknown> = {}) {
    return req({
      type: 'event_callback',
      event: {
        type: 'message',
        subtype: 'file_share',
        text: 'what do these say?',
        user: 'U0USER',
        channel: 'C0CHAN',
        channel_type: 'channel',
        ts: '1700000000.000100',
        files,
        ...overrides,
      },
    });
  }

  function attachmentFor(file: unknown, a = adapter) {
    // Slack parses synchronously.
    return (a.parse(fileShare([file])) as ChannelEvent[])[0]!.attachments![0]!;
  }

  let restore = () => {};
  afterEach(() => {
    restore();
    restore = () => {};
  });

  // A Slack voice clip can be named `audio_message.mp4` and typed `video/mp4`.
  const CLIP = {
    ...PNG,
    id: 'F0CLIP',
    name: 'audio_message.mp4',
    mimetype: 'video/mp4',
    subtype: 'slack_audio',
    url_private_download: 'https://files.slack.com/files-pri/T0-F0CLIP/download/audio_message.mp4',
  };
  const VIDEO = {
    ...CLIP,
    id: 'F0VID',
    name: 'clip.mp4',
    subtype: undefined,
    url_private_download: 'https://files.slack.com/files-pri/T0-F0VID/download/clip.mp4',
  };

  test('a Slack voice clip is audio, even when typed as video; a video stays video', async () => {
    const [event] = await adapter.parse(fileShare([CLIP, VIDEO]));
    expect(event!.attachments!.map((a) => [a.kind, a.contentType])).toEqual([
      ['audio', 'audio/mp4'],
      ['video', 'video/mp4'],
    ]);
  });

  test('a Slack Connect voice clip is described as audio', async () => {
    const m = mockFetch(
      () =>
        new Response(JSON.stringify({ ok: true, file: CLIP }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    restore = m.restore;
    const stub = { id: 'F0CLIP', mode: 'file_access', file_access: 'check_file_info' };
    expect((await attachmentFor(stub).describe!()).contentType).toBe('audio/mp4');
  });

  /** The default channel pipeline, with Slack in front and a fake Timbal client. */
  function slackPipeline() {
    const invocations: Record<string, unknown>[] = [];
    const uploads: string[] = [];
    const transcriptions: { filename: string; contentType: string }[] = [];
    const timbal = {
      workforce: {
        get: () => ({
          async *events(input: Record<string, unknown>) {
            invocations.push(input);
            yield { type: 'delta', delta: 'ok' };
          },
        }),
      },
      async uploadTempFileFromBuffer(_data: Uint8Array, filename: string) {
        uploads.push(filename);
        return { url: `https://cdn.test/tmp/${filename}` };
      },
      async transcribeAudio(_data: Uint8Array, filename: string, contentType: string) {
        transcriptions.push({ filename, contentType });
        return { text: 'the spoken words' };
      },
    } as unknown as Timbal;
    const adapter = slack({
      signingSecret: SIGNING_SECRET,
      botToken: 'xoxb-test',
      apiBase: 'https://slack.test/api',
      now: () => Date.now(),
    });
    const app = new Elysia().use(timbalChannels({ timbal, bindings: [{ adapter, workforce: 'a' }] }));
    const post = async (files: unknown[]) => {
      const signed = signedSlackReq(
        { type: 'event_callback', event_id: 'Ev1', event: { type: 'message', subtype: 'file_share', text: '', user: 'U0USER', channel: 'D0DM', channel_type: 'im', ts: '1700000000.000100', files } },
        Date.now(),
      );
      await app.handle(
        new Request('http://localhost/channels/a/slack', {
          method: 'POST',
          headers: signed.headers,
          body: signed.rawBody,
        }),
      );
      await new Promise((r) => setTimeout(r, 50));
    };
    return { post, invocations, uploads, transcriptions };
  }

  test('through the webhook, a voice clip is transcribed; a video gets the unsupported note', async () => {
    const m = mockFetch((url) =>
      url.startsWith('https://slack.test/api/')
        ? new Response(JSON.stringify({ ok: true, ts: '1700000000.000200' }), {
            headers: { 'Content-Type': 'application/json' },
          })
        : new Response(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), {
            headers: { 'Content-Type': 'video/mp4' },
          }),
    );
    restore = m.restore;

    const clip = slackPipeline();
    await clip.post([CLIP]);
    expect(clip.transcriptions).toEqual([{ filename: 'audio_message.mp4', contentType: 'audio/mp4' }]);
    expect(clip.uploads).toEqual([]);
    expect(clip.invocations[0]).toEqual({ prompt: 'the spoken words' });

    const video = slackPipeline();
    await video.post([VIDEO]);
    expect(video.transcriptions).toEqual([]);
    expect(video.uploads).toEqual([]);
    expect(video.invocations[0]).toEqual({
      prompt: [{ type: 'text', text: unsupportedAttachmentNote('clip.mp4') }],
    });
    // Refused before download.
    expect(m.calls.some((c) => c.url === VIDEO.url_private_download)).toBe(false);
  });

  test('a file_share message carries its files as attachments', async () => {
    const [event] = await adapter.parse(fileShare([PDF, PNG]));
    expect(event!.text).toBe('what do these say?');
    expect(event!.dedupeKey).toBe('slack:C0CHAN:1700000000.000100');
    expect(event!.attachments).toHaveLength(2);
    expect(event!.attachments![0]).toMatchObject({
      kind: 'document',
      fileName: 'invoice.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4,
    });
    expect(event!.attachments![1]).toMatchObject({
      kind: 'image',
      fileName: 'image.png',
      contentType: 'image/png',
      sizeBytes: 70,
    });
  });

  test('a file sent with no text is still an event; an audio clip is audio', async () => {
    const clip = { ...PNG, id: 'F0CLIP', name: 'audio_message.m4a', mimetype: 'audio/mp4' };
    const [event] = await adapter.parse(fileShare([clip], { text: '' }));
    expect(event!.text).toBe('');
    expect(event!.attachments![0]).toMatchObject({ kind: 'audio', fileName: 'audio_message.m4a' });
  });

  test('an unnamed file falls back to its title, then its id', async () => {
    const [event] = await adapter.parse(
      fileShare([
        { ...PNG, name: null, title: 'Screenshot' },
        { ...PNG, id: 'F0BARE', name: null, title: null },
      ]),
    );
    expect(event!.attachments!.map((a) => a.fileName)).toEqual(['Screenshot', 'file_F0BARE']);
  });

  test('an app_mention with files carries them too', async () => {
    const [event] = await adapter.parse(
      req({
        type: 'event_callback',
        event: {
          type: 'app_mention',
          text: '<@U0BOT> summarize this',
          user: 'U0USER',
          channel: 'C0CHAN',
          ts: '1700000000.000100',
          files: [PDF],
        },
      }),
    );
    expect(event!.text).toBe('summarize this');
    expect(event!.attachments![0]!.fileName).toBe('invoice.pdf');
  });

  // The agent is told why such a file is missing instead of never hearing of it.
  test('external, hidden and post files are marked unavailable, with the reason', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { ...PDF, mode: 'external', is_external: true, url_private: 'https://drive.example/f' },
        "it is hosted outside Slack, where the bot can't read it",
      ],
      [{ ...PDF, is_hidden_by_limit: 1 }, "it is hidden by the Slack workspace's plan limit"],
      [{ ...PDF, mode: 'post' }, "Slack doesn't offer a download for this kind of file"],
      [
        { ...PDF, url_private: undefined, url_private_download: undefined },
        "Slack doesn't offer a download for this kind of file",
      ],
    ];
    for (const [file, reason] of cases) {
      // A file on its own is still an event, so the user gets an answer.
      const [event] = await adapter.parse(fileShare([file], { text: '' }));
      expect(event!.attachments).toHaveLength(1);
      expect(event!.attachments![0]).toMatchObject({ fileName: 'invoice.pdf', unavailable: reason });
    }
  });

  test('id-less files are skipped', async () => {
    expect(await adapter.parse(fileShare([{ ...PDF, id: undefined }], { text: '' }))).toHaveLength(0);
    const [withText] = await adapter.parse(fileShare([{ ...PDF, id: undefined }]));
    expect(withText!.attachments).toBeUndefined();
  });

  test('other subtypes and bot uploads are still dropped', async () => {
    expect(await adapter.parse(fileShare([PDF], { subtype: 'message_changed' }))).toHaveLength(0);
    expect(await adapter.parse(fileShare([PDF], { bot_id: 'B0BOT' }))).toHaveLength(0);
  });

  test('a Slack Connect stub is declared without name or type', async () => {
    const stub = { id: 'F0EXT', mode: 'file_access', file_access: 'check_file_info', user: '' };
    const [event] = await adapter.parse(fileShare([stub], { text: '' }));
    const attachment = event!.attachments![0]!;
    expect(attachment.kind).toBe('document');
    expect(attachment.fileName).toBeUndefined();
    expect(attachment.contentType).toBeUndefined();
  });

  test('download fetches url_private_download with the bot token', async () => {
    const m = mockFetch(() => new Response(BYTES, { headers: { 'Content-Type': 'application/pdf' } }));
    restore = m.restore;
    const file = await attachmentFor(PDF).download();
    expect(Array.from(file.data)).toEqual(Array.from(BYTES));
    expect(file.contentType).toBe('application/pdf');
    expect(file.fileName).toBe('invoice.pdf');
    expect(m.calls).toEqual([{ url: PDF_URL, auth: 'Bearer xoxb-test', redirect: 'manual' }]);
  });

  test('download uses url_private when there is no url_private_download', async () => {
    const m = mockFetch(() => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47])));
    restore = m.restore;
    await attachmentFor(PNG).download();
    expect(m.calls[0]!.url).toBe(PNG.url_private);
  });

  test('the bot token is never sent off the Slack file hosts', async () => {
    const m = mockFetch(() => new Response(BYTES));
    restore = m.restore;
    const offHost = { ...PDF, url_private_download: 'https://files.evil.example/invoice.pdf' };
    await expect(attachmentFor(offHost).download()).rejects.toThrow(
      'Slack file URL is not on a Slack file host (files.evil.example); not sending the bot token',
    );
    const plainHttp = { ...PDF, url_private_download: 'http://files.slack.com/invoice.pdf' };
    await expect(attachmentFor(plainHttp).download()).rejects.toThrow('not on a Slack file host');
    expect(m.calls).toHaveLength(0);
  });

  test('redirects keep the token on file hosts and drop it elsewhere', async () => {
    const m = mockFetch((url) => {
      if (url === PDF_URL) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://files.slack.com/files-pri/T0TEAM-F0PDF/moved.pdf' },
        });
      }
      if (url.endsWith('/moved.pdf')) {
        return new Response(null, { status: 302, headers: { Location: 'https://cdn.example/blob' } });
      }
      return new Response(BYTES);
    });
    restore = m.restore;
    await attachmentFor(PDF).download();
    expect(m.calls.map((c) => [c.url, c.auth])).toEqual([
      [PDF_URL, 'Bearer xoxb-test'],
      ['https://files.slack.com/files-pri/T0TEAM-F0PDF/moved.pdf', 'Bearer xoxb-test'],
      ['https://cdn.example/blob', null],
    ]);
  });

  test('a redirect loop fails', async () => {
    const m = mockFetch(
      () => new Response(null, { status: 302, headers: { Location: PDF_URL } }),
    );
    restore = m.restore;
    await expect(attachmentFor(PDF).download()).rejects.toThrow(
      'Slack file download redirected too many times',
    );
  });

  test('fileHosts extends the hosts the token is sent to', async () => {
    const gov = slack({
      signingSecret: SIGNING_SECRET,
      botToken: 'xoxb-test',
      fileHosts: ['files.slack-gov.com'],
    });
    const m = mockFetch(() => new Response(BYTES));
    restore = m.restore;
    const file = { ...PDF, url_private_download: 'https://files.slack-gov.com/files-pri/x.pdf' };
    await attachmentFor(file, gov).download();
    expect(m.calls[0]!.auth).toBe('Bearer xoxb-test');
  });

  test('a sign-in page served instead of the file is refused', async () => {
    for (const [body, contentType] of [
      ['<!DOCTYPE html><html><head><title>Slack</title></head></html>', 'text/html; charset=utf-8'],
      ['  <html><body>Sign in</body></html>', 'application/octet-stream'],
    ] as const) {
      const m = mockFetch(() => new Response(body, { headers: { 'Content-Type': contentType } }));
      try {
        await expect(attachmentFor(PDF).download()).rejects.toThrow(
          'Slack file download returned a web page instead of the file (does the bot token have the files:read scope?)',
        );
      } finally {
        m.restore();
      }
    }
    // A text file is refused when the body is served as HTML.
    const m = mockFetch(
      () => new Response('<!DOCTYPE html><html></html>', { headers: { 'Content-Type': 'text/html' } }),
    );
    try {
      await expect(
        attachmentFor({ ...PDF, name: 'notes.txt', mimetype: 'text/plain' }).download(),
      ).rejects.toThrow('returned a web page');
    } finally {
      m.restore();
    }
  });

  // A `.txt` or snippet holding HTML source is the file, not a sign-in page.
  test('a text file whose content starts with HTML still downloads', async () => {
    const source = '<!DOCTYPE html>\n<html><body>My landing page draft</body></html>\n';
    const m = mockFetch(() => new Response(source, { headers: { 'Content-Type': 'text/plain' } }));
    try {
      const file = await attachmentFor({
        ...PDF,
        name: 'draft.txt',
        mimetype: 'text/plain',
        mode: 'snippet',
      }).download();
      expect(new TextDecoder().decode(file.data)).toBe(source);
      expect(file.contentType).toBe('text/plain');
    } finally {
      m.restore();
    }
  });

  test('an HTML file the user sent still downloads', async () => {
    const m = mockFetch(
      () => new Response('<!DOCTYPE html><html></html>', { headers: { 'Content-Type': 'text/html' } }),
    );
    restore = m.restore;
    const file = await attachmentFor({ ...PDF, name: 'page.html', mimetype: 'text/html' }).download();
    expect(file.contentType).toBe('text/html');
  });

  test('a refused download fails with its status', async () => {
    const m = mockFetch(() => new Response('forbidden', { status: 403 }));
    restore = m.restore;
    await expect(attachmentFor(PDF).download()).rejects.toThrow('Slack file download failed (403)');
  });

  test('a file over maxFileBytes fails, before downloading when its size is declared', async () => {
    const capped = slack({ signingSecret: SIGNING_SECRET, botToken: 'xoxb-test', maxFileBytes: 3 });
    const m = mockFetch(() => new Response(BYTES));
    restore = m.restore;
    await expect(attachmentFor(PDF, capped).download()).rejects.toThrow(
      'Slack file is larger than the 3-byte limit (maxFileBytes)',
    );
    expect(m.calls).toHaveLength(0);
    // Size not declared: the read itself is capped.
    await expect(attachmentFor({ ...PDF, size: undefined }, capped).download()).rejects.toThrow(
      'larger than the 3-byte limit',
    );
  });

  test('a stalled download times out', async () => {
    const slow = slack({ signingSecret: SIGNING_SECRET, botToken: 'xoxb-test', fileTimeoutMs: 20 });
    const m = mockFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    restore = m.restore;
    await expect(attachmentFor(PDF, slow).download()).rejects.toThrow(
      'Slack file download timed out after 20ms',
    );
  });

  test('a Slack Connect stub is looked up with files.info, then downloaded', async () => {
    const m = mockFetch((url) => {
      if (url.startsWith('https://slack.test/api/files.info')) {
        return new Response(JSON.stringify({ ok: true, file: PDF }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(BYTES);
    });
    restore = m.restore;
    const stub = { id: 'F0EXT', mode: 'file_access', file_access: 'check_file_info' };
    const file = await attachmentFor(stub).download();
    expect(file.fileName).toBe('invoice.pdf');
    expect(file.contentType).toBe('application/pdf');
    expect(m.calls.map((c) => [c.url, c.auth])).toEqual([
      ['https://slack.test/api/files.info?file=F0EXT', 'Bearer xoxb-test'],
      [PDF_URL, 'Bearer xoxb-test'],
    ]);
  });

  // The pipeline describes a stub before downloading it, so a file agents
  // can't read is refused without fetching its bytes.
  test('a Slack Connect stub describes itself; the download reuses that lookup', async () => {
    const m = mockFetch((url) => {
      if (url.startsWith('https://slack.test/api/files.info')) {
        return new Response(JSON.stringify({ ok: true, file: PDF }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(BYTES);
    });
    restore = m.restore;
    const stub = { id: 'F0EXT', mode: 'file_access', file_access: 'check_file_info' };
    const attachment = attachmentFor(stub);
    expect(await attachment.describe!()).toEqual({
      fileName: 'invoice.pdf',
      contentType: 'application/pdf',
      sizeBytes: PDF.size,
      unavailable: undefined,
    });
    await attachment.download();
    expect(m.calls.map((c) => c.url)).toEqual([
      'https://slack.test/api/files.info?file=F0EXT',
      PDF_URL,
    ]);
  });

  test('a Slack Connect stub that turns out external is described as unavailable', async () => {
    const external = { ...PDF, mode: 'external', is_external: true, url_private: 'https://drive.example/f' };
    const m = mockFetch(
      () =>
        new Response(JSON.stringify({ ok: true, file: external }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    restore = m.restore;
    const stub = { id: 'F0EXT', mode: 'file_access', file_access: 'check_file_info' };
    expect((await attachmentFor(stub).describe!()).unavailable).toBe(
      "it is hosted outside Slack, where the bot can't read it",
    );
  });

  test('a files.info refusal fails the download clearly', async () => {
    const m = mockFetch(
      () => new Response(JSON.stringify({ ok: false, error: 'access_denied' }), { status: 200 }),
    );
    restore = m.restore;
    const stub = { id: 'F0EXT', file_access: 'check_file_info' };
    await expect(attachmentFor(stub).download()).rejects.toThrow(
      'Slack files.info failed (200): access_denied',
    );
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

function waMediaEnvelope(message: Record<string, unknown>) {
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
              metadata: { display_phone_number: WA_DISPLAY, phone_number_id: WA_PHONE_ID },
              contacts: [{ profile: { name: 'Dani' }, wa_id: WA_USER }],
              messages: [{ from: WA_USER, id: 'wamid.MEDIA', timestamp: '1700000000', ...message }],
            },
          },
        ],
      },
    ],
  };
}

describe('whatsapp adapter media', () => {
  const adapter = whatsapp({
    accessToken: 'tok',
    phoneNumberId: WA_PHONE_ID,
    appSecret: WA_APP_SECRET,
    verifyToken: WA_VERIFY_TOKEN,
  });

  test('an image becomes an image attachment with its caption as text', () => {
    const [event] = adapter.parse(
      signedWhatsAppReq(
        waMediaEnvelope({
          type: 'image',
          image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'is this broken?' },
        }),
      ),
    );
    expect(event!.text).toBe('is this broken?');
    expect(event!.dedupeKey).toBe('whatsapp:wamid.MEDIA');
    expect(event!.attachments).toHaveLength(1);
    expect(event!.attachments![0]).toMatchObject({
      kind: 'image',
      fileName: 'image_MEDIA1.jpg',
      contentType: 'image/jpeg',
    });
  });

  test('a voice note becomes an audio attachment with no text', () => {
    const [event] = adapter.parse(
      signedWhatsAppReq(
        waMediaEnvelope({
          type: 'audio',
          audio: { id: 'MEDIA2', mime_type: 'audio/ogg; codecs=opus', voice: true },
        }),
      ),
    );
    expect(event!.text).toBe('');
    expect(event!.attachments![0]).toMatchObject({
      kind: 'audio',
      fileName: 'voice_MEDIA2.ogg',
      contentType: 'audio/ogg',
    });
  });

  test('a document keeps its file name; an image sent as a document is an image', () => {
    const [pdf] = adapter.parse(
      signedWhatsAppReq(
        waMediaEnvelope({
          type: 'document',
          document: { id: 'MEDIA3', mime_type: 'application/pdf', filename: 'invoice.pdf' },
        }),
      ),
    );
    expect(pdf!.attachments![0]).toMatchObject({ kind: 'document', fileName: 'invoice.pdf' });

    const [photo] = adapter.parse(
      signedWhatsAppReq(
        waMediaEnvelope({
          type: 'document',
          document: { id: 'MEDIA4', mime_type: 'image/png', filename: 'photo.png' },
        }),
      ),
    );
    expect(photo!.attachments![0]!.kind).toBe('image');
  });

  test('unsupported types and media without an id are skipped', () => {
    for (const message of [
      { type: 'video', video: { id: 'V1', mime_type: 'video/mp4' } },
      { type: 'sticker', sticker: { id: 'S1', mime_type: 'image/webp' } },
      { type: 'location', location: { latitude: 41.4, longitude: 2.2 } },
      { type: 'image', image: { mime_type: 'image/jpeg' } },
    ]) {
      expect(adapter.parse(signedWhatsAppReq(waMediaEnvelope(message)))).toHaveLength(0);
    }
  });

  test('download looks the media up, then fetches it, both with the token', async () => {
    const calls: Array<{ url: string; auth: string | null; ua: string | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get('authorization'), ua: headers.get('user-agent') });
      if (url.endsWith('/MEDIA2')) {
        return new Response(
          JSON.stringify({ url: 'https://media.example.com/blob?x=1', mime_type: 'audio/ogg' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;

    try {
      const [event] = adapter.parse(
        signedWhatsAppReq(
          waMediaEnvelope({
            type: 'audio',
            audio: { id: 'MEDIA2', mime_type: 'audio/ogg; codecs=opus', voice: true },
          }),
        ),
      );
      const file = await event!.attachments![0]!.download();
      expect(Array.from(file.data)).toEqual([1, 2, 3]);
      expect(file.contentType).toBe('audio/ogg');
      expect(file.fileName).toBe('voice_MEDIA2.ogg');
      const ua = `timbal-sdk/${SDK_VERSION}`;
      expect(calls).toEqual([
        { url: 'https://graph.facebook.com/v21.0/MEDIA2', auth: 'Bearer tok', ua },
        { url: 'https://media.example.com/blob?x=1', auth: 'Bearer tok', ua },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  /** Lookup answers a URL; the download answers `body` with `contentType`. */
  function mockMediaHost(body: string, contentType?: string) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('graph.facebook.com')) {
        return new Response(JSON.stringify({ url: 'https://media.example.com/blob' }), {
          status: 200,
        });
      }
      return new Response(body, {
        status: 200,
        headers: contentType ? { 'Content-Type': contentType } : {},
      });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  function imageAttachment(type = 'image', mime = 'image/jpeg', filename?: string) {
    const media = { id: 'MEDIA9', mime_type: mime, ...(filename ? { filename } : {}) };
    const [event] = adapter.parse(signedWhatsAppReq(waMediaEnvelope({ type, [type]: media })));
    return event!.attachments![0]!;
  }

  test('an error page served with a 200 is refused, not passed on as the file', async () => {
    for (const [body, contentType] of [
      ['<html><body>Sorry, something went wrong</body></html>', 'text/html; charset=utf-8'],
      ['\n  <!DOCTYPE html><html><head></head></html>', undefined],
    ] as const) {
      const restore = mockMediaHost(body, contentType);
      try {
        await expect(imageAttachment().download()).rejects.toThrow(
          'WhatsApp media download returned a web page instead of the file',
        );
      } finally {
        restore();
      }
    }
  });

  test('an HTML document the user really sent still downloads', async () => {
    const restore = mockMediaHost('<html><body>menu</body></html>', 'text/html');
    try {
      const file = await imageAttachment('document', 'text/html', 'menu.html').download();
      expect(file.fileName).toBe('menu.html');
      expect(file.contentType).toBe('text/html');
    } finally {
      restore();
    }
  });

  test('download fails clearly when the lookup is refused', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'expired' } }), {
        status: 400,
      })) as unknown as typeof fetch;
    try {
      const [event] = adapter.parse(
        signedWhatsAppReq(
          waMediaEnvelope({ type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg' } }),
        ),
      );
      await expect(event!.attachments![0]!.download()).rejects.toThrow(
        'WhatsApp media lookup failed (400)',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a recording sent as a document is audio (transcribed) and keeps its name', () => {
    const attachment = imageAttachment('document', 'audio/ogg', 'meeting.ogg');
    expect(attachment).toMatchObject({ kind: 'audio', fileName: 'meeting.ogg' });
  });

  test('an XHTML document the user sent still downloads; a PDF that is HTML does not', async () => {
    const restore = mockMediaHost('<!DOCTYPE html><html></html>', 'text/html');
    try {
      const file = await imageAttachment('document', 'application/xhtml+xml', 'page.xhtml').download();
      expect(file.fileName).toBe('page.xhtml');
      await expect(
        imageAttachment('document', 'application/pdf', 'invoice.pdf').download(),
      ).rejects.toThrow('WhatsApp media download returned a web page instead of the file');
    } finally {
      restore();
    }
  });

  test('a stalled media download times out', async () => {
    const slow = whatsapp({
      accessToken: 'tok',
      phoneNumberId: WA_PHONE_ID,
      appSecret: WA_APP_SECRET,
      verifyToken: WA_VERIFY_TOKEN,
      mediaTimeoutMs: 20,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    try {
      const [event] = slow.parse(
        signedWhatsAppReq(
          waMediaEnvelope({ type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg' } }),
        ),
      );
      await expect(event!.attachments![0]!.download()).rejects.toThrow(
        'WhatsApp media download timed out after 20ms',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('media over maxMediaBytes is refused, with or without a Content-Length', async () => {
    const capped = whatsapp({
      accessToken: 'tok',
      phoneNumberId: WA_PHONE_ID,
      appSecret: WA_APP_SECRET,
      verifyToken: WA_VERIFY_TOKEN,
      maxMediaBytes: 4,
    });
    const attachment = () =>
      capped.parse(
        signedWhatsAppReq(
          waMediaEnvelope({ type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg' } }),
        ),
      )[0]!.attachments![0]!;

    for (const withLength of [true, false]) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (String(input).includes('graph.facebook.com')) {
          return new Response(JSON.stringify({ url: 'https://media.example.com/blob' }));
        }
        const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
        const body = withLength
          ? bytes
          : new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.subarray(0, 3));
                controller.enqueue(bytes.subarray(3));
                controller.close();
              },
            });
        return new Response(body, {
          headers: withLength ? { 'Content-Length': '6' } : {},
        });
      }) as typeof fetch;
      try {
        await expect(attachment().download()).rejects.toThrow('larger than the 4-byte limit');
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });
});

// Cross-implementation vector: the platform signs forwards with the same
// scheme, and its tests pin the same values.
const PLATFORM_SECRET = 'tps_example_project_secret';
const PLATFORM_BODY = '{"object":"whatsapp_business_account"}';
const PLATFORM_TS = 1763800000;
const PLATFORM_SIG = 'sha256=b90515c29fae0bcbbfb277b93445744bbd5817f4e22424a843279d844c1bea62';

function platformSigned(
  body: unknown,
  secret = PLATFORM_SECRET,
  timestamp = PLATFORM_TS,
): WebhookRequest {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const key = createHmac('sha256', secret).update('whatsapp-forward-v1').digest();
  const signature = `sha256=${createHmac('sha256', key)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')}`;
  return {
    rawBody,
    headers: new Headers({
      [PLATFORM_TIMESTAMP_HEADER]: String(timestamp),
      [PLATFORM_SIGNATURE_HEADER]: signature,
    }),
    url: 'https://app.example.com/channels/joi/whatsapp',
    method: 'POST',
  };
}

describe('verifyPlatformForward', () => {
  const check = (o: {
    secret?: string;
    body?: string;
    ts?: string | null;
    sig?: string | null;
    nowSec?: number;
  }) =>
    verifyPlatformForward(
      o.secret ?? PLATFORM_SECRET,
      o.body ?? PLATFORM_BODY,
      o.ts === undefined ? String(PLATFORM_TS) : o.ts,
      o.sig === undefined ? PLATFORM_SIG : o.sig,
      (o.nowSec ?? PLATFORM_TS) * 1000,
    );

  test('matches the shared vector', () => {
    expect(check({})).toBe(true);
  });

  test('rejects a wrong secret, body, timestamp or signature', () => {
    expect(check({ secret: 'other' })).toBe(false);
    expect(check({ body: '{}' })).toBe(false);
    expect(check({ ts: String(PLATFORM_TS + 1) })).toBe(false);
    expect(check({ sig: 'sha256=00' })).toBe(false);
    expect(check({ ts: null })).toBe(false);
    expect(check({ sig: null })).toBe(false);
    expect(check({ ts: '1.5e9' })).toBe(false);
  });

  test('enforces the timestamp window', () => {
    expect(check({ nowSec: PLATFORM_TS + PLATFORM_MAX_SKEW_SECONDS })).toBe(true);
    expect(check({ nowSec: PLATFORM_TS + PLATFORM_MAX_SKEW_SECONDS + 1 })).toBe(false);
    expect(check({ nowSec: PLATFORM_TS - PLATFORM_MAX_SKEW_SECONDS - 1 })).toBe(false);
  });
});

describe('whatsapp adapter (platform-routed)', () => {
  const adapter = whatsapp({
    accessToken: 'tok',
    phoneNumberId: WA_PHONE_ID,
    platformSecret: PLATFORM_SECRET,
    expectedPhoneNumberId: WA_PHONE_ID,
    now: () => PLATFORM_TS * 1000,
  });

  test('needs no app secret or verify token, but manual mode still does', () => {
    expect(() =>
      whatsapp({ accessToken: 'tok', phoneNumberId: WA_PHONE_ID, platformSecret: 's' }),
    ).not.toThrow();
    expect(() =>
      whatsapp({ accessToken: 'tok', phoneNumberId: WA_PHONE_ID, verifyToken: WA_VERIFY_TOKEN }),
    ).toThrow('appSecret');
    expect(() =>
      whatsapp({ accessToken: 'tok', phoneNumberId: WA_PHONE_ID, appSecret: WA_APP_SECRET }),
    ).toThrow('verifyToken');
  });

  test('accepts a platform-signed forward', () => {
    expect(adapter.verify(platformSigned(waTextEnvelope()))).toBe('ok');
  });

  test("rejects Meta's own signature, a forged forward and a stale one", () => {
    const metaSigned = adapter.verify(signedWhatsAppReq(waTextEnvelope()));
    expect(metaSigned).toBeInstanceOf(Response);
    expect((metaSigned as Response).status).toBe(401);

    const forged = adapter.verify(platformSigned(waTextEnvelope(), 'another-project-secret'));
    expect((forged as Response).status).toBe(401);

    const staleTs = PLATFORM_TS - PLATFORM_MAX_SKEW_SECONDS - 1;
    const stale = adapter.verify(platformSigned(waTextEnvelope(), PLATFORM_SECRET, staleTs));
    expect((stale as Response).status).toBe(401);
  });

  test('refuses hub challenges', () => {
    const verdict = adapter.verify({
      rawBody: '',
      headers: new Headers(),
      url:
        'https://app.example.com/channels/joi/whatsapp' +
        '?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1',
      method: 'GET',
    });
    expect((verdict as Response).status).toBe(405);
  });

  test('parses forwarded messages and drops other numbers', () => {
    const events = adapter.parse(platformSigned(waTextEnvelope({ body: 'hola' })));
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toBe('hola');
    expect(events[0]!.dedupeKey).toBe('whatsapp:wamid.TEST');
    expect(adapter.parse(platformSigned(waTextEnvelope({ phoneNumberId: 'other' })))).toHaveLength(
      0,
    );
  });
});
