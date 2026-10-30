// The Repos map's derivation (#472). Pure — no I/O, no clock: the caller passes
// the repo list, the already-ingested issues, `now`, and an owner lookup. The
// weekly series is a rollup of the SAME org-wide issue list the throughput and
// aging metrics read (#257), so the map costs no extra GitHub call for its
// counts.

import { deliveredCloseAt, type CloseReason } from '../issues-metrics/close-reason';
import type { RepoDescriptor, RepoOwner, RepoRow, RepoWeek } from './repo.types';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Trailing window width — 10 rolling 7-day buckets, the same cadence as the
 *  cockpit sparkline (PULSE_WEEKS) so the two surfaces read alike. */
export const REPO_WEEKS = 10;

/** Just the fields the rollup needs from an ingested issue — typed inline so
 *  this file stays free of the issues-metrics TYPES import. `close-reason` is
 *  the exception (#1014): it imports nothing, so it adds no edge to the graph
 *  this inline type exists to keep clean. */
export interface FlowIssue {
  /** the org this issue was read from, e.g. 'acme' */
  owner: string;
  /** short repo key, e.g. 'board' */
  repo: string;
  state: 'open' | 'closed';
  createdAt: string;
  closedAt: string | null;
  /** WHY it closed (#1014) — required, so a caller that cannot say cannot count
   *  an abandoned issue as a week's delivered work. An unknown reason still
   *  counts; see `deliveredCloseAt`. */
  stateReason: CloseReason;
}

/**
 * The key that joins an ingested issue to a repo (#647): the OWNER plus the
 * short repo key.
 *
 * The short key alone is not a key across orgs. `shortRepoKey` deliberately
 * drops everything after the first dot and carries no owner (#484), so
 * `acme/design-system` and `globex/design-system` — two repos that both
 * exist — fold onto one `design-system`, and every count behind that key
 * becomes the sum of two orgs' queues with nothing to notice.
 *
 * The short key stays exactly what it was: a DISPLAY key and the `?repo=`
 * filter value, which is carried in shareable board URLs and must not change
 * meaning. This composes a join key beside it rather than replacing it, so a
 * single-org board keys on `<the one org>/<the same short key>` and joins
 * exactly the rows it joined before.
 */
export function repoJoinKey(owner: string, repoKey: string): string {
  return `${owner}/${repoKey}`;
}

/** The same join key for a repo the caller holds by its canonical `owner/name`
 *  full key and its short key — `RepoDescriptor` and `RepoRow` both carry that
 *  pair, so neither has to take the owner apart itself. */
export function repoJoinKeyOf(repo: { full: string; key: string }): string {
  return repoJoinKey(repo.full.split('/')[0], repo.key);
}

const emptyWeeks = (weeks: number): RepoWeek[] =>
  Array.from({ length: weeks }, () => ({ opened: 0, closed: 0 }));

/** Which rolling window `t` falls in, or -1 when it is outside the window.
 *  Window w spans [end-WEEK, end) with end = now - (weeks-1-w)*WEEK, so the last
 *  slot is the trailing 7 days [now-7d, now) — the same bucketing the metrics
 *  and the project pulse use, so no two surfaces disagree at a week boundary.
 *
 *  Exported for the repo page (#575), whose PR flow and CI spend are drawn
 *  against the map's issue weeks: they have to share this bucketing rather than
 *  each carry a copy of it, or two series on one page would disagree about
 *  where a week starts. */
export function slotOf(t: number, now: number, weeks: number): number {
  const age = now - t;
  if (age <= 0) return -1;
  const slot = weeks - Math.ceil(age / WEEK_MS);
  return slot >= 0 && slot < weeks ? slot : -1;
}

/**
 * Opened/closed per rolling week for every repo present in `issues`, keyed by
 * `repoJoinKey` — the issue's owner and short repo key. `closed` is DELIVERED
 * closes only (#1014). Activity older than the window drops off rather
 * than piling into the oldest bucket. A repo with no issues simply has no entry
 * — `rollUpRepos` gives it a zeroed series, so an empty queue still lands on the
 * map.
 */
