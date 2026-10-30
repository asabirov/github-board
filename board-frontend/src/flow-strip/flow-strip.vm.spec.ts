import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '../ui/kit';
import { FlowStrip } from './FlowStrip';
import flowStripSource from './FlowStrip.tsx?raw';
import type { DeliveryView } from '../api/delivery';
import type { IssueMetrics, PersonalIssue, PersonalIssues } from '../api/issues';
import type { OrgSource } from '../dashboard/pulse-filter';
import { yearInView } from './FlowStrip';
import { issuePathFromUrl } from '../route';
import { DAY_MS, DAYS_PER_WEEK, SPARK_DAYS, dailyDepth, gridFor, mixPercent, shadeScale, stripModel, weekAlignedGrid, type DayCount, type GridView, type Scope, type StripModel } from './flow-strip.vm';

/** Matches DAY_SPAN in board-service/src/time/day-span.ts. Declared here rather
 *  than imported because the two packages have separate tsconfigs. It is
 *  SHORTER than the 52-week grid since #817, which is the point: the payload no
 *  longer fills the window and the days it cannot reach draw as nothing. */
const SPAN = 98;

/** The days a grid actually holds a reading for. Everything else in it is a day
 *  the series does not reach, drawn as nothing — so this, and not the cell
 *  count, is what a test about counts means. */
const observedOf = (g: GridView): number[] => g.weeks.flat().filter((n): n is number => n !== null);

/** UTC midnight of every day a grid draws a READING for, dated the way `DayGrid`
 *  dates a cell: count back from `endsOn` over the flat day offsets. */
const drawnDays = (g: GridView): number[] => {
  const last = (g.weeks.length - 1) * DAYS_PER_WEEK + g.weeks.at(-1)!.length - 1;
  const days: number[] = [];
  g.weeks.flat().forEach((n, i) => { if (n !== null) days.push(g.endsOn - (last - i) * DAY_MS); });
  return days;
};

/** A Tuesday, so the week-aligned slice has two days to drop. */
const NOW = Date.parse('2026-08-25T12:00:00Z');

const zeros = (n = SPAN) => Array.from({ length: n }, () => 0);
/** `exited` mirrors `closed` on every fixture that holds no abandoned close,
 *  which is the honest default: with nothing dropped, everything that left the
 *  open queue shipped (#1014). The cases that need the two to DIFFER say so. */
const ZEROES = { opened: zeros(), closed: zeros(), exited: zeros() };

function issue(over: Partial<PersonalIssue> & { number: number }): PersonalIssue {
  return {
    repo: 'board',
    owner: 'acme',
    title: `issue ${over.number}`,
    htmlUrl: 'https://example.invalid',
    createdAt: '2026-08-01T00:00:00Z',
    ageDays: 24,
    labels: [],
    type: 'chore',
    blocked: false,
    assignedToMe: true,
    assignees: ['a'],
    author: 'a',
    projects: [],
    state: 'open',
    closedAt: null,
    ...over,
  };
}

const MINE: PersonalIssues = {
  updatedAt: '2026-08-25T12:00:00Z',
  login: 'a',
  issues: [issue({ number: 1 }), issue({ number: 2 }), issue({ number: 3 })],
  throughput: { opened: 4, closed: 6 },
  throughputWeeks: [{ opened: 4, closed: 6 }],
};

/** A day series with something in every cell the tiles read, so an assertion
 *  about "yesterday" cannot pass on an array of zeros. */
function series(tail: { opened: number; closed: number; exited?: number }[]) {
  const opened = zeros();
  const closed = zeros();
  const exited = zeros();
  tail.forEach((d, i) => {
    const at = SPAN - tail.length + i;
    opened[at] = d.opened;
    closed[at] = d.closed;
    exited[at] = d.exited ?? d.closed;
  });
  return { opened, closed, exited };
}

/** 98 days with real closes in them — the not-quiet counterpart of `ZEROES`. */
const BUSY = { opened: zeros(), closed: zeros().map((_, i) => i % 7), exited: zeros().map((_, i) => i % 7) };

const ORG: OrgSource = {
  kind: 'ready',
  issues: [
    issue({ number: 10, assignees: ['a'] }),
    issue({ number: 11, assignees: ['b'] }),
    issue({ number: 12, assignees: ['a', 'b'] }),
    issue({ number: 13, assignees: ['c'] }),
  ],
};

const member = (login: string, days: { opened: number[]; closed: number[] }, closedDays?: number[]) => ({
  login,
  name: login.toUpperCase(),
  opened: 1,
  closed: 2,
  weeks: [{ opened: 1, closed: 2 }],
  days,
  ...(closedDays === undefined ? {} : { closedDays }),
});

const METRICS = {
  updatedAt: '2026-08-25T12:00:00Z',
  repos: [],
  labels: [],
  cycles: [],
  filter: {},
  totals: { open: 4, openFlow: 4, steadyState: 0, closed90: 9, unassigned: 0 },
  weeks: [{ opened: 3, closed: 5 }],
  days: series([{ opened: 2, closed: 5 }, { opened: 1, closed: 3 }, { opened: 4, closed: 2 }]),
  recent4: { opened: 3, closed: 5 },
  byMember: [
    member('a', series([{ opened: 1, closed: 3 }, { opened: 0, closed: 2 }, { opened: 2, closed: 1 }])),
    member('b', series([{ opened: 1, closed: 2 }, { opened: 1, closed: 1 }, { opened: 2, closed: 1 }])),
  ],
  load: [],
  ttc: { medianDays: 3, p90Days: 9, n: 12 },
  stale: [],
  steadyByType: [],
} satisfies IssueMetrics;

const DELIVERY: DeliveryView = {
  releases: [],
  merges: [],
  unassignedPrs: 2,
  updatedAt: '2026-08-25T12:00:00Z',
  releaseDays: zeros().map((_, i) => (i === SPAN - 2 ? 3 : i === SPAN - 3 ? 1 : 0)),
  releasesPartial: true,
  releaseScope: 'acme',
};

const me = (mine: PersonalIssues | null, error: string | null = null): Scope => ({ kind: 'me', mine, error });

/**
 * One login's closes per day, measured on the live API over 91 calendar days:
 * 24 zeros, p50 2, p75 8, p90 23, max 89. The shape is the whole argument for
 * the continuous scale — every figure #720 was decided on is read off this
 * distribution — so the fixture's own statistics are asserted below rather than
 * trusted. A fixture that lost the shape would make the scale tests vacuous.
 */
const REAL_SHAPED_SERIES = [
  ...Array<number>(24).fill(0),
  ...Array<number>(10).fill(1),
  ...Array<number>(12).fill(2),
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 6, 6, 7, 7,
  ...Array<number>(7).fill(8),
  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22,
  23,
  25, 28, 32, 37, 43, 50, 58, 70,
  89,
];

/** A Saturday, so the running column holds five days: Monday through Friday. */
const SATURDAY = Date.parse('2026-08-29T00:00:00Z');

/**
 * A `closedDays` reaching back to 1 January 2025 off a today of 2026-08-29 —
 * two calendar years holding closes, and not one day of a third.
 *
 * 606 days is exactly 2025-01-01 through 2026-08-29. It is CHECKED rather than
 * trusted: the year list is read off the array's length, so a fixture one day
 * out would offer a 2024 nobody closed anything in and every assertion about
 * the switcher would still pass.
 */
const twoYears = () => {
  const days = Array.from({ length: 606 }, (_, i) => (i % 4 === 0 ? 3 : 0));
  expect(new Date(Date.UTC(2026, 7, 29) - (days.length - 1) * DAY_MS).toISOString().slice(0, 10))
    .toBe('2025-01-01');
  return days;
};

/** A Saturday fixture with 91 settled days, five earlier running days,
 *  and today's count. Only the settled days determine the shade scale. */
const saturdaySeries = (running: number[], today: number) => {
  const closed = [...REAL_SHAPED_SERIES, ...running, today];
  expect(closed).toHaveLength(97);
  return closed;
};

/** Linear-interpolated quantile — how the measured shape below is stated. */
function pct(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = q * (s.length - 1);
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}

describe('the fixture really is the measured shape', () => {
  it('carries the distribution the scale decisions were made on', () => {
    expect(REAL_SHAPED_SERIES).toHaveLength(91);
    expect(REAL_SHAPED_SERIES.filter((n) => n === 0)).toHaveLength(24);
    expect(pct(REAL_SHAPED_SERIES, 0.25)).toBe(0);
    expect(pct(REAL_SHAPED_SERIES, 0.5)).toBe(2);
    expect(pct(REAL_SHAPED_SERIES, 0.75)).toBe(8);
    expect(pct(REAL_SHAPED_SERIES, 0.9)).toBe(23);
    expect(Math.max(...REAL_SHAPED_SERIES)).toBe(89);
  });
});

describe('dailyDepth', () => {
  it('never returns a negative depth', () => {
    expect(Math.min(...dailyDepth(3, [0, 0, 0], [9, 9, 9]))).toBeGreaterThanOrEqual(0);
  });

  // The test above cannot fail without the floor: walking back from 3 while
  // subtracting a NEGATIVE net only climbs. This one is the floor's own test —
  // unfloored it reads [-15, -6, 3].
  it('floors a walk-back that opens far more than it closes', () => {
    expect(dailyDepth(3, [9, 9, 9], [0, 0, 0])).toEqual([0, 0, 3]);
  });

  it('walks back from today, subtracting each day net', () => {
    // yesterday = today - opened(today) + closed(today):
    // 10 - 3 + 5 = 12, then 12 - 2 + 1 = 11.
    expect(dailyDepth(10, [1, 2, 3], [0, 1, 5])).toEqual([11, 12, 10]);
  });

  it('holds nothing when the two series disagree on length', () => {
    expect(dailyDepth(10, [1, 2], [0, 1, 5])).toEqual([]);
  });
});

/** The whole 52-week window as its own indices, so an assertion can name the
 *  day it means. One longer than the widest grid — a Sunday's 370 — so the
 *  columns below are full and the day numbers stay readable. */
const WIDE = 52 * 7 + 7;
const INDICES = Array.from({ length: WIDE }, (_, i) => i);

describe('weekAlignedGrid', () => {

  it('draws 52 whole weeks and the running week through today', () => {
    const g = weekAlignedGrid(INDICES, Date.parse('2026-08-25T00:00:00Z'));
    expect(g).toHaveLength(53);
    expect(g.slice(0, 52).every((w) => w.length === 7)).toBe(true);

    expect(g[51]!.at(-1)).toBe(WIDE - 3);
    expect(g.at(-1)).toEqual([WIDE - 2, WIDE - 1]);
  });

  it('holds six of the seven off a Saturday', () => {
    const g = weekAlignedGrid(INDICES, Date.parse('2026-08-29T00:00:00Z'));
    expect(g).toHaveLength(53);
    expect(g.at(-1)).toHaveLength(6);
    expect(g.at(-1)!.at(-1)).toBe(WIDE - 1);
  });

  it('includes Sunday in the running week', () => {

    const g = weekAlignedGrid(INDICES, Date.parse('2026-08-23T00:00:00Z'));
    expect(g).toHaveLength(53);
    expect(g.at(-1)).toHaveLength(7);
    expect(g.at(-1)!.at(-1)).toBe(WIDE - 1);
  });

  it('starts a new column on Monday', () => {
    const g = weekAlignedGrid(INDICES, Date.parse('2026-08-24T00:00:00Z'));
    expect(g).toHaveLength(53);
    expect(g.at(-1)).toEqual([WIDE - 1]);
    expect(g.at(-1)!.at(-1)).toBe(WIDE - 1);
  });

  it('draws the whole window over a series that cannot fill it, as nothing', () => {
    const g = weekAlignedGrid(Array.from({ length: 40 }, () => 1), Date.parse('2026-08-25T00:00:00Z'));
    expect(g).toHaveLength(53);
    expect(g.flat()).toHaveLength(52 * 7 + 2);

    expect(g.flat().filter((n) => n !== null)).toHaveLength(40);
    expect(g.flat().filter((n) => n === null)).toHaveLength(52 * 7 + 2 - 40);

    expect(g.flat()).not.toContain(0);
  });

  it('puts the readings it does have at the RIGHT-hand end', () => {

    const g = weekAlignedGrid([1, 2, 3, 4], Date.parse('2026-08-25T00:00:00Z'));
    expect(g.at(-1)).toEqual([3, 4]);
    expect(g.at(-2)).toEqual([null, null, null, null, null, 1, 2]);
    expect(g.at(-3)!.every((n) => n === null)).toBe(true);
  });
});

