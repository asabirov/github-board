import type { PrismaClient } from '../generated/prisma/client';
import { randomUUID } from 'node:crypto';
import { CODE_TTL_MS, PENDING_TTL_MS } from './oauth-store';

/**
 * Storage for board's OAuth2 grants and the tokens issued under them (#456).
 *
 * There are two implementations and they are not two backends. The Prisma one is
 * the only path a deployment ever takes: `BOARD_MCP_ENABLED=true` requires
 * `IDENTITY_SOURCE=db` at boot (config.schema.ts), and mcp.module.ts throws a
 * second time if that ever slipped through. `InMemoryMcpGrantRepository` is a
 * **test seam and never a production path** — it exists because the provider's
 * own specs construct McpOAuthProvider directly and exchange codes with no
 * database in sight. Both run the same contract
 * (`mcp-grant.repository.contract.ts`), so the seam cannot drift into answering
 * differently from the store.
 *
 * Neither carries a `readonly enabled` flag, unlike PersonalTokenRepository. That
 * flag means "this feature is unavailable, degrade"; here the only correct answer
 * to a missing row is to reject, and a boolean that invites `if (!repo.enabled)
 * return true` is precisely the vacuous guard this repository has shipped before.
 */

export const MCP_GRANT_REPOSITORY = 'MCP_GRANT_REPOSITORY';

/** Rows mirror the Prisma models one-for-one, with date columns as Date. */
export interface GrantRow {
  id: string;
  sub: string;
  email: string;
  clientId: string;
  scopes: string[];
  currentRefreshHash: string | null;
  createdAt: Date;
  lastRefreshedAt: Date | null;
  revokedAt: Date | null;
}

export interface AccessTokenRow {
  jti: string;
  grantId: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface RefreshTokenRow {
  tokenHash: string;
  grantId: string;
  expiresAt: Date;
  replacedAt: Date | null;
  revokedAt: Date | null;
}

export interface CreateGrantInput {
  sub: string;
  email: string;
  clientId: string;
  scopes: string[];
  /**
   * The grant's first refresh pointer, set at the same moment the grant exists so
   * there is never an instant where a grant names no redeemable token. Optional
   * because Task 2 creates grants before a refresh token is minted at all.
   */
  currentRefreshHash?: string;
}

/** What a revocation hands back so the in-process denylist can be primed. */
export interface LiveToken {
  jti: string;
  expiresAtMs: number;
}

export interface McpGrantRepository {
  createGrant(i: CreateGrantInput): Promise<GrantRow>;
  recordAccessToken(i: { jti: string; grantId: string; expiresAt: Date }): Promise<void>;
  recordRefreshToken(i: { tokenHash: string; grantId: string; expiresAt: Date }): Promise<void>;
  /** The guard's hot path: one primary-key read. Null when unknown, revoked or expired. */
  findLiveAccessToken(jti: string, now: Date): Promise<AccessTokenRow | null>;
  /** Revocation's lookup: the row whatever its state, so an EXPIRED access token can
   *  still revoke its grant. Never use this in the guard. */
  findAccessTokenAny(jti: string): Promise<AccessTokenRow | null>;
  findGrant(grantId: string): Promise<GrantRow | null>;
  findRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null>;
  /** The rotation. Compare-and-swap on `McpGrant.currentRefreshHash`: true iff this
   *  caller moved the pointer off `expectedHash`. There is no separate claim and no
   *  sweep — the column IS the invariant, so two racing callers cannot annihilate
   *  each other's work the way two sweeps could. */
  rotateRefreshPointer(grantId: string, expectedHash: string, newHash: string, now: Date): Promise<boolean>;
  /** Stamp a superseded row as a tombstone. Never sets `revokedAt` — on a refresh row
   *  that means explicit revocation (family kill or sign-out), never rotation. */
  markReplaced(tokenHash: string, now: Date): Promise<void>;
  /** Revokes the grant, sweeps its access + refresh rows, returns still-live jtis. */
  revokeGrant(grantId: string, now: Date): Promise<LiveToken[]>;
  /** `null` when no live grant with that id belongs to `sub` — distinct from `[]`,
   *  their grant revoked with no live tokens left to return. */
  revokeGrantForOwner(grantId: string, sub: string, now: Date): Promise<LiveToken[] | null>;
  revokeAllForSubject(sub: string, now: Date): Promise<LiveToken[]>;
  /** Un-revoked grants only, newest first — what the account page lists. */
  listGrantsForSubject(sub: string): Promise<GrantRow[]>;
  touchRefreshed(grantId: string, now: Date): Promise<void>;
  /** Opportunistic retention on the refresh path. Access rows are deleted only once a
   *  day past `expiresAt`, not at expiry: `/revoke` must still find an hour-old access
   *  token, which is the ordinary case once tokens last an hour. Refresh rows and
   *  grants revoked over a day ago go at expiry. The Prisma implementation also
   *  sweeps the pending-authorization and code tables `oauth-store.ts` writes,
   *  which the in-memory seam does not hold at all. */
  pruneExpired(now: Date): Promise<void>;
}

/**
 * How long an expired access-token row is kept before it is deleted. Not zero,
 * because RFC 7009 revocation's ordinary case is a client presenting the access
 * token it has been holding for the last hour, and a row deleted at expiry would
 * leave `/revoke` nothing to find.
 */
export const ACCESS_TOKEN_RETENTION_MS = 24 * 3_600_000;

/** How long a revoked grant is kept, so the account page and the audit log can
 *  still explain a revocation that happened this morning. */
export const REVOKED_GRANT_RETENTION_MS = 24 * 3_600_000;

/** Postgres-backed store (Prisma). The only implementation a deployment runs. */
export class PrismaMcpGrantRepository implements McpGrantRepository {
  constructor(private readonly prisma: PrismaClient) {}

