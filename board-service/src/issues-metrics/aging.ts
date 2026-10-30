/**
 * The ONE definition of "aging" (#478).
 *
 * Two surfaces one section apart used to answer "how much work is old?" from
 * different rules: the Unit page's Oldest-open block counted open FLOW issues,
 * while the Unit queue counted every open issue — so the block said 34 and the
 * queue said 35, for what a reader takes to be the same set. The difference was
 * a single `discovery`-labelled issue.
 *
 * The block's rule won, and it lives here. Steady-state issues (AORs, OKR-tree
 * nodes, discovery notes) are long-lived BY DESIGN — see the note in
 * `issues-metrics.vm.ts` — so measuring them by issue age says nothing, and an
 * "aging" list that leads with a two-year-old AOR buries the thing it exists to
 * show. Everything that reports an aging count goes through this predicate:
 * `computeMetrics` for the block's rows and total, and `shapeQueueIssue` for the
 * per-row flag the queue's Aging filter reads. The frontend never re-derives the
 * threshold, so the two cannot drift apart again.
 */
import { RawIssue } from './issues-metrics.types';

const DAY_MS = 86_400_000;

/** How long an open flow issue has to sit before it reads as aging. */
export const AGING_DAYS = 30;

/**
 * True when an issue is open, is flow work (not steady-state), and has been open
 * for at least AGING_DAYS. `longLived` is the configured LONG_LIVED_LABELS set;
 * an empty set means everything is flow.
 */
export function isAging(i: RawIssue, now: number, longLived: Set<string>): boolean {
  if (i.state !== 'open') return false;
  if (i.labels.some((l) => longLived.has(l))) return false;
  return now - Date.parse(i.createdAt) >= AGING_DAYS * DAY_MS;
}
