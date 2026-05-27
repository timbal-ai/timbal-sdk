import type { ApiClient } from '../api';
import { TimbalApiError } from '../api';
import { IntegrationNotFoundError } from '../integrations/errors';
import type {
  IntegrationCatalogEntry,
  IntegrationCatalogListOptions,
  IntegrationCatalogPage,
  IntegrationDisableResult,
  IntegrationEnableResult,
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
