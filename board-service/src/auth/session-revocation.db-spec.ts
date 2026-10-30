import { createPrismaClient } from '../prisma';
import { afterAll, describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SessionRevocationService } from './session-revocation.service';
import { PrismaSessionRevocationStore } from './session-revocation.repository';
import { InMemoryMcpGrantRepository } from '../mcp/mcp-grant.repository';
import { SESSION_TTL_MS } from './cookies';

/**
 * Durable sign-out against real Postgres (#679).
 *
 * `jwt-auth.guard.spec.ts` proves the same two properties over the memory store,
 * which is the seam and not the thing that ships. What it cannot answer is
 * whether the migration applies, whether the two primary-key reads are the right
 * SQL, or whether a row written by one process is found by the next — and "the
 * next process" is the entire point of this issue, since board redeploys on
 * nearly every merge and #677 made a session last seven days.
 *
 * Every test builds a SECOND service over the same Postgres store and asks the
 * GUARD through that one. The second instance is the restart: a fresh in-memory
 * map, a store that remembers.
 */

const prisma = createPrismaClient();
const store = new PrismaSessionRevocationStore(prisma);
/** Owns this file's rows, so teardown can find them and nothing else's. */
const tag = `revocation-db-spec-${process.pid}-${Date.now()}`;
const HOUR = 3_600_000;

function guardOver(
  revocation: SessionRevocationService,
  session: { sub: string; jti?: string; iat?: number },
): { canActivate: () => Promise<boolean> } {
  const config = {
    get: (key: string, def?: unknown) => (key === 'AUTH_DISABLED' ? false : def),
  } as unknown as ConfigService;
  const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
  const google = {
    verifySession: async () => ({ email: `${session.sub}@example.com`, ...session }),
  } as never;
  const personalTokens = { verify: async () => null } as never;
  const guard = new JwtAuthGuard(
    config,
    reflector,
    google,
    revocation,
    personalTokens,
    new InMemoryMcpGrantRepository(),
  );
  const req = { headers: { authorization: 'Bearer eyJhbGciOi.session.jwt' }, path: '/api/board' };
  const res = { setHeader: () => {} };
  const context = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => null,
    getClass: () => null,
  } as never;
  return { canActivate: () => guard.canActivate(context) };
}

