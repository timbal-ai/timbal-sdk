import type { ApiClient } from '../api';
import { TimbalApiError } from '../api';
import { KbFileNotFoundError, KbFileAlreadyExistsError } from '../kb/errors';
import {
  coerceK2File,
  coerceK2FileDetail,
  coerceKbInfo,
  type RawK2File,
  type RawK2FileDetail,
  type RawKbInfo,
} from '../coerce';
import type {
  K2File,
  K2FileDetail,
  K2FilePage,
  KbFileListOptions,
  KbFileUploadOptions,
  KbInfo,
  KbInfoPage,
  KbListOptions,
  KbSchemaOptions,
  KbSchemaSqlOptions,
  KbSchemaStructuredOptions,
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

type RawKbListEnvelope = {
  k2?: RawKbInfo[];
  items?: RawKbInfo[];
  next_page_token?: string | null;
};

/**
 * List knowledge bases in the org with full pagination metadata
 * (`GET /orgs/{org}/k2` → `ListK2Response`).
 */
export async function listKbsPage(
  client: ApiClient,
  options?: KbListOptions & { orgId?: string },
): Promise<KbInfoPage> {
  const orgId = resolveOrg(client, options?.orgId);
  const params = options?.page_token ? { page_token: options.page_token } : undefined;
  const response = await client.get<RawKbInfo[] | RawKbListEnvelope>(
    `orgs/${orgId}/k2`,
    params,
  );
  const data = response.data;

  if (Array.isArray(data)) {
    return { k2: data.map(coerceKbInfo) };
  }
  if (!data) return { k2: [] };

  const raw = data.k2 ?? data.items ?? [];
  return {
    k2: raw.map(coerceKbInfo),
    ...(data.next_page_token !== undefined && { next_page_token: data.next_page_token }),
  };
}

/**
 * List knowledge bases in the org — **first page only** (`.k2` from
 * {@link listKbsPage}). When you need every KB in the org, use
 * {@link listKbsAll} or {@link iterateKbs}.
 */
export async function listKbs(
  client: ApiClient,
  options?: KbListOptions & { orgId?: string },
): Promise<KbInfo[]> {
  const page = await listKbsPage(client, options);
  return page.k2;
}

/**
 * Async iterator over every KB in the org, walking pages via {@link listKbsPage}.
 */
export async function* iterateKbs(
  client: ApiClient,
  options?: KbListOptions & { orgId?: string },
): AsyncIterable<KbInfo> {
  let pageToken = options?.page_token;

  for (;;) {
    const page = await listKbsPage(client, {
      orgId: options?.orgId,
      ...(pageToken !== undefined && { page_token: pageToken }),
    });

    for (const kb of page.k2) {
      yield kb;
    }

    const next = page.next_page_token;
    if (next == null || next === '') break;
    pageToken = next;
  }
}

/**
 * List every KB in the org, draining all pages into one array.
 *
 * Convenience over {@link iterateKbs} when you want the full set in memory.
 * For large orgs prefer `iterate()` to avoid holding everything at once.
 */
export async function listKbsAll(
  client: ApiClient,
  options?: KbListOptions & { orgId?: string },
): Promise<KbInfo[]> {
  const out: KbInfo[] = [];
  for await (const kb of iterateKbs(client, options)) {
    out.push(kb);
  }
  return out;
}

// ── KB-scoped ──

/**
 * Fetch the KB schema in structured form (tables, columns, indexes, constraints).
 * Default when `format` is omitted or `"structured"`.
 */
export async function getKbSchema(
  client: ApiClient,
  kbId: string,
  options: KbSchemaSqlOptions,
): Promise<string[]>;
export async function getKbSchema(
  client: ApiClient,
  kbId: string,
  options?: KbSchemaStructuredOptions,
): Promise<TableSchema[]>;
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
    const response = await client.postFormData<RawK2File>(path, formData);
    return coerceK2File(response.data);
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
 * Returns a page object. For automatic pagination use `kb.files.iterate()`.
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

  type RawK2FilePage = { files: RawK2File[]; next_page_token?: string | null };
  const response = await client.get<RawK2FilePage | RawK2File[]>(
    `${basePath(org, kbId)}/files`,
    Object.keys(params).length ? params : undefined,
  );
  const data = response.data;
  if (Array.isArray(data)) return { files: data.map(coerceK2File) };
  if (!data) return { files: [] };
  return {
    files: (data.files ?? []).map(coerceK2File),
    ...(data.next_page_token !== undefined && { next_page_token: data.next_page_token }),
  };
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
    const response = await client.get<RawK2FileDetail>(`${basePath(org, kbId)}/files/${fileId}`);
    return coerceK2FileDetail(response.data);
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
