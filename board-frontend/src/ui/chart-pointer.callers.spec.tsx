import { describe, expect, it } from 'vitest';
import { nextPoint } from './chart-pointer';

/**
 * Every chart that answers a pointer answers through ONE module (#708) — the
 * point of the behaviour landing in `ui/chart-pointer.tsx` with four callers
 * rather than in four files with four ideas of what a hover is.
 *
 * It enforces two rules, and they are not the same rule:
 *
 *   1. A chart that answers a pointer at all does it through the module. Its own
 *      hover `useState`, its own hit rects, its own absolutely-positioned chip:
 *      each is a private copy re-growing, and the board had two of them before
 *      this (`repos/repo-spark.tsx` #576, `dashboard/Pulse.tsx` #421) which is
 *      how it learnt they drift.
 *   2. A chart answers, or is a NAMED entry below saying it does not and why.
 *      This is the half that catches a chart nobody remembered: it is found off
 *      the module tree, so a sixth chart in a file this comment does not mention
 *      is swept the day it is written.
 *
 * WHY IT IS BUILT THE WAY IT IS. `command-menu.callers.spec.tsx` is the model,
 * and it is the model because it was rewritten after four mutations walked
 * through its hand-written list of filenames. The four things that survived are
 * copied here: the callers are read off `import.meta.glob` rather than listed;
 * comments are stripped, so a `<ChartPoints` written inside one counts for
 * nothing; the rule is per COMPONENT, because a rule checked against a whole
 * file is satisfied by a second chart's answer somewhere else in it; and every
 * exemption is a named entry read as "at MOST these", so removing one by fixing
 * the chart passes. `command-menu.callers.spec.tsx` records an `exempt: 1` count
 * that inverted exactly there — fixing the unmarked menu failed the test.
 *
 * WHAT COUNTS AS DRAWING A CHART, stated so the next author can argue with it: a
 * top-level unit whose body holds an `<svg` AND one of three marks of a series
 * drawn into it — `preserveAspectRatio="none"` (the stretched-viewBox idiom
 * every chart here uses), a call to the shared `smoothPath(`, or a `.map(` that
 * returns an svg primitive. Three signals rather than one because the board
 * draws charts three ways: `repo-spark` stretches a viewBox, `vouch-variants`'s
 * `Spark` sizes in percentages and has no viewBox at all, and `FlowStrip`'s
 * column spark draws its bars in HTML with only the mark in svg. That middle
 * example used to be the board card's spark in `projects/ProjectsView.tsx`;
 * #785 deleted it with the rollup, and the frozen copy in the preview is the
 * only unit written that way now — so the third signal is still exercised, but
 * by one unit rather than two.
 *
 * WHAT IT CANNOT SEE. A chart drawn with no `<svg` in it anywhere is invisible
 * to this sweep, and `flow-strip/DayGrid.tsx` is one — a 13x7 grid of HTML
 * buttons, up to 91 of them. That is
 * the one chart on the board keeping a pointer mechanism of its own, and the
 * last block here records why rather than leaving it to be discovered.
 */
const MODULES: Record<string, string> = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Block and line comments out, literals kept. A chart's arguments are written
 *  in prose above it in this repo, so nearly every signal below appears in some
 *  comment somewhere; a mark inside one is a mark on nothing. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** `../repos/x.tsx` → `repos/x.tsx`, `./ring.tsx` → `ui/ring.tsx`. This spec
 *  sits in `ui/`, so its own directory comes back from the glob unprefixed. */
const named = (path: string) => path.replace(/^\.\.\//, '').replace(/^\.\//, 'ui/');

/**
 * SCRATCH files, swept out whole, each with a reason a fix is allowed to delete.
 * A path filter with no reason beside it is the thing that rots.
 */
const NOT_THE_APP: Record<string, string> = {
  'cockpit-variants.tsx':
    'preview-only (#658) and imported by nothing but `cockpit-preview.tsx` — the '
    + 'record of the flow-strip designs that were turned DOWN, kept so nobody '
    + 're-proposes them. Its five charts carry the private hover state this rule '
    + 'exists to stop, and rewriting them would falsify the record of what was '
    + 'rejected. What won is `flow-strip/`, which is swept.',
};

/** One top-level unit at a time — a declaration at column 0, so a helper nested
 *  inside a component stays part of it. Per component and not per file:
 *  `FlowStrip.tsx` draws two charts and answers for both from a third component,
 *  and a file-wide rule would let either one lose its answer.
 *
 *  EVERY shape a head is written in, and the block below tests the regex on its
 *  own for that reason. `export default function` was missed until #708's review
 *  — the shape `App.tsx` and `projects/ProjectsView.tsx` both use — and a missed
 *  head is not a boundary either, so the whole tail of such a file was read as
 *  the body of the last unit above it. */
function units(body: string): { name: string; body: string }[] {
  const heads = [
    ...body.matchAll(/^(?:export (?:default )?)?(?:async )?(?:function|const|let|class) (\w+)/gm),
  ];
  return heads.map((h, i) => ({
    name: h[1],
    body: body.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : undefined),
  }));
}

