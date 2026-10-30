import { SESSION_HINT_COOKIE, sessionHintId, setSessionHint } from './session-hint';
import { Controller, Get, Post, HttpCode, Inject, Logger, Req, Res, Query, ForbiddenException, Header } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { decodeJwt } from 'jose';
import { Public } from './jwt-auth.guard';
import { Writes } from '../capability/writes.decorator';
import { GithubUserService } from './github-user.service';
import { GithubAdmissionService } from './github-admission.service';
import { SessionService } from './session.service';
import { SessionRevocationService } from './session-revocation.service';
import { newStateValue } from './github-oauth-state';
import { MCP_GRANT_REPOSITORY, type McpGrantRepository } from '../mcp/mcp-grant.repository';
import { isHumanSession } from './human-session';
import {
  parseCookies,
  NEXT_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SESSION_TTL_S,
  STATE_COOKIE,
} from './cookies';

/**
 * Longest jti sign-out will hold. Every jti this board mints is a `randomUUID()`
 * — 36 characters, in `issueSession` and on the MCP path alike — so no real
 * sign-out comes near it.
 */
const MAX_JTI_LENGTH = 128;

/**
 * Sign-in and account management for the GitHub App user flow (#1450).
 * Sign-in IS the connection: the callback stores the credential and mints the
 * board session in one step. All routes are public (pre-auth) except the
 * account-management ones below.
 */
@Controller('auth/github')
export class GithubAuthController {
  private readonly logger = new Logger(GithubAuthController.name);

  constructor(
    @Inject(GithubUserService) private readonly github: GithubUserService,
    @Inject(GithubAdmissionService) private readonly admission: GithubAdmissionService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(SessionRevocationService) private readonly revocation: SessionRevocationService,
    @Inject(MCP_GRANT_REPOSITORY) private readonly mcpGrants: McpGrantRepository,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  private get base() {
    return this.config.get<string>('BOARD_BASE_URL')!;
  }
  private secureCookie(res: Response, name: string, value: string, maxAgeSec: number) {
    res.cookie(name, value, {
      httpOnly: true,
      secure: this.base.startsWith('https'),
      sameSite: 'lax',
      path: '/',
      maxAge: maxAgeSec * 1000,
    });
  }

  @Public()
  @Get('status')
  status() { return { configured: this.github.enabled }; }

  @Public()
  @Get('login')
  login(@Res() res: Response) {
    this.github.requireEnabled();
    const state = newStateValue();
    this.secureCookie(res, STATE_COOKIE, state, 600);
    res.redirect(this.github.authorizeUrl(state));
  }

  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const cookies = parseCookies(req.headers.cookie);
    // Cleared on every path, so a browser gets one attempt per state.
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (!code || !state || state !== cookies[STATE_COOKIE]) {
      return res.redirect(`${this.base}/?error=auth_state`);
    }
    try {
      const pair = await this.github.exchange({ code, redirect_uri: this.github.callback });
      const user = await this.github.fetchUser(pair);
      // The credential version this sign-in replaces, so two racing sign-ins for
      // one GitHub account cannot both write the rotating refresh token.
      const existing = await this.github.db.githubCredential.findUnique({
        where: { githubUserId: user.githubUserId },
      });
      // Check admission on the stable numeric id BEFORE anything is stored or a
      // session is minted, so a person outside BOARD_ALLOWED_GITHUB leaves with
      // nothing. Organisation membership uses the fresh token just exchanged.
      const admitted = await this.admission.admits(user.githubUserId, user.githubLogin, {
        token: pair.access_token,
        credentialVersion: existing?.version ?? undefined,
      });
      if (!admitted) {
        this.logger.warn(`Denied ${user.githubLogin}: not in the GitHub sign-in allow list`);
        return res.redirect(`${this.base}/?error=auth_failed`);
      }
      await this.github.connect(user.githubUserId, user.githubLogin, pair, existing?.version ?? null);
      const session = await this.sessions.issueSession({ sub: user.githubUserId, email: user.githubLogin });
      this.secureCookie(res, SESSION_COOKIE, session, SESSION_TTL_S);
      setSessionHint(res, this.base, sessionHintId(this.config.get<string>('BOARD_SESSION_SECRET')!, user.githubUserId), null, SESSION_TTL_S);
      // MCP OAuth continuation: honor the whitelisted next-hop only.
      const next = cookies[NEXT_COOKIE];
      res.clearCookie(NEXT_COOKIE, { path: '/' });
      if (next?.startsWith('/api/oauth/consent?req=')) {
        return res.redirect(next);
      }
      return res.redirect(`${this.base}/`);
    } catch (err) {
      this.logger.error(`auth callback failed: ${(err as Error).message}`);
      return res.redirect(`${this.base}/?error=auth_failed`);
    }
  }

