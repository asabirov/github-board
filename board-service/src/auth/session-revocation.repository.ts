import { Logger, type OnModuleInit } from '@nestjs/common';
import type { PrismaClient, Prisma } from '../generated/prisma/client';
import { SESSION_TTL_MS } from './cookies';

/**
 * Where sign-out revocations are kept (#679).
 *
 * Two gates, because one cannot express the other. `RevokedSession` names the one
 * session that was signed out, by jti. `SessionEpoch` names an instant per person
 * before which every session of theirs is dead — the answer to "a copy of my
 * cookie was taken before I signed out", where there is no jti to name because
 * nobody enumerated that session.
 *
 * The Prisma backend is chosen only when IDENTITY_SOURCE=db, following
 * `personal-token.repository.ts`. The memory backend is what dev and the
 * fixture-only tests run on, and it is NOT a silent fallback: it says at error
 * level, exactly what it costs, from its own CONSTRUCTOR — so the announcement
 * follows the object rather than the wiring, and a memory store built outside the
 * module (a default argument, a test) is as loud as the one Nest provides.
 */

export const SESSION_REVOCATION_STORE = 'SESSION_REVOCATION_STORE';

export interface SessionRevocationStore {
  /**
   * True when a revocation written here survives a restart. Read by the logout
   * controller to decide whether a failed write is worth reporting, and asserted
   * in tests so "durable" can never be a claim made only in prose.
   */
  readonly durable: boolean;
  /** Record one signed-out jti until `expiresAt`, and prune what has expired. */
  revoke(jti: string, expiresAt: Date, now: Date): Promise<void>;
  /**
   * Move this subject's cut-off FORWARD to `notBefore`, and prune dead epochs.
   * Forward only: an earlier instant leaves the stored one where it is, so a
   * clock that stepped backwards cannot revive sessions an earlier bump killed.
   */
  bumpEpoch(sub: string, notBefore: Date, now: Date): Promise<void>;
  /** Is this exact jti denied, and not yet past its own expiry? */
  isRevoked(jti: string, now: Date): Promise<boolean>;
  /** This subject's cut-off, or null when they have never signed out. */
  epochOf(sub: string): Promise<Date | null>;
}

/**
 * Postgres-backed store — the one that makes sign-out mean something after a
 * deploy.
 *
 * Pruning is opportunistic and rides on `revoke`, with no timer: a row is only
 * ever read by primary key, so an expired row that lingers costs storage rather
 * than correctness, and a timer would be a second thing to reason about in a
 * process that restarts constantly anyway. Epochs are pruned at
 * `now - SESSION_TTL_MS`, which is the point past which no session old enough to
 * fail that gate could still verify: `jose` has already refused it on `exp`.
 */
export class PrismaSessionRevocationStore implements SessionRevocationStore, OnModuleInit {
  readonly durable = true;
  private readonly logger = new Logger(PrismaSessionRevocationStore.name);

  constructor(private readonly prisma: PrismaClient) {}

  // `implements OnModuleInit`, because Nest duck-types this hook: renamed or
  // mistyped, it would simply never run and the boot line would vanish with
  // nothing failing. The interface turns that into a compile error.
  onModuleInit(): void {
    this.logger.log('session revocation is durable (Postgres) — sign-out survives a restart.');
  }

  async revoke(jti: string, expiresAt: Date, now: Date): Promise<void> {
    // Upsert rather than create: signing out twice with the same cookie is an
    // ordinary thing for a person to do, and a unique-key violation there would
    // report a revocation as failed when the session is, in fact, revoked.
    await this.prisma.revokedSession.upsert({
      where: { jti },
      create: { jti, expiresAt },
      update: { expiresAt },
    });
    // The prune is housekeeping and must not fail the revocation that carried it.
    // Sharing the caller's error path meant a committed upsert followed by a
    // failed delete reported the sign-out as unrecorded, and told the person their
    // cookie might still work when it demonstrably does not.
    await this.prune(
      this.prisma.revokedSession.deleteMany({ where: { expiresAt: { lte: now } } }),
      'expired revocations',
    );
  }

