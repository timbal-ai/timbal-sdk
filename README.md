# Timbal JavaScript SDK

Official TypeScript/JavaScript SDK for the [Timbal](https://timbal.ai) platform.

## Installation

```bash
npm install @timbal-ai/timbal-sdk
```

Three entry points:

| Import | What it is |
| --- | --- |
| `@timbal-ai/timbal-sdk` | The `Timbal` client — knowledge bases, workforce, integrations, tools, files, content URLs, sessions |
| `@timbal-ai/timbal-sdk/elysia` | [Elysia](https://elysiajs.com) plugins — `timbalAuth`, `timbalChannels`, `timbalCron`, `timbalMcp` (needs `elysia` as a peer) |
| `@timbal-ai/timbal-sdk/voice` | Browser-only WebRTC `VoiceSession` client |

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
const res = await timbal.workforce.get("my-agent").call({ message: "Hello!" });
const data = await res.json();
```

## Contents

- Client: [Knowledge Bases](#knowledge-bases) · [Workforce](#workforce) (streaming, voice) · [Integrations](#integrations) · [Tools](#tools) · [Files](#files) · [Content URLs](#content-urls-re-signing) · [Session & Project](#session--project) · [Scoped clients](#scoped-clients)
- Elysia: [Auth](#elysia-auth-plugin) · [Cron](#elysia-cron-plugin) · [Channels](#elysia-channels-plugin) · [MCP](#elysia-mcp-plugin)
- [Error Handling](#error-handling) · [Configuration](#configuration)

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

### Voice

`wf.voice` covers live voice sessions (STT → agent loop → TTS) against a workforce, over two transports. The SDK is transport-level: it mints credentials, builds URLs, opens the socket, relays SDP — the voice wire protocol itself (binary audio frames + JSON events) belongs to the timbal framework.

```typescript
const wf = timbal.workforce.get("my-agent");

// Browser handoff — the main pattern. Browsers can't set Authorization on a
// WebSocket upgrade, so vend a single-use ticket (~60s TTL, one connect,
// pinned to this workforce + rev) from your API and let the browser dial
// the platform directly:
const { ticket, iceServers, iceTransportPolicy } = await wf.voice.ticket();
const url = await wf.voice.wsUrl();
// → browser: new WebSocket(`${url}&ticket=${encodeURIComponent(ticket)}`, ["timbal.v1"])

// Server-side dial (e2e tests, telephony bridges). Resolves once open;
// bearer-subprotocol auth with the SDK's credential by default,
// `auth: "ticket"` to mint-and-dial instead.
const ws = await wf.voice.connect();
ws.addEventListener("message", (ev) => { /* voice protocol frames */ });
ws.close();

// WebRTC signaling relay: forward an end-user's SDP offer under your API's
// credential, hand the answer back to the browser's setRemoteDescription.
const resp = await wf.voice.rtc({ sdp: offer.sdp, type: "offer" });
const answer = await resp.json();
```

Mint tickets **immediately before** connecting (never on page load), and mint a fresh one per retry — a failed connect still burns the ticket.

Routing follows the same environment detection as `call`/`stream`: deployed endpoints by default, the studio **preview** transport (branch worktree, no deployment needed) when `TIMBAL_STUDIO` is set, and a locally running framework server when `TIMBAL_START_WORKFORCE` is set. Pass `{ preview: true | false }` to override auto-detection either way. Preview connects after a source edit perform a cold runtime sync — allow a generous `timeoutMs` or none at all.

#### Browser client (`@timbal-ai/timbal-sdk/voice`)

The subpath export is a browser-only WebRTC client that turns the transport above into a talking agent: mic capture, peer connection, agent audio playback, and a typed view over the session's event stream. No Timbal credential ever reaches the browser — signaling goes through **your** API route, which relays via `wf.voice.rtc(offer)` (see above).

```typescript
import { VoiceSession } from "@timbal-ai/timbal-sdk/voice";

const session = await VoiceSession.start({
  // Your backend route; it forwards the offer with wf.voice.rtc(offer).
  signal: (offer) =>
    fetch("/api/voice/offer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    }),

  // ICE: platform answers are relay-only (media goes browser ↔ TURN ↔ box).
  // The STUN-only default works only when the client NAT accepts
  // TURN-originated checks — for production, fetch a ticket on your backend
  // (wf.voice.ticket() returns ephemeral TURN creds as iceServers +
  // iceTransportPolicy on platforms that mint them), hand those to the
  // browser BEFORE signaling, and pass them through:
  // iceServers: ticketIce.iceServers,
  // iceTransportPolicy: ticketIce.iceTransportPolicy,  // "relay"

  onMode: (mode) => {},                 // "listening" | "thinking" | "speaking"
  onUserTranscript: ({ text, final }) => {},
  onAgentText: ({ delta, done }) => {},
  onInterrupted: ({ heardText }) => {}, // barge-in: rewrite the reply to what was actually spoken
  onAudioBlocked: () => {},             // autoplay policy — show a control that calls resumeAudio()
  onError: (err) => {},
});

session.muted = true;                   // mic mute (track stays alive)
session.setVolume(0.5);                 // agent audio volume
session.inputVolume;                    // 0–1 levels for VU meters
session.outputVolume;
await session.resumeAudio();            // from a click/tap handler, after onAudioBlocked
session.end();
```

Notes:

- **TTS arrives as a real audio track** — the browser handles decode, jitter and clock, and the server paces its own playback, so barge-in truncation is exact. Events ride a WebRTC data channel. There is no audio-frame plumbing in the client.
- Requires the target workforce to run **`timbal[voice] >= 2.3.2`** (a 501 from signaling means it doesn't).
- **ICE defaults are best-effort.** With no `iceServers`, the session gathers srflx candidates via Timbal's STUN only. Because platform answers are relay-only, some NATs never complete the srflx↔relay checks: signaling returns 200, then the call dies at `connectTimeoutMs` (default 15s) with an ICE/media-path error. Passing TURN servers **with credentials** (plus `iceTransportPolicy: "relay"`) removes that failure mode. Two related errors are surfaced distinctly: the connect timeout reports the peer-connection state (ICE never connected), and a separate error fires when the transport connects but the events data channel never opens (agent would stay silent and the server ends the session).
- **Where TURN creds come from:** `wf.voice.ticket()` on your backend. Platforms that mint ephemeral TURN return `iceServers` + `iceTransportPolicy` on the ticket; expose them to the browser from your ticket/offer route and pass them into `VoiceSession.start`. They must reach the browser **before** signaling — the peer connection gathers candidates before `signal` runs, so ICE config arriving with the SDP answer is too late.
- Raw server events (`session_started`, `filler`, `session_transcript`, future types) are all available via `onEvent`; `session.send({...})` is the escape hatch in the other direction.
- The session captures mic with echo cancellation, noise suppression, and auto gain on — the server's barge-in gates assume browser AEC. Override via `audioConstraints` only if you know why.

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

### Quick start

```typescript
// 1. Admin enables a provider for the org (once, idempotent)
await timbal.integrations.catalog.enable("gmail");

// 2a. Shared (one connection for the whole org)
const r = await timbal.integrations.shared.connectOAuth({
  provider: "gmail",
  redirect_uri: "https://my-app/integrations/callback",
});
res.redirect(r.redirect_url);
// …user completes OAuth → row appears in shared.list()…
const shared = await timbal.integrations.shared.byProvider("gmail");
const v = await timbal.integrations.shared.get(shared!.id).token();
await callGmail(v.type === "oauth" ? v.token : v.api_key as string);

// 2b. Personal (per-user; each caller has their own token)
const p = await timbal.integrations.personal.connect("gmail", {
  redirect_uri: "https://my-app/integrations/callback",
});
if (p === null) throw new Error("not enabled for this org");
if (!p.connected) return res.redirect(p.redirect_url);
await callGmail(p.token.token);
```

> **Prereq for both shared and personal:** an admin must `catalog.enable(provider)` first — connect / vend will 404 for providers that aren't enabled. `enable` is idempotent.

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

### Shared: connect & vend

Two flavors, two methods — different inputs, different outputs.

> **Prereq:** `await timbal.integrations.catalog.enable("slack")` (admin, once per org).

#### OAuth (`shared.connectOAuth(opts)`)

Starts an OAuth flow. Returns the provider's authorize URL. The row only appears in `shared.list()` after the user completes OAuth and Timbal's `/oauth/callback/integrations` runs.

```typescript
const r = await timbal.integrations.shared.connectOAuth({
  provider: "slack",
  label: "Acme Slack",
  redirect_uri: "https://app.timbal.ai/org/42/integrations",
});

// r.result === "oauth_redirect"
return res.redirect(r.redirect_url); // user → Slack consent → callback → row created
```

Some providers need upfront params (Shopify needs the shop):

```typescript
await timbal.integrations.shared.connectOAuth({
  provider: "shopify",
  oauth_params: { shop_url: "acme.myshopify.com" },
});
```

For an OAuth reconnect (token expired, refresh dead), call `connectOAuth` again with the same provider — shared connections have **no per-row consent flow**.

#### Credentials (`shared.connectCredentials(opts)`)

Synchronously creates the row from a static credentials blob. Returns a `SharedConnectionRef` bound to the new id — vend immediately, no browser step.

```typescript
const ref = await timbal.integrations.shared.connectCredentials({
  provider: "stripe",
  label: "Prod API key",
  credentials: { api_key: process.env.STRIPE_KEY! },
});

const v = await ref.token();
// v.type === "credentials"; access provider-specific fields directly
```

#### Vend (`shared.get(id).token()`)

Vend an existing shared row. Returns a discriminated union — narrow on `type`:

```typescript
const ref = timbal.integrations.shared.get("10");
const v = await ref.token();

if (v.type === "oauth") {
  await callSlack(v.token); // v.expires_at is also available
} else { // "credentials"
  await callProvider(v.api_key as string);
}
```

Failure modes (bubble as `TimbalApiError`):
- `400 "Integration is not active"` — row exists but needs a reconnect (call `connectOAuth` again)
- `404 "Integration not found"` — bad id

No `consent_required` 401 here — that's personal-only.

#### Delete (`shared.get(id).delete()`)

**Destructive** — the row is gone for the whole org, and every caller loses access to the vended token. To re-add, call `connectOAuth` / `connectCredentials` again. For "drop the whole provider org-wide" use `catalog.disable(provider)` instead.

```typescript
await timbal.integrations.shared.get("10").delete();
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
  renderAccount(gmail.user.metadata.account_email, gmail.user.metadata.account_picture);
} else {
  renderConnectButton(gmail?.integration_provider);
}
```

`PersonalUserState` is a discriminated union — TypeScript narrows automatically. The disconnected branch carries an optional `status` (`'expired'` / `'revoked'`) when a prior connection went bad; it's absent for never-connected rows.

### Personal: vending tokens & consent

> **Prereq:** `await timbal.integrations.catalog.enable("gmail")` (admin, once per org) — creates the shell row that callers can then connect to.

Use a personal connection in three flavors, from highest to lowest level.

#### One-shot: `personal.connect(provider, opts)`

The 90% case. Looks up the row, tries to vend, and if the user hasn't consented yet, starts the consent flow and returns the OAuth provider's redirect URL. Returns a tagged union — no exceptions for the "not connected" case.

```typescript
const r = await timbal.integrations.personal.connect("gmail", {
  redirect_uri: "https://my-app.projects.timbal.ai/integrations/callback",
});

if (r === null) {
  throw new Error("Gmail isn't available in this org — admin needs to enable it");
}

if (!r.connected) {
  // Send the browser to the OAuth provider; they'll come back to redirect_uri
  return res.redirect(r.redirect_url);
}

await callGmail(r.token.token); // r.token: PersonalTokenVend
```

`redirect_uri` must be allowlisted by the platform — `*.timbal.ai`, your org's custom domains, or `localhost`.

#### Per-row: `personal.get(id)`

When you already have the row id (e.g. from `personal.list()` / `byProvider()`) and don't want a second lookup, get a sync resource view and drive it directly.

```typescript
const row = await timbal.integrations.personal.byProvider("gmail");
if (!row) throw new Error("not available");

const ref = timbal.integrations.personal.get(row.id);

// Try-then-consent — the high level
const r = await ref.use({ redirect_uri: "https://my-app/cb" });

// Or split the steps yourself
try {
  const token = await ref.token();
  await callGmail(token.token);
} catch (err) {
  if (err instanceof IntegrationConsentRequiredError) {
    const { redirect_url } = await ref.consent({ redirect_uri: "https://my-app/cb" });
    return res.redirect(redirect_url);
  }
  throw err;
}
```

`get(id)` is synchronous and stateless — no network call, cheap to allocate per request.

#### Typical loop

```
ref.token()      → IntegrationConsentRequiredError
ref.consent({…}) → { redirect_url }   (browser → provider → callback → your redirect_uri)
ref.token()      → { type, token, expires_at }
```

#### Revoke (`personal.get(id).revoke()`)

The "sign out" of personal integrations. **Idempotent** — safe to call when already disconnected. The shell row stays; next `token()` throws `IntegrationConsentRequiredError` and a fresh `consent()` flow brings the user back online.

```typescript
await timbal.integrations.personal.get("15").revoke();
```

Throws `TimbalApiError` (403) if the id isn't a valid per-user OAuth row — e.g. you passed a shared row id by mistake.

### Typed errors

```typescript
import {
  IntegrationNotFoundError,
  IntegrationConsentRequiredError,
} from "@timbal-ai/timbal-sdk";

try {
  await timbal.integrations.catalog.enable("not_a_real_provider");
} catch (err) {
  if (err instanceof IntegrationNotFoundError) {
    console.log(`unknown provider: ${err.provider}`);
  }
}

try {
  const token = await timbal.integrations.personal.get("15").token();
  await callProvider(token.token);
} catch (err) {
  if (err instanceof IntegrationConsentRequiredError) {
    // err.integrationId === "15"
    // err.consentUrl is the API consent endpoint (call ref.consent() to use it)
    console.log("user needs to (re)consent");
  }
}
```

Both still match `instanceof TimbalApiError` for generic handlers.

### Escape hatch

```typescript
import {
  IntegrationsCatalog,
  SharedConnectionsSection,
  SharedConnectionRef,
  PersonalConnectionsSection,
  PersonalConnectionRef,
} from "@timbal-ai/timbal-sdk";

const catalog  = new IntegrationsCatalog(timbal.apiClient);
const shared   = new SharedConnectionsSection(timbal.apiClient);
const personal = new PersonalConnectionsSection(timbal.apiClient);
const sref     = new SharedConnectionRef(timbal.apiClient, "10");
const pref     = new PersonalConnectionRef(timbal.apiClient, "15");
```

## Tools

`timbal.tools` is the **action** plane, the complement to `timbal.integrations` (the **credential** plane): tools are what you run, integrations are the connections they consume, and a tool's `provider` is the join key between the two. Execution goes through the platform proxy, so provider credentials never reach your process.

```typescript
// Fire by name when you already know the tool and its params
const result = await timbal.tools.run("gmail_send_email", {
  to: "ada@example.com",
  subject: "Hi",
  body: "…",
});

// Discover: lightweight descriptors from the manifest (cached per org)
const tools = await timbal.tools.list({ provider: "gmail" }); // RemoteTool[]
// [{ name, description, provider, providerLogo, available, connection, ... }]

// One tool with its parameter schema hydrated
const tool = await timbal.tools.get("gmail_send_email");
tool.parameters; // JSON Schema

await tool.run({ to: "…" }); // same proxy call, bound to this tool
```

### Handing tools to a model

```typescript
// Function-tool specs in the provider's native shape (schemas hydrated)
const openai    = await timbal.tools.specs({ format: "openai", tools: ["gmail_send_email"] });
const anthropic = await timbal.tools.specs({ format: "anthropic" }); // whole manifest

// Agent-loop glue: model `tool_use` → proxy → `tool_result` keyed to the same id
for (const block of message.content) {
  if (block.type === "tool_use") {
    results.push(await timbal.tools.dispatch(block));
  }
}
```

A list-only `RemoteTool` has no schema until `await tool.load()` (or `tools.get()`); `toOpenAI()` / `toAnthropic()` return an empty `parameters` object otherwise. Per-call options (`ToolRunOptions`): `orgId`, `connectionId` (pin a specific integration row — admin/UI flows, never agents), `signal` (proxy calls have no client-side timeout), `runId` / `callId` (trace correlation).

Tool execution is deliberately **not retried** (a retried `generate_image` would double-charge) and has **no client-side timeout** — bound long runs with `signal`. When the tool's provider has no usable connection, `run` / `dispatch` throw `ToolProxyUnavailableError` (`toolName`, `provider`) — the fix lives in `timbal.integrations`: enable the provider in the catalog and connect it. A personal connection whose consent lapsed surfaces as the same `IntegrationConsentRequiredError` the credential plane throws, so one catch handles both. Invalidate the manifest cache after registering tools server-side with `timbal.tools.clearCache()`.

## Files

Short-lived binary handoff for agents and workflows. Hits the stateless `POST /files` endpoint — no org scope, no DB row, signed URL expires in ~24h. For durable, parsed, searchable storage use `kb.files.upload` instead.

```typescript
const tmp = await timbal.uploadTempFile("/path/to/report.pdf");
// { name, url, content_type, content_length, created_at, expires_at }

await timbal.workforce.get("summarize").call({ file_url: tmp.url });

// or from a buffer
const fromBuf = await timbal.uploadTempFileFromBuffer(
  buffer,
  "report.pdf",
  "application/pdf",
);
```

> **Deprecated:** `timbal.uploadFile` / `timbal.uploadFileFromBuffer` hit an undocumented org-bucket route. They still work and now return `{ id: string, ... }` (numeric IDs are coerced at the boundary), but new code should pick between `uploadTempFile` and `kb.files.upload`.

## Content URLs (re-signing)

Content URLs returned by the platform (KB files, temp files, screenshots, …) are CloudFront-signed and **go stale** — the query string carries `Expires` (epoch seconds), `Signature`, `Key-Pair-Id`, and `Hash-Algorithm`. `timbal.content` wraps `POST /orgs/{org}/content/sign`, which resolves a previously returned URL (signed or unsigned) or a bare object key back to a known object, re-checks your access, and mints a fresh URL — no need to re-fetch the whole parent resource.

```typescript
// The one-liner: returns the input unchanged while fresh, re-signs when
// expired or expiring within the next minute (no network call when fresh).
const usable = await timbal.content.ensureFresh(stored.url);

// Force a new URL regardless of freshness (best URL string back)
const url = await timbal.content.refresh(stored.url);

// Raw endpoint: full { signed_url, url } pair. Prefer signed_url when present;
// url is the legacy unsigned CDN URL kept for backwards compatibility.
const pair = await timbal.content.sign(stored.url);
const best = pair.signed_url ?? pair.url;

// Bare object keys work too — the server resolves them to a real URL
await timbal.content.sign("orgs/1/k2/{kb}/files/{id}/source.xlsx");
```

Inspect the signing params locally (pure, no network):

```typescript
timbal.content.isExpired(stored.url);          // exact expiry check
timbal.content.isExpired(stored.url, 60_000);  // treat "dies within 1 min" as expired

const info = timbal.content.parse(stored.url);
// { signed: true, expiresAt: Date, signature, keyPairId, hashAlgorithm }
// Unsigned URLs and bare keys → { signed: false, expiresAt: null, ... } (never expire)
```

Per-call org override and freshness margin:

```typescript
await timbal.content.ensureFresh(url, { orgId: "10", skewMs: 5 * 60_000 });
```

Minted URLs are **memoized** per `(org, object path)` until their own expiry, so hammering `ensureFresh` with the same stale URL or bare object key pays the round-trip once per expiry window — call it right before every use without worrying about cost. `refresh()` always hits the network (it's the "force" path) but feeds the cache. Invalidate manually with `timbal.content.clearCache()`. Caching changes nothing security-wise: a minted signed URL stays valid until its `Expires` whether or not the SDK remembers it.

The standalone functions are also exported for tree-shakeable use: `signContentUrl(client, url, opts?)`, `parseSignedContentUrl(url)`, `isSignedContentUrlExpired(url, skewMs?)`.

> **Errors:** 400 — the body/URL couldn't be resolved to a known object; 403 — the object exists but your token has no access to it.

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
- `GET /config` — public app config, platform mode only (see [`GET /config`](#get-config))
- `POST /__timbal/config/refresh`, `GET /__timbal/cron`, `POST /__timbal/cron/:name/trigger` — platform-facing infrastructure, authenticated with the project service credential (see [Platform endpoints](#platform-endpoints-__timbal))

All other routes are protected automatically. The middleware injects `token`, `timbal` (a user-scoped SDK instance), `session`, and `project` into every route handler — resolved in a single platform call per request:

```typescript
app.get("/me", ({ session, project }) => ({ session, project }));
```

Always public, no configuration needed: `/`, anything under `/auth/`, `/healthcheck`, and anything under `/__timbal/` (an optional `/api` prefix is stripped before matching). Everything else needs a user token unless listed in `publicPaths`.

### Options

```typescript
app.use(timbalAuth({
  afterLoginRedirect: "/",   // where to go after login (default: "/")
  publicPaths: ["/webhook"], // extra path prefixes that skip auth
  loginPage: "./login.html", // custom login page, or false (see below)
}));
```

Platform-mode options (`authMode`, `authConfig`, `authConfigCacheTtlMs`, `configRoute`) and the infrastructure toggles (`configRefresh`, `cron`) are covered in their own sections below.

### Custom login page

```typescript
// Use your own HTML file (supports {{PREFIX}} placeholder)
app.use(timbalAuth({ loginPage: "./my-login.html" }));

// Or disable built-in pages entirely and handle yourself
app.use(timbalAuth({ loginPage: false }));
```

### Local development

When `TIMBAL_PROJECT_ID` is not set, auth is bypassed entirely — all routes are accessible without login.

### Auth modes

The plugin runs in one of two modes.

| | `legacy` | `platform` |
| --- | --- | --- |
| What gates routes | `TIMBAL_PROJECT_ID` presence | the project's `auth_enabled` flag, fetched from the platform |
| Local-dev bypass | yes (no `TIMBAL_PROJECT_ID`) | no — the platform config is authoritative |
| Open projects | n/a | reachable with **no** user token (service identity) |
| Enabled providers | all four, always | driven by the project's `auth_providers` |
| `GET /config` route | not mounted | mounted (public) |

**Mode is inferred from platform linkage**, so deployed apps need no extra wiring:

- no `TIMBAL_PROJECT_ID` (unlinked / local dev) → `legacy`
- `TIMBAL_PROJECT_ID` set (linked deployment) → `platform`

Resolution precedence: `authMode` option → `TIMBAL_AUTH_MODE` env → linkage inference. The env var and option are escape hatches that force a mode; an unrecognized `TIMBAL_AUTH_MODE` is ignored. Force a mode explicitly with either:

```typescript
app.use(timbalAuth({ authMode: "legacy" }));   // pin legacy even when linked
app.use(timbalAuth({ authMode: "platform" })); // pin platform
```

In platform mode the plugin fetches the project once (TTL-cached, single-flight, fail-soft) and decides per request:

- **Open project** (`auth_enabled: false`) — every route is reachable without a token. Stray `Authorization` headers/cookies are ignored; handlers run as the service identity (`token: null`). `GET /auth/login` returns 404, and OAuth/magic-link routes 400.
- **Authenticated project** (`auth_enabled: true`) — protected routes require a user token (401 otherwise), exactly like legacy. The login page and `/auth/:provider` only expose providers in `auth_providers`; disabled providers are rejected server-side, not just hidden.

If the config fetch fails (platform unreachable, no cached value), the request **falls back to legacy behavior** rather than failing closed.

#### Service identity (`TIMBAL_PROJECT_SECRET`)

Open projects don't need a manually-set `TIMBAL_API_KEY`. The platform mints a per-project, project-scoped service key (`t3_proj_sk_…`) and injects it as `TIMBAL_PROJECT_SECRET` into the deployment. The SDK prefers it over `TIMBAL_API_KEY` automatically (precedence: explicit config token → `TIMBAL_PROJECT_SECRET` → `TIMBAL_API_KEY` → profile file), so the plugin's service client — used to fetch the auth config and to run open-mode handlers — authenticates as the project's own identity with no extra wiring. It's absent locally and for closed projects, so existing setups are unaffected.

#### `GET /config`

Platform mode mounts a public, browser-safe config endpoint — let your frontend discover whether login is required and which providers to render, with no secrets:

```jsonc
// GET /config
{
  "project": { "id": "248", "name": "My Project" },
  "auth": { "required": true, "providers": ["email", "google"] }
}
```

It is whitelist-built — `publishable_api_key`, `repository_url`, and SSO connection details are never exposed. Rename or disable it:

```typescript
app.use(timbalAuth({ authMode: "platform", configRoute: "/app-config" })); // rename
app.use(timbalAuth({ authMode: "platform", configRoute: false }));         // off
```

#### Platform-mode options

```typescript
app.use(timbalAuth({
  authMode: "platform",
  authConfig: { enabled: true, providers: ["email", "google"] }, // override; skips the fetch (tests/local)
  authConfigCacheTtlMs: 60_000,                                  // config cache TTL (default 60s)
  configRoute: "/config",                                        // path, or false to disable
}));
```

### Platform endpoints (`/__timbal/*`)

Besides user-facing auth, `timbalAuth` mounts a small set of routes the **platform** calls into your app. They are exempt from the user-token gate and instead require `Authorization: Bearer <project service credential>` — the same `TIMBAL_PROJECT_SECRET` the SDK's own client holds, compared in constant time. Anything else is 401. Both are on by default in every auth mode and share the auth plugin's `Timbal` client:

```typescript
app.use(timbalAuth({
  configRefresh: true, // POST /__timbal/config/refresh   (default on)
  cron: true,          // GET  /__timbal/cron + POST /__timbal/cron/:name/trigger (default on)
}));
```

- **`POST /__timbal/config/refresh`** — cache invalidation. The platform fires it after any project-config mutation the SDK consumes (channel writes, auth mode/provider changes) so they go live immediately instead of on the 60s TTL. Responds 202 and evicts + re-warms the cached project payload and runtime channel credentials, then runs any hooks registered with `registerConfigRefreshHook(name, fn)` (`timbalChannels` uses this to re-provision webhooks). Apps do not need a separate `.use(timbalConfigRefresh())` — the standalone plugin exists for hosts that skip `timbalAuth`, and mounting both is safe (same route, deduped).
- **`GET /__timbal/cron`** / **`POST /__timbal/cron/:name/trigger`** — the platform's view onto your `@elysiajs/cron` jobs. Documented in full under [Elysia Cron Plugin](#elysia-cron-plugin).

Requires `elysia` as a peer dependency.

## Elysia Cron Plugin

In-process cron has three problems on the platform: nothing outside the process can see whether a job ran or failed, it dies with the process (so an API can never be put to sleep while a job is pending), and it double-fires when the same app runs on more than one host. `timbalCron()` fixes this **without changing user code** — you keep writing `@elysiajs/cron` jobs exactly as before, and the SDK exposes them so the platform can observe them and, when told to, own their clock.

```typescript
import { Elysia } from "elysia";
import { cron } from "@elysiajs/cron";
import { timbalAuth } from "@timbal-ai/timbal-sdk/elysia";

const app = new Elysia()
  .use(timbalAuth()) // mounts timbalCron() by default
  .use(cron({
    name: "nightly-report",
    pattern: "0 3 * * *",
    timezone: "Europe/Madrid",
    protect: true,
    run: async () => { /* ... */ },
  }))
  .listen(3000);
