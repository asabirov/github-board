import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { describe, expect, it, vi } from 'vitest';
import { SyncController } from './sync.controller';
import { SYNC_SOURCES } from './sync-operation';
import type { IssuesMetricsService } from '../issues-metrics/issues-metrics.service';
import type { IssueBucketsService } from '../issue-buckets/issue-buckets.service';
import type { ProjectsService } from '../projects/projects.service';
import type { ReposService } from '../repos/repos.service';
import type { DerivedLoginsService } from '../identity/derived-logins.service';

/**
 * `GET /api/sync/sources` — the one record the header chip and the Board sync
 * panel both read (#1169).
 *
 * The bug was two readings of one fact. The chip's time came off whichever data
 * page happened to be mounted; the panel's four rows came off a MANUAL run held
 * in one tab, which is absent until somebody presses the button there. A board
 * whose four sources had all just refreshed therefore drew "Synced 8m ago" over
 * four rows reading "Not recorded".
 *
 * What this drives is the half that does not depend on how the chip words its
 * aggregate: every source is named, a source that has synced reports when, and a
 * source that has not reports that rather than a time.
 */
function reporting(times: Partial<Record<(typeof SYNC_SOURCES)[number], string | null>>) {
  const at = (key: (typeof SYNC_SOURCES)[number]) => vi.fn(() => times[key] ?? null);
  const issues = { lastSyncedAt: at('issues') } as unknown as IssuesMetricsService;
  const buckets = { lastSyncedAt: at('issueBuckets') } as unknown as IssueBucketsService;
  const projects = { freshness: vi.fn(() => ({ syncedAt: times.projects ?? null, organisations: { recorded: times.projects ? 2 : 0, total: 3 } })) } as unknown as ProjectsService;
  const repos = { lastSyncedAt: at('repos') } as unknown as ReposService;
  const derived = { invalidate: vi.fn(), refresh: vi.fn(async () => {}) } as unknown as DerivedLoginsService;
  return {
    controller: new SyncController(issues, buckets, projects, repos, derived),
    issues, buckets, projects, repos,
  };
}

const ALL_FOUR = {
  issues: '2026-09-17T19:52:00.000Z',
  issueBuckets: '2026-09-17T19:58:00.000Z',
  projects: '2026-09-17T19:49:00.000Z',
  repos: '2026-09-17T19:57:00.000Z',
};

