import { describe, test, expect, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import {
  timbalChannels,
  registerChannelWebhooks,
  resolveBindingPath,
  resolveChannelBindings,
} from '../elysia/channels';
import { clearProjectAuthConfigCache } from '../auth/config';
import type { Timbal } from '../lib/timbal';
import type {
  ChannelAdapter,
  ChannelBinding,
  ChannelEvent,
  WebhookRequest,
} from '../channels/types';

/** Let detached (void-ed) processing settle. */
const settle = () => new Promise((r) => setTimeout(r, 10));

/**
 * Fake adapter: authenticates with an `x-test-auth` header, treats the body
 * as `{ id, text }`, and records everything sent back.
 */
function makeAdapter(provider = 'fake') {
  const sent: string[] = [];
  const edits: string[] = [];
  const registered: string[] = [];
  const adapter: ChannelAdapter = {
    provider,
    verify(req: WebhookRequest) {
      return req.headers.get('x-test-auth') === 'yes'
        ? 'ok'
        : new Response('nope', { status: 401 });
    },
    parse(req: WebhookRequest) {
      const body = JSON.parse(req.rawBody) as { id?: string; text?: string };
      if (!body.text) return [];
      const event: ChannelEvent = {
        provider,
        conversationId: 'conv-1',
        text: body.text,
        dedupeKey: body.id ? `${provider}:${body.id}` : undefined,
        raw: body,
      };
      return [event];
    },
    delivery() {
      return {
        async send(text: string) {
          sent.push(text);
          return 'ref-1';
        },
        async edit(_ref: unknown, text: string) {
          edits.push(text);
        },
      };
    },
    async registerWebhook(url: string) {
      registered.push(url);
    },
  };
  return { adapter, sent, edits, registered };
}

/** Fake Timbal whose workforce components yield scripted SSE events. */
function makeTimbal(
  script: (input: Record<string, unknown>) => Record<string, unknown>[],
) {
  const invocations: {
    identifier: string;
    input: Record<string, unknown>;
    ctx?: { parentId?: string };
  }[] = [];
  const timbal = {
    workforce: {
      get(identifier: string) {
        return {
          async *events(
            input: Record<string, unknown>,
            ctx?: { parentId?: string },
          ) {
            invocations.push({ identifier, input, ctx });
            for (const ev of script(input)) yield ev;
          },
        };
      },
    },
  } as unknown as Timbal;
  return { timbal, invocations };
}

function post(app: Elysia, path: string, body: unknown, auth = true) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: auth ? { 'x-test-auth': 'yes' } : {},
      body: JSON.stringify(body),
    }),
  );
}

