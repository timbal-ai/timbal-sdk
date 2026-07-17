import { Elysia } from 'elysia';
import { SDK_VERSION } from '../constants';

/**
 * Per-route MCP metadata, set on the route's `detail`:
 *
 * ```ts
 * .post("/workforce/:id/run", handler, {
 *   detail: {
 *     tags: ["Workforce"],
 *     mcp: { name: "run_workforce", description: "Run a workforce agent" },
 *   },
 * })
 * ```
 *
 * Presence of `mcp` opts the route in even when no `include` tag matches;
 * `mcp: false` opts it out unconditionally. Agent tools want intent-shaped
 * names and descriptions, not REST paths — auto-generation from the route is
 * the default, curated overrides here are what agents actually see.
 */
export interface McpRouteMeta {
  /** Tool name (`[a-zA-Z0-9_-]`). Defaults to `{method}_{path segments}`. */
  name?: string;
  /** Tool description. Defaults to `detail.description` / `detail.summary`. */
  description?: string;
}

declare module 'elysia' {
  interface DocumentDecoration {
    /** Expose this route as an MCP tool (see {@link McpRouteMeta}), or `false` to exclude. */
    mcp?: McpRouteMeta | boolean;
  }
}

export interface TimbalMcpOptions {
  /**
   * Swagger tags whose routes become tools. Opt-in on purpose: a naïve
   * expose-everything dump puts `/healthcheck`, `/docs`, and multipart upload
   * routes in the tool list. Routes carrying `detail.mcp` metadata are
   * included regardless of tags.
   */
  include?: string[];
  /** Endpoint path for the MCP transport. @default '/mcp' */
  path?: string;
  /** `serverInfo.name` reported on `initialize`. @default 'timbal-app' */
  serverName?: string;
  /** `serverInfo.version` reported on `initialize`. Defaults to the SDK version. */
  serverVersion?: string;
  /** Optional `instructions` string returned from `initialize`. */
  instructions?: string;
}

/** Protocol revisions this transport accepts, newest first. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Where a flattened tool argument lands on the underlying HTTP request. */
interface ArgRoute {
  in: 'path' | 'query' | 'body';
  /** Original property key at the destination (tool arg may be suffixed on collision). */
  key: string;
}

interface ToolBinding {
  name: string;
  description: string;
  method: string;
  path: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  args: Record<string, ArgRoute>;
  /** `object` = body composed from flattened args; `raw` = single `body` arg passed through. */
  bodyMode: 'object' | 'raw' | 'none';
}

// Loose view over Elysia's InternalRoute — `hooks` is untyped there anyway.
interface RouteLike {
  method: string;
  path: string;
  hooks?: {
    detail?: Record<string, unknown>;
    body?: unknown;
    query?: unknown;
    params?: unknown;
  };
}

const TOOL_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** TypeBox schemas are JSON Schema — serialization strips symbols/functions. */
function toJsonSchema(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== 'object') return null;
  try {
    return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function deriveToolName(method: string, path: string): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map(s => (s.startsWith(':') ? s.slice(1) : s));
  return sanitizeToolName([method.toLowerCase(), ...segments].join('_'));
}

function pathParamNames(path: string): string[] {
  return path
    .split('/')
    .filter(s => s.startsWith(':'))
    .map(s => s.slice(1));
}

/**
 * Map one route to a tool. Path params, query properties, and body properties
 * flatten into a single argument object (agents deal in one flat schema, not
 * HTTP anatomy). Collisions are rare and resolved deterministically with
 * `__query` / `__body` suffixes; non-object bodies surface as a `body` arg.
 */
function buildToolBinding(route: RouteLike, name: string, description: string): ToolBinding {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const args: Record<string, ArgRoute> = {};

  const claim = (key: string, source: ArgRoute['in']): string => {
    let argName = key;
    if (argName in properties) argName = `${key}__${source}`;
    args[argName] = { in: source, key };
    return argName;
  };

  const paramsSchema = toJsonSchema(route.hooks?.params);
  const paramsProps = (paramsSchema?.properties ?? {}) as Record<string, unknown>;
  for (const param of pathParamNames(route.path)) {
    const argName = claim(param, 'path');
    properties[argName] = paramsProps[param] ?? { type: 'string' };
    required.push(argName);
  }

  const querySchema = toJsonSchema(route.hooks?.query);
  if (querySchema?.properties) {
    const queryRequired = new Set((querySchema.required as string[] | undefined) ?? []);
    for (const [key, prop] of Object.entries(querySchema.properties as Record<string, unknown>)) {
      const argName = claim(key, 'query');
      properties[argName] = prop;
      if (queryRequired.has(key)) required.push(argName);
    }
  }

  let bodyMode: ToolBinding['bodyMode'] = 'none';
  const bodySchema =
    route.method === 'GET' || route.method === 'HEAD' ? null : toJsonSchema(route.hooks?.body);
  if (bodySchema) {
    if (bodySchema.type === 'object' && bodySchema.properties) {
      bodyMode = 'object';
      const bodyRequired = new Set((bodySchema.required as string[] | undefined) ?? []);
      for (const [key, prop] of Object.entries(bodySchema.properties as Record<string, unknown>)) {
        const argName = claim(key, 'body');
        properties[argName] = prop;
        if (bodyRequired.has(key)) required.push(argName);
      }
    } else {
      bodyMode = 'raw';
      const argName = claim('body', 'body');
      properties[argName] = bodySchema;
      required.push(argName);
    }
  }

  return {
    name,
    description,
    method: route.method,
    path: route.path,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    args,
    bodyMode,
  };
}

