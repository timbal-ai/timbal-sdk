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
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createConfigRoute(timbal: Timbal, options: TimbalAuthOptions = {}): any {
  const path = resolveConfigPath(options);

  return new Elysia({ name: 'timbal-config' }).get(
    path,
    () => resolvePublicAppConfig(timbal, options),
    { detail: { hide: true } },
  );
}
