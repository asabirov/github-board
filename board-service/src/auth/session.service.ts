import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { compactVerify, SignJWT, jwtVerify as verifyHs } from 'jose';
import { expandPreset, deriveLegacyPreset, type Preset } from './scopes';
import { SESSION_TTL_S } from './cookies';

/**
 * How long an MCP access token lives, in seconds — the one value both the signer
 * and the `expires_in` the client is told read from (#456).
 *
 * It used to be two unlinked literals that agreed by coincidence: a
 * `MCP_TOKEN_TTL_S` in `mcp-oauth.provider.ts` that only ever reached
 * `expires_in`, and a `.setExpirationTime('7d')` here that was the lifetime
 * actually enforced. Changing one advertised a number the other did not mint.
 *
 * An hour. It used to be seven days, which made a leaked token a week-long
 * full-authority API key that no sign-out could reach. The long-lived half is
 * the refresh token now — `MCP_REFRESH_TOKEN_TTL_S`, thirty days — and it is
 * revocable, rotating and bound to a grant, none of which an access token is.
 */
export const MCP_ACCESS_TOKEN_TTL_S = 3600;

/** How long a refresh token may be redeemed for, in seconds. */
export const MCP_REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;

export interface OverviewSession {
  /** The stable Board identity — the GitHub user id since GitHub-only sign-in. */
  sub: string;
  /** The GitHub login this identity signs in under. */
  email: string;
  /** Present only on MCP access tokens; drives the guard-level scope. */
  mcpScope?: 'agent' | 'full';
  /** Fine-grained scopes (#56). Present on new MCP tokens; expanded from
   *  mcpScope for legacy tokens by verifySession. */
  boardScopes?: string[];
  /** JWT id — the revocation key checked against the sign-out denylist (#112). */
  jti?: string;
  /** Token expiry (epoch seconds), used to bound how long a revoked jti is held. */
  exp?: number;
  /** When it was issued (epoch seconds). Weighed against the owner's revocation
   *  epoch (#679): a token issued before their last sign-out is dead, whatever
   *  its own jti says. */
  iat?: number;
}

/**
 * Mints and verifies the board's self-contained session and MCP JWTs (HS256).
 *
 * Sign-in is GitHub OAuth (`GithubAuthController`); this service holds only the
 * token half, which is identity-agnostic. The issuer stays 'atlas' — changing
 * it invalidates every live session token.
 */
