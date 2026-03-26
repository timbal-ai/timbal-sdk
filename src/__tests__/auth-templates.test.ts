import { describe, test, expect } from 'bun:test';
import { renderLoginPage } from '../auth/templates/login';
import { renderCallbackPage } from '../auth/templates/callback';

// ── renderLoginPage ──

describe('renderLoginPage', () => {
  test('returns valid HTML', () => {
    const html = renderLoginPage('');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('</html>');
  });

  test('interpolates empty prefix in JS baseUrl', () => {
    const html = renderLoginPage('');
    expect(html).toContain('window.location.origin + ""');
  });

  test('interpolates /api prefix in JS baseUrl', () => {
    const html = renderLoginPage('/api');
    expect(html).toContain('window.location.origin + "/api"');
  });

  test('contains OAuth provider buttons', () => {
    const html = renderLoginPage('');
    expect(html).toContain('Google');
    expect(html).toContain('Microsoft');
    expect(html).toContain('GitHub');
  });

  test('contains magic link form', () => {
    const html = renderLoginPage('');
    expect(html).toContain('magic-link');
    expect(html).toContain('email');
  });

  test('does not contain unresolved template placeholders', () => {
    const html = renderLoginPage('');
    expect(html).not.toContain('{{PREFIX}}');
  });

  test('contains logo images from CDN', () => {
    const html = renderLoginPage('');
    expect(html).toContain('https://app.timbal.ai/logos/');
  });
});

// ── renderCallbackPage ──

describe('renderCallbackPage', () => {
  test('returns valid HTML', () => {
    const html = renderCallbackPage('', '/');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('</html>');
  });

  test('interpolates prefix for set-token endpoint', () => {
    const html = renderCallbackPage('/api', '/');
    expect(html).toContain('/api/auth/set-token');
  });

  test('interpolates afterLoginRedirect', () => {
    const html = renderCallbackPage('', '/dashboard');
    expect(html).toContain('/dashboard');
  });

  test('default redirect to / when no return_to saved', () => {
    const html = renderCallbackPage('', '/');
    expect(html).toContain('savedReturn || "/"');
  });

  test('does not contain unresolved template placeholders', () => {
    const html = renderCallbackPage('', '/');
    expect(html).not.toContain('{{PREFIX}}');
  });
});
