import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ADMINS_UNREAD_CODE, ADMINS_UNREAD_REFUSAL, AdminAuthority } from '../auth/admin-authority';
import type { AuthenticatedActor } from '../auth/static-agent';

/**
 * Admin-only gate for the Access panel (#11). The global chain has already run
 * by the time this fires: JwtAuthGuard populated `req.user` (an unauthenticated
 * caller is 401 before reaching here) and TeamAccessGuard confirmed group
 * membership. This adds the last narrowing — the caller must be an admin, or it
 * is 403.
 *
 * Who that is, is not this guard's to decide. `AdminAuthority.isAdminActor` is
 * the board's one answer, and this asks it: a person holding a board-assigned
 * `admin` role (#332 — roles are decoupled from Google-group ownership, which
 * the group no longer confers), or, only while zero such roles exist, a person
 * in the dormant `BOARD_ADMIN_EMAILS` break-glass (#371). A static
 * `BOARD_AGENT_TOKENS` actor is refused whatever the admin set contains,
 * because no person is behind it (#546); a personal access token and an MCP
 * agent-scoped session carry a real person's address and are judged like any
 * other caller.
 *
 * Asking the authority rather than restating it is the point (#551). This guard
 * used to test the address alone while `/api/auth/me` composed personhood at its
 * own call site, so the board reported one thing and enforced another. Adding a
 * second personhood test here — stacking `NoStaticAgentGuard`, say — would have
 * closed the hole and left the two answers separately computed, free to drift
 * again. Both surfaces now read the same method.
 *
 * The scope layer is a separate gate and stays that way: every admin read
 * declares `@RequiredScopes(BOARD_ADMIN)` and RequiredScopesGuard (global, so it
 * runs first) answers on the token's scopes. Being an admin is necessary, not
 * sufficient; neither refusal depends on the other.
 *
 * Applied per-controller via @UseGuards, never globally: it must gate only the
 * admin surface, not the whole app.
 *
 * Two refusals, not one (#811). A caller the board has judged and rejected gets
 * `403 admin access required`, as before. A caller the board could not judge —
 * because its admin roster has never been read, which on a `db` board with
 * Postgres down from boot is every caller — gets `503` and a sentence saying so.
 * Nobody is let in that was not let in before; `AdminAuthority.adminRefusal`
 * decides which of the two it is, and the break-glass still stays disarmed on an
 * unread roster (#588). What changes is that the one page carrying the
 * lost-record count (#781) stops telling an operator they are not an admin when
 * what actually happened is that the board cannot say who is.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(AdminAuthority) private readonly access: AdminAuthority) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedActor }>();
    const refusal = this.access.adminRefusal(req.user);
    if (refusal === null) return true;
    if (refusal === 'admins-unread') {
      // 503, not 403, and the body carries a code the pane matches on. A generic
      // 503 from an ingress or a proxy means something else entirely, and a pane
      // that drew this sentence for any of them would name an outage board has
      // not observed.
      throw new ServiceUnavailableException({
        message: ADMINS_UNREAD_REFUSAL,
        code: ADMINS_UNREAD_CODE,
      });
    }
    throw new ForbiddenException('admin access required');
  }
}
