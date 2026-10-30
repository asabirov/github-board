// Pure personal-queue computation (#206). No I/O, no clock — the caller passes
// the cached raw issue list, the resolved GitHub login, and the reference time.
// Serves the "Your work" home: the signed-in user's OPEN issues (typed, aged,
// blocked-flagged) plus their trailing-7-day throughput, attributed by assignee
// exactly like computeMetrics' byMember so the two surfaces never disagree.

import type { ProjectMembership } from '../projects/project.types';

import { countByDay, historySpan } from '../time/day-span';
import { deliveredCloseAt } from './close-reason';
import { isAging } from './aging';
import { earliestClosedMs, seriesByDay } from './day-buckets';
import { deriveType } from './issue-type';
import {
  DaySeries,
  OrgQueue,
  PersonalIssue,
  PersonalIssues,
  ProjectContribution,
  RawIssue,
  WeekBucket,
} from './issues-metrics.types';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
// Sparkline width for the Closed/Opened cards (#254) — enough points to read a
// trend without crowding a stat tile. Matches computeMetrics' windowing.
const WEEKS = 10;

/**
 * The single window that governs the "Project contributions" block (#380): a
 * close inside the trailing CONTRIB_WINDOW_DAYS counts as "Moving this week",
 * and — inversely — a board you still have open work on but have closed nothing
 * on in this many days has "slipped". One constant drives both sides so the two
 * groups can never overlap or leave a gap: closed7d === 0 means, by definition,
 * no close in the window, i.e. your last close (if any) is at least this old.
 */
export const CONTRIB_WINDOW_DAYS = 7;

/** A `blocked` or `blocker` label — GitHub uses both conventions; the fixture
 *  uses `blocker`, most repos use `blocked`. Either lights the queue's red dot. */
function isBlocked(labels: string[]): boolean {
  return labels.some((l) => {
    const n = l.toLowerCase();
    return n === 'blocked' || n === 'blocker';
  });
}

/** Shape one raw issue into a stackable queue row. `login` marks whether it's
 *  assigned to the viewer (null on the org queue, which has no "me"); `longLived`
 *  is the configured LONG_LIVED_LABELS set, which the row's `aging` flag needs
 *  because steady-state work is never aging (#478). */
export function shapeQueueIssue(
  i: RawIssue,
  login: string | null,
  now: number,
  projectsOf: (htmlUrl: string) => string[],
  longLived: Set<string>,
): PersonalIssue {
  return {
    owner: i.owner,
    repo: i.repo,
    number: i.number,
    title: i.title,
    htmlUrl: i.htmlUrl,
    createdAt: i.createdAt,
    ageDays: Math.round((now - Date.parse(i.createdAt)) / DAY_MS),
    labels: i.labels,
    type: deriveType(i.labels),
    blocked: isBlocked(i.labels),
    aging: isAging(i, now, longLived),
    assignedToMe: login != null && i.assignees.includes(login),
    assignees: i.assignees,
    author: i.author,
    projects: projectsOf(i.htmlUrl),
    state: i.state,
    closedAt: i.closedAt,
    // Carried, not applied: this row is a LIST entry, and the viewer's own
    // closed-week filter is what reads it (#1014).
    stateReason: i.stateReason,
  };
}

/** Blocked to the top, then oldest first — the queue leads with what's been
 *  waiting longest. The frontend regroups by type/project; this is the stable
 *  within-group order. */
const byBlockedThenAge = (a: PersonalIssue, b: PersonalIssue): number =>
  Number(b.blocked) - Number(a.blocked) || b.ageDays - a.ageDays;

