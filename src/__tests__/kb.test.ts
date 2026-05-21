import { test, expect, describe, mock } from 'bun:test';
import {
  KB,
  KbsSection,
  KbFilesSection,
  KbFileNotFoundError,
  KbFileAlreadyExistsError,
  Timbal,
  TimbalApiError,
  type K2File,
  type K2FileDetail,
  type KbInfo,
} from '..';
import type { ApiClient } from '../lib/api';

const mockK2File: K2File = {
  id: '7',
  uid: 'k2f_abc',
  kb_id: '162',
  name: 'order.pdf',
  content_type: 'application/pdf',
  content_length: 1024,
  metadata: { source: 'cron' },
  directory: 'orders',
  parse_state: 'pending',
  url: 'https://content.timbal.ai/orgs/10/k2/162/files/7',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const mockK2FileDetail: K2FileDetail = {
  ...mockK2File,
  parsings: [],
  embeddings: [],
};

function makeMockClient(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  return {
    getConfig: () => ({
      orgId: '10',
      kbId: '',
      projectId: '',
      rev: 'main',
      token: 't',
      baseUrl: 'https://api.test',
      timeout: 30000,
      retryAttempts: 0,
      retryDelay: 0,
    }),
    get: mock(() => Promise.resolve({ data: null, success: true, statusCode: 200 })),
    post: mock(() => Promise.resolve({ data: { rows: [] }, success: true, statusCode: 200 })),
    delete: mock(() => Promise.resolve({ data: null, success: true, statusCode: 204 })),
    postFormData: mock(() => Promise.resolve({ data: mockK2File, success: true, statusCode: 200 })),
    ...overrides,
  } as unknown as ApiClient;
}

// ── KbsSection ──

describe('KbsSection', () => {
  test('get(id) returns a KB view synchronously (no network)', () => {
    const client = makeMockClient();
    const kbs = new KbsSection(client);

    const kb = kbs.get('162');

    expect(kb).toBeInstanceOf(KB);
    expect(kb.kbId).toBe('162');
    expect(kb.apiClient).toBe(client);
    expect((client.get as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  test('get(id) returns a fresh KB view per call (stateless)', () => {
    const client = makeMockClient();
    const kbs = new KbsSection(client);

    const a = kbs.get('162');
    const b = kbs.get('162');

    expect(a).not.toBe(b);
  });

  test('list() calls GET /orgs/{org}/k2 and returns array', async () => {
    const items: KbInfo[] = [
      { id: '1', uid: 'uid-1', name: 'kb-a', created_at: 't', updated_at: 't' },
      { id: '2', uid: 'uid-2', name: 'kb-b', created_at: 't', updated_at: 't' },
    ];
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: items, success: true, statusCode: 200 })),
    });
    const kbs = new KbsSection(client);

    const result = await kbs.list();

    expect(result).toEqual(items);
    expect((client.get as ReturnType<typeof mock>).mock.calls[0][0]).toBe('orgs/10/k2');
  });

  test('list() unwraps { k2 } envelope (current server shape)', async () => {
    const items: KbInfo[] = [{
      id: '296',
      uid: '019e45039ec472a09860becfbf413da5',
      name: 'electric-puffin',
      data_size_bytes: 12288,
      created_at: '2026-05-20T10:52:05Z',
      updated_at: '2026-05-20T10:52:05Z',
    }];
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: { k2: items }, success: true, statusCode: 200 })),
    });
    const kbs = new KbsSection(client);

    const result = await kbs.list();
    expect(result).toEqual(items);
  });

  test('list() also unwraps { items } envelope as a fallback', async () => {
    const items: KbInfo[] = [{
      id: '1',
      uid: 'u1',
      name: 'kb-a',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }];
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: { items }, success: true, statusCode: 200 })),
    });
    const kbs = new KbsSection(client);

    expect(await kbs.list()).toEqual(items);
  });

  test('list({ page_token }) threads pagination cursor', async () => {
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: [], success: true, statusCode: 200 })),
    });
    const kbs = new KbsSection(client);

    await kbs.list({ page_token: 'tok_xyz' });

    expect((client.get as ReturnType<typeof mock>).mock.calls[0][1]).toEqual({ page_token: 'tok_xyz' });
  });

  test('listPage() returns { k2, next_page_token } per OpenAPI ListK2Response', async () => {
    const items: KbInfo[] = [{
      id: '1', uid: 'u1', name: 'kb-a', created_at: 't', updated_at: 't',
    }];
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({
          data: { k2: items, next_page_token: 'tok_2' },
          success: true,
          statusCode: 200,
        }),
      ),
    });
    const kbs = new KbsSection(client);

    const page = await kbs.listPage();
    expect(page).toEqual({ k2: items, next_page_token: 'tok_2' });
  });

  test('iterate() walks multiple KB pages via next_page_token', async () => {
    const kb1: KbInfo = {
      id: '1', uid: 'u1', name: 'kb-a', created_at: 't', updated_at: 't',
    };
    const kb2: KbInfo = {
      id: '2', uid: 'u2', name: 'kb-b', created_at: 't', updated_at: 't',
    };
    const getMock = mock()
      .mockResolvedValueOnce({
        data: { k2: [kb1], next_page_token: 'tok_page_2' },
        success: true,
        statusCode: 200,
      })
      .mockResolvedValueOnce({
        data: { k2: [kb2], next_page_token: null },
        success: true,
        statusCode: 200,
      });
    const client = makeMockClient({ get: getMock });
    const kbs = new KbsSection(client);

    const out: KbInfo[] = [];
    for await (const kb of kbs.iterate()) out.push(kb);

    expect(out).toEqual([kb1, kb2]);
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(getMock.mock.calls[1][1]).toEqual({ page_token: 'tok_page_2' });
  });

  test('iterate() yields nothing when the org has no KBs', async () => {
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({
          data: { k2: [], next_page_token: null },
          success: true,
          statusCode: 200,
        }),
      ),
    });
    const kbs = new KbsSection(client);
    const out: KbInfo[] = [];
    for await (const kb of kbs.iterate()) out.push(kb);
    expect(out).toEqual([]);
  });

  test('listAll() drains every page into one array', async () => {
    const kb1: KbInfo = {
      id: '1', uid: 'u1', name: 'kb-a', created_at: 't', updated_at: 't',
    };
    const kb2: KbInfo = {
      id: '2', uid: 'u2', name: 'kb-b', created_at: 't', updated_at: 't',
    };
    const getMock = mock()
      .mockResolvedValueOnce({
        data: { k2: [kb1], next_page_token: 'tok_2' },
        success: true,
        statusCode: 200,
      })
      .mockResolvedValueOnce({
        data: { k2: [kb2], next_page_token: null },
        success: true,
        statusCode: 200,
      });
    const client = makeMockClient({ get: getMock });
    const kbs = new KbsSection(client);

    const all = await kbs.listAll();
    expect(all).toEqual([kb1, kb2]);
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  test('list() returns only the first page when more pages exist', async () => {
    const kb1: KbInfo = {
      id: '1', uid: 'u1', name: 'kb-a', created_at: 't', updated_at: 't',
    };
    const getMock = mock().mockResolvedValueOnce({
      data: { k2: [kb1], next_page_token: 'tok_2' },
      success: true,
      statusCode: 200,
    });
    const kbs = new KbsSection(makeMockClient({ get: getMock }));

    const first = await kbs.list();
    expect(first).toEqual([kb1]);
    expect(getMock).toHaveBeenCalledTimes(1);
  });
});

