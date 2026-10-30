import { BadRequestException, Controller, Get, Header, Inject, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Viewer } from '../auth/feedback-visibility';
import { FilterOptions } from './filter-options.vm';
import { IssuesMetricsService } from './issues-metrics.service';
import { IssueMetrics, OrgQueue, PersonalIssues, SearchIssue } from './issues-metrics.types';

/**
 * GET /api/issues/metrics — issue-flow health across the tracked repos (#120).
 * Optional filters: ?org=<owner>&repo=<key>&label=<name>&cycle=<milestone>. Behind the
 * global SSO + team-group guards like every other read surface.
 *
 * Every handler here hands the authenticated caller to the service (#497). These
 * surfaces carry issue TITLES, and a feedback submission's title is the first
 * line of somebody's message, so what a caller may read depends on who they are.
 * The service decides once for all of them; the routes only pass identity.
 */
interface AuthedRequest {
  user?: Viewer;
}

@Controller('issues')
export class IssuesMetricsController {
  constructor(@Inject(IssuesMetricsService) private readonly service: IssuesMetricsService) {}

  @Get('metrics')
  @Header('Cache-Control', 'private, no-cache')
  metrics(
    @Req() req: AuthedRequest,
    @Query('repo') repo?: string,
    @Query('label') label?: string,
    @Query('cycle') cycle?: string,
    @Query('org') org?: string,
    @Query('timeZone') timeZone?: string,
  ): Promise<IssueMetrics> {
    return this.service.getMetrics({ repo, label, cycle, org, timeZone: requestedTimeZone(timeZone) }, req.user);
  }

  /**
   * GET /api/issues/mine — the signed-in user's open queue + trailing-7d
   * throughput (#206, "Your work" home). Identity is the session email the
   * global guard verified; a request without one is a guard regression and
   * must 401, not answer 200 with someone else's (empty) queue. Private copies
   * may be persisted by the board; shared caches must never store this answer.
   */
  @Get('mine')
  @Header('Cache-Control', 'private, no-cache')
  mine(@Req() req: AuthedRequest, @Query('org') org?: string, @Query('timeZone') timeZone?: string): Promise<PersonalIssues> {
    const email = req.user?.email;
    if (!email) throw new UnauthorizedException('No session');
    return this.service.getMine(email, req.user, org, requestedTimeZone(timeZone));
  }

  /**
   * GET /api/issues/all — the whole unit's open queue (#284), for the Unit
   * page's shared queue component. Selected owner, or the union when absent, off
   * the same cached list as `mine`. A one-segment path, no collision with the
   * 3-segment issue-detail route. Behind the global SSO + team guards.
   */
  @Get('all')
  @Header('Cache-Control', 'private, no-cache')
  all(@Req() req: AuthedRequest, @Query('org') org?: string): Promise<OrgQueue> {
    return this.service.getOrgQueue(req.user, org);
  }

  /**
   * GET /api/issues/search-index — the ⌘K palette's open-issue index (#214).
   * A one-segment path (no collision with the 3-segment issue-detail route);
   * runs off the same cached raw list as metrics/mine, no extra GitHub call.
   */
  @Get('search-index')
  @Header('Cache-Control', 'no-store')
  searchIndex(@Req() req: AuthedRequest): Promise<SearchIssue[]> {
    return this.service.getSearchIndex(req.user);
  }

  /**
   * GET /api/issues/filter-options — the org-wide label / assignee / project sets
   * the shared IssuesViewer's filters autocomplete against (#376). A one-segment
   * path (no collision with the 3-segment issue-detail route); org-wide, so it's
   * cacheable like `metrics` (no per-user no-store). Behind the same global SSO +
   * team guards as every other read; nothing here writes.
   */
  @Get('filter-options')
  filterOptions(@Req() req: AuthedRequest): Promise<FilterOptions> {
    return this.service.getFilterOptions(req.user);
  }
}

/** Older clients omit the zone; browsers send the resolved account preference. */
export function requestedTimeZone(value?: string): string {
  if (value === undefined || value === '') return 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new BadRequestException('Choose a valid time zone, such as Europe/Berlin.');
  }
}
