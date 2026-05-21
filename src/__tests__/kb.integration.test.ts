import { describe, test, expect } from 'bun:test';
import { Timbal } from '../lib/timbal';
import { KbFileAlreadyExistsError, KbFileNotFoundError } from '../lib/kb/errors';
import { TimbalApiError } from '../lib/api';

// ─────────────────────────────────────────────────────────────
// Integration Tests — knowledge bases (v0.8 surface)
//
// Required env vars:
//   TIMBAL_INTEGRATION_ORG_ID       org id that owns the KB          (e.g. "1")
//   TIMBAL_INTEGRATION_KB_ID        kb id to exercise                (e.g. "32")
//
// Optional env vars:
//   TIMBAL_INTEGRATION_BASE_URL     full API base URL                (default: resolved from
//                                                                     TIMBAL_BASE_URL /
//                                                                     ~/.timbal/config)
//   TIMBAL_INTEGRATION_TOKEN        bearer token                     (default: resolved from
//                                                                     TIMBAL_API_KEY /
//                                                                     ~/.timbal/credentials)
//   SKIP_INTEGRATION_TESTS=true     skip entirely (used by `bun run test`)
//
// Notes:
//   - These tests upload + delete files in your KB. They use unique filenames
//     (`int-test-${timestamp}-${random}.bin`) under the `int-test-tmp` directory,
//     with `parse: false` so the parse+embed pipeline is skipped. Each test
//     cleans up its own files; failures may leak a few harmless files.
//
// Run with:   bun run test:integration
//        or:  bun test src/__tests__/kb.integration.test.ts
// ─────────────────────────────────────────────────────────────

const SKIP = process.env.SKIP_INTEGRATION_TESTS === 'true';

const ORG_ID = process.env.TIMBAL_INTEGRATION_ORG_ID;
const KB_ID = process.env.TIMBAL_INTEGRATION_KB_ID;
const BASE_URL = process.env.TIMBAL_INTEGRATION_BASE_URL;
const TOKEN = process.env.TIMBAL_INTEGRATION_TOKEN;

const TEST_DIRECTORY = 'int-test-tmp';

function missingConfig(): string[] {
  const missing: string[] = [];
  if (!ORG_ID) missing.push('TIMBAL_INTEGRATION_ORG_ID');
  if (!KB_ID) missing.push('TIMBAL_INTEGRATION_KB_ID');
  return missing;
}

function makeTimbal(): Timbal {
  return new Timbal({
    baseUrl: BASE_URL ?? 'https://api.timbal.ai',
    ...(TOKEN && { token: TOKEN }),
    ...(ORG_ID && { orgId: ORG_ID }),
  });
}

