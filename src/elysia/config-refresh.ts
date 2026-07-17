import { createHash, timingSafeEqual } from 'node:crypto';
import { Elysia } from 'elysia';
import { Timbal } from '../lib/timbal';
import { refreshPlatformConfig } from '../config/refresh';

export interface TimbalConfigRefreshOptions {
  /**
   * Timbal client whose service credential authenticates callers and warms
   * the caches. Defaults to a fresh service client (same identity the auth
   * gate and channels plugin hold).
   */
  timbal?: Timbal;
  /** Route path. @default '/__timbal/config/refresh' */
  path?: string;
  /** Warm (refetch) the caches after eviction. @default true */
  warm?: boolean;
}

/** Constant-time bearer comparison; hashing first equalizes lengths. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Platform-config invalidation endpoint: `POST /__timbal/config/refresh`.
 *
 * The platform calls it (fire-and-forget) after any project-config mutation
 * the SDK consumes — channel writes, auth mode/provider changes — so those
 * go live immediately instead of on the 60s TTL. On a valid call it evicts
 * every cached platform-config fetch (project payload + runtime channel
 * credentials), optionally warms them, and runs registered refresh hooks
 * (channels re-provisions programmatic webhooks). Responds 202 immediately;
 * the refresh work runs detached.
 *
 * **Auth:** requires `Authorization: Bearer <project service credential>` —
 * the same token the SDK's own `Timbal` client holds. Anything else is 401
 * without evicting (an open cache-bust route is a DoS primitive). The
 * `timbalAuth` ingress gate exempts `/__timbal/` by default (this route
 * authenticates itself with a stronger credential), so no `publicPaths`
 * entry is needed.
 *
 * ```ts
 * new Elysia()
 *   .use(timbalAuth({ publicPaths: ["/channels/"] }))
 *   .use(timbalChannels())
 *   .use(timbalConfigRefresh())
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function timbalConfigRefresh(options: TimbalConfigRefreshOptions = {}): any {
  const timbal = options.timbal ?? new Timbal();
  const path = options.path ?? '/__timbal/config/refresh';

  return new Elysia({ name: 'timbal-config-refresh' }).post(
    path,
    ({ request }: { request: Request }) => {
      const header = request.headers.get('authorization') ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      const expected = timbal.apiClient.getConfig().token;

      if (!expected || !presented || !tokenMatches(presented, expected)) {
        return new Response('Unauthorized', { status: 401 });
      }

      // 202 now; eviction + warm + hooks run detached. Refresh is
      // best-effort by contract — the TTL is the correctness fallback.
      void refreshPlatformConfig({ timbal, warm: options.warm });
      return new Response(null, { status: 202 });
    },
    { detail: { hide: true } },
  );
}
