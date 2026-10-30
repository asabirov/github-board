import { useBoardRead } from '../cache/use-board-read';
/**
 * One repo's own page (#575), variant 2.
 *
 * Top to bottom: the repo names itself with its owner riding the right of the
 * header band; a row of four tabs (#828); then the tab you are on. Overview is
 * three equal trend cards — issue flow, pull requests, CI spend — and the readme
 * last, a block of the same width with its prose held to reading measure inside
 * it (#825). Every card is `BLOCK` and every section leads with `BlockHeader`,
 * so this page is the same system as Your work and Unit rather than a near-miss.
 * The readme was the one exception to that sentence until #825, which is why the
 * sentence was here and the fault was not: a claim in a comment guards nothing,
 * and `RepoPage.spec.tsx` asks every labelled section of this page for the block
 * surface instead — including the three #828 added.
 *
 * The open issues were the fourth block on this page until #828 and are the
 * Issues tab now, whole rather than five rows of it. They are not drawn in both:
 * a list that appears twice is a list a reader has to compare with itself.
 * `RepoSections.tsx` holds that tab and the two beside it, all three off the
 * SAME fetched view, so changing tab issues no request.
 *
 * Nothing is padded. A repo with no readme, no pull requests and no issues draws
 * a PAGE, not an error and not a white screen — three short cards saying in
 * words what is absent, the readme line under them, and the page ends. Absence
 * never reads as zero: `repo-page-vm.ts` decides which of the three answers each
 * card has (`read` / `nothing` / `unreadable`), because "measured at zero",
 * "there is none" and "we could not find out" are three different things and a
 * card that cannot tell them apart draws one as another (#582).
 *
 * No repo in acme currently lacks a readme, so that path is real and
 * unobservable here. It is held by the spec instead.
 */
import { useEffect, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type RepoPageView } from '../api/repos';
import { useOrgScope } from '../org-scope/OrgScopeProvider';
import { gotoPath, routePath, repoPath, walkedHere, type RepoRef, type RepoSection } from '../route';
import { PageCrumb } from '../PageCrumb';
import { PageHeading, PAGE_RAIL, PAGE_READING } from '../ui/PageHeading';
import { BlockHeader, BLOCK_LABEL } from '../ui/BlockHeader';
import { ActionMenu } from '../ui/ActionMenu';
import { Avatar } from '../ui/avatar';
import { copyToClipboard } from '../ui/clipboard';
import { repoActionItems } from './repo-actions';
import { smoothPath } from '../ui/smooth-path';
import { ChartHint, ChartMark, ChartPoints, useChartPointer } from '../ui/chart-pointer';
import { IssuesSection, MembersSection, PrsSection, RepoTabRow } from './RepoSections';
import { README_COMPONENTS } from './readme-code';
import { repoTabs } from './repo-tabs';
import { Absent, CARD, NOTHING, boardLinkProps } from './repo-page-parts';
import { LoadingStructure } from '../ui/LoadingStructure';
import { ownerName, ownerUnread, OWNER_UNREAD, OWNER_UNREAD_HINT } from './repos-vm';
import {
  ISSUE_SERIES,
  PR_SERIES,
  REPO_PAGE_WINDOW,
  ciSpendCard,
  ciWeekHint,
  coveredWindow,
  issueFlowCard,
  missingRepo,
  prFlowCard,
  readmeCard,
  uncoveredNote,
  weekPairHint,
  type Change,
  type CiSpendCard,
} from './repo-page-vm';

// ── The page's own type scale, hoisted (house rule: no long inline strings) ──

const H1 = 'm-0 break-words text-[33px] font-[680] leading-[1.18] tracking-[-0.025em] text-fg';
/** The owner half of `owner/name` — present, and quieter than the repo it
 *  qualifies, because the name is what a reader came for. */
const H1_ORG = 'font-[560] text-muted';
const DESC = 'mt-[9px] max-w-[74ch] text-[13.5px] leading-[1.5] text-dim';

const HEADER_BAND = 'flex flex-wrap items-start justify-between gap-6';
const HEADER_RIGHT = 'flex min-w-0 max-w-full items-center gap-3';

const GRID = 'grid grid-cols-3 gap-4 max-[900px]:grid-cols-1';
/** The gap between the tab row and the tab, the same on all four, so the
 *  content starts at one height and nothing jumps under the reader when they
 *  change tab. On Overview it is the grid's: the Overview leads with the cards
 *  themselves, no line above them (#1240). */
const TAB_BODY = 'mt-7';