describe('timbalChannels plugin', () => {
  test('happy path: acks 200, invokes the workforce, posts the reply once', async () => {
    const { adapter, sent, edits } = makeAdapter();
    const { timbal, invocations } = makeTimbal(() => [
      { type: 'delta', delta: 'Hello ' },
      { type: 'delta', delta: 'world' },
    ]);
    const app = new Elysia().use(
      timbalChannels({
        timbal,
        bindings: [{ adapter, workforce: 'my-agent' }],
      }),
    );

    const res = await post(app, '/channels/fake', { id: 'e1', text: 'hi agent' });
    expect(res.status).toBe(200);
    await settle();

    expect(invocations).toEqual([
      { identifier: 'my-agent', input: { prompt: 'hi agent' } },
    ]);
    // Streaming defaults OFF: one complete message at finalize, no edits.
    expect(sent).toEqual(['Hello world']);
    expect(edits).toHaveLength(0);
  });

  test('streaming: true streams via send + edits', async () => {
    const { adapter, sent, edits } = makeAdapter();
    const { timbal } = makeTimbal(() => [
      { type: 'delta', delta: 'Hello ' },
      { type: 'delta', delta: 'world' },
    ]);
    const app = new Elysia().use(
      timbalChannels({
        timbal,
        streaming: true,
        editIntervalMs: 0,
        bindings: [{ adapter, workforce: 'my-agent' }],
      }),
    );

    await post(app, '/channels/fake', { id: 'e1', text: 'hi agent' });
    await settle();

    // First delta sends, final state lands via finalize (send or edit).
    expect(sent[0]).toBe('Hello ');
    expect([...sent, ...edits]).toContain('Hello world');
  });

  test('verify short-circuit is returned as-is (401)', async () => {
    const { adapter } = makeAdapter();
    const { timbal, invocations } = makeTimbal(() => []);
    const app = new Elysia().use(
      timbalChannels({ timbal, bindings: [{ adapter, workforce: 'a' }] }),
    );

    const res = await post(app, '/channels/fake', { text: 'x' }, false);
    expect(res.status).toBe(401);
    await settle();
    expect(invocations).toHaveLength(0);
  });

  test('redelivered events are deduped by dedupeKey', async () => {
    const { adapter } = makeAdapter();
    const { timbal, invocations } = makeTimbal(() => [{ type: 'delta', delta: 'ok' }]);
    const app = new Elysia().use(
      timbalChannels({ timbal, bindings: [{ adapter, workforce: 'a' }] }),
    );

    await post(app, '/channels/fake', { id: 'same', text: 'first' });
    await post(app, '/channels/fake', { id: 'same', text: 'retry' });
    await post(app, '/channels/fake', { id: 'other', text: 'new' });
    await settle();

    expect(invocations.map((i) => i.input.prompt)).toEqual(['first', 'new']);
  });

  test('failed processing releases dedupe so provider redelivery can retry', async () => {
    const { adapter, sent } = makeAdapter();
    let attempts = 0;
    const invocations: string[] = [];
    const timbal = {
      workforce: {
        get() {
          return {
            // eslint-disable-next-line require-yield
            async *events(
              input: Record<string, unknown>,
            ): AsyncGenerator<Record<string, unknown>> {
              attempts += 1;
              invocations.push(String(input.prompt));
              if (attempts === 1) throw new Error('boom');
              yield { type: 'delta', delta: 'recovered' };
            },
          };
        },
      },
    } as unknown as Timbal;
    const app = new Elysia().use(
      timbalChannels({
        timbal,
        bindings: [{ adapter, workforce: 'a' }],
        errorMessage: 'temporary failure',
      }),
    );

    await post(app, '/channels/fake', { id: 'same', text: 'hi' });
    await settle();
    expect(sent).toEqual(['temporary failure']);

    // Same dedupeKey — must not be dropped; claim was released on failure.
    await post(app, '/channels/fake', { id: 'same', text: 'hi' });
    await settle();

    expect(invocations).toEqual(['hi', 'hi']);
    expect(sent).toContain('recovered');
  });

  test('partial delivery keeps the dedupe claim (no duplicate on retry)', async () => {
    const { adapter, sent } = makeAdapter();
    let attempts = 0;
    const timbal = {
      workforce: {
        get() {
          return {
            async *events(): AsyncGenerator<Record<string, unknown>> {
              attempts += 1;
              yield { type: 'delta', delta: 'partial answer' };
              throw new Error('stream died after first token');
            },
          };
        },
      },
    } as unknown as Timbal;
    const app = new Elysia().use(
      timbalChannels({
        timbal,
        streaming: true,
        editIntervalMs: 0,
        bindings: [{ adapter, workforce: 'a' }],
        errorMessage: 'failed mid-stream',
      }),
    );

    await post(app, '/channels/fake', { id: 'same', text: 'hi' });
    await settle();
    expect(sent).toContain('partial answer');
    expect(sent).toContain('failed mid-stream');
    expect(attempts).toBe(1);

    // Redelivery must NOT re-invoke — something already reached the user.
    await post(app, '/channels/fake', { id: 'same', text: 'hi' });
    await settle();
    expect(attempts).toBe(1);
  });

  test('empty workforce reply does not advance session continuity', async () => {
    const { adapter } = makeAdapter();
    const parentIds: Array<string | undefined> = [];
    const timbal = {
      workforce: {
        get() {
          return {
            async *events(
              _input: Record<string, unknown>,
              ctx?: { parentId?: string },
            ): AsyncGenerator<Record<string, unknown>> {
              parentIds.push(ctx?.parentId);
              yield { type: 'START', run_id: `run-${parentIds.length}` };
              // No textual output — finalize delivers nothing.
            },
          };
        },
      },
    } as unknown as Timbal;
    const app = new Elysia().use(
      timbalChannels({ timbal, bindings: [{ adapter, workforce: 'a' }] }),
    );

    await post(app, '/channels/fake', { id: 'e1', text: 'first' });
    await settle();
    await post(app, '/channels/fake', { id: 'e2', text: 'second' });
    await settle();

    // Second message must not chain onto the silent first run.
    expect(parentIds).toEqual([undefined, undefined]);
  });

  test('buildInput overrides the default workforce input', async () => {
    const { adapter } = makeAdapter();
    const { timbal, invocations } = makeTimbal(() => []);
    const binding: ChannelBinding = {
      adapter,
      workforce: 'a',
      buildInput: (ev) => ({ message: ev.text, session: ev.conversationId }),
    };
    const app = new Elysia().use(timbalChannels({ timbal, bindings: [binding] }));

    await post(app, '/channels/fake', { id: 'e1', text: 'yo' });
    await settle();

    expect(invocations[0]!.input).toEqual({ message: 'yo', session: 'conv-1' });
  });

  test('handles the Timbal runtime vocabulary (DELTA/OUTPUT)', async () => {
    const { adapter, sent, edits } = makeAdapter();
    const { timbal } = makeTimbal(() => [
      { type: 'START', run_id: 'r1', path: 'agent' },
      { type: 'DELTA', run_id: 'r1', item: { type: 'text_delta', text_delta: 'The time ' } },
      { type: 'DELTA', run_id: 'r1', item: { type: 'text_delta', text_delta: 'is 13:37.' } },
      {
        type: 'OUTPUT',
        run_id: 'r1',
        path: 'agent',
        output: { role: 'assistant', content: [{ type: 'text', text: 'The time is 13:37.' }] },
      },
    ]);
    const app = new Elysia().use(
      timbalChannels({
        timbal,
        editIntervalMs: 0,
        bindings: [{ adapter, workforce: 'joi' }],
      }),
    );

    await post(app, '/channels/fake', { id: 'e1', text: 'what time is it?' });
    await settle();

    expect([...sent, ...edits]).toContain('The time is 13:37.');
  });

  test('session continuity threads parent_id across messages in a conversation', async () => {
    const { adapter } = makeAdapter();
    let run = 0;
    const { timbal, invocations } = makeTimbal(() => [
      { type: 'START', run_id: `run-${++run}`, path: 'agent' },
      { type: 'OUTPUT', run_id: `run-${run}`, path: 'agent', output: 'ok' },
    ]);
    const app = new Elysia().use(
      timbalChannels({ timbal, bindings: [{ adapter, workforce: 'joi' }] }),
    );

    await post(app, '/channels/fake', { id: 'm1', text: 'first' });
    await settle();
    await post(app, '/channels/fake', { id: 'm2', text: 'second' });
    await settle();

    expect(invocations[0]!.ctx).toBeUndefined(); // fresh conversation
    expect(invocations[1]!.ctx).toEqual({ parentId: 'run-1' }); // threaded
  });

  test('sessionContinuity: false never passes parentId', async () => {
    const { adapter } = makeAdapter();
    const { timbal, invocations } = makeTimbal(() => [
      { type: 'OUTPUT', run_id: 'r1', path: 'agent', output: 'ok' },
    ]);
    const app = new Elysia().use(
      timbalChannels({
        timbal,
        sessionContinuity: false,
        bindings: [{ adapter, workforce: 'joi' }],
      }),
    );

    await post(app, '/channels/fake', { id: 'm1', text: 'first' });
    await settle();
    await post(app, '/channels/fake', { id: 'm2', text: 'second' });
    await settle();

    expect(invocations[1]!.ctx).toBeUndefined();
  });

  test('a string `output` event supersedes accumulated deltas', async () => {
    const { adapter, sent, edits } = makeAdapter();
    const { timbal } = makeTimbal(() => [
      { type: 'delta', delta: 'partial' },
      { type: 'output', output: 'the real final answer' },
    ]);
    const app = new Elysia().use(
      timbalChannels({
        timbal,
        editIntervalMs: 0,
        bindings: [{ adapter, workforce: 'a' }],
      }),
    );

    await post(app, '/channels/fake', { id: 'e1', text: 'q' });
    await settle();

    expect([...sent, ...edits]).toContain('the real final answer');
  });

  test('workforce failure posts the error message and calls onError', async () => {
    const { adapter, sent } = makeAdapter();
    const errors: unknown[] = [];
    const timbal = {
      workforce: {
        get() {
          return {
            // eslint-disable-next-line require-yield
            async *events(): AsyncGenerator<Record<string, unknown>> {
              throw new Error('deployment unreachable');
            },
          };
        },
      },
    } as unknown as Timbal;
    const app = new Elysia().use(
      timbalChannels({
        timbal,
        bindings: [{ adapter, workforce: 'a' }],
        errorMessage: 'agent is down, sorry',
        onError: (err) => errors.push(err),
      }),
    );

    const res = await post(app, '/channels/fake', { id: 'e1', text: 'q' });
    expect(res.status).toBe(200); // webhook still acks — errors are out-of-band
    await settle();

    expect(errors).toHaveLength(1);
    expect(sent).toEqual(['agent is down, sorry']);
  });

  test('custom prefix and binding path shape the route', async () => {
    const { adapter } = makeAdapter();
    const { timbal, invocations } = makeTimbal(() => []);
    const binding: ChannelBinding = { adapter, workforce: 'a', path: '/fake/support' };
    const app = new Elysia().use(
      timbalChannels({ timbal, prefix: '/hooks', bindings: [binding] }),
    );

    expect(resolveBindingPath(binding, '/hooks')).toBe('/hooks/fake/support');
    const res = await post(app, '/hooks/fake/support', { id: 'e1', text: 'x' });
    expect(res.status).toBe(200);
    await settle();
    expect(invocations).toHaveLength(1);
  });

  test('registerChannelWebhooks provisions programmatic adapters, reports manual ones', async () => {
    const withHook = makeAdapter('telegramish');
    const withoutHook = makeAdapter('slackish');
    delete (withoutHook.adapter as { registerWebhook?: unknown }).registerWebhook;

    const result = await registerChannelWebhooks(
      {
        bindings: [
          { adapter: withHook.adapter, workforce: 'a' },
          { adapter: withoutHook.adapter, workforce: 'b' },
        ],
      },
      'https://app.example.com/',
    );

    expect(withHook.registered).toEqual([
      'https://app.example.com/channels/telegramish',
    ]);
    expect(withoutHook.registered).toHaveLength(0);

    expect(result.origin).toBe('https://app.example.com');
    expect(result.registrations).toEqual([
      {
        provider: 'telegramish',
        workforce: 'a',
        url: 'https://app.example.com/channels/telegramish',
        registered: true,
      },
      {
        provider: 'slackish',
        workforce: 'b',
        url: 'https://app.example.com/channels/slackish',
        registered: false,
        reason: 'manual-registration',
      },
    ]);
  });

  test('registerChannelWebhooks falls back to PUBLIC_ORIGIN env', async () => {
    const { adapter, registered } = makeAdapter('tg');
    const result = await registerChannelWebhooks({
      bindings: [{ adapter, workforce: 'a' }],
      env: { PUBLIC_ORIGIN: 'https://from-env.example.com' },
    });

    expect(registered).toEqual(['https://from-env.example.com/channels/tg']);
    expect(result.origin).toBe('https://from-env.example.com');
  });

  test('registerChannelWebhooks with no resolvable origin registers nothing', async () => {
    const { adapter, registered } = makeAdapter('tg');
    const failingFetch = (async () => {
      throw new Error('no tunnel');
    }) as unknown as typeof fetch;

    const result = await registerChannelWebhooks({
      bindings: [{ adapter, workforce: 'a' }],
      env: {},
      fetchImpl: failingFetch,
    });

    expect(registered).toHaveLength(0);
    expect(result.origin).toBeNull();
    expect(result.registrations[0]).toEqual({
      provider: 'tg',
      workforce: 'a',
      url: null,
      registered: false,
      reason: 'no-origin',
    });
  });

  test('registerChannelWebhooks surfaces skipped platform specs', async () => {
    const result = await registerChannelWebhooks(
      {
        channelSpecs: [
          { provider: 'slack', workforce: 'joi' }, // no creds in env below
          { provider: 'whatsapp', workforce: 'joi' }, // unknown provider
        ],
        env: {},
        fetchImpl: (async () => {
          throw new Error('no tunnel');
        }) as unknown as typeof fetch,
      },
      'https://app.example.com',
    );

    expect(result.registrations).toEqual([]);
    expect(result.skipped.map((s) => [s.spec.provider, s.reason])).toEqual([
      ['slack', 'missing-credentials'],
      ['whatsapp', 'unknown-provider'],
    ]);
  });

  test('registerChannelWebhooks never probes tunnels on platform-linked deployments', async () => {
    const { adapter, registered } = makeAdapter('tg');
    let probed = false;
    const trackingFetch = (async () => {
      probed = true;
      throw new Error('should not be called');
    }) as unknown as typeof fetch;

    const result = await registerChannelWebhooks({
      bindings: [{ adapter, workforce: 'a' }],
      env: { TIMBAL_PROJECT_ID: '248' },
      fetchImpl: trackingFetch,
    });

    expect(probed).toBe(false);
    expect(registered).toHaveLength(0);
    expect(result.origin).toBeNull();
  });
});

