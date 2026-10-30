import { retryOverviewRead } from '../cache/retry-overview-read';
import { useReadSequence } from '../auth/use-read-sequence';
/**
 * Team pulse (#173, #185). Two operational reads — project completion and
 * per-member throughput, side by side — each mirrored from Github. Skin is the
 * shipped de-gray system (tokens only).
 *
 * The aging list (`OldestOpen`) sat under them until the #752 follow-up moved it
 * to the top of Overview, and #815 took it off the board altogether. The oldest
 * open issue is the flow strip's third tile now (`flow-strip/OldestTile.tsx`).
 * This block no longer takes the org queue at all, and did not gain it back.
 *
 * There was a third: the Issues block (#185), four counts — open / bugs /
 * feedback / unassigned — each a tile that drilled into the board's own issues
 * list. #752 removed the block and its four drill-ins, because the Overview's
 * top screen was spending itself on counts nobody navigated by.
 * `issues-viewer/viewer-links.ts` records what became of each destination.
 *
 * `/api/issues/buckets` is still fetched here and NOTHING on this page reads the
 * answer. That is deliberate and it is load-bearing: this is the board's only
 * caller of that route, and the read is what fills the cache the Board sync
 * panel's "Issue buckets" row reports on (#1169). The argument is at the fetch,
 * where somebody about to delete it will be standing.
 *
 * Mounted on the Unit page only (`team/TeamView.tsx`), under the Crew and above
 * the unit queue. It was the Your-work hero once; that page has been its own
 * personal control room since #206 and no longer renders this.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ThroughputHint } from './ThroughputHint';
import { SessionOrgScopeNotice } from '../OrgScopeNotice';
// #714 — the org the address narrowed to, and the sentences about it.
import { useScopeState } from '../org-scope/use-scope-state';
import { scopeRefusal, type ScopeRefusal } from '../org-scope/scope-copy';
import { type ProjectSummary, fetchOverviewProjects as fetchProjects } from '../api/projects';
import { type IssueMetrics, fetchIssueBuckets } from '../api/issues';
import { memberThroughput, type MemberThroughput } from './pulse-filter';
// #824 — the last answer, kept per person, so this block opens on figures.
import { useReadState } from '../cache/use-board-read';
import { scopeQuery } from '../api/core';
import { PROJECTS_NOT_NOW_CODE, drawable, projectsAfterFailure, saveProjects, type RecalledProjects } from '../projects/projects-last-good';
import { useReportOutdated, useRenewalSignal, useAccessEpoch, useRefreshSignal } from '../sync/sync-status';
import { blockRowOf } from '../projects/ProjectBlock';
import { DisabledProjectStrip, ProjectStrip } from './ProjectContributions';
import { ProjectsPreview } from '../projects/ProjectsPreview';
import { BlockHeader } from '../ui/BlockHeader';
import { BLOCK, CARD_PADDING } from '../ui/block';
import { LoadingStructure } from '../ui/LoadingStructure';
import { smoothPath } from '../ui/smooth-path';
// Shared chart marks, pointer state and keyboard controls (#708).
import { ChartGuide, ChartMark, ChartPoints, pointInside, useChartPointer } from '../ui/chart-pointer';
import { MetricFigure } from '../flow-strip/MetricHelp';
import { weekTipText } from './trend-chart';
import { LAG_AGAINST, lagDays, OrgLagTrend } from './OrgLagTrend';
import { figureChange, FigureChange } from './figure-change';

// Projects spans the page like My work; metrics sit together below it.
const PULSE_ROW = 'grid grid-cols-3 gap-3 max-[900px]:grid-cols-1';

/** Shared by the opened figure and trace. Keep the text token opaque so the
 *  large figure clears 3:1 against the card in both themes (#888 R1). */
const OPENED_LINE = 'var(--muted)';
const BIGNUM = 'text-[34px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-fg';

/** How this page says "we hold nothing here" — plain, no alarm, no retry. The
 *  tile band's missing queue used to share it; since #752 removed the band the
 *  Throughput card's unknown login is the one thing left saying it. */
const QUIET_NOTE = 'text-[12.5px] text-muted';

const CLOSED_LINE = 'var(--chart-series)';

