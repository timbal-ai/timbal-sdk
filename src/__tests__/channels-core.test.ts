import { describe, test, expect } from 'bun:test';
import { DedupeCache } from '../channels/dedupe';
import { StreamingReply, splitText } from '../channels/reply';
import type { ChannelDelivery } from '../channels/types';

describe('DedupeCache', () => {
  test('first sighting is false, repeat is true', () => {
    const cache = new DedupeCache();
    expect(cache.seen('a')).toBe(false);
    expect(cache.seen('a')).toBe(true);
    expect(cache.seen('b')).toBe(false);
  });

  test('entries expire after the TTL', () => {
    let t = 0;
    const cache = new DedupeCache(1000, 10_000, () => t);
    expect(cache.seen('a')).toBe(false);
    t = 500;
    expect(cache.seen('a')).toBe(true);
    t = 1001;
    expect(cache.seen('a')).toBe(false); // expired → re-recorded
  });

  test('evicts oldest entries beyond capacity', () => {
    const cache = new DedupeCache(60_000, 2);
    cache.seen('a');
    cache.seen('b');
    cache.seen('c'); // evicts 'a'
    expect(cache.seen('a')).toBe(false);
    expect(cache.seen('c')).toBe(true);
  });
});

/** Delivery double that records calls and lets tests control edit support. */
function makeDelivery(withEdit = true, maxTextLength?: number) {
  const calls: { op: 'send' | 'edit'; text: string }[] = [];
  const delivery: ChannelDelivery = {
    maxTextLength,
    async send(text: string) {
      calls.push({ op: 'send', text });
      return 'msg-1';
    },
    ...(withEdit
      ? {
          async edit(_ref: unknown, text: string) {
            calls.push({ op: 'edit', text });
          },
        }
      : {}),
  };
  return { delivery, calls };
}

