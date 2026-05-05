import type { Timbal } from '../lib/timbal';
import type { TimbalAuthOptions } from './types';
import type { Session, Project } from '../types';

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

export interface ResolvedAuth {
  token: string;
  session: Session;
  project: Project;
}

/**
 * Resolve an access token from a request.
 * Checks Bearer header first (API calls), falls back to cookie when Bearer is
 * missing or rejected (for browser sessions with a refreshed httpOnly cookie).
 * Validates the token via GET /me?project_id=... (single round trip, no orgId needed).
 * Returns the token, session, and project together so callers pay zero extra round trips.
 */
export async function resolveTokenFromRequest(
  timbal: Timbal,
  request: Request,
  cookieValue?: string | null,
): Promise<ResolvedAuth | null> {
  if (isLocalDev()) return null;

  const projectId = process.env.TIMBAL_PROJECT_ID as string;;
  const { method } = request;
  const path = new URL(request.url).pathname;

  // Bearer header takes priority (API calls, fetch requests)
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const { session, project } = await timbal.as(token).getSession({ projectId });
      return { token, session, project };
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
      const { session, project } = await timbal.as(cookieValue).getSession({ projectId });
      return { token: cookieValue, session, project };
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
