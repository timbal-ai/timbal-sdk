import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { getOAuthUrl, sendMagicLink, refreshToken } from '../lib/functions/auth';
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
    getConfig: () => ({ baseUrl: 'https://api.timbal.ai' }),
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
    expect(opts.headers).toEqual({ 'Content-Type': 'application/json' });

    const body = JSON.parse(opts.body as string);
    expect(body.email).toBe('user@example.com');
    expect(body.redirect_uri).toBe('https://myapp.com/callback');
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
    getConfig: () => ({ baseUrl: 'https://api.timbal.ai' }),
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
    expect(opts.headers).toEqual({ 'Content-Type': 'application/x-www-form-urlencoded' });

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

  test('should throw on non-ok response', async () => {
    mockFetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 401,
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    await expect(refreshToken(mockApiClient, 'expired-token'))
      .rejects.toThrow('Token refresh failed');
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