```

`timbalAuth` mounts it by default; opt out with `timbalAuth({ cron: false })`, or mount it standalone on a host without auth:

```typescript
import { timbalCron } from "@timbal-ai/timbal-sdk/elysia";

app.use(timbalCron({
  path: "/__timbal/cron", // base path (default)
  mode: "platform",       // override TIMBAL_CRON_MODE (default: read from env, else "local")
  timbal,                 // client whose service credential authenticates callers
}));
```

Order doesn't matter — jobs are read lazily from `store.cron`, so `cron()` can be mounted before or after the plugin.

### Routes

Both require the project service credential as a bearer (401 otherwise) and are hidden from swagger.

**`GET /__timbal/cron`** — the manifest:

```jsonc
{
  "version": 1,
  "mode": "local",                     // or "platform"
  "jobs": [
    {
      "name": "nightly-report",
      "pattern": "0 3 * * *",          // null when scheduled from a date
      "timezone": "Europe/Madrid",     // null when unset
      "protect": true,
      "catch": false,
      "state": "scheduled",            // "scheduled" | "paused" | "stopped"
      "busy": false,                   // a run is in flight right now
      "next_run": "2026-09-02T01:00:00.000Z",
      "previous_run": null,
      "platform_eligible": true,
      "platform_ineligible_reason": null
    }
  ]
}
```

**`POST /__timbal/cron/:name/trigger?wait=20000`** — run the job now and wait up to `wait` ms (default 20000, clamped to 0–60000) for the outcome:

| Status | Body | When |
| --- | --- | --- |
| `200` | `{ "status": "done", "duration_ms" }` | `run()` resolved within `wait` |
| `500` | `{ "status": "error", "duration_ms", "error" }` | `run()` threw within `wait` — `error` is the first line of the message, ≤500 chars, no stack |
| `202` | `{ "status": "running", "waited_ms" }` | still running after `wait`; the outcome arrives as a stdout line (below) |
| `409` | `{ "status": "busy" }` | the job has `protect` set and a run is already in flight |
| `404` | `{ "error": "unknown_job" }` | no job registered under that name |

Triggering goes through croner's own `trigger()`, so `previousRun` / `isBusy()` stay accurate and the user's `catch` callback still runs. Two things the SDK adds on top: `protect` is enforced before triggering (croner's `trigger()` ignores it), and the outcome is captured even when `catch` is set (croner swallows the rejection in that case).

### Run log line

Every run — scheduled by croner or triggered by the platform — prints exactly one line to stdout when it finishes:

```
[timbal-cron] name=nightly-report status=done duration_ms=1834
[timbal-cron] name=nightly-report status=error duration_ms=12 error="ECONNREFUSED 10.0.0.4:5432"
```

The platform's log tee parses these, which is how a `202 running` trigger gets its final status and how local-mode jobs become visible at all. `error` is JSON-quoted; `name` is printed raw, so avoid whitespace in job names. On `listen()` the plugin also prints a one-off summary: `[timbal-cron] mode=… jobs=N stopped=N names=a,b`.

### Modes

`TIMBAL_CRON_MODE` is set by the platform per deployment; the plugin never changes behaviour on its own.

| | `local` (default) | `platform` |
| --- | --- | --- |
| Who fires jobs | croner's in-process timer, as today | the platform dispatcher, via the trigger route (ticks every 10–15s) |
| Local timers | untouched | `stop()` is called on every **eligible** job on start — they become pure trigger endpoints. Ineligible jobs keep their timer |
| Manifest / trigger routes | available — the platform observes; a trigger runs the job alongside the local timer | available — the only way eligible jobs run |
| Behaviour change for users | none | job precision becomes ±one dispatcher tick; jobs survive process sleep/crash and fire once across hosts |

Stopping happens on `listen()` (via `onStart`) and again lazily on the first request to either route, so hosts that never call `listen()` (tests using `app.handle()`) behave the same.

### Platform eligibility

The dispatcher can't honour anything finer than its tick or any run-count/window semantics, so those jobs stay local and the manifest says why:

| Pattern / option | Eligible | `platform_ineligible_reason` |
| --- | --- | --- |
| Any 5-field pattern (`0 3 * * *`, `*/5 * * * *`), `@hourly`-style nicknames | yes | — |
| 6-field with a literal or `*/n` / `n/m` (step ≥ 10) seconds field (`0 * * * * *`, `*/30 * * * * *`, `0/10 * * * * *`) | yes | — |
| Seconds field `*` or a step < 10 (`* * * * * *`, `*/5 * * * * *`, `0/5 * * * * *`, `1/5 * * * * *`) | no | `sub_10s_pattern` |
| Seconds field with a list or range (`0,30 * * * * *`, `0-59/10 * * * * *`) | no | `sub_10s_pattern` |
| Scheduled from a `Date` / ISO string instead of a pattern | no | `no_pattern` |
| `maxRuns`, `startAt`, `stopAt`, or `interval` set | no | `unsupported_options` |

The same logic is exported for your own checks: `classifyCronPattern(pattern)` returns the reason or `null`, and `evaluatePlatformEligibility(job)` returns `{ eligible, reason }` for a croner instance. `resolveCronMode(options?)` returns the effective mode.

### Types

`CronManifest`, `CronJobManifest`, `CronRunOutcome`, `CronIneligibleReason`, `TimbalCronMode`, `TimbalCronOptions`, and `CronJobLike` (the structural subset of a croner `Cron` the plugin relies on — the SDK has no dependency on croner) are exported from `@timbal-ai/timbal-sdk/elysia`.

## Elysia Channels Plugin

Connect messaging channels — **Telegram, Slack, WhatsApp, Microsoft Teams** — to workforce components. One plugin mounts the webhook routes and runs a channel-agnostic pipeline: **verify → ack → dedupe → parse → workforce → reply**. The webhook is acked immediately (Slack's 3-second deadline), then the workforce run and the reply happen detached.

```typescript
import { Elysia } from "elysia";
import { timbalAuth, timbalChannels, CHANNELS_PUBLIC_PATHS } from "@timbal-ai/timbal-sdk/elysia";