/**
 * Fake platform-linked Timbal: `getProject` returns the given project (or
 * rejects), with a unique org/project cache key per instance so the shared
 * auth-config cache never leaks across tests.
 */
let fakeProjectCounter = 0;
function makePlatformTimbal(project: Record<string, unknown> | Error) {
  const projectId = `test-proj-${++fakeProjectCounter}`;
  let fetches = 0;
  const timbal = {
    apiClient: { getConfig: () => ({ orgId: 'test-org', projectId }) },
    async getProject() {
      fetches += 1;
      if (project instanceof Error) throw project;
      return project;
    },
  } as unknown as Timbal;
  return { timbal, fetchCount: () => fetches };
}

describe('resolveChannelBindings', () => {
  afterEach(() => clearProjectAuthConfigCache());

  const TG_ENV = {
    TIMBAL_PROJECT_ID: '248',
    TELEGRAM_BOT_TOKEN: '123:abc',
    CHANNELS_WORKFORCE: 'env-target',
  };

  test('explicit bindings short-circuit everything', async () => {
    const { adapter } = makeAdapter('custom');
    const { timbal, fetchCount } = makePlatformTimbal(new Error('unreachable'));
    const bindings = await resolveChannelBindings(timbal, {
      bindings: [{ adapter, workforce: 'static' }],
      env: TG_ENV,
    });
    expect(bindings.map((b) => b.workforce)).toEqual(['static']);
    expect(fetchCount()).toBe(0);
  });

  test('platform project.channels drives the bindings (creds from env)', async () => {
    const { timbal } = makePlatformTimbal({
      channels: [{ provider: 'telegram', workforce: 'platform-target' }],
    });
    const bindings = await resolveChannelBindings(timbal, { env: TG_ENV });
    expect(bindings.map((b) => [b.adapter.provider, b.workforce])).toEqual([
      ['telegram', 'platform-target'],
    ]);
  });

  test('platform empty channels list means all channels off (no env fallback)', async () => {
    const { timbal } = makePlatformTimbal({ channels: [] });
    const bindings = await resolveChannelBindings(timbal, { env: TG_ENV });
    expect(bindings).toEqual([]);
  });

  test("TODAY'S platform (no channels field) → env conventions, exactly as before", async () => {
    const { timbal } = makePlatformTimbal({ name: 'current-platform-project' });
    const bindings = await resolveChannelBindings(timbal, { env: TG_ENV });
    expect(bindings.map((b) => [b.adapter.provider, b.workforce])).toEqual([
      ['telegram', 'env-target'],
    ]);
  });

  test('platform fetch failure fails soft to env conventions', async () => {
    const { timbal } = makePlatformTimbal(new Error('platform down'));
    const bindings = await resolveChannelBindings(timbal, { env: TG_ENV });
    expect(bindings.map((b) => b.workforce)).toEqual(['env-target']);
  });

  test('not platform-linked → env conventions, no fetch', async () => {
    const { timbal, fetchCount } = makePlatformTimbal({});
    const bindings = await resolveChannelBindings(timbal, {
      env: { TELEGRAM_BOT_TOKEN: '123:abc', CHANNELS_WORKFORCE: 'env-target' },
    });
    expect(bindings.map((b) => b.workforce)).toEqual(['env-target']);
    expect(fetchCount()).toBe(0);
  });

  test('skipped specs are reported (missing creds / unknown provider)', async () => {
    const { timbal } = makePlatformTimbal({
      channels: [
        { provider: 'slack', workforce: 'joi' },
        { provider: 'whatsapp', workforce: 'joi' },
        { provider: 'telegram', workforce: 'joi', enabled: false },
      ],
    });
    const skipped: [string, string][] = [];
    const bindings = await resolveChannelBindings(timbal, {
      env: TG_ENV,
      onSkippedSpec: (s) => skipped.push([s.spec.provider, s.reason]),
    });
    expect(bindings).toEqual([]);
    expect(skipped).toEqual([
      ['slack', 'missing-credentials'],
      ['whatsapp', 'unknown-provider'],
    ]);
  });
});

