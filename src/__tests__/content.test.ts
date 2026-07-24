import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  signContentUrl,
  parseSignedContentUrl,
  isSignedContentUrlExpired,
} from '../lib/functions/content';
import { ContentSection } from '../lib/content';
import { Timbal } from '../lib/timbal';
import { TimbalApiError } from '../lib/api';

// Same shape as real platform content URLs:
// https://timbalusercontent.com/orgs/1/k2/{kb}/files/{id}/source.xlsx
//   ?Expires=1784883214&Signature=…&Key-Pair-Id=K2WLME83EQGDL3&Hash-Algorithm=SHA256
const OBJECT_URL = 'https://timbalusercontent.com/orgs/1/k2/kb-uid/files/file-uid/source.xlsx';

function signedUrl(expiresEpochSeconds: number): string {
  return (
    `${OBJECT_URL}?Expires=${expiresEpochSeconds}` +
    '&Signature=iQhgC94Zf~sig--123__&Key-Pair-Id=K2WLME83EQGDL3&Hash-Algorithm=SHA256'
  );
}

const inOneHour = () => Math.floor(Date.now() / 1000) + 3600;
const oneHourAgo = () => Math.floor(Date.now() / 1000) - 3600;

// ── parseSignedContentUrl ───────────────────────────────────────────────────

describe('parseSignedContentUrl', () => {
  test('should parse all CloudFront params off a signed URL', () => {
    const expires = 1784883214;
    const info = parseSignedContentUrl(signedUrl(expires));

    expect(info.signed).toBe(true);
    expect(info.expiresAt).toEqual(new Date(expires * 1000));
    expect(info.signature).toBe('iQhgC94Zf~sig--123__');
    expect(info.keyPairId).toBe('K2WLME83EQGDL3');
    expect(info.hashAlgorithm).toBe('SHA256');
  });

  test('should return unsigned info for a plain URL', () => {
    const info = parseSignedContentUrl(OBJECT_URL);

    expect(info.signed).toBe(false);
    expect(info.expiresAt).toBeNull();
    expect(info.signature).toBeNull();
    expect(info.keyPairId).toBeNull();
    expect(info.hashAlgorithm).toBeNull();
  });

  test('should return unsigned info for a bare object key', () => {
    const info = parseSignedContentUrl('orgs/1/k2/kb-uid/files/file-uid/source.xlsx');

    expect(info.signed).toBe(false);
    expect(info.expiresAt).toBeNull();
  });

  test('should keep signed=true but expiresAt=null when Expires is malformed', () => {
    const info = parseSignedContentUrl(`${OBJECT_URL}?Expires=soon&Signature=abc`);

    expect(info.signed).toBe(true);
    expect(info.expiresAt).toBeNull();
  });
});

// ── isSignedContentUrlExpired ───────────────────────────────────────────────

describe('isSignedContentUrlExpired', () => {
  test('should be false for a URL expiring in the future', () => {
    expect(isSignedContentUrlExpired(signedUrl(inOneHour()))).toBe(false);
  });

  test('should be true for a URL that expired in the past', () => {
    expect(isSignedContentUrlExpired(signedUrl(oneHourAgo()))).toBe(true);
  });

  test('should treat URLs inside the skew window as expired', () => {
    const inThirtySeconds = Math.floor(Date.now() / 1000) + 30;
    expect(isSignedContentUrlExpired(signedUrl(inThirtySeconds), 60_000)).toBe(true);
    expect(isSignedContentUrlExpired(signedUrl(inThirtySeconds), 0)).toBe(false);
  });

  test('should be false for unsigned URLs (they never expire)', () => {
    expect(isSignedContentUrlExpired(OBJECT_URL)).toBe(false);
  });
});

// ── signContentUrl (raw function) ───────────────────────────────────────────

