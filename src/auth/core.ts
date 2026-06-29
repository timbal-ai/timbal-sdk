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
  /** Null when validated without a project scope (no project id available). */
  project: Project | null;
}

export interface ResolveTokenOptions {
  /**
   * Skip the `isLocalDev()` (no `TIMBAL_PROJECT_ID`) early-return. The platform
   * gate sets this for authenticated projects: the platform config is
   * authoritative, so tokens MUST be validated even when `TIMBAL_PROJECT_ID`
   * isn't set (e.g. an `authConfig` override). The legacy gate leaves it off so
   * local dev keeps bypassing auth.
   */
  skipLocalDevBypass?: boolean;
}

/** Validate a single token, scoping to the project when one is available. */
async function validateToken(
  timbal: Timbal,
  token: string,
  projectId: string,
): Promise<ResolvedAuth> {
  if (projectId) {
    const { session, project } = await timbal.as(token).getSession({ projectId });
    return { token, session, project };
  }
  // No project scope (e.g. authConfig override without TIMBAL_PROJECT_ID):
  // validate the token's identity only. A throw here = invalid token.
  const session = await timbal.as(token).getSession();
  return { token, session, project: null };
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
  options?: ResolveTokenOptions,
): Promise<ResolvedAuth | null> {
  // Legacy local-dev bypass — overridden by platform-authenticated mode, where
  // the platform config (not env-var presence) decides that auth is required.
  if (!options?.skipLocalDevBypass && isLocalDev()) return null;

  const projectId = process.env.TIMBAL_PROJECT_ID || '';
  const { method } = request;
  const path = new URL(request.url).pathname;

  // Bearer header takes priority (API calls, fetch requests)
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      return await validateToken(timbal, token, projectId);
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
      return await validateToken(timbal, cookieValue, projectId);
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
