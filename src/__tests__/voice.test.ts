import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { WorkforceVoice } from '../lib/workforce';
import { Workforce } from '../lib/workforce';
import {
  mintVoiceTicket,
  voiceWsUrl,
  connectVoice,
  rtcVoice,
} from '../lib/functions/voice';
import type { ApiClient } from '../lib/api';

const rawTicket = { ticket: 'eyJ.ticket.sig', expires_at: 1754000000000, ttl_secs: 60 };

function makeApiClient(overrides: Partial<Record<string, unknown>> = {}): ApiClient {
  return {
    post: mock(() => Promise.resolve({ data: rawTicket })),
    fetch: mock(() => Promise.resolve(new Response('{"sdp":"a","type":"answer"}', { status: 200 }))),
    getConfig: () => ({
      baseUrl: 'https://api.example.com',
      orgId: 'org1',
      projectId: 'proj1',
      rev: 'main',
      kbId: '',
      token: 'tok',
      ...overrides,
    }),
  } as any;
}

// ── Fake WebSocket ──────────────────────────────────────────────────────────

type FakeBehavior = 'open' | 'error' | 'close' | 'silent';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static behavior: FakeBehavior = 'open';

  url: string;
  protocols?: string | string[];
  binaryType = 'blob';
  closed = false;
  closeCalls = 0;
  private listeners = new Map<string, ((ev: any) => void)[]>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (FakeWebSocket.behavior === 'open') this.dispatch('open', {});
      if (FakeWebSocket.behavior === 'error') this.dispatch('error', {});
      if (FakeWebSocket.behavior === 'close') this.dispatch('close', { code: 4003, reason: 'forbidden' });
      // 'silent': never settles on its own (timeout tests)
    });
  }

  addEventListener(type: string, fn: (ev: any) => void, _opts?: unknown): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  dispatch(type: string, ev: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  close(): void {
    this.closed = true;
    this.closeCalls += 1;
  }
}

const RealWebSocket = globalThis.WebSocket;

beforeEach(() => {
  delete process.env.TIMBAL_START_WORKFORCE;
  delete process.env.TIMBAL_WORKFORCE;
  delete process.env.TIMBAL_STUDIO;
  FakeWebSocket.instances = [];
  FakeWebSocket.behavior = 'open';
  (globalThis as any).WebSocket = FakeWebSocket;
});

afterEach(() => {
  (globalThis as any).WebSocket = RealWebSocket;
  delete process.env.TIMBAL_START_WORKFORCE;
  delete process.env.TIMBAL_STUDIO;
});

// ── ticket ──────────────────────────────────────────────────────────────────

describe('mintVoiceTicket', () => {
  test('POSTs to the voice/ticket endpoint and coerces to camelCase', async () => {
    const client = makeApiClient();
    const t = await mintVoiceTicket(client, 'my-agent');
    expect((client.post as any)).toHaveBeenCalledWith(
      'orgs/org1/projects/proj1/workforce/my-agent/voice/ticket?rev=main',
    );
    expect(t).toEqual({ ticket: 'eyJ.ticket.sig', expiresAt: 1754000000000, ttlSecs: 60 });
  });

  test('surfaces ticket ICE servers and transport policy when the platform mints them', async () => {
    const iceServers = [
      { urls: 'stun:turn.timbal.ai:3478' },
      { urls: ['turn:turn.timbal.ai:3478'], username: '1754000060:voice', credential: 'hmac' },
    ];
    const client = makeApiClient();
    (client.post as any).mockImplementation(() =>
      Promise.resolve({ data: { ...rawTicket, ice_servers: iceServers, ice_transport_policy: 'relay' } }),
    );
    const t = await mintVoiceTicket(client, 'my-agent');
    expect(t.iceServers).toEqual(iceServers);
    expect(t.iceTransportPolicy).toBe('relay');
  });

  test('omits ICE fields entirely on pre-ICE platform responses', async () => {
    const t = await mintVoiceTicket(makeApiClient(), 'my-agent');
    expect('iceServers' in t).toBe(false);
    expect('iceTransportPolicy' in t).toBe(false);
  });

  test('ctx rev overrides the configured rev', async () => {
    const client = makeApiClient();
    await mintVoiceTicket(client, 'my-agent', { rev: 'feature/x' });
    expect((client.post as any)).toHaveBeenCalledWith(
      'orgs/org1/projects/proj1/workforce/my-agent/voice/ticket?rev=feature%2Fx',
    );
  });

  test('same ticket endpoint in studio mode — no preview variant for minting', async () => {
    process.env.TIMBAL_STUDIO = '1';
    const client = makeApiClient();
    await mintVoiceTicket(client, 'my-agent');
    expect((client.post as any)).toHaveBeenCalledWith(
      'orgs/org1/projects/proj1/workforce/my-agent/voice/ticket?rev=main',
    );
  });

  test('throws in pure-local mode', async () => {
    process.env.TIMBAL_START_WORKFORCE = 'uid-1:7100';
    const client = makeApiClient();
    await expect(mintVoiceTicket(client, 'uid-1')).rejects.toThrow(/platform credential/);
    expect((client.post as any)).not.toHaveBeenCalled();
  });
});