export function weeklyFlowByRepo(
  issues: FlowIssue[],
  nowIso: string,
  weeks = REPO_WEEKS,
): Map<string, RepoWeek[]> {
  const now = Date.parse(nowIso);
  const out = new Map<string, RepoWeek[]>();
  const seriesFor = (repo: string): RepoWeek[] => {
    let s = out.get(repo);
    if (!s) {
      s = emptyWeeks(weeks);
      out.set(repo, s);
    }
    return s;
  };

  for (const i of issues) {
    const created = Date.parse(i.createdAt);
    if (!Number.isNaN(created)) {
      const slot = slotOf(created, now, weeks);
      if (slot >= 0) seriesFor(repoJoinKey(i.owner, i.repo))[slot].opened++;
    }
    // `deliveredCloseAt`, not `closedAt` (#1014): a repo's closed bar is read as
    // work shipped, and on one repo here 54% of the last 56 closes were
    // not-planned — enough to invert the shape of the whole sparkline. The
    // OPENED bar above keeps every issue, abandoned ones included: they were
    // opened, and only the claim that they were finished is being withdrawn.
    const closedAt = deliveredCloseAt(i);
    if (closedAt) {
      const closed = Date.parse(closedAt);
      if (!Number.isNaN(closed)) {
        const slot = slotOf(closed, now, weeks);
        if (slot >= 0) seriesFor(repoJoinKey(i.owner, i.repo))[slot].closed++;
      }
    }
  }
  return out;
}

/** Open issues per repo, keyed by `repoJoinKey`. */
export function openCountByRepo(issues: FlowIssue[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const i of issues) {
    if (i.state !== 'open') continue;
    const key = repoJoinKey(i.owner, i.repo);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * The map: every repo in `descriptors` — including the ones whose queue is empty
 * — with its weekly flow, its current open count, its owner, its language and
 * its last push. Sorted by full name so successive reads draw the same map.
 *
 * No verdict on that flow travels with it. One did until #607 — a boolean for
 * "this queue gained ground in most of the window" — and the only thing that
 * ever read it was a coloured border on one tile. The weeks are here in full;
 * whoever wants a verdict can read them.
 *
 * Security and CI are NOT rolled up here (#571): they are the two slowest reads
 * behind this surface and the map must not wait on either, so they are served
 * separately and joined on `full` by the client.
 *
 * `unreadableOrgs` is the orgs whose ownership read FAILED (#718), straight off
 * `DriRead`. Every repo of one of them gets `ownerState: 'unreadable'`, because
 * `ownerOf` answers `null` for a repo it has no row for and `null` otherwise
 * means the org records no owner — one absence standing for two opposite facts.
 * The org is taken off `full`, the same way `repoJoinKeyOf` takes it, so a repo
 * is judged by the org it is actually in rather than by which read produced it.
 */
export function rollUpRepos(
  descriptors: RepoDescriptor[],
  issues: FlowIssue[],
  nowIso: string,
  ownerOf: (full: string) => RepoOwner | null,
  unreadableOrgs: readonly string[] = [],
  weeks = REPO_WEEKS,
): RepoRow[] {
  const flow = weeklyFlowByRepo(issues, nowIso, weeks);
  const open = openCountByRepo(issues);
  // Folded, because Github org names are case-insensitive and the two sides of
  // this comparison come from different reads: the org list the source was
  // configured with, and the owner half of a repo's own `full` as Github spells
  // it. A case difference between them must not decide whether a repo's owner
  // is drawn as unknown.
  const unreadable = new Set(unreadableOrgs.map((o) => o.toLowerCase()));

  return descriptors
    .map((d) => {
      const join = repoJoinKeyOf(d);
      const series = flow.get(join) ?? emptyWeeks(weeks);
      const openNow = open.get(join) ?? 0;
      return {
        full: d.full,
        name: d.name,
        key: d.key,
        htmlUrl: d.htmlUrl,
        description: d.description,
        weeks: series,
        open: openNow,
        owner: ownerOf(d.full),
        ownerState: unreadable.has(d.full.split('/')[0].toLowerCase())
          ? ('unreadable' as const)
          : ('read' as const),
        language: d.language,
        pushedAt: d.pushedAt,
        createdAt: d.createdAt,
      };
    })
    .sort((a, b) => a.full.localeCompare(b.full));
}
