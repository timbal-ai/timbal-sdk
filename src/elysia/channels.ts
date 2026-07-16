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
import { getCachedProject } from '../auth/config';
import type { ProjectChannelSpec } from '../types';
import type {
  ChannelBinding,
  ChannelEvent,
  WebhookRequest,
} from '../channels/types';

export interface TimbalChannelsOptions {
  /**
   * Hand-written channel → workforce bindings (static mode: fixed routes,
   * supports custom `path`s and multiple bindings per provider). When
   * omitted, the plugin runs in **dynamic mode**: bindings are resolved
   * per-request from platform project settings (`project.channels`, TTL
   * cached — the "add a channel in the dropdown, no redeploy" path), falling
   * back to env conventions ({@link channelBindingsFromEnv}) whenever the
   * platform doesn't return the field, is unreachable, or the process isn't
   * platform-linked.
   */
  bindings?: ChannelBinding[];
  /**
   * Platform channel specs override (tests / local dev) — skips the platform
   * fetch in dynamic mode, mirroring `timbalAuth`'s `authConfig` override.
   */
  channelSpecs?: ProjectChannelSpec[];
  /** TTL for the cached platform project fetch, ms. @default 60000 */
  configCacheTtlMs?: number;
  /** Environment source for credentials/fallbacks (injectable for tests). */
  env?: Record<string, string | undefined>;
  /**
   * Observer for platform specs that couldn't be materialized (missing env
   * credentials, provider unknown to this SDK version). Fires on resolution,
   * deduped per `provider:reason` so it doesn't spam per request.
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

/** Webhook path for a binding: `{prefix}{binding.path ?? '/' + provider}`. */
export function resolveBindingPath(
  binding: ChannelBinding,
  prefix = '/channels',
): string {
  return `${prefix}${binding.path ?? `/${binding.adapter.provider}`}`;
}

export interface ResolveChannelBindingsOptions {
  bindings?: ChannelBinding[];
  channelSpecs?: ProjectChannelSpec[];
  configCacheTtlMs?: number;
  env?: Record<string, string | undefined>;
  onSkippedSpec?(skipped: SkippedChannelSpec): void;
}

/**
 * Resolve the effective channel bindings, auth-config style:
 *
 * 1. explicit `bindings` (static, hand-written)
 * 2. `channelSpecs` override (tests / local) → materialized with env creds
 * 3. platform-linked: `project.channels` from the **same TTL-cached project
 *    fetch the auth gate uses** (single-flight, fail-soft) → materialized.
 *    A project without a `channels` field — which is every project until
 *    the platform ships it — falls through to (4), so behavior is
 *    identical to the pre-platform-config SDK.
 * 4. env conventions ({@link channelBindingsFromEnv})
 *
 * Platform errors also fall through to env rather than failing the webhook —
 * a platform blip shouldn't take channels down when env can serve them.
 */
export async function resolveChannelBindings(
  timbal: Timbal,
  options: ResolveChannelBindingsOptions = {},
): Promise<ChannelBinding[]> {
  if (options.bindings) return options.bindings;
  const env = options.env ?? process.env;

  let specs = options.channelSpecs ?? null;
  if (!specs && env.TIMBAL_PROJECT_ID) {
    try {
      const project = await getCachedProject(timbal, {
        ttlMs: options.configCacheTtlMs,
      });
      specs = channelSpecsFromProject(project);
    } catch {
      specs = null; // fail-soft: platform unreachable → env conventions
    }
  }

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
 * ```ts
 * import { timbalAuth, timbalChannels, telegram, slack } from "@timbal-ai/timbal-sdk/elysia";
 *
 * const app = new Elysia()
 *   // Webhooks authenticate via signatures, not user tokens — exempt them
 *   // from the auth ingress gate:
 *   .use(timbalAuth({ publicPaths: ["/channels/"] }))
 *   // Zero-config: channels + target component read from env
 *   // (TELEGRAM_BOT_TOKEN, SLACK_*, CHANNELS_WORKFORCE)...
 *   .use(timbalChannels())
 *   .listen(3000);
 *
 * // ...or hand-written bindings for per-provider routing:
 * timbalChannels({
 *   bindings: [
 *     { adapter: telegram({ botToken }), workforce: "support-agent" },
 *     { adapter: slack({ signingSecret, botToken }), workforce: "sales-agent" },
 *   ],
 * })
 * ```
 *
 * The default workforce input is `{ prompt: event.text }`; use
 * `binding.buildInput` to thread conversation/user context into components
 * with richer input schemas (e.g. session continuity keyed on
 * `event.conversationId`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function timbalChannels(options: TimbalChannelsOptions = {}): any {
  const timbal = options.timbal ?? new Timbal();
  const prefix = options.prefix ?? '/channels';
  const dedupe = new DedupeCache(options.dedupeTtlMs);
  const sessions = options.sessionContinuity !== false ? new SessionStore() : null;
  const errorMessage =
    options.errorMessage ?? 'Something went wrong processing your message.';

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

  async function process(binding: ChannelBinding, event: ChannelEvent): Promise<void> {
    const reply = new StreamingReply(binding.adapter.delivery(event), {
      // Product default is OFF while streaming is experimental; the
      // low-level StreamingReply class itself defaults on.
      streaming: binding.streaming ?? options.streaming ?? false,
      editIntervalMs: options.editIntervalMs,
    });
    try {
      const wf = timbal.workforce.get(binding.workforce);
      const input = binding.buildInput?.(event) ?? { prompt: event.text };

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
      await reply.finalize(collector.text);
      // Only successful runs advance the thread — a failed run would chain
      // the next message onto a run the user never saw a reply to.
      if (sessions && runId) sessions.set(sessionKey, runId);
    } catch (err) {
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

  async function handleWebhook(
    binding: ChannelBinding,
    request: Request,
  ): Promise<Response> {
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
    // STATIC mode: fixed routes known at mount time. Supports custom paths
    // and multiple bindings per provider.
    for (const binding of options.bindings) {
      const path = resolveBindingPath(binding, prefix);
      app.post(
        path,
        ({ request }: { request: Request }) => handleWebhook(binding, request),
        { detail: { hide: true } },
      );
    }
    return app;
  }

  // DYNAMIC mode: one wildcard route; the binding set is resolved per
  // request from platform project settings (TTL-cached — same freshness
  // model as the auth ingress gate), so channels added in the platform UI
  // go live within the cache TTL, no redeploy. Routes are keyed by
  // provider; custom `path`s require static mode.
  app.post(
    `${prefix}/:provider`,
    async ({ request, params }: { request: Request; params: { provider: string } }) => {
      const bindings = await resolveChannelBindings(timbal, {
        channelSpecs: options.channelSpecs,
        configCacheTtlMs: options.configCacheTtlMs,
        env: options.env,
        onSkippedSpec,
      });
      const binding = bindings.find(
        (b) => b.adapter.provider === params.provider,
      );
      if (!binding) return new Response('Unknown channel', { status: 404 });
      return handleWebhook(binding, request);
    },
    { detail: { hide: true } },
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
 * surface). Call once at startup.
 *
 * The origin resolves via {@link resolvePublicOrigin}: explicit argument >
 * `PUBLIC_ORIGIN` env > running ngrok tunnel (local dev only — the tunnel
 * probe is skipped on platform-linked deployments). When nothing resolves,
 * no registration runs and every entry carries `reason: 'no-origin'` —
 * logging/failing on that is the caller's policy, not the SDK's.
 *
 * ```ts
 * const { origin, registrations } = await registerChannelWebhooks({ bindings });
 * ```
 */
export async function registerChannelWebhooks(
  options: RegisterChannelWebhooksOptions = {},
  origin?: string,
): Promise<ChannelProvisionResult> {
  const skipped: SkippedChannelSpec[] = [];
  const bindings = await resolveChannelBindings(options.timbal ?? new Timbal(), {
    bindings: options.bindings,
    channelSpecs: options.channelSpecs,
    configCacheTtlMs: options.configCacheTtlMs,
    env: options.env,
    onSkippedSpec: (s) => skipped.push(s),
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
