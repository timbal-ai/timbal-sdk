import { describe, test, expect } from 'bun:test';
import {
  channelSpecsFromProject,
  materializeChannelBindings,
} from '../channels/config';
import type { Project } from '../types';

const asProject = (channels: unknown): Project =>
  ({ channels }) as unknown as Project;

describe('channelSpecsFromProject', () => {
  test('null when the platform response has no channels field', () => {
    expect(channelSpecsFromProject(asProject(undefined))).toBeNull();
    expect(channelSpecsFromProject(asProject('nope'))).toBeNull();
  });

  test('empty array is a valid (all channels off) config, not a fallback', () => {
    expect(channelSpecsFromProject(asProject([]))).toEqual([]);
  });

  test('drops disabled and malformed entries', () => {
    const specs = channelSpecsFromProject(
      asProject([
        { provider: 'telegram', workforce: 'joi' },
        { provider: 'slack', workforce: 'joi', enabled: false },
        { provider: '', workforce: 'joi' },
        { provider: 'slack' },
        null,
      ]),
    );
    expect(specs).toEqual([{ provider: 'telegram', workforce: 'joi' }]);
  });
});

describe('materializeChannelBindings', () => {
  test('joins specs with env credentials', () => {
    const { bindings, skipped } = materializeChannelBindings(
      [
        { provider: 'telegram', workforce: 'joi' },
        { provider: 'slack', workforce: 'sales' },
      ],
      {
        TELEGRAM_BOT_TOKEN: '123:abc',
        SLACK_SIGNING_SECRET: 's',
        SLACK_BOT_TOKEN: 'xoxb-1',
      },
    );
    expect(skipped).toEqual([]);
    expect(bindings.map((b) => [b.adapter.provider, b.workforce])).toEqual([
      ['telegram', 'joi'],
      ['slack', 'sales'],
    ]);
  });

  test('specs without env credentials are skipped, not broken bindings', () => {
    const { bindings, skipped } = materializeChannelBindings(
      [{ provider: 'slack', workforce: 'joi' }],
      {},
    );
    expect(bindings).toEqual([]);
    expect(skipped).toEqual([
      {
        spec: { provider: 'slack', workforce: 'joi' },
        reason: 'missing-credentials',
      },
    ]);
  });

  test('providers unknown to this SDK version are skipped as such', () => {
    const { bindings, skipped } = materializeChannelBindings(
      [{ provider: 'whatsapp', workforce: 'joi' }],
      {},
    );
    expect(bindings).toEqual([]);
    expect(skipped[0]!.reason).toBe('unknown-provider');
  });
});
