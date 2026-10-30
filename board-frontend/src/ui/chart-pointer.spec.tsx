/**
 * What the one chart-pointer module owes its callers (#708).
 *
 * The board's test env is `node` and there is no DOM: `getBoundingClientRect`
 * answers zeros and a keydown cannot be fired at anything. So this file works
 * the way `flow-strip/DayGrid.spec.tsx` beside it does — the decisions are pure
 * functions driven directly, and the shape they produce is read off
 * `renderToStaticMarkup`'s string. Nothing here asserts on a constant agreeing
 * with itself.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AT_REST,
  ChartHint,
  ChartMark,
  ChartPoints,
  MARK,
  MARK_INK,
  drawMark,
  nextPoint,
  pointAt,
  pointInside,
  useChartPointer,
  type MarkProps,
  type MarkTreatment,
} from './chart-pointer';

/**
 * Every treatment there is, for the tests that must hold across all of them.
 *
 * A type cannot be enumerated at run time, so the list is written out — and the
 * line under it is what stops the list going stale: a treatment added to
 * `MarkTreatment` and not added here leaves `Unlisted` inhabited, and this
 * assignment is then a type error `tsc -b` names by file and line. Prose would
 * have said the same thing and been ignored.
 */
const TREATMENTS = ['recolour', 'halo-dot'] as const;
type Unlisted = Exclude<MarkTreatment, (typeof TREATMENTS)[number]>;
const everyTreatmentIsListed: [Unlisted] extends [never] ? true : never = true;
void everyTreatmentIsListed;

describe('the mark and the reading are two pieces of state (#576, moved in #708)', () => {
  it('rests with neither a mark nor a reading', () => {
    expect(AT_REST).toEqual({ mark: null, read: null });
  });

  it('moves both when a point is pointed at', () => {
    expect(pointAt(AT_REST, 3)).toEqual({ mark: 3, read: 3 });
    expect(pointAt({ mark: 3, read: 3 }, 7)).toEqual({ mark: 7, read: 7 });
  });

  // The whole reason the two are separate. The hint opens to the RIGHT, which is
  // the direction the pointer travels to reach it, so clearing the chart's right
  // edge happens on the way INTO the box. One piece of state dropped the reading
  // there and the open box rewrote itself to a point nobody had pointed at.
  it('drops the mark on leaving and holds the reading', () => {
    expect(pointAt({ mark: 7, read: 7 }, null)).toEqual({ mark: null, read: 7 });
  });

  it('never puts the reading back to null', () => {
    const left = pointAt(pointAt(pointAt(AT_REST, 4), null), null);
    expect(left).toEqual({ mark: null, read: 4 });
  });
});

describe('what a key does to the point, decided in one place (#708)', () => {
  // Extracted as a pure function because the env has no DOM to press a key in.
  // The component's `onKeyDown` is this function and a `.focus()` call, so
  // everything the keyboard DECIDES is covered here.
  const TEN = 10;

  it('walks one point at a time', () => {
    expect(nextPoint('ArrowRight', 3, TEN)).toBe(4);
    expect(nextPoint('ArrowLeft', 3, TEN)).toBe(2);
  });

  // No wrap: a chart is a line of time and running off its end is not the same
  // gesture as jumping to its start. The key is still HANDLED at the end — it
  // has to be, or the arrow scrolls the page under a chart that claimed it.
  it('stops at both ends rather than wrapping, and still handles the key', () => {
    expect(nextPoint('ArrowRight', TEN - 1, TEN)).toBe(TEN - 1);
    expect(nextPoint('ArrowLeft', 0, TEN)).toBe(0);
  });

  it('reaches the ends with Home and End', () => {
    expect(nextPoint('Home', 5, TEN)).toBe(0);
    expect(nextPoint('End', 5, TEN)).toBe(TEN - 1);
  });

  it('answers null for a key it does not own, so the page keeps it', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Tab', 'Enter', ' ', 'a', 'PageDown']) {
      expect(nextPoint(key, 3, TEN), key).toBeNull();
    }
  });

  it('holds still on a chart of one point', () => {
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(nextPoint(key, 0, 1), key).toBe(0);
    }
  });

  // A count that has shrunk under a stale index — the shape `DayGrid` was bitten
  // by when Sunday's running column went away on the Monday.
  it('lands inside the chart from an index the chart no longer has', () => {
    expect(nextPoint('ArrowRight', 12, TEN)).toBe(TEN - 1);
    expect(nextPoint('ArrowLeft', 12, TEN)).toBe(TEN - 1);
    expect(nextPoint('End', 12, TEN)).toBe(TEN - 1);
  });
});

