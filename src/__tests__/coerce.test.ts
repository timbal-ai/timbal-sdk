import { describe, test, expect } from 'bun:test';
import {
  coerceKbInfo,
  coerceK2File,
  coerceK2FileParsing,
  coerceK2FileEmbedding,
  coerceK2FileDetail,
  coerceWorkforceItem,
  coerceWorkforcePreview,
  coerceProject,
  coerceProjectResponse,
  coerceAuthProviders,
} from '../lib/coerce';

describe('coerceKbInfo', () => {
  test('coerces numeric id + uid to string', () => {
    const out = coerceKbInfo({
      id: 32,
      uid: 540123,
      name: 'orders',
      data_size_bytes: 100,
      created_at: 't',
      updated_at: 't',
    } as any);
    expect(out.id).toBe('32');
    expect(out.uid).toBe('540123');
    expect(typeof out.id).toBe('string');
    expect(typeof out.uid).toBe('string');
  });

  test('passes through string ids unchanged', () => {
    const out = coerceKbInfo({
      id: 'abc',
      uid: 'xyz',
      name: 'n',
      created_at: 't',
      updated_at: 't',
    } as any);
    expect(out.id).toBe('abc');
    expect(out.uid).toBe('xyz');
  });
});

describe('coerceK2File', () => {
  test('coerces id / uid / kb_id', () => {
    const out = coerceK2File({
      id: 1,
      uid: 2,
      kb_id: 32,
      name: 'a.pdf',
      content_type: 'application/pdf',
      content_length: 10,
      parse_state: 'pending',
      metadata: {},
      url: 'https://x',
      created_at: 't',
      updated_at: 't',
    } as any);
    expect(out).toMatchObject({ id: '1', uid: '2', kb_id: '32' });
  });
});

describe('coerceK2FileParsing / Embedding / Detail', () => {
  test('parsing coerces id + kb_file_id', () => {
    const out = coerceK2FileParsing({
      id: 11, kb_file_id: 1, provider: 'p', status: 's',
      created_at: 't', updated_at: 't',
    } as any);
    expect(out.id).toBe('11');
    expect(out.kb_file_id).toBe('1');
  });

  test('embedding coerces id + kb_file_id + parsing_id', () => {
    const out = coerceK2FileEmbedding({
      id: 21, kb_file_id: 1, provider: 'p', model: 'm', status: 's',
      parsing_id: 11,
      created_at: 't', updated_at: 't',
    } as any);
    expect(out.id).toBe('21');
    expect(out.kb_file_id).toBe('1');
    expect(out.parsing_id).toBe('11');
  });

  test('embedding parsing_id null preserved', () => {
    const out = coerceK2FileEmbedding({
      id: 21, kb_file_id: 1, provider: 'p', model: 'm', status: 's',
      parsing_id: null,
      created_at: 't', updated_at: 't',
    } as any);
    expect(out.parsing_id).toBe(null);
    expect('parsing_id' in out).toBe(true);
  });

  test('embedding parsing_id absent stays absent (not materialized as null)', () => {
    // Regression: previously `parsing_id: toStringIdOpt(v) ?? null` turned an
    // omitted field into an explicit `null`, flipping `'parsing_id' in obj`,
    // Object.keys, and JSON.stringify output vs the raw shape.
    const raw = {
      id: 21, kb_file_id: 1, provider: 'p', model: 'm', status: 's',
      created_at: 't', updated_at: 't',
    };
    const out = coerceK2FileEmbedding(raw as any);
    expect('parsing_id' in out).toBe(false);
    expect(Object.keys(out)).not.toContain('parsing_id');
    expect(JSON.stringify(out)).not.toContain('parsing_id');
  });

  test('detail recursively coerces nested parsings + embeddings', () => {
    const out = coerceK2FileDetail({
      id: 1, uid: 2, kb_id: 32,
      name: 'a', content_type: 'x', content_length: 0, parse_state: 'success',
      metadata: {}, url: 'u', created_at: 't', updated_at: 't',
      parsings: [
        { id: 11, kb_file_id: 1, provider: 'p', status: 's', created_at: 't', updated_at: 't' },
      ],
      embeddings: [
        { id: 21, kb_file_id: 1, provider: 'p', model: 'm', status: 's', parsing_id: 11,
          created_at: 't', updated_at: 't' },
      ],
    } as any);
    expect(out.id).toBe('1');
    expect(out.parsings[0]!.id).toBe('11');
    expect(out.parsings[0]!.kb_file_id).toBe('1');
    expect(out.embeddings[0]!.id).toBe('21');
    expect(out.embeddings[0]!.parsing_id).toBe('11');
  });
});

