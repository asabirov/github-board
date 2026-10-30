/**
 * The three stat-tile sparks answer when they are pointed at (#708).
 *
 * The board's test env is `node` and there is no DOM: a pointer cannot be moved
 * at anything and `getBoundingClientRect` answers zeros. So this file works the
 * way `DayGrid.spec.tsx` beside it does — the derivations are pure functions
 * driven directly, and the shape they produce is read off
 * `renderToStaticMarkup`'s string. The marked state is rendered by handing the
 * chart components a `mark`, which is why they are exported.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '../ui/kit';
import { ColumnSpark, DepthSpark, FlowStrip } from './FlowStrip';
import {
  DAY_MS,
  dateLabel,
  sparkDay,
  sparkPointSentence,
  sparkTitle,
  type SparkUnit,
  type StripModel,
} from './flow-strip.vm';
import dayGridSource from './DayGrid.tsx?raw';
import flowStripSource from './FlowStrip.tsx?raw';

/** Saturday 22 Aug 2026, UTC midnight — the date `cellSentence`'s own docblock
 *  names, so the two sentences can be read side by side. */
const SAT = Date.UTC(2026, 7, 22);

const OPEN: SparkUnit = { chart: 'Open issues', word: 'issues open', reading: 'level' };
const CLOSED: SparkUnit = { chart: 'Issues closed per day', word: 'closed', reading: 'count' };
const RELEASED: SparkUnit = { chart: 'Released each day', word: 'released', reading: 'count' };

describe('a spark point knows WHICH day it is (#708)', () => {
  // `flow-strip.vm.ts` hands a tile a bare number[] with no calendar on it, so
  // until #708 a spark could not say which day a point was. `endsOn` is the one
  // fact that dates every point, and it is set where `sparkDays` is applied —
  // the one place that knows whether a tile's figure is for today or yesterday.
  it('dates the last point as the day the spark ends on', () => {
    expect(sparkDay(SAT, 10, 9)).toBe(SAT);
  });

  it('counts back one UTC day per point, the way DayGrid dates a cell', () => {
    expect(sparkDay(SAT, 10, 8)).toBe(SAT - DAY_MS);
    expect(sparkDay(SAT, 10, 0)).toBe(SAT - 9 * DAY_MS);
    // The arithmetic is `endsOn - (len - 1 - i) * DAY_MS`, which is exactly
    // `DayGrid`'s `dayOf`. A spark of a different length ending on the same day
    // still dates its last point that day.
    expect(sparkDay(SAT, 97, 96)).toBe(SAT);
    expect(sparkDay(SAT, 97, 0)).toBe(SAT - 96 * DAY_MS);
  });
});

describe('the date is named in ONE place for the grid and the sparks (#708)', () => {
  it('names a UTC day the way the grid’s cells do', () => {
    expect(dateLabel(SAT)).toBe('Sat 22 Aug');
    expect(dateLabel(Date.UTC(2026, 0, 1))).toBe('Thu 1 Jan');
    expect(dateLabel(Date.UTC(2026, 11, 31))).toBe('Thu 31 Dec');
  });

  // It reads the UTC parts, not the local ones: every day on this board is a UTC
  // day, and a local-time reading names a different date west of Greenwich for
  // the whole evening.
  it('names the UTC day whatever the hour', () => {
    expect(dateLabel(SAT + 23 * 3600_000)).toBe('Sat 22 Aug');
  });

  // The hoist itself. `DayGrid` had its own copy of this function; two copies of
  // a date format is how the grid and the sparks come to name a day two ways.
  it('leaves DayGrid with no date format of its own', () => {
    expect(dayGridSource).not.toMatch(/const dateLabel =/);
    expect(dayGridSource).toMatch(/dateLabel/); // it still names dates — with the vm's
  });
});

