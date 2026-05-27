import type { ApiClient } from '../api';
import type {
  SharedConnectCredentialsOptions,
  SharedConnectOAuthOptions,
  SharedConnectOAuthResult,
  SharedConnection,
  SharedConnectionListOptions,
  SharedConnectionPage,
} from '../../types';
import {
  connectShared,
  iterateSharedConnections,
  listSharedConnections,
  listSharedConnectionsAll,
  listSharedConnectionsPage,
} from '../functions/integrations';
import { TimbalApiError } from '../api';
import { SharedConnectionRef } from './shared-connection-ref';

/**
 * Org-wide ("shared") integration connections — reached via
 * `timbal.integrations.shared`.
 *
 * Each row models a provider the org wired up centrally (one shared OAuth or
 * credentials connection). Every caller in the org vends the same token from
 * the same row. Compare with {@link PersonalConnectionsSection} for
 * per-caller-token rows.
 *
 * Stripe-style collection ops plus a resource view via {@link get} for
 * token vending and connect sugar ({@link connectOAuth} /
 * {@link connectCredentials}). Disconnect will land later — for now
 * use {@link IntegrationsCatalog.disable} to drop a provider org-wide.
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

  /**
   * Get a scoped view onto a specific shared connection row.
   * **Synchronous, no network call** — wraps `apiClient` + `integrationId`.
   *
   * ```ts
   * const ref = timbal.integrations.shared.get('10');
   * const v = await ref.token();
   * if (v.type === 'oauth') await callSlack(v.token);
   * ```
   */
  get(integrationId: string): SharedConnectionRef {
    return new SharedConnectionRef(this.apiClient, integrationId);
  }

  /**
   * Start an OAuth connect flow for a shared connection. Returns the
   * provider's authorize URL — send the user's browser there. After they
   * complete OAuth and Timbal's `/oauth/callback/integrations` runs, the
   * row appears in {@link list}. **No id is returned here** — connect
   * doesn't create the row until callback completes.
   *
   * `redirect_uri` defaults server-side to
   * `https://app.timbal.ai/org/{org_id}/integrations` when omitted.
   * Allowlist applies (`*.timbal.ai`, org custom domains, `localhost`).
   *
   * Some providers need upfront knobs via `oauth_params`:
   * ```ts
   * await shared.connectOAuth({
   *   provider: 'shopify',
   *   oauth_params: { shop_url: 'acme.myshopify.com' },
   * });
   * ```
   *
   * For org reconnect (token expired, refresh dead) call this again with
   * the same provider — there's no per-row consent flow for shared rows.
   */
  async connectOAuth(opts: SharedConnectOAuthOptions): Promise<SharedConnectOAuthResult> {
    const result = await connectShared(this.apiClient, { auth_type: 'oauth', ...opts });
    if (result.result !== 'oauth_redirect') {
      throw new TimbalApiError(
        `Expected oauth_redirect result for OAuth connect, got "${result.result}"`,
        500,
      );
    }
    return result;
  }

  /**
   * Synchronously create a shared connection from a static credentials
   * blob (api keys, etc.). Returns a {@link SharedConnectionRef} bound to
   * the freshly-created row id — vend immediately, no browser step.
   *
   * `credentials` shape is provider-specific (commonly `{ api_key }`).
   *
   * ```ts
   * const ref = await shared.connectCredentials({
   *   provider: 'stripe',
   *   label: 'Prod API key',
   *   credentials: { api_key: process.env.STRIPE_KEY! },
   * });
   * const v = await ref.token();
   * ```
   */
  async connectCredentials(opts: SharedConnectCredentialsOptions): Promise<SharedConnectionRef> {
    const result = await connectShared(this.apiClient, { auth_type: 'credentials', ...opts });
    if (result.result !== 'created') {
      throw new TimbalApiError(
        `Expected created result for credentials connect, got "${result.result}"`,
        500,
      );
    }
    return this.get(result.org_integration_id);
  }
}
