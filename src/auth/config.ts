import type { Timbal } from '../lib/timbal';
import type { PlatformContext, Project } from '../types';
import type {
  AuthMode,
  AuthProvider,
  ProjectAuthConfig,
  PublicAppConfig,
  TimbalAuthOptions,
} from './types';

/** Default login methods when the platform omits `auth_providers`. */
const ALL_PROVIDERS: readonly AuthProvider[] = [
  'email',
  'google',
  'microsoft',
  'github',
];

/**
 * Pure mapper: platform `Project` → `ProjectAuthConfig`.
 *
 * - `enabled` ← `auth_enabled` (the user-auth gate)
 * - `providers` ← `auth_providers`, defaulting to all when absent (preserves
 *   today's "show every provider" login page for older platform responses)
 * - `sso` is intentionally omitted until the platform ships SSO connections
 */
export function authConfigFromProject(project: Project): ProjectAuthConfig {
  return {
    enabled: project.auth_enabled,
    providers: project.auth_providers ?? [...ALL_PROVIDERS],
  };
}

/**
 * Fetch the project (with service credentials) and derive its auth config.
 * One network round trip via the existing `getProject()` contract.
 */
export async function getProjectAuthConfig(
  timbal: Timbal,
  ctx?: PlatformContext,
): Promise<ProjectAuthConfig> {
  const project = await timbal.getProject(ctx);
  return authConfigFromProject(project);
}

/**
 * Resolve the effective auth mode.
 *
 * Precedence: explicit `options.authMode` > `TIMBAL_AUTH_MODE` env > `'legacy'`.
 * An unrecognized env value is ignored (falls back to legacy) so a typo can
 * never silently flip a deployment into platform mode.
 */
export function resolveAuthMode(
  options?: Pick<TimbalAuthOptions, 'authMode'>,
): AuthMode {
  if (options?.authMode) return options.authMode;
  const env = process.env.TIMBAL_AUTH_MODE;
  if (env === 'platform' || env === 'legacy') return env;
  return 'legacy';
}

/**
 * Resolve the project auth config for a request.
 *
 * - `options.authConfig` (test/local override) short-circuits — no fetch.
 * - Otherwise the TTL-cached platform fetch is used (fail-soft on error).
 *
 * Does NOT swallow a hard fetch failure (no prior cached value) — the caller
 * (middleware) is responsible for falling back to legacy behavior in that case.
 */
export async function resolveAuthConfig(
  timbal: Timbal,
  options: TimbalAuthOptions = {},
): Promise<ProjectAuthConfig> {
  if (options.authConfig) return options.authConfig;
  return getCachedProjectAuthConfig(timbal, {
    ttlMs: options.authConfigCacheTtlMs,
  });
}

interface CacheEntry {
  value: ProjectAuthConfig;
  expiresAt: number;
}

// Module-level cache keyed by org:project. The middleware uses a single service
// Timbal per plugin, so this is effectively per-deployment.
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ProjectAuthConfig>>();

// Bumped on every clear. In-flight fetches capture the value at start and only
// write to the cache if it still matches — so a revalidation that began before
// a clear can't repopulate (and thus undo) a forced refresh.
let generation = 0;

function resolveCacheKey(timbal: Timbal, ctx?: PlatformContext): string {
  const cfg = timbal.apiClient.getConfig();
  // Mirror getProject()'s resolution (`||`, not `??`) so an empty-string ctx
  // field falls through to client config — otherwise the key wouldn't match the
  // org/project actually fetched.
  const orgId = ctx?.orgId || cfg.orgId || '';
  const projectId = ctx?.projectId || cfg.projectId || '';
  return `${orgId}:${projectId}`;
}

export interface CachedAuthConfigOptions {
  /** Cache TTL in ms. @default 60000 */
  ttlMs?: number;
  /** Platform context override (org/project). */
  ctx?: PlatformContext;
  /** Injectable clock (tests). @default Date.now */
  now?: () => number;
}

/**
 * TTL-cached auth config with single-flight and fail-soft semantics:
 *
 * - **Fresh hit** → cached value, no network.
 * - **Stale/miss** → revalidate once (concurrent callers share one fetch).
 * - **Revalidation error** → serve last-known-good if we have it; only throw
 *   when there is no prior value. This keeps an *open* project reachable during
 *   a platform blip instead of failing closed.
 *
 * Stale entries are retained (not evicted on expiry) precisely so they can back
 * the fail-soft path.
 */
export async function getCachedProjectAuthConfig(
  timbal: Timbal,
  opts: CachedAuthConfigOptions = {},
): Promise<ProjectAuthConfig> {
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const key = resolveCacheKey(timbal, opts.ctx);

  const entry = cache.get(key);
  if (entry && entry.expiresAt > now()) return entry.value;

  let pending = inflight.get(key);
  if (!pending) {
    const gen = generation;
    const fetched = getProjectAuthConfig(timbal, opts.ctx)
      .then((value) => {
        // Only persist if no clear happened while this fetch was in flight.
        if (gen === generation) {
          cache.set(key, { value, expiresAt: now() + ttlMs });
        }
        return value;
      })
      .finally(() => {
        // Don't evict a newer in-flight entry registered under this key after a
        // clear — only remove our own.
        if (inflight.get(key) === fetched) inflight.delete(key);
      });
    pending = fetched;
    inflight.set(key, pending);
  }

  try {
    return await pending;
  } catch (err) {
    if (entry) return entry.value; // fail-soft: stale-on-error
    throw err;
  }
}

/** Clear the auth-config cache (tests, or forced refresh). */
export function clearProjectAuthConfigCache(): void {
  generation += 1;
  cache.clear();
  inflight.clear();
}

/**
 * Build the browser-safe `PublicAppConfig` served by `GET /config`.
 *
 * Whitelist-only: constructs a fresh object and copies just the public fields.
 * Never spreads `project` (which carries `publishable_api_key`,
 * `repository_url`, etc.) and never enumerates SSO connections — only whether
 * SSO is available — so the endpoint can't leak secrets or tenant identity.
 */
export function toPublicAppConfig(
  project: Project,
  auth: ProjectAuthConfig,
): PublicAppConfig {
  const out: PublicAppConfig = {
    project: { id: project.id, name: project.name },
    auth: {
      required: auth.enabled,
      providers: auth.providers,
    },
  };
  if (auth.sso && auth.sso.length > 0) {
    out.auth.sso = { enabled: true };
  }
  return out;
}
