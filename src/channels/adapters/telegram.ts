import { createHash } from 'node:crypto';
import type {
  ChannelAdapter,
  ChannelAttachment,
  ChannelAttachmentData,
  ChannelDelivery,
  ChannelEvent,
  WebhookRequest,
} from '../types';

export interface TelegramAdapterOptions {
  /** Bot token from @BotFather (`123456:ABC-...`). */
  botToken: string;
  /**
   * Shared secret echoed back by Telegram in the
   * `X-Telegram-Bot-Api-Secret-Token` header of every webhook POST. This is
   * Telegram's only webhook authentication (no payload signatures), so the
   * adapter always enforces one. Defaults to a hash derived from the bot
   * token — stable across restarts and exactly as secret as the token
   * itself. Set explicitly only to rotate it independently of the token.
   * Passed to `setWebhook` by {@link ChannelAdapter.registerWebhook}.
   */
  secretToken?: string;
  /** API origin override (tests / local Bot API server). @default https://api.telegram.org */
  apiBase?: string;
}

/** Default webhook secret: derived from the bot token, never sent anywhere but Telegram. */
export function deriveTelegramSecretToken(botToken: string): string {
  return createHash('sha256')
    .update(`timbal-telegram-webhook:${botToken}`)
    .digest('hex')
    .slice(0, 32);
}

const IMAGE_EXTENSION = /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i;

