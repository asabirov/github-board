import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { Response } from 'express';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  SessionService,
  MCP_ACCESS_TOKEN_TTL_S,
  MCP_REFRESH_TOKEN_TTL_S,
} from '../auth/session.service';
import { parseCookies, SESSION_COOKIE, NEXT_COOKIE } from '../auth/cookies';
import { SessionRevocationService } from '../auth/session-revocation.service';
import { AdminAuthority } from '../auth/admin-authority';
import { capToGrantable } from '../auth/scopes';
import { AuditService } from '../audit/audit.service';
import {
  MCP_CLIENTS_STORE,
  MCP_CODE_STORE,
  MCP_PENDING_STORE,
  type McpClientsStore,
  type McpCodeStore,
  type McpPendingAuthStore,
} from './oauth-store';
import {
  MCP_GRANT_REPOSITORY,
  type GrantRow,
  type McpGrantRepository,
} from './mcp-grant.repository';

/** A refresh token as it is handed out, beside the only part of it board keeps. */
interface MintedRefresh {
  /** The secret. Returned to the client once and never stored. */
  value: string;
  /** sha256 hex — what the row is keyed on, and what the grant's pointer holds. */
  hash: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mintRefresh(): MintedRefresh {
  const value = randomBytes(32).toString('base64url');
  return { value, hash: sha256(value) };
}

/**
 * Names the browser that started an MCP authorization (#554). One cookie name,
 * one reused value — see `initiatorFor` for why it is per-browser rather than
 * per-request, and why per-request cookie NAMES are ruled out.
 */
export const INITIATOR_COOKIE = 'atlas_consent_init';

/**
 * The name a consent-flow secret is written and read under.
 *
 * `__Host-` is a browser-enforced contract, not a naming convention: a browser
 * accepts a cookie under that prefix only from the exact host, only with
 * `Secure`, only with `Path=/`, and only with no `Domain` attribute. That last
 * clause is the one that matters here. Without a prefix, any host under the
 * same registrable domain can set a cookie of this name for the board — and
 * `parseCookies` keeps the LAST value it sees, so the planted one wins. The
 * secret this flow binds to would then be the attacker's choice rather than the
 * board's, and the reuse that D1b depends on is what makes a planted value
 * stick rather than being replaced on the next request.
 *
 * The prefix is dropped when the deployment is not served over https, because a
 * browser would reject the cookie outright and the flow would break in local
 * development for a protection that http cannot carry anyway. Both halves — the
 * write in this file and the read in `consent.controller.ts` — go through this
 * function, so they cannot disagree about which name is the real one.
 */
export function consentCookieName(base: string, secure: boolean): string {
  return secure ? `__Host-${base}` : base;
}

/** The shape this server mints: base64url, and never shorter than a request id. */
const WELL_FORMED_INITIATOR = /^[A-Za-z0-9_-]{32,128}$/;

/** What the consent screen is told about a live pending request (#554). */
export interface ConsentContext {
  /** The board's own identifier for the client. Safe to log. */
  clientId: string;
  /** The client's self-chosen name, if it registered one. Never log this. */
  clientName?: string;
  /** Where the code goes — from the pending record, not the registration. */
  redirectUri: string;
  requestedScopes?: string[];
  /**
   * The browser that started this flow, as the store holds it: the **sha256 hex**
   * of the secret that browser was given, never the secret. The consent screen
   * hashes its own cookie before comparing, so both sides are 64 hex characters
   * and the constant-time comparison is reached rather than falling out on
   * length.
   *
   * Absent on a record that carries no initiator, and the consent screen refuses
   * such a record rather than admitting it — see `consent.controller.ts`.
   */
  initiator?: string;
}

/**
 * OAuth 2.1 authorization server for the Overview MCP endpoint. End-user
 * authentication is delegated to the GitHub sign-in flow; this provider
 * only orchestrates: pending request → login → consent (scope choice) →
 * one-time code → Overview-minted HS256 JWT with an `mcp_scope` claim.
 */
@Injectable()
export class McpOAuthProvider implements OAuthServerProvider {
  private readonly logger = new Logger(McpOAuthProvider.name);

