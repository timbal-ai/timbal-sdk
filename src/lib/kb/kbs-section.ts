import type { ApiClient } from '../api';
import type { KbInfo, KbInfoPage, KbListOptions } from '../../types';
import { listKbs, listKbsPage, listKbsAll, iterateKbs } from '../functions/kb';
import { KB } from './kb';

/**
 * Knowledge Base collection — reached via `timbal.kbs`.
 *
 * Stripe-style: collection ops (`list`, `listPage`, `listAll`, `iterate`, …) live
 * here; the resource view itself is returned by `kbs.get(id)`.
 */
export class KbsSection {
  constructor(private readonly apiClient: ApiClient) {}

  /**
   * List KBs in the configured org (`GET /orgs/{org}/k2`) — **first page only**.
   *
   * The API paginates; this returns just the first page's `k2` slice. When you
   * need every KB, use {@link listAll}. For manual paging or streaming use
   * {@link listPage} or {@link iterate}.
   */
  list(options?: KbListOptions): Promise<KbInfo[]> {
    return listKbs(this.apiClient, options);
  }

  /**
   * List KBs with full pagination metadata (`{ k2, next_page_token? }` per
   * the OpenAPI `ListK2Response` shape).
   */
  listPage(options?: KbListOptions): Promise<KbInfoPage> {
    return listKbsPage(this.apiClient, options);
  }

  /**
   * List every KB in the org, draining all pages into one array.
   *
   * Sugar over {@link iterate}. Prefer `iterate()` when the org may have many
   * KBs and you want to process them one at a time without holding the full
   * list in memory.
   */
  listAll(options?: KbListOptions): Promise<KbInfo[]> {
    return listKbsAll(this.apiClient, options);
  }

  /**
   * Async iterator over every KB in the org, walking pages automatically.
   *
   * Built on {@link listPage}. Pass `page_token` only to resume from a cursor.
   *
   * ```ts
   * for await (const kb of timbal.kbs.iterate()) {
   *   console.log(kb.name, kb.id);
   * }
   * ```
   */
  iterate(options?: KbListOptions): AsyncIterable<KbInfo> {
    return iterateKbs(this.apiClient, options);
  }

  /**
   * Get a scoped view onto a specific KB. **Synchronous, no network call** — just
   * wraps `apiClient` + `kbId`. Use the returned `KB` to issue queries, fetch the
   * schema, upload files, etc.
   *
   * ```ts
   * const kb = timbal.kbs.get(process.env.TIMBAL_KB_ID!);
   * await kb.query('SELECT 1');
   * await kb.files.upload(buf, 'order.pdf', { directory: 'orders' });
   * ```
   */
  get(kbId: string): KB {
    return new KB(this.apiClient, kbId);
  }
}
