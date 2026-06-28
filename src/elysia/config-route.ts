import { Elysia } from 'elysia';
import type { Timbal } from '../lib/timbal';
import type { TimbalAuthOptions } from '../auth/types';
import { authConfigFromProject, toPublicAppConfig } from '../auth/config';

/** Path the public config is served at. `configRoute` string overrides `/config`. */
export function resolveConfigPath(options: TimbalAuthOptions = {}): string {
  return typeof options.configRoute === 'string' ? options.configRoute : '/config';
}

/**
 * Public `GET /config` route returning a browser-safe {@link PublicAppConfig}.
 *
 * Mounted only in platform mode (see `timbalAuth`). One `getProject()` round
 * trip; the auth config is derived from that same project (or the
 * `authConfig` override) so there's no second fetch.
 *
 * Note: no fail-soft yet — a platform/getProject failure surfaces as a 500.
 * Caching + stale-on-error for this route is a deliberate follow-up.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createConfigRoute(timbal: Timbal, options: TimbalAuthOptions = {}): any {
  const path = resolveConfigPath(options);

  return new Elysia({ name: 'timbal-config' }).get(
    path,
    async () => {
      const project = await timbal.getProject();
      const authConfig = options.authConfig ?? authConfigFromProject(project);
      return toPublicAppConfig(project, authConfig);
    },
    { detail: { hide: true } },
  );
}
