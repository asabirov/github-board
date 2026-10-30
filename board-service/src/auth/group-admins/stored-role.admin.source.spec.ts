import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../generated/prisma/client';
import { StoredRoleAdminSource } from './stored-role.admin.source';

/** A Prisma stub exposing only identity.findMany, scripted per test. */
function prismaWith(rows: Array<{ emails: string[] }>): PrismaClient {
  return {
    identity: { findMany: async () => rows },
  } as unknown as PrismaClient;
}

describe('StoredRoleAdminSource (#332)', () => {
  it('returns the lowercased, deduped emails of identities with role=admin', async () => {
    const src = new StoredRoleAdminSource(
      prismaWith([{ emails: ['Owner@example.com', 'owner.alt@example.com'] }, { emails: ['owner@example.com'] }]),
    );
    expect((await src.listAdminEmails()).sort()).toEqual(['owner.alt@example.com', 'owner@example.com']);
  });

  it('returns empty when no identity has the admin role', async () => {
    const src = new StoredRoleAdminSource(prismaWith([]));
    expect(await src.listAdminEmails()).toEqual([]);
  });

  it('propagates a DB error so the cache keeps its last-good snapshot', async () => {
    const prisma = {
      identity: {
        findMany: async () => {
          throw new Error('db down');
        },
      },
    } as unknown as PrismaClient;
    await expect(new StoredRoleAdminSource(prisma).listAdminEmails()).rejects.toThrow('db down');
  });
});
