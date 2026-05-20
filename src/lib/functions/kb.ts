import type { ApiClient } from '../api';
import { TimbalApiError } from '../api';
import { KbFileNotFoundError, KbFileAlreadyExistsError } from '../kb/errors';
import type {
  K2File,
  K2FileDetail,
  K2FilePage,
  KbFileListOptions,
  KbFileUploadOptions,
  KbInfo,
  KbListOptions,
  KbSchemaOptions,
  KbSchemaSqlOptions,
  TableSchema,
} from '../../types';

function resolveOrg(client: ApiClient, orgId?: string): string {
  const id = orgId || client.getConfig().orgId;
  if (!id) throw new Error('orgId is required. Provide it in client config or set TIMBAL_ORG_ID env var.');
  return id;
}

function basePath(orgId: string, kbId: string): string {
  return `orgs/${orgId}/k2/${kbId}`;
}

// ── KB collection ──

/**
 * List all knowledge bases the caller has access to in the given org.
 *
 * @returns A list of `KbInfo` (id, name, …). The server may paginate; pass `page_token`
 *          to fetch subsequent pages.
 */
export async function listKbs(
  client: ApiClient,
  options?: KbListOptions & { orgId?: string },
): Promise<KbInfo[]> {
  const orgId = resolveOrg(client, options?.orgId);
  const params = options?.page_token ? { page_token: options.page_token } : undefined;
  const response = await client.get<KbInfo[] | { k2: KbInfo[] } | { items: KbInfo[] }>(
    `orgs/${orgId}/k2`,
    params,
  );
  const data = response.data;
  if (Array.isArray(data)) return data;
  if (data && 'k2' in data) return data.k2 ?? [];
  if (data && 'items' in data) return data.items ?? [];
  return [];
}

// ── KB-scoped ──

/**
 * Fetch the KB schema in structured form (tables, columns, indexes, constraints).
 * Default when `format` is omitted or `"structured"`.
 */
export async function getKbSchema(
  client: ApiClient,
  kbId: string,
  options?: KbSchemaOptions,
): Promise<TableSchema[]>;
export async function getKbSchema(
  client: ApiClient,
  kbId: string,
  options: KbSchemaSqlOptions,
): Promise<string[]>;
export async function getKbSchema(
  client: ApiClient,
  kbId: string,
  options?: KbSchemaOptions,
): Promise<TableSchema[] | string[]> {
  const org = resolveOrg(client, options?.orgId);
  const params =
    options?.format === 'sql' ? { format: 'sql' as const } : undefined;

  if (options?.format === 'sql') {
    const response = await client.get<{ statements: string[] } | string[]>(
      `${basePath(org, kbId)}/schema`,
      params,
    );
    const data = response.data;
    if (Array.isArray(data) && (data.length === 0 || typeof data[0] === 'string')) {
      return data as string[];
    }
    return (data as { statements: string[] })?.statements ?? [];
  }

  const response = await client.get<TableSchema[] | { tables: TableSchema[] }>(
    `${basePath(org, kbId)}/schema`,
    params,
  );
  const data = response.data;
  if (Array.isArray(data)) return data;
  return data?.tables ?? [];
}

// ── KB files ──

function toBlob(data: Blob | ArrayBuffer | ArrayBufferView): Blob {
  if (data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return new Blob([data]);
  return new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer]);
}

/**
 * Upload a file into a KB. Posts to `POST /orgs/{org}/k2/{kb}/files`.
 *
 * Unlike org-bucket uploads, this returns a `K2File` (with `uid`, `metadata`, `directory`,
 * `parse_state`) and runs the platform parse + embed pipeline by default. Pass
 * `parse: false` to skip parsing (KB used as a typed metadata store, not RAG).
 *
 * @throws {KbFileAlreadyExistsError} on HTTP 409 (filename collision under the same directory).
 */
export async function uploadKbFile(
  client: ApiClient,
  kbId: string,
  data: Blob | ArrayBuffer | ArrayBufferView,
  filename: string,
  options?: KbFileUploadOptions & { orgId?: string },
): Promise<K2File> {
  const org = resolveOrg(client, options?.orgId);
  const path = `${basePath(org, kbId)}/files`;

  const formData = new FormData();
  formData.append('file', toBlob(data), filename);
  // `metadata` is REQUIRED by the server per the OpenAPI spec — default to `{}`
  // so callers don't have to pass an empty object every time.
  formData.append('metadata', JSON.stringify(options?.metadata ?? {}));
  if (options?.directory !== undefined) {
    formData.append('directory', options.directory);
  }
  if (options?.parse !== undefined) {
    formData.append('parse', String(options.parse));
  }

  try {
    const response = await client.postFormData<K2File>(path, formData);
    return response.data;
  } catch (err) {
    if (err instanceof TimbalApiError && err.statusCode === 409) {
      throw new KbFileAlreadyExistsError(
        err.message,
        kbId,
        filename,
        options?.directory ?? null,
        err.statusCode,
        err.code,
        err.details,
      );
    }
    throw err;
  }
}

/**
 * List files in a KB, optionally filtered by `directory`.
 *
 * Returns a page object. No auto-pagination in v0.8 — callers thread `next_page_token`
 * manually. (`KbFilesSection.iter()` is planned for v0.9.)
 */
export async function listKbFiles(
  client: ApiClient,
  kbId: string,
  options?: KbFileListOptions & { orgId?: string },
): Promise<K2FilePage> {
  const org = resolveOrg(client, options?.orgId);
  const params: Record<string, unknown> = {};
  if (options?.directory !== undefined) params.directory = options.directory;
  if (options?.page_token !== undefined) params.page_token = options.page_token;

  const response = await client.get<K2FilePage | K2File[]>(
    `${basePath(org, kbId)}/files`,
    Object.keys(params).length ? params : undefined,
  );
  const data = response.data;
  if (Array.isArray(data)) return { files: data };
  return data ?? { files: [] };
}

/**
 * Get a single KB file with its parse + embed pipeline metadata
 * (`parsings`, `embeddings`).
 *
 * Note per the API docs: passing a directory row's id throws 404 — virtual
 * directories don't have a full file payload at this endpoint.
 *
 * @throws {KbFileNotFoundError} on HTTP 404.
 */
export async function getKbFile(
  client: ApiClient,
  kbId: string,
  fileId: string | number,
  orgId?: string,
): Promise<K2FileDetail> {
  const org = resolveOrg(client, orgId);
  try {
    const response = await client.get<K2FileDetail>(`${basePath(org, kbId)}/files/${fileId}`);
    return response.data;
  } catch (err) {
    if (err instanceof TimbalApiError && err.statusCode === 404) {
      throw new KbFileNotFoundError(
        err.message,
        kbId,
        String(fileId),
        err.statusCode,
        err.code,
        err.details,
      );
    }
    throw err;
  }
}

/**
 * Delete a KB file. **Idempotent** — the backend returns 204 even when the file
 * does not exist, so this resolves `void` regardless. Use {@link getKbFile} first
 * if you need to distinguish "deleted" from "never existed".
 */
export async function deleteKbFile(
  client: ApiClient,
  kbId: string,
  fileId: string | number,
  orgId?: string,
): Promise<void> {
  const org = resolveOrg(client, orgId);
  await client.delete(`${basePath(org, kbId)}/files/${fileId}`);
}
