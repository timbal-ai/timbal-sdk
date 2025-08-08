import type { ApiClient } from '../api';
import type { Column } from '../../types';

export interface TableOptions {
  orgId?: string;
  kbId?: string;
}

export class TableService {
  private defaultOrgId?: string;
  private defaultKbId?: string;

  constructor(private apiClient: ApiClient, defaults: TableOptions = {}) {
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
   * Upload a CSV file to a table in a knowledge base.
   *
   * This function imports data from a CSV file into an existing table in the specified knowledge base. 
   * The CSV file must match the table's schema (column names and types). 
   * You can choose to either overwrite the table's contents or append to it.
   *
   * @param orgId The organization ID.
   * @param kbId The knowledge base ID containing the table.
   * @param tableName The name of the table to upload the CSV to.
   * @param csvPath The path to the CSV file on disk.
   * @param mode Import mode. Use "overwrite" to replace all existing data in the table, or "append" to add to it. Default is "overwrite".
   */
  async importCsv(options: {
    orgId?: string;
    kbId?: string;
    tableName: string;
    csvPath: string;
    mode?: 'append' | 'overwrite';
  }): Promise<void> {
    const orgId = this.resolveDefault('orgId', options.orgId);
    const kbId = this.resolveDefault('kbId', options.kbId);
    const mode = options.mode ?? 'overwrite';

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

    const path = `orgs/${orgId}/kbs/${kbId}/tables/${options.tableName}/csv?mode=${mode}`;
    
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
    csvPath: string,
    mode: 'append' | 'overwrite' = 'overwrite'
  ): Promise<void> {
    return this.importCsv({ orgId, kbId, tableName, csvPath, mode });
  }

  private resolveDefault(key: keyof TableOptions, value?: string): string | undefined {
    if (value !== undefined) return value;
    
    switch (key) {
      case 'orgId': return this.defaultOrgId;
      case 'kbId': return this.defaultKbId;
      default: return undefined;
    }
  }
}