export function computePersonalIssues(
  all: RawIssue[],
  login: string | null,
  nowIso: string,
  // Names of the GitHub Project(s) an issue is on, by its html URL. Injected so
  // the VM stays pure/testable; defaults to "on no board".
  projectsOf: (htmlUrl: string) => string[] = () => [],
  // LONG_LIVED_LABELS, for each row's `aging` flag (#478). Default empty → every
  // issue is flow work, which is what the pre-#478 callers already assumed.
  longLived: Set<string> = new Set(),
  timeZone = 'UTC',
): PersonalIssues {
  const now = Date.parse(nowIso);
  // No mapped login → the caller has no GitHub identity we can attribute work
  // to. Answer honestly with an empty queue rather than guessing.
  if (!login) {
    return {
      computedAt: nowIso,
      timeZone,
      updatedAt: nowIso,
      login: null,
      issues: [],
      throughput: { opened: 0, closed: 0 },
      throughputWeeks: [],
      throughputDays: { opened: [], closed: [], exited: [] },
      closedDays: [],
      recentlyClosed: [],
    };
  }

  const assignedToMe = (i: RawIssue): boolean => i.assignees.includes(login);
  // Throughput mirrors computeMetrics' byMember — attributed strictly by assignee.
  const mine = all.filter(assignedToMe);

  // #285: Your queue is strictly issues assigned to you — the earlier "or
  // unassigned, up for grabs" inclusion (#231) was reversed, since an unclaimed
  // org issue isn't your work. The whole-org open list lives on Unit (#284).
  const issues: PersonalIssue[] = all
    .filter((i) => i.state === 'open' && assignedToMe(i))
    .map((i) => shapeQueueIssue(i, login, now, projectsOf, longLived))
    .sort(byBlockedThenAge);

  // Throughput as rolling 7-day windows, attributed to this login — mirrors
  // computeMetrics' windowing. The last window is the trailing 7 days ([now-7d,
  // now)), so the headline `throughput` is just its last entry and can never
  // disagree with the sparkline's last point (#254).
  const throughputWeeks: WeekBucket[] = Array.from({ length: WEEKS }, (_, w) => {
    const end = now - (WEEKS - 1 - w) * WEEK_MS;
    const start = end - WEEK_MS;
    let opened = 0;
    let closed = 0;
    for (const i of mine) {
      const createdMs = Date.parse(i.createdAt);
      if (createdMs >= start && createdMs < end) opened++;
      // Delivery only (#1014) — this is the figure the "Closed this week" tile
      // states, and `recentlyClosed` below is the list behind it, so the two are
      // gated the same way or the drill-in names rows the tile does not count.
      const at = deliveredCloseAt(i);
      if (at) {
        const closedMs = Date.parse(at);
        if (closedMs >= start && closedMs < end) closed++;
      }
    }
    return { opened, closed };
  });
  const throughput = throughputWeeks[WEEKS - 1];

  // The same work at day resolution (#666, #684) — beside the weekly windows,
  // never instead of them. Calendar days, so the last cell is the day `now`
  // falls in; see day-buckets.ts for why that is UTC.
  const throughputDays: DaySeries = seriesByDay(mine, now, undefined, timeZone);
  // The same closes at a year's reach (#817) — the calendar grid draws a whole
  // year, which the span above cannot hold.
  //
  // SIZED OFF `all` AND NOT OFF `mine`, which is the difference between a day
  // nobody watched and a day this person closed nothing on. `mine` is this
  // login's own issues, so its first close is the day THEY started closing
  // things; every day before that is one the board was watching perfectly well
  // and on which they happened to close nothing. Sized off `mine`, the frontend
  // draws those days as unobserved — blank, "nobody was counting" — while the
  // same person's row on Overview draws them as the counted zeroes they are,
  // because `byMember` is sized off the org's whole filtered set. One person,
  // two surfaces, two different claims about the same days.
  //
  // `all` is the set this vm was handed, so the window now reaches as far back as
  // the mirror does, which is the honest meaning of "we were watching". It is the
  // same rule `computeMetrics` applies, and the two routes agree by construction
  // rather than by a comment asking them to.
  const closedSpan = historySpan(earliestClosedMs(all), now, timeZone);
  const closedDays: number[] = countByDay(mine, deliveredCloseAt, now, closedSpan, timeZone);

  // #407: issues I closed in the trailing 7 days — a SEPARATE field, never merged
  // into the open `issues` queue above (which stays strictly open). Most-recently
  // closed first. Runs off the same cached raw list, so no extra GitHub call.
  const windowStart = now - WEEK_MS;
  const recentlyClosed: PersonalIssue[] = all
    .filter((i) => {
      // The list behind `throughput.closed`, gated by the same predicate (#1014).
      const at = deliveredCloseAt(i);
      return i.state === 'closed' && assignedToMe(i) && at != null && Date.parse(at) >= windowStart && Date.parse(at) < now;
    })
    .map((i) => shapeQueueIssue(i, login, now, projectsOf, longLived))
    .sort((a, b) => Date.parse(b.closedAt ?? '') - Date.parse(a.closedAt ?? ''));

  return { computedAt: nowIso, timeZone, updatedAt: nowIso, login, issues, throughput, throughputWeeks, throughputDays, closedDays, recentlyClosed };
}

