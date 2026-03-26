/**
 * Configuration options for the timbalAuth() plugin.
 */
export interface TimbalAuthOptions {
  /**
   * Login page configuration.
   * - omit or `undefined`: use the built-in Timbal login page
   * - `string`: path to a custom HTML file (served with Bun.file()).
   *   The file can use `{{PREFIX}}` as a placeholder for the route prefix.
   * - `false`: disable built-in login/callback pages entirely (handle yourself)
   */
  loginPage?: string | false;

  /** Where to redirect after successful login. Default: "/" */
  afterLoginRedirect?: string;

  /** Where to redirect after logout. Default: "/auth/login" */
  afterLogoutRedirect?: string;

  /** Additional paths that skip authentication (merged with defaults). */
  publicPaths?: string[];

  /** Cookie name for the access token. Default: "timbal_access_token" */
  cookieName?: string;

  /** Cookie max age in seconds. Default: 3600 (1 hour) */
  cookieMaxAge?: number;
}
