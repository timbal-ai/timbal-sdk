import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { listWorkforces, callWorkforce, streamWorkforce, clearDeploymentCache, scanTimbalYamls, listLocalWorkforces } from '../lib/functions/workforce';
import { Timbal } from '../lib/timbal';
import type { WorkforceContext } from '../types';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const remoteCtx: WorkforceContext = {
  orgId: 'org1',
  projectId: 'proj1',
  projectEnvId: 'env1',
};

// ── Shared fixtures ──

const workforceItems = [
  { id: '361', uid: 'manifest-1', type: 'workflow', name: 'clever-jaguar', description: null },
  { id: '360', uid: 'manifest-2', type: 'agent', name: 'eager-pelican', description: null },
];

// Apps items: only id and name, no uid (apps fallback)
const appsItems = [
  { id: '368', name: 'my-agent', type: 'agent', description: null },
  { id: '369', name: 'my-workflow', type: 'workflow', description: null },
];

const deployments = [
  {
    id: 2520,
    domain: 'worker.timbal.ai',
    target: { id: 361, manifest_id: 'manifest-1', uid: null, name: null },
  },
  {
    id: 2521,
    domain: 'worker2.timbal.ai',
    target: { id: 360, manifest_id: 'manifest-2', uid: null, name: null },
  },
];

// Apps deployments: matched by target.id (no manifest_id/uid)
const appsDeployments = [
  {
    id: 2530,
    domain: 'app-agent.timbal.ai',
    target: { id: 368, manifest_id: null, uid: null, name: null },
  },
  {
    id: 2531,
    domain: 'app-workflow.timbal.ai',
    target: { id: 369, manifest_id: null, uid: null, name: null },
  },
];

function mockGetHandler(endpoint: string, useApps = false) {
  if (endpoint === 'orgs/org1/projects/proj1') {
    return Promise.resolve({
      data: useApps
        ? { apps: appsItems }
        : { workforce: workforceItems },
    });
  }
  if (endpoint.includes('/deployments')) {
    return Promise.resolve({
      data: { deployments: useApps ? appsDeployments : deployments },
    });
  }
  return Promise.resolve({ data: {} });
}

// ── listWorkforces ──

describe('listWorkforces', () => {
  const mockApiClient = {
    get: mock(() =>
      Promise.resolve({ data: { workforce: workforceItems } })
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

    expect(result).toEqual(workforceItems);
    expect(mockApiClient.get).toHaveBeenCalledWith('orgs/org1/projects/proj1');
  });

  test('should fall back to apps when workforce is absent', async () => {
    mockApiClient.get.mockResolvedValueOnce({ data: { apps: appsItems } });

    const result = await listWorkforces(mockApiClient, remoteCtx);
    expect(result).toEqual([
      { id: '368', uid: undefined, name: 'my-agent', type: 'agent', description: null },
      { id: '369', uid: undefined, name: 'my-workflow', type: 'workflow', description: null },
    ]);
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
      if (originalEnv === undefined) delete process.env.TIMBAL_START_WORKFORCE;
      else process.env.TIMBAL_START_WORKFORCE = originalEnv;
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
      if (originalEnv === undefined) delete process.env.TIMBAL_START_WORKFORCE;
      else process.env.TIMBAL_START_WORKFORCE = originalEnv;
    }
  });

  test('should call with empty input by default', async () => {
    await callWorkforce(mockApiClient, 'manifest-1', undefined, remoteCtx);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.context.platform_config).toBeDefined();
  });
});

// ── apps fallback (no uid) ──

