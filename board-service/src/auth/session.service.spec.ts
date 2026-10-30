import { describe, it, expect } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { decodeJwt, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import { SessionService, MCP_ACCESS_TOKEN_TTL_S } from './session.service';
import { SESSION_TTL_S } from './cookies';
import { BOARD_READ, BOARD_ADMIN, expandPreset } from './scopes';

/** The third argument every MCP mint now carries, when the test does not care what is in it. */
const anyMint = () => ({ jti: randomUUID(), ttlSeconds: MCP_ACCESS_TOKEN_TTL_S });

function svc(): SessionService {
  const vals: Record<string, unknown> = { BOARD_SESSION_SECRET: 's'.repeat(32) };
  return new SessionService({
    get: (k: string, d?: unknown) => vals[k] ?? d,
  } as unknown as ConfigService);
}

describe('SessionService tokens', () => {
  it('session round-trip has no mcpScope', async () => {
    const s = svc();
    const token = await s.issueSession({ sub: '12345', email: 'octocat' });
    const out = await s.verifySession(token);
    expect(out).toMatchObject({ sub: '12345', email: 'octocat' });
    expect(out.mcpScope).toBeUndefined();
  });

  it('session carries a unique jti + exp for revocation (#112)', async () => {
    const s = svc();
    const a = await s.verifySession(await s.issueSession({ sub: '12345', email: 'octocat' }));
    const b = await s.verifySession(await s.issueSession({ sub: '12345', email: 'octocat' }));
    expect(typeof a.jti).toBe('string');
    expect(typeof a.exp).toBe('number');
    expect(a.jti).not.toBe(b.jti); // per-token id
  });

  it('signs a session for exactly SESSION_TTL_S, not a literal of its own (#677)', async () => {
    // Reads what the signer EMITS, not what the file contains. The lifetime used
    // to be a `'8h'` string here and an `8 * 3600` maxAge in the controller, kept
    // equal by a comment; re-hardcode either and this goes red, because the
    // number under test is the decoded token's own exp - iat.
    const s = svc();
    const { exp, iat } = decodeJwt(await s.issueSession({ sub: '12345', email: 'octocat' }));
    expect(exp! - iat!).toBe(SESSION_TTL_S);
    // And the constant is seven days, pinned against a literal rather than
    // against itself — so a constant that quietly moved fails here too.
    expect(SESSION_TTL_S).toBe(7 * 24 * 3600);
  });

  it('mcp token round-trip carries the scope', async () => {
    const s = svc();
    for (const scope of ['agent', 'full'] as const) {
      const token = await s.issueMcpToken(
        { sub: '12345', email: 'octocat' },
        expandPreset(scope),
        anyMint(),
      );
      const out = await s.verifySession(token);
      expect(out).toMatchObject({ sub: '12345', email: 'octocat', mcpScope: scope });
    }
  });

  it('signs the jti it was given and expires at the ttl it was given', async () => {
    // Both halves, because asserting the jti alone would pass against a signer
    // still hardcoding '7d', and asserting the lifetime alone would pass against
    // one still minting its own jti. The caller has to own both or the row it
    // writes and the token it hands out describe different things.
    const s = svc();
    const token = await s.issueMcpToken(
      { sub: '12345', email: 'octocat' },
      [BOARD_READ],
      { jti: 'chosen-jti', ttlSeconds: MCP_ACCESS_TOKEN_TTL_S },
    );
    const { jti, exp, iat } = decodeJwt(token);
    expect(jti).toBe('chosen-jti');
    expect(exp! - iat!).toBe(MCP_ACCESS_TOKEN_TTL_S);
  });

  it('an mcp access token lasts an hour, and the signer mints exactly that (#456)', async () => {
    // Two assertions and neither is redundant. The first pins the number board
    // advertises in `expires_in`; the second pins the number it signs, against
    // the same literal rather than against the constant — so a constant that
    // stopped reaching the signer fails here instead of passing by comparing
    // itself to itself. That drift is the defect this test exists for.
    expect(MCP_ACCESS_TOKEN_TTL_S).toBe(3600);
    const s = svc();
    const token = await s.issueMcpToken(
      { sub: '12345', email: 'octocat' },
      [BOARD_READ],
      { jti: 'an-hour', ttlSeconds: MCP_ACCESS_TOKEN_TTL_S },
    );
    const { exp, iat } = decodeJwt(token);
    expect(exp! - iat!).toBe(3600);
  });

  it('rejects a token signed with a different secret', async () => {
    const a = svc();
    const token = await a.issueMcpToken(
      { sub: '12345', email: 'octocat' },
      expandPreset('agent'),
      anyMint(),
    );
    const vals: Record<string, unknown> = { BOARD_SESSION_SECRET: 'x'.repeat(32) };
    const b = new SessionService({ get: (k: string, d?: unknown) => vals[k] ?? d } as any);
    await expect(b.verifySession(token)).rejects.toThrow();
  });
});

describe('a malformed board_scopes claim denies rather than promotes (#456)', () => {
  /** Signed with the same secret `svc()` verifies against. */
  function forge(claims: Record<string, unknown>): Promise<string> {
    return new SignJWT({ email: 'octocat', ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('12345')
      .setJti('j')
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer('atlas')
      .sign(new TextEncoder().encode('s'.repeat(32)));
  }

  /** The same forge, with the subject under test rather than fixed at `12345`. */
  function forgeSub(sub: string): Promise<string> {
    return new SignJWT({ email: 'octocat' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(sub)
      .setJti('j')
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer('atlas')
      .sign(new TextEncoder().encode('s'.repeat(32)));
  }

  it('refuses a signed token whose board_scopes claim is not an array of strings', async () => {
    await expect(svc().verifySession(await forge({ board_scopes: 'board:read' }))).rejects.toThrow(
      /board_scopes/,
    );
  });

  it('refuses an array with a non-string in it', async () => {
    await expect(svc().verifySession(await forge({ board_scopes: ['board:read', 7] }))).rejects.toThrow(
      /board_scopes/,
    );
  });

  it('an empty board_scopes array is still a valid, powerless token', async () => {
    const session = await svc().verifySession(await forge({ board_scopes: [] }));
    expect(session.boardScopes).toEqual([]);
  });

  it('refuses a signed token carrying no subject at all', async () => {
    const noSub = await new SignJWT({ email: 'octocat' })
      .setProtectedHeader({ alg: 'HS256' })
      .setJti('j')
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer('atlas')
      .sign(new TextEncoder().encode('s'.repeat(32)));
    await expect(svc().verifySession(noSub)).rejects.toThrow(/subject/i);
  });

  it('refuses a signed token whose subject is an empty string', async () => {
    await expect(svc().verifySession(await forgeSub(''))).rejects.toThrow(/subject/i);
  });
});

describe('verifySignatureOnly — what /revoke may accept (#456)', () => {
  it('verifies a token an hour past its expiry and yields its jti', async () => {
    const s = svc();
    const token = await new SignJWT({ email: 'octocat' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('12345')
      .setJti('stale-jti')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 2 * 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .setIssuer('atlas')
      .sign(new TextEncoder().encode('s'.repeat(32)));

    await expect(s.verifySession(token)).rejects.toThrow();
    expect(await s.verifySignatureOnly(token)).toMatchObject({
      sub: '12345',
      email: 'octocat',
      jti: 'stale-jti',
    });
  });

  it('rejects a token signed with a different secret', async () => {
    const a = svc();
    const token = await a.issueMcpToken({ sub: '12345', email: 'octocat' }, [BOARD_READ], anyMint());
    const vals: Record<string, unknown> = { BOARD_SESSION_SECRET: 'x'.repeat(32) };
    const b = new SessionService({ get: (k: string, d?: unknown) => vals[k] ?? d } as any);
    await expect(b.verifySignatureOnly(token)).rejects.toThrow();
  });

  it('rejects a correctly signed token issued by somebody else', async () => {
    const s = svc();
    const token = await new SignJWT({ email: 'octocat' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('12345')
      .setJti('j')
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer('not-atlas')
      .sign(new TextEncoder().encode('s'.repeat(32)));
    await expect(s.verifySignatureOnly(token)).rejects.toThrow();
  });
});

describe('MCP token board_scopes (#56)', () => {
  it('mints board_scopes and a compat mcp_scope, and round-trips', async () => {
    const s = svc();
    const token = await s.issueMcpToken(
      { sub: '12345', email: 'octocat' },
      [BOARD_READ],
      anyMint(),
    );
    const session = await s.verifySession(token);
    expect(session.boardScopes).toEqual([BOARD_READ]);
    expect(session.mcpScope).toBe('agent'); // compat claim, derived
  });

  it('a full scope-set derives mcp_scope=full', async () => {
    const s = svc();
    const token = await s.issueMcpToken(
      { sub: '12345', email: 'octocat' },
      [BOARD_READ, BOARD_ADMIN],
      anyMint(),
    );
    const session = await s.verifySession(token);
    expect(session.mcpScope).toBe('full');
    expect(session.boardScopes).toContain(BOARD_ADMIN);
  });
});
