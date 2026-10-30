/**
 * A chart answers when you point at it (#708).
 *
 * The one module every chart on this board answers through: the state a pointer
 * produces (`useChartPointer`, `pointAt`), the strip that catches it
 * (`ChartPoints`), the mark drawn inside the caller's own svg (`ChartMark`) and
 * the box that says what the marked point reads (`ChartHint`). A caller owns its
 * numbers, its words, the shape of its own chart and one `relative` box for the
 * strip to cover; it owns none of the decisions, and reopening one of them here
 * changes every chart at once.
 *
 * #877 reopened one of them, and this is the paragraph that says which. The
 * mark used to be the marked DATUM and nothing else — a dot on a line, a
 * repainted bar on a column — and a reader pointing at the middle of a
 * twelve-week line got a tooltip naming a week and a 4.8px dot the same blue as
 * the line under it. `RULE_PX` is the answer: one full-height rule at the
 * marked point, drawn by every chart, which is the piece that says WHICH point
 * without asking the reader to find a dot. The datum's own treatment stays
 * exactly as `MARK` says — the rule was added to it, not put in its place.
 *
 * why: docs/charts-answer-when-pointed-at.md — the two designs turned down, the
 * three arguments a caller inherits, the keyboard and what its tab stops cost,
 * what a zero draws, where the mark's look was decided, and the guard that keeps
 * a sixth chart from growing a pointer of its own.
 */
