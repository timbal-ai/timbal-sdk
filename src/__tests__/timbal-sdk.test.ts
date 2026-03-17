import { test, expect, describe, beforeEach, mock, afterEach } from 'bun:test';
import { Timbal } from '../lib/timbal';

describe('Timbal', () => {
  let timbal: Timbal;
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 'ok' }),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;

    timbal = new Timbal({
      token: 'test-key',
      baseUrl: 'https://api.test.com',
    });
    mockFetch.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('initialization', () => {
    test('should initialize with config', () => {
      const apiClient = timbal.getApiClient();
      const config = apiClient.getConfig();
      expect(config.token).toBe('test-key');
      expect(config.baseUrl).toBe('https://api.test.com');
    });

    test('should initialize without auth (factory mode)', () => {
      const factory = new Timbal({ baseUrl: 'https://api.test.com' });
      expect(factory.getApiClient()).toBeDefined();
    });

    test('should have all expected methods', () => {
      expect(typeof timbal.query).toBe('function');
      expect(typeof timbal.uploadFile).toBe('function');
      expect(typeof timbal.uploadFileFromBuffer).toBe('function');
      expect(typeof timbal.getSession).toBe('function');
      expect(typeof timbal.getProject).toBe('function');
      expect(typeof timbal.getOAuthUrl).toBe('function');
      expect(typeof timbal.sendMagicLink).toBe('function');
      expect(typeof timbal.refreshToken).toBe('function');
      expect(typeof timbal.listWorkforces).toBe('function');
      expect(typeof timbal.callWorkforce).toBe('function');
      expect(typeof timbal.streamWorkforce).toBe('function');
      expect(typeof timbal.as).toBe('function');
      expect(typeof timbal.getApiClient).toBe('function');
    });
  });

  describe('as', () => {
    test('should create scoped client with token string', () => {
      const factory = new Timbal({ baseUrl: 'https://api.test.com', timeout: 5000 });
      const scoped = factory.as('user-token-123');

      const config = scoped.getApiClient().getConfig();
      expect(config.token).toBe('user-token-123');
      expect(config.baseUrl).toBe('https://api.test.com');
      expect(config.timeout).toBe(5000);
    });

    test('should create scoped client with config object', () => {
      const factory = new Timbal({ baseUrl: 'https://api.test.com' });
      const scoped = factory.as({ token: 'sk-test-key' });

      const config = scoped.getApiClient().getConfig();
      expect(config.token).toBe('sk-test-key');
      expect(config.baseUrl).toBe('https://api.test.com');
    });

    test('should not share auth with parent', () => {
      const orig = process.env.TIMBAL_API_KEY;
      delete process.env.TIMBAL_API_KEY;
      try {
        const factory = new Timbal({ baseUrl: 'https://api.test.com' });
        const scoped = factory.as('user-token-123');

        const parentConfig = factory.getApiClient().getConfig();
        const scopedConfig = scoped.getApiClient().getConfig();
        expect(parentConfig.token).toBe('');
        expect(scopedConfig.token).toBe('user-token-123');
      } finally {
        if (orig !== undefined) process.env.TIMBAL_API_KEY = orig;
      }
    });

    test('should override TIMBAL_API_KEY env var with .as() string', () => {
      const orig = process.env.TIMBAL_API_KEY;
      process.env.TIMBAL_API_KEY = 'env-api-key';
      try {
        const factory = new Timbal({ baseUrl: 'https://api.test.com' });
        expect(factory.getApiClient().getConfig().token).toBe('env-api-key');

        const scoped = factory.as('request-token');
        expect(scoped.getApiClient().getConfig().token).toBe('request-token');
      } finally {
        if (orig !== undefined) process.env.TIMBAL_API_KEY = orig;
        else delete process.env.TIMBAL_API_KEY;
      }
    });

    test('should override TIMBAL_API_KEY env var with .as() config object', () => {
      const orig = process.env.TIMBAL_API_KEY;
      process.env.TIMBAL_API_KEY = 'env-api-key';
      try {
        const factory = new Timbal({ baseUrl: 'https://api.test.com' });
        const scoped = factory.as({ token: 'override-token' });
        expect(scoped.getApiClient().getConfig().token).toBe('override-token');
      } finally {
        if (orig !== undefined) process.env.TIMBAL_API_KEY = orig;
        else delete process.env.TIMBAL_API_KEY;
      }
    });

    test('should allow overriding any config', () => {
      const factory = new Timbal({ baseUrl: 'https://api.test.com', timeout: 30000 });
      const scoped = factory.as({ token: 'tok', timeout: 5000 });

      const config = scoped.getApiClient().getConfig();
      expect(config.timeout).toBe(5000);
      expect(config.token).toBe('tok');
    });
  });

  describe('convenience wrappers', () => {
    test('query should delegate to query function', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ id: 1 }]),
      });

      const result = await timbal.query('SELECT 1', [], { orgId: 'org1', kbId: 'kb1' });
      expect(result).toEqual([{ id: 1 }]);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toBe('https://api.test.com/orgs/org1/kbs/kb1/query');
    });

    test('uploadFile should delegate to uploadFile function', async () => {
      const tempPath = '/tmp/timbal-test-delegate.txt';
      await Bun.write(tempPath, 'test');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 1, name: 'test.txt', url: 'https://x.com/f' }),
      });

      const result = await timbal.uploadFile(tempPath, { orgId: 'org1' });
      expect(result.id).toBe(1);
    });
  });

  describe('getApiClient', () => {
    test('should provide access to API client', () => {
      const apiClient = timbal.getApiClient();
      expect(apiClient).toBeDefined();
      expect(typeof apiClient.get).toBe('function');
      expect(typeof apiClient.post).toBe('function');
    });
  });
});
