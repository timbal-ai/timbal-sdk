// ── Config ──

export interface ClientConfig {
  baseUrl?: string;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
}

export interface TimbalConfig extends ClientConfig {
  token?: string;
  orgId?: string;
  projectId?: string;
  rev?: string;
  kbId?: string;
}

// ── API ──

export interface ApiResponse<T = unknown> {
  data: T;
  success: boolean;
  message?: string;
  error?: string;
  statusCode: number;
}

export interface ApiError {
  message: string;
  statusCode: number;
  code?: string;
  details?: Record<string, unknown>;
}

// ── Session ──

export interface Session {
  user_id: string;
  user_name: string;
  user_email: string;
  user_photo_url: string | null;
  user_phone: string | null;
  user_lang: string;
  access_level: string;
}

// ── Context ──

export interface PlatformContext {
  orgId?: string;
  projectId?: string;
  rev?: string;
  /** Optional parent run id. Only emitted in studio-mode codegen requests as `args.context.parent_id`. */
  parentId?: string;
}

// ── Query ──

export interface QueryOptions {
  orgId?: string;
  kbId?: string;
  /** Set to true to query a legacy knowledge base. Defaults to false (K2). */
  legacy?: boolean;
  /** Runs `EXPLAIN ANALYZE` and includes the query plan in the response. */
  explain?: boolean;
}

export interface QueryRow {
  [key: string]: unknown;
}

export interface QueryResult {
  rows: QueryRow[];
  [key: string]: unknown;
}

// ── Files ──
//
// IDs are typed as `string` for consistency with the rest of the SDK (KB IDs,
// file IDs, etc.). The server serializes `int64` IDs as JSON numbers on this
// endpoint, but the SDK coerces them to `string` at the boundary so callers
// don't have to think about precision loss or type drift across resources.

/**
 * Long-lived org-bucket file. Returned by the legacy `POST /orgs/{org}/files`
 * route.
 *
 * @deprecated Prefer {@link TempFile} for short-lived attachments
 * (`timbal.uploadTempFile`) or a Knowledge Base file
 * (`timbal.kbs.get(id).files.upload`) for long-lived, parsed, searchable
 * storage. The org-bucket endpoint is undocumented and may be removed.
 */
export interface File {
  id: string;
  name: string;
  content_type: string;
  content_length: number;
  created_at: string;
  expires_at?: string | null;
  url: string;
}

/**
 * Stateless temporary file metadata returned by `POST /files`.
 *
 * Stored under a `tmp/` prefix in object storage and removed by a storage
 * lifecycle policy ~24h after upload. **No database row is created** — there
 * is no `id`; clients must persist `url` / `name` themselves if they need to
 * track it. Treat a 404 from `url` as "expired".
 *
 * Use for short-lived binary handoff to agents and workflows. For durable
 * storage with parsing + embedding, use `kb.files.upload` instead.
 */
export interface TempFile {
  name: string;
  content_type: string;
  content_length: number;
  url: string;
  created_at: string;
  /** Advisory expiration (~24h after upload). Storage lifecycle may lag by up to a day. */
  expires_at: string;
}

// ── Knowledge Base ──
//
// IDs (`KbInfo.id`, `K2File.id`, `K2File.kb_id`) are typed as `string` because
// the platform serializes `int64` as JSON strings for JS precision safety,
// even though the OpenAPI spec lists them as `integer`. Treat IDs as opaque
// strings; the SDK accepts `string | number` on input and passes through.

