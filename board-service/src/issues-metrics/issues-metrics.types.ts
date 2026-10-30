import type { MetricScope } from './metric-scope';
// Issue-flow metrics (#120): shared shapes for the source, the pure VM, and the
// GET /api/issues/metrics response. A "raw issue" is the normalised subset of a
// GitHub issue we need; everything the surface shows is derived from a list of
// these by the VM (issues-metrics.vm.ts).

import type { CloseReason } from './close-reason';
import type { PersonalIssueType } from './issue-type';

export interface RawIssue {
  /** The Github org this issue was read from, e.g. 'acme' (#647).
   *
   *  `repo` below is a SHORT key and carries no owner, so it is not a key once
   *  the board reads more than one org: `acme/design-system` and
   *  `globex/design-system` both exist, and both fold onto `design-system`.
   *  Everything that JOINS an issue to a repo keys on `${owner}/${repo}` —
   *  `repoJoinKey` in `repos/repo-rollup.ts` composes it — while `repo` stays
   *  what it has always been, a display key and the `?repo=` filter value.
   *
   *  Required, not optional, so a new source has to answer rather than inherit
   *  an opening default. An optional owner compiles while every join stays
   *  keyed on the short key, which is the defect this field exists to end. */
  owner: string;
  /** short repo key, e.g. 'acme' or 'board' — DISPLAY and the `?repo=` filter
   *  value, never a join key on its own; see `owner` above. */
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
  state: 'open' | 'closed';
  createdAt: string;
  closedAt: string | null;
  /** WHY this issue closed, or `null` when we were not told (#1014) — the field
   *  `deliveredCloseAt` reads to decide whether the close beside it is delivery.
   *
   *  Never read on its own by a counter. `close-reason.ts` holds the one
   *  predicate, because the join between the reason and the instant is a single
   *  decision and two dozen call sites restating it is how the two drift.
   *
   *  Required, not optional, so a new source has to answer rather than inherit
   *  an opening default — the rule `owner`, `labelsComplete` and `submission`
   *  each state above, and it carries more weight here than for any of them.
   *  An unknown reason COUNTS as delivery, deliberately (see `close-reason.ts`),
   *  so an optional field would let a source that forgot to select it revert
   *  silently to the over-count this field was added to end. The type is the
   *  guard; the predicate's leniency is safe only because of it. */
  stateReason: CloseReason;
  /** GitHub login of the issue's author/creator, or null (ghost/deleted user). */
  author: string | null;
  /** GitHub assignee logins (may be empty) */
  assignees: string[];
  /** label names */
  labels: string[];
  /** True when `labels` is the issue's WHOLE set (#497). The words gate keys on
   *  a label being present, so a set we could not establish reads as "no
   *  `feedback` label here" and serves an end user's first line; false makes the
   *  gate withhold instead, and only in the repo a submission could live in.
   *  Required, not optional, so a new source has to answer rather than inherit
   *  an opening default. */
  labelsComplete: boolean;
  /** True when this issue's body carries the board feedback form's attribution
   *  footer (#516) — the marker that says what the issue IS, whatever its labels
   *  say after triage. Two-valued rather than three because this source always
   *  has the body: the REST issue list embeds it, so there is no page to truncate
   *  and nothing to be unsure about, the same argument `labelsComplete` makes.
   *  "We could not tell" appears at the index boundary instead, where no row for
   *  an issue is a real state. Required, not optional, so a new source has to
   *  answer rather than inherit an opening default. */
  submission: boolean;
  /** milestone title (our cycle marker) or null */
  milestone: string | null;
}

/** A lean open-issue row for the ⌘K palette index (#214) — enough to match on
 *  and to route to the in-board issue page (#235). owner/repo let the palette
 *  build `/issue/:owner/:repo/:number` without another lookup. */
export interface SearchIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
}

// The taxonomy itself lives in issue-type.ts, beside the `deriveType` that both
// VMs run (#666) — re-exported here so every existing importer keeps one import.
export type { PersonalIssueType } from './issue-type';

/** One open issue in the signed-in user's queue (#206) — assigned to them OR
 *  unassigned (#231): the raw issue plus a derived type, blocked flag, and age. */
