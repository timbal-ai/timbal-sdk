import { test, expect, describe, mock } from 'bun:test';
import {
  IntegrationConsentRequiredError,
  IntegrationsSection,
  IntegrationsCatalog,
  IntegrationNotFoundError,
  PersonalConnectionRef,
  PersonalConnectionsSection,
  SharedConnectionRef,
  SharedConnectionsSection,
  Timbal,
  TimbalApiError,
  type IntegrationCatalogEntry,
  type PersonalConnection,
  type SharedConnection,
} from '..';
import type { ApiClient } from '../lib/api';

const airtable: IntegrationCatalogEntry = {
  id: '116',
  name: 'Airtable',
  provider: 'airtable',
  description: 'Connect to Airtable',
  logo_url: 'https://content.timbal.ai/assets/airtable_favicon.svg',
  auth_methods: [{ type: 'credentials', parameters: [] }],
  tags: [],
  min_plan: 'free',
  visibility: 'public',
  enabled: true,
};

const excel: IntegrationCatalogEntry = {
  id: '388',
  name: 'Excel',
  provider: 'excel',
  description: 'Connect Excel',
  logo_url: 'https://content.timbal.ai/assets/excel_favicon.svg',
  auth_methods: [{ type: 'oauth' }],
  tags: [],
  min_plan: 'free',
  visibility: 'public',
  enabled: false,
};

function makeMockClient(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  return {
    getConfig: () => ({
      orgId: '1',
      kbId: '',
      projectId: '',
      rev: 'main',
      token: 't',
      baseUrl: 'https://api.test',
      timeout: 30000,
      retryAttempts: 0,
      retryDelay: 0,
    }),
    get: mock(() => Promise.resolve({ data: { integrations: [airtable, excel] }, success: true, statusCode: 200 })),
    post: mock(() => Promise.resolve({ data: { provider: 'airtable' }, success: true, statusCode: 200 })),
    ...overrides,
  } as unknown as ApiClient;
}

// ── IntegrationsCatalog ────────────────────────────────────────────────────