const app = new Elysia()
  .use(timbalAuth({ publicPaths: [...CHANNELS_PUBLIC_PATHS] })) // webhooks authenticate via provider signatures, not user tokens
  .use(timbalChannels())
  .listen(3000);
```

### Dynamic vs static bindings

With no options the plugin runs in **dynamic mode**: bindings come from the platform (the project's configured channels and their runtime credentials, fetched with the service credential and cached with a 60s TTL), one `POST` + `GET` route serves them all at `/channels/:workforce/:provider`, and a `/__timbal/config/refresh` hook re-resolves bindings when the platform pushes a change. On mount it also fire-and-forgets webhook provisioning (Telegram `setWebhook`; Slack/Teams/WhatsApp register their URL in the provider console). Unlinked apps (no `TIMBAL_PROJECT_ID`) fall back to env-convention bindings: `CHANNELS_WORKFORCE` plus the provider's credential variables (`TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET`, `WHATSAPP_*`, `TEAMS_*`).

Pass `bindings` for **static mode** — you own the adapters, credentials, and URLs; nothing is fetched or provisioned:

```typescript
import { timbalChannels, telegram, slack } from "@timbal-ai/timbal-sdk/elysia";

app.use(timbalChannels({
  bindings: [
    { adapter: telegram({ botToken }), workforce: "support-agent" },              // POST /channels/support-agent/telegram
    { adapter: slack({ signingSecret, botToken }), workforce: "sales-agent" },    // POST /channels/sales-agent/slack
    {
      adapter: telegram({ botToken: otherToken }),
      workforce: "concierge",
      path: "/vip",                                                               // POST /channels/vip
      buildInput: (event) => ({ prompt: event.text, user: event.externalUserId }),
      streaming: true,
    },
  ],
}));
```

The default workforce input is `{ prompt: event.text }`; events with attachments (Telegram photos/documents) are re-uploaded to Timbal temp storage and sent as prompt content parts (`{ prompt: [{ type: "text", … }, { type: "file", file: url }] }`) — the same shape the platform chat UI produces. `buildInput` takes full control, including attachments via `event.attachments`; `event.conversationId` (Slack `channel:thread_ts`, Telegram `chat.id`, Teams `conversation.id`) is the key for anything conversation-scoped.

### Options

```typescript
app.use(timbalChannels({
  prefix: "/channels",        // route prefix
  timbal,                     // service client (default: new Timbal())
  sessionContinuity: true,    // thread multi-turn: remembers the last run id per provider:conversationId and passes it as context.parent_id (in-memory)
  streaming: false,           // progressive message edits while the agent generates (experimental; per-binding override)
  editIntervalMs: 1000,       // min interval between streaming edits
  dedupeTtlMs: 900_000,       // idempotency window for webhook redelivery (15 min)
  errorMessage: "Something went wrong processing your message.", // posted on failure; false to stay silent
  onError: (err, event) => {}, // observe pipeline failures (they never throw past the pipeline)
  configCacheTtlMs: 60_000,   // dynamic mode: platform channel config TTL
  channelSpecs: [...],        // dynamic mode: override the platform's channel specs (tests/local)
  onSkippedSpec: ({ spec, reason }) => {}, // dynamic mode: "missing-credentials" | "unknown-provider"
  env: process.env,           // injectable env for credentials / origin
}));
```

Webhook URLs need a public origin: `PUBLIC_ORIGIN` if set, else derived from `TIMBAL_PROJECT_ENV_ID` on deployed apps. Helpers exported alongside the plugin: `registerChannelWebhooks(options)` (run provisioning yourself), `resolveChannelBindings(timbal, options)` (see what the plugin would mount), `resolveBindingPath(binding, prefix)`, the adapters `telegram` / `slack` / `whatsapp` / `teams`, and the lower-level building blocks (`StreamingReply`, `DedupeCache`, `channelBindingsFromEnv`, `ChannelAdapter` / `ChannelBinding` / `ChannelEvent` types) for custom adapters.

## Elysia MCP Plugin

Expose your app's routes as [MCP](https://modelcontextprotocol.io) tools, so agents (Claude, Cursor, anything MCP-capable) can call them:

```typescript
import { Elysia, t } from "elysia";
import { timbalAuth, timbalMcp } from "@timbal-ai/timbal-sdk/elysia";