/**
 * The strip's own handlers, driven directly.
 *
 * There is no DOM here, so the elements are read out of the tree the component
 * returns and their handlers are CALLED — which is the wiring itself, not a
 * grep for it. `ReposPage.spec.tsx` reads hints out of a tree the same way, and
 * for the same reason.
 */
type Props = Record<string, unknown> & { children?: unknown };
function elementsOf(node: unknown, out: Props[] = []): Props[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) elementsOf(n, out);
    return out;
  }
  const el = node as { props?: Props };
  if (el.props) out.push(el.props);
  if (el.props?.children !== undefined) elementsOf(el.props.children, out);
  return out;
}

const WEEK = (i: number) => `week ${i + 1} of 10`;

/** The strip as an element tree: the outer element, then one per column. */
function strip(count = 10, at: number | null = null, onPoint: (i: number | null) => void = () => {}) {
  const tree = ChartPoints({ count, label: WEEK, onPoint, at });
  const all = elementsOf(tree);
  return { outer: all[0], columns: all.filter((p) => p['data-point'] !== undefined) };
}

const markup = (count = 10, at: number | null = null) =>
  renderToStaticMarkup(<ChartPoints count={count} label={WEEK} onPoint={() => {}} at={at} />);

describe('the hit strip is reachable, and it is one control (#708)', () => {
  it('lays one real button per point over the chart box', () => {
    const html = markup(10);
    expect((html.match(/<button/g) ?? []).length).toBe(10);
    expect((html.match(/type="button"/g) ?? []).length).toBe(10);
    for (let i = 0; i < 10; i += 1) expect(html).toContain(`aria-label="${WEEK(i)}"`);
  });

  // The strip is reachable or it is not there. An `aria-hidden` hit layer is the
  // shape this module replaces: it answered a pointer and nothing else.
  it('hides nothing from the accessibility tree and ships no native title', () => {
    expect(markup(10)).not.toContain('aria-hidden');
    expect(markup(10)).not.toContain('title=');
  });

  /**
   * THE RING IS ON THE CHART AND NOT ON THE COLUMN (#708).
   *
   * Two questions, two answers: the ring says focus is in THIS CHART rather
   * than on the card around it, and the mark and the readout — both of which
   * `onFocus` draws — say which point.
   *
   * On the column it could not work at any colour. A column is 3.391px wide,
   * measured on the built page at 1440, and `outline-2` at `-2px` offset on a
   * 3.4px box is a degenerate rectangle Chrome fills solid: 288 of the marked
   * column's 408 device px took the ring colour at 2x, and ON A ZERO DAY that
   * ran to 100% of the box height in both themes — a full-height bar drawn on
   * a day whose data has none, against #684's rule that a zero day draws no
   * bar. The chart box is 330x34, so a ring around THAT is a real ring.
   *
   * The colour, the width and now the offset are all the kit's. Collapsing this
   * board's third hand-rolled ring onto `--ring-color` was the right half
   * of the change that introduced the shape; only the shape moved.
   */
  it('rings the chart, in the kit’s own token, and leaves the column bare', () => {
    const s = strip();
    const outer = String(s.outer.className);
    expect(outer).toContain('has-[:focus-visible]:outline-[var(--ring-color)]');
    expect(outer).toContain('has-[:focus-visible]:outline-2');
    // The kit's own outward offset, which a 330x34 box can afford: measured on
    // the built page the spark clears 16px above, 13px below and 16px left,
    // against a ring reaching 4px.
    expect(outer).toContain('has-[:focus-visible]:outline-offset-2');
    // `has-[:focus-visible]` and not `:focus-within`: a mouse press focuses a
    // button in Chrome, and a ring on every click says "focus is here" to a
    // reader who is pointing rather than tabbing.
    expect(outer, 'focus-within would ring the chart on a mouse press').not.toContain('focus-within');

    for (const c of s.columns) {
      const cls = String(c.className);
      expect(cls, 'the degenerate 3.4px ring is what moved').not.toContain('outline-2');
      expect(cls, 'nor may it come back inverted').not.toContain('-outline-offset-2');
      // Stated, not left off: without it the UA draws its own ring on
      // :focus-visible, which is the same degenerate fill in another colour.
      expect(cls).toContain('focus-visible:outline-none');
    }
  });

  it('covers the caller’s box in equal columns', () => {
    // Absolute over a box the caller made `relative`, so a mark can never add a
    // pixel to a tile at any hover state.
    expect(String(strip().outer.className)).toContain('absolute inset-0 flex');
    for (const c of strip().columns) expect(String(c.className)).toContain('flex-1');
  });
});

