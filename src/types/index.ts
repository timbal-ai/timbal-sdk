export interface TimbalConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
}

export interface ApiResponse<T = any> {
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
  details?: Record<string, any>;
}

export interface Column {
  name: string;
  dataType: string;
  defaultValue?: string | null;
  isNullable: boolean;
  isUnique: boolean;
  isPrimary: boolean;
  comment?: string | null;
}

export interface Table {
  name: string;
  columns: Column[];
  comment?: string | null;
  constraints: any[];
}

export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface BaseContent {
  type: string;
}

export interface TextContent extends BaseContent {
  type: "text";
  text: string;
}

export interface ThinkingContent extends BaseContent {
  type: "thinking";
  thinking: string;
}

export interface ToolUseContent extends BaseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ToolResultContent extends BaseContent {
  type: "tool_result";
  id: string;
  content: (TextContent | ThinkingContent | FileContent)[];
}

export interface FileContent extends BaseContent {
  type: "file";
  file: string; // Will always be a url or data url
}

export type MessageContent = TextContent | ThinkingContent | ToolUseContent | ToolResultContent | FileContent;

export interface Message {
  role: MessageRole;
  content: MessageContent[];
}
