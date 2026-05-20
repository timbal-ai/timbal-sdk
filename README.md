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

// list KBs in the org
const all = await timbal.kbs.list();

// multi-KB without global state — each get() is a fresh, isolated view
const [a, b] = await Promise.all([
  timbal.kbs.get("162").query("..."),
  timbal.kbs.get("222").query("..."),
]);
```

### KB files

Distinct from the org bucket (`timbal.uploadFile` below). KB files carry `metadata`, live under a virtual `directory`, and are parsed + embedded by the platform pipeline.

```typescript
const file = await kb.files.upload(buffer, "order.pdf", {
  directory: "orders",
  metadata: { source: "cron", sha256: "deadbeef" },
  parse: false, // skip parse+embed when the KB is a typed metadata store
});

const page = await kb.files.list({ directory: "orders" });
// { files: [...], next_page_token? }

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

```typescript
// list deployed agents/workflows
const items = await timbal.listWorkforces();

// call — accepts id, uid, or name
const res = await timbal.callWorkforce("my-agent", { message: "Hello!" });
const data = await res.json();
```

Stream events via SSE:

```typescript
const res = await timbal.streamWorkforce("my-agent", { message: "Hello!" });
const reader = res.body!.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(decoder.decode(value));
}
```

Clear the deployment cache when deployments change:

```typescript
timbal.clearWorkforceCache();
```

## Files (org bucket)

For files that aren't tied to a KB.

```typescript
const file = await timbal.uploadFile("/path/to/file.pdf");

const fromBuf = await timbal.uploadFileFromBuffer(
  buffer,
  "report.pdf",
  "application/pdf",
);
```

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
