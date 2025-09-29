import { test, expect, describe, beforeAll, afterEach } from 'bun:test';
import { TableService } from '../lib/services/table';
import type { ApiClient } from '../lib/api';
import type { Column } from '../types';
import {
  shouldRunIntegrationTests,
  createTestTimbal,
  logIntegrationTestConfig,
} from './test-utils';
import type { Timbal } from '../lib/timbal';

// Mock ApiClient
const mockApiClient: ApiClient = {
  post: async (_path: string, _data: any) => {
    return { data: null, success: true, statusCode: 200 };
  },
  postText: async (_path: string, _text: string, _contentType: string) => {
    return { data: null, success: true, statusCode: 200 };
  },
  delete: async (_path: string, _data?: any) => {
    return { data: null, success: true, statusCode: 200 };
  },
} as any;

describe('TableService', () => {
  // Create a temporary CSV file for unit tests
  const tempCsvPath = '/tmp/unit_test.csv';
  const csvContent = 'name,age\nJohn,25\nJane,30';

  // Setup temp file before tests
  beforeAll(async () => {
    await Bun.write(tempCsvPath, csvContent);
  });

  test('should create table with required parameters', async () => {
    const tableService = new TableService(mockApiClient);

    const columns: Column[] = [
      {
        name: 'name',
        dataType: 'varchar(255)',
        isNullable: false,
        isUnique: false,
        isPrimary: true,
      },
      {
        name: 'age',
        dataType: 'integer',
        isNullable: false,
        isUnique: false,
        isPrimary: false,
      },
    ];

    await expect(
      tableService.createTable({
        orgId: 'test-org',
        kbId: 'test-kb',
        name: 'test_table',
        columns,
      })
    ).resolves.toBeUndefined();
  });

  test('should throw error when orgId is missing', async () => {
    const tableService = new TableService(mockApiClient);

    const columns: Column[] = [
      {
        name: 'name',
        dataType: 'varchar(255)',
        isNullable: false,
        isUnique: false,
        isPrimary: true,
      },
    ];

    await expect(
      tableService.createTable({
        kbId: 'test-kb',
        name: 'test_table',
        columns,
      })
    ).rejects.toThrow('orgId is required');
  });

  test('should throw error when kbId is missing', async () => {
    const tableService = new TableService(mockApiClient);

    const columns: Column[] = [
      {
        name: 'name',
        dataType: 'varchar(255)',
        isNullable: false,
        isUnique: false,
        isPrimary: true,
      },
    ];

    await expect(
      tableService.createTable({
        orgId: 'test-org',
        name: 'test_table',
        columns,
      })
    ).rejects.toThrow('kbId is required');
  });

  test('should throw error when columns are empty', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.createTable({
        orgId: 'test-org',
        kbId: 'test-kb',
        name: 'test_table',
        columns: [],
      })
    ).rejects.toThrow('columns are required and cannot be empty');
  });

  test('should use defaults when set', async () => {
    const tableService = new TableService(mockApiClient, {
      orgId: 'default-org',
      kbId: 'default-kb',
    });

    const columns: Column[] = [
      {
        name: 'name',
        dataType: 'varchar(255)',
        isNullable: false,
        isUnique: false,
        isPrimary: true,
      },
    ];

    await expect(
      tableService.createTable({
        name: 'test_table',
        columns,
      })
    ).resolves.toBeUndefined();
  });

  test('should handle positional parameters', async () => {
    const tableService = new TableService(mockApiClient);

    const columns: Column[] = [
      {
        name: 'name',
        dataType: 'varchar(255)',
        isNullable: false,
        isUnique: false,
        isPrimary: true,
      },
    ];

    await expect(
      tableService.createTableByParams(
        'test-org',
        'test-kb',
        'test_table',
        columns,
        'Test table comment'
      )
    ).resolves.toBeUndefined();
  });

  test('should import CSV with required parameters', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.importCsv({
        orgId: 'test-org',
        kbId: 'test-kb',
        tableName: 'test_table',
        csvPath: tempCsvPath,
        mode: 'overwrite',
      })
    ).resolves.toBeUndefined();
  });

  test('should use default mode when not specified for CSV import', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.importCsv({
        orgId: 'test-org',
        kbId: 'test-kb',
        tableName: 'test_table',
        csvPath: tempCsvPath,
      })
    ).resolves.toBeUndefined();
  });

  test('should throw error when orgId is missing for CSV import', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.importCsv({
        kbId: 'test-kb',
        tableName: 'test_table',
        csvPath: '/path/to/test.csv',
      })
    ).rejects.toThrow('orgId is required');
  });

  test('should throw error when kbId is missing for CSV import', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.importCsv({
        orgId: 'test-org',
        tableName: 'test_table',
        csvPath: '/path/to/test.csv',
      })
    ).rejects.toThrow('kbId is required');
  });

  test('should throw error when tableName is missing for CSV import', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.importCsv({
        orgId: 'test-org',
        kbId: 'test-kb',
        tableName: '',
        csvPath: '/path/to/test.csv',
      })
    ).rejects.toThrow('tableName is required');
  });

  test('should throw error when csvPath is missing', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.importCsv({
        orgId: 'test-org',
        kbId: 'test-kb',
        tableName: 'test_table',
        csvPath: '',
      })
    ).rejects.toThrow('csvPath is required');
  });

  test('should handle CSV import with positional parameters', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.importCsvByParams('test-org', 'test-kb', 'test_table', tempCsvPath, 'append')
    ).resolves.toBeUndefined();
  });

  test('should use defaults for CSV import when set', async () => {
    const tableService = new TableService(mockApiClient, {
      orgId: 'default-org',
      kbId: 'default-kb',
    });

    await expect(
      tableService.importCsv({
        tableName: 'test_table',
        csvPath: tempCsvPath,
      })
    ).resolves.toBeUndefined();
  });

  test('should delete table with required parameters', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.deleteTable({
        orgId: 'test-org',
        kbId: 'test-kb',
        name: 'test_table',
      })
    ).resolves.toBeUndefined();
  });

  test('should throw error when orgId is missing for delete', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.deleteTable({
        kbId: 'test-kb',
        name: 'test_table',
      })
    ).rejects.toThrow('orgId is required');
  });

  test('should throw error when kbId is missing for delete', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.deleteTable({
        orgId: 'test-org',
        name: 'test_table',
      })
    ).rejects.toThrow('kbId is required');
  });

  test('should throw error when name is missing for delete', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.deleteTable({
        orgId: 'test-org',
        kbId: 'test-kb',
        name: '',
      })
    ).rejects.toThrow('name is required');
  });

  test('should handle positional parameters for delete', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.deleteTableByParams('test-org', 'test-kb', 'test_table')
    ).resolves.toBeUndefined();
  });

  test('should use defaults for delete when set', async () => {
    const tableService = new TableService(mockApiClient, {
      orgId: 'default-org',
      kbId: 'default-kb',
    });

    await expect(
      tableService.deleteTable({
        name: 'test_table',
      })
    ).resolves.toBeUndefined();
  });
});

