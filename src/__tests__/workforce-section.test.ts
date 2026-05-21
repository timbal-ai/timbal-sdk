import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { WorkforceSection, Workforce, streamEvents } from '../lib/workforce';
import { clearWorkforceCache } from '../lib/functions/workforce';
import { Timbal } from '../lib/timbal';
import type { ApiClient } from '../lib/api';

const items = [
  { id: '361', uid: 'manifest-1', type: 'workflow', name: 'clever-jaguar', url: 'https://wf-361.example.com' },
  { id: '360', uid: 'manifest-2', type: 'agent', name: 'eager-pelican', url: 'https://wf-360.example.com' },
];

function makeApiClient(): ApiClient {
  return {
    get: mock(() => Promise.resolve({ data: { workforce: items } })),
    getConfig: () => ({ orgId: 'org1', projectId: 'proj1', rev: 'main', kbId: '', token: 'tok' }),
  } as any;
}

beforeEach(() => {
  clearWorkforceCache();
  delete process.env.TIMBAL_START_WORKFORCE;
  delete process.env.TIMBAL_WORKFORCE;
  delete process.env.TIMBAL_STUDIO;
});

// ── WorkforceSection ───────────────────────────────────────────────────────

describe('WorkforceSection', () => {
  test('list() delegates to listWorkforces', async () => {
    const client = makeApiClient();
    const section = new WorkforceSection(client);
    const result = await section.list();
    expect(result).toEqual(items);
    expect((client.get as any)).toHaveBeenCalledWith(
      'orgs/org1/projects/proj1/workforce',
      { rev: 'main' },
    );
  });

  test('get(identifier) returns a Workforce instance, no network', () => {
    const client = makeApiClient();
    const section = new WorkforceSection(client);
    const wf = section.get('clever-jaguar');
    expect(wf).toBeInstanceOf(Workforce);
    expect(wf.identifier).toBe('clever-jaguar');
    expect(wf.apiClient).toBe(client);
    expect((client.get as any)).not.toHaveBeenCalled();
  });

  test('clearCache() invalidates the per-rev list cache', async () => {
    const client = makeApiClient();
    const section = new WorkforceSection(client);
    await section.list();
    await section.list();
    expect((client.get as any)).toHaveBeenCalledTimes(2);

    section.clearCache();
    await section.list();
    expect((client.get as any)).toHaveBeenCalledTimes(3);
  });
});

// ── Workforce ──────────────────────────────────────────────────────────────

