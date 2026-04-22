import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { listWorkforces, callWorkforce, streamWorkforce, scanTimbalYamls, listLocalWorkforces, clearWorkforceCache } from '../lib/functions/workforce';
import { Timbal } from '../lib/timbal';
import type { PlatformContext } from '../types';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const remoteCtx: PlatformContext = {
  orgId: 'org1',
  projectId: 'proj1',
  rev: 'main',
};

// ── Shared fixtures ──

const workforceItems = [
  { id: '361', uid: 'manifest-1', type: 'workflow', name: 'clever-jaguar', description: null },
  { id: '360', uid: 'manifest-2', type: 'agent', name: 'eager-pelican', description: null },
];

// ── listWorkforces ──

describe('listWorkforces', () => {
  const mockApiClient = {
    get: mock(() =>
      Promise.resolve({ data: { workforce: workforceItems } })
    ),
    getConfig: () => ({ orgId: '', projectId: '', rev: 'main', kbId: '', token: '' }),
  } as any;

  let originalStartEnv: string | undefined;
  let originalWorkforceEnv: string | undefined;

  beforeEach(() => {
    clearWorkforceCache();
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

  test('should GET the workforce endpoint with rev query', async () => {
    const result = await listWorkforces(mockApiClient, remoteCtx);

    expect(result).toEqual(workforceItems);
    expect(mockApiClient.get).toHaveBeenCalledWith('orgs/org1/projects/proj1/workforce', { rev: 'main' });
  });

  test('should use rev from context when provided', async () => {
    await listWorkforces(mockApiClient, { ...remoteCtx, rev: 'feature-x' });

    expect(mockApiClient.get).toHaveBeenCalledWith('orgs/org1/projects/proj1/workforce', { rev: 'feature-x' });
  });

  test('should fall back to client config rev when ctx.rev is absent', async () => {
    const client = {
      get: mock(() => Promise.resolve({ data: { workforce: [] } })),
      getConfig: () => ({ orgId: '', projectId: '', rev: 'release', kbId: '', token: '' }),
    } as any;

    await listWorkforces(client, { orgId: 'org1', projectId: 'proj1' });

    expect(client.get).toHaveBeenCalledWith('orgs/org1/projects/proj1/workforce', { rev: 'release' });
  });

  test('should throw when orgId is missing', async () => {
    await expect(
      listWorkforces(mockApiClient, { projectId: 'proj1' })
    ).rejects.toThrow('orgId is required');
  });

  test('should throw when projectId is missing', async () => {
    await expect(
      listWorkforces(mockApiClient, { orgId: 'org1' })
    ).rejects.toThrow('projectId is required');
  });

  test('should handle empty workforce array', async () => {
    mockApiClient.get.mockResolvedValueOnce({ data: { workforce: [] } });

    const result = await listWorkforces(mockApiClient, remoteCtx);
    expect(result).toEqual([]);
  });

  test('should preserve url field when returned by the server', async () => {
    const withUrls = [
      { id: '361', uid: 'manifest-1', type: 'workflow', name: 'clever-jaguar', description: null, url: 'https://api.timbal.ai/orgs/org1/projects/proj1/workforce/361' },
    ];
    mockApiClient.get.mockResolvedValueOnce({ data: { workforce: withUrls } });

    const result = await listWorkforces(mockApiClient, remoteCtx);
    expect(result[0].url).toBe('https://api.timbal.ai/orgs/org1/projects/proj1/workforce/361');
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
  // Server returns list with canonical `url` field — SDK uses that + /run or /stream.
  function makeListResponse(rev: string) {
    return {
      workforce: [
        {
          id: '473',
          uid: '802fbbfb484ed57c34e3d33390a2a20f',
          type: 'agent',
          name: 'sunny-squid',
          description: null,
          url: `https://api.timbal.ai/orgs/org1/projects/proj1/workforce/802fbbfb484ed57c34e3d33390a2a20f?rev=${rev}`,
        },
        {
          id: '474',
          uid: 'manifest-2',
          type: 'workflow',
          name: 'clever-jaguar',
          description: null,
          url: `https://api.timbal.ai/orgs/org1/projects/proj1/workforce/manifest-2?rev=${rev}`,
        },
      ],
    };
  }

  const mockApiClient = {
    getConfig: () => ({
      baseUrl: 'https://api.timbal.ai',
      token: 'test-key',
      timeout: 30000,
      retryAttempts: 3,
      retryDelay: 1000,
      rev: 'main',
    }),
    get: mock((_endpoint: string, params?: { rev: string }) =>
      Promise.resolve({ data: makeListResponse(params?.rev ?? 'main') })
    ),
  } as any;

  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    clearWorkforceCache();
    mockApiClient.get.mockClear();
    mockApiClient.get.mockImplementation((_endpoint: string, params?: { rev: string }) =>
      Promise.resolve({ data: makeListResponse(params?.rev ?? 'main') })
    );
    originalFetch = global.fetch;
    mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ output: 'hello' }), { status: 200 }))
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should POST to server-provided url with /run appended', async () => {
    await callWorkforce(mockApiClient, 'sunny-squid', { message: 'hi' }, remoteCtx);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.timbal.ai/orgs/org1/projects/proj1/workforce/802fbbfb484ed57c34e3d33390a2a20f/run?rev=main');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.message).toBe('hi');
  });

  test('should resolve by id, uid, or name', async () => {
    await callWorkforce(mockApiClient, '473', {}, remoteCtx);
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.timbal.ai/orgs/org1/projects/proj1/workforce/802fbbfb484ed57c34e3d33390a2a20f/run?rev=main');

    clearWorkforceCache();
    await callWorkforce(mockApiClient, '802fbbfb484ed57c34e3d33390a2a20f', {}, remoteCtx);
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.timbal.ai/orgs/org1/projects/proj1/workforce/802fbbfb484ed57c34e3d33390a2a20f/run?rev=main');

    clearWorkforceCache();
    await callWorkforce(mockApiClient, 'sunny-squid', {}, remoteCtx);
    expect(mockFetch.mock.calls[2][0]).toBe('https://api.timbal.ai/orgs/org1/projects/proj1/workforce/802fbbfb484ed57c34e3d33390a2a20f/run?rev=main');
  });

  test('should use rev from context when resolving', async () => {
    await callWorkforce(mockApiClient, 'sunny-squid', {}, { ...remoteCtx, rev: 'feature-x' });

    expect(mockApiClient.get).toHaveBeenCalledWith('orgs/org1/projects/proj1/workforce', { rev: 'feature-x' });
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.timbal.ai/orgs/org1/projects/proj1/workforce/802fbbfb484ed57c34e3d33390a2a20f/run?rev=feature-x');
  });

  test('should cache the list across multiple calls for the same (org, project, rev)', async () => {
    await callWorkforce(mockApiClient, 'sunny-squid', {}, remoteCtx);
    await callWorkforce(mockApiClient, 'clever-jaguar', {}, remoteCtx);
    await callWorkforce(mockApiClient, 'sunny-squid', {}, remoteCtx);

    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test('should refetch list when switching rev', async () => {
    await callWorkforce(mockApiClient, 'sunny-squid', {}, remoteCtx);
    await callWorkforce(mockApiClient, 'sunny-squid', {}, { ...remoteCtx, rev: 'feature-x' });

    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
  });

  test('should hit the server-provided host even when it differs from client baseUrl', async () => {
    mockApiClient.get.mockImplementationOnce(() =>
      Promise.resolve({
        data: {
          workforce: [{
            id: '473',
            uid: '802fbbfb484ed57c34e3d33390a2a20f',
            type: 'agent',
            name: 'sunny-squid',
            description: null,
            url: 'https://api.dev.timbal.ai/orgs/1/projects/306/workforce/802fbbfb484ed57c34e3d33390a2a20f?rev=main',
          }],
        },
      })
    );

    await callWorkforce(mockApiClient, 'sunny-squid', {}, remoteCtx);

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.dev.timbal.ai/orgs/1/projects/306/workforce/802fbbfb484ed57c34e3d33390a2a20f/run?rev=main');
  });

  test('should reuse the cache populated by listWorkforces (no second fetch)', async () => {
    await listWorkforces(mockApiClient, remoteCtx);
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);

    await callWorkforce(mockApiClient, 'sunny-squid', {}, remoteCtx);
    await callWorkforce(mockApiClient, 'clever-jaguar', {}, remoteCtx);

    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('should refetch the list after clearWorkforceCache()', async () => {
    await callWorkforce(mockApiClient, 'sunny-squid', {}, remoteCtx);
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);

    await callWorkforce(mockApiClient, 'sunny-squid', {}, remoteCtx);
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);

    clearWorkforceCache();

    await callWorkforce(mockApiClient, 'sunny-squid', {}, remoteCtx);
    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
  });

  test('should refetch list when identifier not found in cache', async () => {
    await callWorkforce(mockApiClient, 'sunny-squid', {}, remoteCtx);
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);

    // Simulate a newly-registered component showing up on refetch.
    mockApiClient.get.mockImplementationOnce((_endpoint: string, params?: { rev: string }) =>
      Promise.resolve({
        data: {
          workforce: [
            ...makeListResponse(params?.rev ?? 'main').workforce,
            { id: '999', uid: 'new-uid', type: 'agent', name: 'newcomer', description: null, url: `https://api.timbal.ai/orgs/org1/projects/proj1/workforce/new-uid?rev=main` },
          ],
        },
      })
    );

    await callWorkforce(mockApiClient, 'newcomer', {}, remoteCtx);
    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe('https://api.timbal.ai/orgs/org1/projects/proj1/workforce/new-uid/run?rev=main');
  });

  test('should throw when component does not exist', async () => {
    await expect(
      callWorkforce(mockApiClient, 'nonexistent', {}, remoteCtx)
    ).rejects.toThrow('Workforce component not found');
  });

  test('should throw when component has no running deployment (url is null)', async () => {
    mockApiClient.get.mockImplementationOnce(() =>
      Promise.resolve({
        data: { workforce: [{ id: '473', uid: 'abc', type: 'agent', name: 'unlive', description: null, url: null }] },
      })
    );

    await expect(
      callWorkforce(mockApiClient, 'unlive', {}, remoteCtx)
    ).rejects.toThrow('No running deployment');
  });

  test('should include Authorization header for remote calls', async () => {
    await callWorkforce(mockApiClient, 'sunny-squid', {}, remoteCtx);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');
  });

  test('should inject platform config for remote calls', async () => {
    await callWorkforce(mockApiClient, 'sunny-squid', { message: 'hi' }, remoteCtx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.context.platform_config).toEqual({
      host: 'api.timbal.ai',
      auth: { type: 'bearer', token: 'test-key' },
    });
  });

  test('should preserve existing input fields alongside injected context', async () => {
    await callWorkforce(mockApiClient, 'sunny-squid', { message: 'hi', extra: 'data' }, remoteCtx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.message).toBe('hi');
    expect(body.extra).toBe('data');
    expect(body.context.platform_config).toBeDefined();
  });

  test('should throw when orgId is missing', async () => {
    await expect(
      callWorkforce(mockApiClient, 'sunny-squid', {}, { projectId: 'proj1' })
    ).rejects.toThrow('orgId is required');
  });

  test('should throw when projectId is missing', async () => {
    await expect(
      callWorkforce(mockApiClient, 'sunny-squid', {}, { orgId: 'org1' })
    ).rejects.toThrow('projectId is required');
  });

  test('should allow custom platform config', async () => {
    const customConfig = {
      host: 'custom.api.com',
      auth: { type: 'bearer', token: 'custom-token' },
    };

    await callWorkforce(mockApiClient, 'sunny-squid', { msg: 'hi' }, remoteCtx, customConfig);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.context.platform_config).toEqual(customConfig);
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

  test('should resolve local workforce by name (not uid) when yaml files are present', async () => {
    const originalEnv = process.env.TIMBAL_START_WORKFORCE;
    const originalCwd = process.cwd();
    const tmpDir = await mkdtemp(join(tmpdir(), 'timbal-local-name-test-'));

    try {
      await mkdir(join(tmpDir, 'workforce', 'clever-jaguar'), { recursive: true });
      await Bun.write(join(tmpDir, 'workforce', 'clever-jaguar', 'timbal.yaml'), '_id: manifest-1\n_type: workflow\n');

      process.env.TIMBAL_START_WORKFORCE = 'manifest-1:4000';
      process.chdir(tmpDir);

      const response = await callWorkforce(mockApiClient, 'clever-jaguar', { msg: 'hi' }, remoteCtx);

      expect(response.status).toBe(200);
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:4000/run');
    } finally {
      process.chdir(originalCwd);
      await rm(tmpDir, { recursive: true, force: true });
      if (originalEnv === undefined) delete process.env.TIMBAL_START_WORKFORCE;
      else process.env.TIMBAL_START_WORKFORCE = originalEnv;
    }
  });

  test('should resolve local stream by name (not uid) when yaml files are present', async () => {
    const originalEnv = process.env.TIMBAL_START_WORKFORCE;
    const originalCwd = process.cwd();
    const tmpDir = await mkdtemp(join(tmpdir(), 'timbal-local-name-stream-test-'));

    try {
      await mkdir(join(tmpDir, 'workforce', 'clever-jaguar'), { recursive: true });
      await Bun.write(join(tmpDir, 'workforce', 'clever-jaguar', 'timbal.yaml'), '_id: manifest-1\n_type: workflow\n');

      process.env.TIMBAL_START_WORKFORCE = 'manifest-1:4000';
      process.chdir(tmpDir);

      const response = await streamWorkforce(mockApiClient, 'clever-jaguar', { msg: 'hi' }, remoteCtx);

      expect(response.status).toBe(200);
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:4000/stream');
    } finally {
      process.chdir(originalCwd);
      await rm(tmpDir, { recursive: true, force: true });
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
      ).rejects.toThrow('Could not resolve local workforce');
    } finally {
      if (originalEnv === undefined) delete process.env.TIMBAL_START_WORKFORCE;
      else process.env.TIMBAL_START_WORKFORCE = originalEnv;
    }
  });

  test('should call with empty input by default', async () => {
    await callWorkforce(mockApiClient, 'sunny-squid', undefined, remoteCtx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.context.platform_config).toBeDefined();
  });
});