/**
 * `GridView.endsOn` — the date the grid's right-hand edge carries, and since
 * #734 the only definition of it anywhere.
 *
 * `DayGrid` is handed it as a number and dates every other cell by counting back
 * from it, so an arithmetic that is a day out moves all 96 dates together and no
 * assertion inside that component can see it. These name the calendar day
 * itself, on the three weekdays where the slice behaves differently: a Monday,
 * whose running week is today alone; a Sunday, whose running week is seven days;
 * and an ordinary weekday in between.
 */
describe('which day the grid ends on (#709, #734)', () => {
  const gridAt = (iso: string) => stripModel(me({ ...MINE, throughputDays: ZEROES }), null, Date.parse(iso)).grid!;

  it('ends on today, named as a UTC date, whatever the weekday', () => {
    expect(gridAt('2026-08-25T12:00:00Z').endsOn).toBe(Date.UTC(2026, 7, 25));
    expect(gridAt('2026-08-24T12:00:00Z').endsOn).toBe(Date.UTC(2026, 7, 24));
    expect(gridAt('2026-08-23T12:00:00Z').endsOn).toBe(Date.UTC(2026, 7, 23));
    expect(gridAt('2026-08-29T12:00:00Z').endsOn).toBe(Date.UTC(2026, 7, 29));
  });

  it('is midnight of that day, not the hour the page was opened', () => {

    expect(gridAt('2026-08-25T00:05:00Z').endsOn).toBe(Date.UTC(2026, 7, 25));
    expect(gridAt('2026-08-25T23:55:00Z').endsOn).toBe(Date.UTC(2026, 7, 25));
  });

  it('is the date the last cell of the grid actually reads', () => {

    const at = Date.parse('2026-08-29T12:00:00Z');
    const labels = [...strip(stripModel(me({ ...MINE, throughputDays: ZEROES }), null, at), at)
      .matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels.at(-1)).toBe('Sat 29 Aug, nothing closed');
    expect(labels.at(-6)).toBe('Mon 24 Aug, nothing closed');
  });

  it('ends a past calendar year on 31 December and the current one on today', () => {

    const at = Date.parse('2026-08-29T12:00:00Z');
    const m = stripModel(me({ ...MINE, closedDays: twoYears() }), null, at);
    expect(m.years).toEqual([2026, 2025]);
    expect(gridFor(m, 2025)!.endsOn).toBe(Date.UTC(2025, 11, 31));
    expect(gridFor(m, 2026)!.endsOn).toBe(Date.UTC(2026, 7, 29));
    expect(gridFor(m, null)!.endsOn).toBe(Date.UTC(2026, 7, 29));
  });

  it('starts a calendar year on 1 January, whatever weekday that is', () => {

    const at = Date.parse('2026-08-29T12:00:00Z');
    const m = stripModel(me({ ...MINE, closedDays: twoYears() }), null, at);
    const g = gridFor(m, 2025)!;
    expect(g.weeks[0]!.slice(0, 2)).toEqual([null, null]);
    expect(g.weeks[0]![2]).not.toBeNull();
    expect(observedOf(g)).toHaveLength(365);
  });
});

describe('the relative shade scale (#1293)', () => {
  it('fades small counts relative to the settled maximum', () => {
    const scale = shadeScale([0, 1, 5, 50, 64, 84]);
    expect([0, 1, 5, 50, 64, 84].map((n) => mixPercent(n, scale)))
      .toEqual([0, 1, 6, 60, 76, 100]);
  });

  it('uses the maximum regardless of the minimum or frequency of other counts', () => {
    expect(mixPercent(5, shadeScale([1, 5, 5, 5, 84])))
      .toBe(mixPercent(5, shadeScale([20, 84])));
  });

  it('gives the full fill to a sole or repeated maximum', () => {
    expect(mixPercent(1, shadeScale([0, 1, 0]))).toBe(100);
    expect(mixPercent(4, shadeScale([4, 4, 4]))).toBe(100);
    expect(mixPercent(3, shadeScale([4, 4, 4]))).toBe(75);
  });

  it('clamps running-week counts above the settled maximum', () => {
    expect(mixPercent(100, shadeScale([1, 84]))).toBe(100);
  });

  it('keeps a zero window empty and handles its first running-week activity', () => {
    const scale = shadeScale([null, 0, 0]);
    expect(mixPercent(0, scale)).toBe(0);
    expect(mixPercent(3, scale)).toBe(100);
  });

  it('allows a positive count to round to zero fill beside a large maximum', () => {
    expect(mixPercent(1, shadeScale([1, 10_000]))).toBe(0);
  });

  it('never paints a heavier day paler than a lighter one', () => {
    const scale = shadeScale(REAL_SHAPED_SERIES);
    const sorted = [...REAL_SHAPED_SERIES].sort((a, b) => a - b);
    expect(sorted.every((n, i) => i === 0 || mixPercent(n, scale) >= mixPercent(sorted[i - 1]!, scale))).toBe(true);
  });
});

