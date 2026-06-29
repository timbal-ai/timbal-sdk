import { Elysia } from 'elysia';
import type { Timbal } from '../lib/timbal';
import type { TimbalAuthOptions } from '../auth/types';
import { resolvePublicAppConfig } from '../auth/config';

/** Path the public config is served at. `configRoute` string overrides `/config`. */
export function resolveConfigPath(options: TimbalAuthOptions = {}): string {
  return typeof options.configRoute === 'string' ? options.configRoute : '/config';
}

/**
 * Public `GET /config` route returning a browser-safe {@link PublicAppConfig}.
 *
 * Mounted only in platform mode (see `timbalAuth`). Reads the project from the
 * same TTL-cached source as the ingress gate (single-flight + fail-soft), so
 * the advertised `auth.required`/providers can't diverge from what gates API
 * routes, and a transient platform blip serves the last-known-good config.
 *
 * Cold-cache failure (nothing to fail-soft to) returns a retryable 503 rather
 * than an unhandled 500 — matching how the middleware degrades on the same
 * error. We never fabricate a payload: guessing `required: false` would tell
 * the client no login is needed, a fail-open leak.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createConfigRoute(timbal: Timbal, options: TimbalAuthOptions = {}): any {
  const path = resolveConfigPath(options);

  return new Elysia({ name: 'timbal-config' }).get(
    path,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async ({ set }: { set: any }) => {
      try {
        return await resolvePublicAppConfig(timbal, options);
      } catch {
        set.status = 503;
        return { error: 'config_unavailable' };
      }
    },
    { detail: { hide: true } },
  );
}
