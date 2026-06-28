import { describe, test, expect } from 'bun:test';
import { Elysia } from 'elysia';
import { Timbal } from '../lib/timbal';
import { authConfigFromProject, toPublicAppConfig } from '../auth/config';
import { timbalAuth } from '../elysia';

// ─────────────────────────────────────────────────────────────
// Integration Tests — project auth modes (open vs authenticated)
//
// Proves the *real* platform contract behind the Elysia plugin's platform
// mode. Unit tests mock the project fetch, so they pass even if the backend
// renamed/omitted the field — these don't. The load-bearing assertion is
// `typeof project.auth_enabled === 'boolean'`: if the backend still ships
// `use_platform_iam` (or omits the flag), `auth_enabled` is `undefined` and
// every project silently reads as "open". This catches that immediately.
//
// Required env vars:
//   TIMBAL_INTEGRATION_ORG_ID       org id that owns the project   (e.g. "10")
//   TIMBAL_INTEGRATION_PROJECT_ID   project id to read             (e.g. "248")
//
// Optional env vars:
//   TIMBAL_INTEGRATION_BASE_URL     full API base URL  (default: api.dev.timbal.ai)
//   TIMBAL_INTEGRATION_TOKEN        bearer token       (default: ~/.timbal credentials)
//   SKIP_INTEGRATION_TESTS=true     skip entirely (used by `bun run test`)
//
// Run with: bun test src/__tests__/auth-modes.integration.test.ts
//      or:  bun run test:integration
// ─────────────────────────────────────────────────────────────

const SKIP = process.env.SKIP_INTEGRATION_TESTS === 'true';

const ORG_ID = process.env.TIMBAL_INTEGRATION_ORG_ID;
const PROJECT_ID = process.env.TIMBAL_INTEGRATION_PROJECT_ID;
const BASE_URL = process.env.TIMBAL_INTEGRATION_BASE_URL;
const TOKEN = process.env.TIMBAL_INTEGRATION_TOKEN;

const KNOWN_PROVIDERS = ['email', 'google', 'microsoft', 'github'];

function missingConfig(): string[] {
  const missing: string[] = [];
  if (!ORG_ID) missing.push('TIMBAL_INTEGRATION_ORG_ID');
  if (!PROJECT_ID) missing.push('TIMBAL_INTEGRATION_PROJECT_ID');
  return missing;
}

function makeTimbal(): Timbal {
  return new Timbal({
    baseUrl: BASE_URL ?? 'https://api.dev.timbal.ai',
    ...(TOKEN && { token: TOKEN }),
    ...(ORG_ID && { orgId: ORG_ID }),
    ...(PROJECT_ID && { projectId: PROJECT_ID }),
  });
}

function ready(): Timbal | null {
  const missing = missingConfig();
  if (missing.length > 0) {
    console.warn(`[skip] missing env var(s): ${missing.join(', ')}`);
    return null;
  }
  const t = makeTimbal();
  if (!t.apiClient.getConfig().token) {
    console.warn(
      '[skip] no token resolved — set TIMBAL_INTEGRATION_TOKEN, ' +
        'TIMBAL_API_KEY, or configure ~/.timbal/credentials',
    );
    return null;
  }
  return t;
}

