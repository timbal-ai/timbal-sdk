import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ChannelAdapter,
  ChannelDelivery,
  ChannelEvent,
  WebhookRequest,
} from '../types';

export interface SlackAdapterOptions {
  /** App signing secret (Basic Information → App Credentials). */
  signingSecret: string;
  /** Bot token (`xoxb-...`) with `chat:write` scope. */
  botToken: string;
  /**
   * Reply in a thread under the triggering message when the message arrived
   * in a **channel or group** — keeps busy channels readable. DMs always
   * reply top-level in the conversation (threading a 1:1 chat is noise),
   * except when the user themselves wrote inside a DM thread, in which case
   * the reply stays in that thread. Set `false` to reply top-level
   * everywhere. @default true
   */
  replyInThread?: boolean;
  /** API origin override (tests). @default https://slack.com/api */
  apiBase?: string;
  /** Max accepted signature timestamp skew, in seconds. @default 300 */
  maxSkewSeconds?: number;
  /** Injectable clock (tests). @default Date.now */
  now?: () => number;
}

/** Subset of Slack's Events API envelope we care about. */
interface SlackEnvelope {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    text?: string;
    user?: string;
    bot_id?: string;
    channel?: string;
    channel_type?: string;
    ts?: string;
    thread_ts?: string;
  };
}

/**
 * DM detection: `channel_type: 'im'` on `message` events; `app_mention`
 * events omit `channel_type`, so fall back to the `D` channel-id prefix
 * (Slack ids are typed by prefix: D = DM, C = channel, G = group).
 */
function isDirectMessage(event: { channel_type?: string; channel?: string }): boolean {
  return event.channel_type === 'im' || (event.channel ?? '').startsWith('D');
}

/**
 * Slack channel adapter (Events API).
 *
 * - `verify` checks the `v0` HMAC signature (signing secret + timestamp,
 *   constant-time compare, ±5 min skew window) and answers the
 *   `url_verification` challenge inline.
 * - `parse` accepts `message` and `app_mention` events, skipping bot
 *   messages and message subtypes (edits, joins) to avoid loops and noise.
 *   `app_mention` duplicates of a `message` collapse via the shared
 *   `event_id`-less client dedupe key (`channel:ts`).
 * - Replies: channel/group mentions thread under the triggering message;
 *   DMs reply top-level in the conversation. Both stream via
 *   `chat.postMessage` + `chat.update`.
 *
 * Webhook registration is manifest-driven (no API to set an Events URL at
 * runtime), so there is no `registerWebhook` — point the app manifest's
 * `event_subscriptions.request_url` at this binding's path and subscribe to
 * `message.channels` / `message.im` / `app_mention` as needed.
 */
export function slack(options: SlackAdapterOptions): ChannelAdapter {
  const { signingSecret, botToken } = options;
  if (!signingSecret) throw new Error('slack adapter requires a signingSecret');
  if (!botToken) throw new Error('slack adapter requires a botToken');
  const apiBase = options.apiBase ?? 'https://slack.com/api';
  const replyInThread = options.replyInThread ?? true;
  const maxSkewSeconds = options.maxSkewSeconds ?? 300;
  const now = options.now ?? Date.now;

  function signatureValid(req: WebhookRequest): boolean {
    const timestamp = req.headers.get('x-slack-request-timestamp');
    const signature = req.headers.get('x-slack-signature');
    if (!timestamp || !signature) return false;

    // Replay guard: reject requests older (or newer) than the skew window.
    const age = Math.abs(now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > maxSkewSeconds) return false;

    const expected = `v0=${createHmac('sha256', signingSecret)
      .update(`v0:${timestamp}:${req.rawBody}`)
      .digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async function api(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${apiBase}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${botToken}`,
      },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; [k: string]: unknown }
      | null;
    if (!res.ok || !payload?.ok) {
      throw new Error(`Slack ${method} failed (${res.status}): ${payload?.error ?? 'unknown error'}`);
    }
    return payload;
  }

  return {
    provider: 'slack',

    verify(req: WebhookRequest): Response | 'ok' {
      if (!signatureValid(req)) {
        return new Response('Invalid signature', { status: 401 });
      }

      // URL verification handshake: echo the challenge in the HTTP response.
      try {
        const body = JSON.parse(req.rawBody) as SlackEnvelope;
        if (body.type === 'url_verification' && body.challenge) {
          return new Response(JSON.stringify({ challenge: body.challenge }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      } catch {
        /* not JSON — fall through, parse() will drop it */
      }

      return 'ok';
    },

    parse(req: WebhookRequest): ChannelEvent[] {
      let envelope: SlackEnvelope;
      try {
        envelope = JSON.parse(req.rawBody) as SlackEnvelope;
      } catch {
        return [];
      }
      if (envelope.type !== 'event_callback') return [];

      const event = envelope.event;
      const isMessage = event?.type === 'message' || event?.type === 'app_mention';
      // Skip bot messages (incl. our own replies — loop guard) and message
      // subtypes: edits, deletes, channel joins, etc.
      if (!isMessage || !event?.channel || !event.ts || event.bot_id || event.subtype) {
        return [];
      }

      // Strip a leading bot @-mention so the agent sees clean text.
      const text = (event.text ?? '').replace(/^\s*<@[A-Z0-9]+>\s*/, '').trim();
      if (!text) return [];

      // Conversation identity: a channel conversation is a thread
      // (`channel:thread_ts`), but a DM is the whole 1:1 chat — like a
      // Telegram chat — so memory persists across top-level DM messages.
      // A thread inside a DM is still its own conversation.
      const conversationId =
        isDirectMessage(event) && !event.thread_ts
          ? event.channel
          : `${event.channel}:${event.thread_ts ?? event.ts}`;

      return [
        {
          provider: 'slack',
          conversationId,
          externalUserId: event.user,
          text,
          // `channel:ts`, not `event_id`: when a message both mentions the app
          // and lands in a subscribed channel, Slack sends `app_mention` AND
          // `message` as separate deliveries with distinct event_ids for the
          // same underlying message. `ts` collapses them (and still covers
          // plain retry redelivery, which reuses the same ts).
          dedupeKey: `slack:${event.channel}:${event.ts}`,
          raw: envelope,
        },
      ];
    },

    delivery(event: ChannelEvent): ChannelDelivery {
      const raw = (event.raw as SlackEnvelope).event;
      const channel = raw?.channel ?? '';
      // DMs: top-level reply, unless the user wrote inside a DM thread (then
      // stay in it). Channels/groups: thread under the triggering message.
      const threadTs =
        raw && isDirectMessage(raw)
          ? raw.thread_ts
          : replyInThread
            ? (raw?.thread_ts ?? raw?.ts)
            : undefined;

      return {
        // chat.postMessage/chat.update reject `text` over 40k (msg_too_long).
        maxTextLength: 39000,
        async send(text: string): Promise<unknown> {
          const res = await api('chat.postMessage', {
            channel,
            text,
            ...(threadTs ? { thread_ts: threadTs } : {}),
          });
          return { channel: res.channel, ts: res.ts };
        },
        async edit(ref: unknown, text: string): Promise<void> {
          const { channel: ch, ts } = ref as { channel: string; ts: string };
          await api('chat.update', { channel: ch, ts, text });
        },
      };
    },
  };
}
