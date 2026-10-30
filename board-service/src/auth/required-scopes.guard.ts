import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRED_SCOPES } from './required-scopes.decorator';
import { BOARD_READ } from './scopes';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Declarative scope gate (#56). A scoped/programmatic actor (req.user.scopes is
 * set by JwtAuthGuard) must hold every scope a route declares via
 * @RequiredScopes(). An explicit @RequiredScopes(...) — including the empty
 * @RequiredScopes() "no requirement" form — always overrides the default,
 * for both reads and writes.
 *
 * The DEFAULT for an undecorated route is method-aware and fail-closed:
 *  - GET/HEAD/OPTIONS default to requiring board:read (any data access needs
 *    read).
 *  - Any other method (POST/PATCH/PUT/DELETE/...) defaults to DENY for scoped
 *    actors: a write route is reachable by a scoped actor only when it
 *    EXPLICITLY declares a scope that actor holds. This closes the regression
 *    where static agent tokens (which always carry board:read) could reach
 *    every undecorated write route once AgentScopeGuard's blanket path-deny
 *    was removed.
 *
 * Humans (no req.user.scopes) and public routes pass through immediately —
 * their authority is governed by TeamAccessGuard / AdminGuard / DRI checks.
 * Runs after TeamAccessGuard, replacing AgentScopeGuard's path logic.
 */
@Injectable()
export class RequiredScopesGuard implements CanActivate {
  private readonly logger = new Logger(RequiredScopesGuard.name);

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user as { sub?: string; scopes?: string[] } | undefined;
    // Human or public: not scope-limited here.
    if (!user?.scopes) return true;

    const declared = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRED_SCOPES,
      [context.getHandler(), context.getClass()],
    );

    if (declared === undefined) {
      const method = String(req.method ?? 'GET').toUpperCase();
      if (!READ_METHODS.has(method)) {
        this.logger.warn(
          `Scope denied for ${user.sub}: undecorated write route (${method}) has no explicit @RequiredScopes`,
        );
        throw new ForbiddenException(
          'This write route has no declared scope requirement; scoped actors are denied by default',
        );
      }
    }

    const required = declared ?? [BOARD_READ];
    const missing = required.filter((s) => !user.scopes!.includes(s));
    if (missing.length === 0) return true;

    this.logger.warn(`Scope denied for ${user.sub}: missing ${missing.join(',')}`);
    throw new ForbiddenException(`Missing required scope(s): ${missing.join(', ')}`);
  }
}
