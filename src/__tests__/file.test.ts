import { test, expect, describe, beforeAll, mock } from 'bun:test';
import {
  uploadFile,
  uploadFileFromBuffer,
  uploadTempFile,
  uploadTempFileFromBuffer,
} from '../lib/functions/file';
import type { ApiClient } from '../lib/api';
import type { File, TempFile } from '../types';

// ── Org-bucket (deprecated) ────────────────────────────────────────────────

// Server returns `id` as a JSON number; SDK coerces to string at the boundary.
const mockOrgFileRaw = {
  id: 123 as number | string,
  name: 'test-file.txt',
  content_type: 'text/plain',
  content_length: 1024,
  created_at: '2024-01-01T00:00:00Z',
  expires_at: null,
  url: 'https://content.timbal.ai/orgs/1/files/test-file.txt',
};

const mockOrgFile: File = { ...mockOrgFileRaw, id: '123' };

const mockApiClient: ApiClient = {
  postFormData: async () => ({ data: mockOrgFileRaw, success: true, statusCode: 200 }),
  getConfig: () => ({
    orgId: process.env.TIMBAL_ORG_ID ?? '',
    kbId: '',
    projectId: '',
    rev: 'main',
    token: '',
  }),
} as any;

describe('uploadFile (deprecated org bucket)', () => {
  const tempFilePath = '/tmp/unit_test_file.txt';

  beforeAll(async () => {
    await Bun.write(tempFilePath, 'Hello, World! This is a test file.');
  });

  test('coerces numeric id to string', async () => {
    const result = await uploadFile(mockApiClient, tempFilePath, { orgId: 'test-org' });
    expect(result).toEqual(mockOrgFile);
    expect(typeof result.id).toBe('string');
    expect(result.id).toBe('123');
  });

  test('passes through already-string ids unchanged', async () => {
    const client: ApiClient = {
      ...mockApiClient,
      postFormData: async () => ({
        data: { ...mockOrgFileRaw, id: 'abc-xyz' },
        success: true,
        statusCode: 200,
      }),
    } as any;
    const result = await uploadFile(client, tempFilePath, { orgId: 'test-org' });
    expect(result.id).toBe('abc-xyz');
  });

  test('throws when file does not exist', async () => {
    await expect(
      uploadFile(mockApiClient, '/nonexistent/file.txt', { orgId: 'test-org' })
    ).rejects.toThrow('File not found');
  });

  test('falls back to env var for orgId', async () => {
    const orig = process.env.TIMBAL_ORG_ID;
    process.env.TIMBAL_ORG_ID = 'env-org';
    try {
      const result = await uploadFile(mockApiClient, tempFilePath);
      expect(result.id).toBe('123');
    } finally {
      if (orig === undefined) delete process.env.TIMBAL_ORG_ID;
      else process.env.TIMBAL_ORG_ID = orig;
    }
  });

  test('throws when orgId missing and no env var', async () => {
    const orig = process.env.TIMBAL_ORG_ID;
    delete process.env.TIMBAL_ORG_ID;
    try {
      await expect(uploadFile(mockApiClient, tempFilePath)).rejects.toThrow('orgId is required');
    } finally {
      if (orig !== undefined) process.env.TIMBAL_ORG_ID = orig;
    }
  });
});

describe('uploadFileFromBuffer (deprecated org bucket)', () => {
  test('coerces numeric id to string', async () => {
    const result = await uploadFileFromBuffer(
      mockApiClient,
      new TextEncoder().encode('Test buffer'),
      'buffer-test.txt',
      'text/plain',
      { orgId: 'test-org' },
    );
    expect(typeof result.id).toBe('string');
    expect(result.id).toBe('123');
  });

  test('uses default content type', async () => {
    const result = await uploadFileFromBuffer(
      mockApiClient,
      new TextEncoder().encode('Test buffer'),
      'test.bin',
      undefined,
      { orgId: 'test-org' },
    );
    expect(result.id).toBe('123');
  });
});

// ── Temporary files (POST /files) ──────────────────────────────────────────

const mockTempFile: TempFile = {
  name: 'tmp-test.txt',
  content_type: 'text/plain',
  content_length: 11,
  url: 'https://content.timbal.ai/tmp/abc.txt',
  created_at: '2024-01-01T00:00:00Z',
  expires_at: '2024-01-02T00:00:00Z',
};

function tempClient(captureForm?: { value?: FormData; path?: string }): ApiClient {
  return {
    postFormData: async (path: string, form: FormData) => {
      if (captureForm) {
        captureForm.value = form;
        captureForm.path = path;
      }
      return { data: mockTempFile, success: true, statusCode: 200 };
    },
    getConfig: () => ({} as any),
  } as any;
}

describe('uploadTempFile', () => {
  const tempFilePath = '/tmp/unit_test_temp_file.txt';

  beforeAll(async () => {
    await Bun.write(tempFilePath, 'hello world');
  });

  test('hits POST /files (not org-scoped) and returns TempFile', async () => {
    const captured: { value?: FormData; path?: string } = {};
    const result = await uploadTempFile(tempClient(captured), tempFilePath);
    expect(captured.path).toBe('files');
    expect(result).toEqual(mockTempFile);
  });

  test('throws when file does not exist', async () => {
    await expect(uploadTempFile(tempClient(), '/nonexistent/file.txt')).rejects.toThrow(
      'File not found',
    );
  });

  test('does NOT require orgId', async () => {
    const orig = process.env.TIMBAL_ORG_ID;
    delete process.env.TIMBAL_ORG_ID;
    try {
      const result = await uploadTempFile(tempClient(), tempFilePath);
      expect(result).toEqual(mockTempFile);
    } finally {
      if (orig !== undefined) process.env.TIMBAL_ORG_ID = orig;
    }
  });
});

describe('uploadTempFileFromBuffer', () => {
  test('hits POST /files and uses filename from caller', async () => {
    const captured: { value?: FormData; path?: string } = {};
    const result = await uploadTempFileFromBuffer(
      tempClient(captured),
      new TextEncoder().encode('hello'),
      'greeting.txt',
      'text/plain',
    );
    expect(captured.path).toBe('files');
    expect(result).toEqual(mockTempFile);
    const sent = captured.value!.get('file') as globalThis.File;
    expect(sent.name).toBe('greeting.txt');
    expect(sent.type.startsWith('text/plain')).toBe(true);
  });

  test('defaults content type to application/octet-stream', async () => {
    const captured: { value?: FormData; path?: string } = {};
    await uploadTempFileFromBuffer(
      tempClient(captured),
      new TextEncoder().encode('hello'),
      'blob.bin',
    );
    const sent = captured.value!.get('file') as globalThis.File;
    expect(sent.type).toBe('application/octet-stream');
  });
});
