import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { GithubAuthController } from './github-auth.controller';
import type { GithubUserService } from './github-user.service';
import type { GithubAdmissionService } from './github-admission.service';
import type { SessionService } from './session.service';
import type { SessionRevocationService } from './session-revocation.service';

const SECRET = 'synthetic-board-session-secret-for-1450';
const USER = { githubUserId: '12345', githubLogin: 'octocat' };

function setup(opts: { existing?: { version: string } | null; admitted?: boolean } = {}) {
  const admission = {
    admits: vi.fn(async () => opts.admitted ?? true),
  };
  const github = {
    enabled: true,
    requireEnabled: vi.fn(),
    authorizeUrl: vi.fn((state: string) => `https://github.com/login/oauth/authorize?state=${state}`),
    callback: 'https://board.example.test/api/auth/github/callback',
    exchange: vi.fn(),
    fetchUser: vi.fn(async () => USER),
    connect: vi.fn(),
    disconnect: vi.fn(),
    refreshAccess: vi.fn(),
    db: {
      githubCredential: {
        findUnique: vi.fn(async () => opts.existing ?? null),
      },
    },
  };
  const sessions = {
    issueSession: vi.fn(async () => 'a-new-session-jwt'),
    verifySession: vi.fn(async () => ({ sub: USER.githubUserId, email: USER.githubLogin })),
    verifySignatureOnly: vi.fn(async () => ({ sub: USER.githubUserId, email: USER.githubLogin })),
  };
  const revocation = { check: vi.fn(async () => false), revoke: vi.fn(async () => true), bumpEpoch: vi.fn(async () => true) };
  const mcpGrants = { revokeAllForSubject: vi.fn(async () => []) } as never;
  const controller = new GithubAuthController(
    github as unknown as GithubUserService,
    admission as unknown as GithubAdmissionService,
    sessions as unknown as SessionService,
    revocation as unknown as SessionRevocationService,
    mcpGrants,
    new ConfigService({ BOARD_BASE_URL: 'https://board.example.test', BOARD_SESSION_SECRET: SECRET }),
  );
  const res = { clearCookie: vi.fn(), redirect: vi.fn(), cookie: vi.fn(), status: vi.fn(() => res), json: vi.fn() } as unknown as Response;
  return { github, admission, sessions, revocation, mcpGrants, controller, res };
}

const browser = (cookie: string): Request =>
  ({ headers: { cookie } }) as Request;

describe('GitHub sign-in login', () => {
  it('seals a state cookie and redirects to the GitHub authorize URL', () => {
    const s = setup();
    s.controller.login(s.res);
    expect(s.github.requireEnabled).toHaveBeenCalledOnce();
    expect(s.res.cookie).toHaveBeenCalledWith(
      'atlas_oauth_state',
      expect.any(String),
      expect.objectContaining({ httpOnly: true, path: '/' }),
    );
    expect(s.res.redirect).toHaveBeenCalledWith(expect.stringContaining('https://github.com/login/oauth/authorize'));
  });
});

