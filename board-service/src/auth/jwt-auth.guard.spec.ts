import { describe, it, expect, vi } from 'vitest';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SignJWT } from 'jose';
import { JwtAuthGuard } from './jwt-auth.guard';
import { SessionService } from './session.service';
import { SessionRevocationService } from './session-revocation.service';
import { MemorySessionRevocationStore } from './session-revocation.repository';
import { BOARD_READ, BOARD_ADMIN, PRESET_SCOPES, expandPreset } from './scopes';
import {
  InMemoryMcpGrantRepository,
  type McpGrantRepository,
} from '../mcp/mcp-grant.repository';

const HEX_A = 'a'.repeat(64);

/**
 * The jti every MCP token in this file is signed under, and the one the default
 * grant store holds a live row for (#456). One constant rather than a literal per
 * test: the guard now pairs the token's jti with a row, and a test where those two
 * drift apart would fail for a reason that has nothing to do with what it asserts.
 */
const MCP_JTI = 'mcp-jti-live';

/**
 * A grant store holding one live access-token row for `jti`.
 *
 * The write is not awaited because `makeGuard` has around twenty synchronous call
 * sites and `InMemoryMcpGrantRepository.recordAccessToken` contains no `await` —
 * an async function's body runs synchronously up to its first one, so the row is
 * in the map before this returns.
 */
