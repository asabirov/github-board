import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import type { GithubCredential, PrismaClient } from '../generated/prisma/client';
import { CredentialCipher } from './github-credential-cipher';
import { githubContext } from './github-principal';
import { GithubPrincipalGuard } from './github-principal.guard';
import { GithubUserService } from './github-user.service';

/** Somebody revokes the board's Github authorization while the token board
 *  holds is still unexpired, so Github answers 401 to every call on it (#1411). */
const KEY = Buffer.alloc(32, 11);
const cipher = new CredentialCipher({ key: () => KEY });
const EMAIL = 'revoker@example.test';
const SUB = 'google-sub-revoker';

const config = new ConfigService({
  AUTH_DISABLED: false,
  GITHUB_USER_APP_CLIENT_ID: 'synthetic-client',
  GITHUB_USER_APP_CLIENT_SECRET: 'synthetic-secret',
  BOARD_CREDENTIAL_KEY: KEY.toString('base64'),
});

/** Github refusing every call on the revoked token. The access token has hours
 *  left, so only this refusal can end the stale copy. */
function harness() {
  const stored = {
    ownerEmail: EMAIL, boardSub: SUB, githubUserId: '4242', githubLogin: 'revoker',
    accessCipher: cipher.encrypt('ghu_revoker', `${EMAIL}:access`),
    refreshCipher: cipher.encrypt('ghr_revoker', `${EMAIL}:refresh`),
    accessExpiresAt: new Date(Date.now() + 7 * 3_600_000),
    refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000),
    scopes: '', version: 'v1', refreshLeaseUntil: null, revokedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  } as GithubCredential;
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const db = { githubCredential: { findUnique: vi.fn(async () => stored), updateMany } } as unknown as PrismaClient;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Bad credentials' }), {
    status: 401, headers: { 'content-type': 'application/json' },
  })));
  const service = new GithubUserService(config, db);
  return { guard: new GithubPrincipalGuard(service, config), updateMany };
}

const ctx = (path: string) => ({
  switchToHttp: () => ({
    getRequest: () => ({ path, method: 'GET', user: { email: EMAIL, boardSub: SUB } }),
    getResponse: () => ({ setHeader: () => {} }),
  }),
}) as never;
const admit = (guard: GithubPrincipalGuard, path: string) =>
  githubContext.run({ principal: null }, async () => {
    await guard.canActivate(ctx(path));
    return githubContext.getStore()!.principal!;
  });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('a revoked Github authorization (#1411)', () => {
  it('refuses the next read 403, still answers /api/auth/me, and writes nothing', async () => {
    const h = harness();

    // 403 is what `withdrawsRead` reads as the server withdrawing permission.
    await expect(admit(h.guard, '/api/repos')).rejects.toBeInstanceOf(ForbiddenException);

    // But /api/auth/me still answers: it is the read a reconnect is offered from.
    const principal = await admit(h.guard, '/api/auth/me');
    expect(principal.token).toBeNull();
    expect(principal.key).toContain('unconnected');

    // The row is untouched: it retires on its own refresh, as before.
    expect(h.updateMany).not.toHaveBeenCalled();
  });
});
