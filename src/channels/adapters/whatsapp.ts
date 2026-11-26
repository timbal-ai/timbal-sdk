import { createHmac, timingSafeEqual } from 'node:crypto';
import { SDK_VERSION } from '../../constants';
import type {
  ChannelAdapter,
  ChannelAttachment,
  ChannelAttachmentData,
  ChannelDelivery,
  ChannelEvent,
  WebhookRequest,
} from '../types';

/** Sent on media downloads: some Meta media hosts refuse requests without one. */
const MEDIA_USER_AGENT = `timbal-sdk/${SDK_VERSION}`;

/** Whether `data` starts like an HTML document (an error page, not media). */
function looksLikeHtml(data: Uint8Array): boolean {
  const head = new TextDecoder()
    .decode(data.subarray(0, 512))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

/**
 * Declared types a user-sent *document* can have while really being HTML
 * (or unknown): an HTML body is accepted for these. Images, audio, PDFs and
 * other binary types never legitimately arrive as HTML.
 */
function htmlPlausible(mime: string | undefined): boolean {
  return (
    !mime ||
    mime.startsWith('text/') ||
    mime === 'application/xhtml+xml' ||
    mime === 'application/xml' ||
    mime === 'application/octet-stream'
  );
}

/** Reads `res` into memory, refusing bodies over `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new Error(`WhatsApp media is larger than the ${maxBytes}-byte limit (maxMediaBytes)`);
  const declaredLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

export interface WhatsAppAdapterOptions {
  /** Graph API access token (system user or customer-scoped business token). */
  accessToken: string;
  /** Business phone number ID used in `POST /{phone-number-id}/messages`. */
  phoneNumberId: string;
  /**
   * App secret — HMAC key for `X-Hub-Signature-256` on inbound webhooks.
   * Required unless {@link platformSecret} is set.
   */
  appSecret?: string;
  /**
   * Shared string Meta echoes in the hub challenge (`hub.verify_token`).
   * Required unless {@link platformSecret} is set.
   */
  verifyToken?: string;
  /**
   * Platform-routed mode, for numbers connected to Timbal through WhatsApp
   * Embedded Signup. The Timbal platform receives Meta's webhooks for the
   * number, verifies Meta's signature, and forwards each delivery to this
   * app signed with a key derived from this secret (the project's
   * `TIMBAL_PROJECT_SECRET`). The adapter then checks that signature instead
   * of Meta's, and needs no {@link appSecret} or {@link verifyToken}.
   * See {@link verifyPlatformForward} for the exact scheme.
   */
  platformSecret?: string;
  /**
   * When set, inbound messages whose `metadata.phone_number_id` does not
   * match are dropped. Useful when one Meta app callback fans out to several
   * bindings. Unset by default when constructing the adapter by hand; the
   * platform and env bindings set it to {@link phoneNumberId}.
   */
  expectedPhoneNumberId?: string;
  /** Graph API origin. @default https://graph.facebook.com */
  apiBase?: string;
  /** Graph API version path segment. @default v21.0 */
  apiVersion?: string;
  /**
   * Time allowed for one media download (lookup + file), in milliseconds.
   * @default 60000
   */
  mediaTimeoutMs?: number;
  /**
   * Largest media file downloaded, in bytes; larger ones fail that
   * attachment. Meta allows documents up to 100 MB, all held in memory and
   * re-uploaded. @default 52428800 (50 MB)
   */
  maxMediaBytes?: number;
  /** Clock in milliseconds, for the forward's timestamp window. @default Date.now */
  now?: () => number;
}

/** Header carrying the unix time (seconds) at which the platform signed a forward. */
export const PLATFORM_TIMESTAMP_HEADER = 'x-timbal-channel-timestamp';
/** Header carrying `sha256=<hex>` over `"<timestamp>.<raw body>"`. */
export const PLATFORM_SIGNATURE_HEADER = 'x-timbal-channel-signature';
/** Forwards older or newer than this are rejected. */
export const PLATFORM_MAX_SKEW_SECONDS = 300;
const PLATFORM_KEY_LABEL = 'whatsapp-forward-v1';