/**
 * The one figure a card leads with, and it carries no unit word.
 *
 * Each card reports a single number — open issues, open pull requests, net
 * billed CI — and the header above it has already said which. That is the whole
 * licence for the bare figure, so it holds only while every header names its
 * own number. Two did. The third named the ten-week pair that came off with
 * the unit word, so this card's 3 has been unlabelled since: the header is
 * "Issues" for that reason (#1240), the same word the tab row already puts
 * over the same count. "3 open" under it would say "open" once and "issue"
 * twice, in two sizes (#1197 as filed, superseded by the reporter).
 */
const FIGURE = 'mb-[6px] text-[27px] font-[640] leading-none tracking-[-0.02em] tabular-nums text-fg';
/** How the figure moved against the previous period (#962), under it: Org
 *  lag's line (`dashboard/OrgLagTrend.tsx`) at this card's size. An amount is
 *  in the figure's own ink; the words for there being no amount are quieter. */
const CHANGE = 'mb-[12px] text-[12px] leading-[1.4] tabular-nums';
const CHANGE_MEASURED = `${CHANGE} font-semibold text-fg`;
const CHANGE_QUIET = `${CHANGE} text-dim`;
/** A coverage or billing note under a chart. Quiet, and never
 *  alone: the sentence that replaces a card's whole body is `NOTHING`, which
 *  this page shares with its tabs (`repo-page-parts.tsx`). */
const UNDER = 'mt-[9px] text-[11.5px] leading-[1.5] tabular-nums text-muted';
/**
 * ONE BLUE FOR ALL THREE CHARTS ON THIS ROW, and it is the board's chart blue.
 *
 * `--chart-series` is what `dashboard/Pulse.tsx:69` and
 * `dashboard/OrgLagTrend.tsx:81` already draw their series in — the two
 * page-size trend charts on Overview, which this row is built to read beside.
 * The CI chart kept `--accent` when the two flow charts moved, so the row
 * shipped two blues for one role: measured on the built page, rgb(22,95,242)
 * beside rgb(11,76,213) light and rgb(26,99,242) beside rgb(99,148,246) dark,
 * plainly different in dark. Nothing decided that; it is what doing the work on
 * two of three cards leaves behind.
 *
 * `--accent` is the OTHER thing blue means here, and that is why it is the
 * one that goes: on this page it is the back link, the tab-row focus ring, the
 * chip outline and the one brand-coloured word the Issues tab is allowed
 * (`RepoPage.spec.tsx`). A chart stroke painted in the affordance token asks a
 * reader to tell a line from a link by size.
 *
 * The shared chart series is a mix of the accent into the card, set per accent
 * (#1450). check-chart-contrast.mjs (#1245) holds it to at least 5.3:1 on a
 * light card and 4.4:1 on a dark card, for every accent. The browser guard checks
 * both this page and Overview so a token or surface change cannot silently
 * remove the chosen contrast margin.
 */
const CHART_HERO = 'var(--chart-series)';
const CHART_TRACE = 'var(--muted)';

/**
 * WHICH LINE IS WHICH, said at the end of each line rather than in a key.
 *
 * The card carried a dot legend under the chart until #1197 struck it, then the
 * labelled 34px totals that replaced it, then — when those totals came off as a
 * second window competing with the figure — nothing at all. Two lines of
 * different colour and weight with nothing naming them is worse than the legend
 * #1197 set out to remove: the reader has to hover, or use assistive tech, to
 * learn that the flat blue line is the closed one.
 *
 * A word at the end of a line is not a caption. The rule the reporter set for
 * this page is about sentences that describe a block — "Last 10 weeks.", "Closed
 * against opened, week by week." A series name sits ON the picture and names one
 * mark in it, the way an axis does; it is the same class of thing as the chart's
 * own accessible name, drawn instead of spoken.
 *
 * AT THE LINE'S END, not in a row under the chart, and that is the part that
 * answers #1197 rather than reversing it. A legend is a lookup table: two
 * swatches away from the marks, and the reader matches colours. A terminal label
 * is on the mark — no matching, no colour discrimination needed, and no second
 * row of furniture on a 56px chart. It is what the reporter asked for in #1197's
 * own words ("with colors instead of legend") without the two numbers the rework
 * removed for competing with the figure above them.
 *
 * THE WORDS ARE TEXT INK, not the series colour. `--chart-series` has a
 * 4.4:1 floor in dark: fine for a 1.9px line under 1.4.11, under 1.4.3's 4.5:1
 * for 11.5px text. So the colour correspondence is carried by the terminal dot beside each
 * word — a non-text graphic, at the threshold it can meet — and the words take
 * the same two inks `Pulse.tsx` gives its own two series names, secondary for
 * the hero and tertiary for the reference trace.
 */
