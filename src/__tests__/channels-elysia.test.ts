import { describe, test, expect, afterEach } from 'bun:test';
import { Elysia } from 'elysia';
import {
  timbalChannels,
  registerChannelWebhooks,
  resolveBindingPath,
  resolveChannelBindings,
} from '../elysia/channels';
import { clearProjectAuthConfigCache } from '../auth/config';
import { clearRuntimeChannelsCache } from '../channels/runtime';
import { deriveTelegramSecretToken } from '../channels/adapters/telegram';
import { clearConfigRefreshHooks } from '../config/refresh';
import { TimbalApiError } from '../lib/api';
import type { Timbal } from '../lib/timbal';
import type { ProjectChannelSpec } from '../types';
import type {
  ChannelAdapter,
  ChannelBinding,
  ChannelEvent,
  WebhookRequest,
} from '../channels/types';

/** Let detached (void-ed) processing settle. */
const settle = () => new Promise((r) => setTimeout(r, 10));

/** Default webhook path: /channels/{workforce}/{provider}. */
const channelPath = (workforce: string, provider = 'fake') =>
  `/channels/${workforce}/${provider}`;

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

describe('resolveBindingPath', () => {
  test('defaults to /{workforce}/{provider}', () => {
    const { adapter } = makeAdapter('telegram');
    expect(resolveBindingPath({ adapter, workforce: 'joi' })).toBe(
      '/channels/joi/telegram',
    );
  });

  test('explicit path overrides the default', () => {
    const { adapter } = makeAdapter('telegram');
    expect(
      resolveBindingPath({ adapter, workforce: 'joi', path: '/custom' }, '/hooks'),
    ).toBe('/hooks/custom');
  });
});

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

    const res = await post(app, channelPath('my-agent'), { id: 'e1', text: 'hi agent' });
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

    await post(app, channelPath('my-agent'), { id: 'e1', text: 'hi agent' });
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

    const res = await post(app, channelPath('a'), { text: 'x' }, false);
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

    await post(app, channelPath('a'), { id: 'same', text: 'first' });
    await post(app, channelPath('a'), { id: 'same', text: 'retry' });
    await post(app, channelPath('a'), { id: 'other', text: 'new' });
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

    await post(app, channelPath('a'), { id: 'same', text: 'hi' });
    await settle();
    expect(sent).toEqual(['temporary failure']);

    // Same dedupeKey — must not be dropped; claim was released on failure.
    await post(app, channelPath('a'), { id: 'same', text: 'hi' });
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

    await post(app, channelPath('a'), { id: 'same', text: 'hi' });
    await settle();
    expect(sent).toContain('partial answer');
    expect(sent).toContain('failed mid-stream');
    expect(attempts).toBe(1);

    // Redelivery must NOT re-invoke — something already reached the user.
    await post(app, channelPath('a'), { id: 'same', text: 'hi' });
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

    await post(app, channelPath('a'), { id: 'e1', text: 'first' });
    await settle();
    await post(app, channelPath('a'), { id: 'e2', text: 'second' });
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

    await post(app, channelPath('a'), { id: 'e1', text: 'yo' });
    await settle();

    expect(invocations[0]!.input).toEqual({ message: 'yo', session: 'conv-1' });
  });

  describe('attachments', () => {
    /**
     * Media-aware fake adapter: body is `{ id, text, files: [{name, type,
     * fail?}] }`; each file becomes an attachment whose download() yields
     * one byte per name char (or throws when `fail`).
     */
    function makeMediaAdapter() {
      const base = makeAdapter('media');
      const adapter: ChannelAdapter = {
        ...base.adapter,
        parse(req: WebhookRequest) {
          const body = JSON.parse(req.rawBody) as {
            id?: string;
            text?: string;
            files?: { name: string; type: string; fail?: boolean }[];
          };
          const attachments = (body.files ?? []).map((f) => ({
            kind: 'document' as const,
            fileName: f.name,
            contentType: f.type,
            async download() {
              if (f.fail) throw new Error(`download failed: ${f.name}`);
              return {
                data: new Uint8Array(f.name.length),
                contentType: f.type,
                fileName: f.name,
              };
            },
          }));
          const event: ChannelEvent = {
            provider: 'media',
            conversationId: 'conv-1',
            text: body.text ?? '',
            attachments: attachments.length > 0 ? attachments : undefined,
            dedupeKey: body.id ? `media:${body.id}` : undefined,
            raw: body,
          };
          return [event];
        },
      };
      return { ...base, adapter };
    }

    /** makeTimbal + a recording uploadTempFileFromBuffer. */
    function makeUploadingTimbal() {
      const { timbal, invocations } = makeTimbal(() => [
        { type: 'delta', delta: 'seen it' },
      ]);
      const uploads: { filename: string; contentType?: string; bytes: number }[] = [];
      (timbal as unknown as Record<string, unknown>).uploadTempFileFromBuffer =
        async (data: Uint8Array, filename: string, contentType?: string) => {
          uploads.push({ filename, contentType, bytes: data.byteLength });
          return { url: `https://cdn.test/tmp/${filename}` };
        };
      return { timbal, invocations, uploads };
    }

    test('uploads attachments and sends prompt content parts', async () => {
      const { adapter } = makeMediaAdapter();
      const { timbal, invocations, uploads } = makeUploadingTimbal();
      const app = new Elysia().use(
        timbalChannels({ timbal, bindings: [{ adapter, workforce: 'a' }] }),
      );

      await post(app, channelPath('a', 'media'), {
        id: 'e1',
        text: 'what does this say?',
        files: [{ name: 'scan.pdf', type: 'application/pdf' }],
      });
      await settle();

      expect(uploads).toEqual([
        { filename: 'scan.pdf', contentType: 'application/pdf', bytes: 8 },
      ]);
      expect(invocations[0]!.input).toEqual({
        prompt: [
          { type: 'text', text: 'what does this say?' },
          { type: 'file', file: 'https://cdn.test/tmp/scan.pdf' },
        ],
      });
    });

    test('bare attachment (no caption) sends a file-only prompt', async () => {
      const { adapter } = makeMediaAdapter();
      const { timbal, invocations } = makeUploadingTimbal();
      const app = new Elysia().use(
        timbalChannels({ timbal, bindings: [{ adapter, workforce: 'a' }] }),
      );

      await post(app, channelPath('a', 'media'), {
        id: 'e1',
        files: [{ name: 'pic.jpg', type: 'image/jpeg' }],
      });
      await settle();

      expect(invocations[0]!.input).toEqual({
        prompt: [{ type: 'file', file: 'https://cdn.test/tmp/pic.jpg' }],
      });
    });

    test('text-only events keep the legacy { prompt: text } shape', async () => {
      const { adapter } = makeMediaAdapter();
      const { timbal, invocations } = makeUploadingTimbal();
      const app = new Elysia().use(
        timbalChannels({ timbal, bindings: [{ adapter, workforce: 'a' }] }),
      );

      await post(app, channelPath('a', 'media'), { id: 'e1', text: 'plain' });
      await settle();

      expect(invocations[0]!.input).toEqual({ prompt: 'plain' });
    });

    test('a failed attachment is dropped, the rest still runs', async () => {
      const { adapter, sent } = makeMediaAdapter();
      const { timbal, invocations, uploads } = makeUploadingTimbal();
      const errors: unknown[] = [];
      const app = new Elysia().use(
        timbalChannels({
          timbal,
          bindings: [{ adapter, workforce: 'a' }],
          onError: (err) => errors.push(err),
        }),
      );

      await post(app, channelPath('a', 'media'), {
        id: 'e1',
        text: 'two files',
        files: [
          { name: 'huge.mov', type: 'video/quicktime', fail: true },
          { name: 'ok.pdf', type: 'application/pdf' },
        ],
      });
      await settle();

      expect(uploads.map((u) => u.filename)).toEqual(['ok.pdf']);
      expect(invocations[0]!.input).toEqual({
        prompt: [
          { type: 'text', text: 'two files' },
          { type: 'file', file: 'https://cdn.test/tmp/ok.pdf' },
        ],
      });
      // Drop is surfaced to the observer but the reply still lands.
      expect(errors).toHaveLength(1);
      expect(sent).toContain('seen it');
    });

    test('all attachments failing with no text hits the error path', async () => {
      const { adapter, sent } = makeMediaAdapter();
      const { timbal, invocations } = makeUploadingTimbal();
      const errors: unknown[] = [];
      const app = new Elysia().use(
        timbalChannels({
          timbal,
          bindings: [{ adapter, workforce: 'a' }],
          errorMessage: 'could not read your file',
          onError: (err) => errors.push(err),
        }),
      );

      await post(app, channelPath('a', 'media'), {
        id: 'e1',
        files: [{ name: 'broken.bin', type: 'application/octet-stream', fail: true }],
      });
      await settle();

      expect(invocations).toHaveLength(0);
      expect(errors).toHaveLength(1);
      expect(sent).toEqual(['could not read your file']);
    });
  });

  describe('outbound files', () => {
    /** makeAdapter + recording sendFile/delete on the delivery. */
    function makeFileAdapter() {
      const base = makeAdapter('fake');
      const sentFiles: { file: string; fileName?: string }[] = [];
      const deleted: unknown[] = [];
      const adapter: ChannelAdapter = {
        ...base.adapter,
        delivery(event) {
          const d = base.adapter.delivery(event);
          return {
            ...d,
            async sendFile(file: string, opts?: { fileName?: string }) {
              sentFiles.push({ file, fileName: opts?.fileName });
              return 'file-ref';
            },
            async delete(ref: unknown) {
              deleted.push(ref);
            },
          };
        },
      };
      return { ...base, adapter, sentFiles, deleted };
    }

    const outputWithFiles = (
      text: string | null,
      files: { file: string; name?: string }[],
    ) => [
      { type: 'START', run_id: 'r1' },
      {
        type: 'OUTPUT',
        run_id: 'r1',
        path: 'agent',
        output: {
          role: 'assistant',
          content: [
            ...(text ? [{ type: 'text', text }] : []),
            ...files.map((f) => ({ type: 'file', ...f })),
          ],
        },
      },
    ];

    test('reply files are sent after the text, in order', async () => {
      const { adapter, sent, sentFiles } = makeFileAdapter();
      const { timbal } = makeTimbal(() =>
        outputWithFiles('here you go', [
          { file: 'https://cdn.test/a.png', name: 'a.png' },
          { file: 'https://cdn.test/b.pdf', name: 'b.pdf' },
        ]),
      );
      const app = new Elysia().use(
        timbalChannels({ timbal, bindings: [{ adapter, workforce: 'a' }] }),
      );

      await post(app, channelPath('a'), { id: 'e1', text: 'make me a chart' });
      await settle();

      expect(sent).toEqual(['here you go']);
      expect(sentFiles).toEqual([
        { file: 'https://cdn.test/a.png', fileName: 'a.png' },
        { file: 'https://cdn.test/b.pdf', fileName: 'b.pdf' },
      ]);
    });

    test('a file-only reply still counts as delivered (session advances)', async () => {
      const { adapter, sent, sentFiles } = makeFileAdapter();
      const { timbal, invocations } = makeTimbal(() =>
        outputWithFiles(null, [{ file: 'https://cdn.test/a.png' }]),
      );
      const app = new Elysia().use(
        timbalChannels({ timbal, bindings: [{ adapter, workforce: 'a' }] }),
      );

      await post(app, channelPath('a'), { id: 'e1', text: 'chart please' });
      await settle();
      await post(app, channelPath('a'), { id: 'e2', text: 'another' });
      await settle();

      expect(sent).toHaveLength(0);
      expect(sentFiles).toHaveLength(2);
      // The silent-but-file-carrying first run must chain the second message.
      expect(invocations[1]!.ctx?.parentId).toBe('r1');
    });

    test('file-only reply after streamed deltas sends the file, not stale text', async () => {
      const { adapter, sent, sentFiles } = makeFileAdapter();
      const { timbal } = makeTimbal(() => [
        { type: 'START', run_id: 'r1' },
        { type: 'DELTA', run_id: 'r1', item: { type: 'text_delta', text_delta: 'pre-tool chatter' } },
        {
          type: 'OUTPUT',
          run_id: 'r1',
          path: 'agent',
          output: {
            role: 'assistant',
            content: [{ type: 'file', file: 'https://cdn.test/a.png', name: 'a.png' }],
          },
        },
      ]);
      const app = new Elysia().use(
        timbalChannels({ timbal, bindings: [{ adapter, workforce: 'a' }] }),
      );

      await post(app, channelPath('a'), { id: 'e1', text: 'chart please' });
      await settle();

      expect(sent).toHaveLength(0);
      expect(sentFiles).toEqual([{ file: 'https://cdn.test/a.png', fileName: 'a.png' }]);
    });

    test('streaming: interim text is retracted when the reply turns out file-only', async () => {
      const { adapter, sent, sentFiles, deleted } = makeFileAdapter();
      const { timbal } = makeTimbal(() => [
        { type: 'START', run_id: 'r1' },
        { type: 'DELTA', run_id: 'r1', item: { type: 'text_delta', text_delta: 'pre-tool chatter' } },
        {
          type: 'OUTPUT',
          run_id: 'r1',
          path: 'agent',
          output: {
            role: 'assistant',
            content: [{ type: 'file', file: 'https://cdn.test/a.png', name: 'a.png' }],
          },
        },
      ]);
      const app = new Elysia().use(
        timbalChannels({
          timbal,
          streaming: true,
          editIntervalMs: 0,
          bindings: [{ adapter, workforce: 'a' }],
        }),
      );

      await post(app, channelPath('a'), { id: 'e1', text: 'chart please' });
      await settle();

      // The delta was streamed out...
      expect(sent).toEqual(['pre-tool chatter']);
      // ...but retracted at finalize (the definitive reply has no text),
      // leaving only the file.
      expect(deleted).toEqual(['ref-1']);
      expect(sentFiles).toEqual([{ file: 'https://cdn.test/a.png', fileName: 'a.png' }]);
    });

    test('a run where every file is dropped releases the dedupe claim', async () => {
      const { adapter, sent } = makeAdapter(); // no sendFile
      const { timbal, invocations } = makeTimbal(() =>
        outputWithFiles(null, [{ file: 'data:image/png;base64,AAAA', name: 'gen.png' }]),
      );
      const errors: unknown[] = [];
      const app = new Elysia().use(
        timbalChannels({
          timbal,
          bindings: [{ adapter, workforce: 'a' }],
          onError: (err) => errors.push(err),
        }),
      );

      // Nothing reaches the user: no text, and the only file is a data URL
      // on a channel without sendFile.
      await post(app, channelPath('a'), { id: 'same', text: 'hi' });
      await settle();
      expect(sent).toHaveLength(0);
      expect(errors).toHaveLength(1);

      // The claim must be released — redelivery re-runs instead of being
      // swallowed by a run that produced nothing.
      await post(app, channelPath('a'), { id: 'same', text: 'hi' });
      await settle();
      expect(invocations).toHaveLength(2);
    });

    test('no sendFile: URL files degrade to a link message, data URLs are dropped', async () => {
      const { adapter, sent } = makeAdapter(); // no sendFile
      const { timbal } = makeTimbal(() =>
        outputWithFiles('done', [
          { file: 'https://cdn.test/a.png', name: 'a.png' },
          { file: 'data:image/png;base64,AAAA', name: 'gen.png' },
        ]),
      );
      const errors: unknown[] = [];
      const app = new Elysia().use(
        timbalChannels({
          timbal,
          bindings: [{ adapter, workforce: 'a' }],
          onError: (err) => errors.push(err),
        }),
      );

      await post(app, channelPath('a'), { id: 'e1', text: 'hi' });
      await settle();

      expect(sent).toEqual(['done', 'a.png: https://cdn.test/a.png']);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain('data URL');
    });

    test('sendFile failure after text lands posts the error notice and keeps dedupe', async () => {
      const base = makeAdapter();
      let attempts = 0;
      const parentIds: Array<string | undefined> = [];
      const adapter: ChannelAdapter = {
        ...base.adapter,
        delivery(event) {
          return {
            ...base.adapter.delivery(event),
            async sendFile() {
              throw new Error('file send exploded');
            },
          };
        },
      };
      const timbal = {
        workforce: {
          get() {
            return {
              async *events(
                _input: Record<string, unknown>,
                ctx?: { parentId?: string },
              ): AsyncGenerator<Record<string, unknown>> {
                attempts += 1;
                parentIds.push(ctx?.parentId);
                yield* outputWithFiles('text part', [{ file: 'https://cdn.test/a.png' }]);
              },
            };
          },
        },
      } as unknown as Timbal;
      const app = new Elysia().use(
        timbalChannels({
          timbal,
          bindings: [{ adapter, workforce: 'a' }],
          errorMessage: 'file failed',
        }),
      );

      await post(app, channelPath('a'), { id: 'same', text: 'hi' });
      await settle();
      expect(base.sent).toEqual(['text part', 'file failed']);

      // Text already reached the user — redelivery must not re-run.
      await post(app, channelPath('a'), { id: 'same', text: 'hi' });
      await settle();
      expect(attempts).toBe(1);

      // ...and the delivered text must have advanced session continuity,
      // even though the file send blew up afterwards.
      await post(app, channelPath('a'), { id: 'next', text: 'follow-up' });
      await settle();
      expect(parentIds).toEqual([undefined, 'r1']);
    });
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

    await post(app, channelPath('joi'), { id: 'e1', text: 'what time is it?' });
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

    await post(app, channelPath('joi'), { id: 'm1', text: 'first' });
    await settle();
    await post(app, channelPath('joi'), { id: 'm2', text: 'second' });
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

    await post(app, channelPath('joi'), { id: 'm1', text: 'first' });
    await settle();
    await post(app, channelPath('joi'), { id: 'm2', text: 'second' });
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

    await post(app, channelPath('a'), { id: 'e1', text: 'q' });
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

    const res = await post(app, channelPath('a'), { id: 'e1', text: 'q' });
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
      'https://app.example.com/channels/a/telegramish',
    ]);
    expect(withoutHook.registered).toHaveLength(0);

    expect(result.origin).toBe('https://app.example.com');
    expect(result.registrations).toEqual([
      {
        provider: 'telegramish',
        workforce: 'a',
        url: 'https://app.example.com/channels/a/telegramish',
        registered: true,
      },
      {
        provider: 'slackish',
        workforce: 'b',
        url: 'https://app.example.com/channels/b/slackish',
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

    expect(registered).toEqual(['https://from-env.example.com/channels/a/tg']);
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

  test('registerChannelWebhooks derives platform origin from TIMBAL_PROJECT_ENV_ID', async () => {
    const { adapter, registered } = makeAdapter('tg');
    const result = await registerChannelWebhooks({
      bindings: [{ adapter, workforce: 'joi' }],
      env: {
        TIMBAL_PROJECT_ID: '248',
        TIMBAL_PROJECT_ENV_ID: '1755',
      },
      fetchImpl: (async () => {
        throw new Error('must not probe ngrok');
      }) as unknown as typeof fetch,
    });

    expect(result.origin).toBe('https://e1755.deployments.timbal.ai/api');
    expect(registered).toEqual([
      'https://e1755.deployments.timbal.ai/api/channels/joi/tg',
    ]);
  });
});

/**
 * Fake platform-linked Timbal: `getProject` returns the given project (or
 * rejects), with a unique org/project cache key per instance so the shared
 * auth-config cache never leaks across tests.
 *
 * `runtime` models `GET .../channels/runtime`:
 * - omitted → 404 (older platform, falls back to the project payload)
 * - array → the runtime channel specs (may carry `credentials`)
 * - Error → endpoint failure (5xx/network)
 * The returned array is read live, so tests can mutate it between calls.
 */
let fakeProjectCounter = 0;
function makePlatformTimbal(
  project: Record<string, unknown> | Error,
  runtime?: ProjectChannelSpec[] | Error,
) {
  const projectId = `test-proj-${++fakeProjectCounter}`;
  let fetches = 0;
  let runtimeFetches = 0;
  const timbal = {
    apiClient: {
      getConfig: () => ({ orgId: 'test-org', projectId, token: 'svc-secret' }),
      async get() {
        runtimeFetches += 1;
        if (runtime === undefined) throw new TimbalApiError('Not Found', 404);
        if (runtime instanceof Error) throw runtime;
        return { data: { channels: runtime }, success: true, statusCode: 200 };
      },
    },
    async getProject() {
      fetches += 1;
      if (project instanceof Error) throw project;
      return project;
    },
  } as unknown as Timbal;
  return {
    timbal,
    fetchCount: () => fetches,
    runtimeFetchCount: () => runtimeFetches,
  };
}

describe('resolveChannelBindings', () => {
  afterEach(() => {
    clearProjectAuthConfigCache();
    clearRuntimeChannelsCache();
  });

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

  test('runtime endpoint drives bindings with platform-held creds — zero channel env vars', async () => {
    const { timbal, fetchCount } = makePlatformTimbal(
      new Error('project payload must not be needed'),
      [
        {
          provider: 'telegram',
          workforce: 'platform-target',
          credentials: { token: '999:platform-token' },
        },
      ],
    );
    const bindings = await resolveChannelBindings(timbal, {
      env: { TIMBAL_PROJECT_ID: '248' }, // no TELEGRAM_*, no CHANNELS_WORKFORCE
    });
    expect(bindings.map((b) => [b.adapter.provider, b.workforce])).toEqual([
      ['telegram', 'platform-target'],
    ]);
    expect(fetchCount()).toBe(0);
  });

  test('per-spec platform creds beat env convention vars', async () => {
    const { timbal } = makePlatformTimbal({}, [
      {
        provider: 'telegram',
        workforce: 'joi',
        credentials: { token: '999:platform-token' },
      },
    ]);
    const [binding] = await resolveChannelBindings(timbal, { env: TG_ENV });
    // The adapter's webhook secret is derived from its bot token, so verify()
    // tells us which token won.
    const verifyWith = (token: string) =>
      binding!.adapter.verify({
        headers: new Headers({
          'x-telegram-bot-api-secret-token': deriveTelegramSecretToken(token),
        }),
        rawBody: '{}',
        url: 'https://x.test/channels/joi/telegram',
      });
    expect(verifyWith('999:platform-token')).toBe('ok');
    expect(verifyWith(TG_ENV.TELEGRAM_BOT_TOKEN)).not.toBe('ok');
  });

  test('runtime spec without creds falls back to env vars per-spec', async () => {
    const { timbal } = makePlatformTimbal({}, [
      { provider: 'telegram', workforce: 'joi', credentials: null },
    ]);
    const bindings = await resolveChannelBindings(timbal, { env: TG_ENV });
    expect(bindings.map((b) => [b.adapter.provider, b.workforce])).toEqual([
      ['telegram', 'joi'],
    ]);
  });

  test('runtime empty array is authoritative: all off, even with env creds present', async () => {
    const { timbal } = makePlatformTimbal({}, []);
    const bindings = await resolveChannelBindings(timbal, { env: TG_ENV });
    expect(bindings).toEqual([]);
  });

  test('two telegram bindings route to different workforces with per-binding tokens', async () => {
    const { timbal } = makePlatformTimbal(new Error('unused'), [
      { provider: 'telegram', workforce: 'joi', credentials: { token: '111:bot-a' } },
      { provider: 'telegram', workforce: 'ada', credentials: { token: '222:bot-b' } },
    ]);
    const bindings = await resolveChannelBindings(timbal, {
      env: { TIMBAL_PROJECT_ID: '248' },
    });
    expect(bindings.map((b) => b.workforce)).toEqual(['joi', 'ada']);
    const verifies = (b: ChannelBinding, token: string) =>
      b.adapter.verify({
        headers: new Headers({
          'x-telegram-bot-api-secret-token': deriveTelegramSecretToken(token),
        }),
        rawBody: '{}',
        url: 'https://x.test/',
      }) === 'ok';
    expect(verifies(bindings[0]!, '111:bot-a')).toBe(true);
    expect(verifies(bindings[1]!, '222:bot-b')).toBe(true);
    expect(verifies(bindings[0]!, '222:bot-b')).toBe(false);
  });

  test('runtime endpoint failure falls back to project payload topology + env creds', async () => {
    const { timbal } = makePlatformTimbal(
      { channels: [{ provider: 'telegram', workforce: 'platform-target' }] },
      new TimbalApiError('boom', 500),
    );
    const bindings = await resolveChannelBindings(timbal, { env: TG_ENV });
    expect(bindings.map((b) => b.workforce)).toEqual(['platform-target']);
  });

  test('OLDER platform (runtime 404): project.channels topology + env creds', async () => {
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
  afterEach(() => {
    clearProjectAuthConfigCache();
    clearRuntimeChannelsCache();
    clearConfigRefreshHooks();
  });

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
      new Request('http://localhost/channels/joi/telegram', {
        method: 'POST',
        body: '{}',
      }),
    );
    expect(unauthorized.status).toBe(401);

    // Good secret → acked.
    const ok = await app.handle(
      new Request('http://localhost/channels/joi/telegram', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'shh' },
        body: JSON.stringify({ update_id: 1 }),
      }),
    );
    expect(ok.status).toBe(200);

    // Slack is NOT in the platform config → 404.
    const unknown = await app.handle(
      new Request('http://localhost/channels/joi/slack', {
        method: 'POST',
        body: '{}',
      }),
    );
    expect(unknown.status).toBe(404);

    // Wrong workforce for a known provider → 404 (one binding per pair).
    const wrongWf = await app.handle(
      new Request('http://localhost/channels/other-agent/telegram', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'shh' },
        body: JSON.stringify({ update_id: 3 }),
      }),
    );
    expect(wrongWf.status).toBe(404);
  });

  test('channelSpecs override skips the platform entirely', async () => {
    const app = new Elysia().use(
      timbalChannels({
        timbal: makePlatformTimbal(new Error('must not be fetched')).timbal,
        channelSpecs: [{ provider: 'telegram', workforce: 'joi' }],
        env: {
          // Linked without env-id → origin null; skip ngrok probe on mount provision.
          TIMBAL_PROJECT_ID: '248',
          TELEGRAM_BOT_TOKEN: '123:abc',
          TELEGRAM_SECRET_TOKEN: 'shh',
        },
      }),
    );

    const res = await app.handle(
      new Request('http://localhost/channels/joi/telegram', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': 'shh' },
        body: JSON.stringify({ update_id: 2 }),
      }),
    );
    expect(res.status).toBe(200);
  });
});
