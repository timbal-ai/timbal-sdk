import type { AuthProvider } from '../types';

// Canonical definition lives in core `../types` (so `Project.auth_providers` can
// reference it without depending on the auth submodule). Re-exported here for
// ergonomic imports from the auth surface.
export type { AuthProvider };

/** Auth resolution strategy for the timbalAuth() plugin. */
export type AuthMode = 'legacy' | 'platform';

/**
 * A single SSO connection (one IdP).
 *
 * Intentionally protocol-agnostic: SAML vs OIDC is the platform's concern,
 * hidden behind the initiation `url`. The SDK/UI only ever redirects the
 * browser to `url` (or `/auth/sso/:id`) and lets the platform run the dance;
 * the user returns to `/auth/callback` with a token regardless of protocol.
 */
export interface SsoConnection {
  /** Stable slug — routes via `/auth/sso/:id`. */
  id: string;
  /** Human label, e.g. "Acme Corp". */
  label: string;
  /** Metadata only (icons/debug). MUST NOT branch auth behavior. */
  protocol?: 'oidc' | 'saml';
  /** Initiation endpoint. Omit for IdP-initiated SAML (fixed ACS callback). */
  url?: string;
}

/**
 * Resolved auth configuration for a project.
 *
 * Source of truth is the platform (`auth_enabled` + provider settings).
 * Maps from `Project` via `authConfigFromProject()`.
 */
export interface ProjectAuthConfig {
  /** Whether end users must log in. Maps to `Project.auth_enabled`. */
  enabled: boolean;
  /** Login options to surface. Defaults to all when the platform omits them. */
  providers: AuthProvider[];
  /**
   * SSO connections (zero or more IdPs). Server-side only — see
   * `PublicAppConfig` for why this list is NOT exposed to the browser.
   */
  sso?: SsoConnection[];
}

/**
 * Public, browser-safe app configuration served by `GET /config`.
 *
 * MUST NOT contain secrets, API keys, platform credentials, or anything that
 * leaks tenant identity (e.g. the list of enterprise SSO connections — that
 * would expose customer names to anyone hitting the endpoint).
 */
export interface PublicAppConfig {
  project: { id: string; name?: string };
  auth: {
    required: boolean;
    providers: AuthProvider[];
    /**
     * SSO availability only — never the connection list. When `discovery` is
     * `'email'`, the UI shows an email box and POSTs it; the server resolves
     * the matching IdP (home-realm discovery) without leaking the full list.
     */
    sso?: {
      enabled: boolean;
      discovery?: 'email';
    };
  };
}

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

  /** Additional paths that skip authentication (merged with defaults). */
  publicPaths?: string[];

  // ── New (additive, all optional). Inert until platform mode ships. ──

  /**
   * Auth resolution strategy.
   * - `'legacy'` (default): preserves today's `isLocalDev()` + project-id
   *   semantics exactly. No platform auth-config fetch.
   * - `'platform'`: platform config (`auth_enabled` + providers) is the
   *   source of truth; enables open + authenticated modes.
   *
   * @default 'legacy'
   */
  authMode?: AuthMode;

  /**
   * Override the platform auth config (tests, local dev). When set, the plugin
   * does not fetch from the platform.
   */
  authConfig?: ProjectAuthConfig;

  /**
   * TTL for the cached platform auth config, in milliseconds.
   * @default 60000
   */
  authConfigCacheTtlMs?: number;

  /**
   * Mount `GET /config` (public `PublicAppConfig`).
   * - `true` → mount at `/config`
   * - `string` → mount at the given path
   * - `false` → do not mount
   *
   * @default true when `authMode === 'platform'`
   */
  configRoute?: boolean | string;

  /**
   * Mount `POST /__timbal/config/refresh` — the platform cache-invalidation
   * endpoint (auth config + channel bindings, plus any registered refresh
   * hooks). SDK infrastructure: apps almost never need to opt out. The
   * standalone `timbalConfigRefresh()` plugin remains for hosts that skip
   * `timbalAuth`.
   *
   * @default true
   */
  configRefresh?: boolean;
}
