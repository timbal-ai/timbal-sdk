/**
 * Hardening suite for the hand-rolled MCP transport: the deliberate price of
 * not shipping `@modelcontextprotocol/sdk` as a runtime dependency is that
 * these edge cases are ours to prove — JSON-RPC id quirks, Unicode and
 * encoding round-trips, argument collisions and routing, concurrency, and
 * malformed inputs a real client (or a fuzzer) could send.
 */
import { describe, test, expect } from 'bun:test';
import { Elysia, t } from 'elysia';
import { timbalMcp } from '../elysia/mcp';

async function post(app: Elysia, payload: unknown, headers: Record<string, string> = {}) {
  return app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    })
  );
}

async function rpc(
  app: Elysia,
  method: string,
  params?: Record<string, unknown>,
  id: string | number = 1
) {
  const res = await post(app, { jsonrpc: '2.0', id, method, params });
  return res.json() as Promise<Record<string, any>>;
}

const echoApp = () =>
  new Elysia()
    .use(timbalMcp({ include: ['T'] }))
    .get('/echo/:name', ({ params }) => params.name, { detail: { tags: ['T'] } })
    .post('/mix/:id', ({ params, query, body }) => ({ params, query, body }), {
      body: t.Object({ id: t.String(), note: t.Optional(t.String()) }),
      query: t.Object({ id: t.Optional(t.String()) }),
      detail: { tags: ['T'] },
    });

