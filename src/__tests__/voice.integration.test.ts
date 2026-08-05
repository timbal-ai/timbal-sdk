import { describe, test, expect } from 'bun:test';
import { Timbal } from '../lib/timbal';

// ─────────────────────────────────────────────────────────────
// Integration Tests — voice endpoints, straight at the projects APIs
//
// Required env vars:
//   TIMBAL_INTEGRATION_ORG_ID       org id the workforce lives in
//   TIMBAL_INTEGRATION_PROJECT_ID   project id the workforce lives in
//   TIMBAL_INTEGRATION_AGENT        workforce name/uid/id
//
// Optional env vars:
//   TIMBAL_INTEGRATION_REV          branch/rev to target        (default: "main")
//   TIMBAL_INTEGRATION_BASE_URL     full API base URL
//   TIMBAL_INTEGRATION_TOKEN        bearer token
//   TIMBAL_INTEGRATION_VOICE=true   also dial the voice WebSocket. Off by
//                                   default: the connect needs a running
//                                   deployment whose pinned timbal has the
//                                   voice extra (timbal[voice] >= 2.3.1) —
//                                   ticket minting and URL shape don't.
//   SKIP_INTEGRATION_TESTS=true     skip entirely (used by `bun run test`)
//
// Run with:   bun run test:integration
//        or:  bun test src/__tests__/voice.integration.test.ts
// ─────────────────────────────────────────────────────────────

const SKIP = process.env.SKIP_INTEGRATION_TESTS === 'true';

const ORG_ID = process.env.TIMBAL_INTEGRATION_ORG_ID;
const PROJECT_ID = process.env.TIMBAL_INTEGRATION_PROJECT_ID;
const AGENT = process.env.TIMBAL_INTEGRATION_AGENT;
const REV = process.env.TIMBAL_INTEGRATION_REV ?? 'main';
const BASE_URL = process.env.TIMBAL_INTEGRATION_BASE_URL;
const TOKEN = process.env.TIMBAL_INTEGRATION_TOKEN;
const DIAL = process.env.TIMBAL_INTEGRATION_VOICE === 'true';

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
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    rev: REV,
  });
}

function hasCreds(timbal: Timbal): boolean {
  return !!timbal.apiClient.getConfig().token;
}

describe('Integration Tests — voice', () => {
  test.skipIf(SKIP)('mints a single-use ticket with sane expiry', async () => {
    const missing = missingConfig();
    if (missing.length) {
      console.warn(`Skipping: missing ${missing.join(', ')}`);
      return;
    }
    const timbal = makeTimbal();
    if (!hasCreds(timbal)) {
      console.warn('Skipping: no token resolved');
      return;
    }

    const t = await timbal.workforce.get(AGENT!).voice.ticket();
    expect(t.ticket.length).toBeGreaterThan(20);
    expect(t.ttlSecs).toBeGreaterThan(0);
    // expiresAt is epoch ms in the future, within ~ttl of now.
    expect(t.expiresAt).toBeGreaterThan(Date.now());
    expect(t.expiresAt).toBeLessThanOrEqual(Date.now() + (t.ttlSecs + 10) * 1000);
  });

  test.skipIf(SKIP)('builds the deployed and preview WS URLs', async () => {
    const missing = missingConfig();
    if (missing.length) {
      console.warn(`Skipping: missing ${missing.join(', ')}`);
      return;
    }
    const timbal = makeTimbal();
    const voice = timbal.workforce.get(AGENT!).voice;

    const deployed = await voice.wsUrl();
    expect(deployed).toContain(`/orgs/${ORG_ID}/projects/${PROJECT_ID}/workforce/`);
    expect(deployed).toContain(`/voice/ws?rev=${encodeURIComponent(REV)}`);
    expect(deployed.startsWith('wss://') || deployed.startsWith('ws://')).toBe(true);

    const preview = await voice.wsUrl({ preview: true });
    expect(preview).toContain(`/voice/preview?rev=${encodeURIComponent(REV)}`);
  });

  test.skipIf(SKIP || !DIAL)(
    'ticket-authed WebSocket connect against the deployed voice endpoint',
    async () => {
      const missing = missingConfig();
      if (missing.length) {
        console.warn(`Skipping: missing ${missing.join(', ')}`);
        return;
      }
      const timbal = makeTimbal();
      if (!hasCreds(timbal)) {
        console.warn('Skipping: no token resolved');
        return;
      }

      // Cold serverless spawn budget; deployed connects are usually much faster.
      const ws = await timbal.workforce.get(AGENT!).voice.connect({
        auth: 'ticket',
        timeoutMs: 60_000,
      });
      try {
        expect(ws.readyState).toBe(WebSocket.OPEN);
      } finally {
        ws.close();
      }
    },
    120_000,
  );
});
