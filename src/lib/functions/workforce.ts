import type { ApiClient } from '../api';
import type { PlatformContext, WorkforceItem } from '../../types';
import { coerceWorkforceItem, type RawWorkforceItem } from '../coerce';

function nodeRequire(id: string): any { try { return require(id); } catch { return null; } }

// ── Context resolution ──

export interface ResolvedContext {
  orgId?: string;
  projectId?: string;
  rev: string;
}

export function resolveContext(client: ApiClient, ctx?: PlatformContext): ResolvedContext {
  const config = client.getConfig();
  return {
    orgId: ctx?.orgId || config.orgId || undefined,
    projectId: ctx?.projectId || config.projectId || undefined,
    rev: ctx?.rev || config.rev || 'main',
  };
}

export function requireRemoteContext(resolved: ResolvedContext): { orgId: string; projectId: string; rev: string } {
  if (!resolved.orgId) throw new Error('orgId is required. Provide it in context or set TIMBAL_ORG_ID env var.');
  if (!resolved.projectId) throw new Error('projectId is required. Provide it in context or set TIMBAL_PROJECT_ID env var.');
  return { orgId: resolved.orgId, projectId: resolved.projectId, rev: resolved.rev };
}

// ── Environment detection ──

export function isLocalEnvironment(): boolean {
  return !!(process.env.TIMBAL_START_WORKFORCE ?? process.env.TIMBAL_WORKFORCE);
}

export function isStudioEnvironment(): boolean {
  return !!process.env.TIMBAL_STUDIO;
}

// ── Local workforce helpers ──

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

export function resolveLocalDeployment(manifestId: string): string | null {
  const workforceMap = parseWorkforceEnv();
  const port = workforceMap.get(manifestId);
  return port ? `http://localhost:${port}` : null;
}

export async function resolveLocalWorkforceItem(identifier: string): Promise<WorkforceItem> {
  const items = await listLocalWorkforces();
  const found = items.find(w => w.uid === identifier || w.name === identifier || w.id === identifier);
  return found ?? { uid: identifier, name: identifier, id: identifier };
}

export async function scanTimbalYamls(rootDir: string): Promise<Map<string, { name: string; type?: string }>> {
  const result = new Map<string, { name: string; type?: string }>();
  try {
    const glob = new Bun.Glob('**/timbal.yaml');
    for await (const file of glob.scan({ cwd: rootDir, onlyFiles: true })) {
      if (file.includes('node_modules/') || file.startsWith('.') || file.includes('/.')) continue;
      try {
        const content = await Bun.file(`${rootDir}/${file}`).text();
        const idMatch = content.match(/^_id:\s*["']?([^"'\n]+?)["']?\s*$/m);
        const typeMatch = content.match(/^_type:\s*["']?([^"'\n]+?)["']?\s*$/m);
        if (!idMatch || !idMatch[1]) continue;
        const parts = file.split('/');
        const name = parts[parts.length - 2];
        if (name) result.set(idMatch[1], { name, type: typeMatch?.[1] });
      } catch { /* skip unreadable */ }
    }
  } catch { /* glob unavailable or root unreadable */ }
  return result;
}

