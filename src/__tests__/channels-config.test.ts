import { describe, test, expect } from 'bun:test';
import { createHmac } from 'node:crypto';
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
      [{ provider: 'discord', workforce: 'joi' }],
      {},
    );
    expect(bindings).toEqual([]);
    expect(skipped[0]!.reason).toBe('unknown-provider');
  });

  test('whatsapp materializes from platform credentials or env', () => {
    const fromCreds = materializeChannelBindings(
      [
        {
          provider: 'whatsapp',
          workforce: 'joi',
          credentials: {
            access_token: 'tok',
            phone_number_id: 'pn',
            app_secret: 'sec',
            verify_token: 'ver',
          },
        },
      ],
      {},
    );
    expect(fromCreds.skipped).toEqual([]);
    expect(fromCreds.bindings[0]!.adapter.provider).toBe('whatsapp');

    const fromEnv = materializeChannelBindings([{ provider: 'whatsapp', workforce: 'joi' }], {
      WHATSAPP_ACCESS_TOKEN: 'tok',
      WHATSAPP_PHONE_NUMBER_ID: 'pn',
      WHATSAPP_APP_SECRET: 'sec',
      WHATSAPP_VERIFY_TOKEN: 'ver',
    });
    expect(fromEnv.skipped).toEqual([]);
    expect(fromEnv.bindings[0]!.adapter.provider).toBe('whatsapp');
  });

  test('whatsapp platform-routed bindings verify the platform forward, not Meta', () => {
    const spec = {
      provider: 'whatsapp',
      workforce: 'joi',
      config: { mode: 'platform', waba_id: '200', phone_number_id: '100' },
      credentials: { access_token: 'tok' },
    };
    const { bindings, skipped } = materializeChannelBindings([spec], {
      TIMBAL_PROJECT_SECRET: 'project-secret',
    });
    expect(skipped).toEqual([]);
    const adapter = bindings[0]!.adapter;

    const rawBody = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '100' },
                messages: [{ from: '1', id: 'wamid.X', type: 'text', text: { body: 'hi' } }],
              },
            },
          ],
        },
      ],
    });
    const ts = Math.floor(Date.now() / 1000);
    const key = createHmac('sha256', 'project-secret').update('whatsapp-forward-v1').digest();
    const sig = `sha256=${createHmac('sha256', key).update(`${ts}.${rawBody}`).digest('hex')}`;
    const forward = {
      rawBody,
      headers: new Headers({
        'x-timbal-channel-timestamp': String(ts),
        'x-timbal-channel-signature': sig,
      }),
      url: 'https://app.example.com/channels/joi/whatsapp',
      method: 'POST',
    };
    expect(adapter.verify(forward)).toBe('ok');
    expect(adapter.parse(forward)).toHaveLength(1);
    // The number filter is on: a delivery for another number is dropped.
    const other = { ...forward, rawBody: rawBody.replace('"100"', '"999"') };
    expect(adapter.parse(other)).toHaveLength(0);
  });

  test('whatsapp platform-routed bindings need token, number and project secret', () => {
    const base = {
      provider: 'whatsapp',
      workforce: 'joi',
      config: { mode: 'platform', phone_number_id: '100' },
      credentials: { access_token: 'tok' } as Record<string, string> | null,
    };
    const env = { TIMBAL_PROJECT_SECRET: 's' };
    expect(materializeChannelBindings([base], {}).skipped[0]!.reason).toBe('missing-credentials');
    expect(
      materializeChannelBindings([{ ...base, credentials: null }], env).skipped[0]!.reason,
    ).toBe('missing-credentials');
    expect(
      materializeChannelBindings([{ ...base, config: { mode: 'platform' } }], env).skipped[0]!
        .reason,
    ).toBe('missing-credentials');
    // No env fallback in platform mode.
    expect(
      materializeChannelBindings([{ ...base, credentials: null }], {
        ...env,
        WHATSAPP_ACCESS_TOKEN: 'tok',
      }).skipped[0]!.reason,
    ).toBe('missing-credentials');
  });

  test('teams materializes from platform credentials or env', () => {
    const fromCreds = materializeChannelBindings(
      [
        {
          provider: 'teams',
          workforce: 'joi',
          credentials: {
            app_id: 'app-1',
            app_password: 'secret',
            tenant_id: 'tenant-1',
          },
        },
      ],
      {},
    );
    expect(fromCreds.skipped).toEqual([]);
    expect(fromCreds.bindings[0]!.adapter.provider).toBe('teams');

    const fromEnv = materializeChannelBindings([{ provider: 'teams', workforce: 'joi' }], {
      TEAMS_APP_ID: 'app-1',
      TEAMS_APP_PASSWORD: 'secret',
    });
    expect(fromEnv.skipped).toEqual([]);
    expect(fromEnv.bindings[0]!.adapter.provider).toBe('teams');
  });

  test('teams materializes with a certificate or federated token file and no password', () => {
    const spec = (credentials?: Record<string, string>) => [
      { provider: 'teams', workforce: 'joi', ...(credentials ? { credentials } : {}) },
    ];
    const withCertificate = materializeChannelBindings(
      spec({
        app_id: 'app-1',
        certificate_private_key: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----',
        certificate_thumbprint_sha256: 'ab'.repeat(32),
      }),
      {},
    );
    expect(withCertificate.skipped).toEqual([]);
    expect(withCertificate.bindings[0]!.adapter.provider).toBe('teams');

    const withFederated = materializeChannelBindings(spec(), {
      TEAMS_APP_ID: 'app-1',
      TEAMS_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/tokens/azure-identity-token',
    });
    expect(withFederated.skipped).toEqual([]);

    const withNone = materializeChannelBindings(spec({ app_id: 'app-1' }), {});
    expect(withNone.skipped[0]!.reason).toBe('missing-credentials');
  });
});

