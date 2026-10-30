import { describe, expect, it } from 'vitest';
import { PrismaIdentityRepository } from './prisma-identity.repository';
import { FixtureIdentityRepository } from './fixture-identity.repository';
import { PEOPLE_ALIASES } from '../people/people-aliases';

interface Row {
  id: string;
  displayName: string;
  emails: string[];
  githubLogin: string | null;
  clickupUserId: string | null;
  clickupNames: string[];
}

/** Minimal in-memory Prisma stub — enough to exercise seed + upsert + resolve. */
function stubPrisma(initial: Row[] = []) {
  const rows: Row[] = [...initial];
  let n = 0;
  const client = {
    identity: {
      count: async () => rows.length,
      createMany: async ({ data }: { data: Omit<Row, 'id'>[] }) => {
        data.forEach((d) => rows.push({ id: `s${n++}`, ...d }));
        return { count: data.length };
      },
      create: async ({ data }: { data: Omit<Row, 'id'> }) => {
        const r = { id: `s${n++}`, ...data };
        rows.push(r);
        return r;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      },
      findMany: async () => [...rows],
      findFirst: async ({ where }: { where?: { emails?: { has: string } } }) =>
        rows.find((x) => (where?.emails ? x.emails.includes(where.emails.has) : true)) ?? null,
    },
  };
  return { client, rows };
}

describe('PrismaIdentityRepository (#11)', () => {
  it('seeds from PEOPLE_ALIASES only when the table is empty', async () => {
    const { client, rows } = stubPrisma();
    const repo = new PrismaIdentityRepository(client as never);
    await repo.list();
    expect(rows).toHaveLength(PEOPLE_ALIASES.length);
    // Second call must not re-seed.
    await repo.list();
    expect(rows).toHaveLength(PEOPLE_ALIASES.length);
  });

  it('seeds exactly once under concurrent first-boot reads (single-flight)', async () => {
    const { client, rows } = stubPrisma();
    // Make count() yield the event loop so two callers interleave before either
    // seeds — the exact window that used to double-seed.
    const origCount = client.identity.count;
    client.identity.count = async () => {
      await new Promise((r) => setTimeout(r, 0));
      return origCount();
    };
    const repo = new PrismaIdentityRepository(client as never);
    await Promise.all([repo.list(), repo.list(), repo.identityForEmail('x@y.com')]);
    expect(rows).toHaveLength(PEOPLE_ALIASES.length); // not 2x/3x
  });

  it('upsert updates the identity that already owns the key email', async () => {
    const { client, rows } = stubPrisma([
      { id: 'a', displayName: 'Maria', emails: ['maria@x.com'], githubLogin: null, clickupUserId: null, clickupNames: [] },
    ]);
    const repo = new PrismaIdentityRepository(client as never);
    const res = await repo.upsert('maria@x.com', { displayName: 'Maria Lopez', emails: ['maria@x.com'], githubLogin: 'mlopez' });
    expect(rows).toHaveLength(1); // updated, not created
    expect(res.githubLogin).toBe('mlopez');
    expect(res.displayName).toBe('Maria Lopez');
  });

  it('upsert creates a new identity when no one owns the key email, keeping the key in emails', async () => {
    const { client, rows } = stubPrisma([]);
    const repo = new PrismaIdentityRepository(client as never);
    // seed runs first (empty table) — then the create.
    const res = await repo.upsert('newperson@x.com', { displayName: 'New Person', emails: ['alt@x.com'], githubLogin: 'newp' });
    expect(res.emails).toContain('newperson@x.com'); // key always retained
    expect(res.emails).toContain('alt@x.com');
    expect(rows.some((r) => r.emails.includes('newperson@x.com'))).toBe(true);
  });

  it('identityForEmail resolves the owning identity and its githubLogin (case-insensitive)', async () => {
    const { client } = stubPrisma([
      { id: 'a', displayName: 'A', emails: ['dri@x.com'], githubLogin: 'driHandle', clickupUserId: null, clickupNames: [] },
    ]);
    const repo = new PrismaIdentityRepository(client as never);
    expect((await repo.identityForEmail('DRI@x.com'))?.githubLogin).toBe('driHandle');
    expect(await repo.identityForEmail('nobody@x.com')).toBeNull();
  });

  // #540. These two used to be one value, so an admin clearing a handle got the
  // checked-in table's answer straight back. Absence is the outer null now.
  it('an owned address with no stored handle answers a row, not a silence', async () => {
    const { client } = stubPrisma([
      { id: 'a', displayName: 'A', emails: ['cleared@x.com'], githubLogin: null, clickupUserId: null, clickupNames: [] },
    ]);
    const repo = new PrismaIdentityRepository(client as never);
    const row = await repo.identityForEmail('cleared@x.com');
    expect(row).not.toBeNull();
    expect(row?.githubLogin).toBeNull();
    expect(await repo.identityForEmail('nobody@x.com')).toBeNull();
  });
});

describe('FixtureIdentityRepository (#11)', () => {
  it('serves PEOPLE_ALIASES and resolves handles, but 503s on writes', async () => {
    const repo = new FixtureIdentityRepository();
    expect((await repo.list()).length).toBe(PEOPLE_ALIASES.length);
    expect((await repo.identityForEmail('octocat@example.com'))?.githubLogin).toBe('octocat');
    await expect(
      repo.upsert('x@y.com', { displayName: 'X', emails: ['x@y.com'] }),
    ).rejects.toThrow(/reading a fixed roster/);
  });

  // Here the store IS the file, so "no row" and "a row with no handle" both
  // resolve to the file's answer and there is no second source underneath —
  // which is why fixture mode cannot show #540 and a verification run there
  // proves nothing about it. What fixture mode must still get right is that an
  // owned address answers a ROW: absence is the outer null, nothing else is.
  // (No shipped alias has a null handle, so the inner-null half is pinned on
  // the Prisma stub above and on the resolver spec, not here.)
  it('an owned address answers a row and an unknown one answers null', async () => {
    const repo = new FixtureIdentityRepository();
    const row = await repo.identityForEmail('OCTOCAT@EXAMPLE.COM');
    expect(row?.emails).toContain('octocat@example.com');
    expect(row?.githubLogin).toBe('octocat');
    expect(await repo.identityForEmail('nobody@example.com')).toBeNull();
  });

  it('the two reads describe the same team — list() and identityForEmail agree', async () => {
    const repo = new FixtureIdentityRepository();
    const rows = await repo.list();
    for (const r of rows) {
      expect(await repo.identityForEmail(r.emails[0])).toEqual(r);
    }
  });
});