@Injectable()
export class SessionService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  private get sessionSecret() {
    return new TextEncoder().encode(this.config.get<string>('BOARD_SESSION_SECRET')!);
  }

  /**
   * Mint a board session JWT (HS256), for `SESSION_TTL_S` — the same constant the
   * cookie's maxAge is set from, so the token and the cookie holding it cannot
   * expire on different days (#677). jti enables revocation.
   */
  async issueSession(s: OverviewSession): Promise<string> {
    return new SignJWT({ email: s.email })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(s.sub)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${SESSION_TTL_S}s`)
      .setIssuer('atlas')
      .sign(this.sessionSecret);
  }

  /**
   * Mint an MCP access token (HS256) carrying fine-grained scopes, under the jti
   * and the lifetime the caller hands in.
   *
   * The jti is the caller's, not this method's, and that is the whole point
   * (#456). It used to be minted here, so the only way the caller could learn
   * which token it had just issued was to decode its own output — and when that
   * decode failed the exchange carried on and left a grant nobody could ever
   * revoke. The caller now generates the jti, writes the row keyed on it, and
   * mints the token: one jti, one row, one grant, and no decode anywhere.
   *
   * The lifetime is the caller's for the same reason. `MCP_ACCESS_TOKEN_TTL_S`
   * is what the client is told in `expires_in`, so the signer taking anything
   * else would let the advertised number and the signed number drift apart.
   */
  async issueMcpToken(
    s: { sub: string; email: string },
    scopes: string[],
    opts: { jti: string; ttlSeconds: number },
  ): Promise<string> {
    // Compat: keep minting mcp_scope so any reader still on the old claim
    // (and legacy verifiers) keeps working during the transition.
    const legacy: Preset = deriveLegacyPreset(scopes);
    return new SignJWT({ email: s.email, board_scopes: scopes, mcp_scope: legacy })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(s.sub)
      .setJti(opts.jti)
      .setIssuedAt()
      .setExpirationTime(`${opts.ttlSeconds}s`)
      .setIssuer('atlas')
      .sign(this.sessionSecret);
  }

  /**
   * Check that this board signed the token, and nothing else. **For `/revoke`
   * and sign-out only — never use this in a guard** (#456, #677). Both ask "did
   * we mint this", not "may this act"; a guard asks the second.
   *
   * It differs from `verifySession` in exactly one way and that way is the
   * point: no expiry check. `jose`'s `jwtVerify` validates `exp`, so an
   * access token an hour past its lifetime throws `ERR_JWT_EXPIRED` — and once
   * an access token lives an hour, a client revoking the one it has been
   * holding presents an expired token as the ordinary case, not an edge one.
   * Verifying with `verifySession` there would refuse the revocation and answer
   * a cheerful 200 with the grant, and its refresh token, still alive.
   *
   * What it keeps is what makes revocation a possession check: the HS256
   * signature and `iss === 'atlas'`. A bare `decodeJwt` would protect the
   * operation by knowledge of a jti instead — and jtis are written into an audit
   * log that admins can read.
   *
   * A guard calling this would accept every expired token board ever minted.
   * `verifySession` is the one that answers "may this token act", and it is
   * deliberately not loosened to cover both.
   *
   * `GithubAuthController.logout` is the other sanctioned caller (#677), for
   * the same possession reason: without it, sign-out lodged a denylist entry off
   * an unverified decode, so knowing a jti was enough to revoke that session.
   */
  async verifySignatureOnly(
    token: string,
  ): Promise<{ sub: string; email: string; jti?: string }> {
    const { payload } = await compactVerify(token, this.sessionSecret);
    const claims = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    if (claims['iss'] !== 'atlas') throw new UnauthorizedException('Token issuer mismatch');
    return {
      sub: typeof claims['sub'] === 'string' ? claims['sub'] : '',
      email: typeof claims['email'] === 'string' ? claims['email'] : '',
      jti: typeof claims['jti'] === 'string' ? claims['jti'] : undefined,
    };
  }

  /** Verify a board session or MCP JWT. */
  async verifySession(token: string): Promise<OverviewSession> {
    const { payload } = await verifyHs(token, this.sessionSecret, { issuer: 'atlas' });
    // `sub` is checked rather than asserted. `jose` does not require the claim,
    // and `sub` is what every ownership question in the OAuth store is keyed on
    // — Prisma reads `undefined` in a where-clause as "no filter", so a session
    // carrying none would turn "my grants" into everyone's and "revoke mine"
    // into revoke anyone's. Latent rather than live: GitHub always returns a
    // user id, and `issueSession` always sets it. Checked anyway, for the same
    // reason `board_scopes` is below — this file must not hand downstream code
    // an authority claim it never read.
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new UnauthorizedException('Missing subject claim');
    }
    const out: OverviewSession = { sub: payload.sub, email: payload['email'] as string };
    const scope = payload['mcp_scope'];
    if (scope === 'agent' || scope === 'full') out.mcpScope = scope;
    const board = payload['board_scopes'];
    if (board !== undefined) {
      // Present but unreadable denies (#456). It used to leave `boardScopes`
      // undefined, and an undefined scope-set is not "no authority" downstream —
      // it is a plain human session: the guard's REST rejection and its
      // scoped-actor block both read this field, so neither fires and the token
      // lands on the unrestricted branch. An authorization claim nobody can
      // parse must not promote the bearer.
      if (!Array.isArray(board) || !board.every((x) => typeof x === 'string')) {
        throw new UnauthorizedException('Malformed board_scopes claim');
      }
      // `[]` stays valid and powerless: truthy, so the REST rejection still
      // fires, and empty, so the scope guard denies everything.
      out.boardScopes = board;
    } else if (out.mcpScope) {
      // Legacy token: no board_scopes claim → expand the preset so downstream
      // guards see a scope-set regardless of token age.
      out.boardScopes = expandPreset(out.mcpScope);
    }
    if (typeof payload.jti === 'string') out.jti = payload.jti;
    if (typeof payload.exp === 'number') out.exp = payload.exp;
    if (typeof payload.iat === 'number') out.iat = payload.iat;
    return out;
  }
}
