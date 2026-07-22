import type {
  ChannelAdapter,
  ChannelDelivery,
  ChannelEvent,
  WebhookRequest,
} from '../types';

export interface TeamsAdapterOptions {
  /** Entra Application (client) ID — JWT `aud` + connector token client_id. */
  appId: string;
  /** Client secret from the app registration. */
  appPassword: string;
  /**
   * Entra tenant ID for the connector token endpoint. Required for
   * single-tenant app registrations; omit for multi-tenant (the token is
   * requested against the `botframework.com` tenant).
   */
  tenantId?: string;
  /** Bot Connector OpenID metadata URL (tests). @default Bot Framework prod */
  openIdMetadataUrl?: string;
  /** Entra login origin for connector tokens (tests). @default https://login.microsoftonline.com */
  loginBase?: string;
  /** Max accepted JWT clock skew, in seconds. @default 300 */
  maxSkewSeconds?: number;
  /** Injectable clock (tests). @default Date.now */
  now?: () => number;
}

const DEFAULT_OPENID_METADATA_URL =
  'https://login.botframework.com/v1/.well-known/openidconfiguration';
const BOT_CONNECTOR_ISSUER = 'https://api.botframework.com';

/**
 * Module-level caches, keyed so they survive dynamic-mode binding
 * re-materialization (adapters are recreated per webhook in dynamic mode; a
 * per-instance cache would refetch JWKS + a connector token on every
 * message).
 */
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;
/** Floor between JWKS refetches on unknown `kid` — a forged kid must not become a fetch amplifier. */
const JWKS_MIN_REFETCH_MS = 60 * 1000;

interface JwksCacheEntry {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}
const jwksCache = new Map<string, JwksCacheEntry>();

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, TokenCacheEntry>();

/** Reset the shared JWKS + connector-token caches (tests). */
export function clearTeamsAdapterCaches(): void {
  jwksCache.clear();
  tokenCache.clear();
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(segment))) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

/** Minimal JWK shape — the global `JsonWebKey` type isn't in our tsconfig libs. */
interface Jwk {
  kty?: string;
  kid?: string;
  [key: string]: unknown;
}

/** Subset of a Bot Framework Activity we care about. */
interface TeamsActivity {
  type?: string;
  id?: string;
  text?: string;
  serviceUrl?: string;
  channelId?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string };
  conversation?: { id?: string; conversationType?: string };
}

/**
 * Microsoft Teams channel adapter (hand-rolled Activity Protocol edge — no
 * botbuilder / Teams SDK dependency; see docs/teams-plan.md).
 *
 * - `verify` validates the Bot Connector JWT: RS256 signature against the
 *   Bot Framework JWKS (cached module-wide), `iss`, `aud` = app id,
 *   `exp`/`nbf` within skew, and the token's `serviceurl` claim against the
 *   activity's `serviceUrl` (blocks replaying a signed activity at a forged
 *   reply target).
 * - `parse` accepts `type: "message"` activities; `conversationUpdate`,
 *   reactions, typing, etc. return `[]`. Teams bakes the thread into
 *   `conversation.id` for channel messages, so thread-scoped memory needs no
 *   extra composition (unlike Slack).
 * - Replies go to the **inbound** activity's `serviceUrl` via the Bot
 *   Connector REST API, authenticated with a client-credentials token
 *   (cached until expiry). `edit` maps to activity PUT, so streaming can be
 *   enabled later.
 *
 * Webhook registration is manual (Azure Bot → Configuration → Messaging
 * endpoint), like Slack's manifest — no `registerWebhook`.
 */