/**
 * THE WEEK MARKERS, in SCREEN pixels, because a `<circle>` in this svg is not a
 * circle (#1171). The chart is `preserveAspectRatio="none"` over a 340x130
 * viewBox, so a radius is stretched by whatever that chart stretches by, and the
 * two axes stretch by different factors at every width. Measured in headless
 * Chrome on the built page by `scripts/measure-chart-dots.mjs`, the trailing
 * closed marker the reporter's arrow points at came out 10.60 x 6.20 px at 900,
 * 12.35 x 6.20 at 1280, 14.50 x 6.20 at 1440 and 17.80 x 6.20 at 1920 — one line
 * of code, four different lozenges, and none of them a dot.
 *
 * `ui/chart-pointer.tsx`'s `DOT_PX` is the whole argument and the shape that
 * answers it: a zero-length line with a round cap and a non-scaling stroke paints
 * a circle of `stroke-width` screen pixels wherever it is drawn.
 *
 * EACH NUMBER IS TWICE THE RADIUS IT REPLACES, so the size a reader had is the
 * size they keep. This chart's y-scale is 120/130, so every marker's drawn
 * HEIGHT grows by under half a pixel (6.28 to 6.8 on the trailing one) and only
 * its width moves — which is the defect. The relationship the mark's own dot was
 * chosen against holds too: 4.8px of `DOT_PX` still sits above the 4.4 a
 * stepped-aside trailing marker falls to.
 */
const OPENED_DOT_PX = { trailing: 4.4, rest: 3 };
const CLOSED_DOT_PX = { trailing: 6.8, rest: 4.4 };

/** The comparison uses the previous rolling week. */
export const THROUGHPUT_AGAINST = '7 days';

/** One week of the trend, oldest first — the shape `IssueMetrics.weeks` and a
 *  member's own series both carry. */
type Week = { opened: number; closed: number };

/** The unit's weekly throughput as a two-line trend (#357): closed (brand) over
 *  opened (a dim reference trace), smoothed with a marker per week and a 0 baseline
 *  + mid gridline. Both series share one scale so their gap reads as net backlog
 *  change. Replaces the paired opened/closed bars — a line trend is easier to read
 *  at a glance, and the per-member breakdown that used to sit above now lives on the
 *  member page. The chart fills the card height so it balances Projects beside it.
 *  Blue is the hero: closed is the thicker, brighter line (jony).
 *
 *  Pointing at a week uses the shared `ui/chart-pointer` controls (#708).
 *  This chart grew its own in #421 — a
 *  hover `useState`, twelve `<rect>` hit targets, a halo behind the closed dot,
 *  dots that swelled under the pointer, and a chip positioned by hand — beside
 *  the repo sparkline's separate implementation of the same idea. That pair is
 *  the reason #708 is a rule, and this is the half of it that already existed.
 *
 *  What stayed is what belongs to this chart: the words. `weekTipText` is now
 *  both the sentence the box shows AND each week's accessible name, so the
 *  twelve columns are reachable by keyboard — which they never were, being
 *  transparent rects a pointer alone could find.
 *
 *  Throughput anchors its readout to the marked closed datum (#1190). Other
 *  charts retain the shared ChartHint's whole-chart anchor.
 *
 *  `max` is the y-scale and comes from the caller, never from `weeks`. The chart
 *  was always the unit's before #461, so a self-scaled plot was constant and
 *  meant something; drawing a member's series that way makes every member fill
 *  the same box, and someone closing one issue a week reads exactly as busy as a
 *  unit closing fifteen. Handing it the unit's maximum puts each member inside
 *  the unit's envelope, so quiet looks quiet.
 *
 *  A selection CAN outrun that maximum: `throughputFor` sums the weeks of every
 *  selected member, and an issue assigned to two people counts for both. So the
 *  plotted value is clamped to the scale rather than the scale widened to the
 *  value — widening would make the scale depend on the selection again, which is
 *  the whole thing it was locked against. The cost is that a week past the
 *  ceiling flattens along the top instead of showing its true height; the
 *  reading still reports the exact numbers, because it is drawn from `weeks` and
 *  not from the plot. Unclamped it drew above the plot entirely, and the svg is
 *  `overflow-visible`, so the line ran over the legend. */
