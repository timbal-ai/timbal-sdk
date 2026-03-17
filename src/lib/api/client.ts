import type { TimbalConfig, ApiResponse, ApiError } from '../../types';
import { DEFAULT_CONFIG, ERROR_CODES } from '../../constants';
import { sleep, buildQueryString } from '../utils';

export class TimbalApiError extends Error {
  public statusCode: number;
  public code?: string;
  public details?: Record<string, unknown>;

  constructor(message: string, statusCode: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TimbalApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ApiClient {
  private config: Required<TimbalConfig>;

  constructor(config: TimbalConfig) {
    this.config = {
      baseUrl: config.baseUrl ?? DEFAULT_CONFIG.baseUrl,
      timeout: config.timeout ?? DEFAULT_CONFIG.timeout,
      retryAttempts: config.retryAttempts ?? DEFAULT_CONFIG.retryAttempts,
      retryDelay: config.retryDelay ?? DEFAULT_CONFIG.retryDelay,
      token: config.token ?? '',
    };
  }

  private async makeRequest<T>(
    endpoint: string,
    options: RequestInit = {},
    retryCount = 0
  ): Promise<ApiResponse<T>> {
    // Validate auth at request time (allows factory pattern)
    if (!this.config.token) {
      throw new TimbalApiError(
        'Authentication required: provide a token',
        0,
        ERROR_CODES.AUTH_ERROR
      );
    }

    // Ensure proper URL construction with single slash
    const baseUrl = this.config.baseUrl.endsWith('/')
      ? this.config.baseUrl.slice(0, -1)
      : this.config.baseUrl;
    const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = `${baseUrl}${path}`;

    // Build headers - don't set Content-Type by default, let the browser/runtime handle it for FormData
    const headers = new Headers();

    headers.set('Authorization', `Bearer ${this.config.token}`);

    // Add custom headers from options
    if (options.headers) {
      const optHeaders =
        options.headers instanceof Headers
          ? options.headers
          : new Headers(options.headers as Record<string, string>);

      optHeaders.forEach((value, key) => {
        headers.set(key, value);
      });
    }

    // Set default Content-Type for JSON if body is present and no Content-Type is set
    if (options.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    const requestOptions: RequestInit = {
      ...options,
      headers,
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      if (process.env.TIMBAL_DEBUG) {
        const redactedHeaders: Record<string, string> = {};
        headers.forEach((v, k) => {
          redactedHeaders[k] = k.toLowerCase() === 'authorization' || k.toLowerCase() === 'x-auth-token'
            ? `${v.slice(0, 12)}...`
            : v;
        });
        console.debug(`[timbal-sdk] ${options.method ?? 'GET'} ${url}`, JSON.stringify(redactedHeaders));
      }

      const response = await fetch(url, {
        ...requestOptions,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await this.parseErrorResponse(response);
        if (process.env.TIMBAL_DEBUG) {
          console.debug(`[timbal-sdk] ${response.status} ${url}`, JSON.stringify(errorData));
        }
        throw new TimbalApiError(
          errorData.message || 'Request failed',
          response.status,
          errorData.code,
          errorData.details
        );
      }

      const data = (await response.json()) as T;
      return {
        data,
        success: true,
        statusCode: response.status,
      };
    } catch (error) {
      // Handle timeout
      if (error instanceof Error && error.name === 'AbortError') {
        if (retryCount < this.config.retryAttempts) {
          await sleep(this.config.retryDelay * (retryCount + 1));
          return this.makeRequest<T>(endpoint, options, retryCount + 1);
        }
        throw new TimbalApiError('Request timeout', 0, ERROR_CODES.TIMEOUT_ERROR);
      }

      // Handle network errors
      if (error instanceof TypeError) {
        if (retryCount < this.config.retryAttempts) {
          await sleep(this.config.retryDelay * (retryCount + 1));
          return this.makeRequest<T>(endpoint, options, retryCount + 1);
        }
        throw new TimbalApiError(`Network error: ${error.message}`, 0, ERROR_CODES.NETWORK_ERROR);
      }

      // Handle API errors
      if (error instanceof TimbalApiError) {
        // Retry on server errors (5xx)
        if (error.statusCode >= 500 && retryCount < this.config.retryAttempts) {
          await sleep(this.config.retryDelay * (retryCount + 1));
          return this.makeRequest<T>(endpoint, options, retryCount + 1);
        }
        throw error;
      }

      throw new TimbalApiError(`Unknown error occurred: ${error}`, 0, ERROR_CODES.SERVER_ERROR);
    }
  }

  private async parseErrorResponse(response: Response): Promise<ApiError> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const errorData = (await response.json()) as Record<string, any>;
      return {
        message: errorData.message || errorData.error || 'Unknown error',
        statusCode: response.status,
        code: errorData.code,
        details: errorData.details,
      };
    } catch {
      return {
        message: response.statusText || 'Unknown error',
        statusCode: response.status,
      };
    }
  }

  public async get<T>(endpoint: string, params?: Record<string, unknown>): Promise<ApiResponse<T>> {
    const queryString = params ? buildQueryString(params) : '';
    return this.makeRequest<T>(`${endpoint}${queryString}`, {
      method: 'GET',
    });
  }

  public async post<T>(endpoint: string, data?: unknown): Promise<ApiResponse<T>> {
    return this.makeRequest<T>(endpoint, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  public async put<T>(endpoint: string, data?: unknown): Promise<ApiResponse<T>> {
    return this.makeRequest<T>(endpoint, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  public async patch<T>(endpoint: string, data?: unknown): Promise<ApiResponse<T>> {
    return this.makeRequest<T>(endpoint, {
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  public async delete<T>(endpoint: string, data?: unknown): Promise<ApiResponse<T>> {
    return this.makeRequest<T>(endpoint, {
      method: 'DELETE',
      headers: data
        ? {
            'Content-Type': 'application/json',
          }
        : undefined,
      body: data ? JSON.stringify(data) : undefined,
    });
  }

  public async postFormData<T>(endpoint: string, formData: FormData): Promise<ApiResponse<T>> {
    return this.makeRequest<T>(endpoint, {
      method: 'POST',
      body: formData,
    });
  }

  public async postFile<T>(
    endpoint: string,
    file: File | Blob,
    contentType?: string
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    return this.makeRequest<T>(endpoint, {
      method: 'POST',
      body: file,
      headers,
    });
  }

  public async postText<T>(
    endpoint: string,
    text: string,
    contentType = 'text/plain'
  ): Promise<ApiResponse<T>> {
    return this.makeRequest<T>(endpoint, {
      method: 'POST',
      body: text,
      headers: {
        'Content-Type': contentType,
      },
    });
  }

  public async request<T>(endpoint: string, options: RequestInit): Promise<ApiResponse<T>> {
    return this.makeRequest<T>(endpoint, options);
  }

  public getConfig(): Required<TimbalConfig> {
    return { ...this.config };
  }
}
