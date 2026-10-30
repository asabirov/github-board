import { calendarDate } from './calendar-day';
/**
 * The cockpit flow strip (#666, #684) — Issues · Throughput · Releases over a
 * week-aligned closed-per-day grid, derived once for both surfaces.
 *
 * Pure: no React, no fetch, no URL, no clock of its own. Everything that decides
 * what a tile says lives here, so Your work and Overview cannot hold two ideas
 * of who is selected or of what "we have nothing" means.
 *
 * Absent, empty and zero are three states and never collapse into one. No field
 * → `null`. An empty array → `null`, because a series board-api sent with no
 * days in it is not a run of quiet days. A counted zero → the zero, because a
 * day on which nobody closed anything is a fact. The board already holds this
 * line: `throughputFor` answers `kind: 'unknown'` rather than two zeros, and
 * `MINE_UNAVAILABLE` leaves `updatedAt` blank rather than stamping a lie.
 *
 * The year-long grid (#817) added a fourth: UNOBSERVED, a day older than the
 * series board-api sent. The first close in either org is 2026-03-08, so about
 * half of a 52-week grid is months nobody watched, and painting them as zeros
 * would report a year of quiet that never happened. It is `null` inside a drawn
 * column, and `DayGrid` draws it as nothing at all.
 */
import type { DeliveryView } from '../api/delivery';
import type { IssueMetrics, PersonalIssue, PersonalIssues } from '../api/issues';
import type { OrgSource } from '../dashboard/pulse-filter';
import { selectedIssues } from '../dashboard/pulse-filter';

/** Whole weeks the grid draws — 52 × 7 = 364, a year, the way GitHub's
 *  contribution graph is a year (#817). It was 13 until then, which is what the
 *  98-day payload could fill; the window is longer than the payload now, and
 *  the days it cannot reach are drawn as nothing rather than as zeros. */
const GRID_WEEKS = 52;
/** Two months on the tile sparks (#873). The grid keeps its own full history;
 *  each spark keeps the endpoint of its figure: today for Issues, yesterday
 *  for Closed. */
export const SPARK_DAYS = 60;
/** The row length `weekAlignedGrid` slices to, and the one the grid draws and
 *  the strip counts columns by — one definition, three readers. */
export const DAYS_PER_WEEK = 7;

/**
 * Who the strip is about, as the two genuinely different questions the two
 * surfaces ask.
 *
 * Not one normalised series with a login attached. The surfaces differ in what
 * "we hold nothing" means and in which double-counting applies, and a normalised
 * boundary pushes both decisions back out to the call sites — the thing this
 * file exists to prevent.
 *
 * The union is load-bearing in one specific direction: Dashboard cannot
 * synthesise `logins: [mine.login]` and take the `org` branch, because that
 * branch demands an `IssueMetrics` and an `OrgSource` Your work never fetches.
 * If it could, the same person would read differently on the two pages —
 * `byMember` is roster-seeded and gated on trailing-7-day activity, `mine` is
 * neither — and nothing would flag the disagreement.
 */
export type Scope =
  | { kind: 'me'; mine: PersonalIssues | null; error: string | null }
  | { kind: 'org'; metrics: IssueMetrics | null; org: OrgSource; logins: readonly string[]; owner?: string | null };

/** One tile: the number it states and the series behind it, independently
 *  nullable — a level can be known with no series to draw, and a series can be
 *  held with no level to anchor it.
 *
 *  No delta. #707 took the change-against-the-previous-day off all three tiles,
 *  and a derivation nothing renders is a second definition of yesterday waiting
 *  to drift from `tail`'s. */
export interface TileModel {
  n: number | null;
  /** The days the spark draws, ending on the day `n` is for — `sparkDays`' cut,
   *  made once here because both spark kinds and all three tiles read this one
   *  field. */
  series: number[] | null;
  /** UTC midnight of the LAST day the spark draws, so a point can say WHICH day
   *  it is (#708). Set beside the series and never apart from it: `sparkDays`
   *  answers both, so a tile cannot hold days without a calendar for them or a
   *  calendar with no days under it.
   *
   *  It is the same field the grid carries (`GridView.endsOn`) and the same
   *  arithmetic dates a point off it, which is what stops the two halves of the
   *  strip dating the same day differently. */
  endsOn: number | null;
}

export interface StripModel {
  issues: TileModel;
  throughput: TileModel;
  /** Releases are org-wide whoever is selected, so the tile names the orgs it
   *  counted — `/api/delivery` counts every one of `GITHUB_ORGS` and names them
   *  all, already joined into prose (#697) — and says when its release list was
   *  truncated rather than reading as a quiet week. */
  releases: TileModel & { scope: string | null; partial: boolean };
  /** The default view: 52 whole weeks of 7, oldest first and Monday first
   *  within a week, plus the running week through today as the last
   *  column — with the scale the cells are coloured by. */
  grid: GridView | null;
  /** Every day the closes reach, so the year switcher can cut a different
   *  window out of the same history without a second request. */
  window: DayWindow | null;
  /** The oldest still-open issue this scope holds, or the reason there is none
   *  to name (#816). The third tile states its AGE, so the thing it states is a
   *  property of one issue and not a count over many, which is why this rides
   *  as a record rather than as a fourth `TileModel`. */
  oldest: OldestView;
  /** The calendar years the history holds a CLOSE in, newest first.
   *
   *  Fewer than two of them and there is no switcher: one year of history is
   *  one view, and a control offering the year you are already looking at is
   *  furniture. That is what the board shows until January 2027 — the first
   *  close in either org is 2026-03-08 — and it is the expected state, not a
   *  fault. */
  years: number[];
}

/** `closed` is DELIVERED work; `exited` is everything that left the open queue,
 *  delivered or abandoned (#1014). The depth walk is the only reader of the
 *  second, and it is the only figure on this strip that wants it. Optional
 *  across the deploy window, and its absence is what makes the walk refuse. */
