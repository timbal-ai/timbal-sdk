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

/** Cap on memoized minted URLs; oldest entries are evicted past this. */
const MAX_CACHE_ENTRIES = 1_000;

/** One memoized mint: the fresh URL and when it stops being servable. */
interface CachedMint {
  url: string;
  /** Epoch ms from the minted URL's recognized expiry. */
  expiresAtMs: number;
}

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
 * - `refresh(url)` — always re-sign; returns the authorized URL string.
 * - `ensureFresh(url)` — re-sign **only** when expired or expiring soon;
 *   otherwise returns the input unchanged (no network call).
 * - `parse(url)` / `isExpired(url)` — local inspection, no network.
 *
 * Minted URLs are memoized per `(org, object path)` until their own expiry,
 * so repeated `ensureFresh` calls on the same stale input (or bare object
 * key) pay the round-trip once. Invalidate with {@link clearCache}. Caching
 * changes nothing security-wise — a minted signed URL stays valid until its
 * `Expires` regardless of whether the SDK remembers it.
 */
export class ContentSection {
  private readonly mintCache = new Map<string, CachedMint>();

  constructor(private readonly apiClient: ApiClient) {}

  /**
   * Mint a fresh CDN URL pair for a stored content object
   * (`POST /orgs/{org}/content/sign`).
   *
   * Accepts a content URL previously returned by the API (signed or
   * unsigned) or a bare object key. Use `signed_url`; an absent value is a signing failure, not a public fallback.
   *
   * @throws {TimbalApiError} 400 on a malformed body, 403 when the caller
   *   has no access to the resolved object.
   */
  sign(url: string, opts?: SignContentOptions): Promise<SignedContent> {
    return signContentUrl(this.apiClient, url, opts);
  }

  /**
   * Unconditionally re-sign and return the authorized URL string
   * from `signed_url`. Rejects missing signing instead of downgrading access.
   *
   * Always hits the network (never *reads* the cache), but the minted URL is
   * memoized for subsequent {@link ensureFresh} calls. Use `ensureFresh`
   * instead when the input may still be valid — it skips the round-trip.
   */
  async refresh(url: string, opts?: SignContentOptions): Promise<string> {
    const fresh = await this.sign(url, opts);
    const best = fresh.signed_url;
    if (typeof best !== 'string' || !best.trim()) {
      throw new Error('Content signing is unavailable; no authorized URL was returned');
    }
    this.remember(this.cacheKey(url, opts), best);
    return best;
  }

  /**
   * Return an authorized platform content URL, re-signing when needed.
   *
   * - Signed URL still fresh (expires later than `skewMs` from now) — returned
   *   unchanged, **no network call**.
   * - Signed URL expired or expiring within `skewMs` (default 1 min) — re-signed.
   * - URL without recognized signing/expiry — ask the platform to authorize it.
   * - Bare object key (not an absolute URL) — always signed into a real URL.
   *
   * Before re-signing, a memoized mint for the same `(org, object path)` is
   * served if it's still fresh — repeated calls on the same stale input or
   * bare key hit the network once per expiry window.
   *
   * The cache-refresh pattern in one call:
   *
   * @example
   * // stored.url may be hours old — only pays the round-trip when stale
   * const usable = await timbal.content.ensureFresh(stored.url);
   */
  async ensureFresh(url: string, opts?: EnsureFreshUrlOptions): Promise<string> {
    const skewMs = opts?.skewMs ?? DEFAULT_FRESHNESS_SKEW_MS;

    const info = parseSignedContentUrl(url);
    if (info.signed && info.expiresAt && Number.isFinite(info.expiresAt.getTime()) && !isSignedContentUrlExpired(url, skewMs)) {
      return url;
    }

    const cached = this.mintCache.get(this.cacheKey(url, opts));
    if (cached && cached.expiresAtMs - skewMs > Date.now()) {
      return cached.url;
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

  /** Drop all memoized minted URLs (next `ensureFresh` on stale input re-signs). */
  clearCache(): void {
    this.mintCache.clear();
  }

  // ── Mint memoization ──

  /**
   * Cache key: resolved org + the object path (URL stripped of its query
   * string, or the bare key as-is). Signing params never participate, so a
   * stale URL and its fresh mint share one entry.
   */
  private cacheKey(url: string, opts?: SignContentOptions): string {
    const org = opts?.orgId || this.apiClient.getConfig().orgId || '';
    let objectPath = url;
    try {
      const parsed = new URL(url);
      objectPath = `${parsed.origin}${parsed.pathname}`;
    } catch {
      // Bare object key — use verbatim.
    }
    return `${org}:${objectPath}`;
  }

  /** Memoize only URLs with a recognized expiry; never assume indefinite freshness. */
  private remember(key: string, mintedUrl: string): void {
    const { expiresAt } = parseSignedContentUrl(mintedUrl);
    if (!expiresAt || !Number.isFinite(expiresAt.getTime())) return;
    // Re-inserting moves the key to the back, so eviction stays oldest-first.
    this.mintCache.delete(key);
    if (this.mintCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.mintCache.keys().next().value;
      if (oldest !== undefined) this.mintCache.delete(oldest);
    }
    this.mintCache.set(key, { url: mintedUrl, expiresAtMs: expiresAt.getTime() });
  }
}
