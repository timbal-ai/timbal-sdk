import type { ApiClient } from '../api';
import type { File, PlatformContext } from '../../types';

function resolveOrgId(client: ApiClient, ctx?: PlatformContext): string {
  const orgId = ctx?.orgId || client.getConfig().orgId;
  if (!orgId) throw new Error('orgId is required. Provide it in ctx, client config, or set TIMBAL_ORG_ID env var.');
  return orgId;
}

/**
 * Upload a file to an organization from a local file path.
 *
 * @param client - The API client instance.
 * @param filePath - The absolute path to the file on disk.
 * @param ctx - Optional overrides for orgId. Falls back to client config / env vars.
 * @returns The uploaded File object with metadata (id, name, content_type, url, etc.).
 *
 * @example
 * const file = await uploadFile(client, "/path/to/document.pdf")
 * const file = await uploadFile(client, "/path/to/document.pdf", { orgId: "10" })
 */
export async function uploadFile(
  client: ApiClient,
  filePath: string,
  ctx?: PlatformContext
): Promise<File> {
  const orgId = resolveOrgId(client, ctx);
  const path = `orgs/${orgId}/files`;

  const file = Bun.file(filePath);
  const fileExists = await file.exists();
  if (!fileExists) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileName = filePath.split('/').pop() || 'unknown';
  const fileBuffer = await file.arrayBuffer();
  const contentType = file.type || 'application/octet-stream';

  const formData = new FormData();
  const blob = new Blob([fileBuffer], { type: contentType });
  formData.append('file', blob, fileName);

  const response = await client.postFormData<File>(path, formData);
  return response.data;
}

/**
 * Upload a file to an organization from an in-memory buffer.
 *
 * @param client - The API client instance.
 * @param data - The file contents as an ArrayBuffer or Uint8Array.
 * @param filename - The filename to use for the upload.
 * @param contentType - The MIME type of the file. Defaults to "application/octet-stream".
 * @param ctx - Optional overrides for orgId. Falls back to client config / env vars.
 * @returns The uploaded File object with metadata (id, name, content_type, url, etc.).
 *
 * @example
 * const data = new TextEncoder().encode("Hello, world!")
 * const file = await uploadFileFromBuffer(client, data, "hello.txt", "text/plain")
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
  const blob = new Blob([data], { type: contentType });
  formData.append('file', blob, filename);

  const response = await client.postFormData<File>(path, formData);
  return response.data;
}