export interface PersonalIssue {
  repo: string;
  /** The Github org this row came from (#650) — `repo` above is a SHORT key and
   *  folds across orgs, so a row cannot name its origin without this. */
  owner: string;
  number: number;
  title: string;
  htmlUrl: string;
  createdAt: string;
  ageDays: number;
  labels: string[];
  type: PersonalIssueType;
  /** carries a `blocked`/`blocker` label — the queue's one attention signal. */
  blocked: boolean;
  /** In the aging set (#478) — open flow work at or past the threshold. Decided
   *  here, by the same predicate the Oldest-open block's count runs on, so the
   *  queue's "Aging (30+ days)" filter narrows to exactly what the block reports
   *  instead of re-deriving a rule of its own. Always false for a closed row. */
  aging: boolean;
  /** True when the issue is assigned to the signed-in user; false for an
   *  unassigned "up for grabs" queue item (#231). */
  assignedToMe: boolean;
  /** GitHub assignee logins (may be empty → unassigned) — the card's avatars (#230). */
  assignees: string[];
  /** GitHub login of the issue's author/creator (for the card avatar), or null. */
  author: string | null;
  /** Names of the GitHub Project(s) this issue is on — for stacking by project.
   *  Empty when it's on no board (→ the "No project" stack). */
  projects: string[];
  /** Lifecycle state — 'open' for queue rows, 'closed' for recentlyClosed rows (#407). */
  state: 'open' | 'closed';
  /** ISO close timestamp, or null when open (#407) — powers the closed-week drill-in. */
  closedAt: string | null;
  /** Why it closed, or null when open or when we were not told (#1014).
   *
   *  On the wire because the frontend counts closes of its own: the viewer's
   *  `closed-yesterday` and `closed-week` timeframe filters select client-side
   *  over whatever list is loaded, so without the reason here the drill-in
   *  behind a tile would list closes the tile above it no longer counts. Every
   *  other close figure is filtered server-side and needs nothing.
   *
   *  Optional across the deploy window on the FRONTEND's copy of this type,
   *  required here: board-api always answers, and a reader that predates the
   *  field falls back to counting every close, which is what it did before. */
  stateReason: CloseReason;
}

/** One GitHub Project the signed-in user is working in, with how much they've
 *  moved it lately — the "Project contributions" memory block (#380). Scoped to
 *  the caller: only issues *assigned to them* count. `closed7d` is the issues
 *  they closed within the trailing CONTRIB_WINDOW_DAYS; `lastClosedAtISO` is
 *  their most recent close on the board (null when they've closed nothing there);
 *  `openAssigned` is their current open commitments on it; `slipping` is true
 *  when they still hold open work but have closed nothing inside the window —
 *  it's slipped out of their week. */
export interface ProjectContribution {
  /**
   * The Github org the board was read from (#697) — the other half of its
   * address.
   *
   * Required, and it is what makes `number` below usable as a deep link at all.
   * A Projects v2 number is unique only WITHIN an org, and the memberships this
   * block is built from are the UNION across every configured org — so two rows
   * can both be `number: 3` and be two different boards. A consumer joining
   * these rows to the board rollup on the number alone matched whichever board
   * came last: one org's name over another org's ring. `org` + `number`
   * addresses exactly one board.
   *
   * A single-org deployment answers its one org on every row, so nothing there
   * changes except that the field is now said out loud.
   */
  org: string;
  /** GitHub Project (v2) number — with `org` above, the deep-link segments to
   *  the board's page. Unique within its org, not across the union. */
  number: number;
  name: string;
  closed7d: number;
  openAssigned: number;
  lastClosedAtISO: string | null;
  slipping: boolean;
}

/** GET /api/issues/mine — the signed-in user's open queue + their trailing-7d
 *  throughput. `login` is the resolved GitHub login (null when the caller's
 *  email maps to no alias, in which case `issues` is empty). */
