import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { decodeJwt, SignJWT } from 'jose';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { McpOAuthProvider } from './mcp-oauth.provider';
import { InMemoryMcpGrantRepository } from './mcp-grant.repository';
import { CodeStore, InMemoryClientsStore, PendingAuthStore } from './oauth-store';
import { SessionService } from '../auth/session.service';
import { SessionRevocationService } from '../auth/session-revocation.service';
import type { AdminAuthority } from '../auth/admin-authority';
import type { AuditService } from '../audit/audit.service';
import type { RecordAudit } from '../audit/audit.types';
import { BOARD_READ } from '../auth/scopes';

/**
 * RFC 7009 revocation (#456).
 *
 * The signer here is the REAL `SessionService`, not the echoing double the
 * other provider specs use, and that is what these rows rest on. Revocation
 * verifies the token it is handed rather than decoding it, so a double that
 * returns `tok:u1:...` would make every signature assertion below vacuous — the
 * forged-token row especially, which is the one that separates possession of a
 * token from knowledge of a jti.
 */

const SESSION_SECRET = 's'.repeat(32);

const CLIENT = {
  client_id: 'c1',
  redirect_uris: ['http://localhost:1234/cb'],
} as unknown as OAuthClientInformationFull;

/** A second registered client, which owns none of the grants made below. */
const OTHER_CLIENT = { client_id: 'c2' } as unknown as OAuthClientInformationFull;

function realGoogle(secret = SESSION_SECRET): SessionService {
  const vals: Record<string, unknown> = { BOARD_SESSION_SECRET: secret };
  return new SessionService({
    get: (k: string, d?: unknown) => vals[k] ?? d,
  } as unknown as ConfigService);
}

function harness() {
  const store = new InMemoryMcpGrantRepository();
  const revocation = new SessionRevocationService();
  const record = vi.fn(async (_e: RecordAudit) => {});
  const audit = { record } as unknown as AuditService;
  const admin = { isAdmin: () => false } as unknown as AdminAuthority;
  const config = { get: (_k: string, d?: unknown) => d } as unknown as ConfigService;
  const provider = new McpOAuthProvider(
    realGoogle(),
    config,
    store,
    admin,
    audit,
    revocation,
    new InMemoryClientsStore(),
    new PendingAuthStore(),
    new CodeStore(),
  );
  return { provider, store, revocation, audit: record };
}

/** A full authorization-code exchange — where a grant, and both tokens, come from. */
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

/** Asserted on the wire code, not the message the SDK never sends. */
async function expectInvalidGrant(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(InvalidGrantError);
  expect((err as InvalidGrantError).errorCode).toBe('invalid_grant');
}

const jtiOf = (accessToken: string) => decodeJwt(accessToken).jti as string;

