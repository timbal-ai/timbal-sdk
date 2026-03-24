import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { listWorkforces, callWorkforce, streamWorkforce, clearDeploymentCache } from '../lib/functions/workforce';
import { Timbal } from '../lib/timbal';
import type { WorkforceContext } from '../types';

const remoteCtx: WorkforceContext = {
  orgId: 'org1',
  projectId: 'proj1',
  projectEnvId: 'env1',
};

// ── listWorkforces ──

describe('listWorkforces', () => {
  const mockApiClient = {
    get: mock(() =>
      Promise.resolve({
        data: {
          workforce: [
            { id: '361', uid: 'manifest-1', type: 'workflow', name: 'clever-jaguar', description: null },
            { id: '360', uid: 'manifest-2', type: 'agent', name: 'eager-pelican', description: null },
          ],
        },
      })
    ),
    getConfig: () => ({ orgId: '', projectId: '', projectEnvId: '', kbId: '', token: '' }),
  } as any;

  let originalStartEnv: string | undefined;
  let originalWorkforceEnv: string | undefined;

  beforeEach(() => {
    clearDeploymentCache();
    mockApiClient.get.mockClear();
    originalStartEnv = process.env.TIMBAL_START_WORKFORCE;
    originalWorkforceEnv = process.env.TIMBAL_WORKFORCE;
    delete process.env.TIMBAL_START_WORKFORCE;
    delete process.env.TIMBAL_WORKFORCE;
  });

  afterEach(() => {
    if (originalStartEnv !== undefined) process.env.TIMBAL_START_WORKFORCE = originalStartEnv;
    else delete process.env.TIMBAL_START_WORKFORCE;
    if (originalWorkforceEnv !== undefined) process.env.TIMBAL_WORKFORCE = originalWorkforceEnv;
    else delete process.env.TIMBAL_WORKFORCE;
  });

  test('should list workforces from project endpoint', async () => {
    const result = await listWorkforces(mockApiClient, remoteCtx);

    expect(result).toEqual([
      { id: '361', uid: 'manifest-1', type: 'workflow', name: 'clever-jaguar', description: null },
      { id: '360', uid: 'manifest-2', type: 'agent', name: 'eager-pelican', description: null },
    ]);
    expect(mockApiClient.get).toHaveBeenCalledWith('orgs/org1/projects/proj1');
  });

  test('should return empty array on API error', async () => {
    mockApiClient.get.mockRejectedValueOnce(new Error('API down'));

    const result = await listWorkforces(mockApiClient, remoteCtx);
    expect(result).toEqual([]);
  });

  test('should handle empty workforce array', async () => {
    mockApiClient.get.mockResolvedValueOnce({ data: { workforce: [] } });

    const result = await listWorkforces(mockApiClient, remoteCtx);
    expect(result).toEqual([]);
  });

  test('should list from local env when TIMBAL_START_WORKFORCE is set', async () => {
    process.env.TIMBAL_START_WORKFORCE = 'manifest-1:4000,manifest-2:4001';

    const result = await listWorkforces(mockApiClient, remoteCtx);
    expect(result).toEqual([{ uid: 'manifest-1' }, { uid: 'manifest-2' }]);
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  test('should list from local env when TIMBAL_WORKFORCE is set', async () => {
    process.env.TIMBAL_WORKFORCE = 'manifest-1:4000';

    const result = await listWorkforces(mockApiClient, remoteCtx);
    expect(result).toEqual([{ uid: 'manifest-1' }]);
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });
});

// ── callWorkforce ──

const workforceItems = [
  { id: '361', uid: 'manifest-1', type: 'workflow', name: 'clever-jaguar', description: null },
  { id: '360', uid: 'manifest-2', type: 'agent', name: 'eager-pelican', description: null },
];

function mockGetHandler(endpoint: string) {
  if (endpoint === 'orgs/org1/projects/proj1') {
    return Promise.resolve({ data: { workforce: workforceItems } });
  }
  if (endpoint.includes('/deployments')) {
    return Promise.resolve({
      data: { deployments: [{ domain: 'worker.timbal.ai', target: { manifest_id: 'manifest-1' } }] },
    });
  }
  return Promise.resolve({ data: {} });
}

describe('callWorkforce', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  const mockApiClient = {
    get: mock((endpoint: string) => mockGetHandler(endpoint)),
    getConfig: () => ({
      baseUrl: 'https://api.timbal.ai',
      token: 'test-key',
      timeout: 30000,
      retryAttempts: 3,
      retryDelay: 1000,
    }),
  } as any;

  beforeEach(() => {
    clearDeploymentCache();
    originalFetch = global.fetch;
    mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ output: 'hello' }), { status: 200 }))
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;
    mockApiClient.get.mockImplementation((endpoint: string) => mockGetHandler(endpoint));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should resolve by uid and call /run', async () => {
    const response = await callWorkforce(mockApiClient, 'manifest-1', { message: 'hi' }, remoteCtx);

    expect(response.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe('https://worker.timbal.ai/run');
  });

  test('should resolve by name and call /run', async () => {
    const response = await callWorkforce(mockApiClient, 'clever-jaguar', { message: 'hi' }, remoteCtx);

    expect(response.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe('https://worker.timbal.ai/run');
  });

  test('should resolve by id and call /run', async () => {
    const response = await callWorkforce(mockApiClient, '361', { message: 'hi' }, remoteCtx);

    expect(response.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe('https://worker.timbal.ai/run');
  });

  test('should inject platform config for remote calls', async () => {
    await callWorkforce(mockApiClient, 'manifest-1', { message: 'hi' }, remoteCtx);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.context.platform_config).toEqual({
      host: 'api.timbal.ai',
      auth: { type: 'bearer', token: 'test-key' },
    });
  });

  test('should preserve existing input fields alongside injected context', async () => {
    await callWorkforce(mockApiClient, 'manifest-1', { message: 'hi', extra: 'data' }, remoteCtx);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.message).toBe('hi');
    expect(callBody.extra).toBe('data');
    expect(callBody.context.platform_config).toBeDefined();
  });

  test('should throw when identifier not found', async () => {
    await expect(
      callWorkforce(mockApiClient, 'nonexistent', {}, remoteCtx)
    ).rejects.toThrow('Could not resolve workforce for identifier: nonexistent');
  });

  test('should allow custom platform config', async () => {
    const customConfig = {
      host: 'custom.api.com',
      auth: { type: 'bearer', token: 'custom-token' },
    };

    await callWorkforce(mockApiClient, 'manifest-1', { msg: 'hi' }, remoteCtx, customConfig);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.context.platform_config).toEqual(customConfig);
  });

  test('should skip platform config injection in local mode', async () => {
    const originalEnv = process.env.TIMBAL_START_WORKFORCE;
    process.env.TIMBAL_START_WORKFORCE = 'manifest-1:4000';

    try {
      await callWorkforce(mockApiClient, 'manifest-1', { msg: 'hi' }, remoteCtx);

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.context).toBeUndefined();
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:4000/run');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.TIMBAL_START_WORKFORCE;
      } else {
        process.env.TIMBAL_START_WORKFORCE = originalEnv;
      }
    }
  });

  test('should throw when local deployment not found', async () => {
    const originalEnv = process.env.TIMBAL_START_WORKFORCE;
    process.env.TIMBAL_START_WORKFORCE = 'other-manifest:5000';

    try {
      await expect(
        callWorkforce(mockApiClient, 'nonexistent', {}, remoteCtx)
      ).rejects.toThrow('Could not resolve workforce deployment');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.TIMBAL_START_WORKFORCE;
      } else {
        process.env.TIMBAL_START_WORKFORCE = originalEnv;
      }
    }
  });

  test('should call with empty input by default', async () => {
    await callWorkforce(mockApiClient, 'manifest-1', undefined, remoteCtx);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.context.platform_config).toBeDefined();
  });
});

