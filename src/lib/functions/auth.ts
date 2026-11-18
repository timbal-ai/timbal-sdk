import type { ApiClient } from '../api';
import type { OAuthProvider, TokenPair } from '../../types';

function getBaseUrl(client: ApiClient): string {
  return client.getConfig().baseUrl;
}

/**
 * Build an OAuth authorization URL for the given provider.
 *
 * @param client - The API client instance (used only for baseUrl).
 * @param provider - OAuth provider: "github", "google", or "microsoft".
 * @param redirectUri - The URL to redirect to after authorization.
 * @returns The full OAuth authorization URL.
 */
export function getOAuthUrl(
  client: ApiClient,
  provider: OAuthProvider,
  redirectUri: string,
): string {
  const base = getBaseUrl(client);
  return `${base}/oauth/authorize?provider=${provider}&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

/**
 * Send a magic link email for passwordless authentication.
 *
 * @param client - The API client instance (used only for baseUrl).
 * @param email - The email address to send the magic link to.
 * @param redirectUri - The URL to redirect to after authentication.
 */
export async function sendMagicLink(
  client: ApiClient,
  email: string,
  redirectUri: string,
): Promise<void> {
  const base = getBaseUrl(client);
  const token = client.getConfig().token;
  const res = await fetch(`${base}/auth/magic-link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ email, redirect_uri: redirectUri }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || 'Failed to send magic link');
  }
}

const TERMINAL_OAUTH_ERRORS = new Set(['invalid_grant', 'invalid_client']);

/**
 * The refresh token will never succeed again (revoked, expired, or signed
 * with a key the platform no longer has). Callers must drop it and
 * re-authenticate. Do not retry, and do not substitute the project API key
 * or `TIMBAL_PROJECT_SECRET` — those are service credentials, not a user session.
 *
 * Transient failures (HTTP 5xx, 429, network) stay a generic `Error`.
 */
export class RefreshTokenInvalidError extends Error {
  readonly status: number;
  readonly oauthError: string;

  constructor(message: string, status: number, oauthError = 'invalid_grant') {
    super(message);
    this.name = 'RefreshTokenInvalidError';
    this.status = status;
    this.oauthError = oauthError;
  }
}

interface OAuthErrorBody {
  error?: string;
  error_description?: string;
}

async function readOAuthError(res: Response): Promise<OAuthErrorBody> {
  if (typeof res.json !== 'function') return {};
  try {
    const body = await res.json();
    if (!body || typeof body !== 'object') return {};
    const record = body as { error?: unknown; error_description?: unknown };
    return {
      error: typeof record.error === 'string' ? record.error : undefined,
      error_description:
        typeof record.error_description === 'string' ? record.error_description : undefined,
    };
  } catch {
    return {};
  }
}

/** Drop a description that echoes the refresh token. Never return the raw token. */
function publicRefreshMessage(description: string | undefined, refreshToken: string): string {
  if (!description) return 'Token refresh failed';
  if (refreshToken.length >= 16 && description.includes(refreshToken)) {
    return 'Token refresh failed';
  }
  return description;
}

function publicOAuthCode(oauthError: string | undefined, refreshToken: string): string {
  if (!oauthError) return 'invalid_grant';
  if (refreshToken.length >= 16 && oauthError.includes(refreshToken)) return 'invalid_grant';
  return oauthError;
}

function isTerminalRefreshFailure(status: number, oauthError: string | undefined): boolean {
  if (status === 400 || status === 401) return true;
  return oauthError !== undefined && TERMINAL_OAUTH_ERRORS.has(oauthError);
}

/**
 * Refresh an access token using a refresh token.
 *
 * The configured service token (`TIMBAL_PROJECT_SECRET` / `TIMBAL_API_KEY`),
 * when present, is sent only as client authentication on this token request.
 * It is never returned as a browser session.
 *
 * @param client - The API client instance (used only for baseUrl and client auth).
 * @param refreshToken - The refresh token to exchange.
 * @returns A new token pair (access_token and refresh_token).
 * @throws {RefreshTokenInvalidError} on HTTP 400/401 or `invalid_grant` /
 *   `invalid_client`. Terminal: clear the stored refresh token and re-login.
 * @throws {Error} `Token refresh failed` on transient failures (5xx, 429, other
 *   non-terminal statuses). Network failures reject with the fetch error.
 */
export async function refreshToken(
  client: ApiClient,
  refreshToken: string,
): Promise<TokenPair> {
  const base = getBaseUrl(client);
  const token = client.getConfig().token;
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await readOAuthError(res);
    if (isTerminalRefreshFailure(res.status, body.error)) {
      throw new RefreshTokenInvalidError(
        publicRefreshMessage(body.error_description, refreshToken),
        res.status,
        publicOAuthCode(body.error, refreshToken),
      );
    }
    throw new Error('Token refresh failed');
  }

  return res.json() as Promise<TokenPair>;
}
