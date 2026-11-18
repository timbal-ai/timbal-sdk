import { describe, test, expect, beforeEach } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  TERMINAL_REFRESH_HASH_LIMIT,
  getRejectedRefresh,
  rememberRejectedRefresh,
  rejectedRefreshKeys,
  resetRejectedRefreshTokens,
} from '../elysia/refresh-denylist';

describe('rejected refresh denylist', () => {
  beforeEach(() => {
    resetRejectedRefreshTokens();
  });

  test('stores a sha256 digest, never the raw token', () => {
    const token = 'super-secret-refresh-token-value';
    rememberRejectedRefresh(token, {
      error: 'invalid_grant',
      description: `rejected ${token}`,
    });

    const keys = rejectedRefreshKeys();
    expect(keys).toEqual([createHash('sha256').update(token).digest('hex')]);
    expect(JSON.stringify(keys)).not.toContain(token);

    const stored = getRejectedRefresh(token);
    expect(stored).toEqual({
      error: 'invalid_grant',
      description: 'Token refresh failed',
    });
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  test('a second remember does not grow the list', () => {
    const token = 'super-secret-refresh-token-value';
    rememberRejectedRefresh(token, { error: 'invalid_grant', description: 'first' });
    rememberRejectedRefresh(token, { error: 'invalid_client', description: 'second' });
    expect(rejectedRefreshKeys()).toHaveLength(1);
    expect(getRejectedRefresh(token)?.description).toBe('first');
  });

  test('evicts the least recently used digest at the cap', () => {
    const tokenAt = (i: number) => `refresh-token-${i.toString().padStart(6, '0')}-padding`;

    for (let i = 0; i < TERMINAL_REFRESH_HASH_LIMIT; i++) {
      rememberRejectedRefresh(tokenAt(i), { error: 'invalid_grant', description: 'nope' });
    }
    expect(rejectedRefreshKeys()).toHaveLength(TERMINAL_REFRESH_HASH_LIMIT);

    // Touch the oldest so the next eviction drops the one after it.
    expect(getRejectedRefresh(tokenAt(0))?.error).toBe('invalid_grant');

    rememberRejectedRefresh(tokenAt(TERMINAL_REFRESH_HASH_LIMIT), {
      error: 'invalid_grant',
      description: 'nope',
    });

    expect(rejectedRefreshKeys()).toHaveLength(TERMINAL_REFRESH_HASH_LIMIT);
    expect(getRejectedRefresh(tokenAt(0))).toBeDefined();
    expect(getRejectedRefresh(tokenAt(1))).toBeUndefined();
    expect(getRejectedRefresh(tokenAt(TERMINAL_REFRESH_HASH_LIMIT))).toBeDefined();
    expect(JSON.stringify(rejectedRefreshKeys())).not.toContain('refresh-token-');
  });
});
