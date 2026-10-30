// Calendar-day arithmetic (#666, #684, #817). Nothing here knows what an issue
// is: the span, the index and the counter are the shared x-axis that a
// releases-per-day count, a closed-per-day series and anything else drawn
// day-by-day all read from. Kept out of issues-metrics because three tiles drawn
// side by side must share ONE span — two constants would be two x-axes drawn as
// though they were one, and no legend recovers that. The second span here is the
// exception that proves it: `historySpan` is data-derived and deliberately not
// the tiles', and DAY_SPAN's docblock says so where a reader will meet it.

const DAY_MS = 86_400_000;

/**
 * 98 days = 14 whole weeks. The series ENDS on the calendar day `now` falls in,
 * because the tiles above the grid read "yesterday" and "since yesterday" off
 * its tail. 98 = 91 + 7 so a week-aligned 91 can always be sliced out of the
 * tail whatever weekday today is, 7 spare days being the widest the current
 * partial week can be.
 *
 * Since #817 this is the SPARKS' span and only theirs. The three tiles are drawn
 * side by side at roughly 330px each, so a year of columns would be a year of
 * 1px ones — this span stays where it is, and every tile drawn beside another
 * still shares its x-axis. The closed-per-day grid used to be sliced out of the
 * same tail and now runs off `historySpan` below, back to the first close there
 * has ever been. Two axes on one strip, said out loud here and named apart in
 * the payload (`days` against `closedDays`), rather than two constants that read
 * as one.
 */
export const DAY_SPAN = 98;

/**
 * The cap on the closed-history window: 3 * 366 days. Uncapped, the series grows
 * by one number a day forever — on every metrics response and again on every
 * per-member row inside it. Three whole years is more than the one year the grid
 * draws and enough to switch back through.
 */
export const HISTORY_MAX_DAYS = 1098;

/**
 * How many UTC calendar days the closed-history window covers, ending on the day
 * `now` falls in, inclusive. It reaches back to the day of the FIRST close in
 * scope — clamped into `[DAY_SPAN, HISTORY_MAX_DAYS]`, and the floor is not
 * cosmetic.
 *
 * The reach is what the window exists for. A window padded back to a round
 * number hands a grid leading zeroes it cannot tell from quiet days — months
 * nobody was watching, drawn as months in which nobody closed anything. So the
 * LENGTH of a series counted over this span is what says how far back it
 * reaches; no date travels beside it to disagree with it.
 *
 * THE FLOOR IS EXACTLY THAT PADDING, AND IT IS THE PRICE OF ONE SPAN. Where a
 * scope's first close is younger than DAY_SPAN — a new org, a repo added this
 * month — the window is 98 days regardless, and the days before that first
 * close come back as counted zeroes rather than as nothing. A grid drawn from
 * them says "nothing closed" about days nobody watched, which is the one thing
 * the paragraph above refuses. It is bounded: at most 97 days, only on a scope
 * younger than fourteen weeks, and never on either org this board serves, whose
 * first close is 2026-03-08. The alternative was letting the history run shorter
 * than the sparks beside it, and a grid that cannot cover its own strip is worse
 * than 97 zeroes on a two-week-old org.
 *
 * `null` — nothing has ever been closed in scope — answers DAY_SPAN. So does a
 * close dated in the future, which is clock skew rather than history.
 */
export function historySpan(earliestClosedMs: number | null, now: number, timeZone = 'UTC'): number {
  if (earliestClosedMs == null || Number.isNaN(earliestClosedMs)) return DAY_SPAN;
  const days = calendarDay(now, timeZone) - calendarDay(earliestClosedMs, timeZone) + 1;
  return Math.min(HISTORY_MAX_DAYS, Math.max(DAY_SPAN, days));
}

/**
 * Which bucket `iso` falls in — 0 is the oldest day of the span, `span - 1` is
 * the calendar day `now` falls in — or null when it is outside the span.
 *
 * Days follow the requested IANA zone; callers without a zone retain UTC.
 */
export function dayIndex(iso: string | null | undefined, now: number, span: number = DAY_SPAN, timeZone = 'UTC'): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  // Out-of-span timestamps contribute nothing, rather than piling into bucket 0.
  const i = span - 1 - (calendarDay(now, timeZone) - calendarDay(t, timeZone));
  return i >= 0 && i < span ? i : null;
}

/** Every day of the span at 0 — a grid with holes in it is not a grid. */
export function zeroDays(span: number = DAY_SPAN): number[] {
  return Array.from({ length: span }, () => 0);
}

/**
 * One integer per calendar day, oldest → newest: how many of `items` carry a
 * timestamp (via `at`) falling on that day. `at` returning null/undefined, or a
 * date outside the span, contributes nothing — see `dayIndex`.
 */
export function countByDay<T>(
  items: readonly T[],
  at: (item: T) => string | null | undefined,
  now: number,
  span: number = DAY_SPAN,
  timeZone = 'UTC',
): number[] {
  const days = zeroDays(span);
  for (const item of items) {
    const d = dayIndex(at(item), now, span, timeZone);
    if (d != null) days[d]++;
  }
  return days;
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** Calendar date as an integer, independent of 23/25-hour daylight-saving days. */
export function calendarDay(at: number, timeZone = 'UTC'): number {
  if (!Number.isFinite(at)) return NaN;
  if (timeZone === 'UTC') return Math.floor(at / DAY_MS);
  let format = dayFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    if (dayFormats.size >= 32) dayFormats.clear();
    dayFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(at);
  const part = (name: string) => Number(parts.find(p => p.type === name)!.value);
  return Date.UTC(part('year'), part('month') - 1, part('day')) / DAY_MS;
}