  @Writes()
  @Public()
  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response) {
    // Revoke the presented session (cookie, or a Bearer for programmatic use) so
    // a captured copy can't be replayed for the rest of its lifetime (#112).
    // Durable since #679 — the row outlives this process, so a redeploy no longer
    // resurrects it.
    const auth = req.headers['authorization'];
    const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : undefined;
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? bearer;
    let session: { sub: string; iat?: number } | null = null;
    let revokeJti: string | undefined;
    let revokeUntil = 0;
    if (token) {
      try {
        await this.sessions.verifySignatureOnly(token);
        const { jti, exp } = decodeJwt(token);
        const cap = Date.now() + SESSION_TTL_MS;
        const claimed = typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : cap;
        if (typeof jti === 'string' && jti.length <= MAX_JTI_LENGTH) {
          revokeJti = jti;
          revokeUntil = Math.min(claimed, cap);
        }
      } catch {
        // Malformed, or not signed by this board — nothing to revoke. The cookie
        // still clears below: a bad token must never refuse a sign-out (#456).
      }
      try {
        session = await this.sessions.verifySession(token);
      } catch {
        // Not a valid session (expired, forged, or malformed) — no grants to
        // revoke, and swallowed exactly as it always was.
      }
    }

    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie(SESSION_HINT_COOKIE, { path: '/' });

    let revocationLanded = true;

    let alreadyDead = false;
    if (revokeJti || session) {
      try {
        alreadyDead = await this.revocation.check(revokeJti, session?.sub, session?.iat);
      } catch (err) {
        this.logger.error(`sign-out could not read session revocation: ${(err as Error).message}`);
        alreadyDead = true;
        revocationLanded = false;
      }
    }

    if (revokeJti) {
      revocationLanded = (await this.revocation.revoke(revokeJti, revokeUntil)) && revocationLanded;
    }
    if (session && !alreadyDead) {
      revocationLanded = (await this.revocation.bumpEpoch(session.sub)) && revocationLanded;
    }

    if (session) {
      try {
        for (const g of await this.mcpGrants.revokeAllForSubject(session.sub, new Date())) {
          revocationLanded = (await this.revocation.revoke(g.jti, g.expiresAtMs)) && revocationLanded;
        }
      } catch (err) {
        this.logger.error(`sign-out could not revoke stored grants: ${(err as Error).message}`);
        res.status(503).json({
          ok: false,
          error: 'Signed out of this browser, but connected clients could not be revoked.',
        });
        return;
      }
    }
    if (!revocationLanded) {
      this.logger.error('sign-out could not record the revocation durably');
      res.status(503).json({
        ok: false,
        error:
          'Signed out of this browser, but the revocation was not recorded — a copy of this cookie still works until it expires. Sign out again from another browser where you are still signed in, or ask an admin to revoke the session.',
      });
      return;
    }
    res.status(200).json({ ok: true });
  }

  @Writes() @Post('disconnect')
  @Header('Cache-Control', 'no-store')
  async disconnect(@Req() req: Request & { user?: { email: string; boardSub?: string; scopes?: string[] } }) {
    if (!req.user || !isHumanSession(req.user) || !req.user.boardSub) throw new ForbiddenException('Disconnect GitHub from your Board browser session');
    await this.github.disconnect(req.user.boardSub);
    return { ok: true };
  }

  @Writes() @Post('refresh-access')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  async refreshAccess(@Req() req: Request & { user?: { email: string; boardSub?: string; scopes?: string[] } }): Promise<void> {
    if (!req.user || !isHumanSession(req.user) || !req.user.boardSub) throw new ForbiddenException('Refresh GitHub access from your Board browser session');
    await this.github.refreshAccess(req.user.boardSub);
  }
}