const app = new Elysia()
  .use(timbalAuth())
  .use(timbalMcp({ include: ["Workforce"] })) // opt-in by swagger tag
  .post("/workforce/:id/run", handler, {
    body: t.Object({ prompt: t.String({ description: "What to ask the agent" }) }),
    detail: { tags: ["Workforce"], summary: "Run a workforce agent" },
  })
  .listen(3000);
```

This mounts a stateless [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) endpoint at `POST /mcp`. A tool call is dispatched back through your app's own router — every guard, validator, and middleware on the target route runs exactly as it would for a plain HTTP request.

### Choosing what's exposed

Selection is **opt-in** — nothing is exposed by default, so `/healthcheck`, `/docs`, and upload routes never leak into the tool list. Three levers, all on the same `detail` object swagger reads:

```typescript
// 1. Bulk: every route with a matching tag becomes a tool
.use(timbalMcp({ include: ["Workforce", "Documents"] }))

// 2. Curated identity — agents want intent-shaped names, not REST paths
.post("/workforce/:id/run", handler, {
  detail: {
    tags: ["Workforce"],
    mcp: {
      name: "run_workforce",
      description: "Run a workforce agent with a prompt and get its reply",
    },
  },
})

// 3. Individual opt-in (no tag needed) or opt-out (overrides the tag)
.get("/status", handler, { detail: { mcp: { name: "get_app_status" } } })
.post("/workforce/:id/upload", handler, { detail: { tags: ["Workforce"], mcp: false } })
```

Precedence: `mcp: false` always excludes → explicit `mcp: {...}` always includes → tag match includes. Routes hidden from swagger (`detail: { hide: true }`) stay out unless they carry explicit `mcp` metadata.

Tool schemas are generated from the route's TypeBox schemas: path params, `query`, and `body` flatten into a single argument object, with field `description`s carried through — documenting your schemas well *is* the tool-schema customization. Tool names default to `{method}_{path}` (`post_workforce_id_run`); descriptions fall back through `mcp.description` → `detail.description` → `detail.summary` → `METHOD /path`.

### Options

```typescript
app.use(timbalMcp({
  include: ["Workforce"],          // swagger tags to expose (default: none)
  path: "/mcp",                    // endpoint path
  serverName: "acme-support-app",  // shown in the client's server list
  serverVersion: "1.0.0",          // defaults to the SDK version
  instructions: "Prefer run_workforce for user questions.", // hint sent to clients on connect
  allowedOrigins: ["https://studio.acme.com"], // extra browser origins (cross-origin is 403 by default)
  maxResultBytes: 100 * 1024,      // tool results larger than this are truncated with a marker
  onToolCall: ({ tool, status, durationMs, isError }) =>
    console.log(`mcp ${tool} → ${status} in ${durationMs}ms${isError ? " (error)" : ""}`),
  progressIntervalMs: 15_000,      // heartbeat cadence for streamed long-running calls
}));
```

Routes that declare an object `response` schema also get a typed `outputSchema` on their tool, and successful calls return the parsed JSON as `structuredContent` alongside the text — agents handle typed results better than prose-wrapped JSON.

### Long-running tools

MCP clients default to ~60-second request timeouts, resettable only by progress notifications. When a client accepts SSE and requests progress (the official SDK does both whenever an `onprogress` callback is passed), `tools/call` responds as an SSE stream with `notifications/progress` heartbeats every `progressIntervalMs` while the route runs — so a workforce run that thinks for five minutes completes instead of timing out client-side. Clients that don't opt in get plain JSON responses, unchanged.

### Auth

There is no MCP-specific auth layer. The `/mcp` endpoint sits behind `timbalAuth` ingress like any other route, and the caller's `Authorization` header is forwarded to every tool call — so tools run with the MCP client's Timbal identity, and the target route's own auth re-validates it. Point an MCP client at it with a bearer token:

```jsonc
// e.g. Cursor / Claude Desktop MCP config
{
  "timbal-app": {
    "url": "https://your-app.timbal.ai/mcp",
    "headers": { "Authorization": "Bearer <timbal token or API key>" }
  }
}
```

### Inspecting the tool list

```typescript
import { deriveMcpTools } from "@timbal-ai/timbal-sdk/elysia";

