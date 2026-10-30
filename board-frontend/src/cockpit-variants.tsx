/**
 * SCRATCH — preview-only (#658). Design variants of the cockpit strip, merging
 * "Closed this week" and "Opened this week" into one chart on one scale.
 * Rendered by `cockpit-preview.tsx`; nothing in the app imports this file.
 *
 * Palette and chart idiom come from the Unit page's `dashboard/Pulse.tsx`
 * TrendChart, not invented: closed is brand blue and the thicker line, opened is
 * a dim tint of tertiary, both series share ONE scale drawn from 0, with a 0
 * baseline and a mid gridline, smoothed by the shared `smoothPath`.
 *
 * The governing constraint of this round is that the strip MUST NOT GET TALLER.
 * It sits above a queue and is glanced at, so every chart here has a definite
 * height in px and every tile is built to land on the shipped strip's height.
 *
 * WHAT WON: K — Issues · Throughput · Releases over a week-aligned
 * closed-per-day grid. Built as `src/flow-strip/` and mounted on Your work and
 * Overview on 2026-08-25 (#666). It shipped with a type filter over the grid,
 * which #817 removed when the grid grew to a year: the cells narrowed and
 * neither the three tiles above them nor the shade scale did. Everything else here is the record of what was
 * turned down, kept so nobody re-proposes it.
 *
 * The day figure is NOT waiting on daily snapshots in Postgres. That premise was
 * retracted: the depth line is reconstructed from the issue mirror the board
 * already holds, which is why the feature shipped with no new table — see
 * `flow-strip.vm.ts` for the walk and the two errors it accepts.
 *
 * The FIRST TILE IS THE SHIPPED ONE as of this round — `AssignedTile` below
 * reproduces what Home rendered then, so each variant reads as a proposal about
 * the two flow tiles and nothing else.
 */
import { ReactNode, useState } from 'react';
import { BLOCK } from './ui/block';
import { smoothPath } from './ui/smooth-path';
import { weekAgoLabel } from './dashboard/trend-chart';
import { deltaLabel } from './repos/repos-vm';
import type { PersonalIssueType } from './api/types';
import { TYPE_LABEL, TYPE_ORDER } from './issues-viewer/filter-group';

// ── fixture ───────────────────────────────────────────────────────────────────

export type Week = { opened: number; closed: number };

const OPENED = [6, 9, 4, 12, 7, 5, 11, 8, 6, 9];
const CLOSED = [4, 7, 9, 5, 8, 6, 4, 10, 7, 5];

export const WEEKS: Week[] = OPENED.map((opened, i) => ({ opened, closed: CLOSED[i] }));
export const ASSIGNED = 170;
export const BUGS = 9;
export const BLOCKED = 0;

// ── shared skin ───────────────────────────────────────────────────────────────

const CLOSED_LINE = 'var(--accent-strong)';
const CLOSED_FILL = 'color-mix(in srgb, var(--accent-strong) 15%, transparent)';
const CLOSED_HALO = 'color-mix(in srgb, var(--accent-strong) 18%, transparent)';
const OPENED_LINE = 'color-mix(in srgb, var(--muted) 48%, transparent)';
const OPENED_FILL = 'color-mix(in srgb, var(--muted) 14%, transparent)';
const DEPTH_LINE = 'color-mix(in srgb, var(--muted) 70%, transparent)';
const DEPTH_FILL = 'color-mix(in srgb, var(--muted) 12%, transparent)';

const TILE = `${BLOCK} px-4 py-[13px]`;
const CAP = 'text-[11.5px] text-dim';
const BIG = 'text-[27px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-fg';
const SUB = 'text-[11px] tabular-nums text-muted';
const CHIP =
  'pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+8px)] ' +
  'whitespace-nowrap rounded-md bg-elevated px-2 py-1 text-[11px] tabular-nums ' +
  'text-fg shadow-md';
const STRIP = 'mb-3 gap-2.5 max-[720px]:grid-cols-1';

/**
 * The flow chart's height. A NUMBER, because the svg is `h-full` over a viewBox:
 * in an auto-height parent that resolves to auto and the svg grows to its own
 * aspect ratio — at rail width, a 700px-tall tile where a strip was wanted. This
 * is the knob that holds the strip at the shipped height; move it and re-measure.
 */
const CHART_H = 52;
/** The per-tile spark height, unchanged from the shipped strip's sparkline. */
const SPARK_H = 24;

/** Always the tertiary tone, whichever way the delta points — the rule
 *  `repos/repo-spark.tsx` records: warning-on-growth fired on 41 of 78 live repo
 *  tiles and the page's warning tone stopped meaning anything. The sign carries
 *  the direction. Amber on this strip is spent on `9 bugs`, which is the thing a
 *  person acts on. */
const DELTA = `${SUB} text-muted`;

/**
 * A deep link that reads as one at rest — the board's standing small-link idiom
 * (`RepoPage.tsx` QUEUE_LINK: brand tone, underline on hover), not a legend and
 * not an invented chip treatment. The number keeps its SERIES colour so the pair
 * still says which line it belongs to; the word carries the link tone.
 */
function FlowLink({ href, n, word, tone, size }: {
  href: string; n: number; word: string; tone: string; size: 'meta' | 'head';
}) {
  const num = size === 'head'
    ? `${BIG.replace('text-fg', '')} `
    : 'text-[12px] font-medium tabular-nums ';
  return (
    <a href={href} className="group inline-flex items-baseline gap-1.5 no-underline">
      <span className={`${num}transition-opacity group-hover:opacity-80`} style={{ color: tone }}>{n}</span>
      <span className={`${size === 'head' ? 'text-[12px]' : 'text-[11.5px]'} text-accent no-underline group-hover:underline`}>{word}</span>
    </a>
  );
}

function ClosedLink({ size }: { size: 'meta' | 'head' }) {
  return <FlowLink href="#closed-queue" n={5} word="closed" tone={CLOSED_LINE} size={size} />;
}
function OpenedLink({ size }: { size: 'meta' | 'head' }) {
  return <FlowLink href="#opened-queue" n={9} word="opened" tone={OPENED_LINE} size={size} />;
}

// ── the flow chart (one scale, both series) ───────────────────────────────────

/** Per-week hover text: exact numbers plus the change on the week before. */
function flowTip(weeks: Week[], i: number): string {
  const w = weeks[i];
  const p = weeks[i - 1];
  const d = (v: number, prev: number | undefined) => (prev === undefined ? '' : ` (${deltaLabel(v - prev)})`);
  return `${weekAgoLabel(weeks.length - 1 - i)}: ${w.closed} closed${d(w.closed, p?.closed)}, ${w.opened} opened${d(w.opened, p?.opened)}`;
}

/** Keep a hover chip inside its tile. Anchored on the hovered week, a chip on the
 *  first or last week hangs past the card — which is how the shipped strip's own
 *  tooltip ends up 7px outside the viewport at 760. */
