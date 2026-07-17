import type { Timbal } from '../lib/timbal';
import { TimbalApiError } from '../lib/api';
import type { PlatformContext, ProjectChannelSpec } from '../types';
import { filterChannelSpecs } from './config';

/**
 * Runtime channel config: topology **plus credentials**, served only to the
 * project service principal via
 * `GET /orgs/{org}/projects/{id}/channels/runtime`.
 *
 * This is how platform-configured channels work without env vars or
 * redeploys: credentials are stored platform-side (encrypted under the
 * project DEK) and arrive with the topology. The project payload
 * (`project.channels`) stays topology-only because it renders everywhere.
 *
 * Credentials are held in memory only and must never be logged.
 */

/**
 * Fetch the runtime channel specs.
 *
 * - Array (possibly empty) → the platform's authoritative channel set.
 * - `null` → the platform predates the runtime endpoint (404); callers fall
 *   back to `project.channels` topology + env credentials.
 * - Throws on any other failure (auth, network, 5xx).
 */
export async function getRuntimeChannels(
  timbal: Timbal,
  ctx?: PlatformContext,
): Promise<ProjectChannelSpec[] | null> {
  const cfg = timbal.apiClient.getConfig();
  const orgId = ctx?.orgId || cfg.orgId;
  const projectId = ctx?.projectId || cfg.projectId;
  if (!orgId || !projectId) {
    throw new Error('orgId and projectId are required for runtime channel config.');
  }

  try {
    const response = await timbal.apiClient.get<{ channels?: unknown }>(
      `orgs/${orgId}/projects/${projectId}/channels/runtime`,
    );
    // Malformed/missing array on a 200 is treated as "no channels", not as
    // an older platform — the endpoint existing is the capability signal.
    return filterChannelSpecs(response.data?.channels) ?? [];
  } catch (err) {
    if (err instanceof TimbalApiError && err.isNotFound()) return null;
    throw err;
  }
}

interface CacheEntry {
  value: ProjectChannelSpec[] | null;
  expiresAt: number;
}

// Mirror of the auth-config project cache (TTL + single-flight +
// stale-on-error), keyed org:project. Kept separate because the payloads
// have different sensitivity: this one carries credentials and is never
// exposed through any public route.
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ProjectChannelSpec[] | null>>();
let generation = 0;

function resolveCacheKey(timbal: Timbal, ctx?: PlatformContext): string {
  const cfg = timbal.apiClient.getConfig();
  const orgId = ctx?.orgId || cfg.orgId || '';
  const projectId = ctx?.projectId || cfg.projectId || '';
  return `${orgId}:${projectId}`;
}

export interface CachedRuntimeChannelsOptions {
  /** Cache TTL in ms. @default 60000 */
  ttlMs?: number;
  /** Platform context override (org/project). */
  ctx?: PlatformContext;
  /** Injectable clock (tests). @default Date.now */
  now?: () => number;
}

/**
 * TTL-cached {@link getRuntimeChannels} with single-flight and fail-soft
 * semantics — same freshness model as `getCachedProject`:
 *
 * - Fresh hit → cached value, no network.
 * - Stale/miss → revalidate once (concurrent callers share one fetch).
 * - Revalidation error → serve last-known-good if any; else throw.
 *
 * A cached `null` (older platform, 404) is a valid value — it prevents
 * hammering a route that doesn't exist.
 */
export async function getCachedRuntimeChannels(
  timbal: Timbal,
  opts: CachedRuntimeChannelsOptions = {},
): Promise<ProjectChannelSpec[] | null> {
  const ttlMs = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const key = resolveCacheKey(timbal, opts.ctx);

  const entry = cache.get(key);
  if (entry && entry.expiresAt > now()) return entry.value;

  let pending = inflight.get(key);
  if (!pending) {
    const gen = generation;
    const fetched = getRuntimeChannels(timbal, opts.ctx)
      .then((value) => {
        if (gen === generation) {
          cache.set(key, { value, expiresAt: now() + ttlMs });
        }
        return value;
      })
      .finally(() => {
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

/** Clear the runtime channel cache (config refresh, tests). */
export function clearRuntimeChannelsCache(): void {
  generation += 1;
  cache.clear();
  inflight.clear();
}
