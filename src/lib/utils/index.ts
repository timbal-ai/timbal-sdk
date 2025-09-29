export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function buildQueryString(params: Record<string, any>): string {
  const searchParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      searchParams.append(key, String(value));
    }
  });

  const queryString = searchParams.toString();
  return queryString ? `?${queryString}` : '';
}

export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function sanitizeString(str: string): string {
  return str.trim().replace(/[<>]/g, '');
}

export function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target } as T;

  Object.keys(source).forEach(key => {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
      (result as any)[key] = deepMerge(targetValue || {}, sourceValue);
    } else {
      (result as any)[key] = sourceValue;
    }
  });

  return result;
}
