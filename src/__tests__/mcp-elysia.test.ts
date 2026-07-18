import { describe, test, expect } from 'bun:test';
import { Elysia, t } from 'elysia';
import { timbalMcp, deriveMcpTools } from '../elysia/mcp';

let nextId = 1;
async function rpc(
  app: Elysia,
  method: string,
  params?: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  const res = await app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
    })
  );
  return res.json() as Promise<{
    id: number;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  }>;
}

function workforceApp() {
  return new Elysia()
    .use(timbalMcp({ include: ['Workforce'] }))
    .post('/workforce/:id/run', ({ params, query, body }) => ({ params, query, body }), {
      body: t.Object({ prompt: t.String({ description: 'The prompt' }) }),
      query: t.Object({ verbose: t.Optional(t.String()) }),
      detail: {
        tags: ['Workforce'],
        summary: 'Run a workforce',
        mcp: { name: 'run_workforce', description: 'Run a workforce agent with a prompt' },
      },
    })
    .get('/workforce/:id', ({ params }) => ({ id: params.id, name: 'joi' }), {
      detail: { tags: ['Workforce'] },
    })
    .get('/healthcheck', () => 'ok')
    .get('/docs', () => 'swagger', { detail: { tags: ['Docs'] } });
}

describe('deriveMcpTools', () => {
  const routesOf = (app: Elysia) =>
    app.routes.map(r => ({ method: r.method, path: r.path, hooks: r.hooks as never }));

  test('opt-in by tag; untagged and non-matching routes excluded', () => {
    const tools = deriveMcpTools(routesOf(workforceApp()), {
      include: ['Workforce'],
      mcpPath: '/mcp',
    });
    expect(tools.map(t => t.name).sort()).toEqual(['get_workforce_id', 'run_workforce']);
  });

  test('nothing exposed without include or explicit mcp metadata', () => {
    const app = new Elysia().get('/a', () => 'a', { detail: { tags: ['A'] } });
    expect(deriveMcpTools(routesOf(app))).toEqual([]);
  });

  test('detail.mcp opts a route in without a tag match; mcp:false opts out', () => {
    const app = new Elysia()
      .get('/in', () => 'in', { detail: { mcp: { name: 'custom_in' } } })
      .get('/out', () => 'out', { detail: { tags: ['Workforce'], mcp: false } });
    const tools = deriveMcpTools(routesOf(app), { include: ['Workforce'] });
    expect(tools.map(t => t.name)).toEqual(['custom_in']);
  });

  test('hidden routes need explicit mcp metadata', () => {
    const app = new Elysia()
      .post('/webhook', () => 'x', { detail: { tags: ['Workforce'], hide: true } })
      .post('/visible-hidden', () => 'y', { detail: { hide: true, mcp: { name: 'shown' } } });
    const tools = deriveMcpTools(routesOf(app), { include: ['Workforce'] });
    expect(tools.map(t => t.name)).toEqual(['shown']);
  });

  test('flattens path, query, and body into one input schema', () => {
    const tools = deriveMcpTools(routesOf(workforceApp()), { include: ['Workforce'] });
    const run = tools.find(t => t.name === 'run_workforce')!;
    expect(run.inputSchema.properties).toContainKeys(['id', 'verbose', 'prompt']);
    expect(run.inputSchema.required).toEqual(['id', 'prompt']);
    expect(run.description).toBe('Run a workforce agent with a prompt');
  });

  test('derives names from method + path when no override', () => {
    const tools = deriveMcpTools(routesOf(workforceApp()), { include: ['Workforce'] });
    expect(tools.some(t => t.name === 'get_workforce_id')).toBe(true);
  });
});