// ── KB ──

describe('KB', () => {
  test('query() routes to k2 endpoint with bound kbId', async () => {
    const client = makeMockClient({
      post: mock(() => Promise.resolve({ data: { rows: [{ n: 1 }] }, success: true, statusCode: 200 })),
    });
    const kb = new KB(client, '162');

    const result = await kb.query('SELECT 1');

    expect(result).toEqual({ rows: [{ n: 1 }] });
    expect((client.post as ReturnType<typeof mock>).mock.calls[0][0]).toBe('orgs/10/k2/162/query');
    expect((client.post as ReturnType<typeof mock>).mock.calls[0][1]).toEqual({ sql: 'SELECT 1', params: [] });
  });

  test('query() with legacy:true routes to /kbs/{kbId}/query and wraps array', async () => {
    const client = makeMockClient({
      post: mock(() => Promise.resolve({ data: [{ a: 1 }, { a: 2 }], success: true, statusCode: 200 })),
    });
    const kb = new KB(client, '162');

    const result = await kb.query('SELECT * FROM legacy', [], { legacy: true });

    expect((client.post as ReturnType<typeof mock>).mock.calls[0][0]).toBe('orgs/10/kbs/162/query');
    expect(result).toEqual({ rows: [{ a: 1 }, { a: 2 }] });
  });

  test('query() passes positional params through', async () => {
    const client = makeMockClient();
    const kb = new KB(client, '162');

    await kb.query('SELECT $1', ['pending']);

    expect((client.post as ReturnType<typeof mock>).mock.calls[0][1]).toEqual({
      sql: 'SELECT $1',
      params: ['pending'],
    });
  });

  test('query({ explain: true }) forwards explain to the request body', async () => {
    const client = makeMockClient();
    const kb = new KB(client, '162');

    await kb.query('SELECT 1', [], { explain: true });

    expect((client.post as ReturnType<typeof mock>).mock.calls[0][1]).toEqual({
      sql: 'SELECT 1',
      params: [],
      explain: true,
    });
  });

  test('schema() calls GET /k2/{kbId}/schema and returns K2Table[] from { tables } envelope', async () => {
    const tables = [{
      name: 'orders',
      source: 'primary',
      schema: 'main',
      columns: [{ name: 'id', data_type: 'INTEGER', is_nullable: false }],
      indexes: [],
      constraints: [{ constraint_type: 'PRIMARY_KEY', columns: ['id'] }],
      estimated_row_count: 0,
    }];
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: { tables }, success: true, statusCode: 200 })),
    });
    const kb = new KB(client, '162');

    const result = await kb.schema();

    expect(result).toEqual(tables);
    expect((client.get as ReturnType<typeof mock>).mock.calls[0][0]).toBe('orgs/10/k2/162/schema');
  });

  test('schema() also accepts a bare array response (defensive)', async () => {
    const tables = [{
      name: 'orders',
      source: 'primary',
      columns: [],
      indexes: [],
      constraints: [],
      estimated_row_count: 0,
    }];
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: tables, success: true, statusCode: 200 })),
    });
    const kb = new KB(client, '162');

    expect(await kb.schema()).toEqual(tables);
  });

  test('schema({ format: "sql" }) calls GET with format=sql and returns DDL strings', async () => {
    const statements = [
      'CREATE TABLE "orders" (id INTEGER PRIMARY KEY);',
      'CREATE INDEX idx_orders_status ON "orders" (status);',
    ];
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: { statements }, success: true, statusCode: 200 })),
    });
    const kb = new KB(client, '162');

    const result = await kb.schema({ format: 'sql' });

    expect(result).toEqual(statements);
    expect((client.get as ReturnType<typeof mock>).mock.calls[0][0]).toBe('orgs/10/k2/162/schema');
    expect((client.get as ReturnType<typeof mock>).mock.calls[0][1]).toEqual({ format: 'sql' });
  });

  test('schema({ format: "sql" }) accepts a bare statements array (defensive)', async () => {
    const statements = ['CREATE TABLE "x" (id INTEGER);'];
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: statements, success: true, statusCode: 200 })),
    });
    const kb = new KB(client, '162');

    expect(await kb.schema({ format: 'sql' })).toEqual(statements);
  });

  test('files is a lazy singleton (same instance returned)', () => {
    const client = makeMockClient();
    const kb = new KB(client, '162');

    expect(kb.files).toBeInstanceOf(KbFilesSection);
    expect(kb.files).toBe(kb.files);
  });

  test('apiClient and kbId are publicly readable', () => {
    const client = makeMockClient();
    const kb = new KB(client, '162');

    expect(kb.apiClient).toBe(client);
    expect(kb.kbId).toBe('162');
  });
});

