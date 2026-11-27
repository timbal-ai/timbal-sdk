import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ChannelAdapter,
  ChannelAttachment,
  ChannelAttachmentData,
  ChannelDelivery,
  ChannelEvent,
  WebhookRequest,
} from '../types';
import {
  attachmentKind,
  baseMimeType,
  fetchFollowingRedirects,
  isHtmlType,
  looksLikeHtml,
  readCapped,
  withDeadline,
} from '../download';

export interface SlackAdapterOptions {
  /** App signing secret (Basic Information → App Credentials). */
  signingSecret: string;
  /**
   * Bot token (`xoxb-...`) with `chat:write` scope. Files users send reach
   * the agent only with the `files:read` scope too.
   */
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
  /**
   * Hosts the bot token is sent to when downloading a file a user sent.
   * A file URL on another host is refused, and a redirect to one is
   * followed without the token. @default ['files.slack.com']
   */
  fileHosts?: string[];
  /**
   * Time allowed for one file download (lookup included), in milliseconds.
   * @default 60000
   */
  fileTimeoutMs?: number;
  /**
   * Largest file downloaded, in bytes; larger ones fail that attachment.
   * Files are held in memory and re-uploaded. @default 52428800 (50 MB)
   */
  maxFileBytes?: number;
  /** Max accepted signature timestamp skew, in seconds. @default 300 */
  maxSkewSeconds?: number;
  /** Injectable clock (tests). @default Date.now */
  now?: () => number;
}

/** Subset of Slack's file object. */
interface SlackFile {
  id?: string;
  /** May be `null` for unnamed files. */
  name?: string | null;
  title?: string | null;
  mimetype?: string;
  size?: number;
  /**
   * `hosted`, `external`, `snippet` or `post`; a Slack Connect stub says
   * `file_access`.
   */
  mode?: string;
  /** Hosted outside Slack: `url_private` is that host's URL, never sent the token. */
  is_external?: boolean;
  /**
   * `check_file_info` on a Slack Connect file: the event carries only a
   * stub, and `files.info` returns the full object.
   */
  file_access?: string;
  /** Set when the workspace's plan limit hides the file. */
  is_hidden_by_limit?: number | boolean;
  url_private?: string;
  url_private_download?: string;
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
    /** Files shared with the message (`subtype: 'file_share'`, or an `app_mention`). */
    files?: SlackFile[];
  };
}

/** Modes whose `url_private` serves the file's bytes. */
const DOWNLOADABLE_MODES = new Set(['hosted', 'snippet']);

/**
 * The URL to download a full file object from with the bot token, or
 * `undefined` when there is none: files hosted outside Slack, Slack posts,
 * and files hidden by the plan limit.
 */
function privateUrl(file: SlackFile): string | undefined {
  if (file.mode !== undefined && !DOWNLOADABLE_MODES.has(file.mode)) return undefined;
  if (file.is_external || file.is_hidden_by_limit) return undefined;
  return file.url_private_download || file.url_private || undefined;
}