export function teams(options: TeamsAdapterOptions): ChannelAdapter {
  const { appId, appPassword, tenantId } = options;
  if (!appId) throw new Error('teams adapter requires an appId');
  if (!appPassword) throw new Error('teams adapter requires an appPassword');

  const metadataUrl = options.openIdMetadataUrl ?? DEFAULT_OPENID_METADATA_URL;
  const loginBase = options.loginBase ?? 'https://login.microsoftonline.com';
  const maxSkewSeconds = options.maxSkewSeconds ?? 300;
  const now = options.now ?? Date.now;
  // Multi-tenant bots request connector tokens against the shared
  // botframework.com tenant; single-tenant must use their own.
  const tokenTenant = tenantId || 'botframework.com';

  async function getSigningKey(kid: string): Promise<CryptoKey | null> {
    const nowMs = now();
    let entry = jwksCache.get(metadataUrl);
    const expired = !entry || nowMs - entry.fetchedAt > JWKS_TTL_MS;
    const kidMissing =
      !!entry && !entry.keys.has(kid) && nowMs - entry.fetchedAt > JWKS_MIN_REFETCH_MS;

    if (expired || kidMissing) {
      const metaRes = await fetch(metadataUrl);
      const meta = (await metaRes.json().catch(() => null)) as { jwks_uri?: string } | null;
      if (!metaRes.ok || !meta?.jwks_uri) return null;

      const jwksRes = await fetch(meta.jwks_uri);
      const jwks = (await jwksRes.json().catch(() => null)) as {
        keys?: Jwk[];
      } | null;
      if (!jwksRes.ok || !jwks?.keys) return null;

      const keys = new Map<string, CryptoKey>();
      for (const jwk of jwks.keys) {
        if (!jwk.kid || jwk.kty !== 'RSA') continue;
        try {
          keys.set(
            jwk.kid,
            await crypto.subtle.importKey(
              'jwk',
              jwk,
              { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
              false,
              ['verify'],
            ),
          );
        } catch {
          /* skip unusable keys — others may still verify */
        }
      }
      entry = { keys, fetchedAt: nowMs };
      jwksCache.set(metadataUrl, entry);
    }
    return entry!.keys.get(kid) ?? null;
  }

  async function getConnectorToken(): Promise<string> {
    const cacheKey = `${loginBase}|${tokenTenant}|${appId}|${appPassword}`;
    const cached = tokenCache.get(cacheKey);
    // 60s early-expiry margin so a token never dies mid-send.
    if (cached && cached.expiresAt > now() + 60_000) return cached.token;

    const res = await fetch(`${loginBase}/${tokenTenant}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: appPassword,
        scope: 'https://api.botframework.com/.default',
      }),
    });
    const payload = (await res.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
    } | null;
    if (!res.ok || !payload?.access_token) {
      throw new Error(
        `Teams connector token failed (${res.status}): ${payload?.error_description ?? 'unknown error'}`,
      );
    }
    tokenCache.set(cacheKey, {
      token: payload.access_token,
      expiresAt: now() + (payload.expires_in ?? 3600) * 1000,
    });
    return payload.access_token;
  }

  async function connectorCall(
    url: string,
    method: 'POST' | 'PUT',
    body: Record<string, unknown>,
  ): Promise<{ id?: string } | null> {
    const token = await getConnectorToken();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => null)) as {
      id?: string;
      error?: { message?: string };
    } | null;
    if (!res.ok) {
      throw new Error(
        `Teams connector ${method} failed (${res.status}): ${payload?.error?.message ?? 'unknown error'}`,
      );
    }
    return payload;
  }

  const unauthorized = (): Response => new Response('Unauthorized', { status: 401 });

  return {
    provider: 'teams',

    async verify(req: WebhookRequest): Promise<Response | 'ok'> {
      const auth = req.headers.get('authorization') ?? '';
      if (!auth.startsWith('Bearer ')) return unauthorized();
      const parts = auth.slice(7).trim().split('.');
      if (parts.length !== 3) return unauthorized();

      const header = decodeJsonSegment(parts[0]!);
      const payload = decodeJsonSegment(parts[1]!);
      if (!header || !payload) return unauthorized();
      if (header.alg !== 'RS256' || typeof header.kid !== 'string') return unauthorized();

      let key: CryptoKey | null;
      try {
        key = await getSigningKey(header.kid);
      } catch {
        return unauthorized();
      }
      if (!key) return unauthorized();

      const valid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        b64urlToBytes(parts[2]!),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      );
      if (!valid) return unauthorized();

      if (payload.iss !== BOT_CONNECTOR_ISSUER) return unauthorized();
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes(appId)) return unauthorized();

      const nowSec = now() / 1000;
      if (typeof payload.exp !== 'number' || nowSec > payload.exp + maxSkewSeconds) {
        return unauthorized();
      }
      if (typeof payload.nbf === 'number' && nowSec < payload.nbf - maxSkewSeconds) {
        return unauthorized();
      }

      // The token pins the serviceUrl replies must go to; the activity body
      // carries the one delivery will use. A mismatch means a signed
      // activity replayed against a forged reply target.
      if (typeof payload.serviceurl === 'string') {
        let activity: TeamsActivity | null = null;
        try {
          activity = JSON.parse(req.rawBody) as TeamsActivity;
        } catch {
          /* non-JSON body — parse() will drop it */
        }
        if (
          typeof activity?.serviceUrl === 'string' &&
          trimTrailingSlash(activity.serviceUrl) !== trimTrailingSlash(payload.serviceurl)
        ) {
          return unauthorized();
        }
      }

      return 'ok';
    },

    parse(req: WebhookRequest): ChannelEvent[] {
      let activity: TeamsActivity;
      try {
        activity = JSON.parse(req.rawBody) as TeamsActivity;
      } catch {
        return [];
      }
      // conversationUpdate / messageReaction / typing / invoke → nothing to
      // run; the pipeline's empty-200 ack is the right answer.
      if (activity.type !== 'message') return [];

      const conversationId = activity.conversation?.id;
      const fromId = activity.from?.id;
      if (!conversationId || !fromId) return [];
      // Our own echoes: replying to ourselves would loop.
      if (activity.recipient?.id && fromId === activity.recipient.id) return [];

      // Strip the leading bot @-mention (`<at>Bot</at> text`), then unwrap
      // any remaining mention tags to their display name — same cleanup the
      // Slack adapter does for `<@U…>`.
      const text = (activity.text ?? '')
        .replace(/^\s*<at>[^<]*<\/at>\s*/i, '')
        .replace(/<at>([^<]*)<\/at>/gi, '$1')
        .trim();
      if (!text) return [];

      return [
        {
          provider: 'teams',
          conversationId,
          // aadObjectId is the stable org identity; the `29:` id is
          // bot-scoped. Prefer the former for future cross-channel linking.
          externalUserId: activity.from?.aadObjectId ?? fromId,
          userDisplayName: activity.from?.name,
          text,
          // Activity ids are only unique per conversation — scope the key.
          dedupeKey: activity.id
            ? `teams:${conversationId}:${activity.id}`
            : undefined,
          raw: activity,
        },
      ];
    },

    delivery(event: ChannelEvent): ChannelDelivery {
      const activity = event.raw as TeamsActivity;
      const serviceUrl = activity.serviceUrl ?? '';
      const base = serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`;
      const conversationUrl = `${base}v3/conversations/${encodeURIComponent(
        event.conversationId,
      )}/activities`;

      return {
        // Practical cap — the hard limit is payload size (~28KB), but long
        // single messages render badly; split like the other adapters.
        maxTextLength: 4000,
        async send(text: string): Promise<unknown> {
          const res = await connectorCall(conversationUrl, 'POST', {
            type: 'message',
            text,
            ...(activity.id ? { replyToId: activity.id } : {}),
          });
          return res?.id ?? null;
        },
        async edit(ref: unknown, text: string): Promise<void> {
          if (ref === null || ref === undefined) return;
          await connectorCall(
            `${conversationUrl}/${encodeURIComponent(String(ref))}`,
            'PUT',
            { type: 'message', text },
          );
        },
      };
    },
  };
}