/** A `.map(` whose callback returns an svg primitive — a series turned into
 *  marks, which is what a chart is. The 400-character window is the body of a
 *  short callback; past that the map is doing something else. */
const SERIES_MAP = /\.map\([\s\S]{0,400}?<(rect|circle|line|path|polyline|polygon)\b/;

const drawsAChart = (body: string) =>
  body.includes('<svg')
  && (body.includes('preserveAspectRatio="none"')
    || body.includes('smoothPath(')
    || SERIES_MAP.test(body));

interface Chart {
  /** `repos/repo-spark.tsx#SparkChart` — how every message and every entry
   *  below names one. */
  id: string;
  path: string;
  /** The unit itself, plus the units one hop either way: the component that
   *  renders it and the components it renders. `FlowStrip`'s `DepthSpark` draws
   *  the chart while `Spark` above it holds the answer, and `Pulse`'s pre-#708
   *  chip lived one hop from the svg the other way. Whatever counts as
   *  answering for a chart is therefore also where its private copy would
   *  count against it. */
  near: string;
}

const CHARTS: Chart[] = Object.entries(MODULES)
  .map(([path, source]) => [named(path), code(source)] as const)
  .filter(([path]) => !path.includes('.spec.') && !(path in NOT_THE_APP))
  .flatMap(([path, body]) => {
    const all = units(body);
    return all.filter((u) => drawsAChart(u.body)).map((u) => ({
      id: `${path}#${u.name}`,
      path,
      near: all
        .filter((o) => o.name === u.name
          || new RegExp(`<${u.name}\\b`).test(o.body)
          || new RegExp(`<${o.name}\\b`).test(u.body))
        .map((o) => o.body)
        .join('\n'),
    }));
  });

/** Answering through the module: the hit strip is what a reader points AT, so
 *  it is the piece that says a chart answers. The mark and the box without it
 *  are drawings nothing can reach. */
const answers = (near: string) => /<ChartPoints\b/.test(near);

/**
 * The three shapes of a private pointer mechanism, and what each one was.
 *
 * `useState` is matched on the index it holds rather than on the word `hover`:
 * `Pulse.tsx` called it `hover` and `DayGrid.tsx` calls it `cursor`, and the
 * thing they have in common is a point number that a pointer moves.
 */
const PRIVATE: { what: string; found: (near: string) => boolean }[] = [
  {
    what: 'its own hover state (a `useState` holding a point index)',
    found: (n) => /useState<number \| null>/.test(n)
      || /const \[(hover|hovered|active|cursor|chip|tip)\w*, set/i.test(n),
  },
  {
    what: 'its own hit targets (a pointer handler on something the module does not draw)',
    found: (n) => /on(Mouse|Pointer)(Enter|Move|Over|Leave)=/.test(n),
  },
  {
    what: 'its own tooltip (a chip it positions itself, instead of `ChartHint`)',
    found: (n) => /role="tooltip"/.test(n),
  },
];

/**
 * Charts that answer NOTHING, and why. Read as "at MOST these": a chart removed
 * from this list by being given the module's answer passes, which is the
 * direction a fix travels. Adding one costs a line of reasoning here.
 *
 * Every one of these is a real chart on a real page. None is a bug this file is
 * hiding — but none was in #708's scope either, and a gate that quietly narrowed
 * itself to the four charts that were would not be a gate.
 *
 * IT WAS FOUR AND IS TWO. `repos/RepoPage.tsx`'s `FlowChart` and `CiChart` came
 * off it in #877: the caption they were exempt on the strength of reports the
 * ten-week WINDOW, and a reader pointing at a chart is asking about a week. Two
 * entries leaving by being fixed is the direction this list is written to
 * travel, and the "at MOST these" reading is what lets them leave without
 * editing a count.
 */
const ANSWERS_NOTHING: Record<string, string> = {
  'goals/GoalFlame.tsx#GoalFlame':
    'a decorative burning-cell SVG; the heatmap cell beneath it already answers hover and shows the tooltip.',
  'vouch-variants.tsx#Spark':
    'a frozen COPY of the board card\u2019s spark, inside the scratch preview that '
    + 'drew the four treatments of a board read short so Artur could pick between '
    + 'them (#722). The original — `projects/ProjectsView.tsx#Spark`, exempt here '
    + 'until #785 deleted the rollup — is gone, and the entry went with it rather '
    + 'than lingering as a reason for a chart that is not there. This copy stays '
    + 'exempt for the reason it always had: it reproduces what the card drew on '
    + 'the day the columns were rendered, and giving it an answer the original '
    + 'never had would make the record disagree with the board it is a record of. '
    + 'Nothing imports it and no page mounts it. It goes when the preview goes.',
  'ui/ring.tsx#Ring':
    'a dial and not a series — ONE value, whose figure is printed inside the '
    + 'ring already, and per-person segments each carrying their own `<title>`. '
    + 'There is no per-point reading for a strip of columns to report, so the '
    + 'module has nothing to give it.',
};

describe('the board’s charts, swept off the tree (#708)', () => {
  it('found every chart, so an empty sweep cannot pass this file', () => {
    const ids = CHARTS.map((c) => c.id);
    for (const chart of [
      'repos/repo-spark.tsx#SparkChart',
      'dashboard/Pulse.tsx#TrendPlot',
      'flow-strip/FlowStrip.tsx#DepthSpark',
      'flow-strip/FlowStrip.tsx#ColumnSpark',
      'repos/RepoPage.tsx#FlowChart',
      'repos/RepoPage.tsx#CiChart',
      'vouch-variants.tsx#Spark',
    ]) {
      expect(ids, `${chart} draws a chart and must be swept`).toContain(chart);
    }
    expect(Object.keys(MODULES).length).toBeGreaterThan(50);
  });

  it('names the file it sweeps out whole, and the file is still there', () => {
    for (const [path, why] of Object.entries(NOT_THE_APP)) {
      expect(why.length, `${path} is excluded with no reason on record`).toBeGreaterThan(40);
      const swept = Object.keys(MODULES).map(named);
      expect(swept, `${path} is excluded and no longer exists — drop the entry`).toContain(path);
    }
  });

  /**
   * The same staleness check on the other list, which had none.
   *
   * `NOT_THE_APP` is read as a path filter and fails when the path goes; every
   * entry of `ANSWERS_NOTHING` was only ever read as a lookup, so a renamed,
   * moved or deleted chart left its exemption sitting here forever — and the day
   * a NEW chart took that `path#Name`, it was exempt without anybody deciding
   * so. This file's own header says a filter with no reason beside it is the
   * thing that rots, and a reason for a chart that no longer exists is the same
   * rot one step on.
   *
   * It does not narrow the "at MOST these" reading the list is written for: that
   * is about the COUNT, and a chart given the module's answer stays in `CHARTS`
   * with `answers()` true — it just stops being asked for a reason.
   */
  it('names a chart that is still there, so a renamed one cannot stay exempt', () => {
    const ids = CHARTS.map((c) => c.id);
    for (const id of Object.keys(ANSWERS_NOTHING)) {
      expect(
        ids,
        `${id} is on record as answering nothing and is no longer a chart on the `
        + 'tree — drop the entry, or fix the id it was renamed to.',
      ).toContain(id);
    }
  });
});

/**
 * The head regex is the whole sweep, so it is tested on its own (#708).
 *
 * `/^(?:export )?(?:function|const) (\w+)/gm` matched neither `export default
 * function` nor `export async function` nor a `let`. A chart file written the
 * first way — and `App.tsx` and `projects/ProjectsView.tsx` are both written
 * that way — produced NO unit at all from its default export, so its charts were
 * swept out entirely and the gate reported green over them.
 *
 * The second-order half is worse than the miss: a head the regex does not match
 * is not a boundary either, so everything from the last matched head to EOF was
 * absorbed into that unit's body. A chart added below `Overview` in
 * `ProjectsView.tsx` would have been reported as `ProjectsView.tsx#Overview`.
 */
describe('a top-level unit is found however the file writes its head (#708)', () => {
  it('reads every shape a unit head is written in', () => {
    const heads = `export default function Chart() { return null; }
export async function load() {}
let Legend = () => null;
export class Axis {}
function bare() {}
const plain = 1;
export const named = 2;
`;
    expect(units(heads).map((u) => u.name)).toEqual([
      'Chart', 'load', 'Legend', 'Axis', 'bare', 'plain', 'named',
    ]);
  });

  it('names the default export of the two files that write one, and ends the unit before it', () => {
    for (const [path, unit] of [
      ['../App.tsx', 'App'],
      ['../projects/ProjectsView.tsx', 'ProjectsView'],
    ] as const) {
      const found = units(code(MODULES[path]));
      expect(
        found.map((u) => u.name),
        `${path} hides its default export from the sweep, and every line after `
        + 'the head above it is read as part of that unit instead.',
      ).toContain(unit);
    }
  });
});

describe('a chart answers through the one module, or answers nothing (#708)', () => {
  it('grows no private pointer mechanism of its own', () => {
    for (const chart of CHARTS) {
      for (const { what, found } of PRIVATE) {
        expect(
          found(chart.near),
          `${chart.id} has ${what}. Every chart on this board answers through `
          + '`ui/chart-pointer` — see docs/charts-answer-when-pointed-at.md.',
        ).toBe(false);
      }
    }
  });

  it('either draws the module’s hit strip, or is on record as answering nothing', () => {
    for (const chart of CHARTS.filter((c) => !answers(c.near))) {
      expect(
        ANSWERS_NOTHING[chart.id],
        `${chart.id} draws a chart that answers no pointer and gives no reason. `
        + 'Either render <ChartPoints> from `ui/chart-pointer`, or say here why not.',
      ).toBeTruthy();
      expect(ANSWERS_NOTHING[chart.id].length).toBeGreaterThan(40);
    }
  });

  it('takes its answer from `ui/chart-pointer` and never from a copy', () => {
    const defines = Object.entries(MODULES)
      .filter(([path]) => !path.includes('.spec.'))
      .filter(([, src]) => /export function (ChartPoints|useChartPointer)\b/.test(code(src)))
      .map(([path]) => named(path));
    expect(defines, 'the hit strip is defined in more than one place').toEqual([
      'ui/chart-pointer.tsx',
    ]);

    for (const path of new Set(CHARTS.filter((c) => answers(c.near)).map((c) => c.path))) {
      const body = code(MODULES[Object.keys(MODULES).find((k) => named(k) === path)!]);
      expect(
        /import \{[^}]*\bChartPoints\b[^}]*\} from '[^']*ui\/chart-pointer'/.test(body),
        `${path} draws a hit strip it did not import from ui/chart-pointer`,
      ).toBe(true);
    }
  });
});

