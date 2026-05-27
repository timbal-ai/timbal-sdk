import { describe, test, expect } from 'bun:test';
import { Timbal } from '../lib/timbal';
import { IntegrationNotFoundError } from '../lib/integrations/errors';
import { TimbalApiError } from '../lib/api';

// ─────────────────────────────────────────────────────────────
// Integration Tests — integrations catalog
//
// Required env vars:
//   TIMBAL_INTEGRATION_ORG_ID       org id to read the catalog for      (e.g. "1")
//
// Optional env vars:
//   TIMBAL_INTEGRATION_BASE_URL     full API base URL                   (default: resolved from
//                                                                        TIMBAL_BASE_URL /
//                                                                        ~/.timbal/config)
//   TIMBAL_INTEGRATION_TOKEN        bearer token                        (default: resolved from
//                                                                        TIMBAL_API_KEY /
//                                                                        ~/.timbal/credentials)
//   SKIP_INTEGRATION_TESTS=true     skip entirely (used by `bun run test`)
//
// Notes:
//   - Writes are kept minimal and self-healing. The disable round-trip picks
//     an already-enabled provider, disables it, asserts, then re-enables it
//     inside a `finally` block so a mid-test crash still restores org state.
//   - Idempotent enable (against an already-enabled provider) is the other
//     mutation — server returns 200 with `{ provider }` and the org is
//     unchanged.
//   - Do NOT run against a production org you care about. Prefer a dev org.
//
// Run with:   bun run test:integration
//        or:  bun test src/__tests__/integrations.integration.test.ts
// ─────────────────────────────────────────────────────────────

const SKIP = process.env.SKIP_INTEGRATION_TESTS === 'true';

const ORG_ID = process.env.TIMBAL_INTEGRATION_ORG_ID;
const BASE_URL = process.env.TIMBAL_INTEGRATION_BASE_URL;
const TOKEN = process.env.TIMBAL_INTEGRATION_TOKEN;

