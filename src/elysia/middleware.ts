import { Elysia } from 'elysia';
import type { Timbal } from '../lib/timbal';
import type { ProjectAuthConfig, TimbalAuthOptions } from '../auth/types';
import {
  resolveTokenFromRequest,
  isPublicPath,
  isLocalDev,
} from '../auth/core';
import { resolveAuthConfig, resolveAuthMode } from '../auth/config';
import { getPrefix } from '../auth/helpers';

const COOKIE_NAME = 'timbal_project_access_token';

export function setAuthCookie(
  cookie: Record<string, any>,
  token: string,
) {
  cookie[COOKIE_NAME].set({
    value: token,
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    maxAge: 60 * 60,
    path: '/',
  });
}

export function clearAuthCookie(cookie: Record<string, any>) {
  cookie[COOKIE_NAME]?.set({
    value: '',
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
  });
}

/**
 * Token ingress check, shared by legacy and platform-authenticated modes.
 * Browser navigations to doc pages redirect to login; API calls get 401.
 * Returns a response body to short-circuit, or `undefined` to continue.
 */
function tokenGate(
  path: string,
  token: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set: any,
): { error: string } | undefined {
  if (token) return;

  const normalized = path.startsWith('/api/') ? path.slice(4) : path;

  // Browser navigations to pages — redirect to login
  if (normalized.startsWith('/docs') || normalized.startsWith('/api-spec')) {
    const prefix = getPrefix(path);
    set.status = 302;
    set.headers = {
      Location: `${prefix}/auth/login?return_to=${encodeURIComponent(path)}`,
    };
    return;
  }

  // API calls — return 401
  set.status = 401;
  return { error: 'Unauthorized' };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAuthMiddleware(timbal: Timbal, options: TimbalAuthOptions = {}): any {
  const mode = resolveAuthMode(options);

  return new Elysia({ name: 'timbal-auth-middleware' })
    .derive({ as: 'global' }, async ({ cookie, request }) => {
      const cookieValue = cookie[COOKIE_NAME]?.value as string | undefined;

      // PLATFORM — resolve auth config first. Any failure (config unreachable,
      // missing orgId, etc.) leaves it null → legacy behavior for this request.
      let authConfig: ProjectAuthConfig | null = null;
      if (mode === 'platform') {
        try {
          authConfig = await resolveAuthConfig(timbal, options);
        } catch {
          authConfig = null;
        }
      }

      // OPEN project — no user login. Ignore stray Bearer/cookie tokens and
      // always run as the service identity (prevents accidental hybrid scoping).
      if (authConfig && !authConfig.enabled) {
        return {
          token: null,
          timbal,
          session: null,
          project: null,
          authConfig,
        };
      }

      // LEGACY, platform-fallback (authConfig null), or AUTHENTICATED platform:
      // resolve the user token. In platform-authenticated mode the platform
      // config is authoritative, so we must validate even without
      // TIMBAL_PROJECT_ID — bypass the legacy isLocalDev() short-circuit.
      const enforce = mode === 'platform' && !!authConfig && authConfig.enabled;
      const auth = await resolveTokenFromRequest(timbal, request, cookieValue, {
        skipLocalDevBypass: enforce,
      });
      const scopedTimbal = auth ? timbal.as(auth.token) : timbal;
      return {
        token: auth?.token ?? null,
        timbal: scopedTimbal,
        session: auth?.session ?? null,
        project: auth?.project ?? null,
        authConfig,
      };
    })
    .onBeforeHandle({ as: 'global' }, (ctx) => {
      const { path, token, set, authConfig } = ctx as unknown as {
        path: string;
        token: string | null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        set: any;
        authConfig: ProjectAuthConfig | null;
      };

      // LEGACY (or platform fallback when config is unavailable): exact
      // historical behavior, including the isLocalDev() bypass.
      if (mode !== 'platform' || authConfig === null) {
        if (isLocalDev()) return;
        if (isPublicPath(path, options.publicPaths)) return;
        return tokenGate(path, token, set);
      }

      // PLATFORM. No isLocalDev() bypass — the platform config is authoritative.
      if (isPublicPath(path, options.publicPaths)) return;

      // OPEN: no ingress gate.
      if (!authConfig.enabled) return;

      // AUTHENTICATED: require a user token.
      return tokenGate(path, token, set);
    });
}
