import { Elysia } from 'elysia';
import { Timbal } from '../lib/timbal';
import { createAuthRoutes } from './routes';
import { createAuthMiddleware } from './middleware';
import { createConfigRoute, resolveConfigPath } from './config-route';
import { resolveAuthMode } from '../auth/config';
import type { TimbalAuthOptions } from '../auth/types';

export type {
  TimbalAuthOptions,
  AuthProvider,
  ProjectAuthConfig,
  PublicAppConfig,
  SsoConnection,
} from '../auth/types';

/**
 * Elysia plugin that adds Timbal authentication.
 *
 * Registers:
 * - Auth routes at `/auth` (login, callback, OAuth, magic-link, refresh, logout)
 * - Auth middleware (token resolution from Bearer header/cookie, route guarding)
 *
 * @example
 * ```ts
 * import { timbalAuth } from "@timbal-ai/timbal-sdk/elysia";
 *
 * const app = new Elysia()
 *   .use(timbalAuth())
 *   .get("/", () => "Hello!")
 *   .listen(3000);
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function timbalAuth(options: TimbalAuthOptions = {}): any {
  const timbal = new Timbal();

  // `/config` is platform-mode only and opt-out via `configRoute: false`.
  const mountConfig =
    resolveAuthMode(options) === 'platform' && options.configRoute !== false;

  // Make `/config` public so the ingress gate never blocks it. Done here (not in
  // the shared default list) so legacy apps are completely unaffected.
  const effectiveOptions: TimbalAuthOptions = mountConfig
    ? {
        ...options,
        publicPaths: [...(options.publicPaths ?? []), resolveConfigPath(options)],
      }
    : options;

  const app = new Elysia({ name: 'timbal-auth' })
    .use(createAuthMiddleware(timbal, effectiveOptions))
    .use(createAuthRoutes(timbal, effectiveOptions));

  return mountConfig ? app.use(createConfigRoute(timbal, options)) : app;
}