function grantsHolding(jti = MCP_JTI): InMemoryMcpGrantRepository {
  const repo = new InMemoryMcpGrantRepository();
  void repo.recordAccessToken({
    jti,
    grantId: 'grant-1',
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return repo;
}

function makeGuard(opts: {
  agentTokens?: string;
  verify?: (t: string) => Promise<unknown>;
  revoked?: (jti: string | undefined) => boolean;
  revocation?: SessionRevocationService;
  pat?: (t: string) => Promise<{ ownerEmail: string; ownerSub: string | null; scopes: string[] } | null>;
  grants?: McpGrantRepository;
}) {
  const config = {
    get: (key: string, def?: unknown) => {
      if (key === 'BOARD_AGENT_TOKENS') return opts.agentTokens ?? '';
      if (key === 'AUTH_DISABLED') return false;
      return def;
    },
  } as any;
  const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
  const google = {
    verifySession: opts.verify ?? (async () => ({ sub: 'u1', email: 'user@example.com' })),
  } as any;
  // The guard asks `check`, not `isRevoked` (#679): the first reads through to
  // the store, the second is only what this process remembers. A fake answering
  // the old method would leave every test here green against a guard that had
  // stopped checking anything.
  const revoked = opts.revoked ?? (() => false);
  const revocation = opts.revocation ?? ({ check: async (jti: string | undefined) => revoked(jti) } as any);
  const personalTokens = { verify: opts.pat ?? (async () => null) } as any;
  const grants = opts.grants ?? grantsHolding();
  return new JwtAuthGuard(config, reflector, google, revocation, personalTokens, grants);
}

function ctx(headers: Record<string, string>, path = '/api/board') {
  const req: any = { headers, path };
  // A stand-in for the express response, which the guard reaches for to set the
  // `WWW-Authenticate` challenge on a rejection.
  const res: any = {
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => null,
    getClass: () => null,
  } as any;
  return { req, res, context };
}

describe('JwtAuthGuard agent tokens', () => {
  it('authenticates a valid agent token as an agent user', async () => {
    const guard = makeGuard({ agentTokens: `octocat-cli:${HEX_A}` });
    const { req, context } = ctx({ authorization: `Bearer ${HEX_A}` });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toEqual({
      sub: 'agent:octocat-cli',
      email: 'agent:octocat-cli',
      agent: true,
      staticAgent: true,
      scopes: [BOARD_READ],
    });
  });

  /**
   * #525. `staticAgent` is what the whole service reads to tell a
   * `BOARD_AGENT_TOKENS` token from a person, and this is the ONE place it is
   * written. The `toEqual` above already pins that; these pin the two properties
   * that make it safe to rely on — no other branch sets it, and no branch spreads
   * a caller's claims into `req.user`, so it cannot be forged from the wire.
   */
  it('sets the static-agent flag ONLY on the BOARD_AGENT_TOKENS branch', async () => {
    const human = ctx({ authorization: 'Bearer header.payload.sig' });
    await expect(makeGuard({}).canActivate(human.context)).resolves.toBe(true);
    expect(human.req.user.staticAgent).toBeUndefined();

    const mcpGuard = makeGuard({
      verify: async () => ({
        sub: 'u1',
        email: 'a@example.com',
        boardScopes: [BOARD_READ],
        jti: MCP_JTI,
      }),
    });
    const mcp = ctx({ authorization: 'Bearer header.payload.sig' }, '/mcp');
    await expect(mcpGuard.canActivate(mcp.context)).resolves.toBe(true);
    expect(mcp.req.user.staticAgent).toBeUndefined();

    const patGuard = makeGuard({
      pat: async () => ({ ownerEmail: 'ivan.roslov@example.com', ownerSub: 'google-sub-ivan', scopes: [BOARD_READ] }),
    });
    const pat = ctx({ authorization: 'Bearer board_pat_abc' });
    await expect(patGuard.canActivate(pat.context)).resolves.toBe(true);
    expect(pat.req.user.staticAgent).toBeUndefined();
  });

  it('cannot be talked into the flag by a session whose claims assert it', async () => {
    const guard = makeGuard({
      verify: async () => ({ sub: 'u1', email: 'a@example.com', staticAgent: true, agent: true }),
    });
    const { req, context } = ctx({ authorization: 'Bearer header.payload.sig' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toEqual({ sub: 'u1', boardSub: 'u1', email: 'a@example.com' });
  });

  it('rejects a 64-hex bearer that matches no configured token', async () => {
    const guard = makeGuard({
      agentTokens: `octocat-cli:${HEX_A}`,
      verify: async () => {
        throw new Error('not a JWT');
      },
    });
    const { context } = ctx({ authorization: `Bearer ${'c'.repeat(64)}` });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects agent-shaped bearers when no tokens are configured', async () => {
    const guard = makeGuard({
      verify: async () => {
        throw new Error('not a JWT');
      },
    });
    const { context } = ctx({ authorization: `Bearer ${HEX_A}` });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('still verifies session JWTs via Google when the bearer is not agent-shaped', async () => {
    const guard = makeGuard({ agentTokens: `octocat-cli:${HEX_A}` });
    const { req, context } = ctx({ authorization: 'Bearer eyJhbGciOi.session.jwt' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toEqual({ sub: 'u1', boardSub: 'u1', email: 'user@example.com' });
  });

  it('resolves a board_pat_ personal token to a scoped actor with the owner email (#210)', async () => {
    const guard = makeGuard({
      pat: async () => ({ ownerEmail: 'ivan@example.com', ownerSub: 'google-sub-ivan', scopes: [BOARD_READ] }),
    });
    const { req, context } = ctx({ authorization: 'Bearer board_pat_abc123' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toEqual({
      sub: 'ivan@example.com',
      boardSub: 'google-sub-ivan',
      email: 'ivan@example.com',
      agent: true,
      scopes: [BOARD_READ],
    });
  });

  it('an admin-scoped personal token is a non-agent actor', async () => {
    const guard = makeGuard({
      pat: async () => ({ ownerEmail: 'a@example.com', ownerSub: 'google-sub-a', scopes: ['board:read', 'board:admin'] }),
    });
    const { req, context } = ctx({ authorization: 'Bearer board_pat_xyz' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toEqual({
      sub: 'a@example.com',
      boardSub: 'google-sub-a',
      email: 'a@example.com',
      scopes: ['board:read', 'board:admin'],
    });
  });

  it('rejects an unknown/expired/revoked board_pat_ token (never parsed as a JWT)', async () => {
    const guard = makeGuard({
      pat: async () => null,
      verify: async () => {
        throw new Error('must not reach JWT verification');
      },
    });
    const { context } = ctx({ authorization: 'Bearer board_pat_deadbeef' });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps an mcp agent-scoped session to an agent actor with the real email', async () => {
    // boardScopes reflects the real SessionService.verifySession output
    // (Task 2 populates it for every mcpScope-bearing token, new or legacy).
    const guard = makeGuard({
      verify: async () => ({
        sub: 'u1',
        email: 'a@example.com',
        mcpScope: 'agent',
        boardScopes: [BOARD_READ],
        jti: MCP_JTI,
      }),
    });
    const { req, context } = ctx({ authorization: 'Bearer eyJhbGciOi.mcp.jwt' }, '/mcp');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toEqual({
      sub: 'u1',
      boardSub: 'u1',
      email: 'a@example.com',
      agent: true,
      scopes: [BOARD_READ],
    });
  });

  it('maps an mcp full-scoped session to a plain user at /mcp', async () => {
    const guard = makeGuard({
      verify: async () => ({
        sub: 'u1',
        email: 'a@example.com',
        mcpScope: 'full',
        boardScopes: [BOARD_READ, BOARD_ADMIN],
        jti: MCP_JTI,
      }),
    });
    const { req, context } = ctx({ authorization: 'Bearer eyJhbGciOi.mcp.jwt' }, '/mcp');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toEqual({
      sub: 'u1',
      boardSub: 'u1',
      email: 'a@example.com',
      scopes: [BOARD_READ, BOARD_ADMIN],
    });
  });

  it('rejects an MCP token on a REST route (not a week-long API key)', async () => {
    for (const scope of ['agent', 'full'] as const) {
      // The stub mirrors what verifySession really returns: an mcpScope-bearing
      // token always carries boardScopes too, expanded from the preset when the
      // token predates the board_scopes claim.
      const guard = makeGuard({
        verify: async () => ({
          sub: 'u1',
          email: 'a@example.com',
          mcpScope: scope,
          boardScopes: expandPreset(scope),
        }),
      });
      const { context } = ctx({ authorization: 'Bearer eyJhbGciOi.mcp.jwt' }, '/api/okr');
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('still accepts a plain UI session (no mcpScope) on REST routes', async () => {
    const guard = makeGuard({
      verify: async () => ({ sub: 'u1', email: 'a@example.com' }),
    });
    const { req, context } = ctx({ authorization: 'Bearer eyJhbGciOi.session.jwt' }, '/api/board');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toEqual({ sub: 'u1', boardSub: 'u1', email: 'a@example.com' });
  });

  it('rejects a valid-but-revoked session (signed out) (#112)', async () => {
    const guard = makeGuard({
      verify: async () => ({ sub: 'u1', email: 'a@example.com', jti: 'revoked-1' }),
      revoked: (jti) => jti === 'revoked-1',
    });
    const { context } = ctx({ authorization: 'Bearer eyJhbGciOi.session.jwt' }, '/api/board');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a session whose jti is not on the denylist', async () => {
    const guard = makeGuard({
      verify: async () => ({ sub: 'u1', email: 'a@example.com', jti: 'live-1' }),
      revoked: (jti) => jti === 'some-other-jti',
    });
    const { context } = ctx({ authorization: 'Bearer eyJhbGciOi.session.jwt' }, '/api/board');
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('accepts a legacy pre-#112 session with no jti', async () => {
    // The real SessionRevocationService returns false for an undefined jti, so a
    // token minted before jti existed still authenticates.
    const guard = makeGuard({ verify: async () => ({ sub: 'u1', email: 'a@example.com' }) });
    const { req, context } = ctx({ authorization: 'Bearer eyJhbGciOi.legacy.jwt' }, '/api/board');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toEqual({ sub: 'u1', boardSub: 'u1', email: 'a@example.com' });
  });
});

describe('req.user.scopes resolution (#56)', () => {
  it('static agent token resolves to [read] and agent=true', async () => {
    const guard = makeGuard({ agentTokens: `octocat-cli:${HEX_A}` });
    const { req, context } = ctx({ authorization: `Bearer ${HEX_A}` });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user.scopes).toEqual([BOARD_READ]);
    expect(req.user.agent).toBe(true);
  });

  it('a full-scoped MCP token at /mcp resolves to the full set and agent=false', async () => {
    const guard = makeGuard({
      verify: async () => ({
        sub: 'u1',
        email: 'a@example.com',
        mcpScope: 'full',
        boardScopes: [BOARD_READ, BOARD_ADMIN],
        jti: MCP_JTI,
      }),
    });
    const { req, context } = ctx({ authorization: 'Bearer eyJhbGciOi.mcp.jwt' }, '/mcp');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user.scopes).toContain(BOARD_ADMIN);
    // deriveAgentFlag is false for a full (admin-bearing) scope-set; the guard
    // omits the `agent` key entirely in that case (matches the pre-#56 shape
    // where a full-scope mcp session had no agent field at all).
    expect(req.user.agent).toBeUndefined();
  });

  it('a legacy mcp_scope=agent token (no board_scopes claim) still resolves scopes via expansion', async () => {
    // Genuinely exercise the legacy path: mint a raw HS256 token carrying ONLY
    // mcp_scope (no board_scopes), and run it through the real SessionService
    // (Task 2) so its verifySession expansion actually fires, then through the
    // guard (Task 4) to confirm req.user.scopes/agent resolve correctly.
    const secret = 's'.repeat(32);
    const config = {
      get: (key: string, def?: unknown) => {
        if (key === 'BOARD_AGENT_TOKENS') return '';
        if (key === 'AUTH_DISABLED') return false;
        if (key === 'BOARD_SESSION_SECRET') return secret;
        return def;
      },
    } as any;
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const google = new SessionService(config);
    const revocation = { check: async () => false } as any;
    const personalTokens = { verify: async () => null } as any;
    const guard = new JwtAuthGuard(
      config,
      reflector,
      google,
      revocation,
      personalTokens,
      grantsHolding(),
    );

    const token = await new SignJWT({ email: 'a@example.com', mcp_scope: 'agent' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setJti(MCP_JTI)
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer('atlas')
      .sign(new TextEncoder().encode(secret));

    const { req, context } = ctx({ authorization: `Bearer ${token}` }, '/mcp');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user.scopes).toEqual([BOARD_READ]);
    expect(req.user.agent).toBe(true);
  });

  it('a human UI session gets no scopes and no agent flag', async () => {
    const guard = makeGuard({
      verify: async () => ({ sub: 'u1', email: 'a@example.com' }),
    });
    const { req, context } = ctx({ authorization: 'Bearer eyJhbGciOi.session.jwt' }, '/api/board');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user.scopes).toBeUndefined();
    expect(req.user.agent).toBeUndefined();
  });
});

// The route gate must key on boardScopes, the authoritative claim, not on the
// legacy mcp_scope compat shim that #456 retires. These four cases pin both
// halves: a token minted without mcp_scope is still confined to /mcp, and one
// carrying only mcp_scope still works there.
describe('MCP route confinement keys on boardScopes (#458)', () => {
  /** A guard wired to the real SessionService, so legacy expansion fires. */
  function realGuard(secret: string, grants: McpGrantRepository = grantsHolding()) {
    const config = {
      get: (key: string, def?: unknown) => {
        if (key === 'BOARD_AGENT_TOKENS') return '';
        if (key === 'AUTH_DISABLED') return false;
        if (key === 'BOARD_SESSION_SECRET') return secret;
        return def;
      },
    } as any;
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const revocation = { check: async () => false } as any;
    const personalTokens = { verify: async () => null } as any;
    return new JwtAuthGuard(
      config,
      reflector,
      new SessionService(config),
      revocation,
      personalTokens,
      grants,
    );
  }

  /** Sign a raw HS256 session token with an arbitrary claim set. */
  function sign(secret: string, claims: Record<string, unknown>) {
    return new SignJWT({ email: 'a@example.com', ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      // Every token this helper signs shares the jti the default grant store
      // holds a row for, so a token that reaches /mcp finds its grant there.
      .setJti(MCP_JTI)
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer('atlas')
      .sign(new TextEncoder().encode(secret));
  }

  it('rejects a board_scopes-only token (no mcp_scope) on a REST route', async () => {
    const secret = 'b'.repeat(32);
    const guard = realGuard(secret);
    const token = await sign(secret, { board_scopes: [BOARD_READ] });
    for (const path of ['/api/okr', '/api/board', '/api/issues/1']) {
      const { req, context } = ctx({ authorization: `Bearer ${token}` }, path);
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
      // It must never land in the unrestricted human-session branch either.
      expect(req.user).toBeUndefined();
    }
  });

  it('accepts that same board_scopes-only token at /mcp as a scoped actor', async () => {
    const secret = 'b'.repeat(32);
    const guard = realGuard(secret);
    const token = await sign(secret, { board_scopes: [BOARD_READ] });
    const { req, context } = ctx({ authorization: `Bearer ${token}` }, '/mcp');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toEqual({
      sub: 'u1',
      boardSub: 'u1',
      email: 'a@example.com',
      agent: true,
      scopes: [BOARD_READ],
    });
  });

  it('rejects a legacy mcp_scope-only token on a REST route', async () => {
    const secret = 'b'.repeat(32);
    const guard = realGuard(secret);
    for (const scope of ['agent', 'full'] as const) {
      const token = await sign(secret, { mcp_scope: scope });
      const { req, context } = ctx({ authorization: `Bearer ${token}` }, '/api/okr');
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(req.user).toBeUndefined();
    }
  });

  it('accepts a legacy mcp_scope-only token at /mcp with the preset expanded', async () => {
    const secret = 'b'.repeat(32);
    const guard = realGuard(secret);

    const agentToken = await sign(secret, { mcp_scope: 'agent' });
    const agentCall = ctx({ authorization: `Bearer ${agentToken}` }, '/mcp');
    await expect(guard.canActivate(agentCall.context)).resolves.toBe(true);
    expect(agentCall.req.user).toEqual({
      sub: 'u1',
      boardSub: 'u1',
      email: 'a@example.com',
      agent: true,
      scopes: [...PRESET_SCOPES.agent],
    });

    const fullToken = await sign(secret, { mcp_scope: 'full' });
    const fullCall = ctx({ authorization: `Bearer ${fullToken}` }, '/mcp');
    await expect(guard.canActivate(fullCall.context)).resolves.toBe(true);
    expect(fullCall.req.user).toEqual({
      sub: 'u1',
      boardSub: 'u1',
      email: 'a@example.com',
      scopes: [...PRESET_SCOPES.full],
    });
  });
});

/**
 * The grant behind an MCP token has to still exist (#456).
 *
 * A token used to be self-contained: whoever held one was authenticated for its
 * full seven days and no sign-out, revocation or restart could reach it. The
 * guard now pairs the token's `jti` with a row, so the authorization is the row
 * and the token is only a claim on it.
 *
 * The two cost tests at the bottom are not decoration. The whole case for this
 * read being affordable is WHERE it sits — inside the scope-bearing block, after
 * the REST rejection — and a refactor that lifts it above either boundary would
 * put a database read on every human page view with nothing to notice.
 */
describe('MCP grant lookup (#456)', () => {
  /** What verifySession returns for an MCP access token carrying `jti`. */
  const mcpSession = (jti?: string) => async () => ({
    sub: 'u1',
    email: 'a@example.com',
    boardScopes: [BOARD_READ],
    ...(jti === undefined ? {} : { jti }),
  });

  it('accepts an mcp token at /mcp whose jti still has a live grant row', async () => {
    const guard = makeGuard({ verify: mcpSession(MCP_JTI) });
    const { req, context } = ctx({ authorization: 'Bearer eyJhbGciOi.mcp.jwt' }, '/mcp');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toEqual({
      sub: 'u1',
      boardSub: 'u1',
      email: 'a@example.com',
      agent: true,
      scopes: [BOARD_READ],
    });
  });

  // Deploy day, tested as itself: every token minted before the table existed
  // carries a jti no row was ever written for, so every connected client
  // re-authorizes once. That is the settled behaviour, not an accident of it.
  it('rejects an mcp token whose jti has no row — the deploy-day cutover', async () => {
    const guard = makeGuard({
      verify: mcpSession('minted-before-the-table-existed'),
      grants: grantsHolding(),
    });
    const { req, context } = ctx({ authorization: 'Bearer eyJhbGciOi.mcp.jwt' }, '/mcp');
    await expect(guard.canActivate(context)).rejects.toThrow(/Grant revoked or unknown/);
    // Never the unrestricted human-session branch, whatever else happens.
    expect(req.user).toBeUndefined();
  });

  it('stops accepting a token the moment its grant is revoked', async () => {
    const grants = grantsHolding();
    const guard = makeGuard({ verify: mcpSession(MCP_JTI), grants });
    const before = ctx({ authorization: 'Bearer eyJhbGciOi.mcp.jwt' }, '/mcp');
    // Non-null before and null after, the same token through the same guard:
    // asserting only the rejection would pass equally against a guard that
    // refused every MCP token outright.
    await expect(guard.canActivate(before.context)).resolves.toBe(true);

    await grants.revokeGrant('grant-1', new Date());

    const after = ctx({ authorization: 'Bearer eyJhbGciOi.mcp.jwt' }, '/mcp');
    await expect(guard.canActivate(after.context)).rejects.toThrow(/Grant revoked or unknown/);
  });

  // A scope-bearing token with no jti at all cannot name a grant, so there is no
  // row to consult and nothing to check it against. Letting it through would pass
  // every other test in this file and reopen the hole the read exists to close.
  it('rejects a scope-bearing token carrying no jti', async () => {
    const guard = makeGuard({ verify: mcpSession(undefined) });
    const { req, context } = ctx({ authorization: 'Bearer eyJhbGciOi.mcp.jwt' }, '/mcp');
    await expect(guard.canActivate(context)).rejects.toThrow(/Grant revoked or unknown/);
    expect(req.user).toBeUndefined();
  });

  it('answers a rejected mcp token with a bearer challenge', async () => {
    const guard = makeGuard({ verify: mcpSession('no-such-jti') });
    const { res, context } = ctx({ authorization: 'Bearer eyJhbGciOi.mcp.jwt' }, '/mcp');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    // Without a challenge a client has nothing telling it to re-run the
    // handshake, and the person reaches for a long-lived personal token instead.
    expect(res.headers['WWW-Authenticate']).toBe('Bearer realm="board", error="invalid_token"');
  });

  it('answers the wrong-route rejection with a bearer challenge too', async () => {
    const guard = makeGuard({ verify: mcpSession(MCP_JTI) });
    const { res, context } = ctx({ authorization: 'Bearer eyJhbGciOi.mcp.jwt' }, '/api/issues');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(res.headers['WWW-Authenticate']).toBe('Bearer realm="board", error="invalid_token"');
  });

  it('does not read the grant store for a plain human session', async () => {
    const grants = grantsHolding();
    const spy = vi.spyOn(grants, 'findLiveAccessToken');
    const guard = makeGuard({
      verify: async () => ({ sub: 'u1', email: 'a@example.com', jti: 'human-session-jti' }),
      grants,
    });
    const { context } = ctx({ authorization: 'Bearer eyJhbGciOi.session.jwt' }, '/api/issues');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not read the grant store for an MCP token presented on a REST route', async () => {
    const grants = grantsHolding();
    const spy = vi.spyOn(grants, 'findLiveAccessToken');
    const guard = makeGuard({ verify: mcpSession(MCP_JTI), grants });
    const { context } = ctx({ authorization: 'Bearer eyJhbGciOi.mcp.jwt' }, '/api/issues');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(spy).not.toHaveBeenCalled();
  });
});

/**
 * Durable sign-out, asserted where it has to hold (#679).
 *
 * The guard is the subject rather than the service, because the service being
 * right is not the property anybody depends on — a request being refused is. Each
 * test builds a SECOND `SessionRevocationService` over the SAME store and asks the
 * guard through that one: the second instance is the restart, with a fresh
 * in-memory map and a store that remembers. A test that exercised one instance
 * would have passed just as happily against the process-local Map this issue
 * replaced, and so would have proved nothing.
 *
 * The store here is the memory one — the fake seam. `session-revocation.db-spec.ts`
 * runs the same two properties against Postgres.
 */
describe('durable sign-out at the guard (#679)', () => {
  /** Any fixed second; the epoch tests need `iat` and the bump to be comparable. */
  const IAT_S = 1_800_000_000;

  function verifying(jti: string | undefined, iat: number, sub = 'u1') {
    return async () => ({ sub, email: 'a@example.com', jti, iat });
  }

  async function guardAnswer(revocation: SessionRevocationService, verify: () => Promise<unknown>) {
    const guard = makeGuard({ verify, revocation });
    const { context } = ctx({ authorization: 'Bearer eyJhbGciOi.session.jwt' }, '/api/board');
    return guard.canActivate(context);
  }

  it('rejects a jti revoked through an EARLIER service instance (the restart)', async () => {
    const store = new MemorySessionRevocationStore();
    const before = new SessionRevocationService(store);
    expect(await before.revoke('signed-out-jti', Date.now() + 60_000)).toBe(true);

    const after = new SessionRevocationService(store);
    // The new instance's own map is empty — which is exactly what a restart
    // leaves behind, and exactly what used to resurrect the session.
    expect(after.isRevoked('signed-out-jti')).toBe(false);

    await expect(guardAnswer(after, verifying('signed-out-jti', IAT_S))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('still accepts a jti nobody revoked, through that same second instance', async () => {
    const store = new MemorySessionRevocationStore();
    await new SessionRevocationService(store).revoke('somebody-elses-jti', Date.now() + 60_000);
    const after = new SessionRevocationService(store);
    await expect(guardAnswer(after, verifying('live-jti', IAT_S))).resolves.toBe(true);
  });

  it('rejects a cookie issued BEFORE the epoch bump, and accepts one issued after', async () => {
    const store = new MemorySessionRevocationStore();
    const at = IAT_S * 1000; // the bump, on a whole second
    expect(await new SessionRevocationService(store).bumpEpoch('u1', at)).toBe(true);
    const after = new SessionRevocationService(store);

    // Older by a second, and never named by any jti — the case the denylist
    // cannot express, which is the whole reason the epoch exists.
    await expect(guardAnswer(after, verifying('never-revoked', IAT_S - 1))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guardAnswer(after, verifying('never-revoked', IAT_S + 1))).resolves.toBe(true);
  });

  it('kills only the bumped subject — one sign-out does not sign out the team', async () => {
    const store = new MemorySessionRevocationStore();
    await new SessionRevocationService(store).bumpEpoch('u1', IAT_S * 1000);
    const after = new SessionRevocationService(store);
    await expect(guardAnswer(after, verifying('u2-jti', IAT_S - 1, 'u2'))).resolves.toBe(true);
  });

  /**
   * The boundary the comparison is second-granular on. `iat` is seconds, the bump
   * is an instant, so a token minted inside the same second as the bump is killed
   * when the bump falls even 1 ms later. Unreachable in the real flow — a full
   * Google OAuth round-trip sits between pressing Sign out and holding a newer
   * cookie — and killing is the safe side of it either way. Pinned so a later
   * change to `<=` or a rounding "fix" has to argue with a test.
   */
  it('kills a same-second session when the bump lands mid-second, and spares an exact tie', async () => {
    const midSecond = new MemorySessionRevocationStore();
    await new SessionRevocationService(midSecond).bumpEpoch('u1', IAT_S * 1000 + 500);
    await expect(
      guardAnswer(new SessionRevocationService(midSecond), verifying('same-second', IAT_S)),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const exact = new MemorySessionRevocationStore();
    await new SessionRevocationService(exact).bumpEpoch('u1', IAT_S * 1000);
    await expect(
      guardAnswer(new SessionRevocationService(exact), verifying('exact-tie', IAT_S)),
    ).resolves.toBe(true);
  });

  /**
   * End to end over a really-signed cookie, because everything above hands the
   * guard an `iat` that a stub invented. `verifySession` has to actually read the
   * claim off the JWT for any of this to reach a browser — it is a new field on
   * `OverviewSession`, and an unpopulated one would leave every epoch test here
   * green while the epoch reached nothing in production.
   */
  it('reads iat off a really-signed token, so the bump reaches a real cookie', async () => {
    const secret = 's'.repeat(32);
    const config = {
      get: (key: string, def?: unknown) => {
        if (key === 'BOARD_AGENT_TOKENS') return '';
        if (key === 'AUTH_DISABLED') return false;
        if (key === 'BOARD_SESSION_SECRET') return secret;
        return def;
      },
    } as any;
    const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
    const personalTokens = { verify: async () => null } as any;
    const token = await new SignJWT({ email: 'a@example.com' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setJti('a-real-cookie')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 60) // minted a minute ago
      .setExpirationTime('7d')
      .setIssuer('atlas')
      .sign(new TextEncoder().encode(secret));

    const untouched = new MemorySessionRevocationStore();
    const before = new JwtAuthGuard(
      config,
      reflector,
      new SessionService(config),
      new SessionRevocationService(untouched),
      personalTokens,
      grantsHolding(),
    );
    const first = ctx({ authorization: `Bearer ${token}` }, '/api/board');
    await expect(before.canActivate(first.context)).resolves.toBe(true);

    const bumped = new MemorySessionRevocationStore();
    await new SessionRevocationService(bumped).bumpEpoch('u1', Date.now());
    const after = new JwtAuthGuard(
      config,
      reflector,
      new SessionService(config),
      new SessionRevocationService(bumped),
      personalTokens,
      grantsHolding(),
    );
    const second = ctx({ authorization: `Bearer ${token}` }, '/api/board');
    await expect(after.canActivate(second.context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  /**
   * The kill switch fails CLOSED, and it is a 503 rather than whatever Prisma
   * raised. `revoke` and `bumpEpoch` in that same service both catch, log and
   * return a boolean, so a "resilience" PR adding `catch { return false }` to
   * `check` would look like tidying and would turn sign-out into a suggestion,
   * with every other test in this file still green.
   *
   * A store that cannot answer "is this session dead?" has not answered "no".
   */
  it('refuses the request as 503 when the store cannot answer, rather than admitting it', async () => {
    const unreachable = {
      durable: true,
      revoke: async () => {},
      bumpEpoch: async () => {},
      isRevoked: async () => {
        throw new Error('session store unreachable');
      },
      epochOf: async () => {
        throw new Error('session store unreachable');
      },
    };
    const revocation = new SessionRevocationService(unreachable);
    const { context } = ctx({ authorization: 'Bearer eyJhbGciOi.session.jwt' }, '/api/board');
    const guard = makeGuard({ verify: verifying('a-live-jti', IAT_S), revocation });

    // On the rejection, not on a boolean: the property is that `canActivate` does
    // not resolve true. A `catch { return false }` inside `check` would make this
    // call RESOLVE, and `.rejects` fails on a resolved promise — which is what has
    // to break. 503 rather than 401: nothing says this session is dead, only that
    // the board cannot tell, and that is a server fault rather than the caller's.
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('leaves a legacy token with no iat to the jti gate alone', async () => {
    const store = new MemorySessionRevocationStore();
    await new SessionRevocationService(store).bumpEpoch('u1', Date.now());
    const after = new SessionRevocationService(store);
    const guard = makeGuard({
      verify: async () => ({ sub: 'u1', email: 'a@example.com', jti: 'no-iat' }),
      revocation: after,
    });
    const { context } = ctx({ authorization: 'Bearer eyJhbGciOi.legacy.jwt' }, '/api/board');
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});

/**
 * Which stable identity each kind of caller arrives with (#892).
 *
 * `boardSub` is what a Github credential lookup is keyed on, so what matters
 * here is the MAPPING each branch performs; that the lookup refuses a mismatch
 * is `github-subject-binding.spec.ts`. `sub` keeps its old meaning in every
 * branch, because the MCP-grant and audit reads beside it match on that.
 */
describe('the stable Board identity each actor carries (#892)', () => {
  it('gives a personal token minted before the column no subject at all', async () => {
    const guard = makeGuard({
      pat: async () => ({ ownerEmail: 'legacy@example.com', ownerSub: null, scopes: [BOARD_READ] }),
    });
    const { req, context } = ctx({ authorization: 'Bearer board_pat_legacy' });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user.boardSub, 'absent, never substituted from the address').toBeUndefined();
    expect(req.user.scopes, 'and it keeps every board-local scope it was granted').toEqual([BOARD_READ]);
  });

  it('gives an MCP session the subject the grant was consented under', async () => {
    const guard = makeGuard({
      verify: async () => ({ sub: 'google-sub-mcp', email: 'mcp@example.com', jti: MCP_JTI, boardScopes: [BOARD_READ] }),
      grants: grantsHolding(),
    });
    const { req, context } = ctx({ authorization: 'Bearer eyJ.mcp.jwt' }, '/mcp');
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user).toMatchObject({ sub: 'google-sub-mcp', boardSub: 'google-sub-mcp' });
  });

  it('gives a static agent token no subject, because no person is behind it', async () => {
    const guard = makeGuard({ agentTokens: `ci:${HEX_A}` });
    const { req, context } = ctx({ authorization: `Bearer ${HEX_A}` });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.user.boardSub).toBeUndefined();
    expect(req.user.staticAgent).toBe(true);
  });
});

it('refuses a forged session hint without a real session credential', async () => {
  const guard = makeGuard({});
  const request = ctx({ cookie: `board_session_hint=${encodeURIComponent(JSON.stringify({ id: 'a'.repeat(64), visibilityKey: 'forged' }))}` });
  await expect(guard.canActivate(request.context)).rejects.toBeInstanceOf(UnauthorizedException);
});
