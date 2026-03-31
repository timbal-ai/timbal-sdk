import { test, expect, describe, beforeEach, mock } from 'bun:test';
import { query } from '../lib/functions/query';

// k2 returns { rows: [...], ... } natively
const mockApiClient = {
  post: mock(() => Promise.resolve({ data: { rows: [{ count: 5 }] } })),
  getConfig: () => ({
    orgId: process.env.TIMBAL_ORG_ID ?? '',
    kbId: process.env.TIMBAL_KB_ID ?? '',
    projectId: '',
    envId: '',
    token: '',
  }),
} as any;

describe('query', () => {
  beforeEach(() => {
    mockApiClient.post.mockClear();
  });

  test('should execute query and return result with rows', async () => {
    const result = await query(mockApiClient, 'SELECT COUNT(*) FROM "Documents"', [], {
      orgId: '123',
      kbId: '456',
    });

    expect(mockApiClient.post).toHaveBeenCalledWith('orgs/123/k2/456/query', {
      sql: 'SELECT COUNT(*) FROM "Documents"',
      params: [],
    });
    expect(result).toEqual({ rows: [{ count: 5 }] });
  });

  test('should construct correct path from orgId and kbId', async () => {
    await query(mockApiClient, 'SELECT 1', [], { orgId: 'org-abc', kbId: 'kb-xyz' });

    expect(mockApiClient.post).toHaveBeenCalledWith('orgs/org-abc/k2/kb-xyz/query', {
      sql: 'SELECT 1',
      params: [],
    });
  });

  test('should pass params for parameterized queries', async () => {
    await query(
      mockApiClient,
      'INSERT INTO "Documents" (id, name) VALUES ($1, $2) RETURNING *',
      [1, 'example.txt'],
      { orgId: '10', kbId: '48' }
    );

    expect(mockApiClient.post).toHaveBeenCalledWith('orgs/10/k2/48/query', {
      sql: 'INSERT INTO "Documents" (id, name) VALUES ($1, $2) RETURNING *',
      params: [1, 'example.txt'],
    });
  });

  test('should default params to empty array', async () => {
    await query(mockApiClient, 'SELECT 1', undefined, { orgId: '1', kbId: '2' });

    const payload = mockApiClient.post.mock.calls[0][1];
    expect(payload.params).toEqual([]);
  });

  test('should return empty rows when API returns no rows', async () => {
    mockApiClient.post.mockResolvedValueOnce({ data: { rows: [] } });

    const result = await query(mockApiClient, 'SELECT * FROM empty_table', [], {
      orgId: '1',
      kbId: '2',
    });
    expect(result.rows).toEqual([]);
  });

  test('should return multiple rows', async () => {
    mockApiClient.post.mockResolvedValueOnce({
      data: { rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] },
    });

    const result = await query(mockApiClient, 'SELECT * FROM users', [], {
      orgId: '1',
      kbId: '2',
    });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ id: 1, name: 'Alice' });
    expect(result.rows[1]).toEqual({ id: 2, name: 'Bob' });
  });

  test('should propagate API errors', async () => {
    mockApiClient.post.mockRejectedValueOnce(new Error('Query failed'));

    await expect(
      query(mockApiClient, 'INVALID SQL', [], { orgId: '1', kbId: '2' })
    ).rejects.toThrow('Query failed');
  });

  test('should fall back to env vars for orgId and kbId', async () => {
    const origOrg = process.env.TIMBAL_ORG_ID;
    const origKb = process.env.TIMBAL_KB_ID;
    process.env.TIMBAL_ORG_ID = 'env-org';
    process.env.TIMBAL_KB_ID = 'env-kb';

    try {
      await query(mockApiClient, 'SELECT 1');

      expect(mockApiClient.post).toHaveBeenCalledWith('orgs/env-org/k2/env-kb/query', {
        sql: 'SELECT 1',
        params: [],
      });
    } finally {
      if (origOrg === undefined) delete process.env.TIMBAL_ORG_ID;
      else process.env.TIMBAL_ORG_ID = origOrg;
      if (origKb === undefined) delete process.env.TIMBAL_KB_ID;
      else process.env.TIMBAL_KB_ID = origKb;
    }
  });

  test('should throw when orgId missing and no env var', async () => {
    const origOrg = process.env.TIMBAL_ORG_ID;
    delete process.env.TIMBAL_ORG_ID;

    try {
      await expect(
        query(mockApiClient, 'SELECT 1', [], { kbId: '2' })
      ).rejects.toThrow('orgId is required');
    } finally {
      if (origOrg !== undefined) process.env.TIMBAL_ORG_ID = origOrg;
    }
  });

  test('should default to k2 path when legacy option is omitted', async () => {
    await query(mockApiClient, 'SELECT * FROM documents', [], {
      orgId: '123',
      kbId: '456',
    });

    expect(mockApiClient.post).toHaveBeenCalledWith('orgs/123/k2/456/query', {
      sql: 'SELECT * FROM documents',
      params: [],
    });
  });

  test('should use legacy path and wrap rows when legacy option is true', async () => {
    // legacy endpoint returns a raw array of rows
    mockApiClient.post.mockResolvedValueOnce({ data: [{ id: 1 }, { id: 2 }] });

    const result = await query(mockApiClient, 'SELECT * FROM documents', [], {
      orgId: '123',
      kbId: '456',
      legacy: true,
    });

    expect(mockApiClient.post).toHaveBeenCalledWith('orgs/123/kbs/456/query', {
      sql: 'SELECT * FROM documents',
      params: [],
    });
    expect(result).toEqual({ rows: [{ id: 1 }, { id: 2 }] });
  });

  test('should throw when kbId missing and no env var', async () => {
    const origKb = process.env.TIMBAL_KB_ID;
    delete process.env.TIMBAL_KB_ID;

    try {
      await expect(
        query(mockApiClient, 'SELECT 1', [], { orgId: '1' })
      ).rejects.toThrow('kbId is required');
    } finally {
      if (origKb !== undefined) process.env.TIMBAL_KB_ID = origKb;
    }
  });
});
