import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  getOAuthUrl,
  sendMagicLink,
  refreshToken,
  RefreshTokenInvalidError,
} from '../lib/functions/auth';
import { RefreshTokenInvalidError as ExportedRefreshTokenInvalidError } from '../lib/functions';
import { Timbal } from '../lib/timbal';

// ── getOAuthUrl ──

describe('getOAuthUrl', () => {
  const mockApiClient = {
    getConfig: () => ({ baseUrl: 'https://api.timbal.ai' }),
  } as any;

  test('should build correct OAuth URL for github', () => {
    const url = getOAuthUrl(mockApiClient, 'github', 'https://myapp.com/callback');

    expect(url).toBe(
      'https://api.timbal.ai/oauth/authorize?provider=github&redirect_uri=https%3A%2F%2Fmyapp.com%2Fcallback'
    );
  });

  test('should build correct OAuth URL for google', () => {
    const url = getOAuthUrl(mockApiClient, 'google', 'https://myapp.com/callback');

    expect(url).toContain('provider=google');
  });

  test('should build correct OAuth URL for microsoft', () => {
    const url = getOAuthUrl(mockApiClient, 'microsoft', 'https://myapp.com/callback');

    expect(url).toContain('provider=microsoft');
  });

  test('should encode redirect URI with special characters', () => {
    const url = getOAuthUrl(mockApiClient, 'github', 'https://myapp.com/callback?foo=bar&baz=1');

    expect(url).toContain('redirect_uri=https%3A%2F%2Fmyapp.com%2Fcallback%3Ffoo%3Dbar%26baz%3D1');
  });

  test('should use the client baseUrl', () => {
    const customClient = {
      getConfig: () => ({ baseUrl: 'https://dev.timbal.ai' }),
    } as any;

    const url = getOAuthUrl(customClient, 'github', 'https://myapp.com/callback');

    expect(url).toStartWith('https://dev.timbal.ai/oauth/authorize');
  });
});

// ── sendMagicLink ──

describe('sendMagicLink', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  const mockApiClient = {
    getConfig: () => ({ baseUrl: 'https://api.timbal.ai', token: 'test-api-key' }),
  } as any;

  const mockApiClientNoToken = {
    getConfig: () => ({ baseUrl: 'https://api.timbal.ai', token: '' }),
  } as any;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should POST to /auth/magic-link with correct body', async () => {
    mockFetch = mock(() => Promise.resolve({ ok: true, status: 200 }));
    global.fetch = mockFetch as unknown as typeof global.fetch;

    await sendMagicLink(mockApiClient, 'user@example.com', 'https://myapp.com/callback');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.timbal.ai/auth/magic-link');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body as string);
    expect(body.email).toBe('user@example.com');
    expect(body.redirect_uri).toBe('https://myapp.com/callback');
  });

  test('should include Authorization header when token is available', async () => {
    mockFetch = mock(() => Promise.resolve({ ok: true, status: 200 }));
    global.fetch = mockFetch as unknown as typeof global.fetch;

    await sendMagicLink(mockApiClient, 'user@example.com', 'https://myapp.com/callback');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-api-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('should omit Authorization header when no token', async () => {
    mockFetch = mock(() => Promise.resolve({ ok: true, status: 200 }));
    global.fetch = mockFetch as unknown as typeof global.fetch;

    await sendMagicLink(mockApiClientNoToken, 'user@example.com', 'https://myapp.com/callback');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  test('should throw on non-ok response with error text', async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Invalid email address'),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    await expect(sendMagicLink(mockApiClient, 'bad', 'https://myapp.com/callback'))
      .rejects.toThrow('Invalid email address');
  });

  test('should throw default message when error body is empty', async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve(''),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    await expect(sendMagicLink(mockApiClient, 'user@example.com', 'https://myapp.com/callback'))
      .rejects.toThrow('Failed to send magic link');
  });
});

// ── refreshToken ──

