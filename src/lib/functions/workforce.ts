import { readdir, readFile } from 'fs/promises';
import { resolve, join } from 'path';
import type { ApiClient } from '../api';
import type { WorkforceContext, WorkforceItem, PlatformConfig } from '../../types';

// ── Internal types ──

interface Deployment {
  domain: string;
  target?: { manifest_id?: string };
  [key: string]: unknown;
}

// ── Context resolution ──

function resolveContext(ctx?: WorkforceContext): { orgId: string; projectId: string; projectEnvId?: string } {
  const orgId = ctx?.orgId ?? process.env.TIMBAL_ORG_ID;
  const projectId = ctx?.projectId ?? process.env.TIMBAL_PROJECT_ID;
  const projectEnvId = ctx?.projectEnvId ?? (process.env.TIMBAL_PROJECT_ENV_ID || undefined);

  if (!orgId) throw new Error('orgId is required. Provide it in context or set TIMBAL_ORG_ID env var.');
  if (!projectId) throw new Error('projectId is required. Provide it in context or set TIMBAL_PROJECT_ID env var.');

  return { orgId, projectId, projectEnvId };
}

// ── Deployment resolution (internal) ──

const deploymentCache = new Map<string, Deployment>();

function parseWorkforceEnv(): Map<string, number> {
  const raw = process.env.TIMBAL_START_WORKFORCE ?? process.env.TIMBAL_WORKFORCE;
  if (!raw) return new Map();
  const map = new Map<string, number>();
  for (const entry of raw.split(',')) {
    const [id, port] = entry.split(':');
    if (id && port) map.set(id, Number(port));
  }
  return map;
}

function buildPlatformConfig(client: ApiClient): PlatformConfig {
  const config = client.getConfig();
  const baseUrl = config.baseUrl.replace(/^https?:\/\//, '');
  return {
    host: baseUrl,
    auth: {
      type: 'bearer',
      token: config.apiKey || config.authToken,
    },
  };
}

async function resolveRemoteDeployment(
  client: ApiClient,
  orgId: string,
  projectId: string,
  projectEnvId: string | undefined,
  manifestId: string
): Promise<Deployment | null> {
  const cacheKey = `${orgId}:${projectId}:${manifestId}`;
  const cached = deploymentCache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await client.get<{ deployments: Deployment[] }>(
      `orgs/${orgId}/projects/${projectId}/deployments`,
      {
        status: 'running',
        project_env_id: projectEnvId,
        manifest_id: manifestId,
      }
    );

    const deployment = (response.data.deployments ?? [])[0];
    if (!deployment?.domain) return null;

    deploymentCache.set(cacheKey, deployment);
    return deployment;
  } catch {
    return null;
  }
}

function resolveLocalDeployment(manifestId: string): string | null {
  const workforceMap = parseWorkforceEnv();
  const port = workforceMap.get(manifestId);
  return port ? `http://localhost:${port}` : null;
}

async function resolveEndpoint(
  client: ApiClient,
  orgId: string,
  projectId: string,
  projectEnvId: string | undefined,
  manifestId: string,
  path: string
): Promise<string | null> {
  if (!projectEnvId) {
    const base = resolveLocalDeployment(manifestId);
    return base ? `${base}${path}` : null;
  }

  const deployment = await resolveRemoteDeployment(client, orgId, projectId, projectEnvId, manifestId);
  return deployment ? `https://${deployment.domain}${path}` : null;
}

function injectPlatformConfig(
  payload: Record<string, unknown>,
  client: ApiClient,
  projectEnvId: string | undefined,
  platformConfig?: PlatformConfig
): Record<string, unknown> {
  if (!projectEnvId) return payload;

  const config = platformConfig ?? buildPlatformConfig(client);
  const existingContext = (payload.context && typeof payload.context === 'object') ? payload.context : {};
  return {
    ...payload,
    context: {
      ...existingContext,
      platform_config: config,
    },
  };
}

async function listWorkforcesFromManifests(workforceDir?: string): Promise<WorkforceItem[]> {
  const dir = workforceDir ?? join(process.cwd(), 'workforce');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: WorkforceItem[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const yaml = await readFile(resolve(dir, entry.name, 'timbal.yaml'), 'utf-8');
        const match = yaml.match(/_id:\s*"([^"]+)"/);
        if (match?.[1]) results.push({ id: match[1] });
      } catch {
        // no timbal.yaml — skip
      }
    }

    return results;
  } catch {
    return [];
  }
}

// ── Public functions ──

/**
 * List all running workforce components for a project.
 *
 * In remote mode (when `projectEnvId` is set), queries the Timbal API for running deployments.
 * In local mode, reads `timbal.yaml` manifests from the workforce directory on disk.
 * Context fields fall back to env vars: TIMBAL_ORG_ID, TIMBAL_PROJECT_ID, TIMBAL_PROJECT_ENV_ID.
 *
 * @param client - The API client instance.
 * @param ctx - Optional workforce context overrides.
 * @param workforceDir - Override the local workforce directory. Defaults to `<cwd>/workforce`.
 * @returns A list of workforce items, each containing a manifest ID.
 *
 * @example
 * // Context from env vars
 * const workforces = await listWorkforces(client)
 *
 * // Explicit context
 * const workforces = await listWorkforces(client, {
 *   orgId: "10", projectId: "5", projectEnvId: "env-1"
 * })
 */
