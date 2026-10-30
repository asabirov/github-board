import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { McpOAuthProvider } from './mcp-oauth.provider';
import { InMemoryMcpGrantRepository } from './mcp-grant.repository';
import { SessionRevocationService } from '../auth/session-revocation.service';
import { CodeStore, InMemoryClientsStore, PendingAuthStore } from './oauth-store';
import type { AdminAuthority } from '../auth/admin-authority';
import type { AuditService } from '../audit/audit.service';
import type { RecordAudit } from '../audit/audit.types';
import { BOARD_ADMIN, BOARD_READ } from '../auth/scopes';

/**
 * Refresh tokens: issue, rotate, and catch a replay (#456).
 *
 * A refresh token is redeemable exactly once. There is no window in which a
 * spent one is honoured, so the two replay rows here differ only in how long
 * they wait — one replays immediately, one a full minute later — and both must
 * give the same answer. That pair is the assertion: an implementation carrying
 * any grace period would pass one and fail the other. The clock is controlled
 * rather than real so the minute costs nothing.
 */

const CLIENT = { client_id: 'c1', redirect_uris: ['http://localhost:1234/cb'] } as unknown as OAuthClientInformationFull;

/** Wall clock, held still and moved by hand. */
const clock = {
  set(at: string) {
    vi.setSystemTime(new Date(at));
  },
  advance(ms: number) {
    vi.setSystemTime(new Date(Date.now() + ms));
  },
};

