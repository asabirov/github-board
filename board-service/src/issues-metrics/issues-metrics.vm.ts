// Pure issue-flow metrics computation (#120). No I/O, no clock — the caller
// passes the issue list, the reference time, the filter, and a login→name
// resolver. Everything the surface renders is derived here so it can be unit
// tested against fixtures without GitHub.

import { calendarDay, countByDay, historySpan } from '../time/day-span';
import { shapeQueueIssue } from './personal-issues.vm';
import { isAging } from './aging';
import { DELIVERED_CLOSE_QUALIFIER, deliveredCloseAt } from './close-reason';
import { earliestClosedMs, seriesByDay } from './day-buckets';
import {
  DaySeries,
  IssueMetrics,
  IssueMetricsQuery,
  LoadRow,
  RawIssue,
  SearchIssue,
  StaleRow,
  WeekBucket,
} from './issues-metrics.types';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const WEEKS = 12;
const RECENT_WEEKS = 4;
const TTC_WINDOW_DAYS = 90;
// How many aging rows the response carries. The Oldest-open block shows three
// and expands to at most `EXPANDED_ROWS` (board-frontend/src/dashboard/
// OldestOpen.tsx), so anything past that would be paid for and never rendered.
// The size of the WHOLE aging set travels separately as `staleTotal`, and the
// rest of it is reached through the queue's Aging filter — see aging.ts.
const STALE_N = 10;

/**
 * Lean open-issue index for the ⌘K palette (#214). Open issues only (the palette
 * is for jumping to live work); owner/repo carry the route to the in-board issue
 * page (#235) with no extra lookup.
 *
 * `owner` is read off the issue (#650) rather than re-parsed out of the URL,
 * which is where it used to come from — `RawIssue.owner` did not exist when this
 * was written, and two derivations of one fact can disagree.
 *
 * The URL parse stays for `repo`, and only for `repo`. `SearchIssue.repo` is a
 * route segment that has to be the repo's real Github name, while `RawIssue.repo`
 * is by its own docblock a short DISPLAY key — so the two are not the same string
 * and `i.repo` cannot stand in here. An issue whose URL doesn't parse is still
 * dropped rather than routed to a broken page.
 */
export function toSearchIndex(all: RawIssue[]): SearchIssue[] {
  const out: SearchIssue[] = [];
  for (const i of all) {
    if (i.state !== 'open') continue;
    const m = i.htmlUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\//);
    if (!m) continue;
    out.push({ owner: i.owner, repo: m[2], number: i.number, title: i.title });
  }
  return out;
}

function matches(i: RawIssue, q: IssueMetricsQuery): boolean {
  if (q.repo && q.repo !== 'all' && i.repo !== q.repo) return false;
  if (q.label && !i.labels.includes(q.label)) return false;
  if (q.cycle && i.milestone !== q.cycle) return false;
  return true;
}

// Nearest-rank percentile on an ascending array; 0 for an empty set.
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * (sortedAsc.length - 1)));
  return sortedAsc[idx];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** The org the tracked issues live under, taken as the most common owner across
 *  their html URLs (the board mirrors one org; a stray cross-org URL can't skew
 *  it). Null when nothing parses — callers then skip building Github links. */
