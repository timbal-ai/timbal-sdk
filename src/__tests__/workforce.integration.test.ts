import { describe, test, expect } from 'bun:test';
import { Timbal } from '../lib/timbal';

// ─────────────────────────────────────────────────────────────
// Integration Tests — memory recall via parent_id chaining
//
// Required env vars:
//   TIMBAL_INTEGRATION_ORG_ID       org id the agent lives in                 (e.g. "1")
//   TIMBAL_INTEGRATION_PROJECT_ID   project id the agent lives in             (e.g. "322")
//   TIMBAL_INTEGRATION_AGENT        workforce name/uid/id to call             (e.g. "happy-hamster")
//
// Optional env vars:
//   TIMBAL_INTEGRATION_REV          branch/rev to target                      (default: "main")
//   TIMBAL_INTEGRATION_BASE_URL     full API base URL                         (default: resolved from
//                                                                              TIMBAL_BASE_URL /
//                                                                              ~/.timbal/config)
//   TIMBAL_INTEGRATION_TOKEN        bearer token                              (default: resolved from
//                                                                              TIMBAL_API_KEY /
//                                                                              ~/.timbal/credentials)
//   TIMBAL_INTEGRATION_INPUT_KEY    input field name sent to the agent        (default: "prompt")
//   SKIP_INTEGRATION_TESTS=true     skip entirely (used by `bun run test`)
//
// Run with:   bun run test:integration
//        or:  bun test src/__tests__/workforce.integration.test.ts
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

// Use a neutral label (no "secret" framing) so safety-tuned agents don't refuse
// to echo it back. The assertion only fails on an actual memory failure.
const MEMORY_TAG = `PINEAPPLE-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const TURN_1_PROMPT = `Please remember this session tag for later reference: ${MEMORY_TAG}. Reply with "ok".`;
const TURN_2_PROMPT = `What is the session tag I asked you to remember? Repeat it back verbatim.`;

function makeTimbal(): Timbal {
  return new Timbal({
    ...(BASE_URL && { baseUrl: BASE_URL }),
    ...(TOKEN && { token: TOKEN }),
  });
}

function hasCreds(timbal: Timbal): boolean {
  return !!timbal.getApiClient().getConfig().token;
}

// ── Response parsing ────────────────────────────────────────
// The run endpoint returns JSON; codegen (studio) may return JSON or SSE.
// Parse defensively so both shapes work without a schema.

interface ParsedResponse {
  raw: string;
  runId?: string;
  text: string;
}

function extractText(obj: unknown): string {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj !== 'object') return '';
  const o = obj as Record<string, unknown>;

  // Common shapes: { output: "..." } | { output: { content: [...] } } | { content: [...] } | { text: "..." }
  if (typeof o.text === 'string') return o.text;
  if (typeof o.output === 'string') return o.output;
  if (Array.isArray(o.content)) {
    return o.content.map(c => extractText(c)).join('');
  }
  if (typeof o.content === 'string') return o.content;
  if (o.output && typeof o.output === 'object') return extractText(o.output);
  if (Array.isArray(o.messages)) {
    return o.messages.map(m => extractText(m)).join('\n');
  }
  if (o.delta && typeof o.delta === 'object') return extractText(o.delta);
  return '';
}

function extractRunId(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  for (const key of ['id', 'run_id', 'runId']) {
    const v = o[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

async function consumeResponse(res: Response): Promise<ParsedResponse> {
  const raw = await res.text();

  // Try single JSON body first.
  try {
    const json = JSON.parse(raw);
    return {
      raw,
      runId: extractRunId(json),
      text: extractText(json),
    };
  } catch {
    /* fall through to SSE */
  }

  // Parse as SSE: lines starting with `data: `.
  let runId: string | undefined;
  let text = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const evt = JSON.parse(data);
      if (!runId) runId = extractRunId(evt);
      text += extractText(evt);
    } catch {
      // Non-JSON SSE payload — append as-is.
      text += data;
    }
  }
  return { raw, runId, text };
}

// ── Test helpers ────────────────────────────────────────────

async function runMemoryTest(label: string, timbal: Timbal): Promise<void> {
  // Narrowed by `missingConfig()` check in the test body.
  const ctx = { orgId: ORG_ID!, projectId: PROJECT_ID!, rev: REV };
  const agent = AGENT!;

  // Turn 1 — establish memory, parent_id undefined.
  console.log(`\n[${label}] turn 1 → ${agent}  (parent_id: none)`);
  console.log(`[${label}] prompt: ${TURN_1_PROMPT}`);
  const r1 = await timbal.callWorkforce(agent, { [INPUT_KEY]: TURN_1_PROMPT }, ctx);
  const body1 = await consumeResponse(r1);
  console.log(`[${label}] status=${r1.status} runId=${body1.runId}`);
  console.log(`[${label}] text: ${body1.text.slice(0, 400)}`);
  if (r1.status !== 200) {
    console.log(`[${label}] raw: ${body1.raw.slice(0, 1000)}`);
  }
  expect(r1.status).toBe(200);
  expect(body1.runId).toBeTruthy();

  // Turn 2 — recall, parent_id = turn 1 runId.
  console.log(`\n[${label}] turn 2 → ${agent}  (parent_id: ${body1.runId})`);
  console.log(`[${label}] prompt: ${TURN_2_PROMPT}`);
  const r2 = await timbal.callWorkforce(
    agent,
    { [INPUT_KEY]: TURN_2_PROMPT },
    { ...ctx, parentId: body1.runId },
  );
  const body2 = await consumeResponse(r2);
  console.log(`[${label}] status=${r2.status} runId=${body2.runId}`);
  console.log(`[${label}] text: ${body2.text.slice(0, 400)}`);
  if (r2.status !== 200) {
    console.log(`[${label}] raw: ${body2.raw.slice(0, 1000)}`);
  }
  expect(r2.status).toBe(200);
  expect(body2.text).toContain(MEMORY_TAG);
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

describe('Integration Tests — memory recall', () => {
  test.skipIf(SKIP)(
    'serverless remote: turn 2 recalls memory tag from turn 1 via parent_id',
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
      // Ensure studio mode is NOT on for this test.
      const prev = process.env.TIMBAL_STUDIO;
      delete process.env.TIMBAL_STUDIO;
      try {
        await runMemoryTest('serverless', timbal);
      } finally {
        if (prev !== undefined) process.env.TIMBAL_STUDIO = prev;
      }
    },
    60_000,
  );

  test.skipIf(SKIP)(
    'studio: turn 2 recalls memory tag from turn 1 via parent_id',
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
      const prev = process.env.TIMBAL_STUDIO;
      process.env.TIMBAL_STUDIO = '1';
      try {
        await runMemoryTest('studio', timbal);
      } finally {
        if (prev === undefined) delete process.env.TIMBAL_STUDIO;
        else process.env.TIMBAL_STUDIO = prev;
      }
    },
    60_000,
  );
});
