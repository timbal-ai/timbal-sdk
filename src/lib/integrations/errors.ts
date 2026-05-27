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