describe('timbalChannels dynamic mode', () => {
  afterEach(() => clearProjectAuthConfigCache());

  test('routes per-request from platform config; unknown providers 404', async () => {
    const { timbal: platformTimbal } = makePlatformTimbal({
      channels: [{ provider: 'telegram', workforce: 'joi' }],
    });
    // Graft a fake workforce onto the platform fake so processing works.
    (platformTimbal as unknown as Record<string, unknown>).workforce = {
      get: () => ({
        // eslint-disable-next-line require-yield
        async *events(): AsyncGenerator<Record<string, unknown>> {
          return;
        },
      }),
    };

    const app = new Elysia().use(
      timbalChannels({
        timbal: platformTimbal,
        env: {
          TIMBAL_PROJECT_ID: '248',
          TELEGRAM_BOT_TOKEN: '123:abc',
          TELEGRAM_SECRET_TOKEN: 'shh',
        },
      }),
    );

    // Telegram is bound: bad secret → 401 from the adapter (route exists).
    const unauthorized = await app.handle(
      new Request('http://localhost/channels/telegram', {
        method: 'POST',
        body: '{}',
      }),
    );
    expect(unauthorized.status).toBe(401);

    // Good secret → acked.
    const ok = await app.handle(
      new Request('http://localhost/channels/telegram', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'shh' },
        body: JSON.stringify({ update_id: 1 }),
      }),
    );
    expect(ok.status).toBe(200);

    // Slack is NOT in the platform config → 404.
    const unknown = await app.handle(
      new Request('http://localhost/channels/slack', {
        method: 'POST',
        body: '{}',
      }),
    );
    expect(unknown.status).toBe(404);
  });

  test('channelSpecs override skips the platform entirely', async () => {
    const app = new Elysia().use(
      timbalChannels({
        timbal: makePlatformTimbal(new Error('must not be fetched')).timbal,
        channelSpecs: [{ provider: 'telegram', workforce: 'joi' }],
        env: {
          TELEGRAM_BOT_TOKEN: '123:abc',
          TELEGRAM_SECRET_TOKEN: 'shh',
        },
      }),
    );

    const res = await app.handle(
      new Request('http://localhost/channels/telegram', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'shh' },
        body: JSON.stringify({ update_id: 2 }),
      }),
    );
    expect(res.status).toBe(200);
  });
});
