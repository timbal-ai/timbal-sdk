import { Elysia } from 'elysia';
import type { Timbal } from '../lib/timbal';
import type { TimbalAuthOptions } from '../auth/types';
import {
  resolveTokenFromRequest,
  isPublicPath,
  isLocalDev,
} from '../auth/core';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAuthMiddleware(
  timbal: Timbal,
  options: TimbalAuthOptions = {},
): any {
  return new Elysia({ name: 'timbal-auth-middleware' })
    .derive({ as: 'global' }, async ({ cookie, request }) => {
      const cookieValue = cookie[COOKIE_NAME]?.value as string | undefined;
      const token = await resolveTokenFromRequest(timbal, request, cookieValue);
      const scopedTimbal = token ? timbal.as(token) : timbal;
      return { token, timbal: scopedTimbal };
    })
    .onBeforeHandle({ as: 'global' }, ({ path, token, set }) => {
      if (isLocalDev()) return;

      if (isPublicPath(path, options.publicPaths)) return;

      if (!token) {
        const normalized = path.startsWith('/api/')
          ? path.slice(4)
          : path;

        // Browser navigations to pages — redirect to login
        if (normalized.startsWith('/docs') || normalized.startsWith('/api-spec')) {
          const prefix = getPrefix(path);
          set.status = 302;
          set.headers = { Location: `${prefix}/auth/login?return_to=${encodeURIComponent(path)}` };
          return;
        }

        // API calls — return 401
        set.status = 401;
        return { error: 'Unauthorized' };
      }
    });
}