describe('the whole chart is ONE tab stop (#708, following DayGrid)', () => {
  const stops = (html: string) => [...html.matchAll(/data-point="(\d+)"[^>]*tabindex="0"/g)].map((m) => m[1]);

  it('parks the tab stop on the last point while nothing is marked', () => {
    expect(stops(markup(10, null))).toEqual(['9']);
    expect((markup(10, null).match(/tabindex="-1"/g) ?? []).length).toBe(9);
  });

  it('moves the tab stop to the marked point', () => {
    expect(stops(markup(10, 3))).toEqual(['3']);
    expect((markup(10, 3).match(/tabindex="-1"/g) ?? []).length).toBe(9);
  });

  // DayGrid's Sunday-into-Monday bug, in this module's terms: a stale `at` from
  // a chart that has since lost points matched no column, every button fell to
  // -1, and the chart left the tab order until a reload.
  // The empty chart, which callers guard against but this must survive: a strip
  // with nothing to point at must not leave a stray tab stop behind, and the
  // clamp arithmetic must not answer -1 to anything.
  it('draws nothing, and no tab stop, for a chart with no points', () => {
    expect(markup(0)).not.toContain('<button');
    expect(markup(0)).not.toContain('tabindex');
  });

  it('keeps exactly one stop when the chart has fewer points than the mark', () => {
    expect(stops(markup(10, 12))).toEqual(['9']);
    expect(stops(markup(10, -3))).toEqual(['0']);
  });
});

