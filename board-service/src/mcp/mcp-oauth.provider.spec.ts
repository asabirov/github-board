import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import { decodeJwt, SignJWT } from 'jose';
import { INITIATOR_COOKIE, McpOAuthProvider } from './mcp-oauth.provider';
import { InMemoryMcpGrantRepository } from './mcp-grant.repository';
import { SessionRevocationService } from '../auth/session-revocation.service';
import { CodeStore, hashSecret, InMemoryClientsStore, PendingAuthStore } from './oauth-store';
import type { AdminAuthority } from '../auth/admin-authority';
import type { AuditService } from '../audit/audit.service';
import { expandPreset } from '../auth/scopes';

/** The provider's last two dependencies, stubbed to the answers this file needs. */
const ADMIN = { isAdmin: () => true } as unknown as AdminAuthority;
const noAudit = () => ({ record: async () => {} }) as unknown as AuditService;

/**
 * Every double of `issueMcpToken` in this file echoes `opts.jti` into the token
 * it returns, and that is not decoration (#456). The caller mints the jti, writes
 * the row under it and then signs the token with it; a double that signs
 * something else makes the row and the token describe different tokens, and
 * every grant-lookup assertion built on it would pass against a broken pairing.
 * The compiler cannot catch it — a two-parameter function is assignable to a
 * three-parameter signature — so it is a rule the doubles keep by hand.
 */
type MintOpts = { jti: string; ttlSeconds: number };

function provider(overrides: Partial<Record<string, unknown>> = {}) {
  const google = {
    issueMcpToken: async (u: { sub: string }, scopes: string[], opts: MintOpts) =>
      `tok:${u.sub}:${scopes.join(',')}:${opts.jti}`,
    verifySession: async () => ({ sub: 'u1', email: 'a@example.com', mcpScope: 'agent' }),
    ...overrides,
  } as any;
  const config = { get: (_k: string, d?: unknown) => d } as any;
  const store = new InMemoryMcpGrantRepository();
  // Exposed under a name the provider does not already use for a private field.
  // Reusing `grantRepo` or `revocation` reduces the intersection type to
  // `never`, and every method call on it then fails to compile with a message
  // that does not mention the collision.
  return Object.assign(
    new McpOAuthProvider(
      google,
      config,
      store,
      ADMIN,
      noAudit(),
      new SessionRevocationService(),
      new InMemoryClientsStore(),
      new PendingAuthStore(),
      new CodeStore(),
    ),
    { store },
  );
}

/**
 * A signed token standing in for what `issueMcpToken` returns, honouring the jti
 * AND the lifetime the caller handed in — both, because a double that fixes
 * either one lets the row and the token, or the advertised number and the signed
 * number, describe different things while every assertion stays green.
 */
