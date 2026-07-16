/**
 * Public-origin resolution for webhook provisioning.
 *
 * Channels need a public https URL to deliver webhooks to. Where it comes
 * from differs by environment: production knows its origin (config/env),
 * local dev usually has a tunnel (ngrok) in front of localhost. The
 * resolution order — explicit > `PUBLIC_ORIGIN` env > detected dev tunnel —
 * lives here so every app gets the same behavior without copy-pasting it.
 */

/**
 * Discover the public https URL of a locally running ngrok tunnel via its
 * inspection API (`http://127.0.0.1:4040`). Returns `null` when no tunnel is
 * running — the probe fails fast (1.5s timeout) and never throws.
 *
 * Dev-time convenience only: callers should gate this behind "not deployed"
 * (see {@link resolvePublicOrigin}) so a production process never registers
 * webhooks against a stray local tunnel.
 */
export async function detectNgrokOrigin(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl('http://127.0.0.1:4040/api/tunnels', {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      tunnels?: { public_url?: string; proto?: string }[];
    };
    return (
      data.tunnels?.find((t) => t.proto === 'https' && t.public_url)
        ?.public_url ?? null
    );
  } catch {
    return null;
  }
}

export interface ResolvePublicOriginOptions {
  /** Explicit origin — always wins when provided. */
  origin?: string;
  /** Environment source (injectable for tests). @default process.env */
  env?: Record<string, string | undefined>;
  /** Fetch used for the tunnel probe (injectable for tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Resolve the public origin webhooks should be registered against:
 *
 * 1. explicit `origin` option
 * 2. `PUBLIC_ORIGIN` env var
 * 3. a running ngrok tunnel — **local dev only**: skipped when the app is
 *    platform-linked (`TIMBAL_PROJECT_ID` set), because a deployed process
 *    must never silently point provider webhooks at a developer's tunnel.
 *
 * Returns `null` when nothing resolves; callers decide whether that's a
 * warning (dev) or an error (prod).
 */
export async function resolvePublicOrigin(
  options: ResolvePublicOriginOptions = {},
): Promise<string | null> {
  if (options.origin) return options.origin;
  const env = options.env ?? process.env;
  if (env.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN;
  if (env.TIMBAL_PROJECT_ID) return null;
  return detectNgrokOrigin(options.fetchImpl);
}
