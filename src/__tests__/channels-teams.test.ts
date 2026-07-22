import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { teams, clearTeamsAdapterCaches } from '../channels/adapters/teams';
import type { WebhookRequest } from '../channels/types';

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
    recipient: { id: `28:${APP_ID}` },
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
let tokenFetches: number;
let realFetch: typeof fetch;

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
    if (url === METADATA_URL) return jsonResponse({ jwks_uri: JWKS_URL });
    if (url === JWKS_URL) return jsonResponse({ keys: [publicJwk] });
    if (url.startsWith(`${LOGIN_BASE}/`)) {
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
