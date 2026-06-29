import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Elysia } from 'elysia';
import { timbalAuth } from '../elysia';
import { clearProjectAuthConfigCache } from '../auth/config';

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
        auth_enabled: false,
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
      auth_enabled: false,
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
      clearProjectAuthConfigCache();
    });

    afterEach(() => {
      global.fetch = originalFetch;
      clearProjectAuthConfigCache();
      if (originalProjectId !== undefined) process.env.TIMBAL_PROJECT_ID = originalProjectId;
      else delete process.env.TIMBAL_PROJECT_ID;
      if (originalOrgId !== undefined) process.env.TIMBAL_ORG_ID = originalOrgId;
      else delete process.env.TIMBAL_ORG_ID;
    });

    test('GET /config is public (no token) and returns PublicAppConfig', async () => {
      mockProjectFetch({ auth_enabled: true, auth_providers: ['google', 'email'] });
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
      mockProjectFetch({ auth_enabled: false, auth_providers: ['google'] });
      const app = new Elysia().use(timbalAuth({ authMode: 'platform' }));
      const res = await app.handle(new Request('http://localhost/config'));
      const body = await res.json();
      expect(body.auth.required).toBe(false);
      expect(body.auth.providers).toEqual(['google']);
    });

    test('/config never leaks secret project fields', async () => {
      mockProjectFetch({ auth_enabled: true });
      const app = new Elysia().use(timbalAuth({ authMode: 'platform' }));
      const res = await app.handle(new Request('http://localhost/config'));
      const text = await res.text();
      expect(text).not.toContain('pk_SECRET');
      expect(text).not.toContain('git@secret');
      expect(text).not.toContain('publishable_api_key');
    });

    test('authConfig override is used without altering project id/name', async () => {
      mockProjectFetch({ auth_enabled: true, auth_providers: ['github'] });
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

    test('authConfig override: /config serves it even when the platform is unreachable', async () => {
      // The gate runs on the override without the platform; /config must too —
      // an unreachable platform should not 503 a setup that overrides authConfig.
      global.fetch = mock(() =>
        Promise.reject(new Error('platform down')),
      ) as unknown as typeof global.fetch;

      const app = new Elysia().use(
        timbalAuth({
          authMode: 'platform',
          authConfig: { enabled: true, providers: ['email'] },
        }),
      );
      const res = await app.handle(new Request('http://localhost/config'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.auth).toEqual({ required: true, providers: ['email'] });
      // project id falls back to client config (TIMBAL_PROJECT_ID)
      expect(body.project.id).toBe('248');
    });

    test('custom configRoute path', async () => {
      mockProjectFetch({ auth_enabled: true });
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

    test('GET /config returns 503 (not 500) on cold-cache platform failure', async () => {
      // No prior cached value → nothing to fail-soft to. Must degrade like the
      // middleware (retryable 503), not throw an unhandled 500.
      global.fetch = mock(() =>
        Promise.reject(new Error('platform down')),
      ) as unknown as typeof global.fetch;

      const app = new Elysia().use(timbalAuth({ authMode: 'platform' }));
      const res = await app.handle(new Request('http://localhost/config'));
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe('config_unavailable');
      // never leak a fabricated auth payload
      expect(body.auth).toBeUndefined();
    });

    test('GET /config shares the gate cache (no divergence, no second fetch)', async () => {
      // The project flips open→authenticated between fetches. If /config did its
      // own fresh getProject() it would advertise required:true while the gate
      // (warmed as open) still let routes through — the exact divergence we fix.
      let projectFetches = 0;
      global.fetch = mock((input: unknown) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/me')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                session: { user_id: '1', user_email: 'u@x.com' },
                project: rawProject({ auth_enabled: true }),
              }),
          });
        }
        projectFetches += 1;
        return Promise.resolve({
          ok: true,
          status: 200,
          // first fetch open, any later fetch authenticated
          json: () =>
            Promise.resolve(rawProject({ auth_enabled: projectFetches > 1 })),
        });
      }) as unknown as typeof global.fetch;

      const app = new Elysia()
        .use(timbalAuth({ authMode: 'platform' }))
        .get('/api/x', () => 'ok');

      // Warm the cache via a protected route — open project → reachable.
      const gate = await app.handle(new Request('http://localhost/api/x'));
      expect(gate.status).toBe(200);

      // /config must reflect the SAME cached snapshot the gate used.
      const cfg = await app.handle(new Request('http://localhost/config'));
      const body = await cfg.json();
      expect(body.auth.required).toBe(false);
      expect(projectFetches).toBe(1); // /config reused the cache, no refetch
    });
  });

  // ── Platform mode: ingress gate (open vs authenticated) ──

  describe('platform mode gate', () => {
    const originalOrgId = process.env.TIMBAL_ORG_ID;
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      // Project id set — under legacy this would force auth on every route;
      // the whole point of platform mode is that the config decides instead.
      process.env.TIMBAL_PROJECT_ID = '248';
      process.env.TIMBAL_ORG_ID = '10';
      originalFetch = global.fetch;
      clearProjectAuthConfigCache();
    });

    afterEach(() => {
      global.fetch = originalFetch;
      clearProjectAuthConfigCache();
      if (originalProjectId !== undefined) process.env.TIMBAL_PROJECT_ID = originalProjectId;
      else delete process.env.TIMBAL_PROJECT_ID;
      if (originalOrgId !== undefined) process.env.TIMBAL_ORG_ID = originalOrgId;
      else delete process.env.TIMBAL_ORG_ID;
    });

    const openCfg = { enabled: false, providers: [] as const };
    const authCfg = { enabled: true, providers: ['google'] as const };

    test('open project: protected route is reachable without a token (the bug)', async () => {
      let capturedToken: unknown = 'unset';
      const app = new Elysia()
        .use(timbalAuth({ authMode: 'platform', authConfig: { ...openCfg } }))
        .get('/api/workforce', ({ token }) => {
          capturedToken = token;
          return 'ok';
        });
      const res = await app.handle(new Request('http://localhost/api/workforce'));
      expect(res.status).toBe(200);
      expect(capturedToken).toBeNull(); // service identity, no user token
    });

    test('open project: stray Bearer is ignored (no hybrid scoping)', async () => {
      let capturedToken: unknown = 'unset';
      // No fetch mock — open mode must NOT call getSession at all.
      const app = new Elysia()
        .use(timbalAuth({ authMode: 'platform', authConfig: { ...openCfg } }))
        .get('/api/workforce', ({ token }) => {
          capturedToken = token;
          return 'ok';
        });
      const res = await app.handle(
        new Request('http://localhost/api/workforce', {
          headers: { Authorization: 'Bearer some-token' },
        }),
      );
      expect(res.status).toBe(200);
      expect(capturedToken).toBeNull();
    });

    test('authenticated project: protected route 401 without token', async () => {
      const app = new Elysia()
        .use(timbalAuth({ authMode: 'platform', authConfig: { ...authCfg } }))
        .get('/api/workforce', () => 'ok');
      const res = await app.handle(new Request('http://localhost/api/workforce'));
      expect(res.status).toBe(401);
    });

    test('authenticated project: valid token → 200, user-scoped', async () => {
      global.fetch = mock(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              session: { user_id: '1', user_email: 'u@x.com' },
              project: { id: '248', name: 'T' },
            }),
        }),
      ) as unknown as typeof global.fetch;

      let capturedToken: unknown = 'unset';
      const app = new Elysia()
        .use(timbalAuth({ authMode: 'platform', authConfig: { ...authCfg } }))
        .get('/api/workforce', ({ token }) => {
          capturedToken = token;
          return 'ok';
        });
      const res = await app.handle(
        new Request('http://localhost/api/workforce', {
          headers: { Authorization: 'Bearer test-token' },
        }),
      );
      expect(res.status).toBe(200);
      expect(capturedToken).toBe('test-token');
    });

    test('config fetch failure falls back to legacy (401 when project id set)', async () => {
      // No authConfig override → real fetch path; reject it.
      global.fetch = mock(() =>
        Promise.reject(new Error('platform down')),
      ) as unknown as typeof global.fetch;

      const app = new Elysia()
        .use(timbalAuth({ authMode: 'platform' }))
        .get('/api/workforce', () => 'ok');
      const res = await app.handle(new Request('http://localhost/api/workforce'));
      expect(res.status).toBe(401); // legacy fallback: project id set, no token
    });

    test('publicPaths still bypass the gate in authenticated mode', async () => {
      const app = new Elysia()
        .use(
          timbalAuth({
            authMode: 'platform',
            authConfig: { ...authCfg },
            publicPaths: ['/webhook'],
          }),
        )
        .get('/webhook', () => 'ok');
      const res = await app.handle(new Request('http://localhost/webhook'));
      expect(res.status).toBe(200);
    });
  });

  // ── Step 7: route guards + login provider filtering ──

  describe('platform mode route guards', () => {
    const originalOrgId = process.env.TIMBAL_ORG_ID;

    beforeEach(() => {
      process.env.TIMBAL_PROJECT_ID = '248';
      process.env.TIMBAL_ORG_ID = '10';
      clearProjectAuthConfigCache();
    });

    afterEach(() => {
      clearProjectAuthConfigCache();
      if (originalProjectId !== undefined) process.env.TIMBAL_PROJECT_ID = originalProjectId;
      else delete process.env.TIMBAL_PROJECT_ID;
      if (originalOrgId !== undefined) process.env.TIMBAL_ORG_ID = originalOrgId;
      else delete process.env.TIMBAL_ORG_ID;
    });

    const authedGoogleOnly = { enabled: true, providers: ['google'] as const };
    const open = { enabled: false, providers: [] as const };

    test('GET /auth/:provider → 400 when provider disabled', async () => {
      const app = new Elysia().use(
        timbalAuth({ authMode: 'platform', authConfig: { ...authedGoogleOnly } }),
      );
      const res = await app.handle(
        new Request('http://localhost/auth/microsoft'),
      );
      expect(res.status).toBe(400);
    });

    test('GET /auth/:provider → redirect when provider enabled', async () => {
      const app = new Elysia().use(
        timbalAuth({ authMode: 'platform', authConfig: { ...authedGoogleOnly } }),
      );
      const res = await app.handle(new Request('http://localhost/auth/google'));
      expect(res.status).toBe(302);
    });

    test('GET /auth/:provider → 400 for every provider in open mode', async () => {
      const app = new Elysia().use(
        timbalAuth({ authMode: 'platform', authConfig: { ...open } }),
      );
      const res = await app.handle(new Request('http://localhost/auth/google'));
      expect(res.status).toBe(400);
    });

    test('POST /auth/magic-link → 400 when email disabled', async () => {
      const app = new Elysia().use(
        timbalAuth({ authMode: 'platform', authConfig: { ...authedGoogleOnly } }),
      );
      const res = await app.handle(
        new Request('http://localhost/auth/magic-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'u@x.com' }),
        }),
      );
      expect(res.status).toBe(400);
    });

    test('GET /auth/login → 404 in open mode', async () => {
      const app = new Elysia().use(
        timbalAuth({ authMode: 'platform', authConfig: { ...open } }),
      );
      const res = await app.handle(new Request('http://localhost/auth/login'));
      expect(res.status).toBe(404);
    });

    test('GET /auth/login → built-in page hides disabled providers', async () => {
      const app = new Elysia().use(
        timbalAuth({
          authMode: 'platform',
          authConfig: { enabled: true, providers: ['email', 'google'] },
        }),
      );
      const res = await app.handle(new Request('http://localhost/auth/login'));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('data-provider="google"');
      expect(html).not.toContain('data-provider="microsoft"');
      expect(html).not.toContain('data-provider="github"');
      // email enabled → magic-link form present
      expect(html).toContain('placeholder="name@company.com"');
    });

    test('legacy mode is unaffected: /auth/microsoft still redirects', async () => {
      const app = new Elysia().use(timbalAuth());
      const res = await app.handle(
        new Request('http://localhost/auth/microsoft'),
      );
      expect(res.status).toBe(302);
    });
  });

  // ── Step 8: full matrix, end-to-end through the real platform fetch ──
  //
  // The gate/guard suites above inject `authConfig` to isolate behavior. These
  // drive the actual `getProject()` round trip so the whole pipeline is proven:
  //   platform fetch → auth_enabled/auth_providers → derive → gate → handler
  // A URL-routing fetch mock distinguishes the project fetch from /me session
  // validation, letting us assert when getSession is (not) called.

  describe('platform mode end-to-end (real project fetch)', () => {
    const originalOrgId = process.env.TIMBAL_ORG_ID;
    let originalFetch: typeof global.fetch;
    let meCalls = 0;

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
      auth_enabled: false,
      repository_url: 'git@secret',
      screenshot_url: null,
      created_at: 0,
      updated_at: 0,
      workforce: [],
      ...overrides,
    });

    function mockFetch(projectOverrides: Record<string, unknown> = {}) {
      meCalls = 0;
      global.fetch = mock((input: unknown) => {
        const url =
          typeof input === 'string' ? input : (input as Request).url;
        // /me?project_id=... → token/session validation
        if (url.includes('/me')) {
          meCalls += 1;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                session: { user_id: '1', user_email: 'u@x.com' },
                project: rawProject(projectOverrides),
              }),
          });
        }
        // orgs/:org/projects/:id → project (auth config source)
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(rawProject(projectOverrides)),
        });
      }) as unknown as typeof global.fetch;
    }

    beforeEach(() => {
      process.env.TIMBAL_PROJECT_ID = '248';
      process.env.TIMBAL_ORG_ID = '10';
      originalFetch = global.fetch;
      clearProjectAuthConfigCache();
    });

    afterEach(() => {
      global.fetch = originalFetch;
      clearProjectAuthConfigCache();
      if (originalProjectId !== undefined) process.env.TIMBAL_PROJECT_ID = originalProjectId;
      else delete process.env.TIMBAL_PROJECT_ID;
      if (originalOrgId !== undefined) process.env.TIMBAL_ORG_ID = originalOrgId;
      else delete process.env.TIMBAL_ORG_ID;
    });

    test('auth_enabled:true, no token → 401', async () => {
      mockFetch({ auth_enabled: true, auth_providers: ['google'] });
      const app = new Elysia()
        .use(timbalAuth({ authMode: 'platform' }))
        .get('/api/workforce', () => 'ok');
      const res = await app.handle(new Request('http://localhost/api/workforce'));
      expect(res.status).toBe(401);
    });

    test('auth_enabled:true, valid token → 200, user-scoped', async () => {
      mockFetch({ auth_enabled: true, auth_providers: ['google'] });
      let capturedToken: unknown = 'unset';
      const app = new Elysia()
        .use(timbalAuth({ authMode: 'platform' }))
        .get('/api/workforce', ({ token }) => {
          capturedToken = token;
          return 'ok';
        });
      const res = await app.handle(
        new Request('http://localhost/api/workforce', {
          headers: { Authorization: 'Bearer test-token' },
        }),
      );
      expect(res.status).toBe(200);
      expect(capturedToken).toBe('test-token');
      expect(meCalls).toBeGreaterThan(0); // session was validated
    });

    test('auth_enabled:false, no token → 200, service identity', async () => {
      mockFetch({ auth_enabled: false });
      let capturedToken: unknown = 'unset';
      const app = new Elysia()
        .use(timbalAuth({ authMode: 'platform' }))
        .get('/api/workforce', ({ token }) => {
          capturedToken = token;
          return 'ok';
        });
      const res = await app.handle(new Request('http://localhost/api/workforce'));
      expect(res.status).toBe(200);
      expect(capturedToken).toBeNull();
    });

    test('open project ignores stray Bearer and never calls getSession', async () => {
      mockFetch({ auth_enabled: false });
      let capturedToken: unknown = 'unset';
      const app = new Elysia()
        .use(timbalAuth({ authMode: 'platform' }))
        .get('/api/workforce', ({ token }) => {
          capturedToken = token;
          return 'ok';
        });
      const res = await app.handle(
        new Request('http://localhost/api/workforce', {
          headers: { Authorization: 'Bearer leaked' },
        }),
      );
      expect(res.status).toBe(200);
      expect(capturedToken).toBeNull();
      expect(meCalls).toBe(0); // open mode short-circuits before session validation
    });

    test('open project: service handler is scoped to TIMBAL_PROJECT_SECRET', async () => {
      // The feature's point: in an open project the handler's `timbal` acts as
      // the project service identity (the secret), not an unauthenticated/blank
      // client.
      const savedSecret = process.env.TIMBAL_PROJECT_SECRET;
      process.env.TIMBAL_PROJECT_SECRET = 't3_proj_sk_service';
      mockFetch({ auth_enabled: false });
      let scopedToken: unknown = 'unset';
      try {
        const app = new Elysia()
          .use(timbalAuth({ authMode: 'platform' }))
          .get('/api/x', ({ timbal }) => {
            scopedToken = (
              timbal as unknown as {
                apiClient: { getConfig: () => { token: string } };
              }
            ).apiClient.getConfig().token;
            return 'ok';
          });
        const res = await app.handle(new Request('http://localhost/api/x'));
        expect(res.status).toBe(200);
        expect(scopedToken).toBe('t3_proj_sk_service');
      } finally {
        if (savedSecret !== undefined) process.env.TIMBAL_PROJECT_SECRET = savedSecret;
        else delete process.env.TIMBAL_PROJECT_SECRET;
      }
    });

    test('user token takes precedence over TIMBAL_PROJECT_SECRET', async () => {
      // CRITICAL invariant: in an authenticated project the per-user token must
      // scope the request — the project service secret is only the fallback
      // identity (used here just to fetch the config), never for the user op.
      const savedSecret = process.env.TIMBAL_PROJECT_SECRET;
      process.env.TIMBAL_PROJECT_SECRET = 't3_proj_sk_service';
      let meAuth: string | null = null;
      let projectAuth: string | null = null;
      global.fetch = mock((input: unknown, init: unknown) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        const headers = (init as { headers?: Headers } | undefined)?.headers;
        const auth = headers?.get?.('authorization') ?? null;
        if (url.includes('/me')) {
          meAuth = auth;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                session: { user_id: '1', user_email: 'u@x.com' },
                project: rawProject({ auth_enabled: true }),
              }),
          });
        }
        projectAuth = auth;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(rawProject({ auth_enabled: true })),
        });
      }) as unknown as typeof global.fetch;

      try {
        const app = new Elysia()
          .use(timbalAuth({ authMode: 'platform' }))
          .get('/api/x', ({ token }) => token ?? 'none');
        const res = await app.handle(
          new Request('http://localhost/api/x', {
            headers: { Authorization: 'Bearer user-token' },
          }),
        );
        expect(res.status).toBe(200);
        // User op validated AS THE USER, not the service secret.
        expect(meAuth).toBe('Bearer user-token');
        // Config fetch used the service secret (service identity), as expected.
        expect(projectAuth).toBe('Bearer t3_proj_sk_service');
      } finally {
        if (savedSecret !== undefined) process.env.TIMBAL_PROJECT_SECRET = savedSecret;
        else delete process.env.TIMBAL_PROJECT_SECRET;
      }
    });

    test('config TTL: project fetched once, reused across requests', async () => {
      mockFetch({ auth_enabled: false });
      const app = new Elysia()
        .use(timbalAuth({ authMode: 'platform' }))
        .get('/api/workforce', () => 'ok');
      await app.handle(new Request('http://localhost/api/workforce'));
      await app.handle(new Request('http://localhost/api/workforce'));
      const projectFetches = (global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
      expect(projectFetches).toBe(1); // second request served from the TTL cache
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