  createGrant(i: CreateGrantInput): Promise<GrantRow> {
    return this.prisma.mcpGrant.create({
      data: {
        sub: i.sub,
        email: i.email,
        clientId: i.clientId,
        scopes: i.scopes,
        currentRefreshHash: i.currentRefreshHash ?? null,
      },
    });
  }

  async recordAccessToken(i: { jti: string; grantId: string; expiresAt: Date }): Promise<void> {
    await this.prisma.mcpAccessToken.create({ data: i });
  }

  async recordRefreshToken(i: { tokenHash: string; grantId: string; expiresAt: Date }): Promise<void> {
    await this.prisma.mcpRefreshToken.create({ data: i });
  }

  async findLiveAccessToken(jti: string, now: Date): Promise<AccessTokenRow | null> {
    // One primary-key read, with the liveness checks applied here rather than in
    // the where-clause. Prisma 5 would happily take `{ jti, revokedAt: null }`
    // (extendedWhereUnique has been GA since 5.0), so this is not a limitation
    // being worked around: filtering in the query collapses three outcomes —
    // unknown jti, revoked grant, expired token — into one null, and both the
    // guard's log line and the deploy-day cutover test need to tell them apart.
    const row = await this.prisma.mcpAccessToken.findUnique({ where: { jti } });
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    return row;
  }

  findAccessTokenAny(jti: string): Promise<AccessTokenRow | null> {
    return this.prisma.mcpAccessToken.findUnique({ where: { jti } });
  }

  findGrant(grantId: string): Promise<GrantRow | null> {
    return this.prisma.mcpGrant.findUnique({ where: { id: grantId } });
  }

  findRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
    return this.prisma.mcpRefreshToken.findUnique({ where: { tokenHash } });
  }

  async rotateRefreshPointer(
    grantId: string,
    expectedHash: string,
    newHash: string,
    // Present for symmetry with the rest of the interface and so an
    // implementation may stamp: this one needs no clock, because the database
    // decides the winner.
    _now: Date,
  ): Promise<boolean> {
    // The whole concurrency story in one statement. Two callers presenting the
    // same expectedHash race here and Postgres picks one; the loser's count is 0
    // and it has written nothing for the winner to undo.
    const res = await this.prisma.mcpGrant.updateMany({
      where: { id: grantId, currentRefreshHash: expectedHash, revokedAt: null },
      data: { currentRefreshHash: newHash },
    });
    return res.count === 1;
  }

  async markReplaced(tokenHash: string, now: Date): Promise<void> {
    // `replacedAt: null` in the where-clause, so the stamp records the FIRST time
    // this token was spent and never slides forward. `revokedAt` is never touched
    // here: on a refresh row it means a family kill or a sign-out, and a rotation
    // that revoked its predecessor would make the reuse branch unreachable.
    await this.prisma.mcpRefreshToken.updateMany({
      where: { tokenHash, replacedAt: null },
      data: { replacedAt: now },
    });
  }

  async revokeGrant(grantId: string, now: Date): Promise<LiveToken[]> {
    const live = await this.liveTokensFor([grantId], now);
    await this.revokeGrants([grantId], now);
    return live;
  }

  async revokeGrantForOwner(grantId: string, sub: string, now: Date): Promise<LiveToken[] | null> {
    // Decided before anything is written, so a refusal never leaves a revokedAt
    // on somebody else's row.
    const grant = await this.prisma.mcpGrant.findFirst({ where: { id: grantId, sub, revokedAt: null } });
    if (!grant) return null;
    return this.revokeGrant(grantId, now);
  }

  async revokeAllForSubject(sub: string, now: Date): Promise<LiveToken[]> {
    const grants = await this.prisma.mcpGrant.findMany({ where: { sub, revokedAt: null }, select: { id: true } });
    const ids = grants.map((g) => g.id);
    if (ids.length === 0) return [];
    const live = await this.liveTokensFor(ids, now);
    await this.revokeGrants(ids, now);
    return live;
  }

