import type { ApiClient } from '../api';
import { TimbalApiError } from '../api';
import {
  IntegrationConsentRequiredError,
  IntegrationNotFoundError,
} from '../integrations/errors';
import type {
  IntegrationCatalogEntry,
  IntegrationCatalogListOptions,
  IntegrationCatalogPage,
  IntegrationDisableResult,
  IntegrationEnableResult,
  PersonalConnection,
  PersonalConnectionListOptions,
  PersonalConnectionPage,
  PersonalConsentOptions,
  PersonalConsentResponse,
  PersonalTokenVend,
  SharedConnection,
  SharedConnectionListOptions,
  SharedConnectionPage,
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

// ── Catalog ────────────────────────────────────────────────────────────────

type RawCatalogEnvelope = {
  integrations?: IntegrationCatalogEntry[];
  items?: IntegrationCatalogEntry[];
  next_page_token?: string | null;
};

/**
 * List the integration catalog with full pagination metadata.
 *
 * Hits `GET /integrations?org_id={id}` — a **global** route (not
 * `/orgs/{org}/...`); `org_id` flows as a query param so the server knows
 * which `enabled` flag to populate.
 *
 * Today the backend returns a bare `{ integrations }` object with no cursor,
 * but we thread `next_page_token` so a future paginated rollout is
 * transparent.
 */
export async function listIntegrationsCatalogPage(
  client: ApiClient,
  options?: IntegrationCatalogListOptions,
): Promise<IntegrationCatalogPage> {
  const orgId = resolveOrg(client, options?.orgId);
  const params: Record<string, unknown> = { org_id: orgId };
  if (options?.page_token !== undefined) params.page_token = options.page_token;

  const response = await client.get<IntegrationCatalogEntry[] | RawCatalogEnvelope>(
    'integrations',
    params,
  );
  const data = response.data;

  if (Array.isArray(data)) return { integrations: data };
  if (!data) return { integrations: [] };

  return {
    integrations: data.integrations ?? data.items ?? [],
    ...(data.next_page_token !== undefined && { next_page_token: data.next_page_token }),
  };
}

/**
 * First page of the integration catalog (`integrations` slice from
 * {@link listIntegrationsCatalogPage}). Use {@link listIntegrationsCatalogAll}
 * or {@link iterateIntegrationsCatalog} to walk every page.
 */
export async function listIntegrationsCatalog(
  client: ApiClient,
  options?: IntegrationCatalogListOptions,
): Promise<IntegrationCatalogEntry[]> {
  const page = await listIntegrationsCatalogPage(client, options);
  return page.integrations;
}

/**
 * Async iterator over every catalog entry, walking pages via
 * {@link listIntegrationsCatalogPage}.
 */
export async function* iterateIntegrationsCatalog(
  client: ApiClient,
  options?: IntegrationCatalogListOptions,
): AsyncIterable<IntegrationCatalogEntry> {
  let pageToken = options?.page_token;

  for (;;) {
    const page = await listIntegrationsCatalogPage(client, {
      ...(options?.orgId !== undefined && { orgId: options.orgId }),
      ...(pageToken !== undefined && { page_token: pageToken }),
    });

    for (const entry of page.integrations) {
      yield entry;
    }

    const next = page.next_page_token;
    if (next == null || next === '') break;
    pageToken = next;
  }
}

/**
 * Drain every catalog page into one array. Convenience over
 * {@link iterateIntegrationsCatalog} when you want the full set in memory.
 */
export async function listIntegrationsCatalogAll(
  client: ApiClient,
  options?: IntegrationCatalogListOptions,
): Promise<IntegrationCatalogEntry[]> {
  const out: IntegrationCatalogEntry[] = [];
  for await (const entry of iterateIntegrationsCatalog(client, options)) {
    out.push(entry);
  }
  return out;
}

/**
 * Enable a provider for the org (`POST /orgs/{org}/integrations/enable`).
 *
 * Idempotent on already-enabled providers — server returns 200 with
 * `{ provider }`. Unknown providers throw
 * {@link IntegrationNotFoundError} (server emits 404 / `NOT_FOUND`).
 */
export async function enableIntegration(
  client: ApiClient,
  provider: string,
  orgId?: string,
): Promise<IntegrationEnableResult> {
  const org = resolveOrg(client, orgId);
  try {
    const response = await client.post<IntegrationEnableResult>(
      `orgs/${org}/integrations/enable`,
      { provider },
    );
    // Defensive — if server ever stops echoing provider, fall back to the
    // input so callers always get a populated field.
    return { provider: response.data?.provider ?? provider };
  } catch (err) {
    if (err instanceof TimbalApiError && err.statusCode === 404) {
      throw new IntegrationNotFoundError(
        err.message,
        provider,
        err.statusCode,
        err.code,
        err.details,
      );
    }
    throw err;
  }
}

// ── Connection-list helpers ────────────────────────────────────────────────

/**
 * Coerce wire `next_page_token` to `string | null | undefined`. The backend
 * returns it as a JSON number for paginated routes (matches the row count),
 * but the SDK exposes it as a string so callers can thread it back through
 * `page_token` (a query string) without thinking about types.
 */
function coerceNextPageToken(
  token: string | number | null | undefined,
): string | null | undefined {
  if (token === undefined) return undefined;
  if (token === null) return null;
  return String(token);
}

type RawConnectionEnvelope<T> = {
  integrations?: T[];
  items?: T[];
  next_page_token?: string | number | null;
};

// ── Shared (org-wide) connections ──────────────────────────────────────────

/**
 * List org-wide connections with full pagination metadata.
 *
 * This endpoint paginates server-side — `next_page_token` is non-null when
 * more pages exist. Coerced to `string` (wire returns it as a JSON number)
 * for downstream `page_token` round-tripping.
 */
export async function listSharedConnectionsPage(
  client: ApiClient,
  options?: SharedConnectionListOptions,
): Promise<SharedConnectionPage> {
  const org = resolveOrg(client, options?.orgId);
  const params: Record<string, unknown> = { connection_mode: 'org' };
  if (options?.page_token !== undefined) params.page_token = options.page_token;

  const response = await client.get<SharedConnection[] | RawConnectionEnvelope<SharedConnection>>(
    `orgs/${org}/integrations`,
    params,
  );
  const data = response.data;

  if (Array.isArray(data)) return { integrations: data };
  if (!data) return { integrations: [] };

  const next = coerceNextPageToken(data.next_page_token);
  return {
    integrations: data.integrations ?? data.items ?? [],
    ...(next !== undefined && { next_page_token: next }),
  };
}

/** First page of shared connections. Drains with {@link listSharedConnectionsAll}. */
export async function listSharedConnections(
  client: ApiClient,
  options?: SharedConnectionListOptions,
): Promise<SharedConnection[]> {
  const page = await listSharedConnectionsPage(client, options);
  return page.integrations;
}

/** Async iterator over every shared connection, walking pages via {@link listSharedConnectionsPage}. */
export async function* iterateSharedConnections(
  client: ApiClient,
  options?: SharedConnectionListOptions,
): AsyncIterable<SharedConnection> {
  let pageToken = options?.page_token;

  for (;;) {
    const page = await listSharedConnectionsPage(client, {
      ...(options?.orgId !== undefined && { orgId: options.orgId }),
      ...(pageToken !== undefined && { page_token: pageToken }),
    });

    for (const conn of page.integrations) {
      yield conn;
    }

    const next = page.next_page_token;
    if (next == null || next === '') break;
    pageToken = next;
  }
}

/** Drain every page of shared connections into one array. */
export async function listSharedConnectionsAll(
  client: ApiClient,
  options?: SharedConnectionListOptions,
): Promise<SharedConnection[]> {
  const out: SharedConnection[] = [];
  for await (const conn of iterateSharedConnections(client, options)) {
    out.push(conn);
  }
  return out;
}

// ── Personal (per-caller-token) connections ────────────────────────────────

/**
 * List personal connections with full pagination metadata.
 *
 * Session-scoped — the response only includes rows the caller can see:
 * either the provider is enabled in the catalog *or* the caller already
 * holds a token (admin may have re-disabled the provider since). Each row
 * always carries `user` describing the caller's connection state.
 */
export async function listPersonalConnectionsPage(
  client: ApiClient,
  options?: PersonalConnectionListOptions,
): Promise<PersonalConnectionPage> {
  const org = resolveOrg(client, options?.orgId);
  const params: Record<string, unknown> = { connection_mode: 'user' };
  if (options?.page_token !== undefined) params.page_token = options.page_token;

  const response = await client.get<PersonalConnection[] | RawConnectionEnvelope<PersonalConnection>>(
    `orgs/${org}/integrations`,
    params,
  );
  const data = response.data;

  if (Array.isArray(data)) return { integrations: data };
  if (!data) return { integrations: [] };

  const next = coerceNextPageToken(data.next_page_token);
  return {
    integrations: data.integrations ?? data.items ?? [],
    ...(next !== undefined && { next_page_token: next }),
  };
}

/** First page of personal connections. Drains with {@link listPersonalConnectionsAll}. */
export async function listPersonalConnections(
  client: ApiClient,
  options?: PersonalConnectionListOptions,
): Promise<PersonalConnection[]> {
  const page = await listPersonalConnectionsPage(client, options);
  return page.integrations;
}

/** Async iterator over every personal connection, walking pages via {@link listPersonalConnectionsPage}. */
export async function* iteratePersonalConnections(
  client: ApiClient,
  options?: PersonalConnectionListOptions,
): AsyncIterable<PersonalConnection> {
  let pageToken = options?.page_token;

  for (;;) {
    const page = await listPersonalConnectionsPage(client, {
      ...(options?.orgId !== undefined && { orgId: options.orgId }),
      ...(pageToken !== undefined && { page_token: pageToken }),
    });

    for (const conn of page.integrations) {
      yield conn;
    }

    const next = page.next_page_token;
    if (next == null || next === '') break;
    pageToken = next;
  }
}

/** Drain every page of personal connections into one array. */
export async function listPersonalConnectionsAll(
  client: ApiClient,
  options?: PersonalConnectionListOptions,
): Promise<PersonalConnection[]> {
  const out: PersonalConnection[] = [];
  for await (const conn of iteratePersonalConnections(client, options)) {
    out.push(conn);
  }
  return out;
}

/**
 * Disable a provider for the org (`POST /orgs/{org}/integrations/disable`).
 *
 * Symmetric to {@link enableIntegration}: server returns `{ provider }` on
 * success. Per the platform's visibility rules, disabling a provider hides
 * the user-mode shell row from `list()` for users who never connected, but
 * leaves rows belonging to users who *did* connect intact (so they can
 * still vend their token until they explicitly disconnect).
 *
 * @throws {IntegrationNotFoundError} when the provider is not in the
 *   platform catalog (HTTP 404).
 */
export async function disableIntegration(
  client: ApiClient,
  provider: string,
  orgId?: string,
): Promise<IntegrationDisableResult> {
  const org = resolveOrg(client, orgId);
  try {
    const response = await client.post<IntegrationDisableResult>(
      `orgs/${org}/integrations/disable`,
      { provider },
    );
    return { provider: response.data?.provider ?? provider };
  } catch (err) {
    if (err instanceof TimbalApiError && err.statusCode === 404) {
      throw new IntegrationNotFoundError(
        err.message,
        provider,
        err.statusCode,
        err.code,
        err.details,
      );
    }
    throw err;
  }
}

// ── Personal: vend + consent ──────────────────────────────────────────────

/**
 * Vend the caller's personal token for an integration row
 * (`GET /orgs/{org}/integrations/{id}`).
 *
 * Uses {@link ApiClient.fetch} (raw escape hatch) instead of the typed `get`
 * path because the consent_required 401 body carries a top-level
 * `consent_url` field that the SDK's standard error parser doesn't preserve.
 * Hand-rolling the request lets us surface it through
 * {@link IntegrationConsentRequiredError.consentUrl}.
 *
 * @throws {IntegrationConsentRequiredError} on HTTP 401 with `error:
 *   "consent_required"` — caller needs to (re)consent.
 * @throws {TimbalApiError} for any other non-2xx response.
 */
export async function vendPersonalToken(
  client: ApiClient,
  integrationId: string,
  orgId?: string,
): Promise<PersonalTokenVend> {
  const org = resolveOrg(client, orgId);
  const path = `orgs/${org}/integrations/${integrationId}`;

  const response = await client.fetch(path, { method: 'GET' });

  // Parse the body once — we need it whether the call succeeded or not.
  let body: Record<string, unknown> | null = null;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Empty / non-JSON body — leave null.
  }

  if (response.ok) {
    if (!body) {
      throw new TimbalApiError(
        'Vend returned an empty body',
        response.status,
      );
    }
    return body as unknown as PersonalTokenVend;
  }

  // Consent-required: surface a typed error with the consent endpoint URL.
  if (
    response.status === 401 &&
    body &&
    body.error === 'consent_required' &&
    typeof body.consent_url === 'string'
  ) {
    throw new IntegrationConsentRequiredError(
      String(body.error),
      integrationId,
      body.consent_url,
      response.status,
      typeof body.code === 'string' ? body.code : undefined,
      body as Record<string, unknown>,
    );
  }

  // Fall back to the SDK's generic error shape for anything else.
  const message =
    (body && typeof body.message === 'string' && body.message) ||
    (body && typeof body.error === 'string' && body.error) ||
    response.statusText ||
    'Vend failed';
  const code = body && typeof body.code === 'string' ? body.code : undefined;
  throw new TimbalApiError(
    message,
    response.status,
    code,
    body ? (body as Record<string, unknown>) : undefined,
  );
}

/**
 * Start an OAuth consent flow for a personal integration row
 * (`POST /orgs/{org}/integrations/{id}/consent`).
 *
 * Returns the OAuth provider's authorize URL — send the user's browser
 * there. After the provider redirects them back through Timbal's
 * `/oauth/callback/integrations`, they land on `opts.redirect_uri` (must
 * be allowlisted by the platform; `*.timbal.ai`, org custom domains, or
 * `localhost`).
 *
 * Caller must be an org member for this route (`require_org_membership`).
 */
export async function startPersonalConsent(
  client: ApiClient,
  integrationId: string,
  opts: PersonalConsentOptions,
  orgId?: string,
): Promise<PersonalConsentResponse> {
  const org = resolveOrg(client, orgId);
  const response = await client.post<PersonalConsentResponse>(
    `orgs/${org}/integrations/${integrationId}/consent`,
    { redirect_uri: opts.redirect_uri },
  );
  return response.data;
}
