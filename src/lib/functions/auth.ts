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

/**
 * Refresh an access token using a refresh token.
 *
 * @param client - The API client instance (used only for baseUrl).
 * @param refreshToken - The refresh token to exchange.
 * @returns A new token pair (access_token and refresh_token).
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
    throw new Error('Token refresh failed');
  }

  return res.json() as Promise<TokenPair>;
}