describe('JSON-RPC edge cases', () => {
  test('id 0 is a request, not a notification, and is echoed back', async () => {
    const res = await post(echoApp(), { jsonrpc: '2.0', id: 0, method: 'ping' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(0);
    expect(body.result).toEqual({});
  });

  test('string ids and large numeric ids round-trip', async () => {
    const app = echoApp();
    expect((await rpc(app, 'ping', undefined, 'req-abc')).id).toBe('req-abc');
    expect((await rpc(app, 'ping', undefined, 2 ** 40)).id).toBe(2 ** 40);
  });

  test('missing jsonrpc field is tolerated (lenient parse)', async () => {
    const res = await post(echoApp(), { id: 1, method: 'ping' });
    expect(((await res.json()) as Record<string, unknown>).result).toEqual({});
  });

  test('initialize with no params still answers with the latest protocol', async () => {
    const { result } = await rpc(echoApp(), 'initialize');
    expect(result.protocolVersion).toBe('2025-06-18');
  });

  test('tools/call with no arguments object defaults to {}', async () => {
    const app = new Elysia()
      .use(timbalMcp({ include: ['T'] }))
      .get('/noargs', () => 'ok', { detail: { tags: ['T'] } });
    const { result } = await rpc(app, 'tools/call', { name: 'get_noargs' });
    expect(result.content[0].text).toBe('ok');
  });

  test('non-object params on tools/call are rejected, not crashed on', async () => {
    const res = await post(echoApp(), {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: 'not-an-object',
    });
    const body = (await res.json()) as Record<string, any>;
    expect(body.error.code).toBe(-32602);
  });

  test('empty body, empty object, and deeply nested junk do not 500', async () => {
    const app = echoApp();
    for (const payload of ['', '{}', { jsonrpc: '2.0', id: 1, method: { nested: [] } }]) {
      const res = await post(app, payload);
      // JSON-RPC errors or notification acks, never transport 5xx.
      // ('{}' has no id → correctly treated as a notification → 202.)
      expect([200, 202]).toContain(res.status);
    }
  });
});

describe('argument routing', () => {
  test('unicode path params survive the encode/dispatch/decode round-trip', async () => {
    const { result } = await rpc(echoApp(), 'tools/call', {
      name: 'get_echo_name',
      arguments: { name: 'héllo wörld — 你好 🎉' },
    });
    expect(result.content[0].text).toBe('héllo wörld — 你好 🎉');
  });

  test('path params containing slashes cannot escape their segment', async () => {
    const { result } = await rpc(echoApp(), 'tools/call', {
      name: 'get_echo_name',
      arguments: { name: 'a/b' },
    });
    // encodeURIComponent keeps the value in one segment; the route decodes it.
    expect(result.content[0].text).toBe('a/b');
    expect(result.isError).toBeUndefined();
  });

  test('name collisions route each suffixed argument to its own location', async () => {
    const { result } = await rpc(echoApp(), 'tools/call', {
      name: 'post_mix_id',
      arguments: { id: 'path-v', id__query: 'query-v', id__body: 'body-v', note: 'n' },
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      params: { id: 'path-v' },
      query: { id: 'query-v' },
      body: { id: 'body-v', note: 'n' },
    });
  });

  test('unknown extra arguments are dropped, not smuggled into the body', async () => {
    const { result } = await rpc(echoApp(), 'tools/call', {
      name: 'post_mix_id',
      arguments: { id: 'p', id__body: 'b', hacker_field: 'nope' },
    });
    const body = JSON.parse(result.content[0].text).body as Record<string, unknown>;
    expect(body).toEqual({ id: 'b' });
    expect('hacker_field' in body).toBe(false);
  });

  test('array query params append one entry per value', async () => {
    const app = new Elysia()
      .use(timbalMcp({ include: ['T'] }))
      .get('/tags', ({ request }) => new URL(request.url).searchParams.getAll('tag').join(','), {
        query: t.Object({ tag: t.Optional(t.Array(t.String())) }),
        detail: { tags: ['T'] },
      });
    const { result } = await rpc(app, 'tools/call', {
      name: 'get_tags',
      arguments: { tag: ['a', 'b', 'c'] },
    });
    expect(result.content[0].text).toBe('a,b,c');
  });

  test('non-object bodies surface and dispatch as a single raw `body` argument', async () => {
    const app = new Elysia()
      .use(timbalMcp({ include: ['T'] }))
      .post('/sum', ({ body }) => (body as number[]).reduce((a, b) => a + b, 0).toString(), {
        body: t.Array(t.Number()),
        detail: { tags: ['T'] },
      });
    const list = await rpc(app, 'tools/list');
    const tool = (list.result.tools as Record<string, any>[])[0]!;
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['body']);
    expect(tool.inputSchema.required).toEqual(['body']);

    const { result } = await rpc(app, 'tools/call', {
      name: 'post_sum',
      arguments: { body: [1, 2, 3] },
    });
    expect(result.content[0].text).toBe('6');
  });
});

describe('robustness', () => {
  test('20 concurrent tool calls all resolve with their own results', async () => {
    const app = echoApp();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        rpc(app, 'tools/call', { name: 'get_echo_name', arguments: { name: `n${i}` } }, i)
      )
    );
    results.forEach((r, i) => {
      expect(r.id).toBe(i);
      expect(r.result.content[0].text).toBe(`n${i}`);
    });
  });

  test('tool call responses are valid UTF-8 JSON even for binary-ish route output', async () => {
    const app = new Elysia()
      .use(timbalMcp({ include: ['T'] }))
      .get('/bin', () => new Response(new Uint8Array([0xff, 0xfe, 0x00, 0x41])), {
        detail: { tags: ['T'] },
      });
    const res = await post(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_bin', arguments: {} },
    });
    // Must parse — invalid UTF-8 got replaced, not passed through raw.
    const body = (await res.json()) as Record<string, any>;
    expect(typeof body.result.content[0].text).toBe('string');
  });

  test('a throwing route handler becomes an isError result, not a transport failure', async () => {
    const app = new Elysia().use(timbalMcp({ include: ['T'] })).get(
      '/explode',
      () => {
        throw new Error('kaboom');
      },
      { detail: { tags: ['T'] } }
    );
    const { result } = await rpc(app, 'tools/call', { name: 'get_explode', arguments: {} });
    expect(result.isError).toBe(true);
  });

  test('tool names never contain characters outside [a-zA-Z0-9_-]', async () => {
    const app = new Elysia()
      .use(timbalMcp({ include: ['T'] }))
      .get('/v1.2/some.thing/:id', () => 'x', { detail: { tags: ['T'] } })
      .get('/weird~path/(group)', () => 'y', { detail: { tags: ['T'] } });
    const { result } = await rpc(app, 'tools/list');
    for (const tool of result.tools as { name: string }[]) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  test('duplicate derived names get deterministic numeric suffixes', async () => {
    const app = new Elysia()
      .use(timbalMcp({ include: ['T'] }))
      .get('/a_b', () => '1', { detail: { tags: ['T'] } })
      .get('/a/b', () => '2', { detail: { tags: ['T'] } });
    const { result } = await rpc(app, 'tools/list');
    const names = (result.tools as { name: string }[]).map(t => t.name).sort();
    expect(names).toEqual(['get_a_b', 'get_a_b_2']);
  });
});