type DaySeries = { opened: number[]; closed: number[]; exited?: number[] };

/**
 * Open issues at the end of each day, reconstructed by walking back from the
 * count held now: `depth[i - 1] = depth[i] - opened[i] + exited[i]`.
 *
 * TWO ERRORS THIS ACCEPTS, both consequences of reconstructing from the mirror
 * instead of the daily snapshot table this design turned down, neither removable
 * without it:
 *
 * 1. Reattribution. The walk reads assignment as it stands TODAY for the whole
 *    window, so an issue that changed hands reads as the current assignee's from
 *    the first day of the span.
 * 2. Reopening. GitHub keeps only the latest `closedAt` and nulls it on reopen.
 *    A close that was later reopened is invisible, and the reopen that raised the
 *    queue is never counted. The two land on different days and do not cancel.
 *
 * The walk arithmetic runs unclamped and only the OUTPUT is floored at 0, so a
 * dip below zero does not drag every earlier day down with it — a queue cannot
 * have held a negative number of issues, but the days above the dip are still
 * the best figure available.
 *
 * `openNow` is a COUNT, not a timestamp. Returns `[]` when the two series
 * disagree on length: there is no honest alignment for that and a shorter answer
 * would be silently misdated.
 *
 * THE SECOND SERIES IS `exited`, NOT `closed`, AND THAT IS LOAD-BEARING (#1014).
 * The identity holds against every issue that stopped being open; `closed`
 * counts only the ones that shipped. Handed the delivered series, an issue
 * abandoned as not-planned leaves the queue and is never added back, so every
 * day to the left of it is drawn one too low and the error compounds across the
 * window rather than cancelling. `openNow` is a live count of open rows and
 * excludes abandoned issues already, so the two inputs have to agree about what
 * leaving means. This was the shape of the bug for the fortnight #1014 was in
 * review, which is why the parameter is named for the question and not for the
 * field it used to come from.
 */
export function dailyDepth(openNow: number, opened: number[], exited: number[]): number[] {
  if (opened.length !== exited.length || opened.length === 0) return [];
  const raw = new Array<number>(opened.length);
  let level = openNow;
  for (let i = opened.length - 1; i >= 0; i--) {
    raw[i] = level;
    level = level - opened[i]! + exited[i]!;
  }
  return raw.map((v) => Math.max(0, v));
}

/**
 * One drawn day: what closed, or `null` for a day the grid reaches and the
 * series does not. See the fourth state in this file's opening block.
 */
export type DayCount = number | null;

/**
 * The closes the grid is cut from: one entry per UTC calendar day, oldest
 * first, the LAST entry being today's.
 *
 * There is no start date on it. The length is what says how far back it
 * reaches, and a date stored beside the array is a second definition of the
 * same day waiting to disagree with it — the rule every other series on this
 * strip already follows, since `sparkDay` dates a bare `number[]` by counting
 * back from its last day.
 */
export interface DayWindow {
  days: number[];
  /** UTC midnight of the day the last entry is for. */
  today: number;
}

/** UTC midnight of the Monday on or before `t`. Every column starts on one. */
function mondayOf(t: number): number {
  const day = Math.floor(t / DAY_MS) * DAY_MS;
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
}

/** What the series holds for a UTC day — `null` for one it does not reach,
 *  which is every day before its first and today's own successors. */
function dayAt(w: DayWindow, t: number): DayCount {
  return w.days[w.days.length - 1 - (w.today - t) / DAY_MS] ?? null;
}

/**
 * The columns from `first` to `last` inclusive: Monday-first weeks, oldest
 * column first, the last column SHORT wherever `last` is not a Sunday.
 *
 * WRITTEN IN DATES, NOT IN OFFSETS INTO THE SERIES, and that is what lets the
 * year switcher exist. The rule used to be a slice — `[end - 91, end)` counted
 * back from today — which can only ever express a trailing window; a calendar
 * year does not start where the last 364 days start. Both views ask this one
 * function now, because two copies of which-days-the-grid-draws is how the row
 * labels came to be true one day in seven.
 *
 * A cell is `null` for two different absences, and neither is a zero: a day at
 * the head of the first column that falls before `first` (1 January, for a year
 * view), and a day the series does not reach at all.
 *
 * The rows stay Monday-first whatever the weekday, so the row labels and the
 * weekend stripe hold: a short column is the head of a week, not a window
 * rotated into the rows. Calendar dates use UTC midnight as a date-only
 * coordinate after the snapshot is converted to its viewer timezone.
 */
function columnsFor(w: DayWindow, first: number, last: number): DayCount[][] {
  const weeks: DayCount[][] = [];
  for (let c = mondayOf(first); c <= last; c += DAYS_PER_WEEK * DAY_MS) {
    const col: DayCount[] = [];
    for (let r = 0; r < DAYS_PER_WEEK; r++) {
      const t = c + r * DAY_MS;
      if (t > last) break;
      col.push(t < first ? null : dayAt(w, t));
    }
    weeks.push(col);
  }
  return weeks;
}

/** The trailing year: 52 whole weeks plus the running week through today.
 *  Days before the available history remain null. */
export function weekAlignedGrid(series: number[], todayUtc: number): DayCount[][] {
  const w = { days: series, today: Math.floor(todayUtc / DAY_MS) * DAY_MS };
  const { first, last } = trailingSpan(w);
  return columnsFor(w, first, last);
}

/** The first and last day of the default view, in ONE place. It was written out
 *  twice — once for the columns and once for the grid — and this file argues at
 *  `columnsFor` that two copies of which-days-the-grid-draws is how the row
 *  labels came to be true one day in seven. The two copies were
 *  character-identical, which is what a drift starts as. */
function trailingSpan(w: DayWindow): { first: number; last: number } {
  return {
    first: mondayOf(w.today) - GRID_WEEKS * DAYS_PER_WEEK * DAY_MS,
    last: w.today,
  };
}