function TrendChart({ weeks, max }: { weeks: Week[]; max: number }) {
  const { mark, read, point } = useChartPointer(weeks.length);
  return <TrendPlot weeks={weeks} max={max} mark={mark} read={read} onPoint={point} />;
}

/**
 * The chart itself, marked at `mark` and reporting `read`. Pure — the pointer
 * lives above it — which is the same split `repos/repo-spark.tsx` uses, and for
 * the same reason: the board's test env is `node`, no week can be hovered, and
 * what a marked chart draws is only readable in a spec if the mark can be
 * handed in.
 *
 * Exported for that spec — nothing else renders it.
 */
export function TrendPlot({ weeks, max, mark, read, onPoint }: {
  weeks: Week[];
  max: number;
  mark: number | null;
  read: number | null;
  onPoint: (i: number | null) => void;
}): ReactElement {
  const W = 340;
  const H = 130;
  const PAD = 6;
  const n = Math.max(1, weeks.length - 1);
  // `max` is caller-supplied, so neither a zero (which would divide to Infinity)
  // nor an overshoot is assumed away here.
  const scale = Math.max(1, max);
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / n;
  const y = (v: number) => H - PAD - (Math.min(v, scale) / scale) * (H - 2 * PAD);
  const closedPts = weeks.map((w, i) => [x(i), y(w.closed)] as [number, number]);
  const openedPts = weeks.map((w, i) => [x(i), y(w.opened)] as [number, number]);
  const grid = [PAD, H / 2, H - PAD];
  const last = weeks.length - 1;
  // The module's `pointInside`, not a private copy of it. This chart kept its
  // own — correct, and one of four different answers to the same question, two
  // of which were "throw". Both pieces of state outlive a change of series: a
  // Crew press swaps the unit's twelve weeks for a member's nine.
  const at = pointInside(mark, weeks.length);
  // The sentence a week reads, said in exactly one place: it is the box's words
  // and the column's accessible name, so what a pointer is told and what a
  // screen reader is told cannot drift.
  const say = (i: number) => weekTipText(last - i, weeks[i].closed, weeks[i].opened);
  const plot = (
    <div className="relative h-full w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block h-full w-full overflow-visible"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Weekly throughput, last ${weeks.length} weeks`}
      >
        {grid.map((gy) => (
          <line data-chart-decoration="grid" key={gy} x1={PAD} x2={W - PAD} y1={gy} y2={gy} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        <path d={smoothPath(openedPts)} fill="none" stroke={OPENED_LINE} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <path d={smoothPath(closedPts)} fill="none" stroke={CLOSED_LINE} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {openedPts.map(([cx, cy], i) => (
          <line
            key={`o${i}`}
            data-dot="opened"
            x1={cx}
            x2={cx}
            y1={cy}
            y2={cy}
            stroke={OPENED_LINE}
            strokeWidth={i === last ? OPENED_DOT_PX.trailing : OPENED_DOT_PX.rest}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {/* One dot on the chart at a time (#576, inherited through #708). The
            marked week's own dot steps aside for the mark's — same brand blue,
            0.4px apart in width, so the two are one dot a reader cannot read —
            and the trailing week gives up its emphasis while anything is
            marked, or the biggest dot on the chart is one nobody pointed at. */}
        {closedPts.map(([cx, cy], i) => (
          i === at ? null : (
            <line
              key={`c${i}`}
              data-dot="closed"
              x1={cx}
              x2={cx}
              y1={cy}
              y2={cy}
              stroke={CLOSED_LINE}
              strokeWidth={at === null && i === last ? CLOSED_DOT_PX.trailing : CLOSED_DOT_PX.rest}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          )
        ))}
        {/* The #951 guide and a haloed dot, as on a repo tile, in place of the
            black rule this chart drew until #1030. */}
        {at !== null && (
          <>
            <ChartGuide x={x(at)} height={H} />
            <ChartMark
              treatment="halo-dot"
              x={x(at)}
              height={H}
              y={closedPts[at][1]}
              column={{ i: at, count: weeks.length, width: W }}
              colour={CLOSED_LINE}
            />
          </>
        )}
      </svg>
      <ChartPoints count={weeks.length} label={say} onPoint={onPoint} at={at} />
    </div>
  );
  // A payload carrying no weeks at all draws its empty box and answers nothing:
  // there is no week to name, `ChartPoints` draws no column for one, and a box
  // opening on a week that does not exist would have to invent a sentence.
  if (weeks.length === 0) return plot;
  // Before the pointer has landed anywhere the box reads the week the chart ends
  // on — never an empty box, and never the window's total dressed up as an
  // answer about one week.
  // One expression, read twice: the words in the box and the point it hangs
  // off cannot be derived from two separately-written answers about one week.
  const reading = pointInside(read, weeks.length) ?? last;
  const anchor = at ?? reading;
  return (
    <ThroughputHint
      label={say(reading)}
      x={x(anchor) / W * 100}
      y={closedPts[anchor][1] / H * 100}
      open={at !== null}
      onHold={() => onPoint(anchor)}
      onDismiss={() => onPoint(null)}
    >
      {plot}
    </ThroughputHint>
  );
}

/** The card's own surface. Hoisted because the "we hold nothing" branch below
 *  renders the same block, and the two must not drift apart. It was `p-5`, 4px
 *  more than Org lag beside it (#944). */
const THROUGHPUT_CARD = `${BLOCK} flex flex-col ${CARD_PADDING}`;

/** What the Throughput card says when the selected login is one board-api holds
 *  no row for at all. It replaces the numbers AND the chart rather than sitting
 *  under them: two em dashes at 34px semibold read as a pair of rules, so the
 *  card came out looking like its own legend drawn twice at two sizes. Same
 *  register as `QUIET_NOTE` above — plain, no alarm, no retry. */
const NO_THROUGHPUT = 'The board holds no throughput for this login.';

/**
 * The unit's weekly throughput, or a Crew selection's (#461).
 *
 * The card stretches to Projects' height beside it while it has a chart to fill
 * with. Without one, stretching leaves a tall empty well under a couple of lines,
 * which reads as a chart that failed to load — so the card ends after what it has
 * to say and the gap beside Projects is visibly deliberate.
 *
 * Two states hold no chart and they are not the same state. A login `byMember`
 * has no row for is UNKNOWN: nothing on this card would be about them, so the
 * numbers go with the chart and one line says so. A login it does hold a row for
 * that carries no series is known but unplotted — the deploy window where
 * board-api ships `byMember` before `weeks` — and their counts are real, so they
 * are still stated. Neither may fall through to the unit's own series: an org
 * chart under one person's name is the falsehood `throughputFor` returns
 * `weeks: null` to prevent, and it reached this card a second way through the
 * unknown branch.
 *
 * Exported for its spec — nothing else renders it.
 */
export function ThroughputCard({ m, member }: {
  m: IssueMetrics;
  member?: MemberThroughput | null;
}) {
  if (member?.kind === 'unknown') {
    return (
      <div className={`${THROUGHPUT_CARD} self-start`}>
        <BlockHeader label="Throughput" />
        <p className={QUIET_NOTE}>{NO_THROUGHPUT}</p>
      </div>
    );
  }
  // The scale is the unit's in both states — see `TrendChart`. Same window the
  // unfiltered trend plots, so nothing about the unfiltered render moves.
  const unitWeeks = m.weeks.slice(-12);
  const scaleMax = Math.max(1, ...unitWeeks.flatMap((w) => [w.opened, w.closed]));
  const trend = member ? member.weeks : unitWeeks;
  // UNFILTERED, THE HEADLINE IS THE UNIT'S OWN TRAILING WEEK — the last entry of
  // `weeks`, which is the last point of the chart drawn under it (#895).
  //
  // It summed `byMember` instead, and that sum is a different population from
  // everything else on the page. `issues-metrics.vm.ts` attributes those rows by
  // ASSIGNEE: an issue with two assignees is counted twice, and one with none is
  // counted nowhere. So the figure was neither the org's throughput nor the sum
  // of anything a reader can see — on `scripts/fixtures/team-api.json` it reads
  // 4 closed where the org closed 8, and the flow strip's day grid above it,
  // which counts issues once and keeps the unassigned, sums those same seven days
  // to 8. That is #895's report: two blocks, two closed counts, no way to
  // reconcile them.
  //
  // Both figures now come from the trailing seven-day window. A Crew
  // selection keeps `byMember`'s per-assignee counts, which is the right
  // population for "what this person closed" and is already exactly
  // `member.weeks`' last entry — the same rolling seven days, counted the same
  // way — so the headline and the plotted line agree in that branch too.
  const unitTrailing = unitWeeks[unitWeeks.length - 1] ?? { opened: 0, closed: 0 };
  const teamClosed = member ? member.closed : unitTrailing.closed;
  const teamOpened = member ? member.opened : unitTrailing.opened;
  // THE SEVEN DAYS BEFORE THOSE (#1029), off the series the chart draws: its
  // second-to-last week is that window, counted the way the headline is. A
  // series of one week, or a member whose payload carries none, has no week
  // before to compare with, and the card then omits the deltas.
  //
  // More closed is better. Opened has no better direction, because a rise is
  // as likely to be more reports caught as more trouble made, so its change is
  // signed and drawn in quiet ink.
  const prior = trend && trend.length > 1 ? trend[trend.length - 2] : null;
  const closedChange = prior ? figureChange(teamClosed - prior.closed, 'up') : null;
  const openedChange = prior ? figureChange(teamOpened - prior.opened, null) : null;
  // `data-metric-card` is how `scripts/check-heard-copy.mjs` finds this card in
  // Chrome's accessibility tree, so that removed period labels are counted
  // inside the card that measures them rather than across the whole page. Same
  // reason `data-figure-change` is on each delta: a card that starts or stops
  // saying its window is read the day it is written.
  return (
    <div className={`${THROUGHPUT_CARD} ${trend ? '' : 'self-start'}`} data-metric-card="Throughput">
      <BlockHeader label="Throughput" />
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1" data-throughput-figures>
        <span className="flex items-baseline gap-1.5">
          <span className={BIGNUM} style={{ color: 'var(--accent-strong)' }}>{teamClosed}</span>
          <span className="text-[12px] font-medium text-dim">closed</span>
          {closedChange && <FigureChange change={closedChange} against={THROUGHPUT_AGAINST} />}
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className={BIGNUM} style={{ color: OPENED_LINE }}>{teamOpened}</span>
          <span className="text-[12px] font-medium text-muted">opened</span>
          {openedChange && <FigureChange change={openedChange} against={THROUGHPUT_AGAINST} />}
        </span>
      </div>
      {/* The figures name and colour the series; the chart fills the card. */}
      {trend && (
        <div className="mt-6 flex flex-1 flex-col">
          <div className="h-[120px]">
            <TrendChart weeks={trend} max={scaleMax} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Overview keeps its org-wide population and links in the shared My work layout. */
export function ProjectsCard({ projects, note = null }: { projects: ProjectSummary[]; note?: string | null }) {
  return <ProjectStrip rows={projects.map((p) => blockRowOf(p, p))} note={note} />;
}

/** What the Org lag figure's tooltip says (#1031): what the mean is of, and how
 *  many issues it is over. It was "Mean time from opening to closing.
 *  Organization-wide · Closed in the last 90 days. 255 issues.", four fragments
 *  and a middot, and the figure keeps only the definition.
 *  Exported for its spec. */
export function orgLagHelp(n: number): string {
  return `Mean time from open to close, over ${n.toLocaleString('en-US')} ${n === 1 ? 'issue' : 'issues'} closed organization-wide.`;
}

/**
 * What the card says when the figure has nothing behind it (#1103 review, B2).
 *
 * It has to be true of what was actually COUNTED, and two things were nearly
 * said instead. "anywhere" is a claim about every owner this board serves, and
 * `allowedOwners` has been a list since #649: the metrics `TeamView` hands down
 * are one owner's, which is why the sibling line two elements away says "Org lag
 * couldn't be read" and `orgLagHelp` says "organization-wide". And the count is
 * not every close — `deliveredCloseAt` (`issues-metrics/close-reason.ts`) drops
 * the not-planned and duplicate closes, which on this org is 382 issues against 3,318,
 * so an organization whose only closes in the window were not planned would be
 * told nothing closed at all. Both halves are said rather than one implied.
 *
 * "Not planned" and "Duplicate" are the labels the close dialog offers
 * (`close-reason.ts`'s CLOSE_CHOICES), so a reader meets the same two words here
 * that they picked from there.
 */
const ORG_LAG_NOTHING_CLOSED =
  'No issues closed in this organization in the last 90 days. Ones closed as not planned or duplicate are left out.';

/** Org lag stays organization-wide when the Crew selection changes (#843). */
export function OrgLagCard({ metrics, failed = false }: { metrics: IssueMetrics | null; failed?: boolean }) {
  const ttc = metrics?.ttc;
  const available = !failed && ttc?.readable === true && ttc.windowDays === 90;
  const rolling = available ? ttc.comparison?.rolling : undefined;
  const latest = rolling?.at(-1);
  const mean = latest ? latest.meanDays : ttc?.meanDays;
  const count = latest?.n ?? ttc?.n;
  const hasMean = available && count! > 0 && typeof mean === 'number' && Number.isFinite(mean) && mean >= 0;
  const empty = available && count === 0 && mean === null;
  const value = hasMean ? lagDays(mean) : null;
  // A longer lag is worse (#1029), so a fall is drawn as the good news it is.
  // Rounded to the figure's one decimal first: a move too small to print is no
  // change, not a coloured `+<0.1`.
  const prior = rolling?.[0];
  const rawDelta = rolling && rolling.length > 1 && prior!.meanDays !== null && mean != null
    ? mean - prior!.meanDays : null;
  const delta = rawDelta === null ? null : Math.round(rawDelta * 10) / 10;
  const change = hasMean && delta !== null ? figureChange(delta, 'down', lagDays) : null;
  const pointer = useChartPointer(rolling?.length ?? 0);
  return (
    <section className={`${BLOCK} ${CARD_PADDING}`} aria-label="Org lag" data-metric-card="Org lag">
      <BlockHeader label="Org lag" />
      <div className="flex items-center justify-between gap-5">
      {value !== null ? (
        <p className="flex items-baseline gap-1.5">
          <MetricFigure label={`${value} days. Org lag details`} description={orgLagHelp(count!)}>
            <span className={BIGNUM}>{value}</span>
          </MetricFigure>
          <span className="text-[12px] text-dim">days</span>
          {change && <FigureChange change={change} against={LAG_AGAINST} />}
        </p>
      ) : <p className={QUIET_NOTE}>{empty ? ORG_LAG_NOTHING_CLOSED : !metrics && !failed ? 'Loading org lag…' : 'Org lag couldn’t be read just now.'}</p>}
      {hasMean && rolling && <OrgLagTrend rolling={rolling} mark={pointer.mark} read={pointer.read} onPoint={pointer.point} />}
      </div>
    </section>
  );
}

export function Pulse({ assignees = [], metrics, metricsFailed = false, onScope }: {
  /** The host page's Crew selection (#461), used by Throughput. Org lag and
   *  Projects retain the organization's scope. */
  assignees?: readonly string[];
  /** Issue-flow metrics, fetched by the host and handed down (#666). Fetched
   *  here until the flow strip began reading the same response one level up:
   *  two bare `fetchIssueMetrics()` calls in two effects on one page are one URL
   *  requested twice at once, and nothing coalesces them — `apiFetch` holds no
   *  in-flight map, and the HTTP cache cannot dedupe requests already in flight.
   *  The endpoint is stale-while-revalidate, so two reads straddling a refresh
   *  land on different snapshots and this card could state a different number
   *  for a member than the strip above it. The host withholds metrics on a
   *  named unreadable verdict or withdrawal; `metricsFailed` distinguishes
   *  unavailable figures from an initial read still in flight. */
  metrics: IssueMetrics | null;
  metricsFailed?: boolean;
  /** Optional report of the Projects read alone; issue scope belongs to the host. */
  onScope?: (r: { refusal: ScopeRefusal | null; served: boolean } | null) => void;
}) {
  // Projects has its own coverage, independent of the host's issue reads.
  const [refusal, setRefusal] = useState<ScopeRefusal | null>(null);
  // The read answered, whatever it answered with. See `use-scope-state`: it is
  // the only thing this device remembers about an org (#714).
  const [served, setServed] = useState(false);
  const scope = useScopeState(refusal, served);
  // The ORG is in the key (#714, #824): this read carries `?org=`, so one org's
  // boards can never open on another org's copy, and moving between them
  // re-seeds from the org being moved to rather than blanking to a skeleton.
  // Declared under `scope` because that is where the org is known.
  // `Array.isArray` for the same reason `TeamView`'s roster takes one: these
  // rows are walked, and an object stored under a shape this build no longer
  // speaks would throw inside the render (#824 follow-up).
  const [projects, setProjects] = useReadState<ProjectSummary[], { projects: ProjectSummary[] }>(`/api/projects${scopeQuery(scope.org ?? undefined)}`, value => value.projects);
  // Whether the rollup read FAILED, held apart from the boards themselves
  // (#824 review). `setProjects([])` on a failure wrote that empty array
  // through to the disk — `use-cached-state.ts` stores anything non-null — and
  // the next visit seeded it, so `projects` was truthy on the first render and
  // this block drew `0%` and "0 / 0 issues closed on 0 of 0 boards": a definite
  // claim about the org, from the disk, produced by a read that failed.
  // The failure flag stops the skeleton without inventing an empty answer.
  const [rollupFailed, setRollupFailed] = useState(false);
  const [keepPreview, setKeepPreview] = useState(true);
  // The saved copy a failed read recalled (#1035): what draws when the disk's
  // own copy went with the permission wipe at page load. Null otherwise.
  const [saved, setSaved] = useState<RecalledProjects | null>(null);
  // Only callers that need the Projects verdict subscribe to it.
  const report = onScope;

  // The previous org's boards and the previous org's refusal both go before the
  // new read lands — arriving on a served org from a refused one left the old
  // 404 in state and the block said the board did not cover an org it does.
  useEffect(() => {
    // The boards themselves are no longer cleared here (#824): the key above
    // carries the org, so the state re-seeds on the org that is being moved TO.
    // That does this effect's job and does it better, since the new org's own
    // copy goes up instead of a skeleton. What is left is the verdicts, which
    // are not cached and would otherwise be the previous org's.
    setRefusal(null);
    setServed(false);
    setRollupFailed(false);
    setKeepPreview(true);
    report?.(null);
  }, [scope.org, report]);

  // Refetch when a manual "sync now" completes (#301).
  const refresh = useRefreshSignal();
  const accessEpoch = useAccessEpoch();
  const renewal = useRenewalSignal();

  /**
   * `/api/issues/buckets`, read for the READ and not for the answer (#1169).
   *
   * Nothing draws a number or a link from this payload: #461 took the Issues
   * block and its four drill-ins off this page, and the tiles above read the
   * host's org queue instead. Until #1169 the payload's `syncedAt` still fed the
   * top-bar "Synced" clock through `useReportSync`; that clock reads
   * `GET /api/sync/sources` now, and this file reports nothing up any more.
   *
   * WHAT IT STILL DOES, and why deleting it would take a row off a panel nobody
   * would think to look at. This is the frontend's only caller of that route,
   * `IssueBucketsService` fills lazily on a read and has no boot warm, and the
   * cache it fills is what the Board sync panel's "Issue buckets" row reports
   * on. Delete this and that row says "Not recorded" for ever, on a board where
   * nothing is wrong. `Pulse.spec.tsx` fails if the read goes.
   *
   * The answer is dropped rather than stored: a payload held in state and read
   * by nobody is the thing that made this fetch look dead in the first place.
   * A failure is swallowed for the same reason it always was (#824) — one lost
   * read costs a row its precision, never the card.
   */
  useEffect(() => {
    fetchIssueBuckets().catch(() => {});
    // The ORG is not read by this one, but a navigation re-running it costs a
    // single warm. The rollup, which does carry the org, moved to its own
    // effect below (#892 review, C2).
  }, [refresh, scope.org]);

  const beginProjects = useReadSequence(JSON.stringify([scope.org, accessEpoch]));

  // Only an opening load retries; later refreshes settle on the saved copy.
  const projectScope = JSON.stringify([scope.org, accessEpoch]);
  const openingProjects = useRef({ key: projectScope, ready: false });
  if (openingProjects.current.key !== projectScope) openingProjects.current = { key: projectScope, ready: false };

  useEffect(() => {
    const completed = openingProjects.current;
    const retry = new AbortController();
    void retryOverviewRead(() => {
      const accept = beginProjects();
      return fetchProjects(scope.org ?? undefined).then(
        (r) => {
          if (retry.signal.aborted) return;
          if (!accept()) return;
          completed.ready = true;
          setProjects(r.projects);
          saveProjects(scope.org, r.projects);
          setSaved(null);
          setRollupFailed(false);
          setKeepPreview(true);
          setRefusal(null);
          setServed(true);
          report?.({ refusal: null, served: true });
        },
        (e: unknown) => {
          if (retry.signal.aborted) return;
          if (!accept()) return;
          // Keep the last answer on a transient failure; never store an empty fallback.
          setRollupFailed(true);
          // One rule for every copy of this answer, and it is the saved copy's
          // (#1060). `projectsAfterFailure` says whether the boards this page is
          // HOLDING may stay, and takes the stored and saved copies with them
          // when they may not. It used to ask `scopeWithdrawn` instead, which is
          // a narrower question — a 403 or an org 404 — so a Github FORBIDDEN,
          // which reaches the browser as a 500, left a reader whose access had
          // just been taken away reading the boards on the page they had open.
          // A transient outage or a "not now" still retains all three; neither
          // failure establishes an empty rollup.
          const after = projectsAfterFailure(scope.org, e);
          setKeepPreview(after.keepHeld);
          setSaved(after.saved);
          if (!after.keepHeld) setProjects(null);
          const r = scopeRefusal(e);
          setRefusal(r);
          setServed(false);
          report?.({ refusal: r, served: false });
          throw e;
        },
      );
    }, `/api/projects${scope.org ? `?org=${encodeURIComponent(scope.org)}` : ''}`, PROJECTS_NOT_NOW_CODE, retry.signal, () => !completed.ready).catch(() => {});
    // The ORG is in the key (#714): the projects read carries `?org=` off the
    // address, so a move from one org's board to another's is a different
    // request rather than a re-render of the same one.
    return () => { retry.abort(); };
  }, [refresh, scope.org, accessEpoch, renewal, beginProjects, setProjects, report]);

  // Memoized on the inputs, not left to re-run per render: every keystroke in the
  // queue's search box commits, navigates and fires a popstate, which re-renders
  // this page — and these walk the whole org array. Every dep is a plain
  // identifier: a fresh array literal in one of these lists would read as
  // memoized while defeating the memo on every render.
  const member = useMemo(() => memberThroughput(metrics, assignees), [metrics, assignees]);

  // A failed read is unavailable, never a measured zero-board rollup. What it
  // may draw is a COPY: the boards this page holds, or the saved ones (#1035).
  const copy = rollupFailed ? drawable(saved, scope.org) : null;
  const boards = projects ?? copy?.value ?? null;
  useReportOutdated(rollupFailed && boards !== null);

  return (
    <>
      {scope.org === null && <SessionOrgScopeNotice className="mb-3" />}
      <div className="space-y-3">
        {boards ? <ProjectsCard projects={boards} /> : !keepPreview ? <DisabledProjectStrip label="Projects" note="Projects couldn’t be read just now." /> : <ProjectsPreview org={scope.org ?? undefined} failed={rollupFailed} />}
        <div className={PULSE_ROW}>
          <div className="col-span-2 min-w-0 max-[900px]:col-span-1">
            {metrics ? <ThroughputCard m={metrics} member={member} /> : metricsFailed ? <p className={QUIET_NOTE}>Throughput couldn’t be read just now.</p> : <LoadingStructure surface="throughput" label="throughput" className="min-h-[200px]" />}
          </div>
          <div className="min-w-0 self-start"><OrgLagCard metrics={metrics} failed={metricsFailed} /></div>
        </div>
      </div>
    </>
  );
}
