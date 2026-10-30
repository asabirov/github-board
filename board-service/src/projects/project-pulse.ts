// The Projects rollup "pulse": each board's weekly close-rate (#391) and its
// two 14-day series, opened and closed (#663) — all three derived org-wide from
// the cached issues list joined to the board's issue-URL set. Pure — no I/O, no
// clock: the caller passes the issues, the memberships, and `now`. This is the
// SAME url ↔ closedAt join `computeProjectContributions` does per caller, but
// whole-org (ALL closes on the board, not just one person's), and the day series
// is that join at a finer divisor rather than a second source of truth.

import { deliveredCloseAt, type CloseReason } from '../issues-metrics/close-reason';

/** One rolling window's width for the day series — exported because the day
 *  figure is being built on two other surfaces (#660, #666) and one divisor is
 *  what keeps the three from disagreeing at a boundary. */
export const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Mini-trend width — 10 rolling 7-day windows, matching the personal
 *  throughput sparkline so the two surfaces read on the same cadence. */
export const PULSE_WEEKS = 10;

/** Day-series width — 14 rolling 24h windows (#663). Measured, not chosen: over
 *  70 days the daily series is 11/70, 15/70 and 7/70 non-zero on the three live
 *  boards, which is the flat chart #470 pulled; over 14 it is 6/14, 5/14 and
 *  2/14 closed. Two weeks is the widest window that still has something in it. */
export const PULSE_DAYS = 14;

/** Just the fields the join needs from a raw issue — typed inline so this stays
 *  free of the issues-metrics module's import (keeps `projects` acyclic). The
 *  `close-reason` import below is the one exception and costs nothing: that
 *  module imports NOTHING, so it cannot be the far end of a cycle (#1014). */
export interface PulseIssue {
  htmlUrl: string;
  closedAt: string | null;
  /** WHY it closed (#1014) — required, so a caller that cannot say cannot
   *  compile its way into counting an abandoned issue as throughput. `null` is
   *  a real answer here and counts as delivery; see `deliveredCloseAt`. */
  stateReason: CloseReason;
  /** When the issue was opened — the day series' second direction (#663).
   *
   *  OPTIONAL, unlike `closedAt`, because `weeklyClosedByProject` predates it
   *  and its callers pass rows that carry no open instant. An issue without one
   *  contributes to `closed` and never to `opened`, which is the honest reading:
   *  "we were not told when this opened", not "it opened today". */
  createdAt?: string;
}

/** A board and the issue URLs on it — the reverse index the join walks. */
export interface PulseMembership {
  number: number;
  issueUrls: string[];
}

/**
 * Which slot of a `slots`-long rolling series an instant falls in, or -1 when it
 * falls outside — in the future, or older than the whole window.
 *
 * The ONE piece of bucketing arithmetic on this surface, and it is exported so
 * the week series, the day series and the two other surfaces deriving a day
 * figure (#660, #666) cannot drift a slot apart at a boundary.
 *
 * Slot `s` spans [end-span, end) with end = now - (slots-1-s)*span, so the last
 * slot is the trailing window [now-span, now). `Math.ceil` on the age is what
 * makes that half-open interval match `computePersonalIssues`' `>= start, < end`
 * exactly: an instant exactly `span` old lands in the last slot, one a
 * millisecond older falls back one.
 */
export function pulseSlot(t: number, now: number, slots: number, spanMs: number): number {
  const age = now - t;
  if (age <= 0) return -1;
  const slot = slots - Math.ceil(age / spanMs);
  return slot >= 0 && slot < slots ? slot : -1;
}

/**
 * Closes per ISO week for every board, oldest → newest, last slot = the current
 * week [now-7d, now). Windows mirror `computePersonalIssues` exactly (>= start,
 * < end) so the two surfaces never disagree at a week boundary. Every membership
 * gets an entry: a board with no matched closes (or no issue URLs) is all zeros.
 * Counts ALL closes on the board regardless of assignee — the rollup is a
 * whole-unit signal, not a personal one — but only the ones that were DELIVERY
 * (#1014): an issue closed as not-planned or duplicate never lands in a bucket.
 */
export function weeklyClosedByProject(
  issues: PulseIssue[],
  memberships: PulseMembership[],
  nowIso: string,
  weeks = PULSE_WEEKS,
): Record<number, number[]> {
  const now = Date.parse(nowIso);

  // Index every close instant by its issue URL — the join key. Open issues,
  // unparseable timestamps and closes that are not delivery all drop out here,
  // which is why the per-board loop below needs no reason of its own.
  const closedAtByUrl = new Map<string, number>();
  for (const i of issues) {
    // `deliveredCloseAt`, not `closedAt` (#1014): an issue closed as not-planned
    // or duplicate was never throughput, and a board's close-rate is the first
    // place that showed as delivery.
    const closedAt = deliveredCloseAt(i);
    if (!closedAt) continue;
    const t = Date.parse(closedAt);
    if (!Number.isNaN(t)) closedAtByUrl.set(i.htmlUrl, t);
  }

  const out: Record<number, number[]> = {};
  for (const m of memberships) {
    const series = new Array<number>(weeks).fill(0);
    for (const url of m.issueUrls) {
      const t = closedAtByUrl.get(url);
      if (t == null) continue;
      const slot = pulseSlot(t, now, weeks, WEEK_MS);
      if (slot >= 0) series[slot]++;
    }
    out[m.number] = series;
  }
  return out;
}

