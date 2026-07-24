import type { ApiClient } from '../api';
import type {
  EnsureFreshUrlOptions,
  SignContentOptions,
  SignedContent,
  SignedUrlInfo,
} from '../../types';
import {
  isSignedContentUrlExpired,
  parseSignedContentUrl,
  signContentUrl,
} from '../functions/content';

/** Default freshness margin for {@link ContentSection.ensureFresh} (1 min). */
const DEFAULT_FRESHNESS_SKEW_MS = 60_000;

/**
 * Stored-content URL plane — reached via `timbal.content`.
 *
 * Content URLs returned by the platform (KB files, temp files, screenshots, …)
 * are CloudFront-signed and go stale: the query string carries `Expires`
 * (epoch seconds), `Signature`, `Key-Pair-Id`, and `Hash-Algorithm`. This
 * section wraps `POST /orgs/{org}/content/sign` — which resolves a previously
 * returned URL (or bare object key) back to a known object, re-checks access,
 * and mints a fresh URL — plus pure helpers to inspect the signing params.
 *
 * - `sign(url)` — raw endpoint call, returns the `{ signed_url, url }` pair.
 * - `refresh(url)` — always re-sign; returns the best usable URL string.
 * - `ensureFresh(url)` — re-sign **only** when expired or expiring soon;
 *   otherwise returns the input unchanged (no network call).
 * - `parse(url)` / `isExpired(url)` — local inspection, no network.
 */
export class ContentSection {
  constructor(private readonly apiClient: ApiClient) {}

  /**
   * Mint a fresh CDN URL pair for a stored content object
   * (`POST /orgs/{org}/content/sign`).
   *
   * Accepts a content URL previously returned by the API (signed or
   * unsigned) or a bare object key. Prefer `signed_url` from the response
   * when present; `url` is the legacy unsigned CDN URL.
   *
   * @throws {TimbalApiError} 400 on a malformed body, 403 when the caller
   *   has no access to the resolved object.
   */
  sign(url: string, opts?: SignContentOptions): Promise<SignedContent> {
    return signContentUrl(this.apiClient, url, opts);
  }

  /**
   * Unconditionally re-sign and return the best usable URL string
   * (`signed_url` when present, legacy `url` otherwise).
   *
   * Use {@link ensureFresh} instead when the input may still be valid — it
   * skips the round-trip for fresh URLs.
   */
  async refresh(url: string, opts?: SignContentOptions): Promise<string> {
    const fresh = await this.sign(url, opts);
    return fresh.signed_url ?? fresh.url;
  }

  /**
   * Return a usable URL, re-signing only when needed.
   *
   * - Signed URL still fresh (expires later than `skewMs` from now) — returned
   *   unchanged, **no network call**.
   * - Signed URL expired or expiring within `skewMs` (default 1 min) — re-signed.
   * - Unsigned absolute URL (no `Expires`) — public content, returned unchanged.
   * - Bare object key (not an absolute URL) — always signed into a real URL.
   *
   * The cache-refresh pattern in one call:
   *
   * @example
   * // stored.url may be hours old — only pays the round-trip when stale
   * const usable = await timbal.content.ensureFresh(stored.url);
   */
  async ensureFresh(url: string, opts?: EnsureFreshUrlOptions): Promise<string> {
    const skewMs = opts?.skewMs ?? DEFAULT_FRESHNESS_SKEW_MS;

    let isAbsoluteUrl = true;
    try {
      new URL(url);
    } catch {
      isAbsoluteUrl = false; // bare object key — must be signed to be fetchable
    }

    if (isAbsoluteUrl && !isSignedContentUrlExpired(url, skewMs)) {
      return url;
    }
    return this.refresh(url, opts);
  }

  /**
   * Parse the CloudFront signing params (`Expires`, `Signature`,
   * `Key-Pair-Id`, `Hash-Algorithm`) off a content URL. Pure — no network.
   */
  parse(url: string): SignedUrlInfo {
    return parseSignedContentUrl(url);
  }

  /**
   * Whether a content URL is expired (or expires within `skewMs`).
   * URLs without an `Expires` param never expire. Pure — no network.
   */
  isExpired(url: string, skewMs?: number): boolean {
    return isSignedContentUrlExpired(url, skewMs);
  }
}
