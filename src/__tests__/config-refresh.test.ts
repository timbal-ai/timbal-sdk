import { describe, test, expect, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import {
  getCachedRuntimeChannels,
  clearRuntimeChannelsCache,
} from '../channels/runtime';
import {
  refreshPlatformConfig,
  registerConfigRefreshHook,
  clearConfigRefreshHooks,
} from '../config/refresh';
import { timbalConfigRefresh } from '../elysia/config-refresh';
import { resolveChannelBindings, timbalChannels } from '../elysia/channels';
import { clearProjectAuthConfigCache } from '../auth/config';
import { TimbalApiError } from '../lib/api';
import type { Timbal } from '../lib/timbal';
import type { ProjectChannelSpec } from '../types';

/** Let detached (void-ed) refresh work settle. */
const settle = () => new Promise((r) => setTimeout(r, 10));

/**
 * Fake platform-linked Timbal holding the service token `svc-secret`.
 * `runtime()` supplies the `GET .../channels/runtime` payload per call —
 * return an array, throw a TimbalApiError(404) for older platforms, or
 * throw anything else for a platform blip.
 */
let counter = 0;
function makeTimbal(runtime: () => ProjectChannelSpec[]) {
  const projectId = `refresh-proj-${++counter}`;
  let runtimeFetches = 0;
  let projectFetches = 0;
  const timbal = {
    apiClient: {
      getConfig: () => ({ orgId: 'test-org', projectId, token: 'svc-secret' }),
      async get() {
        runtimeFetches += 1;
        return { data: { channels: runtime() }, success: true, statusCode: 200 };
      },
    },
    async getProject() {
      projectFetches += 1;
      return { id: projectId, name: 'p' };
    },
  } as unknown as Timbal;
  return {
    timbal,
    runtimeFetchCount: () => runtimeFetches,
    projectFetchCount: () => projectFetches,
  };
}

afterEach(() => {
  clearRuntimeChannelsCache();
  clearProjectAuthConfigCache();
  clearConfigRefreshHooks();
});

describe('getCachedRuntimeChannels', () => {
  test('caches within TTL and single-flights concurrent callers', async () => {
    const { timbal, runtimeFetchCount } = makeTimbal(() => [
      { provider: 'telegram', workforce: 'a', credentials: { token: '1:x' } },
    ]);
    const [r1, r2] = await Promise.all([
      getCachedRuntimeChannels(timbal),
      getCachedRuntimeChannels(timbal),
    ]);
    await getCachedRuntimeChannels(timbal);
    expect(r1).toEqual(r2!);
    expect(r1!.map((s) => s.workforce)).toEqual(['a']);
    expect(runtimeFetchCount()).toBe(1);
  });

  test('revalidates after TTL, serves stale on error', async () => {
    let fail = false;
    const specs = [{ provider: 'telegram', workforce: 'a', credentials: { token: '1:x' } }];
    const { timbal } = makeTimbal(() => {
      if (fail) throw new TimbalApiError('down', 503);
      return specs;
    });
    let clock = 1000;
    const now = () => clock;

    expect(await getCachedRuntimeChannels(timbal, { now, ttlMs: 60_000 })).toHaveLength(1);
    clock += 61_000;
    fail = true;
    // TTL expired + fetch failing → stale value, not a throw.
    expect(await getCachedRuntimeChannels(timbal, { now, ttlMs: 60_000 })).toHaveLength(1);
  });

  test('404 (older platform) is cached as null', async () => {
    const { timbal, runtimeFetchCount } = makeTimbal(() => {
      throw new TimbalApiError('Not Found', 404);
    });
    expect(await getCachedRuntimeChannels(timbal)).toBeNull();
    expect(await getCachedRuntimeChannels(timbal)).toBeNull();
    expect(runtimeFetchCount()).toBe(1);
  });

  test('disabled and malformed specs are filtered out', async () => {
    const { timbal } = makeTimbal(
      () =>
        [
          { provider: 'telegram', workforce: 'a', enabled: false },
          { provider: '', workforce: 'a' },
          { provider: 'slack', workforce: 'b' },
        ] as ProjectChannelSpec[],
    );
    const specs = await getCachedRuntimeChannels(timbal);
    expect(specs!.map((s) => s.provider)).toEqual(['slack']);
  });
});

describe('timbalConfigRefresh endpoint', () => {
  const post = (app: Elysia, token?: string) =>
    app.handle(
      new Request('https://x.test/__timbal/config/refresh', {
        method: 'POST',
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    );

  test('missing or wrong bearer → 401, caches untouched', async () => {
    let specs: ProjectChannelSpec[] = [
      { provider: 'telegram', workforce: 'old', credentials: { token: '1:x' } },
    ];
    const { timbal } = makeTimbal(() => specs);
    const env = { TIMBAL_PROJECT_ID: '248' };
    const app = new Elysia().use(timbalConfigRefresh({ timbal }));

    expect((await resolveChannelBindings(timbal, { env })).map((b) => b.workforce)).toEqual(['old']);
    specs = [{ provider: 'telegram', workforce: 'new', credentials: { token: '1:x' } }];

    expect((await post(app)).status).toBe(401);
    expect((await post(app, 'wrong-token')).status).toBe(401);
    await settle();
    // Still the cached value — a bad call must not evict.
    expect((await resolveChannelBindings(timbal, { env })).map((b) => b.workforce)).toEqual(['old']);
  });

  test('valid service credential → 202, caches evicted, next resolve is fresh', async () => {
    let specs: ProjectChannelSpec[] = [
      { provider: 'telegram', workforce: 'old', credentials: { token: '1:x' } },
    ];
    const { timbal } = makeTimbal(() => specs);
    const env = { TIMBAL_PROJECT_ID: '248' };
    const app = new Elysia().use(timbalConfigRefresh({ timbal }));

    expect((await resolveChannelBindings(timbal, { env })).map((b) => b.workforce)).toEqual(['old']);
    specs = [{ provider: 'telegram', workforce: 'new', credentials: { token: '1:x' } }];

    const res = await post(app, 'svc-secret');
    expect(res.status).toBe(202);
    await settle();
    expect((await resolveChannelBindings(timbal, { env })).map((b) => b.workforce)).toEqual(['new']);
  });

  test('valid refresh warms the caches and runs registered hooks', async () => {
    const { timbal, runtimeFetchCount, projectFetchCount } = makeTimbal(() => []);
    const app = new Elysia().use(timbalConfigRefresh({ timbal }));

    let hookRuns = 0;
    registerConfigRefreshHook('test-hook', () => {
      hookRuns += 1;
    });
    // A throwing hook must not break the refresh.
    registerConfigRefreshHook('bad-hook', () => {
      throw new Error('boom');
    });

    expect((await post(app, 'svc-secret')).status).toBe(202);
    await settle();
    expect(hookRuns).toBe(1);
    expect(runtimeFetchCount()).toBe(1); // warmed
    expect(projectFetchCount()).toBe(1); // warmed
  });
});

describe('channels webhook re-provisioning on refresh', () => {
  test('dynamic-mode plugin re-runs setWebhook when config refreshes', async () => {
    const { timbal } = makeTimbal(() => [
      { provider: 'telegram', workforce: 'joi', credentials: { token: '7:abc' } },
    ]);

    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | Request) => {
      calls.push(typeof input === 'string' ? input : input.url);
      return new Response(JSON.stringify({ ok: true, result: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      // Mounting registers the 'channels:webhook-provisioning' hook.
      new Elysia().use(
        timbalChannels({
          timbal,
          env: {
            TIMBAL_PROJECT_ID: '248',
            PUBLIC_ORIGIN: 'https://app.example.com',
          },
        }),
      );
      await refreshPlatformConfig();
      expect(calls.some((u) => u.includes('/bot7:abc/setWebhook'))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