// ── KbFilesSection ──

describe('KbFilesSection', () => {
  test('upload() posts multipart with file blob + default {} metadata to /k2/{kbId}/files', async () => {
    const client = makeMockClient();
    const kb = new KB(client, '162');

    const buf = new TextEncoder().encode('pdf bytes');
    const result = await kb.files.upload(buf, 'order.pdf');

    expect(result).toEqual(mockK2File);
    const [path, formData] = (client.postFormData as ReturnType<typeof mock>).mock.calls[0];
    expect(path).toBe('orgs/10/k2/162/files');
    expect(formData).toBeInstanceOf(FormData);
    const fd = formData as FormData;
    expect(fd.get('file')).toBeInstanceOf(Blob);
    // metadata is REQUIRED by the server — SDK defaults to `{}`.
    expect(fd.get('metadata')).toBe('{}');
    expect(fd.has('directory')).toBe(false);
    expect(fd.has('parse')).toBe(false);
  });

  test('upload() serializes metadata as JSON and includes directory + parse', async () => {
    const client = makeMockClient();
    const kb = new KB(client, '162');

    await kb.files.upload(new TextEncoder().encode('x'), 'order.pdf', {
      metadata: { source: 'cron', sha256: 'deadbeef' },
      directory: 'orders',
      parse: false,
    });

    const fd = (client.postFormData as ReturnType<typeof mock>).mock.calls[0][1] as FormData;
    expect(JSON.parse(fd.get('metadata') as string)).toEqual({ source: 'cron', sha256: 'deadbeef' });
    expect(fd.get('directory')).toBe('orders');
    expect(fd.get('parse')).toBe('false');
  });

  test('upload() accepts ArrayBuffer, Uint8Array, and Blob', async () => {
    const client = makeMockClient();
    const kb = new KB(client, '162');

    await kb.files.upload(new ArrayBuffer(8), 'a.bin');
    await kb.files.upload(new Uint8Array([1, 2, 3]), 'b.bin');
    await kb.files.upload(new Blob(['hi']), 'c.txt');

    expect((client.postFormData as ReturnType<typeof mock>).mock.calls).toHaveLength(3);
    for (const call of (client.postFormData as ReturnType<typeof mock>).mock.calls) {
      const fd = call[1] as FormData;
      expect(fd.get('file')).toBeInstanceOf(Blob);
    }
  });

  test('upload() wraps 409 in KbFileAlreadyExistsError carrying filename + directory', async () => {
    const client = makeMockClient({
      postFormData: mock(() => Promise.reject(new TimbalApiError('Conflict', 409, 'CONFLICT'))),
    });
    const kb = new KB(client, '162');

    let caught: unknown;
    try {
      await kb.files.upload(new Uint8Array([1]), 'dup.pdf', { directory: 'orders' });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(KbFileAlreadyExistsError);
    expect(caught).toBeInstanceOf(TimbalApiError);
    const err = caught as KbFileAlreadyExistsError;
    expect(err.kbId).toBe('162');
    expect(err.filename).toBe('dup.pdf');
    expect(err.directory).toBe('orders');
    expect(err.statusCode).toBe(409);
    expect(err.name).toBe('KbFileAlreadyExistsError');
  });

  test('upload() re-throws non-409 errors untouched', async () => {
    const client = makeMockClient({
      postFormData: mock(() => Promise.reject(new TimbalApiError('Server', 500))),
    });
    const kb = new KB(client, '162');

    let caught: unknown;
    try {
      await kb.files.upload(new Uint8Array([1]), 'x.pdf');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TimbalApiError);
    expect(caught).not.toBeInstanceOf(KbFileAlreadyExistsError);
    expect((caught as TimbalApiError).statusCode).toBe(500);
  });

  test('list() returns a page object and forwards directory + page_token', async () => {
    const page = { files: [mockK2File], next_page_token: 'tok_2' };
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: page, success: true, statusCode: 200 })),
    });
    const kb = new KB(client, '162');

    const result = await kb.files.list({ directory: 'orders', page_token: 'tok_1' });

    expect(result).toEqual(page);
    const [path, params] = (client.get as ReturnType<typeof mock>).mock.calls[0];
    expect(path).toBe('orgs/10/k2/162/files');
    expect(params).toEqual({ directory: 'orders', page_token: 'tok_1' });
  });

  test('list() wraps a bare array response into a page', async () => {
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: [mockK2File], success: true, statusCode: 200 })),
    });
    const kb = new KB(client, '162');

    const result = await kb.files.list();
    expect(result).toEqual({ files: [mockK2File] });
  });

  test('iterate() yields all files from a single page', async () => {
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({
          data: { files: [mockK2File], next_page_token: null },
          success: true,
          statusCode: 200,
        }),
      ),
    });
    const kb = new KB(client, '162');
    const out: K2File[] = [];
    for await (const f of kb.files.iterate({ directory: 'orders' })) out.push(f);

    expect(out).toEqual([mockK2File]);
    expect((client.get as ReturnType<typeof mock>)).toHaveBeenCalledTimes(1);
    expect((client.get as ReturnType<typeof mock>).mock.calls[0][1]).toEqual({
      directory: 'orders',
    });
  });

  test('iterate() walks multiple pages via next_page_token', async () => {
    const file2: K2File = { ...mockK2File, id: '8', name: 'b.pdf' };
    const getMock = mock()
      .mockResolvedValueOnce({
        data: { files: [mockK2File], next_page_token: 'tok_page_2' },
        success: true,
        statusCode: 200,
      })
      .mockResolvedValueOnce({
        data: { files: [file2], next_page_token: null },
        success: true,
        statusCode: 200,
      });
    const client = makeMockClient({ get: getMock });
    const kb = new KB(client, '162');

    const out: K2File[] = [];
    for await (const f of kb.files.iterate()) out.push(f);

    expect(out).toEqual([mockK2File, file2]);
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(getMock.mock.calls[0][1]).toBeUndefined();
    expect(getMock.mock.calls[1][1]).toEqual({ page_token: 'tok_page_2' });
  });

  test('iterate() yields nothing when the first page is empty', async () => {
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({
          data: { files: [], next_page_token: null },
          success: true,
          statusCode: 200,
        }),
      ),
    });
    const kb = new KB(client, '162');
    const out: K2File[] = [];
    for await (const f of kb.files.iterate()) out.push(f);
    expect(out).toEqual([]);
  });

  test('iterate() can resume from an initial page_token', async () => {
    const getMock = mock(() =>
      Promise.resolve({
        data: { files: [mockK2File], next_page_token: null },
        success: true,
        statusCode: 200,
      }),
    );
    const client = makeMockClient({ get: getMock });
    const kb = new KB(client, '162');

    const out: K2File[] = [];
    for await (const f of kb.files.iterate({ page_token: 'tok_resume' })) out.push(f);

    expect(out).toEqual([mockK2File]);
    expect(getMock.mock.calls[0][1]).toEqual({ page_token: 'tok_resume' });
  });

  test('get() returns the extended K2FileDetail (with parsings + embeddings)', async () => {
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: mockK2FileDetail, success: true, statusCode: 200 })),
    });
    const kb = new KB(client, '162');

    const result = await kb.files.get(7);
    expect(result).toEqual(mockK2FileDetail);
    expect(result.parsings).toEqual([]);
    expect(result.embeddings).toEqual([]);
    expect((client.get as ReturnType<typeof mock>).mock.calls[0][0]).toBe('orgs/10/k2/162/files/7');
  });

  test('get() wraps 404 in KbFileNotFoundError', async () => {
    const client = makeMockClient({
      get: mock(() => Promise.reject(new TimbalApiError('Not Found', 404))),
    });
    const kb = new KB(client, '162');

    let caught: unknown;
    try {
      await kb.files.get(999);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(KbFileNotFoundError);
    expect(caught).toBeInstanceOf(TimbalApiError);
    const err = caught as KbFileNotFoundError;
    expect(err.kbId).toBe('162');
    expect(err.fileId).toBe('999');
    expect(err.statusCode).toBe(404);
  });

  test('delete() calls DELETE and resolves void on success', async () => {
    const client = makeMockClient();
    const kb = new KB(client, '162');

    const result = await kb.files.delete(7);

    expect(result).toBeUndefined();
    expect((client.delete as ReturnType<typeof mock>).mock.calls[0][0]).toBe('orgs/10/k2/162/files/7');
  });

  test('delete() is idempotent — backend 204 on missing file resolves void, no error', async () => {
    const client = makeMockClient(); // default delete mock returns 204
    const kb = new KB(client, '162');

    const result = await kb.files.delete(999);
    expect(result).toBeUndefined();
  });

  test('delete() still propagates non-404 errors (e.g. 500)', async () => {
    const client = makeMockClient({
      delete: mock(() => Promise.reject(new TimbalApiError('Server', 500))),
    });
    const kb = new KB(client, '162');

    await expect(kb.files.delete(7)).rejects.toThrow(TimbalApiError);
  });

  test('kbId is publicly readable on the section', () => {
    const client = makeMockClient();
    const kb = new KB(client, '162');
    expect(kb.files.kbId).toBe('162');
  });
});

