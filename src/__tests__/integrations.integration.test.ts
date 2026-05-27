import { describe, test, expect } from 'bun:test';
import { Timbal } from '../lib/timbal';
import {
  IntegrationConsentRequiredError,
  IntegrationNotFoundError,
} from '../lib/integrations/errors';
import { PersonalConnectionRef } from '../lib/integrations/personal-connection-ref';
import { SharedConnectionRef } from '../lib/integrations/shared-connection-ref';
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

  // ── shared connections ────────────────────────────────────────

  test.skipIf(SKIP)(
    'shared.list() returns rows with connection_mode=org and no user field',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const rows = await ctx.timbal.integrations.shared.list();
      console.log(`[integrations] shared.list() → ${rows.length} rows`);

      expect(Array.isArray(rows)).toBe(true);
      for (const r of rows) {
        expect(typeof r.id).toBe('string');
        expect(typeof r.integration_id).toBe('string');
        expect(r.connection_mode).toBe('org');
        expect(typeof r.integration_provider).toBe('string');
        expect(typeof r.integration_name).toBe('string');
        expect(typeof r.status).toBe('string');
        expect(['oauth', 'credentials']).toContain(r.auth_type as string);
        // No user field on org rows — strict structural check.
        expect((r as unknown as { user?: unknown }).user).toBeUndefined();
      }

      if (rows[0]) {
        const r = rows[0];
        console.log(
          `[integrations] shared sample: ${r.integration_provider} ` +
          `(${r.integration_name}) status=${r.status} label=${r.label ?? '<null>'} ` +
          `metadata.keys=[${Object.keys(r.metadata).join(',')}]`,
        );
      }
    },
    20_000,
  );

  test.skipIf(SKIP)(
    'shared.listPage() coerces numeric next_page_token to string',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const page = await ctx.timbal.integrations.shared.listPage();
      console.log(
        `[integrations] shared.listPage() → ${page.integrations.length} rows, ` +
        `next_page_token=${page.next_page_token}`,
      );

      if (page.next_page_token != null) {
        expect(typeof page.next_page_token).toBe('string');
      }
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'shared.iterate() yields the same count as listAll()',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const all = await ctx.timbal.integrations.shared.listAll();
      const iterated: typeof all = [];
      for await (const c of ctx.timbal.integrations.shared.iterate()) {
        iterated.push(c);
      }
      console.log(`[integrations] shared iterate=${iterated.length} listAll=${all.length}`);
      expect(iterated.length).toBe(all.length);
    },
    30_000,
  );

  test.skipIf(SKIP)(
    'shared.byProvider() returns the matching row or null',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const rows = await ctx.timbal.integrations.shared.list();
      if (rows.length === 0) {
        console.warn('[integrations] no shared rows — skipping byProvider check');
        return;
      }

      const target = rows[0]!.integration_provider;
      const hit = await ctx.timbal.integrations.shared.byProvider(target);
      console.log(`[integrations] shared.byProvider(${target}) → id=${hit?.id ?? '<null>'}`);
      expect(hit?.integration_provider).toBe(target);

      const miss = await ctx.timbal.integrations.shared.byProvider(
        '__sdk_test_nonexistent_provider_xyz__',
      );
      expect(miss).toBeNull();
    },
    30_000,
  );

  // ── personal connections ──────────────────────────────────────

  test.skipIf(SKIP)(
    'personal.list() returns rows with connection_mode=user and a user state',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const rows = await ctx.timbal.integrations.personal.list();
      console.log(`[integrations] personal.list() → ${rows.length} rows`);

      for (const r of rows) {
        expect(typeof r.id).toBe('string');
        expect(typeof r.integration_id).toBe('string');
        expect(r.connection_mode).toBe('user');
        expect(typeof r.integration_provider).toBe('string');
        expect(r.user).toBeDefined();
        expect(typeof r.user.connected).toBe('boolean');
        if (r.user.connected) {
          expect(typeof r.user.status).toBe('string');
          expect(r.user.metadata).toBeDefined();
        }
      }

      const connected = rows.filter(r => r.user.connected);
      const disconnected = rows.filter(r => !r.user.connected);
      console.log(`[integrations] personal: ${connected.length} connected, ${disconnected.length} not`);

      if (connected[0]) {
        const u = connected[0].user;
        if (u.connected) {
          console.log(
            `[integrations] personal connected sample: ${connected[0].integration_provider} ` +
            `account=${u.metadata.account_email ?? u.metadata.account_name ?? '<unknown>'} ` +
            `expires=${u.expires_at ?? '<null>'}`,
          );
        }
      }
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'personal.byProvider() returns the matching row or null',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const rows = await ctx.timbal.integrations.personal.list();
      if (rows.length === 0) {
        console.warn('[integrations] no personal rows — skipping byProvider check');
        return;
      }

      const target = rows[0]!.integration_provider;
      const hit = await ctx.timbal.integrations.personal.byProvider(target);
      console.log(
        `[integrations] personal.byProvider(${target}) → id=${hit?.id ?? '<null>'} ` +
        `connected=${hit?.user.connected ?? '<n/a>'}`,
      );
      expect(hit?.integration_provider).toBe(target);

      const miss = await ctx.timbal.integrations.personal.byProvider(
        '__sdk_test_nonexistent_provider_xyz__',
      );
      expect(miss).toBeNull();
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'personal.iterate() yields the same count as listAll()',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const all = await ctx.timbal.integrations.personal.listAll();
      const iterated: typeof all = [];
      for await (const c of ctx.timbal.integrations.personal.iterate()) {
        iterated.push(c);
      }
      console.log(`[integrations] personal iterate=${iterated.length} listAll=${all.length}`);
      expect(iterated.length).toBe(all.length);
    },
    15_000,
  );
});

