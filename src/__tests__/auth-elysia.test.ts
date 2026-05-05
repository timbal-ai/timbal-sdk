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
      expect(html).toContain('Get started');
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
