import type { ApiClient } from '../api';
import type { AppRunRequest, AppRunResponse } from '../../types';

export interface AppOptions {
  orgId?: string;
}

export class AppService {
  private defaultOrgId?: string;

  constructor(
    private apiClient: ApiClient,
    defaults: AppOptions = {}
  ) {
    this.defaultOrgId = defaults.orgId;
  }

  /**
   * Call an app to run on the platform.
   *
   * @param options App run parameters (orgId, appId, request data)
   * @returns The app run response
   */
  async runApp(options: {
    orgId?: string;
    appId: string;
    version_id?: string;
    input: Record<string, any>;
    group_id?: string;
    parent_id?: string;
  }): Promise<AppRunResponse> {
    const orgId = this.resolveDefault('orgId', options.orgId);

    if (!orgId) {
      throw new Error('orgId is required. Provide it in the method call or set a default.');
    }
    if (!options.appId) {
      throw new Error('appId is required.');
    }
    if (!options.input || Object.keys(options.input).length === 0) {
      throw new Error('input is required.');
    }

    const path = `orgs/${orgId}/apps/${options.appId}/runs/collect`;
    const payload: AppRunRequest = {
      input: options.input,
    };

    // Add optional parameters
    if (options.version_id) {
      payload.version_id = options.version_id;
    }
    if (options.group_id) {
      payload.group_id = options.group_id;
    }
    if (options.parent_id) {
      payload.parent_id = options.parent_id;
    }

    const response = await this.apiClient.post<AppRunResponse>(path, payload);
    return response.data;
  }

  /**
   * Convenience method for running an app with positional parameters
   */
  async runAppByParams(
    orgId: string,
    appId: string,
    input: Record<string, any>,
    version_id?: string,
    group_id?: string,
    parent_id?: string
  ): Promise<AppRunResponse> {
    return this.runApp({
      orgId,
      appId,
      input,
      version_id,
      group_id,
      parent_id,
    });
  }

  /**
   * Set default values for future app operations
   */
  setDefaults(defaults: AppOptions): void {
    if (defaults.orgId !== undefined) this.defaultOrgId = defaults.orgId;
  }

  /**
   * Get current default values
   */
  getDefaults(): AppOptions {
    return {
      orgId: this.defaultOrgId,
    };
  }

  private resolveDefault(key: keyof AppOptions, value?: string): string | undefined {
    if (value !== undefined) return value;

    switch (key) {
      case 'orgId':
        return this.defaultOrgId;
      default:
        return undefined;
    }
  }
}