describe('what the strip does when it is pointed at (#708)', () => {
  const pressed = () => {
    const seen: (number | null)[] = [];
    return { seen, ...strip(10, null, (i) => seen.push(i)) };
  };

  it('reports the column the pointer entered', () => {
    const s = pressed();
    (s.columns[4].onPointerEnter as () => void)();
    expect(s.seen).toEqual([4]);
  });

  // On the STRIP, not on each column: leaving column 4 for column 5 is not
  // leaving the chart, and a per-column leave would blink the mark off between
  // every pair of neighbours.
  it('clears on leaving the strip, and no column clears on its own', () => {
    const s = pressed();
    expect(s.columns.every((c) => c.onPointerLeave === undefined)).toBe(true);
    (s.outer.onPointerLeave as () => void)();
    expect(s.seen).toEqual([null]);
  });

  // #739's precedent: a control that announces itself and then does not respond
  // is worse than one that never claimed anything. Focus draws exactly what the
  // pointer draws.
  it('draws on focus and clears on blur, exactly as the pointer does', () => {
    const s = pressed();
    (s.columns[6].onFocus as () => void)();
    (s.columns[6].onBlur as () => void)();
    expect(s.seen).toEqual([6, null]);
  });

  /** A press, with just enough of an event for the handler to do its two jobs:
   *  take the key off the page, and move focus to the sibling column. The
   *  siblings record being focused, so the roving focus is asserted rather than
   *  assumed — there is no DOM here and a real `.focus()` would land nowhere. */
  function press() {
    const s = pressed();
    const prevented: string[] = [];
    const focused: number[] = [];
    const children = Array.from({ length: 10 }, (_, i) => ({ focus: () => focused.push(i) }));
    const key = (c: number, k: string) =>
      (s.columns[c].onKeyDown as (e: unknown) => void)({
        key: k,
        preventDefault: () => prevented.push(k),
        currentTarget: { parentElement: { children } },
      });
    return { ...s, key, prevented, focused };
  }

  it('walks with the arrows, moves focus with the mark, and takes the key off the page', () => {
    const p = press();
    p.key(4, 'ArrowRight');
    p.key(4, 'ArrowLeft');
    p.key(4, 'Home');
    p.key(4, 'End');
    expect(p.seen).toEqual([5, 3, 0, 9]);
    // One tab stop means the mark and the focus are the same thing: whatever
    // point the arrow marks is the point the browser is focused on.
    expect(p.focused).toEqual([5, 3, 0, 9]);
    // An arrow the chart handled must never also scroll the page under it.
    expect(p.prevented).toEqual(['ArrowRight', 'ArrowLeft', 'Home', 'End']);
  });

  it('leaves a key it does not own to the page', () => {
    const p = press();
    p.key(4, 'Tab');
    p.key(4, 'ArrowUp');
    expect(p.seen).toEqual([]);
    expect(p.focused).toEqual([]);
    expect(p.prevented).toEqual([]);
  });

  /**
   * A column is a READING, and a reading has nothing to activate.
   *
   * The columns are `<button>`s, so Enter and Space fire the button's native
   * activation, which synthesizes a `click`. That click bubbles: on a repo tile
   * it reaches `RepoTile`'s card `onClick`, `tileOpens` sees an unmodified
   * primary press with `defaultPrevented` false, and the reader who pressed
   * Enter on "19 opened and 38 closed, 3 weeks ago" lands on the repo page.
   * `preventDefault` on the keydown is what stops the synthesized click, in
   * Chrome, Firefox and Safari alike.
   *
   * `nextPoint` still answers null for both keys — the chart moves no mark — so
   * this is the strip refusing an activation it never offered, not a new
   * binding.
   */
  it('swallows Enter and Space, which would otherwise open the card under the chart', () => {
    const p = press();
    p.key(4, 'Enter');
    p.key(4, ' ');
    expect(p.seen, 'a column is a reading; neither key moves the mark').toEqual([]);
    expect(p.focused).toEqual([]);
    expect(p.prevented, 'the synthesized click is what opens the repo page').toEqual(['Enter', ' ']);
  });

  // RepoTile wraps its chart in a div with an `onClick` that opens the repo's
  // queue. A column that caught the click, or stopped it, would take that away —
  // so no element the strip draws carries a click handler at all.
  //
  // WHAT THIS CANNOT SEE, written here because it read as full cover for a year:
  // it asserts what the strip does NOT carry, which says nothing about a click
  // the BROWSER synthesizes from a keypress on a `<button>`. That one bubbled to
  // the card and navigated away; the Enter/Space test above is the half this
  // one is blind to.
  it('catches no click, so a press on the chart still reaches the card', () => {
    const all = elementsOf(ChartPoints({ count: 10, label: WEEK, onPoint: () => {}, at: null }));
    expect(all.filter((p) => p.onClick !== undefined)).toEqual([]);
    expect(all.filter((p) => p.onMouseDown !== undefined)).toEqual([]);
  });
});