describe('the per-source sync record the chip and the panel share (#1169)', () => {
  it('reports the time every source that synced last synced at', () => {
    const { controller } = reporting(ALL_FOUR);
    const { sources } = controller.sources();
    for (const key of SYNC_SOURCES) expect(sources[key].syncedAt).toBe(ALL_FOUR[key]);
  });

  // The first acceptance criterion, at the wire. A source whose data was
  // refreshed has a recorded time whether or not anybody pressed the button:
  // the record is the cache's own stamp, not a manual run's.
  it('records a source that synced with no manual run in sight', () => {
    const { controller } = reporting({ issues: '2026-09-17T19:52:00.000Z' });
    expect(controller.sources().sources.issues.syncedAt).toBe('2026-09-17T19:52:00.000Z');
  });

  // The second, at the wire: what a source with no record may NOT be given.
  it('says a source has no record rather than inventing a time for it', () => {
    const { controller } = reporting({ issues: '2026-09-17T19:52:00.000Z' });
    const { sources } = controller.sources();
    for (const key of SYNC_SOURCES) {
      if (key === 'issues') continue;
      expect(sources[key].syncedAt, `${key} has nothing cached and must say so`).toBeNull();
    }
  });

  // Named whatever it has to say. A payload that simply left a source out would
  // make "no record" and "this board has no such source" the same on the wire,
  // and the panel draws four rows either way.
  it('names all four sources even when none of them has a record', () => {
    const { controller } = reporting({});
    expect(Object.keys(controller.sources().sources).sort()).toEqual([...SYNC_SOURCES].sort());
  });

  /**
   * It asks the caches and never Github.
   *
   * Each source reports its freshness once: a panel opening must not cost four fetches, and a read that filled
   * its own cache would answer "just now" the first time it was ever asked —
   * which is a record that can never say a source has not synced.
   */
  it('asks each source once and starts no refresh', () => {
    const r = reporting(ALL_FOUR);
    r.controller.sources();
    for (const service of [r.issues, r.buckets, r.projects, r.repos]) {
      const asked = service as unknown as Record<string, ReturnType<typeof vi.fn>>;
      expect(asked.freshness ?? asked.lastSyncedAt).toHaveBeenCalledTimes(1);
      expect(asked.resync).toBeUndefined();
      expect(asked.resyncWithOutcome).toBeUndefined();
    }
  });

  /**
   * It does not go through `operationOwner()`, unlike the two progress routes.
   *
   * That check wants a `boardSub` AND an unexpired per-person token, which is
   * why a fixture board — where `AUTH_DISABLED=true` mints none — answers 403 to
   * the sync button and can never exercise it. Freshness is four times and no
   * Github data, so it answers there, and answers for somebody whose access
   * check is still in flight.
   *
   * It is NOT a route an unconnected person reaches on a board with
   * authentication on: `sync` is a whole segment of `GithubPrincipalGuard`'s
   * `GITHUB_SURFACE`, so that guard refuses it one layer earlier, and
   * `github-request.integration.db-spec.ts` drives that over real HTTP beside
   * `/api/repos` and `/api/projects` rather than leaving it to this sentence.
   */
  it('answers with no Github principal at all, where the progress routes refuse', () => {
    const { controller } = reporting(ALL_FOUR);
    expect(controller.sources().sources.issues.syncedAt).toBe(ALL_FOUR.issues);
    expect(() => controller.startOperation()).toThrow('GitHub access needs rechecking');
  });

  it('answers the same under a principal as without one', () => {
    const { controller } = reporting(ALL_FOUR);
    const principal = { key: 'visibility', token: 'secret', expiresAt: Date.now() + 60_000, cache: new WeakMap() } as GithubPrincipal;
    const under = githubContext.run({ principal, boardSub: 'one' }, () => controller.sources());
    expect(under).toEqual(controller.sources());
  });

  /**
   * It marks the request no more permission-sensitive than a progress read does
   * (#1169 review, B1).
   *
   * The sibling route has pinned this since #976 and the argument is the same
   * one, harder: four moments and no Github data, read every two minutes by every
   * open tab on every page, `/preferences` and `/docs` included. Marked,
   * `GithubExpiryInterceptor` refuses the answer outright once the check behind
   * it has expired, and the answer that does go out carries the withdrawal
   * headers `apiFetch` turns into a whole-board invalidation — from a poll about
   * how fresh the board is.
   *
   * Two of the four caches are `KeptWhileUnchanged` states, which mark a request
   * the moment they are READ, so this holds only while `ProjectsService` and
   * `ReposService` reach their moment through `PrincipalState.peek`. Their own
   * specs pin that end of it; this pins the route.
   */
  it('marks the request no more sensitive than a progress read does', () => {
    const { controller } = reporting(ALL_FOUR);
    const principal = { key: 'visibility', token: 'secret', expiresAt: Date.now() + 60_000, cache: new WeakMap(), permissionCache: new WeakMap() } as unknown as GithubPrincipal;
    const read: { principal: GithubPrincipal; boardSub: string; sensitive?: boolean } = { principal, boardSub: 'one' };
    githubContext.run(read, () => controller.sources());
    expect(read.sensitive).toBeUndefined();
  });

  it('is behind the same human-only guard as the rest of the surface', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SyncController.prototype.sources)).toContain(HumanOnlyGuard);
  });
});


it('carries partial Projects coverage through the route with the recorded moment (#1185)', () => {
  const { controller } = reporting(ALL_FOUR);
  expect(controller.sources().sources.projects).toEqual({
    syncedAt: '2026-09-17T19:49:00.000Z', organisations: { recorded: 2, total: 3 },
  });
});
