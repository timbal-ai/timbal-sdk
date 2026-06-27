import { TimbalApiError } from '../api';

/**
 * Thrown when the backend rejects an enable / lookup because the provider
 * is not in the platform catalog (HTTP 404, server code `NOT_FOUND`).
 *
 * Extends {@link TimbalApiError} — `instanceof TimbalApiError` still matches.
 * Lets consumers branch on the typed error instead of sniffing
 * `statusCode === 404` or pattern-matching the message.
 */
export class IntegrationNotFoundError extends TimbalApiError {
  public readonly provider: string;

  constructor(
    message: string,
    provider: string,
    statusCode: number,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message, statusCode, code, details);
    this.name = 'IntegrationNotFoundError';
    this.provider = provider;
  }
}

/**
 * Thrown when vending a personal token requires the caller to (re)consent —
 * either they never connected, the access token expired and refresh failed,
 * or they revoked the connection upstream.
 *
 * Wire shape (HTTP 401):
 * ```json
 * { "error": "consent_required",
 *   "consent_url": "https://api.timbal.ai/orgs/{org}/integrations/{id}/consent" }
 * ```
 *
 * `consentUrl` is the **API endpoint** to POST to next — not a browser link.
 * Prefer calling `personal.get(id).consent({ redirect_uri })` (or
 * `personal.get(id).use({...})` / `personal.connect(provider, {...})`) over
 * hand-rolling against this URL; the SDK already knows the path.
 */
export class IntegrationConsentRequiredError extends TimbalApiError {
  public readonly integrationId: string;
  public readonly consentUrl: string;

  constructor(
    message: string,
    integrationId: string,
    consentUrl: string,
    statusCode: number,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message, statusCode, code, details);
    this.name = 'IntegrationConsentRequiredError';
    this.integrationId = integrationId;
    this.consentUrl = consentUrl;
  }
}

/**
 * Thrown when a tool-proxy execution can't run because the platform has no
 * usable connection for the tool's provider (HTTP 403, or 404/501 fallbacks).
 *
 * This is the execution-plane counterpart to the credential-plane errors above:
 * the recovery path lives in `timbal.integrations` — enable the provider in the
 * catalog and connect it (`integrations.catalog.enable(provider)` then
 * `integrations.personal.connect(provider, …)` / `integrations.shared.connect*`).
 *
 * Extends {@link TimbalApiError}, so `instanceof TimbalApiError` still matches.
 */
export class ToolProxyUnavailableError extends TimbalApiError {
  /** Wire name of the tool that couldn't be proxied (e.g. `krea_generate_image`). */
  public readonly toolName: string;
  /** Provider backing the tool, when known — the thing to connect in `integrations`. */
  public readonly provider?: string;

  constructor(
    message: string,
    toolName: string,
    statusCode: number,
    provider?: string,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message, statusCode, code, details);
    this.name = 'ToolProxyUnavailableError';
    this.toolName = toolName;
    this.provider = provider;
  }
}
