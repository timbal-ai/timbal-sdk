import { describe, test, expect } from 'bun:test';
import { Timbal } from '../lib/timbal';

// ─────────────────────────────────────────────────────────────
// Integration Tests — files (temporary + deprecated org bucket)
//
// Required env vars:
//   TIMBAL_INTEGRATION_ORG_ID       org id (only used by deprecated tests)
//
// Optional env vars:
//   TIMBAL_INTEGRATION_BASE_URL     full API base URL (default api.timbal.ai)
//   TIMBAL_INTEGRATION_TOKEN        bearer token
//   SKIP_INTEGRATION_TESTS=true     skip entirely
//
// Run with:   bun test src/__tests__/file.integration.test.ts
// ─────────────────────────────────────────────────────────────

const SKIP = process.env.SKIP_INTEGRATION_TESTS === 'true';
const ORG_ID = process.env.TIMBAL_INTEGRATION_ORG_ID;
const BASE_URL = process.env.TIMBAL_INTEGRATION_BASE_URL;
const TOKEN = process.env.TIMBAL_INTEGRATION_TOKEN;

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

function unique(suffix = 'txt'): string {
  return `sdk-int-${Date.now()}-${Math.floor(Math.random() * 1e9)}.${suffix}`;
}

// ── Temp files ─────────────────────────────────────────────────────────────

describe.skipIf(SKIP)('integration: temp files (POST /files)', () => {
  test('uploadTempFile returns TempFile with url + expires_at, no id', async () => {
    const timbal = makeTimbal();
    if (!hasCreds(timbal)) {
      console.warn('[skip] no token resolved');
      return;
    }

    const name = unique('txt');
    const path = `/tmp/${name}`;
    await Bun.write(path, `temp ${name}`);

    const file = await timbal.uploadTempFile(path);

    expect(file.name).toBeDefined();
    expect(file.url).toMatch(/^https?:\/\//);
    expect(file.content_length).toBeGreaterThan(0);
    expect(typeof file.content_type).toBe('string');
    expect(file.created_at).toBeDefined();
    expect(file.expires_at).toBeDefined();
    // intentional shape contract: no id on temp files
    expect((file as any).id).toBeUndefined();
  });

  test('uploadTempFileFromBuffer round-trips bytes through the signed URL', async () => {
    const timbal = makeTimbal();
    if (!hasCreds(timbal)) return;

    const body = `hello ${Date.now()}`;
    const name = unique('txt');
    const data = new TextEncoder().encode(body);

    const file = await timbal.uploadTempFileFromBuffer(data, name, 'text/plain');

    expect(file.name).toBeDefined();
    expect(file.content_length).toBe(data.byteLength);
    expect(file.content_type.startsWith('text/plain')).toBe(true);

    const res = await fetch(file.url);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe(body);
  });

  test('does not require orgId in client config', async () => {
    const t = new Timbal({
      baseUrl: BASE_URL ?? 'https://api.timbal.ai',
      ...(TOKEN && { token: TOKEN }),
    });
    if (!hasCreds(t)) return;

    const file = await t.uploadTempFileFromBuffer(
      new TextEncoder().encode('no org'),
      unique('txt'),
      'text/plain',
    );
    expect(file.url).toMatch(/^https?:\/\//);
  });
});

// ── Deprecated org-bucket ──────────────────────────────────────────────────

describe.skipIf(SKIP)('integration: org-bucket files (deprecated)', () => {
  test('uploadFile coerces id to string', async () => {
    const timbal = makeTimbal();
    if (!hasCreds(timbal)) return;
    if (!ORG_ID) {
      console.warn('[skip] TIMBAL_INTEGRATION_ORG_ID required for org-bucket test');
      return;
    }

    const name = unique('txt');
    const path = `/tmp/${name}`;
    await Bun.write(path, `bucket ${name}`);

    const file = await timbal.uploadFile(path);

    expect(typeof file.id).toBe('string');
    expect(file.id.length).toBeGreaterThan(0);
    expect(file.url).toMatch(/^https?:\/\//);
  });

  test('uploadFileFromBuffer coerces id to string', async () => {
    const timbal = makeTimbal();
    if (!hasCreds(timbal) || !ORG_ID) return;

    const data = new TextEncoder().encode(`buffer ${Date.now()}`);
    const file = await timbal.uploadFileFromBuffer(data, unique('txt'), 'text/plain');

    expect(typeof file.id).toBe('string');
    expect(file.id.length).toBeGreaterThan(0);
  });
});