describe('what one point READS, in words (#708)', () => {
  // "Issues open" is a LEVEL held that day; its two neighbours are COUNTS of
  // things that happened in it. Three 27px figures in a row are not three of the
  // same kind of number, and the sentence under a pointer must not pretend they
  // are — so the tile passes its own noun down and the level/count grammar
  // follows it.
  const series = [4, 0, 7];

  it('names the date and the reading, the way a grid cell does', () => {
    expect(sparkPointSentence(series, SAT, 2, CLOSED)).toBe('Sat 22 Aug, 7 closed');
    expect(sparkPointSentence(series, SAT, 0, CLOSED)).toBe('Thu 20 Aug, 4 closed');
  });

  it('reports a zero day rather than going silent', () => {
    // `ColumnSpark` draws NOTHING for a zero day, and the Releases spark's last
    // month is all zero — so the mark lands on a column with no bar and the
    // words are the whole of what the reader gets. This is the ordinary case on
    // that tile, not an edge one.
    expect(sparkPointSentence(series, SAT, 1, CLOSED)).toBe('Fri 21 Aug, nothing closed');
    expect(sparkPointSentence(series, SAT, 1, RELEASED)).toBe('Fri 21 Aug, nothing released');
  });

  it('says a level as a standing, never as an event count', () => {
    // "4 open" beside "4 closed" reads as four issues OPENED that day, which is
    // a falsehood about a depth series: the number is how many stood open. The
    // noun leads for that reason.
    expect(sparkPointSentence(series, SAT, 2, OPEN)).toBe('Sat 22 Aug, 7 issues open');
  });

  it('keeps the number on a level that reads zero', () => {
    // A count of zero is an absence — nothing happened. A level of zero is a
    // reading: the line touches its floor and that IS the measurement, so it
    // keeps its digit rather than borrowing the count's "nothing".
    expect(sparkPointSentence(series, SAT, 1, OPEN)).toBe('Fri 21 Aug, 0 issues open');
  });
});

describe('what the WHOLE chart shows, for a reader who cannot see it (#708)', () => {
  it('names the measure, the span and the day it ends on', () => {
    expect(sparkTitle([1, 2, 3], SAT, CLOSED)).toBe('Issues closed per day, over the 3 days to Sat 22 Aug');
    expect(sparkTitle([1, 2, 3], SAT, RELEASED)).toBe('Released each day, over the 3 days to Sat 22 Aug');
  });

  it('says a level chart is a level', () => {
    expect(sparkTitle([1, 2, 3], SAT, OPEN)).toBe('Open issues, over the 3 days to Sat 22 Aug');
  });

  // #818. This sentence used to be `Closed each day — 3 days to Sat 22 Aug`,
  // which is two labels bolted together, and it is the string Artur quoted when
  // he read the board's tooltips as machine-written. It is not the point
  // readout's `<when>, <reading>` grammar and never was: it names a WHOLE
  // chart, and it had borrowed the point sentence's separator without the
  // sentence. Both halves are pinned here — the joining preposition, and the
  // absence of the mark it replaced.
  it('joins its two halves with a preposition, not a mark (#818)', () => {
    const said = sparkTitle([1, 2, 3], SAT, CLOSED);
    expect(said).toContain('over the');
    expect(said).not.toContain('—');
  });

  // "1 days to Sat 22 Aug" was reachable — a spark drawn over a single day —
  // and a number agreeing with nothing is the same tell in a smaller place.
  it('agrees with its own day count', () => {
    expect(sparkTitle([4], SAT, CLOSED)).toBe('Issues closed per day, over the 1 day to Sat 22 Aug');
    expect(sparkTitle([4, 5], SAT, CLOSED)).toBe('Issues closed per day, over the 2 days to Sat 22 Aug');
  });

  // The day a spark ends on is the day its own tile's figure is for (#734), so
  // the level chart runs a day further than the two count charts — and the end
  // date is the only thing that says so to a reader who cannot see the strip.
  it('carries the end date, which is not the same day on every tile', () => {
    expect(sparkTitle([1, 2], SAT, OPEN)).toContain('Sat 22 Aug');
    expect(sparkTitle([1, 2], SAT - DAY_MS, CLOSED)).toContain('Fri 21 Aug');
  });
});

// ── the charts themselves ───────────────────────────────────────────────────

const tile = (series: number[] | null, endsOn: number | null, n: number | null = 3) =>
  ({ n, series, endsOn });

const model = (over: Partial<StripModel> = {}): StripModel => ({
  issues: tile([6, 7, 9], SAT),
  throughput: tile([4, 0, 7], SAT - DAY_MS),
  releases: { ...tile([0, 0, 0], SAT - DAY_MS, 0), scope: 'acme', partial: false },
  grid: null,
  // This file is about pointing at a spark, and the third tile no longer draws
  // one (#816). `none` rather than an issue, so nothing it renders can be
  // mistaken for a fourth chart by the counts below.
  oldest: { kind: 'none' },
  window: null,
  years: [],
  ...over,
});