export interface DeriveMcpToolsOptions {
  include?: string[];
  /** The transport's own endpoint, always excluded. */
  mcpPath?: string;
}

/**
 * Derive the MCP tool set from an Elysia route table. Exported for tests and
 * for apps that want to inspect what they're exposing.
 *
 * Selection is opt-in: a route becomes a tool when its `detail.tags`
 * intersect `include`, or when it carries explicit `detail.mcp` metadata.
 * `detail.mcp: false` always wins; `detail.hide: true` routes (hidden from
 * swagger, e.g. webhook internals) need explicit `mcp` metadata to appear.
 */
export function deriveMcpTools(
  routes: RouteLike[],
  options: DeriveMcpToolsOptions = {}
): ToolBinding[] {
  const include = options.include ?? [];
  const tools: ToolBinding[] = [];
  const takenNames = new Set<string>();

  for (const route of routes) {
    if (!TOOL_METHODS.has(route.method)) continue;
    if (options.mcpPath && route.path === options.mcpPath) continue;

    const detail = route.hooks?.detail as
      | (Record<string, unknown> & { mcp?: McpRouteMeta | boolean })
      | undefined;
    const meta = detail?.mcp;
    if (meta === false) continue;

    const hasMeta = meta !== undefined;
    const tags = (detail?.tags as string[] | undefined) ?? [];
    const tagMatch = include.length > 0 && tags.some(t => include.includes(t));
    if (!hasMeta && !tagMatch) continue;
    if (detail?.hide === true && !hasMeta) continue;

    const metaObj = typeof meta === 'object' ? meta : undefined;
    let name = sanitizeToolName(metaObj?.name ?? deriveToolName(route.method, route.path));
    if (takenNames.has(name)) {
      let i = 2;
      while (takenNames.has(`${name}_${i}`)) i++;
      name = `${name}_${i}`;
    }
    takenNames.add(name);

    const description =
      metaObj?.description ??
      (detail?.description as string | undefined) ??
      (detail?.summary as string | undefined) ??
      `${route.method} ${route.path}`;

    tools.push(buildToolBinding(route, name, description));
  }

  return tools;
}

/** Build the internal HTTP request a tool call maps to. */
function buildToolRequest(
  binding: ToolBinding,
  rawArgs: Record<string, unknown>,
  origin: string,
  incoming: Request
): Request {
  let path = binding.path;
  const url = new URL(origin);
  const bodyObject: Record<string, unknown> = {};
  let rawBody: unknown;
  let hasBody = false;

  for (const [argName, route] of Object.entries(binding.args)) {
    const value = rawArgs[argName];
    if (value === undefined) continue;
    switch (route.in) {
      case 'path':
        path = path.replace(`:${route.key}`, encodeURIComponent(String(value)));
        break;
      case 'query':
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(route.key, String(v));
        } else {
          url.searchParams.set(route.key, String(value));
        }
        break;
      case 'body':
        hasBody = true;
        if (binding.bodyMode === 'raw') rawBody = value;
        else bodyObject[route.key] = value;
        break;
    }
  }

  url.pathname = path;

  const headers = new Headers();
  // Token-in → tool-call-as-HTTP-with-that-auth. The MCP caller's identity is
  // the identity every tool call runs as; the target route's own auth
  // middleware re-validates it. No second auth system.
  const auth = incoming.headers.get('authorization');
  if (auth) headers.set('authorization', auth);
  const cookie = incoming.headers.get('cookie');
  if (cookie) headers.set('cookie', cookie);

  let body: string | undefined;
  if (hasBody && binding.method !== 'GET' && binding.method !== 'HEAD') {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(binding.bodyMode === 'raw' ? rawBody : bodyObject);
  }

  return new Request(url.toString(), { method: binding.method, headers, body });
}

