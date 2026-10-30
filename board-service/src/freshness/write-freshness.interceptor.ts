import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import type { Capability } from '../capability/capability';
import { WRITES_CAPABILITY } from '../capability/writes.decorator';
import { FreshnessRegistry } from './freshness.registry';

/** The verbs that read. `CapabilityGuard` exempts exactly these. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * After a Github write succeeds, declare every cached answer that described what
 * it wrote out of date (#692).
 *
 * The discriminator is the `@Writes(...)` metadata the route ALREADY carries for
 * `CapabilityGuard`, read the same way that guard reads it — so a write added
 * later, a comment above all, inherits this with no new wiring at the write's
 * end, and nothing here is a list of paths that can fall behind the routes.
 *
 * Three answers, three behaviours, and the middle one is the reason this is not
 * simply "any POST":
 *  - capabilities named: this route writes Github. Drop.
 *  - `@Writes()` with no arguments: a route's explicit "this writes no Github",
 *    which is what nine of the board's twenty write routes say. Drop NOTHING —
 *    a sign-out or a consent record invalidates no issue, and dropping the
 *    Projects rollup on it would cost a cold GraphQL rebuild for nothing.
 *  - ABSENT: not an answer. `CapabilityGuard` denies such a route before this
 *    runs, and this must not be the thing that gives it a meaning.
 *
 * On SUCCESS only. A refused or failed write changed nothing at Github, so the
 * cached answers still describe what is there.
 *
 * And on a WRITE verb only, the same set `CapabilityGuard` exempts: a GET is
 * what these caches exist to serve, and one that declared a capability would be
 * a route dropping the answer it is about to give.
 */
@Injectable()
export class WriteFreshnessInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(FreshnessRegistry) private readonly registry: FreshnessRegistry,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    if (READ_METHODS.has(String(req?.method ?? 'GET').toUpperCase())) return next.handle();
    // Handler beats class, and `undefined` ≠ `[]` — the same two rules
    // `CapabilityGuard` reads this metadata by.
    const declared = this.reflector.getAllAndOverride<Capability[] | undefined>(WRITES_CAPABILITY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!declared || declared.length === 0) return next.handle();
    // What was declared goes with it, so a cache that only some writes change
    // can tell which this was (#982).
    return next.handle().pipe(tap({ next: () => this.registry.invalidateAll(declared) }));
  }
}