function clampPct(pct: number): number {
  return Math.min(92, Math.max(8, pct));
}

/**
 * Closed and opened on ONE chart and ONE scale, from 0 to the max of both series
 * — the Unit page's TrendChart idiom (0 baseline + mid gridline, smoothed line,
 * a hit column per week revealing a chip). The gap between the two lines is the
 * week's net, which is the whole reason they belong together.
 *
 * Markers are HTML, not `<circle>`. The svg is `preserveAspectRatio="none"` over
 * a 340x130 viewBox drawn into a box a fifth of that height, so an SVG circle
 * comes out a flat ellipse. At this height ten of them would be noise anyway, so
 * only the trailing week and the hovered week carry one.
 */
function FlowChart({ weeks, axis = false }: { weeks: Week[]; axis?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 340;
  const H = 130;
  const PAD = 6;
  const n = Math.max(1, weeks.length - 1);
  const scale = Math.max(1, ...weeks.flatMap((w) => [w.opened, w.closed]));
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / n;
  const y = (v: number) => H - PAD - (v / scale) * (H - 2 * PAD);
  const closedPts = weeks.map((w, i) => [x(i), y(w.closed)] as [number, number]);
  const openedPts = weeks.map((w, i) => [x(i), y(w.opened)] as [number, number]);
  const last = weeks.length - 1;
  const dot = (i: number, series: 'closed' | 'opened') => {
    const pts = series === 'closed' ? closedPts : openedPts;
    return {
      left: `${(pts[i][0] / W) * 100}%`,
      top: `${(pts[i][1] / H) * 100}%`,
      background: series === 'closed' ? CLOSED_LINE : OPENED_LINE,
    };
  };
  return (
    <div className="flex h-full w-full flex-col">
      <div className="relative h-full w-full">
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-full w-full" preserveAspectRatio="none" role="img" aria-label={`Closed and opened, last ${weeks.length} weeks`}>
          {[PAD, H / 2, H - PAD].map((gy) => (
            <line key={gy} x1={PAD} x2={W - PAD} y1={gy} y2={gy} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          <path d={smoothPath(openedPts)} fill="none" stroke={OPENED_LINE} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={smoothPath(closedPts)} fill="none" stroke={CLOSED_LINE} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {[last, ...(hover != null && hover !== last ? [hover] : [])].map((i) => (
          <span key={`m${i}`}>
            <span className="pointer-events-none absolute h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={dot(i, 'closed')} />
            <span className="pointer-events-none absolute h-[5px] w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={dot(i, 'opened')} />
          </span>
        ))}
        {hover != null && (
          <span className="pointer-events-none absolute h-[15px] w-[15px] -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ ...dot(hover, 'closed'), background: CLOSED_HALO }} />
        )}
        <div className="absolute inset-0 flex">
          {weeks.map((_, i) => (
            <span key={i} className="flex-1" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))} />
          ))}
        </div>
        {/* Anchored to the TOP of the plot, not to the hovered value. At Pulse's
            130px the chip riding the closed line sits clear of both curves; in a
            52px box it lands on top of the very lines it is describing. Up here
            it overlays the caption row, which is empty on its left. */}
        {hover != null && (
          <div role="tooltip" className={CHIP} style={{ left: `${clampPct((x(hover) / W) * 100)}%`, top: 0 }}>
            {flowTip(weeks, hover)}
          </div>
        )}
      </div>
      {axis && (
        <div className="mt-1.5 flex text-[10px] tabular-nums text-muted">
          {weeks.map((_, i) => (
            <span key={i} className="flex-1 text-center">
              {i === last ? 'now' : (last - i) % 2 === 0 ? `${last - i}w` : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── the shipped first tile ───────────────────────────────────────────────────

/**
 * What Home renders today, reproduced from the same constants the shipped
 * `Cockpit.StatTile` is built from, so a variant is read against the real strip
 * rather than against a sketch of it. Nothing here is a proposal — #666 owns
 * this tile and is not in this wave.
 */
function AssignedTile() {
  return (
    <a href="#assigned-queue" className={`group ${TILE} block transition-colors hover:bg-elevated`}>
      <div className={CAP}>Assigned to you</div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className={`${BIG} transition-colors group-hover:text-accent`}>{ASSIGNED}</span>
        <span className="text-[12px] text-muted">open</span>
      </div>
      <div className={`mt-[7px] min-h-[14px] ${SUB}`}>
        <span className="inline-flex items-center gap-2">
          <span className={BUGS > 0 ? 'text-warn' : undefined}>{BUGS} bugs</span>
          <span>{BLOCKED} blocked</span>
        </span>
      </div>
    </a>
  );
}

// ── A — one flow tile spanning two columns, led by its caption ─────────────────────────────

export function A({ weeks = WEEKS }: { weeks?: Week[] }) {
  return (
    <div className={`grid grid-cols-3 ${STRIP}`}>
      <AssignedTile />
      <div className={`${TILE} col-span-2 flex flex-col max-[720px]:col-span-1`}>
        <div className="flex items-start justify-between gap-3">
          <span className={CAP}>Closed and opened</span>
          <span className="flex items-baseline gap-3.5"><ClosedLink size="meta" /><OpenedLink size="meta" /></span>
        </div>
        <div className="mt-auto pt-2.5" style={{ height: CHART_H + 10 }}><FlowChart weeks={weeks} /></div>
      </div>
    </div>
  );
}

// ── B — the same split, the flow tile led by its two numbers ──────────────────

export function B({ weeks = WEEKS }: { weeks?: Week[] }) {
  return (
    <div className={`grid grid-cols-3 ${STRIP}`}>
      <AssignedTile />
      <div className={`${TILE} col-span-2 flex flex-col max-[720px]:col-span-1`}>
        {/* The numbers ARE the links, so the tile carries no legend: nothing on it
            is there to be looked at rather than used. */}
        <div className={CAP}>This week</div>
        <div className="mt-2 flex items-baseline gap-6"><ClosedLink size="head" /><OpenedLink size="head" /></div>
        <div className="mt-auto pt-2.5" style={{ height: SPARK_H + 10 }}><FlowChart weeks={weeks} /></div>
      </div>
    </div>
  );
}

// ── C — three tiles, both series drawn in each ────────────────────────────────

/**
 * One tile's chart: BOTH series, one shared scale, in the same two colours
 * everywhere on the strip — brand for closed, dim tertiary for opened, exactly as
 * Pulse draws them. The tile's own series is the hero and takes the thicker
 * stroke and the fill; the other is the reference trace. The last round's ghost
 * was a dashed grey behind a grey line and vanished; two fixed colours cannot.
 */
function PairChart({ weeks, hero }: { weeks: Week[]; hero: 'closed' | 'opened' }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 110;
  const H = 24;
  const TOP = 3;
  const BOT = 2;
  const n = weeks.length;
  const scale = Math.max(1, ...weeks.flatMap((w) => [w.opened, w.closed]));
  const px = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const py = (v: number) => TOP + (1 - v / scale) * (H - TOP - BOT);
  const line = (pick: (w: Week) => number) => weeks.map((w, i) => `${px(i).toFixed(1)},${py(pick(w)).toFixed(1)}`).join(' ');
  const closed = line((w) => w.closed);
  const opened = line((w) => w.opened);
  const heroPts = hero === 'closed' ? closed : opened;
  const heroFill = hero === 'closed' ? CLOSED_FILL : OPENED_FILL;
  return (
    <div className="relative w-full" style={{ height: SPARK_H }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-full w-full" aria-hidden="true">
        <polygon points={`${px(0).toFixed(1)},${H} ${heroPts} ${px(n - 1).toFixed(1)},${H}`} fill={heroFill} />
        <polyline points={opened} fill="none" stroke={OPENED_LINE} strokeWidth={hero === 'opened' ? 1.75 : 1} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <polyline points={closed} fill="none" stroke={CLOSED_LINE} strokeWidth={hero === 'closed' ? 1.75 : 1} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="absolute inset-0 flex">
        {weeks.map((w, i) => (
          <span key={i} className="relative flex-1" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))}>
            {hover === i && <span role="tooltip" className={CHIP} style={{ left: `${clampPct(50)}%`, top: 0 }}>{flowTip(weeks, i)}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

function PairTile({ cap, n, href, weeks, hero }: {
  cap: string; n: number; href: string; weeks: Week[]; hero: 'closed' | 'opened';
}) {
  return (
    <a href={href} className={`group ${TILE} flex flex-col transition-colors hover:bg-elevated`}>
      <div className={CAP}>{cap}</div>
      <div className="mt-2"><span className={`${BIG} transition-colors group-hover:text-accent`}>{n}</span></div>
      <div className="mt-auto pt-2.5"><PairChart weeks={weeks} hero={hero} /></div>
    </a>
  );
}

export function C({ weeks = WEEKS }: { weeks?: Week[] }) {
  return (
    <div className={`grid grid-cols-3 ${STRIP}`}>
      <AssignedTile />
      <PairTile cap="Closed this week" n={5} href="#closed-queue" weeks={weeks} hero="closed" />
      <PairTile cap="Opened this week" n={9} href="#opened-queue" weeks={weeks} hero="opened" />
    </div>
  );
}

// ── D — the same pair drawn as columns, not lines ─────────────────────────────

/**
 * A/B/C all draw the pair as two smoothed lines, which is Pulse's idiom at
 * Pulse's size. At a fifth of that height ten weeks of two lines can sit close
 * enough to read as one thick line. Columns cannot: each week is two bars from a
 * shared 0, so the gap is a difference in height at a fixed x rather than a
 * vertical distance the eye has to measure between two curves.
 *
 * Same two colours as everywhere else on the strip and the same shared scale.
 * Built from HTML boxes rather than svg — the flow charts above are a 340x130
 * viewBox squashed into a 52px box by `preserveAspectRatio="none"`, which is
 * fine for a line and turns a 3px-wide rect into a smear.
 */
function ColumnFlow({ weeks }: { weeks: Week[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const scale = Math.max(1, ...weeks.flatMap((w) => [w.opened, w.closed]));
  const pct = (v: number) => `${Math.max(2, (v / scale) * 100)}%`;
  const last = weeks.length - 1;
  return (
    <div className="relative w-full" style={{ height: CHART_H }}>
      {/* The mid gridline and the 0 baseline, the same two rules Pulse draws. */}
      <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t" style={{ borderColor: 'var(--border)' }} />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t" style={{ borderColor: 'var(--border)' }} />
      <div className="absolute inset-0 flex items-end gap-[3px]">
        {weeks.map((w, i) => (
          <span
            key={i}
            className="relative flex h-full flex-1 items-end justify-center gap-[2px]"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
          >
            <span
              className="w-1/2 rounded-t-[1.5px] transition-opacity"
              style={{ height: pct(w.closed), background: CLOSED_LINE, opacity: hover === null || hover === i ? 1 : 0.45 }}
            />
            <span
              className="w-1/2 rounded-t-[1.5px] transition-opacity"
              style={{ height: pct(w.opened), background: OPENED_LINE, opacity: hover === null || hover === i ? 1 : 0.45 }}
            />
            {hover === i && (
              <span role="tooltip" className={CHIP} style={{ left: `${clampPct(i === 0 ? 30 : i === last ? 70 : 50)}%`, top: 0 }}>
                {flowTip(weeks, i)}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

export function D({ weeks = WEEKS }: { weeks?: Week[] }) {
  return (
    <div className={`grid grid-cols-3 ${STRIP}`}>
      <AssignedTile />
      <div className={`${TILE} col-span-2 flex flex-col max-[720px]:col-span-1`}>
        <div className="flex items-start justify-between gap-3">
          <span className={CAP}>Closed and opened</span>
          <span className="flex items-baseline gap-3.5"><ClosedLink size="meta" /><OpenedLink size="meta" /></span>
        </div>
        <div className="mt-auto pt-2.5"><ColumnFlow weeks={weeks} /></div>
      </div>
    </div>
  );
}

// ── the single Issues block (day resolution) ──────────────────────────────────

/**
 * Artur's shape, 2026-08-24: ONE issues-related block, not three tiles —
 *   · how many issues I (or the unit) have now
 *   · the difference between today and yesterday
 *   · a spark of how many I had EACH DAY, and one of how many closed each day
 *
 * Day resolution, not week. board-api mirrors every issue with `state: 'all'`
 * and no `since`, so `createdAt` / `closedAt` are already on hand for every
 * issue in every repo — bucketing them by day instead of by 7-day window is a
 * change of divisor, not a change of source. Nothing here needs a table.
 *
 * The depth line is RECONSTRUCTED, and that is the honest limit of it: it walks
 * back from today's assigned count subtracting each day's net, and it reads
 * assignment as it stands today. An issue that changed hands last Tuesday counts
 * as mine for the whole window, and a reopened issue carries only its latest
 * `closedAt`. Persisted daily snapshots would make the same line exact — the
 * picture would not change, only what feeds it.
 *
 * Depth is the neutral tone and closed is brand: a queue level is not a flow,
 * and blue on this board means shipped. The two never share a scale — 170 open
 * against 3 closed in a day would flatten the second into the axis.
 */

/**
 * 182 days — half a year, so a 13-week grid and a 26-week one both draw off one
 * array. DETERMINISTIC by construction: a seeded LCG, no `Math.random`, no
 * `Date.now()`. These variants get screenshotted and compared side by side, and
 * a fixture that reshuffles between renders makes that impossible.
 *
 * Day 0 is a Sunday and day 181 is a Saturday, so `i % 7` IS the grid row and 26
 * columns come out exactly full. Weekends run quiet, weekdays carry the work,
 * three forced days stand in for a release and the sweep after it.
 */
const SPAN_DAYS = 182;

/** The fixture's "today" — Sat 22 Aug 2026. A constant, not the clock. */
export const FIXTURE_TODAY = { y: 2026, m: 8, d: 22 };

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

function buildFlow(): Week[] {
  const rnd = lcg(0x60666);
  const out: Week[] = [];
  for (let i = 0; i < SPAN_DAYS; i++) {
    const weekend = i % 7 === 0 || i % 7 === 6;
    const r = rnd();
    const r2 = rnd();
    const closed = weekend
      ? r < 0.58 ? 0 : r < 0.86 ? 1 : 2
      : r < 0.12 ? 0 : r < 0.34 ? 1 : r < 0.58 ? 2 : r < 0.76 ? 3 : r < 0.88 ? 4 : r < 0.96 ? 6 : 8;
    const opened = weekend ? (r2 < 0.62 ? 0 : 1) : Math.round(1 + r2 * 5);
    out.push({ opened, closed });
  }
  for (const [i, n] of [[96, 13], [125, 11], [173, 12]]) out[i].closed = n;
  return out;
}

/** Half a year of days, oldest → newest. */
export const HALF_YEAR: Week[] = buildFlow();

/** The last 14 days of the same array — what E/F/G's sparks draw. One source, so
 *  a grid and a spark of the same week never disagree. */
export const DAY_FLOW: Week[] = HALF_YEAR.slice(-14);

/** Issues open on each day, oldest → newest. Walked BACKWARDS from today's
 *  count, subtracting each day's net (opened − closed), so the trailing point is
 *  the number the block prints and every earlier one is what the queue must have
 *  been. */
export function dailyDepth(now: number, flow: Week[]): number[] {
  const depth = new Array<number>(flow.length);
  let d = now;
  for (let i = flow.length - 1; i >= 0; i--) {
    depth[i] = d;
    d -= flow[i].opened - flow[i].closed;
  }
  return depth;
}

export const DAY_DEPTH = dailyDepth(ASSIGNED, DAY_FLOW);

/** "today" / "yesterday" / "Nd ago" — the day twin of `weekAgoLabel`. */
export function dayAgoLabel(ago: number): string {
  if (ago === 0) return 'today';
  if (ago === 1) return 'yesterday';
  return `${ago}d ago`;
}

/** A level, drawn to its own min..max rather than from 0: the series runs
 *  157..170 on a base of 170, and from a zero baseline that is a flat rule. */
function DepthSpark({ series, tone = DEPTH_LINE, fill = DEPTH_FILL, zero = false, noun }: {
  series: number[]; tone?: string; fill?: string; zero?: boolean; noun: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 110;
  const H = 24;
  const TOP = 3;
  const BOT = 2;
  const n = series.length;
  const min = zero ? 0 : Math.min(...series);
  const span = Math.max(1, Math.max(...series) - min);
  const px = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const py = (v: number) => TOP + (1 - (v - min) / span) * (H - TOP - BOT);
  const pts = series.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  return (
    <div className="relative w-full" style={{ height: SPARK_H }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-full w-full" aria-hidden="true">
        <polygon points={`${px(0).toFixed(1)},${H} ${pts} ${px(n - 1).toFixed(1)},${H}`} fill={fill} />
        <polyline points={pts} fill="none" stroke={tone} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="absolute inset-0 flex">
        {series.map((v, i) => (
          <span key={i} className="relative flex-1" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))}>
            {hover === i && (
              <span role="tooltip" className={CHIP} style={{ left: `${clampPct(50)}%`, top: 0 }}>
                {`${dayAgoLabel(n - 1 - i)}: ${v} ${noun} (${deltaLabel(v - (series[i - 1] ?? v))})`}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Closed per day as columns. A count of events in a bucket is a column; a level
 *  carried from one day to the next is a line. Drawing both as lines is what
 *  makes a reader ask which one is which. */
function ClosedColumns({ series, noun = 'closed', stubZero = true }: {
  series: number[]; noun?: string;
  /** Draw a 4% stub on a zero day so the row reads as a row of columns. True is
   *  what E/F/G ship; a lumpy series turns those stubs into a fake floor, so K
   *  turns it off and a zero draws nothing — the rule the grid's zero cell
   *  already follows. */
  stubZero?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series);
  const n = series.length;
  return (
    <div className="relative w-full" style={{ height: SPARK_H }}>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t" style={{ borderColor: 'var(--border)' }} />
      <div className="absolute inset-0 flex items-end gap-[2px]">
        {series.map((v, i) => (
          <span
            key={i}
            className="relative flex h-full flex-1 items-end"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((h) => (h === i ? null : h))}
          >
            <span
              className="w-full rounded-t-[1.5px] transition-opacity"
              style={{
                height: `${v === 0 && !stubZero ? 0 : Math.max(4, (v / max) * 100)}%`,
                background: CLOSED_LINE,
                opacity: hover === null || hover === i ? 1 : 0.45,
              }}
            />
            {hover === i && (
              <span role="tooltip" className={CHIP} style={{ left: `${clampPct(50)}%`, top: 0 }}>
                {`${dayAgoLabel(n - 1 - i)}: ${v} ${noun}`}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The block's headline: the count now, and today against yesterday. No `open`
 *  word beside it — the caption says Issues and a queue is open by definition. */
function BlockHead({ depth, cap = 'Issues', unit, since = 'since yesterday' }: {
  depth: number[]; cap?: string; unit?: string; since?: string;
}) {
  const now = depth[depth.length - 1];
  const change = now - depth[depth.length - 2];
  return (
    <>
      <div className={CAP}>{cap}</div>
      <div className="mt-2 flex items-baseline gap-2.5">
        <span className={BIG}>{now}</span>
        {unit && <span className="text-[12px] text-muted">{unit}</span>}
        <span className={DELTA}>{deltaLabel(change)} {since}</span>
      </div>
    </>
  );
}

/** One captioned spark inside the block. The caption is what stops two grey-ish
 *  sparks side by side from being a puzzle. */
function SparkCell({ label, children, href }: { label: string; children: ReactNode; href?: string }) {
  const inner = (
    <>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted">{label}</span>
      </div>
      {children}
    </>
  );
  return href ? (
    <a href={href} className="group min-w-0 flex-1 no-underline">
      <span className="block [&_span]:group-hover:opacity-90">{inner}</span>
    </a>
  ) : (
    <div className="min-w-0 flex-1">{inner}</div>
  );
}

// ── E — one block, the number and the two sparks in a row ─────────────────────

export function E({ flow = DAY_FLOW, depth = DAY_DEPTH }: { flow?: Week[]; depth?: number[] }) {
  return (
    <div className="mb-3">
      <div className={`${TILE} flex items-end gap-7`}>
        <div className="w-[190px] flex-none"><BlockHead depth={depth} /></div>
        <SparkCell label="Open each day" href="#assigned-queue">
          <DepthSpark series={depth} noun="open" />
        </SparkCell>
        <SparkCell label="Closed each day" href="#closed-queue">
          <ClosedColumns series={flow.map((d) => d.closed)} />
        </SparkCell>
      </div>
    </div>
  );
}

// ── F — one block, the two series stacked over one shared 14-day axis ─────────

export function F({ flow = DAY_FLOW, depth = DAY_DEPTH }: { flow?: Week[]; depth?: number[] }) {
  return (
    <div className="mb-3">
      <div className={`${TILE} flex items-center gap-7`}>
        <div className="w-[190px] flex-none"><BlockHead depth={depth} /></div>
        <div className="min-w-0 flex-1">
          {/* One x-axis, two rows: the level above the flow that moved it. Same
              14 days at the same pitch, so a spike in closed sits directly under
              the dip it caused. */}
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] text-muted">Open</span>
            <a href="#assigned-queue" className="text-[11px] text-accent no-underline hover:underline">all open</a>
          </div>
          <DepthSpark series={depth} noun="open" />
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-[11px] text-muted">Closed</span>
            <a href="#closed-queue" className="text-[11px] text-accent no-underline hover:underline">closed this week</a>
          </div>
          <ClosedColumns series={flow.map((d) => d.closed)} />
        </div>
      </div>
    </div>
  );
}

// ── G — one block, the level and the flow OVERLAID on one chart ──────────────

/**
 * The tightest reading: closed-per-day as columns rising from the baseline, the
 * open-each-day level drawn as a line across the same box. A day the queue fell
 * and the closes that did it sit at the same x with no eye travel between two
 * charts.
 *
 * The two do NOT share a scale and are not meant to: 170 open against 3 closed
 * in a day would press the columns flat into the axis. The line is a level on
 * its own min..max, the columns a count from 0 — which is exactly why they are
 * drawn as different MARKS, so no one reads the crossing as meaningful.
 */
function OverlayFlow({ depth, closed }: { depth: number[]; closed: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 110;
  const H = 24;
  const TOP = 3;
  const BOT = 2;
  const n = depth.length;
  const min = Math.min(...depth);
  const span = Math.max(1, Math.max(...depth) - min);
  const px = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * W);
  const py = (v: number) => TOP + (1 - (v - min) / span) * (H - TOP - BOT);
  const pts = depth.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  const max = Math.max(1, ...closed);
  return (
    <div className="relative w-full" style={{ height: CHART_H }}>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t" style={{ borderColor: 'var(--border)' }} />
      <div className="absolute inset-0 flex items-end gap-[2px]">
        {closed.map((v, i) => (
          <span key={i} className="flex h-full flex-1 items-end">
            <span
              className="w-full rounded-t-[1.5px] transition-opacity"
              style={{ height: `${Math.max(4, (v / max) * 66)}%`, background: CLOSED_LINE, opacity: hover === null || hover === i ? 0.9 : 0.4 }}
            />
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="pointer-events-none absolute inset-0 block h-full w-full" aria-hidden="true">
        <polyline points={pts} fill="none" stroke={DEPTH_LINE} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="absolute inset-0 flex">
        {depth.map((v, i) => (
          <span key={i} className="relative flex-1" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))}>
            {hover === i && (
              <span role="tooltip" className={CHIP} style={{ left: `${clampPct(50)}%`, top: 0 }}>
                {`${dayAgoLabel(n - 1 - i)}: ${v} open (${deltaLabel(v - (depth[i - 1] ?? v))}), ${closed[i]} closed`}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

export function G({ flow = DAY_FLOW, depth = DAY_DEPTH }: { flow?: Week[]; depth?: number[] }) {
  return (
    <div className="mb-3">
      <div className={`${TILE} flex items-end gap-7`}>
        <div className="w-[190px] flex-none"><BlockHead depth={depth} /></div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <span className="text-[11px] text-muted">Open each day, and what closed</span>
            <span className="flex items-baseline gap-3">
              <a href="#assigned-queue" className="text-[11px] text-accent no-underline hover:underline">open</a>
              <a href="#closed-queue" className="text-[11px] text-accent no-underline hover:underline">closed</a>
              <a href="#opened-queue" className="text-[11px] text-accent no-underline hover:underline">opened</a>
            </span>
          </div>
          <OverlayFlow depth={depth} closed={flow.map((d) => d.closed)} />
        </div>
      </div>
    </div>
  );
}

// ── the day grid (#684 — closed-per-day as one cell per day) ──────────────────

/**
 * Github's contribution graph in the board's blue: 7 rows Sun→Saturday, one
 * column per week, colour carrying the count. Green is not used — nothing on
 * this board is green, and closed is already brand blue everywhere else here.
 *
 * PITCH is the knob. A grid is 7 rows deep whatever else it is, so its height is
 * `7 × PITCH` and nothing else; 13px holds it at 91px, inside the shipped
 * strip's 113px. Width then follows from the span rather than from the rail,
 * which is the thing the span strip below is drawn to show.
 *
 * A ZERO DAY IS NOT THE PALEST BLUE. It is the elevated surface with a hairline
 * — no hue at all — because "nothing closed" and "one thing closed" are a
 * different kind of fact, not two points on a scale.
 */

const CELL = 11;
const PITCH = 13;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The date `ago` days before the fixture's today. A grid is read by position,
 *  so a cell says which day it is — "Sat 22 Aug", never "12d ago". */
function fixtureDate(ago: number): Date {
  return new Date(Date.UTC(FIXTURE_TODAY.y, FIXTURE_TODAY.m - 1, FIXTURE_TODAY.d - ago));
}
function dateLabel(d: Date): string {
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const mixBrand = (pct: number) => `color-mix(in srgb, var(--accent-strong) ${pct}%, var(--surface))`;

const RAMPS = {
  brand: {
    name: 'Brand blue',
    note: 'even steps from the surface to the brand',
    steps: [mixBrand(25), mixBrand(50), mixBrand(75), mixBrand(100)],
  },
  floor: {
    name: 'Wider range',
    note: 'floor lifted clear of a zero, top pushed past the brand into a pale blue — five states, further apart',
    steps: [mixBrand(42), mixBrand(72), mixBrand(100), 'color-mix(in srgb, var(--accent-strong) 55%, white)'],
  },
  github: {
    name: 'Github green',
    note: "Github's own dark ramp, for an informed overrule",
    steps: ['#0e4429', '#006d32', '#26a641', '#39d353'],
  },
} as const;

type RampKey = keyof typeof RAMPS;

/** 0 · 1–2 · 3–4 · 5–7 · 8+ — five buckets over a fixture that maxes at 13. */
function level(n: number): number {
  return n === 0 ? 0 : n <= 2 ? 1 : n <= 4 ? 2 : n <= 7 ? 3 : 4;
}

const ZERO_CELL = { background: 'var(--bg-elevated)', boxShadow: 'inset 0 0 0 1px var(--border)' };

function cellStyle(n: number, ramp: RampKey) {
  return n === 0 ? ZERO_CELL : { background: RAMPS[ramp].steps[level(n) - 1] };
}

function DayGrid({ series, weeks, ramp = 'brand', stretch = false, typeWord }: {
  series: number[]; weeks: number; ramp?: RampKey; stretch?: boolean;
  /** Names the slice a filtered grid is showing, e.g. `bugs` → "3 bugs closed". */
  typeWord?: string;
}) {
  const [hover, setHover] = useState<{ c: number; r: number } | null>(null);
  const days = series.slice(-weeks * 7);
  const ago = (c: number, r: number) => days.length - 1 - (c * 7 + r);
  const monthAt = (c: number) => fixtureDate(ago(c, 0)).getUTCMonth();
  return (
    <div className="relative" style={{ width: stretch ? '100%' : weeks * PITCH + 24 }}>
      <div className="flex" style={{ paddingLeft: 24, height: 13 }}>
        {Array.from({ length: weeks }, (_, c) => (
          <span
            key={c}
            className="text-[9.5px] leading-none text-muted"
            style={stretch ? { flex: 1, minWidth: 0 } : { width: PITCH, flex: 'none' }}
          >
            {c > 0 && monthAt(c) !== monthAt(c - 1) ? MONTHS[monthAt(c)] : ''}
          </span>
        ))}
      </div>
      <div className="flex">
        <div className="flex flex-none flex-col" style={{ width: 24 }}>
          {DOW.map((d, r) => (
            <span key={r} className="text-[9.5px] leading-none text-muted" style={{ height: PITCH }}>
              {r === 1 || r === 3 || r === 5 ? d[0] + d[1] : ''}
            </span>
          ))}
        </div>
        <div className="flex min-w-0 flex-1">
          {Array.from({ length: weeks }, (_, c) => (
            <div key={c} className="flex flex-col" style={stretch ? { flex: 1, minWidth: 0 } : { width: PITCH, flex: 'none' }}>
              {Array.from({ length: 7 }, (_, r) => {
                const n = days[c * 7 + r];
                const on = hover !== null && hover.c === c && hover.r === r;
                return (
                  <span key={r} style={{ height: PITCH, paddingRight: 2, paddingBottom: 2 }}>
                    <span
                      className="block h-full w-full rounded-[2px] transition-opacity"
                      style={{ ...cellStyle(n, ramp), opacity: hover === null || on ? 1 : 0.55 }}
                      onMouseEnter={() => setHover({ c, r })}
                      onMouseLeave={() => setHover((h) => (h && h.c === c && h.r === r ? null : h))}
                    />
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {hover !== null && (
        <span
          role="tooltip"
          className={CHIP}
          style={{ left: Math.max(70, 24 + hover.c * PITCH + CELL / 2), top: 13 + hover.r * PITCH }}
        >
          {`${dateLabel(fixtureDate(ago(hover.c, hover.r)))} — ${
            days[hover.c * 7 + hover.r] === 0
              ? 'nothing closed'
              : `${days[hover.c * 7 + hover.r]}${typeWord ? ` ${typeWord}` : ''} closed`
          }`}
        </span>
      )}
    </div>
  );
}

/** The key. The zero swatch is set apart from the ramp on purpose — it is not
 *  step zero of the scale, it is the absence of one. */
function GridKey({ ramp = 'brand' }: { ramp?: RampKey }) {
  return (
    <div className="flex items-center gap-3 text-[10.5px] text-muted">
      <span className="flex items-center gap-1.5">
        <span className="block rounded-[2px]" style={{ width: CELL, height: CELL, ...ZERO_CELL }} />
        none
      </span>
      <span className="flex items-center gap-1">
        1
        {RAMPS[ramp].steps.map((bg, i) => (
          <span key={i} className="block rounded-[2px]" style={{ width: CELL, height: CELL, background: bg }} />
        ))}
        8+
      </span>
    </div>
  );
}

const CLOSED_DAYS = HALF_YEAR.map((d) => d.closed);

/** #684's own block: closed-per-day, alone, below the strip. */
function GridBlock({ weeks = 13, ramp = 'brand' }: { weeks?: number; ramp?: RampKey }) {
  return (
    <div className={TILE}>
      <div className="flex items-baseline justify-between gap-3">
        <span className={CAP}>Closed each day</span>
        <a href="#closed-queue" className="text-[11px] text-accent no-underline hover:underline">
          everything closed
        </a>
      </div>
      <div className="mt-2.5 flex items-end gap-8">
        <DayGrid series={CLOSED_DAYS} weeks={weeks} ramp={ramp} />
        <GridKey ramp={ramp} />
      </div>
    </div>
  );
}

// ── H — both, stacked. #684 read literally, closed-per-day said twice ─────────

/**
 * E's block UNCHANGED — closed-per-day still a row of columns inside it — with
 * #684's grid underneath. Drawn honestly: the same fact is stated in two marks,
 * at two spans, in two places, and the reader has to work out whether they
 * disagree. They do not; they cannot; that is the cost.
 */
export function H() {
  return (
    <div className="mb-3">
      <E />
      <GridBlock />
    </div>
  );
}

// ── I — division of labour. Each fact drawn once ─────────────────────────────

/**
 * The closed spark comes OUT of the issues block. What is left answers one
 * question — where is the queue going — and the grid below answers the other —
 * when did the work happen. Nothing is said twice, and the open-each-day line
 * inherits the width the closed spark was using, which is most of the block.
 */
export function I({ depth = DAY_DEPTH }: { depth?: number[] }) {
  return (
    <div className="mb-3">
      <div className={`${TILE} mb-2.5 flex items-end gap-8`}>
        <div className="w-[190px] flex-none"><BlockHead depth={depth} /></div>
        <SparkCell label="Open each day" href="#assigned-queue">
          <DepthSpark series={depth} noun="open" />
        </SparkCell>
      </div>
      <GridBlock />
    </div>
  );
}

// ── J — one block, the grid inside it ────────────────────────────────────────

/**
 * #684 asks for a block of its own; this refuses, and puts the grid beside the
 * headline instead. The bet is that a quarter's grid is 13 columns × 13px = 169
 * pixels wide, which the rail has to spare — so "its own block" buys a second
 * place to look and nothing else. Whether that bet holds is what the screenshot
 * settles.
 */
export function J({ depth = DAY_DEPTH }: { depth?: number[] }) {
  return (
    <div className="mb-3">
      <div className={`${TILE} flex items-start gap-8`}>
        <div className="min-w-0 flex-1">
          <BlockHead depth={depth} />
          <div className="mt-4">
            <SparkCell label="Open each day" href="#assigned-queue">
              <DepthSpark series={depth} noun="open" />
            </SparkCell>
          </div>
        </div>
        <div className="flex-none">
          <div className="mb-1 text-[11px] text-muted">Closed each day</div>
          <DayGrid series={CLOSED_DAYS} weeks={13} />
        </div>
      </div>
    </div>
  );
}

// ── the two decisions the grid carries with it ───────────────────────────────

function Strip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={`${TILE} mb-2.5`}>
      <div className={CAP}>{label}</div>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

/** How far back the grid should reach. Drawn at the pitch that keeps it 91px
 *  tall, plus the same half-year stretched across the rail — which is what "as
 *  wide as the span it covers" actually looks like. */
export function SpanCompare() {
  return (
    <div className="mb-3">
      <Strip label={`13 weeks — a quarter, ${13 * PITCH}px wide`}>
        <DayGrid series={CLOSED_DAYS} weeks={13} />
      </Strip>
      <Strip label={`26 weeks — half a year, ${26 * PITCH}px wide`}>
        <DayGrid series={CLOSED_DAYS} weeks={26} />
      </Strip>
      <Strip label="26 weeks stretched to the rail — same days, one column per week, filling the width">
        <DayGrid series={CLOSED_DAYS} weeks={26} stretch />
      </Strip>
    </div>
  );
}

/** The same 13 weeks three times. Only the ramp changes. */
export function ColourCompare() {
  return (
    <div className="mb-3">
      {(['brand', 'floor', 'github'] as RampKey[]).map((r) => (
        <Strip key={r} label={`${RAMPS[r].name} — ${RAMPS[r].note}`}>
          <div className="flex items-end gap-8">
            <DayGrid series={CLOSED_DAYS} weeks={13} ramp={r} />
            <GridKey ramp={r} />
          </div>
        </Strip>
      ))}
    </div>
  );
}

// ── V3 — REJECTED, kept for the record ────────────────────────────────────────

function NumberTile({ cap, n, href }: { cap: string; n: number; href?: string }) {
  const body = (
    <>
      <div className={CAP}>{cap}</div>
      <div className="mt-2"><span className={`${BIG}${href ? ' transition-colors group-hover:text-accent' : ''}`}>{n}</span></div>
    </>
  );
  return href ? (
    <a href={href} className={`group ${TILE} block transition-colors hover:bg-elevated`}>{body}</a>
  ) : (
    <div className={TILE}>{body}</div>
  );
}

export function V3({ weeks = WEEKS }: { weeks?: Week[] }) {
  return (
    <div className="mb-3">
      <div className={`grid grid-cols-3 ${STRIP}`}>
        <AssignedTile />
        <NumberTile cap="Closed this week" n={5} href="#closed-queue" />
        <NumberTile cap="Opened this week" n={9} href="#opened-queue" />
      </div>
      <div className={`${TILE} flex flex-col`}>
        <span className={CAP}>Closed and opened</span>
        <div className="mt-3 h-[152px]"><FlowChart weeks={weeks} axis /></div>
      </div>
    </div>
  );
}

// ── V4 — REJECTED, kept for the record ────────────────────────────────────────

/**
 * The two series mirrored about a centre line: opened upward, closed downward,
 * each side filled from the centre. Filling the gap BETWEEN the curves would
 * encode opened+closed — the week's volume — not its net.
 */
function DivergingFlow({ weeks }: { weeks: Week[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 340;
  const H = 140;
  const PAD = 8;
  const MID = H / 2;
  const half = MID - PAD;
  const n = Math.max(1, weeks.length - 1);
  const scale = Math.max(1, ...weeks.flatMap((w) => [w.opened, w.closed]));
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / n;
  const up = (v: number) => MID - (v / scale) * half;
  const down = (v: number) => MID + (v / scale) * half;
  const openedPts = weeks.map((w, i) => [x(i), up(w.opened)] as [number, number]);
  const closedPts = weeks.map((w, i) => [x(i), down(w.closed)] as [number, number]);
  const area = (pts: [number, number][]) =>
    `${smoothPath(pts)} L${pts[pts.length - 1][0]} ${MID} L${pts[0][0]} ${MID} Z`;
  return (
    <div className="relative h-full w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-full w-full" preserveAspectRatio="none" role="img" aria-label="Opened above, closed below, last 10 weeks">
        <path d={area(openedPts)} fill={OPENED_FILL} />
        <path d={area(closedPts)} fill={CLOSED_FILL} />
        <line x1={PAD} x2={W - PAD} y1={MID} y2={MID} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <path d={smoothPath(openedPts)} fill="none" stroke={OPENED_LINE} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <path d={smoothPath(closedPts)} fill="none" stroke={CLOSED_LINE} strokeWidth={2.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="absolute inset-0 flex">
        {weeks.map((_, i) => (
          <span key={i} className="flex-1" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover((h) => (h === i ? null : h))} />
        ))}
      </div>
      {hover != null && (
        <div role="tooltip" className={CHIP} style={{ left: `${clampPct((x(hover) / W) * 100)}%`, top: `${(up(weeks[hover].opened) / H) * 100}%` }}>
          {flowTip(weeks, hover)}
        </div>
      )}
    </div>
  );
}

export function V4({ weeks = WEEKS }: { weeks?: Week[] }) {
  return (
    <div className={`grid grid-cols-3 ${STRIP}`}>
      <AssignedTile />
      <div className={`${TILE} col-span-2 flex flex-col max-[720px]:col-span-1`}>
        <div className="flex items-start justify-between gap-3">
          <span className={CAP}>Opened above, closed below</span>
          <span className="flex items-baseline gap-3.5"><ClosedLink size="meta" /><OpenedLink size="meta" /></span>
        </div>
        <div className="mt-3 h-[132px]"><DivergingFlow weeks={weeks} /></div>
      </div>
    </div>
  );
}

// ── K — Artur's own shape (2026-08-25) ───────────────────────────────────────

/**
 * H, I and J were all turned down; this is drawn from his description of what he
 * wanted instead, not from any of them:
 *
 *   Issues     — the count now, the change since yesterday, open-each-day.
 *   Throughput — what closed YESTERDAY, the last complete day, against the day
 *                before it, and closed-each-day.
 *   Releases   — releases cut yesterday, against the day before, and
 *                releases-each-day.
 *
 * Three questions, so three marks: a queue level is a line in the neutral tone,
 * a count of events in a day is a column in brand blue — blue on this board
 * means shipped, and a close and a release both are.
 */

/** Releases cut per day, oldest → newest, over the same 182 days. Deterministic,
 *  its own seed. RELEASES ARE LUMPY and the fixture has to be: 140 of the 182
 *  days are zero, 28 carry one, 10 carry two and 4 carry three. A fixture that
 *  released as steadily as issues close would make the third tile look better
 *  than it can ever look on real data.
 *
 *  There is one series for everyone: `ReleaseItem` carries a repo, a tag and a
 *  time and no assignee, so the tile counts every release across every mirrored
 *  repo and reads the same for every viewer. */
function buildReleases(): number[] {
  const rnd = lcg(0x2e1ea5e);
  const out: number[] = [];
  for (let i = 0; i < SPAN_DAYS; i++) {
    const weekend = i % 7 === 0 || i % 7 === 6;
    const r = rnd();
    out.push(weekend ? (r < 0.94 ? 0 : 1) : r < 0.7 ? 0 : r < 0.9 ? 1 : r < 0.98 ? 2 : 3);
  }
  return out;
}

export const RELEASE_DAYS: number[] = buildReleases();

/** How the closes split by type. Drawn issue by issue out of `CLOSED_DAYS`
 *  rather than generated beside it, so the four series SUM to the total on every
 *  day by construction: the switcher on "All" and the switcher on the four types
 *  can never disagree. Weights are a plausible mix, nothing more. */
const TYPE_MIX: [PersonalIssueType, number][] = [
  ['feature', 0.34], ['bug', 0.3], ['chore', 0.24], ['feedback', 0.12],
];

function buildTypeSplit(total: number[]): Record<PersonalIssueType, number[]> {
  const rnd = lcg(0x7c105e);
  const out: Record<PersonalIssueType, number[]> = { bug: [], feedback: [], feature: [], chore: [] };
  for (const n of total) {
    const day: Record<PersonalIssueType, number> = { bug: 0, feedback: 0, feature: 0, chore: 0 };
    for (let k = 0; k < n; k++) {
      let r = rnd();
      for (const [t, w] of TYPE_MIX) {
        if (r < w) { day[t] += 1; break; }
        r -= w;
      }
    }
    for (const t of TYPE_ORDER) out[t].push(day[t]);
  }
  return out;
}

export const CLOSED_BY_TYPE = buildTypeSplit(CLOSED_DAYS);

type TypeChoice = 'all' | PersonalIssueType;

/**
 * The segmented control, in the board's own chrome. `TOGGLE_*` below are the
 * four class strings `issues-viewer/ViewerControls.tsx` builds its list/board
 * toggle from, copied because that file does not export them and this preview
 * lane may not edit it — if this shape ships, they get exported and this copy
 * goes.
 */
const TOGGLE_TRACK = 'flex rounded-[10px] bg-[var(--queue-chrome)] p-[3px]';
const TOGGLE_BTN = 'flex items-center rounded-[7px] px-[9px] py-1.5 transition-colors';
const TOGGLE_ON = 'bg-[var(--queue-chip)] text-fg';
const TOGGLE_OFF = 'text-muted hover:text-dim';

/** The four types are `deriveType`'s, and the labels are the ones the issue
 *  queue's own type filter already shows — imported, not restated. */
function TypeSwitch({ value, onChange }: { value: TypeChoice; onChange: (v: TypeChoice) => void }) {
  const seg = (v: TypeChoice, label: string) => (
    <button
      key={v}
      type="button"
      aria-pressed={value === v}
      onClick={() => onChange(v)}
      className={`${TOGGLE_BTN} text-[11.5px] ${value === v ? TOGGLE_ON : TOGGLE_OFF}`}
    >
      {label}
    </button>
  );
  return (
    <div className={TOGGLE_TRACK} role="group" aria-label="Issue type">
      {seg('all', 'All')}
      {TYPE_ORDER.map((t) => seg(t, TYPE_LABEL[t]))}
    </div>
  );
}

/** One tile's spark, captioned and with its deep link on the right — the row F
 *  draws for its `Open` series, reused so all three tiles read the same way. */
function KSpark({ label, link, href, children }: {
  label: string; link: string; href: string; children: ReactNode;
}) {
  return (
    <>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted">{label}</span>
        <a href={href} className="text-[11px] text-accent no-underline hover:underline">{link}</a>
      </div>
      {children}
    </>
  );
}

function KTile({ head, spark }: { head: ReactNode; spark: ReactNode }) {
  return (
    <div className={`${TILE} flex flex-col`}>
      {head}
      <div className="mt-4">{spark}</div>
    </div>
  );
}

export function K({ flow = DAY_FLOW, depth = DAY_DEPTH }: { flow?: Week[]; depth?: number[] }) {
  const [type, setType] = useState<TypeChoice>('all');
  const closed = flow.map((d) => d.closed);
  const releases = RELEASE_DAYS.slice(-flow.length);
  // The last COMPLETE day and the one before it. Today is still being lived, so
  // a tile that counted it would print a number that only ever grows.
  const yday = (s: number[]) => [s[s.length - 3], s[s.length - 2]];
  const grid = type === 'all' ? CLOSED_DAYS : CLOSED_BY_TYPE[type];
  const typeWord = type === 'all' ? undefined : TYPE_LABEL[type].toLowerCase();
  return (
    <div className="mb-3">
      <div className={`grid grid-cols-3 ${STRIP}`}>
        <KTile
          head={<BlockHead depth={depth} cap="Issues" />}
          spark={
            <KSpark label="Open" link="all open" href="#assigned-queue">
              <DepthSpark series={depth} noun="open" />
            </KSpark>
          }
        />
        <KTile
          head={<BlockHead depth={yday(closed)} cap="Throughput" unit="yesterday" since="on the day before" />}
          spark={
            <KSpark label="Closed" link="closed this week" href="#closed-queue">
              <ClosedColumns series={closed} stubZero={false} />
            </KSpark>
          }
        />
        <KTile
          head={<BlockHead depth={yday(releases)} cap="Releases" unit="yesterday" since="on the day before" />}
          spark={
            <KSpark label="Released" link="all releases" href="#releases">
              <ClosedColumns series={releases} noun="released" stubZero={false} />
            </KSpark>
          }
        />
      </div>
      {/* ONLY THIS BLOCK IS FILTERED. The switcher sits inside it, the caption
          takes the selected type's name and the tiles above keep their captions
          and their numbers. Whether that is enough to stop a reader assuming the
          tiles narrowed too is what this shape is drawn to have judged.

          `queue-housed` is what gives the switcher its two tones: the track is
          the region's chrome and the pressed segment the step raised out of it
          (#447), and without the class the track resolves to the block's fill. */}
      <div className={`${TILE} queue-housed`}>
        <div className="flex items-center justify-between gap-3">
          <span className={CAP}>{typeWord ? `Closed each day — ${TYPE_LABEL[type as PersonalIssueType]}` : 'Closed each day'}</span>
          <TypeSwitch value={type} onChange={setType} />
        </div>
        <div className="mt-3">
          <DayGrid series={grid} weeks={13} stretch typeWord={typeWord} />
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-3">
          <a href="#closed-queue" className="text-[11px] text-accent no-underline hover:underline">
            {typeWord ? `${typeWord} closed` : 'everything closed'}
          </a>
          <GridKey />
        </div>
      </div>
    </div>
  );
}