/**
 * The settled days a blue is read against: every drawn day that closed
 * something, ascending.
 *
 * ZEROS ARE NOT IN IT, and that is not the same decision as leaving them out of
 * a quantile. A day that closed nothing keeps `ZERO_CELL` — the page surface
 * with its hairline — and never enters the ramp at all, so it has no position on
 * it to hold. A day the series never reached is not in it either, and for a
 * different reason: it is not a reading, so there is nothing to place.
 */
export interface ShadeScale {
  nonZeroAscending: number[];
}

/** The scale for one grid, cut over the SETTLED days only — never the running
 *  week, whose counts move every night, and never a day the grid does not draw.
 *  Within a week, a cell cannot change shade overnight without its count
 *  changing. At the Monday cutover, the former running week becomes settled
 *  and the maximum is recomputed, so unchanged counts can receive a new shade. */
export function shadeScale(settled: DayCount[]): ShadeScale {
  return {
    nonZeroAscending: settled.filter((n): n is number => n !== null && n > 0).sort((a, b) => a - b),
  };
}

/**
 * Brand fill as a percentage of the settled maximum (#1293). A linear ramp
 * lets small counts fade into the surface instead of starting at 43% blue.
 * Running-week counts above that maximum clamp to full fill. If the settled
 * window is empty, any positive count is the only activity and takes full fill.
 */
export function mixPercent(n: number, scale: ShadeScale): number {
  if (n <= 0) return 0;
  const max = scale.nonZeroAscending.at(-1);
  if (max === undefined || n >= max) return 100;
  return Math.round(100 * n / max);
}

/** A series board-api did not send, or sent empty, is nothing to draw. */
function present(xs: number[] | undefined): number[] | null {
  return xs && xs.length > 0 ? xs : null;
}

function days(s: DaySeries | undefined): DaySeries | null {
  if (!s || s.opened.length === 0 || s.closed.length === 0) return null;
  return s;
}

/** Yesterday's value for the tile: today's count is still in progress. */
function tail(series: number[] | null): { n: number | null } {
  if (!series || series.length < 2) return { n: null };
  return { n: series[series.length - 2]! };
}

/**
 * Which day a tile's figure is for, and so which day its spark ends on.
 *
 * A COUNT of events in a day is partial until the day is over: `tail` states
 * yesterday for that reason. A LEVEL is complete at every instant — there is no
 * partial about how many issues are open right now — so the figure is today's and nothing is
 * withheld.
 */
type FigureDay = 'today' | 'yesterday';

/**
 * The days a spark draws: through the day its own tile's figure is for (#734).
 *
 * ONE RULE, TWO ANSWERS, and the two answers are the point. Every spark used to
 * draw the whole series, so the rightmost bar under the Closed tile was
 * today's partial count sitting under a figure that was yesterday's — just after
 * UTC midnight it is near zero and the tile reads as a collapse that has not
 * happened. Cutting every series to yesterday fixes that and breaks the other
 * end: `dailyDepth` walks back FROM the level held now, so the last point of the
 * depth series is exactly the number "Issues open" states, and dropping it
 * leaves the line stopping a day short of its own figure.
 *
 * So the rule is not "stop at yesterday". It is "end where the figure is", which
 * `FigureDay` above answers per tile — and it is still one definition in one
 * place, applied where the tiles are built rather than in a spark component or a
 * `mark` prop. If you find the Issues spark ending a day later than the Closed
 * one, that is this rule holding, not drifting.
 *
 * IT IS ALSO WHAT MAKES A FIGURE DATABLE AT ALL SINCE #821, which took the day
 * off the second tile's caption. The last point of a spark is that tile's own
 * figure, on that tile's own day, because of this rule — so the sentence a
 * pointer gets there is the answer to "which day is this?" and not merely a
 * reading of some day near it.
 *
 * SIXTY DAYS IS THE CEILING (#873), and it is a tail. A shorter series draws
 * what it has; a longer one draws its last 60. `endsOn` does not move, because
 * a tail keeps the last day, so nothing downstream that dates a point has to
 * know this window exists — `sparkDay` counts back from `endsOn` by the length
 * it is given, and the length it is given is now 60.
 *
 * TWO DAYS IS THE FLOOR, matching `tail`'s: one point is a dot and a lone
 * `ColumnSpark` bar is full-height whatever it counts, so neither is a shape a
 * reader can take anything from. A tile left with fewer than two days holds no
 * series and draws its "No daily history" line, while the figure it states — one
 * day, honestly counted — stands.
 *
 * IT ALSO ANSWERS THE DATE (#708), because it is the one place that knows which
 * day the series ends on. A spark that can be pointed at has to say which day a
 * point is, and the days arrive as a bare `number[]` carrying no calendar; the
 * answer is `endsOn`, and it is returned here rather than derived again beside
 * the tile so that the day a spark ENDS on and the day it is DATED to cannot
 * become two different rules.
 */
function sparkDays(
  series: number[] | null,
  figureFor: FigureDay,
  now: number,
): { series: number[] | null; endsOn: number | null } {
  const nothing = { series: null, endsOn: null };
  if (series === null) return nothing;
  const ends = figureFor === 'yesterday' ? series.slice(0, -1) : series;
  if (ends.length < 2) return nothing;
  // The window is a TAIL, and it is taken after the figure-day trim rather than
  // before it. Both orderings give 60 points; only this one keeps the last one
  // being the day the tile's own figure is for, which is the rule the whole
  // docstring above is about.
  const drawn = ends.slice(-SPARK_DAYS);
  // Counted off UTC midnight the way the grid's own window is, so the grid's
  // last cell and a count spark's last column are the same day on the same
  // clock.
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return { series: drawn, endsOn: figureFor === 'yesterday' ? today - DAY_MS : today };
}

