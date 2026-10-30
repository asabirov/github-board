// Delivery stream (#173 Phase 2): the dashboard's cross-repo "what shipped"
// feed, plus the org-wide unassigned-PR counter the Unassigned pulse card needs.
// Two independent lanes (Variant B): tagged Releases and recent merged PRs —
// read-only, every item deep-links to GitHub (the source of truth).

/** A GitHub Release tag, from a repo that cuts them. */
export interface ReleaseItem {
  /** short repo name, e.g. 'board' */
  repo: string;
  /** tag, e.g. 'v1.48.0' */
  tag: string;
  /** release title (may equal the tag or be empty) */
  name: string | null;
  htmlUrl: string;
  /** release creation time, ISO */
  atISO: string;
}

/** A pull request merged to its default branch. */
export interface MergeItem {
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
  /** author login, null when GitHub returns a ghost/deleted author */
  author: string | null;
  /** merge time, ISO */
  atISO: string;
}

/** The full delivery-stream payload served to the client. */
export interface DeliveryView {
  releases: ReleaseItem[];
  merges: MergeItem[];
  /** raw org-wide count of open PRs with no assignee (mostly deps bots). */
  unassignedPrs: number;
  /** data freshness (cached rollup age), not request time. */
  updatedAt: string;
  /** releases per UTC calendar day, oldest -> newest, `DAY_SPAN` long. Derived
   *  per request from `DeliveryData.releaseDates`, never cached — see
   *  `toDeliveryView`. */
  releaseDays: number[];
  /** true when the fetch could not see the whole span, so a low tail of
   *  `releaseDays` is a floor rather than a count. A truncated repo otherwise
   *  looks exactly like a quiet one — the distinction `OrgReadOutcome` keeps
   *  for issues, kept here for releases. */
  releasesPartial: boolean;
  /** which orgs `releaseDays` counts, named — "a", "a and b", "a, b, and c".
   *
   *  `/api/delivery` unions every org in `GITHUB_ORGS` (#697), and an org whose
   *  read failed contributes nothing, so the covered set is neither the
   *  configured list nor a single name. It stays ONE string because the only
   *  reader prints it verbatim into a sentence — `board-frontend`'s
   *  `flow-strip/ScopeLine.tsx` writes "Releases are the whole of {scope}." — and
   *  an array there would be a second list grammar beside the one that file
   *  already owns. */
  releaseScope: string;
}

/**
 * What the source produces and the cache holds. Release times stay raw ISO here
 * and are bucketed per request: cached pre-bucketed, the day series freezes at
 * fetch and "yesterday" is wrong for up to a full TTL after every UTC midnight.
 * The service stamps `updatedAt`.
 */
export type DeliveryData = Omit<DeliveryView, 'updatedAt' | 'releaseDays'> & {
  /** every non-draft release `createdAt` the fetch saw, pre-slice — the whole
   *  set, not the eight rows `releases` shows. */
  releaseDates: string[];
};

export const DELIVERY_SOURCE = 'DELIVERY_SOURCE_IMPL';

export interface IDeliverySource {
  /** Fetch ONE org's releases + merges + unassigned-PR count in one shot.
   *
   *  One org per call, and the org is an argument rather than a property of the
   *  source, because a deployment naming two orgs reads both through one source
   *  instance — concurrently, and tolerantly, so one org's failure is one
   *  rejected promise rather than a blank surface (#697). Fanning out and
   *  unioning the answers is `DeliveryService`'s, which is where the per-org
   *  cache already lives. */
  load(org: string): Promise<DeliveryData>;
}

/** How many rows each lane shows. Kept small — the feed is a pulse, not an
 *  archive. Read by the source, which slices one org's answer, and by
 *  `mergeDelivery`, which slices the union of them: two slices of one number,
 *  rather than one number written twice. */
export const MAX_RELEASES = 8;
export const MAX_MERGES = 12;
