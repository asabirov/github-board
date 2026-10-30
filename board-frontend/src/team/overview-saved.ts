import { resolvedTimezone } from '../account/prefs';
/**
 * The saved copies the Overview tiles fall back on (#1046): the org queue that
 * Issues and The oldest are counted from, and the metrics Closed is.
 *
 * The store and the rule a copy is recalled and drawn under are the Projects
 * rollup's (`projects/projects-last-good.ts`, #1035), not a second set: the same
 * person seen through the same Github access, the same two-hour ceiling, never a
 * first paint, the same Caddy 502 during a deploy drawing the copy, and a
 * failure that may not fall back on a copy deleting EVERY saved copy, these and
 * the Projects rollup's alike (#1042 round 3). There is no way to forget one of
 * them. The queue is permission-sensitive and `forgetSensitivePayloads` takes
 * its stored copy at every page load, which is why a reload whose read failed
 * drew the sentence and no figure.
 *
 * What differs is which 503 says "not now". These two reads answer from the
 * issue ingest, and board-api codes its quota refusal `ISSUES_NOT_NOW_CODE`,
 * not the Projects rollup's code.
 */
import type { IssueMetrics, OrgQueue } from '../api/issues';
import { keepSaved, METRICS_KEY, ORG_QUEUE_KEY, orgScopedKey, type SavedKey } from '../cache/payload-cache';
import { recallSaved, SAVED_COPY_MAX_AGE_MS, type Recalled } from '../projects/projects-last-good';

/**
 * The code board-api puts on the one 503 these copies may answer: the issue
 * ingest lost its whole scope, and Github refused every read behind that on
 * quota. Must match `ISSUES_NOT_NOW_CODE` in board-service's
 * `issues-metrics/github-issues.source.ts`, which says why it is not the
 * Projects code.
 */
export const ISSUES_NOT_NOW_CODE = 'issues_not_now';

const queueKey = (org: string | null): SavedKey => orgScopedKey(ORG_QUEUE_KEY, org);
const metricsKey = (org: string | null, timeZone: string): SavedKey => orgScopedKey(METRICS_KEY, JSON.stringify([org, timeZone]));

/** The ceiling on the DATA's age, not only the save's. board-api answers from
 *  its stale-while-revalidate cache, and after a write from the last snapshot it
 *  kept (#692), while `keepSaved` stamps the moment of saving. Both payloads
 *  carry the snapshot's time as `updatedAt`, so a copy whose snapshot is past
 *  the ceiling is refused however recently it was saved. */
function young(v: { updatedAt?: unknown }, now = Date.now()): boolean {
  const at = typeof v.updatedAt === 'string' ? Date.parse(v.updatedAt) : NaN;
  return !Number.isNaN(at) && now - at <= SAVED_COPY_MAX_AGE_MS;
}

/** Shape tests. A copy either refuses is deleted, so beyond the age each asks
 *  only what the strip would throw without: a list of issues, and an object. */
const isQueue = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && Array.isArray((v as { issues?: unknown }).issues) && young(v);
const isMetrics = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && young(v as { updatedAt?: unknown });

/** Save what a live read answered, for this org. */
export function saveQueue(org: string | null, queue: OrgQueue): void {
  keepSaved(queueKey(org), queue);
}
export function saveMetrics(org: string | null, metrics: IssueMetrics, timeZone = resolvedTimezone()): void {
  keepSaved(metricsKey(org, timeZone), metrics);
}

/** The copy a failed read may draw, or null. A failure that may not fall back
 *  on one forgets every saved copy, this one included. */
export function recallQueue(org: string | null, e: unknown): Recalled<OrgQueue> | null {
  return recallSaved<OrgQueue>(queueKey(org), org, e, isQueue);
}
export function recallMetrics(org: string | null, e: unknown, timeZone = resolvedTimezone()): Recalled<IssueMetrics> | null {
  return recallSaved<IssueMetrics>(metricsKey(org, timeZone), org, e, isMetrics);
}
