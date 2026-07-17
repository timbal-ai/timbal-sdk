import { describe, test, expect } from 'bun:test';
import {
  detectNgrokOrigin,
  derivePlatformPublicOrigin,
  resolvePublicOrigin,
} from '../channels/origin';

function fetchReturning(payload: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: ok ? 200 : 500,
    })) as unknown as typeof fetch;
}

const fetchThrowing = (async () => {
  throw new Error('ECONNREFUSED');
}) as unknown as typeof fetch;

describe('detectNgrokOrigin', () => {
  test('returns the https tunnel URL', async () => {
    const origin = await detectNgrokOrigin(
      fetchReturning({
        tunnels: [
          { proto: 'http', public_url: 'http://x.ngrok-free.app' },
          { proto: 'https', public_url: 'https://x.ngrok-free.app' },
        ],
      }),
    );
    expect(origin).toBe('https://x.ngrok-free.app');
  });

  test('returns null when no https tunnel, no tunnels, or probe fails', async () => {
    expect(
      await detectNgrokOrigin(
        fetchReturning({ tunnels: [{ proto: 'http', public_url: 'http://x' }] }),
      ),
    ).toBeNull();
    expect(await detectNgrokOrigin(fetchReturning({ tunnels: [] }))).toBeNull();
    expect(await detectNgrokOrigin(fetchReturning({}, false))).toBeNull();
    expect(await detectNgrokOrigin(fetchThrowing)).toBeNull();
  });
});

describe('derivePlatformPublicOrigin', () => {
  test('returns null without TIMBAL_PROJECT_ENV_ID', () => {
    expect(derivePlatformPublicOrigin({})).toBeNull();
    expect(derivePlatformPublicOrigin({ TIMBAL_PROJECT_ID: '248' })).toBeNull();
  });

  test('derives default deployments domain with /api', () => {
    expect(derivePlatformPublicOrigin({ TIMBAL_PROJECT_ENV_ID: '1755' })).toBe(
      'https://e1755.deployments.timbal.ai/api',
    );
  });

  test('TIMBAL_DEPLOYMENTS_DOMAIN beats DEPLOYMENTS_DOMAIN', () => {
    expect(
      derivePlatformPublicOrigin({
        TIMBAL_PROJECT_ENV_ID: '9',
        TIMBAL_DEPLOYMENTS_DOMAIN: 'dep.example.com',
        DEPLOYMENTS_DOMAIN: 'other.example.com',
      }),
    ).toBe('https://e9.dep.example.com/api');
  });

  test('DEPLOYMENTS_DOMAIN is used when TIMBAL_DEPLOYMENTS_DOMAIN is absent', () => {
    expect(
      derivePlatformPublicOrigin({
        TIMBAL_PROJECT_ENV_ID: '9',
        DEPLOYMENTS_DOMAIN: 'dep.example.com',
      }),
    ).toBe('https://e9.dep.example.com/api');
  });
});

describe('resolvePublicOrigin', () => {
  test('explicit origin wins over everything', async () => {
    const origin = await resolvePublicOrigin({
      origin: 'https://explicit.example.com',
      env: {
        PUBLIC_ORIGIN: 'https://env.example.com',
        TIMBAL_PROJECT_ENV_ID: '1755',
      },
      fetchImpl: fetchThrowing,
    });
    expect(origin).toBe('https://explicit.example.com');
  });

  test('PUBLIC_ORIGIN env wins over platform derivation and tunnel probe', async () => {
    const origin = await resolvePublicOrigin({
      env: {
        PUBLIC_ORIGIN: 'https://env.example.com',
        TIMBAL_PROJECT_ENV_ID: '1755',
      },
      fetchImpl: fetchThrowing,
    });
    expect(origin).toBe('https://env.example.com');
  });

  test('platform derivation when TIMBAL_PROJECT_ENV_ID is set', async () => {
    const origin = await resolvePublicOrigin({
      env: { TIMBAL_PROJECT_ENV_ID: '1755', TIMBAL_PROJECT_ID: '248' },
      fetchImpl: fetchThrowing,
    });
    expect(origin).toBe('https://e1755.deployments.timbal.ai/api');
  });

  test('custom TIMBAL_DEPLOYMENTS_DOMAIN', async () => {
    const origin = await resolvePublicOrigin({
      env: {
        TIMBAL_PROJECT_ENV_ID: '1755',
        TIMBAL_DEPLOYMENTS_DOMAIN: 'dep.example.com',
      },
      fetchImpl: fetchThrowing,
    });
    expect(origin).toBe('https://e1755.dep.example.com/api');
  });

  test('falls through to the ngrok probe in local dev', async () => {
    const origin = await resolvePublicOrigin({
      env: {},
      fetchImpl: fetchReturning({
        tunnels: [{ proto: 'https', public_url: 'https://tunnel.ngrok-free.app' }],
      }),
    });
    expect(origin).toBe('https://tunnel.ngrok-free.app');
  });

  test('TIMBAL_PROJECT_ID without env id or PUBLIC_ORIGIN returns null (no ngrok)', async () => {
    let probed = false;
    const trackingFetch = (async () => {
      probed = true;
      throw new Error('nope');
    }) as unknown as typeof fetch;

    const origin = await resolvePublicOrigin({
      env: { TIMBAL_PROJECT_ID: '248' },
      fetchImpl: trackingFetch,
    });
    expect(origin).toBeNull();
    expect(probed).toBe(false);
  });
});
