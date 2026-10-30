import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient, GithubCredential } from '../generated/prisma/client';
import { GithubUserService } from './github-user.service';
import { CredentialCipher } from './github-credential-cipher';

/**
 * A Github grant belongs to the person who consented to it, not to the address
 * they held at the time (#892 review).
 *
 * The row already stored `boardSub` and nothing read it. An address is
 * reassignable — a company hands `alice@` to the next Alice and every roster
 * read agrees she is the first one — so a lookup keyed on the address alone
 * gives the second person the first one's token, her private repositories and
 * her write identity.
 *
 * This file covers the credential layer: which subject gets the row. Which
 * subject each KIND of caller arrives with — a browser session, an MCP grant, a
 * personal token new or legacy — is a different question and belongs to the
 * guard that maps them; `jwt-auth.guard.spec.ts` holds that boundary.
 */
const KEY = Buffer.alloc(32, 7);
const cipher = new CredentialCipher({ key: () => KEY });
const EMAIL = 'alice@example.test';
const FIRST_ALICE = '9001';
const SECOND_ALICE = '9002';

const config = new ConfigService({
  GITHUB_TOKEN: 'deployment',
  GITHUB_USER_APP_CLIENT_ID: 'synthetic-client',
  GITHUB_USER_APP_CLIENT_SECRET: 'synthetic-secret',
  BOARD_CREDENTIAL_KEY: KEY.toString('base64'),
});

/** The row the FIRST Alice created when she signed in with Github. */
const row = (): GithubCredential =>
  ({
    ownerEmail: EMAIL,
    boardSub: FIRST_ALICE,
    githubUserId: FIRST_ALICE,
    githubLogin: 'alice-the-first',
    accessCipher: cipher.encrypt('ghu_first_alice', `${FIRST_ALICE}:access`),
    refreshCipher: cipher.encrypt('ghr_first_alice', `${FIRST_ALICE}:refresh`),
    accessExpiresAt: new Date(Date.now() + 3_600_000),
    refreshExpiresAt: new Date(Date.now() + 7_200_000),
    scopes: '',
    version: 'v1',
    refreshLeaseUntil: null,
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as GithubCredential;

function service() {
  const stored = row();
  const db = {
    githubCredential: {
      findUnique: vi.fn(async ({ where }: { where: { githubUserId: string } }) =>
        where.githubUserId === FIRST_ALICE ? stored : null,
      ),
    },
  } as unknown as PrismaClient;
  // Discovery answers for whoever asks; the point is WHO gets to ask at all.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = String(url).includes('/repositories')
        ? {
            total_count: 1,
            repositories: [
              { id: 1, name: 'secret', full_name: 'acme/secret', owner: { login: 'acme' }, permissions: { push: true } },
            ],
          }
        : {
            total_count: 1,
            installations: [{ id: 10, account: { id: 10, login: 'acme', type: 'Organization' }, suspended_at: null }],
          };
      const res = new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      Object.defineProperty(res, 'url', { value: String(url) });
      return res;
    }),
  );
  return new GithubUserService(config, db);
}

describe('a Github grant follows the subject, never the address (#892)', () => {
  it('serves the first Alice her own connection', async () => {
    const p = await service().principal(EMAIL, FIRST_ALICE);
    expect(p.token).toBe('ghu_first_alice');
    expect(p.login).toBe('alice-the-first');
    expect(p.owners.map((o) => o.login)).toEqual(['acme']);
  });

  it('refuses a second GitHub user id that inherited the address', async () => {
    const p = await service().principal(EMAIL, SECOND_ALICE);
    expect(p.token, 'the newcomer gets no token').toBeNull();
    expect(p.login, 'and is told about no Github account').toBeNull();
    expect(p.owners, 'and sees no owners').toEqual([]);
    expect(p.repositories).toEqual([]);
  });

  it('refuses a token that carries no recorded subject at all', async () => {
    // Every personal token minted before #892 has `ownerSub` null, so the guard
    // gives it no `boardSub`. Absent must never read as "any subject will do".
    const p = await service().principal(EMAIL, undefined);
    expect(p.token, 'a pre-#892 token reaches no Github credential').toBeNull();
    expect(p.owners).toEqual([]);
  });

  it('keeps the two subjects out of each other`s visibility cache', async () => {
    const svc = service();
    const first = await svc.principal(EMAIL, FIRST_ALICE);
    const second = await svc.principal(EMAIL, SECOND_ALICE);
    expect(first.cache, 'no shared cache container').not.toBe(second.cache);
    // And the newcomer's arrival must not have retired the first Alice's own
    // warm visibility — she is still the person who consented.
    const again = await svc.principal(EMAIL, FIRST_ALICE);
    expect(again.cache).toBe(first.cache);
    expect(again.token).toBe('ghu_first_alice');
  });

  it('never spends the deployment credential for any of them', async () => {
    const svc = service();
    await svc.principal(EMAIL, FIRST_ALICE);
    await svc.principal(EMAIL, SECOND_ALICE);
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    for (const [, init] of calls) {
      expect(new Headers(init.headers).get('authorization')).not.toContain('deployment');
    }
  });
});
