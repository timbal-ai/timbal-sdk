import { test, expect, describe, mock } from 'bun:test';
import {
  IntegrationConsentRequiredError,
  RemoteTool,
  Timbal,
  TimbalApiError,
  ToolProxyUnavailableError,
  ToolsSection,
  type RemoteToolDetail,
  type ToolUseContent,
} from '..';
import type { ApiClient } from '../lib/api';

// ── Wire fixtures (new platform shapes) ──

const listResponse = {
  version: '2.1.7',
  tools: [
    {
      name: 'firecrawl_scrape',
      provider: 'firecrawl',
      description: 'Scrape a page.',
      provider_logo: 'https://content.timbal.ai/assets/firecrawl_favicon.svg',
      class_name: 'FirecrawlScrape',
      module: 'timbal.tools',
      available: true,
      execution: 'proxy',
      service_account_eligible: false,
      connection: 'service_account_unavailable',
    },
    {
      name: 'krea_generate_image',
      provider: 'krea',
      description: 'Generate an image via Krea.ai.',
      provider_logo: 'https://content.timbal.ai/assets/krea_favicon.svg',
      class_name: 'KreaGenerateImage',
      module: 'timbal.tools',
      available: true,
      execution: 'proxy',
      service_account_eligible: true,
      connection: 'connected',
    },
  ],
};

const kreaDetail: RemoteToolDetail = {
  tool: 'krea_generate_image',
  provider: 'krea',
  version: '2.1.7',
  class_name: 'KreaGenerateImage',
  module: 'timbal.tools',
  description: 'Generate an image via Krea.ai.',
  params: {
    type: 'object',
    title: 'KreaGenerateImageParams',
    properties: {
      prompt: { type: 'string', title: 'Prompt', description: 'Text description.' },
      model: { type: 'string', title: 'Model', default: 'bfl/flux-1-dev' },
    },
    required: ['prompt'],
  },
  output: {},
};

const firecrawlDetail: RemoteToolDetail = {
  tool: 'firecrawl_scrape',
  provider: 'firecrawl',
  version: '2.1.7',
  class_name: 'FirecrawlScrape',
  module: 'timbal.tools',
  description: 'Scrape a page.',
  params: {
    type: 'object',
    title: 'FirecrawlScrapeParams',
    properties: { url: { type: 'string', title: 'Url', description: 'Page URL.' } },
    required: ['url'],
  },
  output: {},
};

const detailByName: Record<string, RemoteToolDetail> = {
  krea_generate_image: kreaDetail,
  firecrawl_scrape: firecrawlDetail,
};

interface FakeResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

function proxyResponse(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: () => Promise.resolve(body),
  };
}

function makeMockClient(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  return {
    getConfig: () => ({
      orgId: '1',
      kbId: '',
      projectId: 'proj-7',
      rev: 'main',
      token: 't',
      baseUrl: 'https://api.test',
      timeout: 30000,
      retryAttempts: 0,
      retryDelay: 0,
    }),
    get: mock((path: string) => {
      if (path === 'orgs/1/proxies/v1/tools') {
        return Promise.resolve({ data: listResponse, success: true, statusCode: 200 });
      }
      const name = path.split('/').pop() ?? '';
      return Promise.resolve({ data: detailByName[name], success: true, statusCode: 200 });
    }),
    fetch: mock(() => Promise.resolve(proxyResponse(200, { image_url: 'https://x/y.png' }))),
    ...overrides,
  } as unknown as ApiClient;
}

// ── Execution (run) ──────────────────────────────────────────────────────────

