import type { ApiClient } from '../api';
import type { File, TempFile, PlatformContext } from '../../types';

function resolveOrgId(client: ApiClient, ctx?: PlatformContext): string {
  const orgId = ctx?.orgId || client.getConfig().orgId;
  if (!orgId) throw new Error('orgId is required. Provide it in ctx, client config, or set TIMBAL_ORG_ID env var.');
  return orgId;
}

// Server emits `id` as a JSON number (int64). We coerce at the boundary so
// every ID in the SDK is a string, matching KBs / KB files / projects.
//
// Note: `Omit<File, 'id'> & { id: ... }` rather than `File & { id: ... }`
// because TS collapses `string & (string | number)` to `string`, which would
// hide the union from `raw.id` and make the `String()` call look redundant.
type RawFile = Omit<File, 'id'> & { id: string | number };

function coerceFile(raw: RawFile): File {
  return { ...raw, id: String(raw.id) };
}

function basenameFromPath(filePath: string): string {
  return filePath.split('/').pop() || 'unknown';
}

// ── Temporary files (POST /files) ──────────────────────────────────────────

/**
 * Upload a temporary file from a local file path.
 *
 * Hits `POST /files` (the documented stateless route). Returns a
 * {@link TempFile} with a short-lived URL (~24h). Not org-scoped — no
 * database row is created.
 *
 * Use this for one-shot binary handoff to agents/workflows. For long-lived,
 * parsed, searchable storage use `kb.files.upload` instead.
 *
 * @example
 * const tmp = await uploadTempFile(client, "/path/to/report.pdf");
 * await timbal.callWorkforce("summarize", { file_url: tmp.url });
 */
export async function uploadTempFile(
  client: ApiClient,
  filePath: string,
): Promise<TempFile> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileBuffer = await file.arrayBuffer();
  const contentType = file.type || 'application/octet-stream';
  const fileName = basenameFromPath(filePath);

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: contentType }), fileName);

  const response = await client.postFormData<TempFile>('files', formData);
  return response.data;
}

/**
 * Upload a temporary file from an in-memory buffer.
 *
 * See {@link uploadTempFile} for semantics.
 *
 * @example
 * const data = new TextEncoder().encode("hello");
 * const tmp = await uploadTempFileFromBuffer(client, data, "hello.txt", "text/plain");
 */
export async function uploadTempFileFromBuffer(
  client: ApiClient,
  data: ArrayBuffer | Uint8Array,
  filename: string,
  contentType: string = 'application/octet-stream',
): Promise<TempFile> {
  const formData = new FormData();
  formData.append('file', new Blob([data], { type: contentType }), filename);

  const response = await client.postFormData<TempFile>('files', formData);
  return response.data;
}

// ── Org-bucket files (deprecated) ──────────────────────────────────────────

/**
 * Upload a file to an organization bucket from a local file path.
 *
 * @deprecated Use {@link uploadTempFile} for short-lived attachments or
 * `kb.files.upload` (via `timbal.kbs.get(kbId).files.upload`) for durable,
 * parsed, searchable storage. This route (`POST /orgs/{org}/files`) is
 * undocumented and slated for removal.
 */
export async function uploadFile(
  client: ApiClient,
  filePath: string,
  ctx?: PlatformContext
): Promise<File> {
  const orgId = resolveOrgId(client, ctx);
  const path = `orgs/${orgId}/files`;

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileBuffer = await file.arrayBuffer();
  const contentType = file.type || 'application/octet-stream';
  const fileName = basenameFromPath(filePath);

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: contentType }), fileName);

  const response = await client.postFormData<RawFile>(path, formData);
  return coerceFile(response.data);
}

/**
 * Upload a file to an organization bucket from an in-memory buffer.
 *
 * @deprecated See {@link uploadFile} for rationale and migration path.
 */
export async function uploadFileFromBuffer(
  client: ApiClient,
  data: ArrayBuffer | Uint8Array,
  filename: string,
  contentType: string = 'application/octet-stream',
  ctx?: PlatformContext
): Promise<File> {
  const orgId = resolveOrgId(client, ctx);
  const path = `orgs/${orgId}/files`;

  const formData = new FormData();
  formData.append('file', new Blob([data], { type: contentType }), filename);

  const response = await client.postFormData<RawFile>(path, formData);
  return coerceFile(response.data);
}
