import type { ApiClient } from '../api';
import type { File } from '../../types';

export interface FileOptions {
  orgId?: string;
}

export class FileService {
  private defaultOrgId?: string;

  constructor(
    private apiClient: ApiClient,
    defaults: FileOptions = {}
  ) {
    this.defaultOrgId = defaults.orgId;
  }

  /**
   * Upload a file to an organization.
   *
   * @param options Upload options containing orgId and filePath
   * @returns Promise resolving to the uploaded File object
   */
  async uploadFile(options: { orgId?: string; filePath: string }): Promise<File> {
    const orgId = this.resolveDefault('orgId', options.orgId);

    if (!orgId) {
      throw new Error('orgId is required. Provide it in the method call or set a default.');
    }
    if (!options.filePath) {
      throw new Error('filePath is required.');
    }

    const path = `orgs/${orgId}/files`;

    // Read the file
    const file = Bun.file(options.filePath);

    // Get file stats
    const fileExists = await file.exists();
    if (!fileExists) {
      throw new Error(`File not found: ${options.filePath}`);
    }

    const fileName = options.filePath.split('/').pop() || 'unknown';
    const fileBuffer = await file.arrayBuffer();
    const contentType = file.type || 'application/octet-stream';

    // Create FormData for multipart upload
    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: contentType });
    formData.append('file', blob, fileName);

    const response = await this.apiClient.postFormData<File>(path, formData);
    return response.data;
  }

  /**
   * Upload a file with positional parameters
   */
  async uploadFileByParams(orgId: string, filePath: string): Promise<File> {
    return this.uploadFile({ orgId, filePath });
  }

  /**
   * Upload a file from a Buffer or Uint8Array with custom filename
   *
   * @param options Upload options containing orgId, data, filename, and contentType
   * @returns Promise resolving to the uploaded File object
   */
  async uploadFileFromBuffer(options: {
    orgId?: string;
    data: ArrayBuffer | Uint8Array;
    filename: string;
    contentType?: string;
  }): Promise<File> {
    const orgId = this.resolveDefault('orgId', options.orgId);

    if (!orgId) {
      throw new Error('orgId is required. Provide it in the method call or set a default.');
    }
    if (!options.data) {
      throw new Error('data is required.');
    }
    if (!options.filename) {
      throw new Error('filename is required.');
    }

    const path = `orgs/${orgId}/files`;
    const contentType = options.contentType || 'application/octet-stream';

    // Create FormData for multipart upload
    const formData = new FormData();
    const blob = new Blob([options.data], { type: contentType });
    formData.append('file', blob, options.filename);

    const response = await this.apiClient.postFormData<File>(path, formData);
    return response.data;
  }

  /**
   * Set default values for future file operations
   */
  setDefaults(defaults: FileOptions): void {
    if (defaults.orgId !== undefined) this.defaultOrgId = defaults.orgId;
  }

  /**
   * Get current default values
   */
  getDefaults(): FileOptions {
    return {
      orgId: this.defaultOrgId,
    };
  }

  private resolveDefault(key: keyof FileOptions, value?: string): string | undefined {
    if (value !== undefined) return value;

    switch (key) {
      case 'orgId':
        return this.defaultOrgId;
      default:
        return undefined;
    }
  }
}
