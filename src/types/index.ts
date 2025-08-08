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