import { useCallback, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { Tip } from './Tip';

/**
 * The two things a pointer produces, which do not live the same length of time.
 *
 * `mark` is on the CHART: the line and the dot, drawn only while a pointer is on
 * a point. `read` is in the BOX: the point the words report, which is the last
 * point actually pointed at.
 */
export interface ChartPointer {
  mark: number | null;
  read: number | null;
}

/** No point marked, nothing read yet. */
export const AT_REST: ChartPointer = { mark: null, read: null };

/** Point at a point, or leave the chart. The mark follows the pointer; the
 *  reading holds.
 *
 *  One piece of state used to drive both, and the hint opens to the RIGHT —
 *  the direction the pointer travels to reach it. Clearing the chart's right
 *  edge dropped the state, so the hint fell back to the last point and the open
 *  box rewrote itself to numbers nobody had pointed at. Nothing here can put
 *  the reading back to null. */
export function pointAt(state: ChartPointer, i: number | null): ChartPointer {
  return { mark: i, read: i ?? state.read };
}

/**
 * What a key does to the marked point, and the whole of the keyboard decision.
 *
 * `null` means the key is not this chart's, so the page keeps it. Every other
 * answer is an index inside the chart, which is why an arrow at either END
 * answers its own index rather than null: the key IS handled there, and the
 * caller's `preventDefault` hangs off that, so a chart that claimed the arrow
 * cannot let it scroll the page instead.
 *
 * Pure because the board's test env is `node` and a key cannot be pressed at
 * anything; the component's handler is this function and a `.focus()`.
 */
export function nextPoint(key: string, i: number, count: number): number | null {
  const last = count - 1;
  const inside = (n: number) => Math.min(Math.max(n, 0), last);
  // No wrap. A chart is a line of time, and running off its end is a different
  // gesture from jumping to its start — Home and End are how you say that.
  if (key === 'ArrowLeft') return inside(i - 1);
  if (key === 'ArrowRight') return inside(i + 1);
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return null;
}

/**
 * Is this point still on the chart? ONE answer, and every caller takes it.
 *
 * `at` outlives a change of shape — a chart that loses its running week goes
 * from ten points to nine with a nine still marked — and what an out-of-range
 * point does depends entirely on who is holding it: it drops every button to
 * -1 and takes a chart out of the tab order (`DayGrid`'s Sunday-into-Monday
 * bug), it throws on `closed[mark][1]`, it draws a mark off the end of the
 * chart, or it dates a day that has not happened yet.
 *
 * It lived in `ChartPoints` and was read only by `tabIndex`, so four callers
 * invented four answers to the same question and two of them were "throw". It
 * is the module's now, and `useChartPointer` applies it to BOTH pieces of state
 * so the ordinary path cannot hand a caller an index its series does not have.
 */
export function pointInside(i: number | null, count: number): number | null {
  if (i === null || count < 1) return null;
  return Math.min(Math.max(i, 0), count - 1);
}

/**
 * The strip covers the caller's box, which the caller has made `relative`. It
 * is absolute so that nothing a hover draws can add a pixel to a tile, and a
 * flex row of `flex-1` columns so a column stays aligned to its point at every
 * width the grid makes.
 *
 * The focus ring is on the strip and not on a column: the ring says focus is in
 * this chart, the mark says which point, and a 3.4px column cannot carry an
 * outline at all — inset on a box that narrow it is a degenerate rectangle
 * Chrome fills solid, which on a zero day drew a bar the data does not have.
 * Colour, width and offset are the kit's.
 * why: docs/charts-answer-when-pointed-at.md, "The keyboard".
 *
 * `has-[:focus-visible]` and not `:focus-within`: a mouse press focuses a
 * `<button>` in Chrome, and a ring that appears on every click would be saying
 * "focus is here" to a reader who is pointing rather than tabbing.
 */
const STRIP = 'absolute inset-0 flex '
  + 'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 '
  + 'has-[:focus-visible]:outline-[var(--ring-color)]';

/**
 * A column draws nothing at rest and nothing on focus, the ring having moved to
 * the strip above.
 *
 * `outline-none` is stated rather than left off: without it the UA draws its own
 * ring on `:focus-visible`, which on a 3.4px column is the same degenerate fill
 * in a different colour.
 *
 * `cursor-default` is stated too (#1023): pointing at a column reads it, and
 * pressing one opens nothing, so it keeps the arrow.
 */
const COLUMN = 'h-full flex-1 cursor-default focus-visible:outline-none';

export function ChartPoints({
  count,
  label,
  onPoint,
  at,
}: {
  count: number;
  /** The column's accessible name — what this point IS, in words. */
  label: (i: number) => string;
  onPoint: (i: number | null) => void;
  /** The marked point, which is also where the one tab stop sits. */
  at: number | null;
}): ReactElement {
  const last = count - 1;
  // CLAMPED AT RENDER, not trusted from the caller — through `pointInside`,
  // which is the module's one answer to that question rather than this
  // component's private one. `DayGrid` shipped the bug this prevents; this is
  // the same fix, one level down.
  const cursor = pointInside(at, count) ?? last;

  const move = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    // ACTIVATION IS SWALLOWED, and nothing is put in its place. A column is a
    // READING — it has nothing to activate, and the thing under it is a link.
    // These are `<button>`s, so Enter and Space fire the native activation,
    // which synthesizes a `click` that bubbles: on a repo tile it reaches
    // `RepoTile`'s card handler, `tileOpens` sees an unmodified primary press,
    // and a reader who pressed Enter on "19 opened and 38 closed, 3 weeks ago"
    // lands on a page that sentence never mentioned. `preventDefault` on the
    // keydown is what stops the synthesized click, in all three engines.
    //
    // Only the KEYBOARD path is refused. The strip still carries no click
    // handler at all, so a mouse press on a chart falls through to the card
    // exactly as before — which is the other half of #558's bargain, and what
    // `ReposPage.spec.tsx` pins.
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      return;
    }
    const next = nextPoint(e.key, i, count);
    if (next === null) return;
    e.preventDefault();
    // The mark is moved HERE and not left to the focus that follows, so a point
    // is marked whatever the DOM does — and `onFocus` saying it again is the
    // same answer twice, not a second one.
    onPoint(next);
    // The columns are literal siblings, so the one to focus is the parent's
    // `next`th child and no ref map is needed. `DayGrid` keeps one because its
    // cells are a grid of columns of buttons; a strip is one row, and the ref
    // would be the only state this component holds — the difference between a
    // function a spec can call and one that needs a renderer to exist.
    const sibling = e.currentTarget.parentElement?.children[next] as HTMLElement | undefined;
    sibling?.focus();
  };

  return (
    // The LEAVE is the strip's. Crossing from one column to its neighbour is not
    // leaving the chart, and a per-column leave blinks the mark off between
    // every pair of points.
    <span className={STRIP} onPointerLeave={() => onPoint(null)}>
      {Array.from({ length: count }, (_, i) => (
        <button
          key={i}
          type="button"
          data-point={i}
          tabIndex={i === cursor ? 0 : -1}
          aria-label={label(i)}
          className={COLUMN}
          onPointerEnter={() => onPoint(i)}
          onFocus={() => onPoint(i)}
          onBlur={() => onPoint(null)}
          onKeyDown={(e) => move(e, i)}
        />
      ))}
    </span>
  );
}

export type MarkTreatment = 'recolour' | 'halo-dot';

