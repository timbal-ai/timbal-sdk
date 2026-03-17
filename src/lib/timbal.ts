import type {
  TimbalConfig,
  File,
  Session,
  QueryResult,
  QueryOptions,
  FileOptions,
  WorkforceContext,
  WorkforceItem,
  PlatformConfig,
  OAuthProvider,
  TokenPair,
  Project,
} from '../types';
import { ApiClient } from './api';
import {
  query as queryFn,
  uploadFile as uploadFileFn,
  uploadFileFromBuffer as uploadFileFromBufferFn,
  getSession as getSessionFn,
  getProject as getProjectFn,
  getOAuthUrl as getOAuthUrlFn,
  sendMagicLink as sendMagicLinkFn,
  refreshToken as refreshTokenFn,
  listWorkforces as listWorkforcesFn,
  callWorkforce as callWorkforceFn,
  streamWorkforce as streamWorkforceFn,
  clearDeploymentCache as clearDeploymentCacheFn,
} from './functions';

export class Timbal {
  private apiClient: ApiClient;

  constructor(config: TimbalConfig = {}) {
    this.apiClient = new ApiClient(config);
  }

  /**
   * Create a scoped client. Accepts a token string or a config object.
   */
  as(tokenOrConfig: string | Partial<TimbalConfig>): Timbal {
    const override = typeof tokenOrConfig === 'string'
      ? { token: tokenOrConfig }
      : tokenOrConfig;
    return new Timbal({ ...this.apiClient.getConfig(), ...override });
  }

  /**
   * Get the underlying API client for custom requests.
   */
  getApiClient(): ApiClient {
    return this.apiClient;
  }

  // ── Project ──

  async getProject(orgId?: string, projectId?: string): Promise<Project> {
    return getProjectFn(this.apiClient, orgId, projectId);
  }

  // ── Auth ──

  getOAuthUrl(provider: OAuthProvider, redirectUri: string): string {
    return getOAuthUrlFn(this.apiClient, provider, redirectUri);
  }

  async sendMagicLink(email: string, redirectUri: string): Promise<void> {
    return sendMagicLinkFn(this.apiClient, email, redirectUri);
  }

  async refreshToken(refreshToken: string): Promise<TokenPair> {
    return refreshTokenFn(this.apiClient, refreshToken);
  }

  // ── Session ──

  async getSession(): Promise<Session> {
    return getSessionFn(this.apiClient);
  }

  // ── Query ──

  async query(sql: string, params?: unknown[], options?: QueryOptions): Promise<QueryResult[]> {
    return queryFn(this.apiClient, sql, params, options);
  }

  // ── Files ──

  async uploadFile(filePath: string, options?: FileOptions): Promise<File> {
    return uploadFileFn(this.apiClient, filePath, options);
  }

  async uploadFileFromBuffer(
    data: ArrayBuffer | Uint8Array,
    filename: string,
    contentType?: string,
    options?: FileOptions
  ): Promise<File> {
    return uploadFileFromBufferFn(this.apiClient, data, filename, contentType, options);
  }

  // ── Workforce ──

  async listWorkforces(ctx?: WorkforceContext, workforceDir?: string): Promise<WorkforceItem[]> {
    return listWorkforcesFn(this.apiClient, ctx, workforceDir);
  }

  async callWorkforce(
    manifestId: string,
    input?: Record<string, unknown>,
    ctx?: WorkforceContext,
    platformConfig?: PlatformConfig
  ): Promise<Response> {
    return callWorkforceFn(this.apiClient, manifestId, input, ctx, platformConfig);
  }

  async streamWorkforce(
    manifestId: string,
    input?: Record<string, unknown>,
    ctx?: WorkforceContext,
    platformConfig?: PlatformConfig
  ): Promise<Response> {
    return streamWorkforceFn(this.apiClient, manifestId, input, ctx, platformConfig);
  }

  clearDeploymentCache(): void {
    clearDeploymentCacheFn();
  }
}