const tools = deriveMcpTools(app.routes, { include: ["Workforce"], mcpPath: "/mcp" });
console.log(tools.map(t => ({ name: t.name, description: t.description })));
```

Useful as a startup log or a snapshot test, so a new tagged route showing up as a tool is a deliberate diff, not a surprise.

Tool results are the raw HTTP response body as text; non-2xx responses come back as tool errors (`isError: true`) that agents can read and retry. If you need a tool whose shape differs from any HTTP route, add a purpose-built route rather than bending the mapping.

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
    if (err.isMissingAuth())  /* no credential resolved at all */;
    if (err.isClientError())  /* any 4xx */;
  }
}
```

Resource-specific subclasses are thrown for known failure modes — all still match `instanceof TimbalApiError`:

- `KbFileAlreadyExistsError`, `KbFileNotFoundError`, `KbDirectoryConflictError` — `kb.files.*`
- `IntegrationNotFoundError`, `IntegrationConsentRequiredError` — `timbal.integrations.*`
- `ToolProxyUnavailableError` — `timbal.tools.run` / `dispatch` when the tool's provider has no usable connection

The SDK retries automatically on 5xx errors, timeouts, and network errors — 3 attempts with linear backoff (1s, 2s, 3s) by default; tune with `retryAttempts` / `retryDelay` in the `Timbal` config. 4xx responses are never retried.

