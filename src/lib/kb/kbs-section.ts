import type { ApiClient } from '../api';
import type { KbInfo, KbInfoPage, KbListOptions } from '../../types';
import { listKbs, listKbsPage } from '../functions/kb';
import { KB } from './kb';

/**
 * Knowledge Base collection — reached via `timbal.kbs`.
 *
 * Stripe-style: collection ops (`list`, `listPage`, `iterate`, future CRUD) live here;
 * the resource view itself is returned by `kbs.get(id)`.
 */
export class KbsSection {
  constructor(private readonly apiClient: ApiClient) {}

  /**
   * List KBs in the configured org (`GET /orgs/{org}/k2`).
   *
   * Returns the **first page's** `k2` array only. For `next_page_token` or
   * automatic paging use {@link listPage} or {@link iterate}.
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
  async *iterate(options?: KbListOptions): AsyncIterable<KbInfo> {
    let pageToken = options?.page_token;

    for (;;) {
      const page = await listKbsPage(this.apiClient, {
        ...(pageToken !== undefined && { page_token: pageToken }),
      });

      for (const kb of page.k2) {
        yield kb;
      }

      const next = page.next_page_token;
      if (next == null || next === '') break;
      pageToken = next;
    }
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