describe('apps fallback', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  const mockApiClient = {
    get: mock((endpoint: string) => mockGetHandler(endpoint, true)),
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
    mockApiClient.get.mockImplementation((endpoint: string) => mockGetHandler(endpoint, true));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should resolve apps item by numeric id and call /run', async () => {
    const response = await callWorkforce(mockApiClient, '368', { message: 'hi' }, remoteCtx);

    expect(response.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe('https://app-agent.timbal.ai/run');
  });

  test('should resolve apps item by name and call /run', async () => {
    const response = await callWorkforce(mockApiClient, 'my-agent', { message: 'hi' }, remoteCtx);

    expect(response.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe('https://app-agent.timbal.ai/run');
  });

  test('should resolve apps item by numeric id and call /stream', async () => {
    const response = await streamWorkforce(mockApiClient, '368', { message: 'hi' }, remoteCtx);

    expect(response.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe('https://app-agent.timbal.ai/stream');
  });

  test('should resolve second apps item by id', async () => {
    const response = await callWorkforce(mockApiClient, '369', {}, remoteCtx);

    expect(response.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe('https://app-workflow.timbal.ai/run');
  });

  test('should throw when apps item has no matching deployment', async () => {
    await expect(
      callWorkforce(mockApiClient, 'nonexistent', {}, remoteCtx)
    ).rejects.toThrow('Could not resolve workforce for identifier: nonexistent');
  });
});

// ── deployment matching ──

describe('deployment matching', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  const mockApiClient = {
    get: mock(() => {}),
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
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should match deployment by target.id', async () => {
    mockApiClient.get.mockImplementation((endpoint: string) => {
      if (endpoint.includes('/deployments')) {
        return Promise.resolve({
          data: { deployments: [{ domain: 'by-id.timbal.ai', target: { id: 368, manifest_id: null, uid: null } }] },
        });
      }
      return Promise.resolve({ data: { apps: [{ id: '368', name: 'my-agent' }] } });
    });

    await callWorkforce(mockApiClient, '368', {}, remoteCtx);
    expect(mockFetch.mock.calls[0][0]).toBe('https://by-id.timbal.ai/run');
  });

  test('should match deployment by target.uid (uid alias)', async () => {
    mockApiClient.get.mockImplementation((endpoint: string) => {
      if (endpoint.includes('/deployments')) {
        return Promise.resolve({
          data: { deployments: [{ domain: 'by-uid.timbal.ai', target: { id: 999, manifest_id: null, uid: 'manifest-abc' } }] },
        });
      }
      return Promise.resolve({ data: { workforce: [{ id: '1', uid: 'manifest-abc', name: 'some-agent' }] } });
    });

    await callWorkforce(mockApiClient, 'manifest-abc', {}, remoteCtx);
    expect(mockFetch.mock.calls[0][0]).toBe('https://by-uid.timbal.ai/run');
  });

  test('should prefer target.uid over target.manifest_id when both present', async () => {
    mockApiClient.get.mockImplementation((endpoint: string) => {
      if (endpoint.includes('/deployments')) {
        return Promise.resolve({
          data: {
            deployments: [
              { domain: 'wrong.timbal.ai', target: { id: 999, manifest_id: 'manifest-abc', uid: 'other-uid' } },
              { domain: 'correct.timbal.ai', target: { id: 998, manifest_id: 'other-manifest', uid: 'manifest-abc' } },
            ],
          },
        });
      }
      return Promise.resolve({ data: { workforce: [{ id: '1', uid: 'manifest-abc', name: 'some-agent' }] } });
    });

    await callWorkforce(mockApiClient, 'manifest-abc', {}, remoteCtx);
    expect(mockFetch.mock.calls[0][0]).toBe('https://correct.timbal.ai/run');
  });

  test('should fall back to target.manifest_id when target.uid is null', async () => {
    mockApiClient.get.mockImplementation((endpoint: string) => {
      if (endpoint.includes('/deployments')) {
        return Promise.resolve({
          data: { deployments: [{ domain: 'by-manifest.timbal.ai', target: { id: 999, manifest_id: 'manifest-abc', uid: null } }] },
        });
      }
      return Promise.resolve({ data: { workforce: [{ id: '1', uid: 'manifest-abc', name: 'some-agent' }] } });
    });

    await callWorkforce(mockApiClient, 'manifest-abc', {}, remoteCtx);
    expect(mockFetch.mock.calls[0][0]).toBe('https://by-manifest.timbal.ai/run');
  });

  test('should match deployment by target.name', async () => {
    mockApiClient.get.mockImplementation((endpoint: string) => {
      if (endpoint.includes('/deployments')) {
        return Promise.resolve({
          data: { deployments: [{ domain: 'by-name.timbal.ai', target: { id: 999, manifest_id: null, uid: null, name: 'my-agent' } }] },
        });
      }
      return Promise.resolve({ data: { apps: [{ id: '368', name: 'my-agent' }] } });
    });

    await callWorkforce(mockApiClient, 'my-agent', {}, remoteCtx);
    expect(mockFetch.mock.calls[0][0]).toBe('https://by-name.timbal.ai/run');
  });

  test('should not match when all target fields are null', async () => {
    mockApiClient.get.mockImplementation((endpoint: string) => {
      if (endpoint.includes('/deployments')) {
        return Promise.resolve({
          data: { deployments: [{ domain: 'null-target.timbal.ai', target: { id: null, manifest_id: null, uid: null, name: null } }] },
        });
      }
      return Promise.resolve({ data: { apps: [{ id: '368', name: 'my-agent' }] } });
    });

    await expect(
      callWorkforce(mockApiClient, '368', {}, remoteCtx)
    ).rejects.toThrow('Could not resolve workforce deployment');
  });

  test('should not match when target is absent', async () => {
    mockApiClient.get.mockImplementation((endpoint: string) => {
      if (endpoint.includes('/deployments')) {
        return Promise.resolve({
          data: { deployments: [{ domain: 'no-target.timbal.ai' }] },
        });
      }
      return Promise.resolve({ data: { apps: [{ id: '368', name: 'my-agent' }] } });
    });

    await expect(
      callWorkforce(mockApiClient, '368', {}, remoteCtx)
    ).rejects.toThrow('Could not resolve workforce deployment');
  });

  test('should handle numeric string vs numeric id comparison', async () => {
    // target.id is a number (368), item.id is a string ('368')
    mockApiClient.get.mockImplementation((endpoint: string) => {
      if (endpoint.includes('/deployments')) {
        return Promise.resolve({
          data: { deployments: [{ domain: 'numeric.timbal.ai', target: { id: 368, manifest_id: null, uid: null } }] },
        });
      }
      return Promise.resolve({ data: { apps: [{ id: '368', name: 'my-agent' }] } });
    });

    await callWorkforce(mockApiClient, '368', {}, remoteCtx);
    expect(mockFetch.mock.calls[0][0]).toBe('https://numeric.timbal.ai/run');
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

  test('should reuse deployments list cache for different items in same env', async () => {
    await callWorkforce(mockApiClient, 'manifest-1', {}, remoteCtx);
    const callsAfterFirst = mockApiClient.get.mock.calls.length;

    // Second item from same project env — deployments list should not be fetched again
    await callWorkforce(mockApiClient, 'manifest-2', {}, remoteCtx);
    const newCalls = mockApiClient.get.mock.calls.length - callsAfterFirst;

    // Only the workforce items list may be re-used (cached), deployments list definitely cached
    const deploymentCalls = mockApiClient.get.mock.calls
      .slice(callsAfterFirst)
      .filter((c: any) => c[0].includes('/deployments'));
    expect(deploymentCalls.length).toBe(0);
  });

  test('clearDeploymentCache should force re-resolution of all caches', async () => {
    await callWorkforce(mockApiClient, 'manifest-1', {}, remoteCtx);
    const firstCallCount = mockApiClient.get.mock.calls.length;

    clearDeploymentCache();
    await callWorkforce(mockApiClient, 'manifest-1', {}, remoteCtx);

    // Same number of API calls again after cache clear
    expect(mockApiClient.get).toHaveBeenCalledTimes(firstCallCount * 2);
  });

  test('should fetch deployments list only once even when individual item cache is cold', async () => {
    // Call for item 1 — fetches workforce list + deployments list
    await callWorkforce(mockApiClient, 'manifest-1', {}, remoteCtx);

    mockApiClient.get.mockClear();

    // Call for item 2 — workforce list cached, deployments list cached, no API calls
    await callWorkforce(mockApiClient, 'manifest-2', {}, remoteCtx);
    expect(mockApiClient.get).not.toHaveBeenCalled();
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
    mockApiClient.get.mockClear();
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

  test('should resolve by id and call /stream', async () => {
    const response = await streamWorkforce(mockApiClient, '361', { message: 'hi' }, remoteCtx);

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

  test('should skip platform config injection in local mode', async () => {
    const originalEnv = process.env.TIMBAL_START_WORKFORCE;
    process.env.TIMBAL_START_WORKFORCE = 'manifest-1:4000';

    try {
      await streamWorkforce(mockApiClient, 'manifest-1', { msg: 'hi' }, remoteCtx);

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.context).toBeUndefined();
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:4000/stream');
      expect(mockApiClient.get).not.toHaveBeenCalled();
    } finally {
      if (originalEnv === undefined) delete process.env.TIMBAL_START_WORKFORCE;
      else process.env.TIMBAL_START_WORKFORCE = originalEnv;
    }
  });

  test('should throw when local deployment not found', async () => {
    const originalEnv = process.env.TIMBAL_START_WORKFORCE;
    process.env.TIMBAL_START_WORKFORCE = 'other-manifest:5000';

    try {
      await expect(
        streamWorkforce(mockApiClient, 'nonexistent', {}, remoteCtx)
      ).rejects.toThrow('Could not resolve workforce deployment');
    } finally {
      if (originalEnv === undefined) delete process.env.TIMBAL_START_WORKFORCE;
      else process.env.TIMBAL_START_WORKFORCE = originalEnv;
    }
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

    mockFetch = mock((url: string) => {
      if (url.endsWith('/projects/proj1') || url.includes('/projects/proj1?')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ workforce: workforceItems }),
        });
      }
      if (url.includes('/deployments')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              deployments: [{ domain: 'worker.timbal.ai', target: { id: 361, manifest_id: 'manifest-1', uid: null } }],
            }),
        });
      }
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

// ── scanTimbalYamls ──

describe('scanTimbalYamls', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'timbal-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeYaml(relPath: string, content: string) {
    const fullPath = join(tmpDir, relPath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await Bun.write(fullPath, content);
  }

  test('should return empty map when no yaml files exist', async () => {
    const result = await scanTimbalYamls(tmpDir);
    expect(result.size).toBe(0);
  });

  test('should extract _id, name from directory, and _type from content', async () => {
    await writeYaml('workforce/my-agent/timbal.yaml', `_id: manifest-1\n_type: agent\n`);

    const result = await scanTimbalYamls(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get('manifest-1')).toEqual({ name: 'my-agent', type: 'agent' });
  });

  test('should handle multiple yamls at different paths', async () => {
    await writeYaml('workforce/clever-jaguar/timbal.yaml', `_id: manifest-1\n_type: workflow\n`);
    await writeYaml('workforce/eager-pelican/timbal.yaml', `_id: manifest-2\n_type: agent\n`);

    const result = await scanTimbalYamls(tmpDir);
    expect(result.size).toBe(2);
    expect(result.get('manifest-1')).toEqual({ name: 'clever-jaguar', type: 'workflow' });
    expect(result.get('manifest-2')).toEqual({ name: 'eager-pelican', type: 'agent' });
  });

  test('should work without _type field', async () => {
    await writeYaml('workforce/my-agent/timbal.yaml', `_id: manifest-1\nsome_other_field: value\n`);

    const result = await scanTimbalYamls(tmpDir);
    expect(result.get('manifest-1')).toEqual({ name: 'my-agent', type: undefined });
  });

  test('should skip yamls without _id field', async () => {
    await writeYaml('workforce/no-id/timbal.yaml', `_type: agent\nname: some-agent\n`);

    const result = await scanTimbalYamls(tmpDir);
    expect(result.size).toBe(0);
  });

  test('should skip yamls inside node_modules', async () => {
    await writeYaml('node_modules/some-pkg/timbal.yaml', `_id: should-be-skipped\n_type: agent\n`);

    const result = await scanTimbalYamls(tmpDir);
    expect(result.size).toBe(0);
  });

  test('should skip yaml at root level (no parent directory name)', async () => {
    await writeYaml('timbal.yaml', `_id: root-id\n_type: agent\n`);

    const result = await scanTimbalYamls(tmpDir);
    // file is 'timbal.yaml', parts = ['timbal.yaml'], parts[length-2] = undefined → skipped
    expect(result.size).toBe(0);
  });

  test('should handle quoted _id values', async () => {
    await writeYaml('workforce/my-agent/timbal.yaml', `_id: "manifest-quoted"\n_type: 'workflow'\n`);

    const result = await scanTimbalYamls(tmpDir);
    expect(result.get('manifest-quoted')).toEqual({ name: 'my-agent', type: 'workflow' });
  });

  test('should handle _id with hyphens and dots', async () => {
    await writeYaml('workforce/my-agent/timbal.yaml', `_id: org.project.agent-v2\n_type: agent\n`);

    const result = await scanTimbalYamls(tmpDir);
    expect(result.get('org.project.agent-v2')).toEqual({ name: 'my-agent', type: 'agent' });
  });
});

// ── listLocalWorkforces ──

describe('listLocalWorkforces', () => {
  let tmpDir: string;
  let originalStartEnv: string | undefined;
  let originalWorkforceEnv: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'timbal-test-'));
    originalStartEnv = process.env.TIMBAL_START_WORKFORCE;
    originalWorkforceEnv = process.env.TIMBAL_WORKFORCE;
    delete process.env.TIMBAL_START_WORKFORCE;
    delete process.env.TIMBAL_WORKFORCE;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (originalStartEnv !== undefined) process.env.TIMBAL_START_WORKFORCE = originalStartEnv;
    else delete process.env.TIMBAL_START_WORKFORCE;
    if (originalWorkforceEnv !== undefined) process.env.TIMBAL_WORKFORCE = originalWorkforceEnv;
    else delete process.env.TIMBAL_WORKFORCE;
  });

  async function writeYaml(relPath: string, content: string) {
    const fullPath = join(tmpDir, relPath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await Bun.write(fullPath, content);
  }

  test('should return items with name and type resolved from timbal.yaml', async () => {
    await writeYaml('workforce/clever-jaguar/timbal.yaml', `_id: manifest-1\n_type: workflow\n`);
    process.env.TIMBAL_START_WORKFORCE = 'manifest-1:4000';

    const result = await listLocalWorkforces(tmpDir);
    expect(result).toEqual([{ uid: 'manifest-1', name: 'clever-jaguar', type: 'workflow' }]);
  });

  test('should resolve multiple workforces with name and type', async () => {
    await writeYaml('workforce/clever-jaguar/timbal.yaml', `_id: manifest-1\n_type: workflow\n`);
    await writeYaml('workforce/eager-pelican/timbal.yaml', `_id: manifest-2\n_type: agent\n`);
    process.env.TIMBAL_START_WORKFORCE = 'manifest-1:4000,manifest-2:4001';

    const result = await listLocalWorkforces(tmpDir);
    expect(result).toEqual([
      { uid: 'manifest-1', name: 'clever-jaguar', type: 'workflow' },
      { uid: 'manifest-2', name: 'eager-pelican', type: 'agent' },
    ]);
  });

  test('should return uid only when no matching yaml is found', async () => {
    process.env.TIMBAL_WORKFORCE = 'unknown-uid:4000';

    const result = await listLocalWorkforces(tmpDir);
    expect(result).toEqual([{ uid: 'unknown-uid' }]);
  });

  test('should return uid and name but no type when _type is absent from yaml', async () => {
    await writeYaml('workforce/my-agent/timbal.yaml', `_id: manifest-1\n`);
    process.env.TIMBAL_START_WORKFORCE = 'manifest-1:4000';

    const result = await listLocalWorkforces(tmpDir);
    expect(result).toEqual([{ uid: 'manifest-1', name: 'my-agent' }]);
  });

  test('should work with TIMBAL_WORKFORCE env var', async () => {
    await writeYaml('workforce/my-agent/timbal.yaml', `_id: manifest-1\n_type: agent\n`);
    process.env.TIMBAL_WORKFORCE = 'manifest-1:4000';

    const result = await listLocalWorkforces(tmpDir);
    expect(result).toEqual([{ uid: 'manifest-1', name: 'my-agent', type: 'agent' }]);
  });

  test('should return empty array when no env var is set', async () => {
    const result = await listLocalWorkforces(tmpDir);
    expect(result).toEqual([]);
  });
});
