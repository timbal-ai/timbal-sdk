import { Elysia } from 'elysia';
import type { Timbal } from '../lib/timbal';
import type { TimbalAuthOptions } from '../auth/types';
import {
  resolveTokenFromRequest,
  isPublicPath,
  isLocalDev,
} from '../auth/core';
import { getPrefix } from '../auth/helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAuthMiddleware(
  timbal: Timbal,
  options: TimbalAuthOptions = {},
): any {
  return new Elysia({ name: 'timbal-auth-middleware' })
    .derive({ as: 'global' }, async ({ request }) => {
      const token = await resolveTokenFromRequest(timbal, request);
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

        if (normalized.startsWith('/docs')) {
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