/** Manual timer: collects scheduled callbacks so tests fire them explicitly. */
function makeTimer() {
  const pending: (() => void)[] = [];
  return {
    schedule: (fn: () => void, _ms: number) => {
      pending.push(fn);
      return 0;
    },
    fire: async () => {
      const fns = pending.splice(0);
      for (const fn of fns) fn();
      // Let the enqueued async ops settle.
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('splitText', () => {
  test('returns single chunk when under the limit or unlimited', () => {
    expect(splitText('short', 10)).toEqual(['short']);
    expect(splitText('any length at all', undefined)).toEqual(['any length at all']);
  });

  test('prefers newline, then space, near the end of the window', () => {
    expect(splitText('aaaa aaaa\nbbbb', 10)).toEqual(['aaaa aaaa', 'bbbb']);
    expect(splitText('aaaa aaaa bbbb', 10)).toEqual(['aaaa aaaa', 'bbbb']);
  });

  test('hard-cuts when no break point exists in the window tail', () => {
    expect(splitText('abcdefghijklmno', 10)).toEqual(['abcdefghij', 'klmno']);
  });

  test('every chunk respects the limit', () => {
    const text = 'word '.repeat(1000);
    for (const chunk of splitText(text, 100)) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });
});

describe('StreamingReply', () => {
  test('first update sends, later updates coalesce into one edit', async () => {
    const { delivery, calls } = makeDelivery();
    let t = 0;
    const timer = makeTimer();
    const reply = new StreamingReply(delivery, {
      editIntervalMs: 1000,
      now: () => t,
      schedule: timer.schedule,
    });

    reply.update('Hel');
    await tick(); // let the initial send deliver before more deltas arrive
    reply.update('Hello');
    reply.update('Hello wor');
    t = 1000;
    await timer.fire();
    await reply.finalize('Hello world');

    expect(calls[0]).toEqual({ op: 'send', text: 'Hel' });
    // One coalesced edit carrying the latest text at fire time...
    expect(calls[1]).toEqual({ op: 'edit', text: 'Hello wor' });
    // ...and the finalize edit with the definitive text.
    expect(calls[2]).toEqual({ op: 'edit', text: 'Hello world' });
    expect(calls).toHaveLength(3);
  });

  test('a synchronous burst of deltas coalesces into the initial send', async () => {
    const { delivery, calls } = makeDelivery();
    const timer = makeTimer();
    const reply = new StreamingReply(delivery, { schedule: timer.schedule });

    reply.update('Hel');
    reply.update('Hello wor'); // lands before the send op runs
    await tick();

    expect(calls).toEqual([{ op: 'send', text: 'Hello wor' }]);
  });

  test('delivery without edit support posts once, at finalize', async () => {
    const { delivery, calls } = makeDelivery(false);
    const reply = new StreamingReply(delivery);

    reply.update('partial');
    reply.update('partial text');
    await reply.finalize('final text');

    expect(calls).toEqual([{ op: 'send', text: 'final text' }]);
  });

  test('finalize with no updates and empty text sends nothing', async () => {
    const { delivery, calls } = makeDelivery();
    const reply = new StreamingReply(delivery);
    await reply.finalize('');
    expect(calls).toHaveLength(0);
  });

  test('finalize sends when nothing was streamed', async () => {
    const { delivery, calls } = makeDelivery();
    const reply = new StreamingReply(delivery);
    await reply.finalize('only answer');
    expect(calls).toEqual([{ op: 'send', text: 'only answer' }]);
  });

  test('streaming: false posts once, complete, at finalize', async () => {
    const { delivery, calls } = makeDelivery();
    const reply = new StreamingReply(delivery, { streaming: false });

    reply.update('partial');
    reply.update('partial text');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(0); // nothing mid-generation

    await reply.finalize('final text');
    expect(calls).toEqual([{ op: 'send', text: 'final text' }]);
  });

  test('streamed edits stop growing at maxTextLength; finalize splits the rest', async () => {
    const { delivery, calls } = makeDelivery(true, 10);
    let t = 0;
    const timer = makeTimer();
    const reply = new StreamingReply(delivery, {
      editIntervalMs: 1000,
      now: () => t,
      schedule: timer.schedule,
    });

    reply.update('12345');
    await tick();
    reply.update('1234567890ABCDE'); // over the cap
    t = 1000;
    await timer.fire();
    // The over-cap edit is truncated to the limit...
    expect(calls[1]).toEqual({ op: 'edit', text: '1234567890' });

    reply.update('1234567890ABCDEFGHIJxyz'); // further updates are dropped (capped)
    t = 2000;
    await timer.fire();
    expect(calls).toHaveLength(2);

    await reply.finalize('1234567890ABCDEFGHIJxyz');
    // Chunk 1 already delivered verbatim (no redundant edit), remainder sent fresh.
    expect(calls[2]).toEqual({ op: 'send', text: 'ABCDEFGHIJ' });
    expect(calls[3]).toEqual({ op: 'send', text: 'xyz' });
    expect(calls).toHaveLength(4);
  });

  test('long non-streamed reply is split into multiple sends', async () => {
    const { delivery, calls } = makeDelivery(true, 10);
    const reply = new StreamingReply(delivery, { streaming: false });

    await reply.finalize('aaaaabbbbbcccccddd');
    expect(calls).toEqual([
      { op: 'send', text: 'aaaaabbbbb' },
      { op: 'send', text: 'cccccddd' },
    ]);
  });

  test('mid-stream edit failures are swallowed; finalize re-asserts state', async () => {
    const calls: string[] = [];
    let editCount = 0;
    const delivery: ChannelDelivery = {
      async send(text: string) {
        calls.push(`send:${text}`);
        return 'ref';
      },
      async edit(_ref: unknown, text: string) {
        editCount += 1;
        if (editCount === 1) throw new Error('429');
        calls.push(`edit:${text}`);
      },
    };
    let t = 0;
    const timer = makeTimer();
    const reply = new StreamingReply(delivery, {
      editIntervalMs: 1000,
      now: () => t,
      schedule: timer.schedule,
    });

    reply.update('a');
    await tick(); // send:a delivered
    reply.update('ab');
    t = 1000;
    await timer.fire(); // this edit throws (429) — swallowed
    await reply.finalize('abc');

    expect(calls).toEqual(['send:a', 'edit:abc']);
  });
});
