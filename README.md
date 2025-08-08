# Timbal JavaScript SDK

Official TypeScript/JavaScript SDK for the Timbal platform. This SDK provides easy access to Timbal's API for querying knowledge bases, creating tables, and importing CSV data.

## Installation

```bash
npm install @timbal-ai/timbal-sdk
# or
bun add @timbal-ai/timbal-sdk
# or
yarn add @timbal-ai/timbal-sdk
```

## Quick Start

```typescript
import Timbal from '@timbal-ai/timbal-sdk';

// Initialize the client (like OpenAI)
const timbal = new Timbal({
  apiKey: 'your-api-key-here',
});

// Test connection
const isConnected = await timbal.testConnection();
console.log('Connected:', isConnected);

// Execute a SQL query
const results = await timbal.query({
  orgId: '10',
  kbId: '48',
  sql: 'SELECT COUNT(*) FROM "Documents"'
});
console.log('Query results:', results);
```

## Configuration

```typescript
import Timbal from '@timbal-ai/timbal-sdk';

const timbal = new Timbal({
  apiKey: 'your-api-key-here',
  baseUrl: 'https://api.timbal.ai', // Optional: default API endpoint
  timeout: 30000,                   // Optional: request timeout in ms
  retryAttempts: 3,                 // Optional: number of retry attempts
  retryDelay: 1000,                 // Optional: delay between retries in ms
});

// Optionally set default query parameters
timbal.setQueryDefaults({
  orgId: 'your-default-org-id',
  kbId: 'your-default-kb-id',
});
```

## API Reference

### Query Service

The query service allows you to execute SQL queries against knowledge base tables using PostgreSQL dialect.

```typescript
// Execute a query with all parameters
const results = await timbal.query({
  orgId: '10',
  kbId: '48',
  sql: 'SELECT COUNT(*) FROM "Documents"'
});

// Use positional parameters
const results = await timbal.queryByParams(
  '10',        // orgId
  '48',        // kbId
  'SELECT * FROM "Documents" WHERE status = \'active\''
);

// Using defaults (set during SDK initialization or via setQueryDefaults)
timbal.setQueryDefaults({
  orgId: '10',
  kbId: '48'
});

// Now you can omit orgId and kbId
const results = await timbal.query({
  sql: 'SELECT COUNT(*) FROM "Documents"'
});
```

**Important SQL Notes:**
- SQL syntax must follow PostgreSQL conventions
- Table and column names are case sensitive
- If your identifiers use uppercase or mixed case, escape them with double quotes (e.g., `"Documents"`, `"FileName"`)
- Unescaped identifiers are automatically lowercased by PostgreSQL

### Table Service

The table service allows you to create tables and import CSV data into them.

#### Creating Tables

```typescript
// Create a table with column definitions
await timbal.createTable({
  orgId: '10',
  kbId: '48',
  name: 'users',
  columns: [
    {
      name: 'id',
      dataType: 'serial',
      isNullable: false,
      isUnique: true,
      isPrimary: true,
      comment: 'User ID'
    },
    {
      name: 'name',
      dataType: 'varchar(255)',
      isNullable: false,
      isUnique: false,
      isPrimary: false,
      comment: 'User name'
    },
    {
      name: 'email',
      dataType: 'varchar(255)',
      isNullable: false,
      isUnique: true,
      isPrimary: false,
      comment: 'User email'
    },
    {
      name: 'created_at',
      dataType: 'timestamp',
      defaultValue: 'CURRENT_TIMESTAMP',
      isNullable: false,
      isUnique: false,
      isPrimary: false,
      comment: 'Creation timestamp'
    }
  ],
  comment: 'User information table'
});

// Use positional parameters
await timbal.createTableByParams(
  '10',        // orgId
  '48',        // kbId
  'products',  // table name
  [            // columns
    {
      name: 'id',
      dataType: 'serial',
      isNullable: false,
      isUnique: true,
      isPrimary: true
    },
    {
      name: 'name',
      dataType: 'varchar(255)',
      isNullable: false,
      isUnique: false,
      isPrimary: false
    }
  ],
  'Product catalog table' // comment
);

// Using defaults (set during SDK initialization or via setTableDefaults)
timbal.setTableDefaults({
  orgId: '10',
  kbId: '48'
});

// Now you can omit orgId and kbId
await timbal.createTable({
  name: 'orders',
  columns: [
    { name: 'id', dataType: 'serial', isNullable: false, isUnique: true, isPrimary: true },
    { name: 'user_id', dataType: 'integer', isNullable: false, isUnique: false, isPrimary: false },
    { name: 'total', dataType: 'decimal(10,2)', isNullable: false, isUnique: false, isPrimary: false }
  ]
});
```

#### CSV Import

```typescript
// Import CSV data into an existing table
await timbal.importCsv({
  orgId: '10',
  kbId: '48',
  tableName: 'users',
  csvPath: './data/users.csv',
  mode: 'overwrite' // 'overwrite' or 'append'
});

// Use positional parameters
await timbal.importCsvByParams(
  '10',           // orgId
  '48',           // kbId
  'users',        // table name
  './data/users.csv', // CSV file path
  'append'        // mode (optional, defaults to 'overwrite')
);

// Using defaults
await timbal.importCsv({
  tableName: 'users',
  csvPath: './data/users.csv',
  mode: 'append'
});
```

