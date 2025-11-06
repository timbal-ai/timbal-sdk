import type { ApiClient } from '../api';
import type { Column, Table } from '../../types';

export interface TableOptions {
  orgId?: string;
  kbId?: string;
}

export class TableService {
  private defaultOrgId?: string;
  private defaultKbId?: string;

  constructor(
    private apiClient: ApiClient,
    defaults: TableOptions = {}
  ) {
    this.defaultOrgId = defaults.orgId;
    this.defaultKbId = defaults.kbId;
  }

  /**
   * Create a new table in a knowledge base.
   *
   * @param orgId The organization ID.
   * @param kbId The knowledge base ID where the table will be created.
   * @param name The name of the table to create.
   * @param columns A list of column definitions.
   * @param comment An optional comment describing the table.
   */
  async createTable(options: {
    orgId?: string;
    kbId?: string;
    name: string;
    columns: Column[];
    comment?: string | null;
  }): Promise<void> {
    const orgId = this.resolveDefault('orgId', options.orgId);
    const kbId = this.resolveDefault('kbId', options.kbId);

    if (!orgId) {
      throw new Error('orgId is required. Provide it in the method call or set a default.');
    }
    if (!kbId) {
      throw new Error('kbId is required. Provide it in the method call or set a default.');
    }
    if (!options.name) {
      throw new Error('name is required.');
    }
    if (!options.columns || options.columns.length === 0) {
      throw new Error('columns are required and cannot be empty.');
    }

    const path = `orgs/${orgId}/kbs/${kbId}/tables`;
    const payload = {
      name: options.name,
      columns: options.columns.map(column => ({
        name: column.name,
        data_type: column.dataType,
        default_value: column.defaultValue,
        is_nullable: column.isNullable,
        is_unique: column.isUnique,
        is_primary: column.isPrimary,
        comment: column.comment,
      })),
      comment: options.comment,
    };

    await this.apiClient.post(path, payload);
  }

  /**
   * Convenience method for creating a table with positional parameters
   */
  async createTableByParams(
    orgId: string,
    kbId: string,
    name: string,
    columns: Column[],
    comment?: string | null
  ): Promise<void> {
    return this.createTable({ orgId, kbId, name, columns, comment });
  }

  /**
   * Set default values for future table operations
   */
  setDefaults(defaults: TableOptions): void {
    if (defaults.orgId !== undefined) this.defaultOrgId = defaults.orgId;
    if (defaults.kbId !== undefined) this.defaultKbId = defaults.kbId;
  }

  /**
   * Get current default values
   */
  getDefaults(): TableOptions {
    return {
      orgId: this.defaultOrgId,
      kbId: this.defaultKbId,
    };
  }

  /**
   * List all tables in a knowledge base.
   *
   * @param orgId The organization ID.
   * @param kbId The knowledge base ID.
   * @returns A list of Table models, each containing the table's name, columns, comment, and constraints.
   */
  async getTables(options: {
    orgId?: string;
    kbId?: string;
  }): Promise<Table[]> {
    const orgId = this.resolveDefault('orgId', options.orgId);
    const kbId = this.resolveDefault('kbId', options.kbId);

    if (!orgId) {
      throw new Error('orgId is required. Provide it in the method call or set a default.');
    }
    if (!kbId) {
      throw new Error('kbId is required. Provide it in the method call or set a default.');
    }

    const path = `orgs/${orgId}/kbs/${kbId}/tables`;
    const params = { format: 'full' };

    const response = await this.apiClient.get<{ tables: any[] }>(path, params);
    const tables = response.data.tables || [];

    return tables.map((table: any) => ({
      name: table.name,
      columns: (table.columns || []).map((column: any) => ({
        name: column.name,
        dataType: column.data_type,
        defaultValue: column.default_value,
        isNullable: column.is_nullable,
        isUnique: column.is_unique,
        isPrimary: column.is_primary,
        comment: column.comment,
      })),
      comment: table.comment,
      constraints: table.constraints || [],
    }));
  }

  /**
   * Convenience method for getting tables with positional parameters
   */
  async getTablesByParams(orgId: string, kbId: string): Promise<Table[]> {
    return this.getTables({ orgId, kbId });
  }