describe('IntegrationsCatalog', () => {
  test('list() calls GET /integrations?org_id=... and returns the integrations array', async () => {
    const client = makeMockClient();
    const cat = new IntegrationsCatalog(client);

    const result = await cat.list();

    expect(result).toEqual([airtable, excel]);
    const [path, params] = (client.get as ReturnType<typeof mock>).mock.calls[0];
    expect(path).toBe('integrations');
    expect(params).toEqual({ org_id: '1' });
  });

  test('list() forwards an override orgId as the org_id query param', async () => {
    const client = makeMockClient();
    const cat = new IntegrationsCatalog(client);

    await cat.list({ orgId: '9' });

    expect((client.get as ReturnType<typeof mock>).mock.calls[0][1]).toEqual({ org_id: '9' });
  });

  test('list() threads page_token when provided', async () => {
    const client = makeMockClient();
    const cat = new IntegrationsCatalog(client);

    await cat.list({ page_token: 'tok_xyz' });

    expect((client.get as ReturnType<typeof mock>).mock.calls[0][1]).toEqual({
      org_id: '1',
      page_token: 'tok_xyz',
    });
  });

  test('list() handles a bare array response (defensive)', async () => {
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: [airtable], success: true, statusCode: 200 })),
    });
    const cat = new IntegrationsCatalog(client);

    expect(await cat.list()).toEqual([airtable]);
  });

  test('list() unwraps { items } envelope as a fallback', async () => {
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: { items: [excel] }, success: true, statusCode: 200 })),
    });
    const cat = new IntegrationsCatalog(client);

    expect(await cat.list()).toEqual([excel]);
  });

  test('list() returns [] on null/empty data', async () => {
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: null, success: true, statusCode: 200 })),
    });
    expect(await new IntegrationsCatalog(client).list()).toEqual([]);
  });

  test('list() throws when orgId is missing everywhere', async () => {
    const client = {
      getConfig: () => ({
        orgId: '', kbId: '', projectId: '', rev: 'main', token: 't',
        baseUrl: 'https://api.test', timeout: 30000, retryAttempts: 0, retryDelay: 0,
      }),
      get: mock(() => Promise.resolve({ data: {}, success: true, statusCode: 200 })),
    } as unknown as ApiClient;

    await expect(new IntegrationsCatalog(client).list()).rejects.toThrow(/orgId is required/);
  });

  test('listPage() returns { integrations, next_page_token? } envelope', async () => {
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({
          data: { integrations: [airtable], next_page_token: 'tok_2' },
          success: true,
          statusCode: 200,
        }),
      ),
    });
    const cat = new IntegrationsCatalog(client);

    const page = await cat.listPage();
    expect(page).toEqual({ integrations: [airtable], next_page_token: 'tok_2' });
  });

  test('iterate() walks multiple pages via next_page_token', async () => {
    const getMock = mock()
      .mockResolvedValueOnce({
        data: { integrations: [airtable], next_page_token: 'tok_p2' },
        success: true,
        statusCode: 200,
      })
      .mockResolvedValueOnce({
        data: { integrations: [excel], next_page_token: null },
        success: true,
        statusCode: 200,
      });
    const client = makeMockClient({ get: getMock });
    const cat = new IntegrationsCatalog(client);

    const out: IntegrationCatalogEntry[] = [];
    for await (const e of cat.iterate()) out.push(e);

    expect(out).toEqual([airtable, excel]);
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(getMock.mock.calls[1][1]).toEqual({ org_id: '1', page_token: 'tok_p2' });
  });

  test('iterate() yields nothing for an empty catalog', async () => {
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({
          data: { integrations: [], next_page_token: null },
          success: true,
          statusCode: 200,
        }),
      ),
    });
    const cat = new IntegrationsCatalog(client);
    const out: IntegrationCatalogEntry[] = [];
    for await (const e of cat.iterate()) out.push(e);
    expect(out).toEqual([]);
  });

  test('listAll() drains every page into one array', async () => {
    const getMock = mock()
      .mockResolvedValueOnce({
        data: { integrations: [airtable], next_page_token: 'tok_2' },
        success: true,
        statusCode: 200,
      })
      .mockResolvedValueOnce({
        data: { integrations: [excel], next_page_token: null },
        success: true,
        statusCode: 200,
      });
    const client = makeMockClient({ get: getMock });
    const cat = new IntegrationsCatalog(client);

    expect(await cat.listAll()).toEqual([airtable, excel]);
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  test('list() returns only the first page when more pages exist', async () => {
    const getMock = mock().mockResolvedValueOnce({
      data: { integrations: [airtable], next_page_token: 'tok_2' },
      success: true,
      statusCode: 200,
    });
    const cat = new IntegrationsCatalog(makeMockClient({ get: getMock }));

    expect(await cat.list()).toEqual([airtable]);
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  test('enable() POSTs to /orgs/{org}/integrations/enable with the provider', async () => {
    const client = makeMockClient();
    const cat = new IntegrationsCatalog(client);

    const result = await cat.enable('airtable');

    expect(result).toEqual({ provider: 'airtable' });
    const [path, body] = (client.post as ReturnType<typeof mock>).mock.calls[0];
    expect(path).toBe('orgs/1/integrations/enable');
    expect(body).toEqual({ provider: 'airtable' });
  });

  test('enable() falls back to the input provider if server omits it', async () => {
    const client = makeMockClient({
      post: mock(() => Promise.resolve({ data: {}, success: true, statusCode: 200 })),
    });
    const cat = new IntegrationsCatalog(client);

    expect(await cat.enable('gmail')).toEqual({ provider: 'gmail' });
  });

  test('enable() wraps 404 in IntegrationNotFoundError carrying provider', async () => {
    const client = makeMockClient({
      post: mock(() => Promise.reject(new TimbalApiError('Integration not found', 404, 'NOT_FOUND'))),
    });
    const cat = new IntegrationsCatalog(client);

    let caught: unknown;
    try {
      await cat.enable('nonexistent_xyz');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(IntegrationNotFoundError);
    expect(caught).toBeInstanceOf(TimbalApiError);
    const err = caught as IntegrationNotFoundError;
    expect(err.provider).toBe('nonexistent_xyz');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.name).toBe('IntegrationNotFoundError');
  });

  test('enable() re-throws non-404 errors untouched', async () => {
    const client = makeMockClient({
      post: mock(() => Promise.reject(new TimbalApiError('Server', 500))),
    });
    const cat = new IntegrationsCatalog(client);

    let caught: unknown;
    try {
      await cat.enable('airtable');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TimbalApiError);
    expect(caught).not.toBeInstanceOf(IntegrationNotFoundError);
    expect((caught as TimbalApiError).statusCode).toBe(500);
  });

  test('disable() POSTs to /orgs/{org}/integrations/disable with the provider', async () => {
    const client = makeMockClient({
      post: mock(() => Promise.resolve({ data: { provider: 'slack' }, success: true, statusCode: 200 })),
    });
    const cat = new IntegrationsCatalog(client);

    const result = await cat.disable('slack');

    expect(result).toEqual({ provider: 'slack' });
    const [path, body] = (client.post as ReturnType<typeof mock>).mock.calls[0];
    expect(path).toBe('orgs/1/integrations/disable');
    expect(body).toEqual({ provider: 'slack' });
  });

  test('disable() falls back to the input provider if server omits it', async () => {
    const client = makeMockClient({
      post: mock(() => Promise.resolve({ data: {}, success: true, statusCode: 200 })),
    });
    const cat = new IntegrationsCatalog(client);

    expect(await cat.disable('slack')).toEqual({ provider: 'slack' });
  });

  test('disable() wraps 404 in IntegrationNotFoundError carrying provider', async () => {
    const client = makeMockClient({
      post: mock(() => Promise.reject(new TimbalApiError('Integration not found', 404, 'NOT_FOUND'))),
    });
    const cat = new IntegrationsCatalog(client);

    let caught: unknown;
    try {
      await cat.disable('nonexistent_xyz');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(IntegrationNotFoundError);
    expect(caught).toBeInstanceOf(TimbalApiError);
    const err = caught as IntegrationNotFoundError;
    expect(err.provider).toBe('nonexistent_xyz');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.name).toBe('IntegrationNotFoundError');
  });

  test('disable() re-throws non-404 errors untouched', async () => {
    const client = makeMockClient({
      post: mock(() => Promise.reject(new TimbalApiError('Server', 500))),
    });
    const cat = new IntegrationsCatalog(client);

    let caught: unknown;
    try {
      await cat.disable('slack');
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TimbalApiError);
    expect(caught).not.toBeInstanceOf(IntegrationNotFoundError);
    expect((caught as TimbalApiError).statusCode).toBe(500);
  });

  test('isEnabled() returns true when the provider is in the catalog and enabled', async () => {
    const client = makeMockClient();
    const cat = new IntegrationsCatalog(client);

    expect(await cat.isEnabled('airtable')).toBe(true);
  });

  test('isEnabled() returns false for disabled providers', async () => {
    const client = makeMockClient();
    const cat = new IntegrationsCatalog(client);

    expect(await cat.isEnabled('excel')).toBe(false);
  });

  test('isEnabled() returns false for unknown providers', async () => {
    const client = makeMockClient();
    const cat = new IntegrationsCatalog(client);

    expect(await cat.isEnabled('not_in_catalog')).toBe(false);
  });

  test('isEnabled() walks pages until a match (early exit on hit)', async () => {
    const page1: IntegrationCatalogEntry[] = [
      { ...airtable, provider: 'a', enabled: false },
      { ...airtable, provider: 'b', enabled: false },
    ];
    const page2: IntegrationCatalogEntry[] = [
      { ...airtable, provider: 'c', enabled: true },
    ];
    const getMock = mock()
      .mockResolvedValueOnce({
        data: { integrations: page1, next_page_token: 'p2' },
        success: true,
        statusCode: 200,
      })
      .mockResolvedValueOnce({
        data: { integrations: page2, next_page_token: null },
        success: true,
        statusCode: 200,
      });
    const cat = new IntegrationsCatalog(makeMockClient({ get: getMock }));

    expect(await cat.isEnabled('c')).toBe(true);
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});

// ── IntegrationsSection ────────────────────────────────────────────────────

describe('IntegrationsSection', () => {
  test('catalog is a lazy singleton (same instance on repeat access)', () => {
    const client = makeMockClient();
    const section = new IntegrationsSection(client);

    expect(section.catalog).toBeInstanceOf(IntegrationsCatalog);
    expect(section.catalog).toBe(section.catalog);
  });
});

// ── Shared connections ─────────────────────────────────────────────────────

const sharedSlack: SharedConnection = {
  id: '10',
  integration_id: '3',
  auth_type: 'oauth',
  connection_mode: 'org',
  label: 'Acme Slack',
  status: 'active',
  integration_name: 'Slack',
  integration_provider: 'slack',
  integration_logo_url: 'https://content.timbal.ai/assets/slack_favicon.svg',
  metadata: { account_name: 'Acme Workspace', team_id: 'T012345' },
  expires_at: '2026-06-01T12:00:00Z',
  created_at: '2026-04-10T09:00:00Z',
  updated_at: '2026-05-20T14:00:00Z',
};

const sharedExcel: SharedConnection = {
  id: '11',
  integration_id: '388',
  auth_type: 'oauth',
  connection_mode: 'org',
  label: null,
  status: 'active',
  integration_name: 'Excel',
  integration_provider: 'excel',
  integration_logo_url: 'https://content.timbal.ai/assets/excel_favicon.svg',
  metadata: {},
  expires_at: null,
  created_at: '2026-05-26T10:02:55Z',
  updated_at: '2026-05-26T10:02:55Z',
};

describe('SharedConnectionsSection', () => {
  test('list() calls GET /orgs/{org}/integrations?connection_mode=org', async () => {
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({
          data: { integrations: [sharedSlack], next_page_token: null },
          success: true,
          statusCode: 200,
        }),
      ),
    });
    const shared = new SharedConnectionsSection(client);

    const result = await shared.list();

    expect(result).toEqual([sharedSlack]);
    const [path, params] = (client.get as ReturnType<typeof mock>).mock.calls[0];
    expect(path).toBe('orgs/1/integrations');
    expect(params).toEqual({ connection_mode: 'org' });
  });

  test('list() threads page_token when provided', async () => {
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({ data: { integrations: [] }, success: true, statusCode: 200 }),
      ),
    });
    const shared = new SharedConnectionsSection(client);

    await shared.list({ page_token: 'tok_xyz' });

    expect((client.get as ReturnType<typeof mock>).mock.calls[0][1]).toEqual({
      connection_mode: 'org',
      page_token: 'tok_xyz',
    });
  });

  test('list() overrides orgId via options', async () => {
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({ data: { integrations: [] }, success: true, statusCode: 200 }),
      ),
    });
    const shared = new SharedConnectionsSection(client);

    await shared.list({ orgId: '42' });

    expect((client.get as ReturnType<typeof mock>).mock.calls[0][0]).toBe('orgs/42/integrations');
  });

  test('listPage() coerces numeric next_page_token to string (wire returns a number)', async () => {
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({
          data: { integrations: [sharedSlack], next_page_token: 30 },
          success: true,
          statusCode: 200,
        }),
      ),
    });
    const shared = new SharedConnectionsSection(client);

    const page = await shared.listPage();
    expect(page.integrations).toEqual([sharedSlack]);
    expect(page.next_page_token).toBe('30');
    expect(typeof page.next_page_token).toBe('string');
  });

  test('iterate() walks pages using the coerced string token', async () => {
    const getMock = mock()
      .mockResolvedValueOnce({
        data: { integrations: [sharedSlack], next_page_token: 30 },
        success: true,
        statusCode: 200,
      })
      .mockResolvedValueOnce({
        data: { integrations: [sharedExcel], next_page_token: null },
        success: true,
        statusCode: 200,
      });
    const shared = new SharedConnectionsSection(makeMockClient({ get: getMock }));

    const out: SharedConnection[] = [];
    for await (const c of shared.iterate()) out.push(c);

    expect(out).toEqual([sharedSlack, sharedExcel]);
    expect(getMock).toHaveBeenCalledTimes(2);
    expect(getMock.mock.calls[1][1]).toEqual({ connection_mode: 'org', page_token: '30' });
  });

  test('listAll() drains every page', async () => {
    const getMock = mock()
      .mockResolvedValueOnce({
        data: { integrations: [sharedSlack], next_page_token: 1 },
        success: true,
        statusCode: 200,
      })
      .mockResolvedValueOnce({
        data: { integrations: [sharedExcel], next_page_token: null },
        success: true,
        statusCode: 200,
      });
    const shared = new SharedConnectionsSection(makeMockClient({ get: getMock }));

    expect(await shared.listAll()).toEqual([sharedSlack, sharedExcel]);
  });

  test('byProvider() returns the matching connection across pages', async () => {
    const getMock = mock()
      .mockResolvedValueOnce({
        data: { integrations: [sharedSlack], next_page_token: 1 },
        success: true,
        statusCode: 200,
      })
      .mockResolvedValueOnce({
        data: { integrations: [sharedExcel], next_page_token: null },
        success: true,
        statusCode: 200,
      });
    const shared = new SharedConnectionsSection(makeMockClient({ get: getMock }));

    expect(await shared.byProvider('excel')).toEqual(sharedExcel);
  });

  test('byProvider() returns null when no row matches', async () => {
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({
          data: { integrations: [sharedSlack], next_page_token: null },
          success: true,
          statusCode: 200,
        }),
      ),
    });
    const shared = new SharedConnectionsSection(client);

    expect(await shared.byProvider('not_in_list')).toBeNull();
  });

  test('list() handles a bare array response (defensive)', async () => {
    const client = makeMockClient({
      get: mock(() => Promise.resolve({ data: [sharedSlack], success: true, statusCode: 200 })),
    });
    expect(await new SharedConnectionsSection(client).list()).toEqual([sharedSlack]);
  });

  test('list() throws when orgId is missing everywhere', async () => {
    const client = {
      getConfig: () => ({
        orgId: '', kbId: '', projectId: '', rev: 'main', token: 't',
        baseUrl: 'https://api.test', timeout: 30000, retryAttempts: 0, retryDelay: 0,
      }),
      get: mock(() => Promise.resolve({ data: {}, success: true, statusCode: 200 })),
    } as unknown as ApiClient;

    await expect(new SharedConnectionsSection(client).list()).rejects.toThrow(/orgId is required/);
  });
});

