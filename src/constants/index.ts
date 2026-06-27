export const DEFAULT_CONFIG = {
  baseUrl: 'https://api.timbal.ai',
  timeout: 30000,
  retryAttempts: 3,
  retryDelay: 1000,
};

/**
 * SDK version, sent as `x-timbal-version` on tool-proxy calls (mirrors the
 * Python SDK's `__version__` header). Keep in sync with `package.json`.
 */
export const SDK_VERSION = '0.9.2';

/** Path prefix for the platform tool proxy (`/orgs/{org}/proxies/v1/tools`). */
export const PROXY_TOOLS_PREFIX = '/proxies/v1/tools';

export const ERROR_CODES = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  AUTH_ERROR: 'AUTH_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT_ERROR: 'RATE_LIMIT_ERROR',
  SERVER_ERROR: 'SERVER_ERROR',
} as const;
