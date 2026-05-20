import type { ApiClient } from '../api';
import type { PlatformContext } from '../../types';
import {
  callWorkforce as callWorkforceFn,
  streamWorkforce as streamWorkforceFn,
} from '../functions/workforce';
import { streamEvents, type WorkforceEvent } from './events';

/**
 * A typed, scoped view onto a single workforce component (agent / workflow /
 * tool). Construct via `timbal.workforce.get(identifier)` (preferred) or
 * `new Workforce(apiClient, identifier)` directly (escape hatch).
 *
 * The `identifier` can be a numeric id, uid, or name — resolution happens
 * lazily on the first `call` / `stream` and is cached per
 * `orgId:projectId:rev` on the shared `ApiClient`. Allocating new views per
 * call is cheap; the platform's auth/refresh/retry/error handling lives on
 * the shared client, not duplicated per view.
 */
export class Workforce {
  constructor(
    public readonly apiClient: ApiClient,
    public readonly identifier: string,
  ) {}

  /**
   * Invoke the component and return the raw `Response`.
   *
   * Routes through the appropriate environment (remote `/run`, local
   * `TIMBAL_START_WORKFORCE`, or studio codegen) based on the same env
   * detection used by the legacy `callWorkforce` function.
   */
  call(
    input: Record<string, unknown> = {},
    ctx?: PlatformContext,
  ): Promise<Response> {
    return callWorkforceFn(this.apiClient, this.identifier, input, ctx);
  }

  /**
   * Invoke the component in streaming mode and return the raw `Response`.
   *
   * Most callers should prefer {@link events} for a typed async iterator
   * over parsed SSE payloads. Use `stream` directly only when you need the
   * raw body (e.g. to forward bytes downstream, inspect headers, or pipe
   * through a different parser).
   */
  stream(
    input: Record<string, unknown> = {},
    ctx?: PlatformContext,
  ): Promise<Response> {
    return streamWorkforceFn(this.apiClient, this.identifier, input, ctx);
  }

  /**
   * Invoke the component in streaming mode and yield parsed SSE events.
   *
   * Convenience wrapper over `stream` + the SSE parser. Buffers chunks,
   * splits on event boundaries, drops `[DONE]`, and silently skips comment
   * / heartbeat lines.
   *
   * ```ts
   * for await (const ev of wf.events({ prompt: "hi" })) {
   *   if (ev.type === "delta") process.stdout.write(String(ev.delta));
   * }
   * ```
   */
  async *events(
    input: Record<string, unknown> = {},
    ctx?: PlatformContext,
  ): AsyncIterable<WorkforceEvent> {
    const res = await this.stream(input, ctx);
    yield* streamEvents(res);
  }
}