function fileNameOf(file: SlackFile, id: string): string {
  return file.name || file.title || `file_${id}`;
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
 *   messages and message subtypes (edits, joins) to avoid loops and noise,
 *   except `file_share`. `app_mention` duplicates of a `message` collapse
 *   via the shared `event_id`-less client dedupe key (`channel:ts`).
 * - Files in the message (`files`) become attachments, downloaded from
 *   `url_private` with the bot token (`files:read` scope). The token goes
 *   only to {@link SlackAdapterOptions.fileHosts}; files hosted outside
 *   Slack are skipped. Slack Connect stubs (`file_access:
 *   'check_file_info'`) are looked up with `files.info` on download.
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
  const fileHosts = new Set((options.fileHosts ?? ['files.slack.com']).map((h) => h.toLowerCase()));
  const fileTimeoutMs = options.fileTimeoutMs ?? 60_000;
  const maxFileBytes = options.maxFileBytes ?? 50 * 1024 * 1024;
  const tooLarge = () =>
    new Error(`Slack file is larger than the ${maxFileBytes}-byte limit (maxFileBytes)`);

  /** Whether the bot token may be sent to `url`. */
  function isFileHost(url: URL): boolean {
    return url.protocol === 'https:' && fileHosts.has(url.hostname.toLowerCase());
  }

  /**
   * GET a file URL with the bot token. The token goes only to a file host,
   * so a redirect elsewhere (e.g. a sign-in page) never receives it.
   */
  async function fetchPrivate(url: string, signal: AbortSignal): Promise<Response> {
    const parsed = new URL(url);
    if (!isFileHost(parsed)) {
      throw new Error(
        `Slack file URL is not on a Slack file host (${parsed.host}); not sending the bot token`,
      );
    }
    return fetchFollowingRedirects(parsed, {
      signal,
      headersFor: (hop): Record<string, string> =>
        isFileHost(hop) ? { Authorization: `Bearer ${botToken}` } : {},
      label: 'Slack file download',
    });
  }

  /** `files.info` → the full file object of a Slack Connect stub. */
  async function fileInfo(fileId: string, signal: AbortSignal): Promise<SlackFile> {
    const res = await fetch(`${apiBase}/files.info?file=${encodeURIComponent(fileId)}`, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal,
    });
    const payload = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; file?: SlackFile }
      | null;
    if (!res.ok || !payload?.ok || !payload.file) {
      throw new Error(
        `Slack files.info failed (${res.status}): ${payload?.error ?? 'unknown error'}`
      );
    }
    return payload.file;
  }

  /**
   * A full file object → its bytes. Slack declares the file's type, so an
   * HTML body for anything but an HTML file is a sign-in page: what
   * `url_private` serves when the token lacks `files:read`.
   */
  async function readFile(
    file: SlackFile,
    id: string,
    signal: AbortSignal,
  ): Promise<ChannelAttachmentData> {
    const url = privateUrl(file);
    if (!url) {
      throw new Error(`Slack file ${id} is hosted outside Slack or hidden; not downloadable`);
    }
    if ((file.size ?? 0) > maxFileBytes) throw tooLarge();
    const res = await fetchPrivate(url, signal);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`Slack file download failed (${res.status})`);
    }
    const declared = baseMimeType(file.mimetype);
    const served = baseMimeType(res.headers.get('content-type'));
    const data = await readCapped(res, maxFileBytes, tooLarge);
    if (!isHtmlType(declared) && (served === 'text/html' || looksLikeHtml(data))) {
      throw new Error(
        'Slack file download returned a web page instead of the file (does the bot token have the files:read scope?)',
      );
    }
    return {
      data,
      contentType: declared ?? served ?? 'application/octet-stream',
      fileName: fileNameOf(file, id),
    };
  }

  function download(run: (signal: AbortSignal) => Promise<ChannelAttachmentData>) {
    return withDeadline(
      fileTimeoutMs,
      () => new Error(`Slack file download timed out after ${fileTimeoutMs}ms`),
      run,
    );
  }

  function parseFiles(files: SlackFile[] | undefined): ChannelAttachment[] {
    const attachments: ChannelAttachment[] = [];
    for (const file of files ?? []) {
      const id = file.id;
      if (!id) continue;

      // Slack Connect: the event carries a stub (no name, type or URL), so
      // the metadata is unknown until files.info answers on download.
      if (file.file_access === 'check_file_info') {
        attachments.push({
          kind: 'document',
          download: () =>
            download(async (signal) => readFile(await fileInfo(id, signal), id, signal)),
        });
        continue;
      }

      if (!privateUrl(file)) continue;
      const contentType = baseMimeType(file.mimetype);
      attachments.push({
        kind: attachmentKind(contentType),
        fileName: fileNameOf(file, id),
        contentType,
        sizeBytes: file.size,
        download: () => download((signal) => readFile(file, id, signal)),
      });
    }
    return attachments;
  }

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
      // subtypes: edits, deletes, channel joins, etc. `file_share` is a user
      // message with files.
      const subtypeOk = !event?.subtype || event.subtype === 'file_share';
      if (!isMessage || !event?.channel || !event.ts || event.bot_id || !subtypeOk) {
        return [];
      }

      // Strip a leading bot @-mention so the agent sees clean text. A bare
      // file has no text — still a valid event.
      const text = (event.text ?? '').replace(/^\s*<@[A-Z0-9]+>\s*/, '').trim();
      const attachments = parseFiles(event.files);
      if (!text && attachments.length === 0) return [];

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
          ...(attachments.length > 0 ? { attachments } : {}),
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
