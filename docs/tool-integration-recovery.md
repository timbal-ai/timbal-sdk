# Tool proxy: integration recovery — design notes

Status: **execution layer shipped; recovery API undecided.** The tool proxy
(`run`, `list`, `get`, `specs`, `dispatch`) is done and tested. How we recover
"what integrations does this app need" from outside is still an open design
question — captured below as Option A / Option B.

## What ships today

String-first execution against the proxy, matching Composio (`tools.execute`) and
Pipedream (`actions.run`). No handles, no registry — pass the slug.

```ts
import Timbal from '@timbal-ai/timbal-sdk';
const timbal = new Timbal();

// execute (escape hatch — no manifest round-trip)
await timbal.tools.run('krea_generate_image', { prompt }, { connectionId });

// manifest (the catalog) — name → provider → connection status per tool
await timbal.tools.list();                      // metadata only
await timbal.tools.get('krea_generate_image');   // + hydrated param schema

// model glue
await timbal.tools.specs({ format: 'openai', tools: ['krea_generate_image'] });
await timbal.tools.dispatch(toolUse);           // tool_use → proxy → tool_result
```

Each `RemoteTool` from `list()` / `get()` already carries `provider`,
`available`, `serviceAccountEligible`, and `connection` from the manifest. Group
by provider in app code if you need a dashboard today.

## Why `tools.requirements()` was dropped

We briefly shipped `tools.requirements({ tools?: string[] })` — a helper that
joined tool names against the manifest and returned integration requirements
grouped by provider.

**Removed** — not useful yet:

1. **No caller.** Nothing in the SDK, playground, or a real app used it. It was
   scaffolding for recovery flows we haven't built (CLI scan, Elysia plugin).
2. **Wrong layer too early.** The hard problem is *where tool names come from*
   in scattered Elysia handlers — not aggregating manifest rows once you have
   the list. The helper pretended that problem was solved.
3. **API churn risk.** Semantics kept shifting (empty `tools: []`, missing-name
   handling, conservative `connection` merge). Better to ship the join once with
   the tool that produces the name list (scan or plugin), not as a half-built
   runtime primitive.
4. **`list()` is enough for now.** Filter `await timbal.tools.list()` (or pass
   `list({ provider })`) and group by `tool.provider` client-side until recovery
   lands.

**Will revisit** when Option A or B below ships — likely as part of that tool
(e.g. `timbal tools scan ./src` or `timbalTools(...)` mount introspection), not
as a standalone SDK method you call with a hand-maintained slug array.

The old `tool()` / `toolRegistry` side-effect registry was also **removed** —
it doesn't survive tree-shaking/lazy imports, and in an Elysia backend the
`tools.run('x')` calls live inside route closures that **don't execute at import
time**, so nothing ever registers. Dead end.

## How Timbal already does this (Python codegen — the reference)

Not a source grep, not a runtime registry. It's **load-and-introspect a declared
entry point + a provider catalog**:

1. `timbal.yaml` declares an entry-point `fqn` → `spec.load()` **imports the
   actual Agent/Workflow object**.
2. `get_flow()` walks the live object graph (`agent.tools`, `workflow._steps`) to
   enumerate what's used.
3. Each tool → provider comes from the catalog: `tool_discovery.get_framework_tools()`
   introspects `timbal.tools` and reads the `integration: Annotated[str, Integration(provider=...)]`
   annotation. (Disk-cached, keyed by a hash of `tools/__init__.py`.)

TS already has the **catalog half** — that's the `/proxies/v1/tools` manifest
endpoint (`list()`). What's missing is the TS analog of "the declared structure
you load and walk." That's the whole debate below.

## Context that drives the decision

TS SDK tool calls live **mainly in Elysia backends**, not agent-loop apps. So in
practice they're scattered imperative calls across route handlers:

```ts
new Elysia()
  .post('/img', ({ body }) => timbal.tools.run('krea_generate_image', body))
  .post('/tts', ({ body }) => timbal.tools.run('elevenlabs_text_to_speech', body));
```

There is no single LLM toolset object to walk, and route closures don't run at
import. That rules out toolset-walk and the run()-based registry, and leaves two
realistic options.

---

## Option A — CLI static scan

A `timbal tools scan ./src` command (TS analog of an env/i18n key extractor)
parses the source for literal tool calls and emits the integration list, then
joins the manifest for status.

```bash
$ timbal tools scan ./src
elevenlabs  ✗ needs connection   (elevenlabs_text_to_speech)
krea        ✓ connected          (krea_generate_image)
```

Mechanics: AST (TypeScript compiler API, already a dep) over the tree, collect
the string-literal arg of `*.tools.run(...)` / `.get(...)` / `.dispatch(...)` /
`specs({ tools: [...] })`, dedupe, then join against `tools.list()` for
provider + connection status.

| Pros | Cons |
| --- | --- |
| Zero ceremony — the `run('slug')` string *is* the declaration | Blind to dynamic/computed slugs (`run(name)`) |
| No runtime, no env, no secrets — pure CI/deploy step | Second source of truth (source vs. what really runs) |
| Convention-aligned (env linters, i18n, GraphQL codegen) | Needs an AST walker + literal-extraction rules to maintain |
| Works with the scattered-handler reality as-is | Does nothing for per-request run-id / per-user connection |

Fits the "we just want to know what to provision" need with the least friction.
Diverges from the Python load-and-introspect philosophy.

---

## Option B — Elysia plugin (`timbalTools`)

A first-class Elysia plugin. Solves the backend problems that exist *regardless*
of recovery, and gives recovery as a byproduct.

```ts
new Elysia()
  .use(createAuthRoutes(timbal))
  .use(timbalTools(timbal, ['krea_generate_image', 'elevenlabs_text_to_speech']))
  // ctx.tools is scoped + typed to those slugs;
  // x-timbal-run-id auto-set per request; connection resolved from the authed user
  .post('/img', ({ tools, body }) => tools.run('krea_generate_image', body))
  .post('/tts', ({ tools, body }) => tools.run('elevenlabs_text_to_speech', body));
```

Plugin **mounts run at import** (unlike route closures), so the declared slug
list is captured at load time. Import the app entry → read the mounted
declarations → join the manifest. That's load-and-introspect, Elysia-native —
the same shape as Python's `spec.load()` + walk.

| Pros | Cons |
| --- | --- |
| Auto per-request `x-timbal-run-id` (tracing) — the painful part of a backend | Real surface to design (context typing, plugin wiring) |
| Resolves per-user integration **connection** from the session automatically | Couples recovery to "you use the plugin" |
| `ctx.tools.run` typed to declared slugs → **can't drift** from usage | Declared list sits at mount, slightly apart from call sites |
| Recovery falls out for free (read mounted declarations) | Elysia-specific (bare `run()` stays for scripts/cron) |
| Matches Timbal's load-and-introspect philosophy | More to learn than a grep |

The differentiator: **A only answers recovery. B also solves run-id + per-user
connection**, which a multi-tenant backend needs anyway — recovery is the bonus.

---

## Open question before we decide B

How does a request map to *which* connection? Authed user's personal connection,
an org service account, or explicit per-call? That determines what the plugin
resolves from the session and is the crux of the design. (For A it's irrelevant —
A doesn't touch execution.)

## Recommendation (soft)

- Want to ship recovery fast with no execution changes → **A**.
- Building real multi-tenant Elysia backends (per-user connections) → **B**, and
  recovery comes along for the ride. A can still be added later as a CI lint.