// ── Timbal wiring ──

describe('Timbal.kbs wiring', () => {
  test('Timbal exposes a kbs section as a lazy singleton', () => {
    const t = new Timbal({ token: 'k', orgId: '10', baseUrl: 'https://api.test' });
    expect(t.kbs).toBeInstanceOf(KbsSection);
    expect(t.kbs).toBe(t.kbs);
  });

  test('apiClient is publicly readable on Timbal (semver-committed)', () => {
    const t = new Timbal({ token: 'k', orgId: '10', baseUrl: 'https://api.test' });
    expect(t.apiClient).toBeDefined();
    expect(t.apiClient).toBe(t.getApiClient());
  });

  test('kbs.get returns a KB bound to the shared apiClient', () => {
    const t = new Timbal({ token: 'k', orgId: '10', baseUrl: 'https://api.test' });
    const kb = t.kbs.get('162');
    expect(kb.apiClient).toBe(t.apiClient);
    expect(kb.kbId).toBe('162');
  });

  test('escape hatch: new KB(timbal.apiClient, id) works directly', () => {
    const t = new Timbal({ token: 'k', orgId: '10', baseUrl: 'https://api.test' });
    const kb = new KB(t.apiClient, '162');
    expect(kb.apiClient).toBe(t.apiClient);
    expect(kb.kbId).toBe('162');
  });
});