describe('stripModel', () => {
  it('distinguishes absent from empty from zero', () => {
    expect(stripModel(me(null), null, NOW).throughput.series).toBeNull();
    expect(stripModel(me({ ...MINE, throughputDays: { opened: [], closed: [] } }), null, NOW).throughput.series).toBeNull();
    // Through yesterday (#734) and the last 60 of those (#873). `SPAN` is what
    // board-api sends; `SPARK_DAYS` is what a spark draws, and until #820 the
    // two were one number so an assertion could not tell them apart.
    expect(stripModel(me({ ...MINE, throughputDays: ZEROES }), null, NOW).throughput.series)
      .toEqual(ZEROES.closed.slice(0, -1).slice(-SPARK_DAYS));
  });

  it('counts a zero rather than withholding it when the day was counted', () => {
    const m = stripModel(me({ ...MINE, throughputDays: ZEROES }), null, NOW);
    expect(m.throughput.n).toBe(0);
    expect(m.throughput.series).toEqual(ZEROES.closed.slice(0, -1).slice(-SPARK_DAYS));
  });

  it('reads yesterday, not today, for the throughput tile — figure AND series', () => {
    const days = series([{ opened: 0, closed: 4 }, { opened: 0, closed: 7 }, { opened: 0, closed: 99 }]);
    const m = stripModel(me({ ...MINE, throughputDays: days }), null, NOW);
    expect(m.throughput.n).toBe(7); // yesterday, never today: today is still
    // being counted, and it reads low. The series used to end on that 99, so the
    // spark's rightmost bar was today's partial count under a figure that was
    // yesterday's (#734). It ends where the figure does now.
    expect(m.throughput.series).toHaveLength(SPARK_DAYS);
    expect(m.throughput.series!.at(-1)).toBe(7);
    expect(m.throughput.series).not.toContain(99);
  });

  it('counts the open queue now and walks its depth back', () => {
    const days = series([{ opened: 0, closed: 0 }, { opened: 0, closed: 0 }, { opened: 2, closed: 1 }]);
    const m = stripModel(me({ ...MINE, throughputDays: days }), null, NOW);
    expect(m.issues.n).toBe(3); // MINE holds three assigned-to-me rows
    // The walk starts from the 3 held now and the drawn line ends on it: a level
    // is complete at every instant, so its spark runs to today (#734).
    expect(m.issues.series).toHaveLength(SPARK_DAYS);
    expect(m.issues.series!.at(-1)).toBe(3);
    expect(m.issues.series!.at(-2)).toBe(2); // 3 - 2 opened + 1 closed
  });

  it('states no count at all when the personal queue could not be read', () => {
    // MINE_UNAVAILABLE's rule: an empty queue under an error is not "0 open".
    const m = stripModel(me({ ...MINE, issues: [] }, 'network'), null, NOW);
    expect(m.issues.n).toBeNull();
    expect(m.issues.series).toBeNull();
  });

  it('draws no depth series for a multi-login selection', () => {
    // An issue assigned to two people is counted once in the head count and twice
    // in the summed per-member nets, and over a 98-day walk-back that compounds.
    const m = stripModel({ kind: 'org', metrics: METRICS, org: ORG, logins: ['a', 'b'] }, null, NOW);
    expect(m.issues.series).toBeNull();
    expect(m.issues.n).not.toBeNull(); // the count still shows
  });

  it('does draw one for a single-login selection', () => {
    const m = stripModel({ kind: 'org', metrics: METRICS, org: ORG, logins: ['a'] }, null, NOW);
    expect(m.issues.n).toBe(2); // #10 and #12
    expect(m.issues.series).not.toBeNull();
    expect(m.throughput.n).toBe(2); // a's yesterday
  });

  it('sums the day series of a multi-login selection and folds login case', () => {
    const m = stripModel({ kind: 'org', metrics: METRICS, org: ORG, logins: ['A', 'B'] }, null, NOW);
    expect(m.throughput.n).toBe(3); // a's 2 + b's 1, yesterday
  });

  it('refuses a count when the queue and the series disagree about who is selected', () => {
    // `selectedIssues` matches assignees case-SENSITIVELY; `orgSeries` folds case,
    // because `byMember` can hold two rows for one person. One mis-cased login
    // therefore counts 0 in the queue and matches a full row in `byMember`, and
    // every guard downstream reads that 0 as a fact: the tile prints "0 open
    // now" over a depth walk reconstructed from zero and floored there — a
    // confident wrong curve, beside a Throughput tile reading the same person's
    // real closes. A disagreement is not a zero.
    const folded = stripModel({ kind: 'org', metrics: METRICS, org: ORG, logins: ['A'] }, null, NOW);
    expect(stripModel({ kind: 'org', metrics: METRICS, org: ORG, logins: ['a'] }, null, NOW).issues.n).toBe(2);
    expect(folded.issues.n).toBeNull();
    expect(folded.issues.series).toBeNull();
    // The series half did match — without this the test would pass on a login
    // nothing anywhere knows, which is an empty answer rather than a conflict.
    expect(folded.throughput.n).toBe(2);
    // And what a person reads: the tile's absent state, not a fabricated zero
    // sitting beside the same person's real Throughput figure.
    const text = textOf(strip(folded));
    expect(text).toContain('Issues Unavailable');
    expect(strip(folded)).toContain('aria-label="The issue queue couldn’t be read just now."');
    expect(text).not.toContain('Issues open 0');
    expect(text).toContain('Closed 2');
  });

  it('states a true zero as a zero — an active member with nothing open now', () => {
    // The counterpart of the test above, and the reason a bare `counted === 0`
    // cannot decide it: somebody who closed work this week and holds nothing
    // open now is in `byMember` with a full series and in the queue not at all.
    // "Issues open 0" is the answer; "couldn\u2019t be read" is good news drawn
    // as a fault.
    const metrics = {
      ...METRICS,
      byMember: [...METRICS.byMember, member('quiet', series([{ opened: 0, closed: 4 }, { opened: 0, closed: 2 }, { opened: 0, closed: 1 }]))],
    } satisfies IssueMetrics;
    const m = stripModel({ kind: 'org', metrics, org: ORG, logins: ['quiet'] }, null, NOW);
    expect(m.issues.n).toBe(0);
    // Not vacuous: the series half DID match, which is the state the mis-case
    // refusal keys on.
    expect(m.throughput.n).toBe(2);
    const text = textOf(strip(m));
    expect(text).toContain('Issues 0');
    expect(text).not.toContain('The issue queue couldn\u2019t be read just now.');
  });

  it('reports what it holds, not zeros, for a selection board-api has no row for', () => {
    const m = stripModel({ kind: 'org', metrics: METRICS, org: ORG, logins: ['nobody'] }, null, NOW);
    expect(m.throughput.n).toBeNull();
    expect(m.throughput.series).toBeNull();
    expect(m.grid).toBeNull();
  });

  it('holds no count while the org queue is pending or failed', () => {
    const pending = stripModel({ kind: 'org', metrics: METRICS, org: { kind: 'pending' }, logins: [] }, null, NOW);
    const failed = stripModel({ kind: 'org', metrics: METRICS, org: { kind: 'failed' }, logins: [] }, null, NOW);
    expect(pending.issues.n).toBeNull();
    expect(failed.issues.n).toBeNull();
  });

  it('reads the org-wide series when nothing is selected', () => {
    const m = stripModel({ kind: 'org', metrics: METRICS, org: ORG, logins: [] }, null, NOW);
    expect(m.issues.n).toBe(4); // the whole queue
    expect(m.throughput.n).toBe(3); // the org's yesterday
  });

  it('builds the grid and its scale from the closes it holds', () => {
    const closed = zeros();
    REAL_SHAPED_SERIES.forEach((v, i) => { closed[i + (SPAN - 91)] = v; });
    const m = stripModel(me({ ...MINE, throughputDays: { opened: zeros(), closed } }), null, NOW);
    expect(m.grid!.weeks).toHaveLength(53); // 52 whole + the running week
    // Every cell of it, drawn and undrawn alike, is what the same rule answers
    // for the same series — so the model adds no calendar of its own.
    expect(m.grid!.weeks).toEqual(weekAlignedGrid(closed, NOW));
    // The grid includes today; the scale excludes the whole running week.
    expect(observedOf(m.grid!)).toHaveLength(SPAN);
    expect(m.grid!.scale).toEqual(shadeScale(m.grid!.weeks.slice(0, 52).flat()));
  });

  it('cuts the scale over the settled days alone, never the running week', () => {
    // The running week's counts are the ones that move every night, so a scale
    // that read them would repaint settled cells overnight while their counts
    // stood still. Off a Saturday: same clock, same settled days, a running week
    // rewritten from nothing to a spike far above the settled maximum.
    const quiet = saturdaySeries([0, 0, 0, 0, 0], 0);
    const busy = saturdaySeries([400, 500, 600, 700, 800], 900);

    const a = stripModel(me({ ...MINE, throughputDays: { opened: zeros(), closed: quiet } }), null, SATURDAY);
    const b = stripModel(me({ ...MINE, throughputDays: { opened: zeros(), closed: busy } }), null, SATURDAY);

    // Not vacuous on either side: the settled days really are the measured
    // shape, and the running column really did change under them. `slice(0, -1)`
    // is every column but the running one, and the nulls dropped out of it are
    // the months before this series starts.
    const settled = (m: StripModel) => m.grid!.weeks.slice(0, -1).flat().filter((n) => n !== null);
    expect(settled(a)).toEqual(REAL_SHAPED_SERIES);
    expect(a.grid!.weeks.slice(0, -1)).toEqual(b.grid!.weeks.slice(0, -1));
    expect(a.grid!.weeks.at(-1)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(b.grid!.weeks.at(-1)).toEqual([400, 500, 600, 700, 800, 900]);

    expect(b.grid!.scale).toEqual(a.grid!.scale);
    // And the reading itself, per cent by per cent, for every settled cell.
    for (const n of REAL_SHAPED_SERIES) {
      expect(mixPercent(n, b.grid!.scale)).toBe(mixPercent(n, a.grid!.scale));
    }
    // The spike is drawn, and it clamps rather than rescaling anything.
    expect(mixPercent(800, a.grid!.scale)).toBe(100);
  });

  it('draws today without letting its partial count change the scale', () => {
    // Today can exceed the settled maximum without rescaling older cells.
    const closed = saturdaySeries([1, 1, 1, 1, 1], 999);
    expect(closed.at(-1)).toBe(999);
    const m = stripModel(me({ ...MINE, throughputDays: { opened: zeros(), closed } }), null, SATURDAY);
    expect(m.grid!.weeks.flat()).toContain(999);
    expect(m.grid!.scale.nonZeroAscending).not.toContain(999);
    expect(m.grid!.scale).toEqual(shadeScale(REAL_SHAPED_SERIES));
  });

  it('never paints a day the series does not reach', () => {
    // The fourth state (#817), at the model. Half a 52-week grid is months
    // before board-api's first close, and a zero there would report a quiet
    // spring nobody watched. This series is 1 on every day it holds, so a zero
    // anywhere in the grid could only have been invented by the padding.
    const m = stripModel(me({ ...MINE, throughputDays: { opened: zeros(), closed: zeros().fill(1) } }), null, NOW);
    const cells = m.grid!.weeks.flat();
    expect(cells.filter((n) => n === null).length).toBeGreaterThan(0);
    expect(cells).not.toContain(0);
    expect(observedOf(m.grid!).every((n) => n === 1)).toBe(true);
    // And the shade scale is cut over the readings alone, so the empty months
    // cannot drag it: one distinct count, one blue.
    expect(new Set(m.grid!.scale.nonZeroAscending)).toEqual(new Set([1]));
  });

  it('gives each calendar year its own scale, cut over that year', () => {
    // The reverse of the type filter's rule, and deliberately. A Bugs-only grid
    // was a SUBSET of the days the All scale was cut over and had to stay
    // comparable with it; a calendar year is a different span, mostly of
    // different days, so a scale borrowed from the trailing window would decode
    // 2027 by how 2026 went. The two years here are drawn at different sizes on
    // purpose.
    const days = Array.from({ length: 606 }, (_, i) => (i < 365 ? 1 : 20));
    const at = Date.parse('2026-08-29T12:00:00Z');
    const m = stripModel(me({ ...MINE, closedDays: days }), null, at);
    const y2025 = gridFor(m, 2025)!;
    const y2026 = gridFor(m, 2026)!;
    expect(y2025.scale.nonZeroAscending.at(-1)).toBe(1);
    expect(y2026.scale.nonZeroAscending.at(-1)).toBe(20);
    // Each year's own heaviest day is the full token in its own view, which is
    // the whole of what a per-year scale buys: 2025 is not drawn as an empty
    // year because 2026 was busier.
    expect(mixPercent(1, y2025.scale)).toBe(100);
    expect(mixPercent(20, y2026.scale)).toBe(100);
    // Not vacuous: on ONE scale the quiet year would be the floor throughout.
    expect(mixPercent(1, y2026.scale)).toBe(5);
  });

  it('carries the release tile off the delivery payload, scope and all', () => {
    const m = stripModel(me(MINE), DELIVERY, NOW);
    expect(m.releases.n).toBe(3); // yesterday
    // And the spark ends on that same day, not on today's partial one (#734).
    expect(m.releases.series).toHaveLength(SPARK_DAYS);
    expect(m.releases.series!.at(-1)).toBe(3);
    expect(m.releases.scope).toBe('acme');
    expect(m.releases.partial).toBe(true);
  });

  it('says nothing about releases when delivery has not landed', () => {
    const m = stripModel(me(MINE), null, NOW);
    expect(m.releases.n).toBeNull();
    expect(m.releases.series).toBeNull();
    expect(m.releases.scope).toBeNull();
    expect(m.releases.partial).toBe(false);
  });

  it('falls back to the 98-day series while board-api predates closedDays', () => {
    // The deploy window: board-web ships before board-api, so the long history
    // is optional and the grid is the SAME SHAPE either way — an older board-api
    // simply reaches back less far and draws more empty columns.
    const short = stripModel(me({ ...MINE, throughputDays: ZEROES }), null, NOW);
    const long = stripModel(me({ ...MINE, throughputDays: ZEROES, closedDays: zeros(400) }), null, NOW);
    expect(short.window!.days).toHaveLength(SPAN);
    expect(long.window!.days).toHaveLength(400);
    expect(short.grid!.weeks).toHaveLength(long.grid!.weeks.length);
    expect(short.grid!.endsOn).toBe(long.grid!.endsOn);
    // What differs is only how far back the readings go. The 400-day series is
    // longer than the window, so it fills every one of the 366 slots the grid
    // draws off a Tuesday; the 98-day one reaches 98 of them.
    expect(observedOf(short.grid!)).toHaveLength(SPAN);
    expect(observedOf(long.grid!)).toHaveLength(52 * 7 + 2);
    expect(long.grid!.weeks.flat()).not.toContain(null);
  });

  it('prefers closedDays to the 98-day series when both are sent', () => {
    // They are the same measurement over different spans, and the grid is the
    // one thing that wants the long one. Reading `days.closed` while
    // `closedDays` is there would draw fifteen columns of a year board-api can
    // answer for.
    const m = stripModel(me({
      ...MINE,
      throughputDays: { opened: zeros(), closed: zeros().fill(7) },
      closedDays: Array.from({ length: 400 }, () => 2),
    }), null, NOW);
    expect(observedOf(m.grid!).every((n) => n === 2)).toBe(true);
    // And the THROUGHPUT tile still reads the 98-day series, which is the one
    // its figure and its spark are about — the long history is the grid's alone.
    expect(m.throughput.n).toBe(7);
  });

  it('holds no window at all for a scope board-api sent no closes for', () => {
    // Absent is not empty is not zero: no series means no grid and no years,
    // rather than a year of days nobody closed anything on.
    const m = stripModel(me(MINE), null, NOW);
    expect(m.window).toBeNull();
    expect(m.grid).toBeNull();
    expect(m.years).toEqual([]);
  });

  it('offers a year for every calendar year holding a CLOSE, newest first', () => {
    const at = Date.parse('2026-08-29T12:00:00Z');
    expect(stripModel(me({ ...MINE, closedDays: twoYears() }), null, at).years).toEqual([2026, 2025]);
  });

  it('offers no year a close never landed in, however far the series reaches', () => {
    // A year the series merely reaches into is a segment whose whole content is
    // the empty grid every other line on this block is warning about. This one
    // spans both years and closed nothing in 2025.
    const at = Date.parse('2026-08-29T12:00:00Z');
    const days = twoYears().map((_, i) => (i < 365 ? 0 : 4));
    expect(stripModel(me({ ...MINE, closedDays: days }), null, at).years).toEqual([2026]);
  });

  it('offers ONE year for the history the board actually holds today', () => {
    // The first close in either org is 2026-03-08, so this is what the live
    // board answers until January 2027, and the switcher does not render at
    // all. It is the expected state and not a fault, which is why it is pinned
    // rather than left to be rediscovered.
    const at = Date.parse('2026-09-02T12:00:00Z');
    const since = Math.round((Date.UTC(2026, 8, 2) - Date.UTC(2026, 2, 8)) / DAY_MS) + 1;
    const m = stripModel(me({ ...MINE, closedDays: Array.from({ length: since }, () => 1) }), null, at);
    expect(m.years).toEqual([2026]);
    // And the grid is still drawn over the whole 52 weeks, most of it nothing.
    expect(m.grid!.weeks).toHaveLength(53);
    expect(observedOf(m.grid!)).toHaveLength(since);
  });
});

describe('the years the switcher offers (#817)', () => {
  /** A close on every day from `from` through the day `at` falls in — the shape
   *  `closedDays` arrives in, one entry per UTC day with today's last. */
  const dailyCloses = (from: number, at: number) =>
    Array.from({ length: Math.round((Math.floor(at / DAY_MS) * DAY_MS - from) / DAY_MS) + 1 }, () => 1);

  it('offers the new year as soon as it holds a close on 1 January', () => {
    const at = Date.parse('2027-01-01T09:00:00Z');
    const m = stripModel(me({ ...MINE, closedDays: dailyCloses(Date.UTC(2026, 0, 1), at) }), null, at);
    expect(m.years).toEqual([2027, 2026]);
    const g = gridFor(m, 2027)!;
    expect(g.endsOn).toBe(Date.UTC(2027, 0, 1));
    expect(observedOf(g)).toEqual([1]);
  });

  it('offers only years it can draw, on every day of a year', () => {
    // The property behind the two dates above, over a year of clocks: a segment
    // that draws nothing is the one thing the year list must never contain.
    const from = Date.UTC(2025, 0, 1);
    for (let at = Date.UTC(2026, 0, 1); at <= Date.UTC(2026, 11, 31); at += 29 * DAY_MS) {
      const m = stripModel(me({ ...MINE, closedDays: dailyCloses(from, at) }), null, at + 9 * 3_600_000);
      expect(m.years.length).toBeGreaterThan(0);
      for (const y of m.years) {
        expect(observedOf(gridFor(m, y)!).length).toBeGreaterThan(0);
      }
    }
  });

  it('draws 366 days for a leap year and 365 for the common year beside it', () => {
    const at = Date.parse('2030-06-15T12:00:00Z');
    const m = stripModel(me({ ...MINE, closedDays: dailyCloses(Date.UTC(2028, 0, 1), at) }), null, at);
    expect(observedOf(gridFor(m, 2028)!)).toHaveLength(366); // 29 February is a day
    expect(observedOf(gridFor(m, 2029)!)).toHaveLength(365);
    expect(gridFor(m, 2028)!.endsOn).toBe(Date.UTC(2028, 11, 31));
  });

  it('keeps a press only while the years on offer still hold it', () => {
    // The years come off the SELECTED people's own closes, so they change under
    // a press: pick 2025 for someone with two years of history and select
    // somebody who started this year, and 2025 is no longer a window anyone can
    // draw. `FlowStrip` clears the press as well as masking it — without the
    // clearing it comes back the moment the first person is selected again.
    expect(yearInView(2025, [2026, 2025])).toBe(2025);
    expect(yearInView(2025, [2026])).toBeNull();
    expect(yearInView(null, [2026, 2025])).toBeNull();
  });
});

describe('pressing the current year repaints days already on screen (#817)', () => {
  /** 606 days to 2026-08-29: a 2025 half holding one 89 and a 2026 half topping
   *  out at 20, so the two windows have different heaviest days — which is the
   *  whole of what a per-year scale changes. */
  const at = Date.parse('2026-08-29T12:00:00Z');
  const busyThenQuiet = Array.from({ length: 606 }, (_, i) => (i < 365
    ? (i === 300 ? 89 : [0, 1, 2, 3, 5, 8, 13, 20, 34][i % 9]!)
    : [0, 1, 2, 3, 5, 8, 13, 20][i % 8]!));
  const m = stripModel(me({ ...MINE, closedDays: busyThenQuiet }), null, at);

  it('draws a subset of the trailing window, not a different span', () => {
    // `gridFor`'s docblock used to argue the opposite — "not a subset of the
    // trailing year, a different span, mostly of different days" — which is true
    // of a PAST year and false of this one. The trailing window opens on the
    // Monday 364 days back, which is on or before 2 January of this year.
    const trailing = new Set(drawnDays(gridFor(m, null)!));
    const thisYear = drawnDays(gridFor(m, 2026)!);
    expect(thisYear).toHaveLength(241);
    expect(thisYear.filter((d) => !trailing.has(d))).toEqual([]);
  });

  it('paints the same counts several shades darker for the press', () => {
    // The cost of the per-year scale, measured rather than asserted: one press,
    // no count anywhere has moved, and the same day is up to 78 points more
    // brand. Kept because the alternative runs the same way and further — a
    // light year decoded by a heavy one is a year reported as quiet — and
    // because a cell answers its own count when it is pointed at.
    const trailing = gridFor(m, null)!.scale;
    const thisYear = gridFor(m, 2026)!.scale;
    expect([5, 8, 20].map((n) => [mixPercent(n, trailing), mixPercent(n, thisYear)]))
      .toEqual([[6, 25], [9, 40], [22, 100]]);
  });
});

describe('the grid at org scope (#817)', () => {
  const org = (metrics: IssueMetrics, logins: string[]) =>
    stripModel({ kind: 'org', metrics, org: ORG, logins }, null, NOW);
  const long = (n: number, len = 400) => Array.from({ length: len }, () => n);

  it('cuts the grid from the org-wide closedDays when nobody is selected', () => {
    const m = org({ ...METRICS, closedDays: long(2) }, []);
    expect(m.window!.days).toHaveLength(400);
    expect(observedOf(m.grid!).every((n) => n === 2)).toBe(true);
    expect(m.years).toEqual([2026, 2025]); // 400 days back from 2026-08-25
  });

  it('sums the selected members’ own closedDays', () => {
    const metrics = {
      ...METRICS,
      closedDays: long(9),
      byMember: [member('a', METRICS.byMember[0]!.days, long(1)), member('b', METRICS.byMember[1]!.days, long(3))],
    } satisfies IssueMetrics;
    // A selection is those people's closes, never the org's — 4, not the 9 the
    // org-wide series carries.
    expect(observedOf(org(metrics, ['a', 'b']).grid!).every((n) => n === 4)).toBe(true);
    expect(observedOf(org(metrics, ['a']).grid!).every((n) => n === 1)).toBe(true);
  });

  it('draws the whole selection or the older window, never a subset of it', () => {
    // `closedDays` is optional across the deploy window, so a mixed rollout can
    // answer for one selected member and not the other. Summing whichever rows
    // carry it drew a lattice about ONE person beside a Throughput tile counting
    // two, with nothing on screen saying so.
    const metrics = {
      ...METRICS,
      byMember: [member('a', METRICS.byMember[0]!.days, long(1)), member('b', METRICS.byMember[1]!.days)],
    } satisfies IssueMetrics;
    const both = org(metrics, ['a', 'b']);
    expect(both.window!.days).toHaveLength(SPAN);       // the 98-day fallback
    expect(both.window!.days.at(-2)).toBe(3);           // a’s 2 and b’s 1: both of them
    expect(both.throughput.n).toBe(3);                  // and the tile beside it agrees
    // Not vacuous: a on their own is drawn from the long history they do have.
    expect(org(metrics, ['a']).window!.days).toHaveLength(400);
  });

  it('refuses a sum of rows that do not describe the same days', () => {
    // Nothing sends this today — one `closedSpan` sizes every row of a payload —
    // and the padding that made it look fine was `?? 0`, which turns a day the
    // shorter row never reached into a day on which nothing closed.
    const metrics = {
      ...METRICS,
      byMember: [member('a', METRICS.byMember[0]!.days, long(1)), member('b', METRICS.byMember[1]!.days, long(1, 300))],
    } satisfies IssueMetrics;
    expect(org(metrics, ['a', 'b']).window!.days).toHaveLength(SPAN);
    expect(org(metrics, ['a']).window!.days).toHaveLength(400);
  });

  it('refuses the Throughput figure when a selected row carries no day series at all', () => {
    // The same silent-subset shape as the grid's rule above, on the tile beside
    // it. A `byMember` row with no `days` pair used to be dropped from the sum,
    // so pressing two people and getting one person's number was indistinguishable
    // from pressing two quiet people — and nothing on screen named who was left
    // out. Refusing gives the tile its no-figure state, which says it could not
    // be read.
    const metrics = {
      ...METRICS,
      byMember: [...METRICS.byMember, { login: 'd', name: 'D', opened: 0, closed: 0 }],
    } as unknown as IssueMetrics;
    expect(org(metrics, ['a', 'd']).throughput.n).toBeNull();
    // Not vacuous: a on their own still reads, and so does the pair that both have one.
    expect(org(metrics, ['a']).throughput.n).not.toBeNull();
    expect(org(metrics, ['a', 'b']).throughput.n).not.toBeNull();
  });

  it('refuses a day series summed from rows of different lengths', () => {
    // The same guard on the series the tiles read: the head of the shorter row
    // is days nobody counted, and a zero there is a claim that they were.
    const metrics = {
      ...METRICS,
      byMember: [...METRICS.byMember, member('c', { opened: zeros(50), closed: zeros(50).fill(1) })],
    } satisfies IssueMetrics;
    expect(org(metrics, ['a', 'c']).throughput.n).toBeNull();
    expect(org(metrics, ['c']).throughput.n).toBe(1); // c alone still reads
  });
});

/**
 * What the strip SAYS, rendered — the vm decides absent-from-zero and only the
 * markup shows whether the component honoured it. The board's test env is
 * `node`, so this is `renderToStaticMarkup` on the real component, the way
 * `DayGrid.spec.tsx` renders the grid. It sits in this file because the strip
 * has no spec of its own and every line asserted below is a property of a model
 * built above.
 */
const strip = (model: StripModel, now = NOW) =>
  // Wrapped, because the sparks hint when they are pointed at (#708) and the
  // board's one styled tooltip needs its provider — the app root holds one
  // (App.tsx), so a component rendered on its own has to bring it.
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(FlowStrip, { model })));

