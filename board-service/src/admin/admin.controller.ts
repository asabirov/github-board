import { Controller, Delete, Get, Header, HttpCode, Inject, NotFoundException, Param, Query, Req, UseGuards } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { AccessModel, AdminAccessService } from './admin-access.service';
import { AgentsModel } from './agents';
import { AgentsService } from './agents.service';
import { RequiredScopes } from '../auth/required-scopes.decorator';
import { Writes } from '../capability/writes.decorator';
import { BOARD_ADMIN } from '../auth/scopes';
import { AuditService } from '../audit/audit.service';
import { AuditLog } from '../audit/audit.types';
import { WriteIdentity, WriteIdentityService } from '../sources/write-identity.service';

interface AuthedRequest {
  user?: { email?: string };
}

/**
 * The read-only admin-hub API (#11, #183). Global prefix 'api' → /api/admin/*.
 * Runs under the global chain (JwtAuthGuard → TeamAccessGuard) and then
 * AdminGuard, so an unauthenticated caller is 401, a non-admin teammate is 403,
 * and only an admin reaches the handler. no-store: an admin-scoped identity/
 * config response has no business in any shared cache.
 *
 * Every read declares @RequiredScopes(BOARD_ADMIN) (#471). AdminGuard asks
 * AdminAuthority.isAdminActor — is a person behind this caller, and is that
 * person's address in the admin set (#551) — and reads no scopes at all, while
 * RequiredScopesGuard defaults an undecorated GET to board:read, which every
 * personal access token carries. So without this the admin's read-only token read
 * the org's whole token inventory and audit log, and promoting somebody to admin
 * silently widened every token they already held.
 * Being an admin is now necessary but no longer sufficient: a token must also
 * have been minted with the admin scope. Humans carry no scopes at all and pass
 * RequiredScopesGuard untouched, so a signed-in admin is unaffected.
 *
 * The scope is declared PER ROUTE, not on the class: at class level it would also
 * land on the DELETE below, converting it from "denied to every scoped actor" (the
 * fail-closed default for an undecorated write) into "reachable by any board:admin
 * token" — a widening, not a narrowing. admin-scope.spec.ts pins both halves.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @Inject(AdminAccessService) private readonly access: AdminAccessService,
    @Inject(AgentsService) private readonly agents: AgentsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WriteIdentityService) private readonly writeIdentity: WriteIdentityService,
  ) {}

  @Get('access')
  @Header('Cache-Control', 'no-store')
  @RequiredScopes(BOARD_ADMIN)
  getAccess(): Promise<AccessModel> {
    return this.access.getModel();
  }

  @Get('agents')
  @Header('Cache-Control', 'no-store')
  @RequiredScopes(BOARD_ADMIN)
  getAgents(): Promise<AgentsModel> {
    return this.agents.getModel();
  }

  /**
   * DELETE /api/admin/agents/:id — admin revoke of any connected agent's token
   * (#211). AdminGuard is on the controller, so only an org admin reaches here.
   * 404 when no live token matched (already revoked / unknown id) — the caller
   * treats the agent as gone either way.
   */
  // Revokes a board token — no Github write.
  @Writes()
  @Delete('agents/:id')
  @HttpCode(204)
  async revokeAgent(@Param('id') id: string, @Req() req: AuthedRequest): Promise<void> {
    const revoked = await this.agents.revokeAgent(id);
    if (!revoked) throw new NotFoundException('no live agent token with that id');
    await this.audit.record({
      actorEmail: req.user?.email ?? 'unknown',
      action: 'agent.revoke',
      summary: `Revoked agent token ${id}`,
      targetType: 'agent',
      targetId: id,
    });
  }

  /**
   * GET /api/admin/audit — the read-only audit trail (#212). Optional filters
   * ?actor=<substring>&action=<key>.
   *
   * The rows come with `health` (#781), because an empty list has three causes
   * and an operator could not tell them apart: no database, nothing happened, or
   * Postgres is down and the writes went to Github anyway. The health rides this
   * response rather than its own endpoint so the answer and the caveat on it
   * cannot arrive out of step, or one without the other.
   *
   * That count is ONE INSTANCE'S, and says so since #812 — `instance` and
   * `since` name whose it is and from when, and `gaps` carries what the trail
   * itself records, which is the only half that survives a restart or reaches
   * across a second replica.
   */
  @Get('audit')
  @Header('Cache-Control', 'no-store')
  @RequiredScopes(BOARD_ADMIN)
  async getAudit(
    @Query('actor') actor?: string,
    @Query('action') action?: string,
  ): Promise<AuditLog> {
    // Health FIRST, and sequentially (#812): reading it is what writes any gap
    // marker this process is still carrying, so asking it before the list is
    // what puts that row in the rows this same response returns. The other order
    // — or a `Promise.all` — shows the operator a count with no row behind it
    // until they reload.
    const health = await this.audit.health();
    return { events: await this.audit.list({ actor, action }), health };
  }

  /**
   * GET /api/admin/write-identity — which Github account the board's OWN
   * no-person work goes out as (#756, narrowed by #892).
   *
   * It sits beside the audit trail because it is the other half of one question.
   * The trail answers "which person"; Github's timeline answers "which account".
   * Since #892 those are the SAME answer for anything a person asked for — their
   * own connected credential makes the write and Github names them — so what is
   * left for this route is the board acting as itself: the boot alert, the boot
   * warms, the detached login derivation. An operator who has just pointed
   * GITHUB_WRITE_TOKEN somewhere new had, before this, exactly one way to
   * confirm the swap: make a write and go look at Github. A write cannot be
   * taken back.
   *
   * It NEVER reports the calling admin's own connected account, and it must not
   * start to: `WriteIdentityService.resolve` detaches from the request's person
   * before it reads a credential, and `write-identity.person.spec.ts` is what
   * holds that true.
   *
   * Resolved ONCE per process and memoized (`WriteIdentityService`), so this
   * costs Github nothing per request. Answers `unknown` rather than failing when
   * Github is unreachable — a deployment fact nobody can read is a worse outcome
   * than a 500, but not by enough to justify one.
   *
   * Admin-scoped like every other read here. The login itself is public
   * information; the inventory of how this deployment is credentialed is not.
   */
  @Get('write-identity')
  @Header('Cache-Control', 'no-store')
  @RequiredScopes(BOARD_ADMIN)
  getWriteIdentity(): Promise<WriteIdentity> {
    return this.writeIdentity.resolve();
  }
}