function jsonRpcResult(id: string | number | null, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): Response {
  return Response.json({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

/**
 * Elysia plugin that exposes the app's own routes as MCP tools over the
 * Streamable HTTP transport (single stateless JSON-RPC endpoint, JSON
 * responses — no sessions, no server-initiated streams).
 *
 * Routes are discovered live from the mounted app, so `.use(timbalMcp())`
 * order doesn't matter and routes registered later still appear. Tool calls
 * are dispatched back through the app's own router: every hook, guard, and
 * validator on the target route runs exactly as it would for a plain HTTP
 * call, with the MCP caller's `Authorization` header forwarded.
 *
 * **Auth:** the endpoint sits behind `timbalAuth` ingress like any other
 * route — MCP clients authenticate with the same Timbal bearer/API-key the
 * HTTP API uses. There is deliberately no MCP-specific auth layer.
 *
 * ```ts
 * import { timbalAuth, timbalMcp } from "@timbal-ai/timbal-sdk/elysia";
 *
 * const app = new Elysia()
 *   .use(timbalAuth())
 *   .use(timbalMcp({ include: ["Workforce"] })) // opt-in by swagger tag
 *   .post("/workforce/:id/run", handler, {
 *     body: t.Object({ prompt: t.String() }),
 *     detail: {
 *       tags: ["Workforce"],
 *       // curated override — this is the name/description agents see
 *       mcp: { name: "run_workforce", description: "Run a workforce agent" },
 *     },
 *   })
 *   .listen(3000);
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function timbalMcp(options: TimbalMcpOptions = {}): any {
  const path = options.path ?? '/mcp';
  const serverInfo = {
    name: options.serverName ?? 'timbal-app',
    version: options.serverVersion ?? SDK_VERSION,
  };

  const plugin = new Elysia({ name: 'timbal-mcp' });

  /** Root app instance — set on mount via Elysia's getParent chain. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function resolveRoot(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur: any = plugin;
    const seen = new Set<unknown>();
    while (typeof cur.getParent === 'function') {
      const parent = cur.getParent();
      if (!parent || parent === cur || seen.has(parent)) break;
      seen.add(parent);
      cur = parent;
    }
    return cur;
  }

  function currentTools(): ToolBinding[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = plugin as any;
    const routes: RouteLike[] =
      typeof p.getGlobalRoutes === 'function' ? p.getGlobalRoutes() : p.routes;
    return deriveMcpTools(routes, { include: options.include, mcpPath: path });
  }

  async function callTool(
    toolName: string,
    args: Record<string, unknown>,
    incoming: Request
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean } | null> {
    const binding = currentTools().find(t => t.name === toolName);
    if (!binding) return null;

    const origin = new URL(incoming.url).origin;
    const request = buildToolRequest(binding, args, origin, incoming);
    try {
      const response: Response = await resolveRoot().handle(request);
      const text = await response.text();
      return {
        content: [{ type: 'text', text }],
        ...(response.ok ? {} : { isError: true }),
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }

  async function handleMessage(message: JsonRpcMessage, request: Request): Promise<Response> {
    const id = message.id ?? null;

    // Notification (no id): acknowledge, nothing to do — we're stateless.
    if (message.id === undefined) return new Response(null, { status: 202 });

    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion as string | undefined;
        const protocolVersion =
          requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[0];
        return jsonRpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo,
          ...(options.instructions ? { instructions: options.instructions } : {}),
        });
      }
      case 'ping':
        return jsonRpcResult(id, {});
      case 'tools/list':
        return jsonRpcResult(id, {
          tools: currentTools().map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case 'tools/call': {
        const toolName = message.params?.name;
        if (typeof toolName !== 'string') {
          return jsonRpcError(id, -32602, 'Missing tool name');
        }
        const args = (message.params?.arguments as Record<string, unknown> | undefined) ?? {};
        const result = await callTool(toolName, args, request);
        if (!result) return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
        return jsonRpcResult(id, result);
      }
      default:
        return jsonRpcError(id, -32601, `Method not found: ${message.method}`);
    }
  }

  plugin.post(
    path,
    async ({ request }: { request: Request }) => {
      let message: JsonRpcMessage;
      try {
        message = (await request.json()) as JsonRpcMessage;
      } catch {
        return jsonRpcError(null, -32700, 'Parse error');
      }
      // JSON-RPC batching was removed in protocol 2025-06-18; keep the
      // transport simple and reject arrays outright.
      if (Array.isArray(message) || typeof message !== 'object' || message === null) {
        return jsonRpcError(null, -32600, 'Invalid request');
      }
      return handleMessage(message, request);
    },
    { detail: { hide: true } }
  );

  // Stateless transport: no server-initiated SSE stream, no sessions.
  plugin.get(path, () => new Response(null, { status: 405 }), { detail: { hide: true } });
  plugin.delete(path, () => new Response(null, { status: 405 }), { detail: { hide: true } });

  return plugin;
}