export interface PersonalIssues {
  metricScope?: MetricScope;
  /** The clock the day series below were BUCKETED BY — this exact snapshot's
   *  `now`, and the day their last cell is for (#1015).
   *
   *  NOT `updatedAt`, and the difference is why this field exists. That one is
   *  overwritten downstream with the raw-issue cache's fetch time, because it
   *  answers "how fresh is this", and the cache is served stale-while-revalidate
   *  with no bound while refreshes fail. So it can sit hours or days behind the
   *  day `closedDays` actually ends on, and anything dating a cell off it draws
   *  the series on the wrong days.
   *
   *  A reader must not substitute its OWN clock either. `/api/issues/mine` is
   *  cached in the browser for up to 24 hours and held on screen through a failed
   *  live read, so the caller's `Date.now()` can be a day or two past the day
   *  these counts were counted to — and the grid then draws yesterday's closes on
   *  today's cell, labels and all. The org payload has carried its own anchor
   *  since `computedAt` was added to `IssueMetrics`; this is the same anchor for
   *  the same reason, and the two surfaces now date a day one way.
   *
   *  Optional across the deploy window, and absent from the frontend's
   *  unavailable-queue fallback, which stamps nothing because a failed fetch
   *  knows nothing about freshness. Absent means no claim: date off the caller. */
  computedAt?: string;
  timeZone?: string;
  updatedAt: string;
  login: string | null;
  issues: PersonalIssue[];
  throughput: { opened: number; closed: number };
  /** Rolling 7-day throughput windows for this login, oldest → newest — the
   *  last entry is the trailing 7 days and equals `throughput`. Powers the
   *  Closed/Opened cards' sparklines (#254). Empty for an unmapped login. */
  throughputWeeks: WeekBucket[];
  /** The same throughput at day resolution (#666, #684): DAY_SPAN UTC calendar
   *  days, oldest → newest, last cell = the day `updatedAt` falls in. Feeds the
   *  day-over-day figure and the day grid; the weekly series above is untouched
   *  and still drives the sparklines. Both arrays empty for an unmapped login. */
  throughputDays: DaySeries;
  /** Closes per viewer calendar day over this login's whole history (#817), oldest
   *  → newest, ending on the same day `throughputDays` does. Feeds the calendar
   *  grid, which draws a whole year and so cannot live on the sparks' 98.
   *
   *  Its LENGTH is what says how far back it reaches: the series reaches back to
   *  the first close the mirror holds — the WHOLE fetched set's, not this
   *  login's own — so a consumer dates cell 0 as the payload's own UTC day minus
   *  `closedDays.length - 1`. No start date travels beside it; that would be a
   *  second definition of one date, free to drift from the length.
   *
   *  The whole set and not this login's, because the difference is a claim about
   *  days: before this person's first close the board was watching and they
   *  closed nothing, which is a zero. Sized off their own history those days
   *  would arrive as absent, and the same person's `byMember` row would carry
   *  them as zeroes — one person reading two ways on two surfaces.
   *
   *  It never runs SHORTER than the sparks' 98 days; `historySpan` carries that
   *  trade and its bound.
   *
   *  Empty for an unmapped login, like `throughputDays`: a window nobody counted
   *  is not a run of quiet days. */
  closedDays: number[];
  /** The caller's GitHub Projects with recent contribution (#380). Optional so
   *  the pure queue VM stays byte-stable and an older board-web tolerates a
   *  board-api that predates the field; the service always sets it (→ [] for an
   *  unmapped login or when the projects join is unavailable). */
  projectContributions?: ProjectContribution[];
  /** Issues assigned to the caller that they closed in the trailing 7 days (#407),
   *  most-recently-closed first. A SEPARATE field, never merged into `issues` (which
   *  stays open-only) — the Your-work viewer feeds both so the "Closed this week" tile
   *  can drill in-board, while the queue/oldest/contributions still read `issues` alone.
   *  Optional so an older board-web tolerates a board-api that predates it. */
  recentlyClosed?: PersonalIssue[];
}

/** The whole unit's open queue (#284) — the same stackable rows as the personal
 *  queue, at org scope. No login / throughput: this is a shared work board on the
 *  Unit page, not a personal cockpit. */
export interface OrgQueue {
  metricScope?: MetricScope;
  updatedAt: string;
  issues: PersonalIssue[];
}

export const ISSUES_SOURCE = 'ISSUES_SOURCE_IMPL';

export interface ListIssuesOptions {
  /** Read every repository from Github, even one the webhook store could answer
   *  for, and write what was read back as its baseline (#1007, V5). "Sync now"
   *  and the re-read after a write ask for this, and it is how the store catches
   *  up on a delivery it missed. */
  reconcile?: boolean;
  /** A catch-up after a webhook delivery (#1007, V5): the snapshot being
   *  refreshed. A repo the store answers comes from the store, and every other
   *  repo this describes keeps the rows and outcome it holds for it instead of
   *  being paged from Github again. A repo in scope it does not describe is paged. */
  reuse?: {
    issues: RawIssue[];
    repos: { full: string; ok: boolean; id?: number; fromStore?: boolean }[];
    /** Only these repos changed since the snapshot; absent means refresh all. */
    changedRepos?: string[];
  };
}