async function realMcpToken(sub: string, jti: string, ttlSeconds: number): Promise<string> {
  const secret = new TextEncoder().encode('test-secret');
  return new SignJWT({ email: `${sub}@example.com`, mcp_scope: 'full' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setIssuer('atlas')
    .sign(secret);
}

const CLIENT = { client_id: 'c1', redirect_uris: ['http://localhost:1234/cb'] } as any;

function pend(p: McpOAuthProvider) {
  return p.pendingStore.create({
    clientId: 'c1',
    redirectUri: 'http://localhost:1234/cb',
    codeChallenge: 'ch',
    state: 'st',
  });
}

describe('McpOAuthProvider', () => {
  it('finishConsent issues a code and preserves state', async () => {
    const p = provider();
    const out = await p.finishConsent(await pend(p), expandPreset('agent'), { sub: 'u1', email: 'a@example.com' });
    const url = new URL(out!.redirectTo);
    expect(url.origin + url.pathname).toBe('http://localhost:1234/cb');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('code')).toBeTruthy();
  });

  it('finishConsent is one-time per pending request', async () => {
    const p = provider();
    const id = await pend(p);
    await p.finishConsent(id, expandPreset('agent'), { sub: 'u1', email: 'a@example.com' });
    expect(
      await p.finishConsent(id, expandPreset('agent'), { sub: 'u1', email: 'a@example.com' }),
    ).toBeNull();
  });

  it('exchanges a code for a scoped token; code is one-time', async () => {
    const p = provider();
    const out = await p.finishConsent(await pend(p), expandPreset('full'), { sub: 'u1', email: 'a@example.com' });
    const code = new URL(out!.redirectTo).searchParams.get('code')!;
    expect(await p.challengeForAuthorizationCode(CLIENT, code)).toBe('ch');
    const tokens = await p.exchangeAuthorizationCode(CLIENT, code);
    expect(tokens.access_token).toMatch(
      new RegExp(`^tok:u1:${expandPreset('full').join(',')}:`),
    );
    expect(tokens.scope).toBe(expandPreset('full').join(' '));
    await expect(p.exchangeAuthorizationCode(CLIENT, code)).rejects.toThrow();
  });

  it('the jti in the token is the jti the grant row is keyed on (#456)', async () => {
    // The pairing the whole grant machine rests on. The caller mints one jti,
    // signs it into the token and writes the access-token row under it — so a
    // token in a client's hands can be looked up, and a revoked grant can stop
    // it. If the signer minted its own the two would diverge and every lookup
    // built on this would pass against a broken pairing.
    const p = provider({
      issueMcpToken: async (u: { sub: string }, _s: string[], opts: MintOpts) =>
        realMcpToken(u.sub, opts.jti, opts.ttlSeconds),
    });
    const out = await p.finishConsent(await pend(p), expandPreset('full'), { sub: 'u1', email: 'a@example.com' });
    const code = new URL(out!.redirectTo).searchParams.get('code')!;
    const tokens = await p.exchangeAuthorizationCode(CLIENT, code);

    const jti = decodeJwt(tokens.access_token).jti as string;
    expect(jti).toBeTruthy();
    const row = await p.store.findLiveAccessToken(jti, new Date());
    expect(row).not.toBeNull();
    // and the same jti is what a sign-out finds, now that it reads the store
    // rather than a process-local map that a restart forgot.
    const live = await p.store.revokeAllForSubject('u1', new Date());
    expect(live.map((g) => g.jti)).toEqual([jti]);
  });

  it('records a grant row naming the client, the subject and the scopes (#456)', async () => {
    const p = provider();
    const scopes = expandPreset('full');
    const out = await p.finishConsent(await pend(p), scopes, { sub: 'u1', email: 'a@example.com' });
    const code = new URL(out!.redirectTo).searchParams.get('code')!;
    const tokens = await p.exchangeAuthorizationCode(CLIENT, code);

    const jti = tokens.access_token.split(':').pop()!;
    const row = (await p.store.findLiveAccessToken(jti, new Date()))!;
    const grant = await p.store.findGrant(row.grantId);
    expect(grant).toMatchObject({ sub: 'u1', email: 'a@example.com', clientId: 'c1', scopes });
  });

  it('fails the exchange when the access-token row cannot be written (#456)', async () => {
    // A grant that cannot be recorded cannot be revoked, and an unrevocable
    // token is worse than a failed handshake — so the write is not wrapped in a
    // try/catch and the exchange goes down with it. The old behaviour here was
    // the opposite: a bookkeeping failure was logged and the token handed out
    // anyway, leaving a grant nobody could ever cut off.
    const p = provider();
    vi.spyOn(p.store, 'recordAccessToken').mockRejectedValue(new Error('no database'));
    const out = await p.finishConsent(await pend(p), expandPreset('agent'), { sub: 'u1', email: 'a@example.com' });
    const code = new URL(out!.redirectTo).searchParams.get('code')!;
    await expect(p.exchangeAuthorizationCode(CLIENT, code)).rejects.toThrow('no database');
  });

  it('rejects a code exchanged by a different client', async () => {
    const p = provider();
    const out = await p.finishConsent(await pend(p), expandPreset('agent'), { sub: 'u1', email: 'a@example.com' });
    const code = new URL(out!.redirectTo).searchParams.get('code')!;
    await expect(
      p.exchangeAuthorizationCode({ client_id: 'evil' } as any, code),
    ).rejects.toThrow();
  });

  it('finishConsent stores the scope-set and the exchanged token carries it (#56)', async () => {
    const p = provider();
    const scopes = ['board:read', 'board:admin'];
    const out = await p.finishConsent(await pend(p), scopes, { sub: 'u1', email: 'a@example.com' });
    const code = new URL(out!.redirectTo).searchParams.get('code')!;
    const tokens = await p.exchangeAuthorizationCode(CLIENT, code);
    expect(tokens.access_token).toMatch(new RegExp(`^tok:u1:${scopes.join(',')}:`));
    expect(tokens.scope).toBe(scopes.join(' '));
  });

  it('advertises the lifetime it actually signs (#456)', async () => {
    // The two numbers compared against each other, never against a literal, so
    // this row fails if either moves alone. Board used to hold them as two
    // unlinked constants in two files that agreed at seven days by coincidence —
    // change one and the server advertises an hour while minting a week.
    const p = provider({
      issueMcpToken: async (u: { sub: string }, _s: string[], opts: MintOpts) =>
        realMcpToken(u.sub, opts.jti, opts.ttlSeconds),
    });
    const out = await p.finishConsent(await pend(p), expandPreset('full'), {
      sub: 'u1',
      email: 'a@example.com',
    });
    const code = new URL(out!.redirectTo).searchParams.get('code')!;
    const tokens = await p.exchangeAuthorizationCode(CLIENT, code);
    const { exp, iat } = decodeJwt(tokens.access_token);
    expect(tokens.expires_in).toBe(exp! - iat!);
  });

  it('verifyAccessToken rejects non-MCP session tokens', async () => {
    const p = provider({ verifySession: async () => ({ sub: 'u1', email: 'a@b.c' }) });
    await expect(p.verifyAccessToken('x')).rejects.toThrow('Not an MCP token');
  });
});

describe('McpOAuthProvider.authorize — the request remembers the browser (#554)', () => {
  /** A provider whose ConfigService answers BOARD_BASE_URL with `baseUrl`. */
  function boundProvider(baseUrl = '', signedIn = true) {
    const google = {
      issueMcpToken: async (_u: { sub: string }, _s: string[], opts: MintOpts) => `tok:${opts.jti}`,
      verifySession: signedIn
        ? async () => ({ sub: 'u1', email: 'a@example.com' })
        : async () => {
            throw new Error('no session');
          },
    } as any;
    const config = {
      get: (k: string, d?: unknown) => (k === 'BOARD_BASE_URL' ? baseUrl : d),
    } as any;
    return new McpOAuthProvider(
      google,
      config,
      new InMemoryMcpGrantRepository(),
      ADMIN,
      noAudit(),
      new SessionRevocationService(),
      new InMemoryClientsStore(),
      new PendingAuthStore(),
      new CodeStore(),
    );
  }

  /** An express Response double that records cookies and the redirect. */
  function authRes(cookieHeader = '') {
    const out = {
      set: [] as Array<{ name: string; value: string; opts: Record<string, unknown> }>,
      redirectedTo: null as string | null,
      req: { headers: { cookie: cookieHeader } },
      cookie(name: string, value: string, opts: Record<string, unknown>) {
        out.set.push({ name, value, opts });
        return out;
      },
      redirect(u: string) {
        out.redirectedTo = u;
        return out;
      },
    };
    return out;
  }

  const PARAMS = {
    redirectUri: 'http://localhost:1234/cb',
    codeChallenge: 'ch',
    scopes: ['board:read'],
  } as any;

  // By suffix, because the name carries the `__Host-` prefix on a secure
  // deployment and does not on an insecure one — see the rows below.
  const initiatorCookie = (r: ReturnType<typeof authRes>) =>
    r.set.find((c) => c.name.endsWith(INITIATOR_COOKIE));

  /** The pending id out of whichever redirect this branch produced. */
  function pendingIdFrom(r: ReturnType<typeof authRes>): string {
    const fromConsent = r.redirectedTo?.match(/req=([^&]+)/)?.[1];
    if (fromConsent) return fromConsent;
    const next = r.set.find((c) => c.name === 'atlas_next')?.value ?? '';
    return next.match(/req=([^&]+)/)?.[1] ?? '';
  }

  it('sets the initiator cookie on the ALREADY-SIGNED-IN branch', async () => {
    // This branch returns early, and it is the one the common case takes:
    // signed-in member, clicks a link, lands on consent. Instrumenting only the
    // login-bounce branch below would leave every ordinary flow arriving with
    // no cookie — refused by the binding check, a total consent outage, with
    // the whole suite green. Hence a row of its own.
    const p = boundProvider('', true);
    const r = authRes('atlas_session=good');
    await p.authorize(CLIENT, PARAMS, r as any);
    expect(r.redirectedTo).toMatch(/^\/api\/oauth\/consent\?req=/);
    const cookie = initiatorCookie(r);
    expect(cookie).toBeDefined();
    expect((await p.pendingStore.peek(pendingIdFrom(r)))?.initiator).toBe(hashSecret(cookie!.value));
  });

  it('sets the initiator cookie on the LOGIN-BOUNCE branch', async () => {
    const p = boundProvider('', false);
    const r = authRes('');
    await p.authorize(CLIENT, PARAMS, r as any);
    expect(r.redirectedTo).toBe('/api/auth/github/login');
    const cookie = initiatorCookie(r);
    expect(cookie).toBeDefined();
    expect((await p.pendingStore.peek(pendingIdFrom(r)))?.initiator).toBe(hashSecret(cookie!.value));
  });

  it('mints an initiator at least as unguessable as the request id', () => {
    // `oauth-store.spec.ts` pins request ids at 32 characters; a secret that
    // gates the same flow may not be weaker than the identifier it protects.
    const p = boundProvider();
    const r = authRes('');
    return p.authorize(CLIENT, PARAMS, r as any).then(() => {
      expect(initiatorCookie(r)!.value.length).toBeGreaterThanOrEqual(32);
    });
  });

  it('sets the cookie httpOnly and lax, so it survives the Google round trip', async () => {
    // Lax rides a top-level GET navigation, which is exactly what the return
    // from Google is. Asserted on the attributes — there is no browser here.
    const p = boundProvider('', false);
    const r = authRes('');
    await p.authorize(CLIENT, PARAMS, r as any);
    expect(initiatorCookie(r)!.opts).toMatchObject({ httpOnly: true, sameSite: 'lax' });
  });

  it('marks the cookie secure exactly when the board is served over https', async () => {
    const plain = authRes('');
    await boundProvider('http://localhost:3000', false).authorize(CLIENT, PARAMS, plain as any);
    expect(initiatorCookie(plain)!.opts.secure).toBe(false);

    const tls = authRes('');
    await boundProvider('https://board', false).authorize(CLIENT, PARAMS, tls as any);
    expect(initiatorCookie(tls)!.opts.secure).toBe(true);
  });

  it('D1b: a second flow in the same browser does not kill the first', async () => {
    // The requirement, stated in the plan and answered here by binding to the
    // BROWSER rather than to the request: one cookie, reused, so every record
    // this browser starts binds to the same secret and all of them stay
    // answerable. There is no cap to evict past and no second cookie name.
    const p = boundProvider('', true);

    const first = authRes('atlas_session=good');
    await p.authorize(CLIENT, PARAMS, first as any);
    const secret = initiatorCookie(first)!.value;
    const firstId = pendingIdFrom(first);

    // The browser now carries the cookie, so the second flow presents it.
    const second = authRes(`atlas_session=good; ${INITIATOR_COOKIE}=${secret}`);
    await p.authorize(CLIENT, PARAMS, second as any);
    const secondId = pendingIdFrom(second);

    expect(secondId).not.toBe(firstId);
    expect(initiatorCookie(second)!.value).toBe(secret);
    // Both records answerable by the one secret the browser holds.
    expect((await p.pendingStore.peek(firstId))?.initiator).toBe(hashSecret(secret));
    expect((await p.pendingStore.peek(secondId))?.initiator).toBe(hashSecret(secret));
  });

  it('takes the __Host- prefix when the deployment is secure', async () => {
    // Without a prefix the name is writable from anywhere under the same
    // registrable domain, and `parseCookies` is last-wins — so a cookie set on a
    // sibling host arrives second and wins, and the attacker, not the board,
    // chooses the secret this record is bound to. `__Host-` is the browser-side
    // rule that makes that unwritable: same host, Secure, Path=/, no Domain.
    const r = authRes('');
    await boundProvider('https://board', false).authorize(CLIENT, PARAMS, r as any);
    const cookie = initiatorCookie(r)!;
    expect(cookie.name).toBe(`__Host-${INITIATOR_COOKIE}`);
    // The prefix is a contract, not a label: a browser rejects the cookie
    // outright unless all three hold.
    expect(cookie.opts).toMatchObject({ secure: true, path: '/' });
    expect(cookie.opts.domain).toBeUndefined();
  });

  it('drops the prefix when it is not secure, because a browser would reject it', async () => {
    const r = authRes('');
    await boundProvider('http://localhost:3000', false).authorize(CLIENT, PARAMS, r as any);
    expect(initiatorCookie(r)!.name).toBe(INITIATOR_COOKIE);
  });

  it('reads back only the name it writes, so an unprefixed value is not adopted', async () => {
    // The read half of the same control. Adopting whatever is held under the
    // bare name on a secure deployment would hand the choice of secret straight
    // back to whoever could set it.
    const planted = 'plantedplantedplantedplantedplanted';

    const bare = authRes(`atlas_session=good; ${INITIATOR_COOKIE}=${planted}`);
    await boundProvider('https://board', true).authorize(CLIENT, PARAMS, bare as any);
    expect(initiatorCookie(bare)!.value).not.toBe(planted);

    // The prefixed one still is, or concurrent flows break (D1b).
    const prefixed = authRes(`atlas_session=good; __Host-${INITIATOR_COOKIE}=${planted}`);
    await boundProvider('https://board', true).authorize(CLIENT, PARAMS, prefixed as any);
    expect(initiatorCookie(prefixed)!.value).toBe(planted);
  });

  it('ignores a malformed initiator cookie and mints a fresh one', async () => {
    const p = boundProvider('', true);
    const r = authRes(`atlas_session=good; ${INITIATOR_COOKIE}=not a valid secret!`);
    await p.authorize(CLIENT, PARAMS, r as any);
    const minted = initiatorCookie(r)!.value;
    expect(minted).not.toContain(' ');
    expect(minted.length).toBeGreaterThanOrEqual(32);
    expect((await p.pendingStore.peek(pendingIdFrom(r)))?.initiator).toBe(hashSecret(minted));
  });
});

describe('McpOAuthProvider.consentContextFor — what the consent screen is told (#554)', () => {
  afterEach(() => vi.useRealTimers());

  /** A pending record for `clientId`, sent somewhere the registration does not list. */
  function pendFor(p: McpOAuthProvider, clientId: string, redirectUri = 'http://localhost:9/cb') {
    return p.pendingStore.create({
      clientId,
      redirectUri,
      codeChallenge: 'ch',
      requestedScopes: ['board:read'],
    });
  }

  // Every call below is awaited, and two of them used to be the reason to say
  // so out loud. `expect(p.consentContextFor(id)).not.toBeNull()` passes against
  // a Promise whatever it resolves to, and `tsc` does not complain — so when this
  // method became async in #456 those two rows stayed green while asserting
  // nothing. Both were re-read after the change rather than trusted.
  it('an unknown request id has no context at all', async () => {
    // Null rather than a context with empty fields: the caller has to decide
    // what a dead request does, and an empty-string name is indistinguishable
    // from a client that registered without one.
    expect(await provider().consentContextFor('no-such-id')).toBeNull();
  });

  it('an expired request id has no context', async () => {
    // The TTL check lives in `peek`; reading the raw map would return this.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const p = provider();
    const id = await pendFor(p, 'c1');
    expect(await p.consentContextFor(id)).not.toBeNull();
    vi.setSystemTime(new Date('2026-01-01T00:10:01Z'));
    expect(await p.consentContextFor(id)).toBeNull();
  });

  it('names the registered client and reports the scopes it asked for', async () => {
    const p = provider();
    await p.clientsStore.registerClient({
      client_id: 'c1',
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost:9/cb'],
    } as any);
    expect(await p.consentContextFor(await pendFor(p, 'c1'))).toMatchObject({
      clientId: 'c1',
      clientName: 'Claude Code',
      requestedScopes: ['board:read'],
    });
  });

  it('reports the address on the pending record, not the registered list', async () => {
    // They are usually the same, but a registration may list several and the
    // code goes to the one on the record. Showing the list would show a place
    // the code is not going.
    const p = provider();
    await p.clientsStore.registerClient({
      client_id: 'c1',
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost:1111/first', 'http://localhost:2222/second'],
    } as any);
    const ctx = await p.consentContextFor(await pendFor(p, 'c1', 'http://localhost:2222/second'));
    expect(ctx?.redirectUri).toBe('http://localhost:2222/second');
  });

  it('a client that registered no name reports it as absent, never as an empty string', async () => {
    // `''` and `undefined` are different products downstream: the page has to
    // tell "this client gave no name" from "this client is called nothing", and
    // an empty string is also what makes `esc()` render a blank where a name
    // should be. The distinction is decided on the page, not flattened here.
    const p = provider();
    await p.clientsStore.registerClient({
      client_id: 'c1',
      redirect_uris: ['http://localhost:9/cb'],
    } as any);
    const ctx = await p.consentContextFor(await pendFor(p, 'c1'));
    expect(ctx).not.toBeNull();
    expect(ctx!.clientName).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(ctx!, 'clientName')).toBe(true);
  });

  it('a client the registry has never heard of still yields a grantable context', async () => {
    // A pending record can outlive its own registration — the in-memory seam
    // evicts oldest-first past 1000, and a registration row can be pruned or
    // never have existed. The scopes and the destination are still correct and
    // the request is still grantable; the board has merely lost the name.
    // Throwing or returning null here would kill a live request.
    const p = provider();
    const ctx = await p.consentContextFor(await pendFor(p, 'gone'));
    expect(ctx).toMatchObject({
      clientId: 'gone',
      redirectUri: 'http://localhost:9/cb',
      requestedScopes: ['board:read'],
    });
    expect(ctx!.clientName).toBeUndefined();
  });

  it('does not consume the record it read', async () => {
    const p = provider();
    const id = await pendFor(p, 'c1');
    await p.consentContextFor(id);
    expect(await p.consentContextFor(id)).not.toBeNull();
  });
});

