import type { ApiClient } from '../api';
import type { QueryResult, QueryRow, QueryOptions } from '../../types';

/**
 * Execute a SQL query against a knowledge base table (PostgreSQL dialect).
 *
 * @param client - The API client instance.
 * @param sql - The SQL query to execute. Must be valid PostgreSQL SQL.
 * @param params - Optional parameters for parameterized queries.
 * @param options - Optional overrides for orgId and kbId. Falls back to client config / env vars.
 * @returns A QueryResult object containing a rows array, where each row is a dictionary.
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
): Promise<QueryResult> {
  const config = client.getConfig();
  const orgId = options?.orgId || config.orgId;
  const kbId = options?.kbId || config.kbId;

  if (!orgId) throw new Error('orgId is required. Provide it in options, client config, or set TIMBAL_ORG_ID env var.');
  if (!kbId) throw new Error('kbId is required. Provide it in options, client config, or set TIMBAL_KB_ID env var.');

  const body: Record<string, unknown> = { sql, params };
  if (options?.explain) body.explain = true;

  if (options?.legacy) {
    const path = `orgs/${orgId}/kbs/${kbId}/query`;
    const response = await client.post<QueryRow[]>(path, body);
    return { rows: response.data };
  }

  const path = `orgs/${orgId}/k2/${kbId}/query`;
  const response = await client.post<QueryResult>(path, body);
  return response.data;
}