/** The hint is the board's one styled tooltip, which needs its provider — the
 *  app root has one (App.tsx) and `RepoTile.spec.tsx` wraps the same way. */
const strip = (over: Partial<StripModel> = {}) =>
  renderToStaticMarkup(
    <TooltipProvider><FlowStrip model={model(over)} /></TooltipProvider>,
  );

const count = (markup: string, needle: RegExp) => (markup.match(needle) ?? []).length;

describe('every spark answers a pointer and a keyboard (#708)', () => {
  const html = strip();

  it('gives every point of every spark a column that names it', () => {
    // TWO sparks of three days each: six columns, and each is a real button with
    // a real name. Before this, pointing at any of them changed nothing.
    //
    // It was three sparks and nine columns until #816. The third tile is the
    // oldest open issue now, which is one issue and not a series, so it draws no
    // chart at all — there is nothing on it a pointer could ask a question of.
    expect(count(html, /data-point=/g)).toBe(6);
    expect(html).toContain('aria-label="Sat 22 Aug, 9 issues open"');
    expect(html).toContain('aria-label="Fri 21 Aug, 7 closed"');
  });

  it('keeps exactly one tab stop per spark', () => {
    // The roving tabindex is the module's, and the cost it exists to control is
    // tab stops: one per chart, not one per column.
    expect(count(html, /tabindex="0"/g)).toBe(2);
  });

  it('draws its columns from the one module, with no private copy', () => {
    for (const name of ['useChartPointer', 'ChartPoints', 'ChartMark', 'ChartHint']) {
      expect(flowStripSource).toContain(name);
    }
    // Nothing in this file may re-decide what the module owns.
    for (const forbidden of [/onPointerEnter/, /onKeyDown/, /nextPoint/, /tabIndex/]) {
      expect(flowStripSource).not.toMatch(forbidden);
    }
  });
});

describe('a chart that answers is not hidden from the accessibility tree (#708)', () => {
  const html = strip();

  it('names each chart instead of hiding it', () => {
    expect(html).toContain('aria-label="Open issues, over the 3 days to Sat 22 Aug"');
    expect(html).toContain('aria-label="Issues closed per day, over the 3 days to Fri 21 Aug"');
    // Two, not three (#816): the Releases spark went with its tile.
    expect(count(html, /role="img"/g)).toBe(2);
  });

  it('leaves no aria-hidden chart on the strip', () => {
    // The two sparks carried `aria-hidden="true"` until #708. A chart with nine
    // named columns in it cannot be hidden from the tree that reads them.
    expect(html).not.toMatch(/aria-hidden/);
  });
});

describe('nothing a pointer draws adds a pixel to a tile (#708)', () => {
  it('gives every spark a fixed-height relative box with an absolute strip over it', () => {
    const html = strip();
    // SPARK_BOX fixes the height and `relative` is what lets the strip cover the
    // box instead of sitting beside it. Both, not one: the depth spark had no box
    // of its own at all before this. It read three until #816 took the third
    // tile's spark off with the tile.
    expect(count(html, /class="relative w-full h-\[34px\] max-\[720px\]:h-\[64px\]"/g)).toBe(2);
    // The module's own strip — `absolute inset-0`, so it is out of flow. The
    // bar rows are `absolute inset-0 flex items-end gap-px`, so the class must
    // END there or continue into the strip's focus utilities: `items-end` is
    // what tells the two apart. Those utilities are why this is not an exact
    // string any more — the ring moved onto the strip in #708.
    expect(count(html, /class="absolute inset-0 flex(?: has-|")/g)).toBe(2);
    // And the ring is on both, since it is the strip that carries it.
    expect(count(html, /has-\[:focus-visible\]:outline-\[var\(--ring-color\)\]/g)).toBe(2);
  });
});

