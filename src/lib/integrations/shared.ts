import type { ApiClient } from '../api';
import type {
  SharedConnection,
  SharedConnectionListOptions,
  SharedConnectionPage,
} from '../../types';
import {
  listSharedConnections,
  listSharedConnectionsPage,
  listSharedConnectionsAll,
  iterateSharedConnections,
} from '../functions/integrations';

/**
 * Org-wide ("shared") integration connections — reached via
 * `timbal.integrations.shared`.
 *
 * Each row models a provider the org wired up centrally (one shared OAuth or
 * credentials connection). Every caller in the org vends the same token from
 * the same row. Compare with {@link PersonalConnectionsSection} for
 * per-caller-token rows.
 *
 * Stripe-style collection ops; resource views (token vending, disconnect)
 * will land later.
 */
export class SharedConnectionsSection {
  constructor(private readonly apiClient: ApiClient) {}

  /**
   * First page of shared connections. Use {@link listAll} or {@link iterate}
   * to walk every page (the server paginates today).
   */
  list(options?: SharedConnectionListOptions): Promise<SharedConnection[]> {
    return listSharedConnections(this.apiClient, options);
  }

  /** Full pagination envelope (`{ integrations, next_page_token? }`). */
  listPage(options?: SharedConnectionListOptions): Promise<SharedConnectionPage> {
    return listSharedConnectionsPage(this.apiClient, options);
  }

  /**
   * Drain every page into one array. Sugar over {@link iterate} when you want
   * the full set in memory.
   */
  listAll(options?: SharedConnectionListOptions): Promise<SharedConnection[]> {
    return listSharedConnectionsAll(this.apiClient, options);
  }

  /**
   * Async iterator over every shared connection, walking pages automatically.
   *
   * ```ts
   * for await (const conn of timbal.integrations.shared.iterate()) {
   *   console.log(conn.integration_provider, conn.status);
   * }
   * ```
   */
  iterate(options?: SharedConnectionListOptions): AsyncIterable<SharedConnection> {
    return iterateSharedConnections(this.apiClient, options);
  }

  /**
   * Look up the shared connection for a given provider. Walks pages and
   * early-exits on the first match. Returns `null` when no shared connection
   * exists for that provider in this org.
   */
  async byProvider(
    provider: string,
    options?: SharedConnectionListOptions,
  ): Promise<SharedConnection | null> {
    for await (const conn of this.iterate(options)) {
      if (conn.integration_provider === provider) return conn;
    }
    return null;
  }
}
