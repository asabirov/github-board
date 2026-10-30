/**
 * The cockpit flow strip (#666, #684) — Issues · Throughput · Releases over a
 * closed-per-day grid, on Your work and on Overview.
 *
 * Presentational. It fetches nothing, knows no login, reads no URL, and derives
 * nothing `flow-strip.vm.ts` already derived. It holds no clock of its own —
 * the grid's calendar rides on the model (#817), so the two halves of the strip
 * cannot date the same day differently.
 *
 * Every chart on it ANSWERS when it is pointed at (#708) — the three sparks
 * through `ui/chart-pointer` and the lattice through its own older handlers.
 * This file decides none of that behaviour: the module owns the state, the hit
 * strip, the mark and the box, and what is left here is the numbers, the two
 * shapes, one `relative` box per spark and the words each tile puts in the box.
 */
import { useState, type ReactNode } from 'react';
import { ToggleGroup, ToggleGroupItem } from '../ui/kit';
import { BLOCK, CARD_PADDING } from '../ui/block';
import { ChartHint, ChartMark, ChartPoints, MARK_INK, pointInside, useChartPointer } from '../ui/chart-pointer';
import { Placeholder } from '../ui/LoadingStructure';
import { ChangedFigure } from '../ui/changed-figure';
import type { SparkUnit, StripModel, TileModel } from './flow-strip.vm';
import { dateLabel, gridFor, sparkPointSentence, sparkTitle } from './flow-strip.vm';
import { DayGrid } from './DayGrid';
import { OldestTile } from './OldestTile';
import { MetricHelp } from './MetricHelp';

/** Which window the grid draws: `null` is the trailing 52 weeks, the default,
 *  and a number is that calendar year alone. */
type YearChoice = number | null;

/**
 * Which window is actually drawn, given what was pressed and what is on offer.
 *
 * A year the model no longer offers falls back to the trailing window rather
 * than drawing a year nothing closed in — the same shape the type switcher used
 * when a refresh took its series away. It happens on every change of selection:
 * the years come off the selected people's own closes, so a member whose history
 * starts this year offers one year where the person before them offered three.
 */
export function yearInView(picked: YearChoice, years: readonly number[]): YearChoice {
  return picked !== null && years.includes(picked) ? picked : null;
}

const TILE = `${BLOCK} ${CARD_PADDING}`;
const CAP = 'text-[11.5px] text-dim';
const BIG = 'text-[27px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-fg';
const META = 'text-[11px] tabular-nums text-muted';
/** Prose in the tertiary tone — the line under the lattice and the line a tile
 *  draws instead of a figure it does not have. No `tabular-nums`: these are
 *  sentences, not columns of digits. */
const NOTE = 'text-[11px] leading-[1.4] text-muted';
/** Full tile width, with more height when the tiles stack on phones. */
const SPARK_BOX = 'h-[34px] max-[720px]:h-[64px]';
/**
 * WHICH SIDE A SPARK'S HINT OPENS ON — measured, not chosen (#708).
 *
 * `ChartHint` defaults to RIGHT, for #576's reason: on a repo tile the chart
 * sits directly under the name and a top-side box covered it. A stat tile is not
 * that tile — the caption and a 27px figure stand between the name and the
 * spark — and these are three tiles in a row that stack into a column under
 * 720px, so the default had to be re-measured here rather than inherited.
 *
 * Measured in headless Chrome against `scripts/fixtures/team-api.json`, hovering
 * the middle column of each spark on Your work, one page load per reading. Ink
 * covered, in px², counting every caption, figure, spark and the scope line
 * under the strip — own tile and neighbours together, since a box that covers
 * the tile beside it is no better than one that covers its own:
 *
 *                1440 (three across)        719 and 390 (stacked)
 *   tile          1      2      3            1      2      3
 *   top           0      0      0            0      0      0
 *   right      3907   4038   4351          off    off    off   leaves the viewport
 *   bottom     1933   1977   2095            0      0   2177   the scope line
 *   left          0   4026   4351          off    off    off   leaves the viewport
 *
 * RIGHT AND LEFT ARE OUT ON THE STACKED LAYOUT, not on taste: a stacked spark is
 * as wide as the tile, so there is nowhere beside it for a 175px box to go.
 * Radix flips it to the other side, that does not fit either, and it settles
 * outside the viewport — x 695–870 in a 719px window, or x −165–24. Three across
 * they fit and cover the NEIGHBOURING tile's spark, which is the chart a reader
 * is not asking about.
 *
 * BOTTOM lands on the scope line — "Releases are the whole of acme." in
 * the recording — on all three tiles at 1440 and on the last tile stacked. That
 * is a sentence a reader may be part-way through, and it is the one explaining
 * the Releases spark a pointer is often on.
 *
 * TOP COVERS NOTHING AT ANY WIDTH, and #576's objection does not reach it here.
 * The box opens above the SPARK, not above the tile: at 1440 it sits at y
 * 470–500 against a caption ending at y 453, so the name is never touched, and
 * it clears the figure sideways rather than vertically — the figure is
 * left-aligned at x 294 and the box is centred on the chart at x 372.
 *
 * That clearance is the one thing here that is contingent rather than
 * structural, so it is written down. The figure is `tabular-nums` at 17px a
 * digit: at 1440 it starts at x 294 and the box at x 372, so four digits stop
 * 10px short and five would reach it; at 390 the gap is 63px, which is the same
 * four-digit answer. "Issues open" is 9 in the recording and 184 on the org #707
 * was drawn against. A five-digit stat tile is the thing that reopens this line.
 *
 * THE ZERO IS NOT A PROPERTY OF THE FIXTURE'S BARS, which is the obvious worry:
 * the box is centred on the chart and hangs over the left third of it, so a
 * TALLER bar under it would be covered and the zero would stop being true. It
 * cannot happen. The box is anchored to this spark's own box and offset OUTWARD
 * from it, and a bar is `height: (v / max) * 100%` of that same box — so the
 * tallest bar the data can draw reaches the box's top edge exactly, and the
 * readout starts above it. Re-measured on the built page over all three tiles,
 * hovering columns 0, 50 and 96: the gap between the readout's bottom edge and
 * the spark box's top edge is 3.94px at 1440, 3.5–4.25px at 719 and 3.5–4px at
 * 390, never negative anywhere. The horizontal overlap is near total (145–201px
 * of a 330px box) and costs nothing, because the two never meet vertically.
 */