describe('McpOAuthProvider.revokeToken (#456)', () => {
  afterEach(() => vi.useRealTimers());

  it('revoking an access token leaves no live row behind it', async () => {
    const { provider, store } = harness();
    const t = await exchangeOnce(provider);
    const jti = jtiOf(t.access_token);
    expect(await store.findLiveAccessToken(jti, new Date())).not.toBeNull();

    await provider.revokeToken!(CLIENT, { token: t.access_token });
    expect(await store.findLiveAccessToken(jti, new Date())).toBeNull();
  });

  it('revoking an access token takes the refresh token with it', async () => {
    // RFC 7009 §2.1 permits revoking the whole grant, and it is what a person
    // means by "cut this client off". Revoking the access token alone would
    // leave the client a working refresh token and a new hour of access.
    const { provider } = harness();
    const t = await exchangeOnce(provider);
    await provider.revokeToken!(CLIENT, { token: t.access_token });
    await expectInvalidGrant(provider.exchangeRefreshToken(CLIENT, t.refresh_token!));
  });

  it('revoking a refresh token stops a later refresh', async () => {
    // The other shape, and it needs its own row: an implementation that handles
    // only access tokens passes the two above and silently does nothing here.
    const { provider, store } = harness();
    const t = await exchangeOnce(provider);
    await provider.revokeToken!(CLIENT, { token: t.refresh_token! });
    await expectInvalidGrant(provider.exchangeRefreshToken(CLIENT, t.refresh_token!));
    expect(await store.findLiveAccessToken(jtiOf(t.access_token), new Date())).toBeNull();
  });

  it('a token it has never seen resolves rather than throwing', async () => {
    // `provider.d.ts:47`: "If the given token is invalid or already revoked,
    // this method should do nothing." A throw here becomes a 400 that tells a
    // caller which tokens exist.
    const { provider } = harness();
    await expect(provider.revokeToken!(CLIENT, { token: 'not-a-token-at-all' })).resolves.toBeUndefined();
  });

  it('revokes using an access token that has already expired', async () => {
    // The token must be expired to JOSE, which reads Date.now() and not any
    // clock the provider was handed. Advancing a fake clock forward would leave
    // the token valid as far as the verifier is concerned, the revoke would
    // succeed, this row would go green and production would no-op. So it is
    // minted already expired, in the past.
    //
    // Once an access token lives an hour this is the ORDINARY case: a client
    // revoking the token it has been holding presents an expired one. Looking it
    // up with `findLiveAccessToken` would answer 200 having revoked nothing.
    const { provider } = harness();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() - 2 * 3600_000));
    const t = await exchangeOnce(provider);
    vi.useRealTimers();

    await provider.revokeToken!(CLIENT, { token: t.access_token });
    await expectInvalidGrant(provider.exchangeRefreshToken(CLIENT, t.refresh_token!));
  });

  it('refuses to revoke a grant belonging to a different client — access-token shape', async () => {
    const { provider } = harness();
    const t = await exchangeOnce(provider); // the grant is bound to c1
    await provider.revokeToken!(OTHER_CLIENT, { token: t.access_token });
    await expect(provider.exchangeRefreshToken(CLIENT, t.refresh_token!)).resolves.toBeDefined();
  });

  it('refuses to revoke a grant belonging to a different client — refresh-token shape', async () => {
    // The pair is deliberate. An implementation that puts the client check
    // inside the access-token branch alone passes the row above and fails this
    // one — and registration is open, so any client id at all reaches here.
    const { provider } = harness();
    const t = await exchangeOnce(provider);
    await provider.revokeToken!(OTHER_CLIENT, { token: t.refresh_token! });
    await expect(provider.exchangeRefreshToken(CLIENT, t.refresh_token!)).resolves.toBeDefined();
  });

  it('ignores a token that is not signed by this board', async () => {
    // The forged token carries a LIVE jti, read off a real grant, so this row
    // fails against an implementation that decodes instead of verifying — and it
    // cannot pass by naming a jti that never existed. Jtis are written into an
    // audit log admins can read, so knowing one must not be enough to revoke.
    const { provider, store } = harness();
    const t = await exchangeOnce(provider);
    const liveJti = jtiOf(t.access_token);

    const forged = await new SignJWT({ email: 'x@example.com', board_scopes: [BOARD_READ] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setJti(liveJti)
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer('atlas')
      .sign(new TextEncoder().encode('wrong-secret-wrong-secret-wrong!'));

    await provider.revokeToken!(CLIENT, { token: forged });
    expect(await store.findLiveAccessToken(liveJti, new Date())).not.toBeNull();
  });

  it('primes the in-process denylist with the jtis it revoked', async () => {
    // The same-process fast path sign-out already uses: the row is the durable
    // answer, the denylist is what stops a token before the next read.
    const { provider, revocation } = harness();
    const t = await exchangeOnce(provider);
    const jti = jtiOf(t.access_token);
    expect(revocation.isRevoked(jti)).toBe(false);
    await provider.revokeToken!(CLIENT, { token: t.access_token });
    expect(revocation.isRevoked(jti)).toBe(true);
  });

  it('records oauth.revoke against the client, never against the person', async () => {
    // There is no human on this path — the caller is a client. Filling the
    // required actor field with the grant owner's address would make the log
    // read as though they revoked their own access, which is false, and it is
    // what would make this path indistinguishable from the account page's.
    const { provider, audit } = harness();
    const t = await exchangeOnce(provider);
    await provider.revokeToken!(CLIENT, { token: t.access_token });

    const entry = audit.mock.calls.map((c) => c[0]).find((e) => e.action === 'oauth.revoke')!;
    expect(entry).toBeDefined();
    expect(entry.actorEmail).toBe('client:c1');
    expect(entry.summary).toContain('u1@example.com');
  });

  it('writes nothing to the audit log when it refuses', async () => {
    // A refusal that still records reads as a revocation that happened.
    const { provider, audit } = harness();
    const t = await exchangeOnce(provider);
    await provider.revokeToken!(OTHER_CLIENT, { token: t.access_token });
    expect(audit.mock.calls.map((c) => c[0].action)).not.toContain('oauth.revoke');
  });
});

/**
 * `verifyAccessToken` is the SDK's own validation path. Board does not mount the
 * bearer middleware on `/mcp` — the Nest chain guards it — so this is unreachable
 * today, but its docblock anticipates the SDK using it, and after #456 it is the
 * only code in board that would say yes to a revoked token.
 */
describe('McpOAuthProvider.verifyAccessToken (#456)', () => {
  it('accepts a live token', async () => {
    // The other half of the pair. Without it the row below passes against a
    // method that refuses everything.
    const { provider } = harness();
    const t = await exchangeOnce(provider);
    await expect(provider.verifyAccessToken(t.access_token)).resolves.toMatchObject({
      scopes: [BOARD_READ],
    });
  });

  it('refuses a token whose grant has been revoked', async () => {
    const { provider } = harness();
    const t = await exchangeOnce(provider);
    await provider.revokeToken!(CLIENT, { token: t.access_token });
    await expect(provider.verifyAccessToken(t.access_token)).rejects.toThrow();
  });
});

describe('the endpoint the discovery document names (#456)', () => {
  beforeEach(() => vi.useRealTimers());

  it('advertises a revocation endpoint at /revoke', async () => {
    // Built from `mcpAuthRouterOptions`, the same function `main.ts` passes to
    // the SDK. Rebuilding the options inline here would assert the SDK's
    // behaviour and stay green even if `main.ts` stopped passing the provider —
    // which is the whole reason that function was lifted into a file of its own
    // rather than left as an object literal inside an `if`.
    const { createOAuthMetadata } = await import('@modelcontextprotocol/sdk/server/auth/router.js');
    const { mcpAuthRouterOptions } = await import('./mcp-auth-router-options.js');
    const { provider } = harness();

    const metadata = createOAuthMetadata(
      mcpAuthRouterOptions(provider, new URL('https://board')),
    );
    expect(metadata.revocation_endpoint).toBeDefined();
    expect(new URL(metadata.revocation_endpoint!).pathname).toBe('/revoke');
  });
});
