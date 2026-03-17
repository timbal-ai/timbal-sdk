import { test, expect, describe, beforeEach, mock } from 'bun:test';
import { query } from '../lib/functions/query';

const mockApiClient = {
  post: mock(() => Promise.resolve({ data: [{ count: 5 }] })),
  getConfig: () => ({
    orgId: process.env.TIMBAL_ORG_ID ?? '',
    kbId: process.env.TIMBAL_KB_ID ?? '',
    projectId: '',
    projectEnvId: '',
    token: '',
  }),
} as any;

describe('query', () => {
  beforeEach(() => {
    mockApiClient.post.mockClear();
  });

  test('should execute query and return results', async () => {
    const result = await query(mockApiClient, 'SELECT COUNT(*) FROM "Documents"', [], {
      orgId: '123',
      kbId: '456',
    });

    expect(mockApiClient.post).toHaveBeenCalledWith('orgs/123/kbs/456/query', {
      sql: 'SELECT COUNT(*) FROM "Documents"',
      params: [],
    });
    expect(result).toEqual([{ count: 5 }]);
  });

  test('should construct correct path from orgId and kbId', async () => {
    await query(mockApiClient, 'SELECT 1', [], { orgId: 'org-abc', kbId: 'kb-xyz' });

    expect(mockApiClient.post).toHaveBeenCalledWith('orgs/org-abc/kbs/kb-xyz/query', {
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

    expect(mockApiClient.post).toHaveBeenCalledWith('orgs/10/kbs/48/query', {
      sql: 'INSERT INTO "Documents" (id, name) VALUES ($1, $2) RETURNING *',
      params: [1, 'example.txt'],
    });
  });

  test('should default params to empty array', async () => {
    await query(mockApiClient, 'SELECT 1', undefined, { orgId: '1', kbId: '2' });

    const payload = mockApiClient.post.mock.calls[0][1];
    expect(payload.params).toEqual([]);
  });

  test('should return empty array when API returns empty', async () => {
    mockApiClient.post.mockResolvedValueOnce({ data: [] });

    const result = await query(mockApiClient, 'SELECT * FROM empty_table', [], {
      orgId: '1',
      kbId: '2',
    });
    expect(result).toEqual([]);
  });

  test('should return multiple rows', async () => {
    mockApiClient.post.mockResolvedValueOnce({
      data: [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ],
    });

    const result = await query(mockApiClient, 'SELECT * FROM users', [], {
      orgId: '1',
      kbId: '2',
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 1, name: 'Alice' });
    expect(result[1]).toEqual({ id: 2, name: 'Bob' });
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

      expect(mockApiClient.post).toHaveBeenCalledWith('orgs/env-org/kbs/env-kb/query', {
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