// ── Personal connections ───────────────────────────────────────────────────

const personalGmailDisconnected: PersonalConnection = {
  id: '15',
  integration_id: '8',
  auth_type: 'oauth',
  connection_mode: 'user',
  label: null,
  status: 'active',
  integration_name: 'Gmail',
  integration_provider: 'gmail',
  integration_logo_url: 'https://content.timbal.ai/assets/gmail_favicon.svg',
  metadata: {},
  expires_at: null,
  created_at: '2026-05-01T10:00:00Z',
  updated_at: '2026-05-01T10:00:00Z',
  user: { connected: false },
};

const personalGmailConnected: PersonalConnection = {
  ...personalGmailDisconnected,
  user: {
    connected: true,
    status: 'active',
    expires_at: '2026-06-01T12:00:00Z',
    metadata: { account_email: 'you@example.com', account_name: 'You Example' },
  },
};

const personalSlackExpired: PersonalConnection = {
  ...personalGmailDisconnected,
  id: '16',
  integration_provider: 'slack',
  integration_name: 'Slack',
  user: { connected: false, status: 'expired', expires_at: '2026-05-01T00:00:00Z' },
};

describe('PersonalConnectionsSection', () => {
  test('list() calls GET /orgs/{org}/integrations?connection_mode=user', async () => {
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({
          data: { integrations: [personalGmailDisconnected], next_page_token: null },
          success: true,
          statusCode: 200,
        }),
      ),
    });
    const personal = new PersonalConnectionsSection(client);

    const result = await personal.list();
    expect(result).toEqual([personalGmailDisconnected]);
    const [path, params] = (client.get as ReturnType<typeof mock>).mock.calls[0];
    expect(path).toBe('orgs/1/integrations');
    expect(params).toEqual({ connection_mode: 'user' });
  });

  test('rows always carry user state — disconnected variant', () => {
    const u = personalGmailDisconnected.user;
    expect(u.connected).toBe(false);
    // Narrows correctly — connected:false branch only has optional status/expires_at
    if (!u.connected) {
      expect(u.status).toBeUndefined();
      expect(u.expires_at).toBeUndefined();
    }
  });

  test('rows always carry user state — connected variant exposes account metadata', () => {
    const u = personalGmailConnected.user;
    expect(u.connected).toBe(true);
    if (u.connected) {
      expect(u.metadata.account_email).toBe('you@example.com');
      expect(u.status).toBe('active');
      expect(u.expires_at).toBe('2026-06-01T12:00:00Z');
    }
  });

  test('rows always carry user state — expired variant (post-revoke)', () => {
    const u = personalSlackExpired.user;
    expect(u.connected).toBe(false);
    if (!u.connected) {
      expect(u.status).toBe('expired');
      expect(u.expires_at).toBe('2026-05-01T00:00:00Z');
    }
  });

  test('iterate() walks pages and yields rows in order', async () => {
    const getMock = mock()
      .mockResolvedValueOnce({
        data: { integrations: [personalGmailConnected], next_page_token: 5 },
        success: true,
        statusCode: 200,
      })
      .mockResolvedValueOnce({
        data: { integrations: [personalSlackExpired], next_page_token: null },
        success: true,
        statusCode: 200,
      });
    const personal = new PersonalConnectionsSection(makeMockClient({ get: getMock }));

    const out: PersonalConnection[] = [];
    for await (const c of personal.iterate()) out.push(c);

    expect(out).toEqual([personalGmailConnected, personalSlackExpired]);
    expect(getMock.mock.calls[1][1]).toEqual({ connection_mode: 'user', page_token: '5' });
  });

  test('listAll() drains every page', async () => {
    const getMock = mock()
      .mockResolvedValueOnce({
        data: { integrations: [personalGmailConnected], next_page_token: 1 },
        success: true,
        statusCode: 200,
      })
      .mockResolvedValueOnce({
        data: { integrations: [personalSlackExpired], next_page_token: null },
        success: true,
        statusCode: 200,
      });
    const personal = new PersonalConnectionsSection(makeMockClient({ get: getMock }));

    expect(await personal.listAll()).toEqual([personalGmailConnected, personalSlackExpired]);
  });

  test('byProvider() returns the matching row', async () => {
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({
          data: { integrations: [personalGmailDisconnected, personalSlackExpired], next_page_token: null },
          success: true,
          statusCode: 200,
        }),
      ),
    });
    const personal = new PersonalConnectionsSection(client);

    expect(await personal.byProvider('slack')).toEqual(personalSlackExpired);
  });

  test('byProvider() returns null when provider absent (not enabled + never connected)', async () => {
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({
          data: { integrations: [personalGmailDisconnected], next_page_token: null },
          success: true,
          statusCode: 200,
        }),
      ),
    });
    const personal = new PersonalConnectionsSection(client);

    expect(await personal.byProvider('notion')).toBeNull();
  });
});