/**
 * The rows added day by day, or `null` where they do not describe the same days.
 *
 * ROWS OF DIFFERENT LENGTHS ARE REFUSED, not right-aligned and head-padded. The
 * padding read `?? 0` for a day the shorter row does not reach, which turns a day
 * nobody observed into a day on which nothing closed — the collapse of the fourth
 * state this file's opening block exists to prevent, and here it would be
 * invisible: the sum has no `null` to carry, so the grid would paint a zero cell
 * with a sentence under it.
 *
 * Nothing reaches it today. board-api sizes every `closedDays` in a payload off
 * one `closedSpan` and every `days` off `DAY_SPAN`, so the rows of one response
 * are the same length by construction. That is a fact about the writer, held
 * nowhere on this side, which is what makes it worth a guard rather than a
 * comment: a shorter row is a disagreement about which days these are, and
 * `dailyDepth` already answers a disagreement with nothing rather than with a
 * number.
 */
function sumSeries(rows: number[][]): number[] | null {
  const span = rows[0]?.length ?? 0;
  if (span === 0 || rows.some((r) => r.length !== span)) return null;
  return Array.from({ length: span }, (_, i) => rows.reduce((acc, r) => acc + r[i]!, 0));
}

/** The org-scope series for a selection: the org-wide ones when nothing is
 *  selected, otherwise the matching `byMember` rows summed.
 *
 *  A selection no row answers for is `null`, not zeros — `throughputFor`'s rule.
 *  Logins fold case here, and only here, because `byMember` is keyed
 *  case-sensitively by a different process from the queue's ingest, so one
 *  person can hold two rows; they sum rather than race.
 *
 *  `matched` is that folding made visible to the caller: the queue matches the
 *  same logins case-SENSITIVELY, so the two halves can answer about different
 *  people, and only this side knows it looked one up under a different rule. */
function orgSeries(
  m: IssueMetrics,
  logins: readonly string[],
): { days: DaySeries | null; closedDays: number[] | null; matched: boolean } {
  if (logins.length === 0) return { days: days(m.days), closedDays: present(m.closedDays), matched: false };
  const wanted = new Set(logins.map((l) => l.toLowerCase()));
  const rows = (m.byMember ?? []).filter((r) => wanted.has(r.login.toLowerCase()));
  if (rows.length === 0) return { days: null, closedDays: null, matched: false };

  // EVERY SELECTED ROW OR NONE, and for the same reason the grid's own rule
  // below gives. This used to keep whichever rows carried a `days` pair and sum
  // those, so a selection holding one row without one drew the THROUGHPUT tile
  // and its spark for a subset of the people pressed, with nothing on screen
  // naming who was left out — a figure quietly about fewer people than the
  // reader selected is worse than the tile refusing. `null` is what the tile's
  // no-figure state is drawn from, and it says so.
  const withDays = rows.map((r) => days(r.days)).filter((d): d is DaySeries => d !== null);
  const complete = withDays.length === rows.length;
  const opened = complete ? sumSeries(withDays.map((d) => d.opened)) : null;
  const closed = complete ? sumSeries(withDays.map((d) => d.closed)) : null;
  // `exited` sums on the same all-rows-or-none rule (#1014), and independently:
  // a mixed rollout can leave some rows carrying it and some not, and a partial
  // sum here would walk the depth line against fewer people than the level it
  // starts from. Absent, the walk refuses rather than falling back to `closed`,
  // which is the series that made the line wrong in the first place.
  const withExits = withDays.map((d) => present(d.exited)).filter((e): e is number[] => e !== null);
  const exited = complete && withExits.length === rows.length ? sumSeries(withExits) ?? undefined : undefined;
  const summed = opened === null || closed === null ? null : { opened, closed, exited };

  // EVERY SELECTED ROW OR NONE OF THEM. `closedDays` is optional across the
  // deploy window — board-web ships before board-api — so a mixed rollout, or a
  // board-api that predates the field, leaves some rows carrying it and some
  // not. Summing whichever rows have it draws the grid for a SUBSET of the
  // selection beside a Throughput tile counting all of it, with nothing on
  // screen saying which people the lattice left out. `null` hands the grid to
  // the 98-day fallback below, which is cut from the same rows either way: one
  // reading for everyone selected, or the older one for everyone selected.
  const withClosed = rows.map((r) => present(r.closedDays)).filter((d): d is number[] => d !== null);
  const closedDays = withClosed.length === rows.length ? sumSeries(withClosed) : null;

  return { days: summed, closedDays, matched: true };
}

/**
 * The whole strip for one scope.
 *
 * `now` is a clock, passed in rather than read, so the derivation is testable
 * across a UTC midnight the way the service-side bucketing is.
 *
 * AND THE PAYLOAD'S OWN CLOCK BEATS IT WHEREVER THERE IS ONE (#1015). The
 * caller reads `Date.now()`; the series were bucketed against whatever `now`
 * board-api held when it counted them, and the two are not the same instant.
 * Both surfaces cache — `/api/issues/mine` and `/api/issues/all` sit in
 * `localStorage` for up to `PAYLOAD_MAX_AGE_MS`, and Your work keeps its cached
 * queue ON SCREEN when the live read fails — so the gap is routinely a day and
 * can be two, or unbounded through a Github quota cooldown. Dated off the
 * reader, a day-old payload draws yesterday's closes on today's cell and labels
 * them today: not a shade off, a whole grid shifted, saying a day nobody has
 * finished yet is already counted.
 *
 * The org branch has done this since `computedAt` was added; the `me` branch
 * could not, because `PersonalIssues` carried no stamp to do it with, and the
 * asymmetry was invisible — the two branches only disagree once a payload
 * outlives the UTC day it was built in. Both stamps are read here, in one line,
 * so a third scope cannot be added that quietly dates itself off the reader.
 *
 * An unparseable or absent stamp keeps the caller's clock rather than poisoning
 * every date with `NaN`. Absent is the honest case, not a fault: a board-api
 * predating the field, and `MINE_UNAVAILABLE`, which stamps no freshness
 * because a failed fetch knows none — and carries no series to misdate either.
 */
