import { metricScope } from './metric-scope';
import { Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { githubOrgs } from '../config/github-orgs';
import {
  FeedbackScope,
  Viewer,
  feedbackScopeFrom,
  redactFeedbackTitles,
} from '../auth/feedback-visibility';
import { isStaticAgent } from '../auth/static-agent';
import { GithubLoginResolver } from '../identity/github-login.resolver';
import { ProjectMembership } from '../projects/project.types';
import { ProjectsService } from '../projects/projects.service';
import { IssuesCacheService } from './issues-cache.service';
import { computeFilterOptions, FilterOptions, FilterProject } from './filter-options.vm';
import { computeMetrics, toSearchIndex } from './issues-metrics.vm';
import { computeOrgQueue, computePersonalIssues, computeProjectContributions } from './personal-issues.vm';
import {
  IssueMetrics,
  IssueMetricsQuery,
  OrgQueue,
  PersonalIssues,
  SearchIssue,
} from './issues-metrics.types';

/**
 * Serves the issue-flow metrics (#120). The raw issue list is the heavy part
 * (it pages every tracked repo), so it lives in the shared IssuesCacheService —
 * one org-wide scan per TTL, shared with the Projects rollup (#391) so the
 * fetch never doubles. The per-query filtering + bucketing is cheap and runs
 * fresh on each request against that cached list. Github logins are resolved to
 * display names via the alias table (#73/#81); an unknown login falls back to
 * the login itself.
 */
@Injectable()
export class IssuesMetricsService {
  private readonly logger = new Logger(IssuesMetricsService.name);
  private readonly longLived: Set<string>;
  /** Which issues are somebody else's words, for the one visibility decision. */
  private readonly feedback: FeedbackScope;

  constructor(
    // The shared raw-issues cache (one org-wide scan for the whole app). Explicit
    // token via the module factory (tsx/esbuild emit no param metadata, so an
    // undecorated param would crash the compiled boot — see the DI note).
    @Inject(IssuesCacheService) private readonly issuesCache: IssuesCacheService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(GithubLoginResolver) private readonly githubLogins: GithubLoginResolver,
  ) {
    this.longLived = new Set(
      config
        .get<string>('LONG_LIVED_LABELS', '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    this.feedback = feedbackScopeFrom(config);
  }

  /**
   * The ONE read of the shared cache in this service (#497). Every surface below
   * — metrics, the queues, the palette index, the filter facets — comes through
   * here, so the feedback-visibility decision is applied once for all of them
   * instead of route by route. `viewer` is a required argument on each public
   * method precisely so a new surface cannot quietly skip it: leaving it out is
   * a compile error, not a leak.
   *
   * The cache itself is never touched — `redactFeedbackTitles` copies the rows
   * it hides — so one static-agent read cannot poison the next human's.
   */
  private async visibleIssues(viewer: Viewer | undefined, now = Date.now(), org?: string) {
    const snapshot = await this.issuesCache.getIssues(now);
    if (org != null && typeof org !== 'string') throw new NotFoundException('unknown org');
    const owner = org?.trim().toLowerCase();
    if (!owner) return { ...snapshot, issues: redactFeedbackTitles(snapshot.issues, viewer, this.feedback) };
    const reports = snapshot.orgs.filter(o => o.org.toLowerCase() === owner);
    const repos = snapshot.repos.filter(r => r.full.split('/')[0].toLowerCase() === owner);
    // Live coverage comes only from this scan, including repository-pin mode.
    // Configured owners are a fallback only for sources without reporting APIs.
    const covered = snapshot.coverageReported
      ? reports.length > 0 || repos.length > 0
      : githubOrgs(this.config).some(o => o.toLowerCase() === owner) || repos.length > 0;
    if (!covered) throw new NotFoundException(`unknown org ${owner}`);
    if (reports.some(o => o.state === 'unreadable') || repos.some(r => !r.ok)) {
      throw new ServiceUnavailableException(`issues for ${owner} could not be read`);
    }
    return {
      ...snapshot, orgs: reports, repos,
      issues: redactFeedbackTitles(snapshot.issues.filter(i => i.owner.toLowerCase() === owner), viewer, this.feedback),
    };
  }

  /** Force a fresh pull into the shared cache (#301, "sync now"). Delegates to
   *  the cache service, which awaits the fetch so the metrics/mine/org/search
   *  surfaces are all current — by the time this resolves. */
  async resync(): Promise<void> {
    // The chart's rows and names come off a memo with its own TTL, so an explicit
    // "Sync now" that only refreshed the issues would leave the pulse up to a
    // minute stale — the one thing an explicit sync is supposed to rule out.
    this.githubLogins.invalidateRoster();
    await this.issuesCache.resync();
  }

  /** The ingest's freshness, which is this surface's (#1169): every figure the
   *  metrics draw is computed per request off the shared snapshot, so what ages
   *  is the snapshot and nothing else here has an age of its own. */
  lastSyncedAt(): string | null {
    return this.issuesCache.lastSyncedAt();
  }

  async resyncWithOutcome(): Promise<'succeeded' | 'degraded'> {
    this.githubLogins.invalidateRoster();
    return this.issuesCache.resyncWithOutcome();
  }

  async getMetrics(query: IssueMetricsQuery, viewer: Viewer | undefined): Promise<IssueMetrics> {
    const nowIso = new Date().toISOString();
    const snapshot = await this.visibleIssues(viewer, Date.parse(nowIso), query.org);
    const { issues, at, orgs, repos } = snapshot;
    const roster = await this.githubLogins.teamRoster();
    const metrics = computeMetrics(
      issues,
      nowIso,
      query,
      // `names` is keyed folded and computeMetrics calls this with the login's
      // stored case, so the `.toLowerCase()` is load-bearing — without it every
      // mixed-case login renders as a bare handle (#541).
      (login) => roster.names.get(login.toLowerCase()) ?? login,
      this.longLived,
      // The roster the board currently claims as its team — the admin-editable
      // store first, the checked-in table underneath — so every teammate shows
      // on the throughput pulse even in a quiet week (#173 follow-up: "where is
      // Anton?"), including one who joined without a deploy (#541).
      roster.logins,
    );
    // The window math needs real `now`, but `updatedAt` should tell the truth
    // about data freshness — the cached list may be up to a TTL old.
    metrics.updatedAt = new Date(at).toISOString();
    metrics.metricScope = metricScope(snapshot, query, nowIso, this.longLived, this.config.get<number>('ISSUES_METRICS_CACHE_TTL_MS', 600_000));
    // A partial scan cannot establish an organization-wide mean (#843).
    metrics.ttc.readable = !orgs.some((org) => org.state === 'unreadable') && !repos.some((repo) => !repo.ok);
    if (!metrics.ttc.readable) {
      metrics.ttc.meanDays = null;
      metrics.ttc.comparison = null;
    }
    return metrics;
  }

  /**
   * The signed-in user's open queue + trailing-7d throughput (#206, "Your
   * work" home). Runs off the SAME cached raw list as getMetrics — no extra
   * GitHub call. The email → GitHub login hop happens server-side (the session
   * only carries email); an unmapped email yields an empty queue, not an error.
   *
   * That hop goes through GithubLoginResolver (#520), the one place that answers
   * "which handle belongs to this address" — roster first, checked-in table
   * underneath. It used to read the file directly, so an admin correcting a
   * handle on the Access page moved every other surface and left this page
   * showing the old attribution until the next deploy.
   *
   * A static agent makes that hop for nobody (#546). `login` is an assertion
   * about who the caller is, which makes this route one of the surfaces that
   * answer "who am I", and a static token reaches it — an undecorated GET takes
   * the read scope every one of them holds. Its address is `agent:<name>`, built
   * from a name in an environment variable, so a roster row or alias entry
   * carrying that text would attribute a real person's queue to a token. The
   * fact comes from `isStaticAgent` — the one definition (#525) — off the viewer
   * the route already passes, so this route, `/api/auth/me` and `board_whoami`
   * give one answer to one question. Every other scoped caller is untouched: a
   * personal access token carries its owner's address and keeps their work.
   */
  async getMine(email: string, viewer: Viewer | undefined, org?: string, timeZone = 'UTC'): Promise<PersonalIssues> {
    const nowIso = new Date().toISOString();
    const snapshot = await this.visibleIssues(viewer, Date.parse(nowIso), org);
    const { issues, at } = snapshot;
    // Fetch the project memberships once and feed both the queue's project-name
    // join and the per-board contribution rollup (#380) off the same list.
    const memberships = (await this.projectMemberships()).filter(p => !org?.trim() || p.org.toLowerCase() === org.trim().toLowerCase());
    // Both computations below take `null` already — it is the answer for an
    // address nothing maps, and they return the empty queue rather than guessing.
    const login = isStaticAgent(viewer) ? null : await this.githubLogins.forEmail(email);

    const personal = computePersonalIssues(issues, login, nowIso, membershipIndex(memberships), this.longLived, timeZone);
    personal.projectContributions = computeProjectContributions(issues, login, nowIso, memberships);
    // Same freshness truth as getMetrics: the list may be up to a TTL stale.
    // `computedAt` is deliberately NOT overwritten beside it (#1015) — that one
    // is the clock the day series were bucketed by, and stamping the cache's
    // fetch time on it would hand the grid an anchor older than the days it
    // draws. Two stamps, two questions: when was this counted, how old is what
    // it counted. `getMetrics` above splits them the same way.
    personal.updatedAt = new Date(at).toISOString();
    personal.metricScope = metricScope(snapshot, { org, timeZone }, nowIso, this.longLived, this.config.get<number>('ISSUES_METRICS_CACHE_TTL_MS', 600_000), 'personal-work-v1');
    return personal;
  }

  /**
   * The whole unit's open queue (#284) — the same stackable rows as getMine but
   * at org scope, for the Unit page's shared queue. Runs off the SAME cached raw
   * list + project join, no extra GitHub call.
   */
  async getOrgQueue(viewer: Viewer | undefined, org?: string): Promise<OrgQueue> {
    const nowIso = new Date().toISOString();
    const snapshot = await this.visibleIssues(viewer, Date.parse(nowIso), org);
    const { issues, at } = snapshot;
    const memberships = (await this.projectMemberships()).filter(p => !org?.trim() || p.org.toLowerCase() === org.trim().toLowerCase());

    const queue = computeOrgQueue(issues, nowIso, membershipIndex(memberships), this.longLived);
    queue.updatedAt = new Date(at).toISOString();
    queue.metricScope = metricScope(snapshot, { org }, nowIso, this.longLived, this.config.get<number>('ISSUES_METRICS_CACHE_TTL_MS', 600_000), 'issue-queue-v1');
    return queue;
  }

  /**
   * The org-wide sets the shared IssuesViewer's filters autocomplete against
   * (#376): labels + assignees from the cached raw issue list, projects from the
   * cached rollup. Runs off data the board already holds — no extra GitHub call.
   * The projects join is best-effort: a hiccup degrades to no project options
   * rather than failing the whole filter surface.
   */
  async getFilterOptions(viewer: Viewer | undefined): Promise<FilterOptions> {
    const { issues } = await this.visibleIssues(viewer);
    let projects: FilterProject[] = [];
    try {
      // Board orgs + numbers + board names only — no issue title crosses over
      // here. The org rides along because a board number is unique only WITHIN
      // an org, and this list is the UNION across every configured one (#697):
      // dropping it here is what let one org's board 3 stand in for another's.
      // The viewer still goes down, because the read is identity-scoped at its
      // source (#497) and a call site that quietly opts out is how a control
      // stops covering a surface.
      projects = (await this.projects.listProjects(viewer)).map((p) => ({
        org: p.org,
        number: p.number,
        name: p.name,
      }));
    } catch (err) {
      this.logger.warn(`filter-options projects join skipped: ${(err as Error).message}`);
    }
    return computeFilterOptions(issues, projects);
  }

  /** The per-board issue-URL memberships, for both the queue's project-name join
   *  and the contribution rollup (#380). Best-effort — a projects hiccup must
   *  not break the queue, so a failure degrades to "on no board". */
  private async projectMemberships(): Promise<ProjectMembership[]> {
    try {
      return await this.projects.projectMemberships();
    } catch (err) {
      this.logger.warn(`project-membership join skipped: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Lean open-issue list for the ⌘K palette (#214). Runs off the SAME cached raw
   * list as getMetrics/getMine — no extra GitHub call — and projects each open
   * issue to just what the palette needs to match and route.
   */
  async getSearchIndex(viewer: Viewer | undefined): Promise<SearchIssue[]> {
    const { issues } = await this.visibleIssues(viewer);
    return toSearchIndex(issues);
  }
}

/** Reverse index: issue URL → the project name(s) it's on, for stacking the
 *  queue by project (#206). Built from the memberships list the service already
 *  fetched. */
function membershipIndex(memberships: ProjectMembership[]): (htmlUrl: string) => string[] {
  const byUrl = new Map<string, string[]>();
  for (const m of memberships) {
    for (const url of m.issueUrls) {
      const names = byUrl.get(url) ?? [];
      names.push(m.name);
      byUrl.set(url, names);
    }
  }
  return (url: string) => byUrl.get(url) ?? [];
}
