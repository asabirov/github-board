// The repo page's derivations (#575/#582). Pure — no I/O, no clock: the caller
// passes what was read and `now`, and gets back what the page draws.
//
// Every weekly series here is bucketed by `slotOf` from the map's own rollup, so the
// issue weeks, the PR flow and the CI spend on one page are the SAME rolling
// 7-day windows, in the same count and the same alignment. There is no second
// weekly windowing scheme to keep in step with the first.

import { redactFeedbackTitles, type FeedbackScope } from '../auth/feedback-visibility';
import { REPO_WEEKS, repoJoinKey, repoJoinKeyOf, slotOf } from './repo-rollup';
import type {
  ActionsUsageDay,
  RepoCiSpend,
  RepoCompletedDayChange,
  RepoCiWindow,
  RepoMember,
  RepoMembers,
  RepoOwner,
  RepoPreviousPeriod,
  RepoPrFlow,
  RepoPrior,
  RepoPrRead,
  RepoPrWindow,
  RepoOpenIssue,
  UsageMonth,
} from './repo.types';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** How many open issues the payload carries (#828). Five until the Issues tab
 *  took over from the five-row Overview block: a tab that shows a repo's whole
 *  queue cannot be capped at what fitted under a chart. It is the payload's
 *  limit and not a claim about how many matter — a repo with more open issues
 *  than this is a repo whose tab is one page short, which the tab says by
 *  comparing this list against `repo.open`. */
export const OPEN_ISSUES_CAP = 100;

/** How many OPEN pull requests the payload carries (#828) — the same cap, for
 *  the same reason, on the tab beside it.
 *
 *  It must stay at or under Github's own maximum for one connection page (100),
 *  because the source asks for the list in ONE page of the query it already
 *  sends and does not paginate it: `PR_QUERY` in `github-repos.source.ts`. A
 *  larger number here would be a cap the read cannot fill. */
export const OPEN_PRS_CAP = 100;

/** The moment the trailing window opens. The PR read paginates back to it and
 *  the billing read covers the months it touches, so both are derived from one
 *  definition rather than each computing its own. */
export function windowStart(nowIso: string, weeks = REPO_WEEKS): number {
  return Date.parse(nowIso) - weeks * WEEK_MS;
}

/** The page's window and the one before it (#962): how far back the billing
 *  read has to reach for the CI card to say how its spend moved, and the age a
 *  repo needs before it has a previous period at all. */
export const COMPARED_WEEKS = 2 * REPO_WEEKS;

const emptyPrWeeks = (weeks: number): RepoPrWindow[] =>
  Array.from({ length: weeks }, () => ({ opened: 0, merged: 0 }));

/**
 * A PR read, bucketed into the page's windows.
 *
 * Two rules carry the whole of this function:
 *
 * - a PR is counted as OPENED in the window its `createdAt` falls in and as
 *   MERGED in the window its `mergedAt` falls in, independently. A PR opened
 *   last quarter and merged yesterday is one merge yesterday and nothing else,
 *   which is what actually happened.
 * - a window that starts before the read's reach is `null`, not a zeroed
 *   record. `coveredFrom` is the oldest moment the read can speak for; a busy
 *   repo exhausts the pagination cap well inside the window (measured: 100 PRs
 *   reaches a fortnight back on board), and drawing the rest as
 *   zero would report the org's busiest repo as having stopped.
 */
export function pullRequestWindows(read: RepoPrRead, nowIso: string, weeks = REPO_WEEKS): RepoPrFlow {
  if (read.state === 'unreadable') return { state: 'unreadable' };
  const now = Date.parse(nowIso);
  const series = emptyPrWeeks(weeks);
  for (const p of read.prs) {
    const created = Date.parse(p.createdAt);
    if (!Number.isNaN(created)) {
      const slot = slotOf(created, now, weeks);
      if (slot >= 0) series[slot].opened++;
    }
    if (p.mergedAt) {
      const merged = Date.parse(p.mergedAt);
      if (!Number.isNaN(merged)) {
        const slot = slotOf(merged, now, weeks);
        if (slot >= 0) series[slot].merged++;
      }
    }
  }
  // `coveredFrom: null` is the whole history, so nothing is unknown. Otherwise a
  // window counts only if it opened at or after the read's reach — a window the
  // read entered halfway through is a partial count, and a partial count wearing
  // the clothes of a full one is the failure this rule exists to prevent.
  const reach = read.coveredFrom == null ? -Infinity : Date.parse(read.coveredFrom);
  const windowOpensAt = (slot: number): number => now - (weeks - slot) * WEEK_MS;
  return {
    state: 'read',
    open: read.open,
    closedMerged: read.closedMerged,
    weeks: series.map((w, i) => (windowOpensAt(i) >= reach ? w : null)),
    // Carried through untouched (#828): the source read it already capped and
    // ordered, and this function's subject is the windows. It rides on the
    // `read` variant so the tab and the trend card cannot disagree about
    // whether Github answered.
    openPrs: read.openPrs,
  };
}

/**
 * One repo's Actions spend per window, off the org-wide daily usage report.
 *
 * `days` is every repo's usage — the report is read once for the whole org and
 * every page is served from that one answer — so this filters to `full` itself.
 * `null` means the report could not be read: the CI section goes quiet and the
 * rest of the page is untouched.
 *
 * Minutes are summed beside the dollars, and that pairing is the point (#582):
 * a window billed $0.00 is a window that ran nothing when its minutes are 0 and
 * a window the included allowance absorbed when they are not. Netting to zero is
 * the ordinary case in this org, not an edge one.
 */
export function ciSpendWindows(
  days: ActionsUsageDay[] | null,
  full: string,
  nowIso: string,
  weeks = REPO_WEEKS,
): RepoCiSpend {
  if (days == null) return { state: 'unreadable' };
  const now = Date.parse(nowIso);
  const series: RepoCiWindow[] = Array.from({ length: weeks }, () => ({ minutes: 0, netUsd: 0 }));
  const folded = full.toLowerCase();
  for (const d of days) {
    if (d.full.toLowerCase() !== folded) continue;
    const at = Date.parse(d.date);
    if (Number.isNaN(at)) continue;
    const slot = slotOf(at, now, weeks);
    if (slot < 0) continue;
    series[slot].minutes += d.minutes;
    series[slot].netUsd += d.netUsd;
  }
  // Money, summed from two-decimal rows: the float drift is invisible on a
  // dollar figure but not in a test, and a chart tooltip reading $8.680000000001
  // is a defect. Rounded once, at the end, so no window loses a cent on the way.
  for (const w of series) w.netUsd = Math.round(w.netUsd * 100) / 100;
  return { state: 'read', weeks: series };
}

/**
 * Every calendar month the span touches, oldest first — the months the billing
 * report has to be asked for to cover the page's window and the one before it
 * (#962).
 *
 * Those twenty weeks touch FIVE calendar months on 145 days of 2026 and SIX on
 * the other 220; the ten-week window alone touched three and four. Which is why
 * this counts the months rather than assuming a number: on the days an assumed
 * count falls short, the oldest windows are fetched from nothing, and a window
 * fetched from nothing draws as `minutes: 0`, which the page reads as "nothing
 * ran".
 *
 * `month` is 1-12, as the endpoint takes it. JavaScript's own 0-11 never leaves
 * this function.
 */
export function monthsSpanning(startMs: number, endMs: number): UsageMonth[] {
  const out: UsageMonth[] = [];
  const cursor = new Date(Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1));
  const end = Date.UTC(new Date(endMs).getUTCFullYear(), new Date(endMs).getUTCMonth(), 1);
  while (cursor.getTime() <= end) {
    out.push({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

/** Just the fields the page needs from an ingested issue — typed inline, the
 *  same way `FlowIssue` is, so this file stays free of the issues-metrics
 *  import.
 *
 *  This is the INGEST's shape, not the payload's: `state` stays here after #826
 *  took it off `RepoOpenIssue`, because the ingest carries every issue whatever
 *  its state and `openIssuesFor` is the thing that reads `state` to pick.
 *  `closedAt` stays too since #962: `openIssuesAt` winds the open count back to
 *  the start of the window with it. */
export interface PageIssue {
  /** the org this issue was read from, e.g. 'acme' */
  owner: string;
  /** short repo key, e.g. 'board' */
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
  state: 'open' | 'closed';
  createdAt: string;
  /** The issue's LAST close, or null. `RawIssue.closedAt`, unchanged. */
  closedAt: string | null;
  author: string | null;
  /** Github assignee logins, possibly empty (#828). A field the page stopped
   *  discarding rather than a new read: `RawIssue` has carried it since #120,
   *  and `membersFor` counts a repo's open assignments off it. */
  assignees: string[];
  labels: string[];
  /** True when `labels` is the issue's WHOLE set — `RawIssue.labelsComplete`,
   *  ridden unchanged into the words rule below and re-derived by nothing here
   *  (#836). */
  labelsComplete: boolean;
  /** True when this issue's body carries the feedback form's attribution footer
   *  — `RawIssue.submission`, and the marker that survives triage relabelling
   *  (#836). Two-valued here because the ingest this page reads always has the
   *  body; the third state lives at the index boundary, which this path does not
   *  cross. */
  submission: boolean;
}

/** This repo's open issues, newest first, off the shared org-wide ingest — no
 *  per-repo issue fetch for the page. `repo` is the map's own row, and the join
 *  runs through `repoJoinKeyOf`, the same owner-qualified key the rollup uses
 *  (#647) — a page keyed on the short key alone lists another org's same-named
 *  repo's issues under this one.
 *
 *  The `state` filter is the block's whole subject (#826). Recency and openness
 *  are different questions, and this block is asked the second one: it says what
 *  is left to do on the repo, and a closed row cannot answer that. Sorting by
 *  `createdAt` alone put six closed issues into board's own ten rows, so the
 *  block reported finished work as the repo's current business. */
export function openIssuesFor(
  issues: PageIssue[],
  repo: { full: string; key: string },
  scope: FeedbackScope,
  limit = OPEN_ISSUES_CAP,
): RepoOpenIssue[] {
  const join = repoJoinKeyOf(repo);
  const rows = issues
    .filter((i) => repoJoinKey(i.owner, i.repo) === join && i.state === 'open')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
  // The words rule, run at the SAME `undefined` viewer for everybody (#836).
  // This payload is built once per map build and held in a process-wide cache
  // keyed on that build alone, so whatever one reader is handed is what the next
  // reader gets; there is no viewer to key it on, and adding one would mean a
  // page per reader. `withheldFrom(undefined)` is the least-privileged reader,
  // which is the answer a shared page may safely be built for.
  //
  // It runs AFTER the slice, so it costs at most `limit` predicates rather than
  // one per issue in the org, and BEFORE the map, because `RepoOpenIssue` carries
  // neither `labelsComplete` nor `submission` — this payload is the end user's
  // sentence or it is not, and the facts that decide have to still be on the row.
  return redactFeedbackTitles(rows, undefined, scope).map((i) => ({
    number: i.number,
    title: i.title,
    htmlUrl: i.htmlUrl,
    createdAt: i.createdAt,
    author: i.author,
    labels: i.labels,
  }));
}

/** One person's running counts, before they are ordered and named. `login` is
 *  the spelling first seen; the map that holds these is keyed on the folded one,
 *  because Github logins are case-insensitive and `Octocat` opening an issue
 *  that `octocat` is assigned is one person, not two rows of one each. */
interface MemberTally {
  login: string;
  folded: string;
  assigned: number;
  openedIssues: number;
  openedPrs: number;
  dri: boolean;
}

/**
 * Who works on this repo (#828), off the reads the page already holds.
 *
 * Not a collaborator list. Measured 2026-09-03, GitHub's collaborators are the
 * same three logins on all 8 acme repos sampled, so an access list would
 * draw one identical answer on every repo page on this board. What varies — and
 * what somebody opening this tab is asking — is who has actually been doing
 * things here, and the issues and pull requests on the page already say.
 *
 * `assigned` counts OPEN issues only, because it is a question about now.
 * `openedIssues` and `openedPrs` count inside the page's window whatever
 * happened since, because they are questions about the last ten weeks and a
 * closed issue was still opened by somebody. A bot's pull request counts for
 * nobody — see the loop below.
 *
 * The join is owner-qualified through `repoJoinKeyOf`, exactly as
 * `openIssuesFor` is (#647): a page keyed on the short key alone counts another
 * org's same-named repo's people into this one.
 *
 * A person with all three counts at zero is not in the list — the list is who
 * works here, and a zero row says the opposite. That holds by construction
 * rather than by a filter: nobody is counted here except at the moment a count
 * goes up. The DRI is the one row added without one, and is present at zero,
 * because an owner nobody can see on the page they own is the fact this tab
 * most obviously owes.
 */
export function membersFor(
  issues: PageIssue[],
  prs: RepoPrRead,
  repo: { full: string; key: string; owner: RepoOwner | null },
  names: Map<string, string>,
  nowIso: string,
): RepoMembers {
  const join = repoJoinKeyOf(repo);
  const opensAt = windowStart(nowIso);
  const tallies = new Map<string, MemberTally>();
  const inWindow = (iso: string): boolean => {
    const t = Date.parse(iso);
    return !Number.isNaN(t) && t >= opensAt;
  };
  const tally = (login: string | null): MemberTally | null => {
    if (!login) return null;
    const folded = login.toLowerCase();
    const held = tallies.get(folded);
    if (held) return held;
    const fresh: MemberTally = { login, folded, assigned: 0, openedIssues: 0, openedPrs: 0, dri: false };
    tallies.set(folded, fresh);
    return fresh;
  };
  // Seeded first so the DRI's row exists whatever the counts say, and so the
  // spelling the org RECORDS is the one displayed for them rather than whichever
  // issue happens to be read first.
  const owner = tally(repo.owner?.login ?? null);
  if (owner) owner.dri = true;
  for (const i of issues) {
    if (repoJoinKey(i.owner, i.repo) !== join) continue;
    if (inWindow(i.createdAt)) {
      const author = tally(i.author);
      if (author) author.openedIssues++;
    }
    if (i.state !== 'open') continue;
    for (const login of i.assignees) {
      const assignee = tally(login);
      if (assignee) assignee.assigned++;
    }
  }
  // The RECORDS, not `openPrs`: a PR opened inside the window and merged since
  // is still work this person did, and the open list cannot see it. The records
  // reach back to the window's start (`RepoPrRead.coveredFrom` says where the
  // pagination cap stopped instead), which is the same span the issue counts
  // above use.
  //
  // A bot's pull request is not somebody's work and is skipped. It has to be:
  // measured on acme/board on 2026-09-03, dependabot opened 8
  // of the last 100 PRs and all 8 that are open, which put it SECOND on this
  // repo's own tab, above a teammate. The PRs tab still lists them — they are
  // open pull requests somebody has to close — and `RepoOpenPr.authorIsBot`
  // marks them there.
  //
  // Issue authors are NOT gated the same way, and that is a gap rather than a
  // finding: the ingest carries no author type, so there is nothing here to read
  // one off. What was measured is that board's last 100 issue authors are all
  // `User`, which is a fact about today and not a guarantee the code enforces.
  if (prs.state === 'read') {
    for (const p of prs.prs) {
      if (p.authorIsBot) continue;
      if (!inWindow(p.createdAt)) continue;
      const author = tally(p.author);
      if (author) author.openedPrs++;
    }
  }
  const total = (m: MemberTally): number => m.assigned + m.openedIssues + m.openedPrs;
  // Every tally above is opened by an increment, so a person with all three
  // counts at zero is never in this map to begin with and there is nothing to
  // filter out. The DRI is the one row added without a count, and the one that
  // has to stay. A `filter` here would read as the rule and could never fire.
  const people: RepoMember[] = [...tallies.values()]
    // Total, so a spec can pin it and two people who did the same amount do not
    // swap places between two reads of the same data: the DRI first, then the
    // busiest, then alphabetically by the folded login — which is unique here,
    // because the map is keyed on it.
    .sort((a, b) => Number(b.dri) - Number(a.dri) || total(b) - total(a) || a.folded.localeCompare(b.folded))
    .map((m) => ({
      login: m.login,
      name: names.get(m.folded) ?? null,
      assigned: m.assigned,
      openedIssues: m.openedIssues,
      openedPrs: m.openedPrs,
      dri: m.dri,
    }));
  // Not an empty list, and not a zero (#718's rule, applied to this tab): a PR
  // read that failed leaves `openedPrs` at 0 for everybody and drops anybody
  // active only in pull requests out of the list altogether. Both look exactly
  // like a repo where nobody sends PRs.
  return { people, prsUnreadable: prs.state === 'unreadable' };
}

const UNKNOWN: RepoPrior = { state: 'unknown' };
const NONE: RepoPrior = { state: 'none' };

/**
 * How many of this repo's issues were open at `at` (#962), off the same ingest
 * the row's own open count is rolled up from — so the two numbers a comparison
 * subtracts are two readings of one list, not two reads that disagree.
 *
 * Open at `at` is created before it and not closed before it. `closedAt` is an
 * issue's LAST close and the ingest keeps no history, so an issue closed before
 * `at` and reopened since counts as open then. That is off by one per reopen,
 * and there is nothing in the ingest to do better with.
 */
export function openIssuesAt(issues: PageIssue[], repo: { full: string; key: string }, at: number): number {
  const join = repoJoinKeyOf(repo);
  let open = 0;
  for (const i of issues) {
    if (repoJoinKey(i.owner, i.repo) !== join) continue;
    if (!(Date.parse(i.createdAt) < at)) continue;
    if (i.state === 'open' || (i.closedAt != null && Date.parse(i.closedAt) >= at)) open++;
  }
  return open;
}

/**
 * How many pull requests were open at `at` (#962), wound back from the true
 * total rather than counted.
 *
 * Counting is not possible: `open` is Github's `totalCount` and the records stop
 * at the window, so a PR opened last year and still open is in the total and in
 * no record. Winding back needs only what moved after `at` — each PR opened
 * since was not open then, each PR closed since was — and the UPDATED_AT walk
 * holds every one of those, because a PR's `updatedAt` is never earlier than its
 * creation or its close. No upper bound on either count: `open` was read after
 * the map's clock, and a PR opened in between is in it.
 *
 * Unknown where it cannot be exact: the read failed, or its page cap stopped
 * short of `at`, which is the same reach the chart draws as unread weeks. A
 * negative answer is a reopen the records cannot see, and is unknown too rather
 * than clamped to a zero nobody measured.
 */
export function openPrsAt(read: RepoPrRead, at: number): RepoPrior {
  if (read.state === 'unreadable') return UNKNOWN;
  if (read.coveredFrom != null && !(Date.parse(read.coveredFrom) <= at)) return UNKNOWN;
  let opened = 0;
  let closed = 0;
  for (const p of read.prs) {
    if (Date.parse(p.createdAt) >= at) opened++;
    const shut = p.closedAt ?? p.mergedAt;
    if (shut != null && Date.parse(shut) >= at) closed++;
  }
  const value = read.open - opened + closed;
  return value < 0 ? UNKNOWN : { state: 'read', value };
}

/**
 * The three Overview figures one period back (#962).
 *
 * The previous period is the REPO_WEEKS before the window. A repo created after
 * it opened has none, and says so as `none`; a repo whose creation Github did
 * not report is `unknown`. Neither is computed, because the weeks before a repo
 * existed read as zero, and a comparison against them reports the repo's whole
 * history as growth.
 *
 * `spend` is the billing series over COMPARED_WEEKS, and its earlier half is the
 * previous period. `issuesRead` is the page's `openIssuesState`: an ingest that
 * failed for this repo contributed no rows, and a count off no rows is a zero.
 */
export function previousPeriod(
  issues: PageIssue[],
  repo: { full: string; key: string; createdAt: string | null },
  prs: RepoPrRead,
  spend: RepoCiSpend,
  nowIso: string,
  issuesRead: boolean,
): RepoPreviousPeriod {
  const created = repo.createdAt == null ? NaN : Date.parse(repo.createdAt);
  if (Number.isNaN(created)) return { openIssues: UNKNOWN, openPrs: UNKNOWN, ciNetUsd: UNKNOWN };
  if (created > windowStart(nowIso, COMPARED_WEEKS)) return { openIssues: NONE, openPrs: NONE, ciNetUsd: NONE };
  const opensAt = windowStart(nowIso);
  const before = spend.state === 'read' && spend.weeks.length === COMPARED_WEEKS ? spend.weeks.slice(0, REPO_WEEKS) : null;
  return {
    openIssues: issuesRead ? { state: 'read', value: openIssuesAt(issues, repo, opensAt) } : UNKNOWN,
    openPrs: openPrsAt(prs, opensAt),
    // Rounded once, at the end, for the reason `ciSpendWindows` gives.
    ciNetUsd: before
      ? { state: 'read', value: Math.round(before.reduce((n, w) => n + w.netUsd, 0) * 100) / 100 }
      : UNKNOWN,
  };
}

/** Endpoint shared by daily comparisons and their snapshot coverage checks. */
export function completedDayEnd(nowIso: string): number {
  const now = new Date(nowIso);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** Day-over-day figures from the same reads as the weekly figures. */
export function completedDayChange(
  issues: PageIssue[],
  repo: { full: string; key: string; createdAt: string | null },
  prs: RepoPrRead,
  days: ActionsUsageDay[] | null,
  nowIso: string,
  issuesRead: boolean,
): RepoCompletedDayChange {
  // Compare the two latest completed UTC days before the map build's UTC midnight,
  // excluding partial days so billing periods have equal lengths.
  const end = completedDayEnd(nowIso);
  const start = end - DAY_MS;
  const previousStart = start - DAY_MS;
  const dates = {
    day: new Date(start).toISOString().slice(0, 10),
    previousDay: new Date(previousStart).toISOString().slice(0, 10),
  };
  const created = repo.createdAt == null ? NaN : Date.parse(repo.createdAt);
  if (Number.isNaN(created)) return { ...dates, openIssues: UNKNOWN, openPrs: UNKNOWN, ciNetUsd: UNKNOWN };
  if (created > start) return { ...dates, openIssues: NONE, openPrs: NONE, ciNetUsd: NONE };

  const before = openPrsAt(prs, start);
  const after = openPrsAt(prs, end);
  // A successful org report does not prove that a missing repo/day row is zero.
  // Require a row in each day; explicit zero-dollar usage remains measurable.
  const spend = (from: number, to: number): number | null => {
    const rows = days?.filter((d) => d.full.toLowerCase() === repo.full.toLowerCase()
      && Date.parse(d.date) >= from && Date.parse(d.date) < to);
    return rows?.length ? rows.reduce((sum, d) => sum + d.netUsd, 0) : null;
  };
  const previousSpend = spend(previousStart, start);
  const currentSpend = spend(start, end);
  return {
    ...dates,
    openIssues: issuesRead
      ? { state: 'read', value: openIssuesAt(issues, repo, end) - openIssuesAt(issues, repo, start) }
      : UNKNOWN,
    openPrs: before.state === 'read' && after.state === 'read'
      ? { state: 'read', value: after.value - before.value }
      : UNKNOWN,
    ciNetUsd: created > previousStart ? NONE
      : previousSpend != null && currentSpend != null
        ? { state: 'read', value: Math.round((currentSpend - previousSpend) * 100) / 100 }
        : UNKNOWN,
  };
}
