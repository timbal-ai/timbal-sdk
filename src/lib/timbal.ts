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
import { WorkforceSection } from './workforce';
import { IntegrationsSection } from './integrations';
import { ToolsSection } from './tools';
import { ContentSection } from './content';
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
  private _workforce?: WorkforceSection;
  private _integrations?: IntegrationsSection;
  private _tools?: ToolsSection;
  private _content?: ContentSection;

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
   * - `timbal.kbs.list()` — first page of KBs in the org
   * - `timbal.kbs.listAll()` — every KB (all pages, in memory)
   * - `timbal.kbs.listPage()` / `timbal.kbs.iterate()` — manual / streaming pagination
   * - `timbal.kbs.get(kbId)` — sync, returns a scoped `KB` view (no network call)
   *
   * Lazy singleton on this `Timbal` instance.
   */
  get kbs(): KbsSection {
    if (!this._kbs) this._kbs = new KbsSection(this.apiClient);
    return this._kbs;
  }

  // ── Workforce (Stripe-style) ──

  /**
   * Workforce accessor. Singular because "workforce" is the collection noun
   * in Timbal — it holds agents, workflows, and tools.
   *
   * - `timbal.workforce.list()` — list components in the project
   * - `timbal.workforce.get(identifier)` — sync, returns a scoped `Workforce` view
   * - `timbal.workforce.clearCache()` — invalidate the per-rev list cache
   *
   * Lazy singleton on this `Timbal` instance.
   */
  get workforce(): WorkforceSection {
    if (!this._workforce) this._workforce = new WorkforceSection(this.apiClient);
    return this._workforce;
  }

  // ── Integrations (Stripe-style) ──

  /**
   * Integrations accessor. Two-layer concept on the platform:
   *
   * - `timbal.integrations.catalog` — providers the org may use
   *   (`list`, `listAll`, `iterate`, `listPage`, `enable`, `isEnabled`).
   *
   * Per-user / per-org **connections** (consent + token vending) will hang
   * off this same accessor in a follow-up.
   *
   * Lazy singleton on this `Timbal` instance.
   */
  get integrations(): IntegrationsSection {
    if (!this._integrations) this._integrations = new IntegrationsSection(this.apiClient);
    return this._integrations;
  }

  // ── Tools (execution plane) ──

  /**
   * Framework-tool execution plane — the complement to {@link integrations}
   * (the credential plane). Tools are the *actions* an agent runs; they're
   * executed via the platform proxy with credentials that never leave the
   * platform. A tool's `provider` joins back to `integrations`.
   *
   * - `timbal.tools.run(name, input)` — fire a tool by name
   * - `timbal.tools.list()` / `get(name)` — declarative descriptors + schemas
   * - `timbal.tools.specs({ format })` — OpenAI/Anthropic function-tool specs
   * - `timbal.tools.dispatch(toolUse)` — model `tool_use` → `tool_result`
   *
   * Lazy singleton on this `Timbal` instance.
   */
  get tools(): ToolsSection {
    if (!this._tools) this._tools = new ToolsSection(this.apiClient);
    return this._tools;
  }

  // ── Content (signed URLs) ──

  /**
   * Stored-content URL accessor. Content URLs returned by the platform are
   * CloudFront-signed (`Expires`/`Signature`/`Key-Pair-Id`/`Hash-Algorithm`
   * query params) and go stale — this section re-signs them via
   * `POST /orgs/{org}/content/sign` and inspects their signing params locally.
   *
   * - `timbal.content.sign(url)` — mint a fresh `{ signed_url, url }` pair
   * - `timbal.content.refresh(url)` — always re-sign; returns the usable URL string
   * - `timbal.content.ensureFresh(url)` — re-sign only when expired / near expiry
   * - `timbal.content.parse(url)` / `.isExpired(url)` — local inspection, no network
   *
   * Minted URLs are memoized per `(org, object path)` until their own expiry;
   * invalidate with `timbal.content.clearCache()`.
   *
   * Lazy singleton on this `Timbal` instance.
   */
  get content(): ContentSection {
    if (!this._content) this._content = new ContentSection(this.apiClient);
    return this._content;
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

  /** @deprecated Use `timbal.workforce.list(ctx?)`. */
  async listWorkforces(ctx?: PlatformContext): Promise<WorkforceItem[]> {
    return listWorkforcesFn(this.apiClient, ctx);
  }

  /** @deprecated Use `timbal.workforce.get(identifier).call(input, ctx?)`. */
  async callWorkforce(
    identifier: string,
    input?: Record<string, unknown>,
    ctx?: PlatformContext,
  ): Promise<Response> {
    return callWorkforceFn(this.apiClient, identifier, input, ctx);
  }

  /**
   * @deprecated Use `timbal.workforce.get(identifier).stream(input, ctx?)`
   * for the raw `Response`, or `.events(input, ctx?)` for a typed async
   * iterator over parsed SSE payloads.
   */
  async streamWorkforce(
    identifier: string,
    input?: Record<string, unknown>,
    ctx?: PlatformContext,
  ): Promise<Response> {
    return streamWorkforceFn(this.apiClient, identifier, input, ctx);
  }

  /** @deprecated Use `timbal.workforce.clearCache()`. */
  clearWorkforceCache(): void {
    clearWorkforceCacheFn();
  }
}
