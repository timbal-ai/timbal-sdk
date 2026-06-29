import { Elysia, t } from 'elysia';
import type { Timbal } from '../lib/timbal';
import type { OAuthProvider } from '../types';
import type { ProjectAuthConfig, TimbalAuthOptions } from '../auth/types';
import {
  getCallbackUrl,
  getPrefix,
  resolvePostLoginRedirect,
} from '../auth/helpers';
import { renderLoginPage } from '../auth/templates/login';
import { renderCallbackPage } from '../auth/templates/callback';
import { setAuthCookie, clearAuthCookie } from './middleware';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAuthRoutes(
  timbal: Timbal,
  options: TimbalAuthOptions = {},
): any {
  const afterLoginRedirect = options.afterLoginRedirect ?? '/';

  const routes = new Elysia({ prefix: '/auth' });

  // Only mount login/callback pages if not disabled
  if (options.loginPage !== false) {
    routes
      .get(
        '/login',
        async (ctx) => {
        const { path, redirect, query } = ctx;
        // `token` and `authConfig` are injected at runtime by the global auth
        // middleware derive; not visible on this standalone instance's type.
        const { token, authConfig } = ctx as unknown as {
          token: string | null;
          authConfig: ProjectAuthConfig | null;
        };
        if (token) {
          return redirect(
            resolvePostLoginRedirect(query.return_to, afterLoginRedirect),
          );
        }

        // Open project (platform mode): there is no login page.
        if (authConfig && !authConfig.enabled) {
          return new Response('Not Found', { status: 404 });
        }

        const prefix = getPrefix(path);

        // Custom HTML file (cannot be provider-filtered — passed through as-is)
        if (typeof options.loginPage === 'string') {
          const html = await Bun.file(options.loginPage).text();
          return new Response(html.replaceAll('{{PREFIX}}', prefix), {
            headers: { 'Content-Type': 'text/html' },
          });
        }

        // Default built-in page. In platform mode, hide disabled providers;
        // legacy/fallback (authConfig null) renders all (= today).
        return new Response(
          renderLoginPage(
            prefix,
            authConfig ? { providers: authConfig.providers } : undefined,
          ),
          { headers: { 'Content-Type': 'text/html' } },
        );
        },
        {
          query: t.Object({
            return_to: t.Optional(t.String()),
            error: t.Optional(t.String()),
            redirect_uri: t.Optional(t.String()),
          }),
          detail: { hide: true },
        },
      )
      .get(
        '/callback',
        ({ path }) => {
          const prefix = getPrefix(path);
          return new Response(renderCallbackPage(prefix, afterLoginRedirect), {
            headers: { 'Content-Type': 'text/html' },
          });
        },
        { detail: { hide: true } },
      )
      .post(
        '/callback',
        ({ path }) => {
          const prefix = getPrefix(path);
          return new Response(renderCallbackPage(prefix, afterLoginRedirect), {
            headers: { 'Content-Type': 'text/html' },
          });
        },
        { detail: { hide: true } },
      );
  }

  routes
    .get(
      '/:provider',
      (ctx) => {
        const { params, redirect, request, path, query } = ctx;
        const { authConfig } = ctx as unknown as {
          authConfig: ProjectAuthConfig | null;
        };
        const { provider } = params;
        const validProviders: OAuthProvider[] = ['github', 'google', 'microsoft'];
        if (!validProviders.includes(provider as OAuthProvider)) {
          return new Response('Invalid provider', { status: 400 });
        }
        // Platform mode: reject providers disabled in the project config
        // (server-side, not just hidden on the login page). An open project
        // has no login at all, so every provider is rejected.
        if (
          authConfig &&
          (!authConfig.enabled ||
            !authConfig.providers.includes(provider as OAuthProvider))
        ) {
          return new Response('Provider not enabled', { status: 400 });
        }
        const callbackUrl = query.redirect_uri || getCallbackUrl(request, path);
        return redirect(
          timbal.getOAuthUrl(provider as OAuthProvider, callbackUrl),
        );
      },
      {
        params: t.Object({ provider: t.String() }),
        query: t.Object({ redirect_uri: t.Optional(t.String()) }),
        detail: { hide: true },
      },
    )
    .post(
      '/set-token',
      async ({ body, cookie }) => {
        try {
          const session = await timbal.as(body.access_token).getSession();
          // Set cookie for browser navigations (docs, api-spec)
          setAuthCookie(cookie, body.access_token);
          return { success: true, user: session };
        } catch {
          return new Response(JSON.stringify({ error: 'Invalid token' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
      {
        body: t.Object({ access_token: t.String() }),
        detail: { hide: true },
      },
    )
    .post(
      '/magic-link',
      async (ctx) => {
        const { body, request, path } = ctx;
        const { authConfig } = ctx as unknown as {
          authConfig: ProjectAuthConfig | null;
        };
        // Platform mode: reject email login when disabled (or open project).
        if (
          authConfig &&
          (!authConfig.enabled || !authConfig.providers.includes('email'))
        ) {
          return new Response(
            JSON.stringify({ error: 'Email login not enabled' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        try {
          await timbal.sendMagicLink(body.email, getCallbackUrl(request, path));
          return {
            success: true,
            message: 'Check your email for the login link',
          };
        } catch (err) {
          const message =
            err instanceof Error ? err.message : 'Failed to send magic link';
          return new Response(JSON.stringify({ error: message }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
      {
        body: t.Object({ email: t.String() }),
        detail: { hide: true },
      },
    )
    .post(
      '/refresh',
      async ({ body, cookie }) => {
        try {
          const tokens = await timbal.refreshToken(body.refresh_token);
          setAuthCookie(cookie, tokens.access_token);
          return {
            success: true,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || body.refresh_token,
          };
        } catch {
          clearAuthCookie(cookie);
          return new Response(JSON.stringify({ error: 'Refresh failed' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
      {
        body: t.Object({ refresh_token: t.String() }),
        detail: { hide: true },
      },
    )
    .post(
      '/logout',
      ({ cookie }) => {
        clearAuthCookie(cookie);
        return { success: true };
      },
      { detail: { hide: true } },
    );

  return routes;
}
