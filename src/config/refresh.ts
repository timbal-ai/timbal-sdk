import type { Timbal } from '../lib/timbal';
import { clearProjectAuthConfigCache, getCachedProject } from '../auth/config';
import { clearRuntimeChannelsCache, getCachedRuntimeChannels } from '../channels/runtime';

/**
 * Platform-config refresh — the push complement to the 60s TTL caches.
 *
 * The platform fires the SDK's refresh endpoint (best-effort, fire-and-
 * forget) after any project-config mutation it knows the SDK consumes:
 * channel writes, auth-mode/provider changes, and whatever joins the
 * payload later. The TTL stays as the correctness fallback — a missed call
 * degrades to ≤60s staleness, never wrongness.
 *
 * This module is the shared core: cache eviction + a hook registry so each
 * feature (channels, auth, future config consumers) can attach follow-up
 * work without this file knowing about them.
 */

export type ConfigRefreshHook = () => void | Promise<void>;

// Named registry: re-mounting a plugin (tests, HMR) replaces its hook
// instead of accumulating stale closures.
const hooks = new Map<string, ConfigRefreshHook>();

/**
 * Register follow-up work to run after every config refresh (e.g. channels
 * re-runs programmatic webhook registration so a Telegram binding added in
 * the UI gets its `setWebhook`). Same-name registration replaces. Returns an
 * unregister function.
 */
export function registerConfigRefreshHook(
  name: string,
  hook: ConfigRefreshHook,
): () => void {
  hooks.set(name, hook);
  return () => {
    if (hooks.get(name) === hook) hooks.delete(name);
  };
}

/** Drop all refresh hooks (tests). */
export function clearConfigRefreshHooks(): void {
  hooks.clear();
}

export interface RefreshPlatformConfigOptions {
  /** Client used to warm the caches after eviction. Skipped when omitted. */
  timbal?: Timbal;
  /**
   * Refetch (not just evict) so the next end-user request doesn't pay the
   * platform round trip. @default true when `timbal` is provided
   */
  warm?: boolean;
}

/**
 * Evict every cached platform-config fetch (project payload — auth gate
 * topology and `project.channels` — plus the runtime channels/credentials
 * payload), optionally warm them, then run registered hooks.
 *
 * Hook and warm failures are swallowed: refresh is an optimization on top
 * of the TTL, it must never take the app down.
 */
export async function refreshPlatformConfig(
  options: RefreshPlatformConfigOptions = {},
): Promise<void> {
  clearProjectAuthConfigCache();
  clearRuntimeChannelsCache();

  const { timbal } = options;
  if (timbal && options.warm !== false) {
    await Promise.allSettled([
      getCachedProject(timbal),
      getCachedRuntimeChannels(timbal),
    ]);
  }

  for (const hook of hooks.values()) {
    try {
      await hook();
    } catch {
      /* refresh must never take the app down */
    }
  }
}