export function stripModel(scope: Scope, delivery: DeliveryView | null, now: number): StripModel {
  const computedAt = scope.kind === 'org' ? scope.metrics?.computedAt : scope.mine?.computedAt;
  const stamped = computedAt ? Date.parse(computedAt) : NaN;
  if (!Number.isNaN(stamped)) now = stamped;
  const timeZone = (scope.kind === 'org' ? scope.metrics?.timeZone : scope.mine?.timeZone) ?? 'UTC';
  const day = calendarDate(now, timeZone);
  const src = scope.kind === 'me' ? mineSource(scope) : orgSource(scope);

  const closed = present(src.days?.closed);
  // The grid is cut from the WHOLE series, today included: the column rule
  // counts back from today to find the running week's Monday, so handing it a
  // series that already stops at yesterday moves every column a day.
  //
  // `closedDays` is the long history board-api sends for the grid alone; the
  // 98-day `closed` is the fallback for a board-api that predates it, and the
  // grid is the same shape either way — one simply reaches back further, and
  // the days neither reaches draw as nothing.
  const window = closedWindow(src.closedDays ?? closed, day);
  const releaseDays = present(delivery?.releaseDays);
  // The depth walk needs a level to walk back from; without one there is nothing
  // to draw, however many days of net movement we hold.
  const depth = src.depth && src.open !== null && src.days
    // `exited`, and REFUSED when board-api sent none (#1014). An older payload
    // carries `closed` alone, and walking that draws a line that is wrong and
    // says so nowhere; `present` already turns an absent series into no chart,
    // which is this strip's answer for "we do not hold that".
    ? present(dailyDepth(src.open, src.days.opened, src.days.exited ?? []))
    : null;

  return {
    // Every series a tile hands to a spark goes through `sparkDays`, and this is
    // the only place any of them does. The day each one ends on is the day that
    // tile's own figure is for: `src.open` is a level held now, `tail` is a
    // count for yesterday.
    issues: { n: src.open, ...sparkDays(depth, 'today', day) },
    throughput: { ...tail(closed), ...sparkDays(closed, 'yesterday', day) },
    releases: {
      ...tail(releaseDays),
      ...sparkDays(releaseDays, 'yesterday', day),
      scope: delivery?.releaseScope ?? null,
      partial: delivery?.releasesPartial ?? false,
    },
    grid: window === null ? null : gridOf(window),
    oldest: oldestOpen(scope),
    window,
    years: window === null ? [] : yearsWithCloses(window),
  };
}

/**
 * The oldest still-open issue, as the three answers this board distinguishes.
 *
 * `unread` and `none` are not the same answer, for the reason the docblock at
 * the top of this file gives about absent, empty and zero: a queue nobody could
 * read and a queue with nothing open in it produce the same empty list, and only
 * one of them is a fact about the work. The tile says two different things.
 */
export type OldestView =
  | { kind: 'unread' }
  | { kind: 'none' }
  | { kind: 'issue'; issue: OldestIssue };

/** One issue, in the fields the tile states and the fields the shared action
 *  menu spends (`ui/issue-actions.ts`'s `ActionableIssue` is the second half of
 *  this shape, and `htmlUrl` is what both halves read from). */
export interface OldestIssue {
  repo: string;
  number: number;
  title: string;
  ageDays: number;
  htmlUrl: string;
  /** Github assignee logins, empty when nobody holds it. */
  assignees: string[];
}

/**
 * Oldest first, then a stable tie-break.
 *
 * It is the comparator the Oldest-open block's `agingFor` sorted by, kept when
 * that block and its derivation came off the page (#815): two issues opened the
 * same day must not swap places between renders, and the age this tile states
 * has to be the largest in the queue rather than whichever row the array
 * happened to hold last.
 */
function olderOf(a: PersonalIssue, b: PersonalIssue): PersonalIssue {
  const by = b.ageDays - a.ageDays || a.repo.localeCompare(b.repo) || a.number - b.number;
  return by < 0 ? a : b;
}

const asOldest = (i: PersonalIssue): OldestIssue => ({
  repo: i.repo,
  number: i.number,
  title: i.title,
  ageDays: i.ageDays,
  htmlUrl: i.htmlUrl,
  assignees: i.assignees,
});

/**
 * THE WHOLE QUEUE AND NOT THE AGING SET (#816).
 *
 * The Oldest-open block's `agingState` answered a different question and was the
 * obvious thing to reuse: it was gated on board-api's `aging` predicate, 30 days
 * and over. Its head IS the oldest issue whenever the set is non-empty, and on a
 * unit whose oldest issue is 12 days old the set is empty while an oldest issue
 * plainly exists. A tile captioned "The oldest" that goes blank on a healthy
 * queue reports the queue's health as a failure to read it. (`agingState` and
 * `agingFor` are gone with the block they fed: #815 took the block, #866 took
 * the 95 lines of derivation and 105 of spec that were still standing behind it.
 * This paragraph is the record of why they were not reused.)
 *
 * So this walks the same queue the Issues tile counts, which is what makes the
 * two tiles answerable from one another: the figure on the left is how many are
 * open, and the figure here is how long the longest of exactly those has been.
 */
export function oldestOpen(scope: Scope): OldestView {
  const queue = openQueue(scope);
  // Only oldest follows the selected owner; the headline keeps its union scope.
  const issues = queue === null ? null : scope.kind === 'org' && scope.owner
    ? queue.filter((issue) => issue.owner.toLowerCase() === scope.owner!.toLowerCase())
    : queue;
  if (issues === null) return { kind: 'unread' };
  if (issues.length === 0) return { kind: 'none' };
  return { kind: 'issue', issue: asOldest(issues.reduce(olderOf)) };
}