describe.skipIf(SKIP)('Integration Tests — project auth modes', () => {
  test(
    'getProject() returns a boolean auth_enabled (the contract)',
    async () => {
      const t = ready();
      if (!t) return;

      const project = await t.getProject();
      console.log(
        `[auth-modes] project.id=${project.id} auth_enabled=${project.auth_enabled} ` +
          `auth_providers=${JSON.stringify(project.auth_providers)}`,
      );

      // Load-bearing: the platform must ship a boolean `auth_enabled`.
      expect(typeof project.auth_enabled).toBe('boolean');

      // The legacy `use_platform_iam` should eventually disappear from the
      // wire. A transitional dual-write is harmless (the SDK ignores it), so
      // warn rather than fail — flip to a hard assertion once it's dropped.
      if (
        (project as unknown as Record<string, unknown>).use_platform_iam !==
        undefined
      ) {
        console.warn(
          '[warn] backend still ships deprecated `use_platform_iam` — drop it ' +
            'once nothing reads it (the SDK already uses `auth_enabled`)',
        );
      }
    },
    15_000,
  );

  test(
    'auth_providers (when present) is a subset of the known set',
    async () => {
      const t = ready();
      if (!t) return;

      const project = await t.getProject();
      if (project.auth_providers === undefined) {
        console.warn(
          '[warn] auth_providers omitted — backend should always send it explicitly',
        );
        return;
      }
      expect(Array.isArray(project.auth_providers)).toBe(true);
      for (const p of project.auth_providers) {
        expect(KNOWN_PROVIDERS).toContain(p);
      }
    },
    15_000,
  );

  test(
    'authConfigFromProject() derives a coherent ProjectAuthConfig',
    async () => {
      const t = ready();
      if (!t) return;

      const project = await t.getProject();
      const cfg = authConfigFromProject(project);

      expect(typeof cfg.enabled).toBe('boolean');
      expect(cfg.enabled).toBe(project.auth_enabled);
      expect(Array.isArray(cfg.providers)).toBe(true);
      // Either the platform's explicit list, or the "all" default — never empty.
      expect(cfg.providers.length).toBeGreaterThan(0);
      for (const p of cfg.providers) expect(KNOWN_PROVIDERS).toContain(p);
    },
    15_000,
  );

  test(
    'toPublicAppConfig() is browser-safe (no secrets leak)',
    async () => {
      const t = ready();
      if (!t) return;

      const project = await t.getProject();
      const pub = toPublicAppConfig(project, authConfigFromProject(project));
      const json = JSON.stringify(pub);

      expect(pub.project.id).toBe(project.id);
      expect(pub.auth.required).toBe(project.auth_enabled);
      // Whitelist-built — these must never appear.
      expect(json).not.toContain('publishable_api_key');
      expect(json).not.toContain(project.publishable_api_key);
      if (project.repository_url) {
        expect(json).not.toContain(project.repository_url);
      }
    },
    15_000,
  );

  test(
    'GET /config end-to-end matches the real project',
    async () => {
      const t = ready();
      if (!t) return;

      const project = await t.getProject();

      // The plugin builds its own Timbal from env — point it at this project.
      const saved = {
        org: process.env.TIMBAL_ORG_ID,
        proj: process.env.TIMBAL_PROJECT_ID,
        key: process.env.TIMBAL_API_KEY,
      };
      process.env.TIMBAL_ORG_ID = ORG_ID;
      process.env.TIMBAL_PROJECT_ID = PROJECT_ID;
      if (TOKEN) process.env.TIMBAL_API_KEY = TOKEN;

      try {
        const app = new Elysia().use(timbalAuth({ authMode: 'platform' }));
        const res = await app.handle(new Request('http://localhost/config'));
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(String(body.project.id)).toBe(String(project.id));
        expect(body.auth.required).toBe(project.auth_enabled);
        expect(Array.isArray(body.auth.providers)).toBe(true);

        const text = JSON.stringify(body);
        expect(text).not.toContain('publishable_api_key');
        expect(text).not.toContain(project.publishable_api_key);
      } finally {
        if (saved.org !== undefined) process.env.TIMBAL_ORG_ID = saved.org;
        else delete process.env.TIMBAL_ORG_ID;
        if (saved.proj !== undefined) process.env.TIMBAL_PROJECT_ID = saved.proj;
        else delete process.env.TIMBAL_PROJECT_ID;
        if (saved.key !== undefined) process.env.TIMBAL_API_KEY = saved.key;
        else delete process.env.TIMBAL_API_KEY;
      }
    },
    20_000,
  );
});
