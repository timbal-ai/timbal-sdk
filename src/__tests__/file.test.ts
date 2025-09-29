import { test, expect, describe, beforeAll, afterEach } from 'bun:test';
import { FileService } from '../lib/services/file';
import type { ApiClient } from '../lib/api';
import type { File } from '../types';
import {
  shouldRunIntegrationTests,
  createTestTimbal,
  logIntegrationTestConfig,
} from './test-utils';
import type { Timbal } from '../lib/timbal';

// Mock ApiClient
const mockApiClient: ApiClient = {
  postFormData: async (_path: string, _formData: FormData) => {
    // Mock file response
    const mockFile: File = {
      id: 123,
      name: 'test-file.txt',
      content_type: 'text/plain',
      content_length: 1024,
      created_at: '2024-01-01T00:00:00Z',
      expires_at: null,
      url: 'https://content.timbal.ai/orgs/1/files/test-file.txt',
    };
    return { data: mockFile, success: true, statusCode: 200 };
  },
} as any;

describe('FileService', () => {
  // Create a temporary test file for unit tests
  const tempFilePath = '/tmp/unit_test_file.txt';
  const fileContent = 'Hello, World! This is a test file.';

  // Setup temp file before tests
  beforeAll(async () => {
    await Bun.write(tempFilePath, fileContent);
  });

  test('should upload file with required parameters', async () => {
    const fileService = new FileService(mockApiClient);

    const result = await fileService.uploadFile({
      orgId: 'test-org',
      filePath: tempFilePath,
    });

    expect(result).toEqual({
      id: 123,
      name: 'test-file.txt',
      content_type: 'text/plain',
      content_length: 1024,
      created_at: '2024-01-01T00:00:00Z',
      expires_at: null,
      url: 'https://content.timbal.ai/orgs/1/files/test-file.txt',
    });
  });

  test('should throw error when orgId is missing', async () => {
    const fileService = new FileService(mockApiClient);

    await expect(
      fileService.uploadFile({
        filePath: tempFilePath,
      })
    ).rejects.toThrow('orgId is required');
  });

  test('should throw error when filePath is missing', async () => {
    const fileService = new FileService(mockApiClient);

    await expect(
      fileService.uploadFile({
        orgId: 'test-org',
        filePath: '',
      })
    ).rejects.toThrow('filePath is required');
  });

  test('should throw error when file does not exist', async () => {
    const fileService = new FileService(mockApiClient);

    await expect(
      fileService.uploadFile({
        orgId: 'test-org',
        filePath: '/nonexistent/file.txt',
      })
    ).rejects.toThrow('File not found');
  });

  test('should use defaults when set', async () => {
    const fileService = new FileService(mockApiClient, {
      orgId: 'default-org',
    });

    const result = await fileService.uploadFile({
      filePath: tempFilePath,
    });

    expect(result.id).toBe(123);
  });

  test('should handle positional parameters', async () => {
    const fileService = new FileService(mockApiClient);

    const result = await fileService.uploadFileByParams('test-org', tempFilePath);

    expect(result.id).toBe(123);
  });

  test('should upload file from buffer', async () => {
    const fileService = new FileService(mockApiClient);

    const testData = new TextEncoder().encode('Test buffer content');

    const result = await fileService.uploadFileFromBuffer({
      orgId: 'test-org',
      data: testData,
      filename: 'buffer-test.txt',
      contentType: 'text/plain',
    });

    expect(result.id).toBe(123);
  });

  test('should throw error when buffer data is missing', async () => {
    const fileService = new FileService(mockApiClient);

    await expect(
      fileService.uploadFileFromBuffer({
        orgId: 'test-org',
        data: null as any,
        filename: 'test.txt',
      })
    ).rejects.toThrow('data is required');
  });

  test('should throw error when filename is missing for buffer upload', async () => {
    const fileService = new FileService(mockApiClient);

    const testData = new TextEncoder().encode('Test buffer content');

    await expect(
      fileService.uploadFileFromBuffer({
        orgId: 'test-org',
        data: testData,
        filename: '',
      })
    ).rejects.toThrow('filename is required');
  });

  test('should use default content type for buffer upload', async () => {
    const fileService = new FileService(mockApiClient);

    const testData = new TextEncoder().encode('Test buffer content');

    const result = await fileService.uploadFileFromBuffer({
      orgId: 'test-org',
      data: testData,
      filename: 'test-file-no-type.bin',
      // No contentType specified - should default to application/octet-stream
    });

    expect(result.id).toBe(123);
  });

  test('should set and get defaults', () => {
    const fileService = new FileService(mockApiClient);

    fileService.setDefaults({
      orgId: 'new-default-org',
    });

    const defaults = fileService.getDefaults();
    expect(defaults.orgId).toBe('new-default-org');
  });
});

