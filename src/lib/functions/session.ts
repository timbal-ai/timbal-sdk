import type { ApiClient } from '../api';
import type { Session } from '../../types';

/**
 * Get the authenticated session for the current client credentials.
 *
 * Calls the platform `/me` endpoint to validate the token and return session data.
 * Throws if the token is invalid or expired.
 *
 * @param client - The API client instance (must have valid auth credentials).
 * @returns The session object containing user profile and access level.
 *
 * @example
 * const client = timbal.as({ authToken: requestToken })
 * const session = await getSession(client)
 * console.log(session.user_email) // "user@example.com"
 * console.log(session.access_level) // "admin"
 */
export async function getSession(client: ApiClient): Promise<Session> {
  const response = await client.get<{ session: Session }>('me');
  const session = response.data.session;
  session.user_id = String(session.user_id);
  return session;
}