// ── Personal vend + consent ───────────────────────────────────
//
// Notes:
//   - These are read-mostly: vend is a GET, consent only generates a URL
//     (doesn't actually authenticate anyone). Safe against shared dev orgs.
//   - We use `http://localhost:3000/sdk-test-callback` as the redirect_uri
//     because localhost is on the platform allowlist by spec.
//   - The "connected" branch runs only if some personal row in the org is
//     already connected (otherwise we'd need real OAuth — not happening in
//     CI). Disconnected rows always exist in a dev org with personal
//     integrations enabled.
//
const DEV_REDIRECT_URI = 'http://localhost:3000/sdk-test-callback';

describe('Integration Tests — integrations.personal vend + consent', () => {
  test.skipIf(SKIP)(
    'personal.get(id) returns a synchronous PersonalConnectionRef bound to the shared client',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const ref = ctx.timbal.integrations.personal.get('999999');
      expect(ref).toBeInstanceOf(PersonalConnectionRef);
      expect(ref.integrationId).toBe('999999');
      expect(ref.apiClient).toBe(ctx.timbal.apiClient);
    },
  );

  test.skipIf(SKIP)(
    'personal.get(id).token() throws IntegrationConsentRequiredError for a disconnected row, with the right consentUrl',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const rows = await ctx.timbal.integrations.personal.list();
      const disconnected = rows.find(r => !r.user.connected);
      if (!disconnected) {
        console.warn('[integrations] no disconnected personal rows — skipping vend-401 check');
        return;
      }

      const ref = ctx.timbal.integrations.personal.get(disconnected.id);

      let caught: unknown;
      try {
        await ref.token();
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(IntegrationConsentRequiredError);
      expect(caught).toBeInstanceOf(TimbalApiError);
      const err = caught as IntegrationConsentRequiredError;
      expect(err.statusCode).toBe(401);
      expect(err.integrationId).toBe(disconnected.id);
      expect(err.consentUrl).toContain(`/integrations/${disconnected.id}/consent`);
      console.log(
        `[integrations] vend(${disconnected.integration_provider} id=${disconnected.id}) ` +
        `→ consent_required (consentUrl=${err.consentUrl})`,
      );
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'personal.get(id).consent({ redirect_uri }) returns a browser redirect_url',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const rows = await ctx.timbal.integrations.personal.list();
      // Pick any row — consent works regardless of connected state.
      const row = rows[0];
      if (!row) {
        console.warn('[integrations] no personal rows — skipping consent check');
        return;
      }

      const ref = ctx.timbal.integrations.personal.get(row.id);
      let result: Awaited<ReturnType<typeof ref.consent>> | null = null;
      try {
        result = await ref.consent({ redirect_uri: DEV_REDIRECT_URI });
      } catch (e) {
        // The dev API might not have localhost allowlisted — skip rather than fail.
        if (e instanceof TimbalApiError && e.statusCode === 400) {
          console.warn(
            `[integrations] consent rejected redirect_uri (400) — likely allowlist. ` +
            `Skipping. err=${e.message}`,
          );
          return;
        }
        throw e;
      }

      expect(result).not.toBeNull();
      expect(typeof result!.redirect_url).toBe('string');
      expect(result!.redirect_url.length).toBeGreaterThan(0);
      // Sanity: the browser URL is not the same as the API consent endpoint.
      expect(result!.redirect_url).not.toContain(`/integrations/${row.id}/consent`);
      console.log(
        `[integrations] consent(${row.integration_provider} id=${row.id}) ` +
        `→ redirect_url (${new URL(result!.redirect_url).host})`,
      );
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'personal.get(id).use({ redirect_uri }) returns tagged union (connected | redirect_url)',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const rows = await ctx.timbal.integrations.personal.list();
      const row = rows[0];
      if (!row) {
        console.warn('[integrations] no personal rows — skipping use check');
        return;
      }

      const ref = ctx.timbal.integrations.personal.get(row.id);
      let r: Awaited<ReturnType<typeof ref.use>>;
      try {
        r = await ref.use({ redirect_uri: DEV_REDIRECT_URI });
      } catch (e) {
        if (e instanceof TimbalApiError && e.statusCode === 400) {
          console.warn(`[integrations] use() rejected redirect_uri (400) — skipping. err=${e.message}`);
          return;
        }
        throw e;
      }

      if (r.connected) {
        expect(typeof r.token.type).toBe('string');
        expect(typeof r.token.token).toBe('string');
        console.log(`[integrations] use(${row.integration_provider}) → connected (type=${r.token.type})`);
      } else {
        expect(typeof r.redirect_url).toBe('string');
        expect(r.redirect_url.length).toBeGreaterThan(0);
        console.log(
          `[integrations] use(${row.integration_provider}) → not connected ` +
          `(redirect_url host=${new URL(r.redirect_url).host})`,
        );
      }
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'personal.get(id).revoke() is idempotent — succeeds on an already-disconnected row',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      // Pick a disconnected row — revoking it is a guaranteed no-op (per
      // spec: "works even if you were already disconnected").
      const rows = await ctx.timbal.integrations.personal.list();
      const disconnected = rows.find(r => !r.user.connected);
      if (!disconnected) {
        console.warn('[integrations] no disconnected personal rows — skipping revoke idempotency check');
        return;
      }

      const ref = ctx.timbal.integrations.personal.get(disconnected.id);
      await expect(ref.revoke()).resolves.toBeUndefined();

      // Confirm the row still vends consent_required afterwards — the
      // shell row stays, only the token (if any) is gone.
      let caught: unknown;
      try {
        await ref.token();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(IntegrationConsentRequiredError);
      console.log(
        `[integrations] revoke(${disconnected.integration_provider} id=${disconnected.id}) ` +
        `→ 204 (idempotent), still consent_required afterwards`,
      );
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'personal.get(sharedRowId).revoke() throws TimbalApiError (403 — wrong audience)',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const sharedRows = await ctx.timbal.integrations.shared.list();
      const sharedRow = sharedRows[0];
      if (!sharedRow) {
        console.warn('[integrations] no shared rows — skipping wrong-audience revoke check');
        return;
      }

      // Use the personal-mode revoke path against a shared-mode row id —
      // the backend should reject with 403 ("not a valid per-user OAuth
      // enablement row").
      const ref = ctx.timbal.integrations.personal.get(sharedRow.id);
      let caught: unknown;
      try {
        await ref.revoke();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(TimbalApiError);
      expect([400, 403, 404]).toContain((caught as TimbalApiError).statusCode);
      console.log(
        `[integrations] revoke(sharedRow id=${sharedRow.id}) → ` +
        `${(caught as TimbalApiError).statusCode} ${(caught as TimbalApiError).message}`,
      );
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'personal.connect(provider) returns same shape as use() for an existing row, null for unknown',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const miss = await ctx.timbal.integrations.personal.connect(
        '__sdk_test_nonexistent_provider_xyz__',
        { redirect_uri: DEV_REDIRECT_URI },
      );
      expect(miss).toBeNull();

      const rows = await ctx.timbal.integrations.personal.list();
      const row = rows[0];
      if (!row) {
        console.warn('[integrations] no personal rows — skipping connect(provider) check');
        return;
      }

      let r: Awaited<ReturnType<typeof ctx.timbal.integrations.personal.connect>>;
      try {
        r = await ctx.timbal.integrations.personal.connect(
          row.integration_provider,
          { redirect_uri: DEV_REDIRECT_URI },
        );
      } catch (e) {
        if (e instanceof TimbalApiError && e.statusCode === 400) {
          console.warn(`[integrations] connect() redirect_uri rejected (400) — skipping. err=${e.message}`);
          return;
        }
        throw e;
      }

      expect(r).not.toBeNull();
      if (r!.connected) {
        expect(typeof r!.token.token).toBe('string');
      } else {
        expect(typeof r!.redirect_url).toBe('string');
      }
      console.log(
        `[integrations] connect(${row.integration_provider}) → ${r!.connected ? 'connected' : 'not connected'}`,
      );
    },
    15_000,
  );
});

// ── Shared connect + vend ─────────────────────────────────────────────
//
// Notes:
//   - Vend is read-only: walks shared.list(), picks the first active row,
//     calls .token(), validates the discriminated union.
//   - connectOAuth() is safe to call — `/connect` for OAuth just generates
//     a URL; the row is only created on `/oauth/callback/integrations`.
//   - connectCredentials() is NOT tested live (it would mutate state and
//     there's no per-row disconnect endpoint to clean up). Unit-tested only.
//
describe('Integration Tests — integrations.shared connect + vend', () => {
  test.skipIf(SKIP)(
    'shared.get(id) returns a synchronous SharedConnectionRef',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const ref = ctx.timbal.integrations.shared.get('999999');
      expect(ref).toBeInstanceOf(SharedConnectionRef);
      expect(ref.integrationId).toBe('999999');
      expect(ref.apiClient).toBe(ctx.timbal.apiClient);
    },
  );

  test.skipIf(SKIP)(
    'shared.get(id).token() vends an active row and the result narrows on type',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const rows = await ctx.timbal.integrations.shared.list();
      const active = rows.find(r => r.status === 'active');
      if (!active) {
        console.warn('[integrations] no active shared rows — skipping shared vend check');
        return;
      }

      const ref = ctx.timbal.integrations.shared.get(active.id);
      let v: Awaited<ReturnType<typeof ref.token>>;
      try {
        v = await ref.token();
      } catch (e) {
        // Some active rows can have a refresh problem ("Integration is not
        // active" 400) — skip gracefully rather than fail the suite.
        if (e instanceof TimbalApiError && (e.statusCode === 400 || e.statusCode === 403)) {
          console.warn(
            `[integrations] shared vend(${active.integration_provider} id=${active.id}) ` +
            `failed with ${e.statusCode} — skipping. err=${e.message}`,
          );
          return;
        }
        throw e;
      }

      expect(typeof v.type).toBe('string');
      if (v.type === 'oauth') {
        expect(typeof v.token).toBe('string');
        expect(v.token.length).toBeGreaterThan(0);
        console.log(
          `[integrations] shared vend(${active.integration_provider} id=${active.id}) ` +
          `→ oauth (expires_at=${v.expires_at ?? '<null>'})`,
        );
      } else if (v.type === 'credentials') {
        // Credentials shape is provider-specific; just check at least one
        // non-`type` key exists.
        const extraKeys = Object.keys(v).filter(k => k !== 'type');
        expect(extraKeys.length).toBeGreaterThan(0);
        console.log(
          `[integrations] shared vend(${active.integration_provider} id=${active.id}) ` +
          `→ credentials (keys=${extraKeys.join(',')})`,
        );
      } else {
        throw new Error(`unexpected vend type: ${(v as { type: string }).type}`);
      }
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'shared.get(unknownId).token() throws TimbalApiError (404)',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      const ref = ctx.timbal.integrations.shared.get('999999999');
      let caught: unknown;
      try {
        await ref.token();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(TimbalApiError);
      expect([400, 403, 404]).toContain((caught as TimbalApiError).statusCode);
      console.log(
        `[integrations] shared vend(999999999) → ${(caught as TimbalApiError).statusCode} ` +
        `${(caught as TimbalApiError).message}`,
      );
    },
    15_000,
  );

  test.skipIf(SKIP)(
    'shared.connectOAuth(provider) returns { result: "oauth_redirect", redirect_url } (no row created until callback)',
    async () => {
      const ctx = ready();
      if (!ctx) return;

      // Pick any enabled OAuth provider from the catalog.
      const catalog = await ctx.timbal.integrations.catalog.list();
      const target = catalog.find(
        e => e.enabled && e.auth_methods.some(m => m.type === 'oauth'),
      );
      if (!target) {
        console.warn('[integrations] no enabled OAuth provider — skipping shared connectOAuth check');
        return;
      }

      let r: Awaited<ReturnType<typeof ctx.timbal.integrations.shared.connectOAuth>>;
      try {
        r = await ctx.timbal.integrations.shared.connectOAuth({
          provider: target.provider,
          label: '__sdk_test_label__',
          redirect_uri: 'http://localhost:3000/sdk-test-callback',
        });
      } catch (e) {
        if (e instanceof TimbalApiError && e.statusCode === 400) {
          console.warn(
            `[integrations] shared connectOAuth(${target.provider}) rejected (400) ` +
            `— likely allowlist or provider-specific params. Skipping. err=${e.message}`,
          );
          return;
        }
        throw e;
      }

      expect(r.result).toBe('oauth_redirect');
      expect(typeof r.redirect_url).toBe('string');
      expect(r.redirect_url.length).toBeGreaterThan(0);
      console.log(
        `[integrations] shared connectOAuth(${target.provider}) ` +
        `→ redirect_url host=${new URL(r.redirect_url).host}`,
      );
    },
    15_000,
  );
});
