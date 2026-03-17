// ── Config ──

export interface ClientConfig {
  baseUrl?: string;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
}

export interface TimbalConfig extends ClientConfig {
  token?: string;
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

// ── Query ──

export interface QueryResult {
  [key: string]: unknown;
}

export interface QueryOptions {
  orgId?: string;
  kbId?: string;
}

// ── Files ──

export interface File {
  id: number;
  name: string;
  content_type: string;
  content_length: number;
  created_at: string;
  expires_at?: string | null;
  url: string;
}

export interface FileOptions {
  orgId?: string;
}

// ── Workforce ──

export interface WorkforceContext {
  orgId?: string;
  projectId?: string;
  projectEnvId?: string;
}

export interface WorkforceItem {
  id: string;
}

export interface PlatformConfig {
  host: string;
  auth: {
    type: string;
    token: string;
  };
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
