import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { listWorkforces, callWorkforce, streamWorkforce, clearDeploymentCache } from '../lib/functions/workforce';
import { Timbal } from '../lib/timbal';
import type { WorkforceContext } from '../types';

const remoteCtx: WorkforceContext = {
  orgId: 'org1',
  projectId: 'proj1',
  projectEnvId: 'env1',
};

const localCtx: WorkforceContext = {
  orgId: 'org1',
  projectId: 'proj1',
};

// ── listWorkforces ──

describe('listWorkforces', () => {
  const mockApiClient = {
    get: mock(() =>
      Promise.resolve({
        data: {
          deployments: [
            { domain: 'a.timbal.ai', target: { manifest_id: 'manifest-1' } },
            { domain: 'b.timbal.ai', target: { manifest_id: 'manifest-2' } },
            { domain: 'c.timbal.ai', target: { manifest_id: 'manifest-1' } },
          ],
        },
      })
    ),
  } as any;

  beforeEach(() => {
    mockApiClient.get.mockClear();
  });

  test('should list unique workforces from remote deployments', async () => {
    const result = await listWorkforces(mockApiClient, remoteCtx);

    expect(result).toEqual([{ id: 'manifest-1' }, { id: 'manifest-2' }]);
    expect(mockApiClient.get).toHaveBeenCalledWith(
      'orgs/org1/projects/proj1/deployments',
      { status: 'running', project_env_id: 'env1' }
    );
  });

  test('should return empty array on API error', async () => {
    mockApiClient.get.mockRejectedValueOnce(new Error('API down'));

    const result = await listWorkforces(mockApiClient, remoteCtx);
    expect(result).toEqual([]);
  });

  test('should handle deployments with missing manifest_id', async () => {
    mockApiClient.get.mockResolvedValueOnce({
      data: {
        deployments: [
          { domain: 'a.timbal.ai', target: {} },
          { domain: 'b.timbal.ai', target: { manifest_id: 'valid' } },
          { domain: 'c.timbal.ai' },
        ],
      },
    });

    const result = await listWorkforces(mockApiClient, remoteCtx);
    expect(result).toEqual([{ id: 'valid' }]);
  });

  test('should handle empty deployments array', async () => {
    mockApiClient.get.mockResolvedValueOnce({ data: { deployments: [] } });

    const result = await listWorkforces(mockApiClient, remoteCtx);
    expect(result).toEqual([]);
  });

  test('should list from local manifests when no projectEnvId', async () => {
    const result = await listWorkforces(mockApiClient, localCtx, '/tmp/nonexistent-workforce-dir');
    expect(result).toEqual([]);
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });
});

// ── callWorkforce ──

describe('callWorkforce', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  const mockApiClient = {
    get: mock(() =>
      Promise.resolve({
        data: {
          deployments: [{ domain: 'worker.timbal.ai', target: { manifest_id: 'manifest-1' } }],
        },
      })
    ),
    getConfig: () => ({
      baseUrl: 'https://api.timbal.ai',
      apiKey: 'test-key',
      authToken: '',
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
    mockApiClient.get.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should resolve deployment and call /run', async () => {
    const response = await callWorkforce(mockApiClient, 'manifest-1', { message: 'hi' }, remoteCtx);

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

  test('should throw when deployment not found', async () => {
    mockApiClient.get.mockResolvedValueOnce({ data: { deployments: [] } });

    await expect(
      callWorkforce(mockApiClient, 'nonexistent', {}, remoteCtx)
    ).rejects.toThrow('Could not resolve workforce deployment');
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
      await callWorkforce(mockApiClient, 'manifest-1', { msg: 'hi' }, localCtx);

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
    delete process.env.TIMBAL_START_WORKFORCE;

    try {
      await expect(
        callWorkforce(mockApiClient, 'nonexistent', {}, localCtx)
      ).rejects.toThrow('Could not resolve workforce deployment');
    } finally {
      if (originalEnv !== undefined) {
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

// ── Deployment caching ──

describe('deployment caching', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  const mockApiClient = {
    get: mock(() =>
      Promise.resolve({
        data: {
          deployments: [{ domain: 'worker.timbal.ai', target: { manifest_id: 'manifest-1' } }],
        },
      })
    ),
    getConfig: () => ({
      baseUrl: 'https://api.timbal.ai',
      apiKey: 'test-key',
      authToken: '',
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
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should cache deployment and not call API again', async () => {
    await callWorkforce(mockApiClient, 'manifest-1', {}, remoteCtx);
    await callWorkforce(mockApiClient, 'manifest-1', {}, remoteCtx);

    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('clearDeploymentCache should force re-resolution', async () => {
    await callWorkforce(mockApiClient, 'manifest-1', {}, remoteCtx);
    clearDeploymentCache();
    await callWorkforce(mockApiClient, 'manifest-1', {}, remoteCtx);

    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
  });
});

// ── streamWorkforce ──

describe('streamWorkforce', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  const mockApiClient = {
    get: mock(() =>
      Promise.resolve({
        data: {
          deployments: [{ domain: 'worker.timbal.ai', target: { manifest_id: 'manifest-1' } }],
        },
      })
    ),
    getConfig: () => ({
      baseUrl: 'https://api.timbal.ai',
      apiKey: 'test-key',
      authToken: '',
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
    mockApiClient.get.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should resolve deployment and call /stream', async () => {
    const response = await streamWorkforce(mockApiClient, 'manifest-1', { message: 'hi' }, remoteCtx);

    expect(response.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe('https://worker.timbal.ai/stream');
  });

  test('should throw when deployment not found', async () => {
    mockApiClient.get.mockResolvedValueOnce({ data: { deployments: [] } });

    await expect(
      streamWorkforce(mockApiClient, 'nonexistent', {}, remoteCtx)
    ).rejects.toThrow('Could not resolve workforce deployment');
  });

  test('should inject platform config for stream calls', async () => {
    await streamWorkforce(mockApiClient, 'manifest-1', { msg: 'hi' }, remoteCtx);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.context.platform_config.host).toBe('api.timbal.ai');
  });
});

// ── Timbal class wrappers ──

describe('Timbal workforce wrappers', () => {
  let timbal: Timbal;
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = global.fetch;

    let callCount = 0;
    mockFetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              deployments: [{ domain: 'worker.timbal.ai', target: { manifest_id: 'manifest-1' } }],
            }),
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ output: 'ok' }), { status: 200 }));
    });
    global.fetch = mockFetch as unknown as typeof global.fetch;

    timbal = new Timbal({ apiKey: 'test-key', baseUrl: 'https://api.timbal.ai' });
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
