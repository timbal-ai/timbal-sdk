import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { Timbal } from '../lib/timbal';
import type { Project } from '../types';
import {
  authConfigFromProject,
  getProjectAuthConfig,
  getCachedProjectAuthConfig,
  clearProjectAuthConfigCache,
  toPublicAppConfig,
  resolveAuthMode,
  resolveAuthConfig,
} from '../auth/config';
import { coerceProject } from '../lib/coerce';

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
    auth_enabled: false,
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
  test('enabled maps from auth_enabled', () => {
    expect(authConfigFromProject(makeProject({ auth_enabled: true })).enabled).toBe(true);
    expect(authConfigFromProject(makeProject({ auth_enabled: false })).enabled).toBe(false);
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

  test('all-unknown providers coerce to undefined → defaults to all (no lockout)', () => {
    // The wire sent providers, but none the SDK knows. After coercion that
    // surfaces as undefined, so the derived config shows every known provider
    // rather than an unusable empty login.
    const project = coerceProject({
      id: 230, name: 'p', description: null, has_ui: false, role: 'owner',
      default_role: null, is_public_template: false, template_uses: 0,
      publishable_api_key: 'pk', auth_enabled: true,
      auth_providers: ['oidc', 'saml'],
      repository_url: null, screenshot_url: null,
      created_at: 0, updated_at: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(authConfigFromProject(project).providers).toEqual([
      'email',
      'google',
      'microsoft',
      'github',
    ]);
  });

  test('sso omitted until platform ships it', () => {
    expect(authConfigFromProject(makeProject()).sso).toBeUndefined();
  });
});

describe('getProjectAuthConfig', () => {
  test('fetches project and maps', async () => {
    const { timbal, calls } = makeFakeTimbal({
      project: makeProject({ auth_enabled: true, auth_providers: ['github'] }),
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
      project: makeProject({ auth_enabled: true }),
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

  test('cache key mirrors getProject resolution: empty-string ctx falls through to config', async () => {
    // Regression: key used `??` while getProject uses `||`, so an empty-string
    // ctx field produced a key (':') that didn't match the fetched project.
    const { timbal, calls } = makeFakeTimbal({ orgId: '10', projectId: '230' });
    await getCachedProjectAuthConfig(timbal, { now: () => 0 }); // no ctx → key 10:230
    await getCachedProjectAuthConfig(timbal, {
      now: () => 0,
      ctx: { orgId: '', projectId: '' }, // must resolve to the same 10:230
    });
    expect(calls()).toBe(1); // second call is a cache hit, not a refetch
  });

  test('a fetch in flight during a clear does not repopulate the cache', async () => {
    // Regression: the in-flight .then() called cache.set unconditionally, so a
    // revalidation that started before clear() could land after and undo the
    // forced refresh.
    let calls = 0;
    let release!: (p: Project) => void;
    let gate = new Promise<Project>((res) => {
      release = res;
    });
    const timbal = {
      apiClient: { getConfig: () => ({ orgId: '10', projectId: 'inflight' }) },
      getProject: async () => {
        calls += 1;
        return gate;
      },
    } as unknown as Timbal;

    clearProjectAuthConfigCache(); // baseline epoch
    const p1 = getCachedProjectAuthConfig(timbal, { now: () => 0 }); // fetch #1 in flight
    expect(calls).toBe(1);

    clearProjectAuthConfigCache(); // clear while #1 is still pending
    release(makeProject({ auth_enabled: true }));
    await p1; // #1 resolves — must NOT write to cache (stale epoch)

    // Next call sees an empty cache and must fetch again.
    gate = Promise.resolve(makeProject({ auth_enabled: true }));
    await getCachedProjectAuthConfig(timbal, { now: () => 0 });
    expect(calls).toBe(2);
  });
});

describe('resolveAuthMode', () => {
  const ENV_KEY = 'TIMBAL_AUTH_MODE';
  const original = process.env[ENV_KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  test('defaults to legacy with no option and no env', () => {
    delete process.env[ENV_KEY];
    expect(resolveAuthMode()).toBe('legacy');
    expect(resolveAuthMode({})).toBe('legacy');
  });

  test('explicit option wins', () => {
    process.env[ENV_KEY] = 'legacy';
    expect(resolveAuthMode({ authMode: 'platform' })).toBe('platform');
    process.env[ENV_KEY] = 'platform';
    expect(resolveAuthMode({ authMode: 'legacy' })).toBe('legacy');
  });

  test('env used when no option', () => {
    process.env[ENV_KEY] = 'platform';
    expect(resolveAuthMode()).toBe('platform');
    process.env[ENV_KEY] = 'legacy';
    expect(resolveAuthMode()).toBe('legacy');
  });

  test('unrecognized env value is ignored (falls back to legacy)', () => {
    process.env[ENV_KEY] = 'PLATFORM'; // wrong case
    expect(resolveAuthMode()).toBe('legacy');
    process.env[ENV_KEY] = 'garbage';
    expect(resolveAuthMode()).toBe('legacy');
  });
});

describe('resolveAuthConfig', () => {
  beforeEach(() => clearProjectAuthConfigCache());

  test('authConfig override short-circuits — no fetch', async () => {
    const { timbal, calls } = makeFakeTimbal({ projectId: 'override' });
    const override = { enabled: false, providers: ['email'] as const };
    const cfg = await resolveAuthConfig(timbal, { authConfig: { ...override } });
    expect(cfg).toEqual({ enabled: false, providers: ['email'] });
    expect(calls()).toBe(0);
  });

  test('without override, uses the cached platform fetch', async () => {
    const { timbal, calls } = makeFakeTimbal({
      projectId: 'fetched',
      project: makeProject({ auth_enabled: true, auth_providers: ['google'] }),
    });
    const cfg = await resolveAuthConfig(timbal, {});
    expect(cfg).toEqual({ enabled: true, providers: ['google'] });
    expect(calls()).toBe(1);
  });
});

describe('toPublicAppConfig', () => {
  test('maps project id/name and required flag', () => {
    const pub = toPublicAppConfig(
      makeProject({ id: '230', name: 'My App' }),
      { enabled: true, providers: ['google'] },
    );
    expect(pub).toEqual({
      project: { id: '230', name: 'My App' },
      auth: { required: true, providers: ['google'] },
    });
  });

  test('required reflects auth.enabled', () => {
    const pub = toPublicAppConfig(makeProject(), {
      enabled: false,
      providers: [],
    });
    expect(pub.auth.required).toBe(false);
  });

  test('omits sso when there are no connections', () => {
    const pub = toPublicAppConfig(makeProject(), {
      enabled: true,
      providers: ['email'],
    });
    expect(pub.auth.sso).toBeUndefined();
  });

  test('exposes sso availability only — never the connection list', () => {
    const pub = toPublicAppConfig(makeProject(), {
      enabled: true,
      providers: ['email'],
      sso: [
        { id: 'acme', label: 'Acme Corp', url: 'https://idp.acme/start' },
        { id: 'globex', label: 'Globex', protocol: 'saml' },
      ],
    });
    expect(pub.auth.sso).toEqual({ enabled: true });
    // tenant identity must not leak into the public payload
    const json = JSON.stringify(pub);
    expect(json).not.toContain('Acme');
    expect(json).not.toContain('Globex');
    expect(json).not.toContain('idp.acme');
  });

  test('does not leak secret/internal project fields', () => {
    const pub = toPublicAppConfig(
      makeProject({ publishable_api_key: 'pk_SECRET', repository_url: 'git@x' }),
      { enabled: true, providers: ['google'] },
    );
    const json = JSON.stringify(pub);
    expect(json).not.toContain('pk_SECRET');
    expect(json).not.toContain('publishable_api_key');
    expect(json).not.toContain('repository_url');
    expect(json).not.toContain('auth_enabled');
  });
});