describe('GitHub sign-in callback', () => {
  it('refuses a callback carrying no state, before spending the code', async () => {
    const s = setup();
    await s.controller.callback('code', 'the-state', { headers: {} } as Request, s.res);
    expect(s.github.exchange).not.toHaveBeenCalled();
    expect(s.res.redirect).toHaveBeenCalledWith('https://board.example.test/?error=auth_state');
  });

  it('refuses a state that does not match the cookie', async () => {
    const s = setup();
    await s.controller.callback('code', 'a-different-state', browser('atlas_oauth_state=the-state'), s.res);
    expect(s.github.exchange).not.toHaveBeenCalled();
  });

  it('exchanges the code, connects the GitHub account and mints the session', async () => {
    const s = setup();
    const pair = { access_token: 'synthetic' };
    s.github.exchange.mockResolvedValue(pair);
    await s.controller.callback('code', 'the-state', browser('atlas_oauth_state=the-state'), s.res);
    expect(s.github.exchange).toHaveBeenCalledWith({ code: 'code', redirect_uri: 'https://board.example.test/api/auth/github/callback' });
    expect(s.github.fetchUser).toHaveBeenCalledWith(pair);
    expect(s.github.connect).toHaveBeenCalledWith(USER.githubUserId, USER.githubLogin, pair, null);
    expect(s.sessions.issueSession).toHaveBeenCalledWith({ sub: USER.githubUserId, email: USER.githubLogin });
    expect(s.res.cookie).toHaveBeenCalledWith('atlas_session', 'a-new-session-jwt', expect.objectContaining({ httpOnly: true }));
    expect(s.res.redirect).toHaveBeenCalledWith('https://board.example.test/');
  });

  it('passes the existing credential version into the compare-and-swap', async () => {
    const s = setup({ existing: { version: 'v7' } });
    s.github.exchange.mockResolvedValue({ access_token: 'synthetic' });
    await s.controller.callback('code', 'the-state', browser('atlas_oauth_state=the-state'), s.res);
    expect(s.github.connect).toHaveBeenCalledWith(USER.githubUserId, USER.githubLogin, { access_token: 'synthetic' }, 'v7');
  });

  it('clears the state cookie on every path', async () => {
    const s = setup();
    s.github.exchange.mockResolvedValue({ access_token: 'synthetic' });
    await s.controller.callback('code', 'the-state', browser('atlas_oauth_state=the-state'), s.res);
    expect(s.res.clearCookie).toHaveBeenCalledWith('atlas_oauth_state', { path: '/' });
    const failed = setup();
    await failed.controller.callback('', '', { headers: {} } as Request, failed.res);
    expect(failed.res.clearCookie).toHaveBeenCalledWith('atlas_oauth_state', { path: '/' });
  });

  it('continues an MCP consent flow through the whitelisted next-hop only', async () => {
    const s = setup();
    s.github.exchange.mockResolvedValue({ access_token: 'synthetic' });
    await s.controller.callback('code', 'the-state', browser('atlas_oauth_state=the-state; atlas_next=/api/oauth/consent?req=abc'), s.res);
    expect(s.res.redirect).toHaveBeenCalledWith('/api/oauth/consent?req=abc');
  });

  it('does not follow a next-hop outside the consent path', async () => {
    const s = setup();
    s.github.exchange.mockResolvedValue({ access_token: 'synthetic' });
    await s.controller.callback('code', 'the-state', browser('atlas_oauth_state=the-state; atlas_next=https://evil.example'), s.res);
    expect(s.res.redirect).toHaveBeenCalledWith('https://board.example.test/');
  });

  it('refuses a GitHub account outside the allow list before storing a credential or minting a session', async () => {
    const s = setup({ admitted: false });
    s.github.exchange.mockResolvedValue({ access_token: 'synthetic' });
    await s.controller.callback('code', 'the-state', browser('atlas_oauth_state=the-state'), s.res);
    expect(s.admission.admits).toHaveBeenCalledWith(USER.githubUserId, USER.githubLogin, {
      token: 'synthetic',
      credentialVersion: undefined,
    });
    expect(s.github.connect).not.toHaveBeenCalled();
    expect(s.sessions.issueSession).not.toHaveBeenCalled();
    expect(s.res.cookie).not.toHaveBeenCalledWith('atlas_session', expect.anything(), expect.anything());
    expect(s.res.redirect).toHaveBeenCalledWith('https://board.example.test/?error=auth_failed');
  });

  it('answers auth_failed when the exchange or connect throws', async () => {
    const s = setup();
    s.github.exchange.mockRejectedValue(new Error('denied'));
    await s.controller.callback('code', 'the-state', browser('atlas_oauth_state=the-state'), s.res);
    expect(s.res.redirect).toHaveBeenCalledWith('https://board.example.test/?error=auth_failed');
    expect(s.sessions.issueSession).not.toHaveBeenCalled();
  });
});

describe('account management', () => {
  it('disconnect requires a human session with a stable identity', async () => {
    const s = setup();
    await expect(s.controller.disconnect({} as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.github.disconnect).not.toHaveBeenCalled();
    await s.controller.disconnect({ user: { email: 'octocat', boardSub: '12345' } } as never);
    expect(s.github.disconnect).toHaveBeenCalledWith('12345');
  });

  it('refresh-access requires a human session with a stable identity', async () => {
    const s = setup();
    await expect(s.controller.refreshAccess({} as never)).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.github.refreshAccess).not.toHaveBeenCalled();
    await s.controller.refreshAccess({ user: { email: 'octocat', boardSub: '12345' } } as never);
    expect(s.github.refreshAccess).toHaveBeenCalledWith('12345');
  });

  it('status reports whether the GitHub app is configured', () => {
    const s = setup();
    expect(s.controller.status()).toEqual({ configured: true });
  });
});