  async bumpEpoch(sub: string, notBefore: Date, now: Date): Promise<void> {
    // GREATEST, not a plain assignment: the epoch only ever moves FORWARD. An
    // update that took whatever the caller passed would let a clock behind the
    // stored value — an NTP step, a replica with skew, a retry carrying an older
    // instant — lower the cut-off and resurrect every session an earlier sign-out
    // killed. Raw SQL because Prisma's `upsert` cannot express a column read of
    // the row it is updating; `EXCLUDED` is the row that failed to insert.
    // `updatedAt` is set here because @updatedAt is client-side and no client is
    // involved in a raw write.
    await this.prisma.$executeRaw`
      INSERT INTO "SessionEpoch" ("sub", "notBefore", "updatedAt")
      VALUES (${sub}, ${notBefore}, NOW())
      ON CONFLICT ("sub") DO UPDATE
        SET "notBefore" = GREATEST("SessionEpoch"."notBefore", EXCLUDED."notBefore"),
            "updatedAt" = NOW()
    `;
    await this.prune(
      this.prisma.sessionEpoch.deleteMany({
        where: { notBefore: { lte: new Date(now.getTime() - SESSION_TTL_MS) } },
      }),
      'dead epochs',
    );
  }

  /**
   * Await a prune, and swallow its failure at warn level.
   *
   * The write it follows has already committed. Storage that a prune did not
   * reclaim costs storage; a prune failure raised to the caller costs a person a
   * true report about their own sign-out.
   */
  private async prune(deleting: Prisma.PrismaPromise<unknown>, what: string): Promise<void> {
    try {
      await deleting;
    } catch (err) {
      this.logger.warn(`could not prune ${what}: ${(err as Error).message}`);
    }
  }

  async isRevoked(jti: string, now: Date): Promise<boolean> {
    const row = await this.prisma.revokedSession.findUnique({ where: { jti } });
    // Expiry is compared here rather than in the where-clause so a row the prune
    // has not reached yet still answers correctly.
    return row != null && row.expiresAt.getTime() > now.getTime();
  }

  async epochOf(sub: string): Promise<Date | null> {
    const row = await this.prisma.sessionEpoch.findUnique({ where: { sub } });
    return row?.notBefore ?? null;
  }
}

/**
 * The no-database store. Correct within one process and worthless across a
 * restart, which is why it says so at ERROR level the moment it is constructed:
 * a reader must never be able to believe revocation is durable when it is not.
 *
 * It is not a fallback the Prisma store degrades into — the module picks one or
 * the other from configuration, and a Prisma store that cannot reach Postgres
 * reports the failure to its caller rather than quietly landing here.
 */
export class MemorySessionRevocationStore implements SessionRevocationStore {
  readonly durable = false;
  private readonly logger = new Logger(MemorySessionRevocationStore.name);
  private readonly denied = new Map<string, number>();
  private readonly epochs = new Map<string, number>();

  // In the constructor, not in `onModuleInit`: a hook only fires for an instance
  // Nest is wiring, and this class is also reachable as the default argument of
  // `SessionRevocationService`, which no module registers. Announcing on
  // construction means every instance says what it costs, however it was built.
  constructor() {
    this.logger.error(
      'session revocation is IN-MEMORY ONLY — a restart resurrects every signed-out session for up to 7 days. Set IDENTITY_SOURCE=db.',
    );
  }

  async revoke(jti: string, expiresAt: Date, now: Date): Promise<void> {
    this.denied.set(jti, expiresAt.getTime());
    for (const [key, exp] of this.denied) {
      if (exp <= now.getTime()) this.denied.delete(key);
    }
  }

  async bumpEpoch(sub: string, notBefore: Date, now: Date): Promise<void> {
    // Math.max is the twin of the Prisma store's GREATEST: forward only, so a
    // clock that went backwards cannot resurrect what an earlier sign-out killed.
    // The two implementations answer the same questions, and a test that passed
    // against one and not the other would be testing the fixture.
    this.epochs.set(sub, Math.max(this.epochs.get(sub) ?? 0, notBefore.getTime()));
    const floor = now.getTime() - SESSION_TTL_MS;
    for (const [key, at] of this.epochs) {
      if (at <= floor) this.epochs.delete(key);
    }
  }

  async isRevoked(jti: string, now: Date): Promise<boolean> {
    const exp = this.denied.get(jti);
    return exp != null && exp > now.getTime();
  }

  async epochOf(sub: string): Promise<Date | null> {
    const at = this.epochs.get(sub);
    return at == null ? null : new Date(at);
  }
}
