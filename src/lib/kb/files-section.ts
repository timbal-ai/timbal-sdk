import type { ApiClient } from '../api';
import type {
  K2File,
  K2FileDetail,
  K2FilePage,
  KbFileListOptions,
  KbFileUploadOptions,
} from '../../types';
import {
  uploadKbFile,
  listKbFiles,
  getKbFile,
  deleteKbFile,
} from '../functions/kb';

/**
 * Files inside a Knowledge Base. Reached via `kb.files`.
 *
 * Maps 1:1 to `/orgs/{org}/k2/{kb}/files` and its sub-resources.
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
   * `next_page_token` to paginate. Auto-pagination iterator deferred to v0.9.
   */
  list(options?: KbFileListOptions): Promise<K2FilePage> {
    return listKbFiles(this.apiClient, this.kbId, options);
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
}
