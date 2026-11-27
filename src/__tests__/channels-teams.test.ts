import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import { generateKeyPairSync } from 'node:crypto';
import { teams, clearTeamsAdapterCaches } from '../channels/adapters/teams';
import { certificateAuthentication } from '../channels/adapters/teams-auth';
import { unsupportedAttachmentNote } from '../channels/attachments';
import { webmTrackKinds } from '../channels/download';
import type { WebhookRequest } from '../channels/types';
import { timbalChannels } from '../elysia/channels';
import type { Timbal } from '../lib/timbal';

// ── Fixtures ──
// Synthetic Bot Framework identifiers — never real tenants/apps.
const APP_ID = '00000000-1111-2222-3333-444444444444';
const APP_PASSWORD = 'test-client-secret';
const SERVICE_URL = 'https://smba.test.example/emea/';
const METADATA_URL = 'https://login.bot.test/.well-known/openidconfiguration';
const JWKS_URL = 'https://login.bot.test/keys';
const LOGIN_BASE = 'https://login.entra.test';
const KID = 'test-key-1';
const NOW = 1_700_000_000_000;
const NOW_SEC = NOW / 1000;

const CONVERSATION_ID = '19:chan@thread.tacv2;messageid=169000';

function activityFixture(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    id: '1700000000123',
    text: '<at>Joi</at> hello there',
    serviceUrl: SERVICE_URL,
    channelId: 'msteams',
    from: { id: '29:user-abc', name: 'Dani', aadObjectId: 'aad-obj-1' },
    recipient: { id: `28:${APP_ID}`, name: 'Joi' },
    conversation: { id: CONVERSATION_ID },
    ...overrides,
  };
}

// ── JWT helpers (RS256 via WebCrypto, same primitives the adapter uses) ──

const b64url = (data: ArrayBuffer | Uint8Array): string =>
  Buffer.from(data as Uint8Array)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const encJson = (obj: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function generateKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
}

