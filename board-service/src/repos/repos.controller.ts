import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { Writes } from '../capability/writes.decorator';
import { CapabilityRegistry } from '../capability/capability.registry';
import { guardWrite } from '../capability/write-envelope';
import { capabilityGuardEnforcing } from '../capability/guard-enforcing';
import { Viewer } from '../auth/feedback-visibility';
import { AuditService } from '../audit/audit.service';
import { ReposService } from './repos.service';
import { REPOS_SOURCE } from './repo.types';
import type { IReposSource, RepoOwner, RepoPageView, ReposHealthView, ReposView } from './repo.types';
import { githubOrgs } from '../config/github-orgs';

interface AuthedRequest {
  user?: Viewer;
}

/** One audit line for a `dri` write: what Github now records, plus what was
 *  asked for when that is a different thing. */
export function driSummary(full: string, asked: string | null, recorded: string | null): string {
  const landed = `Set ${full} DRI to ${recorded ?? 'nobody'}`;
  return recorded === asked ? landed : `${landed} (asked for ${asked ?? 'nobody'})`;
}

/**
 * Repos API (#472, write added #558). Global prefix 'api' → GET /api/repos.
 * Runs under the existing global chain (JwtAuthGuard → TeamAccessGuard): any
 * team member can read. The DRI write is human-only and gated by the same
 * fail-closed envelope every native write on this board shares — `guardWrite`,
 * which was three separate copies of one order until #584 merged them.
 */