describe('coerceWorkforceItem', () => {
  test('coerces id + uid when present', () => {
    const out = coerceWorkforceItem({ id: 361, uid: 540, name: 'x' } as any);
    expect(out.id).toBe('361');
    expect(out.uid).toBe('540');
    expect(typeof out.id).toBe('string');
    expect(typeof out.uid).toBe('string');
  });

  test('omits id when undefined (matches optional field)', () => {
    const out = coerceWorkforceItem({ name: 'x' } as any);
    expect(out.id).toBeUndefined();
    expect(out.uid).toBeUndefined();
  });

  test('omitted id stays absent from object (not materialized as undefined/null)', () => {
    // Same regression as the parsing_id and apps leaks: spread + conditional
    // override must not leave a raw-typed `id`/`uid` on the returned object.
    const out = coerceWorkforceItem({ name: 'x' } as any);
    expect('id' in out).toBe(false);
    expect('uid' in out).toBe(false);
    expect(Object.keys(out)).not.toContain('id');
    expect(Object.keys(out)).not.toContain('uid');
    expect(JSON.stringify(out)).toBe('{"name":"x"}');
  });

  test('preserves null uid', () => {
    const out = coerceWorkforceItem({ id: 1, uid: null, name: 'x' } as any);
    expect(out.uid).toBe(null);
    expect('uid' in out).toBe(true);
  });

  test('preserves passthrough fields (type, url, description, deleted_at)', () => {
    const out = coerceWorkforceItem({
      id: 1, uid: 'u', name: 'x', type: 'agent',
      description: 'd', url: 'https://x', deleted_at: null,
    } as any);
    expect(out).toEqual({
      id: '1', uid: 'u', name: 'x', type: 'agent',
      description: 'd', url: 'https://x', deleted_at: null,
    });
  });
});