describe('signContentUrl', () => {
  const mockResponse = { signed_url: signedUrl(inOneHour()), url: OBJECT_URL };

  const mockApiClient = {
    post: mock(() => Promise.resolve({ data: mockResponse })),
    getConfig: () => ({
      orgId: process.env.TIMBAL_ORG_ID ?? '',
      projectId: '',
      kbId: '',
      rev: 'main',
      token: '',
    }),
  } as any;

  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockApiClient.post.mockClear();
    process.env.TIMBAL_ORG_ID = '';
  });

  afterEach(() => {
    process.env.TIMBAL_ORG_ID = originalEnv.TIMBAL_ORG_ID;
  });

  test('should POST the url to the sign endpoint with explicit orgId', async () => {
    const stale = signedUrl(oneHourAgo());
    const result = await signContentUrl(mockApiClient, stale, { orgId: 'org-1' });

    expect(mockApiClient.post).toHaveBeenCalledWith('orgs/org-1/content/sign', { url: stale });
    expect(result).toEqual(mockResponse);
  });

  test('should accept a bare object key as input', async () => {
    await signContentUrl(mockApiClient, 'orgs/1/k2/kb/files/f/source.xlsx', { orgId: 'org-1' });

    expect(mockApiClient.post).toHaveBeenCalledWith('orgs/org-1/content/sign', {
      url: 'orgs/1/k2/kb/files/f/source.xlsx',
    });
  });

  test('should fall back to env var orgId', async () => {
    process.env.TIMBAL_ORG_ID = 'env-org';

    await signContentUrl(mockApiClient, OBJECT_URL);

    expect(mockApiClient.post).toHaveBeenCalledWith('orgs/env-org/content/sign', {
      url: OBJECT_URL,
    });
  });

  test('should throw when orgId is missing', async () => {
    await expect(signContentUrl(mockApiClient, OBJECT_URL)).rejects.toThrow('orgId is required');
    expect(mockApiClient.post).not.toHaveBeenCalled();
  });

  test('should propagate API errors', async () => {
    mockApiClient.post.mockRejectedValueOnce(new TimbalApiError('Forbidden', 403, 'FORBIDDEN'));

    await expect(
      signContentUrl(mockApiClient, OBJECT_URL, { orgId: 'org-1' }),
    ).rejects.toThrow('Forbidden');
  });
});

// ── ContentSection through Timbal ───────────────────────────────────────────

describe('Timbal.content', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;
  let freshSigned: string;

  const makeTimbal = () =>
    new Timbal({ token: 'test-key', baseUrl: 'https://api.test.com', orgId: 'org-1' });

  beforeEach(() => {
    freshSigned = signedUrl(inOneHour());
    originalFetch = global.fetch;
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ signed_url: freshSigned, url: OBJECT_URL }),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should be a lazy singleton', () => {
    const timbal = makeTimbal();
    expect(timbal.content).toBeInstanceOf(ContentSection);
    expect(timbal.content).toBe(timbal.content);
  });

  test('sign() should hit POST /orgs/{org}/content/sign with the url in the body', async () => {
    const stale = signedUrl(oneHourAgo());
    const result = await makeTimbal().content.sign(stale);

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/orgs/org-1/content/sign');
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ url: stale });
    expect(result).toEqual({ signed_url: freshSigned, url: OBJECT_URL });
  });

  test('sign() should respect a per-call orgId override', async () => {
    await makeTimbal().content.sign(OBJECT_URL, { orgId: 'other-org' });

    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/orgs/other-org/content/sign');
  });

  test('refresh() should return signed_url when present', async () => {
    const url = await makeTimbal().content.refresh(signedUrl(oneHourAgo()));
    expect(url).toBe(freshSigned);
  });

  test('refresh() should fall back to legacy url when signed_url is absent', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ signed_url: null, url: OBJECT_URL }),
    });

    const url = await makeTimbal().content.refresh(signedUrl(oneHourAgo()));
    expect(url).toBe(OBJECT_URL);
  });

  test('ensureFresh() should return a still-fresh URL unchanged without a network call', async () => {
    const fresh = signedUrl(inOneHour());
    const url = await makeTimbal().content.ensureFresh(fresh);

    expect(url).toBe(fresh);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('ensureFresh() should re-sign an expired URL', async () => {
    const url = await makeTimbal().content.ensureFresh(signedUrl(oneHourAgo()));

    expect(url).toBe(freshSigned);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('ensureFresh() should re-sign a URL expiring inside the default 1-min skew', async () => {
    const inThirtySeconds = Math.floor(Date.now() / 1000) + 30;
    const url = await makeTimbal().content.ensureFresh(signedUrl(inThirtySeconds));

    expect(url).toBe(freshSigned);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('ensureFresh() should honor a custom skewMs', async () => {
    const inThirtySeconds = signedUrl(Math.floor(Date.now() / 1000) + 30);
    const url = await makeTimbal().content.ensureFresh(inThirtySeconds, { skewMs: 0 });

    expect(url).toBe(inThirtySeconds);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('ensureFresh() should leave unsigned public URLs untouched', async () => {
    const url = await makeTimbal().content.ensureFresh(OBJECT_URL);

    expect(url).toBe(OBJECT_URL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('ensureFresh() should always sign bare object keys', async () => {
    const url = await makeTimbal().content.ensureFresh('orgs/1/k2/kb/files/f/source.xlsx');

    expect(url).toBe(freshSigned);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('parse() and isExpired() should work through the section', () => {
    const timbal = makeTimbal();
    const stale = signedUrl(oneHourAgo());

    expect(timbal.content.parse(stale).keyPairId).toBe('K2WLME83EQGDL3');
    expect(timbal.content.isExpired(stale)).toBe(true);
    expect(timbal.content.isExpired(signedUrl(inOneHour()))).toBe(false);
  });
});