  /**
   * The revocation itself: the grants, then every token row under them, in ONE
   * transaction.
   *
   * It has to be atomic because the guard reads only the denormalized `revokedAt`
   * on the token row and never joins the grant — that is what keeps `/mcp` at one
   * primary-key read. So a sweep that failed after the grant update would leave
   * the grant revoked and its access tokens working for the rest of their hour,
   * and every way back into the product reports success: `revokeAllForSubject`
   * filters `revokedAt: null`, finds nothing left to do, and answers ok, while
   * `revokeGrantForOwner`'s pre-check answers 404 and the account page has
   * already stopped listing the row. The person is told the client is cut off at
   * exactly the moment they most need that to be true.
   *
   * Grant first, children second, inside the transaction: a mint racing this
   * re-reads the grant after writing its row and finds the revocation.
   */
  private async revokeGrants(grantIds: string[], now: Date): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.mcpGrant.updateMany({
        where: { id: { in: grantIds }, revokedAt: null },
        data: { revokedAt: now, currentRefreshHash: null },
      }),
      this.prisma.mcpAccessToken.updateMany({
        where: { grantId: { in: grantIds }, revokedAt: null },
        data: { revokedAt: now },
      }),
      this.prisma.mcpRefreshToken.updateMany({
        where: { grantId: { in: grantIds }, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
  }

  listGrantsForSubject(sub: string): Promise<GrantRow[]> {
    return this.prisma.mcpGrant.findMany({ where: { sub, revokedAt: null }, orderBy: { createdAt: 'desc' } });
  }

  async touchRefreshed(grantId: string, now: Date): Promise<void> {
    await this.prisma.mcpGrant.updateMany({ where: { id: grantId }, data: { lastRefreshedAt: now } });
  }

  async pruneExpired(now: Date): Promise<void> {
    await this.prisma.mcpRefreshToken.deleteMany({ where: { expiresAt: { lte: now } } });
    await this.prisma.mcpAccessToken.deleteMany({
      where: { expiresAt: { lte: new Date(now.getTime() - ACCESS_TOKEN_RETENTION_MS) } },
    });
    await this.prisma.mcpGrant.deleteMany({
      where: { revokedAt: { lte: new Date(now.getTime() - REVOKED_GRANT_RETENTION_MS) } },
    });
    // The two tables `oauth-store.ts` writes, swept from the same call rather
    // than a second retention path of their own. An auth table nobody prunes is
    // a table nobody audits, and these two hold the shortest-lived credentials
    // board has. They are not in the in-memory implementation below because it
    // holds no pending or code rows at all — the seam models this module's three
    // tables and nothing else — so this behaviour is covered by
    // `oauth-store.db-spec.ts` rather than the shared contract.
    await this.prisma.mcpPendingAuth.deleteMany({
      where: { createdAt: { lte: new Date(now.getTime() - PENDING_TTL_MS) } },
    });
    await this.prisma.mcpAuthCode.deleteMany({
      where: { createdAt: { lte: new Date(now.getTime() - CODE_TTL_MS) } },
    });
  }

  private async liveTokensFor(grantIds: string[], now: Date): Promise<LiveToken[]> {
    const rows = await this.prisma.mcpAccessToken.findMany({
      where: { grantId: { in: grantIds }, revokedAt: null, expiresAt: { gt: now } },
    });
    return rows.map((r) => ({ jti: r.jti, expiresAtMs: r.expiresAt.getTime() }));
  }

}

/**
 * Test seam, never a production path — see this file's docblock. Rows are copied
 * on the way in and out, so a caller holding a returned row cannot reach into the
 * store the way it could not reach into Postgres.
 */
export class InMemoryMcpGrantRepository implements McpGrantRepository {
  private readonly grants = new Map<string, GrantRow>();
  private readonly accessTokens = new Map<string, AccessTokenRow>();
  private readonly refreshTokens = new Map<string, RefreshTokenRow>();

  async createGrant(i: CreateGrantInput): Promise<GrantRow> {
    const row: GrantRow = {
      id: randomUUID(),
      sub: i.sub,
      email: i.email,
      clientId: i.clientId,
      scopes: [...i.scopes],
      currentRefreshHash: i.currentRefreshHash ?? null,
      createdAt: new Date(),
      lastRefreshedAt: null,
      revokedAt: null,
    };
    this.grants.set(row.id, row);
    return { ...row, scopes: [...row.scopes] };
  }

  async recordAccessToken(i: { jti: string; grantId: string; expiresAt: Date }): Promise<void> {
    this.accessTokens.set(i.jti, { ...i, revokedAt: null });
  }

  async recordRefreshToken(i: { tokenHash: string; grantId: string; expiresAt: Date }): Promise<void> {
    this.refreshTokens.set(i.tokenHash, { ...i, replacedAt: null, revokedAt: null });
  }

  async findLiveAccessToken(jti: string, now: Date): Promise<AccessTokenRow | null> {
    const row = this.accessTokens.get(jti);
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    return { ...row };
  }

  async findAccessTokenAny(jti: string): Promise<AccessTokenRow | null> {
    const row = this.accessTokens.get(jti);
    return row ? { ...row } : null;
  }

  async findGrant(grantId: string): Promise<GrantRow | null> {
    const row = this.grants.get(grantId);
    return row ? { ...row, scopes: [...row.scopes] } : null;
  }

  async findRefreshToken(tokenHash: string): Promise<RefreshTokenRow | null> {
    const row = this.refreshTokens.get(tokenHash);
    return row ? { ...row } : null;
  }

  async rotateRefreshPointer(grantId: string, expectedHash: string, newHash: string, _now: Date): Promise<boolean> {
    const grant = this.grants.get(grantId);
    if (!grant || grant.revokedAt || grant.currentRefreshHash !== expectedHash) return false;
    grant.currentRefreshHash = newHash;
    return true;
  }

  async markReplaced(tokenHash: string, now: Date): Promise<void> {
    const row = this.refreshTokens.get(tokenHash);
    if (!row || row.replacedAt) return;
    row.replacedAt = now;
  }

  async revokeGrant(grantId: string, now: Date): Promise<LiveToken[]> {
    const live = this.liveTokensFor([grantId], now);
    const grant = this.grants.get(grantId);
    if (grant && !grant.revokedAt) {
      grant.revokedAt = now;
      grant.currentRefreshHash = null;
    }
    this.sweepChildren([grantId], now);
    return live;
  }

  async revokeGrantForOwner(grantId: string, sub: string, now: Date): Promise<LiveToken[] | null> {
    const grant = this.grants.get(grantId);
    if (!grant || grant.sub !== sub || grant.revokedAt) return null;
    return this.revokeGrant(grantId, now);
  }

  async revokeAllForSubject(sub: string, now: Date): Promise<LiveToken[]> {
    const ids = [...this.grants.values()].filter((g) => g.sub === sub && !g.revokedAt).map((g) => g.id);
    if (ids.length === 0) return [];
    const live = this.liveTokensFor(ids, now);
    for (const id of ids) {
      const grant = this.grants.get(id)!;
      grant.revokedAt = now;
      grant.currentRefreshHash = null;
    }
    this.sweepChildren(ids, now);
    return live;
  }

  async listGrantsForSubject(sub: string): Promise<GrantRow[]> {
    // Ordered by `createdAt` alone, like the store. Prisma maps DateTime to
    // TIMESTAMP(3), so two grants created inside one millisecond tie there as
    // well and Postgres leaves that order unspecified — a tiebreak invented here
    // would be a promise the store does not keep.
    return [...this.grants.values()]
      .filter((g) => g.sub === sub && !g.revokedAt)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((g) => ({ ...g, scopes: [...g.scopes] }));
  }

  async touchRefreshed(grantId: string, now: Date): Promise<void> {
    const grant = this.grants.get(grantId);
    if (grant) grant.lastRefreshedAt = now;
  }

  async pruneExpired(now: Date): Promise<void> {
    for (const [hash, row] of this.refreshTokens) {
      if (row.expiresAt.getTime() <= now.getTime()) this.refreshTokens.delete(hash);
    }
    const accessCutoff = now.getTime() - ACCESS_TOKEN_RETENTION_MS;
    for (const [jti, row] of this.accessTokens) {
      if (row.expiresAt.getTime() <= accessCutoff) this.accessTokens.delete(jti);
    }
    const grantCutoff = now.getTime() - REVOKED_GRANT_RETENTION_MS;
    for (const [id, row] of this.grants) {
      if (row.revokedAt && row.revokedAt.getTime() <= grantCutoff) this.grants.delete(id);
    }
  }

  private liveTokensFor(grantIds: string[], now: Date): LiveToken[] {
    const wanted = new Set(grantIds);
    return [...this.accessTokens.values()]
      .filter((r) => wanted.has(r.grantId) && !r.revokedAt && r.expiresAt.getTime() > now.getTime())
      .map((r) => ({ jti: r.jti, expiresAtMs: r.expiresAt.getTime() }));
  }

  private sweepChildren(grantIds: string[], now: Date): void {
    const wanted = new Set(grantIds);
    for (const row of this.accessTokens.values()) {
      if (wanted.has(row.grantId) && !row.revokedAt) row.revokedAt = now;
    }
    for (const row of this.refreshTokens.values()) {
      if (wanted.has(row.grantId) && !row.revokedAt) row.revokedAt = now;
    }
  }
}