function harness(opts: { isAdmin?: boolean } = {}) {
  const store = new InMemoryMcpGrantRepository();
  // Typed on the argument, so `audit.mock.calls[i][0]` is a RecordAudit rather
  // than an element of an empty tuple — an untyped vi.fn() makes every assertion
  // below a compile error, and `as any` around them would hide a real mismatch.
  const record = vi.fn(async (_e: RecordAudit) => {});
  const audit = { record } as unknown as AuditService;
  const admin = { isAdmin: () => opts.isAdmin ?? false } as unknown as AdminAuthority;
  const google = {
    // Echoes the caller's jti, as every double of this method must (#456).
    issueMcpToken: async (u: { sub: string }, scopes: string[], mint: { jti: string }) =>
      `tok:${u.sub}:${scopes.join(',')}:${mint.jti}`,
    verifySession: async () => ({ sub: 'u1', email: 'u1@example.com' }),
  } as never;
  const config = { get: (_k: string, d?: unknown) => d } as unknown as ConfigService;
  const provider = new McpOAuthProvider(
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
  return { provider, store, audit: record, admin };
}

/** A full authorization-code exchange, which is where the first refresh token comes from. */
async function exchangeOnce(p: McpOAuthProvider, scopes: string[] = [BOARD_READ]): Promise<OAuthTokens> {
  const reqId = await p.pendingStore.create({
    clientId: 'c1',
    redirectUri: 'http://localhost:1234/cb',
    codeChallenge: 'ch',
  });
  const out = (await p.finishConsent(reqId, scopes, { sub: 'u1', email: 'u1@example.com' }))!;
  const code = new URL(out.redirectTo).searchParams.get('code')!;
  return p.exchangeAuthorizationCode(CLIENT, code);
}

/**
 * The rejection a client actually receives, asserted on the wire code rather
 * than on the message. `toThrow(/invalid_grant/)` would match the prose of the
 * message and not the `error` field the SDK serialises, so it could pass while
 * the client is told something else entirely.
 */
async function expectInvalidGrant(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(InvalidGrantError);
  expect((err as InvalidGrantError).errorCode).toBe('invalid_grant');
}

/** The grant behind a freshly exchanged pair, found through its access-token row. */
async function grantBehind(store: InMemoryMcpGrantRepository, tokens: OAuthTokens) {
  const jti = tokens.access_token.split(':').pop()!;
  const row = (await store.findAccessTokenAny(jti))!;
  return (await store.findGrant(row.grantId))!;
}

describe('exchangeRefreshToken (#456)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clock.set('2026-08-12T10:00:00Z');
  });
  afterEach(() => vi.useRealTimers());

  it('the code exchange hands back a refresh token', async () => {
    const { provider } = harness();
    const tokens = await exchangeOnce(provider);
    expect(typeof tokens.refresh_token).toBe('string');
    expect(tokens.refresh_token!.length).toBeGreaterThan(20);
  });

  it('a refresh mints a new pair, both halves different, the scope unchanged', async () => {
    const { provider } = harness();
    const first = await exchangeOnce(provider);
    const second = await provider.exchangeRefreshToken(CLIENT, first.refresh_token!);
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.scope).toBe(first.scope);
  });

  it('replaying a refresh token its holder already redeemed kills the whole grant', async () => {
    const { provider, audit } = harness();
    const first = await exchangeOnce(provider);
    const second = await provider.exchangeRefreshToken(CLIENT, first.refresh_token!);

    // No clock advance, deliberately. There is no window: a token is redeemable
    // exactly once, and the second presentation is theft whether it arrives a
    // second later or a week later.
    await expectInvalidGrant(provider.exchangeRefreshToken(CLIENT, first.refresh_token!));

    // The family is dead: the token the honest client holds no longer works
    // either, which is the point — the person is locked out loudly and knows to
    // look, rather than being shadowed by a thief who rotates quietly beside them.
    await expectInvalidGrant(provider.exchangeRefreshToken(CLIENT, second.refresh_token!));
    expect(audit.mock.calls.map((c) => c[0].action)).toContain('oauth.reuse');
  });

  it('a replay a full minute later is the same answer, so nothing is time-dependent', async () => {
    // The pair to the row above, and its length is the whole assertion: an
    // implementation that honoured a replay inside some window would pass one of
    // these two and fail the other. Same inputs, same replay, one clock apart.
    const { provider, audit } = harness();
    const first = await exchangeOnce(provider);
    await provider.exchangeRefreshToken(CLIENT, first.refresh_token!);

    clock.advance(60_000);
    await expectInvalidGrant(provider.exchangeRefreshToken(CLIENT, first.refresh_token!));
    expect(audit.mock.calls.map((c) => c[0].action)).toContain('oauth.reuse');
  });

  it('two callers presenting the same token is one redemption and one reuse, whichever way it interleaves', async () => {
    // The case that has to be deterministic. Two callers, one token: exactly one
    // redemption, and the other is reuse — not "sometimes reuse, depending on
    // whether its read landed before or after the winner committed". Nothing in
    // the data can tell an honest double-submit from a replay, because they are
    // the same event, so both get the same answer.
    //
    // A client that shares one refresh token across two processes cuts itself
    // off here, every time. That is the honest answer to a setup token rotation
    // cannot support, and it beats working nine times in ten.
    const { provider, store, audit } = harness();
    const first = await exchangeOnce(provider);
    const grantId = (await grantBehind(store, first)).id;

    expect((await store.findGrant(grantId))!.revokedAt).toBeNull(); // before

    const settled = await Promise.allSettled([
      provider.exchangeRefreshToken(CLIENT, first.refresh_token!),
      provider.exchangeRefreshToken(CLIENT, first.refresh_token!),
    ]);

    // At most one redemption. Whether that one also gets its answer back is a
    // race with the family kill and is deliberately NOT asserted — the winner's
    // re-read after writing its access row may catch the revocation and refuse,
    // or may land first and be handed a token the sweep then revokes. Both are
    // correct and which happens is the scheduler's business.
    expect(settled.filter((s) => s.status === 'fulfilled').length).toBeLessThanOrEqual(1);

    // What is not the scheduler's business, and what this test exists for: the
    // outcome is the same on every interleaving. The grant is gone, it is
    // recorded as theft, and nothing minted along the way still works. Asserting
    // the fulfilment count alone would pass against the arbitrary version this
    // replaced, where the loser was forgiven whenever its read landed early.
    expect((await store.findGrant(grantId))!.revokedAt).not.toBeNull(); // after
    expect(audit.mock.calls.map((c) => c[0].action)).toContain('oauth.reuse');
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      await expectInvalidGrant(provider.exchangeRefreshToken(CLIENT, s.value.refresh_token!));
    }
  });

  it('a refresh after the owner signs out is refused', async () => {
    const { provider, store } = harness();
    const first = await exchangeOnce(provider);
    await store.revokeAllForSubject('u1', new Date());
    await expectInvalidGrant(provider.exchangeRefreshToken(CLIENT, first.refresh_token!));
  });

  it('a sign-out landing under a refresh refuses it without a second revoke or a reuse signal', async () => {
    // Rejection alone would pass against an implementation that read the refusal
    // as theft and escalated, so this asserts what must NOT have happened: no
    // reuse key in the audit log, and a revocation timestamp that is the
    // sign-out's own, not one this call wrote over it.
    const { provider, store, audit } = harness();
    const first = await exchangeOnce(provider);
    const grant = await grantBehind(store, first);

    const signedOutAt = new Date('2026-08-12T10:05:00Z');
    await store.revokeAllForSubject('u1', signedOutAt);
    const before = (await store.findGrant(grant.id))!.revokedAt;
    expect(before).toEqual(signedOutAt);

    clock.set('2026-08-12T10:06:00Z');
    await expectInvalidGrant(provider.exchangeRefreshToken(CLIENT, first.refresh_token!));

    const after = (await store.findGrant(grant.id))!.revokedAt;
    expect(after).toEqual(before);
    expect(audit.mock.calls.map((c) => c[0].action)).not.toContain('oauth.reuse');
  });

  it('a sign-out landing between the grant read and the rotation is not filed as theft', async () => {
    // The narrower sibling of the test above, and the one that had no coverage.
    // There the revocation had already landed when the refresh began, so the
    // grant read caught it. Here it lands INSIDE the call, after that read and
    // before the compare-and-swap — and the swap's where-clause holds
    // `revokedAt: null` as well as the pointer, so it fails without the pointer
    // having moved at all.
    //
    // Reading that failure as reuse would file a replay alarm against an honest
    // client that presented its own current token at the moment its owner signed
    // out, which is precisely the ordinary traffic this detector must not fire
    // on. Rejection alone would pass against exactly that implementation, so the
    // assertions are what must NOT have happened: no reuse key, and the
    // sign-out's own revocation timestamp left unwritten-over.
    const { provider, store, audit } = harness();
    const first = await exchangeOnce(provider);
    const grant = await grantBehind(store, first);

    const signedOutAt = new Date('2026-08-12T10:05:00Z');
    const realRotate = store.rotateRefreshPointer.bind(store);
    vi.spyOn(store, 'rotateRefreshPointer').mockImplementation(async (...args) => {
      // The sign-out commits here — after the provider read the grant and found
      // it live, before its swap runs.
      await store.revokeAllForSubject('u1', signedOutAt);
      return realRotate(...args);
    });

    await expectInvalidGrant(provider.exchangeRefreshToken(CLIENT, first.refresh_token!));

    expect((await store.findGrant(grant.id))!.revokedAt).toEqual(signedOutAt);
    expect(audit.mock.calls.map((c) => c[0].action)).not.toContain('oauth.reuse');
  });

  it('a refresh whose grant was revoked before the child sweep landed is refused', async () => {
    // Revocation writes the grant first and its children second, deliberately, so
    // there is a real instant where a refresh row still looks live under a grant
    // that is already gone. The grant is the authority; the row is a denormalized
    // copy. Without the grant read this refresh would be honoured.
    const { provider, store } = harness();
    const first = await exchangeOnce(provider);
    const grant = await grantBehind(store, first);

    const row = (await store.findRefreshToken(
      (await store.findGrant(grant.id))!.currentRefreshHash!,
    ))!;
    await store.revokeGrant(grant.id, new Date());
    vi.spyOn(store, 'findRefreshToken').mockResolvedValue({ ...row, revokedAt: null });

    await expectInvalidGrant(provider.exchangeRefreshToken(CLIENT, first.refresh_token!));
  });

  it('a client cannot widen its scopes through a refresh', async () => {
    // The SDK hands the request's `scope` parameter straight through. Reading it
    // would let a client that consented to board:read come back an hour later
    // asking for board:admin and be given it.
    const { provider } = harness({ isAdmin: true });
    const first = await exchangeOnce(provider, [BOARD_READ]);
    const second = await provider.exchangeRefreshToken(CLIENT, first.refresh_token!, [
      BOARD_READ,
      BOARD_ADMIN,
    ]);
    expect(second.scope).toBe(BOARD_READ);
  });

  it("a demoted admin's refresh drops the scope they may no longer hold", async () => {
    // The grant is a record of what was consented to, not a promise it still
    // holds. Scopes are re-capped against the authority the owner has now.
    const { provider } = harness({ isAdmin: false });
    const first = await exchangeOnce(provider, [BOARD_READ, BOARD_ADMIN]);
    const second = await provider.exchangeRefreshToken(CLIENT, first.refresh_token!);
    expect(second.scope).toBe(BOARD_READ);
  });

  it('a sign-out that lands after the access row is written takes that row with it', async () => {
    // The read at the top of the method happened before the sweep, so it proves
    // nothing. The grant is read again after the access row is written: either the
    // sweep saw our row, or we see its revocation and undo ourselves.
    const { provider, store } = harness();
    const first = await exchangeOnce(provider);
    const grant = await grantBehind(store, first);

    let writtenJti = '';
    const realRecord = store.recordAccessToken.bind(store);
    vi.spyOn(store, 'recordAccessToken').mockImplementation(async (i) => {
      await realRecord(i);
      writtenJti = i.jti;
      await store.revokeAllForSubject('u1', new Date());
    });

    await expectInvalidGrant(provider.exchangeRefreshToken(CLIENT, first.refresh_token!));
    expect(writtenJti).toBeTruthy();
    expect(await store.findLiveAccessToken(writtenJti, new Date())).toBeNull();
    expect((await store.findAccessTokenAny(writtenJti))!.revokedAt).not.toBeNull();
    expect((await store.findGrant(grant.id))!.revokedAt).not.toBeNull();
  });

  it('the code exchange records oauth.grant against the grant it created', async () => {
    const { provider, store, audit } = harness();
    const tokens = await exchangeOnce(provider);
    const grant = await grantBehind(store, tokens);
    const entry = audit.mock.calls.map((c) => c[0]).find((e) => e.action === 'oauth.grant')!;
    expect(entry).toMatchObject({ actorEmail: 'u1@example.com', targetId: grant.id });
    expect(entry.summary).toContain('c1');
  });
});