// ── PersonalConnectionRef (vend + consent + use) ───────────────────────────

function makeFetchMockClient(fetchImpl: (path: string, init: RequestInit) => Response | Promise<Response>): ApiClient {
  return {
    getConfig: () => ({
      orgId: '1', kbId: '', projectId: '', rev: 'main', token: 't',
      baseUrl: 'https://api.test', timeout: 30000, retryAttempts: 0, retryDelay: 0,
    }),
    fetch: mock(fetchImpl),
    post: mock(() =>
      Promise.resolve({ data: { redirect_url: 'https://accounts.example.com/oauth' }, success: true, statusCode: 200 }),
    ),
    get: mock(() =>
      Promise.resolve({ data: { integrations: [], next_page_token: null }, success: true, statusCode: 200 }),
    ),
  } as unknown as ApiClient;
}

describe('PersonalConnectionRef', () => {
  test('construction is sync, no network', () => {
    const client = makeFetchMockClient(() => new Response('{}'));
    const ref = new PersonalConnectionRef(client, '15');

    expect(ref.integrationId).toBe('15');
    expect(ref.apiClient).toBe(client);
    expect((client.fetch as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  test('token() GETs /orgs/{org}/integrations/{id} and returns the vend payload', async () => {
    const payload = { type: 'oauth', token: 'ya29.fake', expires_at: '2026-06-01T12:00:00Z' };
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    const client = makeFetchMockClient(fetchMock as (p: string, i: RequestInit) => Response | Promise<Response>);
    const ref = new PersonalConnectionRef(client, '15');

    const result = await ref.token();
    expect(result).toEqual(payload);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('orgs/1/integrations/15');
    expect(((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).method).toBe('GET');
  });

  test('token() throws IntegrationConsentRequiredError on 401 consent_required (with consent_url)', async () => {
    const body = {
      error: 'consent_required',
      consent_url: 'https://api.test/orgs/1/integrations/15/consent',
    };
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 401, headers: { 'content-type': 'application/json' } })),
    );
    const client = makeFetchMockClient(fetchMock as (p: string, i: RequestInit) => Response | Promise<Response>);
    const ref = new PersonalConnectionRef(client, '15');

    let caught: unknown;
    try {
      await ref.token();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(IntegrationConsentRequiredError);
    expect(caught).toBeInstanceOf(TimbalApiError);
    const err = caught as IntegrationConsentRequiredError;
    expect(err.name).toBe('IntegrationConsentRequiredError');
    expect(err.integrationId).toBe('15');
    expect(err.consentUrl).toBe('https://api.test/orgs/1/integrations/15/consent');
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe('consent_required');
    // Full body lands in details so consumers can grab anything else.
    expect(err.details).toEqual(body);
  });

  test('token() throws generic TimbalApiError on other 4xx (NOT consent variant)', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })),
    );
    const client = makeFetchMockClient(fetchMock as (p: string, i: RequestInit) => Response | Promise<Response>);
    const ref = new PersonalConnectionRef(client, '15');

    let caught: unknown;
    try {
      await ref.token();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TimbalApiError);
    expect(caught).not.toBeInstanceOf(IntegrationConsentRequiredError);
    expect((caught as TimbalApiError).statusCode).toBe(403);
  });

  test('token() throws TimbalApiError on empty 2xx body (defensive)', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response('', { status: 200 })),
    );
    const client = makeFetchMockClient(fetchMock as (p: string, i: RequestInit) => Response | Promise<Response>);
    const ref = new PersonalConnectionRef(client, '15');

    await expect(ref.token()).rejects.toThrow(TimbalApiError);
  });

  test('consent() POSTs { redirect_uri } and returns { redirect_url }', async () => {
    const client = makeFetchMockClient(() => new Response('{}'));
    const ref = new PersonalConnectionRef(client, '15');

    const result = await ref.consent({ redirect_uri: 'https://my-app/cb' });

    expect(result).toEqual({ redirect_url: 'https://accounts.example.com/oauth' });
    const [path, body] = (client.post as ReturnType<typeof mock>).mock.calls[0];
    expect(path).toBe('orgs/1/integrations/15/consent');
    expect(body).toEqual({ redirect_uri: 'https://my-app/cb' });
  });

  test('use() — connected: returns { connected: true, token }', async () => {
    const payload = { type: 'oauth', token: 'ya29.fake', expires_at: null };
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    );
    const client = makeFetchMockClient(fetchMock as (p: string, i: RequestInit) => Response | Promise<Response>);
    const ref = new PersonalConnectionRef(client, '15');

    const r = await ref.use({ redirect_uri: 'https://my-app/cb' });

    expect(r).toEqual({ connected: true, token: payload });
    // No consent POST when the token vended cleanly.
    expect((client.post as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  test('use() — not connected: catches IntegrationConsentRequiredError and returns redirect_url', async () => {
    const body = { error: 'consent_required', consent_url: 'https://api.test/orgs/1/integrations/15/consent' };
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 401 })),
    );
    const client = makeFetchMockClient(fetchMock as (p: string, i: RequestInit) => Response | Promise<Response>);
    const ref = new PersonalConnectionRef(client, '15');

    const r = await ref.use({ redirect_uri: 'https://my-app/cb' });

    expect(r).toEqual({ connected: false, redirect_url: 'https://accounts.example.com/oauth' });
    // Consent POST should have been called once with the right body.
    const [path, postBody] = (client.post as ReturnType<typeof mock>).mock.calls[0];
    expect(path).toBe('orgs/1/integrations/15/consent');
    expect(postBody).toEqual({ redirect_uri: 'https://my-app/cb' });
  });

  test('use() re-throws non-consent errors untouched', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'kaboom' }), { status: 500 })),
    );
    const client = makeFetchMockClient(fetchMock as (p: string, i: RequestInit) => Response | Promise<Response>);
    const ref = new PersonalConnectionRef(client, '15');

    let caught: unknown;
    try {
      await ref.use({ redirect_uri: 'https://my-app/cb' });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TimbalApiError);
    expect(caught).not.toBeInstanceOf(IntegrationConsentRequiredError);
    expect((caught as TimbalApiError).statusCode).toBe(500);
    // No consent POST when the failure isn't consent_required.
    expect((client.post as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });
});

