import type { ApiClient } from '../api';
import { IntegrationsCatalog } from './catalog';

/**
 * Integrations accessor — reached via `timbal.integrations`.
 *
 * Mirrors the platform's two-layer model:
 *
 * - `timbal.integrations.catalog` — what providers the org may use
 *   (admin-facing; the only layer implemented in this pass).
 * - Per-user / per-org **connections** (consent, vending tokens) — not yet
 *   surfaced here. They will land on this same section without breaking the
 *   catalog API.
 *
 * Lazy singleton on this `Timbal` instance — same instance returned on every
 * access. Catalog accessor is also a lazy singleton on the section.
 */
export class IntegrationsSection {
  private _catalog?: IntegrationsCatalog;

  constructor(private readonly apiClient: ApiClient) {}

  /**
   * Org catalog accessor (`GET /integrations?org_id={id}` +
   * `POST /orgs/{org}/integrations/enable`).
   */
  get catalog(): IntegrationsCatalog {
    if (!this._catalog) this._catalog = new IntegrationsCatalog(this.apiClient);
    return this._catalog;
  }
}