/**
 * The one chart that keeps a mechanism of its own, recorded as a decision here
 * rather than left to be found.
 *
 * `DayGrid` is a 13x7 grid of HTML buttons — no svg, so the sweep above never
 * sees it — and its cursor moves on TWO axes. `ChartPoints` is one row of
 * columns and `nextPoint` answers `null` for the vertical arrows, so converting
 * the grid would mean handing it a mechanism that cannot reach six of its seven
 * rows. It was left alone deliberately, and #708 took the two things from it
 * that a 1-D strip can hold: one tab stop with the arrows inside it, and a
 * cursor clamped at render (its Sunday-into-Monday bug).
 *
 * The assertion is the reason, so the entry cannot go stale in silence: the day
 * the shared module answers a vertical arrow, this fails and the exemption gets
 * looked at again.
 */
describe('the day grid is different, and this is why (#684, #708)', () => {
  const grid = code(MODULES['../flow-strip/DayGrid.tsx']);

  it('draws no svg, so the sweep above genuinely cannot reach it', () => {
    expect(grid).not.toContain('<svg');
  });

  it('walks two axes, which the shared strip has no answer for', () => {
    expect(grid).toContain('ArrowUp');
    expect(grid).toContain('ArrowDown');
    expect(nextPoint('ArrowUp', 3, 10)).toBeNull();
    expect(nextPoint('ArrowDown', 3, 10)).toBeNull();
  });

  // Matched on the SHAPE and not on DayGrid's variable names, which belong to
  // that file: this spec may not go red because somebody renamed a cursor.
  it('still answers a pointer and a keyboard, which is what the rule is for', () => {
    expect(grid, 'no cell answers a pointer').toMatch(/onMouseEnter=/);
    expect(grid, 'a cell no longer names itself').toMatch(/aria-label=\{cellSentence\(/);
    expect(grid, 'the grid no longer roves one tab stop').toMatch(/tabIndex=\{[^}]+\? 0 : -1\}/);
  });
});
