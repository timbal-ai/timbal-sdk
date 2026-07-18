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
  /**
   * Origins (e.g. `https://studio.example.com`) allowed to reach the
   * endpoint from a browser, in addition to same-host requests. Requests
   * carrying a cross-origin `Origin` header are rejected with 403 — the
   * Streamable HTTP spec requires this to block DNS-rebinding attacks
   * against local dev servers. Non-browser MCP clients send no `Origin`
   * and are unaffected.
   */
  allowedOrigins?: string[];
  /**
   * Cap on a tool result's text content, in bytes. Oversized responses are
   * truncated with a marker instead of silently flooding the agent's
   * context window. @default 102400 (100 KiB)
   */
  maxResultBytes?: number;
  /** Observer for tool calls (logging/metrics). Errors never reach the transport. */
  onToolCall?(info: ToolCallInfo): void;
  /**
   * Interval between `notifications/progress` heartbeats during a streamed
   * `tools/call`, ms. Streaming engages when the client accepts
   * `text/event-stream` and supplies a `progressToken` (the official SDK
   * does both whenever an `onprogress` callback is passed); the heartbeats
   * reset client-side request timeouts, so long workforce runs survive the
   * default 60s limit. @default 15000
   */
  progressIntervalMs?: number;
}

/** Outcome of one `tools/call`, reported to {@link TimbalMcpOptions.onToolCall}. */
export interface ToolCallInfo {
  tool: string;
  args: Record<string, unknown>;
  /** HTTP status of the dispatched request, or `null` when dispatch threw. */
  status: number | null;
  durationMs: number;
  isError: boolean;
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
  /** JSON Schema of the 200 response, when the route declares an object one. */
  outputSchema?: Record<string, unknown>;
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
    response?: unknown;
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
 * The route's 200-response schema, when it's a JSON object — that's the only
 * shape MCP `structuredContent` accepts. Elysia stores `response` either as a
 * bare schema or as a status→schema record.
 */
function deriveOutputSchema(route: RouteLike): Record<string, unknown> | undefined {
  const raw = route.hooks?.response;
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string | number, unknown>;
  const candidate = 200 in record || '200' in record ? (record[200] ?? record['200']) : raw;
  const schema = toJsonSchema(candidate);
  return schema?.type === 'object' ? schema : undefined;
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

  const outputSchema = deriveOutputSchema(route);
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
    ...(outputSchema ? { outputSchema } : {}),
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
    // Wildcard segments have no argument to fill them — there is no sane
    // tool mapping for `/files/*`. Expose a purpose-built route instead.
    if (route.path.includes('*')) continue;

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
    // JSON null has no URL representation — treat it as absent for path and
    // query args rather than emitting the literal string "null". Body args
    // keep null: it's meaningful JSON the route's validator can judge.
    if (value === null && route.in !== 'body') continue;
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
  // Object-mode routes always get a JSON body, even `{}` when every field is
  // optional and the agent sent none — the route's validator expects an
  // object, and a bodyless POST would fail validation spuriously. Raw mode
  // only sends when the (required) `body` arg was actually provided.
  const sendBody = binding.bodyMode === 'object' || hasBody;
  if (sendBody && binding.method !== 'GET' && binding.method !== 'HEAD') {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(binding.bodyMode === 'raw' ? rawBody : bodyObject);
  }

  return new Request(url.toString(), { method: binding.method, headers, body });
}

/**
 * Truncate to a UTF-8 byte budget. A `String.slice` would count UTF-16 code
 * units — up to 3–4 bytes each — letting multibyte content blow past the cap
 * and potentially cutting a surrogate pair in half. Slicing the encoded bytes
 * and backing off to a sequence boundary (continuation bytes are `0b10xxxxxx`)
 * keeps the budget exact and the output valid UTF-8.
 */
function truncateUtf8(
  text: string,
  maxBytes: number
): { text: string; byteLength: number; keptBytes: number; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) {
    return { text, byteLength: bytes.length, keptBytes: bytes.length, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return {
    text: new TextDecoder().decode(bytes.subarray(0, end)),
    byteLength: bytes.length,
    keptBytes: end,
    truncated: true,
  };
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
    // getGlobalRoutes is the live root route table. On Elysia versions
    // without it, walk getParent to the root app — the plugin's own `routes`
    // would contain only the /mcp transport itself, deriving an empty tool
    // set while dispatch (which already uses the root) still worked.
    const routes: RouteLike[] =
      typeof p.getGlobalRoutes === 'function' ? p.getGlobalRoutes() : (resolveRoot().routes ?? []);
    return deriveMcpTools(routes, { include: options.include, mcpPath: path });
  }

  const maxResultBytes = options.maxResultBytes ?? 100 * 1024;

  function report(info: ToolCallInfo): void {
    try {
      options.onToolCall?.(info);
    } catch {
      /* observer must not take down the transport */
    }
  }

  interface ToolResult {
    content: { type: 'text'; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }

  async function callTool(
    toolName: string,
    args: Record<string, unknown>,
    incoming: Request
  ): Promise<ToolResult | null> {
    const binding = currentTools().find(t => t.name === toolName);
    if (!binding) return null;

    // Validate required args before dispatch. A missing path param would
    // otherwise leave a literal `:id` segment in the URL and dispatch to a
    // wrong route or a bare 404 — an agent can't self-correct from that,
    // but it can from an explicit missing-argument error.
    const missing = (binding.inputSchema.required ?? []).filter(name => {
      const value = args[name];
      if (value === undefined) return true;
      // null is treated as absent everywhere except JSON bodies.
      return value === null && binding.args[name]?.in !== 'body';
    });
    if (missing.length > 0) {
      report({ tool: toolName, args, status: null, durationMs: 0, isError: true });
      return {
        content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }],
        isError: true,
      };
    }

    const origin = new URL(incoming.url).origin;
    const request = buildToolRequest(binding, args, origin, incoming);
    const started = Date.now();
    try {
      const response: Response = await resolveRoot().handle(request);
      const text = await response.text();

      // Cap before it reaches the agent — an unbounded list dump silently
      // eats the context window. The marker tells the agent (and the user
      // reading the transcript) that data is missing rather than exhaustive.
      const {
        text: cappedText,
        byteLength,
        keptBytes,
        truncated,
      } = truncateUtf8(text, maxResultBytes);
      const finalText = truncated
        ? `${cappedText}\n… [truncated ${byteLength - keptBytes} of ${byteLength} bytes]`
        : text;

      // structuredContent only when the tool declared an outputSchema (the
      // spec then requires it on success) and the payload is intact — a
      // truncated result must not masquerade as valid structured output.
      let structuredContent: Record<string, unknown> | undefined;
      if (binding.outputSchema && response.ok && !truncated) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            structuredContent = parsed as Record<string, unknown>;
          }
        } catch {
          /* non-JSON despite a response schema — text content stands alone */
        }
      }

      const isError = !response.ok;
      report({
        tool: toolName,
        args,
        status: response.status,
        durationMs: Date.now() - started,
        isError,
      });
      return {
        content: [{ type: 'text', text: finalText }],
        ...(structuredContent ? { structuredContent } : {}),
        ...(isError ? { isError: true } : {}),
      };
    } catch (err) {
      report({
        tool: toolName,
        args,
        status: null,
        durationMs: Date.now() - started,
        isError: true,
      });
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
            ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
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

  /**
   * SSE response mode of Streamable HTTP, for `tools/call` only: emit
   * `notifications/progress` heartbeats while the dispatched route runs,
   * then the JSON-RPC response, then close. Progress is a plain counter —
   * its job is resetting client request timeouts (the official SDK's
   * default is 60s, reset-on-progress), not conveying completion percentage.
   * A client that disconnects mid-call stops receiving events; the tool
   * call itself runs to completion server-side.
   */
  function streamToolCall(
    id: string | number,
    toolName: string,
    args: Record<string, unknown>,
    progressToken: string | number,
    request: Request
  ): Response {
    const encoder = new TextEncoder();
    const intervalMs = options.progressIntervalMs ?? 15_000;
    let interval: ReturnType<typeof setInterval> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        let closed = false;
        const send = (msg: unknown): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(msg)}\n\n`));
          } catch {
            closed = true; // client went away — finish the call, drop the events
          }
        };

        let progress = 0;
        interval = setInterval(() => {
          send({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken, progress: ++progress },
          });
        }, intervalMs);

        void (async () => {
          const result = await callTool(toolName, args, request);
          if (interval) clearInterval(interval);
          if (result) {
            send({ jsonrpc: '2.0', id, result });
          } else {
            send({
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: `Unknown tool: ${toolName}` },
            });
          }
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              /* already closed by the client */
            }
          }
        })();
      },
      cancel: () => {
        if (interval) clearInterval(interval);
      },
    });

    return new Response(stream, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    });
  }

  /**
   * Streamable HTTP requires Origin validation (DNS-rebinding defense: a
   * malicious page must not drive a victim's browser into `localhost:3000/mcp`,
   * which the legacy local-dev auth bypass would otherwise let straight
   * through). Non-browser MCP clients send no Origin and pass untouched.
   */
  function originAllowed(request: Request): boolean {
    const origin = request.headers.get('origin');
    if (!origin) return true;
    if (options.allowedOrigins?.includes(origin)) return true;
    try {
      // Full origin (scheme + host + port), not just host — http:// and
      // https:// on the same hostname are cross-origin in browsers.
      return new URL(origin).origin === new URL(request.url).origin;
    } catch {
      return false; // e.g. `Origin: null` (sandboxed iframe) — reject
    }
  }

  /**
   * CORS for browser-based MCP clients: gating alone isn't enough — an
   * allowlisted (or same-host) origin still needs `Access-Control-Allow-*`
   * on the actual responses, or the browser blocks the fetch it just
   * preflighted. Credentials are allowed because the origin is echoed only
   * when it passed the gate, never wildcarded.
   */
  function withCors(response: Response, request: Request): Response {
    const origin = request.headers.get('origin');
    if (!origin || !originAllowed(request)) return response;
    response.headers.set('access-control-allow-origin', origin);
    response.headers.set('access-control-allow-credentials', 'true');
    response.headers.set('vary', 'Origin');
    return response;
  }

  plugin.options(
    path,
    ({ request }: { request: Request }) => {
      if (!originAllowed(request)) return new Response(null, { status: 403 });
      const requestedHeaders = request.headers.get('access-control-request-headers');
      return withCors(
        new Response(null, {
          status: 204,
          headers: {
            'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
            'access-control-allow-headers':
              requestedHeaders ??
              'content-type, authorization, mcp-protocol-version, mcp-session-id, last-event-id',
            'access-control-max-age': '86400',
          },
        }),
        request
      );
    },
    { detail: { hide: true } }
  );

  plugin.post(
    path,
    async ({ request }: { request: Request }) => {
      if (!originAllowed(request)) return new Response('Forbidden origin', { status: 403 });
      let message: JsonRpcMessage;
      try {
        message = (await request.json()) as JsonRpcMessage;
      } catch {
        return withCors(jsonRpcError(null, -32700, 'Parse error'), request);
      }
      // JSON-RPC batching was removed in protocol 2025-06-18; keep the
      // transport simple and reject arrays outright.
      if (Array.isArray(message) || typeof message !== 'object' || message === null) {
        return withCors(jsonRpcError(null, -32600, 'Invalid request'), request);
      }

      // Stream the response only when the client both accepts SSE and asked
      // for progress (a progressToken without SSE has nowhere to deliver;
      // SSE without a token gains nothing over plain JSON here).
      if (
        message.method === 'tools/call' &&
        message.id !== undefined &&
        message.id !== null &&
        typeof message.params?.name === 'string' &&
        (request.headers.get('accept') ?? '').toLowerCase().includes('text/event-stream')
      ) {
        const meta = message.params._meta as { progressToken?: string | number } | undefined;
        if (meta?.progressToken !== undefined) {
          const args = (message.params.arguments as Record<string, unknown> | undefined) ?? {};
          return withCors(
            streamToolCall(
              message.id,
              message.params.name as string,
              args,
              meta.progressToken,
              request
            ),
            request
          );
        }
      }

      return withCors(await handleMessage(message, request), request);
    },
    { detail: { hide: true } }
  );

  // Stateless transport: no server-initiated SSE stream, no sessions.
  plugin.get(
    path,
    ({ request }: { request: Request }) => withCors(new Response(null, { status: 405 }), request),
    { detail: { hide: true } }
  );
  plugin.delete(
    path,
    ({ request }: { request: Request }) => withCors(new Response(null, { status: 405 }), request),
    { detail: { hide: true } }
  );

  return plugin;
}