/**
 * WHICH treatment a chart draws, and the one line to edit if that is ever
 * reopened (#708).
 *
 * Four existed and were rendered at tile size against each other — the hairline
 * rule that shipped first, a tinted band, a lone dot, and this — and Artur chose
 * `recolour` off the pictures. The other three are gone rather than kept behind
 * the constant: each was measured failing (the
 * band shows as two 0.5px slivers behind a 3.4px column; the hairline spends two
 * thirds of its ink on antialiasing and reads 1.20:1 in bulk; the lone dot draws
 * nothing at all on a column chart), and the renders that decided it are in the
 * lane's record. The seam stays because adding a fourth is then one branch and
 * one line, not a rewrite of four callers.
 */
export const MARK: MarkTreatment = 'recolour';

/** Selected marks use a dedicated ink: white in dark, text-primary in light.
 * The browser guard pins selected/unselected contrast at >=3.5:1 on both pages.
 * Dark measures 3.53449:1; light measures 3.58200:1. */
export const MARK_INK = 'var(--chart-selection)';

/**
 * THE DOT IS A DOT, and a `<circle>` is not one here.
 *
 * Every chart this module draws into is `preserveAspectRatio="none"`, so a
 * circle is stretched by whatever factor that chart's viewBox is stretched by.
 * Measured in headless Chrome by hit-testing the painted extent, at each
 * caller's own box: `<circle r 2.4>` came out 16.25 x 6.75 px on the flow
 * strip's depth spark (96x24 onto 330x34). Two lozenges, ninety degrees apart,
 * from one line of code.
 *
 * A ZERO-LENGTH LINE WITH A ROUND CAP is the shape instead: with a non-scaling
 * stroke it paints a circle of `stroke-width` SCREEN pixels wherever it is
 * drawn, which the same measurement reads as 4.75 x 4.75 on all four. The
 * argument is the hairline's, one paragraph down — the dot is a MARK and not a
 * measurement of anything in the chart, so screen units are the honest ones.
 *
 * 4.8 is what the dot already was on a repo tile, whose svg is 26 viewBox units
 * onto 26 CSS pixels: `2 x DOT_R` at a y-scale of exactly 1. So the tile the
 * size was chosen against does not move, and the three charts that were
 * stretching it do.
 *
 * The module cannot compute a stretch factor from what it is handed — it knows
 * the viewBox height and nothing about the box on screen — so counter-scaling
 * was not available without a new prop, and this needs none.
 */
const DOT_PX = 4.8;

/**
 * The foot tick's weight, in screen pixels, for the reason DOT_PX is in them.
 *
 * SIX FOR THREE. The tick is drawn ON the baseline — `y1 = y2 = height` — so an
 * outermost `<svg>`'s own clip (`overflow: hidden`, the UA default) removes the
 * outer half of the stroke and leaves exactly half of it inside the box, at
 * every chart and every width. It was 2 before this, which is 1 visible px on a
 * baseline that already carries a 1px `--border`: a mark the width of the
 * line it sits on.
 *
 * Drawn ON the baseline and not above it, deliberately: a mark that sits on the
 * floor cannot be read as a bar rising from it, and a 3px STUB on a series whose
 * max is 8 is within a pixel of a real "1 closed" bar and told apart by colour
 * alone. On the Releases spark that is 33 consecutive days where the mark would
 * look like data.
 */
const FOOT_PX = 6;

/**
 * THE RULE'S WEIGHT, in screen pixels, and why a hairline is not what shipped.
 *
 * #708 built a full-height rule as one of four treatments and Artur turned it
 * down off the pictures, measured at 1.20:1 in bulk. That measurement was of a
 * 1px `--muted` line at a 0.5 tint, centred on a 3.4px column: at 1 CSS
 * px a stroke lands between device pixels and spends two thirds of its ink on
 * antialiasing, so it never reaches the tone it was given. This rule is neither
 * of those things — it is `MARK_INK` at full opacity (15.85:1 on the dark card,
 * 3.53:1 over a dark bar; see that constant) and 2 CSS px, which covers
 * two whole device pixels at 1x and four at 2x and therefore paints at full
 * tone. The measurement that rejected the hairline is not a measurement of this,
 * and #877 is the reader asking for it again on the charts a dot cannot serve.
 *
 * In SCREEN pixels for `DOT_PX`'s reason: every chart here is
 * `preserveAspectRatio="none"`, so a width in viewBox units is stretched by
 * whatever that chart stretches by — 2 units is 12px on the flow strip's depth
 * spark and 1.2px on a repo tile. `non-scaling-stroke` takes the width out of
 * the transform, so the rule is 2px on all six.
 */
const RULE_PX = 2;

