import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { decodeJwt } from 'jose';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { McpModule } from './mcp.module';
import { McpOAuthProvider } from './mcp-oauth.provider';
import { MCP_GRANT_REPOSITORY, type McpGrantRepository } from './mcp-grant.repository';
import { GithubAuthController } from '../auth/github-auth.controller';
import { GithubUserService, GITHUB_DB } from '../auth/github-user.service';
import { GithubAdmissionService } from '../auth/github-admission.service';
import { SessionService } from '../auth/session.service';
import { SessionRevocationService } from '../auth/session-revocation.service';
import { SessionRevocationModule } from '../auth/session-revocation.module';
import { AdminAuthorityModule } from '../auth/admin-authority.module';
import { AuditModule } from '../audit/audit.module';
import { expandPreset } from '../auth/scopes';

/**
 * End-to-end lock for #127 (CSO review), carried forward into #456: revoking a
 * user's MCP tokens on sign-out depends on the *provider* (which writes grants)
 * and the *logout controller* (which revokes them) reaching ONE grant store
 * across the module boundary — provider lives in McpModule, controller in
 * AppModule. If a future refactor bound the controller to a second instance,
 * it would read an empty store, revocation would silently become a no-op, and
 * every unit test would stay green. This test wires the real module graph and
 * proves the grant a provider records is the same one the controller revokes.
 *
 * SessionRevocationModule, AdminAuthorityModule and AuditModule are imported
 * explicitly because this graph is McpModule on its own rather than AppModule:
 * ConsentController injects AdminAuthority (#545) and McpOAuthProvider injects
 * AdminAuthority, AuditService and the denylist (#456), and a @Global module
 * still has to be somewhere in the graph to export anything. The denylist comes
 * through its module rather than as a bare provider here on purpose — declaring
 * the service twice hands out two instances and splits the list, which is the
 * failure this file exists to catch. This list is hand-built, so it breaks the
 * moment the provider needs something it omits — re-run this file after every
 * change to the provider's constructor.
 */
function resMock() {
  const res: any = { statusCode: 0, body: null };
  res.clearCookie = () => res;
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
}

