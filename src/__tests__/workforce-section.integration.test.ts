import { describe, test, expect } from 'bun:test';
import { Timbal } from '../lib/timbal';

// ─────────────────────────────────────────────────────────────
// Integration Tests — workforce section (v0.9 surface)
//
// Required env vars:
//   TIMBAL_INTEGRATION_ORG_ID       org id the agent lives in
//   TIMBAL_INTEGRATION_PROJECT_ID   project id the agent lives in
//   TIMBAL_INTEGRATION_AGENT        workforce name/uid/id to call
//
// Optional env vars:
//   TIMBAL_INTEGRATION_REV          branch/rev to target  (default: "main")
//   TIMBAL_INTEGRATION_BASE_URL     full API base URL
//   TIMBAL_INTEGRATION_TOKEN        bearer token
//   TIMBAL_INTEGRATION_INPUT_KEY    input field name      (default: "prompt")
//   SKIP_INTEGRATION_TESTS=true     skip entirely
//
// Run with: bun test src/__tests__/workforce-section.integration.test.ts
// ─────────────────────────────────────────────────────────────

const SKIP = process.env.SKIP_INTEGRATION_TESTS === 'true';

const ORG_ID = process.env.TIMBAL_INTEGRATION_ORG_ID;
const PROJECT_ID = process.env.TIMBAL_INTEGRATION_PROJECT_ID;
const AGENT = process.env.TIMBAL_INTEGRATION_AGENT;
const REV = process.env.TIMBAL_INTEGRATION_REV ?? 'main';
const BASE_URL = process.env.TIMBAL_INTEGRATION_BASE_URL;
const TOKEN = process.env.TIMBAL_INTEGRATION_TOKEN;
const INPUT_KEY = process.env.TIMBAL_INTEGRATION_INPUT_KEY ?? 'prompt';

function missingConfig(): string[] {
  const missing: string[] = [];
  if (!ORG_ID) missing.push('TIMBAL_INTEGRATION_ORG_ID');
  if (!PROJECT_ID) missing.push('TIMBAL_INTEGRATION_PROJECT_ID');
  if (!AGENT) missing.push('TIMBAL_INTEGRATION_AGENT');
  return missing;
}

function makeTimbal(): Timbal {
  return new Timbal({
    baseUrl: BASE_URL ?? 'https://api.dev.timbal.ai',
    ...(TOKEN && { token: TOKEN }),
    ...(ORG_ID && { orgId: ORG_ID }),
    ...(PROJECT_ID && { projectId: PROJECT_ID }),
    rev: REV,
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
    console.warn('[skip] no token resolved');
    return null;
  }
  return t;
}

describe.skipIf(SKIP)('Integration Tests — workforce section', () => {
  test('workforce.list() returns at least one component with the right shape', async () => {
    const t = ready();
    if (!t) return;

    const items = await t.workforce.list();
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    const first = items[0];
    if (!first) throw new Error('unreachable');
    // At least one of id/uid/name must be present per OpenAPI.
    expect(first.id || first.uid || first.name).toBeTruthy();
  });

  test('workforce.get(id).call(...) → 200', async () => {
    const t = ready();
    if (!t) return;

    const wf = t.workforce.get(AGENT!);
    const res = await wf.call({ [INPUT_KEY]: 'reply with the single word: ok' });
    if (res.status !== 200) {
      console.log('[debug] body:', (await res.clone().text()).slice(0, 500));
    }
    expect(res.status).toBe(200);
  });

  test('workforce.get(id).events(...) yields parsed SSE payloads', async () => {
    const t = ready();
    if (!t) return;

    const wf = t.workforce.get(AGENT!);
    const events: any[] = [];
    for await (const ev of wf.events({ [INPUT_KEY]: 'reply with: ok' })) {
      events.push(ev);
      if (events.length >= 50) break;
    }
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev).toBeDefined();
      expect(typeof ev).toBe('object');
    }
  });

  test('workforce.get(id) is sync and does not hit the network', () => {
    const t = ready();
    if (!t) return;
    const wf = t.workforce.get(AGENT!);
    expect(wf.identifier).toBe(AGENT);
  });
});
