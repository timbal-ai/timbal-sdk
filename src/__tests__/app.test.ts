import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Timbal } from '../lib/timbal';
import { AppService } from '../lib/services/app';
import { ApiClient } from '../lib/api';
import type { AppRunResponse } from '../types';

// Mock the ApiClient
const mockApiClient = {
  post: mock(() => Promise.resolve({ data: { result: 'success', output: 'test output' } })),
} as unknown as ApiClient;

describe('AppService', () => {
  let appService: AppService;

  beforeEach(() => {
    appService = new AppService(mockApiClient);
    mock.restore();
  });

  test('should run an app successfully', async () => {
    const mockResponse: AppRunResponse = {
      result: 'success',
      output: 'test output',
      execution_id: '12345',
    };

    (mockApiClient.post as any).mockResolvedValue({ data: mockResponse });

    const result = await appService.runApp({
      orgId: 'org123',
      appId: 'app456',
      input: { message: 'Hello, world!' },
      version_id: 'v1.0.0',
      group_id: 'group789',
      parent_id: 'parent101112',
    });

    expect(result).toEqual(mockResponse);
    expect(mockApiClient.post).toHaveBeenCalledWith(
      'orgs/org123/apps/app456/runs/collect',
      {
        input: { message: 'Hello, world!' },
        version_id: 'v1.0.0',
        group_id: 'group789',
        parent_id: 'parent101112',
      }
    );
  });

  test('should run an app with minimal parameters', async () => {
    const mockResponse: AppRunResponse = {
      result: 'success',
      output: 'minimal test',
    };

    (mockApiClient.post as any).mockResolvedValue({ data: mockResponse });

    const result = await appService.runApp({
      orgId: 'org123',
      appId: 'app456',
      input: { query: 'test query' },
    });

    expect(result).toEqual(mockResponse);
    expect(mockApiClient.post).toHaveBeenCalledWith(
      'orgs/org123/apps/app456/runs/collect',
      {
        input: { query: 'test query' },
      }
    );
  });

  test('should throw error when orgId is missing', async () => {
    await expect(
      appService.runApp({
        appId: 'app456',
        input: { message: 'Hello' },
      })
    ).rejects.toThrow('orgId is required');
  });

  test('should throw error when appId is missing', async () => {
    await expect(
      appService.runApp({
        orgId: 'org123',
        appId: '',
        input: { message: 'Hello' },
      })
    ).rejects.toThrow('appId is required');
  });

  test('should throw error when input is missing', async () => {
    await expect(
      appService.runApp({
        orgId: 'org123',
        appId: 'app456',
        input: {},
      })
    ).rejects.toThrow('input is required');
  });

  test('should use default orgId when set', async () => {
    appService.setDefaults({ orgId: 'default-org' });

    const mockResponse: AppRunResponse = { result: 'success' };
    (mockApiClient.post as any).mockResolvedValue({ data: mockResponse });

    await appService.runApp({
      appId: 'app456',
      input: { message: 'Hello' },
    });

    expect(mockApiClient.post).toHaveBeenCalledWith(
      'orgs/default-org/apps/app456/runs/collect',
      {
        input: { message: 'Hello' },
      }
    );
  });

  test('should work with positional parameters', async () => {
    const mockResponse: AppRunResponse = { result: 'success' };
    (mockApiClient.post as any).mockResolvedValue({ data: mockResponse });

    const result = await appService.runAppByParams(
      'org123',
      'app456',
      { message: 'Hello' },
      'v2.0.0',
      'group999',
      'parent888'
    );

    expect(result).toEqual(mockResponse);
    expect(mockApiClient.post).toHaveBeenCalledWith(
      'orgs/org123/apps/app456/runs/collect',
      {
        input: { message: 'Hello' },
        version_id: 'v2.0.0',
        group_id: 'group999',
        parent_id: 'parent888',
      }
    );
  });
});

describe('Timbal App Integration', () => {
  let timbal: Timbal;
  let mockFetch: any;
  let originalFetch: any;

  beforeEach(() => {
    // Store original fetch and create mock
    originalFetch = global.fetch;
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ result: 'success', output: 'test output' }),
      })
    );
    global.fetch = mockFetch as any;

    timbal = new Timbal({
      apiKey: 'test-key',
      baseUrl: 'https://api.test.com',
    });

    mockFetch.mockClear();
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
  });

  test('should run app through Timbal class', async () => {
    const result = await timbal.runApp({
      orgId: 'org123',
      appId: 'app456',
      input: { message: 'Hello from Timbal!' },
    });

    expect(result).toEqual({ result: 'success', output: 'test output' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test.com/orgs/org123/apps/app456/runs/collect',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          input: { message: 'Hello from Timbal!' },
        }),
      })
    );
  });

  test('should run app with positional parameters through Timbal class', async () => {
    const result = await timbal.runAppByParams(
      'org123',
      'app456',
      { message: 'Hello positional!' }
    );

    expect(result).toEqual({ result: 'success', output: 'test output' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.test.com/orgs/org123/apps/app456/runs/collect',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          input: { message: 'Hello positional!' },
        }),
      })
    );
  });

  test('should manage app defaults', () => {
    timbal.setAppDefaults({ orgId: 'default-org' });
    const defaults = timbal.getAppDefaults();

    expect(defaults).toEqual({ orgId: 'default-org' });
  });
});