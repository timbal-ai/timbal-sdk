import type { ApiClient } from '../api';
import type {
  PersonalConnection,
  PersonalConnectionListOptions,
  PersonalConnectionPage,
  PersonalConsentOptions,
  PersonalUseResult,
} from '../../types';
import {
  listPersonalConnections,
  listPersonalConnectionsPage,
  listPersonalConnectionsAll,
  iteratePersonalConnections,
} from '../functions/integrations';
import { PersonalConnectionRef } from './personal-connection-ref';

/**
 * Per-caller-token ("personal") integration connections — reached via
 * `timbal.integrations.personal`.
 *
 * Each row represents one provider the caller can connect to with their own
 * OAuth token. The row's existence is session-scoped: it's listed if either
 * the provider is enabled in the catalog *or* the caller already holds a
 * token (admin may have re-disabled the provider since they connected).
 *
 * The connection state for the *current caller* is always under `row.user`.
 * Narrow with `if (row.user.connected)`:
 *
 * ```ts
 * const gmail = await timbal.integrations.personal.byProvider('gmail');
 * if (gmail?.user.connected) {
 *   console.log(gmail.user.metadata.account_email);
 * } else if (gmail?.user.status === 'expired') {
 *   // reconnect flow
 * }
 * ```
 *
 * Stripe-style collection ops plus a resource view via {@link get} for
 * token vending and consent. Disconnect will land later.
 */
export class PersonalConnectionsSection {
  constructor(private readonly apiClient: ApiClient) {}

  /**
   * First page of personal connections. The backend currently returns a
   * single page; use {@link listAll} / {@link iterate} to stay forward-compat
   * with paginated rollouts.
   */
  list(options?: PersonalConnectionListOptions): Promise<PersonalConnection[]> {
    return listPersonalConnections(this.apiClient, options);
  }

  /** Full pagination envelope (`{ integrations, next_page_token? }`). */
  listPage(options?: PersonalConnectionListOptions): Promise<PersonalConnectionPage> {
    return listPersonalConnectionsPage(this.apiClient, options);
  }

  /**
   * Drain every page into one array. Sugar over {@link iterate} when you want
   * the full set in memory.
   */
  listAll(options?: PersonalConnectionListOptions): Promise<PersonalConnection[]> {
    return listPersonalConnectionsAll(this.apiClient, options);
  }

  /** Async iterator over every personal connection, walking pages automatically. */
  iterate(options?: PersonalConnectionListOptions): AsyncIterable<PersonalConnection> {
    return iteratePersonalConnections(this.apiClient, options);
  }

  /**
   * Look up the personal connection row for a given provider. Walks pages
   * and early-exits on the first match. Returns `null` when no row exists
   * (provider isn't enabled and caller has never connected).
   *
   * Pair with `result?.user.connected` to decide whether to show "Connect"
   * vs. the connected account in the UI.
   */
  async byProvider(
    provider: string,
    options?: PersonalConnectionListOptions,
  ): Promise<PersonalConnection | null> {
    for await (const conn of this.iterate(options)) {
      if (conn.integration_provider === provider) return conn;
    }
    return null;
  }

  /**
   * Get a scoped view onto a specific personal connection row.
   * **Synchronous, no network call** — just wraps `apiClient` +
   * `integrationId`. Use it to vend tokens, start consent, or run the
   * one-shot `use()` flow.
   *
   * ```ts
   * const ref = timbal.integrations.personal.get('15');
   * const r = await ref.use({ redirect_uri: 'https://my-app/cb' });
   * if (!r.connected) return res.redirect(r.redirect_url);
   * await callGmail(r.token.token);
   * ```
   */
  get(integrationId: string): PersonalConnectionRef {
    return new PersonalConnectionRef(this.apiClient, integrationId);
  }

  /**
   * Provider-keyed shortcut: look up the row, then run {@link
   * PersonalConnectionRef.use} in one call.
   *
   * Returns `null` when no row exists for the provider (admin disabled it
   * and the caller never connected — caller has nothing to do here).
   * Otherwise returns the same tagged union as
   * {@link PersonalConnectionRef.use}.
   *
   * ```ts
   * const r = await timbal.integrations.personal.connect('gmail', {
   *   redirect_uri: 'https://my-app/cb',
   * });
   * if (r === null) throw new Error('Gmail is not available in this org');
   * if (!r.connected) return res.redirect(r.redirect_url);
   * await callGmail(r.token.token);
   * ```
   */
  async connect(
    provider: string,
    opts: PersonalConsentOptions,
  ): Promise<PersonalUseResult | null> {
    const row = await this.byProvider(provider);
    if (!row) return null;
    return this.get(row.id).use(opts);
  }
}
