import type { ApiClient } from '../api';
import { IntegrationConsentRequiredError } from './errors';
import type {
  PersonalConsentOptions,
  PersonalConsentResponse,
  PersonalTokenVend,
  PersonalUseResult,
} from '../../types';
import {
  vendPersonalToken,
  startPersonalConsent,
} from '../functions/integrations';

/**
 * A typed, scoped view onto a single personal integration row.
 *
 * Construct via `timbal.integrations.personal.get(id)` (preferred) or
 * `new PersonalConnectionRef(apiClient, id)` directly. **Synchronous, no
 * network call** — just binds `apiClient` + `integrationId`.
 *
 * Stateless beyond its `integrationId` and the shared `apiClient`. Cheap
 * to allocate per call.
 */
export class PersonalConnectionRef {
  constructor(
    public readonly apiClient: ApiClient,
    public readonly integrationId: string,
  ) {}

  /**
   * Vend the caller's token for this connection.
   *
   * @throws {IntegrationConsentRequiredError} on HTTP 401 `consent_required`
   *   — caller hasn't connected or their refresh token went bad. Prefer
   *   {@link use} when you want a tagged-union return instead of a throw.
   */
  token(): Promise<PersonalTokenVend> {
    return vendPersonalToken(this.apiClient, this.integrationId);
  }

  /**
   * Start an OAuth consent flow and return the provider's authorize URL.
   * Send the user's browser to `redirect_url`. After the round-trip they
   * land on `opts.redirect_uri`; re-call {@link token} to pick up the
   * vended token.
   *
   * `opts.redirect_uri` must be allowlisted by the platform
   * (`*.timbal.ai`, org custom domains, or `localhost`).
   */
  consent(opts: PersonalConsentOptions): Promise<PersonalConsentResponse> {
    return startPersonalConsent(this.apiClient, this.integrationId, opts);
  }

  /**
   * One-shot helper for UI flows: "give me the token, or tell me where to
   * send the user".
   *
   * Tries {@link token} first; on `IntegrationConsentRequiredError`, calls
   * {@link consent} with the provided `redirect_uri` and returns the
   * browser URL the user should be redirected to.
   *
   * Returns a tagged union — no exceptions for the not-connected case:
   * - `{ connected: true,  token }`             — happy path
   * - `{ connected: false, redirect_url }`      — send browser to `redirect_url`
   *
   * Other failures (server 5xx, network, etc.) still throw.
   */
  async use(opts: PersonalConsentOptions): Promise<PersonalUseResult> {
    try {
      const token = await this.token();
      return { connected: true, token };
    } catch (err) {
      if (err instanceof IntegrationConsentRequiredError) {
        const { redirect_url } = await this.consent(opts);
        return { connected: false, redirect_url };
      }
      throw err;
    }
  }
}