**CSV Import Notes:**
- The CSV file must match the table's schema (column names and types)
- `mode: 'overwrite'` replaces all existing data in the table
- `mode: 'append'` adds the CSV data to existing table data
- CSV files should have a header row with column names
- Column names in CSV must match table column names exactly

**Complete Workflow Example:**

```typescript
// 1. Create a table
await timbal.createTable({
  name: 'sales_data',
  columns: [
    { name: 'date', dataType: 'date', isNullable: false, isUnique: false, isPrimary: false },
    { name: 'product', dataType: 'varchar(100)', isNullable: false, isUnique: false, isPrimary: false },
    { name: 'amount', dataType: 'decimal(10,2)', isNullable: false, isUnique: false, isPrimary: false },
    { name: 'region', dataType: 'varchar(50)', isNullable: false, isUnique: false, isPrimary: false }
  ],
  comment: 'Daily sales data'
});

// 2. Import initial data
await timbal.importCsv({
  tableName: 'sales_data',
  csvPath: './data/january_sales.csv',
  mode: 'overwrite'
});

// 3. Append more data
await timbal.importCsv({
  tableName: 'sales_data',
  csvPath: './data/february_sales.csv',
  mode: 'append'
});

// 4. Query the data
const results = await timbal.query({
  sql: 'SELECT region, SUM(amount) as total_sales FROM sales_data GROUP BY region ORDER BY total_sales DESC'
});
console.log('Sales by region:', results);
```

### File Upload & Custom Requests

The SDK's API client supports various content types for flexible file uploads and custom requests:

```typescript
// Get the API client for custom requests
const apiClient = timbal.getApiClient();

// Upload a file with multipart/form-data
const formData = new FormData();
formData.append('file', fileInput.files[0]);
formData.append('metadata', JSON.stringify({ type: 'document' }));

const uploadResult = await apiClient.postFormData('/upload', formData);

// Upload a file directly
const csvFile = new File(['col1,col2\nval1,val2'], 'data.csv', { type: 'text/csv' });
const csvUpload = await apiClient.postFile('/upload-csv', csvFile, 'text/csv');

// Upload plain text
const textUpload = await apiClient.postText('/upload-text', 'Hello, world!', 'text/plain');

// Make completely custom requests
const customResponse = await apiClient.request('/custom-endpoint', {
  method: 'PUT',
  body: JSON.stringify({ data: 'custom' }),
  headers: {
    'Content-Type': 'application/json',
    'X-Custom-Header': 'value'
  }
});
```

## Error Handling

The SDK throws `TimbalApiError` for API-related errors:

```typescript
import { TimbalApiError } from '@timbal-ai/timbal-sdk';

try {
  const results = await timbal.query({
    orgId: '10',
    kbId: '48',
    sql: 'SELECT * FROM invalid_table'
  });
} catch (error) {
  if (error instanceof TimbalApiError) {
    console.error('API Error:', error.message);
    console.error('Status Code:', error.statusCode);
    console.error('Error Code:', error.code);
    console.error('Details:', error.details);
  }
}
```

## TypeScript Support

The SDK is written in TypeScript and provides full type definitions:

```typescript
import type { 
  TimbalConfig,
  QueryResult,
  QueryOptions,
  Column,
  TableOptions
} from '@timbal-ai/timbal-sdk';

const config: TimbalConfig = {
  apiKey: 'your-key',
  timeout: 10000
};

const results: QueryResult[] = await timbal.query({
  orgId: '10',
  kbId: '48',
  sql: 'SELECT * FROM "Documents"'
});

// Define table columns with types
const columns: Column[] = [
  {
    name: 'id',
    dataType: 'serial',
    isNullable: false,
    isUnique: true,
    isPrimary: true,
    comment: 'Primary key'
  },
  {
    name: 'name',
    dataType: 'varchar(255)',
    isNullable: false,
    isUnique: false,
    isPrimary: false,
    comment: 'Record name'
  }
];

// Create table with typed columns
await timbal.createTable({
  name: 'my_table',
  columns,
  comment: 'Example table'
});
```

## Development

```bash
# Install dependencies
bun install

# Run unit tests (mocked)
bun run test

# Type checking
bun run typecheck

# Build the library
bun run build

# Lint code
bun run lint

# Format code
bun run format
```

### Testing

The SDK includes both unit tests (with mocks) and integration tests (real API calls):

```bash
# Run only unit tests (default - no API calls)
bun run test:unit

# Run integration tests (requires real API credentials)
bun run test:integration

# Run all tests (unit + integration)
bun run test:all
```

#### Integration Testing Setup

To run integration tests with real API calls:

1. Copy the environment template:
   ```bash
   cp .env.example .env
   ```

2. Fill in your real credentials in `.env`:
   ```bash
   TIMBAL_API_KEY=your-actual-api-key
   TIMBAL_ORG_ID=your-organization-id
   TIMBAL_KB_ID=your-knowledge-base-id
   ```

3. Run integration tests:
   ```bash
   bun run test:integration
   ```

The integration tests will:
- Test real API connectivity
- Execute actual SQL queries against your knowledge base
- Test table creation and CSV import functionality
- Test error handling with invalid queries
- Test concurrent query performance

**Note:** Integration tests are automatically skipped if environment variables are not set.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for your changes
5. Run the test suite
6. Create a pull request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Support

- [GitHub Issues](https://github.com/timbal-ai/timbal-sdk/issues)
- [Documentation](https://docs.timbal.ai)
- [API Reference](https://api.timbal.ai/docs)

---

Made with ❤️ by the Timbal team