/** One board's two day series, oldest → newest, both `days` long. */
export interface DailyPulse {
  /** Issues opened per day. */
  opened: number[];
  /** Issues closed per day, over the same buckets. */
  closed: number[];
}

/** Days of a week — the bridge between the two divisors above (#851).
 *
 *  The week series' last slot spans [now-7d, now) and the day series' last SEVEN
 *  slots span the same interval, because `readRollup` derives both from one
 *  `nowIso`. So this sum is the week's opens over exactly the window
 *  `closedThisWeek` counts its closes over, and the two figures on a card are a
 *  pair rather than two nearly-equal windows. `project-pulse.spec.ts` pins that
 *  by putting one issue a millisecond either side of the boundary and asserting
 *  the two series move together. */
export const WEEK_DAYS = 7;

/**
 * Opens in the trailing 7 days, from a board's day series (#851).
 *
 * Takes the SERIES rather than the issues: the join has already run by the time
 * anyone wants this, and a second walk over the issues would be a second answer
 * to a question `dailyByProject` has already answered. A series shorter than
 * `WEEK_DAYS` — the empty one a withheld board carries — sums what is there,
 * which is 0; callers withhold the figure rather than relying on that, and the
 * `[]` case never reaches a reader.
 */
export function openedThisWeekOf(opened: number[], days = WEEK_DAYS): number {
  return opened.slice(-days).reduce((a, b) => a + b, 0);
}

/**
 * Opens AND closes per DAY for every board, oldest → newest, last slot = the
 * trailing 24 hours [now-24h, now) (#663).
 *
 * The same url ↔ membership join `weeklyClosedByProject` does, at a finer
 * divisor and read in both directions: `closedAt` gives the closed series,
 * `createdAt` the opened one. Both go through `pulseSlot`, so a close on the day
 * boundary lands the same way it does in the week series.
 *
 * Every membership gets an entry; a board that matched nothing — no issue URLs,
 * or none of them in `issues` — is two arrays of zeros, and zero is served
 * rather than hidden behind a fallback. A quiet board is a fact about the board.
 *
 * An open-count LEVEL can be walked back from today's count by subtracting each
 * day's net, and whoever does that should know what it cannot see: a reopened
 * issue carries only its LATEST `closedAt`, so an earlier close-and-reopen is
 * invisible here, and an issue that moved between boards is counted under the
 * board it sits on TODAY for its whole history. Both errors are accepted; the
 * reconstruction is the frontend's and is deliberately not built here.
 */
export function dailyByProject(
  issues: PulseIssue[],
  memberships: PulseMembership[],
  nowIso: string,
  days = PULSE_DAYS,
): Record<number, DailyPulse> {
  const now = Date.parse(nowIso);

  // Index both instants by issue URL — the join key, as above. Unparseable and
  // missing timestamps drop out here rather than inside the per-board loop.
  const openedAtByUrl = new Map<string, number>();
  const closedAtByUrl = new Map<string, number>();
  for (const i of issues) {
    const opened = i.createdAt ? Date.parse(i.createdAt) : NaN;
    if (!Number.isNaN(opened)) openedAtByUrl.set(i.htmlUrl, opened);
    // The same delivery gate the week series applies (#1014), so the two
    // divisors cannot disagree about whether a close happened at all. Note the
    // OPENED side is untouched: an issue later abandoned was still opened, and
    // dropping it from `opened` would make the pair's arithmetic a lie.
    const closedAt = deliveredCloseAt(i);
    if (!closedAt) continue;
    const closed = Date.parse(closedAt);
    if (!Number.isNaN(closed)) closedAtByUrl.set(i.htmlUrl, closed);
  }

  const out: Record<number, DailyPulse> = {};
  for (const m of memberships) {
    const opened = new Array<number>(days).fill(0);
    const closed = new Array<number>(days).fill(0);
    for (const url of m.issueUrls) {
      const o = openedAtByUrl.get(url);
      if (o != null) {
        const slot = pulseSlot(o, now, days, DAY_MS);
        if (slot >= 0) opened[slot]++;
      }
      const c = closedAtByUrl.get(url);
      if (c != null) {
        const slot = pulseSlot(c, now, days, DAY_MS);
        if (slot >= 0) closed[slot]++;
      }
    }
    out[m.number] = { opened, closed };
  }
  return out;
}
