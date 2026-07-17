/**
 * Core contracts for messaging-channel connectivity (Slack, Telegram, Teams,
 * ...). An adapter owns everything channel-specific — webhook verification,
 * payload normalization, and outbound delivery — while the Elysia plugin
 * (`timbalChannels`) owns the channel-agnostic pipeline:
 *
 *   verify → ack → dedupe → parse → workforce.events() → reply
 *
 * Adapters are pure and stateless: they never touch Elysia or the Timbal
 * client, which keeps them unit-testable and reusable if webhook termination
 * ever moves out of the app (e.g. a central platform gateway).
 */

/**
 * A webhook request, pre-read by the pipeline. The raw body is captured once
 * as text (a `Request` body can only be consumed once) so both signature
 * verification and parsing can see the exact bytes.
 */
export interface WebhookRequest {
  /** Raw request body, exactly as received (signature checks need this). */
  rawBody: string;
  /** Request headers. */
  headers: Headers;
  /** Full request URL. */
  url: string;
}

/** Raw bytes + metadata of a downloaded attachment. */
export interface ChannelAttachmentData {
  data: Uint8Array;
  contentType: string;
  fileName: string;
}

/**
 * A media file attached to an incoming message (photo, document, ...).
 *
 * The adapter supplies metadata plus a **lazy, adapter-authenticated**
 * `download()` — providers gate file content behind their own auth (Telegram
 * `getFile` + token-bearing URL, Slack `url_private` + bot token), and those
 * URLs must never leak past the adapter (they embed credentials and expire).
 * The pipeline downloads and re-uploads to Timbal temp storage
 * (`POST /files`), so the workforce only ever sees a platform URL.
 */
export interface ChannelAttachment {
  /** Broad media class — drives filename synthesis and future routing. */
  kind: 'image' | 'document' | 'audio' | 'video';
  /** Original filename, when the provider carries one. */
  fileName?: string;
  /** MIME type, when the provider carries one. */
  contentType?: string;
  /** Declared size in bytes, when known (pre-download hint, not verified). */
  sizeBytes?: number;
  /** Fetch the raw bytes from the provider, using the adapter's credentials. */
  download(): Promise<ChannelAttachmentData>;
}

/**
 * A normalized incoming message, provider-agnostic. This is the only shape
 * the pipeline (and the workforce input builder) ever sees.
 */
export interface ChannelEvent {
  /** Adapter provider id (`'slack'`, `'telegram'`, ...). */
  provider: string;
  /**
   * Stable conversation identity — Slack `channel:thread_ts`, Telegram
   * `chat.id`, Teams `conversation.id`. Use it to key session continuity.
   */
  conversationId: string;
  /** Sender's id in the channel's namespace (Slack user id, Telegram from.id). */
  externalUserId?: string;
  /** Sender's display name, when the payload carries one. */
  userDisplayName?: string;
  /**
   * Message text, cleaned of channel artifacts (e.g. leading bot mentions).
   * Media messages use the caption; may be `''` for a bare attachment.
   */
  text: string;
  /** Media attached to the message. Absent/empty for text-only messages. */
  attachments?: ChannelAttachment[];
  /**
   * Idempotency key for webhook redelivery (Slack retries, Telegram
   * re-sends on non-200). Events without one are never deduped.
   */
  dedupeKey?: string;
  /** The original provider payload, for adapters' responders and escape hatches. */
  raw: unknown;
}

/**
 * Outbound delivery primitives for one incoming event. The pipeline wraps
 * these in a {@link StreamingReply} that handles throttling and coalescing —
 * adapters just implement the raw send/edit calls.
 */