async function signJwt(
  privateKey: CryptoKey,
  payload: Record<string, unknown>,
  kid: string = KID,
): Promise<string> {
  const header = encJson({ alg: 'RS256', typ: 'JWT', kid });
  const body = encJson(payload);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${b64url(signature)}`;
}

const claims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: 'https://api.botframework.com',
  aud: APP_ID,
  serviceurl: SERVICE_URL,
  exp: NOW_SEC + 3600,
  nbf: NOW_SEC - 60,
  ...overrides,
});

function req(
  body: unknown,
  headers: Record<string, string> = {},
): WebhookRequest {
  return {
    rawBody: typeof body === 'string' ? body : JSON.stringify(body),
    headers: new Headers(headers),
    url: 'https://app.example.com/channels/joi/teams',
    method: 'POST',
  };
}

// ── Fetch mock ──

interface RecordedFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

let keyPair: CryptoKeyPair;
let publicJwk: JsonWebKey & { kid?: string };
let fetches: RecordedFetch[];
/** Connector-token requests (scope api.botframework.com). */
let tokenFetches: number;
/** Every other token request: file tokens. */
let fileTokenFetches: number;
/** Overrides the token endpoint's answer to file-token requests. */
let fileTokenRoute: ((body: URLSearchParams) => Response | Promise<Response>) | undefined;
let realFetch: typeof fetch;
/** File URLs the mock serves, by exact URL (checked before the connector routes). */
let fileRoutes: Map<string, (init: RequestInit | undefined) => Response | Promise<Response>>;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

beforeEach(async () => {
  clearTeamsAdapterCaches();
  keyPair = await generateKeyPair();
  publicJwk = { ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)), kid: KID };
  fetches = [];
  tokenFetches = 0;
  fileTokenFetches = 0;
  fileTokenRoute = undefined;
  fileRoutes = new Map();
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    fetches.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : (init?.body?.toString() ?? null),
    });
    const fileRoute = fileRoutes.get(url);
    if (fileRoute) return fileRoute(init);
    if (url === METADATA_URL) return jsonResponse({ jwks_uri: JWKS_URL });
    if (url === JWKS_URL) return jsonResponse({ keys: [publicJwk] });
    if (url.startsWith(`${LOGIN_BASE}/`)) {
      const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : String(init?.body));
      if (form.get('scope') !== 'https://api.botframework.com/.default') {
        fileTokenFetches += 1;
        if (fileTokenRoute) return fileTokenRoute(form);
        return jsonResponse({ access_token: `file-token-${fileTokenFetches}`, expires_in: 3600 });
      }
      tokenFetches += 1;
      return jsonResponse({ access_token: `connector-token-${tokenFetches}`, expires_in: 3600 });
    }
    if (url.startsWith(SERVICE_URL)) return jsonResponse({ id: 'sent-activity-1' });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const makeAdapter = (tenantId?: string) =>
  teams({
    appId: APP_ID,
    appPassword: APP_PASSWORD,
    tenantId,
    openIdMetadataUrl: METADATA_URL,
    loginBase: LOGIN_BASE,
    fileHosts: ['sharepoint.test'],
    now: () => NOW,
  });

// ── Verify ──

describe('teams adapter verify', () => {
  test('accepts a valid Bot Connector JWT', async () => {
    const adapter = makeAdapter();
    const jwt = await signJwt(keyPair.privateKey, claims());
    expect(
      await adapter.verify(req(activityFixture(), { authorization: `Bearer ${jwt}` })),
    ).toBe('ok');
  });

  test('rejects missing or malformed Authorization header', async () => {
    const adapter = makeAdapter();
    const noHeader = await adapter.verify(req(activityFixture()));
    expect(noHeader).toBeInstanceOf(Response);
    expect((noHeader as Response).status).toBe(401);

    const garbage = await adapter.verify(
      req(activityFixture(), { authorization: 'Bearer not.a.jwt' }),
    );
    expect((garbage as Response).status).toBe(401);
  });

  test('rejects a token signed by a different key', async () => {
    const adapter = makeAdapter();
    const otherPair = await generateKeyPair();
    // Same kid, wrong private key → signature check must fail.
    const jwt = await signJwt(otherPair.privateKey, claims());
    const res = await adapter.verify(
      req(activityFixture(), { authorization: `Bearer ${jwt}` }),
    );
    expect((res as Response).status).toBe(401);
  });

  test('rejects unknown kid', async () => {
    const adapter = makeAdapter();
    const jwt = await signJwt(keyPair.privateKey, claims(), 'other-kid');
    const res = await adapter.verify(
      req(activityFixture(), { authorization: `Bearer ${jwt}` }),
    );
    expect((res as Response).status).toBe(401);
  });

  test('rejects wrong issuer, wrong audience, and expired tokens', async () => {
    const adapter = makeAdapter();
    for (const bad of [
      claims({ iss: 'https://evil.example' }),
      claims({ aud: 'some-other-app' }),
      claims({ exp: NOW_SEC - 3600 }),
      claims({ nbf: NOW_SEC + 3600 }),
    ]) {
      const jwt = await signJwt(keyPair.privateKey, bad);
      const res = await adapter.verify(
        req(activityFixture(), { authorization: `Bearer ${jwt}` }),
      );
      expect((res as Response).status).toBe(401);
    }
  });

  test('rejects when the serviceurl claim does not match the activity', async () => {
    const adapter = makeAdapter();
    const jwt = await signJwt(keyPair.privateKey, claims());
    const res = await adapter.verify(
      req(activityFixture({ serviceUrl: 'https://attacker.example/' }), {
        authorization: `Bearer ${jwt}`,
      }),
    );
    expect((res as Response).status).toBe(401);
  });

  // Without the claim the body alone would choose where the connector
  // token goes (replies, inline media).
  test('rejects a token without a serviceurl claim', async () => {
    const adapter = makeAdapter();
    const { serviceurl: _omit, ...withoutClaim } = claims();
    const jwt = await signJwt(keyPair.privateKey, withoutClaim);
    const verdict = await adapter.verify(req(activityFixture(), { authorization: `Bearer ${jwt}` }));
    expect((verdict as Response).status).toBe(401);
  });

  test('rejects when the serviceurl claim is present but the body omits serviceUrl', async () => {
    const adapter = makeAdapter();
    const jwt = await signJwt(keyPair.privateKey, claims());
    const { serviceUrl: _drop, ...withoutServiceUrl } = activityFixture();
    const res = await adapter.verify(
      req(withoutServiceUrl, { authorization: `Bearer ${jwt}` }),
    );
    expect((res as Response).status).toBe(401);
  });

  test('rejects non-JSON bodies when the token carries a serviceurl claim', async () => {
    const adapter = makeAdapter();
    const jwt = await signJwt(keyPair.privateKey, claims());
    const res = await adapter.verify(req('not json', { authorization: `Bearer ${jwt}` }));
    expect((res as Response).status).toBe(401);
  });

  test('trailing-slash differences in serviceurl are not a mismatch', async () => {
    const adapter = makeAdapter();
    const jwt = await signJwt(
      keyPair.privateKey,
      claims({ serviceurl: SERVICE_URL.replace(/\/+$/, '') }),
    );
    expect(
      await adapter.verify(req(activityFixture(), { authorization: `Bearer ${jwt}` })),
    ).toBe('ok');
  });

  test('JWKS is fetched once and reused across verifications', async () => {
    const adapter = makeAdapter();
    const jwt = await signJwt(keyPair.privateKey, claims());
    await adapter.verify(req(activityFixture(), { authorization: `Bearer ${jwt}` }));
    await adapter.verify(req(activityFixture(), { authorization: `Bearer ${jwt}` }));
    expect(fetches.filter((f) => f.url === JWKS_URL)).toHaveLength(1);
  });
});

// ── Parse ──

describe('teams adapter parse', () => {
  const adapter = makeAdapter();

  test('normalizes a message activity', async () => {
    const events = await adapter.parse(req(activityFixture()));
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.provider).toBe('teams');
    expect(ev.conversationId).toBe(CONVERSATION_ID);
    expect(ev.externalUserId).toBe('aad-obj-1');
    expect(ev.userDisplayName).toBe('Dani');
    expect(ev.text).toBe('hello there');
    expect(ev.dedupeKey).toBe(`teams:${CONVERSATION_ID}:1700000000123`);
  });

  test('falls back to the channel-scoped from.id without aadObjectId', async () => {
    const events = await adapter.parse(
      req(activityFixture({ from: { id: '29:user-abc', name: 'Dani' } })),
    );
    expect(events[0]!.externalUserId).toBe('29:user-abc');
  });

  test('unwraps inline mentions of other users to their display name', async () => {
    const events = await adapter.parse(
      req(activityFixture({ text: '<at>Joi</at> ask <at>Marta</at> about this' })),
    );
    expect(events[0]!.text).toBe('ask Marta about this');
  });

  test('strips <at id="…"> leading bot mentions used in channel payloads', async () => {
    const events = await adapter.parse(
      req(
        activityFixture({
          text: `<at id="28:${APP_ID}">Joi</at> hello there`,
        }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toBe('hello there');
  });

  test('strips the bot mention even when another user is mentioned first', async () => {
    const botId = `28:${APP_ID}`;
    const events = await adapter.parse(
      req(
        activityFixture({
          text: `<at id="29:marta">Marta</at> <at id="${botId}">Joi</at> hello there`,
        }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toBe('Marta hello there');
  });

  test('strips recipient mention via activity.entities (RemoveRecipientMention)', async () => {
    const botId = `28:${APP_ID}`;
    const botTag = `<at id="${botId}">Joi</at>`;
    const events = await adapter.parse(
      req(
        activityFixture({
          text: `<at id="29:marta">Marta</at> ${botTag} please help`,
          entities: [
            {
              type: 'mention',
              mentioned: { id: '29:marta', name: 'Marta' },
              text: '<at id="29:marta">Marta</at>',
            },
            {
              type: 'mention',
              mentioned: { id: botId, name: 'Joi' },
              text: botTag,
            },
          ],
        }),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toBe('Marta please help');
  });

  test('drops mention-only messages that use attributed <at> tags', async () => {
    expect(
      await adapter.parse(
        req(activityFixture({ text: `<at id="28:${APP_ID}">Joi</at>` })),
      ),
    ).toHaveLength(0);
  });

  test('drops non-message activities, bot echoes, empty text, and junk', async () => {
    expect(await adapter.parse(req(activityFixture({ type: 'conversationUpdate' })))).toHaveLength(0);
    expect(await adapter.parse(req(activityFixture({ type: 'messageReaction' })))).toHaveLength(0);
    // Our own outbound message echoed back (from === recipient).
    expect(
      await adapter.parse(
        req(activityFixture({ from: { id: `28:${APP_ID}` } })),
      ),
    ).toHaveLength(0);
    // Other bots (from.role === 'bot', different from/recipient ids).
    expect(
      await adapter.parse(
        req(
          activityFixture({
            from: { id: '28:other-bot', name: 'OtherBot', role: 'bot' },
          }),
        ),
      ),
    ).toHaveLength(0);
    // Mention-only message → nothing to run.
    expect(await adapter.parse(req(activityFixture({ text: '<at>Joi</at>' })))).toHaveLength(0);
    expect(await adapter.parse(req(activityFixture({ conversation: {} })))).toHaveLength(0);
    expect(await adapter.parse(req('not json'))).toHaveLength(0);
  });
});

// ── Delivery ──

describe('teams adapter delivery', () => {
  test('send posts to the connector with a bearer token and returns the activity id', async () => {
    const adapter = makeAdapter('tenant-1');
    const [event] = await adapter.parse(req(activityFixture()));
    const delivery = adapter.delivery(event!);

    const ref = await delivery.send('hi from the agent');
    expect(ref).toBe('sent-activity-1');

    const post = fetches.find((f) => f.url.startsWith(SERVICE_URL))!;
    expect(post.method).toBe('POST');
    expect(post.url).toBe(
      `${SERVICE_URL}v3/conversations/${encodeURIComponent(CONVERSATION_ID)}/activities`,
    );
    expect(post.headers.authorization).toBe('Bearer connector-token-1');
    const body = JSON.parse(post.body!);
    expect(body).toEqual({
      type: 'message',
      text: 'hi from the agent',
      replyToId: '1700000000123',
    });

    // Token endpoint got the tenant-scoped client-credentials request.
    const tokenReq = fetches.find((f) => f.url.startsWith(LOGIN_BASE))!;
    expect(tokenReq.url).toBe(`${LOGIN_BASE}/tenant-1/oauth2/v2.0/token`);
    expect(tokenReq.body).toContain('grant_type=client_credentials');
    expect(tokenReq.body).toContain(`client_id=${APP_ID}`);
  });

  test('multi-tenant bots request tokens against the botframework.com tenant', async () => {
    const adapter = makeAdapter();
    const [event] = await adapter.parse(req(activityFixture()));
    await adapter.delivery(event!).send('hello');
    const tokenReq = fetches.find((f) => f.url.startsWith(LOGIN_BASE))!;
    expect(tokenReq.url).toBe(`${LOGIN_BASE}/botframework.com/oauth2/v2.0/token`);
  });

  test('connector token is cached across sends', async () => {
    const adapter = makeAdapter();
    const [event] = await adapter.parse(req(activityFixture()));
    const delivery = adapter.delivery(event!);
    await delivery.send('one');
    await delivery.send('two');
    expect(tokenFetches).toBe(1);
  });

  test('edit PUTs the replacement activity', async () => {
    const adapter = makeAdapter();
    const [event] = await adapter.parse(req(activityFixture()));
    const delivery = adapter.delivery(event!);
    await delivery.edit!('sent-activity-1', 'updated text');

    const put = fetches.find((f) => f.method === 'PUT')!;
    expect(put.url).toBe(
      `${SERVICE_URL}v3/conversations/${encodeURIComponent(
        CONVERSATION_ID,
      )}/activities/sent-activity-1`,
    );
    expect(JSON.parse(put.body!)).toEqual({ type: 'message', text: 'updated text' });
  });

  test('connector errors surface with status and message', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(`${LOGIN_BASE}/`)) {
        return jsonResponse({ access_token: 'tok', expires_in: 3600 });
      }
      return jsonResponse({ error: { message: 'Bot is not part of the conversation roster' } }, 403);
    }) as typeof fetch;

    const adapter = makeAdapter();
    const [event] = await adapter.parse(req(activityFixture()));
    await expect(adapter.delivery(event!).send('hi')).rejects.toThrow(
      /Teams connector POST failed \(403\): Bot is not part of the conversation roster/,
    );
  });
});

// ── Attachments ──

const DOWNLOAD_URL =
  'https://contoso-my.sharepoint.test/personal/dani/_layouts/15/download.aspx?UniqueId=abc-123&tempauth=v1.tempauth-token';
/** The same file's URL after March 1, 2027: no `tempauth`. */
const BARE_DOWNLOAD_URL =
  'https://contoso-my.sharepoint.test/personal/dani/_layouts/15/download.aspx?UniqueId=abc-123&ApiVersion=2.0';
const INLINE_IMAGE_URL = `${SERVICE_URL}v3/attachments/0-weu-d1-abc/views/original`;
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fileDownloadInfo(name: string, fileType: string, downloadUrl: string = DOWNLOAD_URL) {
  return {
    contentType: 'application/vnd.microsoft.teams.file.download.info',
    contentUrl: `https://contoso-my.sharepoint.test/personal/dani/Documents/${name}`,
    name,
    content: { downloadUrl, uniqueId: 'abc-123', fileType },
  };
}

