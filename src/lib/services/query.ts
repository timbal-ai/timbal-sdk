import type { ApiClient } from '../api';

export interface QueryOptions {
  orgId?: string;
  kbId?: string;
  sql?: string;
}

export interface QueryResult {
  [key: string]: any;
}

export class QueryService {
  private defaultOrgId?: string;
  private defaultKbId?: string;
  private defaultSql?: string;

  constructor(
    private apiClient: ApiClient,
    defaults: QueryOptions = {}
  ) {
    this.defaultOrgId = defaults.orgId;
    this.defaultKbId = defaults.kbId;
    this.defaultSql = defaults.sql;
  }

  /**
   * Execute a SQL query against a knowledge base table (PostgreSQL dialect).
   *
   * @param orgId The organization ID.
   * @param kbId The knowledge base ID.
   * @param sql The SQL query to execute. This must be valid PostgreSQL SQL.
   * @returns The query results as a list of dictionaries, where each dictionary represents a row.
   *
   * Notes:
   * - SQL syntax must follow PostgreSQL conventions.
   * - Table and column names are case sensitive. If your identifiers use uppercase or mixed case,
   *   you must escape them with double quotes (e.g., "Documents", "FileName").
   * - Unescaped identifiers are automatically lowercased by PostgreSQL.
   *
   * Example:
   * ```typescript
   * // Count all the documents in the table
   * const result = await queryService.query({
   *   orgId: "10",
   *   kbId: "48",
   *   sql: 'SELECT COUNT(*) FROM "Documents"'
   * });
   * ```
   */
  async query(options: { orgId?: string; kbId?: string; sql?: string }): Promise<QueryResult[]> {
    const orgId = this.resolveDefault('orgId', options.orgId);
    const kbId = this.resolveDefault('kbId', options.kbId);
    const sql = this.resolveDefault('sql', options.sql);

    if (!orgId) {
      throw new Error('orgId is required. Provide it in the method call or set a default.');
    }
    if (!kbId) {
      throw new Error('kbId is required. Provide it in the method call or set a default.');
    }
    if (!sql) {
      throw new Error('sql is required. Provide it in the method call or set a default.');
    }

    const path = `orgs/${orgId}/kbs/${kbId}/query`;
    const payload = { sql };

    const response = await this.apiClient.post<QueryResult[]>(path, payload);
    return response.data;
  }

  /**
   * Convenience method for querying with positional parameters
   */
  async queryByParams(orgId: string, kbId: string, sql: string): Promise<QueryResult[]> {
    return this.query({ orgId, kbId, sql });
  }

  /**
   * Set default values for future queries
   */
  setDefaults(defaults: QueryOptions): void {
    if (defaults.orgId !== undefined) this.defaultOrgId = defaults.orgId;
    if (defaults.kbId !== undefined) this.defaultKbId = defaults.kbId;
    if (defaults.sql !== undefined) this.defaultSql = defaults.sql;
  }

  /**
   * Get current default values
   */
  getDefaults(): QueryOptions {
    return {
      orgId: this.defaultOrgId,
      kbId: this.defaultKbId,
      sql: this.defaultSql,
    };
  }

  private resolveDefault(key: keyof QueryOptions, value?: string): string | undefined {
    if (value !== undefined) return value;

    switch (key) {
      case 'orgId':
        return this.defaultOrgId;
      case 'kbId':
        return this.defaultKbId;
      case 'sql':
        return this.defaultSql;
      default:
        return undefined;
    }
  }
}
