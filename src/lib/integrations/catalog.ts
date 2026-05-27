import type { ApiClient } from '../api';
import type {
  IntegrationCatalogEntry,
  IntegrationCatalogListOptions,
  IntegrationCatalogPage,
  IntegrationDisableResult,
  IntegrationEnableResult,
} from '../../types';
import {
  listIntegrationsCatalog,
  listIntegrationsCatalogPage,
  listIntegrationsCatalogAll,
  iterateIntegrationsCatalog,
  enableIntegration,
  disableIntegration,
} from '../functions/integrations';

/**
 * Org-scoped integration catalog — reached via `timbal.integrations.catalog`.
 *
 * Models the **what your org is allowed to use** layer:
 *
 * - `list()` / `listAll()` / `iterate()` / `listPage()` — same Stripe-style
 *   surface as `timbal.kbs`. Backend currently returns everything on one
 *   page, but the SDK threads `next_page_token` so a future paginated
 *   rollout is transparent.
 * - `enable(provider)` / `disable(provider)` — admin ops
 *   (`POST /orgs/{org}/integrations/{enable,disable}`). Idempotent on
 *   already-{enabled,disabled} providers; both throw
 *   {@link IntegrationNotFoundError} for unknown providers.
 * - `isEnabled(provider)` — sugar over `list()`.
 *
 * The **connections** layer (per-user OAuth tokens, vending, consent) is a
 * separate accessor that will land on `IntegrationsSection` later.
 */
export class IntegrationsCatalog {
  constructor(private readonly apiClient: ApiClient) {}

  /**
   * First page of the catalog (`GET /integrations?org_id={id}`).
   *
   * Today this returns every entry in a single page. When you want to be
   * forward-compat with pagination, use {@link listAll} or {@link iterate}.
   */
  list(options?: IntegrationCatalogListOptions): Promise<IntegrationCatalogEntry[]> {
    return listIntegrationsCatalog(this.apiClient, options);
  }

  /**
   * List the catalog with full pagination metadata
   * (`{ integrations, next_page_token? }`).
   */
  listPage(options?: IntegrationCatalogListOptions): Promise<IntegrationCatalogPage> {
    return listIntegrationsCatalogPage(this.apiClient, options);
  }

  /**
   * Drain every page of the catalog into one array.
   *
   * Sugar over {@link iterate}. Prefer `iterate()` if the catalog grows large
   * enough that you don't want it all in memory.
   */
  listAll(options?: IntegrationCatalogListOptions): Promise<IntegrationCatalogEntry[]> {
    return listIntegrationsCatalogAll(this.apiClient, options);
  }

  /**
   * Async iterator over every catalog entry, walking pages automatically.
   *
   * ```ts
   * for await (const entry of timbal.integrations.catalog.iterate()) {
   *   console.log(entry.provider, entry.enabled);
   * }
   * ```
   */
  iterate(options?: IntegrationCatalogListOptions): AsyncIterable<IntegrationCatalogEntry> {
    return iterateIntegrationsCatalog(this.apiClient, options);
  }

  /**
   * Enable a provider for the org. Idempotent on already-enabled providers.
   *
   * @throws {IntegrationNotFoundError} when the provider is not in the
   *   platform catalog (HTTP 404).
   */
  enable(provider: string): Promise<IntegrationEnableResult> {
    return enableIntegration(this.apiClient, provider);
  }

  /**
   * Disable a provider for the org. Idempotent on already-disabled providers.
   *
   * Per the platform's visibility rules, disabling hides the user-mode shell
   * row from `list()` for users who never connected, but leaves rows
   * belonging to users who *did* connect intact (so they keep vending tokens
   * until they explicitly disconnect).
   *
   * @throws {IntegrationNotFoundError} when the provider is not in the
   *   platform catalog (HTTP 404).
   */
  disable(provider: string): Promise<IntegrationDisableResult> {
    return disableIntegration(this.apiClient, provider);
  }

  /**
   * Returns `true` if `provider` is in the catalog **and** enabled for this
   * org. Returns `false` for disabled or unknown providers.
   *
   * One-shot helper over `list()` — walks every page to be correct even when
   * pagination eventually ships.
   */
  async isEnabled(provider: string, options?: IntegrationCatalogListOptions): Promise<boolean> {
    for await (const entry of this.iterate(options)) {
      if (entry.provider === provider) return entry.enabled;
    }
    return false;
  }
}
