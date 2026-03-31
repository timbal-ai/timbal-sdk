import type { ApiClient } from '../api';
import type { QueryResult, QueryOptions } from '../../types';

/**
 * Execute a SQL query against a knowledge base table (PostgreSQL dialect).
 *
 * @param client - The API client instance.
 * @param sql - The SQL query to execute. Must be valid PostgreSQL SQL.
 * @param params - Optional parameters for parameterized queries.
 * @param options - Optional overrides for orgId and kbId. Falls back to client config / env vars.
 * @returns The query results as a list of dictionaries, where each dictionary represents a row.
 *
 * @example
 * await query(client, 'SELECT COUNT(*) FROM "Documents"')
 * await query(client, 'SELECT 1', [], { orgId: "10", kbId: "48" })
 */
export async function query(
  client: ApiClient,
  sql: string,
  params: unknown[] = [],
  options?: QueryOptions
): Promise<QueryResult[]> {
  const config = client.getConfig();
  const orgId = options?.orgId || config.orgId;
  const kbId = options?.kbId || config.kbId;

  if (!orgId) throw new Error('orgId is required. Provide it in options, client config, or set TIMBAL_ORG_ID env var.');
  if (!kbId) throw new Error('kbId is required. Provide it in options, client config, or set TIMBAL_KB_ID env var.');

  const path = options?.legacy
    ? `orgs/${orgId}/kbs/${kbId}/query`
    : `orgs/${orgId}/k2/${kbId}/query`;
  const response = await client.post<QueryResult[]>(path, { sql, params });
  return response.data;
}
