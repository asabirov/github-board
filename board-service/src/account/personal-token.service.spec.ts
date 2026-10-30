import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { BOARD_ADMIN, BOARD_READ, capToGrantable, grantableScopesFor } from '../auth/scopes';
import { PersonalTokenService } from './personal-token.service';
import {
  CreateTokenInput,
  PersonalTokenRepository,
  PersonalTokenRow,
} from './personal-token.repository';

/** In-memory repo keyed by tokenHash, mirroring the Prisma contract. */
class FakeRepo implements PersonalTokenRepository {
  readonly enabled = true;
  rows: PersonalTokenRow[] = [];
  private seq = 0;
  async create(input: CreateTokenInput): Promise<PersonalTokenRow> {
    const row: PersonalTokenRow = {
      id: `t${++this.seq}`,
      ...input,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date('2026-07-27T00:00:00Z'),
    };
    this.rows.push(row);
    return row;
  }
  async listByOwner(ownerEmail: string): Promise<PersonalTokenRow[]> {
    return this.rows.filter((r) => r.ownerEmail === ownerEmail);
  }
  async findByHash(tokenHash: string): Promise<PersonalTokenRow | null> {
    return this.rows.find((r) => r.tokenHash === tokenHash) ?? null;
  }
  async revoke(id: string, ownerEmail: string): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id && r.ownerEmail === ownerEmail && !r.revokedAt);
    if (!row) return false;
    row.revokedAt = new Date();
    return true;
  }
  async listAllActive(): Promise<PersonalTokenRow[]> {
    const now = Date.now();
    return this.rows.filter((r) => !r.revokedAt && (!r.expiresAt || r.expiresAt.getTime() > now));
  }
  async revokeAny(id: string): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id && !r.revokedAt);
    if (!row) return false;
    row.revokedAt = new Date();
    return true;
  }
  async touchLastUsed(id: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.lastUsedAt = new Date();
  }
}

