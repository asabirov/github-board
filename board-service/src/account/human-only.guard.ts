import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { isHumanSession } from '../auth/human-session';

/**
 * Restricts a route to signed-in HUMANS — a scoped actor (a static agent token
 * or a personal access token) is rejected. Token self-management must never be
 * reachable by a token, so a leaked token can't mint more tokens or enumerate
 * its owner's others. Runs after the global JwtAuthGuard has set `req.user`.
 * (Writes are already fail-closed for scoped actors by RequiredScopesGuard; this
 * additionally closes the GET list route, which board:read alone would allow.)
 */
@Injectable()
export class HumanOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: { scopes?: string[] } }>();
    if (!isHumanSession(req.user)) {
      throw new ForbiddenException('Token management is available to signed-in users only.');
    }
    return true;
  }
}