/** Whether a reply file should go out as a Telegram photo rather than a document. */
function looksLikeImage(file: string, fileName?: string): boolean {
  if (file.startsWith('data:')) return file.startsWith('data:image/');
  if (fileName && IMAGE_EXTENSION.test(fileName)) return true;
  return IMAGE_EXTENSION.test(file.split(/[?#]/, 1)[0] ?? '');
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

/** Decode a `data:` URL into bytes + MIME (base64 or percent-encoded). */
function decodeDataUrl(dataUrl: string): { data: Uint8Array; contentType: string } {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('Malformed data URL');
  const contentType = match[1] || 'application/octet-stream';
  const payload = match[3] ?? '';
  const data = match[2]
    ? new Uint8Array(Buffer.from(payload, 'base64'))
    : new TextEncoder().encode(decodeURIComponent(payload));
  return { data, contentType };
}

/** Subset of Telegram's `PhotoSize`. */
interface TelegramPhotoSize {
  file_id?: string;
  file_unique_id?: string;
  file_size?: number;
}

/** Subset of Telegram's `Document`. */
interface TelegramDocument {
  file_id?: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Subset of Telegram's `Update` we care about. */
interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    /** Media messages carry their text here instead of `text`. */
    caption?: string;
    chat?: { id?: number };
    from?: { id?: number; is_bot?: boolean; first_name?: string; username?: string };
    /** Compressed photo — one entry per resolution, ascending. */
    photo?: TelegramPhotoSize[];
    /** Generic file — also how Telegram sends "uncompressed" images. */
    document?: TelegramDocument;
  };
}

/**
 * Telegram channel adapter.
 *
 * The friendliest channel to automate: webhook registration is one API call
 * (`setWebhook`), authentication is the `secret_token` header echo, and
 * progressive replies map onto `sendMessage` + `editMessageText`.
 *
 * ```ts
 * timbalChannels({
 *   bindings: [{
 *     adapter: telegram({ botToken: process.env.TELEGRAM_BOT_TOKEN! }),
 *     workforce: "my-agent", // webhook: /channels/my-agent/telegram
 *   }],
 * })
 * ```
 */
export function telegram(options: TelegramAdapterOptions): ChannelAdapter {
  const { botToken } = options;
  if (!botToken) throw new Error('telegram adapter requires a botToken');
  const secretToken = options.secretToken || deriveTelegramSecretToken(botToken);
  const apiBase = options.apiBase ?? 'https://api.telegram.org';

  async function parseApiResponse(res: Response, method: string): Promise<unknown> {
    const payload = (await res.json().catch(() => null)) as
      | { ok?: boolean; result?: unknown; description?: string }
      | null;
    if (!res.ok || !payload?.ok) {
      throw new Error(
        `Telegram ${method} failed (${res.status}): ${payload?.description ?? 'unknown error'}`,
      );
    }
    return payload.result;
  }

  async function api(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${apiBase}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return parseApiResponse(res, method);
  }

  /** Multipart variant of {@link api} — used to upload file bytes. */
  async function apiForm(method: string, form: FormData): Promise<unknown> {
    const res = await fetch(`${apiBase}/bot${botToken}/${method}`, {
      method: 'POST',
      body: form,
    });
    return parseApiResponse(res, method);
  }

  /**
   * Exchange a `file_id` for bytes: `getFile` → download from the
   * token-bearing file URL. That URL embeds the bot token and expires
   * (~1h), so it never leaves the adapter — callers get bytes only.
   * Bot API caps `getFile` downloads at 20MB; larger files fail here.
   */
  async function downloadFile(fileId: string): Promise<{ data: Uint8Array; contentType: string | null }> {
    const info = (await api('getFile', { file_id: fileId })) as { file_path?: string };
    if (!info?.file_path) {
      throw new Error('Telegram getFile returned no file_path');
    }
    const res = await fetch(`${apiBase}/file/bot${botToken}/${info.file_path}`);
    if (!res.ok) {
      throw new Error(`Telegram file download failed (${res.status})`);
    }
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type'),
    };
  }

  function parseAttachments(message: NonNullable<TelegramUpdate['message']>): ChannelAttachment[] {
    const attachments: ChannelAttachment[] = [];

    // `photo` lists resolutions in ascending size — last is the original's
    // largest rendition. Compressed photos are always JPEG and carry no name.
    const photo = message.photo?.[message.photo.length - 1];
    if (photo?.file_id) {
      const fileId = photo.file_id;
      const fileName = `photo_${photo.file_unique_id ?? fileId}.jpg`;
      attachments.push({
        kind: 'image',
        fileName,
        contentType: 'image/jpeg',
        sizeBytes: photo.file_size,
        async download(): Promise<ChannelAttachmentData> {
          const { data, contentType } = await downloadFile(fileId);
          return { data, contentType: contentType ?? 'image/jpeg', fileName };
        },
      });
    }

    const doc = message.document;
    if (doc?.file_id) {
      const fileId = doc.file_id;
      const fileName = doc.file_name ?? `document_${doc.file_unique_id ?? fileId}`;
      const declaredType = doc.mime_type;
      attachments.push({
        kind: declaredType?.startsWith('image/') ? 'image' : 'document',
        fileName,
        contentType: declaredType,
        sizeBytes: doc.file_size,
        async download(): Promise<ChannelAttachmentData> {
          const { data, contentType } = await downloadFile(fileId);
          return {
            data,
            contentType: declaredType ?? contentType ?? 'application/octet-stream',
            fileName,
          };
        },
      });
    }

    return attachments;
  }

  return {
    provider: 'telegram',

    verify(req: WebhookRequest): Response | 'ok' {
      const header = req.headers.get('x-telegram-bot-api-secret-token');
      if (header !== secretToken) {
        return new Response('Unauthorized', { status: 401 });
      }
      return 'ok';
    },

    parse(req: WebhookRequest): ChannelEvent[] {
      let update: TelegramUpdate;
      try {
        update = JSON.parse(req.rawBody) as TelegramUpdate;
      } catch {
        return [];
      }

      const message = update.message;
      const chatId = message?.chat?.id;
      if (!message || chatId === undefined || message.from?.is_bot) {
        return [];
      }

      // Media messages carry their text as `caption`. A bare photo/document
      // has neither — still a valid event, with empty text.
      const text = message.text ?? message.caption ?? '';
      const attachments = parseAttachments(message);
      // Skip updates with nothing to act on (stickers, joins, voice — for
      // now —, edits, callbacks). Bot echoes are skipped above: replying to
      // ourselves would loop.
      if (!text && attachments.length === 0) {
        return [];
      }

      return [
        {
          provider: 'telegram',
          conversationId: String(chatId),
          externalUserId:
            message.from?.id !== undefined ? String(message.from.id) : undefined,
          userDisplayName: message.from?.username ?? message.from?.first_name,
          text,
          attachments: attachments.length > 0 ? attachments : undefined,
          dedupeKey:
            update.update_id !== undefined
              ? `telegram:${update.update_id}`
              : undefined,
          raw: update,
        },
      ];
    },

    delivery(event: ChannelEvent): ChannelDelivery {
      // Keep chat_id as a string — Telegram accepts string or number, and
      // Number() silently corrupts IDs past Number.MAX_SAFE_INTEGER (some
      // supergroup/channel ids).
      const chatId = event.conversationId;
      return {
        // Telegram rejects messages over 4096 chars (MESSAGE_TOO_LONG).
        // Slightly under the wire limit for safety margin.
        maxTextLength: 4000,
        async send(text: string): Promise<unknown> {
          const result = (await api('sendMessage', {
            chat_id: chatId,
            text,
          })) as { message_id?: number };
          return result?.message_id ?? null;
        },
        async edit(ref: unknown, text: string): Promise<void> {
          if (ref === null || ref === undefined) return;
          try {
            await api('editMessageText', {
              chat_id: chatId,
              message_id: ref,
              text,
            });
          } catch (err) {
            // Telegram 400s when the new text equals the current text
            // ("message is not modified") — benign for a coalescing streamer.
            if (err instanceof Error && err.message.includes('message is not modified')) {
              return;
            }
            throw err;
          }
        },
        async delete(ref: unknown): Promise<void> {
          if (ref === null || ref === undefined) return;
          await api('deleteMessage', { chat_id: chatId, message_id: ref });
        },
        async sendFile(file: string, opts?: { fileName?: string }): Promise<unknown> {
          const asPhoto = looksLikeImage(file, opts?.fileName);
          const post = async (method: 'sendPhoto' | 'sendDocument'): Promise<unknown> => {
            const field = method === 'sendPhoto' ? 'photo' : 'document';
            if (file.startsWith('data:')) {
              // Unpersisted agent output — upload the bytes as multipart.
              const { data, contentType } = decodeDataUrl(file);
              const fileName =
                opts?.fileName ?? `file.${MIME_EXTENSIONS[contentType] ?? 'bin'}`;
              const form = new FormData();
              form.append('chat_id', chatId);
              form.append(field, new Blob([data], { type: contentType }), fileName);
              return apiForm(method, form);
            }
            // https URL: Telegram fetches it server-side (caps: 5MB photos,
            // 20MB documents by URL).
            return api(method, { chat_id: chatId, [field]: file });
          };
          try {
            const result = (await post(asPhoto ? 'sendPhoto' : 'sendDocument')) as {
              message_id?: number;
            };
            return result?.message_id ?? null;
          } catch (err) {
            if (!asPhoto) throw err;
            // sendPhoto is picky (5MB URL cap, dimension/format limits) —
            // anything it rejects still reaches the user as a document.
            const result = (await post('sendDocument')) as { message_id?: number };
            return result?.message_id ?? null;
          }
        },
      };
    },

    /**
     * Point the bot's webhook at `webhookUrl` with the secret token attached.
     * Idempotent — Telegram replaces any previous webhook for this bot.
     */
    async registerWebhook(webhookUrl: string): Promise<void> {
      await api('setWebhook', {
        url: webhookUrl,
        secret_token: secretToken,
        allowed_updates: ['message'],
      });
    },
  };
}
