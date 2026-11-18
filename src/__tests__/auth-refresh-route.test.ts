import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Elysia } from 'elysia';
import { timbalAuth } from '../elysia';
import { resetRejectedRefreshTokens } from '../elysia/refresh-denylist';

const DEAD = 'eyJhbGciOiJSUzI1NiIsImtpZCI6Im9sZC1raWQifQ.eyJzdWIiOiJ1c2VyIn0.dead-signature';
const OTHER = 'eyJhbGciOiJSUzI1NiIsImtpZCI6Im9sZC1raWQifQ.eyJzdWIiOiJvdGhlciJ9.other-signature';
const SERVICE = 't3_proj_sk_SHOULD_NOT_BE_A_SESSION';
const BASE = 'https://api.test.example';

const ENV_KEYS = [
  'TIMBAL_PROJECT_ID',
  'TIMBAL_ORG_ID',
  'TIMBAL_AUTH_MODE',
  'TIMBAL_API_KEY',
  'TIMBAL_PROJECT_SECRET',
  'TIMBAL_BASE_URL',
  'TIMBAL_API_HOST',
] as const;

function postRefresh(token: string) {
  return new Request('http://localhost/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: token }),
  });
}

function cookieHeader(res: Response): string {
  const cookies = res.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) return cookies.join('\n');
  return res.headers.get('set-cookie') ?? '';
}

describe('POST /auth/refresh', () => {
  const saved: Record<string, string | undefined> = {};
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    delete process.env.TIMBAL_PROJECT_ID;
    delete process.env.TIMBAL_ORG_ID;
    delete process.env.TIMBAL_AUTH_MODE;
    delete process.env.TIMBAL_API_KEY;
    delete process.env.TIMBAL_API_HOST;
    process.env.TIMBAL_BASE_URL = BASE;
    process.env.TIMBAL_PROJECT_SECRET = SERVICE;
    resetRejectedRefreshTokens();
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetRejectedRefreshTokens();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  function app() {
    return new Elysia().use(timbalAuth());
  }

  test('invalid_grant is terminal, clears auth cookies, and is not forwarded again', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    global.fetch = mock((url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: 'invalid_grant',
            error_description: 'Token signed with unknown key',
          }),
      });
    }) as unknown as typeof global.fetch;

    const elysia = app();
    const first = await elysia.handle(postRefresh(DEAD));
    const second = await elysia.handle(postRefresh(DEAD));
    const firstBody = await first.json();
    const secondBody = await second.json();

    expect(first.status).toBe(400);
    expect(firstBody).toEqual({
      error: 'invalid_grant',
      error_description: 'Token signed with unknown key',
    });
    expect(second.status).toBe(400);
    expect(secondBody).toEqual(firstBody);
    expect(JSON.stringify(firstBody)).not.toContain(DEAD);
    expect(JSON.stringify(secondBody)).not.toContain(SERVICE);
    expect(JSON.stringify(secondBody)).not.toContain('access_token');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/oauth/token`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${SERVICE}`);
    const body = new URLSearchParams(calls[0].init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe(DEAD);

    for (const res of [first, second]) {
      const setCookie = cookieHeader(res).toLowerCase();
      expect(setCookie).toContain('timbal_project_access_token=');
      expect(setCookie).toContain('timbal_project_refresh_token=');
      expect(setCookie).toContain('max-age=0');
      expect(setCookie).not.toContain(DEAD.toLowerCase());
      expect(setCookie).not.toContain(SERVICE.toLowerCase());
    }
  });

  test('upstream 401 is answered as 400 invalid_grant', async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({
            error: 'invalid_grant',
            error_description: 'revoked',
          }),
      })
    ) as unknown as typeof global.fetch;

    const res = await app().handle(postRefresh(OTHER));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'revoked',
    });
    expect(cookieHeader(res).toLowerCase()).toContain('max-age=0');
  });

  test('a different refresh token is still forwarded', async () => {
    const seen: string[] = [];
    global.fetch = mock((_url: string, init: RequestInit) => {
      seen.push(new URLSearchParams(init.body as string).get('refresh_token') ?? '');
      return Promise.resolve({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: 'invalid_grant',
            error_description: 'Token signed with unknown key',
          }),
      });
    }) as unknown as typeof global.fetch;

    const elysia = app();
    await elysia.handle(postRefresh(DEAD));
    await elysia.handle(postRefresh(DEAD));
    const other = await elysia.handle(postRefresh(OTHER));

    expect(other.status).toBe(400);
    expect(seen).toEqual([DEAD, OTHER]);
  });

  test('upstream 5xx stays 401 and is retried', async () => {
    let n = 0;
    global.fetch = mock(() => {
      n += 1;
      return Promise.resolve({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: 'temporarily_unavailable' }),
      });
    }) as unknown as typeof global.fetch;

    const elysia = app();
    const first = await elysia.handle(postRefresh(DEAD));
    const second = await elysia.handle(postRefresh(DEAD));

    expect(first.status).toBe(401);
    expect(await first.json()).toEqual({ error: 'Refresh failed' });
    expect(second.status).toBe(401);
    expect(n).toBe(2);
  });

  test('network errors stay 401 and are not denylisted', async () => {
    let n = 0;
    global.fetch = mock(() => {
      n += 1;
      return Promise.reject(new TypeError('network down'));
    }) as unknown as typeof global.fetch;

    const elysia = app();
    const first = await elysia.handle(postRefresh(DEAD));
    const second = await elysia.handle(postRefresh(DEAD));

    expect(first.status).toBe(401);
    expect(await first.json()).toEqual({ error: 'Refresh failed' });
    expect(second.status).toBe(401);
    expect(n).toBe(2);
  });

  test('success sets the access cookie and does not denylist the refresh token', async () => {
    let n = 0;
    global.fetch = mock(() => {
      n += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: 'new-access', refresh_token: null }),
      });
    }) as unknown as typeof global.fetch;

    const elysia = app();
    const res = await elysia.handle(postRefresh(DEAD));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      access_token: 'new-access',
      refresh_token: DEAD,
    });
    const setCookie = cookieHeader(res);
    expect(setCookie).toContain('timbal_project_access_token=new-access');
    expect(setCookie.toLowerCase()).not.toContain('max-age=0');

    await elysia.handle(postRefresh(DEAD));
    expect(n).toBe(2);
  });

  test('does not log the raw refresh token', async () => {
    const lines: string[] = [];
    const orig = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    const spy = (...args: unknown[]) => {
      lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    console.log = spy;
    console.info = spy;
    console.warn = spy;
    console.error = spy;
    console.debug = spy;

    global.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: 'invalid_grant',
            error_description: 'Token signed with unknown key',
          }),
      })
    ) as unknown as typeof global.fetch;

    try {
      const elysia = app();
      await elysia.handle(postRefresh(DEAD));
      await elysia.handle(postRefresh(DEAD));
      expect(lines.join('\n')).not.toContain(DEAD);
      expect(lines.join('\n')).not.toContain(SERVICE);
    } finally {
      console.log = orig.log;
      console.info = orig.info;
      console.warn = orig.warn;
      console.error = orig.error;
      console.debug = orig.debug;
    }
  });
});