const inlineImage = (contentUrl: string = INLINE_IMAGE_URL, contentType = 'image/*') => ({
  contentType,
  contentUrl,
});

/** The message's own HTML copy, which Teams sends alongside inline images. */
const HTML_COPY = {
  contentType: 'text/html',
  content: '<div><div><span><img src="https://smba.test.example/x" /></span></div></div>',
};

async function parseAttachments(attachments: unknown[], text = '', adapter = makeAdapter()) {
  const events = await adapter.parse(req(activityFixture({ text, attachments })));
  return events;
}

describe('teams adapter attachments', () => {
  test('a file sent in a personal chat is a document attachment', async () => {
    const [event] = await parseAttachments([fileDownloadInfo('invoice.pdf', 'pdf')]);
    expect(event!.text).toBe('');
    expect(event!.attachments).toHaveLength(1);
    expect(event!.attachments![0]).toMatchObject({
      kind: 'document',
      fileName: 'invoice.pdf',
      contentType: 'application/pdf',
    });
  });

  // An unknown type is left to the download; a known unreadable one is
  // declared so the pipeline refuses it without downloading.
  test('audio files are audio; unknown file types are left untyped', async () => {
    const [event] = await parseAttachments([
      fileDownloadInfo('memo.m4a', 'm4a'),
      fileDownloadInfo('slides.key', 'key'),
      fileDownloadInfo('x.constructor', 'constructor'),
      fileDownloadInfo('capture.webm', 'webm'),
      fileDownloadInfo('archive.zip', 'zip'),
    ]);
    expect(event!.attachments!.map((a) => [a.kind, a.contentType])).toEqual([
      ['audio', 'audio/mp4'],
      ['document', undefined],
      ['document', undefined],
      ['document', undefined],
      ['document', 'application/zip'],
    ]);
  });

  test('an inline image is an image; the HTML copy and cards are not files', async () => {
    const [event] = await parseAttachments(
      [
        inlineImage(),
        HTML_COPY,
        { contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard' } },
      ],
      '<at>Joi</at> what is this?',
    );
    expect(event!.text).toBe('what is this?');
    expect(event!.attachments).toHaveLength(1);
    expect(event!.attachments![0]).toMatchObject({ kind: 'image', fileName: 'image_1' });
    // Typed only `image/*`: the real type is known after the download.
    expect(event!.attachments![0]!.contentType).toBeUndefined();
  });

  // The agent is told the file is missing, and nothing is fetched.
  test('files without an acceptable link are marked unavailable', async () => {
    const offHosts = "its download link isn't on the bot's allowed file hosts";
    const offConnector = 'Teams gave no link to it on the Bot Connector service';
    const cases: [unknown, string][] = [
      [{ ...fileDownloadInfo('a.pdf', 'pdf'), content: { uniqueId: 'x', fileType: 'pdf' } }, offHosts],
      [fileDownloadInfo('b.pdf', 'pdf', 'http://contoso.sharepoint.test/b.pdf'), offHosts],
      [fileDownloadInfo('c.pdf', 'pdf', 'https://attacker.example/c.pdf'), offHosts],
      [fileDownloadInfo('d.pdf', 'pdf', 'https://sharepoint.test.attacker.example/d.pdf'), offHosts],
      [inlineImage('not a url'), offConnector],
      [inlineImage('https://cdn.example.test/cat.png', 'image/png'), offConnector],
      [{ contentType: 'image/png' }, offConnector],
    ];
    for (const [attachment, reason] of cases) {
      const [event] = await parseAttachments([attachment]);
      expect(event!.attachments).toHaveLength(1);
      expect(event!.attachments![0]!.unavailable).toBe(reason);
    }
    expect(fetches.filter((f) => !f.url.startsWith(LOGIN_BASE))).toHaveLength(0);
    // The message's HTML copy is not a file at all.
    expect(await parseAttachments([HTML_COPY])).toHaveLength(0);
  });

  // On Web Chat or Direct Line the sender picks the URLs.
  test('files are only fetched from Teams activities', async () => {
    const adapter = makeAdapter();
    const [event] = await adapter.parse(
      req(
        activityFixture({
          channelId: 'webchat',
          text: 'what is in this file?',
          attachments: [
            fileDownloadInfo('invoice.pdf', 'pdf'),
            inlineImage(),
            { contentType: 'text/plain', contentUrl: 'https://attacker.example/notes.txt', name: 'notes.txt' },
          ],
        }),
      ),
    );
    expect(event!.attachments!.map((a) => [a.fileName, a.unavailable])).toEqual([
      ['invoice.pdf', 'the bot only downloads files sent through Microsoft Teams'],
      ['image_2', 'the bot only downloads files sent through Microsoft Teams'],
      ['notes.txt', 'the bot only downloads files sent through Microsoft Teams'],
    ]);
    expect(fetches).toHaveLength(0);
  });

  test('a file shared in a channel or group chat is marked unavailable', async () => {
    const shared = "files shared in Teams channels and group chats can't be downloaded by the bot";
    for (const contentType of [
      'reference',
      'application/vnd.microsoft.teams.file.info',
      'application/vnd.microsoft.teams.card.file.info',
    ]) {
      const [event] = await parseAttachments([
        { contentType, contentUrl: 'https://contoso.sharepoint.test/Shared/plan.docx', name: 'plan.docx' },
      ]);
      expect(event!.attachments![0]).toMatchObject({ fileName: 'plan.docx', unavailable: shared });
    }
    expect(fetches).toHaveLength(0);
  });

  test('a file consent card or a nameless file-info attachment is not a file', async () => {
    for (const attachment of [
      { contentType: 'application/vnd.microsoft.teams.card.file.consent', name: 'report.pdf' },
      { contentType: 'application/vnd.microsoft.teams.file.info' },
    ]) {
      expect(await parseAttachments([attachment])).toHaveLength(0);
    }
  });

  test('a redirect off https or off the file hosts is refused', async () => {
    for (const target of [
      'http://169.254.169.254/latest/meta-data/',
      'https://attacker.example/file.pdf',
    ]) {
      fileRoutes.set(DOWNLOAD_URL, () => new Response(null, { status: 302, headers: { Location: target } }));
      const [event] = await parseAttachments([fileDownloadInfo('invoice.pdf', 'pdf')]);
      await expect(event!.attachments![0]!.download()).rejects.toThrow(
        "Teams file download led to a URL that isn't allowed",
      );
      expect(fetches.some((f) => f.url === target)).toBe(false);
    }
  });

  test('more audio types are declared as audio, for transcription', async () => {
    const [event] = await parseAttachments(
      ['aac', 'amr', 'flac', 'opus', 'oga', 'weba'].map((ext) =>
        fileDownloadInfo(`voice.${ext}`, ext),
      ),
    );
    for (const attachment of event!.attachments!) {
      expect(attachment.kind).toBe('audio');
      expect(attachment.contentType?.startsWith('audio/')).toBe(true);
    }
  });

  test('a text file whose content starts with HTML still downloads', async () => {
    const source = '<!DOCTYPE html><html><body>draft</body></html>';
    fileRoutes.set(DOWNLOAD_URL, () => new Response(source, { headers: { 'Content-Type': 'text/plain' } }));
    const [event] = await parseAttachments([fileDownloadInfo('draft.txt', 'txt')]);
    const file = await event!.attachments![0]!.download();
    expect(new TextDecoder().decode(file.data)).toBe(source);
  });

  test('a personal-chat file downloads from downloadUrl as received, without the bot token', async () => {
    fileRoutes.set(DOWNLOAD_URL, () =>
      new Response(PDF_BYTES, { headers: { 'Content-Type': 'application/octet-stream' } }),
    );
    const [event] = await parseAttachments([fileDownloadInfo('invoice.pdf', 'pdf')]);
    const file = await event!.attachments![0]!.download();
    expect(Array.from(file.data)).toEqual(Array.from(PDF_BYTES));
    expect(file.contentType).toBe('application/pdf');
    expect(file.fileName).toBe('invoice.pdf');
    const download = fetches.find((f) => f.url === DOWNLOAD_URL)!;
    expect(download.headers.authorization).toBeUndefined();
    expect(tokenFetches).toBe(0);
  });

  test('an unknown file type takes the type the host serves', async () => {
    fileRoutes.set(DOWNLOAD_URL, () =>
      new Response('a,b\n1,2\n', { headers: { 'Content-Type': 'text/csv; charset=utf-8' } }),
    );
    const [event] = await parseAttachments([fileDownloadInfo('export.dat', 'dat')]);
    expect((await event!.attachments![0]!.download()).contentType).toBe('text/csv');
  });

  test('an inline image downloads with the connector token; its type comes from the bytes', async () => {
    fileRoutes.set(INLINE_IMAGE_URL, () =>
      new Response(PNG_BYTES, { headers: { 'Content-Type': 'application/octet-stream' } }),
    );
    const [event] = await parseAttachments([inlineImage()]);
    const file = await event!.attachments![0]!.download();
    expect(file.contentType).toBe('image/png');
    expect(file.fileName).toBe('image_1');
    const download = fetches.find((f) => f.url === INLINE_IMAGE_URL)!;
    expect(download.headers.authorization).toBe('Bearer connector-token-1');
  });

  // Teams can list a pasted image as GIF and serve a static PNG.
  test('an image takes the type of its bytes over the declared one', async () => {
    fileRoutes.set(INLINE_IMAGE_URL, () =>
      new Response(PNG_BYTES, { headers: { 'Content-Type': 'image/gif' } }),
    );
    const [inline] = await parseAttachments([
      { ...inlineImage(INLINE_IMAGE_URL, 'image/gif'), name: 'animation.gif' },
    ]);
    expect((await inline!.attachments![0]!.download()).contentType).toBe('image/png');

    fileRoutes.set(DOWNLOAD_URL, () =>
      new Response(PNG_BYTES, { headers: { 'Content-Type': 'image/gif' } }),
    );
    const [file] = await parseAttachments([fileDownloadInfo('chart.gif', 'gif')]);
    expect((await file!.attachments![0]!.download()).contentType).toBe('image/png');
  });

  test('a redirect off the connector host drops the token', async () => {
    const blob = 'https://blob.example.test/image';
    fileRoutes.set(INLINE_IMAGE_URL, () =>
      new Response(null, { status: 302, headers: { Location: blob } }),
    );
    fileRoutes.set(blob, () => new Response(PNG_BYTES));
    const [event] = await parseAttachments([inlineImage()]);
    await event!.attachments![0]!.download();
    const hops = fetches.filter((f) => f.url === INLINE_IMAGE_URL || f.url === blob);
    expect(hops.map((f) => [f.url, f.headers.authorization])).toEqual([
      [INLINE_IMAGE_URL, 'Bearer connector-token-1'],
      [blob, undefined],
    ]);
  });

  test('a refused download fails with its status; a URL without tempauth says why', async () => {
    fileRoutes.set(DOWNLOAD_URL, () => new Response('expired', { status: 403 }));
    const [withTempauth] = await parseAttachments([fileDownloadInfo('invoice.pdf', 'pdf')]);
    await expect(withTempauth!.attachments![0]!.download()).rejects.toThrow(
      /^Teams file download failed \(403\)$/,
    );

    // A client secret can't get a file token: the URL is tried as is.
    fileRoutes.set(BARE_DOWNLOAD_URL, () => new Response('unauthorized', { status: 401 }));
    const [withoutTempauth] = await parseAttachments([
      fileDownloadInfo('invoice.pdf', 'pdf', BARE_DOWNLOAD_URL),
    ]);
    await expect(withoutTempauth!.attachments![0]!.download()).rejects.toThrow(
      'Teams file download failed (401): the URL has no tempauth credential and needs a file token, which takes a certificate or federatedToken (not a client secret)',
    );
    expect(fetches.find((f) => f.url === BARE_DOWNLOAD_URL)!.headers.authorization).toBeUndefined();
    expect(fileTokenFetches).toBe(0);
  });

  test('an error page served instead of the file is refused', async () => {
    fileRoutes.set(DOWNLOAD_URL, () =>
      new Response('<!DOCTYPE html><html><body>Sign in</body></html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const [event] = await parseAttachments([fileDownloadInfo('invoice.pdf', 'pdf')]);
    await expect(event!.attachments![0]!.download()).rejects.toThrow(
      'Teams file download returned a web page instead of the file',
    );
  });

  test('an HTML file the user sent still downloads', async () => {
    fileRoutes.set(DOWNLOAD_URL, () =>
      new Response('<!DOCTYPE html><html></html>', { headers: { 'Content-Type': 'text/html' } }),
    );
    const [event] = await parseAttachments([fileDownloadInfo('menu.html', 'html')]);
    expect((await event!.attachments![0]!.download()).contentType).toBe('text/html');
  });

  test('a file over maxFileBytes is refused', async () => {
    fileRoutes.set(DOWNLOAD_URL, () => new Response(PDF_BYTES));
    const capped = teams({
      appId: APP_ID,
      appPassword: APP_PASSWORD,
      openIdMetadataUrl: METADATA_URL,
      loginBase: LOGIN_BASE,
      now: () => NOW,
      fileHosts: ['sharepoint.test'],
      maxFileBytes: 3,
    });
    const [event] = await parseAttachments([fileDownloadInfo('invoice.pdf', 'pdf')], '', capped);
    await expect(event!.attachments![0]!.download()).rejects.toThrow(
      'Teams file is larger than the 3-byte limit (maxFileBytes)',
    );
  });

  // The token request is shared and takes no abort signal: the deadline must
  // still end the download.
  test('a stalled connector-token request still times out', async () => {
    fileRoutes.set(`${LOGIN_BASE}/botframework.com/oauth2/v2.0/token`, () => new Promise<Response>(() => {}));
    const slow = teams({
      appId: APP_ID,
      appPassword: APP_PASSWORD,
      openIdMetadataUrl: METADATA_URL,
      loginBase: LOGIN_BASE,
      now: () => NOW,
      fileTimeoutMs: 20,
    });
    const [event] = await parseAttachments([inlineImage()], '', slow);
    await expect(event!.attachments![0]!.download()).rejects.toThrow(
      'Teams file download timed out after 20ms',
    );
  });

  test('a stalled download times out', async () => {
    fileRoutes.set(
      DOWNLOAD_URL,
      (init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const slow = teams({
      appId: APP_ID,
      appPassword: APP_PASSWORD,
      openIdMetadataUrl: METADATA_URL,
      loginBase: LOGIN_BASE,
      now: () => NOW,
      fileHosts: ['sharepoint.test'],
      fileTimeoutMs: 20,
    });
    const [event] = await parseAttachments([fileDownloadInfo('invoice.pdf', 'pdf')], '', slow);
    await expect(event!.attachments![0]!.download()).rejects.toThrow(
      'Teams file download timed out after 20ms',
    );
  });
});

// ── Through the default channel pipeline ──

/** The default channel pipeline, with Teams in front and a fake Timbal client. */
function teamsPipeline() {
  const invocations: Record<string, unknown>[] = [];
  const uploads: { filename: string; contentType?: string; text: string }[] = [];
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
    async uploadTempFileFromBuffer(data: Uint8Array, filename: string, contentType?: string) {
      uploads.push({ filename, contentType, text: new TextDecoder().decode(data) });
      return { url: `https://cdn.test/tmp/${filename}` };
    },
    async transcribeAudio(_data: Uint8Array, filename: string, contentType: string) {
      transcriptions.push({ filename, contentType });
      return { text: 'the spoken words' };
    },
  } as unknown as Timbal;
  const app = new Elysia().use(
    timbalChannels({ timbal, bindings: [{ adapter: makeAdapter(), workforce: 'a' }] }),
  );
  const post = async (attachments: unknown[], tokenClaims = claims()) => {
    const jwt = await signJwt(keyPair.privateKey, tokenClaims);
    const res = await app.handle(
      new Request('http://localhost/channels/a/teams', {
        method: 'POST',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        body: JSON.stringify(activityFixture({ text: '', attachments })),
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    return res;
  };
  return { post, invocations, uploads, transcriptions };
}

describe('teams attachments through the channel pipeline', () => {
  // The connector token may only go where the signed token says.
  test('a token without, or with a different, serviceurl claim is rejected before any credentialed fetch', async () => {
    const { serviceurl: _omit, ...withoutClaim } = claims();
    for (const tokenClaims of [withoutClaim, claims({ serviceurl: 'https://attacker.example/' })]) {
      const { post, invocations } = teamsPipeline();
      const res = await post([inlineImage()], tokenClaims);
      expect(res.status).toBe(401);
      expect(invocations).toHaveLength(0);
      expect(tokenFetches).toBe(0);
      expect(fetches.some((f) => f.url === INLINE_IMAGE_URL)).toBe(false);
    }
  });

  test('with a matching claim, an inline GIF that is really a PNG is uploaded as a PNG', async () => {
    fileRoutes.set(INLINE_IMAGE_URL, () =>
      new Response(PNG_BYTES, { headers: { 'Content-Type': 'image/gif' } }),
    );
    const { post, uploads } = teamsPipeline();
    const res = await post([{ ...inlineImage(INLINE_IMAGE_URL, 'image/gif'), name: 'animation.gif' }]);
    expect(res.status).toBe(200);
    expect(uploads.map(({ filename, contentType }) => ({ filename, contentType }))).toEqual([
      { filename: 'animation.png', contentType: 'image/png' },
    ]);
    const download = fetches.find((f) => f.url === INLINE_IMAGE_URL)!;
    expect(download.headers.authorization).toBe('Bearer connector-token-1');
  });

  test('a file with an unknown extension takes the type it is served with', async () => {
    fileRoutes.set(DOWNLOAD_URL, () =>
      new Response('a,b\n1,2\n', { headers: { 'Content-Type': 'text/csv; charset=utf-8' } }),
    );
    const { post, uploads, invocations } = teamsPipeline();
    await post([fileDownloadInfo('export.dat', 'dat')]);
    expect(uploads).toEqual([{ filename: 'export.dat', contentType: 'text/csv', text: 'a,b\n1,2\n' }]);
    expect(invocations[0]).toEqual({
      prompt: [{ type: 'file', file: 'https://cdn.test/tmp/export.dat' }],
    });
  });

  test('a .webm is transcribed when it is audio, and refused when it is video', async () => {
    fileRoutes.set(DOWNLOAD_URL, () => new Response(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), {
      headers: { 'Content-Type': 'audio/webm' },
    }));
    const audio = teamsPipeline();
    await audio.post([fileDownloadInfo('voice.webm', 'webm')]);
    expect(audio.transcriptions).toEqual([{ filename: 'voice.webm', contentType: 'audio/webm' }]);
    expect(audio.invocations[0]).toEqual({ prompt: 'the spoken words' });

    fileRoutes.set(DOWNLOAD_URL, () => new Response(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), {
      headers: { 'Content-Type': 'video/webm' },
    }));
    const video = teamsPipeline();
    await video.post([fileDownloadInfo('capture.webm', 'webm')]);
    expect(video.transcriptions).toEqual([]);
    expect(video.uploads).toEqual([]);
    expect(video.invocations[0]).toEqual({
      prompt: [{ type: 'text', text: unsupportedAttachmentNote('capture.webm') }],
    });
  });
});

// ── WebM track lists ──

/** EBML size: 1 to 3 bytes is plenty here. */
const ebmlSize = (n: number): number[] =>
  n < 0x7f ? [0x80 | n] : n < 0x3fff ? [0x40 | (n >> 8), n & 0xff] : [0x20 | (n >> 16), (n >> 8) & 0xff, n & 0xff];
const ebml = (id: number[], body: number[]): number[] => [...id, ...ebmlSize(body.length), ...body];
const ascii = (text: string) => [...new TextEncoder().encode(text)];
/** An 8-byte size with every value bit set: "unknown", as recorders write it. */
const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

/** A minimal WebM: header, unknown-size Segment, Tracks (1 video, 2 audio), a Cluster. */
function webmFile(trackTypes: number[], { tracksAfterCluster = false } = {}): Uint8Array {
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], ascii('webm')));
  const tracks = ebml(
    [0x16, 0x54, 0xae, 0x6b],
    trackTypes.flatMap((type, i) =>
      ebml([0xae], [
        ...ebml([0xd7], [i + 1]),
        ...ebml([0x83], [type]),
        ...ebml([0x86], ascii(type === 1 ? 'V_VP9' : 'A_OPUS')),
      ]),
    ),
  );
  const cluster = ebml([0x1f, 0x43, 0xb6, 0x75], ebml([0xe7], [0]));
  const body = tracksAfterCluster ? [...cluster, ...tracks] : [...tracks, ...cluster];
  return Uint8Array.from([...header, 0x18, 0x53, 0x80, 0x67, ...UNKNOWN_SIZE, ...body]);
}

describe('webmTrackKinds', () => {
  test('reads the track list of recorder output (unknown-size Segment)', () => {
    expect(webmTrackKinds(webmFile([2]))).toEqual({ audio: true, video: false });
    expect(webmTrackKinds(webmFile([1, 2]))).toEqual({ audio: true, video: true });
  });

  test('is undefined for other bytes, or with no track list before the media data', () => {
    expect(webmTrackKinds(new TextEncoder().encode('not a webm'))).toBeUndefined();
    expect(webmTrackKinds(new Uint8Array(0))).toBeUndefined();
    expect(webmTrackKinds(webmFile([2], { tracksAfterCluster: true }))).toBeUndefined();
    // Cut off in the middle of the header.
    expect(webmTrackKinds(webmFile([2]).subarray(0, 6))).toBeUndefined();
  });
});

describe('teams .webm served with a generic type, through the channel pipeline', () => {
  // SharePoint may serve a .webm as application/octet-stream: the track list decides.
  test('an audio-only recording is transcribed; one with a video track is refused', async () => {
    fileRoutes.set(DOWNLOAD_URL, () =>
      new Response(webmFile([2]), { headers: { 'Content-Type': 'application/octet-stream' } }),
    );
    const audio = teamsPipeline();
    await audio.post([fileDownloadInfo('voice.webm', 'webm')]);
    expect(audio.transcriptions).toEqual([{ filename: 'voice.webm', contentType: 'audio/webm' }]);
    expect(audio.invocations[0]).toEqual({ prompt: 'the spoken words' });

    fileRoutes.set(DOWNLOAD_URL, () =>
      new Response(webmFile([1, 2]), { headers: { 'Content-Type': 'application/octet-stream' } }),
    );
    const video = teamsPipeline();
    await video.post([fileDownloadInfo('capture.webm', 'webm')]);
    expect(video.transcriptions).toEqual([]);
    expect(video.uploads).toEqual([]);
    expect(video.invocations[0]).toEqual({
      prompt: [{ type: 'text', text: unsupportedAttachmentNote('capture.webm') }],
    });
  });
});

// ── File tokens (file URLs without tempauth, from March 1, 2027) ──

const FILE_TENANT = 'a1b2c3d4-0000-4000-8000-00000000f11e';
const FILE_SCOPE = 'https://contoso-my.sharepoint.test/.default';
/** Stand-in certificate bytes: only their SHA-256 thumbprint is used. */
const CERT_DER = new Uint8Array([0x30, 0x82, 0x01, 0x0a, 0x02, 0x82, 0x01, 0x01, 0x00, 0xc3]);

const pem = (label: string, der: ArrayBuffer | Uint8Array): string =>
  `-----BEGIN ${label}-----\n${(Buffer.from(der as Uint8Array).toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;

const pemDer = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64'));

let certKeys: CryptoKeyPair;
let certificate: { privateKey: string; certificate: string };
let certThumbprint: string;

beforeEach(async () => {
  certKeys = await crypto.subtle.generateKey(
    {
      name: 'RSA-PSS',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  certificate = {
    privateKey: pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', certKeys.privateKey)),
    certificate: pem('CERTIFICATE', CERT_DER),
  };
  certThumbprint = b64url(await crypto.subtle.digest('SHA-256', CERT_DER));
});

const certAdapter = (overrides: Partial<Parameters<typeof teams>[0]> = {}) =>
  teams({
    appId: APP_ID,
    appPassword: APP_PASSWORD,
    certificate,
    openIdMetadataUrl: METADATA_URL,
    loginBase: LOGIN_BASE,
    fileHosts: ['sharepoint.test'],
    now: () => NOW,
    ...overrides,
  });

const fileTokenRequests = () =>
  fetches
    .filter((f) => f.url.startsWith(LOGIN_BASE) && !f.body?.includes('api.botframework.com'))
    .map((f) => ({ url: f.url, form: new URLSearchParams(f.body ?? '') }));

/** A file attachment whose content names its tenant, as Teams sends it. */
const tenantFile = (downloadUrl: string, tenantId: string | null = FILE_TENANT) => {
  const attachment = fileDownloadInfo('invoice.pdf', 'pdf', downloadUrl);
  return { ...attachment, content: { ...attachment.content, ...(tenantId ? { tenantId } : {}) } };
};

const serveFile = (url: string) =>
  fileRoutes.set(url, () => new Response(PDF_BYTES, { headers: { 'Content-Type': 'application/pdf' } }));

function decodeJwt(jwt: string) {
  const [header, payload, signature] = jwt.split('.');
  const json = (segment: string) => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  return {
    header: json(header!),
    payload: json(payload!),
    signature: new Uint8Array(Buffer.from(signature!, 'base64url')),
    signed: new TextEncoder().encode(`${header}.${payload}`),
  };
}

async function verifiesWith(publicKey: CryptoKey, jwt: string): Promise<boolean> {
  const { signature, signed } = decodeJwt(jwt);
  return crypto.subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, publicKey, signature, signed);
}

describe('teams adapter file tokens', () => {
  test('a file URL without tempauth downloads with a certificate token for its host, in its tenant', async () => {
    serveFile(BARE_DOWNLOAD_URL);
    const [event] = await parseAttachments([tenantFile(BARE_DOWNLOAD_URL)], '', certAdapter());
    const file = await event!.attachments![0]!.download();
    expect(Array.from(file.data)).toEqual(Array.from(PDF_BYTES));

    const download = fetches.find((f) => f.url === BARE_DOWNLOAD_URL)!;
    expect(download.headers.authorization).toBe('Bearer file-token-1');

    const [request] = fileTokenRequests();
    const tokenUrl = `${LOGIN_BASE}/${FILE_TENANT}/oauth2/v2.0/token`;
    expect(request!.url).toBe(tokenUrl);
    expect(request!.form.get('grant_type')).toBe('client_credentials');
    expect(request!.form.get('client_id')).toBe(APP_ID);
    expect(request!.form.get('scope')).toBe(FILE_SCOPE);
    expect(request!.form.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    // Never the client secret: Entra refuses file access with its token.
    expect(request!.form.has('client_secret')).toBe(false);

    const assertion = request!.form.get('client_assertion')!;
    const { header, payload } = decodeJwt(assertion);
    expect(header).toEqual({ alg: 'PS256', typ: 'JWT', 'x5t#S256': certThumbprint });
    expect(payload).toMatchObject({
      aud: tokenUrl,
      iss: APP_ID,
      sub: APP_ID,
      nbf: NOW_SEC,
      iat: NOW_SEC,
      exp: NOW_SEC + 600,
    });
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(await verifiesWith(certKeys.publicKey, assertion)).toBe(true);
    // The bot's connector token isn't involved.
    expect(tokenFetches).toBe(0);
  });

  test('a URL with tempauth gets no token, even with a certificate (name matched ignoring case)', async () => {
    const mixedCase = BARE_DOWNLOAD_URL.replace('ApiVersion', 'TempAuth=v1.x&ApiVersion');
    serveFile(DOWNLOAD_URL);
    serveFile(mixedCase);
    const [event] = await parseAttachments(
      [tenantFile(DOWNLOAD_URL), tenantFile(mixedCase)],
      '',
      certAdapter(),
    );
    for (const attachment of event!.attachments!) await attachment.download();
    for (const url of [DOWNLOAD_URL, mixedCase]) {
      expect(fetches.find((f) => f.url === url)!.headers.authorization).toBeUndefined();
    }
    expect(fileTokenFetches).toBe(0);
  });

  test('file tokens are cached per tenant and host, and shared by concurrent downloads', async () => {
    let clock = NOW;
    const adapter = certAdapter({ now: () => clock });
    const otherHost = 'https://fabrikam-my.sharepoint.test/personal/x/_layouts/15/download.aspx?UniqueId=z';
    const otherTenant = `${BARE_DOWNLOAD_URL}&v=2`;
    for (const url of [BARE_DOWNLOAD_URL, otherHost, otherTenant]) serveFile(url);

    const [event] = await parseAttachments(
      [
        tenantFile(BARE_DOWNLOAD_URL),
        tenantFile(BARE_DOWNLOAD_URL),
        tenantFile(otherHost),
        tenantFile(otherTenant, 'contoso.onmicrosoft.test'),
      ],
      '',
      adapter,
    );
    const [first, second, elsewhere, otherTenantFile] = event!.attachments!;
    await Promise.all([first!.download(), second!.download()]);
    await first!.download();
    expect(fileTokenFetches).toBe(1);

    await elsewhere!.download();
    await otherTenantFile!.download();
    expect(
      fileTokenRequests().map((r) => [r.url.split('/')[3], r.form.get('scope')]),
    ).toEqual([
      [FILE_TENANT, FILE_SCOPE],
      [FILE_TENANT, 'https://fabrikam-my.sharepoint.test/.default'],
      ['contoso.onmicrosoft.test', FILE_SCOPE],
    ]);

    // Near expiry (inside the 60s margin), the token is requested again.
    clock = NOW + 3600_000 - 30_000;
    await first!.download();
    expect(fileTokenFetches).toBe(4);
    expect(fetches.filter((f) => f.url === BARE_DOWNLOAD_URL).at(-1)!.headers.authorization).toBe(
      'Bearer file-token-4',
    );
  });

  test("without content.tenantId, the file's tenant is the activity's, then the tenantId option", async () => {
    serveFile(BARE_DOWNLOAD_URL);
    const tenantOf = async (activity: Record<string, unknown>, adapter = certAdapter()) => {
      clearTeamsAdapterCaches();
      fetches = [];
      const [event] = await adapter.parse(
        req(activityFixture({ text: '', attachments: [tenantFile(BARE_DOWNLOAD_URL, null)], ...activity })),
      );
      await event!.attachments![0]!.download();
      return fileTokenRequests()[0]!.url.split('/')[3];
    };
    expect(await tenantOf({ channelData: { tenant: { id: 'channel-data-tenant' } } })).toBe(
      'channel-data-tenant',
    );
    expect(
      await tenantOf({ conversation: { id: CONVERSATION_ID, tenantId: 'conversation-tenant' } }),
    ).toBe('conversation-tenant');
    expect(await tenantOf({}, certAdapter({ tenantId: 'app-tenant' }))).toBe('app-tenant');

    // A tenant that isn't an ID or domain never reaches the token URL.
    clearTeamsAdapterCaches();
    const [event] = await certAdapter().parse(
      req(activityFixture({ text: '', attachments: [tenantFile(BARE_DOWNLOAD_URL, '../evil?')] })),
    );
    await expect(event!.attachments![0]!.download()).rejects.toThrow(
      'Teams file token needs a tenant ID, and the activity has none',
    );
  });

  test('a federated token is sent as the client assertion', async () => {
    serveFile(BARE_DOWNLOAD_URL);
    let calls = 0;
    const adapter = teams({
      appId: APP_ID,
      federatedToken: async () => {
        calls += 1;
        return ' external-oidc-token\n';
      },
      openIdMetadataUrl: METADATA_URL,
      loginBase: LOGIN_BASE,
      fileHosts: ['sharepoint.test'],
      now: () => NOW,
    });
    const [event] = await parseAttachments([tenantFile(BARE_DOWNLOAD_URL)], '', adapter);
    await event!.attachments![0]!.download();
    const [request] = fileTokenRequests();
    expect(request!.form.get('client_assertion')).toBe('external-oidc-token');
    expect(request!.form.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    expect(fetches.find((f) => f.url === BARE_DOWNLOAD_URL)!.headers.authorization).toBe(
      'Bearer file-token-1',
    );
    expect(calls).toBe(1);
  });

  test('the file token is not sent on a redirect to another file host', async () => {
    const otherHost = 'https://contoso.sharepoint.test/Shared/invoice.pdf';
    fileRoutes.set(BARE_DOWNLOAD_URL, () =>
      new Response(null, { status: 302, headers: { Location: otherHost } }),
    );
    serveFile(otherHost);
    const [event] = await parseAttachments([tenantFile(BARE_DOWNLOAD_URL)], '', certAdapter());
    await event!.attachments![0]!.download();
    const hops = fetches.filter((f) => f.url === BARE_DOWNLOAD_URL || f.url === otherHost);
    expect(hops.map((f) => [f.url, f.headers.authorization])).toEqual([
      [BARE_DOWNLOAD_URL, 'Bearer file-token-1'],
      [otherHost, undefined],
    ]);
  });

  // The token stays on the first host: a 401 from the next one isn't the
  // RSC permission's fault.
  test('a 401 after a redirect to another file host names the redirect, not the permission', async () => {
    const otherHost = 'https://contoso.sharepoint.test/Shared/invoice.pdf';
    fileRoutes.set(BARE_DOWNLOAD_URL, () =>
      new Response(null, { status: 302, headers: { Location: otherHost } }),
    );
    fileRoutes.set(otherHost, () => new Response('unauthorized', { status: 401 }));
    const [event] = await parseAttachments([tenantFile(BARE_DOWNLOAD_URL)], '', certAdapter());
    const error = await event!.attachments![0]!.download().catch((e: Error) => e);
    expect(String(error)).toContain(
      'Teams file download failed (401): the file host redirected to another host, which the file token is not sent to',
    );
    expect(String(error)).not.toContain('File.ReadSelected.User');
  });

  // A stalled exchange is dropped after tokenTimeoutMs, so it can't hold up
  // every later download.
  test('a stalled token request is dropped, and the next download starts a fresh one', async () => {
    serveFile(BARE_DOWNLOAD_URL);
    const adapter = certAdapter({ fileTimeoutMs: 20, tokenTimeoutMs: 40 });
    fileTokenRoute = () => new Promise<Response>(() => {});
    const [first] = await parseAttachments([tenantFile(BARE_DOWNLOAD_URL)], '', adapter);
    await expect(first!.attachments![0]!.download()).rejects.toThrow(
      'Teams file download timed out after 20ms',
    );

    await new Promise((r) => setTimeout(r, 60)); // past tokenTimeoutMs
    fileTokenRoute = undefined; // the endpoint answers again
    const [second] = await parseAttachments([tenantFile(BARE_DOWNLOAD_URL)], '', adapter);
    const file = await second!.attachments![0]!.download();
    expect(Array.from(file.data)).toEqual(Array.from(PDF_BYTES));
    expect(fileTokenFetches).toBe(2);
  });

  // During a rotation, two adapters for the same app, tenant and scope.
  test('adapters with different credentials do not share token requests', async () => {
    serveFile(BARE_DOWNLOAD_URL);
    let retiringCalls = 0;
    let healthyCalls = 0;
    const retiring = certAdapter({
      certificate: undefined,
      federatedToken: async () => {
        retiringCalls += 1;
        return 'retired-assertion';
      },
    });
    const healthy = certAdapter({
      certificate: undefined,
      federatedToken: async () => {
        healthyCalls += 1;
        return 'current-assertion';
      },
    });
    fileTokenRoute = (form) =>
      form.get('client_assertion') === 'retired-assertion'
        ? jsonResponse({ error_description: 'AADSTS700027: Client assertion failed signature validation.' }, 401)
        : jsonResponse({ access_token: 'file-token-current', expires_in: 3600 });

    const [a] = await parseAttachments([tenantFile(BARE_DOWNLOAD_URL)], '', retiring);
    const [b] = await parseAttachments([tenantFile(BARE_DOWNLOAD_URL)], '', healthy);
    const [failed, succeeded] = await Promise.allSettled([
      a!.attachments![0]!.download(),
      b!.attachments![0]!.download(),
    ]);
    expect(failed.status).toBe('rejected');
    expect(succeeded.status).toBe('fulfilled');
    expect([retiringCalls, healthyCalls]).toEqual([1, 1]);

    // Same adapter, concurrent downloads: still one shared request.
    const before = fileTokenFetches;
    clearTeamsAdapterCaches();
    const [c] = await parseAttachments([tenantFile(BARE_DOWNLOAD_URL), tenantFile(BARE_DOWNLOAD_URL)], '', healthy);
    await Promise.all(c!.attachments!.map((attachment) => attachment.download()));
    expect(fileTokenFetches - before).toBe(1);
  });

  // Off the file hosts a redirect isn't followed at all, token or not.
  test('a redirect off the file hosts is refused before it is fetched', async () => {
    const elsewhere = 'https://cdn.example.test/invoice.pdf';
    fileRoutes.set(BARE_DOWNLOAD_URL, () =>
      new Response(null, { status: 302, headers: { Location: elsewhere } }),
    );
    serveFile(elsewhere);
    const [event] = await parseAttachments([tenantFile(BARE_DOWNLOAD_URL)], '', certAdapter());
    await expect(event!.attachments![0]!.download()).rejects.toThrow(
      "Teams file download led to a URL that isn't allowed (https://cdn.example.test)",
    );
    expect(fetches.some((f) => f.url === elsewhere)).toBe(false);
  });

  test("a refused file token fails the download with Entra's reason; a refused token names the RSC permission", async () => {
    serveFile(BARE_DOWNLOAD_URL);
    fileTokenRoute = () =>
      jsonResponse({ error_description: 'AADSTS7000215: Invalid client secret provided.' }, 401);
    const [event] = await parseAttachments([tenantFile(BARE_DOWNLOAD_URL)], '', certAdapter());
    await expect(event!.attachments![0]!.download()).rejects.toThrow(
      'Teams file token failed (401): AADSTS7000215: Invalid client secret provided.',
    );
    expect(fetches.some((f) => f.url === BARE_DOWNLOAD_URL)).toBe(false);

    fileTokenRoute = undefined;
    fileRoutes.set(BARE_DOWNLOAD_URL, () => new Response('forbidden', { status: 403 }));
    await expect(event!.attachments![0]!.download()).rejects.toThrow(
      'Teams file download failed (403): the file token was refused; the app manifest must grant the File.ReadSelected.User RSC permission',
    );
  });

  test('without appPassword, connector tokens come from the certificate', async () => {
    const adapter = certAdapter({ appPassword: undefined, tenantId: 'tenant-1' });
    const [event] = await adapter.parse(req(activityFixture()));
    await adapter.delivery(event!).send('hi');
    const tokenReq = fetches.find((f) => f.url.startsWith(LOGIN_BASE))!;
    const tokenUrl = `${LOGIN_BASE}/tenant-1/oauth2/v2.0/token`;
    expect(tokenReq.url).toBe(tokenUrl);
    const form = new URLSearchParams(tokenReq.body!);
    expect(form.get('scope')).toBe('https://api.botframework.com/.default');
    expect(form.has('client_secret')).toBe(false);
    const assertion = form.get('client_assertion')!;
    expect(decodeJwt(assertion).payload.aud).toBe(tokenUrl);
    expect(await verifiesWith(certKeys.publicKey, assertion)).toBe(true);
    expect(fetches.find((f) => f.url.startsWith(SERVICE_URL))!.headers.authorization).toBe(
      'Bearer connector-token-1',
    );
  });

  test('with appPassword, connector tokens still use the client secret', async () => {
    const adapter = certAdapter();
    const [event] = await adapter.parse(req(activityFixture()));
    await adapter.delivery(event!).send('hi');
    const form = new URLSearchParams(fetches.find((f) => f.url.startsWith(LOGIN_BASE))!.body!);
    expect(form.get('client_secret')).toBe(APP_PASSWORD);
    expect(form.has('client_assertion')).toBe(false);
  });

  test('the adapter needs a client secret, certificate or federated token', () => {
    expect(() => teams({ appId: APP_ID })).toThrow(
      'teams adapter requires an appPassword, certificate or federatedToken',
    );
  });
});

describe('teams certificate assertions', () => {
  const TOKEN_URL = `${LOGIN_BASE}/${FILE_TENANT}/oauth2/v2.0/token`;
  const assertionFor = async (cert: Parameters<typeof certificateAuthentication>[1]) =>
    (await certificateAuthentication(APP_ID, cert, () => NOW)(TOKEN_URL)).client_assertion!;

  test('a PKCS#1 key signs; a combined PEM with escaped newlines supplies the certificate', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(privateKey).toContain('BEGIN RSA PRIVATE KEY');
    const combined = `${privateKey}${pem('CERTIFICATE', CERT_DER)}`.replace(/\n/g, '\\n');
    const assertion = await assertionFor({ privateKey: combined });
    expect(decodeJwt(assertion).header['x5t#S256']).toBe(certThumbprint);
    const verifyKey = await crypto.subtle.importKey(
      'spki',
      pemDer(publicKey),
      { name: 'RSA-PSS', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    expect(await verifiesWith(verifyKey, assertion)).toBe(true);
  });

  test('a SHA-256 thumbprint in hex stands in for the certificate', async () => {
    const hex = Buffer.from(certThumbprint, 'base64url').toString('hex').toUpperCase();
    const colons = hex.match(/../g)!.join(':');
    const assertion = await assertionFor({ privateKey: certificate.privateKey, thumbprintSha256: colons });
    expect(decodeJwt(assertion).header['x5t#S256']).toBe(certThumbprint);
  });

  // A rotated certificate with a stale thumbprint still around: the PEM wins.
  test('the certificate PEM decides the thumbprint over a stale thumbprintSha256', async () => {
    const assertion = await assertionFor({ ...certificate, thumbprintSha256: 'cd'.repeat(32) });
    expect(decodeJwt(assertion).header['x5t#S256']).toBe(certThumbprint);
  });

  test('each assertion has its own jti', async () => {
    const auth = certificateAuthentication(APP_ID, certificate, () => NOW);
    const [a, b] = await Promise.all([auth(TOKEN_URL), auth(TOKEN_URL)]);
    expect(decodeJwt(a.client_assertion!).payload.jti).not.toBe(
      decodeJwt(b.client_assertion!).payload.jti,
    );
  });

  test('unusable certificates fail with what to fix', async () => {
    const { privateKey } = certificate;
    await expect(assertionFor({ privateKey })).rejects.toThrow(
      'Teams certificate needs the certificate PEM (certificate) or its SHA-256 thumbprint (thumbprintSha256)',
    );
    await expect(
      assertionFor({ privateKey, thumbprintSha256: 'A1'.repeat(20) }),
    ).rejects.toThrow('Teams certificate thumbprintSha256 is a SHA-1 thumbprint');
    await expect(assertionFor({ privateKey, thumbprintSha256: 'xyz' })).rejects.toThrow(
      'Teams certificate thumbprintSha256 must be 64 hex characters',
    );
    await expect(
      assertionFor({ privateKey: pem('ENCRYPTED PRIVATE KEY', CERT_DER), certificate: certificate.certificate }),
    ).rejects.toThrow('Teams certificate privateKey is encrypted');
    await expect(
      assertionFor({ privateKey: certificate.certificate, certificate: certificate.certificate }),
    ).rejects.toThrow('Teams certificate privateKey has no PEM private key');
    await expect(
      assertionFor({ privateKey: pem('EC PRIVATE KEY', CERT_DER), certificate: certificate.certificate }),
    ).rejects.toThrow('Teams certificate privateKey must be an RSA key, not EC PRIVATE KEY');
  });
});
