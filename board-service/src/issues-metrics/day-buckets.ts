// Issue-shaped wrappers over the calendar-day primitive in ../time/day-span —
// the day-resolution twin of the rolling 7-day windows in issues-metrics.vm.ts
// / personal-issues.vm.ts. A rolling window anchored on the current clock time
// cannot answer "which DAY did this close on", which is the question a
// Github-style grid asks. Pure: the caller passes `now`. The span, the index
// and the counting all live in day-span.ts, which knows nothing about issues.

import { DAY_SPAN, countByDay } from '../time/day-span';
import { deliveredCloseAt, type CloseReason } from './close-reason';
import { DaySeries } from './issues-metrics.types';

/** The fields both functions here need off an issue: when it opened, when it
 *  closed, and whether that close was delivery (#1014). Structural rather than
 *  `RawIssue`, as it always was — these count anything issue-shaped. */
type Counted = { createdAt: string; closedAt: string | null; stateReason: CloseReason };

/** Opened/closed per calendar day for one set of issues, oldest → newest. Two
 *  arrays rather than an array of pairs: measured over a DAY_SPAN series, 2,353
 *  bytes of JSON against 415, which the per-member roster pays 20-60 times over
 *  on every metrics response. */
export function seriesByDay(
  items: readonly Counted[],
  now: number,
  span: number = DAY_SPAN,
  timeZone = 'UTC',
): DaySeries {
  return {
    opened: countByDay(items, (i) => i.createdAt, now, span, timeZone),
    // `deliveredCloseAt` and not `closedAt` (#1014): an issue abandoned as not
    // planned has a close instant and is not delivery, and `countByDay` skips a
    // null the same way it skips an open row. The OPENED series is untouched —
    // an issue that was opened was opened, whatever became of it later.
    closed: countByDay(items, deliveredCloseAt, now, span, timeZone),
    // And EVERY exit beside it, which is a different question and the one the
    // queue-depth walk asks: an abandoned issue stopped being open even though
    // it never shipped.
    exited: countByDay(items, (i) => i.closedAt, now, span, timeZone),
  };
}

/**
 * When the earliest close in a set happened, in ms, or null if nothing in it has
 * ever closed — the one input `historySpan` needs to size the closed-history
 * window.
 *
 * Whichever set the caller hands it: the filtered issue set the rest of a vm
 * counts, never the unfiltered one it was sliced out of, or a narrowed board
 * would be given the org's window and drawn as quiet for months it never saw.
 */
export function earliestClosedMs(items: readonly Pick<Counted, 'closedAt'>[]): number | null {
  let earliest: number | null = null;
  for (const i of items) {
    // ANY close, INCLUDING one that was not delivery (#1014). This asks how far
    // back the board was watching, and the mirror holds every issue whatever
    // became of it — so a day between an abandoned first close and the first
    // delivered one has a real reading, and that reading is zero. Sized off the
    // first DELIVERED close instead, a scope whose earliest close was abandoned
    // has its grid clipped to the floor and every month in between drawn as
    // nothing at all, which says nobody was counting about days somebody was.
    // The window is the reach; `closedDays` is what is counted inside it.
    if (!i.closedAt) continue;
    const t = Date.parse(i.closedAt);
    if (Number.isNaN(t)) continue;
    if (earliest == null || t < earliest) earliest = t;
  }
  return earliest;
}
