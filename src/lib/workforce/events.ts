import { parseSSELine } from '../functions/sse';

/**
 * A workforce event emitted over SSE. Shape is component-specific; the SDK
 * does not coerce it. Treat as `Record<string, unknown>` and key off your
 * known fields (e.g. `type`, `delta`, `output`).
 */
export type WorkforceEvent = Record<string, unknown>;

/**
 * Stream events from a workforce `Response` as an async iterable of parsed
 * JSON objects.
 *
 * Buffers chunks across `read()` boundaries, splits on SSE event terminators
 * (`\n\n`), gathers `data:` lines per event, and yields parsed payloads.
 * Drops the `[DONE]` sentinel silently. Unparseable lines are skipped (not
 * thrown — the workforce can emit comments/heartbeats).
 *
 * Cleanup: the iterator's `finally` calls `reader.cancel()` which signals
 * the source's cancel algorithm — for a fetch `Response` body this aborts
 * the underlying HTTP request and closes the socket. Releasing the lock
 * alone (`releaseLock()`) would NOT do this; the connection would stay open
 * until GC. Safe to break out of the loop early.
 *
 * ```ts
 * const res = await wf.stream({ message: "hi" });
 * for await (const ev of streamEvents(res)) {
 *   if (ev.type === "delta") process.stdout.write(String(ev.delta));
 *   if (someCondition) break; // socket is closed here
 * }
 * ```
 */
export async function* streamEvents(response: Response): AsyncIterable<WorkforceEvent> {
  if (!response.body) {
    throw new Error('Response has no body to stream');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any trailing event without a final \n\n.
        if (buffer.trim()) {
          const flushed = drainEvent(buffer);
          if (flushed) yield flushed;
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = drainEvent(rawEvent);
        if (parsed) yield parsed;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    // cancel() aborts the underlying fetch and implicitly releases the lock
    // (per Streams spec). No-op on already-closed streams. Awaited so the
    // socket teardown actually completes before the generator returns.
    try { await reader.cancel(); } catch { /* already detached */ }
  }
}

/**
 * Collect the `data:` lines in one SSE event block and parse the
 * concatenated payload. Returns `null` for [DONE] / unparseable / empty.
 */
function drainEvent(block: string): WorkforceEvent | null {
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith(':')) continue;
    if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return parseSSELine(`data: ${dataLines.join('\n')}`);
}
