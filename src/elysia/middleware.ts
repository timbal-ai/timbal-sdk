import { Elysia } from 'elysia';
import type { Timbal } from '../lib/timbal';
import type { TimbalAuthOptions } from '../auth/types';
import {
  resolveTokenFromRequest,
  buildCookieOptions,
  isPublicPath,
  isLocalDev,
} from '../auth/core';
import { getPrefix } from '../auth/helpers';

export function setAuthCookie(
  cookie: Record<string, any>,
  token: string,
  options: TimbalAuthOptions = {},
) {
  const opts = buildCookieOptions(options);
  cookie[opts.name].set({
    value: token,
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    maxAge: opts.maxAge,
    path: opts.path,
  });
}

export function clearAuthCookie(
  cookie: Record<string, any>,
  options: TimbalAuthOptions = {},
) {
  const opts = buildCookieOptions(options);
  cookie[opts.name]?.set({
    value: '',
    httpOnly: opts.httpOnly,
    secure: opts.secure,
    sameSite: opts.sameSite,
    path: opts.path,
    maxAge: 0,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAuthMiddleware(
  timbal: Timbal,
  options: TimbalAuthOptions = {},
): any {
  const cookieOpts = buildCookieOptions(options);

  return new Elysia({ name: 'timbal-auth-middleware' })
    .derive({ as: 'global' }, async ({ cookie, request }) => {
      const cookieValue = cookie[cookieOpts.name]?.value as string | undefined;
      const token = await resolveTokenFromRequest(timbal, request, cookieValue);
      const scopedTimbal = token ? timbal.as(token) : timbal;
      return { token, timbal: scopedTimbal };
    })
    .onBeforeHandle({ as: 'global' }, ({ path, token, cookie, set }) => {
      if (isLocalDev()) return;

      if (isPublicPath(path, options.publicPaths)) return;

      if (!token) {
        const normalized = path.startsWith('/api/')
          ? path.slice(4)
          : path;

        if (normalized.startsWith('/docs')) {
          clearAuthCookie(cookie, options);
          const prefix = getPrefix(path);
          set.status = 302;
          set.headers = { Location: `${prefix}/auth/login?return_to=${encodeURIComponent(path)}` };
          return;
        }

        set.status = 401;
        return { error: 'Unauthorized' };
      }
    });
}
