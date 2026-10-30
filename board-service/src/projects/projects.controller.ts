import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Viewer } from '../auth/feedback-visibility';
import { ProjectsService } from './projects.service';
import type { ProjectCatalogEntry, ProjectDetail, ProjectSummary } from './project.types';
import { githubOrgs } from '../config/github-orgs';

/**
 * Read-only Projects API. Global prefix 'api' → /api/projects/*. Runs under the
 * existing global chain (JwtAuthGuard → TeamAccessGuard): any team member can
 * read; nothing here writes (edits happen on GitHub).
 *
 * The two routes that carry issue titles hand the authenticated caller to the
 * service (#497). A board's rows are ordinary Github issues, and a feedback
 * submission triaged onto a board — ordinary practice since #404 shipped the
 * picker — has the end user's first line for a title. So what a caller may read
 * here depends on who they are; the service decides once, the routes only pass
 * identity.
 */
interface AuthedRequest {
  user?: Viewer;
}

@Controller('projects')
export class ProjectsController {
  constructor(
    @Inject(ProjectsService) private readonly projects: ProjectsService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  /** Every route follows the owners the caller may read: the person's own
   * Github App grants, or `GITHUB_ORGS` where no person is acting. There is no
   * narrower mutation ceiling to supply any more — `PROJECTS_OWNER` was it, and
   * it is retired (#1209 part 4). A query only narrows that owner set. */
  private servedOrg(org?: unknown, owners = githubOrgs(this.config)): string | undefined {
    if (org === undefined || org === null) return undefined;
    // Express hands `?org=a&org=b` up as an array and `?org[k]=v` as an object.
    // Neither names one org this board could serve, so neither is served — and a
    // gate that assumed a string would answer 500 where it owes a refusal.
    if (typeof org !== 'string') throw new NotFoundException('unknown org');
    const asked = org.trim();
    if (!asked) return undefined;
    // Github org names are case-insensitive, so `?org=Acme` names the same
    // org and refusing it would be a false refusal.
    const folded = asked.toLowerCase();
    const served = owners.find((o) => o.trim().toLowerCase() === folded);
    // An empty owner set refuses every named org.
    if (!served) throw new NotFoundException(`unknown org ${asked}`);
    return served;
  }

  @Get()
  async list(
    @Req() req: AuthedRequest,
    @Query('org') org?: string,
  ): Promise<{ projects: ProjectSummary[] }> {
    return { projects: await this.projects.listProjects(req.user, this.servedOrg(org)) };
  }

  // MUST come before `:number` — otherwise the literal "catalog" matches the
  // `:number` param route and 400s on the non-numeric segment.
  //
  // No `@Req()`: a catalog entry is a BOARD's identity (node id, number, board
  // title) and carries no issue title, body or address, so there is nothing on
  // it that depends on the caller. Taking a viewer it never consulted would
  // read like a control that is doing something.
  @Get('catalog')
  async catalog(@Query('org') org?: string): Promise<ProjectCatalogEntry[]> {
    return this.projects.listProjectCatalog(this.servedOrg(org));
  }

  /** This read-only catalog follows All work; the picker catalog above keeps
   * the same owner ceiling as add-to-project writes. */
  @Get('preview')
  async preview(@Query('org') org?: string): Promise<ProjectCatalogEntry[]> {
    return this.projects.listProjectPreview(this.servedOrg(org));
  }

  @Get(':number')
  async detail(
    @Req() req: AuthedRequest,
    @Param('number') number: string,
    @Query('org') org?: string,
  ): Promise<ProjectDetail> {
    const served = this.servedOrg(org);
    const n = Number(number);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException(`bad project ${number}`);
    const detail = await this.projects.getProject(n, req.user, served);
    // Unknown in every org the read covered — which, without a `?org=`, is every
    // org this board serves. See `ProjectsService.detailInScope` for how a
    // number two orgs both hold is resolved.
    if (!detail) throw new NotFoundException(`unknown project ${number}`);
    return detail;
  }
}