/** Rendered text, tags dropped, so an assertion reads what a person reads. */
const textOf = (markup: string) => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** The headline slot: one per tile that holds a figure, none for a tile that
 *  does not. 27px is the only size `BIG` is set at. */
const headlines = (markup: string) => (markup.match(/text-\[27px\]/g) ?? []).length;

const QUIET = stripModel(me({ ...MINE, throughputDays: ZEROES }), null, NOW);

describe('a tile with no figure says so instead of drawing one', () => {
  it('drops the headline slot rather than setting an em dash at 27px', () => {
    // The tile this was written for was Releases, and #816 replaced it. What it
    // asserted is a rule about the whole strip and not about that tile, so it is
    // pointed at the tile that can still be figureless: the oldest issue.
    //
    // THE UNREAD STATE IS SET ON THE MODEL rather than reached through a scope,
    // and that is the honest way round here. Every scope that leaves the oldest
    // issue unread leaves Issues and Closed unread too — `mineSource` nulls the
    // level and the days on the same error — so a whole-scope construction would
    // assert 0 against 0 and prove nothing about the SLOT. The scope-level rule
    // is a fact about the vm and is asserted on the vm, directly, below.
    const full = stripModel(me({ ...MINE, throughputDays: ZEROES }), DELIVERY, NOW);
    expect(headlines(strip(full))).toBe(3);
    expect(headlines(strip({ ...full, oldest: { kind: 'unread' } }))).toBe(2);
  });

  // The vm half of the same rule: an unread queue is what produces that state,
  // and `MINE_UNAVAILABLE`'s shape — an empty list under a message — is the case
  // that must not read as "nothing is open" about a person.
  it('calls a queue it could not read unread, not empty', () => {
    expect(stripModel({ kind: 'me', mine: MINE, error: 'nope' }, DELIVERY, NOW).oldest)
      .toEqual({ kind: 'unread' });
    expect(stripModel({ kind: 'me', mine: null, error: null }, DELIVERY, NOW).oldest)
      .toEqual({ kind: 'unread' });
  });

  it('names the source that could not be read, and keeps the caption', () => {
    const full = stripModel(me({ ...MINE, throughputDays: ZEROES }), DELIVERY, NOW);
    const text = textOf(strip({ ...full, oldest: { kind: 'unread' } }));
    expect(text).toContain('The oldest Unavailable');
    // The caption is what makes the tile identifiable as the one that could not
    // be read, so a tile with no figure still says what kind of figure is
    // missing.
    expect(text).toContain('The oldest');
  });

  // AND AN EMPTY QUEUE IS NOT AN UNREAD ONE (#816). Both arrive as no issue to
  // name, and only one of them is a fact about the work. This is the same line
  // the top of `flow-strip.vm.ts` draws between absent, empty and zero.
  it('tells a queue with nothing open from a queue nobody could read', () => {
    const empty = stripModel(me({ ...MINE, issues: [] }), DELIVERY, NOW);
    expect(empty.oldest).toEqual({ kind: 'none' });
    const text = textOf(strip(empty));
    expect(text).toContain('Nothing open.');
    // Its OWN sentence, not any sentence: the Closed tile draws its unreadable
    // line over this fixture, and a bare `couldn’t be read` sweep would catch
    // that one and pass whatever this tile said.
    expect(text).not.toContain('The oldest open issue couldn’t be read');
  });

  // ── #816's Done-when, one assertion each ─────────────────────────────────
  //
  // Everything below was TRUE on the branch that shipped #816 and asserted
  // nowhere: the unread/none states were set on the model by hand, and no test
  // walked a scope to an issue. Reversing `olderOf` shipped green.

  /** A github issue URL, so `issuePathFromUrl` resolves a real board path — the
   *  fixture's `https://example.invalid` falls through and returns itself. */
  const GH = (n: number) => `https://github.com/acme/board/issues/${n}`;

  it('names the OLDEST of the queue, never the newest and never the first row', () => {
    // Laid out so head, tail and newest are three different rows: a comparator
    // reversed, or a `reduce` that kept whichever it met first, each names a
    // different one of these three.
    const m = stripModel(me({ ...MINE, issues: [
      issue({ number: 1, ageDays: 12 }),
      issue({ number: 2, ageDays: 77 }),
      issue({ number: 3, ageDays: 40 }),
    ] }), null, NOW);
    expect(m.oldest).toMatchObject({ kind: 'issue', issue: { number: 2, ageDays: 77 } });
    // And it does not depend on the order the queue arrived in.
    const back = stripModel(me({ ...MINE, issues: [
      issue({ number: 3, ageDays: 40 }),
      issue({ number: 2, ageDays: 77 }),
      issue({ number: 1, ageDays: 12 }),
    ] }), null, NOW);
    expect(back.oldest).toMatchObject({ kind: 'issue', issue: { number: 2 } });
  });

  it('breaks a tie by repo then by number, so two same-day issues cannot swap', () => {
    // The tile is redrawn every two minutes off a fresh payload, and Github does
    // not promise a stable order. Without the tie-break the title under the
    // figure changes while the figure does not.
    const sameDay = stripModel(me({ ...MINE, issues: [
      issue({ number: 9, repo: 'zeta', ageDays: 50 }),
      issue({ number: 4, repo: 'alpha', ageDays: 50 }),
    ] }), null, NOW);
    expect(sameDay.oldest).toMatchObject({ kind: 'issue', issue: { repo: 'alpha', number: 4 } });
    const sameRepo = stripModel(me({ ...MINE, issues: [
      issue({ number: 9, ageDays: 50 }),
      issue({ number: 4, ageDays: 50 }),
    ] }), null, NOW);
    expect(sameRepo.oldest).toMatchObject({ kind: 'issue', issue: { number: 4 } });
  });

  describe('the org queue a Crew press narrows to (#816)', () => {
    const AGED = {
      kind: 'ready' as const,
      issues: [
        issue({ number: 20, assignees: ['a'], ageDays: 9 }),
        issue({ number: 21, assignees: ['b'], ageDays: 200 }),
        issue({ number: 22, assignees: ['a', 'b'], ageDays: 30 }),
      ],
    };
    const at = (logins: string[], org: OrgSource = AGED) =>
      stripModel({ kind: 'org', metrics: METRICS, org, logins }, null, NOW);

    it('takes the oldest of the SELECTION, not the org-wide oldest', () => {
      // The 200-day one is b's. Pressing a must not hand a's tile b's issue —
      // and must not hand it a's newest either.
      expect(at([]).oldest).toMatchObject({ kind: 'issue', issue: { number: 21, ageDays: 200 } });
      expect(at(['a']).oldest).toMatchObject({ kind: 'issue', issue: { number: 22, ageDays: 30 } });
      expect(at(['b']).oldest).toMatchObject({ kind: 'issue', issue: { number: 21 } });
      // Two pressed is the union, so the older of the two selections wins.
      expect(at(['a', 'b']).oldest).toMatchObject({ kind: 'issue', issue: { number: 21 } });
    });

    it('agrees with the Issues tile about how many are in that selection', () => {
      // The whole claim of the tile's docblock: one queue, two readings. A filter
      // that narrowed differently here would put "Issues 1" beside somebody
      // else's issue with nothing on screen saying so.
      // Stated as pairs, so a selection that counted right and picked the wrong
      // issue fails here rather than passing two separate assertions.
      const both = (who: string[]) => [at(who).issues.n, (at(who).oldest as { issue: { number: number } }).issue.number];
      expect(both([])).toEqual([3, 21]);
      expect(both(['a'])).toEqual([2, 22]);
      expect(both(['b'])).toEqual([2, 21]);
      expect(both(['a', 'b'])).toEqual([3, 21]);
    });

    it('says nothing open when the selection genuinely holds nothing', () => {
      // Found by NEITHER login rule, so 0 is the true answer and the tile draws
      // the good news rather than a failure.
      const quiet = at(['nobody']);
      expect(quiet.issues.n).toBe(0);
      expect(quiet.oldest).toEqual({ kind: 'none' });
    });

    // ── #866 review: the two tiles must not answer the same queue differently ──
    it('refuses BOTH tiles when the two login rules disagree, never one of them', () => {
      // Reachable from /team?assignee=ivanroslov. The queue spells the login
      // `IvanRoslov`, so the case-sensitive filter matches nothing while the
      // folded one matches — a disagreement about WHO IS SELECTED, and the
      // Issues tile has refused it since #752. The oldest-issue walk applied only
      // the case-sensitive half, so it returned an empty list and the tile said
      // "Nothing open." over a 77-day-old open issue.
      const org = { kind: 'ready' as const, issues: [
        issue({ number: 77, assignees: ['IvanRoslov'], ageDays: 77, htmlUrl: GH(77) }),
      ] };
      const miscased = at(['ivanroslov'], org);
      expect(miscased.issues.n).toBeNull();
      expect(miscased.oldest).toEqual({ kind: 'unread' });
      const text = textOf(strip(miscased));
      expect(text).toContain('The oldest Unavailable');
      expect(text).not.toContain('Nothing open.');

      // NOT VACUOUS: spelled the way the queue spells it, both tiles answer, and
      // the answer is the 77-day issue.
      const spelled = at(['IvanRoslov'], org);
      expect(spelled.issues.n).toBe(1);
      expect(spelled.oldest).toMatchObject({ kind: 'issue', issue: { number: 77, ageDays: 77 } });
    });

    it('refuses both tiles while the org queue is unread, and again when it failed', () => {
      for (const org of [{ kind: 'pending' as const }, { kind: 'failed' as const }]) {
        expect(at(['a'], org).issues.n).toBeNull();
        expect(at(['a'], org).oldest).toEqual({ kind: 'unread' });
      }
    });
  });

  describe('what the tile draws off that issue (#816)', () => {
    const OLD = issue({
      number: 77,
      repo: 'board',
      title: 'the flow strip loses a day at the year boundary',
      ageDays: 77,
      assignees: ['IvanRoslov'],
      htmlUrl: GH(77),
    });
    const markup = strip(stripModel(me({ ...MINE, issues: [OLD] }), null, NOW));

    it('states the AGE as the figure, in the strip’s own headline slot', () => {
      // The figure and not the count of issues, and not the number: #816 asks
      // for how long the longest-open one has been open.
      expect(markup).toMatch(/class="[^"]*text-\[27px\][^"]*"[^>]*>77</);
      expect(textOf(markup)).toContain('77 days');
    });

    it('names the issue, and links it to the board’s own page for it', () => {
      expect(textOf(markup)).toContain(OLD.title);
      expect(markup).toContain(`href="${issuePathFromUrl(GH(77))}"`);
      // The repo and number under it, so a reader can find it without the link.
      expect(textOf(markup)).toContain('board#77');
    });

    it('names who holds it', () => {
      // `AssigneeCluster`, the shared treatment — the avatar is the login's own
      // Github photo, which is what makes this assertion about the person.
      expect(markup).toContain('https://github.com/IvanRoslov.png');
    });

    it('carries the action control every issue row on this board carries', () => {
      expect(markup).toContain('aria-label="Issue actions"');
    });

    it('counts one day as a day', () => {
      const one = strip(stripModel(me({ ...MINE, issues: [issue({ number: 5, ageDays: 1 })] }), null, NOW));
      expect(textOf(one)).toContain('1 day');
      expect(textOf(one)).not.toContain('1 days');
    });
  });

  it('states a counted zero as a zero, never as a failure', () => {
    const text = textOf(strip(QUIET));
    expect(QUIET.throughput.n).toBe(0);
    expect(text).toContain('Closed 0');
    expect(text).not.toContain('Closed issues couldn’t be read just now.');
  });

  it('says what a figure counts in the caption, once (#707, #752, #821)', () => {
    const text = textOf(strip(QUIET));
    // The unit is in the caption and nowhere else: three 27px figures in a row
    // read as three of the same kind of number without it, and said twice it was
    // furniture. `Issues 3 open now` is the shape this replaced.
    //
    // Two captions have since given the unit back up — `Issues` in #752, `Closed`
    // in #821 — and both dropped it HERE on purpose. What each spark's accessible
    // name carries is the other half of that trade, and `struck-copy.spec.tsx`
    // is what holds it: this file pins the words that went, that one pins the
    // answer that has to stay somewhere on the tile.
    expect(text).toContain('Issues 3');
    expect(text).not.toContain('Issues open');
    expect(text).not.toContain('open now');
    expect(text).toContain('Closed 0');
    expect(text).not.toContain('Closed yesterday');
  });

  it('drops the delta entirely, sign and words (#707)', () => {
    // A bare signed delta was drawn and turned down: with the words gone,
    // nothing would say that the Issues delta is since yesterday while
    // Throughput's is yesterday against the day before. So the model stopped
    // deriving one at all rather than keeping a field no tile draws — nothing
    // outside this folder ever read it.
    const m = stripModel(me({ ...MINE, throughputDays: BUSY }), DELIVERY, NOW);
    // Still the whole key set and not a `not.toContain('delta')`: the claim is
    // that the model carries nothing beyond what a tile draws. `endsOn` joined
    // it in #708 — the calendar a spark's points are dated off, set beside the
    // series by the same `sparkDays` that cuts it.
    expect(Object.keys(m.throughput)).toEqual(['n', 'series', 'endsOn']);
    const text = textOf(strip(m));
    for (const words of ['since yesterday', 'vs the day before']) {
      expect(text).not.toContain(words);
    }
  });

  it('drops the spark’s label and its printed range (#707)', () => {
    const m = stripModel(me({ ...MINE, throughputDays: BUSY }), DELIVERY, NOW);
    const text = textOf(strip(m));
    // `Open` / `Closed` / `Released` captioned a shape that needs no caption,
    // and the range restated the figure's own ends.
    expect(text).not.toMatch(/\b\d+–\d+\b/);
    expect(text).not.toContain('Released 0');
  });

  // The "list truncated" note went off the strip with the Releases tile it sat
  // on (#816). It was the one thing beside that figure which was not a
  // restatement of it, and it has no figure left to qualify. `model.releases`
  // still carries `partial`, because `stripModel` is not this issue's to change
  // and a later reader of the delivery payload will want it; nothing draws it.
  it('draws no releases figure at all, so nothing is left to qualify', () => {
    expect(DELIVERY.releasesPartial).toBe(true);
    const text = textOf(strip(stripModel(me(MINE), DELIVERY, NOW)));
    expect(text).not.toContain('list truncated');
    expect(text).not.toContain('Released');
  });
});