describe('refreshToken', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  const mockApiClient = {
    getConfig: () => ({ baseUrl: 'https://api.timbal.ai', token: 'test-api-key' }),
  } as any;

  const mockTokens = {
    access_token: 'new-access-token',
    refresh_token: 'new-refresh-token',
  };

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should POST to /oauth/token with correct form body', async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockTokens),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const tokens = await refreshToken(mockApiClient, 'old-refresh-token');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.timbal.ai/oauth/token');
    expect(opts.method).toBe('POST');

    const headers = opts.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers['Authorization']).toBe('Bearer test-api-key');

    const body = new URLSearchParams(opts.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh-token');
  });

  test('should return token pair on success', async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockTokens),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const tokens = await refreshToken(mockApiClient, 'old-refresh-token');

    expect(tokens.access_token).toBe('new-access-token');
    expect(tokens.refresh_token).toBe('new-refresh-token');
  });

  test('401 with no OAuth body is a terminal RefreshTokenInvalidError', async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const err = await refreshToken(mockApiClient, 'expired-token').catch(e => e);
    expect(err).toBeInstanceOf(RefreshTokenInvalidError);
    expect(err).toBeInstanceOf(ExportedRefreshTokenInvalidError);
    expect(err.message).toBe('Token refresh failed');
    expect(err.status).toBe(401);
    expect(err.oauthError).toBe('invalid_grant');
    expect(err.name).toBe('RefreshTokenInvalidError');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('400 invalid_grant surfaces the OAuth description and does not retry', async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: 'invalid_grant',
            error_description: 'Token signed with unknown key',
          }),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const err = await refreshToken(mockApiClient, 'dead-refresh-token-value').catch(e => e);
    expect(err).toBeInstanceOf(RefreshTokenInvalidError);
    expect(err.status).toBe(400);
    expect(err.oauthError).toBe('invalid_grant');
    expect(err.message).toBe('Token signed with unknown key');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('401 invalid_client is terminal and keeps the OAuth code', async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () =>
          Promise.resolve({
            error: 'invalid_client',
            error_description: 'Client authentication failed',
          }),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const err = await refreshToken(mockApiClient, 'some-refresh-token').catch(e => e);
    expect(err).toBeInstanceOf(RefreshTokenInvalidError);
    expect(err.oauthError).toBe('invalid_client');
    expect(err.status).toBe(401);
  });

  test('invalid_grant on a non-400 status is still terminal', async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () =>
          Promise.resolve({
            error: 'invalid_grant',
            error_description: 'Token signed with unknown key',
          }),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const err = await refreshToken(mockApiClient, 'dead-refresh-token-value').catch(e => e);
    expect(err).toBeInstanceOf(RefreshTokenInvalidError);
    expect(err.status).toBe(500);
    expect(err.oauthError).toBe('invalid_grant');
  });

  test('5xx without an OAuth rejection stays a generic transient error', async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: 'temporarily_unavailable' }),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const err = await refreshToken(mockApiClient, 'still-valid-token').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RefreshTokenInvalidError);
    expect(err.message).toBe('Token refresh failed');
  });

  test('429 is transient', async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ error: 'slow_down' }),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const err = await refreshToken(mockApiClient, 'still-valid-token').catch(e => e);
    expect(err).not.toBeInstanceOf(RefreshTokenInvalidError);
    expect(err.message).toBe('Token refresh failed');
  });

  test('non-JSON 400 is still terminal', async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.reject(new Error('not json')),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const err = await refreshToken(mockApiClient, 'dead-refresh-token-value').catch(e => e);
    expect(err).toBeInstanceOf(RefreshTokenInvalidError);
    expect(err.message).toBe('Token refresh failed');
    expect(err.oauthError).toBe('invalid_grant');
  });

  test('network failures propagate and are not RefreshTokenInvalidError', async () => {
    const network = new TypeError('network down');
    mockFetch = mock(() => Promise.reject(network));
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const err = await refreshToken(mockApiClient, 'dead-refresh-token-value').catch(e => e);
    expect(err).toBe(network);
    expect(err).not.toBeInstanceOf(RefreshTokenInvalidError);
  });

  test('does not echo the refresh token in the error', async () => {
    const secret = 'eyJhbGciOiJSUzI1NiIsImtpZCI6Im9sZCJ9.payload.signature';
    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            error: 'invalid_grant',
            error_description: `rejected ${secret}`,
          }),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const err = await refreshToken(mockApiClient, secret).catch(e => e);
    expect(err).toBeInstanceOf(RefreshTokenInvalidError);
    expect(err.message).toBe('Token refresh failed');
    expect(err.message).not.toContain(secret);
    expect(String(err.oauthError)).not.toContain(secret);
  });
});

// ── Timbal class integration ──

describe('Timbal auth methods', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('getOAuthUrl should work through Timbal class', () => {
    const timbal = new Timbal({ baseUrl: 'https://api.test.com' });
    const url = timbal.getOAuthUrl('github', 'https://myapp.com/cb');

    expect(url).toBe(
      'https://api.test.com/oauth/authorize?provider=github&redirect_uri=https%3A%2F%2Fmyapp.com%2Fcb'
    );
  });

  test('getOAuthUrl should use default baseUrl', () => {
    const savedBaseUrl = process.env.TIMBAL_BASE_URL;
    const savedApiHost = process.env.TIMBAL_API_HOST;
    const savedConfigDir = process.env.TIMBAL_CONFIG_DIR;
    delete process.env.TIMBAL_BASE_URL;
    delete process.env.TIMBAL_API_HOST;
    process.env.TIMBAL_CONFIG_DIR = '/nonexistent';
    try {
      const timbal = new Timbal({});
      const url = timbal.getOAuthUrl('google', 'https://myapp.com/cb');
      expect(url).toStartWith('https://api.timbal.ai/oauth/authorize');
    } finally {
      if (savedBaseUrl !== undefined) process.env.TIMBAL_BASE_URL = savedBaseUrl;
      else delete process.env.TIMBAL_BASE_URL;
      if (savedApiHost !== undefined) process.env.TIMBAL_API_HOST = savedApiHost;
      else delete process.env.TIMBAL_API_HOST;
      if (savedConfigDir !== undefined) process.env.TIMBAL_CONFIG_DIR = savedConfigDir;
      else delete process.env.TIMBAL_CONFIG_DIR;
    }
  });

  test('sendMagicLink should work through Timbal class', async () => {
    mockFetch = mock(() => Promise.resolve({ ok: true, status: 200 }));
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const timbal = new Timbal({ baseUrl: 'https://api.test.com' });
    await timbal.sendMagicLink('user@example.com', 'https://myapp.com/cb');

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/auth/magic-link');
  });

  test('refreshToken should work through Timbal class', async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: 'new', refresh_token: 'new-rt' }),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    const timbal = new Timbal({ baseUrl: 'https://api.test.com' });
    const tokens = await timbal.refreshToken('old-rt');

    expect(tokens.access_token).toBe('new');
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/oauth/token');
  });

  test('auth methods should not require a token', async () => {
    const timbal = new Timbal({});

    // getOAuthUrl is sync and needs no auth
    const url = timbal.getOAuthUrl('github', 'https://myapp.com/cb');
    expect(url).toContain('provider=github');

    // sendMagicLink and refreshToken use raw fetch, not ApiClient
    mockFetch = mock(() => Promise.resolve({ ok: true, status: 200 }));
    global.fetch = mockFetch as unknown as typeof global.fetch;
    await timbal.sendMagicLink('user@example.com', 'https://myapp.com/cb');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
