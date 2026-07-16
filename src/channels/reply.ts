import type { ChannelDelivery } from './types';

export interface StreamingReplyOptions {
  /**
   * Stream progressive edits while the agent generates. When `false`, the
   * reply is posted once, complete, at `finalize` — no mid-generation
   * traffic. Streaming is **experimental**: it leans on channel edit APIs
   * with per-conversation rate limits and length quirks. @default true
   */
  streaming?: boolean;
  /**
   * Minimum interval between edits, in ms. Slack `chat.update` and Telegram
   * `editMessageText` tolerate roughly one call per second per conversation;
   * anything faster gets 429s. @default 1000
   */
  editIntervalMs?: number;
  /** Injectable clock (tests). @default Date.now */
  now?: () => number;
  /** Injectable timer (tests). @default setTimeout */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Cancel a handle from {@link schedule}. @default clearTimeout */
  cancel?: (handle: unknown) => void;
}

/**
 * Progressive-reply writer over a {@link ChannelDelivery}.
 *
 * Callers push the full accumulated text on every delta (`update`); this
 * class turns that firehose into channel-safe traffic:
 *
 * - The first `update` sends a new message and remembers its ref.
 * - Subsequent updates edit that message, throttled and **coalesced** — at
 *   most one edit per `editIntervalMs`, always carrying the latest text.
 *   Intermediate states are dropped, never queued (editing a chat message
 *   to a stale state is worse than skipping it).
 * - **Length**: streamed edits stop growing at the channel's
 *   `maxTextLength`; `finalize` splits the definitive text into multiple
 *   messages at that limit (preferring newline/space boundaries), editing
 *   the streamed message down to chunk one and sending the rest fresh.
 * - `finalize` flushes the definitive text, bypassing the throttle window,
 *   and settles only after every in-flight call has finished.
 * - Deliveries without `edit` support, or `streaming: false`, degrade
 *   gracefully: nothing is sent during generation and the whole reply is
 *   posted at `finalize`.
 *
 * Send/edit failures are swallowed after the first send: a dropped edit
 * only costs freshness, and the final state is re-asserted by `finalize`
 * (whose errors DO propagate, so the pipeline can report delivery failure).
 */
export class StreamingReply {
  private readonly streaming: boolean;
  private readonly editIntervalMs: number;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  private ref: unknown = null;
  private sent = false;
  private latestText = '';
  private deliveredText: string | null = null;
  private lastEditAt = 0;
  private timerArmed = false;
  private timerHandle: unknown = null;
  private done = false;
  private capped = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly delivery: ChannelDelivery,
    options: StreamingReplyOptions = {},
  ) {
    this.streaming = options.streaming ?? true;
    this.editIntervalMs = options.editIntervalMs ?? 1000;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Push the latest accumulated text. Non-blocking; safe to call per delta. */
  update(text: string): void {
    if (!text) return;
    this.latestText = text;
    // No streaming (disabled, or channel can't edit) — wait for finalize().
    if (!this.streaming || !this.delivery.edit) return;
    // Past the channel's length cap: stop editing; finalize() will split
    // into multiple messages. Keeping the capped message stable beats
    // hammering the API with edits that would be rejected (MESSAGE_TOO_LONG).
    if (this.capped) return;

    if (!this.sent) {
      this.sent = true;
      this.lastEditAt = this.now();
      this.enqueue(async () => {
        // Reads latestText at execution time (a microtask later), so a burst
        // of synchronous deltas coalesces into the send itself.
        const text = this.streamableText();
        this.ref = await this.delivery.send(text);
        this.deliveredText = text;
      });
      return;
    }
    this.scheduleEdit();
  }

  /**
   * Deliver the definitive text and settle all in-flight traffic. Always call
   * this exactly once, even when no deltas arrived (empty final text is
   * skipped). Throws if the final delivery itself fails.
   */
  async finalize(text?: string): Promise<void> {
    if (text !== undefined) this.latestText = text;
    const finalText = this.latestText;

    // Kill any trailing-edge edit timer first — otherwise it can fire after
    // we write the definitive text and overwrite it with stale/capped stream
    // text. The done flag also no-ops a callback already in the event queue.
    this.done = true;
    this.disarmTimer();

    await this.chain.catch(() => {}); // drain in-flight sends/edits

    if (!finalText || finalText === this.deliveredText) return;
    const chunks = splitText(finalText, this.delivery.maxTextLength);
    const first = chunks[0] ?? finalText;
    const rest = chunks.slice(1);

    if (!this.sent) {
      await this.delivery.send(first);
    } else if (this.delivery.edit && this.ref !== null && first !== this.deliveredText) {
      await this.delivery.edit(this.ref, first);
    }
    this.deliveredText = first;
    for (const chunk of rest) {
      await this.delivery.send(chunk);
    }
  }

  /** Latest text truncated to what the channel accepts in one message. */
  private streamableText(): string {
    const max = this.delivery.maxTextLength;
    if (max === undefined || this.latestText.length <= max) return this.latestText;
    this.capped = true;
    return this.latestText.slice(0, max);
  }

  /** Arm (at most) one trailing-edge edit carrying whatever text is latest. */
  private scheduleEdit(): void {
    if (this.timerArmed || this.done) return;
    const wait = Math.max(0, this.lastEditAt + this.editIntervalMs - this.now());
    this.timerArmed = true;
    this.timerHandle = this.schedule(() => {
      this.timerArmed = false;
      this.timerHandle = null;
      if (this.done) return;
      this.lastEditAt = this.now();
      this.enqueue(async () => {
        if (this.done) return;
        const text = this.streamableText();
        // Skip no-op edits (the send may already carry this text).
        if (this.ref === null || !this.delivery.edit || text === this.deliveredText) return;
        await this.delivery.edit(this.ref, text);
        this.deliveredText = text;
      });
    }, wait);
  }

  private disarmTimer(): void {
    if (!this.timerArmed) return;
    if (this.timerHandle !== null) this.cancel(this.timerHandle);
    this.timerHandle = null;
    this.timerArmed = false;
  }

  /** Serialize sends/edits so they can't reorder (edit racing ahead of send). */
  private enqueue(op: () => Promise<void>): void {
    this.chain = this.chain.then(op).catch(() => {
      // Swallow: a lost edit is cosmetic; finalize() re-asserts final state.
    });
  }
}

/**
 * Split `text` into chunks of at most `max` characters, breaking at the last
 * newline (preferred) or space inside each window when one exists in the
 * final 20% — hard cut otherwise. Trailing/leading whitespace at the seam is
 * trimmed. `max` undefined → single chunk.
 */
export function splitText(text: string, max?: number): string[] {
  if (max === undefined || text.length <= max) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const minBreak = Math.floor(max * 0.8);
    const newline = window.lastIndexOf('\n');
    const space = window.lastIndexOf(' ');
    const breakAt =
      newline >= minBreak ? newline : space >= minBreak ? space : max;
    chunks.push(rest.slice(0, breakAt).trimEnd());
    rest = rest.slice(breakAt).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