/** The open issues this scope is about, or `null` where none were read at all.
 *  Selection is applied by `selectedOrgQueue` below, which is the SAME call the
 *  Issues tile counts. Oldest additionally narrows this list by selected owner. */
function openQueue(scope: Scope): readonly PersonalIssue[] | null {
  if (scope.kind === 'me') {
    // The same gate `mineSource` puts on the count. MINE_UNAVAILABLE arrives as
    // an empty list under an error, and naming no oldest issue over it would be
    // "nothing is open" about a person whose queue we never read.
    if (!scope.mine || scope.error !== null) return null;
    return scope.mine.issues.filter((i) => i.assignedToMe);
  }
  // Overview reads the untruncated org queue, so a selection narrows it here
  // rather than costing a request. `metrics.stale` is NOT the fallback: it is
  // the server's org-wide ten oldest and knows nothing about a Crew press.
  return selectedOrgQueue(scope.org, scope.logins);
}

/**
 * The org queue a selection holds, or `null` where there is no honest answer.
 *
 * TWO `null`s, and both are the strip refusing rather than guessing. A queue
 * still fetching, or one whose fetch the page swallowed, was never read.
 *
 * The second is a DISAGREEMENT about who is selected. The two halves of this
 * scope are matched by two different login rules — `selectedIssues` is
 * case-sensitive, `orgSeries` folds — so a mis-cased login matches nothing in
 * the queue while matching a full `byMember` row. Every guard downstream then
 * passes: the count is 0 rather than null, the series is populated, and
 * `dailyDepth` walks 98 days back from zero and floors them there. Fold case in
 * `assignedToAny` instead and the queue below the strip starts matching a
 * different set from the one the tiles count, which is the drift the single
 * comparator exists to end — so the answer is to refuse here.
 *
 * The refusal is keyed on the SAME queue answering differently under the two
 * rules, and NOT on a bare zero: a correctly-spelled member who closed work this
 * week and holds nothing open now is in `byMember` with a full series and in the
 * queue not at all. Both rules find them nothing, so 0 is the true answer, and
 * refusing it would draw good news as a fault.
 *
 * IT LIVES HERE, ABOVE BOTH READERS, because it lived in `orgSource` alone: the
 * count refused and the oldest-issue walk did not, so a mis-cased login drew
 * "Issues" with no figure beside "Nothing open." over a 77-day-old
 * open issue (#866 review). One list, read twice, refusing once.
 */
function selectedOrgQueue(org: OrgSource, logins: readonly string[]): readonly PersonalIssue[] | null {
  if (org.kind !== 'ready') return null;
  const mine = selectedIssues(org.issues, logins);
  if (mine.length === 0 && logins.length > 0 && foldedMatchInQueue(org, logins)) return null;
  return mine;
}

/** What a scope contributes: the level now, the day series, whether a depth
 *  series may be drawn at all, and the long closed history the grid is cut
 *  from. */
interface Derived {
  open: number | null;
  days: DaySeries | null;
  depth: boolean;
  closedDays: number[] | null;
}

function mineSource(scope: Extract<Scope, { kind: 'me' }>): Derived {
  const mine = scope.mine;
  if (!mine) return { open: null, days: null, depth: false, closedDays: null };
  // An unreadable queue arrives as MINE_UNAVAILABLE — an empty issue list under
  // an error message. Counting it says "0 open" about the person, which is a
  // claim about them rather than about what we hold.
  const open = scope.error !== null ? null : mine.issues.filter((i) => i.assignedToMe).length;
  return { open, days: days(mine.throughputDays), depth: true, closedDays: present(mine.closedDays) };
}

/**
 * Whether the queue holds work for this selection under a case-INSENSITIVE match.
 *
 * Asked only when the case-SENSITIVE count came back 0, and it is what tells a
 * disagreement from a true zero: somebody spelled differently from the queue's
 * ingest is found here and nowhere else, while a member who genuinely holds
 * nothing open is found by neither rule.
 */
function foldedMatchInQueue(org: OrgSource, logins: readonly string[]): boolean {
  if (org.kind !== 'ready') return false;
  const wanted = new Set(logins.map((l) => l.toLowerCase()));
  return org.issues.some((i) => i.assignees.some((a) => wanted.has(a.toLowerCase())));
}

function orgSource(scope: Extract<Scope, { kind: 'org' }>): Derived {
  const { metrics, org, logins } = scope;
  // The same gate the Overview tile band used to apply before #752 removed it: a
  // queue still fetching, or one whose fetch the page swallowed, has no count to
  // state, and `null` is what the tile draws its no-figure state from. The
  // disagreement refusal below is in the same call, so this figure and the
  // oldest-issue tile refuse together or answer together.
  const queue = selectedOrgQueue(org, logins);
  const series = metrics ? orgSeries(metrics, logins) : { days: null, closedDays: null, matched: false };
  // A shared close contributes once to the selected union, including its grid.
  // Keep the existing absence gates and history span from the member series.
  if (metrics?.closeEvents && metrics.computedAt && logins.length > 0 && series.closedDays && series.days) {
    const wanted = new Set(logins.map((login) => login.toLowerCase()));
    const today = calendarDate(Date.parse(metrics.computedAt), metrics.timeZone) / DAY_MS;
    const unique = [...new Map(metrics.closeEvents.map((event) => [event.htmlUrl, event])).values()]
      .filter((event) => event.assignees.some((login) => wanted.has(login.toLowerCase())));
    const count = (length: number) => {
      const values = Array<number>(length).fill(0);
      for (const event of unique) {
        const index = length - 1 - (today - calendarDate(Date.parse(event.closedAt), metrics.timeZone) / DAY_MS);
        if (index >= 0 && index < length) values[index]++;
      }
      return values;
    };
    series.closedDays = count(series.closedDays.length);
    series.days = { ...series.days, closed: count(series.days.closed.length) };
  }
  const open = queue === null ? null : queue.length;
  return {
    open,
    days: series.days,
    // With several Crew cards pressed, a shared issue is counted ONCE in the
    // head count and once per assignee in the summed nets. The walk re-applies
    // that error at every one of its 98 steps, so it drifts further from the
    // truth the further back it goes and can render negative — which is why the
    // walk is refused while the head count above it stands.
    depth: logins.length <= 1,
    closedDays: series.closedDays,
  };
}

