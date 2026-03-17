export const DEFAULT_CONFIG = {
  baseUrl: 'https://api.timbal.ai',
  timeout: 30000,
  retryAttempts: 3,
  retryDelay: 1000,
};

export const ERROR_CODES = {
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  AUTH_ERROR: 'AUTH_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RATE_LIMIT_ERROR: 'RATE_LIMIT_ERROR',
  SERVER_ERROR: 'SERVER_ERROR',
} as const;
