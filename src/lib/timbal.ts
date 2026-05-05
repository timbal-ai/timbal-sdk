import type {
  TimbalConfig,
  File,
  Session,
  QueryResult,
  QueryRow,
  QueryOptions,
  PlatformContext,
  WorkforceItem,
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
  clearWorkforceCache as clearWorkforceCacheFn,
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

  async getProject(ctx?: PlatformContext): Promise<Project> {
    return getProjectFn(this.apiClient, ctx);
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

  async getSession(): Promise<Session>;
  async getSession(opts: { projectId: string | number }): Promise<{ session: Session; project: Project }>;
  async getSession(opts?: { projectId?: string | number }): Promise<Session | { session: Session; project: Project }> {
    return getSessionFn(this.apiClient, opts as any);
  }

  // ── Query ──

  async query(sql: string, params?: unknown[], ctx?: QueryOptions): Promise<QueryResult> {
    return queryFn(this.apiClient, sql, params, ctx);
  }

  // ── Files ──

  async uploadFile(filePath: string, ctx?: PlatformContext): Promise<File> {
    return uploadFileFn(this.apiClient, filePath, ctx);
  }

  async uploadFileFromBuffer(
    data: ArrayBuffer | Uint8Array,
    filename: string,
    contentType?: string,
    ctx?: PlatformContext
  ): Promise<File> {
    return uploadFileFromBufferFn(this.apiClient, data, filename, contentType, ctx);
  }

  // ── Workforce ──

  async listWorkforces(ctx?: PlatformContext): Promise<WorkforceItem[]> {
    return listWorkforcesFn(this.apiClient, ctx);
  }

  async callWorkforce(
    identifier: string,
    input?: Record<string, unknown>,
    ctx?: PlatformContext,
  ): Promise<Response> {
    return callWorkforceFn(this.apiClient, identifier, input, ctx);
  }

  async streamWorkforce(
    identifier: string,
    input?: Record<string, unknown>,
    ctx?: PlatformContext,
  ): Promise<Response> {
    return streamWorkforceFn(this.apiClient, identifier, input, ctx);
  }

  clearWorkforceCache(): void {
    clearWorkforceCacheFn();
  }
}
