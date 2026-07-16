import { createHash } from 'node:crypto';
import type {
  ChannelAdapter,
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

/** Subset of Telegram's `Update` we care about. */
interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number };
    from?: { id?: number; is_bot?: boolean; first_name?: string; username?: string };
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
 *     workforce: "my-agent",
 *   }],
 * })
 * ```
 */
export function telegram(options: TelegramAdapterOptions): ChannelAdapter {
  const { botToken } = options;
  if (!botToken) throw new Error('telegram adapter requires a botToken');
  const secretToken = options.secretToken || deriveTelegramSecretToken(botToken);
  const apiBase = options.apiBase ?? 'https://api.telegram.org';

  async function api(method: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${apiBase}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
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
      const text = message?.text;
      // Skip non-text updates (stickers, joins, edits, callbacks) and bot
      // echoes — replying to ourselves would loop.
      if (!message || chatId === undefined || !text || message.from?.is_bot) {
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
          dedupeKey:
            update.update_id !== undefined
              ? `telegram:${update.update_id}`
              : undefined,
          raw: update,
        },
      ];
    },

    delivery(event: ChannelEvent): ChannelDelivery {
      const chatId = Number(event.conversationId);
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
