import type { ApiClient } from '../api';
import type { SharedTokenVend } from '../../types';
import {
  deleteSharedConnection,
  vendSharedToken,
} from '../functions/integrations';

/**
 * A typed, scoped view onto a single shared (org-wide) integration row.
 *
 * Construct via `timbal.integrations.shared.get(id)` (preferred), or get
 * one for free from `shared.connectCredentials(...)`. You can also
 * `new SharedConnectionRef(apiClient, id)` directly.
 *
 * **Synchronous, no network call** — just binds `apiClient` +
 * `integrationId`. Cheap to allocate per call; stateless.
 *
 * Mirrors {@link PersonalConnectionRef} minus the consent/use methods —
 * shared connections have no per-row consent flow. To reconnect a stale
 * shared OAuth row, run `shared.connectOAuth({ provider, … })` again.
 */
export class SharedConnectionRef {
  constructor(
    public readonly apiClient: ApiClient,
    public readonly integrationId: string,
  ) {}

  /**
   * Vend this connection's token/credentials. Returns a discriminated
   * union — narrow on `result.type`:
   *
   * ```ts
   * const v = await ref.token();
   * if (v.type === 'oauth')        await callSlack(v.token);
   * else /* credentials *\/         await callProvider(v.api_key as string);
   * ```
   *
   * Throws {@link TimbalApiError} on 400 ("Integration is not active" —
   * row exists but needs reconnect), 404 ("Integration not found" — bad
   * id), and any other non-2xx.
   */
  token(): Promise<SharedTokenVend> {
    return vendSharedToken(this.apiClient, this.integrationId);
  }

  /**
   * Delete this shared connection. **Destructive** — the row is gone for
   * the whole org, and every caller loses access to the vended token.
   *
   * To re-add, call `shared.connectOAuth(...)` or
   * `shared.connectCredentials(...)` again. For "drop the whole
   * provider org-wide" use `catalog.disable(provider)` instead.
   */
  delete(): Promise<void> {
    return deleteSharedConnection(this.apiClient, this.integrationId);
  }
}
