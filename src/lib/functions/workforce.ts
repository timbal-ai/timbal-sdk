import type { ApiClient } from '../api';
import type { PlatformSubject, WorkforceItem, PlatformConfig } from '../../types';

// ── Internal types ──

interface Deployment {
  domain: string;
  target?: { manifest_id?: string };
  [key: string]: unknown;
}

// ── Context resolution ──

function resolveContext(client: ApiClient, ctx?: PlatformSubject): { orgId?: string; projectId?: string; projectEnvId?: string } {
  const config = client.getConfig();
  const orgId = ctx?.orgId || config.orgId || undefined;
  const projectId = ctx?.projectId || config.projectId || undefined;
  const projectEnvId = ctx?.projectEnvId || config.projectEnvId || undefined;

  return { orgId, projectId, projectEnvId };
}

function requireRemoteContext(resolved: { orgId?: string; projectId?: string }): { orgId: string; projectId: string } {
  if (!resolved.orgId) throw new Error('orgId is required. Provide it in context or set TIMBAL_ORG_ID env var.');
  if (!resolved.projectId) throw new Error('projectId is required. Provide it in context or set TIMBAL_PROJECT_ID env var.');
  return { orgId: resolved.orgId, projectId: resolved.projectId };
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
      token: config.token,
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
  resolved: { orgId?: string; projectId?: string; projectEnvId?: string },
  manifestId: string,
  path: string
): Promise<string | null> {
  if (isLocalEnvironment()) {
    const base = resolveLocalDeployment(manifestId);
    return base ? `${base}${path}` : null;
  }

  const { orgId, projectId } = requireRemoteContext(resolved);
  const deployment = await resolveRemoteDeployment(client, orgId, projectId, resolved.projectEnvId, manifestId);
  return deployment ? `https://${deployment.domain}${path}` : null;
}

function injectPlatformConfig(
  payload: Record<string, unknown>,
  client: ApiClient,
  platformConfig?: PlatformConfig
): Record<string, unknown> {
  if (isLocalEnvironment()) return payload;

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

function isLocalEnvironment(): boolean {
  return !!(process.env.TIMBAL_START_WORKFORCE ?? process.env.TIMBAL_WORKFORCE);
}

function isStudioEnvironment(): boolean {
  return !!process.env.TIMBAL_STUDIO;
}

function buildStudioUrl(client: ApiClient, resolved: { orgId?: string; projectId?: string }): string {
  const { orgId, projectId } = requireRemoteContext(resolved);
  const config = client.getConfig();
  const baseUrl = config.baseUrl.endsWith('/') ? config.baseUrl.slice(0, -1) : config.baseUrl;
  return `${baseUrl}/orgs/${orgId}/projects/${projectId}/git/codegen`;
}

interface StudioPayloadOptions {
  stream?: boolean;
  platformConfig?: PlatformConfig | Record<string, unknown>;
  subject?: { org_id: string; app_id: string };
}

function buildStudioPayload(
  workforceName: string,
  input: Record<string, unknown>,
  options?: StudioPayloadOptions
): Record<string, unknown> {
  const args: Record<string, unknown> = { input };
  if (options?.stream) args.stream = true;

  const context: Record<string, unknown> = {};
  if (options?.platformConfig) {
    Object.assign(context, options.platformConfig);
  }
  if (options?.subject) {
    context.subject = options.subject;
  }
  if (Object.keys(context).length > 0) {
    args.context = context;
  }

  return {
    rev: process.env.TIMBAL_REV || 'main',
    workforce: workforceName,
    command: 'test',
    args,
  };
}



function listLocalWorkforces(): WorkforceItem[] {
  const workforceMap = parseWorkforceEnv();
  return Array.from(workforceMap.keys()).map(uid => ({ uid }));
}

// ── Workforce resolution ──

const workforceCache = new Map<string, WorkforceItem[]>();

async function fetchWorkforceItems(
  client: ApiClient,
  resolved: { orgId?: string; projectId?: string }
): Promise<WorkforceItem[]> {
  const { orgId, projectId } = requireRemoteContext(resolved);
  const cacheKey = `${orgId}:${projectId}`;
  const cached = workforceCache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await client.get<{ workforce?: WorkforceItem[]; apps?: WorkforceItem[] }>(
      `orgs/${orgId}/projects/${projectId}`
    );
    const rawItems = response.data.workforce ?? response.data.apps ?? [];
    const items = rawItems.map(item => ({
      id: item.id,
      uid: item.uid,
      type: item.type,
      name: item.name,
      description: item.description,
    }));
    workforceCache.set(cacheKey, items);
    return items;
  } catch {
    return [];
  }
}