/**
 * The figure is one that can be SEEN to change (#824).
 *
 * The board refetches every two minutes, and until now a figure that moved was a
 * different number on the next paint with nothing saying which of the nine had
 * moved. `ui/changed-figure.tsx` marks one that did. Whether the mark is UP or
 * DOWN is decided there and tested there against a pure function, because no
 * effect fires in this environment; what is asserted here is the wiring, which
 * is the half that lives in this file.
 */
describe('the strip draws its figures through the thing that marks a change (#824)', () => {
  const m = stripModel(me({ ...MINE, throughputDays: BUSY }), DELIVERY, NOW);

  it('routes every headline slot through ChangedFigure', () => {
    const markup = strip(m);
    // Three figures on the strip, TWO of which can move (#816). Issues and
    // Closed are counts the two-minute refetch can land differently, and both
    // carry the marker on the same element `headlines` counts. Not `toContain`:
    // a strip that had wired one and left the other bare would pass that.
    //
    // The third is the oldest issue's AGE, and it is deliberately not routed
    // through `ChangedFigure`. An age rises by one every day for as long as the
    // issue is open, so marking it would put a chevron on the tile most mornings
    // and say nothing: the mark means somebody's number moved, and this one moves
    // because time passed. When the OLDEST issue changes, the title and the repo
    // under the figure change with it, which is what a reader actually needs to
    // see, and it is a change of subject rather than of value.
    expect(headlines(markup)).toBe(3);
    expect(markup.match(/figure-moved/g)).toHaveLength(2);
  });

  it('draws no marker on a tile that has no figure to move', () => {
    // The absent case does not become a rise from nothing. The tile draws no
    // number-shaped thing at all, so there is nothing there to mark either.
    // Set on the model for the reason the headline count above gives: a scope
    // that leaves this tile unread leaves the other two unread with it.
    expect(QUIET.oldest.kind).toBe('issue');
    expect(strip({ ...QUIET, oldest: { kind: 'unread' } }).match(/figure-moved/g)).toHaveLength(2);
  });

  it('keeps FlowStrip presentational — the previous value is not in the model', () => {
    // The file's docblock is a promise: it derives nothing the vm did not, and
    // the vm's tile is still exactly the three fields #708 left it with. The
    // memory of what was on screen a moment ago belongs to the component that
    // drew it, not to a fourth field every caller would have to feed.
    expect(Object.keys(m.issues)).toEqual(['n', 'series', 'endsOn']);
    expect(flowStripSource).toMatch(/<ChangedFigure value=\{tile\.n\}/);
    expect(flowStripSource).not.toMatch(/useEffect|useRef/);
  });
});

