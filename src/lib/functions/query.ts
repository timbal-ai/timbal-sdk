import type { ApiClient } from '../api';
import type { QueryResult, QueryOptions } from '../../types';

function resolveOrgId(options?: QueryOptions): string {
  const orgId = options?.orgId ?? process.env.TIMBAL_ORG_ID;
  if (!orgId) throw new Error('orgId is required. Provide it in options or set TIMBAL_ORG_ID env var.');
  return orgId;
}

function resolveKbId(options?: QueryOptions): string {
  const kbId = options?.kbId ?? process.env.TIMBAL_KB_ID;
  if (!kbId) throw new Error('kbId is required. Provide it in options or set TIMBAL_KB_ID env var.');
  return kbId;
}

/**
 * Execute a SQL query against a knowledge base table (PostgreSQL dialect).
 *
 * @param client - The API client instance.
 * @param sql - The SQL query to execute. Must be valid PostgreSQL SQL.
 * @param params - Optional parameters for parameterized queries.
 * @param options - Optional overrides for orgId and kbId. Falls back to TIMBAL_ORG_ID and TIMBAL_KB_ID env vars.
 * @returns The query results as a list of dictionaries, where each dictionary represents a row.
 *
 * Notes:
 * - SQL syntax must follow PostgreSQL conventions.
 * - Table and column names are case sensitive. If your identifiers use uppercase or mixed case,
 *   you must escape them with double quotes (e.g., "Documents", "FileName").
 * - Unescaped identifiers are automatically lowercased by PostgreSQL.
 *
 * @example
 * // Simple query (orgId/kbId from env)
 * await query(client, 'SELECT COUNT(*) FROM "Documents"')
 *
 * // Parameterized query
 * await query(client,
 *   'INSERT INTO "Documents" (id::uuid, name) VALUES ($1, $2) RETURNING *',
 *   [1, "example.txt"]
 * )
 *
 * // Explicit orgId/kbId
 * await query(client, 'SELECT 1', [], { orgId: "10", kbId: "48" })
 */
export async function query(
  client: ApiClient,
  sql: string,
  params: unknown[] = [],
  options?: QueryOptions
): Promise<QueryResult[]> {
  const orgId = resolveOrgId(options);
  const kbId = resolveKbId(options);
  const path = `orgs/${orgId}/kbs/${kbId}/query`;
  const response = await client.post<QueryResult[]>(path, { sql, params });
  return response.data;
}
