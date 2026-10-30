/**
 * Closed-per-day as a calendar grid (#684, #817): one cell per UTC day, seven
 * rows, one column per week, brand blue carrying the count. Never Github green —
 * nothing on this board is green, and closed is already blue everywhere here.
 *
 * The columns arrive from the vm: whole Monday→Sunday weeks, oldest first, a
 * short last column where the span ends mid-week, and `null` for any day the
 * series does not reach. This component paints them and derives nothing about
 * the calendar itself — not the columns, not the shade a count takes.
 */
import { GoalFlame } from '../goals/GoalFlame';
import { tooltipSurface } from '../ui/kit';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DAY_MS, DAYS_PER_WEEK, DOW, MONTHS, dateLabel, mixPercent, flameLevel, type DayCount, type ShadeScale } from './flow-strip.vm';

/**
 * The gutter, as a share of the CELL rather than a count of pixels.
 *
 * A flat 2px gutter is 2.4% of the cell across and 18% down on a 24px-pitch
 * grid, so columns touch while rows are visibly split — that alone turns a grid
 * into stripes. Sizing the swatch as a percentage of its slot makes the gutter
 * the same fraction on both axes at every width, and now that the cell is
 * square the two fractions are the same number of pixels as well.
 */
const SWATCH = '92%';

/** Width of the weekday label column. */
const LABEL_W = 26;

/** Height of the month-label row above the grid. */
const MONTH_H = 14;

/**
 * The chip's width, and so half of it — the clamp that keeps a chip centred on
 * an edge cell inside the block it is drawn in. ONE number, spent twice, because
 * a width in a class and a half-width in the placement arithmetic are two copies
 * of the same fact and only one of them gets changed.
 *
 * Retain the 212px minimum measured for the former UTC-labelled sentence
 * (#1034). #1121 drops that marker, so the shorter date and count still fit.
 * `min-width` lets an unexpectedly long sentence grow without clipping.
 */
export const CHIP_W = 212;

/**
 * The clearance a cell needs ABOVE it before the chip may open upward: the
 * chip's own height plus the 6px it stands off by.
 *
 * A FACT ABOUT THE CHIP, NOT ABOUT THE GRID, which is the whole reason the row
 * pitch could not answer it any more. The test used to be "is this one of the
 * top two rows", which was the same question while a row was a fixed 24px tall.
 * A square cell is ~19px at the rail and ~6px on a phone, where three rows still
 * do not clear the box and the chip would be drawn off the top of the card.
 *
 * IT IS ONE LINE BECAUSE THE CHIP CANNOT WRAP, which is what makes this number
 * a derivation rather than a guess. It was a guess: the number was read off "11px
 * at 1.35 leading inside 6px of padding" while the chip was a 152px content box
 * with no `whitespace-nowrap`, so 163 of a year's 367 sentences took two lines —
 * 41.69px against the 26.84px this assumed, and 12.69px of the chip landing on
 * the caption above the grid at 390px. The wrap was the ordinary case, not the
 * rare one, because the zero sentence is the longest.
 *
 * So the shape answers it instead of a constant tracking it: `whitespace-nowrap`
 * on a box at least as wide as the longest sentence is one line by construction,
 * and one line in the kit tooltip's type is 30.5px with its padding and border,
 * measured on the page (#1028), plus the 6px standoff in the transform below.
 * The alternative was to measure `offsetHeight` after the chip renders,
 * which costs a second pass on every hover to place a box whose height cannot
 * vary once it cannot wrap.
 */
export const CHIP_CLEARANCE = 37;

/**
 * Of the kit tooltip's surface, the width cap and the wrapping. A tooltip wraps
 * at `--layout-80`; the chip is one line, and `CHIP_CLEARANCE` is derived from
 * that. Everything else in `tooltipSurface` is how a tooltip looks.
 */
const WRAPS = /^(max-w-|overflow-|break-)/;

/**
 * The chip's classes. `w-max` and `whitespace-nowrap` against `CHIP_W` as a
 * `min-width` keep the box exactly one line tall whatever it says, which is the
 * whole of what `CHIP_CLEARANCE` is derived from, and what a fixed width with
 * wrapping left to chance could not promise. The rest is the kit Tooltip's own
 * look (#1028), read off the constant the kit's `TooltipContent` wears rather
 * than copied, so this chip matches the board's other tooltips on every kit
 * release. `DayGrid.spec.tsx` reads that constant, the installed kit's
 * `TooltipContent` and the built `text-xs` rule, and fails when any stops
 * matching what this was measured in.
 */
