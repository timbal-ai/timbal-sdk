import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  isLocalDev,
  isPublicPath,
  buildCookieOptions,
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

// ── buildCookieOptions ──

describe('buildCookieOptions', () => {
  test('returns sensible defaults', () => {
    const opts = buildCookieOptions();
    expect(opts.name).toBe('timbal_access_token');
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.maxAge).toBe(3600);
    expect(opts.path).toBe('/');
  });

  test('respects custom cookie name', () => {
    const opts = buildCookieOptions({ cookieName: 'my_token' });
    expect(opts.name).toBe('my_token');
  });

  test('respects custom max age', () => {
    const opts = buildCookieOptions({ cookieMaxAge: 7200 });
    expect(opts.maxAge).toBe(7200);
  });

  test('secure is false in non-production', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const opts = buildCookieOptions();
    expect(opts.secure).toBe(false);
    process.env.NODE_ENV = original;
  });

  test('secure is true in production', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const opts = buildCookieOptions();
    expect(opts.secure).toBe(true);
    process.env.NODE_ENV = original;
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
    const mockTimbal = {
      as: () => ({ getProject: async () => ({}) }),
    } as any;
    const request = new Request('http://localhost:3000/me', {
      headers: { Authorization: 'Bearer valid-token' },
    });
    const result = await resolveTokenFromRequest(mockTimbal, request);
    expect(result).toBe('valid-token');
  });

  test('returns null when Bearer token is invalid', async () => {
    const mockTimbal = {
      as: () => ({ getProject: async () => { throw new Error('invalid'); } }),
    } as any;
    const request = new Request('http://localhost:3000/me', {
      headers: { Authorization: 'Bearer bad-token' },
    });
    const result = await resolveTokenFromRequest(mockTimbal, request);
    expect(result).toBeNull();
  });

  test('falls back to cookie when no Bearer header', async () => {
    const mockTimbal = {
      as: () => ({ getProject: async () => ({}) }),
    } as any;
    const request = new Request('http://localhost:3000/me');
    const result = await resolveTokenFromRequest(mockTimbal, request, 'cookie-token');
    expect(result).toBe('cookie-token');
  });

  test('returns null when cookie token is invalid', async () => {
    const mockTimbal = {
      as: () => ({ getProject: async () => { throw new Error('invalid'); } }),
    } as any;
    const request = new Request('http://localhost:3000/me');
    const result = await resolveTokenFromRequest(mockTimbal, request, 'bad-cookie');
    expect(result).toBeNull();
  });

  test('returns null when no token source is available', async () => {
    const mockTimbal = {} as any;
    const request = new Request('http://localhost:3000/me');
    const result = await resolveTokenFromRequest(mockTimbal, request);
    expect(result).toBeNull();
  });

  test('Bearer header takes priority over cookie', async () => {
    const mockTimbal = {
      as: () => ({ getProject: async () => ({}) }),
    } as any;
    const request = new Request('http://localhost:3000/me', {
      headers: { Authorization: 'Bearer header-token' },
    });
    const result = await resolveTokenFromRequest(mockTimbal, request, 'cookie-token');
    expect(result).toBe('header-token');
  });
});
