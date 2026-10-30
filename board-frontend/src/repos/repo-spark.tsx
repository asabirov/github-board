/**
 * A repo tile's sparkline (#558, made readable per week in #576, collapsed onto
 * the board's one chart behaviour in #708).
 *
 * Ten weeks in a 150×26 slot: closed is the hero line in brand blue drawn over
 * opened as a dim reference trace, so the gap between the two reads as net
 * backlog rather than as two metrics competing for the eye. Only what that slot
 * needs is kept — no gridlines, no axes — and the smoothing is shared with the
 * dashboard's throughput trend (`ui/smooth-path`), so the two charts cannot
 * drift into two different ideas of what a spike looks like.
 *
 * `ui/chart-pointer.tsx` divides the slot into ten columns, one per week, and
 * owns everything a pointer or a keyboard does with them.
 *
 * why: docs/charts-answer-when-pointed-at.md — what the right-side box costs on
 * a 112px tile, why the closed series alone carries a dot, why the delta figure
 * beside the chart keeps a box of its own, and what a repo whose window is empty
 * draws instead.
 */
import type { RepoRow } from '../api/repos';
import { smoothPath } from '../ui/smooth-path';
import { ChartGuide, ChartMark, ChartPoints, pointInside, useChartPointer, type ChartPointer } from '../ui/chart-pointer';
import { flowTitle, weekHint } from './repos-vm';
import { ISSUES_UNREADABLE } from './repo-page-vm';

const W = 150;
const H = 26;
const PAD = 3;

/** Always the tertiary tone, whichever way the figure points.
 *
 *  It used to go warning whenever `net > 0` — the window's opened minus its
 *  closed, which one heavy week can carry on its own. On the 78 live repos that
 *  was 41 tiles (measured 2026-08-12; the figure moves), so the page's warning
 *  tone was on half the map and meant nothing on any of it. Nor is a fallen
 *  queue painted good: that is a claim about STANDING, which a queue length
 *  cannot make (`OPEN_COUNT`, RepoTile.tsx). Warning is kept for what a person
 *  must act on — a red build, a leaked credential.
 *
 *  30px wide, and every pixel of it comes off the `flex-1` chart beside it
 *  (ReposPage.spec.tsx). Measured in Chrome on the live org at 1280:
 *  `tabular-nums` fixes every digit at 7.47px and does NOT reach the arrow,
 *  which stays proportional at 9.59px (the `+` it replaced was a digit-width
 *  7.47). So the slot holds an arrow and two digits — 24.52px, and `↑54` on
 *  `acme` was the org's widest on 2026-08-25, a reading that moves — while a
 *  third digit sets 31.97px and runs 1.97px past it.
 *
 *  That overflow reaches nothing. `text-right` in an overfull box spills to the
 *  RIGHT, into the tile's own 16px of `pr`, and the chart ends 9px to the LEFT
 *  of the slot. The tile's edge is 509px against a slot ending at 493, so a
 *  figure would have to set 46px of ink — an arrow and five digits, |net| ≥
 *  10000 — to touch it, on an org that opened 2,100 issues across the whole
 *  window and 404 on its busiest repo. */

/**
 * The delta sits on the tile's MIDDLE line, which is the hardest line to hint
 * from: every side lands on something the tile drew. So the side is a
 * measurement, not a preference — hovered on all 56 live tiles that draw a
 * delta, at 1280 and 1440, in every column. Own-tile ink covered, as a mean per
 * column (first to last) and the single worst tile, in px²:
 *
 *   top     1890 · 1879 · 1946 · 2980   worst 3159   the name and the count,
 *                                                    on 54 of the 56
 *   left    3984 · 4008 · 4063 · 4316   worst 4316   the whole chart, on 54
 *   right      0 ·    0 ·    0 · 4316   worst 4316   nothing at all, until the
 *                                                    last column flips it over
 *                                                    the chart on all 14 there
 *   bottom   158 ·  208 ·  275 · 1193   worst 1671   the drawn word, and the
 *                                                    owner in the last column
 *
 * (1440 tells the same story: bottom 154 · 200 · 266 · 492, right 0 · 0 · 0 ·
 * 5278.) No side leaves the viewport at either width, in any column. Bottom
 * costs about half what right costs and a fifth of top, and what it covers is
 * the footer — a word and a name that are still on the tile a hover later —
 * where right's last column covers the chart, which is the thing the figure
 * this box explains is the sum of.
 *
 * It is NOT free, unlike the drawn word's bottom (see `WORD_SIDE` in
 * RepoTile.tsx): the word sits on the last line, so its box falls into padding,
 * and this one sits a line higher and lands on the footer. On 34 of 56 tiles at
 * 1280 it covers something real. There was no zero to choose.
 *
 * The table above measures own-tile ink, and bottom has a cost it does not
 * count: the box is centred under a figure at the tile's RIGHT edge, so wider
 * than 86px reaches across the gutter onto the NEXT tile and wider than 118px
 * reaches that tile's avatar. Unbounded it did — 158 × 30.5 at x 399–557 on
 * `acme` at 1280, over an avatar at x 537–555 — which is why `deltaHint` is
 * the two counts and no sentence, and why its box is bounded narrower than
 * every other hint on the page (`narrow`, repo-hint.tsx). Bounded, re-measured
 * live at 1280 dark, first column: 114 × 47 at x 421–535, against a next card
 * beginning at x 521 and its first ink, the avatar, at x 537. The 14px of that
 * card under the box are all its own left padding, so 2px separate the two and
 * the off-tile cost in ink is zero.
 */

