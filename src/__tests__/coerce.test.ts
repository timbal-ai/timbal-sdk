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
  });

  test('omits id when undefined (matches optional field)', () => {
    const out = coerceWorkforceItem({ name: 'x' } as any);
    expect(out.id).toBeUndefined();
    expect(out.uid).toBeUndefined();
  });

  test('preserves null uid', () => {
    const out = coerceWorkforceItem({ id: 1, uid: null, name: 'x' } as any);
    expect(out.uid).toBe(null);
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
      use_platform_iam: false,
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
      publishable_api_key: 'pk', use_platform_iam: false,
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
      publishable_api_key: 'pk', use_platform_iam: false,
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
      publishable_api_key: 'pk', use_platform_iam: false,
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
      publishable_api_key: 'pk', use_platform_iam: false,
      repository_url: null, screenshot_url: null,
      created_at: 0, updated_at: 0,
    } as any);
    expect(out.workforce).toEqual([]);
  });
});
