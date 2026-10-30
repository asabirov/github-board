import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { isStaticAgent } from './static-agent';

/**
 * Closes a route to static `BOARD_AGENT_TOKENS` actors (#482). Everyone else —
 * a signed-in human, a personal access token — passes, because each of those is
 * a person who already sees the data in the board. An MCP session never arrives:
 * a scope-bearing token is rejected on any path but `/mcp` (`jwt-auth.guard.ts`,
 * #458), so it is unaffected here because it cannot reach this guard, not
 * because the guard admits it.
 *
 * For routes serving data that belongs to somebody outside the team, where a
 * redacted payload would be worth nothing: the feedback stream is end users
 * writing to us, so their address and their words are the whole of it. Runs
 * after the global JwtAuthGuard has set `req.user`.
 */
@Injectable()
export class NoStaticAgentGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ user?: { agent?: boolean; staticAgent?: boolean; email?: string } }>();
    // No user means JwtAuthGuard did not run, which is a guard regression rather
    // than a caller. Refuse: `isStaticAgent` answers false for an absent user —
    // correct where TeamAccessGuard uses it, since true there would bypass the
    // group check — but here false means "allow", so the absent case is spelled
    // out instead of inherited.
    if (!req.user?.email) {
      throw new UnauthorizedException('No session');
    }
    if (isStaticAgent(req.user)) {
      throw new ForbiddenException(
        'This route serves other people\'s personal data and is closed to static agent tokens. ' +
          'Use a personal access token, which carries the identity of the person accountable for the read.',
      );
    }
    return true;
  }
}