function findTimbalRoot(startDir: string): string {
  const fs = nodeRequire('node:fs');
  const path = nodeRequire('node:path');
  if (!fs || !path) return startDir;

  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(`${dir}/workforce`)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

export async function listLocalWorkforces(rootDir?: string): Promise<WorkforceItem[]> {
  const workforceMap = parseWorkforceEnv();
  const effectiveRoot = rootDir ?? findTimbalRoot(process.cwd());
  const yamlMap = await scanTimbalYamls(effectiveRoot);
  return Array.from(workforceMap.keys()).map(uid => {
    const info = yamlMap.get(uid);
    return { uid, ...(info?.name && { name: info.name }), ...(info?.type && { type: info.type }) };
  });
}

// ── Remote helpers ──

/**
 * List responses cached per `orgId:projectId:rev` so successive callWorkforce/
 * streamWorkforce calls don't each trigger a list round-trip.
 * Invalidate with `clearWorkforceCache()` when you deploy new code mid-session.
 */
const workforceListCache = new Map<string, WorkforceItem[]>();

export function clearWorkforceCache(): void {
  workforceListCache.clear();
}

/**
 * Resolve a workforce identifier to its `WorkforceItem` (id, uid, name, type,
 * url, …). Public wrapper over `resolveWorkforceItem` that handles env detection
 * (studio / local / remote) and context resolution. Goes through the same
 * `workforceListCache` as `call` / `stream`, so calling `info()` before `call()`
 * is a free warm-up.
 *
 * - **Studio** (`TIMBAL_STUDIO`): remote resolve via `GET /orgs/{org}/projects/
 *   {proj}/workforce?rev=...`. Studio takes precedence over local — same order
 *   used by `call` / `stream` so `info()` always reveals the deployment they
 *   will actually hit.
 * - **Local** (`TIMBAL_START_WORKFORCE` / `TIMBAL_WORKFORCE`): scans
 *   `timbal.yaml` manifests on disk. Returns a synthetic `{ uid, name, id }`
 *   if not found.
 * - **Remote** (default): hits the workforce list endpoint (cached) and finds
 *   the matching component by id / uid / name.
 */
export async function getWorkforceItem(
  client: ApiClient,
  identifier: string,
  ctx?: PlatformContext,
): Promise<WorkforceItem> {
  // Studio first to match callWorkforce / streamWorkforce precedence. Studio
  // uses the same remote resolve path as remote — only pure-local mode
  // (no studio) goes through the on-disk YAML scan.
  if (isLocalEnvironment() && !isStudioEnvironment()) {
    return resolveLocalWorkforceItem(identifier);
  }
  const resolved = resolveContext(client, ctx);
  const { orgId, projectId, rev } = requireRemoteContext(resolved);
  return resolveWorkforceItem(client, orgId, projectId, rev, identifier);
}

async function resolveWorkforceItem(
  client: ApiClient,
  orgId: string,
  projectId: string,
  rev: string,
  identifier: string,
): Promise<WorkforceItem> {
  const cacheKey = `${orgId}:${projectId}:${rev}`;

  const findInList = (items: WorkforceItem[]): WorkforceItem | undefined =>
    items.find(w => w.id === identifier || w.uid === identifier || w.name === identifier);

  let items = workforceListCache.get(cacheKey);
  let item = items ? findInList(items) : undefined;

  // Cache miss, or cached list predates a newly-registered component → refresh.
  if (!item) {
    const response = await client.get<{ workforce: RawWorkforceItem[] }>(
      `orgs/${orgId}/projects/${projectId}/workforce`,
      { rev },
    );
    items = (response.data.workforce ?? []).map(coerceWorkforceItem);
    workforceListCache.set(cacheKey, items);
    item = findInList(items);
  }

  if (!item) {
    throw new Error(`Workforce component not found for identifier "${identifier}" on rev "${rev}"`);
  }
  return item;
}

function appendPathToUrl(url: string, path: string): string {
  const u = new URL(url);
  const cleanPath = path.replace(/^\//, '');
  if (!cleanPath) return url;
  u.pathname = `${u.pathname.replace(/\/$/, '')}/${cleanPath}`;
  return u.toString();
}

async function resolveWorkforceEndpoint(
  client: ApiClient,
  orgId: string,
  projectId: string,
  rev: string,
  identifier: string,
  path: string,
): Promise<string> {
  const item = await resolveWorkforceItem(client, orgId, projectId, rev, identifier);
  if (!item.url) {
    throw new Error(`No running deployment for workforce "${identifier}" on rev "${rev}"`);
  }
  return appendPathToUrl(item.url, path);
}

function postWorkforce(client: ApiClient, url: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${client.getConfig().token}`,
    },
    body: JSON.stringify(payload),
  });
}

function injectParentId(
  payload: Record<string, unknown>,
  parentId?: string,
): Record<string, unknown> {
  if (!parentId) return payload;
  const existingContext = (payload.context && typeof payload.context === 'object') ? payload.context : {};
  return {
    ...payload,
    context: {
      ...existingContext,
      parent_id: parentId,
    },
  };
}

// ── Studio helpers ──

function buildStudioUrl(client: ApiClient, resolved: ResolvedContext): string {
  const { orgId, projectId } = requireRemoteContext(resolved);
  const config = client.getConfig();
  const baseUrl = config.baseUrl.replace(/\/$/, '');
  return `${baseUrl}/orgs/${orgId}/projects/${projectId}/git/codegen`;
}

interface StudioPayloadOptions {
  stream?: boolean;
  rev: string;
  parentId?: string;
}

function buildStudioPayload(
  workforceName: string,
  input: Record<string, unknown>,
  options: StudioPayloadOptions,
): Record<string, unknown> {
  const args: Record<string, unknown> = { input };
  if (options.stream) args.stream = true;
  if (options.parentId) args.context = { parent_id: options.parentId };

  return {
    rev: options.rev,
    workforce: workforceName,
    command: 'test',
    args,
  };
}

// ── Public functions ──

/**
 * List workforce components for a project.
 *
 * In remote mode, queries `GET /orgs/{orgId}/projects/{projectId}/workforce?rev={rev}`.
 * Items include a `url` when a running deployment exists on the given branch.
 * In local mode, reads `timbal.yaml` manifests from the workforce directory on disk.
 * Context fields fall back to env vars: TIMBAL_ORG_ID, TIMBAL_PROJECT_ID, TIMBAL_PROJECT_REV.
 */
export async function listWorkforces(
  client: ApiClient,
  ctx?: PlatformContext,
): Promise<WorkforceItem[]> {
  if (isLocalEnvironment()) {
    return listLocalWorkforces();
  }

  const resolved = resolveContext(client, ctx);
  const { orgId, projectId, rev } = requireRemoteContext(resolved);
  const response = await client.get<{ workforce: RawWorkforceItem[] }>(
    `orgs/${orgId}/projects/${projectId}/workforce`,
    { rev },
  );
  const items = (response.data.workforce ?? []).map(coerceWorkforceItem);
  workforceListCache.set(`${orgId}:${projectId}:${rev}`, items);
  return items;
}

/**
 * Call a workforce component and return the full response.
 *
 * In remote mode, POSTs to `/orgs/{orgId}/projects/{projectId}/workforce/{identifier}/run?rev={rev}`.
 * In local mode, resolves via `TIMBAL_START_WORKFORCE` env var.
 * In studio mode (`TIMBAL_STUDIO`), routes through the codegen endpoint with the same rev.
 * Context fields fall back to env vars: TIMBAL_ORG_ID, TIMBAL_PROJECT_ID, TIMBAL_PROJECT_REV.
 */
export async function callWorkforce(
  client: ApiClient,
  identifier: string,
  input: Record<string, unknown> = {},
  ctx?: PlatformContext,
): Promise<Response> {
  const resolved = resolveContext(client, ctx);

  if (isStudioEnvironment()) {
    const { orgId, projectId, rev } = requireRemoteContext(resolved);
    const item = await resolveWorkforceItem(client, orgId, projectId, rev, identifier);
    const url = buildStudioUrl(client, resolved);
    const payload = buildStudioPayload(item.name!, input, { rev, parentId: ctx?.parentId });
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${client.getConfig().token}`,
      },
      body: JSON.stringify(payload),
    });
  }

  if (isLocalEnvironment()) {
    const item = await resolveLocalWorkforceItem(identifier);
    const key = item.uid ?? item.name ?? item.id;
    const base = key ? resolveLocalDeployment(key) : null;
    if (!base) throw new Error(`Could not resolve local workforce for: ${identifier}`);
    const payload = injectParentId(input, ctx?.parentId);
    return fetch(`${base}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  const { orgId, projectId, rev } = requireRemoteContext(resolved);
  const url = await resolveWorkforceEndpoint(client, orgId, projectId, rev, identifier, 'run');
  const payload = injectParentId(input, ctx?.parentId);
  return postWorkforce(client, url, payload);
}

/**
 * Stream events from a workforce component via Server-Sent Events (SSE).
 *
 * In remote mode, POSTs to `/orgs/{orgId}/projects/{projectId}/workforce/{identifier}/stream?rev={rev}`.
 * In local mode, resolves via `TIMBAL_START_WORKFORCE` env var.
 * In studio mode (`TIMBAL_STUDIO`), routes through the codegen endpoint with the same rev.
 * Context fields fall back to env vars: TIMBAL_ORG_ID, TIMBAL_PROJECT_ID, TIMBAL_PROJECT_REV.
 */
export async function streamWorkforce(
  client: ApiClient,
  identifier: string,
  input: Record<string, unknown> = {},
  ctx?: PlatformContext,
): Promise<Response> {
  const resolved = resolveContext(client, ctx);

  if (isStudioEnvironment()) {
    const { orgId, projectId, rev } = requireRemoteContext(resolved);
    const item = await resolveWorkforceItem(client, orgId, projectId, rev, identifier);
    const url = buildStudioUrl(client, resolved);
    const payload = buildStudioPayload(item.name!, input, { rev, stream: true, parentId: ctx?.parentId });
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${client.getConfig().token}`,
      },
      body: JSON.stringify(payload),
    });
  }

  if (isLocalEnvironment()) {
    const item = await resolveLocalWorkforceItem(identifier);
    const key = item.uid ?? item.name ?? item.id;
    const base = key ? resolveLocalDeployment(key) : null;
    if (!base) throw new Error(`Could not resolve local workforce for: ${identifier}`);
    const payload = injectParentId(input, ctx?.parentId);
    return fetch(`${base}/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  const { orgId, projectId, rev } = requireRemoteContext(resolved);
  const url = await resolveWorkforceEndpoint(client, orgId, projectId, rev, identifier, 'stream');
  const payload = injectParentId(input, ctx?.parentId);
  return postWorkforce(client, url, payload);
}