/** What the grid draws, what decodes it, and which day it ends on. */
export interface GridView {
  weeks: DayCount[][];
  scale: ShadeScale;
  /** UTC midnight of the LAST DRAWN day — the last cell of the last column, and
   *  the date every other cell is counted back from. */
  endsOn: number;
}

/** One UTC day. The grid's own arithmetic and `DayGrid`'s cell dating both
 *  count in these, so there is one of them. */
export const DAY_MS = 86_400_000;

// ── naming a day, once for everything on the strip (#708) ────────────────────

/** The grid's own column headings read these too, which is why they are here
 *  rather than beside `dateLabel` alone: one list of month names on the strip. */
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * A UTC day, named — "Sat 22 Aug".
 *
 * `DayGrid` wrote this and was the only thing on the strip that named a date.
 * The stat-tile sparks name one too now (#708), and a second copy of a date
 * format is how the grid and the sparks come to say the same day two ways — so
 * it is hoisted here, where both read it, rather than duplicated.
 *
 * UTC parts read the date-only coordinate, already converted to the viewer
 * zone by stripModel. A local
 * reading names the day before for the whole evening west of Greenwich.
 */
export function dateLabel(t: number): string {
  const d = new Date(t);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * UTC midnight of the day point `i` of a spark draws.
 *
 * The same arithmetic `DayGrid` dates a cell with, against the same kind of
 * `endsOn`: count back one day per point from the last one. A spark carries no
 * calendar of its own — the days arrive as a bare `number[]` — so this and
 * `TileModel.endsOn` together are the whole of what makes a point datable.
 */
export function sparkDay(endsOn: number, len: number, i: number): number {
  return endsOn - (len - 1 - i) * DAY_MS;
}

/**
 * What a tile's spark measures, in the tile's own words.
 *
 * THE THREE TILES DO NOT STATE THE SAME KIND OF NUMBER, and the sentence under
 * a pointer must not pretend they do. "Issues" is a LEVEL held that day;
 * "Closed" and "Released yesterday" are COUNTS of things that happened in it
 * (`FigureDay` above argues this at length). Two of the three captions used to
 * carry that distinction and no longer do — #752 took it off the first, #821 off
 * the second — so these words are where it is held for every reader now, not
 * only for one who cannot see the strip. The tile passes its own noun down and
 * `reading` says which grammar it takes.
 */
export interface SparkUnit {
  /** What the WHOLE chart shows, for its accessible name. Written out per tile
   *  rather than built from `word`: "closed each day" is a rate and "issues open
   *  each day" would read as one too, which is the exact misreading this file
   *  spends `FigureDay` on preventing. */
  chart: string;
  /** What ONE point reads, after the number. */
  word: string;
  reading: 'level' | 'count';
}

/**
 * What one point of a spark says when it is pointed at (#708).
 *
 * A sentence in the shape `DayGrid`'s cells use — the date, a comma, the
 * reading — because these are the same strip and a reader crossing from the
 * lattice to a tile should not have to learn a second format. The count
 * sentence is word for word the grid's own, and that is on purpose: the
 * Throughput spark and the grid report the same measurement, so a day they
 * disagreed about would be a straight contradiction on one screen.
 *
 * THE MARK WAS AN EM DASH UNTIL #818, and the reason it is not one now is that
 * a reader met it and called the sentence machine-written. Nothing measured it:
 * the detector this repo vendors scores a `.ts` file's comments and never its
 * strings, and its one em-dash rule ignores anything under sixty words, which
 * is every sentence on this board. `docs/user-facing-copy.md` is that argument
 * and `scripts/copy-gate/` is what now reads these strings.
 *
 * A ZERO IS REPORTED, NEVER PASSED OVER. `ColumnSpark` draws nothing at all for
 * a zero day, so the words are the whole of what a reader gets there — and on
 * the live board the Releases spark's last month is entirely zero, which makes
 * it the ordinary case on that tile rather than an edge one.
 *
 * A LEVEL KEEPS ITS DIGIT. "nothing closed" is an absence: no event happened. A
 * level of zero is a reading — the depth line touching its own floor — so it
 * says "0 issues open", the number being the measurement rather than the lack of
 * one.
 */
export function sparkPointSentence(
  series: number[],
  endsOn: number,
  i: number,
  unit: SparkUnit,
): string {
  const n = series[i] ?? 0;
  const reads = unit.reading === 'count' && n === 0 ? `nothing ${unit.word}` : `${n} ${unit.word}`;
  return `${dateLabel(sparkDay(endsOn, series.length, i))}, ${reads}`;
}

/**
 * The chart's own accessible name — what the whole of it shows.
 *
 * NOT the `<when>, <reading>` grammar, and it never was. This names a WHOLE
 * chart, not one of its points, and until #818 it borrowed the point sentence's
 * separator without the sentence: "Closed each day — 3 days to Sat 22 Aug" is
 * two labels bolted together, and it is the string a reader quoted when he
 * called the board's tooltips machine-written. It is a clause now, joined by
 * the preposition it always needed.
 *
 * THE DAY COUNT IS PLURALISED, which it was not before. "1 days to Sat 22 Aug"
 * is reachable — a spark drawn over a single day — and a number agreeing with
 * nothing is the same tell in a smaller place.
 *
 * The span and the END DATE, because the day a spark ends on is the day its own
 * tile's figure is for (#734) and so is not the same day on every tile: the
 * level chart runs one day further than its two neighbours. A reader who cannot
 * see the strip has nothing else that says so.
 */
export function sparkTitle(series: number[], endsOn: number, unit: SparkUnit): string {
  const days = series.length;
  return `${unit.chart}, over the ${days} day${days === 1 ? '' : 's'} to ${dateLabel(endsOn)}`;
}

/**
 * The window the grid is cut from, from whichever series board-api sent.
 *
 * `closedDays` is the long one and `days.closed` the 98-day fallback for a
 * board-api that predates it; both end on the day the payload was built, so
 * they are the same kind of array and the caller picks one. `null` when there
 * is nothing at all — a series board-api did not send is not a run of quiet
 * days, and the grid is absent rather than empty.
 */
function closedWindow(days: number[] | null, now: number): DayWindow | null {
  return days === null ? null : { days, today: Math.floor(now / DAY_MS) * DAY_MS };
}

/**
 * The calendar years the history holds a CLOSE in, newest first.
 *
 * A close, not an observed day: a year the series merely reaches into with
 * nothing in it is a year there is no reason to offer, and offering it would
 * put a segment on screen whose whole content is the empty grid the reader is
 * being warned about everywhere else.
 *
 * Dated the way every other day on this strip is — counted back from the last
 * entry — so the year list and the columns cannot disagree about which day a
 * count belongs to.
 */
function yearsWithCloses(w: DayWindow): number[] {
  const years = new Set<number>();
  const drawn = w.days.length - 1;
  for (let i = 0; i <= drawn; i++) {
    if (w.days[i]! > 0) years.add(new Date(w.today - (drawn - i) * DAY_MS).getUTCFullYear());
  }
  return [...years].sort((a, b) => b - a);
}

/**
 * The columns and the scale that decodes them, over one span of days.
 *
 * THEY ARE NOT CUT FROM THE SAME DAYS. The columns are everything drawn,
 * running week included. The scale is cut over the SETTLED days alone — every
 * drawn day before the running week's Monday — so the window it reads holds the
 * same calendar days within a week. Monday adds the former running week to the
 * settled days and recomputes the maximum, so unchanged counts can change shade.
 * A past calendar year is settled end to end and leaves nothing out.
 *
 * Days the grid never draws are outside both, which is what stops the scale
 * describing a reading no visible cell carries, and days the series never
 * reached are in neither: they are not zeros, they are nothing.
 */
function gridFrom(w: DayWindow, first: number, last: number): GridView | null {
  if (last < first) return null;
  const weeks = columnsFor(w, first, last);
  if (weeks.length === 0) return null;
  const running = mondayOf(w.today);
  const start = mondayOf(first);
  const settled = weeks.filter((_, i) => start + i * DAYS_PER_WEEK * DAY_MS < running).flat();
  return { weeks, scale: shadeScale(settled), endsOn: last };
}

/** The default view: 52 whole weeks plus the running week through today. */
function gridOf(w: DayWindow): GridView | null {
  const { first, last } = trailingSpan(w);
  return gridFrom(w, first, last);
}

/**
 * The grid for one year choice: the model's own columns for the trailing year,
 * that calendar year alone for anything else.
 *
 * A YEAR GETS ITS OWN SCALE, and this is the one place the old type filter's
 * rule is reversed rather than deleted. That filter kept the All scale because a
 * Bugs-only grid is a SUBSET of the same days and had to stay comparable with
 * the grid it was filtered out of. A PAST calendar year is a different span of
 * mostly different days, so a scale borrowed from the trailing window would
 * decode 2025 by how 2026 went — the quiet year drawn as an empty one because
 * its neighbour was busier, which `flow-strip.vm.spec.ts` pins.
 *
 * THE CURRENT YEAR IS A SUBSET, and the argument above does not cover it. The
 * trailing window opens on the Monday 364 days back, which is on or before 2
 * January of this year: over every day from 2020 to 2060 the current year is
 * drawn inside the trailing view but once — 31 December 2040, a leap year whose
 * 31 December is a Monday, where the trailing window opens on 2 January and
 * misses one day. So pressing "2026" beside "Last 12 months" REPAINTS days that
 * were on screen a second ago, and the count under them has not moved.
 *
 * Measured with this file's own `mixPercent`, over a 606-day window ending
 * 2026-08-29 whose 2025 half holds one 89 and whose 2026 half tops out at 20:
 * the same day carrying 5 goes 6% → 25%, 8 goes 9% → 40%, and 20 goes 22% →
 * 100%. That is the cost of the per-year scale, taken knowingly and pinned in
 * the spec beside the past-year case. It is paid because the alternative is
 * worse in the same direction — a light year decoded by a heavy one is a year
 * reported as quiet — and because a cell's own count is one hover away, where
 * a shade only ever ranks a day against the days beside it. The grid lost its
 * legend in #709, so there is nothing on screen that would explain the repaint;
 * what makes it readable is that every cell answers when it is pointed at.
 *
 * The year ends on 31 December, or today when that is sooner.
 */
export function gridFor(model: StripModel, year: number | null): GridView | null {
  if (model.window === null) return null;
  if (year === null) return model.grid;
  const w = model.window;
  return gridFrom(w, Date.UTC(year, 0, 1), Math.min(Date.UTC(year, 11, 31), w.today));
}

export function flameLevel(count: DayCount, level1?: number | null, level2?: number | null, level3?: number | null): 0 | 1 | 2 | 3 {
  if (count === null || level1 == null || !Number.isInteger(level1) || level1 <= 0 || count < level1) return 0;
  if (level2 != null && Number.isInteger(level2) && level2 > level1 && count >= level2) {
    if (level3 != null && Number.isInteger(level3) && level3 > level2 && count >= level3) return 3;
    return 2;
  }
  return 1;
}
