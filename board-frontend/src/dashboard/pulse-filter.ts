/**
 * The Unit page's per-member derivations (#461). Pressing a Crew card re-points
 * the whole page at that person, and every number it then states is computed
 * here — pure, no I/O, no React, so the correctness is unit-tested DOM-free the
 * way `filter-group.ts` and `controlled-filter.ts` already are.
 *
 * The inputs are data the page already holds: the untruncated org queue
 * (`/api/issues/all`) and the metrics payload. A member selection therefore
 * costs no new request.
 *
 * One seam stays and is named where it bites: an issue assigned to two people
 * counts for both. That is right for "what is on their plate", and it means
 * member totals can exceed the unit's.
 */
import type { IssueMetrics, PersonalIssue } from '../api/issues';

/**
 * The Unit page's org queue, as the three states its fetch actually has.
 *
 * `failed` is a state and not a synonym for `pending`: the page swallows that
 * fetch's rejection, so a block told only "no issues yet" would pulse for the
 * rest of the session. Everything downstream of the queue distinguishes the two.
 */
export type OrgSource =
  | { kind: 'pending' }
  | { kind: 'ready'; issues: readonly PersonalIssue[] }
  | { kind: 'failed' };

/**
 * Membership, matched case-SENSITIVELY — the one comparator `filter-group.ts`
 * uses for this dimension.
 *
 * It case-folded once, which meant a URL spelling a login differently from the
 * ingest (`?assignee=ivanroslov`) lit the tiles over a queue that matched
 * nothing: two comparators for one dimension, and the drift the tiles exist to
 * end. Spelling is corrected upstream instead, against the logins the data
 * actually carries (`crew-filter.ts`), so a token that reaches here and matches
 * nothing matches nothing in the queue below either.
 */
function assignedToAny(issue: PersonalIssue, logins: readonly string[]): boolean {
  const who = new Set(issue.assignees);
  return logins.some((l) => who.has(l));
}

/**
 * The open issues a selection holds, or the whole unit's when nothing is
 * selected — an empty selection means "no assignee filter", exactly as it does
 * in `filter-group.ts`.
 *
 * It returned a count in a one-field record (`bucketsFor(...).open`) and had
 * held four of them, because the Overview band drew four tiles off this one
 * call; #752 took the band off the page and left the flow strip's Issues tile
 * as the only reader. #816 gave that strip a second tile off the SAME
 * selection — the oldest of exactly these — and a count cannot answer which
 * issue that is. So the list is what this hands back, and the count is its
 * length: two tiles reading one filter cannot disagree about who is selected.
 */
export function selectedIssues(
  issues: readonly PersonalIssue[],
  logins: readonly string[],
): readonly PersonalIssue[] {
  return logins.length === 0 ? issues : issues.filter((i) => assignedToAny(i, logins));
}

/** A selection's weekly series and trailing counts, or the fact that board-api
 *  holds none for them. */
export type MemberThroughput =
  | { kind: 'unknown' }
  | { kind: 'known'; closed: number; opened: number; weeks: { opened: number; closed: number }[] | null };

/** A member selection's throughput: their trailing counts and their own 12-week
 *  series, summed when more than one card is pressed.
 *
 *  A selection nobody in `byMember` answers for is `unknown`, not two zeros. It
 *  is the same argument the `weeks: null` branch makes — a member board-api does
 *  not know about has no throughput to report, and "0 closed · 0 opened" under
 *  their name is a claim about them rather than about what we hold.
 *
 *  `weeks` is `null` rather than the org-wide series when the rows carry none —
 *  an org chart under one person's name is a lie, so the trend is absent
 *  instead. `byMember` is keyed case-sensitively server-side and by a different
 *  process from the queue's ingest, so one person can hold two rows (a roster
 *  spelling plus a Github one); they sum rather than race, which is why this one
 *  lookup folds case where the queue's does not. */
export function throughputFor(m: IssueMetrics, logins: readonly string[]): MemberThroughput {
  const wanted = new Set(logins.map((l) => l.toLowerCase()));
  const rows = (m.byMember ?? []).filter((r) => wanted.has(r.login.toLowerCase()));
  if (rows.length === 0) return { kind: 'unknown' };
  if (m.openedEvents && m.closeEvents && m.computedAt) {
    const now = Date.parse(m.computedAt);
    const week = 7 * 86400000;
    const selected = <T extends { htmlUrl: string; assignees: string[] }>(events: T[]) =>
      [...new Map(events.map(event => [event.htmlUrl, event])).values()]
        .filter(event => event.assignees.some(login => wanted.has(login.toLowerCase())));
    const opened = selected(m.openedEvents);
    const closed = selected(m.closeEvents);
    const weeks = m.weeks.map((_, index) => {
      const end = now - (m.weeks.length - 1 - index) * week;
      const start = end - week;
      return {
        opened: opened.filter(event => Date.parse(event.createdAt) >= start && Date.parse(event.createdAt) < end).length,
        closed: closed.filter(event => Date.parse(event.closedAt) >= start && Date.parse(event.closedAt) < end).length,
      };
    });
    const trailing = weeks.at(-1);
    if (trailing) return { kind: 'known', ...trailing, weeks };
  }
  const closed = rows.reduce((s, r) => s + r.closed, 0);
  const opened = rows.reduce((s, r) => s + r.opened, 0);

  const series = rows.map((r) => r.weeks).filter((w): w is { opened: number; closed: number }[] => w != null);
  if (series.length === 0) return { kind: 'known', closed, opened, weeks: null };
  const span = Math.max(...series.map((w) => w.length));
  // Align on the most recent week, so a short series (a member board-api has
  // fewer windows for) sums against the right end of a longer one.
  const weeks = Array.from({ length: span }, (_, i) =>
    series.reduce(
      (acc, w) => {
        const at = w[i - (span - w.length)];
        return at ? { opened: acc.opened + at.opened, closed: acc.closed + at.closed } : acc;
      },
      { opened: 0, closed: 0 },
    ));
  return { kind: 'known', closed, opened, weeks };
}

/** The selection's throughput, or `null` when there is no selection or no
 *  metrics to read — the shape `Pulse` memoizes and hands its Throughput card,
 *  kept here so the "unfiltered means untouched" branch is a tested fact. */
export function memberThroughput(
  m: IssueMetrics | null,
  logins: readonly string[],
): MemberThroughput | null {
  if (logins.length === 0 || !m) return null;
  return throughputFor(m, logins);
}