// ── PersonalConnectionsSection.get / connect ───────────────────────────────

describe('PersonalConnectionsSection.get / connect', () => {
  test('get(id) returns a PersonalConnectionRef synchronously', () => {
    const client = makeMockClient();
    const personal = new PersonalConnectionsSection(client);

    const ref = personal.get('15');
    expect(ref).toBeInstanceOf(PersonalConnectionRef);
    expect(ref.integrationId).toBe('15');
    expect(ref.apiClient).toBe(client);
    expect((client.get as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  test('get(id) returns a fresh ref per call (stateless)', () => {
    const client = makeMockClient();
    const personal = new PersonalConnectionsSection(client);

    expect(personal.get('15')).not.toBe(personal.get('15'));
  });

  test('connect(provider) — happy path: byProvider hit + use connected', async () => {
    const payload = { type: 'oauth', token: 'ya29.fake', expires_at: null };
    const listResponse = {
      data: { integrations: [personalGmailDisconnected], next_page_token: null },
      success: true,
      statusCode: 200,
    };
    const client = {
      getConfig: () => ({
        orgId: '1', kbId: '', projectId: '', rev: 'main', token: 't',
        baseUrl: 'https://api.test', timeout: 30000, retryAttempts: 0, retryDelay: 0,
      }),
      get: mock(() => Promise.resolve(listResponse)),
      fetch: mock(() =>
        Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
      ),
      post: mock(() => Promise.resolve({ data: {}, success: true, statusCode: 200 })),
    } as unknown as ApiClient;
    const personal = new PersonalConnectionsSection(client);

    const r = await personal.connect('gmail', { redirect_uri: 'https://my-app/cb' });

    expect(r).toEqual({ connected: true, token: payload });
    // Vend was called against the row id from the list (id=15).
    expect(((client.fetch as ReturnType<typeof mock>).mock.calls[0] as unknown[])[0]).toBe('orgs/1/integrations/15');
  });

  test('connect(provider) — consent path: byProvider hit + use disconnected returns redirect_url', async () => {
    const body = { error: 'consent_required', consent_url: 'https://api.test/orgs/1/integrations/15/consent' };
    const client = {
      getConfig: () => ({
        orgId: '1', kbId: '', projectId: '', rev: 'main', token: 't',
        baseUrl: 'https://api.test', timeout: 30000, retryAttempts: 0, retryDelay: 0,
      }),
      get: mock(() =>
        Promise.resolve({
          data: { integrations: [personalGmailDisconnected], next_page_token: null },
          success: true,
          statusCode: 200,
        }),
      ),
      fetch: mock(() =>
        Promise.resolve(new Response(JSON.stringify(body), { status: 401 })),
      ),
      post: mock(() =>
        Promise.resolve({
          data: { redirect_url: 'https://accounts.google.com/o/oauth2/auth?...' },
          success: true,
          statusCode: 200,
        }),
      ),
    } as unknown as ApiClient;
    const personal = new PersonalConnectionsSection(client);

    const r = await personal.connect('gmail', { redirect_uri: 'https://my-app/cb' });

    expect(r).toEqual({
      connected: false,
      redirect_url: 'https://accounts.google.com/o/oauth2/auth?...',
    });
  });

  test('connect(unknown_provider) returns null (no row to act on)', async () => {
    const client = makeMockClient({
      get: mock(() =>
        Promise.resolve({
          data: { integrations: [personalGmailDisconnected], next_page_token: null },
          success: true,
          statusCode: 200,
        }),
      ),
    });
    const personal = new PersonalConnectionsSection(client);

    expect(await personal.connect('not_in_list', { redirect_uri: 'https://my-app/cb' })).toBeNull();
  });
});

// ── SharedConnectionRef + connect sugar ────────────────────────────────────

describe('SharedConnectionRef', () => {
  test('construction is sync, no network', () => {
    const client = makeMockClient();
    const ref = new SharedConnectionRef(client, '10');

    expect(ref.integrationId).toBe('10');
    expect(ref.apiClient).toBe(client);
    expect((client.get as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  test('token() GETs /orgs/{org}/integrations/{id} and returns oauth vend', async () => {
    const payload = {
      type: 'oauth',
      token: 'xoxb-fake',
      expires_at: '2026-06-01T12:00:00Z',
    };
    const getMock = mock(() =>
      Promise.resolve({ data: payload, success: true, statusCode: 200 }),
    );
    const client = makeMockClient({ get: getMock });
    const ref = new SharedConnectionRef(client, '10');

    const v = await ref.token();
    expect(v).toEqual(payload);
    expect((getMock.mock.calls[0] as unknown[])[0]).toBe('orgs/1/integrations/10');

    // Discriminated union narrows
    if (v.type === 'oauth') {
      expect(v.token).toBe('xoxb-fake');
      expect(v.expires_at).toBe('2026-06-01T12:00:00Z');
    } else {
      throw new Error('expected oauth narrowing');
    }
  });

  test('token() returns credentials vend (flattened provider-specific keys)', async () => {
    const payload = { type: 'credentials', api_key: 'sk-fake' };
    const getMock = mock(() =>
      Promise.resolve({ data: payload, success: true, statusCode: 200 }),
    );
    const client = makeMockClient({ get: getMock });
    const ref = new SharedConnectionRef(client, '10');

    const v = await ref.token();
    expect(v).toEqual(payload);

    if (v.type === 'credentials') {
      expect(v.api_key).toBe('sk-fake');
    } else {
      throw new Error('expected credentials narrowing');
    }
  });

  test('token() lets TimbalApiError bubble on 400 not-active / 404 not-found (no special class)', async () => {
    const getMock = mock(() =>
      Promise.reject(new TimbalApiError('Integration is not active', 400, 'BAD_REQUEST')),
    );
    const client = makeMockClient({ get: getMock });
    const ref = new SharedConnectionRef(client, '10');

    let caught: unknown;
    try {
      await ref.token();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TimbalApiError);
    expect(caught).not.toBeInstanceOf(IntegrationConsentRequiredError);
    expect((caught as TimbalApiError).statusCode).toBe(400);
  });
});

describe('SharedConnectionsSection.get / connectOAuth / connectCredentials', () => {
  test('get(id) returns a SharedConnectionRef synchronously', () => {
    const client = makeMockClient();
    const shared = new SharedConnectionsSection(client);

    const ref = shared.get('10');
    expect(ref).toBeInstanceOf(SharedConnectionRef);
    expect(ref.integrationId).toBe('10');
    expect(ref.apiClient).toBe(client);
    expect((client.get as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
  });

  test('get(id) returns a fresh ref per call (stateless)', () => {
    const client = makeMockClient();
    const shared = new SharedConnectionsSection(client);

    expect(shared.get('10')).not.toBe(shared.get('10'));
  });

  test('connectOAuth() POSTs auth_type=oauth and returns { redirect_url }', async () => {
    const postMock = mock(() =>
      Promise.resolve({
        data: { result: 'oauth_redirect', redirect_url: 'https://slack.com/oauth/v2/authorize?...' },
        success: true,
        statusCode: 200,
      }),
    );
    const client = makeMockClient({ post: postMock });
    const shared = new SharedConnectionsSection(client);

    const r = await shared.connectOAuth({
      provider: 'slack',
      label: 'Acme Slack',
      redirect_uri: 'https://app.timbal.ai/org/1/integrations',
    });

    expect(r).toEqual({ result: 'oauth_redirect', redirect_url: 'https://slack.com/oauth/v2/authorize?...' });
    const [path, body] = postMock.mock.calls[0] as unknown[];
    expect(path).toBe('orgs/1/integrations/connect');
    expect(body).toEqual({
      auth_type: 'oauth',
      provider: 'slack',
      label: 'Acme Slack',
      redirect_uri: 'https://app.timbal.ai/org/1/integrations',
    });
  });

  test('connectOAuth() forwards oauth_params (e.g. Shopify shop_url)', async () => {
    const postMock = mock(() =>
      Promise.resolve({
        data: { result: 'oauth_redirect', redirect_url: 'https://shopify.com/oauth?...' },
        success: true,
        statusCode: 200,
      }),
    );
    const client = makeMockClient({ post: postMock });
    const shared = new SharedConnectionsSection(client);

    await shared.connectOAuth({
      provider: 'shopify',
      oauth_params: { shop_url: 'acme.myshopify.com' },
    });

    const body = (postMock.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(body.oauth_params).toEqual({ shop_url: 'acme.myshopify.com' });
    expect(body.auth_type).toBe('oauth');
  });

  test('connectOAuth() throws if the wire returns a "created" shape (defensive)', async () => {
    const postMock = mock(() =>
      Promise.resolve({
        data: { result: 'created', org_integration_id: '10' },
        success: true,
        statusCode: 200,
      }),
    );
    const client = makeMockClient({ post: postMock });
    const shared = new SharedConnectionsSection(client);

    await expect(shared.connectOAuth({ provider: 'slack' })).rejects.toThrow(TimbalApiError);
  });

  test('connectCredentials() POSTs auth_type=credentials and returns a SharedConnectionRef', async () => {
    const postMock = mock(() =>
      Promise.resolve({
        data: { result: 'created', org_integration_id: '10' },
        success: true,
        statusCode: 201,
      }),
    );
    const client = makeMockClient({ post: postMock });
    const shared = new SharedConnectionsSection(client);

    const ref = await shared.connectCredentials({
      provider: 'stripe',
      label: 'Prod',
      credentials: { api_key: 'sk-fake' },
    });

    expect(ref).toBeInstanceOf(SharedConnectionRef);
    expect(ref.integrationId).toBe('10');
    expect(ref.apiClient).toBe(client);

    const [path, body] = postMock.mock.calls[0] as unknown[];
    expect(path).toBe('orgs/1/integrations/connect');
    expect(body).toEqual({
      auth_type: 'credentials',
      provider: 'stripe',
      label: 'Prod',
      credentials: { api_key: 'sk-fake' },
    });
  });

  test('connectCredentials() throws if the wire returns "oauth_redirect" (defensive)', async () => {
    const postMock = mock(() =>
      Promise.resolve({
        data: { result: 'oauth_redirect', redirect_url: 'https://slack.com/...' },
        success: true,
        statusCode: 200,
      }),
    );
    const client = makeMockClient({ post: postMock });
    const shared = new SharedConnectionsSection(client);

    await expect(
      shared.connectCredentials({
        provider: 'slack',
        credentials: { api_key: 'sk-fake' },
      }),
    ).rejects.toThrow(TimbalApiError);
  });
});

// ── IntegrationsSection wiring ─────────────────────────────────────────────

describe('IntegrationsSection sub-accessors', () => {
  test('shared is a lazy singleton', () => {
    const section = new IntegrationsSection(makeMockClient());
    expect(section.shared).toBeInstanceOf(SharedConnectionsSection);
    expect(section.shared).toBe(section.shared);
  });

  test('personal is a lazy singleton', () => {
    const section = new IntegrationsSection(makeMockClient());
    expect(section.personal).toBeInstanceOf(PersonalConnectionsSection);
    expect(section.personal).toBe(section.personal);
  });

  test('catalog / shared / personal are three distinct instances', () => {
    const section = new IntegrationsSection(makeMockClient());
    expect(section.catalog).not.toBe(section.shared as unknown);
    expect(section.shared).not.toBe(section.personal as unknown);
    expect(section.catalog).not.toBe(section.personal as unknown);
  });
});

// ── Timbal wiring ──────────────────────────────────────────────────────────

describe('Timbal.integrations wiring', () => {
  test('Timbal exposes integrations as a lazy singleton', () => {
    const t = new Timbal({ token: 'k', orgId: '1', baseUrl: 'https://api.test' });
    expect(t.integrations).toBeInstanceOf(IntegrationsSection);
    expect(t.integrations).toBe(t.integrations);
  });

  test('integrations.catalog binds the shared apiClient', async () => {
    const t = new Timbal({ token: 'k', orgId: '1', baseUrl: 'https://api.test' });
    const get = mock(() =>
      Promise.resolve({ data: { integrations: [airtable] }, success: true, statusCode: 200 }),
    );
    (t.apiClient as unknown as { get: typeof get }).get = get;

    const list = await t.integrations.catalog.list();

    expect(list).toEqual([airtable]);
    expect(get.mock.calls[0][0]).toBe('integrations');
    expect(get.mock.calls[0][1]).toEqual({ org_id: '1' });
  });

  test('integrations.shared and integrations.personal hit org-scoped routes', async () => {
    const t = new Timbal({ token: 'k', orgId: '1', baseUrl: 'https://api.test' });
    const get = mock(() =>
      Promise.resolve({ data: { integrations: [], next_page_token: null }, success: true, statusCode: 200 }),
    );
    (t.apiClient as unknown as { get: typeof get }).get = get;

    await t.integrations.shared.list();
    await t.integrations.personal.list();

    expect(get.mock.calls[0][0]).toBe('orgs/1/integrations');
    expect(get.mock.calls[0][1]).toEqual({ connection_mode: 'org' });
    expect(get.mock.calls[1][0]).toBe('orgs/1/integrations');
    expect(get.mock.calls[1][1]).toEqual({ connection_mode: 'user' });
  });

  test('escape hatch: new IntegrationsCatalog(timbal.apiClient) works directly', () => {
    const t = new Timbal({ token: 'k', orgId: '1', baseUrl: 'https://api.test' });
    const cat = new IntegrationsCatalog(t.apiClient);
    expect(cat).toBeInstanceOf(IntegrationsCatalog);
  });
});