export const CHIP_CLASS = [
  'pointer-events-none absolute z-10 w-max whitespace-nowrap tabular-nums',
  ...tooltipSurface.split(/\s+/).filter((cls) => !WRAPS.test(cls)),
].join(' ');

/**
 * `weekAlignedGrid` always cuts whole ISO weeks, so row 0 is a Monday and row 6
 * a Sunday. Every weekday label is derived from that one fact. The preview
 * pinned Mo/We/Fr to rows 1/3/5, which is only true when row 0 is a Sunday —
 * true of its fixture, whose today is a Saturday, and false the rest of the
 * week.
 */
const FIRST_ROW_WEEKDAY = 1; // ISO Monday
const weekdayLabel = (row: number) => DOW[(FIRST_ROW_WEEKDAY + row) % 7]!.slice(0, 2);

const mixBrand = (pct: number) => `color-mix(in srgb, var(--accent-strong) ${pct}%, var(--surface))`;

/** Every cell has the same inset hairline; hovering replaces it with the hover ring. */
const CELL_OUTLINE = { boxShadow: 'inset 0 0 0 1px var(--border)' };

/** A zero day uses the page surface with a
 *  hairline. "Nothing closed" is a different kind of fact from "one thing
 *  closed", not the bottom of the same scale, so it is off the ramp entirely and
 *  the count itself selects this treatment, even when a positive count rounds
 *  to 0% brand fill. */
const ZERO_CELL = { background: 'var(--surface)', ...CELL_OUTLINE };
/** The hovered cell's mark (#1028): a 1px ring in the secondary text colour. It
 *  shows on a blue cell and on a zero cell in both themes without being the
 *  black 2px box #937 drew. Inset, because a ring outside the swatch is clipped
 *  by the scroller along the bottom row and the last column. */
export const HOVER_CELL = { boxShadow: 'inset 0 0 0 1px var(--dim)' };

/**
 * A numbered cell's fill and ink. The ink flips from the pale-fill ink to the
 * deep-fill ink at `--day-ink-flip` (#953). All three are board tokens in
 * app.css, set per theme and per accent (#1450).
 *
 * The flip is a token because it depends on the accent, and only CSS knows the
 * accent. The clamp makes a step: `pct` and the flip are whole numbers, so the
 * mix is exactly 0% or 100% of the deep ink, and the deep ink starts at the flip.
 *
 * THE KIT'S TWO INKS CANNOT COVER THE LIGHT RAMP, whatever the flip. Two inks
 * can only promise the square root of their own contrast on the fill where they
 * cross. Black and white are 21:1 apart, which promises 4.58:1, so light prints
 * in those. The dark Phoenix, Ocean and Emerald ramps need them too. Each flip
 * is where black and white cross on that ramp, not a value chosen by eye.
 * `day-grid-contrast.spec.tsx` computes the ratio for every per cent the ramp
 * makes, in both themes and with each accent, from the installed kit and
 * app.css, and fails on the first cell under 4.5:1.
 */
export const dayCellPaint = (pct: number) => ({
  background: mixBrand(pct),
  color: `color-mix(in srgb, var(--day-ink-on-deep) clamp(0%, calc((${pct} - var(--day-ink-flip) + 1) * 100%), 100%), var(--day-ink-on-pale))`,
});

/** Every day gets its own blue (#720). The percentage is the vm's — this file
 *  spends it against the block's own fill, so the ramp is monotonic in both
 *  themes and carries no literal colour. */
const fillFor = (n: number, scale: ShadeScale) => {
  const pct = mixPercent(n, scale);
  return n === 0
    ? ZERO_CELL
    : { ...dayCellPaint(pct), ...CELL_OUTLINE };
};