/**
 * RFC 6749 §4.1.2.1, carried unchanged into OAuth 2.1: when the resource owner
 * denies the request, the authorization server informs the client by redirecting
 * to the redirection URI with `error=access_denied`, and with `state` — required
 * — when the client sent one. Structurally this mirrors `finishConsent`, with
 * `error` where `code` is; the controller decides WHETHER it is safe to send it.
 */
describe('McpOAuthProvider.denyConsent — the client is told no (#555)', () => {
  const USER = { email: 'a@example.com' };

  // Two rows below spy on the logger, and both used to restore as their last
  // statement. An `expect` that throws before it never runs, and the spy then
  // leaks into every test that follows in this file.
  afterEach(() => vi.restoreAllMocks());

  it('redirects to the pending address with error=access_denied', async () => {
    const p = provider();
    const url = new URL((await p.denyConsent(await pend(p), USER))!.redirectTo);
    expect(url.origin + url.pathname).toBe('http://localhost:1234/cb');
    expect(url.searchParams.get('error')).toBe('access_denied');
  });

  it('preserves the state the client sent', async () => {
    const p = provider();
    const url = new URL((await p.denyConsent(await pend(p), USER))!.redirectTo);
    expect(url.searchParams.get('state')).toBe('st');
  });

  it('omits state entirely when the client sent none', async () => {
    const p = provider();
    const id = await p.pendingStore.create({
      clientId: 'c1',
      redirectUri: 'http://localhost:1234/cb',
      codeChallenge: 'ch',
    });
    const url = new URL((await p.denyConsent(id, USER))!.redirectTo);
    expect(url.searchParams.has('state')).toBe(false);
  });

  it('mints no authorization code', async () => {
    const p = provider();
    const url = new URL((await p.denyConsent(await pend(p), USER))!.redirectTo);
    expect(url.searchParams.has('code')).toBe(false);
  });

  it('sends no error_description, so nothing the client wrote rides the redirect', async () => {
    // RFC 6749 restricts the character set, and any description here would be
    // on a URL the board authored. The board has nothing to add that the error
    // code does not already say.
    const p = provider();
    const url = new URL((await p.denyConsent(await pend(p), USER))!.redirectTo);
    expect(url.searchParams.has('error_description')).toBe(false);
    expect(url.searchParams.has('error_uri')).toBe(false);
  });

  it('consumes the pending record, so a refusal is one-time too', async () => {
    const p = provider();
    const id = await pend(p);
    expect(await p.denyConsent(id, USER)).not.toBeNull();
    expect(await p.denyConsent(id, USER)).toBeNull();
    expect(
      await p.finishConsent(id, expandPreset('agent'), { sub: 'u1', email: 'a@b.c' }),
    ).toBeNull();
  });

  it('returns null for a request that is already gone', async () => {
    expect(await provider().denyConsent('no-such-id', USER)).toBeNull();
  });

  it('records the refusal, naming the actor and the client id', async () => {
    // #555's Context asks for a way to say no ON THE RECORD. That is a log line,
    // not only a redirect.
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const p = provider();
    await p.denyConsent(await pend(p), USER);
    const line = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('a@example.com');
    expect(line).toContain('c1');
  });

  it("never puts the client's self-chosen name in that line", async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const p = provider();
    await p.clientsStore.registerClient({
      client_id: 'c1',
      client_name: 'Sneaky Client',
      redirect_uris: ['http://localhost:1234/cb'],
    } as any);
    await p.denyConsent(await pend(p), USER);
    const line = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('c1');
    expect(line).not.toContain('Sneaky Client');
  });
});