const SPARK_SIDE = 'top' as const;

/** The viewBox height both sparks draw in, so a mark spanning `0..SPARK_H` is
 *  the full height of either shape. The box on screen is `SPARK_BOX`; this is
 *  the number the drawing is done in, and `preserveAspectRatio="none"` stretches
 *  one onto the other. */
const SPARK_H = 24;

/** The column spark's bars — every one of them except the marked one, which is
 *  repainted in `MARK_INK` (#708). This token stopped colouring the mark as
 *  well when that landed: a mark drawn in the series' own blue is a mark that
 *  reads 1.00:1 against the bar it stands on. */
const BAR = 'var(--chart-series)';

/** What a chart is handed: its own days, the point marked right now, and the
 *  name of the whole chart. The pointer state and the words are `Spark`'s — a
 *  chart draws, and holds nothing. That split is `repo-spark.tsx`'s, and it is
 *  what lets a spec render a MARKED chart in a test env with no DOM to point
 *  with. */
interface SparkChart {
  series: number[];
  mark: number | null;
  title: string;
  dailyGoal?: number | null;
}

/* #707: this file used to carry a `deltaLabel` copied from `repos/repos-vm.ts`
   and a `rangeLabel` printing each spark's own min..max. The tiles state a
   figure and nothing else now, so both are gone — and with `deltaLabel` goes the
   duplication its docblock flagged, so the follow-up issue it named is moot for
   this file. */

/**
 * A queue level: a line in the neutral tone, drawn to its own min..max.
 *
 * It is NOT zero-baselined: the series runs 157..170 on a base of 170, which
 * from zero is a flat rule with no information in it. Its neighbours count
 * events in a day and do baseline at zero. So the three marks share a width and
 * a height and no axis, and the spark is a shape rather than a second reading —
 * which is why #707 took its printed range off: the figure above it is the
 * reading, and the range restated its ends.
 *
 * Its right-hand end is TODAY, and that is the same rule its neighbours follow
 * rather than an exception to it (#734): a spark ends on the day its own tile's
 * figure is for. "Issues open" states the level held right now, a level is
 * complete at every instant, and `dailyDepth` walks back FROM that number — so
 * the last point of this line is the figure printed above it. The two column
 * sparks end a day earlier because their figures are counts for yesterday.
 */
/**
 * THIS SPARK DOES NOT CLIP, and it is the only one that must not (#877).
 *
 * Its viewBox is `0 0 (n-1) H` and a point sits at x = i, so the FIRST and LAST
 * points are exactly on the box's own edges — where an outermost svg's default
 * clip takes the outer half of anything centred there. The mark's rule and its
 * dot are both screen-fixed strokes centred on the point, so on those two days
 * they painted at HALF weight: 1px of a 2px rule, on the board's most-visited
 * spark, and the half-weight geometry is exactly what #708's rejected hairline
 * lost on.
 *
 * The rule may not be nudged inward to dodge it. It stands ON the datum, which
 * is the whole of what #877 asked for, and the module could not do the nudge
 * anyway: it holds a viewBox height and no way to turn screen pixels into these
 * units, which is `DOT_PX`'s argument one step on. So the clip is what goes.
 *
 * What else escapes is small and was measured: `y()` runs 3..H-2, so the line
 * never approaches the top or the floor; the polygon is a fill whose bottom edge
 * is the box's own; and the polyline's 1.25px stroke gains about 0.6px at each
 * horizontal end. `Spark` above sets no overflow and the tile has padding either
 * side, so none of it reaches a neighbour.
 *
 * `ColumnSpark`'s mark svg keeps its clip deliberately, and the two must not be
 * made to agree: its points sit at x = i + 0.5 so nothing is ever on an edge,
 * and its foot tick is drawn ON the baseline and RELIES on the clip taking the
 * outer half — six paints three (see `FOOT_PX`).
 */
