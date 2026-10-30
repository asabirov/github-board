import {
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  MemorySessionRevocationStore,
  SESSION_REVOCATION_STORE,
  type SessionRevocationStore,
} from './session-revocation.repository';
import { ACCESS_NOT_NOW_CODE } from './access-not-now';

/**
 * Sign-out revocation for the self-contained HS256 JWTs this board signs (#112,
 * durable since #679). Clearing the cookie leaves a captured copy usable as a
 * Bearer, so sign-out has to say the token is dead somewhere the guard reads.
 *
 * Two gates, and the second is the one that matters:
 *
 *  - the per-jti denylist kills the session that was presented.
 *  - the per-subject EPOCH kills every session that person holds, by refusing any
 *    session JWT issued before the bump. It is what answers "a copy of my cookie
 *    was taken before I signed out" — there is no jti to deny for a session nobody
 *    enumerated, and one row per person is bounded by headcount rather than by
 *    how many times anybody has signed in.
 *
 * Both gates read claims off a token this board signed, so both reach exactly the
 * credentials that carry one: browser sessions and MCP tokens. A `board_pat_`
 * personal access token carries neither jti nor iat, and the guard resolves it
 * against the PersonalToken table BEFORE session verification, so neither gate is
 * consulted and nothing here revokes one. That is deliberate: a PAT is an API key
 * its owner created on purpose, with its own expiry, listed and revoked in
 * Account. Signing out of a browser does not end it.
 *
 * Both live in Postgres when IDENTITY_SOURCE=db (`PrismaSessionRevocationStore`),
 * so a revocation survives the restart that board performs on nearly every merge
 * — which, at #677's seven-day sessions, is the difference between sign-out
 * meaning something and meaning nothing. With no database the store is the memory
 * one, which says at boot, at error level, that it cannot do that.
 *
 * `isRevoked` remains the in-memory view and the synchronous compatibility
 * surface: `revoke` writes the map before its first `await`, and four MCP specs
 * assert on it immediately after an unawaited `revoke`. It is NOT the authority
 * and must not be used to decide a request — it knows only what this process
 * revoked. `check` is what the guard calls, and it reads through to the store.
 *
 * Size, for the in-memory view only: entries are clamped to SESSION_TTL_MS, up to
 * seven days each. Measured (node 24, arm64, uuid keys): ~530 B an entry, prune()
 * O(n) on every revoke(). Three people at three sign-outs each, ~4 jtis a
 * sign-out: ~250 entries, 143 KB, 0.02 ms a prune. Request volume sets the real
 * ceiling, since POST /api/auth/github/logout is @Public(): 100k entries is
 * 49 MB and 0.65 ms a revoke, 1M is 486 MB and 11 ms. Filling through revoke()
 * is quadratic (40k revocations, 5.4 s of CPU), and since #677 that handler
 * lodges nothing without a board signature and a bounded jti.
 */
@Injectable()
export class SessionRevocationService {
  private readonly logger = new Logger(SessionRevocationService.name);
  private readonly denied = new Map<string, number>();

  /**
   * The store is optional with a default so the four `new SessionRevocationService()`
   * call sites under src/mcp keep working, and it is DECORATED because this repo
   * has already shipped an undecorated optional constructor param: board boots
   * fine under `tsx` and in CI, then crash-loops when run compiled, because the
   * emitted design:paramtypes metadata carries no token for it.
   */
  constructor(
    @Optional()
    @Inject(SESSION_REVOCATION_STORE)
    private readonly store: SessionRevocationStore = new MemorySessionRevocationStore(),
  ) {}

  /** True when a revocation written through this service survives a restart. */
  get durable(): boolean {
    return this.store.durable;
  }

  /**
   * Revoke a token by jti until `expEpochMs` (its own expiry, clamped by the
   * caller). No-op if empty.
   *
   * Returns false ONLY when a durable store was configured and refused the write
   * — the one case where a caller would otherwise be told a revocation landed
   * when it has not. It never rejects: production revokes this UNAWAITED
   * (mcp-oauth.provider.ts, connected-clients.controller.ts), and an unhandled
   * rejection there would take the process down.
   */
  async revoke(
    jti: string | undefined,
    expEpochMs: number,
    now: number = Date.now(),
  ): Promise<boolean> {
    if (!jti) return true;
    // Before the first `await`, deliberately: unawaited callers assert on
    // `isRevoked` in the very next statement, and an async body runs
    // synchronously up to its first suspension.
    this.prune(now);
    this.denied.set(jti, expEpochMs);
    try {
      await this.store.revoke(jti, new Date(expEpochMs), new Date(now));
      return true;
    } catch (err) {
      this.logger.error(`durable revocation failed for jti: ${(err as Error).message}`);
      return !this.store.durable;
    }
  }