/**
 * The caller's GitHub Projects with recent contribution (#380) — the data behind
 * the "Project contributions" memory block on Your work. Pure: the caller passes
 * the cached raw issue list, the resolved login, `now`, and the per-board issue-URL
 * index (the same `ProjectMembership[]` the queue's project join rides). Scoped
 * strictly to the caller — only issues *assigned to them* count, mirroring how
 * throughput is attributed — so the block answers "which of MY boards have I moved
 * lately", not the board's overall activity.
 *
 * A board lands on the caller's radar when they either moved it this week
 * (`closed7d >= 1`) or still carry open work on it (`openAssigned >= 1`). Boards
 * they finished with — nothing open, nothing closed this week — drop off. Within
 * that set, `slipping` marks a board with open work but zero closes in the window.
 *
 * Ordered most-moved first, then most-recently-closed: the frontend splits the
 * rows into the "Moving this week" / "Slipping" groups, and this order holds
 * inside each.
 */
export function computeProjectContributions(
  all: RawIssue[],
  login: string | null,
  nowIso: string,
  // `ProjectMembership` itself, not a restatement of it. The inline copy that
  // stood here was written to keep this pure VM free of the projects module's
  // import — a type-only import costs nothing at runtime, and the copy is
  // precisely why #697 could add `org` to the real type without the compiler
  // noticing this builder had not.
  memberships: ProjectMembership[],
): ProjectContribution[] {
  if (!login) return [];
  const now = Date.parse(nowIso);
  const windowStart = now - CONTRIB_WINDOW_DAYS * DAY_MS;

  // Join on issue URL — the same key the queue's project index uses.
  const byUrl = new Map<string, RawIssue>();
  for (const i of all) byUrl.set(i.htmlUrl, i);

  const rows: ProjectContribution[] = [];
  for (const m of memberships) {
    let closed7d = 0;
    let openAssigned = 0;
    let lastClosedMs: number | null = null;
    for (const url of m.issueUrls) {
      const issue = byUrl.get(url);
      if (!issue || !issue.assignees.includes(login)) continue; // only MY work here
      if (issue.state === 'open') openAssigned++;
      // `slipping` INVERTS on this (#1014): a member whose only close on a board
      // this week was abandoned has not moved it, and the block exists to say so.
      const at = deliveredCloseAt(issue);
      if (at) {
        const t = Date.parse(at);
        if (Number.isNaN(t)) continue;
        if (lastClosedMs == null || t > lastClosedMs) lastClosedMs = t;
        if (t >= windowStart && t < now) closed7d++;
      }
    }
    // On the radar only if I moved it this week or still carry open work there.
    if (closed7d === 0 && openAssigned === 0) continue;
    rows.push({
      // The org the board was read from, carried through so a row addresses one
      // board rather than one per org (#697).
      org: m.org,
      number: m.number,
      name: m.name,
      closed7d,
      openAssigned,
      lastClosedAtISO: lastClosedMs == null ? null : new Date(lastClosedMs).toISOString(),
      slipping: closed7d === 0 && openAssigned > 0,
    });
  }

  const recency = (r: ProjectContribution) => (r.lastClosedAtISO ? Date.parse(r.lastClosedAtISO) : 0);
  rows.sort((a, b) => b.closed7d - a.closed7d || recency(b) - recency(a) || a.name.localeCompare(b.name));
  return rows;
}

/**
 * The whole unit's open queue (#284) — every open org issue shaped like the
 * personal queue so the Unit page renders the SAME stacked component, just at
 * org scope instead of one assignee's. No login (there's no "me" here), no
 * throughput — this is a shared work board, not a personal cockpit. Runs off the
 * same cached raw list as the personal queue.
 */
export function computeOrgQueue(
  all: RawIssue[],
  nowIso: string,
  projectsOf: (htmlUrl: string) => string[] = () => [],
  // LONG_LIVED_LABELS, for each row's `aging` flag (#478) — see computePersonalIssues.
  longLived: Set<string> = new Set(),
): OrgQueue {
  const now = Date.parse(nowIso);
  const issues = all
    .filter((i) => i.state === 'open')
    .map((i) => shapeQueueIssue(i, null, now, projectsOf, longLived))
    .sort(byBlockedThenAge);
  return { updatedAt: nowIso, issues };
}
