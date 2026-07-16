/**
 * TTL-bounded idempotency cache for webhook redelivery.
 *
 * Channels redeliver aggressively: Slack retries any event not acked within
 * 3s (`X-Slack-Retry-Num`), Telegram re-sends every update until it sees a
 * 200. Without this, a slow agent run means the same message invokes the
 * workforce two or three times.
 *
 * In-memory on purpose — webhook retries land within seconds/minutes, well
 * inside one process lifetime. Multi-replica deployments where retries can
 * hit different pods need a shared store; that slots in behind this same
 * `seen()` contract later.
 */
export class DedupeCache {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs = 15 * 60_000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Returns `true` if `key` was already seen (within TTL); otherwise records
   * it and returns `false`. One call does both — check and mark — so there's
   * no race window between them.
   */
  seen(key: string): boolean {
    const t = this.now();
    const expiresAt = this.entries.get(key);
    if (expiresAt !== undefined && expiresAt > t) return true;

    this.entries.set(key, t + this.ttlMs);
    this.evict(t);
    return false;
  }

  /** Drop expired entries; if still over capacity, drop oldest-inserted. */
  private evict(t: number): void {
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= t) this.entries.delete(key);
    }
    // Map preserves insertion order → the first keys are the oldest.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
