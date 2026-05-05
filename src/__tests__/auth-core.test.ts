import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  isLocalDev,
  isPublicPath,
  resolveTokenFromRequest,
} from '../auth/core';

// ── isLocalDev ──

describe('isLocalDev', () => {
  const originalEnv = process.env.TIMBAL_PROJECT_ID;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TIMBAL_PROJECT_ID = originalEnv;
    } else {
      delete process.env.TIMBAL_PROJECT_ID;
    }
  });

  test('returns true when TIMBAL_PROJECT_ID is not set', () => {
    delete process.env.TIMBAL_PROJECT_ID;
    expect(isLocalDev()).toBe(true);
  });

  test('returns false when TIMBAL_PROJECT_ID is set', () => {
    process.env.TIMBAL_PROJECT_ID = '248';
    expect(isLocalDev()).toBe(false);
  });

  test('returns true when TIMBAL_PROJECT_ID is empty string', () => {
    process.env.TIMBAL_PROJECT_ID = '';
    expect(isLocalDev()).toBe(true);
  });
});

// ── isPublicPath ──

describe('isPublicPath', () => {
  test('root path is public', () => {
    expect(isPublicPath('/')).toBe(true);
  });

  test('/api root is public', () => {
    expect(isPublicPath('/api')).toBe(true);
  });

  test('auth paths are public', () => {
    expect(isPublicPath('/auth/login')).toBe(true);
    expect(isPublicPath('/auth/callback')).toBe(true);
    expect(isPublicPath('/auth/google')).toBe(true);
  });

  test('auth paths with /api prefix are public', () => {
    expect(isPublicPath('/api/auth/login')).toBe(true);
    expect(isPublicPath('/api/auth/callback')).toBe(true);
  });

  test('healthcheck is public', () => {
    expect(isPublicPath('/healthcheck')).toBe(true);
    expect(isPublicPath('/api/healthcheck')).toBe(true);
  });

  test('protected paths are not public', () => {
    expect(isPublicPath('/me')).toBe(false);
    expect(isPublicPath('/workforce')).toBe(false);
    expect(isPublicPath('/api/me')).toBe(false);
    expect(isPublicPath('/api/workforce')).toBe(false);
  });

  test('custom public paths are respected', () => {
    expect(isPublicPath('/webhook', ['/webhook'])).toBe(true);
    expect(isPublicPath('/api/webhook', ['/webhook'])).toBe(true);
  });

  test('custom public paths do not override defaults', () => {
    expect(isPublicPath('/auth/login', ['/webhook'])).toBe(true);
    expect(isPublicPath('/healthcheck', ['/webhook'])).toBe(true);
  });
});

// ── resolveTokenFromRequest ──

describe('resolveTokenFromRequest', () => {
  const originalProjectId = process.env.TIMBAL_PROJECT_ID;

  beforeEach(() => {
    process.env.TIMBAL_PROJECT_ID = '248';
  });

  afterEach(() => {
    if (originalProjectId !== undefined) {
      process.env.TIMBAL_PROJECT_ID = originalProjectId;
    } else {
      delete process.env.TIMBAL_PROJECT_ID;
    }
  });

  test('returns null in local dev mode', async () => {
    delete process.env.TIMBAL_PROJECT_ID;
    const mockTimbal = {} as any;
    const request = new Request('http://localhost:3000/me');
    const result = await resolveTokenFromRequest(mockTimbal, request);
    expect(result).toBeNull();
  });

  test('returns token from Bearer header when valid', async () => {
    const mockSession = { user_id: '1', user_email: 'test@example.com' };
    const mockProject = { id: '248', name: 'Test' };
    const mockTimbal = {
      as: () => ({ getSession: async () => ({ session: mockSession, project: mockProject }) }),
    } as any;
    const request = new Request('http://localhost:3000/me', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    const result = await resolveTokenFromRequest(mockTimbal, request);
    expect(result).toEqual({ token: 'valid-token', session: mockSession, project: mockProject });
  });

  test('returns null when Bearer token is invalid', async () => {
    const mockTimbal = {
      as: () => ({ getSession: async () => { throw new Error('invalid'); } }),
    } as any;
    const request = new Request('http://localhost:3000/me', {
      headers: { Authorization: 'Bearer bad-token' },
    });
    const result = await resolveTokenFromRequest(mockTimbal, request);
    expect(result).toBeNull();
  });

  test('falls back to cookie when Bearer token is invalid', async () => {
    const mockSession = { user_id: '1', user_email: 'test@example.com' };
    const mockProject = { id: '248', name: 'Test' };
    const mockTimbal = {
      as: (token: string) => ({
        getSession: async () => {
          if (token === 'bad-token') throw new Error('invalid');
          return { session: mockSession, project: mockProject };
        },
      }),
    } as any;
    const request = new Request('http://localhost:3000/me', {
      headers: { Authorization: 'Bearer bad-token' },
    });
    const result = await resolveTokenFromRequest(
      mockTimbal,
      request,
      'valid-cookie-token',
    );
    expect(result).toEqual({ token: 'valid-cookie-token', session: mockSession, project: mockProject });
  });

  test('returns null when no token is available', async () => {
    const mockTimbal = {} as any;
    const request = new Request('http://localhost:3000/me');
    const result = await resolveTokenFromRequest(mockTimbal, request);
    expect(result).toBeNull();
  });
});
