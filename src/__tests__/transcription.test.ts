import { test, expect, describe } from 'bun:test';
import { transcribeAudio, TRANSCRIPTION_TIMEOUT_MS } from '../lib/functions/transcription';
import type { ApiClient } from '../lib/api';

type Captured = {
  path?: string;
  form?: FormData;
  headers?: Record<string, string>;
  overrides?: { timeout?: number; retryAttempts?: number };
};

function client(
  config: { orgId?: string; projectId?: string; timeout?: number },
  data: unknown,
  captured: Captured,
): ApiClient {
  return {
    postFormData: async (
      path: string,
      form: FormData,
      headers?: Record<string, string>,
      overrides?: Captured['overrides'],
    ) => {
      captured.path = path;
      captured.form = form;
      captured.headers = headers;
      captured.overrides = overrides;
      return { data, success: true, statusCode: 200 };
    },
    getConfig: () => config,
  } as unknown as ApiClient;
}

describe('transcribeAudio', () => {
  test('posts the file to the org transcriptions route, attributed to the project', async () => {
    const captured: Captured = {};
    const result = await transcribeAudio(
      client({ orgId: '7', projectId: '42' }, { text: 'hola' }, captured),
      new Uint8Array([1, 2, 3]),
      'voice.ogg',
      'audio/ogg',
    );

    expect(result).toEqual({ text: 'hola' });
    expect(captured.path).toBe('orgs/7/transcriptions');
    expect(captured.headers).toEqual({ 'x-timbal-project-id': '42' });
    const file = captured.form!.get('file') as File;
    expect(file.name).toBe('voice.ogg');
    expect(file.type).toBe('audio/ogg');
    expect(file.size).toBe(3);
  });

  test('sends no project header without a project, and tolerates a missing text', async () => {
    const captured: Captured = {};
    const result = await transcribeAudio(
      client({ orgId: '7', projectId: '' }, {}, captured),
      new Uint8Array([1]),
      'a.mp3',
      'audio/mpeg',
    );
    expect(result).toEqual({ text: '' });
    expect(captured.headers).toEqual({});
  });

  test('is sent once, with a timeout long enough for long audio', async () => {
    const captured: Captured = {};
    await transcribeAudio(
      client({ orgId: '7', timeout: 30_000 }, { text: 'x' }, captured),
      new Uint8Array([1]),
      'a.ogg',
      'audio/ogg',
    );
    expect(captured.overrides).toEqual({ timeout: TRANSCRIPTION_TIMEOUT_MS, retryAttempts: 0 });

    await transcribeAudio(
      client({ orgId: '7', timeout: 600_000 }, { text: 'x' }, captured),
      new Uint8Array([1]),
      'a.ogg',
      'audio/ogg',
    );
    expect(captured.overrides).toEqual({ timeout: 600_000, retryAttempts: 0 });
  });

  test('needs an org', async () => {
    await expect(
      transcribeAudio(client({ orgId: '' }, {}, {}), new Uint8Array([1]), 'a.ogg', 'audio/ogg'),
    ).rejects.toThrow('orgId is required');
  });
});
