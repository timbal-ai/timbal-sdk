import { createHash, timingSafeEqual } from 'node:crypto';
import type { Timbal } from '../lib/timbal';

/** Constant-time bearer comparison; hashing first equalizes lengths. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Does `request` carry `Authorization: Bearer <project service credential>`,
 * i.e. the same token the SDK's own `Timbal` client holds (TIMBAL_PROJECT_SECRET
 * on deployed projects)? Used by every `/__timbal/*` platform-facing route.
 */
export function hasServiceBearer(request: Request, timbal: Timbal): boolean {
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = timbal.apiClient.getConfig().token;
  return Boolean(expected && presented && tokenMatches(presented, expected));
}