function findWorkforceItem(items: WorkforceItem[], identifier: string): WorkforceItem | undefined {
  return items.find(w => w.uid === identifier || w.id === identifier || w.name === identifier);
}

async function resolveWorkforceItem(
  client: ApiClient,
  resolved: { orgId?: string; projectId?: string },
  identifier: string,
): Promise<WorkforceItem> {
  const items = await fetchWorkforceItems(client, resolved);
  const item = findWorkforceItem(items, identifier);
  if (!item) {
    throw new Error(`Could not resolve workforce for identifier: ${identifier}`);
  }
  return item;
}

async function resolveWorkforceIdentifier(
  client: ApiClient,
  resolved: { orgId?: string; projectId?: string },
  identifier: string,
): Promise<string> {
  if (isLocalEnvironment()) return identifier;

  const item = await resolveWorkforceItem(client, resolved, identifier);
  return item.id ?? item.uid ?? item.name ?? identifier;
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
  ctx?: PlatformSubject,
): Promise<WorkforceItem[]> {
  if (isLocalEnvironment()) {
    return listLocalWorkforces();
  }

  const resolved = resolveContext(client, ctx);
  return fetchWorkforceItems(client, resolved);
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
  identifier: string,
  input: Record<string, unknown> = {},
  ctx?: PlatformSubject,
  platformConfig?: PlatformConfig
): Promise<Response> {
  const resolved = resolveContext(client, ctx);

  if (isStudioEnvironment()) {
    const item = await resolveWorkforceItem(client, resolved, identifier);
    const { orgId } = requireRemoteContext(resolved);
    const url = buildStudioUrl(client, resolved);
    const payload = buildStudioPayload(item.name!, input, {
      platformConfig: platformConfig ?? buildPlatformConfig(client),
      subject: { org_id: orgId, app_id: item.id! },
    });
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${client.getConfig().token}`,
      },
      body: JSON.stringify(payload),
    });
  }

  const uid = await resolveWorkforceIdentifier(client, resolved, identifier);
  const url = await resolveEndpoint(client, resolved, uid, '/run');
  if (!url) {
    throw new Error(`Could not resolve workforce deployment for: ${identifier}`);
  }

  const payload = injectPlatformConfig(input, client, platformConfig);

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
  identifier: string,
  input: Record<string, unknown> = {},
  ctx?: PlatformSubject,
  platformConfig?: PlatformConfig
): Promise<Response> {
  const resolved = resolveContext(client, ctx);

  if (isStudioEnvironment()) {
    const item = await resolveWorkforceItem(client, resolved, identifier);
    const { orgId } = requireRemoteContext(resolved);
    const url = buildStudioUrl(client, resolved);
    const payload = buildStudioPayload(item.name!, input, {
      stream: true,
      platformConfig: platformConfig ?? buildPlatformConfig(client),
      subject: { org_id: orgId, app_id: item.id! },
    });
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${client.getConfig().token}`,
      },
      body: JSON.stringify(payload),
    });
  }

  const uid = await resolveWorkforceIdentifier(client, resolved, identifier);
  const url = await resolveEndpoint(client, resolved, uid, '/stream');
  if (!url) {
    throw new Error(`Could not resolve workforce deployment for: ${identifier}`);
  }

  const payload = injectPlatformConfig(input, client, platformConfig);

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
  workforceCache.clear();
}