// Integration Tests for FileService
describe('FileService Integration Tests', () => {
  let timbal: Timbal;
  const uploadedFiles: File[] = [];

  beforeAll(() => {
    logIntegrationTestConfig();
    if (!shouldRunIntegrationTests()) return;
    timbal = createTestTimbal();
  });

  afterEach(async () => {
    if (!shouldRunIntegrationTests()) return;

    // Note: There's no delete file endpoint mentioned, so we can't clean up uploaded files
    // In a real scenario, you might want to add a delete file functionality
    console.log(
      `ℹ️  ${uploadedFiles.length} files were uploaded during tests (no cleanup available)`
    );
    uploadedFiles.length = 0; // Clear the array
  });

  test.skipIf(!shouldRunIntegrationTests())(
    'should upload a text file and verify response',
    async () => {
      const testFileName = `integration-test-${Date.now()}.txt`;
      const testFilePath = `/tmp/${testFileName}`;
      const testContent = `Integration test file content - ${new Date().toISOString()}`;

      // Create test file
      await Bun.write(testFilePath, testContent);

      try {
        // Upload the file
        console.log(`📤 Uploading file: ${testFileName}`);
        const uploadedFile = await timbal.uploadFile({
          filePath: testFilePath,
        });

        uploadedFiles.push(uploadedFile);

        console.log(`✅ File uploaded successfully: ${uploadedFile.name}`);
        console.log(`📎 File URL: ${uploadedFile.url}`);

        // Verify the response structure
        expect(uploadedFile).toHaveProperty('id');
        expect(uploadedFile).toHaveProperty('name');
        expect(uploadedFile).toHaveProperty('content_type');
        expect(uploadedFile).toHaveProperty('content_length');
        expect(uploadedFile).toHaveProperty('created_at');
        expect(uploadedFile).toHaveProperty('url');

        // Verify the file properties
        expect(typeof uploadedFile.id).toBe('number');
        expect(uploadedFile.id).toBeGreaterThan(0);
        expect(uploadedFile.name).toContain('.txt');
        expect(uploadedFile.content_type).toMatch(/^text\/plain/); // May include charset
        expect(uploadedFile.content_length).toBeGreaterThan(0);
        expect(uploadedFile.url).toMatch(/^https:\/\/content\.timbal\.ai\//);

        console.log(`✅ File upload integration test completed successfully`);
      } finally {
        // Clean up test file
        await Bun.write(testFilePath, '');
      }
    }
  );

  test.skipIf(!shouldRunIntegrationTests())('should upload file from buffer', async () => {
    const testContent = `Buffer upload test - ${new Date().toISOString()}`;
    const testData = new TextEncoder().encode(testContent);
    const testFileName = `buffer-test-${Date.now()}.txt`;

    console.log(`📤 Uploading file from buffer: ${testFileName}`);
    const uploadedFile = await timbal.uploadFileFromBuffer({
      data: testData,
      filename: testFileName,
      contentType: 'text/plain',
    });

    uploadedFiles.push(uploadedFile);

    console.log(`✅ Buffer file uploaded successfully: ${uploadedFile.name}`);

    // Verify the response
    expect(uploadedFile.name).toContain('.txt');
    expect(uploadedFile.content_type).toMatch(/^text\/plain/); // May include charset
    expect(uploadedFile.content_length).toBe(testData.length);

    console.log(`✅ Buffer upload integration test completed successfully`);
  });

  test.skipIf(!shouldRunIntegrationTests())(
    'should handle file upload errors gracefully',
    async () => {
      try {
        // Try to upload a non-existent file
        await timbal.uploadFile({
          filePath: '/nonexistent/file.txt',
        });
        expect(false).toBe(true); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toMatch(/File not found/i);
        console.log(`✅ File upload error handling test completed successfully`);
      }
    }
  );
});