export interface ChannelDelivery {
  /**
   * Post a new message into the event's conversation. Returns an opaque
   * message reference that `edit` receives back (e.g. Slack `{channel, ts}`,
   * Telegram `message_id`).
   */
  send(text: string): Promise<unknown>;
  /**
   * Replace the text of a previously sent message. Optional — channels
   * without edit support still work, they just don't stream (the reply is
   * posted once, when complete).
   */
  edit?(ref: unknown, text: string): Promise<void>;
  /**
   * Delete a previously sent message. Optional — used to retract streamed
   * interim text when the definitive reply turns out to carry no text
   * (e.g. a file-only reply): a message can't be edited to empty, so
   * channels without `delete` keep the interim text on screen.
   */
  delete?(ref: unknown): Promise<void>;
  /**
   * Post a file into the event's conversation. `file` is either an
   * `https://` URL (platform CDN / temp storage — channels that can fetch
   * URLs server-side, like Telegram, pass it through) or a
   * `data:<mime>;base64,...` URL (unpersisted agent output — must be
   * decoded and uploaded as bytes). Optional — channels without it degrade:
   * the pipeline posts URL files as a plain text message and drops data-URL
   * files.
   */
  sendFile?(file: string, opts?: { fileName?: string }): Promise<unknown>;
  /**
   * The channel's max message length, in characters (Telegram 4096, Slack
   * 40k). The reply writer streams edits only up to this cap and splits the
   * final text into multiple messages beyond it. Unset = unlimited.
   */
  readonly maxTextLength?: number;
}

/**
 * Everything channel-specific, behind one interface. Register a binding with
 * `timbalChannels({ bindings: [{ adapter: telegram({...}), workforce: 'my-agent' }] })`.
 */
export interface ChannelAdapter {
  /** Provider id — used in the default webhook path (`/channels/{workforce}/{provider}`). */
  readonly provider: string;

  /**
   * Authenticate the webhook and handle protocol handshakes.
   *
   * Return `'ok'` to continue the pipeline, or a `Response` to short-circuit
   * — both for rejections (bad signature → 401) and for handshakes that must
   * answer inline (Slack `url_verification` challenge echo).
   */
  verify(req: WebhookRequest): Response | 'ok' | Promise<Response | 'ok'>;

  /**
   * Normalize the payload into zero or more {@link ChannelEvent}s. Return
   * `[]` for payloads that shouldn't invoke the workforce (bot echoes,
   * non-text updates, status callbacks). Runs only after `verify` passed.
   */
  parse(req: WebhookRequest): ChannelEvent[] | Promise<ChannelEvent[]>;

  /** Build the outbound delivery primitives for one incoming event. */
  delivery(event: ChannelEvent): ChannelDelivery;

  /**
   * The immediate webhook acknowledgment. Defaults to an empty 200 — which
   * is what Slack (3-second deadline) and Telegram both want. Override only
   * for channels with a different ack contract.
   */
  ack?(req: WebhookRequest): Response;

  /**
   * Provision the webhook programmatically where the channel API allows it
   * (Telegram `setWebhook`). Channels requiring manual/console setup (Slack
   * app manifest, Teams bot registration) leave this undefined.
   */
  registerWebhook?(webhookUrl: string): Promise<void>;
}

/** Maps one channel (adapter + credentials) onto one workforce component. */
export interface ChannelBinding {
  adapter: ChannelAdapter;
  /**
   * Workforce component identifier (id, uid, or name) — resolved via
   * `timbal.workforce.get(identifier)`.
   */
  workforce: string;
  /**
   * Webhook path under the plugin prefix. Defaults to
   * `/{workforce}/{adapter.provider}` (e.g. `/joi/telegram`). Override only
   * for non-standard mounts; the product rule is one binding per
   * `(workforce, provider)`.
   */
  path?: string;
  /**
   * Map the normalized event to the workforce input. Defaults to
   * `{ prompt: event.text }`; when the event carries attachments, the
   * pipeline uploads them to Timbal temp storage and sends prompt content
   * parts (`{type:'text'}` / `{type:'file', file: url}`) instead. Override
   * when your component expects a different input schema or wants
   * conversation/user context threaded in — an override takes full control,
   * including attachment handling.
   */
  buildInput?(event: ChannelEvent): Record<string, unknown>;
  /**
   * Stream the reply via progressive edits (experimental). Overrides the
   * plugin-level `streaming` option for this binding. @default false
   */
  streaming?: boolean;
}
