# Timbal JavaScript SDK

Official TypeScript/JavaScript SDK for the [Timbal](https://timbal.ai) platform.

## Installation

```bash
npm install @timbal-ai/timbal-sdk
```

## Quick Start

```typescript
import Timbal from "@timbal-ai/timbal-sdk";

const timbal = new Timbal();
// Picks up TIMBAL_API_KEY, TIMBAL_ORG_ID, etc. from the environment
// or from `timbal configure` — see Configuration at the bottom.

// Query a knowledge base
const kb = timbal.kbs.get(process.env.TIMBAL_KB_ID!);
const { rows } = await kb.query("SELECT * FROM orders LIMIT 10");

// Call a workforce agent
const res = await timbal.callWorkforce("my-agent", { message: "Hello!" });
const data = await res.json();
```

## Knowledge Bases

`timbal.kbs.get(id)` is **synchronous** — it returns a scoped `KB` view without a network call. Use it to query, inspect schema, and manage files inside one KB.

```typescript
const kb = timbal.kbs.get(process.env.TIMBAL_KB_ID!);

await kb.query("SELECT * FROM orders WHERE status = $1", ["pending"]);
await kb.schema(); // [{ table_name, columns: [...] }]

// list KBs in the org (first page)
const all = await timbal.kbs.list();

// walk every KB across pages
for await (const kb of timbal.kbs.iterate()) {
  console.log(kb.name, kb.id);
}

// multi-KB without global state — each get() is a fresh, isolated view
const [a, b] = await Promise.all([
  timbal.kbs.get("162").query("..."),
  timbal.kbs.get("222").query("..."),
]);
```

### KB files

Distinct from temporary files (`timbal.uploadTempFile` below). KB files carry `metadata`, live under a virtual `directory`, and are parsed + embedded by the platform pipeline.

```typescript
const file = await kb.files.upload(buffer, "order.pdf", {
  directory: "orders",
  metadata: { source: "cron", sha256: "deadbeef" },
  parse: false, // skip parse+embed when the KB is a typed metadata store
});

const page = await kb.files.list({ directory: "orders" });
// { files: [...], next_page_token? }

for await (const f of kb.files.iterate({ directory: "orders" })) {
  await process(f);
}

const one = await kb.files.get(file.id);
await kb.files.delete(file.id);
```

Typed errors let consumers branch without sniffing status codes:

```typescript
import { KbFileAlreadyExistsError, KbFileNotFoundError } from "@timbal-ai/timbal-sdk";

try {
  await kb.files.upload(buf, "order.pdf", { directory: "orders" });
} catch (err) {
  if (err instanceof KbFileAlreadyExistsError) {
    // idempotent cron retry: file already registered, no-op
  }
}
```

### Escape hatch

`apiClient` is public. Construct a `KB` view directly when you need to bypass the `Timbal` wrapper (custom retry policy, pooled clients, tests):

```typescript
import { KB } from "@timbal-ai/timbal-sdk";

const kb = new KB(timbal.apiClient, "162");
```

## Workforce

`timbal.workforce.get(identifier)` is **synchronous** — it returns a scoped `Workforce` view without a network call. `identifier` is a numeric id, uid, or name; resolution to a deployment URL happens lazily on the first `call` / `stream` / `events` and is cached per `orgId:projectId:rev`. Singular `workforce` because it's already the collection noun in Timbal (holds agents, workflows, tools).

```typescript
const items = await timbal.workforce.list();

const wf = timbal.workforce.get("my-agent");

// JSON call
const res = await wf.call({ message: "Hello!" });
const data = await res.json();

// Resolved deployment metadata (id, uid, name, type, url). Shares the
// list cache with call() / stream() — free if you'll dispatch anyway.
const info = await wf.info();
console.log(`hitting ${info.url} (rev ${info.uid})`);
```

### Streaming

Two shapes — raw `Response` for power use, typed async iterator for the happy path:

```typescript
// Typed iterator: parsed SSE payloads, buffered across chunk boundaries.
for await (const ev of wf.events({ message: "Hello!" })) {
  if (ev.type === "delta") process.stdout.write(String(ev.delta));
}

// Or raw Response when you need the underlying body.
const res = await wf.stream({ message: "Hello!" });
```

`events()` yields `Record<string, unknown>` — the exact shape is component-specific. Key off your known fields (`type`, `delta`, `output`, etc.). `[DONE]` sentinels and comment/heartbeat lines are filtered out.

### Cache

Invalidate the cached workforce list when deployments change mid-session:

```typescript
timbal.workforce.clearCache();
```

### Escape hatch

Construct a `Workforce` view directly when you need to bypass the `Timbal` wrapper:

```typescript
import { Workforce } from "@timbal-ai/timbal-sdk";

const wf = new Workforce(timbal.apiClient, "my-agent");
```

> **Deprecated:** `timbal.listWorkforces` / `callWorkforce` / `streamWorkforce` / `clearWorkforceCache` still work and delegate to the same backing functions. New code should use the section above.

## Files

Short-lived binary handoff for agents and workflows. Hits the stateless `POST /files` endpoint — no org scope, no DB row, signed URL expires in ~24h. For durable, parsed, searchable storage use `kb.files.upload` instead.

```typescript
const tmp = await timbal.uploadTempFile("/path/to/report.pdf");
// { name, url, content_type, content_length, created_at, expires_at }

await timbal.callWorkforce("summarize", { file_url: tmp.url });

// or from a buffer
const fromBuf = await timbal.uploadTempFileFromBuffer(
  buffer,
  "report.pdf",
  "application/pdf",
);
```

> **Deprecated:** `timbal.uploadFile` / `timbal.uploadFileFromBuffer` hit an undocumented org-bucket route. They still work and now return `{ id: string, ... }` (numeric IDs are coerced at the boundary), but new code should pick between `uploadTempFile` and `kb.files.upload`.

## Session & Project

```typescript
const session = await timbal.getSession();
// { user_id, user_name, user_email, access_level, ... }

const project = await timbal.getProject();
// { id, name, description, workforce, ... }
```

Validate a token **and** fetch project access in a single round trip:

```typescript
const { session, project } = await timbal.as(token).getSession({ projectId: "56" });
// 401 → invalid token. 403 → valid token but no access to that project.
```

## Scoped clients

`as()` returns a new `Timbal` bound to a different token (or other config overrides). Useful for per-request user-scoped clients in a server.

```typescript
const userTimbal = timbal.as(userAccessToken);
const session = await userTimbal.getSession();

// or override multiple fields
const other = timbal.as({ token: "...", orgId: "other-org" });
```

## Elysia Auth Plugin

Drop-in authentication for [Elysia](https://elysiajs.com) apps. Adds login pages, OAuth, magic link, token refresh, cookie management, and route guarding with a single line:

```typescript
import { Elysia } from "elysia";
import { timbalAuth } from "@timbal-ai/timbal-sdk/elysia";

const app = new Elysia()
  .use(timbalAuth())
  .get("/", () => "Hello!")
  .listen(3000);
```

Registers:
- `GET /auth/login` — built-in login page with OAuth + magic link
- `GET /auth/:provider` — OAuth redirect (github, google, microsoft)
- `GET /auth/callback` — OAuth callback handler
- `POST /auth/set-token` — validate token and set httpOnly cookie
- `POST /auth/magic-link` — send passwordless login email
- `POST /auth/refresh` — refresh access token
- `POST /auth/logout` — clear cookie and redirect

All other routes are protected automatically. The middleware injects `token`, `timbal` (a user-scoped SDK instance), `session`, and `project` into every route handler — resolved in a single platform call per request:

```typescript
app.get("/me", ({ session, project }) => ({ session, project }));
```

### Options

```typescript
app.use(timbalAuth({
  afterLoginRedirect: "/",   // where to go after login (default: "/")
  publicPaths: ["/webhook"], // extra paths that skip auth
}));
```

### Custom login page

```typescript
// Use your own HTML file (supports {{PREFIX}} placeholder)
app.use(timbalAuth({ loginPage: "./my-login.html" }));

// Or disable built-in pages entirely and handle yourself
app.use(timbalAuth({ loginPage: false }));
```

### Local development

When `TIMBAL_PROJECT_ID` is not set, auth is bypassed entirely — all routes are accessible without login.

Requires `elysia` as a peer dependency.

## Error Handling

The SDK throws `TimbalApiError` for API errors, with status-aware predicates so you don't sniff codes manually:

```typescript
import { TimbalApiError } from "@timbal-ai/timbal-sdk";

try {
  await timbal.query("SELECT * FROM documents");
} catch (err) {
  if (err instanceof TimbalApiError) {
    if (err.isUnauthorized()) /* 401 */;
    if (err.isForbidden())    /* 403 */;
    if (err.isNotFound())     /* 404 */;
    if (err.isConflict())     /* 409 */;
    if (err.isRateLimited())  /* 429 */;
    if (err.isServerError())  /* 5xx */;
    if (err.isTimeout())      /* SDK aborted before the wire */;
    if (err.isNetworkError()) /* DNS/connection failure */;
  }
}
```

KB-specific subclasses (`KbFileAlreadyExistsError`, `KbFileNotFoundError`) are thrown by `kb.files.*`; both still match `instanceof TimbalApiError`.

The SDK retries automatically on 5xx errors, timeouts, and network errors (3 attempts by default).

---

## Configuration

The SDK resolves each config field in order, using the first value found:

1. **Explicit options** passed to `new Timbal({ ... })`
2. **Environment variables**
3. **`~/.timbal/` profile files** (managed by `timbal configure`)
4. **Defaults**

If you've run `timbal configure`, the SDK picks up your credentials automatically — no env vars or explicit config needed. Select a non-default profile with `TIMBAL_PROFILE=staging`.

### Environment variables

| Variable             | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `TIMBAL_API_KEY`     | API key / token                                          |
| `TIMBAL_BASE_URL`    | API base URL                                             |
| `TIMBAL_ORG_ID`      | Organization ID                                          |
| `TIMBAL_PROJECT_ID`  | Project ID                                               |
| `TIMBAL_PROJECT_REV` | Git branch (default: `main`)                             |
| `TIMBAL_KB_ID`       | Knowledge base ID                                        |
| `TIMBAL_PROFILE`     | Profile to load from `~/.timbal/` files                  |
| `TIMBAL_CONFIG_DIR`  | Override the config directory (default: `~/.timbal`)     |
| `TIMBAL_DEBUG`       | Set to `1` to log every request/response                 |

## License

Apache License 2.0 — see [LICENSE](LICENSE).
