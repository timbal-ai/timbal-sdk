import type {
  TimbalConfig,
  File,
  TempFile,
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
import { KbsSection } from './kb';
import {
  query as queryFn,
  uploadTempFile as uploadTempFileFn,
  uploadTempFileFromBuffer as uploadTempFileFromBufferFn,
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
  /**
   * The underlying API client. Public as of v0.8 — committed as part of the
   * semver-stable surface so power users can build their own typed wrappers
   * (e.g. `new KB(timbal.apiClient, kbId)`).
   */
  public readonly apiClient: ApiClient;

  private _kbs?: KbsSection;

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
   * @deprecated Use the `apiClient` field directly. Kept for backward compat.
   */
  getApiClient(): ApiClient {
    return this.apiClient;
  }

  // ── KB collection (Stripe-style) ──

  /**
   * Knowledge Base collection accessor.
   *
   * - `timbal.kbs.list()` — list KBs in the org
   * - `timbal.kbs.get(kbId)` — sync, returns a scoped `KB` view (no network call)
   *
   * Lazy singleton on this `Timbal` instance.
   */
  get kbs(): KbsSection {
    if (!this._kbs) this._kbs = new KbsSection(this.apiClient);
    return this._kbs;
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

  /**
   * Upload a temporary file from a local path.
   *
   * Hits the documented stateless `POST /files` route. Returns a
   * {@link TempFile} with a short-lived URL (~24h). Not org-scoped, no DB
   * row. Use for one-shot binary handoff to agents/workflows; use
   * `kbs.get(id).files.upload(...)` for durable, parsed, searchable storage.
   */
  async uploadTempFile(filePath: string): Promise<TempFile> {
    return uploadTempFileFn(this.apiClient, filePath);
  }

  /**
   * Upload a temporary file from an in-memory buffer.
   * See {@link uploadTempFile} for semantics.
   */
  async uploadTempFileFromBuffer(
    data: ArrayBuffer | Uint8Array,
    filename: string,
    contentType?: string,
  ): Promise<TempFile> {
    return uploadTempFileFromBufferFn(this.apiClient, data, filename, contentType);
  }

  /**
   * @deprecated Use {@link uploadTempFile} for short-lived attachments or
   * `timbal.kbs.get(kbId).files.upload(...)` for durable storage. The
   * org-bucket route is undocumented and slated for removal.
   */
  async uploadFile(filePath: string, ctx?: PlatformContext): Promise<File> {
    return uploadFileFn(this.apiClient, filePath, ctx);
  }

  /**
   * @deprecated See {@link uploadFile}.
   */
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