function dominantOwner(all: RawIssue[]): string | null {
  const counts = new Map<string, number>();
  for (const i of all) {
    const m = i.htmlUrl.match(/^https:\/\/github\.com\/([^/]+)\//);
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [owner, n] of counts) if (n > bestN) { best = owner; bestN = n; }
  return best;
}

/** A Github issue-search deep-link for one assignee within the org (#303) —
 *  same `org:… is:issue` shape as the Issues-band tiles, so the drill-in matches
 *  the count it sits behind. `clause` is the date filter (`closed:>=…` etc.). */
function memberSearchHref(org: string, login: string, clause: string): string {
  const q = `org:${org} is:issue assignee:${login} ${clause}`;
  return `https://github.com/search?q=${encodeURIComponent(q)}&type=issues`;
}

export function computeMetrics(
  all: RawIssue[],
  nowIso: string,
  query: IssueMetricsQuery,
  loginToName: (login: string) => string,
  longLived: Set<string> = new Set(),
  // The team roster (GitHub logins). Seeded into the throughput map so every
  // teammate shows on the pulse even with a quiet week (0/0), rather than
  // silently vanishing when they had no assigned issues in the tracked repos.
  roster: string[] = [],
): IssueMetrics {
  const now = Date.parse(nowIso);
  const timeZone = query.timeZone ?? 'UTC';
  const issues = all.filter((i) => matches(i, query));
  const open = issues.filter((i) => i.state === 'open');

  // Steady-state issues (AORs, OKR-tree nodes, hypotheses, …) are long-lived BY
  // DESIGN — measuring them by raw issue age is the wrong lens. They're kept out
  // of the flow "problem" views (aging, per-person load, the open headline) and
  // tracked as their own typed category instead. A hypothesis, e.g., is tracked
  // by its stage + decision deadline, not by how long its issue has been open.
  const isSteady = (i: RawIssue) => i.labels.some((l) => longLived.has(l));
  const openFlow = open.filter((i) => !isSteady(i));
  const openSteady = open.filter(isSteady);

  // ── throughput: 12 rolling 7-day windows ending at `now` ──────────────────
  const weeks: WeekBucket[] = Array.from({ length: WEEKS }, (_, w) => {
    // w=0 is the oldest window; the last entry is the trailing 7 days.
    const end = now - (WEEKS - 1 - w) * WEEK_MS;
    const start = end - WEEK_MS;
    let opened = 0;
    let closed = 0;
    for (const i of issues) {
      const c = Date.parse(i.createdAt);
      if (c >= start && c < end) opened++;
      // The DELIVERED close, so an issue abandoned as not planned is opened
      // here and never closed (#1014) — which is the honest reading of a week
      // in which somebody took work on and then dropped it.
      const at = deliveredCloseAt(i);
      if (at) {
        const cl = Date.parse(at);
        if (cl >= start && cl < end) closed++;
      }
    }
    return { opened, closed };
  });
  // ── the same throughput per CALENDAR day (#666, #684) ─────────────────────
  // Beside `weeks`, not instead of it: a rolling window ending at `now` cannot
  // say which DAY a close happened on, which is what the day grid asks.
  const days: DaySeries = seriesByDay(issues, now, undefined, timeZone);
  // ── the same closes, back as far as the data goes (#817) ──────────────────
  // The calendar grid draws a whole year, which the 98-day span above cannot
  // hold. Sized ONCE here, off the filtered set, and reused for every byMember
  // row below: one x-axis for the whole payload, so two rows of the same grid
  // can be read against each other.
  const closedSpan = historySpan(earliestClosedMs(issues), now, timeZone);
  const closedDays: number[] = countByDay(issues, deliveredCloseAt, now, closedSpan, timeZone);

  const recentSlice = weeks.slice(WEEKS - RECENT_WEEKS);
  const recent4 = {
    opened: recentSlice.reduce((s, w) => s + w.opened, 0),
    closed: recentSlice.reduce((s, w) => s + w.closed, 0),
  };

  // ── per-member throughput over the trailing 7 days (assignee-attributed) ────
  // The team-pulse roster: who shipped (closed) and took on (opened) work this
  // week. Attributed by assignee — an issue counts once per assignee it carries;
  // unassigned issues land in neither bucket (surfaced by the Unassigned tile).
  const weekStart = now - WEEK_MS;
  // Github logins are case-insensitive, and the two sides of this join arrive
  // from different places: the seed list is our own roster, while the increments
  // carry whatever spelling Github returned on the issue. Keyed raw, a roster
  // entry `IvanRoslov` and an assignee `ivanroslov` split one person into two
  // rows — one stuck at 0/0, the other holding all their work, with nothing
  // saying they are the same person. So key on the folded login, and keep the
  // first spelling seen (the roster's, since it seeds first) for display and for
  // the search links, which Github resolves case-insensitively anyway.
  const displayLogin = new Map<string, string>();
  const canonical = (login: string): string => {
    const key = login.toLowerCase();
    if (!displayLogin.has(key)) displayLogin.set(key, login);
    return key;
  };
  const member = new Map<string, { opened: number; closed: number }>();
  // Seed the roster first so a teammate with a quiet week still appears at 0/0.
  for (const login of roster) member.set(canonical(login), { opened: 0, closed: 0 });
  const bump = (login: string, key: 'opened' | 'closed') => {
    const id = canonical(login);
    const m = member.get(id) ?? { opened: 0, closed: 0 };
    m[key]++;
    member.set(id, m);
  };
  for (const i of issues) {
    if (i.assignees.length === 0) continue;
    const createdMs = Date.parse(i.createdAt);
    const openedInWeek = createdMs >= weekStart && createdMs < now;
    // "Who shipped this week" is the claim #1014 corrects most directly: an
    // abandoned issue was somebody's close on this pulse.
    const deliveredAt = deliveredCloseAt(i);
    const closedMs = deliveredAt ? Date.parse(deliveredAt) : NaN;
    const closedInWeek = !Number.isNaN(closedMs) && closedMs >= weekStart && closedMs < now;
    if (!openedInWeek && !closedInWeek) continue;
    for (const login of i.assignees) {
      if (openedInWeek) bump(login, 'opened');
      if (closedInWeek) bump(login, 'closed');
    }
  }
  // Github deep-links behind each count (#303). The window is [weekStart, now);
  // Github search is date-granular, so we bound from the window's start date —
  // the same convention the personal cockpit tiles already use. Derived from the
  // full (unfiltered) list so the org is stable regardless of the active filter.
  const org = dominantOwner(all);
  const sinceDate = new Date(weekStart).toISOString().slice(0, 10);

  // Per-member 12-week series (#336) — the same rolling windows as `weeks[]`
  // above, attributed by assignee, so the dashboard can filter the trend chart to
  // one member. Each week counted independently of the trailing-7d totals above.
  const emptyWeeks = (): WeekBucket[] => Array.from({ length: WEEKS }, () => ({ opened: 0, closed: 0 }));
  const memberWeeks = new Map<string, WeekBucket[]>();
  for (const login of roster) memberWeeks.set(canonical(login), emptyWeeks());
  for (const i of issues) {
    if (i.assignees.length === 0) continue;
    const c = Date.parse(i.createdAt);
    const delivered = deliveredCloseAt(i);
    const cl = delivered ? Date.parse(delivered) : NaN;
    for (let w = 0; w < WEEKS; w++) {
      const end = now - (WEEKS - 1 - w) * WEEK_MS;
      const start = end - WEEK_MS;
      const openedIn = c >= start && c < end;
      const closedIn = !Number.isNaN(cl) && cl >= start && cl < end;
      if (!openedIn && !closedIn) continue;
      for (const login of i.assignees) {
        const id = canonical(login);
        const wk = memberWeeks.get(id) ?? emptyWeeks();
        if (openedIn) wk[w].opened++;
        if (closedIn) wk[w].closed++;
        memberWeeks.set(id, wk);
      }
    }
  }

  // Per-member calendar-day series (#666, #684) — the same days as the org
  // `days` above, attributed by assignee, so one member's grid can be drawn
  // without a second request. Group by assignee once, then run each group
  // through the SAME seriesByDay/countByDay the org series uses: one
  // implementation of the day bucketing, on one span, so a member's row and the
  // org's row are index-for-index the same days. A member's own first close does
  // NOT shorten their row — the span is the org's. Seeded from the roster so a
  // teammate with a quiet quarter still gets a full span of zeroes rather than
  // no grid.
  const memberIssues = new Map<string, RawIssue[]>();
  for (const login of roster) memberIssues.set(canonical(login), []);
  for (const i of issues) {
    for (const login of i.assignees) {
      const id = canonical(login);
      const list = memberIssues.get(id);
      if (list) list.push(i);
      else memberIssues.set(id, [i]);
    }
  }

  const byMember = [...member.entries()]
    .map(([id, m]) => {
      // Report the spelling a human would recognise, not the folded key.
      const login = displayLogin.get(id) ?? id;
      return {
        login,
        name: loginToName(login),
        opened: m.opened,
        closed: m.closed,
        // The qualifier is what keeps the LINK and the number agreeing (#1014).
        // Without it this search returns every close, including the abandoned
        // ones the count beside it no longer holds — and this field exists so a
        // number can be validated against the actual issues it stands for.
        closedHref: org ? memberSearchHref(org, login, `closed:>=${sinceDate} ${DELIVERED_CLOSE_QUALIFIER}`) : null,
        openedHref: org ? memberSearchHref(org, login, `created:>=${sinceDate}`) : null,
        weeks: memberWeeks.get(id) ?? emptyWeeks(),
        days: seriesByDay(memberIssues.get(id) ?? [], now, undefined, timeZone),
        closedDays: countByDay(memberIssues.get(id) ?? [], deliveredCloseAt, now, closedSpan, timeZone),
      };
    })
    .sort((a, b) => b.closed - a.closed || b.opened - a.opened || a.name.localeCompare(b.name));

  // ── load by assignee (open FLOW issues — steady-state ownership isn't WIP) ──
  const byLogin = new Map<string, number>();
  let unassigned = 0;
  for (const i of openFlow) {
    if (i.assignees.length === 0) {
      unassigned++;
      continue;
    }
    for (const login of i.assignees) byLogin.set(login, (byLogin.get(login) ?? 0) + 1);
  }
  const load: LoadRow[] = [...byLogin.entries()]
    .map(([login, count]) => ({ name: loginToName(login), login, count }))
    .sort((a, b) => b.count - a.count);
  if (unassigned > 0) load.push({ name: 'Unassigned', login: null, count: unassigned });

  // ── time to close, over the trailing 90 days of closures ──────────────────
  // Guard against clock skew / corrupt data: a closedAt in the future (or a
  // closedAt earlier than createdAt) would otherwise pass the window and feed a
  // negative time-to-close into the median/p90, dragging the headline down.
  const closures = issues.flatMap((i) => {
    // Abandoned work is not a time-to-close (#1014). It leaves `n` as well as
    // the median, and the median MOVES rather than merely shrinking: a
    // not-planned issue is typically an old one, so the figure this card
    // reports will improve because data was removed, not because anything got
    // faster. That is stated in the release note for the same reason it is
    // stated here.
    const at = deliveredCloseAt(i);
    if (i.state !== 'closed' || at == null) return [];
    const closedMs = Date.parse(at);
    const ageMs = now - closedMs;
    const createdMs = Date.parse(i.createdAt);
    return ageMs >= 0 && closedMs >= createdMs ? [{ ageMs, days: (closedMs - createdMs) / DAY_MS }] : [];
  });
  const windowMs = TTC_WINDOW_DAYS * DAY_MS;
  const closed90 = closures.filter(({ ageMs }) => ageMs < windowMs);
  const ttcDays = closed90
    .map((i) => i.days)
    .sort((a, b) => a - b);
  const meanOf = (samples: readonly { days: number }[]) => samples.length ? samples.reduce((sum, sample) => sum + sample.days, 0) / samples.length : null;
  const meanDays = ttcDays.length ? ttcDays.reduce((sum, days) => sum + days, 0) / ttcDays.length : null;
  const previous = closures.filter(({ ageMs }) => ageMs >= windowMs && ageMs < 2 * windowMs);
  const previousMeanDays = meanOf(previous);
  const lagWeeks = Math.ceil(TTC_WINDOW_DAYS / 7);
  const ttc = {
    medianDays: round1(percentile(ttcDays, 0.5)),
    p90Days: round1(percentile(ttcDays, 0.9)),
    n: ttcDays.length,
    meanDays,
    windowDays: TTC_WINDOW_DAYS,
    readable: true,
    comparison: {
      // These bounds use computation time. updatedAt is later replaced with
      // cache freshness by the service, so it cannot date these cohorts.
      startAt: new Date(now - windowMs).toISOString(),
      endAt: nowIso,
      previousStartAt: new Date(now - 2 * windowMs).toISOString(),
      previousN: previous.length,
      previousMeanDays,
      deltaDays: meanDays !== null && previousMeanDays !== null ? meanDays - previousMeanDays : null,
      rolling: Array.from({ length: lagWeeks + 1 }, (_, index) => {
        const endAgo = index === 0 ? windowMs : (lagWeeks - index) * WEEK_MS;
        const samples = closures.filter(({ ageMs }) => ageMs >= endAgo && ageMs < endAgo + windowMs);
        return {
          startAt: new Date(now - endAgo - windowMs).toISOString(),
          endAt: new Date(now - endAgo).toISOString(),
          n: samples.length,
          meanDays: index === lagWeeks ? meanDays : meanOf(samples),
        };
      }),
      // Anchored at `now`, the way Throughput's `weeks` are, so the chart's
      // "this week" is the same seven days as Throughput's and so is every
      // week back to "11 weeks ago". These were anchored at the window's far
      // edge, `now` minus 90 days, and 90 is not a multiple of seven: every
      // bound sat a day after Throughput's and "this week" was six days long
      // (#1041). The window itself does not move. The oldest bucket is cut at
      // its edge instead, so it holds the last six days of the week twelve
      // weeks back, and the buckets still split exactly the closes the
      // headline mean reads.
      weekly: Array.from({ length: lagWeeks }, (_, index) => {
        const endAgo = (lagWeeks - 1 - index) * WEEK_MS;
        const startAgo = Math.min(windowMs, endAgo + WEEK_MS);
        // Same (start, end] convention as the existing 90-day headline, where
        // Throughput counts [start, end): the bounds agree, and only a close
        // on a bound's exact millisecond lands one week apart in the two.
        const samples = closed90.filter(({ ageMs }) => ageMs >= endAgo && ageMs < startAgo);
        return {
          startAt: new Date(now - startAgo).toISOString(),
          endAt: new Date(now - endAgo).toISOString(),
          n: samples.length,
          meanDays: meanOf(samples),
        };
      }),
    },
  };

  // ── the aging set: open FLOW issues at or past the threshold, oldest first ──
  // Before #478 this was "the six oldest open flow issues, whatever their age",
  // which made the block's header count the size of its own slice rather than of
  // anything real. It is now a genuine set — everything `isAging` admits — so
  // `staleTotal` can report how much aging work there actually is while `stale`
  // carries only the head of it.
  const aging = issues.filter((i) => isAging(i, now, longLived));
  const stale: StaleRow[] = aging
    .map((i) => ({
      owner: i.owner,
      repo: i.repo,
      number: i.number,
      title: i.title,
      ageDays: Math.round((now - Date.parse(i.createdAt)) / DAY_MS),
      who:
        i.assignees.length === 0
          ? 'unassigned'
          : i.assignees.map((l) => loginToName(l)).join(', '),
      assignees: i.assignees,
      htmlUrl: i.htmlUrl,
    }))
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, STALE_N);

  // ── filter facets (computed from the UNFILTERED set so options stay stable) ─
  const repos = [...new Set(all.map((i) => i.repo))].sort();
  const labels = [...new Set(all.filter((i) => i.state === 'open').flatMap((i) => i.labels))].sort();
  const cycles = [...new Set(all.map((i) => i.milestone).filter((m): m is string => !!m))].sort();

  // ── steady-state breakdown: each long-lived issue counted once, under the ──
  // first of its long-lived labels in config order, so the surface can show
  // "AORs · OKR · Hypotheses" as their own tracked categories.
  const order = [...longLived];
  const byType = new Map<string, number>();
  for (const i of openSteady) {
    const label = order.find((l) => i.labels.includes(l));
    if (label) byType.set(label, (byType.get(label) ?? 0) + 1);
  }
  const steadyByType = [...byType.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return {
    updatedAt: nowIso,
    computedAt: nowIso,
    timeZone,
    openedEvents: issues.filter(i => Date.parse(i.createdAt) >= now - WEEKS * WEEK_MS).map(i => ({
      htmlUrl: i.htmlUrl, createdAt: i.createdAt, assignees: i.assignees,
    })),
    // Filtered HERE, which is what makes the frontend's three independent
    // re-counts inherit #1014 without a reason rule of their own — `throughputFor`
    // and the two series rebuilds in `flow-strip.vm.ts` all run off this list.
    closeEvents: issues.flatMap((i) => {
      const at = deliveredCloseAt(i);
      return at === null ? [] : [{ htmlUrl: i.htmlUrl, closedAt: at, assignees: i.assignees }];
    }),
    closedYesterday: issues.filter((i) => {
      // The LIST behind the "Closed yesterday" figure. If it did not move with
      // the count it sits under, the drill-in would name closes the tile refuses
      // to count (#1014).
      const at = deliveredCloseAt(i);
      const closed = at === null ? NaN : Date.parse(at);
      return calendarDay(closed, timeZone) === calendarDay(now, timeZone) - 1;
    }).map((i) => shapeQueueIssue(i, null, now, () => [], longLived)),
    repos,
    labels,
    cycles,
    filter: query,
    totals: {
      open: open.length,
      openFlow: openFlow.length,
      steadyState: openSteady.length,
      closed90: closed90.length,
      unassigned,
    },
    weeks,
    days,
    closedDays,
    recent4,
    byMember,
    load,
    ttc,
    stale,
    staleTotal: aging.length,
    steadyByType,
  };
}
