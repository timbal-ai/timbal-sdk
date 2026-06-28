import type { Timbal } from '../lib/timbal';
import type { PlatformContext, Project } from '../types';
import type { AuthProvider, ProjectAuthConfig, PublicAppConfig } from './types';

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
 * - `enabled` ← `use_platform_iam` (the user-auth gate)
 * - `providers` ← `auth_providers`, defaulting to all when absent (preserves
 *   today's "show every provider" login page for older platform responses)
 * - `sso` is intentionally omitted until the platform ships SSO connections
 */
export function authConfigFromProject(project: Project): ProjectAuthConfig {
  return {
    enabled: project.use_platform_iam,
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

interface CacheEntry {
  value: ProjectAuthConfig;
  expiresAt: number;
}

// Module-level cache keyed by org:project. The middleware uses a single service
// Timbal per plugin, so this is effectively per-deployment.
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ProjectAuthConfig>>();

function resolveCacheKey(timbal: Timbal, ctx?: PlatformContext): string {
  const cfg = timbal.apiClient.getConfig();
  const orgId = ctx?.orgId ?? cfg.orgId ?? '';
  const projectId = ctx?.projectId ?? cfg.projectId ?? '';
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
    pending = getProjectAuthConfig(timbal, opts.ctx)
      .then((value) => {
        cache.set(key, { value, expiresAt: now() + ttlMs });
        return value;
      })
      .finally(() => {
        inflight.delete(key);
      });
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
