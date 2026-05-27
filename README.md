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

// first page only — do NOT assume this is every KB in the org
const firstPage = await timbal.kbs.list();

// every KB (drains all pages; fine for small orgs)
const everyKb = await timbal.kbs.listAll();

// or stream pages without holding the full list in memory
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

// Virtual directories (idempotent — re-create returns created: false)
const dir = await kb.files.mkdir("docs/reports");
// dir.placeholder_file_id is the listing row; delete to remove the folder
await kb.files.delete(dir.placeholder_file_id);
```

Typed errors let consumers branch without sniffing status codes:

```typescript
import {
  KbDirectoryConflictError,
  KbFileAlreadyExistsError,
  KbFileNotFoundError,
} from "@timbal-ai/timbal-sdk";

try {
  await kb.files.mkdir("docs/reports");
} catch (err) {
  if (err instanceof KbDirectoryConflictError) {
    // a file (not a folder) already occupies that path
  }
}

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
import { Workforce, getWorkforceItem } from "@timbal-ai/timbal-sdk";

const wf = new Workforce(timbal.apiClient, "my-agent");

// Or resolve metadata without constructing a view:
const info = await getWorkforceItem(timbal.apiClient, "my-agent", { rev: "main" });
```

> **Deprecated:** `timbal.listWorkforces` / `callWorkforce` / `streamWorkforce` / `clearWorkforceCache` still work and delegate to the same backing functions. New code should use the section above.

## Integrations

Three sub-accessors mirror the platform's mental model. Catalog is the **what your org may use** layer; shared and personal are two separate **connection** layers with two separate types — impossible to mix.

```typescript
timbal.integrations.catalog    // what providers the org may use (admin)
timbal.integrations.shared     // org-wide connections (one token per org)
timbal.integrations.personal   // per-caller-token connections
```

### Catalog (admin)

```typescript
// Every provider the platform offers, with this org's enabled flag
const entries = await timbal.integrations.catalog.list();
// [{ id, provider, name, description, logo_url, enabled, auth_methods, ... }]

await timbal.integrations.catalog.enable("gmail");   // { provider: "gmail" }
await timbal.integrations.catalog.disable("gmail");  // { provider: "gmail" }

// Both are idempotent — re-enabling an already-enabled provider returns 200.
// Unknown providers throw IntegrationNotFoundError (see below).

if (await timbal.integrations.catalog.isEnabled("gmail")) {
  // ...
}

// Pagination is threaded even though the endpoint returns one page today.
for await (const e of timbal.integrations.catalog.iterate()) {
  console.log(e.provider, e.enabled);
}
```

### Shared connections (org-wide)

Returns `SharedConnection` rows. **No `user` field** — these are org-level credentials. Every caller in the org vends the same token from the same row.

```typescript
const shared = await timbal.integrations.shared.list();
// [{ id, integration_id, integration_provider, label, status,
//    metadata: { account_name?, team_id?, scope?, ... },
//    expires_at, ... }]

// Full pagination envelope (this endpoint paginates server-side)
const page = await timbal.integrations.shared.listPage();
// { integrations, next_page_token? }  ← coerced to string at the SDK boundary

// Drain every page
const all = await timbal.integrations.shared.listAll();

// Or stream without holding everything in memory
for await (const conn of timbal.integrations.shared.iterate()) {
  if (conn.status !== "active") console.warn(`${conn.integration_provider} is ${conn.status}`);
}

// Look up by provider — walks pages, early-exits on hit, null if not present
const slack = await timbal.integrations.shared.byProvider("slack");
if (slack) console.log(slack.label, slack.metadata.account_name);
```

### Personal connections (per-user)

Returns `PersonalConnection` rows. Every row carries a `user` field describing the **current caller's** connection state. Use `if (row.user.connected)` to narrow.

Visibility: a personal row appears if either the provider is enabled in the catalog *or* the caller already holds a token (admin may have re-disabled the provider since they connected).

```typescript
const personal = await timbal.integrations.personal.list();

for (const row of personal) {
  if (row.user.connected) {
    // Narrowed — metadata + status + expires_at are guaranteed present
    console.log(`${row.integration_provider}: ${row.user.metadata.account_email}`);
  } else if (row.user.status === "expired") {
    console.log(`${row.integration_provider}: token expired, reconnect needed`);
  } else if (row.user.status === "revoked") {
    console.log(`${row.integration_provider}: revoked`);
  } else {
    console.log(`${row.integration_provider}: not connected`);
  }
}

// Same byProvider helper, same pagination helpers as the other two sections
const gmail = await timbal.integrations.personal.byProvider("gmail");

if (gmail?.user.connected) {
  // Render the connected account card
  renderAccount(gmail.user.metadata.account_email, gmail.user.metadata.account_picture);
} else {
  // Render the Connect button — consent/vend flow lands in the next slice
  renderConnectButton(gmail?.integration_provider);
}
```

`PersonalUserState` is a discriminated union — TypeScript narrows automatically. The disconnected branch carries an optional `status` (`'expired'` / `'revoked'`) when a prior connection went bad; it's absent for never-connected rows.

### Typed errors

```typescript
import { IntegrationNotFoundError } from "@timbal-ai/timbal-sdk";

try {
  await timbal.integrations.catalog.enable("not_a_real_provider");
} catch (err) {
  if (err instanceof IntegrationNotFoundError) {
    console.log(`unknown provider: ${err.provider}`);
  }
}
```

Still matches `instanceof TimbalApiError` for generic handlers.

### Escape hatch

```typescript
import {
  IntegrationsCatalog,
  SharedConnectionsSection,
  PersonalConnectionsSection,
} from "@timbal-ai/timbal-sdk";

const catalog  = new IntegrationsCatalog(timbal.apiClient);
const shared   = new SharedConnectionsSection(timbal.apiClient);
const personal = new PersonalConnectionsSection(timbal.apiClient);
```

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

Resource-specific subclasses are thrown for known failure modes — all still match `instanceof TimbalApiError`:

- `KbFileAlreadyExistsError`, `KbFileNotFoundError`, `KbDirectoryConflictError` — `kb.files.*`
- `IntegrationNotFoundError` — `timbal.integrations.catalog.{enable,disable}`

The SDK retries automatically on 5xx errors, timeouts, and network errors (3 attempts by default).

---

## Configuration

The SDK resolves each config field in order, using the first value found:

1. **Explicit options** passed to `new Timbal({ ... })`
2. **Environment variables**
3. `**~/.timbal/` profile files** (managed by `timbal configure`)
4. **Defaults**

If you've run `timbal configure`, the SDK picks up your credentials automatically — no env vars or explicit config needed. Select a non-default profile with `TIMBAL_PROFILE=staging`.

### Environment variables


| Variable             | Description                                          |
| -------------------- | ---------------------------------------------------- |
| `TIMBAL_API_KEY`     | API key / token                                      |
| `TIMBAL_BASE_URL`    | API base URL                                         |
| `TIMBAL_ORG_ID`      | Organization ID                                      |
| `TIMBAL_PROJECT_ID`  | Project ID                                           |
| `TIMBAL_PROJECT_REV` | Git branch (default: `main`)                         |
| `TIMBAL_KB_ID`       | Knowledge base ID                                    |
| `TIMBAL_PROFILE`     | Profile to load from `~/.timbal/` files              |
| `TIMBAL_CONFIG_DIR`  | Override the config directory (default: `~/.timbal`) |
| `TIMBAL_DEBUG`       | Set to `1` to log every request/response             |


## License

Apache License 2.0 — see [LICENSE](LICENSE).