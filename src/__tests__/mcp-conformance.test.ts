/**
 * Conformance tests: the official `@modelcontextprotocol/sdk` client
 * (devDependency only — never shipped) speaks to `timbalMcp()` over a real
 * localhost socket. Our transport is hand-rolled, so this is the guard
 * against drifting from what real MCP clients (Claude, Cursor, mcp-remote)
 * actually send: initialize lifecycle, notifications, Accept headers, tool
 * result shapes.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Elysia, t } from 'elysia';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { timbalMcp } from '../elysia/mcp';

let app: Elysia;
let url: URL;

beforeAll(() => {
  app = new Elysia()
    .use(timbalMcp({ include: ['Workforce'], instructions: 'App tools for tests' }))
    .post('/workforce/:id/run', ({ params, body }) => ({ id: params.id, echo: body.prompt }), {
      body: t.Object({ prompt: t.String({ description: 'The prompt' }) }),
      detail: {
        tags: ['Workforce'],
        mcp: { name: 'run_workforce', description: 'Run a workforce agent' },
      },
    })
    .get('/whoami', ({ request }) => request.headers.get('authorization') ?? 'anonymous', {
      detail: { mcp: { name: 'whoami', description: 'Echo the auth header' } },
    })
    .get('/answer/:n', ({ params }) => ({ answer: Number(params.n), source: 'test' }), {
      response: t.Object({ answer: t.Number(), source: t.String() }),
      detail: { mcp: { name: 'get_answer', description: 'Structured output route' } },
    })
    .get('/healthcheck', () => 'ok')
    .listen(0);
  url = new URL(`http://localhost:${app.server!.port}/mcp`);
});

afterAll(() => {
  app.stop();
});

async function connect(headers?: Record<string, string>) {
  const client = new Client({ name: 'conformance-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(transport);
  return client;
}

describe('MCP conformance (official SDK client)', () => {
  test('connect completes the initialize lifecycle', async () => {
    const client = await connect();
    expect(client.getServerVersion()?.name).toBe('timbal-app');
    expect(client.getServerCapabilities()?.tools).toEqual({});
    expect(client.getInstructions()).toBe('App tools for tests');
    await client.close();
  });

  test('listTools returns the opted-in routes with valid schemas', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['get_answer', 'run_workforce', 'whoami']);

    const run = tools.find(t => t.name === 'run_workforce')!;
    expect(run.description).toBe('Run a workforce agent');
    expect(run.inputSchema.type).toBe('object');
    expect(run.inputSchema.properties).toContainKeys(['id', 'prompt']);
    expect(run.inputSchema.required).toEqual(['id', 'prompt']);
    await client.close();
  });

  test('callTool dispatches through the route and returns text content', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'run_workforce',
      arguments: { id: 'joi', prompt: 'hello' },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as { type: string; text: string }[];
    expect(content[0]!.type).toBe('text');
    expect(JSON.parse(content[0]!.text)).toEqual({ id: 'joi', echo: 'hello' });
    await client.close();
  });

  test('callTool forwards the transport auth headers to the route', async () => {
    const client = await connect({ authorization: 'Bearer conformance-token' });
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    const content = result.content as { text: string }[];
    expect(content[0]!.text).toBe('Bearer conformance-token');
    await client.close();
  });

  test('validation failure surfaces as a tool error, not a protocol error', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'run_workforce',
      arguments: { id: 'joi' }, // missing required `prompt`
    });
    expect(result.isError).toBe(true);
    await client.close();
  });

  test('unknown tool is a JSON-RPC error the client rejects with', async () => {
    const client = await connect();
    expect(client.callTool({ name: 'does_not_exist', arguments: {} })).rejects.toThrow();
    await client.close();
  });

  test('structuredContent validates against the declared outputSchema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'get_answer')!;
    expect(tool.outputSchema).toBeDefined();

    // The official client validates structuredContent against outputSchema
    // and throws on mismatch — resolving cleanly IS the conformance check.
    const result = await client.callTool({ name: 'get_answer', arguments: { n: 7 } });
    expect(result.structuredContent).toEqual({ answer: 7, source: 'test' });
    await client.close();
  });

  test('ping round-trips', async () => {
    const client = await connect();
    await expect(client.ping()).resolves.toBeDefined();
    await client.close();
  });
});