describe('Workforce', () => {
  test('info() returns the resolved WorkforceItem with coerced ids', async () => {
    const client = makeApiClient();
    const wf = new Workforce(client, 'clever-jaguar');
    const info = await wf.info();
    expect(info.id).toBe('361');
    expect(info.uid).toBe('manifest-1');
    expect(info.name).toBe('clever-jaguar');
    expect(info.url).toBe('https://wf-361.example.com');
    expect(typeof info.id).toBe('string');
  });

  test('info() shares the workforce list cache with call()', async () => {
    const client = makeApiClient();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('{"ok":true}', { status: 200 })),
    ) as any;

    try {
      const wf = new Workforce(client, 'clever-jaguar');
      await wf.info();
      await wf.call({ message: 'hi' });
      // First info() refresh → 1; cached on the second call → still 1.
      expect((client.get as any)).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('info() throws when identifier not found', async () => {
    const client = makeApiClient();
    const wf = new Workforce(client, 'nope-not-here');
    await expect(wf.info()).rejects.toThrow(/not found/);
  });

  test('info() takes the studio (remote-resolve) path when TIMBAL_STUDIO is set, even with TIMBAL_START_WORKFORCE', async () => {
    // Regression: callWorkforce / streamWorkforce check studio BEFORE local.
    // info() must match — otherwise info() returns the YAML-scanned local item
    // while call() hits the deployed remote item. Different items, same wf.
    process.env.TIMBAL_STUDIO = '1';
    process.env.TIMBAL_START_WORKFORCE = 'manifest-1:7100';
    try {
      const client = makeApiClient();
      const wf = new Workforce(client, 'clever-jaguar');
      const info = await wf.info();
      // Remote shape — id "361" comes from the mocked workforce list,
      // not from the synthetic local YAML scan which would set id=identifier.
      expect(info.id).toBe('361');
      expect(info.url).toBe('https://wf-361.example.com');
      expect((client.get as any)).toHaveBeenCalled();
    } finally {
      delete process.env.TIMBAL_STUDIO;
      delete process.env.TIMBAL_START_WORKFORCE;
    }
  });

  test('info() falls back to local resolution only when studio is OFF', async () => {
    // Pure-local mode: no TIMBAL_STUDIO, TIMBAL_START_WORKFORCE set.
    // info() should NOT hit the network — local resolve handles it.
    process.env.TIMBAL_START_WORKFORCE = 'standalone-x:7100';
    try {
      const client = makeApiClient();
      const wf = new Workforce(client, 'standalone-x');
      const info = await wf.info();
      // Synthetic local item — uid comes straight from the env entry.
      expect(info.uid).toBe('standalone-x');
      expect((client.get as any)).not.toHaveBeenCalled();
    } finally {
      delete process.env.TIMBAL_START_WORKFORCE;
    }
  });

  test('call() POSTs to the resolved deployment url with the payload', async () => {
    const client = makeApiClient();
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(() =>
      Promise.resolve(new Response('{"ok":true}', { status: 200 })),
    );
    globalThis.fetch = fetchMock as any;

    try {
      const wf = new Workforce(client, 'clever-jaguar');
      const res = await wf.call({ message: 'hi' });
      expect(res.status).toBe(200);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchMock.mock.calls[0] as any);
      expect(url).toBe('https://wf-361.example.com/run');
      expect((init as RequestInit).method).toBe('POST');
      expect(JSON.parse((init as any).body)).toEqual({ message: 'hi' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('stream() POSTs to the deployment /stream path', async () => {
    const client = makeApiClient();
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(() =>
      Promise.resolve(new Response('data: {"type":"delta"}\n\n', { status: 200 })),
    );
    globalThis.fetch = fetchMock as any;

    try {
      const wf = new Workforce(client, 'manifest-2');
      await wf.stream({ prompt: 'go' });
      const [url] = (fetchMock.mock.calls[0] as any);
      expect(url).toBe('https://wf-360.example.com/stream');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('events() yields parsed SSE payloads', async () => {
    const client = makeApiClient();
    const sse = [
      'data: {"type":"delta","delta":"hel"}\n\n',
      'data: {"type":"delta","delta":"lo"}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(sse, { status: 200 })),
    ) as any;

    try {
      const wf = new Workforce(client, 'clever-jaguar');
      const out: any[] = [];
      for await (const ev of wf.events({})) out.push(ev);

      expect(out).toEqual([
        { type: 'delta', delta: 'hel' },
        { type: 'delta', delta: 'lo' },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── streamEvents (standalone) ──────────────────────────────────────────────

describe('streamEvents', () => {
  test('buffers across chunk boundaries', async () => {
    // Manually craft a stream that splits "data: {\"a\":1}\n\n" in half.
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('data: {"a"'),
      encoder.encode(':1}\n\n'),
      encoder.encode('data: {"b":2}\n\n'),
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const res = new Response(stream);

    const out: any[] = [];
    for await (const ev of streamEvents(res)) out.push(ev);
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test('handles multi-line data: events', async () => {
    const body = 'data: {"k":\ndata: 42}\n\n';
    const res = new Response(body);
    const out: any[] = [];
    for await (const ev of streamEvents(res)) out.push(ev);
    expect(out).toEqual([{ k: 42 }]);
  });

  test('skips comment lines and [DONE]', async () => {
    const body = ': heartbeat\n\ndata: {"x":1}\n\ndata: [DONE]\n\n';
    const res = new Response(body);
    const out: any[] = [];
    for await (const ev of streamEvents(res)) out.push(ev);
    expect(out).toEqual([{ x: 1 }]);
  });

  test('throws when response has no body', async () => {
    const res = new Response(null);
    await expect((async () => {
      for await (const _ of streamEvents(res)) { /* unused */ }
    })()).rejects.toThrow('no body');
  });

  test('cancels the underlying stream on early break (closes the HTTP socket)', async () => {
    let cancelled = false;
    let pulled = 0;
    const events = [
      'data: {"i":0}\n\n',
      'data: {"i":1}\n\n',
      'data: {"i":2}\n\n',
      'data: {"i":3}\n\n',
    ];
    const stream = new ReadableStream({
      pull(controller) {
        if (pulled < events.length) {
          controller.enqueue(new TextEncoder().encode(events[pulled]!));
          pulled++;
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(stream);

    let seen = 0;
    for await (const _ev of streamEvents(res)) {
      seen++;
      if (seen === 1) break;
    }
    // releaseLock() alone would leave `cancelled` as false; cancel() must be
    // called for the source's cancel algorithm to run (and the fetch socket
    // to close in production).
    expect(seen).toBe(1);
    expect(cancelled).toBe(true);
  });

  test('cancels on throw inside the consumer', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"x":1}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const res = new Response(stream);

    await expect((async () => {
      for await (const _ev of streamEvents(res)) {
        throw new Error('consumer boom');
      }
    })()).rejects.toThrow('consumer boom');
    expect(cancelled).toBe(true);
  });
});

// ── Timbal.workforce wiring ────────────────────────────────────────────────

describe('Timbal.workforce', () => {
  test('lazy singleton — same instance on repeat access', () => {
    const timbal = new Timbal({ token: 'tok', orgId: 'org1', projectId: 'proj1' });
    const a = timbal.workforce;
    const b = timbal.workforce;
    expect(a).toBe(b);
    expect(a).toBeInstanceOf(WorkforceSection);
  });

  test('legacy flat methods still exist and delegate to the same backing fns', () => {
    const timbal = new Timbal({ token: 'tok', orgId: 'org1', projectId: 'proj1' });
    expect(typeof timbal.listWorkforces).toBe('function');
    expect(typeof timbal.callWorkforce).toBe('function');
    expect(typeof timbal.streamWorkforce).toBe('function');
    expect(typeof timbal.clearWorkforceCache).toBe('function');
  });
});