/**
 * A day the grid draws and the series does not reach: a CELL, dimmed.
 *
 * It drew nothing at all in the first cut of #817 — no swatch, no outline, no
 * button — and Artur turned that down on the rendered page: "make empty cells,
 * dont just leave empty space". Half a year of void on the left is a hole where
 * a calendar should be, and a hole reads as something failing to render.
 *
 * It shares the recorded-zero fill now (#947), so a no-data cell and a measured
 * zero have one visual treatment. These days still have no reading: the first
 * close in either org is 2026-03-08, so a 52-week grid opens on months the board
 * was not watching, and painting them as zeroes would report a quiet spring that
 * was never counted. Absent, empty and zero remain distinct data states here.
 *
 * It ANSWERS to a pointer and takes no focus. A visible cell that ignores the
 * mouse while the cell beside it answers is a worse trap than the void was, so
 * it draws the same chip with the sentence a day nobody counted deserves — "not
 * recorded", never "nothing closed". It stays out of the keyboard walk and off
 * the accessibility tree, because there is no reading to walk to and none to
 * report; the roving tab stop and `expectedDayCells` both count buttons, and
 * this is not one.
 *
 * The slot occupies its square either way, so the grid stays exactly seven rows
 * tall and does not shift as the week fills in. Two days arrive here: one of the
 * running week that has not happened yet, and one older than anything board-api
 * holds. They are the same absence and share one branch.
 */
// Unobserved days share the recorded-zero fill (#947), while their null value,
// hover sentence and lack of a button continue to preserve the data truth.
const UNREACHED_CELL = ZERO_CELL;

/** What an unreached day says when pointed at. Not `cellSentence`'s wording:
 *  that one is about a count, and this day has none. */
const unreachedSentence = (t: number) => `${dateLabel(t)}, not recorded`;

/**
 * What a cell says, in the chip and to a screen reader. A grid is read by
 * position, so a cell names its date — "Sat 22 Aug", never "12d ago".
 *
 * IT NAMES NO SLICE ANY MORE (#817). With Bugs selected, a zero used to read
 * "no bugs closed" beside "3 bugs closed", because "nothing closed" was a
 * falsehood about a day that closed twelve chores. The type switcher is gone,
 * so there is no slice left to be wrong about and no filtered register to keep
 * a zero in step with: a zero is "nothing closed" and a count is "3 closed",
 * which is what they said before the filter existed.
 *
 * Since #709 took the key off the grid this sentence is the only thing left
 * decoding a cell, and only a day the series reaches gets one at all — an
 * unobserved day draws no button, so there is nothing to name.
 */
function cellSentence(t: number, n: number, goal?: number | null, level2?: number | null, level3?: number | null): string {
  // The separator is a COMMA and not an em dash (#818): this string is read out
  // as well as drawn, and a dash is read as a pause nobody wrote.
  const level = flameLevel(n, goal, level2, level3);
  return `${dateLabel(t)}, ${n === 0 ? 'nothing closed' : `${n} closed`}${level ? `, at or over level ${level} (${[goal, level2, level3][level - 1]} closed)` : ''}`;
}

interface Chip { left: number; top: number; cell: number; below: boolean; text: string }

/** A cell's own box, as the four numbers the chip is placed from. `cell` is its
 *  height, named the way the chip carries it. */
interface CellBox { left: number; top: number; width: number; cell: number }

/**
 * Where a cell's chip goes, from its own box and the visible scroll interval
 * in inner-grid coordinates.
 *
 * SPLIT OUT SO IT CAN BE READ WITHOUT A BROWSER. Both rules here are invisible
 * to every check this repo has — the chip renders on hover, and the suite has no
 * DOM to hover with — and both have already been wrong on the page: the chip
 * once opened upward off the top of the card, and once landed 877px from the
 * cell it described. What they say is that a cell too near the top opens
 * downward instead, and that a chip centred on an edge cell is pulled back
 * inside the block by half its own width.
 */
export function chipPlacement(box: CellBox, wrapWidth: number, scrollLeft = 0, chipWidth = CHIP_W): Omit<Chip, 'text'> {
  const mid = box.left + box.width / 2;
  return {
    // A wrapper that has not been measured yet cannot say where its edges are,
    // and guessing one is worse than a chip that hangs over by a few pixels.
    left: wrapWidth === 0 ? mid : Math.min(Math.max(mid, scrollLeft + chipWidth / 2), scrollLeft + wrapWidth - chipWidth / 2),
    top: box.top,
    cell: box.cell,
    below: box.top < CHIP_CLEARANCE,
  };
}

