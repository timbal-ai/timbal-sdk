import type { ApiClient } from '../api';
import type { Project, WorkforcePreview } from '../../types';

interface RawProject extends Omit<Project, 'workforce'> {
  workforce?: WorkforcePreview[];
  apps?: WorkforcePreview[];
}

/**
 * Get project details.
 *
 * @param client - The API client instance.
 * @param orgId - Organization ID. Falls back to TIMBAL_ORG_ID env var.
 * @param projectId - Project ID. Falls back to TIMBAL_PROJECT_ID env var.
 * @returns The project object.
 *
 * @example
 * const project = await getProject(client)
 * console.log(project.name)
 * console.log(project.workforce)
 */
export async function getProject(
  client: ApiClient,
  orgId?: string,
  projectId?: string,
): Promise<Project> {
  const org = orgId ?? process.env.TIMBAL_ORG_ID;
  const project = projectId ?? process.env.TIMBAL_PROJECT_ID;

  if (!org) throw new Error('orgId is required. Provide it as an argument or set TIMBAL_ORG_ID env var.');
  if (!project) throw new Error('projectId is required. Provide it as an argument or set TIMBAL_PROJECT_ID env var.');

  const response = await client.get<RawProject>(`orgs/${org}/projects/${project}`);
  const data = response.data;

  return {
    id: data.id,
    name: data.name,
    description: data.description,
    has_ui: data.has_ui,
    role: data.role,
    default_role: data.default_role,
    is_public_template: data.is_public_template,
    template_uses: data.template_uses,
    publishable_api_key: data.publishable_api_key,
    use_platform_iam: data.use_platform_iam,
    repository_url: data.repository_url,
    screenshot_url: data.screenshot_url,
    created_at: data.created_at,
    updated_at: data.updated_at,
    workforce: data.workforce ?? data.apps ?? [],
  };
}