/**
 * Which tile is about what, and where that comes from (#824).
 *
 * A mark says a figure moved, so the thing drawing it has to know the figure is
 * still about the same subject — and this strip is presentational, so it is told
 * rather than deriving it. Nothing here can drive the mark itself: the mark is
 * raised from an effect and no effect fires in this environment, and
 * `changed-figure.spec.tsx` drives the decision as a pure
 * function. What is asserted here is the wiring, which is the half that lives in
 * this file, read off the source the way `keeps FlowStrip presentational` above
 * reads it.
 */
describe('what each tile is about, and who says so (#824)', () => {
  /** The `<Tile …/>` call sites, whole. TWO since #816: the third slot is
   *  `<OldestTile/>`, which is a different component and a different shape. */
  const tiles = [...flowStripSource.matchAll(/<Tile\b[\s\S]*?\/>/g)].map((t) => t[0]);

  it('found the call sites it is judging, so an empty match cannot pass', () => {
    expect(tiles).toHaveLength(2);
    expect(tiles.map((t) => /cap="([^"]*)"/.exec(t)![1]))
      // `Closed` and not `Closed yesterday`: #857 moved the day off the caption
      // and into the spark. What this pins is which tiles exist and in what
      // order, so the assertion below can name them; the wording is that file's
      // to change and this follows it.
      .toEqual(['Issues', 'Closed']);
  });

  // The third slot is drawn and it is NOT a `Tile` (#816). Without this the two
  // assertions above pass just as well over a strip that lost its third slot
  // entirely, which is the hole #815 forbids one page down.
  it('draws the third slot, as the other shape', () => {
    // `note` is the copy line (#1046), which the tile carries beside its caption.
    expect(flowStripSource).toMatch(/<OldestTile view=\{model\.oldest\}[^>]*\/>/);
  });

  it('gives every tile a subject, so none is left comparing a number to nothing', () => {
    for (const t of tiles) expect(t, t).toMatch(/\bsubject=\{/);
  });

  // The two that re-scope take the caller's word. TeamView narrows them to a
  // pressed Crew card and holds that selection already; this component reads no
  // URL and knows no login, so it cannot work the subject out and must not try.
  it('takes the caller’s subject for the two tiles a Crew press re-scopes', () => {
    const fromCaller = tiles.filter((t) => /subject=\{subject\}/.test(t));
    expect(fromCaller.map((t) => /cap="([^"]*)"/.exec(t)![1]))
      .toEqual(['Issues', 'Closed']);
  });

  // Releases used to be the third, and took its subject off the model because a
  // press does not re-scope it. That tile is gone (#816) and the tile in its slot
  // needs no subject at all: it states an age, and the issue the age belongs to
  // is named underneath it, so a reader can see for themselves when the subject
  // changed. There is no silent renumbering for a mark to have to disambiguate.
  it('gives the third slot no subject, because it names its own', () => {
    expect(flowStripSource).not.toMatch(/<OldestTile[^>]*subject=/);
  });

  // The subject is not derived here and not remembered here. `useEffect|useRef`
  // above is the memory half; this is the derivation half.
  it('derives no subject of its own', () => {
    expect(flowStripSource).not.toMatch(/subject = /);
  });
});

/** The spark window must not shorten the grid's independent history. */
describe('a spark draws sixty days, and the grid does not (#873)', () => {
  const REAL = series([{ opened: 0, closed: 0 }, { opened: 0, closed: 0 }, { opened: 2, closed: 1 }]);
  const m = stripModel(me({ ...MINE, throughputDays: REAL }), DELIVERY, NOW);

  it('draws sixty days on every spark, off a payload holding 98', () => {
    expect(REAL.closed).toHaveLength(SPAN);
    expect(m.issues.series).toHaveLength(60);
    expect(m.throughput.series).toHaveLength(60);
    expect(m.releases.series).toHaveLength(60);
  });

  it('keeps the two tiles ending a day apart, which is #734’s rule and not this one', () => {
    // The constraint the issue names: the Issues figure is a level standing
    // today, Closed is a count that stops a day earlier. A window applied
    // BEFORE the figure-day trim would give both the same last day and pass the
    // length test above.
    expect(m.issues.endsOn).toBe(NOW - NOW % DAY_MS);
    expect(m.throughput.endsOn).toBe(NOW - NOW % DAY_MS - DAY_MS);
    expect(m.issues.series).toEqual(dailyDepth(3, REAL.opened, REAL.closed).slice(-60));
    expect(m.throughput.series).toEqual(REAL.closed.slice(-61, -1));
  });

  it('is a TAIL, so the last day is still the day the figure is for', () => {
    expect(m.issues.series!.at(-1)).toBe(m.issues.n);
    expect(m.throughput.series!.at(-1)).toBe(m.throughput.n);
  });

  it('draws what it has when the payload holds fewer than sixty days', () => {
    const short = { opened: zeros(10), closed: zeros(10).map((_, i) => i) };
    const s = stripModel(me({ ...MINE, throughputDays: short }), null, NOW);
    expect(s.throughput.series).toHaveLength(9); // 10, less today
  });

  it('leaves the grid on a whole year — 52 settled weeks plus the running one', () => {
    // #820's assertion, and it is the one that fails if the spark window is
    // applied in `stripModel` rather than in `sparkDays`. #817 widened what it
    // is measuring: 364 settled slots in 52 columns rather than 91 in 13, so
    // the gap between the two spans is a year against sixty days instead of a
    // quarter against sixty. The slots are counted, not the cells — this
    // payload holds 98 days, so most of the year is drawn as nothing at all,
    // which is exactly the state the grid is supposed to survive.
    const grid = gridFor(m, null)!;
    expect(grid).not.toBeNull();
    const slots = grid.weeks.reduce((n, w) => n + w.length, 0);
    expect(grid.weeks.length).toBeGreaterThanOrEqual(52);
    expect(slots).toBeGreaterThanOrEqual(364);
    // And the sparks beside it still hold sixty, which is the whole point.
    expect(m.throughput.series).toHaveLength(60);
  });

  it('says sixty in the chart’s own accessible name', () => {
    const markup = strip(m);
    expect(markup).toContain('over the 60 days to');
    expect(markup).not.toContain('over the 98 days to');
  });
});

/**
 * The three surfaces held two rules about today: the tiles stated yesterday, the
 * grid drew through yesterday, and both sparks drew the whole 98-day series with
 * today in it. So the rightmost bar under the Closed tile was today's PARTIAL
 * count sitting under a figure that was yesterday's, and just after UTC midnight
 * it is near zero — the tile reading as a collapse that has not happened.
 */
describe('a spark ends on the day its own tile’s figure is for (#734)', () => {
  /** Every bar a `ColumnSpark` drew, tallest-relative height and all. */
  const barHeights = (markup: string) =>
    [...markup.matchAll(/height:([\d.]+)%;background:var\(--chart-series\)/g)].map((m) => Number(m[1]));
  /** Every point a `DepthSpark` drew. */
  const depthPoints = (markup: string) => (markup.match(/<polyline points="([^"]+)"/)?.[1] ?? '').split(' ').length;

  // Today closed 99, more than any other day in the span, and yesterday closed
  // more than any day before it. Drawn, today's bar would be the full-height one
  // and every other day would shrink against it.
  const TODAY_SPIKE = zeros().map((_, i) => (i === SPAN - 1 ? 99 : i === SPAN - 2 ? 7 : i % 5));
  const spiked = strip(stripModel(me({ ...MINE, throughputDays: { opened: zeros(), closed: TODAY_SPIKE, exited: TODAY_SPIKE } }), null, NOW));

  it('ends every spark on the day the figure above it is for', () => {
    // ONE RULE, TWO ANSWERS, because the tiles state two kinds of number. A
    // count of events in a day is partial until the day ends, so Closed and
    // Released stop at yesterday — the day `tail` states. A level is complete at
    // every instant, so Issues open runs to today, the day its own figure is
    // for. The last point of each spark IS the tile's figure.
    const m = stripModel(me({ ...MINE, throughputDays: series([{ opened: 0, closed: 0 }, { opened: 0, closed: 0 }, { opened: 2, closed: 1 }]) }), DELIVERY, NOW);
    expect(m.issues.series!.at(-1)).toBe(m.issues.n);
    expect(m.throughput.series!.at(-1)).toBe(m.throughput.n);
    expect(m.releases.series!.at(-1)).toBe(m.releases.n);
    expect(m.issues.series).toHaveLength(SPARK_DAYS);
    expect(m.throughput.series).toHaveLength(SPARK_DAYS);
    expect(m.releases.series).toHaveLength(SPARK_DAYS);
  });

  it('draws one mark per day it holds, counted off the page', () => {
    // Delivery is absent here, so the only ColumnSpark on the page is
    // Throughput's and the count is unambiguous.
    expect(barHeights(spiked)).toHaveLength(SPARK_DAYS);
    expect(depthPoints(spiked)).toBe(SPARK_DAYS);
  });

  it('never lets today’s partial count set a spark’s scale', () => {
    const heights = barHeights(spiked);
    // Yesterday's 7 is the tallest day the spark holds, so it is the full-height
    // bar and every other day is measured against it: a day that closed 4 is
    // drawn at four sevenths. Against today's 99 that same day was 4% of the box
    // and the whole shape read flat — which is the second cost of drawing a day
    // that is still being counted, after the misread figure.
    expect(heights.at(-1)).toBe(100);
    expect(Math.max(...heights.slice(0, -1))).toBeCloseTo((4 / 7) * 100, 6);
  });

  it('leaves the grid drawing on a Sunday, when the cut series is a week short', () => {
    // Which day the grid ends on is cut from the WHOLE series, and it has to be:
    // the slice counts back from today to find the running week's Monday. Read
    // off a tile's series instead — one day shorter since the cut above — a
    // Sunday's 97 days no longer fill 13 whole weeks plus a running one, the
    // slice answers nothing, and the whole lattice disappears with only the line
    // under it left standing. Sunday is the one weekday that does it, which is
    // why nothing else here would have caught it.
    const sunday = Date.parse('2026-08-23T12:00:00Z');
    const m = stripModel(me({ ...MINE, throughputDays: ZEROES }), null, sunday);
    // 52 whole weeks and seven running days, of which the 98 the series reaches
    // are the ones that draw a cell.
    expect(m.grid!.weeks.reduce((acc, w) => acc + w.length, 0)).toBe(52 * 7 + 7);
    expect((strip(m, sunday).match(/data-day=/g) ?? []).length).toBe(98);
  });

  it('dates each spark to the same day it ends on', () => {
    // The calendar rides on the tile beside the series, cut by the same
    // `sparkDays` (#708). Two answers again, and they are the two the rule
    // above already gives: a level runs to today, a count stops at yesterday.
    // Derived here rather than restated — a hardcoded date would go stale and
    // a second copy of the arithmetic would be the drift this guards against.
    const m = stripModel(me({ ...MINE, throughputDays: BUSY }), DELIVERY, NOW);
    const today = Math.floor(NOW / DAY_MS) * DAY_MS;
    expect(m.issues.endsOn).toBe(today);
    expect(m.throughput.endsOn).toBe(today - DAY_MS);
    expect(m.releases.endsOn).toBe(today - DAY_MS);
    // The grid includes today while the count tiles stay on yesterday.
    expect(m.grid!.endsOn).toBe(today);
  });

  it('holds no calendar for a tile that holds no days', () => {
    // Set together or not at all: a date with no series under it would be a
    // fact about days nothing draws.
    const m = stripModel(me({ ...MINE, throughputDays: { opened: [0, 0], closed: [4, 99], exited: [4, 99] } }), null, NOW);
    expect(m.throughput.series).toBeNull();
    expect(m.throughput.endsOn).toBeNull();
    expect(m.releases.series).toBeNull();
    expect(m.releases.endsOn).toBeNull();
  });

  it('draws no spark at all when a tile is left with a single day', () => {
    // One point is a dot, and a one-bar ColumnSpark is a full-height bar
    // whatever it counts — neither is an honest shape, so the tile says it has
    // no daily history and keeps stating the figure it does have. Two days of
    // payload is exactly where the two answers separate: the count tile drops
    // today and is left with one, the level tile keeps both.
    const m = stripModel(me({ ...MINE, throughputDays: { opened: [0, 0], closed: [4, 99], exited: [4, 99] } }), null, NOW);
    expect(m.throughput.n).toBe(4); // yesterday, and it is still stated
    expect(m.throughput.series).toBeNull();
    expect(m.issues.series).toHaveLength(2);
    expect(textOf(strip(m))).toContain('No daily history');
  });
});

describe('the year switcher, rendered (#817)', () => {
  const at = Date.parse('2026-08-29T12:00:00Z');
  const TWO = stripModel(me({ ...MINE, closedDays: twoYears() }), null, at);
  const ONE = stripModel(me({ ...MINE, closedDays: Array.from({ length: 200 }, () => 1) }), null, at);
  /** Every native radio segment, in order, with its selected state. */
  const segments = (markup: string) =>
    [...markup.matchAll(/aria-checked="(true|false)"[^>]*>([^<]+)</g)].map((m) => [m[2], m[1]]);

  it('draws one segment per year behind the trailing window, which is pressed', () => {
    // The behaviour behind `useState<YearChoice>`, which a source regex passes
    // over even where the control renders nothing at all.
    expect(segments(strip(TWO, at)))
      .toEqual([['Last 12 months', 'true'], ['2026', 'false'], ['2025', 'false']]);
  });

  it('draws no control at all over one year of history', () => {
    // A control offering the year you are already looking at is furniture, and
    // this is the state the live board is in until January 2027.
    expect(ONE.years).toEqual([2026]);
    expect(segments(strip(ONE, at))).toEqual([]);
    expect(textOf(strip(ONE, at))).not.toContain('Last 12 months');
  });

  it('keeps the range in the grid label without drawing the struck caption (#950)', () => {
    // The range remains in the group name for screen-reader date truth, but the
    // separate sighted line under Issues closed was marked for removal.
    const markup = strip(QUIET);
    expect(markup).toContain('aria-label="Issues closed, 98 days to Tue 25 Aug"');
    expect(markup).not.toMatch(/<p[^>]*>98 days to Tue 25 Aug<\/p>/);
  });

  it('moves the span with the year switcher, because the pressed span is what the grid '
    + 'is actually cut to', () => {
    // The trailing window is pressed on first paint, so the span is the trailing
    // one: 606 days of history cut to 52 whole weeks plus the running week
    // through today, which is 370 observed days ending Sat 29 Aug. The year
    // segments are drawn beside it, and the span is the one on the left of them.
    expect(textOf(strip(TWO, at))).not.toContain('370 days to Sat 29 Aug');
    expect(strip(TWO, at)).toContain('aria-label="Issues closed, 370 days to Sat 29 Aug"');
  });

  it('names the lattice for a reader who cannot see it', () => {
    // The block's own caption and the span, the sentence `sparkTitle` gives each
    // spark. Without it the grid is an unnamed group of 367 buttons, and the
    // twelve month labels inside it were read out in front of the first one.
    expect(strip(QUIET)).toContain('role="group" aria-label="Issues closed, 98 days to Tue 25 Aug"');
  });
});

describe('the line under the grid (#707, #709)', () => {
  const cells = (markup: string) => (markup.match(/data-day=/g) ?? []).length;

  it('answers "why is this empty" over a grid that stays drawn', () => {
    // Uniformly zero cells are the form factor of a skeleton loader, and the
    // block has no loading state a reader could tell it from.
    const markup = strip(QUIET);
    expect(cells(markup)).toBe(98);
    expect(textOf(markup)).toContain('Nothing closed on any of these 98 days.');
  });

  it('counts the days the series REACHES, not the days the grid draws (#817)', () => {
    // The 52-week window is four times longer than the payload, so most of the
    // grid is months nobody watched — drawn as nothing, and not quiet. The
    // count is 98 whatever the weekday. Monday starts the running column.
    const columns = (markup: string) => (markup.match(/data-week=/g) ?? []).length;
    const tuesday = strip(QUIET);
    const monday = Date.parse('2026-08-24T12:00:00Z');
    const mondayMarkup = strip(stripModel(me({ ...MINE, throughputDays: ZEROES }), null, monday), monday);
    expect(columns(tuesday)).toBe(53);
    expect(columns(mondayMarkup)).toBe(53);
    expect(cells(mondayMarkup)).toBe(98);
    expect(textOf(mondayMarkup)).toContain('Nothing closed on any of these 98 days.');
  });

  it('never counts an unobserved day as a quiet one', () => {
    // The line would otherwise read "Nothing closed on any of these 366 days"
    // over a board whose oldest issue is five months old. It is only worth
    // running because the grid really does draw that many slots.
    const markup = strip(QUIET);
    expect(QUIET.grid!.weeks.reduce((acc, w) => acc + w.length, 0)).toBe(52 * 7 + 2);
    expect(textOf(markup)).not.toContain('365 days');
    expect(textOf(markup)).not.toContain('366 days');
  });

  it('says NOTHING at all under a grid that has something in it', () => {
    // A line that restates the number beside it goes. "Whole weeks, ending last
    // Sunday. Shades are quartiles over every day in the window." said what the
    // grid draws and how it is shaded, and pointing at a day answers both.
    const busy = strip(stripModel(me({ ...MINE, throughputDays: BUSY }), null, NOW));
    expect(textOf(busy)).not.toContain('Whole weeks');
    expect(textOf(busy)).not.toContain('quartiles');
    // No element and no empty span, so nothing to describe the grid by either.
    expect(busy).not.toContain('flow-grid-note');
    expect(busy).not.toContain('aria-describedby');
  });

  it('never claims yesterday is missing, because it no longer is', () => {
    // The clause was true when the grid ended on the last complete Sunday, and
    // it was checked rather than assumed — on a Monday yesterday WAS drawn. The
    // running week is drawn every day now, so the clause is false every day.
    for (const day of ['2026-08-24', '2026-08-25', '2026-08-29', '2026-08-23']) {
      const at = Date.parse(`${day}T12:00:00Z`);
      const text = textOf(strip(stripModel(me({ ...MINE, throughputDays: ZEROES }), null, at), at));
      expect(text).toContain('Nothing closed on any of these');
      expect(text).not.toContain('isn’t in them yet');
    }
  });
});

describe('Overview scoped oldest and unique closes (#903, #913)', () => {
  it('narrows only oldest by owner and intersects Crew while preserving the union issue count', () => {
    const org: OrgSource = { kind: 'ready', issues: [
      issue({ number: 1, owner: 'other', ageDays: 90 }),
      issue({ number: 2, owner: 'acme', ageDays: 30 }),
      issue({ number: 3, owner: 'acme', ageDays: 50, assignees: ['b'] }),
    ] };
    const scope: Scope = { kind: 'org', org, metrics: METRICS, logins: ['a'], owner: 'ACME' };
    const selected = stripModel(scope, null, NOW);
    expect(selected.oldest).toMatchObject({ kind: 'issue', issue: { number: 2 } });
    expect(selected.issues.n).toBe(2);
    expect(stripModel({ ...scope, owner: null }, null, NOW).oldest).toMatchObject({ kind: 'issue', issue: { number: 1 } });
    expect(stripModel({ ...scope, owner: 'missing' }, null, NOW).oldest).toEqual({ kind: 'none' });
  });

  it('counts a shared close once for multiple Crew members and keeps unassigned closes in the union', () => {
    const m: IssueMetrics = { ...METRICS, computedAt: new Date(NOW).toISOString(),
      closedDays: [0, 2, 0], days: { opened: [0, 0, 0], closed: [0, 2, 0] },
      byMember: ['a', 'b'].map((login) => member(login, { opened: [0, 0, 0], closed: [0, 1, 0] }, [0, 1, 0])),
      closeEvents: [
        { htmlUrl: 'shared', closedAt: '2026-08-24T12:00:00Z', assignees: ['a', 'b'] },
        { htmlUrl: 'unassigned', closedAt: '2026-08-24T12:00:00Z', assignees: [] },
      ],
    };
    const selected = stripModel({ kind: 'org', org: ORG, metrics: m, logins: ['a', 'b'] }, null, NOW + DAY_MS);
    expect(selected.throughput.n).toBe(1);
    expect(selected.grid?.endsOn).toBe(Date.UTC(2026, 7, 25));
    expect(stripModel({ kind: 'org', org: ORG, metrics: m, logins: [] }, null, NOW).throughput.n).toBe(2);
  });
});

describe('the me-scope grid is dated by the payload, not by the reader’s clock (#1015)', () => {
  /** Your work's closes, with the snapshot stamp the grid has to date them by.
   *  Three days ending on `computedAt`, enough to catch a one-day slip. */
  const dated = (computedAt: string): PersonalIssues => ({
    ...MINE, computedAt, closedDays: [0, 5, 0],
  });

  it('dates the grid off computedAt when the caller’s clock has moved on a day', () => {
    const model = stripModel({ kind: 'me', mine: dated('2026-08-25T12:00:00Z'), error: null }, null, NOW + DAY_MS);
    expect(model.grid?.endsOn).toBe(Date.UTC(2026, 7, 25));
    expect(observedOf(model.grid!)).toEqual([0, 5, 0]);
  });

  it('holds a two-day-stale cached payload on its own days rather than sliding it forward', () => {
    const model = stripModel({ kind: 'me', mine: dated('2026-08-25T12:00:00Z'), error: null }, null, NOW + 2 * DAY_MS);
    expect(drawnDays(model.grid!)).toEqual([Date.UTC(2026, 7, 23), Date.UTC(2026, 7, 24), Date.UTC(2026, 7, 25)]);
  });

  it('falls back to the caller’s clock against a board-api that predates the stamp', () => {
    // The MIXED-ROLLOUT case, which is the one with a series in it: board-web
    // ships before board-api, so a payload arrives with `closedDays` and no
    // `computedAt`. There is no anchor to prefer, and the caller's clock is the
    // only one there is. (`MINE_UNAVAILABLE` is a different shape and never
    // reaches this assertion — it carries no series, so `stripModel` answers
    // `grid: null` and there is nothing to date.)
    const model = stripModel({ kind: 'me', mine: { ...MINE, closedDays: [0, 5, 0] }, error: null }, null, NOW);
    expect(model.grid?.endsOn).toBe(Date.UTC(2026, 7, 25));
  });

  it('keeps the caller’s clock when the stamp is unparseable, rather than dating every cell NaN', () => {
    // The one behaviour this change alters on the ORG branch, and the line most
    // likely to be "simplified" back to a bare `Date.parse`. Before the guard, a
    // malformed stamp set `now = NaN`, and every day of the grid and every spark
    // dated off it went undefined while the suite stayed green.
    const m: IssueMetrics = { ...METRICS, computedAt: 'not-a-date', closedDays: [0, 5, 0] };
    const model = stripModel({ kind: 'org', org: ORG, metrics: m, logins: [] }, null, NOW);
    expect(model.grid?.endsOn).toBe(Date.UTC(2026, 7, 25));
    expect(Number.isNaN(model.grid?.endsOn as number)).toBe(false);
  });
});

describe('the strip counts the closes board-api sent, and defines none of its own (#1014)', () => {
  /** A three-day payload whose per-member series says FIVE closes on the middle
   *  day, so a figure of 5 means the summed rows were read and a figure of 2
   *  means the event list was. */
  const metrics = (closeEvents?: IssueMetrics['closeEvents']): IssueMetrics => ({
    ...METRICS,
    computedAt: new Date(NOW).toISOString(),
    closedDays: [0, 5, 0],
    days: { opened: [0, 0, 0], closed: [0, 5, 0] },
    byMember: [member('a', { opened: [0, 0, 0], closed: [0, 5, 0] }, [0, 5, 0])],
    ...(closeEvents === undefined ? {} : { closeEvents }),
  });

  it('rebuilds a selection’s series from every event in the list, applying no reason rule of its own', () => {
    // `closeEvents` is filtered server-side by `deliveredCloseAt` before it is
    // sent (`issues-metrics.vm.ts`), which is what makes this rebuild inherit
    // #1014 for nothing. Both closes below are counted, and the shape assertion
    // is the tripwire: an independent definition on this side would need a
    // reason on the wire to read, and there is none.
    const m = metrics([
      { htmlUrl: 'one', closedAt: '2026-08-24T12:00:00Z', assignees: ['a'] },
      { htmlUrl: 'two', closedAt: '2026-08-24T13:00:00Z', assignees: ['a'] },
    ]);
    const model = stripModel({ kind: 'org', org: ORG, metrics: m, logins: ['a'] }, null, NOW + DAY_MS);
    expect(model.throughput.n).toBe(2);
    expect(Object.keys(m.closeEvents![0]!).sort()).toEqual(['assignees', 'closedAt', 'htmlUrl']);
  });

  it('sums the member rows unchanged where the payload carries no events', () => {
    // `orgSeries`, the other rebuild: it adds up `byMember`, and every one of
    // those series was counted by `deliveredCloseAt` server-side too. Five, not
    // two — this path never sees an event list.
    const model = stripModel({ kind: 'org', org: ORG, metrics: metrics(), logins: ['a'] }, null, NOW + DAY_MS);
    expect(model.throughput.n).toBe(5);
  });
});

describe('the queue-depth walk counts EXITS, not deliveries (#1014)', () => {
  it('adds an abandoned close back to the level, so the days before it are not drawn low', () => {
    // The regression #1014 introduced and this pins: an issue closed as
    // not-planned left the open queue, and `openNow` already excludes it. Walk
    // the DELIVERED series instead and it is never added back, so every day to
    // the left of it sits one issue low and the error compounds across the
    // window rather than cancelling.
    const opened = [0, 0, 0];
    // Three days, 5 open now. The last day delivered nothing but ABANDONED one,
    // and the middle day delivered one — so two issues left the queue over the
    // window and the level three days ago was 7.
    expect(dailyDepth(5, opened, [0, 1, 1])).toEqual([7, 6, 5]);
    // The same window walked on DELIVERIES loses the abandoned exit entirely and
    // reads 6 where the queue really held 7, on both of the days left of it.
    expect(dailyDepth(5, opened, [0, 1, 0])).toEqual([6, 5, 5]);
  });

  it('refuses the walk rather than falling back to deliveries when board-api sent no exits', () => {
    // A board-api predating the field carries `closed` alone. Walking that is
    // the wrong line drawn confidently; no line is the strip's honest answer,
    // and it is the one `present` already gives for every other absent series.
    const noExits = stripModel(
      { kind: 'me', mine: { ...MINE, throughputDays: { opened: zeros(), closed: zeros() } }, error: null },
      null,
      NOW,
    );
    expect(noExits.issues.series).toBeNull();
    // …and the tile still states the level it does hold.
    expect(noExits.issues.n).toBe(3);
  });
});

describe('today’s closed count', () => {
  it.each([
    ['2026-08-30T23:59:59Z', 'Sun 30 Aug'],
    ['2026-08-30T17:00:00-07:00', 'Mon 31 Aug'],
    ['2026-12-31T17:00:00-07:00', 'Fri 1 Jan'],
  ])('renders the latest UTC day on My work and Overview at %s', (computedAt, label) => {
    const now = Date.parse(computedAt);
    const closedDays = [3, 7];
    const scopes: Scope[] = [
      me({ ...MINE, computedAt, closedDays }),
      { kind: 'org', metrics: { ...METRICS, computedAt, closedDays }, org: ORG, logins: [] },
    ];
    for (const scope of scopes) {
      const model = stripModel(scope, null, now);
      expect(strip(model, now)).toContain(`aria-label="${label}, 7 closed"`);
      expect(model.grid!.weeks.at(-1)!.at(-1)).toBe(7);
      const year = new Date(now).getUTCFullYear();
      expect(model.years).toContain(year);
      expect(gridFor(model, year)!.weeks.at(-1)!.at(-1)).toBe(7);
    }
  });
});

describe('viewer time-zone anchors', () => {
  it.each(['me', 'org'] as const)('ends %s on the snapshot date in Berlin', (kind) => {
    const computedAt = '2026-09-25T22:30:00Z';
    const scope: Scope = kind === 'me'
      ? { kind, error: null, mine: { ...MINE, throughputDays: ZEROES, computedAt, timeZone: 'Europe/Berlin' } }
      : { kind, metrics: { ...METRICS, computedAt, timeZone: 'Europe/Berlin' }, org: { kind: 'ready', issues: [] }, logins: [] };
    expect(stripModel(scope, null, Date.parse(computedAt)).grid?.endsOn).toBe(Date.UTC(2026, 8, 26));
  });
});

it('recounts shared selected-member closes in the viewer zone', () => {
  const computedAt = '2026-09-26T12:00:00Z';
  const metrics: IssueMetrics = { ...METRICS, computedAt, timeZone: 'Europe/Berlin',
    closedDays: [0, 1], days: { opened: [0, 0], closed: [0, 1] },
    byMember: ['a', 'b'].map(login => member(login, { opened: [0, 0], closed: [0, 1] }, [0, 1])),
    closeEvents: [{ htmlUrl: 'shared', closedAt: '2026-09-25T22:30:00Z', assignees: ['a', 'b'] }],
  };
  const model = stripModel({ kind: 'org', metrics, org: ORG, logins: ['a', 'b'] }, null, Date.parse(computedAt));
  expect(model.throughput.n).toBe(0);
  expect(model.window?.days).toEqual([0, 1]);
});