describe('ToolsSection.run', () => {
  test('POSTs to the proxy path with params and returns raw JSON', async () => {
    const client = makeMockClient();
    const tools = new ToolsSection(client);

    const result = await tools.run('krea_generate_image', { prompt: 'a lake' });

    expect(result).toEqual({ image_url: 'https://x/y.png' });
    const [path, init] = (client.fetch as ReturnType<typeof mock>).mock.calls[0];
    expect(path).toBe('orgs/1/proxies/v1/tools/krea_generate_image');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ prompt: 'a lake' });
  });

  test('attaches version + subject + optional correlation/connection headers', async () => {
    const client = makeMockClient();
    const tools = new ToolsSection(client);

    await tools.run('krea_generate_image', { prompt: 'x' }, {
      runId: 'run-1',
      callId: 'call-1',
      connectionId: '42',
    });

    const init = (client.fetch as ReturnType<typeof mock>).mock.calls[0][1];
    expect(init.headers['x-timbal-version']).toBeDefined();
    expect(init.headers['x-timbal-project-id']).toBe('proj-7');
    expect(init.headers['x-timbal-rev']).toBe('main');
    expect(init.headers['x-timbal-run-id']).toBe('run-1');
    expect(init.headers['x-timbal-call-id']).toBe('call-1');
    expect(init.headers['x-timbal-integration-id']).toBe('42');
  });

  test('always sends x-timbal-run-id, auto-generated when not provided', async () => {
    const client = makeMockClient();
    const tools = new ToolsSection(client);

    await tools.run('krea_generate_image', { prompt: 'x' });

    const init = (client.fetch as ReturnType<typeof mock>).mock.calls[0][1];
    expect(init.headers['x-timbal-run-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.headers['x-timbal-call-id']).toBeUndefined();
  });

  test('forwards an abort signal and never retries (single fetch)', async () => {
    const client = makeMockClient();
    const tools = new ToolsSection(client);
    const ac = new AbortController();

    await tools.run('krea_generate_image', { prompt: 'x' }, { signal: ac.signal });

    expect((client.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(1);
    expect((client.fetch as ReturnType<typeof mock>).mock.calls[0][1].signal).toBe(ac.signal);
  });
});

// ── Error mapping ─────────────────────────────────────────────────────────────

describe('ToolsSection.run error mapping', () => {
  test('403 → ToolProxyUnavailableError carrying tool + provider', async () => {
    const client = makeMockClient({
      fetch: mock(() => Promise.resolve(proxyResponse(403, { message: 'no conn', provider: 'krea' }))),
    });
    const tools = new ToolsSection(client);

    const err = await tools.run('krea_generate_image', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ToolProxyUnavailableError);
    expect(err).toBeInstanceOf(TimbalApiError);
    expect(err.toolName).toBe('krea_generate_image');
    expect(err.provider).toBe('krea');
  });

  test.each([404, 501])('%d → ToolProxyUnavailableError', async (status) => {
    const client = makeMockClient({
      fetch: mock(() => Promise.resolve(proxyResponse(status, {}))),
    });
    const tools = new ToolsSection(client);

    const err = await tools.run('krea_generate_image', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ToolProxyUnavailableError);
  });

  test('401 consent_required → IntegrationConsentRequiredError', async () => {
    const client = makeMockClient({
      fetch: mock(() =>
        Promise.resolve(
          proxyResponse(401, {
            error: 'consent_required',
            consent_url: 'https://api.test/orgs/1/integrations/5/consent',
            integration_id: '5',
          }),
        ),
      ),
    });
    const tools = new ToolsSection(client);

    const err = await tools.run('krea_generate_image', {}).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationConsentRequiredError);
    expect(err.consentUrl).toBe('https://api.test/orgs/1/integrations/5/consent');
    expect(err.integrationId).toBe('5');
  });

  test('other non-2xx (400) → plain TimbalApiError', async () => {
    const client = makeMockClient({
      fetch: mock(() => Promise.resolve(proxyResponse(400, { message: 'bad params' }))),
    });
    const tools = new ToolsSection(client);

    const err = await tools.run('krea_generate_image', {}).catch((e) => e);
    expect(err).toBeInstanceOf(TimbalApiError);
    expect(err).not.toBeInstanceOf(ToolProxyUnavailableError);
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('bad params');
  });
});

// ── Manifest: list / get / specs ──────────────────────────────────────────────

describe('ToolsSection manifest', () => {
  test('list() returns lightweight RemoteTools with metadata (no schema)', async () => {
    const client = makeMockClient();
    const tools = new ToolsSection(client);

    const list = await tools.list();

    expect(list.map((t) => t.name)).toEqual(['firecrawl_scrape', 'krea_generate_image']);
    const krea = list.find((t) => t.name === 'krea_generate_image')!;
    expect(krea.provider).toBe('krea');
    expect(krea.className).toBe('KreaGenerateImage');
    expect(krea.serviceAccountEligible).toBe(true);
    expect(krea.connection).toBe('connected');
    expect(krea.parameters).toBeUndefined(); // schema not in the list
    expect((client.get as ReturnType<typeof mock>).mock.calls[0][0]).toBe('orgs/1/proxies/v1/tools');
  });

  test('list() is cached per org; clearCache() forces a refetch', async () => {
    const client = makeMockClient();
    const tools = new ToolsSection(client);

    await tools.list();
    await tools.list();
    expect((client.get as ReturnType<typeof mock>).mock.calls.length).toBe(1);

    tools.clearCache();
    await tools.list();
    expect((client.get as ReturnType<typeof mock>).mock.calls.length).toBe(2);
  });

  test('get(name) hydrates the parameter schema from the detail endpoint', async () => {
    const client = makeMockClient();
    const tools = new ToolsSection(client);

    const tool = await tools.get('krea_generate_image');

    expect(tool.parameters).toEqual(kreaDetail.params);
    expect((client.get as ReturnType<typeof mock>).mock.calls[0][0]).toBe(
      'orgs/1/proxies/v1/tools/krea_generate_image',
    );
  });

  test('specs({format, tools}) serializes hydrated schemas', async () => {
    const client = makeMockClient();
    const tools = new ToolsSection(client);

    const openai = await tools.specs({ format: 'openai', tools: ['krea_generate_image'] });
    expect(openai[0]).toEqual({
      type: 'function',
      function: {
        name: 'krea_generate_image',
        description: kreaDetail.description!,
        parameters: kreaDetail.params,
      },
    });

    const anthropic = await tools.specs({ format: 'anthropic', tools: ['krea_generate_image'] });
    expect(anthropic[0]).toEqual({
      name: 'krea_generate_image',
      description: kreaDetail.description!,
      input_schema: kreaDetail.params,
    });
  });

  test('specs() defaults to the whole manifest when no tools are given', async () => {
    const client = makeMockClient();
    const tools = new ToolsSection(client);

    const openai = await tools.specs({ format: 'openai' });

    expect(openai.map((s) => s.function.name).sort()).toEqual([
      'firecrawl_scrape',
      'krea_generate_image',
    ]);
  });
});

// ── dispatch (agent-loop glue) ────────────────────────────────────────────────

describe('ToolsSection.dispatch', () => {
  test('runs a tool_use and returns a tool_result keyed to the same id', async () => {
    const client = makeMockClient();
    const tools = new ToolsSection(client);
    const toolUse: ToolUseContent = {
      type: 'tool_use',
      id: 'c1',
      name: 'krea_generate_image',
      input: { prompt: 'a lake' },
    };

    const result = await tools.dispatch(toolUse);

    expect(result.type).toBe('tool_result');
    expect(result.id).toBe('c1');
    expect(result.content[0]).toEqual({
      type: 'text',
      text: JSON.stringify({ image_url: 'https://x/y.png' }),
    });
  });
});

// ── requirements (recover integrations from declared usage) ───────────────────

describe('ToolsSection.requirements', () => {
  test('joins the named tools against the manifest, grouped by provider', async () => {
    const client = makeMockClient();
    const tools = new ToolsSection(client);

    const reqs = await tools.requirements({ tools: ['krea_generate_image'] });

    expect(reqs).toEqual([
      {
        provider: 'krea',
        tools: ['krea_generate_image'],
        available: true,
        serviceAccountEligible: true,
        connection: 'connected',
      },
    ]);
  });

  test('falls back to the whole manifest when no tools are given', async () => {
    const client = makeMockClient();
    const tools = new ToolsSection(client);

    const reqs = await tools.requirements();

    expect(reqs.map((r) => r.provider).sort()).toEqual(['firecrawl', 'krea']);
    const firecrawl = reqs.find((r) => r.provider === 'firecrawl')!;
    expect(firecrawl.serviceAccountEligible).toBe(false);
    expect(firecrawl.connection).toBe('service_account_unavailable');
  });
});

// ── RemoteTool + wiring ───────────────────────────────────────────────────────

describe('RemoteTool', () => {
  test('toOpenAI emits an empty schema until loaded; fromDetail populates it', () => {
    const client = makeMockClient();
    const bare = new RemoteTool(client, { name: 'krea_generate_image', provider: 'krea' });
    expect(bare.toOpenAI().function.parameters).toEqual({ type: 'object', properties: {} });

    const hydrated = RemoteTool.fromDetail(client, kreaDetail);
    expect(hydrated.toAnthropic().input_schema).toEqual(kreaDetail.params);
  });
});

describe('Timbal.tools', () => {
  test('is a lazy singleton', () => {
    const timbal = new Timbal({ token: 't', orgId: '1' });
    expect(timbal.tools).toBeInstanceOf(ToolsSection);
    expect(timbal.tools).toBe(timbal.tools);
  });
});
