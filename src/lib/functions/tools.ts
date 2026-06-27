import type { ApiClient } from '../api';
import { TimbalApiError } from '../api';
import {
  IntegrationConsentRequiredError,
  ToolProxyUnavailableError,
} from '../integrations/errors';
import { PROXY_TOOLS_PREFIX, SDK_VERSION } from '../../constants';
import type {
  RawToolManifest,
  RemoteToolDetail,
  RemoteToolSpec,
  ToolRunOptions,
} from '../../types';

function resolveOrg(client: ApiClient, orgId?: string): string {
  const id = orgId || client.getConfig().orgId;
  if (!id) {
    throw new Error(
      'orgId is required. Provide it in client config or set TIMBAL_ORG_ID env var.',
    );
  }
  return id;
}

/**
 * Build the per-request attribution headers for tool-proxy calls. Mirrors the
 * Python SDK's `build_tool_proxy_headers` (run/call/subject/version), adapted
 * to the TS client (subject comes from client config, not a run context).
 */
function buildProxyHeaders(client: ApiClient, opts?: ToolRunOptions): Record<string, string> {
  const cfg = client.getConfig();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-timbal-version': SDK_VERSION,
    // Required by the platform proxy (mirrors the Python run_context.id). Auto-
    // generated per call when the caller doesn't supply one; pass `runId` to
    // correlate multiple tool calls to the same run/trace.
    'x-timbal-run-id': opts?.runId ?? crypto.randomUUID(),
  };
  if (cfg.projectId) headers['x-timbal-project-id'] = cfg.projectId;
  if (cfg.rev) headers['x-timbal-rev'] = cfg.rev;
  if (opts?.callId) headers['x-timbal-call-id'] = opts.callId;
  if (opts?.connectionId) headers['x-timbal-integration-id'] = opts.connectionId;
  return headers;
}

/**
 * Execute a framework tool via the platform proxy
 * (`POST /orgs/{org}/proxies/v1/tools/{name}`). Params go up as the JSON body;
 * the platform resolves the provider connection, injects credentials, runs the
 * handler, and returns its raw JSON result (no envelope) — credentials never
 * reach this runtime.
 *
 * Built on {@link ApiClient.fetch} (the raw escape hatch) **on purpose**:
 * - no auto-retry — tool execution is non-idempotent (a retried
 *   `krea_generate_image` would double-charge);
 * - no client-side timeout — tools can be long-running (Krea polls for
 *   minutes). Pass `opts.signal` to bound it yourself.
 *
 * @throws {ToolProxyUnavailableError} on 403/404/501 — no connection for the
 *   tool's provider; recover via `timbal.integrations`.
 * @throws {IntegrationConsentRequiredError} on 401 `consent_required` — the
 *   caller must (re)consent (same flow as personal token vending).
 * @throws {TimbalApiError} for any other non-2xx (e.g. 400 bad params, 5xx).
 */
export async function executeToolProxy<T = unknown>(
  client: ApiClient,
  name: string,
  params: Record<string, unknown>,
  opts?: ToolRunOptions,
): Promise<T> {
  const org = resolveOrg(client, opts?.orgId);
  const path = `orgs/${org}${PROXY_TOOLS_PREFIX}/${encodeURIComponent(name)}`;

  const response = await client.fetch(path, {
    method: 'POST',
    body: JSON.stringify(params ?? {}),
    headers: buildProxyHeaders(client, opts),
    ...(opts?.signal && { signal: opts.signal }),
  });

  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Empty / non-JSON body — leave null.
  }

  if (response.ok) {
    return body as T;
  }

  // No connection configured for this tool's provider — actionable, points to
  // the integrations API for recovery.
  if ([403, 404, 501].includes(response.status)) {
    const message =
      (body && typeof body.message === 'string' && body.message) ||
      `No connection available for tool "${name}". Enable and connect its provider via timbal.integrations.`;
    throw new ToolProxyUnavailableError(
      message,
      name,
      response.status,
      body && typeof body.provider === 'string' ? body.provider : undefined,
      body && typeof body.code === 'string' ? body.code : undefined,
      body ?? undefined,
    );
  }

  // Caller must (re)consent — reuse the same typed error the credential plane
  // throws, so a single catch handles both vend and proxy paths.
  if (
    response.status === 401 &&
    body &&
    body.error === 'consent_required' &&
    typeof body.consent_url === 'string'
  ) {
    throw new IntegrationConsentRequiredError(
      String(body.error),
      typeof body.integration_id === 'string' || typeof body.integration_id === 'number'
        ? String(body.integration_id)
        : name,
      body.consent_url,
      response.status,
      typeof body.code === 'string' ? body.code : undefined,
      body,
    );
  }

  const message =
    (body && typeof body.message === 'string' && body.message) ||
    (body && typeof body.error === 'string' && body.error) ||
    response.statusText ||
    'Tool execution failed';
  throw new TimbalApiError(
    message,
    response.status,
    body && typeof body.code === 'string' ? body.code : undefined,
    body ?? undefined,
  );
}

/**
 * Fetch the tool manifest list (`GET /orgs/{org}/proxies/v1/tools` →
 * `{ version, tools: [...] }`) — the lightweight registry of what an agent may
 * call (metadata only; no parameter schema — see {@link getToolDetail}).
 *
 * Tolerant of a bare-array body too. Optionally filters to one provider.
 */
export async function listToolManifest(
  client: ApiClient,
  opts?: { orgId?: string; provider?: string },
): Promise<RemoteToolSpec[]> {
  const org = resolveOrg(client, opts?.orgId);
  const response = await client.get<RawToolManifest | RemoteToolSpec[]>(
    `orgs/${org}${PROXY_TOOLS_PREFIX}`,
  );
  const data = response.data;
  const tools = Array.isArray(data) ? data : (data?.tools ?? []);
  return opts?.provider ? tools.filter((t) => t.provider === opts.provider) : tools;
}

/**
 * Fetch one tool's detail (`GET /orgs/{org}/proxies/v1/tools/{name}`), including
 * the parameter JSON Schema (`params`) the list omits.
 */
export async function getToolDetail(
  client: ApiClient,
  name: string,
  opts?: { orgId?: string },
): Promise<RemoteToolDetail> {
  const org = resolveOrg(client, opts?.orgId);
  const response = await client.get<RemoteToolDetail>(
    `orgs/${org}${PROXY_TOOLS_PREFIX}/${encodeURIComponent(name)}`,
  );
  return response.data;
}
