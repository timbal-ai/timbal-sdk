import { test, expect, describe, beforeAll } from 'bun:test';
import { uploadFile, uploadFileFromBuffer } from '../lib/functions/file';
import type { ApiClient } from '../lib/api';
import type { File } from '../types';

const mockFile: File = {
  id: 123,
  name: 'test-file.txt',
  content_type: 'text/plain',
  content_length: 1024,
  created_at: '2024-01-01T00:00:00Z',
  expires_at: null,
  url: 'https://content.timbal.ai/orgs/1/files/test-file.txt',
};

const mockApiClient: ApiClient = {
  postFormData: async () => ({ data: mockFile, success: true, statusCode: 200 }),
  getConfig: () => ({
    orgId: process.env.TIMBAL_ORG_ID ?? '',
    kbId: '',
    projectId: '',
    projectEnvId: '',
    token: '',
  }),
} as any;

describe('uploadFile', () => {
  const tempFilePath = '/tmp/unit_test_file.txt';

  beforeAll(async () => {
    await Bun.write(tempFilePath, 'Hello, World! This is a test file.');
  });

  test('should upload file and return result', async () => {
    const result = await uploadFile(mockApiClient, tempFilePath, { orgId: 'test-org' });
    expect(result).toEqual(mockFile);
  });

  test('should throw error when file does not exist', async () => {
    await expect(
      uploadFile(mockApiClient, '/nonexistent/file.txt', { orgId: 'test-org' })
    ).rejects.toThrow('File not found');
  });

  test('should fall back to env var for orgId', async () => {
    const orig = process.env.TIMBAL_ORG_ID;
    process.env.TIMBAL_ORG_ID = 'env-org';

    try {
      const result = await uploadFile(mockApiClient, tempFilePath);
      expect(result).toEqual(mockFile);
    } finally {
      if (orig === undefined) delete process.env.TIMBAL_ORG_ID;
      else process.env.TIMBAL_ORG_ID = orig;
    }
  });

  test('should throw when orgId missing and no env var', async () => {
    const orig = process.env.TIMBAL_ORG_ID;
    delete process.env.TIMBAL_ORG_ID;

    try {
      await expect(
        uploadFile(mockApiClient, tempFilePath)
      ).rejects.toThrow('orgId is required');
    } finally {
      if (orig !== undefined) process.env.TIMBAL_ORG_ID = orig;
    }
  });
});

describe('uploadFileFromBuffer', () => {
  test('should upload buffer and return result', async () => {
    const testData = new TextEncoder().encode('Test buffer content');
    const result = await uploadFileFromBuffer(
      mockApiClient, testData, 'buffer-test.txt', 'text/plain', { orgId: 'test-org' }
    );
    expect(result.id).toBe(123);
  });

  test('should use default content type', async () => {
    const testData = new TextEncoder().encode('Test buffer content');
    const result = await uploadFileFromBuffer(
      mockApiClient, testData, 'test.bin', undefined, { orgId: 'test-org' }
    );
    expect(result.id).toBe(123);
  });
});