---

## Configuration

The SDK resolves each config field in order, using the first value found:

1. **Explicit options** passed to `new Timbal({ ... })` — `token`, `orgId`, `projectId`, `rev`, `kbId`, `baseUrl`, `timeout`, `retryAttempts`, `retryDelay`
2. **Environment variables**
3. **`~/.timbal/` profile files** (managed by `timbal configure`)
4. **Defaults**

If you've run `timbal configure`, the SDK picks up your credentials automatically — no env vars or explicit config needed. Select a non-default profile with `TIMBAL_PROFILE=staging`.

### Environment variables

Client:

| Variable                | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `TIMBAL_API_KEY`        | API key / token                                      |
| `TIMBAL_PROJECT_SECRET` | Platform-minted, project-scoped service key (auto-injected into deployed open projects; preferred over `TIMBAL_API_KEY`) |
| `TIMBAL_BASE_URL`       | API base URL (`TIMBAL_API_HOST` is accepted as a bare host) |
| `TIMBAL_ORG_ID`         | Organization ID                                      |
| `TIMBAL_PROJECT_ID`     | Project ID — also what marks an app as platform-linked |
| `TIMBAL_PROJECT_REV`    | Git branch (default: `main`)                         |
| `TIMBAL_KB_ID`          | Knowledge base ID                                    |
| `TIMBAL_PROFILE`        | Profile to load from `~/.timbal/` files              |
| `TIMBAL_CONFIG_DIR`     | Override the config directory (default: `~/.timbal`) |
| `TIMBAL_DEBUG`          | Set to `1` to log every request/response             |
| `TIMBAL_STUDIO`         | Set inside studio sessions — routes workforce `call` / `stream` / `voice` to the preview transport |
| `TIMBAL_START_WORKFORCE` | `id:port,id:port` map set by the local framework runner — routes workforce calls to those local servers (`TIMBAL_WORKFORCE` is an alias) |

Set by the platform on deployed apps (you normally never set these yourself):

| Variable                | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `TIMBAL_AUTH_MODE`      | Force Elysia auth mode: `legacy` / `platform` (default: inferred from `TIMBAL_PROJECT_ID`) |
| `TIMBAL_CRON_MODE`      | `local` (default) or `platform` — who fires `@elysiajs/cron` jobs, see [Elysia Cron Plugin](#elysia-cron-plugin) |
| `TIMBAL_PROJECT_ENV_ID` | Deployment environment id; used to derive the public webhook origin when `PUBLIC_ORIGIN` is unset |
| `PUBLIC_ORIGIN`         | Explicit public origin for channel webhook URLs      |

Channels, when running unlinked with env-convention bindings: `CHANNELS_WORKFORCE`, `TELEGRAM_BOT_TOKEN` / `TELEGRAM_SECRET_TOKEN`, `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET`, `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_APP_SECRET` / `WHATSAPP_VERIFY_TOKEN`, `TEAMS_APP_ID` / `TEAMS_APP_PASSWORD` / `TEAMS_TENANT_ID`.


## License

Apache License 2.0 — see [LICENSE](LICENSE).