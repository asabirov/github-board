import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { SessionService } from './session.service';
import { SessionRevocationService } from './session-revocation.service';
import { parseCookies, SESSION_COOKIE } from './cookies';
import { matchAgentToken, parseAgentTokens } from './agent-tokens';
import { PRESET_SCOPES, deriveAgentFlag } from './scopes';
import { PersonalTokenService } from '../account/personal-token.service';
import { MCP_GRANT_REPOSITORY, type McpGrantRepository } from '../mcp/mcp-grant.repository';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * What a rejected bearer is answered with (RFC 6750 §3).
 *
 * Board set this header nowhere before #456, and its absence starts to cost the
 * day the grant table lands: every connected client is rejected at once, and a
 * 401 with no challenge is the difference between a client that re-runs the
 * handshake and one that simply stops. When somebody's agent silently stops
 * working, the workaround they reach for is a long-lived personal token — the
 * door this whole issue exists to make unnecessary.
 */
const BEARER_CHALLENGE = 'Bearer realm="board", error="invalid_token"';

/**
 * Validates the board session — a self-contained HS256 JWT minted after GitHub
 * sign-in. Read from the `atlas_session` cookie (browser) or a Bearer header
 * (programmatic). A Bearer value matching `BOARD_AGENT_TOKENS` authenticates as
 * an agent actor instead. When AUTH_DISABLED=true (dev), every request is
 * allowed with a stub user.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private readonly disabled: boolean;
  private readonly agentTokens: Map<string, string>;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SessionRevocationService) private readonly revocation: SessionRevocationService,
    @Inject(PersonalTokenService) private readonly personalTokens: PersonalTokenService,
    @Inject(MCP_GRANT_REPOSITORY) private readonly grants: McpGrantRepository,
  ) {
    this.disabled = this.config.get<boolean>('AUTH_DISABLED', false);
    this.agentTokens = parseAgentTokens(this.config.get<string>('BOARD_AGENT_TOKENS', ''));
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest();

    if (isPublic) return true;
    if (this.disabled) {
      req.user = {
        sub: 'dev-user',
        boardSub: 'dev-user',
        email: this.config.get<string>('DEV_USER_EMAIL', 'dev@example.com'),
      };
      return true;
    }

    const token = this.sessionToken(req);
    if (!token) throw new UnauthorizedException('No session');
    // Agent bearer tokens are matched before session verification: a 64-hex
    // bearer can only be an agent secret, never a JWT, so the paths are disjoint.
    const agentName = matchAgentToken(this.agentTokens, token);
    if (agentName) {
      // `staticAgent` is the one place this fact is written (#525). Everything
      // that treats a static token differently reads it through `isStaticAgent`,
      // which no longer looks at the address — a name is a string out of an
      // environment variable, and the shape of a string must not decide what a
      // caller is. Nothing forgeable reaches here: this object is built field by
      // field, and so is every other branch below, so no claim a caller controls
      // is ever spread into `req.user`.
      req.user = {
        sub: `agent:${agentName}`,
        email: `agent:${agentName}`,
        agent: true,
        staticAgent: true,
        scopes: [...PRESET_SCOPES.agent],
      };
      return true;
    }
    // Personal access tokens (#210): a `board_pat_` bearer is DB-backed, not a
    // JWT, so it must be resolved here before session verification. Unlike MCP
    // tokens it is valid on REST + MCP alike (it IS an API key). The owner is a
    // real teammate, so TeamAccessGuard passes; RequiredScopesGuard gates it by
    // the token's scopes. An unknown/expired/revoked board_pat_ is rejected
    // (never falls through to be parsed as a JWT).
    if (PersonalTokenService.looksLikePersonalToken(token)) {
      const pat = await this.personalTokens.verify(token);
      if (!pat) throw new UnauthorizedException('Invalid or expired token');
      const agent = deriveAgentFlag(pat.scopes);
      // `boardSub` is the token's RECORDED minting subject and never its address
      // (#892). `sub` stays the address, because that is what this branch has
      // always put there and what the MCP-grant and audit reads beside it match
      // on. A pre-#892 row has no recorded subject, so it carries none here: the
      // token keeps every board-local scope and `GithubPrincipalGuard` refuses
      // it the Github-backed surfaces rather than guessing whose grant it meant.
      const boardSub = pat.ownerSub ?? undefined;
      req.user = agent
        ? { sub: pat.ownerEmail, boardSub, email: pat.ownerEmail, agent: true, scopes: pat.scopes }
        : { sub: pat.ownerEmail, boardSub, email: pat.ownerEmail, scopes: pat.scopes };
      return true;
    }
    let session;
    try {
      session = await this.sessions.verifySession(token);
    } catch (err) {
      this.logger.warn(`Session rejected: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid session');
    }
    // Sign-out revocation (#112, durable since #679): a valid-but-revoked token
    // (captured before its owner signed out) is rejected until its natural
    // expiry. Two gates in one call — the token's own jti, and its owner's
    // revocation epoch, which kills every session issued before their last
    // sign-out including the ones nobody could name.
    //
    // It reads Postgres, so this is two primary-key reads rather than a map
    // lookup: no cache and no boot-time hydration, deliberately, because a
    // process-local view is exactly what the restart used to empty. Placed here,
    // it covers every JWT this board signs, MCP tokens included — a token minted
    // before the bump belongs to a grant that sign-out already revoked, so
    // covering it is strictly safer and simpler to explain than excluding it.
    if (await this.revocation.check(session.jti, session.sub, session.iat)) {
      throw new UnauthorizedException('Session revoked');
    }
    // MCP tokens (one-hour, scope-bearing, refreshable for thirty days) are only
    // valid at the MCP endpoint. Accepting them on REST routes would turn the
    // OAuth flow into a month-long full-authority API key, defeating the 8h
    // UI-session cap.
    //
    // This keys on boardScopes, the authoritative claim (#458). verifySession
    // sets it for new tokens (board_scopes) and legacy ones alike (expanded from
    // mcp_scope), so the rejection holds once the mcp_scope compat shim retires.
    // It also runs before the scoped-actor block below, which reads the same
    // field — so on a REST route a scope-bearing token is always rejected and
    // can never fall through to the unrestricted human-session branch.
    if (session.boardScopes && !/^\/mcp\/?$/.test(req.path ?? '')) {
      throw this.challenge(context, 'MCP token not valid on this route');
    }
    // At /mcp: a scope-bearing token becomes a scoped actor. The agent flag is
    // derived from scopes to preserve MCP tool gating.
    if (session.boardScopes) {
      // The grant behind the token has to still exist (#456). One primary-key
      // read on McpAccessToken, and it happens HERE for a reason: a scope-bearing
      // token on a REST route was already rejected above without it, a
      // `board_pat_` bearer returned long before, and a plain human session never
      // enters this block. So this read is /mcp's alone — a third primary-key
      // read on top of the two the revocation check above now issues for every
      // session JWT (#679), rather than a read every caller pays. The grant's
      // revocation state is denormalized onto the token row, so there is no join
      // and no second query.
      //
      // A token with no row is a token minted before this table existed, and the
      // right answer to it is the same as the answer to a revoked one: reject.
      // Every connected client re-authorizes once on deploy day, by design.
      //
      // The guard must NEVER branch on whether the store looks available. There
      // is no `enabled` flag to read, deliberately — `BOARD_MCP_ENABLED=true`
      // requires a database at boot, and the only correct answer to a missing row
      // is to refuse. A guard that fails open when its store looks unavailable is
      // the vacuous shape this repository has already shipped twice.
      const live = session.jti
        ? await this.grants.findLiveAccessToken(session.jti, new Date())
        : null;
      if (!live) {
        this.logger.warn(`MCP token rejected: no live grant (sub=${session.sub})`);
        throw this.challenge(context, 'Grant revoked or unknown');
      }
      const scopes = session.boardScopes;
      const agent = deriveAgentFlag(scopes);
      // An MCP grant records the consenting person's GitHub user id, so this
      // branch has the stable identity a Github lookup needs (#892).
      req.user = agent
        ? { sub: session.sub, boardSub: session.sub, email: session.email, agent: true, scopes }
        : { sub: session.sub, boardSub: session.sub, email: session.email, scopes };
      return true;
    }
    // Plain human UI session — no scope limitation.
    req.user = { sub: session.sub, boardSub: session.sub, email: session.email, sessionExpiresAt: session.exp };
    return true;
  }

  /**
   * Refuse a bearer, and say so in the way a compliant client understands.
   *
   * Returned rather than thrown so the call site reads `throw this.challenge(…)`
   * — a helper that threw would leave the compiler unable to see that the branch
   * ends there.
   */
  private challenge(context: ExecutionContext, message: string): UnauthorizedException {
    const res = context.switchToHttp().getResponse<{
      setHeader(name: string, value: string): void;
    }>();
    res.setHeader('WWW-Authenticate', BEARER_CHALLENGE);
    return new UnauthorizedException(message);
  }

  private sessionToken(req: {
    headers: Record<string, string | undefined>;
  }): string | null {
    const auth = req.headers['authorization'] ?? req.headers['Authorization'];
    if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
    return parseCookies(req.headers['cookie'])[SESSION_COOKIE] ?? null;
  }
}
