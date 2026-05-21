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
  use_platform_iam: boolean;
  repository_url: string | null;
  screenshot_url: string | null;
  created_at: number;
  updated_at: number;
  workforce: WorkforcePreview[];
}

// ── Auth ──

export type OAuthProvider = 'github' | 'google' | 'microsoft';

export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

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
