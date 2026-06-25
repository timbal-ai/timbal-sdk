import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  getOrigin,
  getCallbackUrl,
  getPrefix,
  isSafeRedirectPath,
  resolvePostLoginRedirect,
} from '../auth/helpers';

// ── getPrefix ──

describe('getPrefix', () => {
  test('returns /api for paths starting with /api', () => {
    expect(getPrefix('/api/auth/login')).toBe('/api');
    expect(getPrefix('/api/workforce')).toBe('/api');
    expect(getPrefix('/api')).toBe('/api');
  });

  test('returns empty string for non-api paths', () => {
    expect(getPrefix('/auth/login')).toBe('');
    expect(getPrefix('/workforce')).toBe('');
    expect(getPrefix('/')).toBe('');
  });
});

// ── getOrigin ──

describe('getOrigin', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.TIMBAL_STUDIO = process.env.TIMBAL_STUDIO;
    savedEnv.TIMBAL_BASE_URL = process.env.TIMBAL_BASE_URL;
    savedEnv.TIMBAL_API_HOST = process.env.TIMBAL_API_HOST;
    delete process.env.TIMBAL_STUDIO;
    delete process.env.TIMBAL_BASE_URL;
    delete process.env.TIMBAL_API_HOST;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
  });

  test('uses request URL for localhost', () => {
    const request = new Request('http://localhost:3000/auth/login');
    expect(getOrigin(request)).toBe('http://localhost:3000');
  });

  test('uses x-forwarded-host when present', () => {
    const request = new Request('http://localhost:3000/auth/login', {
      headers: { 'x-forwarded-host': 'myapp.example.com' },
    });
    expect(getOrigin(request)).toBe('https://myapp.example.com');
  });

  test('uses x-forwarded-proto when present', () => {
    const request = new Request('http://localhost:3000/auth/login', {
      headers: {
        'x-forwarded-host': 'myapp.example.com',
        'x-forwarded-proto': 'https',
      },
    });
    expect(getOrigin(request)).toBe('https://myapp.example.com');
  });

  test('constructs studio domain for production', () => {
    process.env.TIMBAL_STUDIO = 'my-project';
    process.env.TIMBAL_API_HOST = 'api.timbal.ai';
    const request = new Request('http://localhost:3000/auth/login');
    expect(getOrigin(request)).toBe('https://my-project.projects.timbal.ai');
  });

  test('constructs studio domain for dev', () => {
    process.env.TIMBAL_STUDIO = 'my-project';
    process.env.TIMBAL_BASE_URL = 'https://api.dev.timbal.ai';
    const request = new Request('http://localhost:3000/auth/login');
    expect(getOrigin(request)).toBe('https://my-project.projects.dev.timbal.ai');
  });
});

// ── getCallbackUrl ──

describe('getCallbackUrl', () => {
  test('builds callback URL without prefix', () => {
    const request = new Request('http://localhost:3000/auth/google');
    const url = getCallbackUrl(request, '/auth/google');
    expect(url).toBe('http://localhost:3000/auth/callback');
  });

  test('builds callback URL with /api prefix', () => {
    const request = new Request('http://localhost:3000/api/auth/google');
    const url = getCallbackUrl(request, '/api/auth/google');
    expect(url).toBe('http://localhost:3000/api/auth/callback');
  });
});

// ── isSafeRedirectPath / resolvePostLoginRedirect ──

describe('isSafeRedirectPath', () => {
  test('allows same-origin relative paths', () => {
    expect(isSafeRedirectPath('/')).toBe(true);
    expect(isSafeRedirectPath('/dashboard')).toBe(true);
    expect(isSafeRedirectPath('/docs?tab=api')).toBe(true);
  });

  test('rejects open redirects', () => {
    expect(isSafeRedirectPath('//evil.com')).toBe(false);
    expect(isSafeRedirectPath('https://evil.com')).toBe(false);
    expect(isSafeRedirectPath('javascript:alert(1)')).toBe(false);
    expect(isSafeRedirectPath('dashboard')).toBe(false);
  });
});

describe('resolvePostLoginRedirect', () => {
  test('prefers validated return_to', () => {
    expect(resolvePostLoginRedirect('/app', '/')).toBe('/app');
  });

  test('falls back when return_to is unsafe', () => {
    expect(resolvePostLoginRedirect('//evil.com', '/home')).toBe('/home');
    expect(resolvePostLoginRedirect(null, 'home')).toBe('/home');
  });
});