export interface KbInfo {
  id: string;
  uid: string;
  name: string;
  description?: string | null;
  data_size_bytes?: number | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/** Response shape of `GET /orgs/{org}/k2` (`ListK2Response` in the OpenAPI spec). */
export interface KbInfoPage {
  k2: KbInfo[];
  next_page_token?: string | null;
}

// ── Schema ──

export type TableSource = 'primary' | 'vectors' | (string & {});

export type ConstraintType =
  | 'PRIMARY_KEY'
  | 'UNIQUE'
  | 'FOREIGN_KEY'
  | 'CHECK'
  | 'NOT_NULL'
  | (string & {});

export interface ForeignKey {
  column: string;
  ref_table: string;
  ref_column: string;
}

export interface TableConstraint {
  constraint_type: ConstraintType;
  /** Columns involved (for PK, UNIQUE, NOT_NULL). Empty for CHECK. */
  columns?: string[];
  /** CHECK expression, if applicable. */
  expression?: string | null;
  /** Foreign key references, if applicable. */
  foreign_keys?: ForeignKey[];
}

export interface TableIndex {
  name: string;
  table_name: string;
  columns: string[];
  is_unique: boolean;
}

export interface TableSchemaColumn {
  name: string;
  data_type: string;
  is_nullable: boolean;
}

export interface TableSchema {
  name: string;
  source: TableSource;
  /** Schema namespace (e.g. "main"). */
  schema?: string | null;
  columns: TableSchemaColumn[];
  indexes: TableIndex[];
  constraints: TableConstraint[];
  estimated_row_count: number;
}

// ── Files ──

/**
 * A file (or virtual directory) stored inside a Knowledge Base (K2).
 *
 * Distinct from {@link File} (org bucket) — KB files carry `kb_id`, `metadata`,
 * `directory`, and a `parse_state` set by the platform's parse + embed pipeline.
 *
 * `kb.files.list` returns both regular files **and** virtual directories. Folder
 * rows have `content_type` `application/vnd.timbal.k2-directory` and
 * `content_length: 0`.
 */
export interface K2File {
  id: string;
  uid: string;
  kb_id: string;
  name: string;
  content_type: string;
  content_length: number;
  /**
   * `pending` — pipeline in flight.
   * `success` — parse + embed both completed.
   * `failed` — latest attempt failed.
   * `skipped` — format unsupported (never parsed) or `parse: false` was passed.
   */
  parse_state: 'pending' | 'success' | 'failed' | 'skipped' | (string & {});
  metadata: Record<string, unknown>;
  directory?: string | null;
  url: string;
  created_at: string;
  updated_at: string;
}

export interface K2FileParsing {
  id: string;
  kb_file_id: string;
  provider: string;
  status: string;
  num_pages?: number | null;
  chunk_count?: number | null;
  cost_usd?: number | null;
  error?: string | null;
  provider_job_id?: string | null;
  s3_bucket?: string | null;
  s3_key?: string | null;
  created_at: string;
  updated_at: string;
}

export interface K2FileEmbedding {
  id: string;
  kb_file_id: string;
  provider: string;
  model: string;
  status: string;
  parsing_id?: string | null;
  chunk_count?: number | null;
  token_count?: number | null;
  cost_usd?: number | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
}

/** Response shape of `kb.files.get(id)` — K2File extended with pipeline rows. */
export interface K2FileDetail extends K2File {
  parsings: K2FileParsing[];
  embeddings: K2FileEmbedding[];
}

export interface K2FilePage {
  files: K2File[];
  next_page_token?: string | null;
}

export interface KbFileUploadOptions {
  /** Free-form metadata persisted on the K2File row; filterable later. Defaults to `{}`. */
  metadata?: Record<string, unknown>;
  /** Virtual directory inside the KB to store the file under. */
  directory?: string;
  /**
   * Whether to run the parse + embed pipeline on upload.
   *
   * Not in the public OpenAPI spec but supported by the backend — passing
   * `parse: false` results in `parse_state: "skipped"`. Use for typed metadata
   * stores that won't be semantically searched.
   *
   * Defaults to the backend default (parse) when omitted.
   */
  parse?: boolean;
}

export interface KbFileListOptions {
  directory?: string;
  page_token?: string;
}

/** Response from `POST /orgs/{org}/k2/{kb}/directories`. */
export interface KbDirectoryCreateResult {
  directory: string;
  /** Listing id for the folder row — delete via `kb.files.delete(id)` to remove. */
  placeholder_file_id: string;
  /** `true` if created on this call; `false` if the folder already existed (200). */
  created: boolean;
}

export interface KbListOptions {
  page_token?: string;
}

export interface KbQueryOptions {
  /** Set to true to query a legacy knowledge base via `/kbs/{kbId}/query` instead of `/k2/...`. */
  legacy?: boolean;
  /** Runs `EXPLAIN ANALYZE` and includes the query plan in the response. */
  explain?: boolean;
}

/** `structured` (default) — tables + columns. `sql` — DDL statement strings. */
export type KbSchemaFormat = 'structured' | 'sql';

export interface KbSchemaStructuredOptions {
  format?: 'structured';
  orgId?: string;
}

export interface KbSchemaSqlOptions {
  format: 'sql';
  orgId?: string;
}

export type KbSchemaOptions = KbSchemaStructuredOptions | KbSchemaSqlOptions;

// ── Workforce ──

export type WorkforceType = 'agent' | 'workflow' | 'unknown';

export interface WorkforceItem {
  id?: string;
  uid?: string | null;
  type?: WorkforceType | string;
  name?: string;
  description?: string | null;
  /** Set only when list was queried with `rev` and the component has a running deployment on that branch. */
  url?: string | null;
  deleted_at?: number | null;
}

// ── Project ──

export interface WorkforcePreview {
  id: string;
  name: string;
  type: 'agent' | 'workflow';
  description: string | null;
  uid: string | null;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  has_ui: boolean;
  role: string;
  default_role: string | null;
  is_public_template: boolean;
  template_uses: number;
  publishable_api_key: string;
  /** Whether end users must authenticate to access this project. */
  auth_enabled: boolean;
  /**
   * Enabled sign-in methods (subset of {@link AuthProvider}).
   * Optional: older/cached platform responses may omit it — consumers should
   * default to all providers when `undefined`.
   */
  auth_providers?: AuthProvider[];
  repository_url: string | null;
  screenshot_url: string | null;
  /**
   * Messaging-channel bindings configured on the platform ("add Slack to
   * this component" in the UI). Optional: platform responses predating the
   * channels feature omit it — consumers fall back to env conventions.
   * Topology only (which channel → which component); credentials never
   * travel through project config.
   */
  channels?: ProjectChannelSpec[];
  created_at: number;
  updated_at: number;
  workforce: WorkforcePreview[];
}

/**
 * One platform-configured channel binding.
 * Webhook URL is derived as `/channels/{workforce}/{provider}` — the platform
 * canonicalizes `workforce` to the component's manifest uid on read.
 * Product rule: at most one enabled binding per `(workforce, provider)`.
 *
 * Two payloads carry this shape:
 * - `project.channels` (topology): never contains `credentials`; may carry
 *   `configured` so UIs can flag bindings whose secrets are missing.
 * - `GET .../channels/runtime` (service-principal only): includes
 *   `credentials` for platform-configured bindings.
 */
export interface ProjectChannelSpec {
  /** Channel provider id: 'telegram', 'slack', ... */
  provider: string;
  /** Workforce component the channel talks to (manifest uid on read). */
  workforce: string;
  /** Soft toggle from the platform UI. @default true */
  enabled?: boolean;
  /** Whether credentials are stored platform-side (topology payload only). */
  configured?: boolean;
  /** Provider-specific non-secret config (runtime payload). */
  config?: Record<string, unknown>;
  /**
   * Provider-specific secrets (runtime payload only; `null` when not
   * configured). Telegram: `{ token, secret_token? }`. Slack:
   * `{ bot_token, signing_secret }`. Hold in memory only; never log.
   */
  credentials?: Record<string, string> | null;
}

// ── Auth ──

/**
 * Sign-in methods surfaced on the login page.
 *
 * `google` | `microsoft` | `github` are OAuth providers (see {@link OAuthProvider},
 * handled by `/auth/:provider`). `email` is the magic-link flow — a user-visible
 * login option gated separately from the OAuth `:provider` route.
 */
export type AuthProvider = 'email' | 'google' | 'microsoft' | 'github';

export type OAuthProvider = 'github' | 'google' | 'microsoft';

export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

// ── Integrations ──
//
// Two-layer concept on the platform:
//   • **catalog** — providers the platform offers, with an `enabled` flag per
//     org (admin enables what their org can use). Returned by
//     `GET /integrations?org_id={id}` — the only piece implemented in this
//     pass.
//   • **connections** — actual wired-up rows (per-user OAuth tokens or shared
//     org credentials). Not yet modeled in the SDK.

export type IntegrationConnectionMode = 'user' | 'org';

/**
 * A single auth-method parameter the UI must collect from the user (for
 * `type: 'credentials'` methods). `oauth` methods don't carry parameters.
 *
 * `[key: string]: unknown` keeps the type forward-compat with backend additions
 * (e.g. new validation hints) without forcing an SDK release.
 */
export interface IntegrationAuthParameter {
  name: string;
  type: string;
  label: string;
  required: boolean;
  secret: boolean;
  readonly: boolean;
  multiline: boolean;
  default: unknown;
  placeholder: string | null;
  help?: string | null;
  url?: string | null;
  [key: string]: unknown;
}

export interface IntegrationAuthMethodCredentials {
  type: 'credentials';
  label?: string;
  parameters: IntegrationAuthParameter[];
}

export interface IntegrationAuthMethodOAuth {
  type: 'oauth';
  label?: string;
}

/** Discriminated by `type`. Backend may add new variants — fall through via the string-and-extends pattern. */
export type IntegrationAuthMethod =
  | IntegrationAuthMethodCredentials
  | IntegrationAuthMethodOAuth
  | { type: string; [key: string]: unknown };

/**
 * One row from the org-scoped catalog (`GET /integrations?org_id={id}`).
 *
 * `enabled` reflects whether **this org** has the provider turned on. The rest
 * is provider metadata served to every org.
 *
 * The `[key: string]: unknown` index signature is intentional: the platform
 * adds catalog fields more often than the SDK ships, and we'd rather pass
 * them through than swallow them.
 */
export interface IntegrationCatalogEntry {
  id: string;
  name: string;
  provider: string;
  description: string;
  logo_url: string;
  auth_methods: IntegrationAuthMethod[];
  tags: string[];
  /** e.g. `'free'`, `'enterprise'` — open string, backend may add tiers. */
  min_plan: string;
  /** e.g. `'public'`, `'private'` — open string. */
  visibility: string;
  enabled: boolean;
  [key: string]: unknown;
}

/**
 * Pagination envelope. The current backend returns a bare `{ integrations }`
 * object with no cursor, but the SDK threads `next_page_token` so a future
 * paginated rollout is transparent to callers.
 */
export interface IntegrationCatalogPage {
  integrations: IntegrationCatalogEntry[];
  next_page_token?: string | null;
}

export interface IntegrationCatalogListOptions {
  page_token?: string;
  orgId?: string;
}

/**
 * Response of `POST /orgs/{org}/integrations/enable`. The server returns a
 * minimal echo (`{ provider }`); call `list()` again if you need the full
 * catalog entry.
 */
export interface IntegrationEnableResult {
  provider: string;
}

/**
 * Response of `POST /orgs/{org}/integrations/disable`. Same `{ provider }`
 * echo as {@link IntegrationEnableResult}. Aliased rather than reused so a
 * future divergence in the wire shape stays a non-breaking change.
 */
export type IntegrationDisableResult = IntegrationEnableResult;

// ── Integration connections ────────────────────────────────────────────────
//
// Two completely separate types, two separate accessors
// (`timbal.integrations.shared` vs `timbal.integrations.personal`). Sharing
// nothing structural means it's impossible to pass a shared connection
// where a personal one is expected.

export type IntegrationAuthType = 'oauth' | 'credentials' | (string & {});

/**
 * Auth status of a connection row. `'active'` is the happy path; the others
 * appear on personal rows after a token has gone bad.
 */
export type IntegrationConnectionStatus =
  | 'active'
  | 'expired'
  | 'revoked'
  | (string & {});

/**
 * Shared (org-wide) connection — one row per provider the org wired up
 * centrally (admin-owned OAuth or credentials). Every caller in the org
 * vends the same token from this row. No `user` field — that's session-scoped
 * state only.
 */
export interface SharedConnection {
  id: string;
  /** Catalog id this connection is bound to (FK to {@link IntegrationCatalogEntry.id}). */
  integration_id: string;
  auth_type: IntegrationAuthType;
  connection_mode: 'org';
  /** Optional admin-set label (e.g. "Acme Slack"). */
  label: string | null;
  status: IntegrationConnectionStatus;
  integration_name: string;
  integration_provider: string;
  integration_logo_url: string;
  /**
   * Provider-shaped metadata (e.g. `account_name`, `team_id`, `scope`,
   * `token_type`). Open shape because contents vary per provider.
   */
  metadata: Record<string, unknown>;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/**
 * Personal account metadata reported on a *connected* personal row. Provider
 * fills in whatever it knows about the authenticated account.
 */
export interface PersonalAccountMetadata {
  account_email?: string;
  account_name?: string;
  account_picture?: string | null;
  [key: string]: unknown;
}

/**
 * Discriminated union by `connected`. Use `if (user.connected)` to narrow:
 * the connected branch exposes `metadata` and `expires_at`; the disconnected
 * branch optionally exposes a `status` like `'expired'` / `'revoked'` when a
 * prior connection has gone bad (absent for never-connected rows).
 */
export type PersonalUserState =
  | {
      connected: true;
      status: IntegrationConnectionStatus;
      expires_at: string | null;
      metadata: PersonalAccountMetadata;
    }
  | {
      connected: false;
      /** Present only when a prior connection went bad (`expired` / `revoked`). Absent for never-connected rows. */
      status?: IntegrationConnectionStatus;
      expires_at?: string | null;
    };

/**
 * Personal (per-caller-token) connection.
 *
 * The row's existence is session-scoped: a user sees a personal row if either
 * the provider is enabled in the catalog, *or* they already hold a token
 * (e.g. admin re-disabled the provider after they connected). The `user`
 * field always carries the caller's connection state.
 *
 * Top-level `metadata` / `expires_at` describe the *shell row*, not the
 * caller's token — that lives under `user.metadata` / `user.expires_at`.
 */
export interface PersonalConnection {
  id: string;
  /** Catalog id this connection is bound to (FK to {@link IntegrationCatalogEntry.id}). */
  integration_id: string;
  auth_type: IntegrationAuthType;
  connection_mode: 'user';
  label: string | null;
  status: IntegrationConnectionStatus;
  integration_name: string;
  integration_provider: string;
  integration_logo_url: string;
  /** Shell-row metadata. Caller's per-token metadata is under `user.metadata`. */
  metadata: Record<string, unknown>;
  /** Shell-row expiry. Caller's per-token expiry is under `user.expires_at`. */
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  /** Per-caller connection state. Always present on user-mode rows. */
  user: PersonalUserState;
  [key: string]: unknown;
}

export interface SharedConnectionPage {
  integrations: SharedConnection[];
  next_page_token?: string | null;
}

export interface PersonalConnectionPage {
  integrations: PersonalConnection[];
  next_page_token?: string | null;
}

export interface SharedConnectionListOptions {
  page_token?: string;
  orgId?: string;
}

export interface PersonalConnectionListOptions {
  page_token?: string;
  orgId?: string;
}

// ── Shared connect + vend ──────────────────────────────────────────────────

/**
 * Inputs for `shared.connectOAuth(opts)` — start an OAuth flow that will
 * land back on `redirect_uri` (defaults to
 * `https://app.timbal.ai/org/{org_id}/integrations` when omitted).
 *
 * `oauth_params` carries provider-specific upfront knobs. Shopify, for
 * example, needs `{ shop_url: "acme.myshopify.com" }` to construct the
 * provider's authorize URL.
 */
export interface SharedConnectOAuthOptions {
  provider: string;
  label?: string | null;
  redirect_uri?: string;
  oauth_params?: Record<string, unknown>;
}

/**
 * Inputs for `shared.connectCredentials(opts)` — synchronously create a
 * shared connection from a static credentials blob (api keys, etc.).
 *
 * `credentials` is whatever the provider's auth schema defines (commonly
 * `{ api_key: "..." }`, but providers can require multi-field shapes).
 */
export interface SharedConnectCredentialsOptions {
  provider: string;
  label?: string | null;
  credentials: Record<string, unknown>;
}

/**
 * Discriminated request union accepted by the raw `connectShared()`
 * function and the `POST /orgs/{org}/integrations/connect` endpoint.
 *
 * Prefer the typed sugar (`shared.connectOAuth` / `shared.connectCredentials`)
 * over building this manually unless you're driving connect dynamically
 * from the catalog.
 */
export type SharedConnectOptions =
  | ({ auth_type: 'oauth' } & SharedConnectOAuthOptions)
  | ({ auth_type: 'credentials' } & SharedConnectCredentialsOptions);

/**
 * OAuth `/connect` response — the provider's authorize URL. Browser → there
 * → callback → row appears in `shared.list()`. No id is returned here
 * because the row doesn't exist yet.
 */
export interface SharedConnectOAuthResult {
  result: 'oauth_redirect';
  redirect_url: string;
}

/**
 * Credentials `/connect` response — synchronous create, you get the row id
 * back and can vend immediately.
 */
export interface SharedConnectCredentialsResult {
  result: 'created';
  org_integration_id: string;
}

export type SharedConnectResult =
  | SharedConnectOAuthResult
  | SharedConnectCredentialsResult;

/**
 * Vended payload for a shared connection. Discriminated on `type` so
 * TypeScript narrows:
 *
 * ```ts
 * const v = await shared.get('10').token();
 * if (v.type === 'oauth') v.token;          // ya29.…
 * else v.api_key;                            // or whatever the schema says
 * ```
 *
 * Both branches carry `[key: string]: unknown` for provider-specific
 * extras (Shopify oauth adds `shop_url`, AWS credentials add `secret_…`,
 * etc.).
 */
export type SharedTokenVend =
  | {
      type: 'oauth';
      token: string;
      expires_at: string | null;
      [key: string]: unknown;
    }
  | {
      type: 'credentials';
      [key: string]: unknown;
    };

// ── Personal vend + consent ────────────────────────────────────────────────

/**
 * Vended token payload for a personal connection. Returned by `vend` /
 * `personal.get(id).token()` on success.
 *
 * For OAuth rows: `token` is the access token, `expires_at` is the access
 * token's expiry. Refresh is handled server-side — the SDK only sees fresh
 * tokens (or a 401 `consent_required` when refresh is impossible).
 *
 * `[key: string]: unknown` carries through any provider-specific fields the
 * backend adds later (e.g. credentials-mode auxiliary fields).
 */
export interface PersonalTokenVend {
  type: IntegrationAuthType;
  token: string;
  expires_at: string | null;
  [key: string]: unknown;
}

/**
 * Input for `personal.get(id).consent(...)` /
 * `personal.connect(provider, ...)`.
 *
 * `redirect_uri` must be allowlisted by the platform (typically
 * `*.timbal.ai`, org custom domains, or `localhost`). Non-allowlisted URIs
 * get a 400 from the backend.
 */
export interface PersonalConsentOptions {
  redirect_uri: string;
}

/**
 * Response of starting consent — the OAuth provider's authorize URL.
 *
 * Send the user's browser here. After the provider redirects them back
 * through `/oauth/callback/integrations`, they land on the `redirect_uri`
 * the caller supplied. Re-vend afterwards to pick up the token.
 */
export interface PersonalConsentResponse {
  redirect_url: string;
}

/**
 * Tagged-union result of `personal.get(id).use(...)` /
 * `personal.connect(provider, ...)`. No exceptions for the not-connected
 * case — the SDK catches `IntegrationConsentRequiredError` internally and
 * surfaces it as `{ connected: false, redirect_url }`.
 *
 * `redirect_url` here is the same browser URL returned by
 * `PersonalConsentResponse` — distinct from the API endpoint URL exposed on
 * `IntegrationConsentRequiredError.consentUrl`.
 */
export type PersonalUseResult =
  | { connected: true; token: PersonalTokenVend }
  | { connected: false; redirect_url: string };

// ── Messages ──

export type MessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface BaseContent {
  type: string;
}

export interface TextContent extends BaseContent {
  type: 'text';
  text: string;
}

export interface ThinkingContent extends BaseContent {
  type: 'thinking';
  thinking: string;
}

export interface ToolUseContent extends BaseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent extends BaseContent {
  type: 'tool_result';
  id: string;
  content: (TextContent | ThinkingContent | FileContent)[];
}

export interface FileContent extends BaseContent {
  type: 'file';
  file: string;
}

export type MessageContent =
  | TextContent
  | ThinkingContent
  | ToolUseContent
  | ToolResultContent
  | FileContent;

export interface Message {
  role: MessageRole;
  content: MessageContent[];
}

// ── Tool proxy ──
//
// The execution plane that complements `integrations` (the credential plane).
// Framework tools (`krea_generate_image`, `firecrawl_scrape`, …) are registered
// server-side and executed via `POST /orgs/{org}/proxies/v1/tools/{name}` — the
// platform resolves the provider connection and injects credentials, so they
// never leave the platform. `provider` is the join key back to `integrations`.

/**
 * A JSON Schema object (Draft 2020-12 subset). Deliberately loose — it's the
 * provider/handler's parameter schema as emitted server-side (from the Python
 * pydantic model), forwarded verbatim to LLM function-calling specs.
 */
export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema | JSONSchema[];
  required?: string[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
  [key: string]: unknown;
}

/** Per-call options for tool-proxy execution. */
export interface ToolRunOptions {
  /** Override the org (defaults to client config / `TIMBAL_ORG_ID`). */
  orgId?: string;
  /**
   * Pin execution to a specific integration connection row. Opaque to the
   * SDK — forwarded to the backend, which owns connection-resolution policy.
   * Agents never set this; UI/admin flows can to disambiguate when both a
   * shared and personal connection exist for the provider.
   */
  connectionId?: string;
  /** Abort signal — proxy calls have no client-side timeout (tools can be long-running). */
  signal?: AbortSignal;
  /** Trace-correlation id forwarded as `x-timbal-run-id`. */
  runId?: string;
  /** Trace-correlation id forwarded as `x-timbal-call-id`. */
  callId?: string;
}

/**
 * One entry in the tool manifest **list**
 * (`GET /orgs/{org}/proxies/v1/tools` → `{ version, tools: RemoteToolSpec[] }`).
 *
 * This is the lightweight registry row — rich metadata but **no parameter
 * schema** (that lives in the per-tool detail, {@link RemoteToolDetail}).
 */
export interface RemoteToolSpec {
  /** Snake_case wire name the model calls (e.g. `krea_generate_image`). */
  name: string;
  /** Provider this tool is backed by — join key to `integrations`. */
  provider?: string | null;
  description?: string;
  provider_logo?: string | null;
  /** PascalCase class name of the backing framework tool (e.g. `KreaGenerateImage`). */
  class_name?: string;
  /** Python module the tool lives in (e.g. `timbal.tools`). */
  module?: string;
  /** Whether the tool is currently usable for this org/caller. */
  available?: boolean;
  /** How the tool runs — `"proxy"` for platform-executed framework tools. */
  execution?: string;
  /** Whether the tool can run on an org service account (no per-user connection). */
  service_account_eligible?: boolean;
  /** Connection status string, e.g. `"service_account_unavailable"`, `"connected"`. */
  connection?: string;
}

/**
 * Per-tool detail (`GET /orgs/{org}/proxies/v1/tools/{name}`) — adds the
 * parameter JSON Schema (`params`) and output schema that the list omits.
 */
export interface RemoteToolDetail {
  tool: string;
  provider?: string | null;
  version?: string;
  class_name?: string;
  module?: string;
  description?: string;
  /** Handler input JSON Schema. */
  params: JSONSchema;
  /** Handler output schema (may be empty `{}` today). */
  output?: JSONSchema;
}

/** Manifest list envelope (`{ version, tools }`). */
export interface RawToolManifest {
  version?: string;
  tools: RemoteToolSpec[];
}

/** OpenAI function-tool spec (`tools: [...]` in chat completions). */
export interface OpenAIToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

/** Anthropic tool spec (`tools: [...]` in the Messages API). */
export interface AnthropicToolSpec {
  name: string;
  description: string;
  input_schema: JSONSchema;
}

export type ToolSpecFormat = 'openai' | 'anthropic';
