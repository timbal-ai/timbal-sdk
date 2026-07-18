import { Elysia } from 'elysia';
import { Timbal } from '../lib/timbal';
import { DedupeCache } from '../channels/dedupe';
import { StreamingReply } from '../channels/reply';
import { WorkforceTextCollector } from '../channels/collect';
import { channelBindingsFromEnv } from '../channels/env';
import { resolvePublicOrigin } from '../channels/origin';
import {
  channelSpecsFromProject,
  materializeChannelBindings,
  type SkippedChannelSpec,
} from '../channels/config';
import { getCachedRuntimeChannels } from '../channels/runtime';
import { getCachedProject } from '../auth/config';
import { registerConfigRefreshHook } from '../config/refresh';
import type { ProjectChannelSpec } from '../types';
import type { ChannelBinding, ChannelEvent, WebhookRequest } from '../channels/types';

/**
 * Path prefixes that must bypass `timbalAuth` ingress. Webhooks authenticate
 * via provider signatures (Slack HMAC / Telegram secret), not user tokens.
 *
 * ```ts
 * import { timbalAuth, CHANNELS_PUBLIC_PATHS } from "@timbal-ai/timbal-sdk/elysia";
 *
 * .use(timbalAuth({ publicPaths: [...CHANNELS_PUBLIC_PATHS] }))
 * ```
 */
export const CHANNELS_PUBLIC_PATHS = ['/channels/'] as const;

export interface TimbalChannelsOptions {
  /**
   * Hand-written channel → workforce bindings (static mode: fixed routes,
   * supports custom `path`s and multiple bindings per provider). When
   * omitted, the plugin runs in **dynamic mode**: bindings are resolved
   * per-request from the platform's runtime channel config (topology +
   * platform-held credentials, TTL cached — the "add a channel in the
   * dropdown, no env vars, no redeploy" path), falling back to
   * `project.channels` topology + env creds on older platforms, and to env
   * conventions ({@link channelBindingsFromEnv}) when the platform has no
   * channel data at all or the process isn't platform-linked.
   */
  bindings?: ChannelBinding[];
  /**
   * Platform channel specs override (tests / local dev) — skips the platform
   * fetch in dynamic mode, mirroring `timbalAuth`'s `authConfig` override.
   */
  channelSpecs?: ProjectChannelSpec[];
  /** TTL for the cached platform-config fetches, ms. @default 60000 */
  configCacheTtlMs?: number;
  /** Environment source for credentials/fallbacks (injectable for tests). */
  env?: Record<string, string | undefined>;
  /**
   * Observer for platform specs that couldn't be materialized (no credentials
   * platform-side or in env, provider unknown to this SDK version). Fires on
   * resolution, deduped per `provider:reason` so it doesn't spam per request.
   */
  onSkippedSpec?(skipped: SkippedChannelSpec): void;
  /** Path prefix for every webhook route. @default '/channels' */
  prefix?: string;
  /**
   * Timbal client used to invoke workforce components. Defaults to a fresh
   * service-credentials client (same as `timbalAuth`). Injectable for tests.
   */
  timbal?: Timbal;
  /**
   * Stream the reply into the channel as the agent generates, via
   * progressive message edits (**experimental** — edit APIs carry
   * per-conversation rate limits and channel-specific quirks). Off by
   * default: the reply is posted once, complete. Per-binding `streaming`
   * overrides this. @default false
   */
  streaming?: boolean;
  /** Min interval between streaming edits, ms. See `StreamingReply`. @default 1000 */
  editIntervalMs?: number;
  /** Idempotency window for webhook redelivery, ms. @default 900000 (15 min) */
  dedupeTtlMs?: number;
  /**
   * Message posted to the conversation when the workforce run or the final
   * delivery fails. `false` disables the user-facing notice (errors still
   * reach {@link onError}).
   * @default 'Something went wrong processing your message.'
   */
  errorMessage?: string | false;
  /** Observer for processing failures (logging/metrics). Errors never throw past the pipeline. */
  onError?(error: unknown, event: ChannelEvent): void;
  /**
   * Thread multi-turn conversations: remember the last run id per
   * `provider:conversationId` and pass it as `context.parent_id` on the next
   * message, so the agent keeps its memory across messages (same mechanism
   * the platform chat UI uses). In-memory — restarting the server starts
   * conversations fresh. @default true
   */
  sessionContinuity?: boolean;
}

