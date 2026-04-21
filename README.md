# Timbal JavaScript SDK

Official TypeScript/JavaScript SDK for the [Timbal](https://timbal.ai) platform.

## Installation

```bash
npm install @timbal-ai/timbal-sdk
```

## Quick Start

```typescript
import Timbal from "@timbal-ai/timbal-sdk";

const timbal = new Timbal({
  token: "your-api-key",
  orgId: "your-org-id",
  projectId: "your-project-id",
});
```

## Configuration

The SDK resolves each config field in this order, using the first value found:

1. **Explicit options** passed to `new Timbal({ ... })`
2. **Environment variables**
3. **`~/.timbal/` profile files** (shared with the Timbal CLI)
4. **Defaults**

### Environment variables

| Variable                | Description                              |
| ----------------------- | ---------------------------------------- |
| `TIMBAL_API_KEY`        | API key / token                          |
| `TIMBAL_BASE_URL`       | API base URL                             |
| `TIMBAL_ORG_ID`         | Organization ID                          |
| `TIMBAL_PROJECT_ID`     | Project ID                               |
| `TIMBAL_PROJECT_REV`    | Git branch (default: `main`)             |
| `TIMBAL_KB_ID`          | Knowledge base ID                        |
| `TIMBAL_PROFILE`        | Profile to load from `~/.timbal/` files  |
| `TIMBAL_CONFIG_DIR`     | Override the config directory (default: `~/.timbal`) |

### Profile files

If you've run `timbal configure`, the SDK automatically picks up your credentials — no env vars or explicit config needed.

Profiles are stored in two INI files:

**`~/.timbal/config`**
```ini
[default]
base_url = https://api.timbal.ai
org = your-org-id

[profile staging]
base_url = https://staging.timbal.ai
org = staging-org-id
```

**`~/.timbal/credentials`**
```ini
[default]
api_key = your-api-key

[profile staging]
api_key = staging-api-key
```

Select a profile with `TIMBAL_PROFILE`:

```bash
TIMBAL_PROFILE=staging node my-script.js
```

Or in code:
```typescript
process.env.TIMBAL_PROFILE = "staging";
const timbal = new Timbal(); // picks up staging credentials automatically
```

## Scoped Clients

Use `as()` to create a client scoped to a specific user token:

```typescript
const userTimbal = timbal.as("user-access-token");
const session = await userTimbal.getSession();
```

You can also pass a partial config object:

```typescript
const scoped = timbal.as({ token: "other-token", orgId: "other-org" });
```

## Session

```typescript
const session = await timbal.getSession();
// { user_id, user_name, user_email, access_level, ... }
```

## Project

```typescript
const project = await timbal.getProject();
// { id, name, description, workforce, ... }
```

## Query

Execute SQL queries against a knowledge base (PostgreSQL dialect):

```typescript
const rows = await timbal.query("SELECT * FROM documents WHERE id = $1", [42]);
```

Requires `orgId` and `kbId` to be set in config, env vars, or passed as context:

```typescript
const rows = await timbal.query("SELECT * FROM documents", [], {
  orgId: "10",
  kbId: "kb-1",
});
```

For legacy knowledge bases, pass `legacy: true`:

```typescript
const rows = await timbal.query("SELECT * FROM documents", [], {
  orgId: "10",
  kbId: "kb-1",
  legacy: true,
});
```

## Files

Upload a file from disk:

```typescript
const file = await timbal.uploadFile("/path/to/file.pdf");
// { id, name, content_type, content_length, url, ... }
```

Upload from an in-memory buffer:

```typescript
const file = await timbal.uploadFileFromBuffer(
  buffer,
  "report.pdf",
  "application/pdf",
);
```

## Workforce

List running workforce components:

```typescript
const workforces = await timbal.listWorkforces();
// [{ id, uid?, type: "agent", name: "my-agent", description }, ...]
```

Call a workforce component — accepts `id`, `uid`, or `name` as identifier:

```typescript
const response = await timbal.callWorkforce("my-agent", { message: "Hello!" });
const data = await response.json();
```

Stream events via SSE:

```typescript
const response = await timbal.streamWorkforce("my-agent", {
  message: "Hello!",
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(decoder.decode(value));
}
```

Clear the deployment cache when deployments change:

```typescript
timbal.clearDeploymentCache();
```

## Authentication

Build an OAuth URL for social login:

```typescript
const url = timbal.getOAuthUrl("github", "https://myapp.com/callback");
// Redirect the user to this URL
```

Send a passwordless magic link:

```typescript
await timbal.sendMagicLink("user@example.com", "https://myapp.com/callback");
```

Refresh an access token:

```typescript
const tokens = await timbal.refreshToken("refresh-token");
// { access_token, refresh_token }
```

## Elysia Auth Plugin

Drop-in authentication for [Elysia](https://elysiajs.com) applications. Adds login pages, OAuth, magic link, token refresh, cookie management, and route guarding with a single line:

```typescript
import { Elysia } from "elysia";
import { timbalAuth } from "@timbal-ai/timbal-sdk/elysia";

const app = new Elysia()
  .use(timbalAuth())
  .get("/", () => "Hello!")
  .listen(3000);
```

This registers:
- `GET /auth/login` — built-in login page with OAuth + magic link
- `GET /auth/:provider` — OAuth redirect (github, google, microsoft)
- `GET /auth/callback` — OAuth callback handler
- `POST /auth/set-token` — validate token and set httpOnly cookie
- `POST /auth/magic-link` — send passwordless login email
- `POST /auth/refresh` — refresh access token
- `POST /auth/logout` — clear cookie and redirect

All other routes are protected automatically. The middleware injects `token` and `timbal` (a user-scoped SDK instance) into every route handler:

```typescript
app.get("/me", ({ timbal }) => timbal.getSession());
```

### Options

```typescript
app.use(timbalAuth({
  afterLoginRedirect: "/",           // where to go after login (default: "/")
  afterLogoutRedirect: "/auth/login", // where to go after logout
  publicPaths: ["/webhook"],          // extra paths that skip auth
  cookieName: "timbal_access_token",  // cookie name
  cookieMaxAge: 3600,                 // cookie TTL in seconds (1 hour)
}));
```

### Custom Login Page

```typescript
// Use your own HTML file (supports {{PREFIX}} placeholder)
app.use(timbalAuth({ loginPage: "./my-login.html" }));

// Or disable built-in pages entirely and handle yourself
app.use(timbalAuth({ loginPage: false }));
```

### Local Development

When `TIMBAL_PROJECT_ID` is not set, auth is bypassed entirely — all routes are accessible without login.

Requires `elysia` as a peer dependency.

## Error Handling

The SDK throws `TimbalApiError` for API errors:

```typescript
import { TimbalApiError } from "@timbal-ai/timbal-sdk";

try {
  await timbal.query("SELECT * FROM documents");
} catch (err) {
  if (err instanceof TimbalApiError) {
    console.error(err.message); // Error message
    console.error(err.statusCode); // HTTP status code
    console.error(err.code); // Error code (e.g. "NETWORK_ERROR", "AUTH_ERROR")
    console.error(err.details); // Additional details
  }
}
```

Error codes: `NETWORK_ERROR`, `TIMEOUT_ERROR`, `AUTH_ERROR`, `VALIDATION_ERROR`, `RATE_LIMIT_ERROR`, `SERVER_ERROR`.

The SDK retries automatically on 5xx errors, timeouts, and network errors (3 attempts by default).

## Debug Logging

Set `TIMBAL_DEBUG=1` to enable request/response logging.

## License

Apache License 2.0 - see [LICENSE](LICENSE) for details.