export interface IIssuesSource {
  /** All tracked issues across the configured repos (open + closed, no PRs). */
  listIssues(options?: ListIssuesOptions): Promise<RawIssue[]>;
}

export interface IssueMetricsQuery {
  timeZone?: string;
  org?: string;
  /** short repo key to scope to, or undefined/'all' for every repo */
  repo?: string;
  /** only issues carrying this label */
  label?: string;
  /** only issues on this milestone (cycle) */
  cycle?: string;
}

export interface WeekBucket {
  opened: number;
  closed: number;
}

/** Opened/closed per viewer calendar day (#666, #684) — the same two counts as a
 *  WeekBucket, but over the DAY a thing happened on rather than a window ending
 *  at `now`. Kept a separate type so the two divisors can't be swapped by
 *  accident, and struct-of-arrays rather than one `{opened, closed}` object per
 *  day: 415 bytes of JSON against 2,353, measured, which the per-member roster
 *  pays 20-60 times over on every metrics response. Both arrays are `DAY_SPAN`
 *  long, oldest → newest, every day present including the zeroes. */
export interface DaySeries {
  opened: number[];
  /** Issues DELIVERED per day — completed closes only, since #1014. */
  closed: number[];
  /** Issues that LEFT THE OPEN QUEUE per day, whatever the reason (#1014).
   *
   *  `closed` above answers "what shipped"; this answers "what stopped being
   *  open", and after #1014 they are different numbers. Both ship because the
   *  frontend's queue-depth walk needs the second and every other figure needs
   *  the first.
   *
   *  The walk reconstructs the open level backwards as
   *  `level - opened[i] + exited[i]`, and that identity holds only against
   *  EVERY exit. Fed the delivered series, an issue abandoned as not-planned
   *  leaves the queue without being added back, so every day before it is drawn
   *  one issue too low and the error accumulates over the window — on a repo
   *  where half the closes are abandoned the line reaches the zero floor and
   *  draws a queue that grew from nothing.
   *
   *  A third array on a shape whose docblock argues about bytes: the two-arrays
   *  decision was measured at 2,353 bytes against 415 over a DAY_SPAN series,
   *  and this adds about half as much again per row. Paid knowingly — the
   *  alternative is a chart that is wrong for most of its width. */
  exited: number[];
}

export interface LoadRow {
  /** resolved display name (or the login when unknown; 'Unassigned' bucket) */
  name: string;
  /** GitHub login, or null for the unassigned bucket */
  login: string | null;
  count: number;
}

export interface StaleRow {
  repo: string;
  /** The Github org this row came from (#650) — `repo` above is a SHORT key and
   *  folds across orgs, so a row cannot name its origin without this. */
  owner: string;
  number: number;
  title: string;
  ageDays: number;
  who: string;
  /** Assignee GitHub logins — the Oldest-open block (#207) shows the first as an
   *  avatar; empty = unassigned. `who` stays the human-readable fallback. */
  assignees: string[];
  htmlUrl: string;
}

/** Per-member throughput over the trailing 7 days — attributed by assignee.
 * `opened`/`closed` count issues an assignee owns that were created/closed in
 * the window (an unassigned issue lands in neither; that gap is the Unassigned
 * headline, tracked separately). The team-pulse roster on the dashboard. */
export interface MemberThroughput {
  login: string;
  /** resolved display name (or the login when unknown) */
  name: string;
  opened: number;
  closed: number;
  /** Github searches behind the two counts (#303) — so a number can be validated
   *  against the actual issues it stands for. `closedHref` lists this member's
   *  issues closed in the window; `openedHref` those created in it. Null when no
   *  org could be derived (empty issue set), so the count renders non-clickable. */
  closedHref: string | null;
  openedHref: string | null;
  /** This member's own 12-week opened/closed series (#336) — same rolling
   *  windows as the org-wide `weeks`, attributed by assignee. Lets the dashboard
   *  filter the trend chart to one member without a second request. */
  weeks: WeekBucket[];
  /** This member's own calendar days (#666, #684) — same span and alignment as
   *  the org-wide `days`, attributed by assignee, so a per-member day grid needs
   *  no second request. Every day present, zeroes included. */
  days: DaySeries;
  /** This member's closes per calendar day over the whole history (#817) — the
   *  same window as the org-wide `closedDays`, and the same length, so every row
   *  of the payload is drawn on ONE axis. Sized from the whole filtered issue
   *  set rather than from this member's own first close: a member who started
   *  last month gets the org's window with leading zeroes, which is the truth
   *  about them, where a shorter row would silently be a different x-axis. */
  closedDays: number[];
}