const KEY_COL = 'w-[56px]';
const KEY_WORD = 'absolute left-[7px] text-[11.5px] leading-[1.2] whitespace-nowrap';
const KEY_HERO = `${KEY_WORD} font-medium text-dim`;
const KEY_TRACE = `${KEY_WORD} text-muted`;
/** Half a key word's line box, so a word centred on its line's end still sits
 *  inside the chart's 56px, and the gap two words need before they touch. */
const KEY_HALF = 7;
const KEY_APART = 14;

const OWNER_NAME = 'text-[13px] font-[560] leading-[1.3] text-fg';
const OWNER_LOGIN = 'text-[11.5px] leading-[1.3] text-muted';
const OWNER_UNSET = 'text-[13px] text-muted';
/** The reason under an unread owner (#718) — the login line's own size and
 *  tone, so the block keeps the two-line shape it has when there IS an owner. */
const OWNER_UNREAD_LINE = `${OWNER_LOGIN} block`;

const QUEUE_LINK = 'text-[11.5px] text-accent text-link';

/**
 * WHICH SIDE THE READING BOX OPENS ON, and it is not the module's default.
 *
 * `ChartHint` opens RIGHT because on a repo TILE the chart sits under the thing
 * that names it and a top-side box covers that name (#576). These three cards
 * are a 3-up grid, so right is the one side that is actually unavailable:
 * measured on the running build at 1280, the Issue-flow box opened 210px wide
 * straight over the Pull-requests chart beside it — over a second chart, which
 * is worse than covering any words. It intercepted a pointer aimed at that
 * chart, which is how it was found. LEFT is the same fault mirrored, and off the
 * page entirely for the first card.
 *
 * TOP covers the figure and the block label — "10", "CI spend" — and the label
 * is what names the card the box is reporting inside.
 *
 * BOTTOM covers the space under the chart or its note, and
 * that is the cheapest thing on the card to cover while a pointer is down: the
 * box names the same series for one week, in words. It is the side `dashboard/Pulse.tsx` picked for the
 * same chart shape.
 */
const CHART_SIDE = 'bottom' as const;

/**
 * The three Overview cards NAME THEMSELVES, and that is what makes them regions.
 *
 * A bare `<section>` with no accessible name is not a region: Chrome's AX tree
 * ignored all three, so the page carried exactly one landmark — its title — and
 * a screen-reader user had no structural way into the Overview but to read it
 * top to bottom. The header was a loose `StaticText` above a paragraph reading
 * "5", and with the unit word gone from the figure that paragraph no longer
 * survives being read out of order: on main it read "3 open".
 *
 * Each id points at the header the card already draws, so the region's name and
 * the word a sighted reader sees are one string. The empty-card branch
 * (`Absent`) takes the same id: a card that failed to read is still a card, and
 * a region that appears and disappears with the payload is worse than neither.
 */
const ISSUES_CARD = 'repo-card-issues';
const PRS_CARD = 'repo-card-prs';
const CI_CARD = 'repo-card-ci';

const MISSING = 'pt-2';
const MISSING_LINE = 'mb-4 mt-2 text-[13.5px] leading-[1.5] text-dim';
const REPOS_PATH = '/repos';

type Status = 'loading' | 'not-found' | 'error';

// ── Charts ───────────────────────────────────────────────────────────────────
//
// Same grammar as the tile's sparkline (`repo-spark.tsx`) at page size: the hero
// series in brand blue over a dim reference trace, smoothed through the shared
// `smoothPath` so the two surfaces cannot drift into different ideas of what a
// spike looks like. No gridlines and no axes.
//
// THEY ANSWER A POINTER AGAIN, through `ui/chart-pointer` like every other chart
// (#877). They did not between #708 and here, and the argument for that was
// real: the caption underneath already prints the ten-week reading, so a hover
// layer made the CI card five mechanisms telling one story. What overturned it
// is that the caption reports the WINDOW and a reader pointing at a chart is
// asking about a WEEK — which week peaked, and, on the CI chart, which of two
// visually identical baseline weeks ran for free. The caption cannot answer
// either, and the ten-week total stays on each `aria-label` where it was.
//
// Nothing here composes a sentence: `weekPairHint` and `ciWeekHint` are in
// `repo-page-vm.ts` with the rest of this page's words, so the grammar is
// somewhere a spec can drive. The reasoning for the mark a free CI week gets is
// with the code below.

const W = 324;
const H = 56;
const PAD = 3;
const SVG = 'block h-[56px] w-full overflow-visible';

const cx = (i: number, n: number) => PAD + (i * (W - 2 * PAD)) / Math.max(1, n - 1);
const cy = (v: number, max: number) => H - PAD - (v / Math.max(1, max)) * (H - 2 * PAD);