describe('teams certificate from the platform', () => {
  const pem = (label: string, der: ArrayBuffer | Uint8Array): string =>
    `-----BEGIN ${label}-----\n${(Buffer.from(der as Uint8Array).toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${label}-----\n`;

  // A rotated certificate on the platform, the previous thumbprint still in
  // the environment: the assertion must name the new certificate.
  test('a complete platform certificate is not paired with a stale env thumbprint', async () => {
    const keys = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const newCertDer = new Uint8Array([0x30, 0x82, 0x01, 0x0a, 0x02, 0x82, 0x01, 0x01, 0x00, 0x7e]);
    const { bindings } = materializeChannelBindings(
      [
        {
          provider: 'teams',
          workforce: 'joi',
          credentials: {
            app_id: 'app-1',
            certificate_private_key: pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', keys.privateKey)),
            certificate: pem('CERTIFICATE', newCertDer),
          },
        },
      ],
      { TEAMS_CERTIFICATE_THUMBPRINT_SHA256: 'ab'.repeat(32) },
    );

    const assertions: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/oauth2/v2.0/token')) {
        assertions.push(new URLSearchParams(String(init?.body)).get('client_assertion') ?? '');
        return new Response(JSON.stringify({ access_token: 'connector-token', expires_in: 3600 }));
      }
      return new Response(JSON.stringify({ id: 'sent-1' }));
    }) as typeof fetch;
    try {
      const adapter = bindings[0]!.adapter;
      const [event] = await adapter.parse({
        rawBody: JSON.stringify({
          type: 'message',
          id: 'a1',
          text: 'hi',
          channelId: 'msteams',
          serviceUrl: 'https://smba.test.example/emea/',
          from: { id: '29:user' },
          recipient: { id: '28:bot' },
          conversation: { id: 'c1' },
        }),
        headers: new Headers(),
        method: 'POST',
      } as never);
      await adapter.delivery(event!).send('hello');
    } finally {
      globalThis.fetch = realFetch;
    }

    const header = JSON.parse(Buffer.from(assertions[0]!.split('.')[0]!, 'base64url').toString('utf8'));
    const newThumbprint = Buffer.from(await crypto.subtle.digest('SHA-256', newCertDer)).toString('base64url');
    expect(header['x5t#S256']).toBe(newThumbprint);
  });
});
