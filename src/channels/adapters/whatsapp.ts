import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  ChannelAdapter,
  ChannelDelivery,
  ChannelEvent,
  WebhookRequest,
} from '../types';

export interface WhatsAppAdapterOptions {
  /** Graph API access token (system user or customer-scoped business token). */
  accessToken: string;
  /** Business phone number ID used in `POST /{phone-number-id}/messages`. */
  phoneNumberId: string;
  /** App secret — HMAC key for `X-Hub-Signature-256` on inbound webhooks. */
  appSecret: string;
  /** Shared string Meta echoes in the hub challenge (`hub.verify_token`). */
  verifyToken: string;
  /**
   * When set, inbound messages whose `metadata.phone_number_id` does not
   * match are dropped. Useful when one Meta app callback fans out to several
   * bindings. **Unset by default** — a wrong {@link phoneNumberId} should
   * fail loudly on send, not silently drop inbound webhooks.
   */
  expectedPhoneNumberId?: string;
  /** Graph API origin. @default https://graph.facebook.com */
  apiBase?: string;
  /** Graph API version path segment. @default v21.0 */
  apiVersion?: string;
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
        }>;
        statuses?: unknown[];
      };
    }>;
  }>;
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
 * - `parse` accepts `messages` field changes; status callbacks and non-text
 *   messages return `[]` for now.
 * - Delivery is send-only (no progressive edit API) — keep plugin streaming
 *   off for this channel.
 * - Webhook URL is configured in Meta (or via Embedded Signup / override);
 *   there is no Telegram-style `setWebhook`, so no `registerWebhook`.
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
  const { accessToken, phoneNumberId, appSecret, verifyToken } = options;
  if (!accessToken) throw new Error('whatsapp adapter requires an accessToken');
  if (!phoneNumberId) throw new Error('whatsapp adapter requires a phoneNumberId');
  if (!appSecret) throw new Error('whatsapp adapter requires an appSecret');
  if (!verifyToken) throw new Error('whatsapp adapter requires a verifyToken');

  const expectedPhoneNumberId = options.expectedPhoneNumberId;
  const apiBase = options.apiBase ?? 'https://graph.facebook.com';
  const apiVersion = options.apiVersion ?? 'v21.0';
  const messagesUrl = `${apiBase}/${apiVersion}/${phoneNumberId}/messages`;

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
      const url = new URL(req.url);
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      const method = (req.method ?? '').toUpperCase();

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
      if (!signatureValid(req.rawBody, req.headers.get('x-hub-signature-256'), appSecret)) {
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
            // Text-only for v1. Status webhooks have no `messages`.
            if (message.type !== 'text' || !message.from || !message.text?.body) continue;

            events.push({
              provider: 'whatsapp',
              conversationId: message.from,
              externalUserId: message.from,
              userDisplayName: contactName,
              text: message.text.body,
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