describe('the one mark, and what each kind of chart does with it (#708)', () => {
  /** A chart of ten points 150 units wide, with point 2 marked. Point 2 is drawn
   *  at x 40 by the caller's own scale; its hit column is 30..45, which is a
   *  different partition of the same box and the thing the foot tick has to
   *  match. */
  const COL = { i: 2, count: 10, width: 150 };
  /** THE HELPER TAKES `MarkTreatment`, and used to re-declare the union as a
   *  string literal here. That compiled and would have gone on compiling while
   *  saying something false the moment a treatment was added or renamed — which
   *  it was: `tsc -b` named this line and nothing else. */
  const drawn = (
    t: MarkTreatment,
    y: number | null = 9,
    over: Partial<MarkProps> = {},
  ) =>
    renderToStaticMarkup(
      <svg viewBox="0 0 150 26">
        {drawMark(t, { x: 40, height: 26, y, column: COL, ...over })}
      </svg>,
    );

  /** The line a treatment drew, as its own chunk of markup. Which ELEMENT it is
   *  is part of what is being asserted, so the helper does not care and the
   *  tests do. */
  const marked = (html: string, kind: 'dot' | 'foot' | 'rule' | 'halo') =>
    [...html.matchAll(new RegExp(`<(?:line|rect) [^>]*data-mark="${kind}"[^>]*>`, 'g'))].map((m) => m[0]);
  const dots = (html: string) => (html.match(/data-mark="dot"/g) ?? []).length;

  /**
   * OVER A COLUMN THAT CARRIES ITS OWN BAR, THE RULE IS THE ONLY THING DRAWN.
   *
   * That is `recolour` plus #877, and the two halves are worth keeping apart.
   * `recolour` says the marked DATUM changes its own ink and the module adds
   * nothing to it — the tinted band and the lone dot were both built, rendered
   * at tile size and turned down, and neither may creep back. The rule is not an
   * addition to the datum: it is the answer to which point the tooltip is
   * talking about, and every chart draws it.
   *
   * The assertion is the whole string for that reason. Anything that appears
   * here other than one rule is a treatment coming back through a side door.
   */
  it('leaves the highlighted bar as the only mark on a nonzero column', () => {
    const html = drawn('recolour', null, { emptyColumn: false });
    expect(marked(html, 'rule')).toHaveLength(0);
    expect(marked(html, 'foot')).toHaveLength(0);
    expect(dots(html)).toBe(0);
    // The default is the same answer: a caller that says nothing about its
    // column is a caller whose column is drawn.
    expect(drawn('recolour', null)).toBe(html);
  });

  /**
   * THE RULE STANDS ON THE POINT, and that is the whole of what #877 asked for:
   * the tooltip names a week and the rule says which week on the plot.
   *
   * At the POINT's x (40 here, the caller's own scale) and not at the middle of
   * the hit column (37.5, which is `columnBox` on this geometry). The two differ
   * on every chart whose points are inset from its edges, and a mark a pixel and
   * a half off its datum is the thing the issue was filed about.
   *
   * Top edge to floor, so it cannot be read as a measurement of the value it
   * stops at, and in screen units so a stretched viewBox cannot make it a band —
   * `preserveAspectRatio="none"` on the depth spark would paint 2 viewBox units
   * as 12px there and 1.2px on a repo tile.
   */
  it('rules the marked point, full height, in screen units', () => {
    for (const [what, y] of [['a line chart', 9]] as const) {
      const [rule] = marked(drawn('recolour', y, { emptyColumn: y === null }), 'rule');
      expect(rule, `${what} drew no rule`).toBeDefined();
      expect(rule, `${what} put the rule off its point`).toContain('x1="40"');
      expect(rule).toContain('x2="40"');
      expect(rule, `${what} did not rule the whole box`).toContain('y1="0"');
      expect(rule).toContain('y2="26"');
      expect(rule).toContain('vector-effect="non-scaling-stroke"');
      // The one ink that clears 3:1 against both a card and a full-height bar,
      // in both themes. It is the module's, never the caller's — see MARK_INK.
      expect(rule).toContain(`stroke="${MARK_INK}"`);
      // 2 CSS px. At 1 a stroke lands between device pixels and spends two
      // thirds of its ink on antialiasing, which is the 1.20:1 hairline #708
      // measured and rejected.
      expect(rule).toContain('stroke-width="2"');
    }
  });

  /** One rule, whatever the chart and whatever the treatment — the same rule the
   *  dot follows, for the same reason: two marks on one chart is two answers to
   *  "which point". */
  it('keeps the default rule and lets halo-dot opt out', () => {
    for (const t of TREATMENTS) {
      for (const y of [9, null]) {
        for (const empty of [true, false]) {
          const rules = marked(drawn(t, y, { emptyColumn: empty }), 'rule');
          expect(rules, `${t} rule count at y=${y}, emptyColumn=${empty}`).toHaveLength(t === 'recolour' && y !== null ? 1 : 0);
        }
      }
    }
  });

  it('draws a fixed-size halo dot for the explicit opt-in treatment', () => {
    const html = drawn('halo-dot');
    expect(marked(html, 'halo')).toHaveLength(1);
    expect(marked(html, 'dot')).toHaveLength(1);
    expect(html).toContain('stroke="var(--surface)"');
    expect(html).toContain('stroke-width="4.8"');
    expect(html).not.toContain('data-mark="rule"');
  });

  /**
   * A ZERO DAY HAS NO BAR TO RECOLOUR, and the Releases spark spends its last
   * 33 days there — the ordinary case on that tile, not an edge.
   *
   * The tick sits ON the chart's own baseline, one column wide. A mark on the
   * floor cannot be read as a bar rising FROM it; a 3px STUB inside the plot
   * can, and on a series whose max is 8 it is within a pixel of a real
   * "1 closed" bar, told apart by colour alone.
   */
  it('ticks the baseline under a column with no bar, one column wide', () => {
    const html = drawn('recolour', null, { emptyColumn: true });
    const [foot] = marked(html, 'foot');
    expect(foot, 'nothing was drawn for a column with no bar').toBeDefined();
    expect(foot).toContain('x1="30"'); // the marked column, start to end
    expect(foot).toContain('x2="45"');
    // ON the baseline, not above it: both ends sit at the box's own floor.
    expect(foot).toContain('y1="26"');
    expect(foot).toContain('y2="26"');
    // Screen units, so the tick is the same weight on a 26px tile and a 64px
    // stacked spark — it is a rule, not a measurement of anything in the chart.
    expect(foot).toContain('vector-effect="non-scaling-stroke"');
    // SIX FOR THREE: drawn on the bottom edge, the outermost svg's own clip
    // takes the outer half. Two paints one, on a baseline that already carries
    // a 1px border.
    expect(foot).toContain('stroke-width="6"');
    // And no dot: a column chart has no series point for one to sit on.
    expect(dots(html)).toBe(0);
  });

  it('ticks nothing on a chart that gave the mark a series point to sit on', () => {
    // `emptyColumn` is a column chart's word and a line chart never says it,
    // but a caller that said both would still get one mark and not two.
    expect(marked(drawn('recolour', 9, { emptyColumn: true }), 'foot')).toHaveLength(0);
    expect(dots(drawn('recolour', 9, { emptyColumn: true }))).toBe(1);
  });

  /** The tick is the marked COLUMN, and the columns TILE the box: the first
   *  starts at 0, the last ends on the far edge, and none of them can hang
   *  outside a chart whose svg paints past its viewBox. */
  it('never lets the tick leave the box, at either end of any of the four charts', () => {
    for (const [name, count, width] of [
      ['repo-spark', 10, 150], ['Pulse', 12, 340],
      // 12 columns across 1000px was the Overview feedback plot's geometry. That
      // chart went with #752; the numbers stay, because a wide chart with few
      // columns is the end of the range the arithmetic has to hold over.
      ['12 columns, wide', 12, 1000], ['flow-strip column', 97, 97],
    ] as const) {
      for (const i of [0, count - 1]) {
        const [foot] = marked(drawn('recolour', null, { column: { i, count, width }, emptyColumn: true }), 'foot');
        expect(foot, `${name} drew no tick at point ${i}`).toBeDefined();
        const x1 = Number(/x1="([-\d.]+)"/.exec(foot)![1]);
        const x2 = Number(/x2="([-\d.]+)"/.exec(foot)![1]);
        expect(x1, `${name} tick starts left of the box`).toBeGreaterThanOrEqual(0);
        expect(x2, `${name} tick ends past the box`).toBeLessThanOrEqual(width);
        expect(x2 - x1, `${name} tick is not one column wide`).toBeCloseTo(width / count, 9);
      }
    }
  });

  it('covers the whole box on a chart of one point', () => {
    const [foot] = marked(drawn('recolour', null, { column: { i: 0, count: 1, width: 150 }, emptyColumn: true }), 'foot');
    expect(foot, 'no tick drawn on a chart of one point').toBeDefined();
    expect(foot).toContain('x1="0"');
    expect(foot).toContain('x2="150"');
  });

  // #576's rule, inherited and not reopened. The caller hides its own terminal
  // dot while a point is marked; this module's side of the bargain is that it
  // never draws a second one itself, in any treatment.
  it('never draws more than one dot, whichever treatment is chosen', () => {
    for (const t of TREATMENTS) {
      expect(dots(drawn(t)), t).toBe(1);
      // A chart whose marked datum is its own bar passes y null and gets none.
      expect(dots(drawn(t, null)), t).toBe(0);
      expect(dots(drawn(t, null, { emptyColumn: true })), t).toBe(0);
    }
  });

  /**
   * THE DOT IS A DOT ON EVERY CHART, which a `<circle>` is not.
   *
   * Every caller here is `preserveAspectRatio="none"`, so a circle is stretched
   * by whatever factor that chart's viewBox is stretched by. Measured in
   * headless Chrome, hit-testing the painted extent on a 0.25px lattice, at each
   * caller's own box:
   *
   *   chart                viewBox -> box        <circle r 2.4>   this
   *   repo-spark           150x26  -> 112x26      3.75 x 4.75     4.75 x 4.75
   *   Pulse                340x130 -> 340x130     4.75 x 4.75     4.75 x 4.75
   *   FlowStrip depth      96x24   -> 330x34     16.25 x 6.75     4.75 x 4.75
   *
   * A zero-length line with a round cap and a non-scaling stroke is a circle of
   * `stroke-width` SCREEN pixels, wherever it is drawn — the same argument the
   * foot tick is sized by.
   */
  it('draws the dot in screen units, so no stretch can make it an ellipse', () => {
    const html = drawn('recolour');
    expect(html, 'a circle is stretched by the caller’s own aspect ratio').not.toContain('<circle');
    const [dot] = marked(html, 'dot');
    expect(dot, 'no dot drawn').toBeDefined();
    // Zero length: the cap is the whole of it.
    expect(dot).toContain('x1="40"');
    expect(dot).toContain('x2="40"');
    expect(dot).toContain('y1="9"');
    expect(dot).toContain('y2="9"');
    expect(dot).toContain('stroke-linecap="round"');
    expect(dot).toContain('vector-effect="non-scaling-stroke"');
    expect(dot).toMatch(/stroke-width="4\.8"/);
  });

  /**
   * THE MODULE OWNS THE MARK'S INK; A CALLER OWNS ITS OWN SERIES' COLOUR.
   *
   * The two are not the same question and #708 separated them. A caller passes
   * the blue its own line is drawn in, for the DOT that sits on that line. The
   * mark's own furniture — the foot tick here, and the recolouring a column
   * chart does with `MARK_INK` — is the module's, because it is the half that
   * has to clear 3:1 against a bar and against the card in both themes, and
   * exactly one token in the kit does.
   */
  it('takes the caller’s own series colour for the dot, and none for the tick', () => {
    expect(marked(drawn('recolour'), 'dot')[0]).toContain('var(--accent)');
    expect(marked(drawn('recolour', 9, { colour: 'var(--accent-strong)' }), 'dot')[0])
      .toContain('var(--accent-strong)');
    // The tick refuses it: a mark in the series' own blue reads 1.00:1 against
    // the bar beside it.
    const [foot] = marked(drawn('recolour', null, { emptyColumn: true, colour: 'var(--accent-strong)' }), 'foot');
    expect(foot).toContain(MARK_INK);
    expect(foot).not.toContain('var(--accent-strong)');
  });

  it('uses the dedicated selection ink measured by the browser guard', () => {
    expect(MARK_INK).toBe('var(--chart-selection)');
  });

  it('spends only tokens, so the mark reads in both themes', () => {
    for (const t of TREATMENTS) {
      for (const html of [drawn(t), drawn(t, null, { emptyColumn: true })]) {
        expect(html, t).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(html, t).not.toMatch(/rgba?\(/);
        expect(html, t).not.toMatch(/hsla?\(/);
      }
    }
    expect(drawn('recolour')).toContain('var(--accent)');
    expect(drawn('recolour', null, { emptyColumn: true })).toContain('var(--chart-selection)');
  });

  // The constant is the whole of the choice, and `ChartMark` is what the callers
  // draw. These two must not drift.
  it('draws whatever MARK currently says, and says recolour since Artur chose it', () => {
    expect(MARK).toBe('recolour');
    // Every prop, the column and the emptiness included, so this is also what
    // pins the pass-through: a dropped prop here is a chart that marks the
    // wrong column or draws nothing on a zero day.
    expect(renderToStaticMarkup(
      <svg viewBox="0 0 150 26">
        <ChartMark x={40} height={26} y={null} emptyColumn column={COL} />
      </svg>,
    )).toBe(drawn(MARK, null, { emptyColumn: true }));
    expect(renderToStaticMarkup(
      <svg viewBox="0 0 150 26">
        <ChartMark x={40} height={26} y={9} column={COL} colour="var(--accent-strong)" />
      </svg>,
    )).toBe(drawn(MARK, 9, { colour: 'var(--accent-strong)' }));
  });
});

/**
 * ONE ANSWER TO "IS THIS POINT STILL ON THE CHART", held here (#708).
 *
 * `ChartPoints` clamped `at` at render, and only its own `tabIndex` read the
 * clamped value: `onPoint` handed out the raw index and the callers drew from
 * the raw mark. Four callers then had four answers — `Pulse` kept a
 * private `inside()`, `FlowStrip` guarded with `at !== undefined` and silently
 * drew nothing. The clamp fixed tabbability and left the mark wrong: the stop
 * sat on the last point while the mark drew off the end of the chart.
 */
describe('a point outside the chart is no point at all (#708)', () => {
  it('answers the point when the chart still has it', () => {
    expect(pointInside(3, 10)).toBe(3);
    expect(pointInside(0, 10)).toBe(0);
    expect(pointInside(9, 10)).toBe(9);
  });

  // The shape `DayGrid` was bitten by, one level down: a chart that loses its
  // running week goes from ten points to nine with a nine still marked.
  it('lands inside the chart from an index the chart no longer has', () => {
    expect(pointInside(12, 10)).toBe(9);
    expect(pointInside(-3, 10)).toBe(0);
  });

  it('answers null for nothing marked, and for a chart with no points', () => {
    expect(pointInside(null, 10)).toBeNull();
    expect(pointInside(4, 0)).toBeNull();
    expect(pointInside(0, 0)).toBeNull();
  });
});

describe('the hint is bounded, and opens to the right (#576, inherited)', () => {
  const hint = (over: Partial<Parameters<typeof ChartHint>[0]> = {}) =>
    elementsOf(ChartHint({ label: 'nineteen opened, thirty-eight closed', children: <span />, ...over }));

  it('opens to the right unless the caller says otherwise', () => {
    // The chart sits directly under the thing that names it, and a top-side box
    // covers that name on every tile.
    expect(hint()[0].side).toBe('right');
    expect(hint({ side: 'bottom' })[0].side).toBe('bottom');
  });

  it('bounds the box so a sentence wraps instead of running to a page edge', () => {
    const label = hint()[0].label as { props: { className: string } };
    expect(label.props.className).toMatch(/max-w-\[\d+px\]/);
    // `block` is what makes the bound bite — an inline span sizes to its
    // longest unbroken run.
    expect(label.props.className).toContain('block');
  });
});

describe('the pointer a chart holds (#708)', () => {
  // The hook needs a renderer to exist in, so it is driven through a probe that
  // prints what it was handed. Only the resting state is reachable without a
  // DOM to re-render in — every transition from there is `pointAt`, pinned above.
  function Probe({ count = 10 }: { count?: number }) {
    const p = useChartPointer(count);
    return <i data-at={`${p.mark},${p.read}`} data-can-point={typeof p.point} />;
  }

  it('starts at rest, with a way to point', () => {
    const html = renderToStaticMarkup(<Probe />);
    expect(html).toContain('data-at="null,null"');
    expect(html).toContain('data-can-point="function"');
  });

  // The hook is handed the count so that NEITHER piece of state can leave it out
  // of range — `mark`, which the caller indexes its series with, and `read`,
  // which the caller turns into a sentence. `flow-strip`'s `sparkPointSentence`
  // dates a point by counting back from the last day, so a `read` past the end
  // printed a day that has not happened yet with a zero under it.
  it('holds the count, so neither the mark nor the reading can outlive the chart', () => {
    expect(renderToStaticMarkup(<Probe count={0} />)).toContain('data-at="null,null"');
  });
});
