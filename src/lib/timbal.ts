import type { TimbalConfig, Column, File } from '../types';
import { ApiClient } from './api';
import { QueryService, QueryOptions, QueryResult, TableService, TableOptions, FileService, FileOptions } from './services';

export class Timbal {
  private apiClient: ApiClient;
  private queryService: QueryService;
  private tableService: TableService;
  private fileService: FileService;

  constructor(config: TimbalConfig) {
    this.apiClient = new ApiClient(config);

    // Initialize services
    this.queryService = new QueryService(this.apiClient);
    this.tableService = new TableService(this.apiClient);
    this.fileService = new FileService(this.apiClient);
  }

  /**
   * Get the underlying API client for custom requests
   */
  getApiClient(): ApiClient {
    return this.apiClient;
  }

  /**
   * Update SDK configuration
   */
  updateConfig(newConfig: Partial<TimbalConfig>): void {
    this.apiClient.updateConfig(newConfig);
  }

  /**
   * Get current SDK configuration
   */
  getConfig(): Required<TimbalConfig> {
    return this.apiClient.getConfig();
  }

  /**
   * Execute a SQL query against a knowledge base table (PostgreSQL dialect).
   *
   * @param options Query parameters (orgId, kbId, sql)
   * @returns The query results as a list of dictionaries, where each dictionary represents a row.
   */
  async query(options: {
    orgId?: string;
    kbId?: string;
    sql?: string;
  }): Promise<QueryResult[]> {
    return this.queryService.query(options);
  }

  /**
   * Execute a SQL query with positional parameters
   */
  async queryByParams(
    orgId: string,
    kbId: string,
    sql: string
  ): Promise<QueryResult[]> {
    return this.queryService.queryByParams(orgId, kbId, sql);
  }

  /**
   * Set default values for future queries
   */
  setQueryDefaults(defaults: QueryOptions): void {
    this.queryService.setDefaults(defaults);
  }

  /**
   * Get current query default values
   */
  getQueryDefaults(): QueryOptions {
    return this.queryService.getDefaults();
  }

  /**
   * Create a new table in a knowledge base.
   *
   * @param options Table creation parameters (orgId, kbId, name, columns, comment)
   */
  async createTable(options: {
    orgId?: string;
    kbId?: string;
    name: string;
    columns: Column[];
    comment?: string | null;
  }): Promise<void> {
    return this.tableService.createTable(options);
  }

  /**
   * Create a table with positional parameters
   */
  async createTableByParams(
    orgId: string,
    kbId: string,
    name: string,
    columns: Column[],
    comment?: string | null
  ): Promise<void> {
    return this.tableService.createTableByParams(orgId, kbId, name, columns, comment);
  }

  /**
   * Set default values for future table operations
   */
  setTableDefaults(defaults: TableOptions): void {
    this.tableService.setDefaults(defaults);
  }

  /**
   * Get current table default values
   */
  getTableDefaults(): TableOptions {
    return this.tableService.getDefaults();
  }

  /**
   * Upload a CSV file to a table in a knowledge base.
   *
   * This function imports data from a CSV file into an existing table in the specified knowledge base. 
   * The CSV file must match the table's schema (column names and types). 
   * You can choose to either overwrite the table's contents or append to it.
   *
   * @param options CSV import parameters (orgId, kbId, tableName, csvPath, mode)
   */
  async importCsv(options: {
    orgId?: string;
    kbId?: string;
    tableName: string;
    csvPath: string;
    mode?: 'append' | 'overwrite';
  }): Promise<void> {
    return this.tableService.importCsv(options);
  }

  /**
   * Import CSV with positional parameters
   */
  async importCsvByParams(
    orgId: string,
    kbId: string,
    tableName: string,
    csvPath: string,
    mode: 'append' | 'overwrite' = 'overwrite'
  ): Promise<void> {
    return this.tableService.importCsvByParams(orgId, kbId, tableName, csvPath, mode);
  }

  /**
   * Delete a table from a knowledge base.
   *
   * @param options Table deletion parameters (orgId, kbId, name, cascade)
   */
  async deleteTable(options: {
    orgId?: string;
    kbId?: string;
    name: string;
    cascade?: boolean;
  }): Promise<void> {
    return this.tableService.deleteTable(options);
  }

  /**
   * Delete a table with positional parameters
   */
  async deleteTableByParams(
    orgId: string,
    kbId: string,
    name: string,
    cascade?: boolean
  ): Promise<void> {
    return this.tableService.deleteTableByParams(orgId, kbId, name, cascade);
  }

  /**
   * Upload a file to an organization.
   *
   * @param options File upload parameters (orgId, filePath)
   */
  async uploadFile(options: {
    orgId?: string;
    filePath: string;
  }): Promise<File> {
    return this.fileService.uploadFile(options);
  }

  /**
   * Upload a file with positional parameters
   */
  async uploadFileByParams(
    orgId: string,
    filePath: string
  ): Promise<File> {
    return this.fileService.uploadFileByParams(orgId, filePath);
  }

  /**
   * Upload a file from a Buffer or Uint8Array with custom filename
   */
  async uploadFileFromBuffer(options: {
    orgId?: string;
    data: ArrayBuffer | Uint8Array;
    filename: string;
    contentType?: string;
  }): Promise<File> {
    return this.fileService.uploadFileFromBuffer(options);
  }

  /**
   * Set default values for future file operations
   */
  setFileDefaults(defaults: FileOptions): void {
    this.fileService.setDefaults(defaults);
  }

  /**
   * Get current file default values
   */
  getFileDefaults(): FileOptions {
    return this.fileService.getDefaults();
  }

  /**
   * Test API connectivity with a simple query
   */
  async testConnection(): Promise<boolean> {
    try {
      // Test with a simple query if we have defaults set
      const defaults = this.queryService.getDefaults();
      if (defaults.orgId && defaults.kbId) {
        await this.query({ sql: 'SELECT 1' });
        return true;
      }

      // Otherwise just try to make a basic request to see if the API is reachable
      await this.apiClient.get('/');
      return true;
    } catch {
      return false;
    }
  }
}