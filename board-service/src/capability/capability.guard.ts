import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Capability } from './capability';
import { CapabilityRegistry } from './capability.registry';
import { capabilityGuardEnforcing } from './guard-enforcing';
import type { RefusalBody, RefusalReason } from './github-refusal';
import { WRITES_CAPABILITY } from './writes.decorator';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Capability gate (#584). A non-GET route must declare, via @Writes(), which
 * Github capabilities it needs of the BOARD'S credential — and the board must
 * not already know the credential lacks one.
 *
 * Four properties mirrored from RequiredScopesGuard (required-scopes.guard.ts):
 *  - method-aware: GET/HEAD/OPTIONS pass, the default is keyed on the verb and
 *    never on a path list;
 *  - getAllAndOverride([handler, class]) — a handler beats its class;
 *  - `undefined` ≠ `[]` — only ABSENT metadata fails closed;
 *  - an explicit empty declaration is a real answer.
 *
 * ONE DELIBERATE DIFFERENCE: there is no actor escape hatch.
 * RequiredScopesGuard returns true at its first line for a caller with no
 * scopes, because the scopes it checks belong to the caller. The capability
 * this checks belongs to the board, so a human is refused exactly as an agent
 * is. A person cannot lend the board a permission it does not have.
 *
 * ONE DELIBERATE LIMIT: it reads `state(cap)` with NO target, so only a
 * CREDENTIAL-WIDE refusal reaches it. It has the route and nothing else — the
 * owner and repo are path parameters the handler binds. A per-target refusal is
 * enforced by the write envelope (task 9), which has them as arguments.
 *
 * `unknown` NEVER refuses. An unattempted capability is not a refusal, and the
 * first write after a restart is what teaches the registry.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  private readonly logger = new Logger(CapabilityGuard.name);
  private readonly enforcing: boolean;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(CapabilityRegistry) private readonly registry: CapabilityRegistry,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {
    // Through the one accessor (#626), which owns the fallback and the argument
    // for it — see `guard-enforcing.ts`.
    this.enforcing = capabilityGuardEnforcing(config);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (READ_METHODS.has(String(req.method ?? 'GET').toUpperCase())) return true;

    const declared = this.reflector.getAllAndOverride<Capability[] | undefined>(WRITES_CAPABILITY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (declared === undefined) {
      return this.deny(
        `undecorated write route (${req.method} ${req.url}) has no @Writes`,
        'This write route does not declare what it writes; it is denied by default',
      );
    }

    for (const cap of declared) {
      const v = this.registry.state(cap);
      if (v.state === 'refused') {
        return this.deny(
          `${cap} — ${v.why ?? 'refused'} (${v.source})`,
          v.publicMessage ?? `The board is not permitted to do this (${cap}).`,
          // The verdict's OWN reason and link, not a hardcoded 'not-permitted'.
          // A `not-permitted-yet` served from the registry during its one-minute
          // life must reach the person as `not-permitted-yet` with the SSO link
          // still attached; hardcoding here would downgrade it to a refusal
          // nobody can act on, which is the whole point of the reason existing.
          v.reason ?? 'not-permitted',
          v.authorizeUrl ?? undefined,
        );
      }
    }
    return true;
  }

  /** The whole difference between task 6 and task 8. `why` is logged;
   *  `publicMessage`, `reason` and `authorizeUrl` are what reach a client, and
   *  they are the same three fields `refusalToHttp` sends, so the frontend's
   *  `describeEditFailure` reads a guard refusal exactly as it reads a source
   *  refusal. */
  private deny(
    why: string,
    publicMessage: string,
    reason: RefusalReason = 'not-permitted',
    authorizeUrl?: string,
  ): boolean {
    if (!this.enforcing) {
      this.logger.warn(`Capability would have been refused: ${why}`);
      return true;
    }
    this.logger.warn(`Capability denied: ${why}`);
    const body: RefusalBody = { message: publicMessage, reason };
    if (authorizeUrl) body.authorizeUrl = authorizeUrl;
    throw new ForbiddenException(body);
  }
}