  /**
   * Kill every session this subject holds by moving their epoch to `atEpochMs`.
   *
   * Same contract as `revoke`: false only when a durable store refused, never a
   * rejection.
   */
  async bumpEpoch(
    sub: string | undefined,
    atEpochMs: number = Date.now(),
    now: number = Date.now(),
  ): Promise<boolean> {
    if (!sub) return true;
    try {
      await this.store.bumpEpoch(sub, new Date(atEpochMs), new Date(now));
      return true;
    } catch (err) {
      this.logger.error(`epoch bump failed: ${(err as Error).message}`);
      return !this.store.durable;
    }
  }

  /**
   * Is this session dead — by its own jti, or by its owner's epoch?
   *
   * This is the authority, and the guard's only question. Two primary-key reads,
   * issued together: no cache and no boot-time hydration, so correctness does not
   * rest on an assumption about how many replicas are running or how long one has
   * been up.
   *
   * Unlike `revoke` and `bumpEpoch` above, a store failure here REFUSES the
   * request rather than being reported to the caller, and the asymmetry is the
   * design. Those two run after the cookie has already cleared, where throwing
   * would take a person's own sign-out down with the database; this one decides
   * whether a request is admitted, and a store that cannot answer "is this session
   * dead?" has not answered "no". So the error is caught only to be named — logged
   * once, then rethrown as a 503 rather than left to surface as a bare 500 from
   * whatever Prisma raised. Returning false here instead would admit every revoked
   * session the moment Postgres wobbled, with every other test in this file still
   * green, so `jwt-auth.guard.spec.ts` holds one that goes red on exactly that
   * edit.
   *
   * The epoch compares second-granularity `iat` against a millisecond instant, so
   * a sign-in completing inside the same wall-clock second as a bump would be
   * killed. Unreachable in the real flow: a full GitHub OAuth round-trip sits
   * between pressing Sign out and holding a newer cookie. Killing is the safe
   * side of that boundary in any case.
   */
  async check(
    jti: string | undefined,
    sub: string | undefined,
    iatSeconds: number | undefined,
    now: number = Date.now(),
  ): Promise<boolean> {
    const at = new Date(now);
    let revoked: boolean;
    let epoch: Date | null;
    try {
      [revoked, epoch] = await Promise.all([
        jti ? this.store.isRevoked(jti, at) : Promise.resolve(false),
        sub ? this.store.epochOf(sub) : Promise.resolve(null),
      ]);
    } catch (err) {
      this.logger.error(`session revocation is unreadable: ${(err as Error).message}`);
      throw new ServiceUnavailableException({ message: 'The board cannot confirm your sign-in right now. Try again in a moment.', code: ACCESS_NOT_NOW_CODE });
    }
    if (revoked) return true;
    // A token with no `iat` predates the claim being read here, and cannot be
    // placed against an epoch. It is left to the jti gate rather than guessed at.
    if (epoch == null || iatSeconds == null) return false;
    return iatSeconds * 1000 < epoch.getTime();
  }

  /**
   * The in-memory view of the denylist: what THIS process revoked, nothing more.
   * The dev/no-DB answer and the compatibility surface the MCP specs assert on —
   * synchronous by contract. `check` is the authority; do not gate a request on
   * this.
   */
  isRevoked(jti: string | undefined, now: number = Date.now()): boolean {
    if (!jti) return false;
    const exp = this.denied.get(jti);
    if (exp == null) return false;
    if (exp <= now) {
      this.denied.delete(jti);
      return false;
    }
    return true;
  }

  /** Drop every entry of the in-memory view past its expiry. */
  prune(now: number = Date.now()): void {
    for (const [jti, exp] of this.denied) {
      if (exp <= now) this.denied.delete(jti);
    }
  }

  /** Current in-memory denylist size (introspection / tests). */
  get size(): number {
    return this.denied.size;
  }
}
