import { describe, test, expect } from 'bun:test';
import { Timbal } from '../lib/timbal';

// ─────────────────────────────────────────────────────────────
// Integration Tests — auth / session endpoint
//
// Required env vars:
//   TIMBAL_INTEGRATION_PROJECT_ID   project id the token must have access to   (e.g. "322")
//
// Optional env vars:
//   TIMBAL_INTEGRATION_BASE_URL     full API base URL                          (default: resolved from
//                                                                               TIMBAL_BASE_URL /
//                                                                               ~/.timbal/config)
//   TIMBAL_INTEGRATION_TOKEN        bearer token                               (default: resolved from
//                                                                               TIMBAL_API_KEY /
//                                                                               ~/.timbal/credentials)
//   SKIP_INTEGRATION_TESTS=true     skip entirely (used by `bun run test`)
//
// Run with:   bun run test:integration
//        or:  bun test src/__tests__/auth.integration.test.ts
// ─────────────────────────────────────────────────────────────

const SKIP = process.env.SKIP_INTEGRATION_TESTS === 'true';

const PROJECT_ID = process.env.TIMBAL_INTEGRATION_PROJECT_ID;
const BASE_URL = process.env.TIMBAL_INTEGRATION_BASE_URL;
const TOKEN = process.env.TIMBAL_INTEGRATION_TOKEN;

function missingConfig(): string[] {
  const missing: string[] = [];
  if (!PROJECT_ID) missing.push('TIMBAL_INTEGRATION_PROJECT_ID');
  return missing;
}

function makeTimbal(): Timbal {
  return new Timbal({
    baseUrl: BASE_URL ?? 'https://api.timbal.ai',
    ...(TOKEN && { token: TOKEN }),
  });
}

function hasCreds(timbal: Timbal): boolean {
  return !!timbal.getApiClient().getConfig().token;
}

function guardConfig(): boolean {
  const missing = missingConfig();
  if (missing.length > 0) {
    console.warn(
      `[skip] missing required env var(s): ${missing.join(', ')}. ` +
      `See the header comment in this file for the full list.`,
    );
    return false;
  }
  return true;
}

// ── Scenarios ────────────────────────────────────────────────

describe('Integration Tests — auth / session', () => {
  test.skipIf(SKIP)(
    'getSession() returns identity without project_id',
    async () => {
      if (!guardConfig()) return;
      const timbal = makeTimbal();
      if (!hasCreds(timbal)) {
        console.warn(
          '[skip] no token resolved — set TIMBAL_INTEGRATION_TOKEN, ' +
          'TIMBAL_API_KEY, or configure ~/.timbal/credentials',
        );
        return;
      }

      const session = await timbal.getSession();

      console.log(`[auth] session.user_email=${session.user_email}`);
      expect(typeof session.user_id).toBe('string');
      expect(session.user_id.length).toBeGreaterThan(0);
      expect(typeof session.user_email).toBe('string');
      expect(session.user_email).toContain('@');
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'getSession({ projectId }) returns session + project in one call',
    async () => {
      if (!guardConfig()) return;
      const timbal = makeTimbal();
      if (!hasCreds(timbal)) {
        console.warn(
          '[skip] no token resolved — set TIMBAL_INTEGRATION_TOKEN, ' +
          'TIMBAL_API_KEY, or configure ~/.timbal/credentials',
        );
        return;
      }

      const { session, project } = await timbal.getSession({ projectId: PROJECT_ID! });

      console.log(`[auth] session.user_email=${session.user_email} project.id=${project.id}`);
      expect(typeof session.user_id).toBe('string');
      expect(session.user_id.length).toBeGreaterThan(0);
      expect(typeof session.user_email).toBe('string');
      expect(String(project.id)).toBe(String(PROJECT_ID));
      expect(typeof project.name).toBe('string');
      expect(Array.isArray(project.workforce)).toBe(true);
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'getSession() with an invalid token throws a 401',
    async () => {
      if (!guardConfig()) return;
      const timbal = makeTimbal();

      await expect(
        timbal.as('invalid-token-xyz').getSession(),
      ).rejects.toThrow();
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'getSession({ projectId }) with a nonexistent project throws a 403',
    async () => {
      if (!guardConfig()) return;
      const timbal = makeTimbal();
      if (!hasCreds(timbal)) {
        console.warn(
          '[skip] no token resolved — set TIMBAL_INTEGRATION_TOKEN, ' +
          'TIMBAL_API_KEY, or configure ~/.timbal/credentials',
        );
        return;
      }

      // Project id 0 should not exist (or not be accessible) — expect 403.
      await expect(
        timbal.getSession({ projectId: 0 }),
      ).rejects.toThrow();
    },
    15_000,
  );
});
