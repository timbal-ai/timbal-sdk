import type { ApiClient } from '../api';
import type { SignContentOptions, SignedContent, SignedUrlInfo } from '../../types';

function resolveOrgId(client: ApiClient, opts?: SignContentOptions): string {
  const orgId = opts?.orgId || client.getConfig().orgId;
  if (!orgId) throw new Error('orgId is required. Provide it in opts, client config, or set TIMBAL_ORG_ID env var.');
  return orgId;
}

// ── Signed-URL inspection (pure, no network) ────────────────────────────────

/**
 * Parse the CloudFront-style signing params off a content URL.
 *
 * Timbal-served content URLs carry `Expires` (epoch **seconds**), `Signature`,
 * `Key-Pair-Id`, and `Hash-Algorithm` on the query string. Unsigned URLs and
 * non-URL inputs (bare object keys) return an all-`null` info with
 * `signed: false` — they never "expire".
 *
 * @example
 * const info = parseSignedContentUrl(file.url);
 * if (info.expiresAt) console.log("URL dies at", info.expiresAt.toISOString());
 */
export function parseSignedContentUrl(url: string): SignedUrlInfo {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    // Not an absolute URL (e.g. a bare object key) — nothing to parse.
  }

  const params = parsed?.searchParams;
  const expiresRaw = params?.get('Expires') ?? null;
  const expiresSeconds = expiresRaw !== null ? Number(expiresRaw) : NaN;

  return {
    signed: params?.get('Signature') != null,
    expiresAt: Number.isFinite(expiresSeconds) ? new Date(expiresSeconds * 1000) : null,
    signature: params?.get('Signature') ?? null,
    keyPairId: params?.get('Key-Pair-Id') ?? null,
    hashAlgorithm: params?.get('Hash-Algorithm') ?? null,
  };
}

/**
 * Whether a signed content URL is expired (or expires within `skewMs`).
 *
 * URLs without an `Expires` param (public/unsigned content) are never
 * considered expired.
 *
 * @param skewMs - Freshness margin: treat URLs expiring within this window as
 *   already expired. Defaults to 0 (exact expiry check).
 */
export function isSignedContentUrlExpired(url: string, skewMs = 0): boolean {
  const { expiresAt } = parseSignedContentUrl(url);
  if (!expiresAt) return false;
  return expiresAt.getTime() - skewMs <= Date.now();
}

// ── Sign endpoint (POST /orgs/{org}/content/sign) ───────────────────────────

/**
 * Refresh a signed URL for stored content
 * (`POST /orgs/{org}/content/sign`).
 *
 * Pass a content URL previously returned by the API (signed or unsigned), or
 * a bare object key. The server resolves it back to a known object it owns,
 * re-checks your access, and mints a fresh URL — useful when a cached signed
 * URL has expired and you want a new one without re-fetching the whole parent
 * resource.
 *
 * Prefer `signed_url` from the response when present; `url` is the legacy
 * unsigned CDN URL kept for backwards compatibility.
 *
 * @throws {TimbalApiError} 400 on a malformed body, 403 when the caller has
 *   no access to the resolved object.
 *
 * @example
 * const fresh = await signContentUrl(client, staleFile.url);
 * const usable = fresh.signed_url ?? fresh.url;
 */
export async function signContentUrl(
  client: ApiClient,
  url: string,
  opts?: SignContentOptions,
): Promise<SignedContent> {
  const orgId = resolveOrgId(client, opts);
  const response = await client.post<SignedContent>(`orgs/${orgId}/content/sign`, { url });
  return response.data;
}
