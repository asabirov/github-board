import { API, networkFetch as apiFetch } from './core';

// Delivery stream (#173 Phase 2): cross-repo "what shipped" feed for the dashboard.
export interface ReleaseItem {
  repo: string;
  tag: string;
  name: string | null;
  htmlUrl: string;
  atISO: string;
}
export interface MergeItem {
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
  author: string | null;
  atISO: string;
}
export interface DeliveryView {
  releases: ReleaseItem[];
  merges: MergeItem[];
  /** raw org-wide count of open PRs with no assignee (mostly deps bots). */
  unassignedPrs: number;
  updatedAt: string;
  /** Releases per UTC calendar day (#666), oldest → newest, DAY_SPAN long —
   *  the Releases tile's number and spark. Bucketed at read time, so the tail
   *  cell is always the day the response was served on. Optional across the
   *  deploy window: board-web ships before board-api. */
  releaseDays?: number[];
  /** True when a repo's release list was truncated at the page limit, or when
   *  more repos exist than one page holds — a truncated repo is otherwise
   *  indistinguishable from a quiet one. */
  releasesPartial?: boolean;
  /** The Github orgs these releases were counted over, already joined into
   *  English prose by the service — "a", "a and b" (#697). Named rather than
   *  implied so the tile says what it counted; it was ONE org's name before
   *  #697, and a reader who assumed that still gets a true sentence, because a
   *  single-org deployment formats to that one name. Optional across the deploy
   *  window, and the sentence is dropped rather than guessed at when absent. */
  releaseScope?: string;
}

/** The delivery stream (#173 Phase 2). Live since then and, until #666, never
 *  called: the strip's Releases tile is its first reader. */
export async function fetchDelivery(): Promise<DeliveryView> {
  const res = await apiFetch(`${API}/api/delivery`);
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(`delivery ${res.status}`);
  return res.json();
}
