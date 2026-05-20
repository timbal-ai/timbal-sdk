import type { ApiClient } from '../api';
import type { PlatformContext, WorkforceItem } from '../../types';
import {
  listWorkforces as listWorkforcesFn,
  clearWorkforceCache as clearWorkforceCacheFn,
} from '../functions/workforce';
import { Workforce } from './workforce';

/**
 * Workforce accessor — reached via `timbal.workforce`.
 *
 * Stripe-style: collection ops (`list`, `clearCache`) live here; the
 * resource view itself is returned by `workforce.get(identifier)`. Named
 * `WorkforceSection` (singular) because "workforce" is itself the
 * collection noun in Timbal — it holds agents, workflows, and tools.
 */
export class WorkforceSection {
  constructor(private readonly apiClient: ApiClient) {}

  /**
   * List workforce components for the configured project.
   *
   * `GET /orgs/{org}/projects/{proj}/workforce?rev={rev}` in remote mode.
   * Reads `timbal.yaml` manifests on disk in local mode.
   *
   * Items include a `url` when a running deployment exists on the given branch.
   */
  list(ctx?: PlatformContext): Promise<WorkforceItem[]> {
    return listWorkforcesFn(this.apiClient, ctx);
  }

  /**
   * Get a scoped view onto a workforce component. **Synchronous, no network
   * call** — just wraps `apiClient` + `identifier`. The identifier is
   * resolved lazily (id / uid / name) on the first `call` / `stream` /
   * `events`.
   *
   * ```ts
   * const wf = timbal.workforce.get("my-agent");
   * await wf.call({ message: "hi" });
   * for await (const ev of wf.events({ message: "hi" })) { ... }
   * ```
   */
  get(identifier: string): Workforce {
    return new Workforce(this.apiClient, identifier);
  }

  /**
   * Invalidate the cached workforce list (keyed by `orgId:projectId:rev`).
   *
   * Call this when you deploy new components mid-session or want to force
   * the next `get(id).call(...)` to re-fetch the list before resolving the
   * deployment URL.
   */
  clearCache(): void {
    clearWorkforceCacheFn();
  }
}
