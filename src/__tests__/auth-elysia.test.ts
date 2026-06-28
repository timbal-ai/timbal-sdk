import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Elysia } from 'elysia';
import { timbalAuth } from '../elysia';

describe('timbalAuth Elysia plugin', () => {
  const originalProjectId = process.env.TIMBAL_PROJECT_ID;

  // ── Auth disabled (local dev) ──

  describe('local dev mode (no TIMBAL_PROJECT_ID)', () => {
    beforeEach(() => {
      delete process.env.TIMBAL_PROJECT_ID;
    });

    afterEach(() => {
      if (originalProjectId !== undefined) {
        process.env.TIMBAL_PROJECT_ID = originalProjectId;
      } else {
        delete process.env.TIMBAL_PROJECT_ID;
      }
    });

    test('GET /auth/login returns 200 with HTML', async () => {
      const app = new Elysia().use(timbalAuth());
      const res = await app.handle(new Request('http://localhost/auth/login'));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('Welcome to Timbal');
    });

    test('GET /auth/callback returns 200 with HTML', async () => {
      const app = new Elysia().use(timbalAuth());
      const res = await app.handle(new Request('http://localhost/auth/callback'));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Completing authentication');
    });

    test('POST /auth/callback returns 200 with HTML (magic-link 307 redirect)', async () => {
      const app = new Elysia().use(timbalAuth());
      const res = await app.handle(new Request('http://localhost/auth/callback', { method: 'POST' }));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Completing authentication');
    });

    test('GET /auth/invalid-provider returns 400', async () => {
      const app = new Elysia().use(timbalAuth());
      const res = await app.handle(new Request('http://localhost/auth/invalid'));
      expect(res.status).toBe(400);
    });

    test('protected routes are accessible without token in local dev', async () => {
      const app = new Elysia()
        .use(timbalAuth())
        .get('/test', () => 'ok');
      const res = await app.handle(new Request('http://localhost/test'));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    });
  });

  // ── Auth enabled ──

  describe('auth enabled (TIMBAL_PROJECT_ID set)', () => {
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

    test('auth routes are public (no 401)', async () => {
      const app = new Elysia().use(timbalAuth());
      const loginRes = await app.handle(new Request('http://localhost/auth/login'));
      expect(loginRes.status).toBe(200);

      const callbackRes = await app.handle(new Request('http://localhost/auth/callback'));
      expect(callbackRes.status).toBe(200);
    });

    test('protected routes return 401 without token', async () => {
      const app = new Elysia()
        .use(timbalAuth())
        .get('/test', () => 'ok');
      const res = await app.handle(new Request('http://localhost/test'));
      expect(res.status).toBe(401);
    });

    test('POST /auth/logout clears cookie and returns success', async () => {
      const app = new Elysia().use(timbalAuth());
      const res = await app.handle(
        new Request('http://localhost/auth/logout', { method: 'POST' }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });

    test('derive context contains session and project for authenticated request', async () => {
      const mockSession = {
        user_id: 1,
        user_name: 'Test User',
        user_email: 'test@example.com',
        user_photo_url: null,
        user_phone: null,
        user_lang: 'en',
        access_level: 'admin',
      };
      const mockProject = {
        id: '248',
        name: 'Test Project',
        description: null,
        has_ui: false,
        role: 'admin',
        default_role: null,
        is_public_template: false,
        template_uses: 0,
        publishable_api_key: 'pk_test',
        use_platform_iam: false,
        repository_url: null,
        screenshot_url: null,
        created_at: 0,
        updated_at: 0,
        workforce: [],
      };

      const originalFetch = global.fetch;
      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ session: mockSession, project: mockProject }),
        }),
      ) as unknown as typeof global.fetch;

      try {
        let capturedSession: unknown;
        let capturedProject: unknown;

        const app = new Elysia()
          .use(timbalAuth())
          .get('/protected', ({ session, project }) => {
            capturedSession = session;
            capturedProject = project;
            return 'ok';
          });

        const res = await app.handle(
          new Request('http://localhost/protected', {
            headers: { Authorization: 'Bearer test-token' },
          }),
        );

        expect(res.status).toBe(200);
        expect((capturedSession as any).user_email).toBe('test@example.com');
        expect((capturedSession as any).user_id).toBe('1');
        expect((capturedProject as any).id).toBe('248');
        expect((capturedProject as any).name).toBe('Test Project');
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('GET /auth/login redirects when already authenticated', async () => {
      const originalFetch = global.fetch;
      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              session: { user_id: '1', user_email: 'test@example.com' },
              project: { id: '248', name: 'Test' },
            }),
        }),
      ) as unknown as typeof global.fetch;

      try {
        const app = new Elysia().use(timbalAuth());
        const res = await app.handle(
          new Request('http://localhost/auth/login', {
            headers: { Authorization: 'Bearer test-token' },
          }),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/');
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('GET /auth/login redirects to return_to when authenticated', async () => {
      const originalFetch = global.fetch;
      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              session: { user_id: '1', user_email: 'test@example.com' },
              project: { id: '248', name: 'Test' },
            }),
        }),
      ) as unknown as typeof global.fetch;

      try {
        const app = new Elysia().use(timbalAuth());
        const res = await app.handle(
          new Request(
            'http://localhost/auth/login?return_to=%2Fdashboard',
            { headers: { Authorization: 'Bearer test-token' } },
          ),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/dashboard');
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('GET /auth/login redirects via cookie when Bearer is absent', async () => {
      const originalFetch = global.fetch;
      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              session: { user_id: '1', user_email: 'test@example.com' },
              project: { id: '248', name: 'Test' },
            }),
        }),
      ) as unknown as typeof global.fetch;

      try {
        const app = new Elysia().use(timbalAuth());
        const res = await app.handle(
          new Request('http://localhost/auth/login', {
            headers: {
              cookie: 'timbal_project_access_token=cookie-token',
            },
          }),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/');
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('GET /auth/login still returns HTML when not authenticated', async () => {
      const app = new Elysia().use(timbalAuth());
      const res = await app.handle(new Request('http://localhost/auth/login'));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Welcome to Timbal');
    });

    test('GET /auth/login ignores unsafe return_to and uses afterLoginRedirect', async () => {
      const originalFetch = global.fetch;
      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              session: { user_id: '1', user_email: 'test@example.com' },
              project: { id: '248', name: 'Test' },
            }),
        }),
      ) as unknown as typeof global.fetch;

      try {
        const app = new Elysia().use(
          timbalAuth({ afterLoginRedirect: '/app' }),
        );
        const res = await app.handle(
          new Request(
            'http://localhost/auth/login?return_to=%2F%2Fevil.com',
            { headers: { Authorization: 'Bearer test-token' } },
          ),
        );
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/app');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  // ── Login page options ──

  describe('loginPage options', () => {
    beforeEach(() => {
      delete process.env.TIMBAL_PROJECT_ID;
    });

    afterEach(() => {
      if (originalProjectId !== undefined) {
        process.env.TIMBAL_PROJECT_ID = originalProjectId;
      }
    });

    test('loginPage: false disables login and callback routes', async () => {
      const app = new Elysia().use(timbalAuth({ loginPage: false }));
      // /auth/login falls through to /:provider which returns 400 for "login"
      const loginRes = await app.handle(new Request('http://localhost/auth/login'));
      expect(loginRes.status).toBe(400);

      // /auth/callback falls through to /:provider which returns 400 for "callback"
      const callbackRes = await app.handle(new Request('http://localhost/auth/callback'));
      expect(callbackRes.status).toBe(400);
    });

    test('loginPage: false still mounts other auth routes', async () => {
      const app = new Elysia().use(timbalAuth({ loginPage: false }));
      const logoutRes = await app.handle(
        new Request('http://localhost/auth/logout', { method: 'POST' }),
      );
      expect(logoutRes.status).toBe(200);
    });
  });

  // ── Platform mode: GET /config ──

  describe('platform mode /config', () => {
    const originalOrgId = process.env.TIMBAL_ORG_ID;
    let originalFetch: typeof global.fetch;

    const rawProject = (overrides: Record<string, unknown> = {}) => ({
      id: '248',
      name: 'Test Project',
      description: null,
      has_ui: false,
      role: 'admin',
      default_role: null,
      is_public_template: false,
      template_uses: 0,
      publishable_api_key: 'pk_SECRET',
      use_platform_iam: false,
      repository_url: 'git@secret',
      screenshot_url: null,
      created_at: 0,
      updated_at: 0,
      workforce: [],
      ...overrides,
    });

    function mockProjectFetch(overrides: Record<string, unknown> = {}) {
      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(rawProject(overrides)),
        }),
      ) as unknown as typeof global.fetch;
    }

    beforeEach(() => {
      process.env.TIMBAL_PROJECT_ID = '248';
      process.env.TIMBAL_ORG_ID = '10';
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
      if (originalProjectId !== undefined) process.env.TIMBAL_PROJECT_ID = originalProjectId;
      else delete process.env.TIMBAL_PROJECT_ID;
      if (originalOrgId !== undefined) process.env.TIMBAL_ORG_ID = originalOrgId;
      else delete process.env.TIMBAL_ORG_ID;
    });

    test('GET /config is public (no token) and returns PublicAppConfig', async () => {
      mockProjectFetch({ use_platform_iam: true, auth_providers: ['google', 'email'] });
      const app = new Elysia().use(timbalAuth({ authMode: 'platform' }));
      const res = await app.handle(new Request('http://localhost/config'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        project: { id: '248', name: 'Test Project' },
        auth: { required: true, providers: ['google', 'email'] },
      });
    });

    test('open project: required=false', async () => {
      mockProjectFetch({ use_platform_iam: false, auth_providers: ['google'] });
      const app = new Elysia().use(timbalAuth({ authMode: 'platform' }));
      const res = await app.handle(new Request('http://localhost/config'));
      const body = await res.json();
      expect(body.auth.required).toBe(false);
      expect(body.auth.providers).toEqual(['google']);
    });

    test('/config never leaks secret project fields', async () => {
      mockProjectFetch({ use_platform_iam: true });
      const app = new Elysia().use(timbalAuth({ authMode: 'platform' }));
      const res = await app.handle(new Request('http://localhost/config'));
      const text = await res.text();
      expect(text).not.toContain('pk_SECRET');
      expect(text).not.toContain('git@secret');
      expect(text).not.toContain('publishable_api_key');
    });

    test('authConfig override is used without altering project id/name', async () => {
      mockProjectFetch({ use_platform_iam: true, auth_providers: ['github'] });
      const app = new Elysia().use(
        timbalAuth({
          authMode: 'platform',
          authConfig: { enabled: false, providers: ['email'] },
        }),
      );
      const res = await app.handle(new Request('http://localhost/config'));
      const body = await res.json();
      expect(body.auth).toEqual({ required: false, providers: ['email'] });
      expect(body.project.id).toBe('248');
    });

    test('custom configRoute path', async () => {
      mockProjectFetch({ use_platform_iam: true });
      const app = new Elysia().use(
        timbalAuth({ authMode: 'platform', configRoute: '/app-config' }),
      );
      const res = await app.handle(new Request('http://localhost/app-config'));
      expect(res.status).toBe(200);
    });

    test('configRoute: false does not mount /config', async () => {
      const app = new Elysia().use(
        timbalAuth({ authMode: 'platform', configRoute: false }),
      );
      // Route absent → 404 (the global gate only runs for matched routes, so an
      // unmounted path is 404 rather than a gated 401).
      const res = await app.handle(new Request('http://localhost/config'));
      expect(res.status).toBe(404);
    });

    test('legacy mode (default) does not mount /config', async () => {
      // local dev (no project id) so the gate is bypassed — a 404 proves the
      // route simply is not mounted, rather than being gated.
      delete process.env.TIMBAL_PROJECT_ID;
      const app = new Elysia().use(timbalAuth());
      const res = await app.handle(new Request('http://localhost/config'));
      expect(res.status).toBe(404);
    });
  });

  // ── Public paths ──

  describe('custom publicPaths', () => {
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

    test('custom public paths skip auth', async () => {
      const app = new Elysia()
        .use(timbalAuth({ publicPaths: ['/webhook'] }))
        .get('/webhook', () => 'ok');
      const res = await app.handle(new Request('http://localhost/webhook'));
      expect(res.status).toBe(200);
    });

    test('non-public paths still require auth', async () => {
      const app = new Elysia()
        .use(timbalAuth({ publicPaths: ['/webhook'] }))
        .get('/secret', () => 'ok');
      const res = await app.handle(new Request('http://localhost/secret'));
      expect(res.status).toBe(401);
    });
  });
});
