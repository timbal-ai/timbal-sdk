import type { ApiClient } from '../api';
import type { KbInfo, KbListOptions } from '../../types';
import { listKbs } from '../functions/kb';
import { KB } from './kb';

/**
 * Knowledge Base collection — reached via `timbal.kbs`.
 *
 * Stripe-style: collection ops (`list`, future `create`/`update`/`delete`) live here;
 * the resource view itself is returned by `kbs.get(id)`.
 */
export class KbsSection {
  constructor(private readonly apiClient: ApiClient) {}

  /**
   * List KBs in the configured org (`GET /orgs/{org}/k2`).
   */
  list(options?: KbListOptions): Promise<KbInfo[]> {
    return listKbs(this.apiClient, options);
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
