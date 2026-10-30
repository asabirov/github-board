/**
 * How old an issue is, and what that age is allowed to look like (#822).
 *
 * The two thresholds — amber at 60 days, red at 90 — were `IssueListRow`'s
 * private arithmetic until the issues list started ranking by age too. They live
 * here so there is one answer to "when is an issue old", rather than two
 * surfaces that both paint a warning and disagree about when it starts.
 *
 * The resting class is the CALLER's, because the two surfaces genuinely rest at
 * different depths: the "Oldest open" block sits its cold rows at
 * `text-dim`, the issues list at `text-muted`, and moving
 * either to match the other would restyle a row this module has no business
 * restyling. Only the two warm steps are shared, because only those two carry
 * meaning.
 */

const DAY = 86_400_000;

/** Whole days between an ISO instant and `now`, or `null` when the source has no
 *  usable date — which the label and the class below both read as "say nothing"
 *  rather than as "brand new". A future date clamps at 0.
 *
 *  It ROUNDS because board-api rounds: `personal-issues.vm.ts` and
 *  `issues-metrics.vm.ts` both derive their `ageDays` as
 *  `Math.round((now - createdAt) / DAY)`, and on `/team` the "Oldest open" block
 *  draws that number directly above a list drawing this one. Flooring here made
 *  the two answer the same question differently for twelve hours out of every
 *  twenty-four, on one screen — so this is not a shared threshold, it is shared
 *  arithmetic, and only the second makes the two blocks agree. */
export function ageDaysSince(iso: string | undefined, now: number = Date.now()): number | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((now - t) / DAY));
}

/** One format down the whole column: whole days with a `d`. A column that reads
 *  `1d / 9d / 44d` compares at a glance, which a mixture of `yesterday`, `6d ago`
 *  and `20 Jul` cannot. */
export function ageLabel(days: number | null): string {
  return days === null ? '—' : `${days}d`;
}

/** Age carries the only colour on a row, and only once the issue is genuinely
 *  old. `resting` is what a young one gets. */
export function ageToneClass(days: number | null, resting: string): string {
  if (days === null) return resting;
  if (days >= 90) return 'text-danger';
  if (days >= 60) return 'text-warn';
  return resting;
}