function missingConfig(): string[] {
  const missing: string[] = [];
  if (!ORG_ID) missing.push('TIMBAL_INTEGRATION_ORG_ID');
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

function ready(): { timbal: Timbal } | null {
  const missing = missingConfig();
  if (missing.length > 0) {
    console.warn(
      `[skip] missing required env var(s): ${missing.join(', ')}. ` +
      `See the header comment in this file for the full list.`,
    );
    return null;
  }
  const timbal = makeTimbal();
  if (!hasCreds(timbal)) {
    console.warn(
      '[skip] no token resolved — set TIMBAL_INTEGRATION_TOKEN, ' +
      'TIMBAL_API_KEY, or configure ~/.timbal/credentials',
    );
    return null;
  }
  return { timbal };
}

// ── Scenarios ────────────────────────────────────────────────

describe('Integration Tests — integrations.catalog', () => {
  test.skipIf(SKIP)(
    'catalog.list() returns the org-scoped catalog with at least one entry',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const entries = await ctx.timbal.integrations.catalog.list();
      console.log(`[integrations] catalog.list() → ${entries.length} entries`);

      expect(Array.isArray(entries)).toBe(true);
      expect(entries.length).toBeGreaterThan(0);

      for (const e of entries) {
        expect(typeof e.id).toBe('string');
        expect(typeof e.name).toBe('string');
        expect(typeof e.provider).toBe('string');
        expect(typeof e.description).toBe('string');
        expect(typeof e.logo_url).toBe('string');
        expect(Array.isArray(e.auth_methods)).toBe(true);
        expect(Array.isArray(e.tags)).toBe(true);
        expect(typeof e.min_plan).toBe('string');
        expect(typeof e.visibility).toBe('string');
        expect(typeof e.enabled).toBe('boolean');
      }

      const sample = entries[0]!;
      console.log(
        `[integrations] sample: ${sample.provider} (${sample.name}) ` +
        `enabled=${sample.enabled} auth_methods=${sample.auth_methods.map(a => a.type).join(',')}`,
      );
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'catalog.iterate() yields the same entries as listAll()',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const all = await ctx.timbal.integrations.catalog.listAll();
      const iterated: typeof all = [];
      for await (const e of ctx.timbal.integrations.catalog.iterate()) {
        iterated.push(e);
      }

      console.log(`[integrations] iterate() → ${iterated.length}, listAll() → ${all.length}`);
      expect(iterated.length).toBe(all.length);
      expect(iterated.map(e => e.provider).sort()).toEqual(all.map(e => e.provider).sort());
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'catalog.list() includes recognized auth_method types (credentials and/or oauth)',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const entries = await ctx.timbal.integrations.catalog.list();
      const types = new Set<string>();
      for (const e of entries) for (const m of e.auth_methods) types.add(m.type);

      console.log(`[integrations] auth_method types seen: ${[...types].join(', ')}`);
      // We don't assert the exact set — the catalog evolves. But every type
      // should be a non-empty string, and at least one row should expose one.
      expect(types.size).toBeGreaterThan(0);
      for (const t of types) expect(typeof t).toBe('string');
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'catalog.isEnabled(provider) agrees with catalog.list() for an enabled row',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const entries = await ctx.timbal.integrations.catalog.list();
      const enabled = entries.find(e => e.enabled);
      if (!enabled) {
        console.warn('[integrations] no enabled provider in catalog — skipping isEnabled check');
        return;
      }

      const ok = await ctx.timbal.integrations.catalog.isEnabled(enabled.provider);
      console.log(`[integrations] isEnabled(${enabled.provider}) → ${ok}`);
      expect(ok).toBe(true);
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'catalog.isEnabled() returns false for an unknown provider',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const ok = await ctx.timbal.integrations.catalog.isEnabled(
        '__sdk_test_nonexistent_provider_xyz__',
      );
      console.log(`[integrations] isEnabled(unknown) → ${ok}`);
      expect(ok).toBe(false);
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'catalog.enable() is idempotent on an already-enabled provider — returns { provider }',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const entries = await ctx.timbal.integrations.catalog.list();
      const enabled = entries.find(e => e.enabled);
      if (!enabled) {
        console.warn('[integrations] no enabled provider — skipping idempotent enable check');
        return;
      }

      const result = await ctx.timbal.integrations.catalog.enable(enabled.provider);
      console.log(`[integrations] enable(${enabled.provider}) → ${JSON.stringify(result)}`);

      expect(result.provider).toBe(enabled.provider);
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'catalog.enable() throws IntegrationNotFoundError for an unknown provider (404)',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const fake = '__sdk_test_nonexistent_provider_xyz__';

      let caught: unknown;
      try {
        await ctx.timbal.integrations.catalog.enable(fake);
      } catch (e) {
        caught = e;
      }

      console.log(
        `[integrations] enable(${fake}) caught: ${(caught as Error)?.name} ` +
        `status=${(caught as TimbalApiError)?.statusCode} code=${(caught as TimbalApiError)?.code}`,
      );

      expect(caught).toBeInstanceOf(IntegrationNotFoundError);
      expect(caught).toBeInstanceOf(TimbalApiError);
      const err = caught as IntegrationNotFoundError;
      expect(err.provider).toBe(fake);
      expect(err.statusCode).toBe(404);
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'catalog.disable() round-trips against a real provider and re-enables in finally',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const entries = await ctx.timbal.integrations.catalog.list();
      const target = entries.find(e => e.enabled);
      if (!target) {
        console.warn('[integrations] no enabled provider — skipping disable round-trip');
        return;
      }

      let disableResult: { provider: string } | null = null;
      try {
        disableResult = await ctx.timbal.integrations.catalog.disable(target.provider);
        console.log(`[integrations] disable(${target.provider}) → ${JSON.stringify(disableResult)}`);

        expect(disableResult.provider).toBe(target.provider);

        // Cross-check via list — provider should now be enabled=false.
        const post = await ctx.timbal.integrations.catalog.list();
        const after = post.find(e => e.provider === target.provider);
        // Tolerant assertion: the entry may disappear from the list under
        // some visibility rules, or stay with enabled=false. Both prove the
        // disable took effect.
        if (after) {
          console.log(`[integrations] post-disable enabled=${after.enabled}`);
          expect(after.enabled).toBe(false);
        } else {
          console.log(`[integrations] post-disable: provider absent from catalog (visibility rule)`);
        }
      } finally {
        // Restore org state regardless of failure above.
        try {
          const restored = await ctx.timbal.integrations.catalog.enable(target.provider);
          console.log(`[integrations] re-enable(${target.provider}) → ${JSON.stringify(restored)}`);
        } catch (e) {
          console.error(
            `[integrations] FAILED to re-enable ${target.provider} — ` +
            `org state may be left disabled: ${(e as Error).message}`,
          );
          throw e;
        }
      }
    },
    30_000,
  );

  test.skipIf(SKIP)(
    'catalog.disable() throws IntegrationNotFoundError for an unknown provider (404)',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const fake = '__sdk_test_nonexistent_provider_xyz__';

      let caught: unknown;
      try {
        await ctx.timbal.integrations.catalog.disable(fake);
      } catch (e) {
        caught = e;
      }

      console.log(
        `[integrations] disable(${fake}) caught: ${(caught as Error)?.name} ` +
        `status=${(caught as TimbalApiError)?.statusCode} code=${(caught as TimbalApiError)?.code}`,
      );

      expect(caught).toBeInstanceOf(IntegrationNotFoundError);
      expect(caught).toBeInstanceOf(TimbalApiError);
      const err = caught as IntegrationNotFoundError;
      expect(err.provider).toBe(fake);
      expect(err.statusCode).toBe(404);
    },
    15_000,
  );
});