describe('durable sign-out against Postgres (#679)', () => {
  afterAll(async () => {
    await prisma.revokedSession.deleteMany({ where: { jti: { startsWith: tag } } });
    await prisma.sessionEpoch.deleteMany({ where: { sub: { startsWith: tag } } });
    await prisma.$disconnect();
  });

  it('rejects at the guard a jti revoked by a service instance that is gone', async () => {
    const jti = `${tag}-signed-out`;
    expect(await new SessionRevocationService(store).revoke(jti, Date.now() + HOUR)).toBe(true);

    const afterRestart = new SessionRevocationService(store);
    expect(afterRestart.isRevoked(jti)).toBe(false); // the new process remembers nothing

    await expect(
      guardOver(afterRestart, { sub: `${tag}-u1`, jti }).canActivate(),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('still accepts a session nobody revoked, through that same instance', async () => {
    const afterRestart = new SessionRevocationService(store);
    await expect(
      guardOver(afterRestart, { sub: `${tag}-u1`, jti: `${tag}-never-revoked` }).canActivate(),
    ).resolves.toBe(true);
  });

  it('rejects a cookie issued before the epoch bump and accepts one issued after', async () => {
    const sub = `${tag}-u2`;
    const at = Math.floor(Date.now() / 1000) * 1000; // a whole second, so `iat` is comparable
    expect(await new SessionRevocationService(store).bumpEpoch(sub, at)).toBe(true);
    const afterRestart = new SessionRevocationService(store);

    const older = { sub, jti: `${tag}-older`, iat: at / 1000 - 1 };
    await expect(guardOver(afterRestart, older).canActivate()).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const newer = { sub, jti: `${tag}-newer`, iat: at / 1000 + 1 };
    await expect(guardOver(afterRestart, newer).canActivate()).resolves.toBe(true);
  });

  /**
   * The same-second boundary, against the real column. `iat` is seconds and the
   * stored instant is a millisecond one, so a session minted in the same second
   * as a bump 500 ms into it is killed. Unreachable in the real flow — a full
   * Google OAuth round-trip sits between the two — and killing is the safe side.
   */
  it('kills a same-second session on a mid-second bump, and spares an exact tie', async () => {
    const second = Math.floor(Date.now() / 1000);
    const mid = `${tag}-u3`;
    await new SessionRevocationService(store).bumpEpoch(mid, second * 1000 + 500);
    await expect(
      guardOver(new SessionRevocationService(store), {
        sub: mid,
        jti: `${tag}-mid`,
        iat: second,
      }).canActivate(),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const tie = `${tag}-u4`;
    await new SessionRevocationService(store).bumpEpoch(tie, second * 1000);
    await expect(
      guardOver(new SessionRevocationService(store), {
        sub: tie,
        jti: `${tag}-tie`,
        iat: second,
      }).canActivate(),
    ).resolves.toBe(true);
  });

  it('bumps one subject only — a sign-out is not a sign-out for the team', async () => {
    const mine = `${tag}-u5`;
    const theirs = `${tag}-u6`;
    await new SessionRevocationService(store).bumpEpoch(mine, Date.now());
    await expect(
      guardOver(new SessionRevocationService(store), {
        sub: theirs,
        jti: `${tag}-theirs`,
        iat: Math.floor(Date.now() / 1000) - 3600,
      }).canActivate(),
    ).resolves.toBe(true);
  });

  it('prunes expired rows on the next revoke, and keeps the live one', async () => {
    const dead = `${tag}-dead`;
    const live = `${tag}-live`;
    const s = new SessionRevocationService(store);
    // Already past its expiry when written, so the very next revoke sweeps it.
    await s.revoke(dead, Date.now() - 1_000);
    await s.revoke(live, Date.now() + HOUR);
    expect(await prisma.revokedSession.findUnique({ where: { jti: dead } })).toBeNull();
    expect(await prisma.revokedSession.findUnique({ where: { jti: live } })).not.toBeNull();
  });

  it('signing out twice with the same cookie is not a failure', async () => {
    // A person pressing Sign out on a stale tab does exactly this. A plain
    // `create` would raise a unique-key violation, and the handler would report a
    // revocation as refused while the row sat there, revoked.
    const jti = `${tag}-twice`;
    const s = new SessionRevocationService(store);
    expect(await s.revoke(jti, Date.now() + HOUR)).toBe(true);
    expect(await s.revoke(jti, Date.now() + HOUR)).toBe(true);
  });

  it('answers false for a row it has not swept yet but which has expired', async () => {
    // Written with `now` before the expiry, so the opportunistic prune leaves it
    // in place: the read has to compare the expiry itself, or a week-old row
    // would keep refusing a session minted after it.
    const jti = `${tag}-stale`;
    const expired = new Date(Date.now() - 1_000);
    await store.revoke(jti, expired, new Date(Date.now() - 10_000));
    expect(await prisma.revokedSession.findUnique({ where: { jti } })).not.toBeNull();
    expect(await store.isRevoked(jti, new Date())).toBe(false);
  });

  it('prunes epochs older than one whole session lifetime', async () => {
    // Past that point no session old enough to fail the gate can still verify —
    // `jose` has already refused it on `exp` — so the row is only storage.
    const ancient = `${tag}-ancient`;
    await store.bumpEpoch(ancient, new Date(Date.now() - SESSION_TTL_MS - 60_000), new Date());
    expect(await prisma.sessionEpoch.findUnique({ where: { sub: ancient } })).toBeNull();

    const recent = `${tag}-recent`;
    await store.bumpEpoch(recent, new Date(Date.now() - 60_000), new Date());
    expect(await prisma.sessionEpoch.findUnique({ where: { sub: recent } })).not.toBeNull();
  });

  /**
   * The epoch moves forward only, and against the real SQL: `GREATEST` on the
   * conflict path is what makes that true, and a plain `update: { notBefore }`
   * would pass every other test in this file. A clock that stepped backwards —
   * NTP, a replica with skew, a retry carrying an older instant — would otherwise
   * lower the cut-off and revive every session the earlier sign-out killed.
   */
  it('never lowers an epoch: a bump with an older instant leaves the later one standing', async () => {
    const sub = `${tag}-u7`;
    const second = Math.floor(Date.now() / 1000);
    const later = second * 1000;
    const earlier = later - 3_600_000;
    const s = new SessionRevocationService(store);

    expect(await s.bumpEpoch(sub, later)).toBe(true);
    expect(await s.bumpEpoch(sub, earlier)).toBe(true); // accepted, and ignored
    expect((await store.epochOf(sub))!.getTime()).toBe(later);

    // Said as the guard asks it: a session from between the two instants stays
    // dead. Under a plain assignment it would be admitted again.
    await expect(
      guardOver(new SessionRevocationService(store), {
        sub,
        jti: `${tag}-between`,
        iat: second - 60,
      }).canActivate(),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reports itself durable, which is what the sign-out handler branches on', () => {
    expect(new SessionRevocationService(store).durable).toBe(true);
  });
});
