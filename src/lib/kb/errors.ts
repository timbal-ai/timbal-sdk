import { TimbalApiError } from '../api';

/**
 * Thrown when a KB file lookup or deletion fails because the file does not exist (HTTP 404).
 *
 * Extends {@link TimbalApiError} — `instanceof TimbalApiError` still matches. Lets consumers
 * branch on the typed error instead of sniffing `statusCode === 404`.
 */
export class KbFileNotFoundError extends TimbalApiError {
  public readonly kbId: string;
  public readonly fileId: string;

  constructor(
    message: string,
    kbId: string,
    fileId: string,
    statusCode: number,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message, statusCode, code, details);
    this.name = 'KbFileNotFoundError';
    this.kbId = kbId;
    this.fileId = fileId;
  }
}

/**
 * Thrown when uploading a KB file conflicts with an existing file (HTTP 409).
 * Typically a filename collision under the same `directory`.
 *
 * Extends {@link TimbalApiError}. Consumers can use this for cron idempotency:
 * catch it and treat the upload as a no-op.
 */
export class KbFileAlreadyExistsError extends TimbalApiError {
  public readonly kbId: string;
  public readonly filename: string;
  public readonly directory: string | null;

  constructor(
    message: string,
    kbId: string,
    filename: string,
    directory: string | null,
    statusCode: number,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message, statusCode, code, details);
    this.name = 'KbFileAlreadyExistsError';
    this.kbId = kbId;
    this.filename = filename;
    this.directory = directory;
  }
}