describe('coerceWorkforcePreview / coerceProject', () => {
  test('preview coerces nested ids', () => {
    const out = coerceWorkforcePreview({
      id: 5, name: 'wf', type: 'agent', description: null, uid: 99,
    } as any);
    expect(out.id).toBe('5');
    expect(out.uid).toBe('99');
  });

  test('project coerces id and nested workforce[]', () => {
    const out = coerceProject({
      id: 230,
      name: 'p',
      description: null,
      has_ui: false,
      role: 'owner',
      default_role: null,
      is_public_template: false,
      template_uses: 0,
      publishable_api_key: 'pk',
      auth_enabled: false,
      repository_url: null,
      screenshot_url: null,
      created_at: 0,
      updated_at: 0,
      workforce: [
        { id: 5, name: 'wf', type: 'agent', description: null, uid: 99 },
      ],
    } as any);
    expect(out.id).toBe('230');
    expect(out.workforce[0]!.id).toBe('5');
    expect(out.workforce[0]!.uid).toBe('99');
  });

  test('coerceProjectResponse folds legacy `apps` alias into workforce', () => {
    const out = coerceProjectResponse({
      id: 230, name: 'p', description: null, has_ui: false, role: 'owner',
      default_role: null, is_public_template: false, template_uses: 0,
      publishable_api_key: 'pk', auth_enabled: false,
      repository_url: null, screenshot_url: null,
      created_at: 0, updated_at: 0,
      apps: [
        { id: 7, name: 'legacy-wf', type: 'agent', description: null, uid: 88 },
      ],
    } as any);
    expect(out.id).toBe('230');
    expect(out.workforce[0]!.id).toBe('7');
    expect(out.workforce[0]!.uid).toBe('88');
  });

  test('coerceProjectResponse does NOT leak `apps` onto the returned Project', () => {
    // Regression: spreading `...raw` previously carried `apps` through to the
    // returned object as a hidden runtime field with uncoerced numeric ids,
    // while `workforce` had string ids — surfacing as a JSON.stringify mismatch.
    const out = coerceProjectResponse({
      id: 230, name: 'p', description: null, has_ui: false, role: 'owner',
      default_role: null, is_public_template: false, template_uses: 0,
      publishable_api_key: 'pk', auth_enabled: false,
      repository_url: null, screenshot_url: null,
      created_at: 0, updated_at: 0,
      apps: [{ id: 7, name: 'legacy', type: 'agent', description: null, uid: 88 }],
    } as any);

    expect('apps' in out).toBe(false);
    expect(Object.keys(out)).not.toContain('apps');
    expect(JSON.stringify(out)).not.toContain('"apps"');
    expect(out.workforce[0]!.id).toBe('7');
  });

  test('coerceProjectResponse prefers workforce when both are present', () => {
    const out = coerceProjectResponse({
      id: 230, name: 'p', description: null, has_ui: false, role: 'owner',
      default_role: null, is_public_template: false, template_uses: 0,
      publishable_api_key: 'pk', auth_enabled: false,
      repository_url: null, screenshot_url: null,
      created_at: 0, updated_at: 0,
      workforce: [{ id: 1, name: 'wf-new', type: 'agent', description: null, uid: 11 }],
      apps:      [{ id: 2, name: 'wf-old', type: 'agent', description: null, uid: 22 }],
    } as any);
    expect(out.workforce.length).toBe(1);
    expect(out.workforce[0]!.name).toBe('wf-new');
  });

  test('project missing workforce defaults to []', () => {
    const out = coerceProject({
      id: 230, name: 'p', description: null, has_ui: false, role: 'owner',
      default_role: null, is_public_template: false, template_uses: 0,
      publishable_api_key: 'pk', auth_enabled: false,
      repository_url: null, screenshot_url: null,
      created_at: 0, updated_at: 0,
    } as any);
    expect(out.workforce).toEqual([]);
  });

  test('project preserves a valid auth_providers subset', () => {
    const out = coerceProject({
      id: 230, name: 'p', description: null, has_ui: false, role: 'owner',
      default_role: null, is_public_template: false, template_uses: 0,
      publishable_api_key: 'pk', auth_enabled: true,
      auth_providers: ['google', 'email'],
      repository_url: null, screenshot_url: null,
      created_at: 0, updated_at: 0,
    } as any);
    expect(out.auth_providers).toEqual(['google', 'email']);
  });

  test('project drops unknown auth_providers entries', () => {
    const out = coerceProject({
      id: 230, name: 'p', description: null, has_ui: false, role: 'owner',
      default_role: null, is_public_template: false, template_uses: 0,
      publishable_api_key: 'pk', auth_enabled: true,
      auth_providers: ['google', 'wat', 'sso'],
      repository_url: null, screenshot_url: null,
      created_at: 0, updated_at: 0,
    } as any);
    expect(out.auth_providers).toEqual(['google']);
  });

  test('project missing auth_providers stays undefined (default-to-all signal)', () => {
    const out = coerceProject({
      id: 230, name: 'p', description: null, has_ui: false, role: 'owner',
      default_role: null, is_public_template: false, template_uses: 0,
      publishable_api_key: 'pk', auth_enabled: false,
      repository_url: null, screenshot_url: null,
      created_at: 0, updated_at: 0,
    } as any);
    expect(out.auth_providers).toBeUndefined();
  });

  test('missing auth_enabled fails CLOSED (defaults to true)', () => {
    // A wire that omits the gate flag must require auth, never silently open.
    const out = coerceProject({
      id: 230, name: 'p', description: null, has_ui: false, role: 'owner',
      default_role: null, is_public_template: false, template_uses: 0,
      publishable_api_key: 'pk',
      repository_url: null, screenshot_url: null,
      created_at: 0, updated_at: 0,
    } as any);
    expect(out.auth_enabled).toBe(true);
  });

  test('maps legacy use_platform_iam when auth_enabled is absent', () => {
    const open = coerceProject({
      id: 230, name: 'p', description: null, has_ui: false, role: 'owner',
      default_role: null, is_public_template: false, template_uses: 0,
      publishable_api_key: 'pk', use_platform_iam: false,
      repository_url: null, screenshot_url: null,
      created_at: 0, updated_at: 0,
    } as any);
    expect(open.auth_enabled).toBe(false);
  });

  test('auth_enabled wins over legacy use_platform_iam when both present', () => {
    const out = coerceProject({
      id: 230, name: 'p', description: null, has_ui: false, role: 'owner',
      default_role: null, is_public_template: false, template_uses: 0,
      publishable_api_key: 'pk', auth_enabled: true, use_platform_iam: false,
      repository_url: null, screenshot_url: null,
      created_at: 0, updated_at: 0,
    } as any);
    expect(out.auth_enabled).toBe(true);
  });

  test('strips deprecated use_platform_iam from the returned Project', () => {
    const out = coerceProject({
      id: 230, name: 'p', description: null, has_ui: false, role: 'owner',
      default_role: null, is_public_template: false, template_uses: 0,
      publishable_api_key: 'pk', auth_enabled: true, use_platform_iam: true,
      repository_url: null, screenshot_url: null,
      created_at: 0, updated_at: 0,
    } as any);
    expect('use_platform_iam' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('use_platform_iam');
  });
});

describe('coerceAuthProviders', () => {
  test('undefined → undefined (absence preserved)', () => {
    expect(coerceAuthProviders(undefined)).toBeUndefined();
  });

  test('empty array → empty array (explicit no providers, distinct from absence)', () => {
    expect(coerceAuthProviders([])).toEqual([]);
  });

  test('filters unknown values, keeps order', () => {
    expect(
      coerceAuthProviders(['github', 'nope', 'email', 'oidc']),
    ).toEqual(['github', 'email']);
  });

  test('non-empty list of all-unknown values → undefined (default-to-all, not lockout)', () => {
    // Regression: previously returned [], which authConfigFromProject treats as
    // "no providers" — locking an auth-required project out with no sign-in.
    expect(coerceAuthProviders(['oidc', 'saml'])).toBeUndefined();
    expect(coerceAuthProviders(['apple'])).toBeUndefined();
  });

  test('keeps all four known providers', () => {
    expect(
      coerceAuthProviders(['email', 'google', 'microsoft', 'github']),
    ).toEqual(['email', 'google', 'microsoft', 'github']);
  });
});
