import type { ApiClient } from '../api';
import type {
  K2File,
  K2FileDetail,
  K2FilePage,
  KbDirectoryCreateResult,
  KbFileListOptions,
  KbFileUploadOptions,
} from '../../types';
import {
  uploadKbFile,
  listKbFiles,
  getKbFile,
  deleteKbFile,
  createKbDirectory,
} from '../functions/kb';

/**
 * Files inside a Knowledge Base. Reached via `kb.files`.
 *
 * Maps to `/orgs/{org}/k2/{kb}/files` and its sub-resources.
 */
export class KbFilesSection {
  constructor(
    private readonly apiClient: ApiClient,
    public readonly kbId: string,
  ) {}

  /**
   * Upload a file into this KB (`POST /k2/{kb}/files`).
   *
   * Pass `parse: false` to skip the parse + embed pipeline (typed metadata store
   * use case). Throws {@link KbFileAlreadyExistsError} on filename collision (409).
   */
  upload(
    data: Blob | ArrayBuffer | ArrayBufferView,
    filename: string,
    options?: KbFileUploadOptions,
  ): Promise<K2File> {
    return uploadKbFile(this.apiClient, this.kbId, data, filename, options);
  }

  /**
   * List files in this KB. Returns a page (`{ files, next_page_token? }`); thread
   * `next_page_token` manually, or use {@link iterate} to walk all pages.
   */
  list(options?: KbFileListOptions): Promise<K2FilePage> {
    return listKbFiles(this.apiClient, this.kbId, options);
  }

  /**
   * Async iterator over every file in this KB, walking pages automatically.
   *
   * Built on {@link list} — same filters (`directory`), same coercion. Pass
   * `page_token` only to resume from a known cursor (e.g. after a crash).
   *
   * ```ts
   * for await (const f of kb.files.iterate({ directory: "orders" })) {
   *   await process(f);
   * }
   * ```
   */
  async *iterate(options?: KbFileListOptions): AsyncIterable<K2File> {
    let pageToken = options?.page_token;

    for (;;) {
      const page = await listKbFiles(this.apiClient, this.kbId, {
        ...(options?.directory !== undefined && { directory: options.directory }),
        ...(pageToken !== undefined && { page_token: pageToken }),
      });

      for (const file of page.files) {
        yield file;
      }

      const next = page.next_page_token;
      if (next == null || next === '') break;
      pageToken = next;
    }
  }

  /**
   * Returns the file with its parse + embed pipeline metadata
   * (`parsings`, `embeddings`). Throws {@link KbFileNotFoundError} on 404.
   */
  get(fileId: string | number): Promise<K2FileDetail> {
    return getKbFile(this.apiClient, this.kbId, fileId);
  }

  /**
   * Delete a file. **Idempotent** — backend returns 204 even when the file does
   * not exist, so this resolves `void` regardless. Call {@link get} first if you
   * need to distinguish "deleted" from "never existed".
   */
  delete(fileId: string | number): Promise<void> {
    return deleteKbFile(this.apiClient, this.kbId, fileId);
  }

  /**
   * Create a virtual directory (e.g. `"docs/reports"`).
   *
   * Idempotent when the folder already exists (`created: false`, HTTP 200).
   * Throws {@link KbDirectoryConflictError} if a file occupies that path (409).
   *
   * Remove the folder with `kb.files.delete(result.placeholder_file_id)`.
   */
  mkdir(directory: string): Promise<KbDirectoryCreateResult> {
    return createKbDirectory(this.apiClient, this.kbId, directory);
  }
}