/**
 * The row a chart is drawn in: the plot, and the gutter that holds its key.
 *
 * ALL THREE CARDS RESERVE THE GUTTER, including the CI chart, which has one
 * series and needs no key. The three charts are a 3-up row over the same ten
 * weeks, so week k has to sit at one x across the row for a reader to scan a
 * column down it; a plot 56px wider on the third card breaks that for the sake
 * of 56px of ink. The empty gutter is the price of the row reading as one
 * picture, and it is the same price the two flow charts pay.
 */
function ChartRow({ children, keys }: { children: ReactNode; keys?: ReactNode }) {
  return (
    <div className="flex h-[56px] w-full items-stretch">
      <div className="min-w-0 flex-1">{children}</div>
      <div className={`relative flex-none ${KEY_COL}`}>{keys}</div>
    </div>
  );
}

/**
 * Where the two key words sit, given where their lines finish.
 *
 * Each word is centred on its own line's last point, which is the whole of the
 * argument for labelling at the end rather than in a legend. Two lines that
 * finish within a line box of each other would print one word over the other,
 * so they are pushed apart symmetrically about their midpoint and then held
 * inside the chart's own height — a key that overlaps itself names nothing, and
 * a key that hangs off the chart changes the card's height.
 *
 * Pure, and exported, because it is the one piece of this key that can be wrong
 * without anybody seeing it: in the board's `node` test env nothing lays out.
 */
export function keyTops(heroY: number, traceY: number): [number, number] {
  const lo = KEY_HALF;
  const hi = H - KEY_HALF;
  const hold = (y: number) => Math.min(Math.max(y, lo), hi);
  if (Math.abs(heroY - traceY) >= KEY_APART) {
    // Far enough apart to need nothing from each other, so each word holds its
    // own line's end and is only kept inside the chart. Moving BOTH here is
    // what put a word at −1: two lines 50px apart cannot both be pushed into a
    // 42px band without one of them leaving it.
    return [hold(heroY), hold(traceY)];
  }
  const half = KEY_APART / 2;
  const mid = Math.min(Math.max((heroY + traceY) / 2, lo + half), hi - half);
  return heroY > traceY ? [mid + half, mid - half] : [mid - half, mid + half];
}

/** Two series: the hero over a dim reference trace, each ending on its own dot
 *  with its own name beside it.
 *
 *  `say` is derived here from the two series and their names, and it is ONE
 *  function used twice — the hit column's accessible name and the words in the
 *  box — so a pointer and a screen reader cannot be told two different things
 *  about one week, and no caller can restate the week in other words. */
