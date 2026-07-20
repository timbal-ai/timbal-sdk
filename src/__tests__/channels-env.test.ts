import { describe, test, expect } from 'bun:test';
import { channelBindingsFromEnv } from '../channels/env';

describe('channelBindingsFromEnv', () => {
  test('no channel credentials → no bindings (and no workforce required)', () => {
    expect(channelBindingsFromEnv({ env: {} })).toEqual([]);
    expect(channelBindingsFromEnv({ env: { CHANNELS_WORKFORCE: 'joi' } })).toEqual([]);
  });

  test('telegram binds from TELEGRAM_BOT_TOKEN', () => {
    const bindings = channelBindingsFromEnv({
      env: { TELEGRAM_BOT_TOKEN: '123:abc', CHANNELS_WORKFORCE: 'joi' },
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.adapter.provider).toBe('telegram');
    expect(bindings[0]!.workforce).toBe('joi');
  });

  test('slack binds only when BOTH signing secret and bot token are set', () => {
    const partial = channelBindingsFromEnv({
      env: { SLACK_SIGNING_SECRET: 's', CHANNELS_WORKFORCE: 'joi' },
    });
    expect(partial).toEqual([]);

    const bindings = channelBindingsFromEnv({
      env: {
        SLACK_SIGNING_SECRET: 's',
        SLACK_BOT_TOKEN: 'xoxb-1',
        CHANNELS_WORKFORCE: 'joi',
      },
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.adapter.provider).toBe('slack');
  });

  test('whatsapp binds only when all four credentials are set', () => {
    const partial = channelBindingsFromEnv({
      env: {
        WHATSAPP_ACCESS_TOKEN: 'tok',
        WHATSAPP_PHONE_NUMBER_ID: 'pn',
        CHANNELS_WORKFORCE: 'joi',
      },
    });
    expect(partial).toEqual([]);

    const bindings = channelBindingsFromEnv({
      env: {
        WHATSAPP_ACCESS_TOKEN: 'tok',
        WHATSAPP_PHONE_NUMBER_ID: 'pn',
        WHATSAPP_APP_SECRET: 'sec',
        WHATSAPP_VERIFY_TOKEN: 'ver',
        CHANNELS_WORKFORCE: 'joi',
      },
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.adapter.provider).toBe('whatsapp');
  });

  test('both channels bind to the same workforce', () => {
    const bindings = channelBindingsFromEnv({
      env: {
        TELEGRAM_BOT_TOKEN: '123:abc',
        SLACK_SIGNING_SECRET: 's',
        SLACK_BOT_TOKEN: 'xoxb-1',
        CHANNELS_WORKFORCE: 'joi',
      },
    });
    expect(bindings.map((b) => b.adapter.provider).sort()).toEqual(['slack', 'telegram']);
    expect(new Set(bindings.map((b) => b.workforce))).toEqual(new Set(['joi']));
  });

  test('workforce option beats CHANNELS_WORKFORCE env', () => {
    const bindings = channelBindingsFromEnv({
      workforce: 'from-option',
      env: { TELEGRAM_BOT_TOKEN: '123:abc', CHANNELS_WORKFORCE: 'from-env' },
    });
    expect(bindings[0]!.workforce).toBe('from-option');
  });

  test('credentials without a workforce target throw loudly', () => {
    expect(() =>
      channelBindingsFromEnv({ env: { TELEGRAM_BOT_TOKEN: '123:abc' } }),
    ).toThrow(/CHANNELS_WORKFORCE/);
  });
});