// ── Backward compat ──

describe('Timbal backward compat (zero breaking changes)', () => {
  test('Timbal.query signature unchanged — still accepts QueryOptions', async () => {
    const post = mock(() => Promise.resolve({ data: { rows: [{ n: 1 }] }, success: true, statusCode: 200 }));
    const t = new Timbal({ token: 'k', orgId: '10', baseUrl: 'https://api.test' });
    (t.apiClient as unknown as { post: typeof post }).post = post;

    const result = await t.query('SELECT 1', [], { kbId: '162', orgId: '10' });

    expect(result).toEqual({ rows: [{ n: 1 }] });
    expect(post.mock.calls[0][0]).toBe('orgs/10/k2/162/query');
  });

  test('Timbal.query still honors legacy flag', async () => {
    const post = mock(() => Promise.resolve({ data: [{ a: 1 }], success: true, statusCode: 200 }));
    const t = new Timbal({ token: 'k', orgId: '10', baseUrl: 'https://api.test' });
    (t.apiClient as unknown as { post: typeof post }).post = post;

    const result = await t.query('SELECT 1', [], { kbId: '162', legacy: true });

    expect(post.mock.calls[0][0]).toBe('orgs/10/kbs/162/query');
    expect(result).toEqual({ rows: [{ a: 1 }] });
  });

  test('Timbal.uploadFileFromBuffer still hits the org bucket', async () => {
    const postFormData = mock(() => Promise.resolve({
      data: { id: 1, name: 'x', content_type: 't', content_length: 1, created_at: '', url: '' },
      success: true,
      statusCode: 200,
    }));
    const t = new Timbal({ token: 'k', orgId: '10', baseUrl: 'https://api.test' });
    (t.apiClient as unknown as { postFormData: typeof postFormData }).postFormData = postFormData;

    await t.uploadFileFromBuffer(new TextEncoder().encode('hi'), 'hi.txt');

    expect(postFormData.mock.calls[0][0]).toBe('orgs/10/files');
  });
});
