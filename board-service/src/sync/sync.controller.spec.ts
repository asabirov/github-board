import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { describe, expect, it, vi } from 'vitest';
import { SyncController } from './sync.controller';
import { IssuesMetricsService } from '../issues-metrics/issues-metrics.service';
import { IssueBucketsService } from '../issue-buckets/issue-buckets.service';
import { ProjectsService } from '../projects/projects.service';
import { ReposService } from '../repos/repos.service';
import { DerivedLoginsService } from '../identity/derived-logins.service';

describe('SyncController (#301)', () => {
  function make() {
    const issues = { resync: vi.fn(async () => {}), resyncWithOutcome: vi.fn(async () => 'succeeded') } as unknown as IssuesMetricsService;
    const buckets = { resync: vi.fn(async () => {}) } as unknown as IssueBucketsService;
    const projects = { resync: vi.fn(async () => {}), resyncWithOutcome: vi.fn(async () => 'succeeded') } as unknown as ProjectsService;
    const repos = { resync: vi.fn(async () => {}), resyncWithOutcome: vi.fn(async () => 'succeeded') } as unknown as ReposService;
    // #535. `calls` records ORDER: invalidate must precede refresh, or the
    // refresh builds a map the invalidation immediately marks stale again.
    const calls: string[] = [];
    const derived = {
      invalidate: vi.fn(() => void calls.push('invalidate')),
      refresh: vi.fn(async () => void calls.push('refresh')),
    } as unknown as DerivedLoginsService;
    return {
      controller: new SyncController(issues, buckets, projects, repos, derived),
      issues, buckets, projects, repos, derived, calls,
    };
  }

  it('requires a resolved human principal for progress and binds status to its Board identity', async () => {
    const { controller } = make();
    expect(() => controller.startOperation()).toThrow('GitHub access needs rechecking');
    const principal = { key: 'visibility', token: 'secret', expiresAt: Date.now() + 60_000, cache: new WeakMap() } as GithubPrincipal;
    const operation = githubContext.run({ principal, boardSub: 'one' }, () => controller.startOperation());
    expect(githubContext.run({ principal, boardSub: 'one' }, () => controller.operation(operation.operationId)).operationId).toBe(operation.operationId);
    expect(() => githubContext.run({ principal, boardSub: 'two' }, () => controller.operation(operation.operationId))).toThrow('Sync progress unavailable.');
    // #976. Progress holds no Github data. Marked sensitive, the browser would
    // drop a finished run at the deadline of the check its last read was under.
    const read: { principal: GithubPrincipal; boardSub: string; sensitive?: boolean } = { principal, boardSub: 'one' };
    githubContext.run(read, () => controller.operation(operation.operationId));
    expect(read.sensitive).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, SyncController.prototype.startOperation)).toContain(HumanOnlyGuard);
    expect(Reflect.getMetadata(GUARDS_METADATA, SyncController.prototype.operation)).toContain(HumanOnlyGuard);
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

  it('force-refreshes all read caches and reports a fresh syncedAt', async () => {
    const { controller, issues, buckets, projects, repos } = make();
    const res = await controller.sync();
    expect(issues.resync).toHaveBeenCalledTimes(1);
    expect(buckets.resync).toHaveBeenCalledTimes(1);
    expect(projects.resync).toHaveBeenCalledTimes(1);
    expect(repos.resync).toHaveBeenCalledTimes(1);
    expect(Number.isNaN(Date.parse(res.syncedAt))).toBe(false);
  });

  it('rejects (surfaced error) when a source fails to refresh — never a silent no-op', async () => {
    const { controller, buckets } = make();
    (buckets.resync as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('github down'));
    await expect(controller.sync()).rejects.toThrow('github down');
  });

  // #535. The derived map is the one cache here whose rebuild is paced against
  // Github search's 30-a-minute bucket, so it is dropped and re-warmed but
  // never awaited.
  it('invalidates the derived login map BEFORE it re-warms', async () => {
    const { controller, calls } = make();
    await controller.sync();
    expect(calls).toEqual(['invalidate', 'refresh']);
  });

  it('does not make the caller wait on the derived rebuild', async () => {
    const { controller, derived } = make();
    // A refresh that never settles must not hold the response: awaiting it
    // would put a rate-limited Github loop on a request path.
    (derived.refresh as unknown as { mockImplementation: (f: () => Promise<void>) => void })
      .mockImplementation(() => new Promise<void>(() => {}));
    const res = await controller.sync();
    expect(Number.isNaN(Date.parse(res.syncedAt))).toBe(false);
  });
});
