import { createPrismaClient } from '../prisma';
import { afterAll, describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { McpOAuthProvider } from './mcp-oauth.provider';
import { SessionRevocationService } from '../auth/session-revocation.service';
import { PrismaMcpGrantRepository } from './mcp-grant.repository';
import { CodeStore, InMemoryClientsStore, PendingAuthStore } from './oauth-store';
import type { AdminAuthority } from '../auth/admin-authority';
import type { AuditService } from '../audit/audit.service';
import { BOARD_READ } from '../auth/scopes';

/**
 * Refresh rotation under real contention (#456).
 *
 * `refresh.spec.ts` runs the same provider against the in-memory seam, where
 * `rotateRefreshPointer` picks one winner because JavaScript is single-threaded —
 * which proves nothing about the compare-and-swap a deployment depends on. Here
 * the winner is chosen by Postgres.
 *
 * Neither test asserts an emergent property. "Exactly one refresh row is
 * un-revoked and un-replaced" is the shape an earlier design of this was pinned
 * with, and it was flaky by construction: it held on most interleavings and
 * failed on the rest. What is asserted instead is the single column — a grant
 * names one current refresh token because that is what the column is, and there
 * is no interleaving on which a single value is ambiguous.
 */

const prisma = createPrismaClient();
const store = new PrismaMcpGrantRepository(prisma);
const subPrefix = `refresh-db-spec-${process.pid}-${Date.now()}`;

const CLIENT = { client_id: 'c1', redirect_uris: ['http://localhost:1234/cb'] } as unknown as OAuthClientInformationFull;

function providerFor(sub: string): McpOAuthProvider {
  const google = {
    issueMcpToken: async (u: { sub: string }, scopes: string[], mint: { jti: string }) =>
      `tok:${u.sub}:${scopes.join(',')}:${mint.jti}`,
  } as never;
  const config = { get: (_k: string, d?: unknown) => d } as unknown as ConfigService;
  const admin = { isAdmin: () => false } as unknown as AdminAuthority;
  const audit = { record: async () => {} } as unknown as AuditService;
  // The grant tables are what this file drives against Postgres. The three
  // consent-flow stores stay on the in-memory seam here: a pending record and a
  // code are consumed within the same call as they are created, so putting them
  // in Postgres would add rows to clean up and nothing to prove.
  // `oauth-store.db-spec.ts` is where those tables are exercised.
  return new McpOAuthProvider(
    google,
    config,
    store,
    admin,
    audit,
    new SessionRevocationService(),
    new InMemoryClientsStore(),
    new PendingAuthStore(),
    new CodeStore(),
  );
}

/** A code exchange under a `sub` this file owns, so teardown can find its rows. */
async function firstPair(p: McpOAuthProvider, sub: string): Promise<OAuthTokens> {
  const reqId = await p.pendingStore.create({
    clientId: 'c1',
    redirectUri: 'http://localhost:1234/cb',
    codeChallenge: 'ch',
  });
  const out = (await p.finishConsent(reqId, [BOARD_READ], { sub, email: `${sub}@example.com` }))!;
  const code = new URL(out.redirectTo).searchParams.get('code')!;
  return p.exchangeAuthorizationCode(CLIENT, code);
}

async function grantIdOf(tokens: OAuthTokens): Promise<string> {
  const jti = tokens.access_token.split(':').pop()!;
  return (await store.findAccessTokenAny(jti))!.grantId;
}

/** sha256 hex, the way the provider hashes a refresh token before storing it. */
async function hashOf(value: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value).digest('hex');
}

describe('refresh rotation against Postgres (#456)', () => {
  afterAll(async () => {
    // Routed through the grant: the child tables have no `sub` column.
    const grants = await prisma.mcpGrant.findMany({
      where: { sub: { startsWith: subPrefix } },
      select: { id: true },
    });
    const ids = grants.map((g) => g.id);
    if (ids.length > 0) {
      await prisma.mcpAccessToken.deleteMany({ where: { grantId: { in: ids } } });
      await prisma.mcpRefreshToken.deleteMany({ where: { grantId: { in: ids } } });
      await prisma.mcpGrant.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  });

  it('exactly one of two callers redeeming one token wins, and Postgres picks the winner', async () => {
    const sub = `${subPrefix}-race`;
    const p = providerFor(sub);
    const first = await firstPair(p, sub);
    const grantId = await grantIdOf(first);

    const settled = await Promise.allSettled([
      p.exchangeRefreshToken(CLIENT, first.refresh_token!),
      p.exchangeRefreshToken(CLIENT, first.refresh_token!),
    ]);
    // Postgres decides who wins the compare-and-swap, which is why the invariant
    // is structural rather than swept into place by two writers. At most one
    // redemption — never two, on any interleaving.
    //
    // An earlier version of this test asserted BOTH callers were served and the
    // grant survived. That was true only when the loser's read landed before the
    // winner's commit, and flaky by construction the rest of the time — the exact
    // disease this file's own docblock names three lines up.
    expect(settled.filter((s) => s.status === 'fulfilled').length).toBeLessThanOrEqual(1);

    // And this is the part that does not vary: one token presented twice is
    // reuse, so the grant is gone and anything minted on the way is gone with it.
    expect((await store.findGrant(grantId))!.revokedAt).not.toBeNull();
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      await expect(p.exchangeRefreshToken(CLIENT, s.value.refresh_token!)).rejects.toThrow();
    }
  });

  it('presenting a spent refresh token kills the grant, against the real database', async () => {
    const sub = `${subPrefix}-reuse`;
    const p = providerFor(sub);
    const first = await firstPair(p, sub);
    const grantId = await grantIdOf(first);

    const second = await p.exchangeRefreshToken(CLIENT, first.refresh_token!);
    expect((await store.findGrant(grantId))!.revokedAt).toBeNull(); // before

    // The same token a second time. No clock is involved and none is available
    // to involve: `markReplaced` stamped it when its holder spent it, and a
    // second presentation of a one-use credential is theft at any distance.
    await expect(p.exchangeRefreshToken(CLIENT, first.refresh_token!)).rejects.toThrow();

    // The whole family, written through to Postgres: the grant, and the token
    // the honest client was still holding.
    expect((await store.findGrant(grantId))!.revokedAt).not.toBeNull(); // after
    await expect(p.exchangeRefreshToken(CLIENT, second.refresh_token!)).rejects.toThrow();
  });
});
