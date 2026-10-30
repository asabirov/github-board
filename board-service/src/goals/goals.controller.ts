import { Body, Controller, ForbiddenException, Get, Header, Inject, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminAuthority } from '../auth/admin-authority';
import type { AuthenticatedActor } from '../auth/static-agent';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { AdminGuard } from '../admin/admin.guard';
import { AuditService } from '../audit/audit.service';
import { Writes } from '../capability/writes.decorator';
import { githubPrincipal } from '../auth/github-principal';
import { githubOrgs } from '../config/github-orgs';
import { GoalsService, type GoalLevels } from './goals.service';

type Request = { user: AuthenticatedActor & { email: string } };

@Controller('goals')
@UseGuards(HumanOnlyGuard)
export class GoalsController {
  constructor(
    @Inject(GoalsService) private readonly goals: GoalsService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AdminAuthority) private readonly admin: AdminAuthority,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private subject(req: Request): string {
    if (!req.user.boardSub) throw new ForbiddenException('Sign in again to use your goals.');
    return req.user.boardSub;
  }

  private organisation(org: string) {
    const allowed = githubPrincipal()?.owners.find((owner) => owner.type === 'Organization' && owner.login.toLowerCase() === org.toLowerCase());
    if (!allowed || typeof allowed.id !== 'number' || !Number.isSafeInteger(allowed.id) || allowed.id <= 0) throw new ForbiddenException('This organisation is not available to you.');
    return { id: BigInt(allowed.id), login: allowed.login };
  }

  @Get('personal')
  @Header('Cache-Control', 'no-store')
  async personal(@Req() req: Request) {
    return { ...await this.goals.personal(this.subject(req)), editable: this.goals.enabled };
  }

  @Put('personal')
  @Writes()
  async savePersonal(@Req() req: Request, @Body() body: Partial<Record<keyof GoalLevels, unknown>> | null) {
    return { ...await this.goals.savePersonal(this.subject(req), body), editable: true };
  }

  @Get('organisations')
  @Header('Cache-Control', 'no-store')
  organisations() { return githubOrgs(this.config); }

  @Get('organisations/:org')
  @Header('Cache-Control', 'no-store')
  async team(@Req() req: Request, @Param('org') org: string) {
    const selected = this.organisation(org);
    return { ...await this.goals.team(selected.id), editable: this.goals.enabled && this.admin.isAdminActor(req.user) };
  }

  @Put('organisations/:org')
  @UseGuards(AdminGuard)
  @Writes()
  async saveTeam(@Req() req: Request, @Param('org') org: string, @Body() body: Partial<Record<keyof GoalLevels, unknown>> | null) {
    const selected = this.organisation(org);
    const levels = await this.goals.saveTeam(selected.id, body);
    await this.audit.record({ actorEmail: req.user.email, action: 'goal.team.update', summary: `Set ${selected.login} flame levels to ${levels.dailyGoal}, ${levels.level2Goal}, ${levels.level3Goal}`, targetType: 'organisation', targetId: String(selected.id) });
    return { ...levels, editable: true };
  }
}