describe('the mark, inside the caller’s own drawing (#708)', () => {
  // Rendered with a mark set, which no static render can produce on its own —
  // the components take it as a prop for exactly this reason.
  const depth = (mark: number | null) =>
    renderToStaticMarkup(<DepthSpark series={[6, 7, 9]} mark={mark} title="t" />);
  const columns = (mark: number | null) =>
    renderToStaticMarkup(<ColumnSpark series={[4, 0, 7]} mark={mark} title="t" />);

  it('draws nothing at rest', () => {
    expect(depth(null)).not.toContain('data-mark');
    expect(columns(null)).not.toContain('data-mark');
  });

  it('puts a dot on the line, because the line is the reading', () => {
    expect(depth(1)).toContain('data-mark="dot"');
  });

  it('puts NO dot on a column spark, whose reading is its own bar', () => {
    // `ChartMark`'s `y` is nullable for this: a column chart's hero mark is the
    // bar, and a dot floating above it would be a second one.
    expect(columns(1)).not.toContain('data-mark="dot"');
    expect(columns(1)).toContain('data-mark=');
  });

  it('adds nothing outside the fixed viewBox when a point is marked', () => {
    // The mark is svg children inside a viewBox that does not change size, so a
    // marked chart and a resting one differ inside the svg and nowhere else —
    // which is the whole of "a hover cannot add a pixel to a tile".
    const hollow = (markup: string) => markup.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>');
    expect(depth(1)).not.toBe(depth(null));
    expect(hollow(depth(1))).toBe(hollow(depth(null)));

    // A COLUMN SPARK IS THE ONE EXCEPTION, and it is the shape of the mark
    // Artur chose (#708): the marked bar's own ink is repainted, so this chart
    // does differ outside its svg. What must not differ is anything that
    // OCCUPIES SPACE — no element added, no height moved — and that is what is
    // asserted here rather than byte identity, which would be asserting the
    // treatment is not implemented.
    expect(columns(1)).not.toBe(columns(null)); // it really did mark something
    const bare = (markup: string) => markup.replace(/background:var\(--[a-z-]+\)/g, 'background:_');
    expect(bare(hollow(columns(1)))).toBe(bare(hollow(columns(null))));
    // The recolouring is exactly one bar's, and it is the marked one.
    const fills = (markup: string) => [...markup.matchAll(/background:var\((--[a-z-]+)\)/g)].map((m) => m[1]);
    expect(fills(columns(null))).toEqual(['--chart-series', '--chart-series', '--chart-series']);
    expect(fills(columns(1))).toEqual(['--chart-series', '--chart-selection', '--chart-series']);
    expect(fills(columns(2))).toEqual(['--chart-series', '--chart-series', '--chart-selection']);
  });

  /**
   * THE ENDPOINTS ARE ON THE BOX EDGE HERE, AND THE BOX MUST NOT CLIP THEM.
   *
   * `DepthSpark`'s viewBox is `0 0 (n-1) H` with a point at x = i, so points 0
   * and n-1 sit exactly on the edges, where an outermost svg's own clip takes
   * the outer half of a stroke centred there. The rule and the dot are both
   * screen-fixed, so on those two days they painted at HALF weight until #877
   * turned the clip off — 1px of a 2px rule, on the board's most-visited spark.
   *
   * `ColumnSpark` must NOT be made to agree: its foot tick is drawn ON the
   * baseline and relies on that clip taking the outer half, six painting three.
   * So the two are asserted apart, and the reason each is what it is travels
   * with the assertion.
   */
  it('lets the mark paint at its full weight on the two days that sit on the edge', () => {
    expect(depth(0), 'the depth spark clips its own endpoint marks').toContain('overflow-visible');
    expect(columns(1), 'the column spark stopped clipping, and its foot tick is six-for-three')
      .not.toContain('overflow-visible');
    // The rule really is at x = 0 there — this is the geometry the clip bit on,
    // and an inward nudge would take the mark off its datum instead.
    expect(depth(0)).toMatch(/data-mark="rule"[^>]*x1="0"/);
    expect(depth(2)).toMatch(/data-mark="rule"[^>]*x1="2"/); // W = n - 1 = 2
  });

  it('tells the mark which column a day owns, in its own viewBox units', () => {
    // A spark that said nothing would draw its band over the whole box under
    // `MARK = 'band'` — a treatment losing a comparison to a missing argument
    // rather than on its merits. Read off the element tree rather than the
    // markup, because the current treatment is a hairline and draws no width:
    // the prop is the thing that must be right whichever treatment is chosen.
    //
    // The two sparks give DIFFERENT widths for the same three days, and both are
    // right. A column spark's viewBox is one unit per column, so its box is
    // `series.length` wide; the depth spark draws point `i` at x = i, so its box
    // is `series.length - 1` wide and a column is a shade under one unit. Only
    // the strip's own partition — `width / count` — is the same question on both.
    const columnOf = (node: unknown): unknown[] => {
      const out: unknown[] = [];
      const walk = (n: unknown) => {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) return n.forEach(walk);
        const el = n as { type?: unknown; props?: Record<string, unknown> };
        if (el.props && 'column' in el.props && 'height' in el.props) out.push(el.props.column);
        if (el.props?.children !== undefined) walk(el.props.children);
      };
      walk(node);
      return out;
    };
    expect(columnOf(DepthSpark({ series: [6, 7, 9], mark: 1, title: 't' })))
      .toEqual([{ i: 1, count: 3, width: 2 }]);
    expect(columnOf(ColumnSpark({ series: [4, 0, 7], mark: 1, title: 't' })))
      .toEqual([{ i: 1, count: 3, width: 3 }]);
  });

  it('marks a zero day, which draws no bar at all', () => {
    // The Releases spark's last month is all zero, so this is the ordinary case
    // on that tile and not an edge. Recolouring a bar of no height says nothing,
    // so the module puts a tick on the baseline instead — and this file is what
    // tells it to, since `v / max` is this file's scale and nowhere else's.
    const marked = columns(1);
    expect(marked).toContain('data-mark="foot"');
    // The whole of column 1 in this chart's own units — one viewBox unit per
    // column — and ON the floor, y = SPARK_H.
    expect(marked).toMatch(/x1="1" x2="2"/);
    expect(marked).toMatch(/y1="24" y2="24"/);
    // A nonzero column uses its own highlighted ink without an overlay rule (#952).
    for (const day of [0, 2]) {
      expect(columns(day), 'a drawn bar was given a second mark of its own')
        .not.toContain('data-mark="foot"');
      expect(columns(day)).not.toContain('data-mark="dot"');
      expect(columns(day), 'a drawn bar received an overlay rule').not.toContain('data-mark="rule"');
    }
  });
});

