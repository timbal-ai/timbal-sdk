import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelBindingsFromEnv } from '../channels/env';
import { clearTeamsAdapterCaches } from '../channels/adapters/teams';

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

  test('teams binds when app id and password are set (tenant optional)', () => {
    const partial = channelBindingsFromEnv({
      env: { TEAMS_APP_ID: 'app-1', CHANNELS_WORKFORCE: 'joi' },
    });
    expect(partial).toEqual([]);

    const bindings = channelBindingsFromEnv({
      env: {
        TEAMS_APP_ID: 'app-1',
        TEAMS_APP_PASSWORD: 'secret',
        CHANNELS_WORKFORCE: 'joi',
      },
    });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.adapter.provider).toBe('teams');
  });

  test('teams binds with a certificate or a federated token file instead of a password', () => {
    for (const credential of [
      { TEAMS_CERTIFICATE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nAA==\\n-----END PRIVATE KEY-----' },
      { TEAMS_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/tokens/azure-identity-token' },
    ]) {
      const bindings = channelBindingsFromEnv({
        env: { TEAMS_APP_ID: 'app-1', CHANNELS_WORKFORCE: 'joi', ...credential },
      });
      expect(bindings).toHaveLength(1);
      expect(bindings[0]!.adapter.provider).toBe('teams');
    }
  });

  describe('teams federated token file', () => {
    const realFetch = globalThis.fetch;
    let dir: string | undefined;
    afterEach(() => {
      globalThis.fetch = realFetch;
      clearTeamsAdapterCaches();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    test('its contents are read per token request and sent as the client assertion', async () => {
      dir = mkdtempSync(join(tmpdir(), 'teams-fic-'));
      const tokenFile = join(dir, 'token');
      writeFileSync(tokenFile, 'projected-token-1\n');
      const forms: URLSearchParams[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/oauth2/v2.0/token')) {
          forms.push(new URLSearchParams(String(init?.body)));
          return Response.json({ access_token: 'tok', expires_in: 0 });
        }
        return Response.json({ id: 'sent-1' });
      }) as typeof fetch;

      const [binding] = channelBindingsFromEnv({
        env: { TEAMS_APP_ID: 'app-1', TEAMS_FEDERATED_TOKEN_FILE: tokenFile, CHANNELS_WORKFORCE: 'joi' },
      });
      const activity = {
        type: 'message',
        id: 'a-1',
        text: 'hi',
        serviceUrl: 'https://smba.test.example/',
        from: { id: '29:user' },
        recipient: { id: '28:app-1' },
        conversation: { id: 'conv-1' },
      };
      const [event] = await binding!.adapter.parse({
        rawBody: JSON.stringify(activity),
        headers: new Headers(),
        url: 'https://app.example.com/channels/joi/teams',
        method: 'POST',
      });
      const delivery = binding!.adapter.delivery(event!);
      await delivery.send('one');
      writeFileSync(tokenFile, 'projected-token-2\n');
      await delivery.send('two'); // expires_in 0: not cached, so the file is read again

      expect(forms.map((f) => [f.get('client_assertion'), f.has('client_secret')])).toEqual([
        ['projected-token-1', false],
        ['projected-token-2', false],
      ]);
    });
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