// Integration Tests for TableService
describe('TableService Integration Tests', () => {
  let timbal: Timbal;
  const testTableName = `test_table_${Date.now()}`;
  const tablesToCleanup: string[] = [];

  beforeAll(() => {
    logIntegrationTestConfig();
    if (!shouldRunIntegrationTests()) return;
    timbal = createTestTimbal();
  });

  afterEach(async () => {
    if (!shouldRunIntegrationTests()) return;

    // Clean up any tables created during tests
    for (const tableName of tablesToCleanup) {
      try {
        await timbal.deleteTable({ name: tableName });
        console.log(`🧹 Cleaned up table: ${tableName}`);
      } catch (error) {
        console.log(`ℹ️  Failed to cleanup table ${tableName} (may not exist): ${error.message}`);
      }
    }
    tablesToCleanup.length = 0; // Clear the array
  });

  test.skipIf(!shouldRunIntegrationTests())(
    'should create table and verify it exists',
    async () => {
      tablesToCleanup.push(testTableName);

      const columns: Column[] = [
        {
          name: 'name',
          dataType: 'varchar(255)',
          isNullable: false,
          isUnique: false,
          isPrimary: true,
          comment: 'Name field',
        },
        {
          name: 'age',
          dataType: 'integer',
          isNullable: false,
          isUnique: false,
          isPrimary: false,
          comment: 'Age field',
        },
        {
          name: 'created_at',
          dataType: 'timestamp',
          defaultValue: 'CURRENT_TIMESTAMP',
          isNullable: false,
          isUnique: false,
          isPrimary: false,
          comment: 'Creation timestamp',
        },
      ];

      // Create the table
      await expect(async () => {
        await timbal.createTable({
          name: testTableName,
          columns,
          comment: 'Test table created by integration tests',
        });
      }).not.toThrow();

      // Verify table was created by querying its structure
      const result = await timbal.query({
        sql: `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${testTableName}' ORDER BY ordinal_position`,
      });

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);

      // Check that our expected columns exist
      const columnNames = result.map((row: any) => row.column_name);
      expect(columnNames).toContain('name');
      expect(columnNames).toContain('age');
      expect(columnNames).toContain('created_at');
    }
  );

  test.skipIf(!shouldRunIntegrationTests())(
    'should handle table creation errors gracefully',
    async () => {
      const invalidTableName = `invalid_table_${Date.now()}`;

      // Try to create a table with invalid column type
      const invalidColumns: Column[] = [
        {
          name: 'name',
          dataType: 'invalid_type',
          isNullable: false,
          isUnique: false,
          isPrimary: true,
        },
      ];

      try {
        await timbal.createTable({
          name: invalidTableName,
          columns: invalidColumns,
        });
        expect(false).toBe(true); // Should not reach here
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        // The API should return some kind of error for invalid data type
        expect(error.message).toMatch(/unprocessable|invalid|type|error/i);
      }

      // Note: No need to add to cleanup since table creation should fail
    }
  );

  test.skipIf(!shouldRunIntegrationTests())(
    'should create table, import CSV, and verify data',
    async () => {
      const csvTableName = `csv_test_table_${Date.now()}`;
      const csvFilePath = `/tmp/test_data_${Date.now()}.csv`;

      tablesToCleanup.push(csvTableName);

      // Create test CSV data
      const csvContent = `name,age,city
John Doe,25,New York
Jane Smith,30,San Francisco
Bob Johnson,35,Chicago`;

      // Write CSV file
      await Bun.write(csvFilePath, csvContent);

      try {
        // Create a simple table
        const columns: Column[] = [
          {
            name: 'name',
            dataType: 'varchar(100)',
            isNullable: false,
            isUnique: false,
            isPrimary: true,
          },
          {
            name: 'age',
            dataType: 'integer',
            isNullable: false,
            isUnique: false,
            isPrimary: false,
          },
          {
            name: 'city',
            dataType: 'varchar(100)',
            isNullable: false,
            isUnique: false,
            isPrimary: false,
          },
        ];

        // Step 1: Create the table
        console.log(`Creating table: ${csvTableName}`);
        await timbal.createTable({
          name: csvTableName,
          columns,
          comment: 'Test table for CSV import integration test',
        });
        console.log(`✅ Table ${csvTableName} created successfully`);

        // Step 2: Import CSV data (overwrite mode)
        console.log(`Importing CSV data to ${csvTableName} (overwrite mode)`);
        await timbal.importCsv({
          tableName: csvTableName,
          csvPath: csvFilePath,
          mode: 'overwrite',
        });
        console.log(`✅ CSV data imported successfully`);

        // Step 3: Query the table to verify data was imported
        console.log(`Querying table ${csvTableName} to verify data`);
        const results = await timbal.query({
          sql: `SELECT name, age, city FROM ${csvTableName} ORDER BY age`,
        });
        console.log(`✅ Query returned ${results.length} rows`);

        // Verify we got the expected data
        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBe(3);

        // Check first row (youngest person)
        expect(results[0].name).toBe('John Doe');
        expect(results[0].age).toBe(25);
        expect(results[0].city).toBe('New York');

        // Check second row
        expect(results[1].name).toBe('Jane Smith');
        expect(results[1].age).toBe(30);
        expect(results[1].city).toBe('San Francisco');

        // Check third row (oldest person)
        expect(results[2].name).toBe('Bob Johnson');
        expect(results[2].age).toBe(35);
        expect(results[2].city).toBe('Chicago');

        console.log(`✅ All imported data verified correctly`);

        // Step 4: Test append mode by adding more data
        const additionalCsvContent = `name,age,city
Alice Brown,28,Boston
Charlie Wilson,32,Seattle`;

        const additionalCsvPath = `/tmp/additional_data_${Date.now()}.csv`;
        await Bun.write(additionalCsvPath, additionalCsvContent);

        console.log(`Importing additional CSV data (append mode)`);
        await timbal.importCsv({
          tableName: csvTableName,
          csvPath: additionalCsvPath,
          mode: 'append',
        });
        console.log(`✅ Additional CSV data appended successfully`);

        // Step 5: Query again to verify append worked
        const appendResults = await timbal.query({
          sql: `SELECT COUNT(*) as count FROM ${csvTableName}`,
        });

        expect(appendResults[0].count).toBe(5); // 3 original + 2 appended
        console.log(`✅ Append mode verified - total rows: ${appendResults[0].count}`);

        // Step 6: Query all data to see the final result
        const allResults = await timbal.query({
          sql: `SELECT name, age, city FROM ${csvTableName} ORDER BY age`,
        });

        console.log(`Final table contents:`);
        allResults.forEach((row: any, index: number) => {
          console.log(`  ${index + 1}. ${row.name}, age ${row.age}, from ${row.city}`);
        });

        // Verify we have all 5 records
        expect(allResults.length).toBe(5);
        expect(allResults.map((r: any) => r.name)).toContain('Alice Brown');
        expect(allResults.map((r: any) => r.name)).toContain('Charlie Wilson');

        // Clean up additional CSV file
        await Bun.write(additionalCsvPath, '');
      } finally {
        // Clean up CSV file
        await Bun.write(csvFilePath, '');
      }
    }
  );
});
