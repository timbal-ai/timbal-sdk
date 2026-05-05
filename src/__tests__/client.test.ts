import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient, TimbalApiError } from '../lib/api';

describe('ApiClient', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: 'ok' }),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ── Auth ──

  describe('authentication', () => {
    test('should throw AUTH_ERROR when no credentials provided', async () => {
      const orig = process.env.TIMBAL_API_KEY;
      const origConfigDir = process.env.TIMBAL_CONFIG_DIR;
      delete process.env.TIMBAL_API_KEY;
      process.env.TIMBAL_CONFIG_DIR = '/nonexistent';
      const client = new ApiClient({ baseUrl: 'https://api.test.com' });

      try {
        await client.get('/test');
        expect(false).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(TimbalApiError);
        expect((error as TimbalApiError).code).toBe('AUTH_ERROR');
      } finally {
        if (orig !== undefined) process.env.TIMBAL_API_KEY = orig;
        if (origConfigDir !== undefined) process.env.TIMBAL_CONFIG_DIR = origConfigDir;
        else delete process.env.TIMBAL_CONFIG_DIR;
      }
    });

    test('should set Authorization Bearer header with token', async () => {
      const client = new ApiClient({ token: 'my-key', baseUrl: 'https://api.test.com' });
      await client.get('/test');

      const headers = mockFetch.mock.calls[0][1].headers as Headers;
      expect(headers.get('Authorization')).toBe('Bearer my-key');
    });
  });

  // ── URL construction ──

  describe('URL construction', () => {
    test('should handle baseUrl with trailing slash', async () => {
      const client = new ApiClient({ token: 'k', baseUrl: 'https://api.test.com/' });
      await client.get('/test');

      expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/test');
    });

    test('should handle endpoint without leading slash', async () => {
      const client = new ApiClient({ token: 'k', baseUrl: 'https://api.test.com' });
      await client.get('test/path');

      expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/test/path');
    });

    test('should append query string for GET params', async () => {
      const client = new ApiClient({ token: 'k', baseUrl: 'https://api.test.com' });
      await client.get('/test', { status: 'running', limit: 10 });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('status=running');
      expect(url).toContain('limit=10');
    });
  });

  // ── Content-Type ──

  describe('content type', () => {
    test('should set application/json for string body by default', async () => {
      const client = new ApiClient({ token: 'k', baseUrl: 'https://api.test.com' });
      await client.post('/test', { data: 'value' });

      const headers = mockFetch.mock.calls[0][1].headers as Headers;
      expect(headers.get('Content-Type')).toBe('application/json');
    });

    test('should not set Content-Type for FormData', async () => {
      const client = new ApiClient({ token: 'k', baseUrl: 'https://api.test.com' });
      const formData = new FormData();
      formData.append('file', new Blob(['test']), 'test.txt');
      await client.postFormData('/test', formData);

      const headers = mockFetch.mock.calls[0][1].headers as Headers;
      expect(headers.get('Content-Type')).toBeNull();
    });

    test('should use custom content type for postText', async () => {
      const client = new ApiClient({ token: 'k', baseUrl: 'https://api.test.com' });
      await client.postText('/test', 'csv,data', 'text/csv');

      const headers = mockFetch.mock.calls[0][1].headers as Headers;
      expect(headers.get('Content-Type')).toBe('text/csv');
    });
  });

  // ── HTTP methods ──

  describe('HTTP methods', () => {
    const client = () => new ApiClient({ token: 'k', baseUrl: 'https://api.test.com' });

    test('GET should use GET method', async () => {
      await client().get('/test');
      expect(mockFetch.mock.calls[0][1].method).toBe('GET');
    });

    test('POST should use POST method with JSON body', async () => {
      await client().post('/test', { key: 'value' });
      expect(mockFetch.mock.calls[0][1].method).toBe('POST');
      expect(mockFetch.mock.calls[0][1].body).toBe('{"key":"value"}');
    });

    test('PUT should use PUT method', async () => {
      await client().put('/test', { key: 'value' });
      expect(mockFetch.mock.calls[0][1].method).toBe('PUT');
    });

    test('PATCH should use PATCH method', async () => {
      await client().patch('/test', { key: 'value' });
      expect(mockFetch.mock.calls[0][1].method).toBe('PATCH');
    });

    test('DELETE should use DELETE method', async () => {
      await client().delete('/test', { cascade: true });
      expect(mockFetch.mock.calls[0][1].method).toBe('DELETE');
      expect(mockFetch.mock.calls[0][1].body).toBe('{"cascade":true}');
    });

    test('POST without body should not include body', async () => {
      await client().post('/test');
      expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
    });
  });

  // ── Error handling ──

  describe('error handling', () => {
    test('should throw TimbalApiError on 4xx', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({ message: 'Resource not found', code: 'NOT_FOUND' }),
      });

      const client = new ApiClient({ token: 'k', baseUrl: 'https://api.test.com' });

      try {
        await client.get('/missing');
        expect(false).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(TimbalApiError);
        const err = error as TimbalApiError;
        expect(err.statusCode).toBe(404);
        expect(err.message).toBe('Resource not found');
        expect(err.code).toBe('NOT_FOUND');
      }
    });

    test('should return data:null on 204 No Content (DELETE)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        // No json() — would throw if called.
        json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      });

      const client = new ApiClient({ token: 'k', baseUrl: 'https://api.test.com' });
      const result = await client.delete('/test');

      expect(result.data).toBeNull();
      expect(result.statusCode).toBe(204);
      expect(result.success).toBe(true);
    });

    test('should return data:null on empty 200 body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      });

      const client = new ApiClient({ token: 'k', baseUrl: 'https://api.test.com' });
      const result = await client.get('/test');

      expect(result.data).toBeNull();
      expect(result.statusCode).toBe(200);
    });

    test('should handle non-JSON error responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        json: () => Promise.reject(new Error('not json')),
      });

      const client = new ApiClient({
        token: 'k',
        baseUrl: 'https://api.test.com',
        retryAttempts: 0,
      });

      try {
        await client.get('/test');
        expect(false).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(TimbalApiError);
        expect((error as TimbalApiError).message).toBe('Bad Gateway');
      }
    });
  });

  // ── Retries ──

  describe('retries', () => {
    test('should retry on 5xx and eventually succeed', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ message: 'Internal Server Error' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ result: 'ok' }),
        });

      const client = new ApiClient({
        token: 'k',
        baseUrl: 'https://api.test.com',
        retryAttempts: 3,
        retryDelay: 1,
      });

      const result = await client.get('/test');
      expect(result.data).toEqual({ result: 'ok' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test('should not retry on 4xx', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ message: 'Bad Request' }),
      });

      const client = new ApiClient({
        token: 'k',
        baseUrl: 'https://api.test.com',
        retryAttempts: 3,
        retryDelay: 1,
      });

      try {
        await client.get('/test');
      } catch {
        // expected
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('should retry on network error and throw after exhausting retries', async () => {
      mockFetch.mockRejectedValue(new TypeError('fetch failed'));

      const client = new ApiClient({
        token: 'k',
        baseUrl: 'https://api.test.com',
        retryAttempts: 2,
        retryDelay: 1,
      });

      try {
        await client.get('/test');
        expect(false).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(TimbalApiError);
        expect((error as TimbalApiError).code).toBe('NETWORK_ERROR');
      }

      // 1 initial + 2 retries
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    test('should retry on timeout and throw after exhausting retries', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValue(abortError);

      const client = new ApiClient({
        token: 'k',
        baseUrl: 'https://api.test.com',
        retryAttempts: 1,
        retryDelay: 1,
      });

      try {
        await client.get('/test');
        expect(false).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(TimbalApiError);
        expect((error as TimbalApiError).code).toBe('TIMEOUT_ERROR');
      }

      // 1 initial + 1 retry
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  // ── Config ──

  describe('getConfig', () => {
    test('should return config with defaults applied', () => {
      const savedBaseUrl = process.env.TIMBAL_BASE_URL;
      const savedApiHost = process.env.TIMBAL_API_HOST;
      const savedConfigDir = process.env.TIMBAL_CONFIG_DIR;
      delete process.env.TIMBAL_BASE_URL;
      delete process.env.TIMBAL_API_HOST;
      process.env.TIMBAL_CONFIG_DIR = '/nonexistent';
      try {
        const client = new ApiClient({ token: 'k' });
        const config = client.getConfig();
        expect(config.baseUrl).toBe('https://api.timbal.ai');
        expect(config.timeout).toBe(30000);
        expect(config.retryAttempts).toBe(3);
        expect(config.retryDelay).toBe(1000);
      } finally {
        if (savedBaseUrl !== undefined) process.env.TIMBAL_BASE_URL = savedBaseUrl;
        else delete process.env.TIMBAL_BASE_URL;
        if (savedApiHost !== undefined) process.env.TIMBAL_API_HOST = savedApiHost;
        else delete process.env.TIMBAL_API_HOST;
        if (savedConfigDir !== undefined) process.env.TIMBAL_CONFIG_DIR = savedConfigDir;
        else delete process.env.TIMBAL_CONFIG_DIR;
      }
    });

    test('should return a copy (not a reference)', () => {
      const client = new ApiClient({ token: 'k' });
      const config1 = client.getConfig();
      const config2 = client.getConfig();

      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2);
    });

    test('should default rev to "main" when nothing is configured', () => {
      const saved = process.env.TIMBAL_PROJECT_REV;
      delete process.env.TIMBAL_PROJECT_REV;
      try {
        const client = new ApiClient({ token: 'k' });
        expect(client.getConfig().rev).toBe('main');
      } finally {
        if (saved !== undefined) process.env.TIMBAL_PROJECT_REV = saved;
        else delete process.env.TIMBAL_PROJECT_REV;
      }
    });

    test('should read rev from TIMBAL_PROJECT_REV env var', () => {
      const saved = process.env.TIMBAL_PROJECT_REV;
      process.env.TIMBAL_PROJECT_REV = 'feature-branch';
      try {
        const client = new ApiClient({ token: 'k' });
        expect(client.getConfig().rev).toBe('feature-branch');
      } finally {
        if (saved !== undefined) process.env.TIMBAL_PROJECT_REV = saved;
        else delete process.env.TIMBAL_PROJECT_REV;
      }
    });

    test('should let explicit rev override TIMBAL_PROJECT_REV env var', () => {
      const saved = process.env.TIMBAL_PROJECT_REV;
      process.env.TIMBAL_PROJECT_REV = 'feature-branch';
      try {
        const client = new ApiClient({ token: 'k', rev: 'release' });
        expect(client.getConfig().rev).toBe('release');
      } finally {
        if (saved !== undefined) process.env.TIMBAL_PROJECT_REV = saved;
        else delete process.env.TIMBAL_PROJECT_REV;
      }
    });
  });

  // ── Raw fetch ──

  describe('fetch (raw)', () => {
    test('returns the raw Response without parsing', async () => {
      const fakeResponse = {
        ok: true,
        status: 200,
        body: 'sentinel-stream',
        json: () => Promise.reject(new Error('should not be called')),
      };
      mockFetch = mock(() => Promise.resolve(fakeResponse));
      global.fetch = mockFetch as unknown as typeof global.fetch;

      const client = new ApiClient({ token: 'k', baseUrl: 'https://api.test.com' });
      const resp = await client.fetch('/stream', { method: 'POST', body: '{"x":1}' });

      expect(resp).toBe(fakeResponse as unknown as Response);
      expect(resp.ok).toBe(true);
      expect((resp as unknown as { body: string }).body).toBe('sentinel-stream');
    });

    test('attaches Authorization header and resolves baseUrl', async () => {
      const client = new ApiClient({ token: 'my-key', baseUrl: 'https://api.test.com' });
      await client.fetch('/runs/stream', { method: 'POST' });

      expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/runs/stream');
      const headers = mockFetch.mock.calls[0][1].headers as Headers;
      expect(headers.get('Authorization')).toBe('Bearer my-key');
    });

    test('does NOT throw on non-2xx — caller decides', async () => {
      const errResponse = {
        ok: false,
        status: 500,
        json: () => Promise.resolve({ message: 'boom' }),
      };
      mockFetch = mock(() => Promise.resolve(errResponse));
      global.fetch = mockFetch as unknown as typeof global.fetch;

      const client = new ApiClient({ token: 'k', baseUrl: 'https://api.test.com' });
      const resp = await client.fetch('/x', { method: 'GET' });

      expect(resp.ok).toBe(false);
      expect(resp.status).toBe(500);
    });

    test('does NOT auto-retry on 5xx (single call)', async () => {
      const errResponse = { ok: false, status: 503, json: () => Promise.resolve({}) };
      mockFetch = mock(() => Promise.resolve(errResponse));
      global.fetch = mockFetch as unknown as typeof global.fetch;

      const client = new ApiClient({
        token: 'k',
        baseUrl: 'https://api.test.com',
        retryAttempts: 3,
        retryDelay: 1,
      });
      await client.fetch('/x');

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('throws AUTH_ERROR when no token configured', async () => {
      const orig = process.env.TIMBAL_API_KEY;
      const origConfigDir = process.env.TIMBAL_CONFIG_DIR;
      delete process.env.TIMBAL_API_KEY;
      process.env.TIMBAL_CONFIG_DIR = '/nonexistent';
      const client = new ApiClient({ baseUrl: 'https://api.test.com' });

      try {
        await client.fetch('/x');
        expect(false).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(TimbalApiError);
        expect((error as TimbalApiError).code).toBe('AUTH_ERROR');
      } finally {
        if (orig !== undefined) process.env.TIMBAL_API_KEY = orig;
        if (origConfigDir !== undefined) process.env.TIMBAL_CONFIG_DIR = origConfigDir;
        else delete process.env.TIMBAL_CONFIG_DIR;
      }
    });

    test('forwards caller-provided AbortSignal', async () => {
      const client = new ApiClient({ token: 'k', baseUrl: 'https://api.test.com' });
      const controller = new AbortController();
      await client.fetch('/x', { method: 'GET', signal: controller.signal });

      expect(mockFetch.mock.calls[0][1].signal).toBe(controller.signal);
    });
  });
});

// ── File config (profile loading) ──

describe('ApiClient file config', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const MANAGED_VARS = ['TIMBAL_CONFIG_DIR', 'TIMBAL_PROFILE', 'TIMBAL_API_KEY', 'TIMBAL_ORG_ID', 'TIMBAL_BASE_URL', 'TIMBAL_API_HOST'];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'timbal-config-test-'));
    for (const key of MANAGED_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.TIMBAL_CONFIG_DIR = tmpDir;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    for (const key of MANAGED_VARS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  async function writeConfig(content: string) {
    await writeFile(join(tmpDir, 'config'), content, 'utf8');
  }

  async function writeCredentials(content: string) {
    await writeFile(join(tmpDir, 'credentials'), content, 'utf8');
  }

  test('loads token from credentials file default profile', async () => {
    await writeCredentials('[default]\napi_key = file-token\n');
    const client = new ApiClient({});
    expect(client.getConfig().token).toBe('file-token');
  });

  test('loads orgId from config file default profile', async () => {
    await writeCredentials('[default]\napi_key = t\n');
    await writeConfig('[default]\norg = file-org\n');
    const client = new ApiClient({});
    expect(client.getConfig().orgId).toBe('file-org');
  });

  test('loads baseUrl from config file default profile', async () => {
    await writeCredentials('[default]\napi_key = t\n');
    await writeConfig('[default]\nbase_url = https://staging.timbal.ai\n');
    const client = new ApiClient({});
    expect(client.getConfig().baseUrl).toBe('https://staging.timbal.ai');
  });

  test('loads named profile when TIMBAL_PROFILE is set', async () => {
    await writeCredentials('[default]\napi_key = default-token\n\n[profile staging]\napi_key = staging-token\n');
    process.env.TIMBAL_PROFILE = 'staging';
    const client = new ApiClient({});
    expect(client.getConfig().token).toBe('staging-token');
  });

  test('explicit config takes precedence over file', async () => {
    await writeCredentials('[default]\napi_key = file-token\n');
    await writeConfig('[default]\norg = file-org\n');
    const client = new ApiClient({ token: 'explicit-token', orgId: 'explicit-org' });
    expect(client.getConfig().token).toBe('explicit-token');
    expect(client.getConfig().orgId).toBe('explicit-org');
  });

  test('env var takes precedence over file', async () => {
    await writeCredentials('[default]\napi_key = file-token\n');
    process.env.TIMBAL_API_KEY = 'env-token';
    const client = new ApiClient({});
    expect(client.getConfig().token).toBe('env-token');
  });

  test('loads all fields together from file', async () => {
    await writeCredentials('[default]\napi_key = file-token\n');
    await writeConfig('[default]\norg = file-org\nbase_url = https://custom.timbal.ai\n');
    const client = new ApiClient({});
    expect(client.getConfig().token).toBe('file-token');
    expect(client.getConfig().orgId).toBe('file-org');
    expect(client.getConfig().baseUrl).toBe('https://custom.timbal.ai');
  });

  test('silently ignores missing config files', async () => {
    const client = new ApiClient({ token: 'direct' });
    expect(client.getConfig().token).toBe('direct');
  });

  test('silently ignores malformed config file', async () => {
    await writeCredentials('not valid ini %%% ===\n');
    const client = new ApiClient({ token: 'direct' });
    expect(client.getConfig().token).toBe('direct');
  });

  test('falls back gracefully when profile section not in file', async () => {
    await writeCredentials('[default]\napi_key = default-token\n');
    process.env.TIMBAL_PROFILE = 'nonexistent';
    const client = new ApiClient({ token: 'explicit' });
    expect(client.getConfig().token).toBe('explicit');
  });

  test('named profile in credentials and config are both loaded', async () => {
    await writeCredentials('[default]\napi_key = default-token\n\n[profile prod]\napi_key = prod-token\n');
    await writeConfig('[default]\norg = default-org\n\n[profile prod]\norg = prod-org\n');
    process.env.TIMBAL_PROFILE = 'prod';
    const client = new ApiClient({});
    expect(client.getConfig().token).toBe('prod-token');
    expect(client.getConfig().orgId).toBe('prod-org');
  });
});

