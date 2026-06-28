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

  test('contains platform branding assets', () => {
    const html = renderLoginPage('');
    expect(html).toContain('Welcome to Timbal');
    expect(html).toContain('https://app.timbal.ai/onboarding-welcome-mark.png');
  });

  // ── provider filtering (additive; default = all = today) ──

  test('default (no opts) renders all providers — unchanged behavior', () => {
    const html = renderLoginPage('');
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Continue with Microsoft');
    expect(html).toContain('Continue with GitHub');
    expect(html).toContain('magic-link-form');
    expect(html).toContain('class="divider"');
  });

  test('explicit all providers equals default', () => {
    expect(
      renderLoginPage('', {
        providers: ['email', 'google', 'microsoft', 'github'],
      }),
    ).toBe(renderLoginPage(''));
  });

  // Email form sentinel: the input placeholder appears only in the <form>
  // element markup, never in the bottom <script> (which still references
  // "magic-link-form" by id but is harmlessly guarded when the form is absent).
  const EMAIL_FORM_MARKER = 'placeholder="name@company.com"';

  test('single OAuth provider: only that button, no email form, no divider', () => {
    const html = renderLoginPage('', { providers: ['google'] });
    expect(html).toContain('Continue with Google');
    expect(html).not.toContain('Continue with Microsoft');
    expect(html).not.toContain('Continue with GitHub');
    expect(html).not.toContain(EMAIL_FORM_MARKER);
    expect(html).not.toContain('class="divider"');
    // OAuth stack wrapper stays (still has a button)
    expect(html).toContain('class="oauth-stack"');
  });

  test('email only: form kept, no OAuth buttons, no divider, no oauth-stack', () => {
    const html = renderLoginPage('', { providers: ['email'] });
    expect(html).toContain(EMAIL_FORM_MARKER);
    expect(html).not.toContain('Continue with Google');
    expect(html).not.toContain('Continue with Microsoft');
    expect(html).not.toContain('Continue with GitHub');
    expect(html).not.toContain('class="divider"');
    expect(html).not.toContain('class="oauth-stack"');
  });

  test('one OAuth + email: that button, email form, and divider between them', () => {
    const html = renderLoginPage('', { providers: ['google', 'email'] });
    expect(html).toContain('Continue with Google');
    expect(html).not.toContain('Continue with Microsoft');
    expect(html).toContain(EMAIL_FORM_MARKER);
    expect(html).toContain('class="divider"');
  });

  test('empty providers: no buttons, no form, no divider, no stack', () => {
    const html = renderLoginPage('', { providers: [] });
    expect(html).not.toContain('Continue with Google');
    expect(html).not.toContain('Continue with Microsoft');
    expect(html).not.toContain('Continue with GitHub');
    expect(html).not.toContain(EMAIL_FORM_MARKER);
    expect(html).not.toContain('class="divider"');
    expect(html).not.toContain('class="oauth-stack"');
    // still a valid document
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Welcome to Timbal');
  });

  test('filtering never leaves unresolved placeholders', () => {
    const html = renderLoginPage('/api', { providers: ['github'] });
    expect(html).not.toContain('{{PREFIX}}');
    expect(html).toContain('window.location.origin + "/api"');
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