function FlowChart({ hero, trace, names, label }: {
  hero: number[];
  trace: number[];
  /** What each line is called, hero first, as the chart's own hint reads it. */
  names: { hero: string; trace: string };
  label: string;
}) {
  const max = Math.max(1, ...hero, ...trace);
  const n = hero.length;
  const say = (i: number) => weekPairHint(n - 1 - i, hero[i], names.hero, trace[i], names.trace);
  const pts = (vs: number[]) => vs.map((v, i) => [cx(i, n), cy(v, max)] as [number, number]);
  const heroPts = pts(hero);
  const tracePts = pts(trace);
  const end = heroPts[heroPts.length - 1];
  const traceEnd = tracePts[tracePts.length - 1];
  const { mark, read, point } = useChartPointer(n);
  const plot = (
    /* `relative`, and the SVG's own fixed height, is the caller's half of what
       `ChartPoints` needs: the strip is absolute over this box, so nothing a
       hover draws can change the card's height. */
    <div className="relative h-[56px] w-full">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className={SVG}>
        <path
          d={smoothPath(tracePts)} fill="none" stroke={CHART_TRACE}
          strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
        />
        <path
          d={smoothPath(heroPts)} fill="none" stroke={CHART_HERO}
          strokeWidth={1.9} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
        />
        {/* The trace's own terminus, which is what carries the colour over to
            the word beside it. Thinner than the hero's, as its line is. It does
            NOT step aside for the marker: the marker is drawn on the hero. */}
        {traceEnd && (
          <line data-dot="repo-flow-trace" x1={traceEnd[0]} x2={traceEnd[0]} y1={traceEnd[1]} y2={traceEnd[1]}
            stroke={CHART_TRACE} strokeWidth={3.2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        )}
        {/* The resting endpoint steps aside for the active week's marker. */}
        {end && mark !== n - 1 && (
          <line data-dot="repo-flow" x1={end[0]} x2={end[0]} y1={end[1]} y2={end[1]}
            stroke={CHART_HERO} strokeWidth={4.2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        )}
        {mark !== null && (
          <ChartMark
            x={cx(mark, n)}
            height={H}
            y={heroPts[mark][1]}
            colour={CHART_HERO}
            column={{ i: mark, count: n, width: W }}
          />
        )}
      </svg>
      <ChartPoints count={n} label={say} onPoint={point} at={mark} />
    </div>
  );
  // A CARD WITH NO WEEKS DRAWS ITS EMPTY CHART AND ANSWERS NOTHING, which is the
  // guard `dashboard/Pulse.tsx` keeps for the same reason. `prFlowCard` returns
  // a `read` card whose `covered` is EMPTY when the read's cap reached no window
  // at all — a busy repo where every window came back `null` — and there is then
  // no week for `say` to name. Without this the box would ask for week -1 and
  // take the whole page down.
  if (!end || !traceEnd) return <ChartRow>{plot}</ChartRow>;
  // The key is OUTSIDE the hint's trigger: pointing at a word is not pointing
  // at a week, and a box opening over the thing that names the line it reports
  // is the fault `CHART_SIDE` above was measured to avoid.
  const [heroTop, traceTop] = keyTops(end[1], traceEnd[1]);
  return (
    <ChartRow
      keys={
        <>
          <span className={KEY_HERO} style={{ top: heroTop, transform: 'translateY(-50%)' }}>{names.hero}</span>
          <span className={KEY_TRACE} style={{ top: traceTop, transform: 'translateY(-50%)' }}>{names.trace}</span>
        </>
      }
    >
      <ChartHint label={say(read ?? n - 1)} side={CHART_SIDE}>{plot}</ChartHint>
    </ChartRow>
  );
}

/**
 * The mark a free week gets on the baseline, and why it looks like this.
 *
 * The line is net billed USD — the whole trend. But $0.00 is the answer to two
 * different weeks: one where nothing ran, and one whose real work the org's
 * included-minutes allowance absorbed (measured: `acme-docs` ran 53, 303 and
 * 94 minutes in three consecutive weeks, billed $0.00 for all three). Both sit
 * on the baseline. The mark says which.
 *
 * FULL tone, not the trace's 0.55. At 0.55 the effective fill was rgb(90,96,113)
 * on the card's rgb(31,34,45) — 2.53:1, under WCAG 1.4.11's 3:1 for an
 * informational non-text graphic. This is the mark that keeps net-billed-cost
 * honest, so it is the last thing here allowed to be hard to see.
 *
 * A STROKE, not a rect, and that is the fix rather than a caveat. `viewBox` +
 * `preserveAspectRatio="none"` scales x with the card, so a 2-unit-wide RECT
 * painted 2.041px at 1440, 1.737px at 1280 and 1.210px at 1024 — and a
 * sub-pixel mark never reaches full tone, so its brightest painted pixel at
 * 1024 was rgb(115,123,142), a measured 3.738:1. `vectorEffect` takes the
 * stroke width out of the transform, so the mark is 2 CSS px wide whatever the
 * card is. Re-measured by rasterising this markup at its real CSS size and
 * sampling the brightest pixel it paints, with the dollars line removed from
 * the raster because its brand blue crosses the same column:
 *
 *   viewport   1440    1280    1024    768
 *   card svg   330.7   281.3   196.0   693.0  px wide
 *   painted    rgb(138,147,168) at all four
 *   contrast   5.147:1 at all four
 *
 * What it does NOT have is magnitude: every free week is the same 2×6 mark. The
 * moment its height varies it is a second series and somebody reads a value off
 * it, and minutes are not a trend.
 */
const FREE_TICK_W = 2;
const FREE_TICK_H = 6;

/** CI spend: dollars, with the weeks that ran for nothing marked on the baseline. */
function CiChart({ card }: { card: Extract<CiSpendCard, { kind: 'read' }> }) {
  const dollars = card.weeks.map((w) => w.netUsd);
  const max = Math.max(...dollars);
  const n = dollars.length;
  const pts = dollars.map((v, i) => [cx(i, n), cy(v, max)] as [number, number]);
  const end = pts[pts.length - 1];
  const base = cy(0, max);
  const label = `${card.figure} in ${REPO_PAGE_WINDOW}${card.note ? `; ${card.note}` : ''}`;
  const { mark, read, point } = useChartPointer(n);
  // The words for one week, in this page's own vocabulary rather than the
  // component's — and the reason this chart wanted a pointer most of the three:
  // a free week and an idle week are the same point on the same baseline, told
  // apart by a 2x6 tick a reader has to already understand.
  const say = (i: number) => ciWeekHint(card.weeks[i], n - 1 - i);
  return (
    <ChartRow>
      <ChartHint label={say(read ?? n - 1)} side={CHART_SIDE}>
      <div className="relative h-[56px] w-full">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className={SVG}>
          <path
            d={smoothPath(pts)} fill="none" stroke={CHART_HERO}
            strokeWidth={1.9} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
          />
          {card.free.map((i) => (
            <line
              key={i}
              data-free-week={i}
              x1={cx(i, n)}
              x2={cx(i, n)}
              y1={base}
              y2={base - FREE_TICK_H}
              stroke="var(--muted)"
              strokeWidth={FREE_TICK_W}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {end && mark !== n - 1 && (
            <line data-dot="repo-ci" x1={end[0]} x2={end[0]} y1={end[1]} y2={end[1]}
              stroke={CHART_HERO} strokeWidth={4.2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          )}
          {mark !== null && (
            <ChartMark
              x={cx(mark, n)}
              height={H}
              y={pts[mark][1]}
              column={{ i: mark, count: n, width: W }}
            />
          )}
        </svg>
        <ChartPoints count={n} label={say} onPoint={point} at={mark} />
      </div>
      </ChartHint>
    </ChartRow>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function OwnerBadge({ view }: { view: RepoPageView }) {
  const { org } = useOrgScope();
  const owner = view.repo.owner;
  if (!owner) {
    // Three states in this slot, not two (#718). An ownership read that failed
    // must not print "Set owner": that says the org records no owner for this
    // repo, which is a fact, and this is the absence of one — the same false
    // claim the tile used to make, in a second place.
    //
    // The page has room the tile does not, so the reason goes UNDER the words
    // rather than into a hover: the tile can only afford three words and a
    // tooltip, this block already carries a second line on every other read
    // that failed (`Absent` below), and a sentence nobody has to hover for is
    // the better answer wherever it fits.
    const unread = ownerUnread(view.repo);
    return (
      <div className="text-right">
        <span className={`${BLOCK_LABEL} mb-[5px] block`}>Owner</span>
        <span className={OWNER_UNSET}>{unread ? OWNER_UNREAD : ownerName(null)}</span>
        {unread && <span className={OWNER_UNREAD_LINE}>{OWNER_UNREAD_HINT}</span>}
      </div>
    );
  }
  const path = routePath({ tab: 'people', person: owner.login, org: org ?? undefined });
  return (
    <a {...boardLinkProps(path)} className="flex min-h-11 min-w-0 items-center gap-[10px] rounded-lg hover:underline focus-visible:outline-3 focus-visible:outline-offset-2">
      <span aria-hidden="true" className="shrink-0"><Avatar name={owner.name ?? owner.login} login={owner.login} px={76} className="size-[38px]!" showTitle={false} /></span>
      <span className={`${OWNER_NAME} min-w-0 break-words`}>{owner.name || owner.login}</span>
    </a>
  );
}

// ── The page ─────────────────────────────────────────────────────────────────

export function RepoPage({ repoRef }: { repoRef: RepoRef }) {
  const { owner, name, section } = repoRef;
  const { data: view, error } = useBoardRead<RepoPageView>(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/page`);
  const status: Status = error ? (error as { status?: number }).status === 404 ? 'not-found' : 'error' : 'loading';

  useEffect(() => {
    if (view) document.title = `${view.repo.name} · Board`;
  }, [view]);

  if (!view) {
    return (
      <div className={PAGE_RAIL}>
        <div className="pt-8">
          {/* No breadcrumb on the missing state, deliberately. A crumb shows a
              page's ANCESTORS, and a repo that is not here has no page to have
              ancestors of — while `Repos` in the crumb and `Back to Repos`
              below it were two <a href="/repos"> about 180px apart, saying the
              same thing twice on a page whose whole design is a heading, a
              sentence and one link. The offered link is the one that survives:
              it is the one presented AS a way back. */}
          {status === 'loading'
            ? <><PageCrumb /><LoadingStructure surface="repo" label="repository" /></>
            : <MissingRepoState status={status} owner={owner} name={name} />}
        </div>
      </div>
    );
  }

  return <RepoBody view={view} now={Date.now()} section={section} />;
}

/**
 * A repo this board does not carry — a STATE, not a sentence.
 *
 * It used to be one 12.5px tertiary line under the breadcrumb: the page's
 * smallest, dimmest type, with no heading and no offered action. The way back
 * existed (the crumb's `Repos` is a real link) but was never presented as one.
 *
 * It stays quiet on purpose. This is not an error page — nothing broke, the repo
 * simply is not here — so it gets a heading, one sentence and one link, and no
 * icon, no panel and no apology.
 *
 * One link, still: `PageCrumb` is deliberately not drawn above this, because a
 * crumb and an offered link 180px apart said the same thing twice. What #823
 * changed is where the one link GOES. On an entry the reader walked to, the map
 * they left is one entry behind, and `/repos` is the whole map at its resting
 * order — the loss this issue was filed over, landed on the state that needs it
 * least deniable: they narrowed the map, pressed a tile, and the repo is not
 * there. So the link goes back where there is a back, and to `/repos` where the
 * page was opened cold and there is no walk to undo. The label is true either
 * way, both destinations being Repos.
 */
export function MissingRepoState({ status, owner, name }: {
  status: 'not-found' | 'error';
  owner: string;
  name: string;
}) {
  const m = missingRepo(status, owner, name);
  const walked = typeof window !== 'undefined' && walkedHere(window.history.state);
  return (
    <div className={MISSING}>
      <PageHeading>{m.heading}</PageHeading>
      <p className={MISSING_LINE}>{m.line}</p>
      {/* `boardLinkProps`, which is `tileOpens`, and not the guard that used to
          be written out here: that one read ⌘ and ctrl and swallowed shift and
          alt, so a reader asking this link for a new window got their current
          page replaced. It is the same defect #575 fixed on the queue row, in
          the second place on this page that had it (#828).

          Its second argument is #823's: on an entry the reader walked to, the
          plain press goes BACK, to the map as they left it. The href is `/repos`
          either way, so every press the browser claims still addresses a page. */}
      <a {...boardLinkProps(REPOS_PATH, walked ? () => window.history.back() : undefined)} className={QUEUE_LINK}>
        {m.back}
      </a>
    </div>
  );
}

/** Queue counts compare snapshots; CI compares period totals. */
function ChangeLine({ change, comparison }: { change: Change; comparison: string }) {
  return <p className={change.measured ? CHANGE_MEASURED : CHANGE_QUIET}>{change.text}{change.measured && <> {comparison}</>}</p>;
}

/**
 * Overview: the three trend cards and the readme (#828).
 *
 * It keeps no list of its own. The three cards are windows onto ten weeks and
 * the readme is the repo's own words; everything that is a list of things
 * happening right now is a tab beside this one.
 */
function Overview({ view, now }: { view: RepoPageView; now: number }) {
  const { repo } = view;
  // The payload's read state goes in with the row (#837). Both halves of this
  // card come from the ingest that failed, so without it the Overview says
  // "Nothing opened or closed" one click away from the Issues tab saying the
  // read failed — and it is the Overview's answer that is the false positive.
  const issues = issueFlowCard(repo, now, view.openIssuesState, view.previous?.openIssues);
  const prs = prFlowCard(view.pullRequests, view.previous?.openPrs);
  const ci = ciSpendCard(view.ciSpend, view.previous?.ciNetUsd);
  const readme = readmeCard(view.readme);
  const unread = prs.kind === 'read' ? uncoveredNote(prs.uncovered) : null;
  return (
    <>
      <div className={`${TAB_BODY} ${GRID}`}>
        {issues.kind !== 'read' ? (
          <Absent label="Issues" line={issues.line} labelId={ISSUES_CARD} />
        ) : (
          <section className={CARD} aria-labelledby={ISSUES_CARD}>
            <BlockHeader label="Issues" labelId={ISSUES_CARD} />
            <p className={FIGURE}>{issues.figure}</p>
            <ChangeLine change={issues.change} comparison="vs 10 weeks ago" />
            <FlowChart
              hero={issues.weeks.map((w) => w.closed)}
              trace={issues.weeks.map((w) => w.opened)}
              names={ISSUE_SERIES}
              /* The word is written out here and not read off `ISSUE_SERIES`,
                 against this file's usual rule, because the copy gate reads a
                 template through its literal chunks: built from the constant
                 the sentence files as "{} opened and {} {} in {}", which is not
                 a sentence anybody can review. `RepoPage.spec.tsx` ties the two
                 together instead — it reads the key word out of the rendered
                 gutter and requires the accessible name to carry it. */
              label={`${issues.opened} opened and ${issues.closed} closed in ${REPO_PAGE_WINDOW}`}
            />
          </section>
        )}

        {prs.kind !== 'read' ? (
          <Absent label="Pull requests" line={prs.line} labelId={PRS_CARD} />
        ) : (
          <section className={CARD} aria-labelledby={PRS_CARD}>
            <BlockHeader label="Pull requests" labelId={PRS_CARD} />
            <p className={FIGURE}>{prs.figure}</p>
            <ChangeLine change={prs.change} comparison="vs 10 weeks ago" />
            {/* The name says the window these two totals ACTUALLY cover, which
                on a short read is not the window the page draws: they sum the
                weeks the read reached and the label used to claim ten
                regardless. The sentence under the chart says the same shortfall
                to a reader who can see it. */}
            <FlowChart
              hero={prs.covered.map((w) => w.merged)}
              trace={prs.covered.map((w) => w.opened)}
              names={PR_SERIES}
              label={`${prs.opened} opened and ${prs.merged} merged in ${coveredWindow(prs.covered.length, prs.uncovered)}`}
            />
            {/* Under the chart, because the chart is now the only thing the
                missing weeks shorten. #1240 R1 moved this up against the
                ten-week totals — correctly, while those totals existed and
                summed the covered weeks only. They are off the card, and the
                leading figure above is `pr.open`, a right-now count no unread
                window makes partial: left up there it would qualify a number
                it has nothing to say about. */}
            {unread && <p className={UNDER}>{unread}</p>}
          </section>
        )}

        {ci.kind !== 'read' ? (
          <Absent label="CI spend" line={ci.line} labelId={CI_CARD} />
        ) : (
          <section className={CARD} aria-labelledby={CI_CARD}>
            <BlockHeader label="CI spend" labelId={CI_CARD} />
            <p className={FIGURE}>{ci.figure}</p>
            <ChangeLine change={ci.change} comparison="vs previous 10 weeks" />
            <CiChart card={ci} />
            {/* The free weeks' sentence, or nothing. The fallback that stood
                here, "N minutes, $0.00 of it free", could only draw when no
                week was free, so it said $0.00 on every card it reached: a
                gloss on billing with nothing in it, the sentence #961 struck
                one branch over. */}
            {ci.note && <p className={UNDER}>{ci.note}</p>}
          </section>
        )}
      </div>

      {/* The readme is a block, at the page's own block width, and the prose
          inside it keeps the reading measure (#825). It used to be the measure
          alone: a `Readme` label over markdown running on the page canvas, 580px
          short of the block above it at a capped rail, under a page built out of
          blocks. Two things were wrong and only one of them was visible — the
          block edge was missing, and the last thing on the page was on a second
          measure from everything above it. */}
      <section className={`${CARD} mt-7`}>
        <BlockHeader label="Readme" />
        {readme.kind === 'read' ? (
          // react-markdown is CommonMark-only on its own: remark-gfm is what
          // turns tables, task lists, strikethrough and autolinks into real
          // elements rather than raw `| a | b |` text. Styling is `.pj-md`,
          // except fenced code, which is the kit's CodeBlock (#963).
          <div className={`pj-md ${PAGE_READING}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={README_COMPONENTS}>{readme.markdown}</ReactMarkdown>
          </div>
        ) : (
          <p className={NOTHING}>{readme.line}</p>
        )}
      </section>
    </>
  );
}

/**
 * The page's pure half — the whole of what a reader sees, given a landed view
 * and a fixed moment. Split for the same reason `ReposBody` is: the board's test
 * env is `node` with no DOM, so this is the half a spec can render.
 */
export function RepoBody({ view, now, section }: {
  view: RepoPageView;
  now: number;
  /** Which tab the address named (#828). Absent is Overview, which is what a
   *  bare `/repo/:owner/:name` means and what every link older than that issue
   *  says. */
  section?: RepoSection;
}) {
  const { repo } = view;
  // No queue entry here (#827): the Issues tab IS this repo's open list, and its
  // own footer already links the filtered board list. `goto` is still wired
  // because the effects are one contract shared with the map tile, where the
  // entry stays.
  const items = repoActionItems(
    repo,
    {
      openExternal: (url) => { window.open(url, '_blank', 'noopener'); },
      goto: gotoPath,
      copy: copyToClipboard,
    },
    { queue: false },
  );

  return (
    <div className={PAGE_RAIL}>
      <div className="pb-24 pt-8">
        <PageCrumb />

        <div className={HEADER_BAND}>
          <div className="min-w-0 basis-[360px] flex-1">
            <h1 className={H1}>
              <a href={repoPath(repo.full)} className={`${H1_ORG} text-link`}>{repo.full.split('/')[0]}/</a>
              {repo.name}
            </h1>
            {repo.description && <p className={DESC}>{repo.description}</p>}
          </div>
          <div className={HEADER_RIGHT}>
            <OwnerBadge view={view} />
            <ActionMenu items={items} handleLabel="Repo actions" appearance="standalone" className="flex-none">
              <span className="sr-only">{repo.name}</span>
            </ActionMenu>
          </div>
        </div>

        <RepoTabRow tabs={repoTabs(view, section)} />

        {/* One of four, and never two. The open issues used to sit under the
            cards on every render of this page; drawing them here as well as on
            their own tab would be the same list in two places, which is a list
            a reader has to compare with itself. */}
        {section === 'issues' ? (
          <div className={TAB_BODY}><IssuesSection view={view} now={now} /></div>
        ) : section === 'prs' ? (
          <div className={TAB_BODY}><PrsSection view={view} now={now} /></div>
        ) : section === 'members' ? (
          <div className={TAB_BODY}><MembersSection view={view} /></div>
        ) : (
          <Overview view={view} now={now} />
        )}
      </div>
    </div>
  );
}