/**
 * Check a platform-forwarded WhatsApp delivery.
 *
 * - key = HMAC-SHA256(key: `platformSecret`, message: `"whatsapp-forward-v1"`)
 * - signature = `sha256=` + hex(HMAC-SHA256(key, `"<timestamp>.<raw body>"`))
 *
 * The timestamp is inside the MAC, so it cannot be replaced; deliveries
 * outside {@link PLATFORM_MAX_SKEW_SECONDS} are rejected, and the pipeline's
 * message-id dedupe drops replays inside the window.
 */
export function verifyPlatformForward(
  platformSecret: string,
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  nowMs: number = Date.now(),
): boolean {
  if (!timestampHeader || !/^\d{1,12}$/.test(timestampHeader.trim())) return false;
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const timestamp = Number(timestampHeader.trim());
  if (Math.abs(nowMs / 1000 - timestamp) > PLATFORM_MAX_SKEW_SECONDS) return false;

  const key = createHmac('sha256', platformSecret).update(PLATFORM_KEY_LABEL).digest();
  const expected = `sha256=${createHmac('sha256', key)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Subset of the WhatsApp Cloud API webhook envelope. */
interface WhatsAppWebhook {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: {
          display_phone_number?: string;
          phone_number_id?: string;
        };
        contacts?: Array<{
          wa_id?: string;
          profile?: { name?: string };
        }>;
        messages?: Array<{
          from?: string;
          id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          image?: WhatsAppMedia;
          document?: WhatsAppMedia;
          audio?: WhatsAppMedia;
        }>;
        statuses?: unknown[];
      };
    }>;
  }>;
}

/** The media object of an image, document or audio message. */
interface WhatsAppMedia {
  /** Media id, exchanged for a short-lived download URL (`GET /{id}`). */
  id?: string;
  mime_type?: string;
  caption?: string;
  /** Documents only. */
  filename?: string;
  /** Audio only: true for a voice note recorded in WhatsApp. */
  voice?: boolean;
}

/** Message types turned into attachments. Video, stickers, locations,
 * contacts and interactive replies are not handled yet and are skipped. */
const MEDIA_TYPES = ['image', 'document', 'audio'] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
};

/** `audio/ogg; codecs=opus` → `audio/ogg`. */
function baseMimeType(mime: string | undefined): string | undefined {
  const base = mime?.split(';')[0]?.trim().toLowerCase();
  return base || undefined;
}

function signatureValid(rawBody: string, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * WhatsApp Cloud API channel adapter.
 *
 * - `verify` answers Meta's hub challenge on GET (`hub.mode=subscribe` +
 *   `hub.verify_token` → plain-text `hub.challenge`) and checks
 *   `X-Hub-Signature-256` on POST.
 * - `parse` accepts `messages` field changes: text, and image / document /
 *   audio messages as attachments (caption as text). Attachments download
 *   through the Graph API with the access token; the pipeline uploads files
 *   and transcribes audio (voice notes). Status callbacks, video, stickers,
 *   locations, contacts and interactive replies return `[]` for now.
 * - Delivery is send-only (no progressive edit API) — keep plugin streaming
 *   off for this channel.
 * - Webhook URL is configured in Meta (or via Embedded Signup / override);
 *   there is no Telegram-style `setWebhook`, so no `registerWebhook`.
 * - With `platformSecret` (numbers connected through Embedded Signup), Meta
 *   talks to the Timbal platform, not to this app: `verify` accepts only
 *   POSTs signed by the platform ({@link verifyPlatformForward}) and refuses
 *   hub challenges.
 *
 * ```ts
 * timbalChannels({
 *   bindings: [{
 *     adapter: whatsapp({
 *       accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
 *       phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
 *       appSecret: process.env.WHATSAPP_APP_SECRET!,
 *       verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
 *     }),
 *     workforce: "my-agent", // webhook: /channels/my-agent/whatsapp
 *   }],
 * })
 * ```
 */
export function whatsapp(options: WhatsAppAdapterOptions): ChannelAdapter {
  const { accessToken, phoneNumberId, appSecret, verifyToken, platformSecret } = options;
  if (!accessToken) throw new Error('whatsapp adapter requires an accessToken');
  if (!phoneNumberId) throw new Error('whatsapp adapter requires a phoneNumberId');
  if (!platformSecret) {
    if (!appSecret) throw new Error('whatsapp adapter requires an appSecret');
    if (!verifyToken) throw new Error('whatsapp adapter requires a verifyToken');
  }
  const now = options.now ?? Date.now;

  const expectedPhoneNumberId = options.expectedPhoneNumberId;
  const apiBase = options.apiBase ?? 'https://graph.facebook.com';
  const apiVersion = options.apiVersion ?? 'v21.0';
  const messagesUrl = `${apiBase}/${apiVersion}/${phoneNumberId}/messages`;
  const mediaTimeoutMs = options.mediaTimeoutMs ?? 60_000;
  const maxMediaBytes = options.maxMediaBytes ?? 50 * 1024 * 1024;

  /**
   * Media id → bytes: `GET /{media-id}` returns a short-lived URL (minutes),
   * which needs the same bearer token. Neither the URL nor the token leave
   * the adapter; callers get bytes only.
   *
   * A media host can answer an error *page* with a 200; unless the user
   * sent a document that may really be HTML (`isDocument` and a text-like
   * or unknown type), an HTML response is refused here so it never reaches
   * the agent as an "image" or a "voice note".
   *
   * Both requests share one {@link mediaTimeoutMs} deadline, and the body is
   * capped at {@link maxMediaBytes}.
   */
  async function downloadMedia(
    mediaId: string,
    declared: string | undefined,
    isDocument: boolean,
  ): Promise<{ data: Uint8Array; contentType: string | null }> {
    const headers = { Authorization: `Bearer ${accessToken}`, 'User-Agent': MEDIA_USER_AGENT };
    const signal = AbortSignal.timeout(mediaTimeoutMs);
    try {
      const lookup = await fetch(`${apiBase}/${apiVersion}/${encodeURIComponent(mediaId)}`, {
        headers,
        signal,
      });
      const meta = (await lookup.json().catch(() => null)) as
        | { url?: string; mime_type?: string }
        | null;
      if (!lookup.ok || !meta?.url) {
        throw new Error(`WhatsApp media lookup failed (${lookup.status})`);
      }
      const res = await fetch(meta.url, { headers, signal });
      if (!res.ok) {
        throw new Error(`WhatsApp media download failed (${res.status})`);
      }
      const served = baseMimeType(res.headers.get('content-type') ?? undefined);
      const data = await readCapped(res, maxMediaBytes);
      const expected = declared ?? baseMimeType(meta.mime_type);
      const htmlAllowed = isDocument && htmlPlausible(expected);
      if (!htmlAllowed && (served === 'text/html' || looksLikeHtml(data))) {
        throw new Error('WhatsApp media download returned a web page instead of the file');
      }
      return {
        data,
        contentType: baseMimeType(meta.mime_type) ?? served ?? null,
      };
    } catch (err) {
      if (signal.aborted) {
        throw new Error(`WhatsApp media download timed out after ${mediaTimeoutMs}ms`);
      }
      throw err;
    }
  }

  function mediaAttachment(
    type: MediaType,
    media: WhatsAppMedia & { id: string },
  ): ChannelAttachment {
    const mediaId = media.id;
    const declared = baseMimeType(media.mime_type);
    const ext = declared ? EXTENSIONS[declared] : undefined;
    const fileName =
      (type === 'document' && media.filename) ||
      `${type === 'audio' && media.voice ? 'voice' : type}_${mediaId}${ext ? `.${ext}` : ''}`;
    // A photo or a recording sent "as a document" is still an image / audio
    // to the pipeline (audio is transcribed); it keeps the user's file name.
    const kind: ChannelAttachment['kind'] =
      type === 'document' && declared?.startsWith('image/')
        ? 'image'
        : type === 'document' && declared?.startsWith('audio/')
          ? 'audio'
          : type;
    return {
      kind,
      fileName,
      contentType: declared,
      async download(): Promise<ChannelAttachmentData> {
        const { data, contentType } = await downloadMedia(
          mediaId,
          declared,
          type === 'document',
        );
        return {
          data,
          contentType: declared ?? contentType ?? 'application/octet-stream',
          fileName,
        };
      },
    };
  }

  async function sendText(to: string, body: string): Promise<unknown> {
    const res = await fetch(messagesUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body },
      }),
    });
    const payload = (await res.json().catch(() => null)) as
      | { messages?: Array<{ id?: string }>; error?: { message?: string } }
      | null;
    if (!res.ok) {
      throw new Error(
        `WhatsApp send failed (${res.status}): ${payload?.error?.message ?? 'unknown error'}`,
      );
    }
    return payload?.messages?.[0]?.id ?? null;
  }

  return {
    provider: 'whatsapp',

    verify(req: WebhookRequest): Response | 'ok' {
      const method = (req.method ?? '').toUpperCase();

      // Platform-routed: Meta never calls this app, the platform does.
      if (platformSecret) {
        if (method === 'GET') return new Response('Method Not Allowed', { status: 405 });
        const valid = verifyPlatformForward(
          platformSecret,
          req.rawBody,
          req.headers.get(PLATFORM_TIMESTAMP_HEADER),
          req.headers.get(PLATFORM_SIGNATURE_HEADER),
          now(),
        );
        return valid ? 'ok' : new Response('Invalid signature', { status: 401 });
      }

      const url = new URL(req.url);
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');

      // Hub challenge is GET-only. Meta sometimes leaves `hub.*` on the saved
      // callback URL — a POST with those query params must still verify the
      // signature and deliver messages, not echo the challenge / 403.
      if (method === 'GET' && mode === 'subscribe') {
        if (token === verifyToken && challenge) {
          return new Response(challenge, {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          });
        }
        return new Response('Forbidden', { status: 403 });
      }

      // Inbound webhook (POST) — require a valid signature.
      if (
        !appSecret ||
        !signatureValid(req.rawBody, req.headers.get('x-hub-signature-256'), appSecret)
      ) {
        return new Response('Invalid signature', { status: 401 });
      }
      return 'ok';
    },

    parse(req: WebhookRequest): ChannelEvent[] {
      let envelope: WhatsAppWebhook;
      try {
        envelope = JSON.parse(req.rawBody) as WhatsAppWebhook;
      } catch {
        return [];
      }
      if (envelope.object !== 'whatsapp_business_account') return [];

      const events: ChannelEvent[] = [];
      for (const entry of envelope.entry ?? []) {
        for (const change of entry.changes ?? []) {
          if (change.field !== 'messages') continue;
          const value = change.value;
          if (!value?.messages?.length) continue;

          const phoneId = value.metadata?.phone_number_id;
          if (
            expectedPhoneNumberId &&
            phoneId &&
            phoneId !== expectedPhoneNumberId
          ) {
            continue;
          }

          const contactName = value.contacts?.[0]?.profile?.name;

          for (const message of value.messages) {
            // Status webhooks have no `messages`.
            if (!message.from) continue;

            // Text, or an image / document / audio with its caption. The
            // pipeline downloads attachments (and transcribes audio).
            let text = '';
            const attachments: ChannelAttachment[] = [];
            if (message.type === 'text') {
              text = message.text?.body ?? '';
            } else if ((MEDIA_TYPES as readonly string[]).includes(message.type ?? '')) {
              const type = message.type as MediaType;
              const media = message[type];
              if (media?.id) {
                text = media.caption ?? '';
                attachments.push(mediaAttachment(type, { ...media, id: media.id }));
              }
            }
            if (!text && attachments.length === 0) continue;

            events.push({
              provider: 'whatsapp',
              conversationId: message.from,
              externalUserId: message.from,
              userDisplayName: contactName,
              text,
              ...(attachments.length > 0 ? { attachments } : {}),
              dedupeKey: message.id ? `whatsapp:${message.id}` : undefined,
              raw: { entry, change, message },
            });
          }
        }
      }
      return events;
    },

    delivery(event: ChannelEvent): ChannelDelivery {
      const to = event.conversationId;
      return {
        // Cloud API text body limit is 4096 characters.
        maxTextLength: 4000,
        async send(text: string): Promise<unknown> {
          return sendText(to, text);
        },
      };
    },
  };
}
