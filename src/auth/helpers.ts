/**
 * Determine the origin of the request for constructing callback URLs.
 * Handles Timbal Studio multi-tenant setup, forwarded headers, and localhost.
 */
export function getOrigin(request: Request): string {
  const studioSlug = process.env.TIMBAL_STUDIO;
  if (studioSlug) {
    const baseUrl =
      process.env.TIMBAL_BASE_URL ||
      (process.env.TIMBAL_API_HOST
        ? `https://${process.env.TIMBAL_API_HOST}`
        : 'https://api.timbal.ai');
    const isDev = baseUrl.includes('dev.');
    const domain = isDev
      ? `${studioSlug}.projects.dev.timbal.ai`
      : `${studioSlug}.projects.timbal.ai`;
    return `https://${domain}`;
  }

  const forwardedProto = request.headers.get('x-forwarded-proto');
  const forwardedHost = request.headers.get('x-forwarded-host');

  const url = new URL(request.url);
  const protocol = forwardedProto || url.protocol.replace(':', '');
  const host = forwardedHost || url.host;

  const hostname = host.split(':')[0];
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
  const finalProtocol =
    protocol === 'http' && !isLocalhost ? 'https' : protocol;

  return `${finalProtocol}://${host}`;
}

/**
 * Build the OAuth callback URL from the request origin and path prefix.
 */
export function getCallbackUrl(request: Request, path: string): string {
  const origin = getOrigin(request);
  const prefix = path.startsWith('/api') ? '/api' : '';
  return `${origin}${prefix}/auth/callback`;
}

/**
 * Extract the route prefix from a path ("/api" or "").
 */
export function getPrefix(path: string): string {
  return path.startsWith('/api') ? '/api' : '';
}

/**
 * Same-origin relative path safe for post-login redirects (blocks open redirects).
 */
export function isSafeRedirectPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  if (path.includes('\\')) return false;
  const slash = path.indexOf('/');
  const colon = path.indexOf(':');
  if (colon !== -1 && (slash === -1 || colon < slash)) return false;
  return true;
}

/**
 * Pick a post-login destination: validated `return_to`, else configured fallback.
 */
export function resolvePostLoginRedirect(
  returnTo: string | undefined | null,
  fallback: string,
): string {
  if (returnTo && isSafeRedirectPath(returnTo)) return returnTo;
  return fallback.startsWith('/') ? fallback : `/${fallback}`;
}
