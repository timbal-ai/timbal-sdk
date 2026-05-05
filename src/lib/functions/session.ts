import type { ApiClient } from '../api';
import type { Session, Project, WorkforcePreview } from '../../types';

interface RawProject extends Omit<Project, 'workforce'> {
  workforce?: WorkforcePreview[];
  apps?: WorkforcePreview[];
}

function normalizeProject(raw: RawProject): Project {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    has_ui: raw.has_ui,
    role: raw.role,
    default_role: raw.default_role,
    is_public_template: raw.is_public_template,
    template_uses: raw.template_uses,
    publishable_api_key: raw.publishable_api_key,
    use_platform_iam: raw.use_platform_iam,
    repository_url: raw.repository_url,
    screenshot_url: raw.screenshot_url,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    workforce: raw.workforce ?? raw.apps ?? [],
  };
}

export async function getSession(client: ApiClient): Promise<Session>;
export async function getSession(
  client: ApiClient,
  opts: { projectId: string | number },
): Promise<{ session: Session; project: Project }>;
export async function getSession(
  client: ApiClient,
  opts?: { projectId?: string | number },
): Promise<Session | { session: Session; project: Project }> {
  const url = opts?.projectId != null ? `me?project_id=${opts.projectId}` : 'me';
  const response = await client.get<{ session: Session; project?: RawProject }>(url);

  const session = response.data.session;
  session.user_id = String(session.user_id);

  if (opts?.projectId != null) {
    return { session, project: normalizeProject(response.data.project!) };
  }

  return session;
}
