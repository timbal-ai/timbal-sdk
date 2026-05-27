import type { ApiClient } from '../api';
import { IntegrationsCatalog } from './catalog';
import { SharedConnectionsSection } from './shared';
import { PersonalConnectionsSection } from './personal';

/**
 * Integrations accessor — reached via `timbal.integrations`.
 *
 * Three sub-accessors so the catalog vs. connections distinction is
 * impossible to confuse and shared vs. personal connections are never
 * collapsed into one type:
 *
 * - `timbal.integrations.catalog` — what providers the org may use
 *   (admin-facing; `enable` / `disable`).
 * - `timbal.integrations.shared` — org-wide connections wired up centrally;
 *   all callers vend the same token.
 * - `timbal.integrations.personal` — per-caller-token connections; each
 *   caller sees their own row + state.
 *
 * Each accessor is a lazy singleton on the section, and the section itself
 * is a lazy singleton on the `Timbal` instance.
 */
export class IntegrationsSection {
  private _catalog?: IntegrationsCatalog;
  private _shared?: SharedConnectionsSection;
  private _personal?: PersonalConnectionsSection;

  constructor(private readonly apiClient: ApiClient) {}

  /**
   * Org catalog (`GET /integrations?org_id={id}` +
   * `POST /orgs/{org}/integrations/{enable,disable}`).
   */
  get catalog(): IntegrationsCatalog {
    if (!this._catalog) this._catalog = new IntegrationsCatalog(this.apiClient);
    return this._catalog;
  }

  /**
   * Org-wide connections. Returns {@link SharedConnection} rows — no `user`
   * field; all callers vend the same token.
   */
  get shared(): SharedConnectionsSection {
    if (!this._shared) this._shared = new SharedConnectionsSection(this.apiClient);
    return this._shared;
  }

  /**
   * Per-caller-token connections. Returns {@link PersonalConnection} rows —
   * each carries a `user` field describing the caller's connection state.
   */
  get personal(): PersonalConnectionsSection {
    if (!this._personal) this._personal = new PersonalConnectionsSection(this.apiClient);
    return this._personal;
  }
}