// ── wsUrl ───────────────────────────────────────────────────────────────────

describe('voiceWsUrl', () => {
  test('remote: wss URL against the deployed voice/ws path', async () => {
    const url = await voiceWsUrl(makeApiClient(), 'my-agent');
    expect(url).toBe(
      'wss://api.example.com/orgs/org1/projects/proj1/workforce/my-agent/voice/ws?rev=main',
    );
  });

  test('embeds a ticket as an encoded query param', async () => {
    const url = await voiceWsUrl(makeApiClient(), 'my-agent', { ticket: 'a+b/c' });
    expect(url).toBe(
      'wss://api.example.com/orgs/org1/projects/proj1/workforce/my-agent/voice/ws?rev=main&ticket=a%2Bb%2Fc',
    );
  });

  test('http base yields ws scheme', async () => {
    const url = await voiceWsUrl(makeApiClient({ baseUrl: 'http://localhost:4000' }), 'wf');
    expect(url.startsWith('ws://localhost:4000/')).toBe(true);
  });

  test('TIMBAL_STUDIO routes to voice/preview', async () => {
    process.env.TIMBAL_STUDIO = '1';
    const url = await voiceWsUrl(makeApiClient(), 'my-agent');
    expect(url).toContain('/voice/preview?rev=main');
  });

  test('explicit preview: false overrides studio auto-detection', async () => {
    process.env.TIMBAL_STUDIO = '1';
    const url = await voiceWsUrl(makeApiClient(), 'my-agent', { preview: false });
    expect(url).toContain('/voice/ws?rev=main');
  });

  test('explicit preview: true works without the studio env', async () => {
    const url = await voiceWsUrl(makeApiClient(), 'my-agent', { preview: true });
    expect(url).toContain('/voice/preview?rev=main');
  });

  test('local: ws URL straight at the local timbal.server port', async () => {
    process.env.TIMBAL_START_WORKFORCE = 'uid-1:7100';
    const url = await voiceWsUrl(makeApiClient(), 'uid-1');
    expect(url).toBe('ws://localhost:7100/voice/ws');
  });

  test('studio takes precedence over local, matching call/stream', async () => {
    process.env.TIMBAL_STUDIO = '1';
    process.env.TIMBAL_START_WORKFORCE = 'uid-1:7100';
    const url = await voiceWsUrl(makeApiClient(), 'uid-1');
    expect(url).toContain('/voice/preview?rev=main');
  });
});

// ── connect ─────────────────────────────────────────────────────────────────

