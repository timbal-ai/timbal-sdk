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
  get: async (_path: string, _params?: any) => {
    return {
      data: {
        tables: [
          {
            name: 'test_table',
            columns: [
              {
                name: 'id',
                data_type: 'integer',
                default_value: null,
                is_nullable: false,
                is_unique: true,
                is_primary: true,
                comment: null,
              },
              {
                name: 'name',
                data_type: 'varchar(255)',
                default_value: null,
                is_nullable: false,
                is_unique: false,
                is_primary: false,
                comment: 'Name field',
              },
            ],
            comment: 'Test table',
            constraints: [],
          },
        ],
      },
      success: true,
      statusCode: 200,
    };
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
      tableService.importCsvByParams('test-org', 'test-kb', 'test_table', tempCsvPath)
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

  test('should get tables with required parameters', async () => {
    const tableService = new TableService(mockApiClient);

    const tables = await tableService.getTables({
      orgId: 'test-org',
      kbId: 'test-kb',
    });

    expect(Array.isArray(tables)).toBe(true);
    expect(tables.length).toBeGreaterThan(0);
    expect(tables[0]).toHaveProperty('name');
    expect(tables[0]).toHaveProperty('columns');
    expect(tables[0]).toHaveProperty('comment');
    expect(tables[0]).toHaveProperty('constraints');
    expect(tables[0].columns[0]).toHaveProperty('name');
    expect(tables[0].columns[0]).toHaveProperty('dataType');
    expect(tables[0].columns[0]).toHaveProperty('isNullable');
  });

  test('should throw error when orgId is missing for getTables', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.getTables({
        kbId: 'test-kb',
      })
    ).rejects.toThrow('orgId is required');
  });

  test('should throw error when kbId is missing for getTables', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.getTables({
        orgId: 'test-org',
      })
    ).rejects.toThrow('kbId is required');
  });

  test('should use defaults for getTables when set', async () => {
    const tableService = new TableService(mockApiClient, {
      orgId: 'default-org',
      kbId: 'default-kb',
    });

    const tables = await tableService.getTables({});
    expect(Array.isArray(tables)).toBe(true);
  });

  test('should handle getTables with positional parameters', async () => {
    const tableService = new TableService(mockApiClient);

    const tables = await tableService.getTablesByParams('test-org', 'test-kb');
    expect(Array.isArray(tables)).toBe(true);
  });

  test('should import records with required parameters', async () => {
    const tableService = new TableService(mockApiClient);

    const records = [
      { id: 1, name: 'John', age: 25 },
      { id: 2, name: 'Jane', age: 30 },
    ];

    await expect(
      tableService.importRecords({
        orgId: 'test-org',
        kbId: 'test-kb',
        tableName: 'test_table',
        records,
      })
    ).resolves.toBeUndefined();
  });

  test('should throw error when orgId is missing for importRecords', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.importRecords({
        kbId: 'test-kb',
        tableName: 'test_table',
        records: [{ id: 1 }],
      })
    ).rejects.toThrow('orgId is required');
  });

  test('should throw error when kbId is missing for importRecords', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.importRecords({
        orgId: 'test-org',
        tableName: 'test_table',
        records: [{ id: 1 }],
      })
    ).rejects.toThrow('kbId is required');
  });

  test('should throw error when tableName is missing for importRecords', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.importRecords({
        orgId: 'test-org',
        kbId: 'test-kb',
        tableName: '',
        records: [{ id: 1 }],
      })
    ).rejects.toThrow('tableName is required');
  });

  test('should throw error when records are empty for importRecords', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.importRecords({
        orgId: 'test-org',
        kbId: 'test-kb',
        tableName: 'test_table',
        records: [],
      })
    ).rejects.toThrow('records are required and cannot be empty');
  });

  test('should throw error when records are missing for importRecords', async () => {
    const tableService = new TableService(mockApiClient);

    await expect(
      tableService.importRecords({
        orgId: 'test-org',
        kbId: 'test-kb',
        tableName: 'test_table',
        records: null as any,
      })
    ).rejects.toThrow('records are required and cannot be empty');
  });

  test('should use defaults for importRecords when set', async () => {
    const tableService = new TableService(mockApiClient, {
      orgId: 'default-org',
      kbId: 'default-kb',
    });

    const records = [{ id: 1, name: 'Test' }];

    await expect(
      tableService.importRecords({
        tableName: 'test_table',
        records,
      })
    ).resolves.toBeUndefined();
  });

  test('should handle importRecords with positional parameters', async () => {
    const tableService = new TableService(mockApiClient);

    const records = [
      { id: 1, name: 'John' },
      { id: 2, name: 'Jane' },
    ];

    await expect(
      tableService.importRecordsByParams('test-org', 'test-kb', 'test_table', records)
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

        // Step 2: Import CSV data
        console.log(`Importing CSV data to ${csvTableName}`);
        await timbal.importCsv({
          tableName: csvTableName,
          csvPath: csvFilePath,
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

        // Step 4: Test importRecords by adding more data
        console.log(`Importing additional records using importRecords`);
        await timbal.importRecords({
          tableName: csvTableName,
          records: [
            { name: 'Alice Brown', age: 28, city: 'Boston' },
            { name: 'Charlie Wilson', age: 32, city: 'Seattle' },
          ],
        });
        console.log(`✅ Additional records imported successfully`);

        // Step 5: Query again to verify importRecords worked
        const appendResults = await timbal.query({
          sql: `SELECT COUNT(*) as count FROM ${csvTableName}`,
        });

        expect(appendResults[0].count).toBe(5); // 3 original + 2 added
        console.log(`✅ Import records verified - total rows: ${appendResults[0].count}`);

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

      } finally {
        // Clean up CSV file
        await Bun.write(csvFilePath, '');
      }
    }
  );

  test.skipIf(!shouldRunIntegrationTests())(
    'should get tables and verify structure',
    async () => {
      const testTableName = `get_tables_test_${Date.now()}`;
      tablesToCleanup.push(testTableName);

      // Create a test table first
      const columns: Column[] = [
        {
          name: 'id',
          dataType: 'integer',
          isNullable: false,
          isUnique: true,
          isPrimary: true,
        },
        {
          name: 'name',
          dataType: 'varchar(100)',
          isNullable: false,
          isUnique: false,
          isPrimary: false,
          comment: 'Name field',
        },
      ];

      await timbal.createTable({
        name: testTableName,
        columns,
        comment: 'Test table for getTables integration test',
      });

      // Get all tables
      const tables = await timbal.getTables({});

      expect(Array.isArray(tables)).toBe(true);
      expect(tables.length).toBeGreaterThan(0);

      // Find our test table
      const testTable = tables.find((t) => t.name === testTableName);
      expect(testTable).toBeDefined();
      expect(testTable?.name).toBe(testTableName);
      expect(testTable?.comment).toBe('Test table for getTables integration test');
      expect(Array.isArray(testTable?.columns)).toBe(true);
      expect(testTable?.columns.length).toBe(2);
      expect(testTable?.columns[0].name).toBe('id');
      expect(testTable?.columns[0].dataType).toBe('integer');
      expect(testTable?.columns[1].name).toBe('name');
      expect(testTable?.columns[1].dataType).toBe('varchar(100)');
      expect(testTable?.columns[1].comment).toBe('Name field');
    }
  );

  test.skipIf(!shouldRunIntegrationTests())(
    'should create table, import records, and verify data',
    async () => {
      const recordsTableName = `records_test_table_${Date.now()}`;
      tablesToCleanup.push(recordsTableName);

      // Create a test table
      const columns: Column[] = [
        {
          name: 'id',
          dataType: 'integer',
          isNullable: false,
          isUnique: true,
          isPrimary: true,
        },
        {
          name: 'name',
          dataType: 'varchar(100)',
          isNullable: false,
          isUnique: false,
          isPrimary: false,
        },
        {
          name: 'email',
          dataType: 'varchar(255)',
          isNullable: true,
          isUnique: false,
          isPrimary: false,
        },
      ];

      await timbal.createTable({
        name: recordsTableName,
        columns,
        comment: 'Test table for importRecords integration test',
      });

      // Import records
      const records = [
        { id: 1, name: 'John Doe', email: 'john@example.com' },
        { id: 2, name: 'Jane Smith', email: 'jane@example.com' },
        { id: 3, name: 'Bob Johnson', email: null },
      ];

      await timbal.importRecords({
        tableName: recordsTableName,
        records,
      });

      // Verify data was imported
      const results = await timbal.query({
        sql: `SELECT id, name, email FROM ${recordsTableName} ORDER BY id`,
      });

      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(3);
      expect(results[0].id).toBe(1);
      expect(results[0].name).toBe('John Doe');
      expect(results[0].email).toBe('john@example.com');
      expect(results[1].id).toBe(2);
      expect(results[1].name).toBe('Jane Smith');
      expect(results[2].id).toBe(3);
      expect(results[2].name).toBe('Bob Johnson');
    }
  );
});