export async function listWorkforces(
  client: ApiClient,
  ctx?: WorkforceContext,
  workforceDir?: string
): Promise<WorkforceItem[]> {
  const { orgId, projectId, projectEnvId } = resolveContext(ctx);

  if (!projectEnvId) {
    return listWorkforcesFromManifests(workforceDir);
  }

  try {
    const response = await client.get<{ deployments: Deployment[] }>(
      `orgs/${orgId}/projects/${projectId}/deployments`,
      {
        status: 'running',
        project_env_id: projectEnvId,
      }
    );

    const deployments = response.data.deployments ?? [];
    const seen = new Set<string>();
    const results: WorkforceItem[] = [];

    for (const d of deployments) {
      const id = d.target?.manifest_id;
      if (id && !seen.has(id)) {
        seen.add(id);
        results.push({ id });
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Call a workforce component and return the full response.
 *
 * Resolves the deployment for the given manifest ID, then POSTs to its `/run` endpoint.
 * In remote mode, platform credentials are automatically injected into the request context.
 * In local mode, resolves via `TIMBAL_START_WORKFORCE` env var and skips credential injection.
 * Context fields fall back to env vars: TIMBAL_ORG_ID, TIMBAL_PROJECT_ID, TIMBAL_PROJECT_ENV_ID.
 *
 * @param client - The API client instance.
 * @param manifestId - The manifest ID of the workforce component to call.
 * @param input - The request payload to send to the workforce component.
 * @param ctx - Optional workforce context overrides.
 * @param platformConfig - Override the auto-injected platform config.
 * @returns The raw fetch Response. The caller can read JSON, pipe the body, etc.
 *
 * @example
 * // Context from env vars
 * const response = await callWorkforce(client, "my-agent", { message: "Hello!" })
 *
 * // Explicit context
 * const response = await callWorkforce(client, "my-agent", { message: "Hello!" }, {
 *   orgId: "10", projectId: "5", projectEnvId: "env-1"
 * })
 */
export async function callWorkforce(
  client: ApiClient,
  manifestId: string,
  input: Record<string, unknown> = {},
  ctx?: WorkforceContext,
  platformConfig?: PlatformConfig
): Promise<Response> {
  const { orgId, projectId, projectEnvId } = resolveContext(ctx);
  const url = await resolveEndpoint(client, orgId, projectId, projectEnvId, manifestId, '/run');
  if (!url) {
    throw new Error(`Could not resolve workforce deployment for manifest: ${manifestId}`);
  }

  const payload = injectPlatformConfig(input, client, projectEnvId, platformConfig);

  return fetch(url, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * Stream events from a workforce component via Server-Sent Events (SSE).
 *
 * Resolves the deployment for the given manifest ID, then POSTs to its `/stream` endpoint.
 * Platform credentials are automatically injected in remote mode, same as `callWorkforce`.
 * Context fields fall back to env vars: TIMBAL_ORG_ID, TIMBAL_PROJECT_ID, TIMBAL_PROJECT_ENV_ID.
 *
 * @param client - The API client instance.
 * @param manifestId - The manifest ID of the workforce component to stream from.
 * @param input - The request payload to send to the workforce component.
 * @param ctx - Optional workforce context overrides.
 * @param platformConfig - Override the auto-injected platform config.
 * @returns The raw fetch Response. Use `response.body` to read the SSE stream.
 *
 * @example
 * // Context from env vars
 * const response = await streamWorkforce(client, "my-agent", { message: "Hello!" })
 *
 * // Pipe through in an API handler
 * return new Response(response.body, {
 *   headers: { "Content-Type": "text/event-stream" }
 * })
 */
export async function streamWorkforce(
  client: ApiClient,
  manifestId: string,
  input: Record<string, unknown> = {},
  ctx?: WorkforceContext,
  platformConfig?: PlatformConfig
): Promise<Response> {
  const { orgId, projectId, projectEnvId } = resolveContext(ctx);
  const url = await resolveEndpoint(client, orgId, projectId, projectEnvId, manifestId, '/stream');
  if (!url) {
    throw new Error(`Could not resolve workforce deployment for manifest: ${manifestId}`);
  }

  const payload = injectPlatformConfig(input, client, projectEnvId, platformConfig);

  return fetch(url, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * Clear the deployment cache.
 *
 * Deployments are cached after first resolution to avoid repeated API calls.
 * Call this when deployments change (e.g., after a new deploy) to force re-resolution.
 */
export function clearDeploymentCache(): void {
  deploymentCache.clear();
}
