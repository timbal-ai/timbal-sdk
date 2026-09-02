import { Elysia } from 'elysia';
import { Timbal } from '../lib/timbal';
import { createAuthRoutes } from './routes';
import { createAuthMiddleware } from './middleware';
import { createConfigRoute, resolveConfigPath } from './config-route';
import { timbalConfigRefresh } from './config-refresh';
import { timbalCron } from './cron';
import { resolveAuthMode } from '../auth/config';
import type { TimbalAuthOptions } from '../auth/types';

export type {
  TimbalAuthOptions,
  AuthProvider,
  ProjectAuthConfig,
  PublicAppConfig,
  SsoConnection,
} from '../auth/types';

export {
  timbalChannels,
  registerChannelWebhooks,
  resolveBindingPath,
  resolveChannelBindings,
  CHANNELS_PUBLIC_PATHS,
  type TimbalChannelsOptions,
  type RegisterChannelWebhooksOptions,
  type ResolveChannelBindingsOptions,
  type WebhookRegistration,
  type ChannelProvisionResult,
} from './channels';
export {
  timbalMcp,
  deriveMcpTools,
  type TimbalMcpOptions,
  type McpRouteMeta,
  type ToolCallInfo,
  type DeriveMcpToolsOptions,
} from './mcp';
export { timbalConfigRefresh, type TimbalConfigRefreshOptions } from './config-refresh';
export {
  timbalCron,
  classifyCronPattern,
  evaluatePlatformEligibility,
  resolveCronMode,
  type TimbalCronOptions,
  type TimbalCronMode,
  type CronManifest,
  type CronJobManifest,
  type CronJobLike,
  type CronRunOutcome,
  type CronIneligibleReason,
} from './cron';
export {
  refreshPlatformConfig,
  registerConfigRefreshHook,
  clearConfigRefreshHooks,
  type ConfigRefreshHook,
  type RefreshPlatformConfigOptions,
} from '../config/refresh';
export * from '../channels';

/**
 * Elysia plugin that adds Timbal authentication.
 *
 * Registers:
 * - Auth routes at `/auth` (login, callback, OAuth, magic-link, refresh, logout)
 * - Auth middleware (token resolution from Bearer header/cookie, route guarding)
 * - `POST /__timbal/config/refresh` (platform cache invalidation; opt out with
 *   `configRefresh: false`)
 * - `GET /__timbal/cron` + `POST /__timbal/cron/:name/trigger` (platform-owned
 *   scheduling for `@elysiajs/cron` jobs; opt out with `cron: false`)
 * - `GET /config` in platform mode (opt out with `configRoute: false`)
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
  const mountConfig = resolveAuthMode(options) === 'platform' && options.configRoute !== false;

  // Make `/config` public so the ingress gate never blocks it. Done here (not in
  // the shared default list) so legacy apps are completely unaffected.
  const effectiveOptions: TimbalAuthOptions = mountConfig
    ? {
        ...options,
        publicPaths: [...(options.publicPaths ?? []), resolveConfigPath(options)],
      }
    : options;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any = new Elysia({ name: 'timbal-auth' })
    .use(createAuthMiddleware(timbal, effectiveOptions))
    .use(createAuthRoutes(timbal, effectiveOptions));

  if (mountConfig) {
    app = app.use(createConfigRoute(timbal, options));
  }

  // Platform cache bust — always-on SDK infrastructure (same default as the
  // blueprint used to mount explicitly). Shares the auth plugin's Timbal
  // client so the bearer check uses the same service credential.
  if (options.configRefresh !== false) {
    app = app.use(timbalConfigRefresh({ timbal }));
  }

  // Cron manifest + trigger — lets the platform own scheduling for
  // `@elysiajs/cron` jobs. Behaviour-neutral unless TIMBAL_CRON_MODE=platform.
  if (options.cron !== false) {
    app = app.use(timbalCron({ timbal }));
  }

  return app;
}