// ── Caching ──

describe('caching', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  const mockApiClient = {
    get: mock((endpoint: string) => mockGetHandler(endpoint)),
    getConfig: () => ({
      baseUrl: 'https://api.timbal.ai',
      token: 'test-key',
      timeout: 30000,
      retryAttempts: 3,
      retryDelay: 1000,
    }),
  } as any;

  beforeEach(() => {
    clearDeploymentCache();
    originalFetch = global.fetch;
    mockFetch = mock(() =>
      Promise.resolve(new Response('{}', { status: 200 }))
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;
    mockApiClient.get.mockClear();
    mockApiClient.get.mockImplementation((endpoint: string) => mockGetHandler(endpoint));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should cache workforce items and deployments across calls', async () => {
    await callWorkforce(mockApiClient, 'manifest-1', {}, remoteCtx);
    const firstCallCount = mockApiClient.get.mock.calls.length;

    await callWorkforce(mockApiClient, 'manifest-1', {}, remoteCtx);

    // No additional API calls on second invocation (both caches hit)
    expect(mockApiClient.get).toHaveBeenCalledTimes(firstCallCount);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('clearDeploymentCache should force re-resolution of both caches', async () => {
    await callWorkforce(mockApiClient, 'manifest-1', {}, remoteCtx);
    const firstCallCount = mockApiClient.get.mock.calls.length;

    clearDeploymentCache();
    await callWorkforce(mockApiClient, 'manifest-1', {}, remoteCtx);

    // Same number of API calls again after cache clear
    expect(mockApiClient.get).toHaveBeenCalledTimes(firstCallCount * 2);
  });
});

// ── streamWorkforce ──

describe('streamWorkforce', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  const mockApiClient = {
    get: mock((endpoint: string) => mockGetHandler(endpoint)),
    getConfig: () => ({
      baseUrl: 'https://api.timbal.ai',
      token: 'test-key',
      timeout: 30000,
      retryAttempts: 3,
      retryDelay: 1000,
    }),
  } as any;

  beforeEach(() => {
    clearDeploymentCache();
    originalFetch = global.fetch;
    mockFetch = mock(() =>
      Promise.resolve(
        new Response('data: {"chunk": 1}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      )
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;
    mockApiClient.get.mockImplementation((endpoint: string) => mockGetHandler(endpoint));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should resolve by uid and call /stream', async () => {
    const response = await streamWorkforce(mockApiClient, 'manifest-1', { message: 'hi' }, remoteCtx);

    expect(response.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe('https://worker.timbal.ai/stream');
  });

  test('should resolve by name and call /stream', async () => {
    const response = await streamWorkforce(mockApiClient, 'clever-jaguar', { message: 'hi' }, remoteCtx);

    expect(response.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe('https://worker.timbal.ai/stream');
  });

  test('should throw when identifier not found', async () => {
    await expect(
      streamWorkforce(mockApiClient, 'nonexistent', {}, remoteCtx)
    ).rejects.toThrow('Could not resolve workforce for identifier: nonexistent');
  });

  test('should inject platform config for stream calls', async () => {
    await streamWorkforce(mockApiClient, 'manifest-1', { msg: 'hi' }, remoteCtx);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.context.platform_config.host).toBe('api.timbal.ai');
  });
});

// ── Studio mode ──

describe('studio mode', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;
  let originalStudio: string | undefined;
  let originalRev: string | undefined;

  const mockApiClient = {
    get: mock((endpoint: string) => mockGetHandler(endpoint)),
    getConfig: () => ({
      baseUrl: 'https://api.timbal.ai',
      token: 'test-key',
      timeout: 30000,
      retryAttempts: 3,
      retryDelay: 1000,
    }),
  } as any;

  beforeEach(() => {
    clearDeploymentCache();
    originalFetch = global.fetch;
    mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ output: 'hello' }), { status: 200 }))
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;
    mockApiClient.get.mockImplementation((endpoint: string) => mockGetHandler(endpoint));
    originalStudio = process.env.TIMBAL_STUDIO;
    originalRev = process.env.TIMBAL_REV;
    process.env.TIMBAL_STUDIO = '1';
    delete process.env.TIMBAL_REV;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalStudio !== undefined) process.env.TIMBAL_STUDIO = originalStudio;
    else delete process.env.TIMBAL_STUDIO;
    if (originalRev !== undefined) process.env.TIMBAL_REV = originalRev;
    else delete process.env.TIMBAL_REV;
  });

  test('callWorkforce should resolve name by uid and POST codegen test command', async () => {
    await callWorkforce(mockApiClient, 'manifest-2', { prompt: 'hello' }, remoteCtx);

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.timbal.ai/orgs/org1/projects/proj1/git/codegen');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.rev).toBe('main');
    expect(body.workforce).toBe('eager-pelican');
    expect(body.command).toBe('test');
    expect(body.args.input).toEqual({ prompt: 'hello' });
    expect(body.args.stream).toBeUndefined();
    expect(body.args.context).toBeDefined();
  });

  test('callWorkforce should resolve name by id', async () => {
    await callWorkforce(mockApiClient, '360', { prompt: 'hello' }, remoteCtx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.workforce).toBe('eager-pelican');
  });

  test('callWorkforce should pass name through directly', async () => {
    await callWorkforce(mockApiClient, 'eager-pelican', { prompt: 'hello' }, remoteCtx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.workforce).toBe('eager-pelican');
  });

  test('streamWorkforce should POST codegen test command with stream flag', async () => {
    await streamWorkforce(mockApiClient, 'manifest-1', { prompt: 'hello' }, remoteCtx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.command).toBe('test');
    expect(body.args.stream).toBe(true);
    expect(body.args.input).toEqual({ prompt: 'hello' });
    expect(body.workforce).toBe('clever-jaguar');
  });

  test('should use TIMBAL_REV env var for rev', async () => {
    process.env.TIMBAL_REV = 'feature-branch';

    await callWorkforce(mockApiClient, 'manifest-1', {}, remoteCtx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.rev).toBe('feature-branch');
  });

  test('should include Authorization header', async () => {
    await callWorkforce(mockApiClient, 'manifest-1', {}, remoteCtx);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer test-key');
  });

  test('should throw when identifier not found', async () => {
    await expect(
      callWorkforce(mockApiClient, 'nonexistent', {}, remoteCtx)
    ).rejects.toThrow('Could not resolve workforce for identifier: nonexistent');
  });
});