describe('timbalMcp transport', () => {
  test('initialize reports tools capability and server info', async () => {
    const { result } = await rpc(workforceApp(), 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    expect(result!.protocolVersion).toBe('2025-06-18');
    expect(result!.capabilities).toEqual({ tools: {} });
    expect((result!.serverInfo as { name: string }).name).toBe('timbal-app');
  });

  test('unknown protocol version falls back to latest supported', async () => {
    const { result } = await rpc(workforceApp(), 'initialize', {
      protocolVersion: '1999-01-01',
    });
    expect(result!.protocolVersion).toBe('2025-06-18');
  });

  test('tools/list discovers routes registered after .use(timbalMcp())', async () => {
    const { result } = await rpc(workforceApp(), 'tools/list');
    const tools = result!.tools as { name: string; inputSchema: Record<string, unknown> }[];
    expect(tools.map(t => t.name).sort()).toEqual(['get_workforce_id', 'run_workforce']);
  });

  test('tools/call dispatches through the app router with args in place', async () => {
    const { result } = await rpc(workforceApp(), 'tools/call', {
      name: 'run_workforce',
      arguments: { id: 'joi', prompt: 'hello', verbose: 'yes' },
    });
    const content = result!.content as { type: string; text: string }[];
    expect(result!.isError).toBeUndefined();
    expect(JSON.parse(content[0]!.text)).toEqual({
      params: { id: 'joi' },
      query: { verbose: 'yes' },
      body: { prompt: 'hello' },
    });
  });

  test('tools/call surfaces route validation failures as isError', async () => {
    const { result } = await rpc(workforceApp(), 'tools/call', {
      name: 'run_workforce',
      arguments: { id: 'joi' }, // missing required prompt
    });
    expect(result!.isError).toBe(true);
  });

  test('tools/call forwards the Authorization header to the route', async () => {
    const app = new Elysia()
      .use(timbalMcp({ include: ['T'] }))
      .get('/whoami', ({ request }) => request.headers.get('authorization') ?? 'none', {
        detail: { tags: ['T'] },
      });
    const { result } = await rpc(
      app,
      'tools/call',
      { name: 'get_whoami', arguments: {} },
      { authorization: 'Bearer tok-123' }
    );
    const content = result!.content as { text: string }[];
    expect(content[0]!.text).toBe('Bearer tok-123');
  });

  test('unknown tool and unknown method return JSON-RPC errors', async () => {
    const app = workforceApp();
    const unknownTool = await rpc(app, 'tools/call', { name: 'nope', arguments: {} });
    expect(unknownTool.error!.code).toBe(-32602);
    const unknownMethod = await rpc(app, 'resources/list');
    expect(unknownMethod.error!.code).toBe(-32601);
  });

  test('notifications are acknowledged with 202', async () => {
    const res = await workforceApp().handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      })
    );
    expect(res.status).toBe(202);
  });

  test('malformed and batch payloads are rejected', async () => {
    const app = workforceApp();
    const bad = await app.handle(
      new Request('http://localhost/mcp', { method: 'POST', body: 'not json' })
    );
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32700);
    const batch = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
      })
    );
    expect(((await batch.json()) as { error: { code: number } }).error.code).toBe(-32600);
  });

  test('GET/DELETE on the endpoint are 405 (stateless transport)', async () => {
    const app = workforceApp();
    expect((await app.handle(new Request('http://localhost/mcp'))).status).toBe(405);
    expect(
      (await app.handle(new Request('http://localhost/mcp', { method: 'DELETE' }))).status
    ).toBe(405);
  });

  test('rejects cross-origin browser requests, allows same-origin and allowlisted', async () => {
    const post = (app: Elysia, url: string, origin?: string) =>
      app.handle(
        new Request(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(origin ? { origin } : {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        })
      );

    const app = workforceApp();
    expect((await post(app, 'http://localhost/mcp', 'http://evil.com')).status).toBe(403);
    expect((await post(app, 'http://localhost/mcp', 'http://localhost')).status).toBe(200);
    expect((await post(app, 'http://localhost/mcp')).status).toBe(200); // non-browser, no Origin
    // Same host, different scheme is still cross-origin.
    expect((await post(app, 'https://localhost/mcp', 'http://localhost')).status).toBe(403);

    const allowlisted = new Elysia().use(
      timbalMcp({ allowedOrigins: ['https://studio.acme.com'] })
    );
    expect(
      (await post(allowlisted, 'http://localhost/mcp', 'https://studio.acme.com')).status
    ).toBe(200);
  });

  test('declares outputSchema from the response schema and returns structuredContent', async () => {
    const app = new Elysia()
      .use(timbalMcp({ include: ['T'] }))
      .get('/answer', () => ({ answer: 42 }), {
        response: t.Object({ answer: t.Number() }),
        detail: { tags: ['T'] },
      });

    const list = await rpc(app, 'tools/list');
    const tool = (list.result!.tools as Record<string, unknown>[])[0]!;
    expect((tool.outputSchema as { type: string }).type).toBe('object');

    const call = await rpc(app, 'tools/call', { name: 'get_answer', arguments: {} });
    expect(call.result!.structuredContent).toEqual({ answer: 42 });
  });

  test('no outputSchema when the route declares none or a non-object one', async () => {
    const app = new Elysia()
      .use(timbalMcp({ include: ['T'] }))
      .get('/plain', () => 'text', { detail: { tags: ['T'] } })
      .get('/num', () => 3, { response: t.Number(), detail: { tags: ['T'] } });
    const { result } = await rpc(app, 'tools/list');
    for (const tool of result!.tools as Record<string, unknown>[]) {
      expect(tool.outputSchema).toBeUndefined();
    }
  });

  test('oversized results are truncated with a marker', async () => {
    const app = new Elysia()
      .use(timbalMcp({ include: ['T'], maxResultBytes: 100 }))
      .get('/big', () => 'x'.repeat(500), { detail: { tags: ['T'] } });
    const { result } = await rpc(app, 'tools/call', { name: 'get_big', arguments: {} });
    const text = (result!.content as { text: string }[])[0]!.text;
    expect(text).toStartWith('x'.repeat(100));
    expect(text).toContain('[truncated 400 of 500 bytes]');
  });

  test('truncation is byte-accurate for multibyte content and never splits a character', async () => {
    // '€' is 3 bytes in UTF-8 — 200 of them is 600 bytes, but only 200
    // UTF-16 code units, so a naive String.slice(0, 100) would keep 300 bytes.
    const app = new Elysia()
      .use(timbalMcp({ include: ['T'], maxResultBytes: 100 }))
      .get('/euros', () => '€'.repeat(200), { detail: { tags: ['T'] } });
    const { result } = await rpc(app, 'tools/call', { name: 'get_euros', arguments: {} });
    const text = (result!.content as { text: string }[])[0]!.text;

    const body = text.slice(0, text.indexOf('\n'));
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(100);
    expect(body).toBe('€'.repeat(33)); // 99 bytes — backed off the 100-byte mid-character cut
    expect(text).toContain('[truncated 501 of 600 bytes]');
    expect(body).not.toInclude('\uFFFD'); // no mangled character at the cut point
  });

  test('onToolCall observes successes, errors, and never breaks the transport', async () => {
    const calls: { tool: string; status: number | null; isError: boolean }[] = [];
    const app = new Elysia()
      .use(
        timbalMcp({
          include: ['T'],
          onToolCall: info => {
            calls.push({ tool: info.tool, status: info.status, isError: info.isError });
            throw new Error('observer bug'); // must not surface
          },
        })
      )
      .get('/ok', () => 'fine', { detail: { tags: ['T'] } })
      .get('/boom', () => new Response('nope', { status: 500 }), { detail: { tags: ['T'] } });

    const ok = await rpc(app, 'tools/call', { name: 'get_ok', arguments: {} });
    expect(ok.result!.isError).toBeUndefined();
    const boom = await rpc(app, 'tools/call', { name: 'get_boom', arguments: {} });
    expect(boom.result!.isError).toBe(true);

    expect(calls).toEqual([
      { tool: 'get_ok', status: 200, isError: false },
      { tool: 'get_boom', status: 500, isError: true },
    ]);
  });

  test('streams SSE with progress heartbeats when the client accepts SSE + sends progressToken', async () => {
    const app = new Elysia().use(timbalMcp({ include: ['T'], progressIntervalMs: 20 })).get(
      '/slow',
      async () => {
        await new Promise(r => setTimeout(r, 90));
        return 'finally';
      },
      { detail: { tags: ['T'] } }
    );

    const res = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'get_slow', arguments: {}, _meta: { progressToken: 'tok-1' } },
        }),
      })
    );
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const frames = (await res.text())
      .split('\n\n')
      .filter(f => f.includes('data: '))
      .map(f => JSON.parse(f.split('data: ')[1]!) as Record<string, any>);

    const progress = frames.filter(f => f.method === 'notifications/progress');
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.every(p => p.params.progressToken === 'tok-1')).toBe(true);
    // Progress values strictly increase, per spec.
    const values = progress.map(p => p.params.progress as number);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(new Set(values).size).toBe(values.length);

    const final = frames.at(-1)!;
    expect(final.id).toBe(7);
    expect(final.result.content[0].text).toBe('finally');
  });

  test('Accept media type matching is case-insensitive for SSE mode', async () => {
    const app = new Elysia()
      .use(timbalMcp({ include: ['T'], progressIntervalMs: 20 }))
      .get('/slow', () => 'ok', { detail: { tags: ['T'] } });

    const res = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'APPLICATION/JSON, TEXT/EVENT-STREAM',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_slow', arguments: {}, _meta: { progressToken: 1 } },
        }),
      })
    );
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });

  test('falls back to plain JSON without SSE accept or without progressToken', async () => {
    const app = workforceApp();
    const body = (extra: Record<string, unknown>) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_workforce_id', arguments: { id: 'x' }, ...extra },
      });

    // progressToken but no SSE accept
    const noAccept = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body({ _meta: { progressToken: 1 } }),
      })
    );
    expect(noAccept.headers.get('content-type')).toContain('application/json');

    // SSE accept but no progressToken
    const noToken = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: body({}),
      })
    );
    expect(noToken.headers.get('content-type')).toContain('application/json');
  });

  test('streamed unknown tool ends with a JSON-RPC error frame', async () => {
    const res = await workforceApp().handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'nope', arguments: {}, _meta: { progressToken: 2 } },
        }),
      })
    );
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const frames = (await res.text())
      .split('\n\n')
      .filter(f => f.includes('data: '))
      .map(f => JSON.parse(f.split('data: ')[1]!) as Record<string, any>);
    expect(frames.at(-1)!.error.code).toBe(-32602);
  });

  test('CORS: preflight and responses carry allow-origin for permitted origins only', async () => {
    const app = new Elysia().use(timbalMcp({ allowedOrigins: ['https://studio.acme.com'] }));

    // Preflight from an allowlisted origin
    const preflight = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://studio.acme.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type, authorization',
        },
      })
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://studio.acme.com');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');

    // Preflight from a forbidden origin
    const forbidden = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'OPTIONS',
        headers: { origin: 'http://evil.com', 'access-control-request-method': 'POST' },
      })
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('access-control-allow-origin')).toBeNull();

    // Actual POST response echoes the allowed origin
    const res = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://studio.acme.com',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      })
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('https://studio.acme.com');
    expect(res.headers.get('vary')).toBe('Origin');

    // No Origin header (non-browser client) → no CORS headers added
    const plain = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      })
    );
    expect(plain.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('wildcard routes are never exposed as tools', async () => {
    const app = new Elysia()
      .use(timbalMcp({ include: ['T'] }))
      .get('/files/*', () => 'file', { detail: { tags: ['T'] } })
      .get('/ok', () => 'ok', { detail: { tags: ['T'] } });
    const { result } = await rpc(app, 'tools/list');
    expect((result!.tools as { name: string }[]).map(t => t.name)).toEqual(['get_ok']);
  });

  test('custom path and server identity', async () => {
    const app = new Elysia().use(
      timbalMcp({ path: '/tools/mcp', serverName: 'blueprint', serverVersion: '1.2.3' })
    );
    const res = await app.handle(
      new Request('http://localhost/tools/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      })
    );
    const { result } = (await res.json()) as { result: { serverInfo: Record<string, string> } };
    expect(result.serverInfo).toEqual({ name: 'blueprint', version: '1.2.3' });
  });
});