/** conversation key → last run id, insertion-order bounded. */
class SessionStore {
  private readonly entries = new Map<string, string>();
  constructor(private readonly maxEntries = 5000) {}

  get(key: string): string | undefined {
    return this.entries.get(key);
  }

  set(key: string, runId: string): void {
    this.entries.delete(key); // re-insert → refreshes eviction order
    this.entries.set(key, runId);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * Webhook path for a binding:
 * `{prefix}{binding.path ?? '/' + workforce + '/' + provider}`.
 *
 * Product rule today: one binding per `(workforce, provider)`. The workforce
 * segment (prefer uid) keeps multi-agent Telegram/Slack URLs distinct. A
 * future binding-id segment can extend this without breaking the prefix.
 */
export function resolveBindingPath(binding: ChannelBinding, prefix = '/channels'): string {
  return `${prefix}${binding.path ?? `/${binding.workforce}/${binding.adapter.provider}`}`;
}

export interface ResolveChannelBindingsOptions {
  bindings?: ChannelBinding[];
  channelSpecs?: ProjectChannelSpec[];
  configCacheTtlMs?: number;
  env?: Record<string, string | undefined>;
  onSkippedSpec?(skipped: SkippedChannelSpec): void;
}

/**
 * Resolve the effective channel bindings:
 *
 * 1. explicit `bindings` (static, hand-written)
 * 2. `channelSpecs` override (tests / local)
 * 3. platform-linked (`TIMBAL_PROJECT_ID` set): the **runtime endpoint**
 *    (`GET .../channels/runtime`, TTL-cached) — topology *and* platform-held
 *    credentials, so channels added in the UI work with zero env vars.
 *    Per-spec credential precedence: `spec.credentials` → env convention
 *    vars → skipped as `missing-credentials`.
 * 4. runtime endpoint 404 (older platform): `project.channels` topology
 *    (same TTL-cached project fetch the auth gate uses) + env credentials.
 * 5. platform unreachable / not linked: env conventions
 *    ({@link channelBindingsFromEnv}).
 *
 * An **empty array** from the platform is authoritative — all channels off,
 * no env fallback. Env conventions only apply when the platform has no
 * channel data at all (absent field, 404, unreachable, unlinked): a platform
 * blip degrades to env rather than dropping webhooks, but "zero channels
 * configured" must stay zero.
 */
export async function resolveChannelBindings(
  timbal: Timbal,
  options: ResolveChannelBindingsOptions = {}
): Promise<ChannelBinding[]> {
  if (options.bindings) return options.bindings;
  const env = options.env ?? process.env;

  let specs = options.channelSpecs ?? null;
  if (!specs && env.TIMBAL_PROJECT_ID) {
    try {
      specs = await getCachedRuntimeChannels(timbal, {
        ttlMs: options.configCacheTtlMs,
      });
    } catch {
      specs = null; // fail-soft — try the project payload next
    }
    if (specs === null) {
      try {
        const project = await getCachedProject(timbal, {
          ttlMs: options.configCacheTtlMs,
        });
        specs = channelSpecsFromProject(project);
      } catch {
        specs = null; // fail-soft: platform unreachable → env conventions
      }
    }
  }

  // `[]` is deliberately truthy here: platform-says-none ≠ platform-says-
  // nothing. Only `null` (no platform data) reaches the env fallback.
  if (specs) {
    const { bindings, skipped } = materializeChannelBindings(specs, env);
    for (const s of skipped) options.onSkippedSpec?.(s);
    return bindings;
  }
  return channelBindingsFromEnv({ env });
}

/**
 * Elysia plugin that connects messaging channels (Slack, Telegram, ...) to
 * workforce components.
 *
 * Mounts one `POST` webhook route per binding and runs the channel-agnostic
 * pipeline: **verify → ack → dedupe → parse → workforce → reply**. The
 * webhook is acked immediately (Slack's 3-second deadline) and the workforce
 * run + reply happen detached, streaming progressive edits where the channel
 * supports them.
 *
 * **Auth:** webhook routes must bypass `timbalAuth` ingress — they authenticate
 * via provider signatures, not user tokens. Spread {@link CHANNELS_PUBLIC_PATHS}
 * into `timbalAuth({ publicPaths })` (or pass `["/channels/"]` directly).
 *
 * **Provisioning (dynamic mode):** on mount, fire-and-forget
 * {@link registerChannelWebhooks} so Telegram `setWebhook` runs without a
 * manual startup call. A config-refresh hook re-runs provisioning when the
 * platform pushes channel changes. Static mode (`bindings` set) skips both —
 * the app owns those URLs.
 *
 * ```ts
 * import {
 *   timbalAuth,
 *   timbalChannels,
 *   CHANNELS_PUBLIC_PATHS,
 * } from "@timbal-ai/timbal-sdk/elysia";
 *
 * const app = new Elysia()
 *   .use(timbalAuth({ publicPaths: [...CHANNELS_PUBLIC_PATHS] })) // mounts config refresh
 *   .use(timbalChannels())
 *   .listen(3000);
 *
 * // ...or hand-written bindings (URLs: /channels/{workforce}/{provider}):
 * timbalChannels({
 *   bindings: [
 *     { adapter: telegram({ botToken }), workforce: "support-agent" },
 *     { adapter: slack({ signingSecret, botToken }), workforce: "sales-agent" },
 *   ],
 * })
 * ```
 *
 * The default workforce input is `{ prompt: event.text }`. Events carrying
 * attachments (Telegram photos/documents) are re-uploaded to Timbal temp
 * storage and sent as prompt content parts
 * (`{ prompt: [{type:'text',...}, {type:'file', file: url}] }`) — the same
 * shape the platform chat UI produces. Use `binding.buildInput` to thread
 * conversation/user context into components with richer input schemas (e.g.
 * session continuity keyed on `event.conversationId`); an override takes
 * full control, including attachment handling via `event.attachments`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function timbalChannels(options: TimbalChannelsOptions = {}): any {
  const timbal = options.timbal ?? new Timbal();
  const prefix = options.prefix ?? '/channels';
  const dedupe = new DedupeCache(options.dedupeTtlMs);
  const sessions = options.sessionContinuity !== false ? new SessionStore() : null;
  const errorMessage = options.errorMessage ?? 'Something went wrong processing your message.';

  // Dedupe skipped-spec reports per provider:reason — dynamic mode resolves
  // on every webhook, and a misconfigured channel shouldn't spam the observer.
  const reportedSkips = new Set<string>();
  const onSkippedSpec = (skipped: SkippedChannelSpec): void => {
    const key = `${skipped.spec.provider}:${skipped.reason}`;
    if (reportedSkips.has(key)) return;
    reportedSkips.add(key);
    try {
      options.onSkippedSpec?.(skipped);
    } catch {
      /* observer must not take down the pipeline */
    }
  };

  /**
   * Default workforce input. Text-only events keep the legacy shape
   * (`{ prompt: text }`). Events with attachments download each file from
   * the provider (adapter-authenticated) and re-upload it to Timbal temp
   * storage (`POST /files`) via the pipeline's own client — on deployed
   * projects that authenticates as the project service principal
   * (`TIMBAL_PROJECT_SECRET`) — then send prompt content parts, the same
   * shape the platform chat UI uses.
   */
  async function buildDefaultInput(event: ChannelEvent): Promise<Record<string, unknown>> {
    const attachments = event.attachments ?? [];
    if (attachments.length === 0) return { prompt: event.text };

    const parts: Array<Record<string, unknown>> = [];
    if (event.text) parts.push({ type: 'text', text: event.text });
    const failures: unknown[] = [];
    for (const attachment of attachments) {
      try {
        const { data, contentType, fileName } = await attachment.download();
        const tmp = await timbal.uploadTempFileFromBuffer(data, fileName, contentType);
        parts.push({ type: 'file', file: tmp.url });
      } catch (err) {
        // Per-attachment fail-soft: a 20MB-cap photo shouldn't sink the
        // caption + other files. Collected, not thrown — unless nothing at
        // all survives.
        failures.push(err);
      }
    }
    if (parts.length === 0) {
      // Bare attachment(s), all failed — nothing to run the workforce on.
      // Throw into the pipeline's error path so the user gets the notice.
      throw failures[0] ?? new Error('No usable message content');
    }
    for (const err of failures) {
      try {
        options.onError?.(err, event);
      } catch {
        /* observer must not take down the pipeline */
      }
    }
    return { prompt: parts };
  }

  async function process(binding: ChannelBinding, event: ChannelEvent): Promise<void> {
    const delivery = binding.adapter.delivery(event);
    const reply = new StreamingReply(delivery, {
      // Product default is OFF while streaming is experimental; the
      // low-level StreamingReply class itself defaults on.
      streaming: binding.streaming ?? options.streaming ?? false,
      editIntervalMs: options.editIntervalMs,
    });
    // Tracked outside `try` so the catch can tell "file already reached the
    // user" apart from "nothing delivered" — StreamingReply only knows about
    // text.
    let fileDelivered = false;
    try {
      const wf = timbal.workforce.get(binding.workforce);
      const input = binding.buildInput?.(event) ?? (await buildDefaultInput(event));

      const sessionKey = `${event.provider}:${event.conversationId}`;
      const parentId = sessions?.get(sessionKey);

      // Collector understands the Timbal runtime vocabulary (DELTA/OUTPUT)
      // plus the simplified lowercase shapes. See WorkforceTextCollector.
      const collector = new WorkforceTextCollector();
      let runId: string | undefined;
      for await (const ev of wf.events(input, parentId ? { parentId } : undefined)) {
        if (!runId && typeof ev.run_id === 'string') runId = ev.run_id;
        const updated = collector.push(ev);
        if (updated !== null) reply.update(updated);
      }
      // Only advance the thread when the user actually got a reply — chaining
      // onto a silent/empty run would make the next message inherit a parent
      // the user never saw. Called at every delivery milestone (idempotent)
      // rather than once at the end: a file send failing later must not
      // undo continuity for text the user already received — dedupe keeps
      // the claim in that case, so the run would otherwise be orphaned.
      const advanceSession = (): void => {
        if (sessions && runId) sessions.set(sessionKey, runId);
      };

      const textDelivered = await reply.finalize(collector.text);
      if (textDelivered) advanceSession();

      // Files the agent attached to its reply — sent after the text, in
      // order. Channels with `sendFile` get the native treatment (Telegram
      // sendPhoto/sendDocument); without it, URL files degrade to a plain
      // link message and data-URL files are dropped (reported, not posted —
      // megabytes of base64 as chat text helps nobody).
      for (const file of collector.files) {
        if (delivery.sendFile) {
          await delivery.sendFile(file.file, { fileName: file.fileName });
          fileDelivered = true;
          advanceSession();
        } else if (!file.file.startsWith('data:')) {
          await delivery.send(file.fileName ? `${file.fileName}: ${file.file}` : file.file);
          fileDelivered = true;
          advanceSession();
        } else {
          try {
            options.onError?.(
              new Error('Reply file dropped: channel has no sendFile and file is a data URL'),
              event
            );
          } catch {
            /* observer must not take down the pipeline */
          }
        }
      }

      // A run that completed with nothing reaching the user (silent
      // workforce, or every reply file dropped) releases the idempotency
      // claim — mirroring the error path below: a claim that produced no
      // user-visible output must not swallow provider redelivery.
      if (event.dedupeKey && !reply.didDeliver && !fileDelivered) {
        dedupe.forget(event.dedupeKey);
      }
    } catch (err) {
      // Drain in-flight stream sends before inspecting didDeliver — update()
      // enqueues asynchronously, so a throw right after the first delta can
      // race the postMessage.
      await reply.settle();
      // Release the dedupe claim only when nothing reached the channel yet —
      // otherwise Slack/Telegram redelivery would re-run the workforce and
      // post a duplicate on top of a partial reply. User can resend.
      if (event.dedupeKey && !reply.didDeliver && !fileDelivered) {
        dedupe.forget(event.dedupeKey);
      }
      try {
        options.onError?.(err, event);
      } catch {
        /* observer must not take down the pipeline */
      }
      if (errorMessage !== false) {
        try {
          await binding.adapter.delivery(event).send(errorMessage);
        } catch {
          /* channel unreachable — nothing left to do */
        }
      }
    }
  }

  async function handleWebhook(binding: ChannelBinding, request: Request): Promise<Response> {
    // Read the body once, as text — signature verification (Slack HMAC)
    // needs the exact raw bytes, and a Request body is single-read.
    const req: WebhookRequest = {
      rawBody: await request.text(),
      headers: request.headers,
      url: request.url,
    };

    const verdict = await binding.adapter.verify(req);
    if (verdict !== 'ok') return verdict;

    const events = await binding.adapter.parse(req);
    for (const event of events) {
      if (event.dedupeKey && dedupe.seen(event.dedupeKey)) continue;
      // Detached on purpose: the webhook must ack now (Slack retries after
      // 3s), the agent replies out-of-band via the channel's send API.
      void process(binding, event);
    }

    return binding.adapter.ack?.(req) ?? new Response(null, { status: 200 });
  }

  const app = new Elysia({ name: 'timbal-channels' });

  if (options.bindings) {
    // STATIC mode: fixed routes known at mount time. Supports custom `path`s.
    for (const binding of options.bindings) {
      const path = resolveBindingPath(binding, prefix);
      app.post(path, ({ request }: { request: Request }) => handleWebhook(binding, request), {
        detail: { hide: true },
      });
    }
    return app;
  }

  // DYNAMIC mode: one wildcard route keyed by workforce + provider
  // (`/channels/{uid}/telegram`). Binding set is resolved per request from
  // platform config (runtime endpoint with platform-held credentials,
  // TTL-cached), so channels added in the platform UI go live without env
  // changes or redeploys. Product rule: one binding per
  // (workforce, provider); a future `:bindingId` segment can relax that.
  // Custom `path`s require static mode.

  const provisionOpts: RegisterChannelWebhooksOptions = {
    timbal,
    channelSpecs: options.channelSpecs,
    configCacheTtlMs: options.configCacheTtlMs,
    prefix,
    env: options.env,
  };

  // Startup provisioning — fire-and-forget so apps don't need a manual
  // `registerChannelWebhooks()` after `.listen()`. Failures are best-effort;
  // the refresh hook + TTL retry cover them. Never take down mount.
  void registerChannelWebhooks(provisionOpts).catch(() => {
    /* best-effort — refresh + TTL retry */
  });

  // On platform-config refresh, re-run programmatic webhook provisioning so
  // a binding that appeared (or gained credentials) gets its Telegram
  // `setWebhook` — startup-only registration misses channels added later.
  registerConfigRefreshHook('channels:webhook-provisioning', async () => {
    await registerChannelWebhooks(provisionOpts).catch(() => {
      /* best-effort — TTL + next refresh retry cover it */
    });
  });
  app.post(
    `${prefix}/:workforce/:provider`,
    async ({
      request,
      params,
    }: {
      request: Request;
      params: { workforce: string; provider: string };
    }) => {
      let bindings: ChannelBinding[];
      try {
        bindings = await resolveChannelBindings(timbal, {
          channelSpecs: options.channelSpecs,
          configCacheTtlMs: options.configCacheTtlMs,
          env: options.env,
          onSkippedSpec,
        });
      } catch {
        // Env conventions throw when credentials exist without
        // CHANNELS_WORKFORCE — loud at startup, but a per-request resolve
        // must not 500 Slack/Telegram (they'd retry forever).
        return new Response('Channel configuration error', { status: 503 });
      }
      const binding = bindings.find(
        b => b.workforce === params.workforce && b.adapter.provider === params.provider
      );
      if (!binding) return new Response('Unknown channel', { status: 404 });
      return handleWebhook(binding, request);
    },
    { detail: { hide: true } }
  );

  return app;
}

