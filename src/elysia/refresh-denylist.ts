import { createHash } from 'node:crypto';

/**
 * In-process denylist of refresh tokens the monolith has already rejected.
 *
 * Keys are SHA-256 hex digests. The raw token is never stored. Values are
 * the OAuth error code and a description that has had the token redacted.
 * Capped LRU so a client that keeps POSTing the same dead token (open tab,
 * iframe re-inject) does not hammer `/oauth/token`.
 *
 * Not shared across processes or restarts. One rejected call per process
 * still reaches the monolith; repeats do not.
 */
export const TERMINAL_REFRESH_HASH_LIMIT = 10_000;

export interface RejectedRefresh {
  error: string;
  description: string;
}

const rejected = new Map<string, RejectedRefresh>();

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function redact(text: string, token: string): string {
  if (token.length < 16 || !text.includes(token)) return text;
  return 'Token refresh failed';
}

function publicRejection(token: string, info: RejectedRefresh): RejectedRefresh {
  const error = redact(info.error, token);
  return {
    error: error === 'Token refresh failed' ? 'invalid_grant' : error,
    description: redact(info.description, token),
  };
}

export function getRejectedRefresh(token: string): RejectedRefresh | undefined {
  const hash = hashRefreshToken(token);
  const info = rejected.get(hash);
  if (!info) return undefined;
  // LRU: a token that is still being replayed is the last to evict.
  rejected.delete(hash);
  rejected.set(hash, info);
  return info;
}

export function rememberRejectedRefresh(token: string, info: RejectedRefresh): RejectedRefresh {
  const hash = hashRefreshToken(token);
  const existing = rejected.get(hash);
  if (existing) {
    rejected.delete(hash);
    rejected.set(hash, existing);
    return existing;
  }

  if (rejected.size >= TERMINAL_REFRESH_HASH_LIMIT) {
    const oldest = rejected.keys().next().value;
    if (oldest !== undefined) rejected.delete(oldest);
  }

  const stored = publicRejection(token, info);
  rejected.set(hash, stored);
  return stored;
}

/** Digests currently held. Tests use this to prove the raw token is not a key. */
export function rejectedRefreshKeys(): string[] {
  return [...rejected.keys()];
}

export function resetRejectedRefreshTokens(): void {
  rejected.clear();
}
