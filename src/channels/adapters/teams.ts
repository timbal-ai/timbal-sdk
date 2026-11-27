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
  isErrorPage,
  isGenericType,
  readCapped,
  sniffImageType,
  webmTrackKinds,
  withDeadline,
} from '../download';
import {
  certificateAuthentication,
  federatedAuthentication,
  type ClientAuthentication,
  type TeamsCertificate,
  type TeamsFederatedToken,
} from './teams-auth';

export interface TeamsAdapterOptions {
  /** Entra Application (client) ID — JWT `aud` + connector token client_id. */
  appId: string;
  /**
   * Client secret from the app registration. Gets connector tokens (replies)
   * but not file tokens. Optional when `certificate` or `federatedToken` is
   * set, which then get connector tokens too.
   */
  appPassword?: string;
  /**
   * Certificate on the app registration. Gets the tokens that personal-chat
   * file downloads need once their URLs lose `tempauth` (March 1, 2027).
   * Takes precedence over `federatedToken`.
   */
  certificate?: TeamsCertificate;
  /**
   * Federated identity credential: returns the external token the app
   * registration trusts, sent as the client assertion. Gets file tokens,
   * like `certificate`.
   */
  federatedToken?: TeamsFederatedToken;
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
  /**
   * Hosts (and their subdomains) a file's `downloadUrl` may be on, and its
   * redirects may lead to. Teams stores files users send in OneDrive for
   * Business. @default ['sharepoint.com']
   */
  fileHosts?: string[];
  /** Time allowed for one file download, in milliseconds. @default 60000 */
  fileTimeoutMs?: number;
  /**
   * Time allowed for one Entra token request (connector or file token), in
   * milliseconds. A request still pending then is dropped, so the next
   * download or reply starts a fresh one. @default 30000
   */
  tokenTimeoutMs?: number;
  /**
   * Largest file downloaded, in bytes; larger ones fail that attachment.
   * Files are held in memory and re-uploaded. @default 52428800 (50 MB)
   */
  maxFileBytes?: number;
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
/** Connector and file tokens, by login origin, tenant, app, scope and credential. */
const tokenCache = new Map<string, TokenCacheEntry>();
/** Token requests in flight, so concurrent downloads share one. */
const pendingTokens = new Map<string, Promise<TokenCacheEntry>>();
/** Numbers each certificate / federated credential, to key its tokens apart. */
let credentialSerial = 0;

/** Reset the shared JWKS + token caches (tests). */
export function clearTeamsAdapterCaches(): void {
  jwksCache.clear();
  tokenCache.clear();
  pendingTokens.clear();
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
  from?: { id?: string; name?: string; aadObjectId?: string; role?: string };
  recipient?: { id?: string; name?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  channelData?: { tenant?: { id?: string } };
  entities?: TeamsMentionEntity[];
  attachments?: TeamsAttachment[];
}

/** Bot Framework attachment: `content` and `contentUrl` are alternatives. */
interface TeamsAttachment {
  contentType?: string;
  contentUrl?: string;
  content?: unknown;
  name?: string;
}

/** `content` of a {@link FILE_DOWNLOAD_INFO} attachment. */
interface TeamsFileDownloadInfo {
  downloadUrl?: string;
  uniqueId?: string;
  /** The file's extension (`pdf`, `docx`, ...). */
  fileType?: string;
  /** Tenant that holds the file; its file token is requested there. */
  tenantId?: string;
}

/**
 * A file the user sent in a personal chat (bots whose manifest sets
 * `supportsFiles`). Until March 1, 2027, `content.downloadUrl` carries its
 * own credential (`tempauth`) and is fetched with no token. A URL without
 * one needs an app-only token for `https://<url host>/.default`, got with a
 * certificate or federated credential (Entra refuses a client secret's) in
 * the file's tenant, and the RSC permission `File.ReadSelected.User` in the
 * app manifest.
 */
const FILE_DOWNLOAD_INFO = 'application/vnd.microsoft.teams.file.download.info';

const CONNECTOR_SCOPE = 'https://api.botframework.com/.default';

/** Whether a file URL carries its own `tempauth` credential (name matched ignoring case). */
function hasTempauth(url: URL): boolean {
  for (const name of url.searchParams.keys()) {
    if (name.toLowerCase() === 'tempauth') return true;
  }
  return false;
}

/** A tenant ID (GUID) or domain, safe to put in the token endpoint path. */
const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

const validTenant = (tenant: unknown): string | undefined =>
  typeof tenant === 'string' && TENANT_PATTERN.test(tenant) ? tenant : undefined;

/**
 * Teams file types other than {@link FILE_DOWNLOAD_INFO} (`file.info`,
 * `card.file.info`, as seen for files shared in channels and group chats):
 * a file was sent, but with no link the bot can download. A consent card
 * is the bot's own upload request, not a file.
 */
function isTeamsFileInfo(type: string | undefined): boolean {
  return (
    !!type &&
    type.startsWith('application/vnd.microsoft.teams.') &&
    type.includes('file') &&
    type !== FILE_DOWNLOAD_INFO &&
    !type.includes('consent')
  );
}

/**
 * Extension → MIME type, for files Teams sends with only an extension. Lets
 * the pipeline skip files agents can't read before downloading them, and
 * marks audio for transcription. An extension not listed (or ambiguous,
 * like `webm`, audio or video) stays untyped: the download's type decides.
 */
const FILE_TYPES = new Map<string, string>([
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['txt', 'text/plain'],
  ['csv', 'text/csv'],
  ['md', 'text/markdown'],
  ['html', 'text/html'],
  ['htm', 'text/html'],
  ['json', 'application/json'],
  ['mp3', 'audio/mpeg'],
  ['m4a', 'audio/mp4'],
  ['wav', 'audio/wav'],
  ['ogg', 'audio/ogg'],
  ['oga', 'audio/ogg'],
  ['opus', 'audio/opus'],
  ['aac', 'audio/aac'],
  ['amr', 'audio/amr'],
  ['flac', 'audio/flac'],
  ['weba', 'audio/webm'],
  // Unreadable types common enough to refuse before downloading them.
  ['zip', 'application/zip'],
  ['7z', 'application/x-7z-compressed'],
  ['rar', 'application/vnd.rar'],
  ['gz', 'application/gzip'],
  ['tgz', 'application/gzip'],
  ['tar', 'application/x-tar'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
  ['doc', 'application/msword'],
  ['xls', 'application/vnd.ms-excel'],
  ['ppt', 'application/vnd.ms-powerpoint'],
  ['avi', 'video/x-msvideo'],
  ['mkv', 'video/x-matroska'],
  ['wmv', 'video/x-ms-wmv'],
  ['mp4', 'video/mp4'],
  ['mov', 'video/quicktime'],
]);

/**
 * A `.webm` served with a generic type: audio or video by its track list,
 * so a voice recording is transcribed and a screen recording isn't.
 */
function webmType(data: Uint8Array): string | undefined {
  const kinds = webmTrackKinds(data);
  if (kinds?.video) return 'video/webm';
  if (kinds?.audio) return 'audio/webm';
  return undefined;
}

/** `url` when it is an `https:` URL, else `undefined`. */
function httpsUrl(url: unknown): URL | undefined {
  if (typeof url !== 'string') return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface TeamsMentionEntity {
  type?: string;
  text?: string;
  mentioned?: { id?: string; name?: string };
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Remove the bot's @mention (anywhere in the text) and unwrap other `<at>`
 * tags to display names — Bot Framework `RemoveRecipientMention` semantics.
 *
 * Channel posts often put another user before the bot (`@Marta @Bot hi`);
 * stripping only a *leading* `<at>` leaves the bot's display name in the
 * prompt. Prefer `entities` (exact `entity.text` match on recipient id),
 * then `<at id="{recipient}">` tags, then a leading tag whose inner text
 * matches the recipient name (bare tags with no entities).
 */
function cleanTeamsMentionText(
  text: string,
  opts: {
    recipientId?: string;
    recipientName?: string;
    entities?: TeamsMentionEntity[];
  },
): string {
  let out = text;
  const recipientId = opts.recipientId;

  if (recipientId && opts.entities) {
    for (const entity of opts.entities) {
      if (entity?.type !== 'mention' || entity.mentioned?.id !== recipientId) continue;
      if (typeof entity.text === 'string' && entity.text.length > 0) {
        out = out.split(entity.text).join('');
      }
    }
  }

  if (recipientId) {
    const id = escapeRegExp(recipientId);
    out = out.replace(
      new RegExp(`\\s*<at\\s[^>]*\\bid=(["']?)${id}\\1[^>]*>[^<]*</at>\\s*`, 'gi'),
      ' ',
    );
  }

  // Bare leading `<at>BotName</at>` when Teams omitted entities / id attrs.
  if (opts.recipientName) {
    const name = escapeRegExp(opts.recipientName);
    out = out.replace(
      new RegExp(`^\\s*<at(?:\\s[^>]*)?>\\s*@?${name}\\s*</at>\\s*`, 'i'),
      '',
    );
  }

  return out
    .replace(/<at(?:\s[^>]*)?>([^<]*)<\/at>/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Microsoft Teams channel adapter (hand-rolled Activity Protocol edge — no
 * botbuilder / Teams SDK dependency; see docs/teams-plan.md).
 *
 * - `verify` validates the Bot Connector JWT: RS256 signature against the
 *   Bot Framework JWKS (cached module-wide), `iss`, `aud` = app id,
 *   `exp`/`nbf` within skew, and the token's `serviceurl` claim (required)
 *   against the activity's `serviceUrl` (blocks replaying a signed activity
 *   at a forged reply target, and sending the connector token elsewhere).
 * - `parse` accepts `type: "message"` activities; `conversationUpdate`,
 *   reactions, typing, etc. return `[]`. Teams bakes the thread into
 *   `conversation.id` for channel messages, so thread-scoped memory needs no
 *   extra composition (unlike Slack).
 * - Attachments: files sent in a personal chat
 *   (`application/vnd.microsoft.teams.file.download.info`) download from
 *   `content.downloadUrl` as received: with no token while the URL carries
 *   `tempauth`, else with a file token (`certificate` / `federatedToken`)
 *   sent only to the URL's host. Inline images (`image/*` with a
 *   `contentUrl`) download with the connector token, which is sent only to
 *   the activity's `serviceUrl` host. Cards and the message's `text/html`
 *   copy are not files.
 * - Replies go to the **inbound** activity's `serviceUrl` via the Bot
 *   Connector REST API, authenticated with a client-credentials token
 *   (cached until expiry; the client secret, else the certificate or
 *   federated credential). `edit` maps to activity PUT, so streaming can
 *   be enabled later.
 *
 * Webhook registration is manual (Azure Bot → Configuration → Messaging
 * endpoint), like Slack's manifest — no `registerWebhook`.
 */
export function teams(options: TeamsAdapterOptions): ChannelAdapter {
  const { appId, appPassword, tenantId } = options;
  if (!appId) throw new Error('teams adapter requires an appId');

  const metadataUrl = options.openIdMetadataUrl ?? DEFAULT_OPENID_METADATA_URL;
  const loginBase = options.loginBase ?? 'https://login.microsoftonline.com';
  const maxSkewSeconds = options.maxSkewSeconds ?? 300;
  const now = options.now ?? Date.now;
  const fileHosts = (options.fileHosts ?? ['sharepoint.com']).map((h) => h.toLowerCase());
  const fileTimeoutMs = options.fileTimeoutMs ?? 60_000;
  const tokenTimeoutMs = options.tokenTimeoutMs ?? 30_000;
  const maxFileBytes = options.maxFileBytes ?? 50 * 1024 * 1024;
  /** Whether `url` is on a file host or one of its subdomains. */
  const isFileHost = (url: URL): boolean => {
    const host = url.hostname.toLowerCase();
    return fileHosts.some((h) => host === h || host.endsWith(`.${h}`));
  };
  // Multi-tenant bots request connector tokens against the shared
  // botframework.com tenant; single-tenant must use their own.
  const tokenTenant = tenantId || 'botframework.com';

  /** A credential, and the id that keeps tokens it gets apart in the cache. */
  interface Credential {
    id: string;
    authenticate: ClientAuthentication;
  }
  // File tokens: a certificate or federated credential only.
  // Each adapter's credential gets its own id: two adapters for the same
  // app (during a rotation) must not share token requests, or a failing
  // retired credential fails the healthy one's downloads too.
  const fileCredential: Credential | undefined = options.certificate
    ? {
        id: `certificate#${++credentialSerial}`,
        authenticate: certificateAuthentication(appId, options.certificate, now),
      }
    : options.federatedToken
      ? {
          id: `federated#${++credentialSerial}`,
          authenticate: federatedAuthentication(options.federatedToken),
        }
      : undefined;
  // Connector tokens: the client secret when set (as before), else the same.
  const connectorCredential: Credential | undefined = appPassword
    ? { id: `secret:${appPassword}`, authenticate: async () => ({ client_secret: appPassword }) }
    : fileCredential;
  if (!connectorCredential) {
    throw new Error('teams adapter requires an appPassword, certificate or federatedToken');
  }

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

  /** The cached token for `key`, else one from `request` (shared while in flight). */
  async function cachedToken(
    key: string,
    request: () => Promise<TokenCacheEntry>,
  ): Promise<string> {
    const cached = tokenCache.get(key);
    // 60s early-expiry margin so a token never dies mid-send.
    if (cached && cached.expiresAt > now() + 60_000) return cached.token;
    let pending = pendingTokens.get(key);
    if (!pending) {
      pending = request()
        .then((entry) => {
          tokenCache.set(key, entry);
          return entry;
        })
        .finally(() => pendingTokens.delete(key));
      pendingTokens.set(key, pending);
    }
    return (await pending).token;
  }

  /**
   * An app-only token for `scope` in `tenant` (client credentials grant).
   * The request, shared by concurrent callers, is limited to
   * `tokenTimeoutMs`: a stalled one is dropped, so the next caller starts
   * a fresh one instead of waiting on it.
   */
  function token(tenant: string, scope: string, credential: Credential, label: string) {
    const request = (signal: AbortSignal) => async (): Promise<TokenCacheEntry> => {
      const tokenUrl = `${loginBase}/${tenant}/oauth2/v2.0/token`;
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: appId,
          scope,
          ...(await credential.authenticate(tokenUrl)),
        }),
        signal,
      });
      const payload = (await res.json().catch(() => null)) as {
        access_token?: string;
        expires_in?: number;
        error_description?: string;
      } | null;
      if (!res.ok || !payload?.access_token) {
        throw new Error(
          `${label} failed (${res.status}): ${payload?.error_description ?? 'unknown error'}`,
        );
      }
      return {
        token: payload.access_token,
        expiresAt: now() + (payload.expires_in ?? 3600) * 1000,
      };
    };
    return cachedToken(`${loginBase}|${tenant}|${appId}|${scope}|${credential.id}`, () =>
      withDeadline(
        tokenTimeoutMs,
        () => new Error(`${label} timed out after ${tokenTimeoutMs}ms`),
        (signal) => request(signal)(),
      ),
    );
  }

  const getConnectorToken = (): Promise<string> =>
    token(tokenTenant, CONNECTOR_SCOPE, connectorCredential, 'Teams connector token');

  /**
   * The token for a file URL on `host` in `tenant`: scope
   * `https://<host>/.default`, cached per tenant and host.
   */
  const getFileToken = (credential: Credential, tenant: string, host: string): Promise<string> =>
    token(tenant, `https://${host}/.default`, credential, 'Teams file token');

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

  const tooLarge = () =>
    new Error(`Teams file is larger than the ${maxFileBytes}-byte limit (maxFileBytes)`);

  function deadline(run: (signal: AbortSignal) => Promise<ChannelAttachmentData>) {
    return withDeadline(
      fileTimeoutMs,
      () => new Error(`Teams file download timed out after ${fileTimeoutMs}ms`),
      run,
    );
  }

  /**
   * GET an attachment's bytes. A `token` goes to `url`'s origin only, never
   * to a redirect elsewhere; `allowHop` limits where redirects may lead. An
   * error page instead of the file is refused (see {@link isErrorPage}), and
   * `refusalHint` explains a failed status, knowing whether the hop that
   * answered was sent the token.
   */
  async function fetchAttachment(
    url: URL,
    opts: {
      token?: () => Promise<string>;
      declared: string | undefined;
      allowHop?: (hop: URL) => boolean;
      signal: AbortSignal;
      refusalHint?: (status: number, tokenSent: boolean) => string;
    },
  ): Promise<{ data: Uint8Array; served: string | undefined }> {
    const token = opts.token ? await opts.token() : undefined;
    // The last hop asked for: the one whose answer comes back.
    let tokenSent = false;
    const res = await fetchFollowingRedirects(url, {
      signal: opts.signal,
      headersFor: (hop): Record<string, string> => {
        tokenSent = !!token && hop.origin === url.origin;
        return tokenSent ? { Authorization: `Bearer ${token}` } : {};
      },
      label: 'Teams file download',
      allowHop: opts.allowHop,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(
        `Teams file download failed (${res.status})${opts.refusalHint?.(res.status, tokenSent) ?? ''}`,
      );
    }
    const served = baseMimeType(res.headers.get('content-type'));
    const data = await readCapped(res, maxFileBytes, tooLarge);
    if (isErrorPage(opts.declared, served, data)) {
      throw new Error('Teams file download returned a web page instead of the file');
    }
    return { data, served };
  }

  /** An attachment the bot won't fetch, so the agent is told why it's missing. */
  function unavailableFile(
    kind: ChannelAttachment['kind'],
    fileName: string,
    contentType: string | undefined,
    reason: string,
  ): ChannelAttachment {
    return {
      kind,
      fileName,
      contentType,
      unavailable: reason,
      download: () => Promise.reject(new Error(`Teams file ${fileName} is not available: ${reason}`)),
    };
  }

  /**
   * How a personal-chat file URL is fetched. With `tempauth`, as received
   * and with no token. Without it, with a file token for the file's tenant
   * (`content.tenantId`, else the activity's), which needs a certificate or
   * federated credential.
   */
  function fileDownloadAuth(
    url: URL,
    info: TeamsFileDownloadInfo,
    activity: TeamsActivity,
  ): Pick<Parameters<typeof fetchAttachment>[1], 'token' | 'refusalHint'> {
    if (hasTempauth(url)) return {};
    if (!fileCredential) {
      return {
        refusalHint: (status) =>
          status === 401
            ? ': the URL has no tempauth credential and needs a file token, which takes a certificate or federatedToken (not a client secret)'
            : '',
      };
    }
    const credential = fileCredential;
    const tenant =
      validTenant(info.tenantId) ??
      validTenant(activity.channelData?.tenant?.id) ??
      validTenant(activity.conversation?.tenantId) ??
      validTenant(tenantId);
    return {
      token: async () => {
        if (!tenant) throw new Error('Teams file token needs a tenant ID, and the activity has none');
        return getFileToken(credential, tenant, url.host);
      },
      refusalHint: (status, tokenSent) =>
        status !== 401 && status !== 403
          ? ''
          : tokenSent
            ? ': the file token was refused; the app manifest must grant the File.ReadSelected.User RSC permission'
            : ': the file host redirected to another host, which the file token is not sent to',
    };
  }

  /**
   * Files and inline media of a message. Only Teams activities are fetched:
   * on other Bot Framework channels (Web Chat, Direct Line) the sender
   * chooses the URLs, and the server would fetch whatever they point at.
   * Within Teams, file links must be on {@link TeamsAdapterOptions.fileHosts}
   * and inline media on the connector (`serviceUrl`) origin.
   */
  function parseAttachments(activity: TeamsActivity): ChannelAttachment[] {
    const connectorOrigin = httpsUrl(activity.serviceUrl)?.origin;
    const fromTeams = activity.channelId === 'msteams';
    const attachments: ChannelAttachment[] = [];
    for (const attachment of activity.attachments ?? []) {
      const type = baseMimeType(attachment.contentType);

      // A file shared in a channel or group chat: a link into SharePoint
      // that only a Graph token can read, typed `reference` or as a Teams
      // file-info attachment (named, unlike cards).
      if (type === 'reference' || (isTeamsFileInfo(type) && attachment.name)) {
        attachments.push(
          unavailableFile(
            'document',
            attachment.name || `file_${attachments.length + 1}`,
            undefined,
            "files shared in Teams channels and group chats can't be downloaded by the bot",
          ),
        );
        continue;
      }

      if (type === FILE_DOWNLOAD_INFO) {
        const info = (attachment.content ?? {}) as TeamsFileDownloadInfo;
        const nameExt = attachment.name?.includes('.') ? attachment.name.split('.').pop() : '';
        const ext = (info.fileType || nameExt || '').toLowerCase();
        const declared = FILE_TYPES.get(ext);
        const fallbackName = `file_${info.uniqueId ?? attachments.length + 1}`;
        const fileName = attachment.name || `${fallbackName}${ext ? `.${ext}` : ''}`;
        const url = httpsUrl(info.downloadUrl);
        if (!fromTeams || !url || !isFileHost(url)) {
          const reason = fromTeams
            ? "its download link isn't on the bot's allowed file hosts"
            : 'the bot only downloads files sent through Microsoft Teams';
          attachments.push(unavailableFile(attachmentKind(declared), fileName, declared, reason));
          continue;
        }
        attachments.push({
          kind: attachmentKind(declared),
          fileName,
          // Teams sends only the extension: an unknown one stays untyped,
          // so the download's type decides (`export.dat` served as CSV).
          contentType: declared,
          download: () =>
            deadline(async (signal) => {
              const { data, served } = await fetchAttachment(url, {
                ...fileDownloadAuth(url, info, activity),
                declared,
                allowHop: isFileHost,
                signal,
              });
              // An image's bytes beat its extension (`.gif` holding a PNG).
              const sniffed =
                attachmentKind(declared ?? served) === 'image'
                  ? sniffImageType(data)
                  : ext === 'webm' && isGenericType(served)
                    ? webmType(data)
                    : undefined;
              return {
                data,
                contentType: sniffed ?? declared ?? served ?? 'application/octet-stream',
                fileName,
              };
            }),
        });
        continue;
      }

      // Media with a `contentUrl` (inline images). Cards, the message's own
      // HTML copy and other Microsoft vendor types are not files.
      if (
        !type?.includes('/') ||
        type === 'text/html' ||
        type.startsWith('application/vnd.microsoft.')
      ) {
        continue;
      }
      // Inline images are often typed just `image/*`; the bytes tell.
      const declared = type.endsWith('/*') ? undefined : type;
      const kind = attachmentKind(type);
      const fileName = attachment.name || `${kind}_${attachments.length + 1}`;
      const url = httpsUrl(attachment.contentUrl);
      if (!fromTeams || !url || !connectorOrigin || url.origin !== connectorOrigin) {
        const reason = fromTeams
          ? 'Teams gave no link to it on the Bot Connector service'
          : 'the bot only downloads files sent through Microsoft Teams';
        attachments.push(unavailableFile(kind, fileName, declared, reason));
        continue;
      }
      attachments.push({
        kind,
        fileName,
        contentType: declared,
        download: () =>
          deadline(async (signal) => {
            // `type` (e.g. `image/*`) for the error-page check: an image is
            // never HTML.
            const { data, served } = await fetchAttachment(url, {
              token: getConnectorToken,
              declared: declared ?? type,
              signal,
            });
            // The bytes beat the declared type: Teams can list a pasted
            // image as GIF and serve a static PNG.
            const sniffed = kind === 'image' ? sniffImageType(data) : undefined;
            return {
              data,
              contentType: sniffed ?? declared ?? served ?? 'application/octet-stream',
              fileName,
            };
          }),
      });
    }
    return attachments;
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

      // The token pins the serviceUrl the connector token is later sent to
      // (replies, inline media); the activity body carries the one used.
      // Require the claim and a matching body serviceUrl, as botbuilder's
      // channel validation does: without the claim, the body alone would
      // choose where the connector token goes.
      if (typeof payload.serviceurl !== 'string') return unauthorized();
      let activity: TeamsActivity | null = null;
      try {
        activity = JSON.parse(req.rawBody) as TeamsActivity;
      } catch {
        return unauthorized();
      }
      if (
        typeof activity?.serviceUrl !== 'string' ||
        trimTrailingSlash(activity.serviceUrl) !== trimTrailingSlash(payload.serviceurl)
      ) {
        return unauthorized();
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
      // Drop bot-authored activities (our echoes and other bots). Role is the
      // Bot Framework signal; from===recipient covers self-echoes without it.
      if (
        activity.from?.role === 'bot' ||
        (activity.recipient?.id && fromId === activity.recipient.id)
      ) {
        return [];
      }

      // Strip the bot @-mention wherever it appears, then unwrap other
      // mention tags to display names (see cleanTeamsMentionText).
      const text = cleanTeamsMentionText(activity.text ?? '', {
        recipientId: activity.recipient?.id,
        recipientName: activity.recipient?.name,
        entities: activity.entities,
      });
      // A bare file or image has no text — still a valid event.
      const attachments = parseAttachments(activity);
      if (!text && attachments.length === 0) return [];

      return [
        {
          provider: 'teams',
          conversationId,
          // aadObjectId is the stable org identity; the `29:` id is
          // bot-scoped. Prefer the former for future cross-channel linking.
          externalUserId: activity.from?.aadObjectId ?? fromId,
          userDisplayName: activity.from?.name,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
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