  constructor(
    // Explicit tokens — tsx/vitest (esbuild) emit no design:paramtypes metadata.
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(MCP_GRANT_REPOSITORY) private readonly grantRepo: McpGrantRepository,
    @Inject(AdminAuthority) private readonly admin: AdminAuthority,
    @Inject(AuditService) private readonly audit: AuditService,
    // The same instance sign-out primes. `revokeToken` writes the durable answer
    // to Postgres and this is the same-process fast path in front of it, so a
    // token cut off through /revoke stops at the guard before its row is read.
    @Inject(SessionRevocationService) private readonly revocation: SessionRevocationService,
    // The three stores were field initializers holding the in-memory classes
    // until #456. They come through the constructor now so the module graph
    // decides which implementation runs, and so a spec can drive either.
    //
    // Public, and they stay that way. The SDK's router reads
    // `provider.clientsStore` off the provider it is handed, and the provider's
    // own specs drive consent through `pendingStore` and `codeStore` rather than
    // through HTTP.
    //
    // `clientsStore` is typed as an interface rather than the concrete in-memory
    // class, which is what makes `getClient` possibly-async — and that is what
    // makes `consentContextFor` a promise. The docblock on that method used to
    // warn against exactly this re-typing; it now describes what happened
    // instead.
    @Inject(MCP_CLIENTS_STORE) readonly clientsStore: McpClientsStore,
    @Inject(MCP_PENDING_STORE) readonly pendingStore: McpPendingAuthStore,
    @Inject(MCP_CODE_STORE) readonly codeStore: McpCodeStore,
  ) {}

  /**
   * The secret that says "this browser started the flow", read back if the
   * browser already has one and minted if it does not.
   *
   * D1b — the concurrency mechanism, chosen here and justified rather than
   * defaulted. The binding is to the BROWSER, not to the request: one cookie
   * name holding one reused value, so every pending request a browser starts
   * binds to the same secret and all of them stay answerable at once.
   *
   * That is what this cookie costs a second flow: nothing. It is NOT on its own
   * what makes two consent tabs work, and this docblock used to claim it was.
   * The consent screen mints a CSRF token into a cookie of its own, and while
   * that one was minted fresh on every GET, a second tab overwrote the first
   * tab's token and the first tab's answer was refused as though the request had
   * timed out. The requirement is met by both cookies following this same rule —
   * see `csrfFor` in `consent.controller.ts`, which reuses for the same reason.
   *
   * Why not the alternatives:
   *  - Per-request cookie NAMES are ruled out by the plan and rightly so: a
   *    browser caps cookies per domain and evicts oldest-first, so an endpoint
   *    anyone can hit unauthenticated would become a way to push `atlas_session`
   *    out of the jar.
   *  - A capped LIST of per-request tokens in one cookie also works, but it has
   *    a cap, and a page that makes the victim's browser traverse `/authorize`
   *    more times than the cap evicts a genuine in-flight flow. Binding to the
   *    browser has no cap and therefore nothing to evict.
   *  - Last-write-wins is a cap of one, and fails the requirement outright.
   *
   * What it costs: the secret is stable for the cookie's lifetime rather than
   * per-request, so somebody who could both read an httpOnly cookie and get the
   * person to open a consent link could re-bind. Reading that cookie already
   * means reading `atlas_session`, which is a larger loss than this one, so the
   * marginal exposure is small. Cookie tossing from a subdomain would defeat
   * any of these mechanisms equally.
   *
   * Path is `/`, not the consent path. It has to be: `/authorize` is mounted at
   * the ROOT (`main.ts:24`, outside the global `/api` prefix), so a cookie
   * scoped to `/api/oauth/consent` would not be sent back here and could never
   * be reused — which forces last-write-wins and fails D1b. The lifetime
   * matches `PENDING_TTL_MS`, so the cookie lives exactly as long as a record
   * it could answer for.
   */
  private initiatorFor(res: Response): string {
    const secure = this.config.get<string>('BOARD_BASE_URL', '').startsWith('https');
    const name = consentCookieName(INITIATOR_COOKIE, secure);
    // Exactly the one name this deployment writes. Reading the bare name too
    // would give back the whole of what the prefix buys.
    const held = parseCookies(res.req.headers.cookie)[name];
    const initiator = WELL_FORMED_INITIATOR.test(held ?? '')
      ? held
      : randomBytes(24).toString('base64url');
    res.cookie(name, initiator, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 600_000,
    });
    return initiator;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Before the session check branches, deliberately. `authorize()` has two
    // exits and the FIRST one — already signed in — carries the common case and
    // returns early. Setting the cookie inside the login-bounce branch alone
    // would leave every ordinary consent flow arriving unbound and refused: a
    // total outage, with every test still green because no row would cover the
    // branch that was missed. One call site is what makes that unwritable.
    const initiator = this.initiatorFor(res);
    const reqId = await this.pendingStore.create({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      requestedScopes: params.scopes,
      initiator,
    });
    const consentPath = `/api/oauth/consent?req=${reqId}`;