export interface RegisterChannelWebhooksOptions {
  /** Bindings to provision. Defaults to the same resolution as the plugin's dynamic mode. */
  bindings?: ChannelBinding[];
  /** Platform channel specs override (tests / local dev). */
  channelSpecs?: ProjectChannelSpec[];
  /** Timbal client for the platform config fetch. Defaults to a fresh service client. */
  timbal?: Timbal;
  /** TTL for the cached platform project fetch, ms. @default 60000 */
  configCacheTtlMs?: number;
  /** Path prefix, matching the plugin's. @default '/channels' */
  prefix?: string;
  /** Environment source for credentials + origin resolution (injectable for tests). */
  env?: Record<string, string | undefined>;
  /** Fetch used for the dev-tunnel probe (injectable for tests). */
  fetchImpl?: typeof fetch;
}

/** One binding's provisioning outcome. */
export interface WebhookRegistration {
  provider: string;
  workforce: string;
  /** Full webhook URL, when an origin was resolved. */
  url: string | null;
  /** True when the adapter's programmatic registration ran successfully. */
  registered: boolean;
  /** Why registration didn't run. */
  reason?: 'manual-registration' | 'no-origin';
}

export interface ChannelProvisionResult {
  /** The origin webhooks were registered against, or `null` if unresolvable. */
  origin: string | null;
  registrations: WebhookRegistration[];
  /**
   * Platform specs that couldn't become live bindings (missing env
   * credentials, unknown provider). Startup is where a silently-dead
   * channel should surface, so they're reported here for the app to log.
   */
  skipped: SkippedChannelSpec[];
}