export function DayGrid({ weeks, scale, endsOn, label, describedBy, dailyGoal, level2Goal, level3Goal }: {
  /** One column per week, oldest first and Monday first within a week. The last
   *  may be SHORT — the running week through today — so nothing here may
   *  flatten it: flattening loses exactly the shortness the grid is drawing. A
   *  `null` is a day the grid reaches and the series does not. */
  weeks: DayCount[][];
  /** Cut over the drawn window's settled days, by the vm. */
  scale: ShadeScale;
  /** UTC midnight of the LAST DRAWN day — the last cell of the last column, and
   *  the grid's right-hand edge. */
  endsOn: number;
  /** What the whole grid shows, for the group's accessible name — the caller's
   *  words, the way a spark's `SparkUnit.chart` is. Without one a reader hears
   *  an unnamed group of 367 buttons and has to infer the block from the first
   *  cell that speaks. The caller composes it because the caption above the
   *  block is the same sentence, and this component must not hold a second copy
   *  of it. */
  label: string;
  describedBy?: string;
  dailyGoal?: number | null;
  level2Goal?: number | null;
  level3Goal?: number | null;
}) {
  const cols = weeks.length;
  /** How many rows column `c` reaches down to — seven for every whole week,
   *  fewer for the running one. */
  const heldBy = (c: number) => weeks[c]?.length ?? 0;
  /** The first row of column `c` the series reaches. Everything above it draws
   *  nothing, so it is not somewhere a cursor may land. The unobserved days are
   *  a contiguous head of the whole grid — the series runs to today without
   *  gaps — so a column is empty, part-full from this row down, or full. */
  const firstHeld = (c: number) => {
    const w = weeks[c] ?? [];
    const i = w.findIndex((n) => n !== null);
    return i === -1 ? w.length : i;
  };
  /** The first column holding anything at all. Everything left of it is months
   *  older than board-api's first close. */
  const firstCol = Math.max(0, weeks.findIndex((w) => w.some((n) => n !== null)));
  const [chip, setChip] = useState<Chip | null>(null);
  const [hover, setHover] = useState<{ c: number; r: number } | null>(null);
  // Roving tabindex: one tab stop for the whole grid, arrows inside it. 364
  // separate tab stops between the strip and the queue below would be worse
  // than the mouse-only grid this replaces. It starts on the last cell that
  // EXISTS: the last column's row 6 is an empty slot six days in seven, and a
  // tab into the grid would land on nothing.
  const [cursor, setCursor] = useState({ c: cols - 1, r: heldBy(cols - 1) - 1 });
  const wrap = useRef<HTMLDivElement>(null);
  const chipElement = useRef<HTMLDivElement>(null);
  const activeCell = useRef<{ el: HTMLElement; text: string } | null>(null);
  useEffect(() => {
    const scroller = wrap.current?.parentElement;
    if (!scroller) return;
    scroller.scrollLeft = scroller.scrollWidth;
    const observer = new ResizeObserver(() => {
      const active = activeCell.current;
      if (active) show(active.el, active.text);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [endsOn, cols]);
  const cells = useRef(new Map<string, HTMLButtonElement>());
  // Goal details can be wider than the original date/count tooltip.
  useLayoutEffect(() => {
    const el = activeCell.current?.el;
    const scroller = wrap.current?.parentElement;
    if (!chip || !chipElement.current || !el || !scroller) return;
    const box = { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, cell: el.offsetHeight };
    const placed = chipPlacement(box, scroller.clientWidth, scroller.scrollLeft, chipElement.current.offsetWidth);
    if (placed.left !== chip.left) setChip({ ...chip, ...placed });
  }, [chip]);

  // CLAMPED AT RENDER, not trusted from state. `cursor` is initialised once and
  // this component is never remounted — `FlowStrip` renders it with no `key` —
  // so the stored column survives a change of shape. Sunday 23:59 into Monday
  // 00:01, the auto-refresh drops the running column, 53 becomes 52, and a
  // cursor still on 52 matches no cell: every button falls to `tabIndex={-1}`
  // and the grid leaves the tab order until the page is reloaded. Sun→Mon is
  // the only transition that does it, which is why nothing caught it. Picking a
  // year is the other way the shape changes now, and it lands here too.
  const cc = Math.min(Math.max(cursor.c, firstCol), cols - 1);
  const cr = Math.min(Math.max(cursor.r, firstHeld(cc)), heldBy(cc) - 1);

  const at = (c: number, r: number) => weeks[c]?.[r] ?? null;
  // The flat day offset of a cell is `c * 7 + r` whatever the last column holds,
  // because every column before it is a whole week. The last DRAWN cell is the
  // one `endsOn` dates.
  const lastDrawn = (cols - 1) * DAYS_PER_WEEK + heldBy(cols - 1) - 1;
  const dayOf = (c: number, r: number) =>
    endsOn - (lastDrawn - (c * DAYS_PER_WEEK + r)) * DAY_MS;
  const monthAt = (c: number) => new Date(dayOf(c, 0)).getUTCMonth();
  /** Whether column `c` is where a month starts, and so carries its name.
   *
   *  COLUMN 0 IS ASKED THE SAME QUESTION AS THE REST, not skipped. A change
   *  against the column before is the test everywhere else, and for column 0
   *  there is no column before — so it used to be labelled never, which is right
   *  for the trailing window, whose first column opens mid-month on a part-month
   *  nothing before it drew, and wrong for a calendar year that begins exactly
   *  on column 0. 2029 opens on a Monday and rendered `Feb Mar Apr May Jun`,
   *  with January the one month of the year with no name over it. So the test is
   *  the month's own first day: a column whose Monday IS the 1st starts that
   *  month whether or not anything is drawn to its left. */
  const startsMonth = (c: number) =>
    c === 0 ? new Date(dayOf(0, 0)).getUTCDate() === 1 : monthAt(c) !== monthAt(c - 1);

  /** The chip is placed from the cell's OWN box, height included. The preview
   *  placed it off a pitch constant that the stretched grid does not use, which
   *  put it 877px from the cell it described — and there is no pitch left to
   *  reach for since the cell became square (#817). */
  // `text` is passed rather than derived, because two kinds of day open this
  // chip now: one with a count, and one the series never reached, whose sentence
  // is about the absence rather than about a number.
  const show = (el: HTMLElement, text: string) => {
    const box = { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, cell: el.offsetHeight };
    const scroller = wrap.current?.parentElement;
    const width = scroller?.clientWidth ?? 0;
    const left = scroller?.scrollLeft ?? 0;
    if (box.left + box.width <= left || box.left >= left + width) {
      hide();
      return;
    }
    activeCell.current = { el, text };
    setChip({ ...chipPlacement(box, width, left), text });
  };
  const hide = () => {
    activeCell.current = null;
    setChip(null);
  };

  const move = (e: React.KeyboardEvent, c: number, r: number) => {
    const step: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const d = step[e.key];
    if (!d) return;
    e.preventDefault();
    const nc = Math.min(Math.max(c + d[0], firstCol), cols - 1);
    // Clamped to the days the TARGET column actually holds, so an arrow cannot
    // land on a slot that does not exist — moving right off row 6 into the
    // short column lands on its last day, and moving up into a column the
    // series starts part-way down lands on its first.
    const nr = Math.min(Math.max(r + d[1], firstHeld(nc)), heldBy(nc) - 1);
    setCursor({ c: nc, r: nr });
    cells.current.get(`${nc}:${nr}`)?.focus();
  };

  return (
    <div data-day-scroll className="w-full overflow-x-auto" onScroll={() => {
      const active = activeCell.current;
      if (active) show(active.el, active.text);
    }}>
    <div ref={wrap} className="relative w-full" style={{ minWidth: LABEL_W + cols * 36 }}>
      {/* A readable cell size; the containing rail scrolls through the year. */}
      <div
        className="grid"
        style={{ gridTemplateColumns: `${LABEL_W}px repeat(${cols}, minmax(36px, 1fr))`, gridTemplateRows: `${MONTH_H}px auto` }}
        role="group"
        aria-label={label}
        aria-describedby={describedBy}
      >
        <span aria-hidden="true" />
        {Array.from({ length: cols }, (_, c) => (
          <span
            key={c}
            className="min-w-0 text-[10px] leading-none text-muted"
            // OUT OF THE GROUP, all twelve of them. The month row moved inside
            // the grid element when the two became one grid, and the group is
            // the 367 cells: read out, the names put twelve bare month words in
            // front of a reader before the first day they can point at, and
            // each one is already in the sentence every cell under it carries.
            aria-hidden="true"
          >
            {startsMonth(c) ? MONTHS[monthAt(c)] : ''}
          </span>
        ))}
        <div className="flex flex-col" aria-hidden="true">
          {Array.from({ length: DAYS_PER_WEEK }, (_, r) => (
            <span key={r} className="flex flex-1 items-center text-[10px] leading-none text-muted">
              {weekdayLabel(r)}
            </span>
          ))}
        </div>
        {Array.from({ length: cols }, (_, c) => (
          <div key={c} data-week={c} className="flex min-w-0 flex-col">
            {Array.from({ length: DAYS_PER_WEEK }, (_, r) => {
              const n = at(c, r);
              if (n === null) {
                return (
                  <div
                    key={r}
                    className="flex w-full items-center justify-center"
                    style={{ aspectRatio: '1' }}
                    aria-hidden="true"
                    onMouseEnter={(e) => {
                      setHover({ c, r });
                      show(e.currentTarget, unreachedSentence(dayOf(c, r)));
                    }}
                    onMouseLeave={() => {
                      setHover(null);
                      hide();
                    }}
                  >
                    <span
                      className="block rounded-[3px]"
                      style={{ width: SWATCH, height: SWATCH, ...UNREACHED_CELL, ...(hover?.c === c && hover.r === r ? HOVER_CELL : {}) }}
                    />
                  </div>
                );
              }
              const level = flameLevel(n, dailyGoal, level2Goal, level3Goal);
              return (
                <button
                  key={r}
                  type="button"
                  data-day={c * DAYS_PER_WEEK + r}
                  // The cleanup form (React 19), so a detached button leaves the
                  // map. It only ever `set`, which was harmless while the grid
                  // was one shape for the life of the page and is not now: every
                  // press of the year switcher changes the columns, and the old
                  // buttons were held by this map for as long as the component
                  // lived.
                  ref={(el) => {
                    const key = `${c}:${r}`;
                    if (el) cells.current.set(key, el);
                    return () => { cells.current.delete(key); };
                  }}
                  tabIndex={cc === c && cr === r ? 0 : -1}
                  aria-label={cellSentence(dayOf(c, r), n, dailyGoal, level2Goal, level3Goal)}
                  // The arrow, stated (#1023): pointing at a day reads it, and
                  // pressing one opens nothing.
                  className="flex w-full cursor-default items-center justify-center rounded-[3px] outline-offset-1 focus-visible:outline-2 focus-visible:outline-[var(--text)]"
                  style={{ aspectRatio: '1' }}
                  onMouseEnter={(e) => {
                    setHover({ c, r });
                    show(e.currentTarget, cellSentence(dayOf(c, r), at(c, r) ?? 0, dailyGoal, level2Goal, level3Goal));
                  }}
                  onMouseLeave={(e) => {
                    // Touch synthesizes a mouse leave after focusing the cell.
                    if (document.activeElement !== e.currentTarget) {
                      setHover(null);
                      hide();
                    }
                  }}
                  onFocus={(e) => {
                    setCursor({ c, r });
                    setHover({ c, r });
                    show(e.currentTarget, cellSentence(dayOf(c, r), at(c, r) ?? 0, dailyGoal, level2Goal, level3Goal));
                  }}
                  onBlur={() => {
                    setHover(null);
                    hide();
                  }}
                  onKeyDown={(e) => move(e, c, r)}
                >
                  <span
                    className={`relative flex items-center justify-center rounded-[3px] text-[12px] font-medium tabular-nums text-fg${level ? ' goal-cell' : ''}`}
                    style={{ width: SWATCH, height: SWATCH, ...fillFor(n, scale), ...(hover?.c === c && hover.r === r ? HOVER_CELL : {}) }}
                  >
                    {level ? <>
                      <GoalFlame level={level} />
                      <span className="goal-count">{n}</span>
                    </> : n === 0 ? null : n}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {chip && (
        <div
          ref={chipElement}
          role="tooltip"
          className={CHIP_CLASS}
          // The half-width shift is inline and NOT a `-translate-x-1/2` class:
          // Tailwind v4 compiles that to the `translate` property, which applies
          // on top of `transform` rather than instead of it, and the chip lands a
          // full width to the left of the cell it describes.
          style={{ minWidth: CHIP_W, left: chip.left, top: chip.below ? chip.top + chip.cell + 20 : chip.top, transform: chip.below ? 'translateX(-50%)' : 'translate(-50%, calc(-100% - 6px))' }}
        >
          {chip.text}
        </div>
      )}
    </div>
    </div>
  );
}