function hasCreds(timbal: Timbal): boolean {
  return !!timbal.apiClient.getConfig().token;
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

function uniqueFilename(suffix = 'bin'): string {
  return `int-test-${Date.now()}-${Math.floor(Math.random() * 1e9)}.${suffix}`;
}

function ready(): { timbal: Timbal; kb: ReturnType<Timbal['kbs']['get']> } | null {
  if (!guardConfig()) return null;
  const timbal = makeTimbal();
  if (!hasCreds(timbal)) {
    console.warn(
      '[skip] no token resolved — set TIMBAL_INTEGRATION_TOKEN, ' +
      'TIMBAL_API_KEY, or configure ~/.timbal/credentials',
    );
    return null;
  }
  return { timbal, kb: timbal.kbs.get(KB_ID!) };
}

// ── Scenarios ────────────────────────────────────────────────

describe('Integration Tests — kb', () => {
  test.skipIf(SKIP)(
    'kbs.list() returns an array of KbInfo with the expected shape',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const kbs = await ctx.timbal.kbs.list();
      console.log(`[kb] kbs.list() → ${kbs.length} kbs (first: ${kbs[0]?.name ?? '<empty>'})`);

      expect(Array.isArray(kbs)).toBe(true);
      // Don't assert KB_ID is included — endpoint appears to return only a recent
      // page and the configured KB may be older. Just validate the shape.
      for (const k of kbs) {
        expect(typeof k.id).toBe('string');
        expect(typeof k.name).toBe('string');
      }
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'kbs.iterate() yields KbInfo rows with string ids',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      let count = 0;
      for await (const kb of ctx.timbal.kbs.iterate()) {
        expect(typeof kb.id).toBe('string');
        expect(typeof kb.name).toBe('string');
        count++;
        if (count >= 5) break;
      }
      console.log(`[kb] kbs.iterate() → sampled ${count} kb(s)`);
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'kb.query("SELECT 1") roundtrip',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const result = await ctx.kb.query('SELECT 1 AS n');
      console.log(`[kb] query → rows[0]=${JSON.stringify(result.rows[0])}`);

      expect(Array.isArray(result.rows)).toBe(true);
      expect(result.rows.length).toBe(1);
      // Postgres may return number or string depending on driver; accept either.
      expect(String((result.rows[0] as { n: unknown }).n)).toBe('1');
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'kb.schema() returns at least one table',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const tables = await ctx.kb.schema();
      console.log(`[kb] schema → ${tables.length} tables (first: ${tables[0]?.name ?? '<empty>'})`);

      expect(Array.isArray(tables)).toBe(true);
      // We don't assert >0 — a freshly created KB may legitimately have zero tables.
      for (const t of tables) {
        expect(typeof t.name).toBe('string');
        expect(Array.isArray(t.columns)).toBe(true);
        for (const c of t.columns) {
          expect(typeof c.name).toBe('string');
          expect(typeof c.data_type).toBe('string');
        }
      }
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'kb.schema({ format: "sql" }) returns DDL statement strings',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const statements = await ctx.kb.schema({ format: 'sql' });
      console.log(`[kb] schema(sql) → ${statements.length} statements`);
      if (statements[0]) console.log(`[kb] first: ${statements[0].slice(0, 120)}...`);

      expect(Array.isArray(statements)).toBe(true);
      expect(statements.length).toBeGreaterThan(0);
      for (const stmt of statements) {
        expect(typeof stmt).toBe('string');
        expect(stmt.length).toBeGreaterThan(0);
      }
      // At least one statement should look like DDL for this KB (has real tables).
      const hasDdl = statements.some(
        s => s.includes('CREATE TABLE') || s.includes('create table'),
      );
      expect(hasDdl).toBe(true);
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'kb.files.iterate() walks pages and yields coerced string ids',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      let count = 0;
      for await (const f of ctx.kb.files.iterate({ directory: TEST_DIRECTORY })) {
        expect(typeof f.id).toBe('string');
        expect(f.kb_id).toBeDefined();
        expect(typeof f.kb_id).toBe('string');
        count++;
        if (count >= 10) break;
      }
      console.log(`[kb] iterate(${TEST_DIRECTORY}) → sampled ${count} file(s)`);
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'kb.files: upload → get → list → delete lifecycle (parse: false)',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const name = uniqueFilename();
      const body = new TextEncoder().encode(`integration-test ${name}`);
      const metadata = { source: 'sdk-integration-test', uploaded_at: new Date().toISOString() };

      let uploadedId: string | number | null = null;
      try {
        const uploaded = await ctx.kb.files.upload(body, name, {
          directory: TEST_DIRECTORY,
          metadata,
          parse: false,
        });
        uploadedId = uploaded.id;
        console.log(`[kb] uploaded id=${uploaded.id} name=${uploaded.name} parse_state=${uploaded.parse_state}`);

        expect(uploaded.id).toBeDefined();
        expect(uploaded.name).toBe(name);
        expect(uploaded.kb_id).toBeDefined();
        expect(String(uploaded.kb_id)).toBe(String(KB_ID));
        expect(uploaded.content_length).toBe(body.byteLength);
        expect(uploaded.metadata).toMatchObject(metadata);

        const got = await ctx.kb.files.get(uploaded.id);
        expect(got.id).toBe(uploaded.id);
        expect(got.name).toBe(name);

        const page = await ctx.kb.files.list({ directory: TEST_DIRECTORY });
        expect(Array.isArray(page.files)).toBe(true);
        const listed = page.files.find(f => String(f.id) === String(uploaded.id));
        expect(listed).toBeTruthy();
      } finally {
        if (uploadedId !== null) {
          try {
            await ctx.kb.files.delete(uploadedId);
          } catch (e) {
            console.warn(`[kb] cleanup delete failed for ${uploadedId}: ${(e as Error).message}`);
          }
        }
      }
    },
    30_000,
  );

  test.skipIf(SKIP)(
    'kb.files.upload throws KbFileAlreadyExistsError on filename collision (409)',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const name = uniqueFilename();
      const body = new TextEncoder().encode('first');

      let firstId: string | number | null = null;
      try {
        const first = await ctx.kb.files.upload(body, name, {
          directory: TEST_DIRECTORY,
          parse: false,
        });
        firstId = first.id;

        let caught: unknown;
        try {
          await ctx.kb.files.upload(body, name, {
            directory: TEST_DIRECTORY,
            parse: false,
          });
        } catch (e) {
          caught = e;
        }

        if (caught) {
          console.log(`[kb] collision caught: ${(caught as Error).name} status=${(caught as TimbalApiError).statusCode}`);
        } else {
          console.warn('[kb] collision did NOT throw — backend may dedupe silently or allow duplicate filenames');
        }

        // If the backend returns 409 we expect the typed error. If it allows
        // duplicates (no error), we mark the test inconclusive instead of failing
        // — the assumption that 409 = filename collision is what we're verifying.
        expect(caught).toBeInstanceOf(KbFileAlreadyExistsError);
        expect(caught).toBeInstanceOf(TimbalApiError);
        const err = caught as KbFileAlreadyExistsError;
        expect(err.filename).toBe(name);
        expect(err.directory).toBe(TEST_DIRECTORY);
        expect(err.statusCode).toBe(409);
      } finally {
        if (firstId !== null) {
          try {
            await ctx.kb.files.delete(firstId);
          } catch (e) {
            console.warn(`[kb] cleanup delete failed for ${firstId}: ${(e as Error).message}`);
          }
        }
      }
    },
    30_000,
  );

  test.skipIf(SKIP)(
    'kb.files.get(missingId) throws KbFileNotFoundError (404)',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const fakeId = 999_999_999;
      let caught: unknown;
      try {
        await ctx.kb.files.get(fakeId);
      } catch (e) {
        caught = e;
      }

      console.log(`[kb] get(${fakeId}) caught: ${(caught as Error)?.name} status=${(caught as TimbalApiError)?.statusCode}`);

      expect(caught).toBeInstanceOf(KbFileNotFoundError);
      expect(caught).toBeInstanceOf(TimbalApiError);
      const err = caught as KbFileNotFoundError;
      expect(err.fileId).toBe(String(fakeId));
      expect(err.statusCode).toBe(404);
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'kb.files.delete(missingId) is idempotent — backend returns 204, resolves void',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const fakeId = 999_999_998;
      const result = await ctx.kb.files.delete(fakeId);

      console.log(`[kb] delete(${fakeId}) resolved (no throw) — backend is idempotent`);
      expect(result).toBeUndefined();
    },
    15_000,
  );
});