// ── Timbal class wrappers ──

describe('Timbal workforce wrappers', () => {
  let timbal: Timbal;
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = global.fetch;

    mockFetch = mock((url: string, opts?: RequestInit) => {
      // Workforce items fetch (from ApiClient.get -> makeRequest)
      if (url.endsWith('/orgs//projects/proj1') || url.endsWith('/projects/proj1')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ workforce: workforceItems }),
        });
      }
      // Deployment fetch
      if (url.includes('/deployments')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              deployments: [{ domain: 'worker.timbal.ai', target: { manifest_id: 'manifest-1' } }],
            }),
        });
      }
      // Actual workforce call
      return Promise.resolve(new Response(JSON.stringify({ output: 'ok' }), { status: 200 }));
    });
    global.fetch = mockFetch as unknown as typeof global.fetch;

    timbal = new Timbal({ token: 'test-key', baseUrl: 'https://api.timbal.ai' });
    clearDeploymentCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should call workforce through Timbal class', async () => {
    const response = await timbal.callWorkforce('manifest-1', { msg: 'hi' }, remoteCtx);
    expect(response.status).toBe(200);
  });

  test('should stream workforce through Timbal class', async () => {
    const response = await timbal.streamWorkforce('manifest-1', { msg: 'hi' }, remoteCtx);
    expect(response.status).toBe(200);
  });
});