/**
 * Provision webhooks for every binding that supports programmatic
 * registration (Telegram `setWebhook`; Slack/Teams are manifest/console-driven
 * and are reported as `manual-registration` with their URL, for the app to
 * surface).
 *
 * In dynamic mode, {@link timbalChannels} already calls this on mount and on
 * config refresh — apps usually don't need a manual startup call. Static mode
 * (explicit `bindings`) still needs an explicit call if you want programmatic
 * registration.
 *
 * The origin resolves via {@link resolvePublicOrigin}: explicit argument >
 * `PUBLIC_ORIGIN` env > platform derivation (`TIMBAL_PROJECT_ENV_ID` →
 * `https://e{id}.{domain}/api`) > running ngrok tunnel (local dev only —
 * skipped when `TIMBAL_PROJECT_ID` is set). When nothing resolves, no
 * registration runs and every entry carries `reason: 'no-origin'` —
 * logging/failing on that is the caller's policy, not the SDK's.
 *
 * ```ts
 * const { origin, registrations } = await registerChannelWebhooks({ bindings });
 * ```
 */
export async function registerChannelWebhooks(
  options: RegisterChannelWebhooksOptions = {},
  origin?: string
): Promise<ChannelProvisionResult> {
  const skipped: SkippedChannelSpec[] = [];
  const bindings = await resolveChannelBindings(options.timbal ?? new Timbal(), {
    bindings: options.bindings,
    channelSpecs: options.channelSpecs,
    configCacheTtlMs: options.configCacheTtlMs,
    env: options.env,
    onSkippedSpec: s => skipped.push(s),
  });
  const prefix = options.prefix ?? '/channels';
  const resolved = await resolvePublicOrigin({
    origin,
    env: options.env,
    fetchImpl: options.fetchImpl,
  });
  const base = resolved?.replace(/\/$/, '') ?? null;

  const registrations: WebhookRegistration[] = [];
  for (const binding of bindings) {
    const path = resolveBindingPath(binding, prefix);
    const url = base ? `${base}${path}` : null;

    if (!url) {
      registrations.push({
        provider: binding.adapter.provider,
        workforce: binding.workforce,
        url: null,
        registered: false,
        reason: 'no-origin',
      });
      continue;
    }
    if (!binding.adapter.registerWebhook) {
      registrations.push({
        provider: binding.adapter.provider,
        workforce: binding.workforce,
        url,
        registered: false,
        reason: 'manual-registration',
      });
      continue;
    }
    await binding.adapter.registerWebhook(url);
    registrations.push({
      provider: binding.adapter.provider,
      workforce: binding.workforce,
      url,
      registered: true,
    });
  }

  return { origin: base, registrations, skipped };
}
