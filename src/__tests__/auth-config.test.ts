import { describe, test, expect, beforeEach } from 'bun:test';
import type { Timbal } from '../lib/timbal';
import type { Project } from '../types';
import {
  authConfigFromProject,
  getProjectAuthConfig,
  getCachedProjectAuthConfig,
  clearProjectAuthConfigCache,
} from '../auth/config';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: '230',
    name: 'p',
    description: null,
    has_ui: false,
    role: 'owner',
    default_role: null,
    is_public_template: false,
    template_uses: 0,
    publishable_api_key: 'pk',
    use_platform_iam: false,
    repository_url: null,
    screenshot_url: null,
    created_at: 0,
    updated_at: 0,
    workforce: [],
    ...overrides,
  };
}

/**
 * Minimal Timbal stand-in: a getProject() that counts calls and can be told to
 * reject, plus the apiClient.getConfig() the cache key resolver reads.
 */
function makeFakeTimbal(opts: {
  project?: Project;
  orgId?: string;
  projectId?: string;
  fail?: () => boolean;
}): { timbal: Timbal; calls: () => number } {
  let calls = 0;
  const timbal = {
    apiClient: {
      getConfig: () => ({ orgId: opts.orgId ?? '10', projectId: opts.projectId ?? '230' }),
    },
    getProject: async () => {
      calls += 1;
      if (opts.fail?.()) throw new Error('platform 500');
      return opts.project ?? makeProject();
    },
  } as unknown as Timbal;
  return { timbal, calls: () => calls };
}

describe('authConfigFromProject', () => {
  test('enabled maps from use_platform_iam', () => {
    expect(authConfigFromProject(makeProject({ use_platform_iam: true })).enabled).toBe(true);
    expect(authConfigFromProject(makeProject({ use_platform_iam: false })).enabled).toBe(false);
  });

  test('providers passthrough when present', () => {
    const cfg = authConfigFromProject(
      makeProject({ auth_providers: ['google', 'email'] }),
    );
    expect(cfg.providers).toEqual(['google', 'email']);
  });

  test('providers default to all when auth_providers is undefined', () => {
    const cfg = authConfigFromProject(makeProject({ auth_providers: undefined }));
    expect(cfg.providers).toEqual(['email', 'google', 'microsoft', 'github']);
  });

  test('explicit empty providers is preserved (not defaulted)', () => {
    const cfg = authConfigFromProject(makeProject({ auth_providers: [] }));
    expect(cfg.providers).toEqual([]);
  });

  test('sso omitted until platform ships it', () => {
    expect(authConfigFromProject(makeProject()).sso).toBeUndefined();
  });
});

describe('getProjectAuthConfig', () => {
  test('fetches project and maps', async () => {
    const { timbal, calls } = makeFakeTimbal({
      project: makeProject({ use_platform_iam: true, auth_providers: ['github'] }),
    });
    const cfg = await getProjectAuthConfig(timbal);
    expect(cfg).toEqual({ enabled: true, providers: ['github'] });
    expect(calls()).toBe(1);
  });
});

describe('getCachedProjectAuthConfig', () => {
  beforeEach(() => clearProjectAuthConfigCache());

  test('fresh hit served from cache (no second fetch)', async () => {
    const { timbal, calls } = makeFakeTimbal({ projectId: 'fresh' });
    const t = 1_000;
    await getCachedProjectAuthConfig(timbal, { ttlMs: 60_000, now: () => t });
    await getCachedProjectAuthConfig(timbal, { ttlMs: 60_000, now: () => t + 100 });
    expect(calls()).toBe(1);
  });

  test('refetches after TTL expiry', async () => {
    const { timbal, calls } = makeFakeTimbal({ projectId: 'expire' });
    await getCachedProjectAuthConfig(timbal, { ttlMs: 1_000, now: () => 0 });
    await getCachedProjectAuthConfig(timbal, { ttlMs: 1_000, now: () => 2_000 });
    expect(calls()).toBe(2);
  });

  test('single-flight: concurrent callers share one fetch', async () => {
    const { timbal, calls } = makeFakeTimbal({ projectId: 'concurrent' });
    const [a, b] = await Promise.all([
      getCachedProjectAuthConfig(timbal, { now: () => 0 }),
      getCachedProjectAuthConfig(timbal, { now: () => 0 }),
    ]);
    expect(a).toEqual(b);
    expect(calls()).toBe(1);
  });

  test('fail-soft: serves stale value when revalidation fails', async () => {
    let down = false;
    const { timbal, calls } = makeFakeTimbal({
      projectId: 'failsoft',
      project: makeProject({ use_platform_iam: true }),
      fail: () => down,
    });
    const first = await getCachedProjectAuthConfig(timbal, { ttlMs: 1_000, now: () => 0 });
    expect(first.enabled).toBe(true);

    down = true;
    const stale = await getCachedProjectAuthConfig(timbal, { ttlMs: 1_000, now: () => 5_000 });
    expect(stale).toEqual(first); // stale-on-error, no throw
    expect(calls()).toBe(2); // it did attempt a revalidation
  });

  test('throws when fetch fails and there is no prior value', async () => {
    const { timbal } = makeFakeTimbal({ projectId: 'nofallback', fail: () => true });
    await expect(getCachedProjectAuthConfig(timbal, { now: () => 0 })).rejects.toThrow(
      'platform 500',
    );
  });

  test('clearProjectAuthConfigCache forces a refetch', async () => {
    const { timbal, calls } = makeFakeTimbal({ projectId: 'cleared' });
    await getCachedProjectAuthConfig(timbal, { now: () => 0 });
    clearProjectAuthConfigCache();
    await getCachedProjectAuthConfig(timbal, { now: () => 0 });
    expect(calls()).toBe(2);
  });
});
