import type { ApiClient } from '../api';
import type { KbQueryOptions, QueryResult, TableSchema } from '../../types';
import { query as queryFn } from '../functions/query';
import { getKbSchema } from '../functions/kb';
import { KbFilesSection } from './files-section';

/**
 * A typed, scoped view onto a single Knowledge Base.
 *
 * Construct via `timbal.kbs.get(kbId)` (preferred) or `new KB(apiClient, kbId)`
 * directly (escape hatch — commits `ApiClient` as part of the public API surface).
 *
 * `KB` is stateless beyond its `kbId` and the shared `apiClient`. Allocating new
 * views per call is cheap; the platform's auth/refresh/retry/error handling lives
 * on the shared `ApiClient`, not duplicated per view.
 */
export class KB {
  private _files?: KbFilesSection;

  constructor(
    public readonly apiClient: ApiClient,
    public readonly kbId: string,
  ) {}

  /**
   * Execute SQL against this KB. Mirrors `timbal.query()` semantics with `kbId`
   * bound to the view.
   *
   * - `{ legacy: true }` routes to the legacy `/kbs/{kbId}/query` path
   *   (returns array, wrapped into `{ rows }`). Defaults to the K2 endpoint.
   * - `{ explain: true }` runs `EXPLAIN ANALYZE` and includes the plan in the
   *   response.
   */
  query(
    sql: string,
    params?: unknown[],
    options?: KbQueryOptions,
  ): Promise<QueryResult> {
    return queryFn(this.apiClient, sql, params, {
      kbId: this.kbId,
      legacy: options?.legacy,
      explain: options?.explain,
    });
  }

  /**
   * Fetch the KB's table schema (`GET /k2/{kb}/schema`).
   */
  schema(): Promise<TableSchema[]> {
    return getKbSchema(this.apiClient, this.kbId);
  }

  /**
   * Files in this KB. Lazy singleton — same instance returned on every access.
   */
  get files(): KbFilesSection {
    if (!this._files) this._files = new KbFilesSection(this.apiClient, this.kbId);
    return this._files;
  }
}