// ── streamWorkforce ──

describe('streamWorkforce', () => {
  const mockApiClient = {
    getConfig: () => ({
      baseUrl: 'https://api.timbal.ai',
      token: 'test-key',
      timeout: 30000,
      retryAttempts: 3,
      retryDelay: 1000,
      rev: 'main',
    }),
    get: mock((_endpoint: string, params?: { rev: string }) =>
      Promise.resolve({
        data: {
          workforce: [
            {
              id: '473',
              uid: '802fbbfb484ed57c34e3d33390a2a20f',
              type: 'agent',
              name: 'sunny-squid',
              description: null,
              url: `https://api.timbal.ai/orgs/org1/projects/proj1/workforce/802fbbfb484ed57c34e3d33390a2a20f?rev=${params?.rev ?? 'main'}`,
            },
          ],
        },
      })
    ),
  } as any;

  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    clearWorkforceCache();
    mockApiClient.get.mockClear();
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
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should POST to server-provided url with /stream appended', async () => {
    await streamWorkforce(mockApiClient, 'sunny-squid', { message: 'hi' }, remoteCtx);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.timbal.ai/orgs/org1/projects/proj1/workforce/802fbbfb484ed57c34e3d33390a2a20f/stream?rev=main');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.message).toBe('hi');
  });

  test('should inject platform config for stream calls', async () => {
    await streamWorkforce(mockApiClient, 'sunny-squid', { msg: 'hi' }, remoteCtx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.context.platform_config.host).toBe('api.timbal.ai');
  });

  test('should include Authorization header for stream calls', async () => {
    await streamWorkforce(mockApiClient, 'sunny-squid', { msg: 'hi' }, remoteCtx);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer test-key');
  });

  test('should throw when orgId is missing', async () => {
    await expect(
      streamWorkforce(mockApiClient, 'sunny-squid', {}, { projectId: 'proj1' })
    ).rejects.toThrow('orgId is required');
  });

  test('should skip platform config injection in local mode', async () => {
    const originalEnv = process.env.TIMBAL_START_WORKFORCE;
    process.env.TIMBAL_START_WORKFORCE = 'manifest-1:4000';

    try {
      await streamWorkforce(mockApiClient, 'manifest-1', { msg: 'hi' }, remoteCtx);

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.context).toBeUndefined();
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:4000/stream');
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
      ).rejects.toThrow('Could not resolve local workforce');
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

  function makeListResponse(rev: string) {
    return {
      workforce: [
        {
          id: '473',
          uid: '802fbbfb484ed57c34e3d33390a2a20f',
          type: 'agent',
          name: 'sunny-squid',
          description: null,
          url: `https://api.timbal.ai/orgs/org1/projects/proj1/workforce/802fbbfb484ed57c34e3d33390a2a20f?rev=${rev}`,
        },
        {
          id: '474',
          uid: 'manifest-2',
          type: 'workflow',
          name: 'clever-jaguar',
          description: null,
          url: `https://api.timbal.ai/orgs/org1/projects/proj1/workforce/manifest-2?rev=${rev}`,
        },
        {
          id: '475',
          uid: 'manifest-3',
          type: 'agent',
          name: 'eager-pelican',
          description: null,
          url: `https://api.timbal.ai/orgs/org1/projects/proj1/workforce/manifest-3?rev=${rev}`,
        },
      ],
    };
  }

  const mockApiClient = {
    getConfig: () => ({
      baseUrl: 'https://api.timbal.ai',
      token: 'test-key',
      timeout: 30000,
      retryAttempts: 3,
      retryDelay: 1000,
      rev: 'main',
    }),
    get: mock((_endpoint: string, params?: { rev: string }) =>
      Promise.resolve({ data: makeListResponse(params?.rev ?? 'main') })
    ),
  } as any;

  beforeEach(() => {
    clearWorkforceCache();
    mockApiClient.get.mockClear();
    mockApiClient.get.mockImplementation((_endpoint: string, params?: { rev: string }) =>
      Promise.resolve({ data: makeListResponse(params?.rev ?? 'main') })
    );
    originalFetch = global.fetch;
    mockFetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ output: 'hello' }), { status: 200 }))
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;
    originalStudio = process.env.TIMBAL_STUDIO;
    originalRev = process.env.TIMBAL_PROJECT_REV;
    process.env.TIMBAL_STUDIO = '1';
    delete process.env.TIMBAL_PROJECT_REV;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalStudio !== undefined) process.env.TIMBAL_STUDIO = originalStudio;
    else delete process.env.TIMBAL_STUDIO;
    if (originalRev !== undefined) process.env.TIMBAL_PROJECT_REV = originalRev;
    else delete process.env.TIMBAL_PROJECT_REV;
  });

  test('callWorkforce should POST codegen test command with resolved name', async () => {
    await callWorkforce(mockApiClient, 'eager-pelican', { prompt: 'hello' }, remoteCtx);

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.timbal.ai/orgs/org1/projects/proj1/git/codegen');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.rev).toBe('main');
    expect(body.workforce).toBe('eager-pelican');
    expect(body.command).toBe('test');
    expect(body.args.input).toEqual({ prompt: 'hello' });
    expect(body.args.stream).toBeUndefined();
    expect(body.args.context).toBeUndefined();
  });

  test('should resolve uid identifier to canonical name', async () => {
    await callWorkforce(mockApiClient, '802fbbfb484ed57c34e3d33390a2a20f', {}, remoteCtx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.workforce).toBe('sunny-squid');
    expect(body.args.context).toBeUndefined();
  });

  test('should resolve numeric id identifier to canonical name', async () => {
    await callWorkforce(mockApiClient, '473', {}, remoteCtx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.workforce).toBe('sunny-squid');
    expect(body.args.context).toBeUndefined();
  });

  test('should throw when identifier does not resolve', async () => {
    await expect(
      callWorkforce(mockApiClient, 'nonexistent', {}, remoteCtx)
    ).rejects.toThrow('Workforce component not found');
  });

  test('streamWorkforce should POST codegen test command with stream flag', async () => {
    await streamWorkforce(mockApiClient, 'clever-jaguar', { prompt: 'hello' }, remoteCtx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.command).toBe('test');
    expect(body.args.stream).toBe(true);
    expect(body.args.input).toEqual({ prompt: 'hello' });
    expect(body.workforce).toBe('clever-jaguar');
    expect(body.args.context).toBeUndefined();
  });

  test('should use rev from context when provided', async () => {
    await callWorkforce(mockApiClient, 'sunny-squid', {}, { ...remoteCtx, rev: 'feature-branch' });

    expect(mockApiClient.get).toHaveBeenCalledWith('orgs/org1/projects/proj1/workforce', { rev: 'feature-branch' });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.rev).toBe('feature-branch');
  });

  test('should include Authorization header', async () => {
    await callWorkforce(mockApiClient, 'sunny-squid', {}, remoteCtx);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe('Bearer test-key');
  });

  test('should include args.context.parent_id when parentId is provided in ctx', async () => {
    await callWorkforce(mockApiClient, 'sunny-squid', {}, { ...remoteCtx, parentId: 'run-123' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.args.context).toEqual({ parent_id: 'run-123' });
  });

  test('streamWorkforce should include args.context.parent_id when parentId is provided', async () => {
    await streamWorkforce(mockApiClient, 'sunny-squid', {}, { ...remoteCtx, parentId: 'run-456' });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.args.stream).toBe(true);
    expect(body.args.context).toEqual({ parent_id: 'run-456' });
  });

  test('should omit args.context entirely when parentId is not provided', async () => {
    await callWorkforce(mockApiClient, 'sunny-squid', {}, remoteCtx);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.args.context).toBeUndefined();
  });
});

// ── Timbal class wrappers ──

describe('Timbal workforce wrappers', () => {
  let timbal: Timbal;
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  const listResponse = {
    workforce: [
      {
        id: '361',
        uid: 'manifest-1',
        type: 'workflow',
        name: 'clever-jaguar',
        description: null,
        url: 'https://api.timbal.ai/orgs/org1/projects/proj1/workforce/manifest-1?rev=main',
      },
    ],
  };

  beforeEach(() => {
    clearWorkforceCache();
    originalFetch = global.fetch;

    mockFetch = mock((url: string) => {
      // Proxy endpoint has an identifier segment: /workforce/{id}/...
      if (/\/workforce\/[^/?]+/.test(url)) {
        return Promise.resolve(new Response(JSON.stringify({ output: 'ok' }), { status: 200 }));
      }
      // Otherwise this is the list endpoint.
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(listResponse),
      });
    });
    global.fetch = mockFetch as unknown as typeof global.fetch;

    timbal = new Timbal({ token: 'test-key', baseUrl: 'https://api.timbal.ai' });
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

  test('should expose clearWorkforceCache on the Timbal class', () => {
    expect(typeof timbal.clearWorkforceCache).toBe('function');
    timbal.clearWorkforceCache();
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