export interface IssueMetrics {
  metricScope?: MetricScope;
  /** Calendar anchor and underlying closes from this exact metric snapshot. */
  computedAt?: string;
  timeZone?: string;
  openedEvents?: { htmlUrl: string; createdAt: string; assignees: string[] }[];
  closeEvents?: { htmlUrl: string; closedAt: string; assignees: string[] }[];
  closedYesterday?: PersonalIssue[];

  updatedAt: string;
  /** repo keys available to filter by (from the full, unfiltered set) */
  repos: string[];
  /** labels present across open issues, for the label filter */
  labels: string[];
  /** milestones present, for the cycle filter */
  cycles: string[];
  filter: IssueMetricsQuery;
  totals: {
    /** all open issues (flow + steady-state) */
    open: number;
    /** open issues in flow — the "work in flight" headline */
    openFlow: number;
    /** open issues that are long-lived by design (AORs, OKR nodes, hypotheses) */
    steadyState: number;
    closed90: number;
    /** unassigned FLOW issues (steady-state ownership gaps are surfaced elsewhere) */
    unassigned: number;
  };
  /** 12 rolling 7-day windows, oldest → newest (last = the trailing 7 days) */
  weeks: WeekBucket[];
  /** The same throughput per viewer calendar day (#666, #684): DAY_SPAN days,
   *  oldest → newest, last cell = the day `updatedAt` falls in. The day grid
   *  reads this; `weeks` above is unchanged and still drives the trend chart. */
  days: DaySeries;
  /** Closes per viewer calendar day over the whole tracked history (#817), oldest →
   *  newest, ending on the same day `days` does. The calendar grid reads this;
   *  `days` above is unchanged and still drives the sparks beside it, on its own
   *  narrower axis (see DAY_SPAN).
   *
   *  Its LENGTH is what says how far back it reaches — the series reaches back to
   *  the first close in the FILTERED set, so cell 0 is the payload's own UTC day
   *  minus `closedDays.length - 1`. A start date shipped beside it would be a
   *  second definition of that same day, and this file's `days` has never needed
   *  one.
   *
   *  It never runs SHORTER than DAY_SPAN, so a scope whose first close is younger
   *  than fourteen weeks carries counted zeroes back to the floor rather than
   *  days nobody watched. `historySpan` carries that trade, its bound and the
   *  cap. */
  closedDays: number[];
  recent4: { opened: number; closed: number };
  /** trailing-7-day throughput per assignee, most closed first (active only) */
  byMember: MemberThroughput[];
  load: LoadRow[];
  ttc: {
    medianDays: number; p90Days: number; n: number;
    /** Arithmetic mean of elapsed days; null when no eligible closures exist. */
    meanDays: number | null;
    windowDays: number;
    /** False when any part of the issue scan could not be read. */
    readable: boolean;
    /** Same authorized population; null when the scan is incomplete. */
    comparison?: {
      startAt: string;
      endAt: string;
      previousStartAt: string;
      previousN: number;
      previousMeanDays: number | null;
      deltaDays: number | null;
      weekly: { startAt: string; endAt: string; n: number; meanDays: number | null }[];
      /** Rolling 90-day means from the prior comparison endpoint to the current one. */
      rolling?: { startAt: string; endAt: string; n: number; meanDays: number | null }[];
    } | null;
  };
  stale: StaleRow[];
  /** How many issues are aging in total (#478) — `stale` carries only the head of
   *  that set, so the block's header count reports this and doesn't shrink to the
   *  number of rows it happens to have been sent. Same predicate as the queue
   *  rows' `aging` flag; see `aging.ts`. */
  staleTotal: number;
  /** Open steady-state issues per long-lived label, desc — tracked, not flagged. */
  steadyByType: { label: string; count: number }[];
}