/**
 * WHICH COLUMN A POINT OWNS, in the caller's own viewBox units.
 *
 * The band used to be drawn from `pitch`, the point-to-point distance, and that
 * is the wrong partition of the box. `ChartPoints` lays `count` equal columns
 * over the caller's box, so the column a pointer is actually in is
 * `width / count` — and the two disagree on every chart whose points are inset
 * from its edges:
 *
 *   chart                      pitch    hit column   band at point 0
 *   repo-spark (150, PAD 3)    16.00      15.00       [-5.0, 11.0]
 *   Pulse (340, PAD 6)         29.82      28.33       [-8.9, 20.9]
 *
 * At the first and last point the band hung half outside the chart, and all
 * three of those svgs are `overflow-visible`, so it painted there — on a repo
 * tile, into the delta figure beside it. Drawn from the column instead, the
 * bands TILE the box: each starts where the one before it ended, and the last
 * ends on the far edge.
 *
 * A chart of one point needs no special case any more. One point is one column
 * and the column is the whole box, which is exactly what a mark on a chart with
 * no neighbour to be confused with should cover. The old fallback — the box's
 * HEIGHT, the only other length the module held — was not a length in x at all.
 */
export interface ChartColumn {
  /** The marked point's index. */
  i: number;
  /** How many points the chart has, which is how many columns the strip lays. */
  count: number;
  /** The caller's viewBox width, which the strip covers end to end. */
  width: number;
}

const columnBox = ({ i, count, width }: ChartColumn) => {
  const w = width / Math.max(1, count);
  return { x: i * w, width: w };
};

/** The dot's own colour, which is the CALLER's series colour and not the
 *  module's. It defaults to what every chart drew before the prop existed. */
const DOT_COLOUR = 'var(--accent)';

/**
 * What the mark is drawn from. The x, the height and the y are the caller's own
 * scale; the column is the strip's partition of the same box, which is a
 * different thing (see `ChartColumn`).
 */
export interface MarkProps {
  /** viewBox units of the CALLER's svg. */
  x: number;
  height: number;
  /** The hero series' y at the marked point, or null for a chart whose marked
   *  datum is its own COLUMN — those recolour it themselves, in `MARK_INK`. */
  y: number | null;
  /** COLUMN CHARTS ONLY, and read only where `y` is null: whether the marked
   *  column has any bar to recolour. A zero day has none, and gets the foot
   *  tick instead of nothing. The module cannot answer this itself — it holds a
   *  viewBox height and knows nothing about the caller's own scale — and the
   *  caller already has the number in its hand. */
  emptyColumn?: boolean;
  /** Which column the pointer is in, and how wide a column is. */
  column: ChartColumn;
  /** The caller's own hero-series colour, for the DOT alone. The module owns
   *  the mark's shape, the one-dot rule and `MARK_INK`; a caller owns the blue
   *  its line is drawn in, and the board has two brand tokens —
   *  `--accent` and `--accent-strong` — so a fixed default put a slightly
   *  different blue on three of the four charts. */
  colour?: string;
}

/**
 * The mark, drawn inside the CALLER's svg — which is why it is a fragment of
 * svg children rather than a component with a box of its own. Nothing here can
 * add a pixel to a tile at any hover state.
 *
 * WHAT `recolour` DRAWS HERE IS THE HALF THAT IS NOT THE CALLER'S. On a chart
 * with a series point to sit on it is the dot; on a column chart it is the foot
 * tick for the zero case, and nothing else where there is a bar — because there
 * the marked datum's own ink is what changes, and only the caller can repaint
 * that. See `MARK_INK` and this file's header.
 *
 * Line charts retain the rule from #877. Column charts use their highlighted
 * bar, or the baseline tick when the value is zero (#952).
 *
 * `treatment` is a parameter rather than the constant read inline so the spec
 * can drive every treatment directly, including one the constant is not
 * currently set to.
 */
