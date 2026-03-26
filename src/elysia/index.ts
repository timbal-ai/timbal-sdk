import { Elysia } from 'elysia';
import { Timbal } from '../lib/timbal';
import { createAuthRoutes } from './routes';
import { createAuthMiddleware } from './middleware';
import type { TimbalAuthOptions } from '../auth/types';

export type { TimbalAuthOptions } from '../auth/types';

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

  return new Elysia({ name: 'timbal-auth' })
    .use(createAuthRoutes(timbal, options))
    .use(createAuthMiddleware(timbal, options));
}