describe('MCP sign-out revocation — real DI graph (#127)', () => {
  const config = ConfigModule.forRoot({
    isGlobal: true,
    ignoreEnvFile: true,
    // Both SessionService instances read this shared secret, so a session
    // token minted for logout and an MCP token minted by the provider are
    // signed/verified under the same key.
    // `GITHUB_ORGS` and `FEEDBACK_REPO` carry no defaults since #1175, and this
    // graph builds services that read both at construction.
    load: [() => ({ BOARD_SESSION_SECRET: 'integration-secret-0123456789', BOARD_BASE_URL: 'http://localhost', GITHUB_ORGS: 'acme', FEEDBACK_REPO: 'acme/board' })],
  });

  it("revokes an issued MCP token when its owner signs out (shared store)", async () => {
    const mod = await Test.createTestingModule({
      imports: [config, SessionRevocationModule, AdminAuthorityModule, AuditModule, McpModule],
      controllers: [GithubAuthController],
      providers: [SessionService, GithubUserService, GithubAdmissionService, { provide: GITHUB_DB, useValue: {} }],
    }).compile();

    const provider = mod.get(McpOAuthProvider);
    const controller = mod.get(GithubAuthController);
    const google = mod.get(SessionService);
    const revocation = mod.get(SessionRevocationService);

    // 1) Issue a real MCP access token for u1 through the provider's own flow.
    const reqId = await provider.pendingStore.create({
      clientId: 'c1',
      redirectUri: 'http://localhost:9/cb',
      codeChallenge: 'ch',
    });
    const consent = (await provider.finishConsent(reqId, expandPreset('full'), { sub: 'u1', email: 'u1@example.com' }))!;
    const code = new URL(consent.redirectTo).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode({ client_id: 'c1' } as any, code);
    const mcpJti = decodeJwt(tokens.access_token).jti as string;
    expect(mcpJti).toBeTruthy();
    expect(revocation.isRevoked(mcpJti)).toBe(false); // live until sign-out

    // 2) u1 signs out with a session token minted under the same secret.
    const sessionToken = await google.issueSession({ sub: 'u1', email: 'u1@example.com' });
    await controller.logout({ headers: { cookie: `atlas_session=${sessionToken}` } } as any, resMock());

    // 3) The MCP jti the provider recorded is now denylisted — proving the
    //    provider and controller shared one store. JwtAuthGuard (unit-tested
    //    separately) rejects any revoked jti, so /mcp calls now 401.
    expect(revocation.isRevoked(mcpJti)).toBe(true);

    await mod.close();
  });

  it("a different user's sign-out does NOT revoke u1's MCP token", async () => {
    const mod = await Test.createTestingModule({
      imports: [config, SessionRevocationModule, AdminAuthorityModule, AuditModule, McpModule],
      controllers: [GithubAuthController],
      providers: [SessionService, GithubUserService, GithubAdmissionService, { provide: GITHUB_DB, useValue: {} }],
    }).compile();

    const provider = mod.get(McpOAuthProvider);
    const controller = mod.get(GithubAuthController);
    const google = mod.get(SessionService);
    const revocation = mod.get(SessionRevocationService);

    const reqId = await provider.pendingStore.create({ clientId: 'c1', redirectUri: 'http://localhost:9/cb', codeChallenge: 'ch' });
    const consent = (await provider.finishConsent(reqId, expandPreset('agent'), { sub: 'u1', email: 'u1@example.com' }))!;
    const code = new URL(consent.redirectTo).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode({ client_id: 'c1' } as any, code);
    const mcpJti = decodeJwt(tokens.access_token).jti as string;

    // u2 (a different subject) signs out.
    const otherSession = await google.issueSession({ sub: 'u2', email: 'u2@example.com' });
    await controller.logout({ headers: { cookie: `atlas_session=${otherSession}` } } as any, resMock());

    expect(revocation.isRevoked(mcpJti)).toBe(false); // u1's grant untouched
    await mod.close();
  });

  it('sign-out revokes a grant recorded before this process started', async () => {
    // The regression cycle 1 shipped, stated as a test. The old registry was a
    // process-local map, so sign-out could only reach grants this process had
    // itself minted — a restart forgot every one while the tokens under them
    // stayed valid for their full week. Here the grants are written STRAIGHT to
    // the store, never through an exchange in this process, which is what
    // "before this process started" means in a single-process test.
    //
    // Two grants built identically, one for each subject, and the second is
    // load-bearing rather than thorough. Without it a rejection could equally
    // mean the hand-built refresh token was never redeemable in the first
    // place; u2's, untouched by u1's sign-out, is what proves the construction
    // works and that the refusal came from the sign-out.
    const mod = await Test.createTestingModule({
      imports: [config, SessionRevocationModule, AdminAuthorityModule, AuditModule, McpModule],
      controllers: [GithubAuthController],
      providers: [SessionService, GithubUserService, GithubAdmissionService, { provide: GITHUB_DB, useValue: {} }],
    }).compile();

    const provider = mod.get(McpOAuthProvider);
    const controller = mod.get(GithubAuthController);
    const google = mod.get(SessionService);
    const repo = mod.get<McpGrantRepository>(MCP_GRANT_REPOSITORY);

    const future = new Date(Date.now() + 30 * 24 * 3600_000);
    async function plantGrant(sub: string, refresh: string) {
      const hash = createHash('sha256').update(refresh).digest('hex');
      const grant = await repo.createGrant({
        sub,
        email: `${sub}@example.com`,
        clientId: 'c1',
        scopes: ['board:read'],
        currentRefreshHash: hash,
      });
      await repo.recordRefreshToken({ tokenHash: hash, grantId: grant.id, expiresAt: future });
      return grant;
    }

    await plantGrant('u1', 'planted-refresh-u1');
    await plantGrant('u2', 'planted-refresh-u2');

    const session = await google.issueSession({ sub: 'u1', email: 'u1@example.com' });
    await controller.logout({ headers: { cookie: `atlas_session=${session}` } } as any, resMock());

    const client = { client_id: 'c1' } as any;
    // The stolen refresh token cannot be refreshed past its owner's sign-out.
    await expect(provider.exchangeRefreshToken(client, 'planted-refresh-u1')).rejects.toThrow(
      InvalidGrantError,
    );
    // And the same construction, under a subject who did not sign out, still works.
    await expect(
      provider.exchangeRefreshToken(client, 'planted-refresh-u2'),
    ).resolves.toBeDefined();

    await mod.close();
  });
});
