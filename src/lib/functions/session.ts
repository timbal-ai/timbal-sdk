import type { ApiClient } from '../api';
import type { Session, Project } from '../../types';
import { coerceProject, type RawProject } from '../coerce';

// `me` may return either `workforce` or `apps` historically.
type RawProjectResponse = Omit<RawProject, 'workforce'> & {
  workforce?: RawProject['workforce'];
  apps?: RawProject['workforce'];
};

type RawSession = Omit<Session, 'user_id'> & { user_id: string | number };

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
  const response = await client.get<{ session: RawSession; project?: RawProjectResponse }>(url);

  const session: Session = {
    ...response.data.session,
    user_id: String(response.data.session.user_id),
  };

  if (opts?.projectId != null) {
    const rawProject = response.data.project!;
    return {
      session,
      project: coerceProject({
        ...rawProject,
        workforce: rawProject.workforce ?? rawProject.apps ?? [],
      }),
    };
  }

  return session;
}