describe('PersonalTokenService', () => {
  let repo: FakeRepo;
  let svc: PersonalTokenService;
  beforeEach(() => {
    repo = new FakeRepo();
    svc = new PersonalTokenService(repo);
  });

  it('mints a board_pat_ secret, stores only its hash, and verifies back to owner + scopes', async () => {
    const { token, record } = await svc.mint('Octocat@example.com', 'sub-Octocat', false, {
      name: 'my-laptop',
      scopes: ['board:read'],
      expiresInDays: 90,
    });
    expect(token).toMatch(/^board_pat_/);
    expect(record.scopes).toEqual(['board:read']);
    expect(record.prefix).toBe(token.slice(0, 14));
    // secret is never stored; only its hash
    expect(repo.rows[0].tokenHash).not.toContain(token);
    expect(repo.rows[0].ownerEmail).toBe('octocat@example.com'); // lowercased
    // The minting session's subject is recorded verbatim, and is what a Github
    // credential lookup is keyed on rather than the address above (#892).
    expect(repo.rows[0].ownerSub).toBe('sub-Octocat');

    const v = await svc.verify(token);
    // `ownerSub` travels back out too, so `JwtAuthGuard` can bind this token's
    // Github credential to the identity that minted it (#892).
    expect(v).toEqual({ ownerEmail: 'octocat@example.com', ownerSub: 'sub-Octocat', scopes: ['board:read'] });
  });

  it('caps scopes to the minter: a non-admin cannot mint board:admin', async () => {
    await expect(
      svc.mint('a@example.com', 'sub-a', false, { name: 'x', scopes: ['board:admin'], expiresInDays: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // an admin can
    const { record } = await svc.mint('a@example.com', 'sub-a', true, {
      name: 'x',
      scopes: ['board:read', 'board:admin'],
      expiresInDays: null,
    });
    expect(record.scopes).toContain('board:admin');
  });

  it('rejects an empty name or empty scope set', async () => {
    await expect(
      svc.mint('a@example.com', 'sub-a', false, { name: '  ', scopes: ['board:read'], expiresInDays: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.mint('a@example.com', 'sub-a', false, { name: 'x', scopes: [], expiresInDays: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('null expiry = no expiry; verify still resolves', async () => {
    const { token, record } = await svc.mint('a@example.com', 'sub-a', false, {
      name: 'ci',
      scopes: ['board:read'],
      expiresInDays: null,
    });
    expect(record.expiresAt).toBeNull();
    expect(await svc.verify(token)).not.toBeNull();
  });

  it('an expired token does not verify', async () => {
    const { token } = await svc.mint('a@example.com', 'sub-a', false, {
      name: 'x',
      scopes: ['board:read'],
      expiresInDays: 1,
    });
    // force the stored row into the past
    repo.rows[0].expiresAt = new Date(Date.now() - 1000);
    expect(await svc.verify(token)).toBeNull();
  });

  it('a revoked token does not verify', async () => {
    const { token } = await svc.mint('a@example.com', 'sub-a', false, {
      name: 'x',
      scopes: ['board:read'],
      expiresInDays: null,
    });
    const id = repo.rows[0].id;
    expect(await svc.revoke(id, 'a@example.com')).toBe(true);
    expect(await svc.verify(token)).toBeNull();
    // a second revoke is a no-op, never an error
    expect(await svc.revoke(id, 'a@example.com')).toBe(false);
  });

  it('only the owner can revoke their token', async () => {
    await svc.mint('a@example.com', 'sub-a', false, { name: 'x', scopes: ['board:read'], expiresInDays: null });
    const id = repo.rows[0].id;
    expect(await svc.revoke(id, 'someone-else@example.com')).toBe(false);
  });

  it('a non-board_pat_ bearer is not a personal token', async () => {
    expect(await svc.verify('eyJ.some.jwt')).toBeNull();
    expect(PersonalTokenService.looksLikePersonalToken('eyJ.some.jwt')).toBe(false);
    expect(PersonalTokenService.looksLikePersonalToken('board_pat_abc')).toBe(true);
  });

  it('grantableScopes is the shared rule, not a second copy of it', () => {
    expect(svc.grantableScopes(false)).toEqual(grantableScopesFor(false));
    expect(svc.grantableScopes(true)).toEqual(grantableScopesFor(true));
    // Pinned literally as well, so a mutation that breaks BOTH is still caught.
    expect(svc.grantableScopes(false)).toEqual([BOARD_READ]);
    expect(svc.grantableScopes(true)).toEqual([BOARD_READ, BOARD_ADMIN]);
  });

  it('refuses a non-admin an admin-scoped token, naming the scope', async () => {
    await expect(
      svc.mint('dev@example.com', 'sub-dev', false, {
        name: 'agent', scopes: [BOARD_READ, BOARD_ADMIN], expiresInDays: null,
      }),
    ).rejects.toThrow(`Your account cannot grant ${BOARD_ADMIN}, so this token cannot carry it.`);
  });

  it('mints an admin the scopes a non-admin is refused', async () => {
    const { record } = await svc.mint('boss@example.com', 'sub-boss', true, {
      name: 'agent', scopes: [BOARD_READ, BOARD_ADMIN], expiresInDays: null,
    });
    expect(record.scopes).toEqual([BOARD_READ, BOARD_ADMIN]);
  });

  // The Definition-of-Done line, made observable: for the same person, the set a
  // token may carry and the set a consent grant may carry are the same set.
  // Fails the moment either path grows its own answer.
  it('a token and a consent grant agree on what one authority may hold', () => {
    for (const isAdmin of [true, false]) {
      expect(capToGrantable([BOARD_READ, BOARD_ADMIN], isAdmin)).toEqual(
        svc.grantableScopes(isAdmin),
      );
    }
  });
});

/**
 * A token minted before #892 has no recorded subject (#892 review).
 *
 * It must keep every board-local scope it was granted — dropping the feature is
 * not a security fix — and it must reach no Github credential, because nothing
 * on the row says which person's grant it would be reaching for.
 * `github-subject-binding.spec.ts` holds the second half; this holds that
 * `verify` reports the absence honestly rather than substituting the address.
 */
describe('a personal token minted before subject binding (#892)', () => {
  it('verifies, keeps its scopes, and reports no owning subject', async () => {
    const repo = new FakeRepo();
    const svc = new PersonalTokenService(repo);
    const { token } = await svc.mint('a@example.com', 'sub-a', false, {
      name: 'legacy',
      scopes: ['board:read'],
      expiresInDays: null,
    });
    // The shape of every row written before the column existed.
    repo.rows[0].ownerSub = null;
    expect(await svc.verify(token)).toEqual({
      ownerEmail: 'a@example.com',
      ownerSub: null,
      scopes: ['board:read'],
    });
  });
});
