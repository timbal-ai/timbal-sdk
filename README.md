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

Configuration can also be provided via environment variables:

| Variable                | Description          |
| ----------------------- | -------------------- |
| `TIMBAL_API_KEY`        | API key or token     |
| `TIMBAL_BASE_URL`       | API base URL         |
| `TIMBAL_ORG_ID`         | Organization ID      |
| `TIMBAL_PROJECT_ID`     | Project ID           |
| `TIMBAL_PROJECT_ENV_ID` | Project environment  |
| `TIMBAL_KB_ID`          | Knowledge base ID    |

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
// [{ id: "my-agent" }, { id: "my-workflow" }]
```

Call a workforce component:

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
