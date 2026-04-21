import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { getProject } from '../lib/functions/project';
import { Timbal } from '../lib/timbal';
import { TimbalApiError } from '../lib/api';

const mockWorkforce = [
  { id: 'wf-1', name: 'My Agent', type: 'agent' as const, description: 'An agent', uid: 'uid-1' },
  { id: 'wf-2', name: 'My Workflow', type: 'workflow' as const, description: null, uid: null },
];

const mockProjectData = {
  id: 'proj-1',
  name: 'Test Project',
  description: 'A test project',
  has_ui: true,
  role: 'admin',
  default_role: null,
  is_public_template: false,
  template_uses: 0,
  publishable_api_key: 'pk-123',
  use_platform_iam: true,
  repository_url: null,
  screenshot_url: null,
  created_at: 1700000000000,
  updated_at: 1700000000000,
  workforce: mockWorkforce,
};

describe('getProject', () => {
  const mockApiClient = {
    get: mock(() => Promise.resolve({ data: mockProjectData })),
    getConfig: () => ({
      orgId: process.env.TIMBAL_ORG_ID ?? '',
      projectId: process.env.TIMBAL_PROJECT_ID ?? '',
      kbId: '',
      rev: 'main',
      token: '',
    }),
  } as any;

  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockApiClient.get.mockClear();
    process.env.TIMBAL_ORG_ID = '';
    process.env.TIMBAL_PROJECT_ID = '';
  });

  afterEach(() => {
    process.env.TIMBAL_ORG_ID = originalEnv.TIMBAL_ORG_ID;
    process.env.TIMBAL_PROJECT_ID = originalEnv.TIMBAL_PROJECT_ID;
  });

  test('should call correct endpoint with explicit ids', async () => {
    const project = await getProject(mockApiClient, { orgId: 'org-1', projectId: 'proj-1' });

    expect(mockApiClient.get).toHaveBeenCalledWith('orgs/org-1/projects/proj-1');
    expect(project.id).toBe('proj-1');
    expect(project.name).toBe('Test Project');
  });

  test('should fall back to env vars', async () => {
    process.env.TIMBAL_ORG_ID = 'env-org';
    process.env.TIMBAL_PROJECT_ID = 'env-proj';

    await getProject(mockApiClient);

    expect(mockApiClient.get).toHaveBeenCalledWith('orgs/env-org/projects/env-proj');
  });

  test('should throw when orgId is missing', async () => {
    await expect(getProject(mockApiClient, { projectId: 'proj-1' })).rejects.toThrow('orgId is required');
  });

  test('should throw when projectId is missing', async () => {
    await expect(getProject(mockApiClient, { orgId: 'org-1' })).rejects.toThrow('projectId is required');
  });

  test('should return workforce from workforce field', async () => {
    const project = await getProject(mockApiClient, { orgId: 'org-1', projectId: 'proj-1' });

    expect(project.workforce).toEqual(mockWorkforce);
    expect(project.workforce).toHaveLength(2);
    expect(project.workforce[0].type).toBe('agent');
    expect(project.workforce[1].type).toBe('workflow');
  });

  test('should fall back to apps field when workforce is missing', async () => {
    const { workforce: _, ...withoutWorkforce } = mockProjectData;
    mockApiClient.get.mockResolvedValueOnce({
      data: { ...withoutWorkforce, apps: mockWorkforce },
    });

    const project = await getProject(mockApiClient, { orgId: 'org-1', projectId: 'proj-1' });

    expect(project.workforce).toEqual(mockWorkforce);
  });

  test('should prefer workforce over apps when both are present', async () => {
    const appsData = [{ id: 'app-1', name: 'Old App', type: 'agent' as const, description: null, uid: null }];
    mockApiClient.get.mockResolvedValueOnce({
      data: { ...mockProjectData, apps: appsData },
    });

    const project = await getProject(mockApiClient, { orgId: 'org-1', projectId: 'proj-1' });

    expect(project.workforce).toEqual(mockWorkforce);
  });

  test('should return empty array when neither workforce nor apps is present', async () => {
    const { workforce: _, ...withoutWorkforce } = mockProjectData;
    mockApiClient.get.mockResolvedValueOnce({
      data: withoutWorkforce,
    });

    const project = await getProject(mockApiClient, { orgId: 'org-1', projectId: 'proj-1' });

    expect(project.workforce).toEqual([]);
  });

  test('should propagate API errors', async () => {
    mockApiClient.get.mockRejectedValueOnce(
      new TimbalApiError('Not Found', 404, 'NOT_FOUND')
    );

    await expect(getProject(mockApiClient, { orgId: 'org-1', projectId: 'proj-1' })).rejects.toThrow('Not Found');
  });
});

describe('Timbal.getProject', () => {
  let originalFetch: typeof global.fetch;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockFetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockProjectData),
      })
    );
    global.fetch = mockFetch as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('should get project through Timbal class', async () => {
    const timbal = new Timbal({ token: 'test-key', baseUrl: 'https://api.test.com' });
    const project = await timbal.getProject({ orgId: 'org-1', projectId: 'proj-1' });

    expect(project.name).toBe('Test Project');
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.test.com/orgs/org-1/projects/proj-1');
  });
});
