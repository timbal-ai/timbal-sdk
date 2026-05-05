import type { Timbal } from '../lib/timbal';
import type { TimbalAuthOptions } from './types';

const DEFAULT_PUBLIC_PATHS = ['/auth/', '/healthcheck'];

/**
 * Check if the environment is local development (no TIMBAL_PROJECT_ID set).
 */
export function isLocalDev(): boolean {
  return !process.env.TIMBAL_PROJECT_ID;
}

/**
 * Check if a path should skip authentication.
 */
export function isPublicPath(
  path: string,
  extraPublicPaths?: string[],
): boolean {
  // Normalize: strip /api prefix for matching
  const normalized = path.startsWith('/api/')
    ? path.slice(4)
    : path === '/api'
      ? '/'
      : path;

  if (normalized === '/') return true;

  const allPaths = [...DEFAULT_PUBLIC_PATHS, ...(extraPublicPaths ?? [])];
  return allPaths.some((p) => normalized.startsWith(p));
}

/**
 * Resolve an access token from a request.
 * Checks Bearer header first (API calls), falls back to cookie when Bearer is
 * missing or rejected (for browser sessions with a refreshed httpOnly cookie).
 * Validates the token by calling timbal.as(token).getProject().
 */
export async function resolveTokenFromRequest(
  timbal: Timbal,
  request: Request,
  cookieValue?: string | null,
): Promise<string | null> {
  if (isLocalDev()) return null;

  const { method } = request;
  const path = new URL(request.url).pathname;

  // Bearer header takes priority (API calls, fetch requests)
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      await timbal.as(token).getProject();
      return token;
    } catch (err) {
      console.warn(
        `[auth] ${method} ${path} — bearer token rejected:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Fall back to cookie (browser navigations, or stale Bearer + fresh cookie).
  if (cookieValue) {
    try {
      await timbal.as(cookieValue).getProject();
      return cookieValue;
    } catch (err) {
      console.warn(
        `[auth] ${method} ${path} — cookie token rejected:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  console.warn(`[auth] ${method} ${path} — no token found`);
  return null;
}
