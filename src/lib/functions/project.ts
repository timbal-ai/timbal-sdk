import type { ApiClient } from '../api';
import type { Project, PlatformContext } from '../../types';
import { coerceProject, type RawProject } from '../coerce';

// Backend used to ship `apps`; current contract is `workforce`. Accept both.
type RawProjectResponse = Omit<RawProject, 'workforce'> & {
  workforce?: RawProject['workforce'];
  apps?: RawProject['workforce'];
};

/**
 * Get project details.
 *
 * @param client - The API client instance.
 * @param ctx - Optional overrides for orgId and projectId. Falls back to client config / env vars.
 * @returns The project object.
 *
 * @example
 * const project = await getProject(client)
 * const project = await getProject(client, { orgId: "10", projectId: "230" })
 */
export async function getProject(
  client: ApiClient,
  ctx?: PlatformContext,
): Promise<Project> {
  const config = client.getConfig();
  const orgId = ctx?.orgId || config.orgId;
  const projectId = ctx?.projectId || config.projectId;

  if (!orgId) throw new Error('orgId is required. Provide it in ctx, client config, or set TIMBAL_ORG_ID env var.');
  if (!projectId) throw new Error('projectId is required. Provide it in ctx, client config, or set TIMBAL_PROJECT_ID env var.');

  const response = await client.get<RawProjectResponse>(`orgs/${orgId}/projects/${projectId}`);
  const data = response.data;

  return coerceProject({
    ...data,
    workforce: data.workforce ?? data.apps ?? [],
  });
}
