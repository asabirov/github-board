import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { McpGrantRepository } from './mcp-grant.repository';

/**
 * One suite, run against both implementations of McpGrantRepository (#456) — the
 * Prisma store against a real Postgres in `mcp-grant.repository.db-spec.ts`, the
 * in-memory test seam in `mcp-grant.repository.spec.ts`. The seam exists so the
 * provider's own specs can exchange codes with no database in sight, and a seam
 * that answers differently from the store is worse than no seam at all: every
 * test above it would then be proving something about a thing that never runs.
 *
 * This file is a helper rather than a spec — it defines no tests when imported,
 * so vitest's `src/**\/*.spec.ts` pattern deliberately does not collect it.
 */

/** What a runner hands the suite: a repository, a namespace, and a teardown. */
export interface RepositoryUnderTest {
  repo: McpGrantRepository;
  /**
   * Every grant the suite creates carries this on `sub`. The child tables have no
   * `sub` column, so teardown finds the grants by this prefix and deletes their
   * rows by `grantId` — cleanup routes through the grant, never through `sub`.
   */
  subPrefix: string;
  cleanup(): Promise<void>;
}

const HOUR_MS = 3_600_000;

export function describeMcpGrantRepository(label: string, setup: () => Promise<RepositoryUnderTest>): void {
  describe(label, () => {
    let repo: McpGrantRepository;
    let subPrefix: string;
    let cleanup: () => Promise<void>;
    let seq = 0;

    beforeAll(async () => {
      const under = await setup();
      repo = under.repo;
      subPrefix = under.subPrefix;
      cleanup = under.cleanup;
    });

    afterAll(async () => {
      await cleanup();
    });

    /** A subject of this suite's own, so tests never collide with each other. */
    const nextSub = () => `${subPrefix}-${++seq}`;

    const grantFor = (sub: string, currentRefreshHash?: string) =>
      repo.createGrant({
        sub,
        email: `${sub}@example.test`,
        clientId: 'client-under-test',
        scopes: ['board:read'],
        currentRefreshHash,
      });

    it('rotateRefreshPointer lets exactly one of two concurrent callers win', async () => {
      const grant = await grantFor(nextSub(), 'h1');

      const [a, b] = await Promise.all([
        repo.rotateRefreshPointer(grant.id, 'h1', 'h2', new Date()),
        repo.rotateRefreshPointer(grant.id, 'h1', 'h3', new Date()),
      ]);

      // Not "one of them is true" — exactly one, so a store that let both through
      // fails here rather than reading as a pass on whichever ran first.
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(['h2', 'h3']).toContain((await repo.findGrant(grant.id))!.currentRefreshHash);
    });

    it('rotateRefreshPointer refuses a stale expectedHash and leaves the pointer where it was', async () => {
      const grant = await grantFor(nextSub(), 'current');

      const won = await repo.rotateRefreshPointer(grant.id, 'stale', 'attempted', new Date());

      expect(won).toBe(false);
      // Re-read rather than trust the return value: a method that moved the
      // pointer anyway and returned false would pass on the assertion above.
      expect((await repo.findGrant(grant.id))!.currentRefreshHash).toBe('current');
    });

    it('revokeGrant sweeps access rows so findLiveAccessToken stops returning them', async () => {
      const grant = await grantFor(nextSub());
      const now = new Date();
      const jti = `${grant.id}-live`;
      await repo.recordAccessToken({ jti, grantId: grant.id, expiresAt: new Date(now.getTime() + HOUR_MS) });

      // Non-null before, null after. Asserting only the "after" state would pass
      // equally against a lookup that always returned null.
      expect(await repo.findLiveAccessToken(jti, now)).not.toBeNull();
      const live = await repo.revokeGrant(grant.id, now);
      expect(live.map((t) => t.jti)).toEqual([jti]);
      expect(await repo.findLiveAccessToken(jti, now)).toBeNull();
    });

    it('findLiveAccessToken refuses an expired row whose revokedAt is still null', async () => {
      const grant = await grantFor(nextSub());
      const now = new Date();
      const jti = `${grant.id}-expired`;
      await repo.recordAccessToken({ jti, grantId: grant.id, expiresAt: new Date(now.getTime() - HOUR_MS) });

      expect(await repo.findLiveAccessToken(jti, now)).toBeNull();
      // The expiry branch alone did that — nothing revoked this row.
      expect((await repo.findAccessTokenAny(jti))!.revokedAt).toBeNull();
    });

    it('findAccessTokenAny still returns that same expired row, so /revoke can find it', async () => {
      const grant = await grantFor(nextSub());
      const now = new Date();
      const jti = `${grant.id}-expired-any`;
      await repo.recordAccessToken({ jti, grantId: grant.id, expiresAt: new Date(now.getTime() - HOUR_MS) });

      // The pair is what stops the two lookups being silently identical: one
      // input, opposite answers.
      expect(await repo.findLiveAccessToken(jti, now)).toBeNull();
      expect((await repo.findAccessTokenAny(jti))!.jti).toBe(jti);
    });

    it('revokeGrantForOwner tells a stranger apart from an owner with nothing live left', async () => {
      const owner = nextSub();
      const stranger = nextSub();
      const now = new Date();

      const someoneElses = await grantFor(owner);
      const liveJti = `${someoneElses.id}-live`;
      await repo.recordAccessToken({ jti: liveJti, grantId: someoneElses.id, expiresAt: new Date(now.getTime() + HOUR_MS) });

      // Null, not []: no live grant with that id belongs to the stranger.
      expect(await repo.revokeGrantForOwner(someoneElses.id, stranger, now)).toBeNull();
      // And the refusal wrote nothing — it decided before touching a row.
      expect(await repo.findLiveAccessToken(liveJti, now)).not.toBeNull();
      expect((await repo.findGrant(someoneElses.id))!.revokedAt).toBeNull();

      const mine = await grantFor(owner);
      await repo.recordAccessToken({
        jti: `${mine.id}-expired`,
        grantId: mine.id,
        expiresAt: new Date(now.getTime() - HOUR_MS),
      });

      // Empty, not null: the grant was theirs and is now revoked; there was
      // simply no live token left to prime the denylist with. A method that
      // returned [] for both cases passes the first assertion and fails this one.
      expect(await repo.revokeGrantForOwner(mine.id, owner, now)).toEqual([]);
      expect((await repo.findGrant(mine.id))!.revokedAt).not.toBeNull();
    });

    // The six above are the ones the plan names. The rest of the interface needs
    // covering too, or the two implementations are free to disagree on any method
    // nobody exercised — which is the same hole as having no seam contract at all.

    it('markReplaced stamps replacedAt, never revokedAt, and never moves an existing stamp', async () => {
      const grant = await grantFor(nextSub());
      const now = new Date();
      const tokenHash = `${grant.id}-refresh`;
      await repo.recordRefreshToken({ tokenHash, grantId: grant.id, expiresAt: new Date(now.getTime() + HOUR_MS) });

      expect((await repo.findRefreshToken(tokenHash))!.replacedAt).toBeNull();
      await repo.markReplaced(tokenHash, now);

      const stamped = (await repo.findRefreshToken(tokenHash))!;
      expect(stamped.replacedAt?.getTime()).toBe(now.getTime());
      // On a refresh row `revokedAt` means a family kill or a sign-out. A rotation
      // that set it would put this row past the check at the top of
      // exchangeRefreshToken, so a replay would be answered "not redeemable"
      // instead of killing the grant — the reuse branch would be unreachable.
      expect(stamped.revokedAt).toBeNull();

      // The stamp records when this token was FIRST spent, so a second call must
      // not slide it forward and rewrite when that happened.
      await repo.markReplaced(tokenHash, new Date(now.getTime() + HOUR_MS));
      expect((await repo.findRefreshToken(tokenHash))!.replacedAt?.getTime()).toBe(now.getTime());
    });

    it('revokeAllForSubject revokes every grant of one subject and leaves another subject alone', async () => {
      const mine = nextSub();
      const theirs = nextSub();
      const now = new Date();
      const later = new Date(now.getTime() + HOUR_MS);

      const first = await grantFor(mine);
      const second = await grantFor(mine);
      const untouched = await grantFor(theirs);
      await repo.recordAccessToken({ jti: `${first.id}-a`, grantId: first.id, expiresAt: later });
      await repo.recordAccessToken({ jti: `${second.id}-b`, grantId: second.id, expiresAt: later });
      await repo.recordAccessToken({ jti: `${untouched.id}-c`, grantId: untouched.id, expiresAt: later });

      const live = await repo.revokeAllForSubject(mine, now);

      expect(live.map((t) => t.jti).sort()).toEqual([`${first.id}-a`, `${second.id}-b`].sort());
      expect(await repo.findLiveAccessToken(`${first.id}-a`, now)).toBeNull();
      expect(await repo.findLiveAccessToken(`${second.id}-b`, now)).toBeNull();
      expect(await repo.findLiveAccessToken(`${untouched.id}-c`, now)).not.toBeNull();
      expect((await repo.findGrant(untouched.id))!.revokedAt).toBeNull();
    });

    it('listGrantsForSubject returns un-revoked grants, newest first', async () => {
      const sub = nextSub();
      const now = new Date();
      const older = await grantFor(sub);
      // A real gap between the two. Prisma maps DateTime to TIMESTAMP(3), so two
      // grants created inside one millisecond tie on `createdAt` and neither
      // Postgres nor the seam promises an order for them — without the gap this
      // test would be asserting something the method never guaranteed.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const newer = await grantFor(sub);
      const revoked = await grantFor(sub);
      await repo.revokeGrant(revoked.id, now);

      const listed = await repo.listGrantsForSubject(sub);

      expect(listed.map((g) => g.id)).toEqual([newer.id, older.id]);
    });

    it('touchRefreshed stamps lastRefreshedAt', async () => {
      const grant = await grantFor(nextSub());
      expect(grant.lastRefreshedAt).toBeNull();
      const at = new Date();

      await repo.touchRefreshed(grant.id, at);

      expect((await repo.findGrant(grant.id))!.lastRefreshedAt?.getTime()).toBe(at.getTime());
    });

    it('pruneExpired drops refresh rows at expiry but keeps an access row for a day past it', async () => {
      const grant = await grantFor(nextSub());
      const now = new Date();
      const anHourAgo = new Date(now.getTime() - HOUR_MS);
      const twoDaysAgo = new Date(now.getTime() - 48 * HOUR_MS);

      await repo.recordRefreshToken({ tokenHash: `${grant.id}-r`, grantId: grant.id, expiresAt: anHourAgo });
      await repo.recordAccessToken({ jti: `${grant.id}-recent`, grantId: grant.id, expiresAt: anHourAgo });
      await repo.recordAccessToken({ jti: `${grant.id}-ancient`, grantId: grant.id, expiresAt: twoDaysAgo });

      await repo.pruneExpired(now);

      expect(await repo.findRefreshToken(`${grant.id}-r`)).toBeNull();
      // /revoke's ordinary case is a client presenting an hour-old access token.
      // Deleting these at expiry would leave it nothing to find.
      expect(await repo.findAccessTokenAny(`${grant.id}-recent`)).not.toBeNull();
      expect(await repo.findAccessTokenAny(`${grant.id}-ancient`)).toBeNull();
      // The grant itself is live, so nothing prunes it.
      expect(await repo.findGrant(grant.id)).not.toBeNull();
    });

    it('pruneExpired drops a grant revoked more than a day ago, keeping one revoked just now', async () => {
      const now = new Date();
      const fresh = await grantFor(nextSub());
      const stale = await grantFor(nextSub());
      await repo.revokeGrant(fresh.id, now);
      await repo.revokeGrant(stale.id, new Date(now.getTime() - 48 * HOUR_MS));

      await repo.pruneExpired(now);

      expect(await repo.findGrant(fresh.id)).not.toBeNull();
      expect(await repo.findGrant(stale.id)).toBeNull();
    });
  });
}
