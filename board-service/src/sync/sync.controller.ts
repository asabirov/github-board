import { createHash } from 'node:crypto';
import { githubContext } from '../auth/github-principal';
import { SYNC_SOURCES, SyncOperations, type SyncOperation, type SyncSource } from './sync-operation';
import { type BoardFreshness, type ReportsFreshness, type SourceFreshness } from './source-freshness';
import { Controller, ForbiddenException, Get, Header, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { Writes } from '../capability/writes.decorator';
import { IssuesMetricsService } from '../issues-metrics/issues-metrics.service';
import { IssueBucketsService } from '../issue-buckets/issue-buckets.service';
import { ProjectsService } from '../projects/projects.service';
import { ReposService } from '../repos/repos.service';
import { DerivedLoginsService } from '../identity/derived-logins.service';

/**
 * On-demand "sync now" (#301). The board's read surfaces serve stale-while-
 * revalidate, so data is at most a TTL old — but when it *looks* stale you can
 * force a fresh pull instead of waiting for the next cycle. This refreshes the
 * board's own server-side caches from the same GitHub reads it already runs; it
 * is NOT a new write path (no GitHub mutation, no new scope). Human-only (a
 * person clicking refresh), behind the global SSO + team guards like every
 * other surface.
 */
@Controller('sync')
export class SyncController {
  private readonly operations = new SyncOperations();
  constructor(
    @Inject(IssuesMetricsService) private readonly issues: IssuesMetricsService,
    @Inject(IssueBucketsService) private readonly buckets: IssueBucketsService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(ReposService) private readonly repos: ReposService,
    @Inject(DerivedLoginsService) private readonly derived: DerivedLoginsService,
  ) {}

  /**
   * Who may read a run: this Board identity, with this Github visibility.
   * `principal.key` changes when the person's access does, so a read under a
   * check that found different access is refused, while one under an unchanged
   * re-check reads on (#976). The run's life is not taken from this check.
   *
   * A progress read is not marked permission-sensitive. Progress is four outcome
   * words and their times, and no Github data. Marked, the browser would drop a
   * finished run from the header at the deadline of the check its last read
   * happened under. The press itself can still be marked: a Projects refresh it
   * starts reads permission-sensitive state before the answer goes. The browser
   * holds either answer in plain state, so neither expires there.
   */
  private operationOwner(): string {
    const context = githubContext.getStore();
    const principal = context?.principal;
    if (!context?.boardSub || !principal?.token || !principal.expiresAt || principal.expiresAt <= Date.now()) {
      throw new ForbiddenException('GitHub access needs rechecking before sync.');
    }
    return createHash('sha256').update(context.boardSub).update('\0').update(principal.key).digest('hex');
  }

  @Writes()
  @Post('operations')
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(202)
  @UseGuards(HumanOnlyGuard)
  startOperation(): SyncOperation {
    return this.operations.start(this.operationOwner(), {
      issues: () => this.issues.resyncWithOutcome(),
      issueBuckets: () => this.buckets.resync(),
      projects: () => this.projects.resyncWithOutcome(),
      repos: () => this.repos.resyncWithOutcome(),
    }, () => {
      this.derived.invalidate();
      void this.derived.refresh();
    });
  }

  /**
   * When each of the four sources last refreshed (#1169).
   *
   * The Board sync panel's rows read THIS, not `SyncOperation.sources`. That
   * record is one manual run in one tab — absent until the button is pressed
   * there, gone on reload, pruned five minutes after the run ends — so a panel
   * drawn from it said "Not recorded" about four sources that had all just
   * synced, beside a header chip reading "Synced 8m ago" off the payload
   * timestamps. The two were reading different things. They read this one now,
   * so they cannot say different things about it again.
   *
   * No Github, and no `operationOwner()`. Four times and nothing else goes over
   * this wire, each read out of a cache the service already holds, and no read
   * here starts one. What the route skips is `operationOwner()`'s stricter
   * check, which also wants a `boardSub` and an unexpired `expiresAt`: so a
   * person whose access check is mid-flight can still be told how fresh their
   * board is, and a fixture board, where `AUTH_DISABLED=true` mints no
   * per-person token and the sync button therefore answers 403, can be developed
   * against.
   *
   * It is NOT reachable without a Github connection, and this route does not get
   * to decide that. `sync` is a whole segment of `GithubPrincipalGuard`'s
   * `GITHUB_SURFACE`, so on a board with authentication on an unconnected person
   * is refused here with "Sign in with GitHub to use this surface", exactly as on
   * every other Github-backed surface. Only `AUTH_DISABLED=true`, which skips
   * that guard outright, reaches it with no token at all.
   *
   * The read is NOT permission-sensitive, and that is a property held rather
   * than a claim made: `sync.controller.spec.ts` pins it here as it has pinned
   * it for the progress route since #976, and both `ProjectsService` and
   * `ReposService` reach their moment through `PrincipalState.peek` rather than
   * through the state itself, which is what keeps it true. Marked, this poll —
   * two minutes, every open tab, every page, `/preferences` and `/docs`
   * included — would be refused outright by `GithubExpiryInterceptor` once the
   * check behind it expired, and would carry the withdrawal headers that
   * `apiFetch` turns into a whole-board invalidation.
   *
   * Every source is named in the answer whatever it has to say, and a source
   * with nothing cached says `null` rather than being left out or given a time.
   */
  @Get('sources')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(HumanOnlyGuard)
  sources(): BoardFreshness {
    const reporters: Record<SyncSource, ReportsFreshness> = {
      issues: this.issues,
      issueBuckets: this.buckets,
      projects: this.projects,
      repos: this.repos,
    };
    // One pass over the same list the answer's type is built from, so a source
    // cannot be left out of the payload by being forgotten here.
    const sources = Object.fromEntries(
      SYNC_SOURCES.map((key) => [key, key === 'projects'
        ? this.projects.freshness()
        : { syncedAt: reporters[key].lastSyncedAt() }]),
    ) as Record<SyncSource, SourceFreshness>;
    return { sources };
  }

  @Get('operations/:operationId')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(HumanOnlyGuard)
  operation(@Param('operationId') operationId: string): SyncOperation {
    return this.operations.get(operationId, this.operationOwner());
  }

  /**
   * Force-refresh every dashboard read cache and report when it completed. All
   * of them are awaited, so the returned `syncedAt` reflects warm, current data —
   * and a source that fails to refresh rejects the request (a surfaced error),
   * never a silent no-op.
   *
   * Two reads are outside that: the derived logins below, and the repo map's
   * security and CI pair since #571. Both are re-warmed in the background
   * instead, because each costs more than the press should wait for — the health
   * pair alone is 14-18 s of Github — and both report a failure as a warning
   * rather than as this request's error.
   */
  // Refreshes the board's own read caches. It READS Github, and a read is not
  // a capability this layer models.
  @Writes()
  @Post()
  @UseGuards(HumanOnlyGuard)
  async sync(): Promise<{ syncedAt: string }> {
    await Promise.all([
      this.issues.resync(),
      this.buckets.resync(),
      this.projects.resync(),
      this.repos.resync(),
    ]);
    // #535. Mark the derived login map stale and re-warm it WITHOUT awaiting.
    // Unlike every cache above, its rebuild is paced against Github search's
    // 30-a-minute bucket — six requests for a three-person org, four hundred at
    // the max-members default. Awaiting it would hold this response for tens of
    // seconds now and past any ingress timeout later, and `syncedAt` was never a
    // promise that every cache is warm; it is a timestamp.
    this.derived.invalidate();
    void this.derived.refresh();
    return { syncedAt: new Date().toISOString() };
  }
}