const DEPTH_SVG = 'block h-full w-full overflow-visible';

export function DepthSpark({ series, mark, title }: SparkChart) {
  const W = Math.max(1, series.length - 1);
  const min = Math.min(...series);
  const span = Math.max(1, Math.max(...series) - min);
  const y = (v: number) => 3 + (1 - (v - min) / span) * (SPARK_H - 5);
  const pts = series.map((v, i) => `${i},${y(v).toFixed(2)}`).join(' ');
  // The module's answer, not this file's. It used to guard with `series[mark]
  // !== undefined`, which drew NOTHING for a stale mark while the tab stop sat
  // on the last point — a chart saying it had marked something and marking
  // nothing.
  const at = pointInside(mark, series.length);
  return (
    <svg
      viewBox={`0 0 ${W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className={DEPTH_SVG}
      role="img"
      aria-label={title}
    >
      <polygon
        data-chart-decoration="area"
        points={`0,${SPARK_H} ${pts} ${W},${SPARK_H}`}
        fill="color-mix(in srgb, var(--muted) 12%, transparent)"
      />
      <polyline
        points={pts}
        fill="none"
        stroke="var(--dim)"
        strokeWidth={1.25}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* A dot ON THE SERIES, because the line is the reading: the marked point
          has a height and the mark says which height it is. This spark draws no
          terminal dot at rest, so the module's one-dot rule costs it nothing.

          The COLUMN is the strip's partition of this box and not this chart's:
          `count` points laid over a viewBox `W` wide, so a column is `W / count`
          — very slightly under 1 here, where the viewBox is `0 0 (len - 1)` and
          a point sits at x = i. `ChartMark` does that arithmetic; this passes
          the two numbers it is done from, and they move with the viewBox. */}
      {at !== null && (
        <ChartMark
          x={at}
          height={SPARK_H}
          y={y(series[at])}
          column={{ i: at, count: series.length, width: W }}
        />
      )}
    </svg>
  );
}

/** A count of events per day: columns in brand blue, baselined at zero with the
 *  baseline drawn. A zero day draws nothing — the rule the grid's zero cell
 *  follows too, and the only honest mark for a lumpy series.
 *
 *  The last column is YESTERDAY, the day the figure above states. It was today
 *  until #734, so the rightmost bar was a day still being counted: near zero just
 *  after UTC midnight, and tall enough on a busy afternoon to flatten every
 *  settled day against it, since the tallest bar sets the scale for the rest. */
export function ColumnSpark({ series, mark, title, dailyGoal }: SparkChart) {
  const goal = dailyGoal != null && Number.isFinite(dailyGoal) && dailyGoal > 0 ? dailyGoal : null;
  // Include the target in the zero-based scale even when no day reaches it.
  const max = Math.max(1, ...series, goal ?? 0);
  const at = pointInside(mark, series.length);
  return (
    <>
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 border-t"
        style={{ borderColor: 'var(--border)' }}
      />
      {/* THE NAME GOES HERE, on the row of bars: it is the element that IS the
          chart and holds no controls of its own. `role="img"` makes its contents
          presentational, which the bars already are — empty spans carrying a
          height — and it must not be put on the box outside, because the hit
          strip's buttons live in there and role="img" would hide every one of
          their names. The line spark carries the same name on its <svg>, which is
          the same element by the same rule. */}
      <div className="absolute inset-0 isolate flex items-end gap-px" role="img" aria-label={goal === null ? title : `${title}, daily goal: ${goal} closed`}>
        {/* THE MARKED BAR IS REPAINTED, and this ternary is the whole of the
            caller's half of the mark (#708). The chart gains no ink: the marked
            point's OWN ink changes colour, so on a tall bar the mark is the
            chart's tallest object rather than a rule drawn over 3.4px. The
            module owns which point and what ink — `MARK_INK`, the only token
            that clears 3:1 against both a bar and the card in both themes — so
            there is no colour decision here to get wrong.

            No second element and no extra span: the height is untouched, so a
            marked chart and a resting one differ in one CSS property and in
            nothing that occupies space. */}
        {series.map((v, i) => (
          <span
            key={i}
            className="flex-1 rounded-t-[1.5px]"
            style={{ height: `${(v / max) * 100}%`, background: i === at ? MARK_INK : BAR }}
          />
        ))}
        {goal !== null && <div
          data-daily-goal={goal}
          className="pointer-events-none absolute inset-x-0 -z-10 border-t border-dashed"
          style={{ top: `${(1 - goal / max) * 100}%`, borderColor: 'var(--chip-warn-ink)' }}
        />}
      </div>
      {/* WHAT IS LEFT FOR THE MODULE TO DRAW, on the days the recolouring above
          cannot say anything about. It rides in an svg of its own because the
          bars are laid out in HTML, not drawn — and `ChartMark` is svg children,
          so that nothing here can add a pixel to a tile at any state.
          `preserveAspectRatio="none"` over one viewBox unit per column puts
          x = i + 0.5 down the middle of column i; the 1px gutters make that off
          by half a pixel at the far end of a 97-column spark.
          NO DOT (`y={null}`): a column spark's reading IS its own bar, so the
          bar is what the mark repaints, and a dot hanging over it would be the
          second mark the module forbids. On the days with no bar the svg carries
          the foot tick instead, which is the case the Releases spark spends its
          last month in. */}
      <svg
        viewBox={`0 0 ${series.length} ${SPARK_H}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 block h-full w-full"
      >
        {/* The viewBox is `0 0 series.length SPARK_H`, one unit per column, so
            the strip's column and this chart's column are the same unit — the
            one caller where the two partitions coincide exactly.

            `emptyColumn` is the only thing the module cannot work out for
            itself: a zero day has no bar for the recolouring above to land on,
            so it gets the tick on the baseline instead. `v / max` is this file's
            scale and nowhere else's, which is why the answer comes from here. */}
        {at !== null && (
          <ChartMark
            x={at + 0.5}
            height={SPARK_H}
            y={null}
            emptyColumn={series[at] === 0}
            column={{ i: at, count: series.length, width: series.length }}
          />
        )}
      </svg>
    </>
  );
}

/**
 * A spark that answers, which is every spark on this strip (#708).
 *
 * The pointer state, the hit strip, the mark and the words all come from
 * `ui/chart-pointer` and none of them is decided here — this file owns the
 * numbers, the two shapes and one `relative` box for the strip to cover, and
 * that is the whole of a caller's half of the bargain.
 *
 * ONE WRAPPER FOR BOTH SHAPES rather than one each: the columns, the hint and
 * the box are identical for a line and for bars, and only the drawing differs.
 * Two wrappers would be two places to keep the same wiring in step.
 *
 * The hint reads the LAST point before a pointer has landed anywhere — never an
 * empty box, and never the tile's own figure dressed up as an answer about a day
 * nobody pointed at. `read` holds the last point actually pointed at, which is
 * why leaving the chart to the right does not rewrite the box on the way into it.
 */
function Spark({ series, endsOn, unit, dailyGoal }: { series: number[]; endsOn: number; unit: SparkUnit; dailyGoal?: number | null }) {
  // The count goes in so neither the mark nor the reading can outlive the
  // series. `sparkPointSentence` dates a point by counting back from the last
  // day, so a `read` past the end printed a day that has not happened yet with a
  // fabricated zero under it.
  const { mark, read, point } = useChartPointer(series.length);
  const say = (i: number) => sparkPointSentence(series, endsOn, i, unit);
  const chart = { series, mark, title: sparkTitle(series, endsOn, unit), dailyGoal };
  return (
    <ChartHint label={dailyGoal != null && dailyGoal > 0 ? `${say(read ?? series.length - 1)}; daily goal: ${dailyGoal} closed` : say(read ?? series.length - 1)} side={SPARK_SIDE}>
      {/* `relative` so the absolute strip can cover it, and SPARK_BOX so the
          height is fixed whatever a pointer draws. */}
      <div className={`relative w-full ${SPARK_BOX}`}>
        {unit.reading === 'level' ? <DepthSpark {...chart} /> : <ColumnSpark {...chart} />}
        <ChartPoints count={series.length} label={say} onPoint={point} at={mark} />
      </div>
    </ChartHint>
  );
}

/**
 * What each tile's spark measures, in that tile's own words.
 *
 * THE TWO ARE NOT THE SAME KIND OF NUMBER, and the words a pointer gets are now
 * the only place that line is held: "Issues" is a LEVEL standing that day,
 * "Closed" a COUNT of things that happened in it, and neither caption says so
 * any more (#752, #821). So the level's noun leads — "9 issues open", which
 * cannot be read as nine issues OPENED that day — while a count's number leads
 * its verb, and a count of zero says "nothing closed" where a level of zero
 * says "0 issues open", a reading rather than an absence. `flow-strip.vm.ts`
 * owns that grammar; these are the words it is spent on.
 *
 * Neither chart name may say a phrase struck from a caption. They were "Issues
 * open, day by day" and "Closed each day", after #752 had taken the first off
 * the Issues tile and #817 the second off the grid, and a screen reader went on
 * reading both aloud until #979, because `struck-copy.spec.tsx` read only the
 * text a sighted reader sees. It reads accessible names too now.
 */
const OPEN: SparkUnit = { chart: 'Open issues', word: 'issues open', reading: 'level' };
const CLOSED: SparkUnit = { chart: 'Issues closed per day', word: 'closed', reading: 'count' };

/**
 * One stat tile: a caption naming the figure, the figure, and a spark.
 *
 * THE CAPTION SAYS THE UNIT (#707). "Issues / 184 / open now / −1 since
 * yesterday" said the same thing three times over and still needed the words
 * "since yesterday" to keep the Issues delta from being read as Throughput's;
 * "Issues open / 184" says it once. So the unit moved into the caption, the
 * figure stands alone, and the delta went entirely — sign and words. A bare
 * signed delta was drawn and turned down: with the words gone, nothing would say
 * that Issues is measured since yesterday while Throughput is yesterday against
 * the day before.
 *
 * #752 TOOK IT BACK OUT OF THE FIRST CAPTION, which now reads "Issues", and
 * #821 out of the second, which now reads "Closed". What each tile gave up is
 * the same thing: the caption no longer says which day the figure is for, or
 * whether it is a level or a count. The spark holds both — "Open issues" and
 * "Issues closed per day", each named "over the N days to <date>", with every
 * point dated (`OPEN` and `CLOSED` above). Each decision is recorded at its own
 * render site, not here.
 *
 * The spark loses its label and its printed range with them. A shape under a
 * figure needs no second caption, and the range restated the figure's own ends.
 *
 * WHICH IS ALSO WHY THE SPARK HAS TO ANSWER (#708). With the label and the range
 * gone the shape says nothing a reader can name, and pointing at it changed
 * nothing at all: a screenshot with the pointer held on the tallest column of
 * the Releases spark was byte-identical to one taken with it anywhere else.
 * Every point is a column now, with the date and the reading on it.
 *
 * WHATEVER DAYS IT IS HANDED, and they end on the day this tile's figure is for
 * — the vm's `sparkDays` decides that once, for all three tiles and both spark
 * kinds (#734), which is why the depth line under "Issues open" runs a day
 * further than the two count sparks. A tile left with fewer than two days holds
 * no series at all and draws "No daily history" beside the figure it can still
 * state.
 */
function Tile({ cap, tile, subject, unit, dailyGoal, note, unreadable, copied = false, pending = false, onOpen, notComparable = false }: {
  cap: string;
  notComparable?: boolean;
  onOpen?: () => void;
  tile: TileModel;
  /** What THIS tile's figure is about, for the mark on it (#824). Per tile and
   *  not per strip, because the three do not share a subject: under a Crew press
   *  Issues and Throughput are that person's while Releases stay org-wide, which
   *  is the relationship the scope line under the tiles states in words. */
  subject: string | undefined;
  /** What this tile's spark measures, in this tile's own words — the noun a
   *  point takes, the name the whole chart takes, and which of the two kinds of
   *  reading it is (#708). ONE prop rather than two: the kind decides both which
   *  shape is drawn and which grammar the sentence takes, and two props that had
   *  to agree could disagree. */
  unit: SparkUnit;
  dailyGoal?: number | null;
  /** A fact about the figure that the figure cannot state — Releases' truncated
   *  list. Not a restatement of it: those are what #707 took off. */
  note?: string;
  /** What the tile says when it holds no figure at all — the source named, in
   *  the board's own words for a read that did not land. */
  unreadable: string;
  /** The figure is a copy drawn after a failed read (#1046). */
  copied?: boolean;
  pending?: boolean;
}) {
  const series = tile.series;
  const known = tile.n !== null;
  return (
    <div className={`${TILE} flex flex-col`} data-spark-card={cap} aria-busy={!known && pending}>
      {/* The caption alone. It carried `across acme and globex` beside
          Releases until #714's review: the line under the strip already says
          "Releases are the whole of acme and globex." sixty pixels
          below, so the tile was restating one clause of a sentence the reader
          was about to read. One scope line per strip, and it is that one. */}
      {/* The note takes no line box of its own (`leading-none`): beside the
          caption, its 11px box would make the row taller than the caption
          alone, and the tile would grow when the figure lands. */}
      <div className="flex items-baseline gap-2 [&>span+span]:leading-none">
        <span className={CAP}>{onOpen && known ? <button type="button" onClick={onOpen} className="cursor-pointer hover:underline focus-visible:underline">{cap}</button> : cap}</span>
        {copied && known && <span className={META}>{COPY_NOTE}</span>}
        {!known && <span role="status" aria-label={pending ? `Loading ${cap.toLowerCase()}` : unreadable} className={META}>{pending ? 'Loading' : 'Unavailable'}</span>}
      </div>
      {!known ? (
        <div aria-hidden="true">
          <Placeholder still={!pending} className="mt-2 h-[27px] w-12 bg-elevated" />
          <Placeholder still={!pending} className={`mt-4 w-full bg-elevated ${SPARK_BOX}`} />
        </div>
      ) : (
        <>
          <div className="mt-2 flex items-baseline gap-2.5">
            {/* Marked for well under a second when the poll replaces it with a
                different number about the same thing (#824). The previous
                reading is held inside `ChangedFigure`, so this file stays
                presentational and the model it is handed grew no field. */}
            <ChangedFigure value={tile.n} subject={subject} className={BIG} />
            {notComparable && <MetricHelp label="Not comparable" align="left" compact>Not comparable</MetricHelp>}
            {note && <span className={META}>{note}</span>}
          </div>
          <div className="mt-4 w-full">
            {/* `series` and `endsOn` are set together by the vm's `sparkDays` —
                a tile never holds days without a calendar for them — and both
                are named here because that is what makes the pair readable as
                the one thing it is. */}
            {series && tile.endsOn !== null
              ? <Spark series={series} endsOn={tile.endsOn} unit={unit} dailyGoal={dailyGoal} />
              : <div className={`${META} ${SPARK_BOX}`}>No daily history</div>}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The year switcher, in the board's own segmented control — the same four class
 * strings the queue's list/board toggle is built from, imported rather than
 * copied.
 *
 * "Last 12 months" leads and is the default, because that is what GitHub's
 * contribution graph opens on and the trailing year is the only window that is
 * the same length every day of the year. The calendar years follow it newest
 * first.
 *
 * It renders only where a second year exists to switch TO — `StripModel.years`
 * argues that where it is derived.
 */
export function YearSwitch({ value, years, onChange }: {
  value: YearChoice;
  years: number[];
  onChange: (v: YearChoice) => void;
}) {
  return (
    <ToggleGroup type="single" value={value === null ? 'trailing' : String(value)}
      treatment="track" size="sm" aria-label="Year"
      onValueChange={(next) => {
        if (next === 'trailing') onChange(null);
        else if (next && years.includes(Number(next))) onChange(Number(next));
      }}>
      <ToggleGroupItem value="trailing">Last 12 months</ToggleGroupItem>
      {years.map((year) => <ToggleGroupItem key={year} value={String(year)}>{year}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}

/**
 * The line under the lattice, when there is one to draw.
 *
 * NOTHING AT ALL is the ordinary case since #707. "Whole weeks, ending last
 * Sunday. Shades are quartiles over every day in the window." restated what the
 * grid draws and how it is shaded, and both are now answered by pointing at a
 * day: the hover chip and the cell's `aria-label` each name the date and the
 * count. That is the trade — what a shade stands for is no longer readable at a
 * glance — and it was made deliberately.
 *
 * ONE LINE IS LEFT, over an all-zero grid, because uniformly zero cells are the
 * form factor of a skeleton loader and the block has no loading state a reader
 * could tell it from. It counts the days the series REACHES and not the days
 * drawn: a 52-week grid opens on months nobody watched (#817), those draw as
 * nothing at all, and calling them quiet would be the falsehood the null cell
 * exists to avoid.
 *
 * The second line went with the type switcher. It warned that the three tiles
 * and the shade scale had not narrowed with the filter, and there is no filter
 * left for it to be about.
 */
function gridNote({ quiet, days }: { quiet: boolean; days: number }): string | null {
  return quiet ? `Nothing closed on any of these ${days} days.` : null;
}

/** What the lattice is of, said once — the block's caption and the grid's own
 *  accessible name are the same words, so they are the same string.
 *
 *  "Issues closed" (#817). It was "Closed each day", which named the grid's unit
 *  twice over: every cell is a day and the block is a calendar.
 *  `struck-copy.spec.tsx` holds the old phrase now. */
const GRID_UNIT = 'Issues closed';

/** What a tile says beside its caption when its figure is a copy the page held
 *  or saved, drawn because the live read failed (#1046). One quiet line with no
 *  age, as the reporter asked. A saved copy's data is never older than
 *  `SAVED_COPY_MAX_AGE_MS`; a held one is whatever `useCachedState` kept, which
 *  for the metrics can be older, since their key is not wiped at page load. A
 *  tile with no copy at all still names the read that failed, and a real zero
 *  is a figure, so neither reads as this. */
export const COPY_NOTE = 'Saved copy';

/**
 * `scopeLine` is a slot, not a derivation: which surface is filtered to whom is
 * the host page's fact, and this component reads no URL and knows no login. It
 * renders BETWEEN the tiles and the grid because that is what it is a caption
 * on — below the strip it lands against whatever the page draws next, and on
 * Overview that is a row of per-member stat tiles it would be read as labelling.
 *
 * `subject` is a slot for the same reason (#824). The mark on a figure means the
 * number moved, so it needs to know the number is still about the same thing —
 * and who the tiles are counting is the page's fact, held by the page as the
 * selection it read out of the URL. This component derives none of it and
 * remembers none of it: the two tiles that re-scope take the caller's word for
 * their subject, and Releases takes the orgs the delivery read says it counted,
 * which is in the model already.
 */
/* NO `now` PROP any more (#817). The grid's calendar moved onto
   `StripModel.window`, which carries the day the series ends on, so the year
   switcher cuts a second window out of the model rather than out of a clock
   this component holds separately — and a component holding a second clock is
   the drift the window exists to stop. It stayed in the signature unread for a
   while, passed by both hosts, which is one more thing to keep in step than
   this file needs. */
export function FlowStrip({ model, scopeLine, subject, onIssues, onClosed, fromCopy, pending, dailyGoal, level2Goal, level3Goal, goalNote, notComparable }: {
  model: StripModel;
  notComparable?: { queue: boolean; metrics: boolean };
  /** Pending reads with no figure; failures must never keep pulsing. */
  pending?: { queue: boolean; metrics: boolean };
  onIssues?: () => void;
  onClosed?: () => void;
  scopeLine?: ReactNode;
  /** Which of the two reads the tiles count from failed while the page still
   *  drew a copy of it, held or saved (#1046): the queue for Issues and The
   *  oldest, the metrics for Closed. Each tile drawn from one says so. */
  fromCopy?: { queue: boolean; metrics: boolean };
  /** What Issues and Throughput are about, as an opaque key — `changed-figure`'s
   *  `Reading` says what one is. A caller that passes nothing has said nothing
   *  about what its figures count, and those two tiles then mark no movement at
   *  all: silence is the honest answer where the alternative is a chevron over a
   *  number that changed subject rather than value. */
  subject?: string;
  dailyGoal?: number | null;
  level2Goal?: number | null;
  level3Goal?: number | null;
  goalNote?: string;
}) {
  const [picked, setPicked] = useState<YearChoice>(null);
  // AND THE PRESS IS DROPPED, not only masked. Masking alone left `picked`
  // standing behind the fallback, and this component is never remounted —
  // `FlowStrip` is rendered with no `key` — so it came back the moment the year
  // was offered again: pick 2025 for one member, select another whose history
  // starts this year, select the first back, and the grid is on 2025 with nobody
  // having pressed anything. React's own answer for state that has to follow a
  // prop, adjusted during the render rather than in an effect, so no wrong grid
  // is ever committed. The offer is compared as text because `model.years` is a
  // fresh array on every derivation — by identity this would clear the press on
  // every auto-refresh.
  const offer = model.years.join(',');
  const [offered, setOffered] = useState(offer);
  if (offered !== offer) {
    setOffered(offer);
    if (yearInView(picked, model.years) === null) setPicked(null);
  }
  const year = yearInView(picked, model.years);

  // The columns, the scale and the day the grid ends on all come from the vm:
  // the trailing year is the model's own, a calendar year is the same rule over
  // a different span of the same history. The end date rides on the same object
  // rather than being re-derived from a tile's series here — that series stops
  // at yesterday (#734), and a date counted back from it moved the grid by a day
  // every Sunday.
  const grid = gridFor(model, year);
  // OBSERVED days, not drawn ones. Half a 52-week grid is days older than
  // board-api's first close; they draw as nothing, and a count that included
  // them would tell a reader the board was quiet through months nobody watched.
  const observed = grid ? grid.weeks.flat().filter((n): n is number => n !== null) : [];
  const days = observed.length;
  const quiet = days > 0 && observed.every((n) => n === 0);
  const note = gridNote({ quiet, days });
  /* HOW FAR BACK THIS GRID REACHES, AND WHERE IT STOPS (#895). Keep the range in
     the accessible group name, where a screen reader can recover the date truth,
     without repeating it as a sighted caption under Issues closed (#950). It
     tracks the year switcher because `gridFor` cuts `endsOn` and the drawn days
     out of whichever span is pressed. */
  const span = grid && days > 0 ? `${days} days to ${dateLabel(grid.endsOn)}` : null;

  const queueComparison = !!notComparable?.queue && model.issues.n !== null;

  return (
    <div className="mb-6">
      <div className="grid grid-cols-3 gap-4 max-[720px]:grid-cols-1">
        {/* The first tile is captioned "Issues" (#752). It said "Issues open"
            until then, to hold #707's level-against-a-day line against its two
            neighbours; that distinction is dropped here on purpose. The spark's
            own accessible name still carries it — see `OPEN` above, which reads
            the chart out as "Open issues, over the N days to <date>" without
            saying the struck caption again. */}
        <Tile
          cap="Issues"
          onOpen={onIssues}
          tile={model.issues}
          subject={subject}
          unit={OPEN}
          unreadable="The issue queue couldn’t be read just now."
          notComparable={queueComparison}
          copied={fromCopy?.queue}
          pending={pending?.queue}
        />
        {/* The second tile is captioned "Closed" (#821). It said "Closed
            yesterday", and the day was carrying real weight: this figure is a
            COUNT of one day, so "Closed 1" alone does not say whether that is
            yesterday, this week or since the board was built.

            WHAT ANSWERS IT NOW IS THE SPARK, on #752's precedent one tile to the
            left. Its accessible name is "Issues closed per day, over the 30
            days to Wed 2 Sep" and every column is dated — and the last column IS this
            figure, because `sparkDays` ends each series on the day its own
            tile's figure is for (#734). So the day is one hover or one screen
            reader away rather than in the caption, and `struck-copy.spec.tsx`
            holds that half of the trade against a spark that stops saying it.

            WHAT IT COSTS is a reader who never points at the shape: they get
            "Closed 1" and nothing on the tile tells them which day. That was
            accepted rather than overlooked. Two ways of paying it back were
            drawn and turned down for now — a date under the spark's right end,
            and one line under the row saying the counts are yesterday's — both
            of which put ink back that #707 and #752 spent two issues taking
            off. */}
        <Tile
          cap="Closed"
          onOpen={onClosed}
          tile={model.throughput}
          subject={subject}
          unit={CLOSED}
          dailyGoal={dailyGoal}
          unreadable="Closed issues couldn’t be read just now."
          notComparable={!queueComparison && notComparable?.metrics}
          copied={fromCopy?.metrics}
          pending={pending?.metrics}
        />
        {/* AND THE THIRD IS NOT A TILE (#816). "Released yesterday" stated a
            count of one day's releases, which on this board is 0 on most days
            and is not a thing anybody can act on either way. The oldest open
            issue is: it has an age, a title, an owner and a menu.

            It is deliberately a different shape from the two above, and the two
            above were deliberately left alone. `OldestTile.tsx` argues both
            halves of that, and it owns the session read the menu needs, so the
            promise at the top of this file still holds for everything drawn
            here. */}
        <OldestTile view={model.oldest} pending={pending?.queue} note={fromCopy?.queue ? COPY_NOTE : undefined} />
      </div>
      {/* The slot IS the gap between the tiles and the grid, 24px with or
          without a line in it, so a Crew press that draws the line moves
          nothing (#968) and an empty slot adds no space of its own (#1450). */}
      <div className="min-h-6">{scopeLine}</div>
      {/* ONLY THIS BLOCK CHANGES SPAN. The switcher sits inside it rather than
          above the tiles, because the three tiles above are trailing figures
          and picking a year says nothing about them.

          `queue-housed` is what gives the switcher its two tones: the track
          takes the region's chrome and the pressed segment the step raised out
          of it (#447). */}
      {/* `data-flow-grid` is the strip's stable hook, and it exists for
          `scripts/check-phone-overflow.mjs`: that guard used to anchor on the
          note's id, which #707 made conditional — the note is absent in the
          ordinary case now. */}
      <div className={`${TILE} queue-housed`} data-flow-grid>
        <div className="flex items-center justify-between gap-3">
          <span className={CAP}>{GRID_UNIT}</span>
          {model.years.length > 1 && (
            <YearSwitch value={year} years={model.years} onChange={setPicked} />
          )}
        </div>
        <div className="mt-3">
          {grid && days > 0 ? (
            <DayGrid
              level2Goal={level2Goal}
              level3Goal={level3Goal}
              dailyGoal={dailyGoal}
              weeks={grid.weeks}
              scale={grid.scale}
              endsOn={grid.endsOn}
              /* The block's own caption, and then the span in the accessible
                 name: a reader who cannot see the grid still has its range and
                 end date. It counts the days that ANSWER, which is the same set
                 as the cells that exist: months before the first close have no
                 button in them.

                 A COMMA and not an em dash. This string is read out rather than
                 drawn, and a dash is announced as a pause nobody wrote — the
                 same argument #818 made for a cell's own sentence, and the one
                 `scripts/copy-gate` now holds every user-facing string to. */
              label={`${GRID_UNIT}, ${span}`}
              describedBy={note === null ? undefined : 'flow-grid-note'}
            />
          ) : (
            <div className={`${META} py-6`}>No daily history to draw yet.</div>
          )}
        </div>
        {goalNote && <p className="mt-2 text-xs text-dim">{goalNote}</p>}
        {note !== null && (
          <div className="mt-2.5">
            <span id="flow-grid-note" className={NOTE}>{note}</span>
          </div>
        )}
      </div>
    </div>
  );
}