    // Already logged in? Straight to consent.
    const session = parseCookies(res.req.headers.cookie)[SESSION_COOKIE];
    if (session) {
      try {
        await this.sessions.verifySession(session);
        res.redirect(consentPath);
        return;
      } catch {
        // fall through to login
      }
    }
    const secure = this.config.get<string>('BOARD_BASE_URL', '').startsWith('https');
    res.cookie(NEXT_COOKIE, consentPath, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: 600_000,
    });
    res.redirect('/api/auth/github/login');
  }

  /** Called by the consent controller after the user picked a scope-set. */
  async finishConsent(
    reqId: string,
    scopes: string[],
    user: { sub: string; email: string },
  ): Promise<{ redirectTo: string } | null> {
    const pending = await this.pendingStore.consume(reqId);
    if (!pending) return null;
    const code = await this.codeStore.create({
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes,
      sub: user.sub,
      email: user.email,
    });
    const url = new URL(pending.redirectUri);
    url.searchParams.set('code', code);
    if (pending.state) url.searchParams.set('state', pending.state);
    this.logger.log(`mcp consent scopes=[${scopes.join(' ')}] actor=${user.email} client=${pending.clientId}`);
    return { redirectTo: url.toString() };
  }

  /**
   * The person said no, and the client is told (#555).
   *
   * RFC 6749 §4.1.2.1, carried unchanged into OAuth 2.1: the authorization
   * server informs the client by redirecting to the redirection URI with
   * `error=access_denied`, and with `state` — required — when the client sent
   * one. Structurally this is `finishConsent` with `error` where `code` is, and
   * it consumes the record for the same reason: a decision is answered once.
   *
   * No `error_description` and no `error_uri`. RFC 6749 restricts the character
   * set, and anything the client supplied would be a stranger's text riding a
   * URL the board authored. The error code says all there is to say.
   *
   * The SDK's own `createErrorRedirect` is not exported (`handlers/authorize.js`),
   * so the URL is built here — three lines, no import, no dependency.
   *
   * WHETHER it is safe to tell the client is not decided here. The controller
   * only calls this once the binding check has confirmed the flow started in
   * this browser; on a pre-seeded link a redirect would confirm to a stranger
   * that a live board member opened their page.
   */
  async denyConsent(
    reqId: string,
    user: { email: string },
  ): Promise<{ redirectTo: string } | null> {
    const pending = await this.pendingStore.consume(reqId);
    if (!pending) return null;
    const url = new URL(pending.redirectUri);
    url.searchParams.set('error', 'access_denied');
    if (pending.state) url.searchParams.set('state', pending.state);
    // Actor and client id, never `client_name` — same rule `finishConsent` follows.
    this.logger.log(`mcp consent refused actor=${user.email} client=${pending.clientId}`);
    return { redirectTo: url.toString() };
  }

  /**
   * Everything the consent screen needs about a pending request, from one peek.
   *
   * `null` means the request is dead — unknown, already spent, or past its TTL —
   * and the caller must not render a grantable page for it. That is different
   * from a live request the board knows little about, which comes back as a
   * context with fields missing.
   *
   * `clientName` is absent rather than empty when the client registered without
   * one, and absent rather than throwing when the registry has no row for the
   * client at all — the in-memory seam evicts oldest-first past its cap, and a
   * registration row could equally have been removed. Such a request is still
   * live and still grantable: the scopes and the destination both live on the
   * pending record, which is untouched. Only the name is lost.
   *
   * `redirectUri` is the pending record's, never `client.redirect_uris`. A
   * registration may list several and the code goes to the one on the record;
   * showing the list would show a place the code is not going.
   *
   * Awaited, and this docblock used to say the opposite. It said the call was
   * synchronous because `clientsStore` was typed as the concrete
   * `InMemoryClientsStore`, and it warned against re-typing that field. #456 did
   * exactly that: both stores are Postgres-backed now and neither can answer
   * without a round trip, so the consent GET is async too. A docblock that lies
   * is worse than none, which is why this paragraph replaced that one rather
   * than being deleted.
   *
   * `initiator` comes back as the sha256 hex the store holds, never the secret
   * the browser was given — see `PendingAuth.initiator`. The consent screen
   * hashes its cookie before comparing, so both sides are 64 hex characters and
   * `secretsMatch` reaches `timingSafeEqual` rather than failing on length.
   */
  async consentContextFor(reqId: string): Promise<ConsentContext | null> {
    const pending = await this.pendingStore.peek(reqId);
    if (!pending) return null;
    const client = await this.clientsStore.getClient(pending.clientId);
    return {
      clientId: pending.clientId,
      clientName: client?.client_name,
      redirectUri: pending.redirectUri,
      requestedScopes: pending.requestedScopes,
      initiator: pending.initiator,
    };
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const challenge = await this.codeStore.peekChallenge(authorizationCode);
    if (!challenge) throw new Error('Unknown or expired authorization code');
    return challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const record = await this.codeStore.consume(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new Error('Invalid authorization code');
    }
    const now = new Date();
    const refresh = mintRefresh();

    // The durable authorization, written before anything is minted (#456). This
    // is what a person revokes on the account page and what sign-out cuts off;
    // the tokens below are issued under it and die with it. The refresh pointer
    // is set as part of the create, so there is never an instant where a grant
    // exists naming no redeemable token.
    const grant = await this.grantRepo.createGrant({
      sub: record.sub,
      email: record.email,
      clientId: client.client_id,
      scopes: record.scopes,
      currentRefreshHash: refresh.hash,
    });

    // The jti is minted HERE and handed to the signer, rather than minted inside
    // the signer and decoded back out of its own output. That decode used to sit
    // in a try/catch that logged and carried on, so a failure handed out a token
    // no sign-out could ever reach. One value, one row, one token.
    const jti = randomUUID();
    const expiresAt = new Date(now.getTime() + MCP_ACCESS_TOKEN_TTL_S * 1000);
    const accessToken = await this.sessions.issueMcpToken(
      { sub: record.sub, email: record.email },
      record.scopes,
      { jti, ttlSeconds: MCP_ACCESS_TOKEN_TTL_S },
    );

    // Deliberately not wrapped: a token whose row is missing is a token the
    // guard rejects and the account page cannot show, so failing the handshake
    // is the better of the two answers. An unrevocable credential is worse than
    // a client that has to try again.
    await this.grantRepo.recordAccessToken({ jti, grantId: grant.id, expiresAt });
    await this.grantRepo.recordRefreshToken({
      tokenHash: refresh.hash,
      grantId: grant.id,
      expiresAt: new Date(now.getTime() + MCP_REFRESH_TOKEN_TTL_S * 1000),
    });

    await this.audit.record({
      actorEmail: record.email,
      action: 'oauth.grant',
      summary: `client ${client.client_id} granted [${record.scopes.join(' ')}]`,
      targetType: 'mcp-grant',
      targetId: grant.id,
    });

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: MCP_ACCESS_TOKEN_TTL_S,
      refresh_token: refresh.value,
      scope: record.scopes.join(' '),
    };
  }

  /**
   * Redeem a refresh token for a new pair, rotating the one presented.
   *
   * `McpGrant.currentRefreshHash` names the single token that may be redeemed,
   * and rotation is a compare-and-swap on that column — so the invariant "one
   * grant, one redeemable refresh token" is what the column IS, rather than
   * something two racing writers sweep into existence between them.
   *
   * A presented token gets one of three answers. Its hash is the pointer, and it
   * rotates. Its row is missing, revoked or expired, and it is refused with
   * nothing changed. Or its row is live but is no longer the pointer — which
   * means its own holder already redeemed it — and that is a second use of a
   * one-use credential, so the whole grant goes.
   *
   * The `scopes` the SDK parsed off the request are deliberately not read. A
   * client widening its own scopes through a refresh is privilege escalation; the
   * grant is the only authority, and even that is re-capped against what its
   * owner may hold today.
   */
  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const now = new Date();
    const hash = sha256(refreshToken);

    const row = await this.grantRepo.findRefreshToken(hash);
    if (!row || row.revokedAt || row.expiresAt.getTime() <= now.getTime()) {
      throw new InvalidGrantError('Refresh token is not redeemable');
    }
    const grant = await this.grantRepo.findGrant(row.grantId);
    // The grant is the authority and the row's own `revokedAt` is a denormalized
    // copy of it. Revocation writes the grant first and its children second, so
    // there is a real instant where the row still looks live under a grant that
    // is already gone.
    if (!grant || grant.revokedAt) {
      throw new InvalidGrantError('Refresh token is not redeemable');
    }

    // One rule, and no second answer anywhere: a refresh token may be redeemed
    // once. Winning the compare-and-swap IS the redemption, and everything else
    // is a token being presented after it was spent.
    //
    // Two softer answers used to live here and both were the same mistake in
    // different clothes. A thirty-second window honoured a replay as a retry by
    // re-rotating — and re-rotation is indistinguishable from a takeover, so
    // whoever replayed inside it got a working pair and unseated the rightful
    // holder without a trace. Then a quieter version refused a lost
    // compare-and-swap without escalating, on the theory that two callers
    // holding the same live token are one client racing itself. That one was
    // worse than it looked: which of the two answers a caller got was decided by
    // whether its `findGrant` landed before or after the winner's commit, so the
    // same client, the same token and the same instant produced a survivable
    // refusal or a dead grant depending on the connection pool. An arbitrary
    // rule is not a kind one.
    //
    // Nothing in the data can tell an honest double-submit from a replay, because
    // they are the same event: one token, presented twice. So both are refused
    // the same way. A client must own its refresh token alone — two processes
    // sharing one token store will cut themselves off, loudly and every time,
    // which is the honest answer to a setup token rotation cannot support.
    //
    // What this costs the honest client is real: a lost refresh response means
    // re-running the handshake, and the audit log will carry an `oauth.reuse`
    // entry for it. Doing better would mean handing a retry back the pair it was
    // already given, which needs the plaintext refresh token kept at rest. This
    // design stores only hashes, and that is worth more.
    if (grant.currentRefreshHash === hash) {
      const minted = mintRefresh();
      if (await this.grantRepo.rotateRefreshPointer(grant.id, hash, minted.hash, now)) {
        await this.grantRepo.markReplaced(hash, now);
        return this.mintUnderGrant(grant, minted, now);
      }
      // The compare-and-swap can fail for two reasons and they are not the same
      // event. Its where-clause holds `revokedAt: null` as well as the pointer,
      // so a sign-out or a revoke committing between the read above and this
      // write fails it without the pointer having moved at all — an honest
      // client presenting its own current token at the moment its owner signs
      // out. Calling that theft would file a replay alarm against somebody who
      // did nothing, and this whole branch exists because a detector that fires
      // on ordinary traffic stops meaning anything.
      //
      // So the reason is read off the grant rather than inferred from the
      // failure. Revocation is terminal and never reverses, which is what makes
      // this re-read safe to branch on: finding it set is a fact that cannot
      // become false underneath us. Finding it clear means the pointer really
      // did move, and the token really was spent twice.
      const after = await this.grantRepo.findGrant(grant.id);
      if (!after || after.revokedAt) {
        throw new InvalidGrantError('Refresh token is not redeemable');
      }
    }
    return this.refuseAsReuse(grant, now);
  }

  /** A token presented after its holder spent it: the whole family goes, loudly. */
  private async refuseAsReuse(grant: GrantRow, now: Date): Promise<never> {
    await this.grantRepo.revokeGrant(grant.id, now);
    this.logger.warn(
      `mcp refresh reuse detected grant=${grant.id} client=${grant.clientId} — grant revoked`,
    );
    await this.audit.record({
      actorEmail: grant.email,
      action: 'oauth.reuse',
      summary: `replayed refresh token for client ${grant.clientId} — grant revoked`,
      targetType: 'mcp-grant',
      targetId: grant.id,
    });
    throw new InvalidGrantError('Refresh token has already been used');
  }

  /** Mint the access token and persist the new refresh token under a live grant. */
  private async mintUnderGrant(
    grant: GrantRow,
    minted: MintedRefresh,
    now: Date,
  ): Promise<OAuthTokens> {
    // Re-capped, not replayed. A grant records what was consented to, not a
    // promise its owner may still hold it — a demoted admin's refresh drops
    // board:admin. The cap is only as fresh as AdminAuthority's cache, so that
    // takes up to ADMIN_CACHE_TTL_MS rather than being instant.
    const scopes = capToGrantable(grant.scopes, this.admin.isAdmin(grant.email));
    const jti = randomUUID();
    const expiresAt = new Date(now.getTime() + MCP_ACCESS_TOKEN_TTL_S * 1000);
    const accessToken = await this.sessions.issueMcpToken(
      { sub: grant.sub, email: grant.email },
      scopes,
      { jti, ttlSeconds: MCP_ACCESS_TOKEN_TTL_S },
    );
    await this.grantRepo.recordAccessToken({ jti, grantId: grant.id, expiresAt });

    // Read the grant AGAIN, after the write. The read at the top of the method
    // happened before a concurrent sign-out's sweep could have run, so it proves
    // nothing; revocation writes the grant before its children precisely so that
    // either the sweep sees this row or this read sees the revocation.
    const after = await this.grantRepo.findGrant(grant.id);
    if (!after || after.revokedAt) {
      await this.grantRepo.revokeGrant(grant.id, now);
      throw new InvalidGrantError('Refresh token is not redeemable');
    }

    // The refresh row lands after that re-read, so a sign-out arriving in the gap
    // leaves a refresh row that looks live under a revoked grant. Harmless: the
    // next presentation reads the grant and refuses. Written down so it is not
    // mistaken for a hole.
    await this.grantRepo.recordRefreshToken({
      tokenHash: minted.hash,
      grantId: grant.id,
      expiresAt: new Date(now.getTime() + MCP_REFRESH_TOKEN_TTL_S * 1000),
    });
    await this.grantRepo.touchRefreshed(grant.id, now);

    // Opportunistic retention, on the one path slow enough to carry it. Its
    // failure is logged rather than raised: nothing about an old row being left
    // behind should cost a client its refresh.
    try {
      await this.grantRepo.pruneExpired(now);
    } catch (err) {
      this.logger.warn(`mcp grant prune failed: ${(err as Error).message}`);
    }

    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: MCP_ACCESS_TOKEN_TTL_S,
      refresh_token: minted.value,
      scope: scopes.join(' '),
    };
  }

  /**
   * RFC 7009 token revocation (#456). Implementing this method is what mounts
   * the endpoint: `router.js:41` reads `provider.revokeToken ? '/revoke' :
   * undefined`, puts that into the discovery document and mounts the handler at
   * the same pathname. A hand-rolled `POST /api/oauth/revoke` would be a URL no
   * compliant client ever looks for.
   *
   * Either shape revokes the whole grant, which §2.1 permits explicitly and
   * which is what a person means by cutting a client off. Revoking the access
   * token alone would leave its holder a refresh token and another hour.
   *
   * An unknown, unverifiable or somebody-else's token is a silent success, as
   * `provider.d.ts:47` requires — a throw here would turn the endpoint into a
   * way to ask which tokens exist.
   */
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const now = new Date();
    const grantId = await this.grantBehindPresentedToken(request.token);
    if (!grantId) return;
    const grant = await this.grantRepo.findGrant(grantId);
    if (!grant) return;

    // One check covering both shapes, deliberately in front of the branch rather
    // than inside either arm of it. RFC 7009 §2.1 states it as a MUST, and it is
    // load-bearing here rather than belt-and-braces: every client is public and
    // registration is open, so presenting any registered `client_id` is all the
    // authentication the endpoint has.
    if (grant.clientId !== client.client_id) {
      this.logger.warn(
        `mcp revoke refused: client ${client.client_id} presented a token for grant ${grant.id}`,
      );
      return;
    }

    for (const t of await this.grantRepo.revokeGrant(grant.id, now)) {
      this.revocation.revoke(t.jti, t.expiresAtMs);
    }

    // `client:<client_id>`, never the grant owner's address. `actorEmail` is
    // required and there is no human on this path — the caller is a client — so
    // filling it with the owner's would make the log read as though they revoked
    // their own access. It also keeps this path distinguishable from the account
    // page's, where there really is a person. The owner is named in the summary.
    await this.audit.record({
      actorEmail: `client:${client.client_id}`,
      action: 'oauth.revoke',
      summary: `client ${client.client_id} revoked the grant it holds for ${grant.email}`,
      targetType: 'mcp-grant',
      targetId: grant.id,
    });
  }

  /**
   * The grant a presented token belongs to, whichever of the two shapes it is,
   * or undefined when this board cannot vouch for it.
   *
   * The access-token branch verifies the SIGNATURE AND ISSUER and skips the
   * expiry check — `verifySignatureOnly`, never `verifySession` and never a bare
   * `decodeJwt`. `verifySession` validates `exp`, so it would reject an
   * hour-old token one line before the lookup that exists to accept it; a bare
   * decode would protect revocation by knowledge of a jti rather than by
   * possession of a token, and jtis reach an audit log.
   *
   * The lookup is `findAccessTokenAny`, not `findLiveAccessToken`. The live
   * variant returns null for an expired row, so revocation would answer a
   * cheerful 200 having revoked nothing while the refresh token stayed alive —
   * and once an access token lasts an hour, that is the ordinary case.
   */
  private async grantBehindPresentedToken(token: string): Promise<string | undefined> {
    const refreshRow = await this.grantRepo.findRefreshToken(sha256(token));
    if (refreshRow) return refreshRow.grantId;

    const verified = await this.sessions.verifySignatureOnly(token).catch(() => null);
    if (!verified?.jti) return undefined;
    const accessRow = await this.grantRepo.findAccessTokenAny(verified.jti);
    return accessRow?.grantId;
  }

  // Part of the OAuthServerProvider contract, used by the SDK's bearer
  // middleware. We do NOT mount that middleware on /mcp — the endpoint is
  // guarded by the Nest chain (JwtAuthGuard → TeamAccessGuard →
  // AgentScopeGuard) instead — so this runs only if the SDK internally needs
  // it. It stays strict (MCP-scoped tokens only) for correctness.
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const session = await this.sessions.verifySession(token);
    if (!session.boardScopes) throw new Error('Not an MCP token');
    // The grant behind the token has to still exist, matching the guard (#456).
    // Unreachable as long as board keeps the Nest chain in front of /mcp, but
    // the docblock above anticipates the SDK calling this — and without the read
    // it would be the one place in board that still says yes to a revoked token.
    if (!(await this.grantRepo.findLiveAccessToken(session.jti ?? '', new Date()))) {
      throw new Error('Token has no live grant');
    }
    return { token, clientId: 'atlas-mcp', scopes: session.boardScopes };
  }
}