/** The chart and the strip over it share one box, which is what keeps a column
 *  aligned to the week under it at every tile width the grid makes. `relative`
 *  is the caller's half of what `ChartPoints` needs; the strip is absolute
 *  inside it. */
const CHART = 'relative block min-w-0 flex-1';

export function RepoSpark({ row }: { row: RepoRow }) {
  const { mark, read, point } = useChartPointer(row.weeks.length);
  return <SparkChart row={row} mark={mark} read={read} onWeek={point} />;
}

/**
 * The chart itself, marked at `mark` and reporting `read`. Pure — the pointer
 * lives above it — which is the same split `ReposBody`/`ReposMap` and
 * `OwnerControl`/`OwnerEditor` use, and for the same reason: the marks a hover
 * draws, and the side the hint takes, are then readable in the spec without a
 * DOM the board's test env does not have.
 */
export function SparkChart({
  row,
  mark,
  read,
  onWeek,
}: ChartPointer & {
  row: RepoRow;
  onWeek: (week: number | null) => void;
}) {
  if (row.openIssuesState === 'unreadable') {
    return <span className="block text-xs text-ink-tertiary">{ISSUES_UNREADABLE}</span>;
  }
  const n = Math.max(1, row.weeks.length - 1);
  const max = Math.max(1, ...row.weeks.flatMap((w) => [w.opened, w.closed]));
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / n;
  const y = (v: number) => H - PAD - (v / max) * (H - 2 * PAD);
  const closed = row.weeks.map((w, i) => [x(i), y(w.closed)] as [number, number]);
  const opened = row.weeks.map((w, i) => [x(i), y(w.opened)] as [number, number]);
  // An empty series keeps the same zero baseline without inventing weeks to inspect.
  if (row.weeks.length === 0) {
    opened.push([PAD, H - PAD], [W - PAD, H - PAD]);
    closed.push([PAD, H - PAD], [W - PAD, H - PAD]);
  }
  // Null when there are no weeks: the baseline pushed above is a line to draw,
  // not a week to mark, and the terminal dot below is the only thing that would
  // have read it as one.
  const end = row.weeks.length > 0 ? closed[closed.length - 1] : null;
  const total = flowTitle(row);
  // The module's one answer to "is this week still on the chart", not a private
  // one: `SparkChart` is pure and a stale `mark` reaches it straight from a
  // caller. Unguarded it read `closed[mark][1]` off the end of the array.
  const at = pointInside(mark, row.weeks.length);
  // Before the pointer has landed anywhere the hint reads the last week, which
  // is the week the chart ends on — never an empty tooltip, never the total
  // dressed up as an answer about one week.
  return (
    <span className="flex items-center">
      <span className={CHART}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="block h-[26px] w-full overflow-visible"
            role="img"
            aria-label={total}
          >
            <path
              d={smoothPath(opened)}
              fill="none"
              stroke="var(--muted)"
              strokeOpacity={0.55}
              strokeWidth={1.25}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={smoothPath(closed)}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1.9}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {/* The terminal dot steps aside for the marked week's: this file
                is the half of the one-dot rule `ChartMark` cannot keep for it.
                why: docs/charts-answer-when-pointed-at.md */}
            {at === null && end && (
              <line data-dot="repo-spark" x1={end[0]} x2={end[0]} y1={end[1]} y2={end[1]}
                stroke="var(--accent)" strokeWidth={4.2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            )}
            {at !== null && (
              <>
              <ChartGuide x={x(at)} height={H} />
              <ChartMark
                treatment="halo-dot"
                x={x(at)}
                height={H}
                y={closed[at][1]}
                column={{ i: at, count: row.weeks.length, width: W }}
              />
              </>
            )}
          </svg>
          <ChartPoints
            count={row.weeks.length}
            label={(i) => weekHint(row, i)}
            onPoint={onWeek}
            at={at}
          />
      </span>
    </span>
  );
}