describe('connectVoice', () => {
  test('default bearer auth: timbal.v1 + timbal.bearer.<token> subprotocols, no ticket', async () => {
    const client = makeApiClient();
    const ws = await connectVoice(client, 'my-agent');
    expect(FakeWebSocket.instances).toHaveLength(1);
    const dial = FakeWebSocket.instances[0]!;
    expect(dial.url).toBe(
      'wss://api.example.com/orgs/org1/projects/proj1/workforce/my-agent/voice/ws?rev=main',
    );
    expect(dial.protocols).toEqual(['timbal.v1', 'timbal.bearer.tok']);
    expect((client.post as any)).not.toHaveBeenCalled();
    expect((ws as any).binaryType).toBe('arraybuffer');
  });

  test("auth: 'ticket' mints just-in-time and dials with ?ticket=, no bearer subprotocol", async () => {
    const client = makeApiClient();
    await connectVoice(client, 'my-agent', { auth: 'ticket' });
    expect((client.post as any)).toHaveBeenCalledTimes(1);
    const dial = FakeWebSocket.instances[0]!;
    expect(dial.url).toContain('&ticket=');
    expect(dial.protocols).toEqual(['timbal.v1']);
  });

  test('a supplied ticket implies ticket auth and skips minting', async () => {
    const client = makeApiClient();
    await connectVoice(client, 'my-agent', { ticket: 'pre-minted' });
    expect((client.post as any)).not.toHaveBeenCalled();
    const dial = FakeWebSocket.instances[0]!;
    expect(dial.url).toContain('&ticket=pre-minted');
    expect(dial.protocols).toEqual(['timbal.v1']);
  });

  test('bearer auth without a configured token throws before dialing', async () => {
    const client = makeApiClient({ token: '' });
    await expect(connectVoice(client, 'my-agent')).rejects.toThrow(/requires a configured token/);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  test('local: bare dial, no subprotocols', async () => {
    process.env.TIMBAL_START_WORKFORCE = 'uid-1:7100';
    await connectVoice(makeApiClient(), 'uid-1');
    const dial = FakeWebSocket.instances[0]!;
    expect(dial.url).toBe('ws://localhost:7100/voice/ws');
    expect(dial.protocols).toBeUndefined();
  });

  test('extra protocols are appended', async () => {
    await connectVoice(makeApiClient(), 'my-agent', { protocols: ['custom.x'] });
    expect(FakeWebSocket.instances[0]!.protocols).toEqual([
      'timbal.v1',
      'timbal.bearer.tok',
      'custom.x',
    ]);
  });

  test('rejects when the socket errors before opening', async () => {
    FakeWebSocket.behavior = 'error';
    await expect(connectVoice(makeApiClient(), 'my-agent')).rejects.toThrow(/connect failed/);
  });

  test('rejects with code/reason when the socket closes before opening', async () => {
    FakeWebSocket.behavior = 'close';
    await expect(connectVoice(makeApiClient(), 'my-agent')).rejects.toThrow(
      /code 4003, forbidden/,
    );
  });

  test('timeoutMs rejects and closes a socket that never opens', async () => {
    FakeWebSocket.behavior = 'silent';
    await expect(
      connectVoice(makeApiClient(), 'my-agent', { timeoutMs: 10 }),
    ).rejects.toThrow(/did not open within 10ms/);
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
  });

  test('a late open after a timeout rejection closes the socket instead of leaking it', async () => {
    FakeWebSocket.behavior = 'silent';
    await expect(
      connectVoice(makeApiClient(), 'my-agent', { timeoutMs: 10 }),
    ).rejects.toThrow(/did not open within 10ms/);
    const dial = FakeWebSocket.instances[0]!;
    expect(dial.closeCalls).toBe(1); // the timeout's own close()
    // close() during CONNECTING is best-effort — the handshake can still
    // complete. Nobody holds the socket anymore, so it must be closed again.
    dial.dispatch('open', {});
    expect(dial.closeCalls).toBe(2);
  });

  test('close after a timeout rejection does not double-settle', async () => {
    FakeWebSocket.behavior = 'silent';
    await expect(
      connectVoice(makeApiClient(), 'my-agent', { timeoutMs: 10 }),
    ).rejects.toThrow(/did not open within 10ms/);
    // The close event that follows the timeout's ws.close() must be a no-op
    // (guarded by settle), not a second rejection path.
    FakeWebSocket.instances[0]!.dispatch('close', { code: 1006, reason: '' });
  });
});

// ── rtc ─────────────────────────────────────────────────────────────────────

describe('rtcVoice', () => {
  test('remote: POSTs the JSON offer to voice/rtc through the api client', async () => {
    const client = makeApiClient();
    const res = await rtcVoice(client, 'my-agent', { sdp: 'v=0…', type: 'offer' });
    expect(res.status).toBe(200);
    const [endpoint, init] = (client.fetch as any).mock.calls[0];
    expect(endpoint).toBe('orgs/org1/projects/proj1/workforce/my-agent/voice/rtc?rev=main');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ sdp: 'v=0…', type: 'offer' });
  });

  test('studio auto-routes signaling to voice/preview', async () => {
    process.env.TIMBAL_STUDIO = '1';
    const client = makeApiClient();
    await rtcVoice(client, 'my-agent', { sdp: 's', type: 'offer' });
    const [endpoint] = (client.fetch as any).mock.calls[0];
    expect(endpoint).toBe('orgs/org1/projects/proj1/workforce/my-agent/voice/preview?rev=main');
  });

  test('local: plain fetch to the local box, api client untouched', async () => {
    process.env.TIMBAL_START_WORKFORCE = 'uid-1:7100';
    const client = makeApiClient();
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = fetchMock as any;
    try {
      await rtcVoice(client, 'uid-1', { sdp: 's', type: 'offer' });
      const [url] = fetchMock.mock.calls[0] as any;
      expect(url).toBe('http://localhost:7100/voice/rtc');
      expect((client.fetch as any)).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('string offers pass through with an overridable content type', async () => {
    const client = makeApiClient();
    await rtcVoice(client, 'my-agent', 'v=0…raw-sdp', { contentType: 'application/sdp' });
    const [, init] = (client.fetch as any).mock.calls[0];
    expect(init.headers).toEqual({ 'Content-Type': 'application/sdp' });
    expect(init.body).toBe('v=0…raw-sdp');
  });
});

// ── view wiring ─────────────────────────────────────────────────────────────

describe('Workforce.voice', () => {
  test('lazy singleton view scoped to the same client + identifier', () => {
    const client = makeApiClient();
    const wf = new Workforce(client, 'my-agent');
    const v = wf.voice;
    expect(v).toBeInstanceOf(WorkforceVoice);
    expect(wf.voice).toBe(v);
    expect(v.apiClient).toBe(client);
    expect(v.identifier).toBe('my-agent');
    expect((client.post as any)).not.toHaveBeenCalled();
  });

  test('ticket() delegates through the view', async () => {
    const client = makeApiClient();
    const wf = new Workforce(client, 'my-agent');
    const t = await wf.voice.ticket();
    expect(t.ticket).toBe('eyJ.ticket.sig');
  });
});