describe('a tile with no series still says what it can (#708)', () => {
  it('draws no columns and no chart when the tile holds no days', () => {
    const html = strip({ issues: tile(null, null, 9) });
    expect(html).toContain('No daily history');
    expect(count(html, /data-point=/g)).toBe(3); // the one other spark only
  });
});


describe('the daily closure goal (#1298)', () => {
  const chart = (dailyGoal: number | null | undefined, series = [4, 0, 8]) =>
    renderToStaticMarkup(<ColumnSpark series={series} mark={null} title="Daily closures" dailyGoal={dailyGoal} />);

  it('positions the goal on the same zero-based scale as the daily counts', () => {
    const html = chart(4);
    expect(html).toContain('data-daily-goal="4"');
    expect(html).toContain('top:50%');
    expect(html).toContain('height:100%');
    expect(html).toContain('daily goal: 4 closed');
  });

  it('extends the scale for a goal above every day, including all-zero history', () => {
    const html = chart(100);
    expect(html).toContain('top:0%');
    expect(html).toContain('height:4%');
    expect(html).toContain('height:8%');
    expect(chart(100, [0, 0])).toContain('top:0%');
    expect(chart(8)).toContain('top:0%');
  });

  it('omits missing or invalid goals without changing the data scale', () => {
    for (const goal of [null, undefined, 0, -1, NaN, Infinity]) {
      const html = chart(goal);
      expect(html).not.toContain('data-daily-goal');
      expect(html).toContain('height:100%');
      expect(html).not.toContain('daily goal:');
    }
  });

  it('applies only to closures and preserves every dated point and tab stop', () => {
    const html = renderToStaticMarkup(<TooltipProvider><FlowStrip model={model()} dailyGoal={4} /></TooltipProvider>);
    expect(count(html, /data-daily-goal=/g)).toBe(1);
    expect(html.slice(html.indexOf('data-spark-card="Issues"'), html.indexOf('data-spark-card="Closed"'))).not.toContain('daily goal');
    expect(count(html, /data-point=/g)).toBe(6);
    expect(count(html, /tabindex="0"/g)).toBe(2);
    expect(html).toContain('7 closed');
    expect(strip()).not.toContain('data-daily-goal');
  });
});