  /**
   * Import records into a table in a knowledge base.
   *
   * @param orgId The organization ID.
   * @param kbId The knowledge base ID containing the table.
   * @param tableName The name of the table to import records to.
   * @param records The records to import. Each record should be a dictionary where keys match the table's column names.
   *
   * @example
   * ```typescript
   * // For an example table "Documents" with columns: id, filename, content
   * await tableService.importRecords({
   *   orgId: "10",
   *   kbId: "48",
   *   tableName: "Documents",
   *   records: [
   *     { id: 1, filename: "foo.txt", content: "Hello world!" },
   *     { id: 2, filename: "bar.txt", content: "Another document" }
   *   ]
   * });
   * ```
   */
  async importRecords(options: {
    orgId?: string;
    kbId?: string;
    tableName: string;
    records: Record<string, any>[];
  }): Promise<void> {
    const orgId = this.resolveDefault('orgId', options.orgId);
    const kbId = this.resolveDefault('kbId', options.kbId);

    if (!orgId) {
      throw new Error('orgId is required. Provide it in the method call or set a default.');
    }
    if (!kbId) {
      throw new Error('kbId is required. Provide it in the method call or set a default.');
    }
    if (!options.tableName) {
      throw new Error('tableName is required.');
    }
    if (!options.records || options.records.length === 0) {
      throw new Error('records are required and cannot be empty.');
    }

    const path = `orgs/${orgId}/kbs/${kbId}/tables/${options.tableName}/records`;
    const payload = {
      records: options.records,
    };

    await this.apiClient.post(path, payload);
  }

  /**
   * Convenience method for importing records with positional parameters
   */
  async importRecordsByParams(
    orgId: string,
    kbId: string,
    tableName: string,
    records: Record<string, any>[]
  ): Promise<void> {
    return this.importRecords({ orgId, kbId, tableName, records });
  }

  /**
   * Upload a CSV file to a table in a knowledge base.
   *
   * This function imports data from a CSV file into an existing table in the specified knowledge base.
   * The CSV file must match the table's schema (column names and types).
   *
   * @param orgId The organization ID.
   * @param kbId The knowledge base ID containing the table.
   * @param tableName The name of the table to upload the CSV to.
   * @param csvPath The path to the CSV file on disk.
   */
  async importCsv(options: {
    orgId?: string;
    kbId?: string;
    tableName: string;
    csvPath: string;
  }): Promise<void> {
    const orgId = this.resolveDefault('orgId', options.orgId);
    const kbId = this.resolveDefault('kbId', options.kbId);

    if (!orgId) {
      throw new Error('orgId is required. Provide it in the method call or set a default.');
    }
    if (!kbId) {
      throw new Error('kbId is required. Provide it in the method call or set a default.');
    }
    if (!options.tableName) {
      throw new Error('tableName is required.');
    }
    if (!options.csvPath) {
      throw new Error('csvPath is required.');
    }

    const path = `orgs/${orgId}/kbs/${kbId}/tables/${options.tableName}/csv`;

    // Read the CSV file
    const file = Bun.file(options.csvPath);
    const csvData = await file.text();

    await this.apiClient.postText(path, csvData, 'text/csv');
  }

  /**
   * Convenience method for importing CSV with positional parameters
   */
  async importCsvByParams(
    orgId: string,
    kbId: string,
    tableName: string,
    csvPath: string
  ): Promise<void> {
    return this.importCsv({ orgId, kbId, tableName, csvPath });
  }

  /**
   * Delete a table from a knowledge base.
   *
   * @param orgId The organization ID.
   * @param kbId The knowledge base ID containing the table.
   * @param name The name of the table to delete.
   * @param cascade Whether to cascade delete (optional, defaults to false).
   */
  async deleteTable(options: {
    orgId?: string;
    kbId?: string;
    name: string;
    cascade?: boolean;
  }): Promise<void> {
    const orgId = this.resolveDefault('orgId', options.orgId);
    const kbId = this.resolveDefault('kbId', options.kbId);

    if (!orgId) {
      throw new Error('orgId is required. Provide it in the method call or set a default.');
    }
    if (!kbId) {
      throw new Error('kbId is required. Provide it in the method call or set a default.');
    }
    if (!options.name) {
      throw new Error('name is required.');
    }

    const path = `orgs/${orgId}/kbs/${kbId}/tables/${options.name}`;
    const payload = {
      cascade: options.cascade ?? false,
    };

    await this.apiClient.delete(path, payload);
  }

  /**
   * Convenience method for deleting a table with positional parameters
   */
  async deleteTableByParams(
    orgId: string,
    kbId: string,
    name: string,
    cascade?: boolean
  ): Promise<void> {
    return this.deleteTable({ orgId, kbId, name, cascade });
  }

  private resolveDefault(key: keyof TableOptions, value?: string): string | undefined {
    if (value !== undefined) return value;

    switch (key) {
      case 'orgId':
        return this.defaultOrgId;
      case 'kbId':
        return this.defaultKbId;
      default:
        return undefined;
    }
  }
}