@Controller('repos')
export class ReposController {
  constructor(
    @Inject(ReposService) private readonly repos: ReposService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CapabilityRegistry) private readonly registry: CapabilityRegistry,
    // Injected by TOKEN, like every other parameter here: tsx/esbuild emit no
    // `design:paramtypes`, so an inferred interface-typed parameter boots in dev
    // and crash-loops compiled.
    //
    // The controller holds the source only to ask it `servedOrgs` — which orgs
    // its map covers. That is a question the service does not expose and could
    // not answer more cheaply; every other read on this controller still goes
    // through `ReposService`.
    @Inject(REPOS_SOURCE) private readonly source: IReposSource,
  ) {}

  /**
   * #648 — the org gate this surface's reads run behind, and the org each read
   * is NARROWED to when one was asked for (#718).
   *
   * Returns the org to read in the SOURCE's own spelling, or `undefined` when
   * none was asked — which means every org the source serves, exactly as an
   * absent `?org=` always has. A named org this board does not serve is a 404,
   * decided here before anything reads. It has to be decided here: every row's
   * alert counts come from org-scoped Github reads (`GET
   * /orgs/{org}/dependabot|code-scanning|secret-scanning/alerts`) under one
   * shared token, so an org that reached a source unchecked would read a
   * stranger's security posture.
   *
   * The gate asks the SOURCE which orgs its map covers, and refuses every other
   * org. It does not re-derive that from config, because config is not what
   * decides: `servedOrgs` is the source's own answer, and the rows this route
   * serves came from exactly those orgs.
   *
   * PLURAL since #718, and the map really is plural now: the source fans every
   * read over every configured org, so a second org's repos are on this map and
   * admitting one is not admitting a stranger. What made it singular before was
   * that the map WAS one org wide — an argument about what had been read, and
   * it is spent.
   *
   * Narrowing, rather than validating and then serving everything, is the other
   * half of that. `?org=X` means X's repos; answering it with two orgs' rows is
   * the same class of lie this gate was written to prevent, and on `/health`
   * those rows are per-repo secret-scanning, dependabot and code-scanning
   * numbers — an org drawn a clean bill of health that nobody read for it.
   *
   * STILL NOT THE WRITE GATE BELOW, which answers a different question: *may a
   * write land in this org*. This gate asks the SOURCE what its map covers; the
   * write gate asks the owner scope. They can differ, because a map can be
   * missing an owner the scope allows. A request this gate refuses is not a
   * request the write path would have accepted either — the write route does not
   * read this map at all.
   *
   * Returning the CONFIGURED spelling rather than the caller's is load-bearing:
   * `?org=Acme` and `?org=acme` name one org, and a service keyed on
   * what the caller typed would filter on a spelling no row carries.
   *
   * A second refusal comes from BELOW this gate and is not its business: an org
   * this board serves whose repo listing failed on the current build answers
   * 503 from `ReposService`, because there is genuinely nothing to serve for it
   * and `200 {"repos":[]}` would say the org is empty. This gate's 404 says the
   * board does not cover that org at all; the 503 says it does and could not
   * read it. Two different facts, and a reader that got one for the other would
   * go looking in the wrong place.
   */
  private servedOrg(org?: unknown): string | undefined {
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
    const served = this.source.servedOrgs.find((o) => o.trim().toLowerCase() === folded);
    // `find` on an empty list is `undefined`, so a source serving NO org — an
    // operator who turned enumeration off — refuses every named org rather than
    // serving one it does not have. A blank `?org=` returned above as "none
    // asked" and never reaches this.
    if (!served) throw new NotFoundException(`unknown org ${asked}`);
    return served;
  }

  @Get()
  async list(@Query('org') org?: string): Promise<ReposView> {
    return this.repos.listRepos(this.servedOrg(org));
  }

  /**
   * GET /api/repos/health (#571) — the map's second piece: every repo's open
   * security alerts and its default branch's latest CI conclusion, keyed by the
   * same `owner/name` the rows carry, so the client joins the two on `full`.
   *
   * NOT the service-wide `/api/health` liveness probe, which answers whether
   * board-api is up. This one answers what the org's repos look like, has
   * nothing to say about this process, and reads under the same guard chain as
   * `GET /api/repos` — any team member. It is a read, so no HumanOnlyGuard.
   *
   * Split off `GET /api/repos` because these two reads are 14-17 s and 3.5 s
   * cold against the live org, against 1.3 s for the repo listing they were
   * blocking. Every repo on the map this answer was built from gets a row here
   * even when it is perfectly clean — the service keeps the two in step by
   * binding one to the other — because absence has to mean "not received yet",
   * never "nothing found".
   */
  @Get('health')
  async health(@Query('org') org?: string): Promise<ReposHealthView> {
    return this.repos.listHealth(this.servedOrg(org));
  }

  @Get('pr-flow')
  async prFlow(@Query('org') org?: string) {
    return this.repos.listPrFlow(this.servedOrg(org));
  }

  @Get('ci-spend')
  async ciSpend(@Query('org') org?: string) {
    return this.repos.listCiSpend(this.servedOrg(org));
  }

  /**
   * GET /api/repos/:owner/:name/page (#575) — everything one repo's own page
   * draws: its row off the map, its README, its pull-request flow, what its CI
   * cost, and its open issues.
   *
   * One endpoint rather than five, because a page that fetched its five parts
   * separately would draw itself five times and would have to decide, in the
   * client, what a missing part means. The three reads that can fail carry
   * their own state in the payload instead — a README that is absent and a
   * README that could not be read are different answers, and only one of them
   * is worth a retry (#582).
   *
   * Same guard chain as `GET /api/repos` — any team member. It is a read, so no
   * HumanOnlyGuard. A repo that is not on the map 404s from the service.
   *
   * Declared AFTER `health` so the literal route is matched first; `:owner` is a
   * single segment and could otherwise swallow it.
   */
  @Get(':owner/:name/page')
  async page(@Param('owner') owner: string, @Param('name') name: string): Promise<RepoPageView> {
    return this.repos.repoPage(owner, name);
  }

  /**
   * PATCH /api/repos/:owner/:repo/dri (#558) — set or clear (`login: null`)
   * a repo's owner. The allowed-login list AND whether the property may be
   * written at all come from `ownerWriteEnv()`: the same cached view the picker
   * reads whenever that view KNOWS the answer, and a fresh schema read when it
   * holds `unknown`, so a retry after a failed read can actually succeed
   * (#577). Route and client therefore agree except where the route is the
   * better informed of the two. Guard first
   * (404 → 400 → 503 → 403/502 → 400 → 403 → 401), then the write, then an
   * audit — matching every other native write on this board (#384). The
   * second 403 is #584's target rung: a refusal Github gave about THIS repo,
   * which the route-level guard could not see.
   */
  @Writes('repo.dri')
  @Patch(':owner/:repo/dri')
  @Header('Cache-Control', 'no-store')
  @UseGuards(HumanOnlyGuard)
  async setDri(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Body() body: { login: string | null },
    @Req() req: AuthedRequest,
  ): Promise<{ owner: RepoOwner | null }> {
    // The owners the acting person may write to: their own Github App grants,
    // or GITHUB_ORGS where no person is acting. Four per-surface keys used to
    // narrow this, and this route was keyed on `ISSUES_METRICS_ORG` while the
    // issue routes were keyed on `PROJECTS_OWNER`, so the two could not diverge
    // onto each other's orgs. All four are retired (#1209 part 4) and there is
    // one answer to key on, so there is nothing left to diverge.
    //
    // NOT the same question as the read gate above, which asks the source what
    // its MAP covers. This set may name an org the map does not hold — writing
    // to it is fine, because nothing here reads the map to do it.
    const allowedOwners = githubOrgs(this.config);
    const writesEnabled = this.config.get<boolean>('GITHUB_WRITE_ENABLED', false);
    // The CONFIGURED spelling of the org the request names, matched
    // case-insensitively because Github resolves owners that way — never the
    // caller's own string. `ownerWriteEnv` reads that org's `dri` schema from
    // Github (#649), so its argument aims an outward call, and no outward call
    // may be aimed by an unvalidated request parameter.
    const target = allowedOwners.find((o) => o.toLowerCase() === owner.toLowerCase());
    // The schema answer for THAT org. When the request names an org outside the
    // set there is nothing to read and nothing is read: the placeholder below is
    // never consulted, because `guardWrite`'s owner-pin rung runs first and
    // throws the 404. `repos.controller.spec.ts` proves the read never goes out,
    // which the 404 on its own would not.
    const { allowed, writability } = target
      ? // See the note on the route above: this is `listRepos()`'s cached answer
        // except when that answer is "the board could not find out", which is
        // served fresh.
        await this.repos.ownerWriteEnv(target)
      : { allowed: [], writability: 'unreadable' as const };
    const email = req.user?.email;
    guardWrite(
      { kind: 'repo', owner, name: repo, login: body.login, email },
      {
        allowedOwners,
        writesEnabled,
        allowed,
        writability,
        registry: this.registry,
        capability: 'repo.dri',
        // One switch for both halves of the capability check: reporting mode
        // has to mean the same thing here as it does in `CapabilityGuard`, so
        // both read it through the one accessor (#626).
        enforcing: capabilityGuardEnforcing(this.config),
      },
    );
    const full = `${owner}/${repo}`;
    const resolvedOwner = await this.repos.setDri(full, body.login);
    await this.audit.record({
      actorEmail: email!,
      action: 'repo.dri',
      // The OUTCOME, never the request. Github's record is what this write left
      // behind, and an audit row that names the ask would claim something that
      // may not have happened. The ask is kept only where the two differ, which
      // is the case worth being able to find later.
      summary: driSummary(full, body.login, resolvedOwner?.login ?? null),
      targetType: 'repo',
      targetId: full,
    });
    return { owner: resolvedOwner };
  }
}