export function drawMark(
  treatment: MarkTreatment,
  { x, height, y, column, emptyColumn = false, colour = DOT_COLOUR }: MarkProps,
): ReactElement {
  const band = columnBox(column);
  return (
    <>
      {/* Line charts keep their point rule. Column charts highlight the bar
          itself; a zero column keeps only the baseline tick (#952). */}
      {treatment === 'recolour' && y !== null && <line
          data-mark="rule"
          x1={x}
          x2={x}
          y1={0}
          y2={height}
          stroke={MARK_INK}
          strokeWidth={RULE_PX}
          vectorEffect="non-scaling-stroke"
        />}
      {/* THE ZERO DAY, WHICH HAS NO BAR TO RECOLOUR — a stretch the Releases
          spark spends its last 33 days in, so it is the ordinary case there and
          not an edge.

          A stroke ON the chart's own baseline, one column wide. Thickness is
          screen-fixed by `non-scaling-stroke` and length is in the caller's
          units, which is exactly "3px tall, one column wide" without the module
          measuring a DOM; the outermost svg's clip takes the outer half, so 6
          paints 3 (see FOOT_PX). Sitting ON the floor is the whole argument: a
          mark on the baseline cannot be read as a bar rising from it, which a
          stub of the same height can and would state a count of 1 on a day that
          counted nothing. */}
      {treatment === 'recolour' && y === null && emptyColumn && (
        <line
          data-mark="foot"
          x1={band.x}
          x2={band.x + band.width}
          y1={height}
          y2={height}
          stroke={MARK_INK}
          strokeWidth={FOOT_PX}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* At most one, ever — see the one-dot note in this file's header. A
          zero-length line with a round cap, and not a `<circle>`: see DOT_PX. */}
      {y !== null && treatment === 'halo-dot' && (
        <>
          <line data-mark="halo" x1={x} x2={x} y1={y} y2={y} stroke="var(--surface)" strokeWidth={9} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <line data-mark="dot" x1={x} x2={x} y1={y} y2={y} stroke={colour} strokeWidth={4.8} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </>
      )}
      {y !== null && treatment === 'recolour' && (
        <line
          data-mark="dot"
          x1={x}
          x2={x}
          y1={y}
          y2={y}
          stroke={colour}
          strokeWidth={DOT_PX}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </>
  );
}

export function ChartMark(props: MarkProps & { treatment?: MarkTreatment }): ReactElement {
  const { treatment = MARK, ...mark } = props;
  return drawMark(treatment, mark);
}

/**
 * The guide at a marked week on a line chart: a dashed brand rule, the variant
 * #951 chose over the primary-ink rule `drawMark` draws. Pair it with the
 * `halo-dot` treatment, which draws no rule of its own.
 *
 * It shipped on the Repos sparkline first, in #997, as a line private to
 * `repo-spark.tsx`, and the Throughput chart went on drawing the black rule
 * (#1030). It lives here so the two draw one definition. As a token,
 * `--accent` reads 5.36:1 on the card dark and 6.98 light (`MARK_INK`'s
 * table). The painted 1.5px dashed stroke has not been measured.
 */
export function ChartGuide({ x, height }: { x: number; height: number }): ReactElement {
  return (
    <line data-mark="guide" x1={x} x2={x} y1={0} y2={height} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
  );
}

/**
 * Wide enough for a sentence to keep its rhythm, narrow enough that the widest
 * one cannot reach a page edge from any tile in the grid (`repo-hint.tsx`, whose
 * measurement this is). `block` is what makes the bound bite — an inline span
 * sizes to its longest unbroken run.
 */
export const HINT = 'block max-w-[260px]';

/**
 * What the marked point READS, in words.
 *
 * It anchors to the whole chart box and NOT to the pointed column, and that is
 * deliberate. #576 measured what a right-side box covers against the chart's own
 * right edge; anchored to a column instead, the box for point 0 of a ten-point
 * chart opens over the nine points to its right — over the chart it is
 * describing. The mark says WHICH point. This says what it reads.
 *
 * `side` defaults to 'right' for the reason in this file's header: the chart
 * sits under the thing that names it, and a top-side box covers that name.
 */
export function ChartHint({
  label,
  side = 'right',
  children,
}: {
  label: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
}): ReactElement {
  return (
    <Tip label={<span className={HINT}>{label}</span>} side={side}>
      {children}
    </Tip>
  );
}

/**
 * The pointer state a chart holds, so a caller wires four handlers and keeps
 * none of the argument about what they mean.
 *
 * IT IS HANDED THE COUNT, so that neither piece of state can leave the hook out
 * of range. Both outlive a change of series — a Crew press swaps the unit's
 * twelve weeks for a member's nine, a spark loses its running day — and an index
 * the chart no longer has means something different to every caller: it throws
 * on `closed[mark][1]`, it draws a mark off the end of the chart, or it dates a
 * day that has not happened yet and puts a zero under it. `read` is clamped as
 * well as `mark`, because `read` is what the box turns into a sentence.
 */
export function useChartPointer(count: number): {
  mark: number | null;
  read: number | null;
  point: (i: number | null) => void;
} {
  const [pointer, setPointer] = useState<ChartPointer>(AT_REST);
  const point = useCallback((i: number | null) => setPointer((p) => pointAt(p, i)), []);
  return {
    mark: pointInside(pointer.mark, count),
    read: pointInside(pointer.read, count),
    point,
  };
}
