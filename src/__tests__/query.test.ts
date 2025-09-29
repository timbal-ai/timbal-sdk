import { test, expect, describe, beforeEach, beforeAll, mock } from 'bun:test';
import { QueryService } from '../lib/services/query';
import {
  shouldRunIntegrationTests,
  createTestTimbal,
  logIntegrationTestConfig,
} from './test-utils';
import type { Timbal } from '../lib/timbal';

// Mock API client
const mockApiClient = {
  post: mock(() => Promise.resolve({ data: [{ count: 5 }] })),
} as any;

describe('QueryService', () => {
  let queryService: QueryService;

  beforeEach(() => {
    queryService = new QueryService(mockApiClient);
    mockApiClient.post.mockClear();
  });

  describe('query', () => {
    test('should execute query with all parameters', async () => {
      const result = await queryService.query({
        orgId: '123',
        kbId: '456',
        sql: 'SELECT COUNT(*) FROM "Documents"',
      });

      expect(mockApiClient.post).toHaveBeenCalledWith('orgs/123/kbs/456/query', {
        sql: 'SELECT COUNT(*) FROM "Documents"',
      });
      expect(result).toEqual([{ count: 5 }]);
    });

    test('should throw error when orgId is missing', async () => {
      try {
        await queryService.query({
          kbId: '456',
          sql: 'SELECT COUNT(*) FROM "Documents"',
        });
        expect(false).toBe(true); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          'orgId is required. Provide it in the method call or set a default.'
        );
      }
    });

    test('should throw error when kbId is missing', async () => {
      try {
        await queryService.query({
          orgId: '123',
          sql: 'SELECT COUNT(*) FROM "Documents"',
        });
        expect(false).toBe(true); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          'kbId is required. Provide it in the method call or set a default.'
        );
      }
    });

    test('should throw error when sql is missing', async () => {
      try {
        await queryService.query({
          orgId: '123',
          kbId: '456',
        });
        expect(false).toBe(true); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          'sql is required. Provide it in the method call or set a default.'
        );
      }
    });
  });

  describe('queryByParams', () => {
    test('should execute query with positional parameters', async () => {
      const result = await queryService.queryByParams('123', '456', 'SELECT * FROM "Users"');

      expect(mockApiClient.post).toHaveBeenCalledWith('orgs/123/kbs/456/query', {
        sql: 'SELECT * FROM "Users"',
      });
      expect(result).toEqual([{ count: 5 }]);
    });
  });

  describe('defaults', () => {
    test('should use default values', async () => {
      const serviceWithDefaults = new QueryService(mockApiClient, {
        orgId: 'default-org',
        kbId: 'default-kb',
      });

      await serviceWithDefaults.query({
        sql: 'SELECT 1',
      });

      expect(mockApiClient.post).toHaveBeenCalledWith('orgs/default-org/kbs/default-kb/query', {
        sql: 'SELECT 1',
      });
    });

    test('should override defaults with provided values', async () => {
      const serviceWithDefaults = new QueryService(mockApiClient, {
        orgId: 'default-org',
        kbId: 'default-kb',
      });

      await serviceWithDefaults.query({
        orgId: 'override-org',
        sql: 'SELECT 1',
      });

      expect(mockApiClient.post).toHaveBeenCalledWith('orgs/override-org/kbs/default-kb/query', {
        sql: 'SELECT 1',
      });
    });

    test('should set and get defaults', () => {
      queryService.setDefaults({ orgId: 'new-org', kbId: 'new-kb' });
      const defaults = queryService.getDefaults();

      expect(defaults.orgId).toBe('new-org');
      expect(defaults.kbId).toBe('new-kb');
    });
  });
});

// Integration Tests for QueryService
describe('QueryService Integration Tests', () => {
  let timbal: Timbal;

  beforeAll(() => {
    logIntegrationTestConfig();
    if (!shouldRunIntegrationTests()) return;
    timbal = createTestTimbal();
  });

  test.skipIf(!shouldRunIntegrationTests())('should execute a simple query', async () => {
    const result = await timbal.query({
      sql: 'SELECT 1 as test_value',
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty('test_value');
    expect(result[0].test_value).toBe(1);
  });

  test.skipIf(!shouldRunIntegrationTests())('should execute a count query', async () => {
    const result = await timbal.query({
      sql: 'SELECT COUNT(*) as total FROM (SELECT 1 UNION SELECT 2 UNION SELECT 3) as temp_table',
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0]).toHaveProperty('total');
    expect(result[0].total).toBe(3);
  });

  test.skipIf(!shouldRunIntegrationTests())(
    'should handle query with parameters from environment',
    async () => {
      const result = await timbal.queryByParams(
        process.env.TIMBAL_ORG_ID!,
        process.env.TIMBAL_KB_ID!,
        'SELECT 42 as answer'
      );

      expect(Array.isArray(result)).toBe(true);
      expect(result[0].answer).toBe(42);
    }
  );

  test.skipIf(!shouldRunIntegrationTests())('should handle SQL errors gracefully', async () => {
    try {
      await timbal.query({
        sql: 'SELECT * FROM non_existent_table',
      });
      expect(false).toBe(true); // Should not reach here
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/table|relation|exist/i);
    }
  });

  test.skipIf(!shouldRunIntegrationTests())(
    'should handle multiple concurrent queries',
    async () => {
      const queries = Array(3)
        .fill(null)
        .map((_, i) =>
          timbal.query({
            sql: `SELECT ${i + 1} as query_number`,
          })
        );

      const results = await Promise.all(queries);

      expect(results).toHaveLength(3);
      results.forEach((result: any, i: number) => {
        expect(result[0].query_number).toBe(i + 1);
      });
    },
    { timeout: 10000 }
  );
});
