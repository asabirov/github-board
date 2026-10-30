import { describe, expect, it } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  IdentityController,
  WRITE_DROPS_ACTOR_BREAK_GLASS_ADMIN,
  WRITE_LEAVES_NO_USABLE_ADMIN,
} from './identity.controller';
import type { IdentityData, IdentityRecord, IdentityRepository } from './identity.repository';
import type { AuditService } from '../audit/audit.service';
import type { AuditAction } from '../audit/audit.types';
import type { AdminEmailCache } from '../auth/group-admins/admin-email-cache';
import { AdminAuthority } from '../auth/admin-authority';
import { fakeIdentityStore, identityRecordFor } from './identity.test-double';
import { GithubLoginResolver } from './github-login.resolver';

const REQ = { user: { email: 'admin@x.io' } };

/**
 * The REAL authority over a roster this spec controls, never a hand-written
 * `{ isAdministrable }` stub. What the controller has to get right is #591's
 * rule — a stored admin counts only if the roster could let them in — and a
 * stub answering that question a second time would agree with whatever the
 * controller did.
 *
 * Its admin-cache snapshot is left EMPTY on purpose. The controller must judge a
 * write on the records it reads itself: the cache is stale-while-revalidate and
 * `invalidate()` is fired without an await, so on the request after a role write
 * it still holds the pre-write set. Any read of it here shows up as a wrong
 * answer rather than passing quietly.
 */
async function authorityFor(opts: { env?: string; roster?: string[] } = {}): Promise<AdminAuthority> {
  const a = new AdminAuthority(
    {
      get: (key: string, def?: unknown) => (key === 'BOARD_ADMIN_EMAILS' ? opts.env ?? '' : def),
    } as unknown as ConfigService,
    { emails: () => [] },
    { listMemberEmails: async () => opts.roster ?? [] },
  );
  await a.onModuleInit();
  return a;
}

function stubAudit(): AuditService & { actions: AuditAction[] } {
  const actions: AuditAction[] = [];
  return {
    actions,
    record: async (e: { action: AuditAction }) => {
      actions.push(e.action);
    },
    list: async () => [],
  } as unknown as AuditService & { actions: AuditAction[] };
}

function stubCache(): { cache: AdminEmailCache; count: () => number } {
  let invalidations = 0;
  const cache = { invalidate: () => { invalidations += 1; } } as unknown as AdminEmailCache;
  return { cache, count: () => invalidations };
}

/**
 * The REAL resolver over a roster whose table read is counted. Real on purpose:
 * asserting a spy on `invalidateRoster` would only prove the controller calls a
 * method, not that the next reader gets a fresh answer.
 */
function stubLogins(): { logins: GithubLoginResolver; reads: () => number } {
  const base = fakeIdentityStore([]);
  let reads = 0;
  const store: IdentityRepository = {
    ...base,
    list: async () => {
      reads += 1;
      return base.list();
    },
  };
  return { logins: new GithubLoginResolver(store), reads: () => reads };
}

/**
 * The refusal a call produced, proved to be one before anything reads it. Both
 * halves matter: `rejects.toThrow(ConflictException)` alone passes for either of
 * the two messages, so a regression that crossed them — telling the last-admin
 * demoter that their admin comes from the env var — would ship green. Every
 * refusal below pins WHICH message its path throws.
 */
async function refusal(call: Promise<unknown>): Promise<Error> {
  const err: unknown = await call.then(() => null).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConflictException);
  return err as Error;
}

function stubRepo(seed: IdentityRecord[] = []): IdentityRepository & { calls: Array<[string, IdentityData]> } {
  const calls: Array<[string, IdentityData]> = [];
  return {
    calls,
    // Both reads come off `seed` — `currentRole` now asks the same per-email
    // lookup the upsert targets, so a spec that seeds a role must serve it here.
    ...fakeIdentityStore(seed),
    upsert: async (keyEmail: string, data: IdentityData) => {
      calls.push([keyEmail, data]);
      return {
        id: 'x',
        displayName: data.displayName,
        emails: data.emails,
        githubLogin: data.githubLogin ?? null,
        clickupUserId: data.clickupUserId ?? null,
        clickupNames: data.clickupNames ?? [],
        role: data.role ?? null,
      } as IdentityRecord;
    },
  };
}

describe('IdentityController (#11, #332)', () => {
  it('validates then upserts by the key email', async () => {
    const repo = stubRepo();
    const ctl = new IdentityController(repo, stubAudit(), stubCache().cache, stubLogins().logins, await authorityFor());
    const res = await ctl.upsert({
      email: 'maria.lopez@example.com',
      displayName: 'Maria Lopez',
      emails: ['maria.lopez@example.com'],
      githubLogin: 'mlopez',
    }, REQ);
    expect(res.githubLogin).toBe('mlopez');
    expect(repo.calls[0][0]).toBe('maria.lopez@example.com');
    expect(repo.calls[0][1].githubLogin).toBe('mlopez');
  });

  it('rejects a bad payload before touching the repository', async () => {
    const repo = stubRepo();
    const ctl = new IdentityController(repo, stubAudit(), stubCache().cache, stubLogins().logins, await authorityFor());
    await expect(ctl.upsert({ email: 'nope', displayName: 'x', emails: ['x@y.com'] }, REQ)).rejects.toThrow(
      BadRequestException,
    );
    expect(repo.calls).toHaveLength(0);
  });

  it('rejects an invalid role', async () => {
    const repo = stubRepo();
    const ctl = new IdentityController(repo, stubAudit(), stubCache().cache, stubLogins().logins, await authorityFor());
    await expect(
      ctl.upsert({ email: 'a@x.io', displayName: 'A', emails: ['a@x.io'], role: 'superuser' }, REQ),
    ).rejects.toThrow(BadRequestException);
  });

  it('audits a role change distinctly and invalidates the admin cache (#332)', async () => {
    const repo = stubRepo();
    const audit = stubAudit();
    const cache = stubCache();
    const ctl = new IdentityController(repo, audit, cache.cache, stubLogins().logins, await authorityFor());
    await ctl.upsert({ email: 'a@x.io', displayName: 'A', emails: ['a@x.io'], role: 'admin' }, REQ);
    expect(audit.actions).toContain('identity.role');
    expect(cache.count()).toBe(1);
  });

  it('leaves the stored role untouched when the role key is omitted (#332)', async () => {
    const repo = stubRepo([
      { id: 'x', displayName: 'A', emails: ['a@x.io'], githubLogin: null, clickupUserId: null, clickupNames: [], role: 'admin' },
    ]);
    const audit = stubAudit();
    const cache = stubCache();
    const ctl = new IdentityController(repo, audit, cache.cache, stubLogins().logins, await authorityFor());
    // No `role` key at all — a plain identity edit must not wipe the stored role.
    await ctl.upsert({ email: 'a@x.io', displayName: 'A', emails: ['a@x.io'] }, REQ);
    expect(repo.calls[0][1].role).toBeUndefined(); // repo leaves the column unchanged
    expect(audit.actions).not.toContain('identity.role');
    expect(cache.count()).toBe(0);
  });

  it('does not audit identity.role or invalidate when the role is unchanged (#332)', async () => {
    // Prior stored role is already 'writer'; saving the same value is a no-op for role.
    const repo = stubRepo([
      { id: 'x', displayName: 'A', emails: ['a@x.io'], githubLogin: null, clickupUserId: null, clickupNames: [], role: 'writer' },
    ]);
    const audit = stubAudit();
    const cache = stubCache();
    const ctl = new IdentityController(repo, audit, cache.cache, stubLogins().logins, await authorityFor());
    await ctl.upsert({ email: 'a@x.io', displayName: 'A', emails: ['a@x.io'], role: 'writer' }, REQ);
    expect(audit.actions).not.toContain('identity.role');
    expect(audit.actions).toContain('identity.upsert');
    expect(cache.count()).toBe(0);
  });

  // #541. The reverse map is memoised on a minute's TTL, so without this an
  // admin who corrects a handle would watch the panel and the chart disagree
  // for up to a minute. Unlike the admin cache this fires on every upsert —
  // any edit can change a handle, not just a role edit.
  it('an upsert drops the roster memo, so the next reader re-reads the store', async () => {
    const repo = stubRepo();
    const logins = stubLogins();
    const ctl = new IdentityController(repo, stubAudit(), stubCache().cache, logins.logins, await authorityFor());
    await logins.logins.teamRoster();
    expect(logins.reads()).toBe(1);
    await ctl.upsert({ email: 'a@x.io', displayName: 'A', emails: ['a@x.io'] }, REQ);
    await logins.logins.teamRoster();
    expect(logins.reads()).toBe(2);
  });

  it('a rejected payload leaves the memo alone — nothing changed', async () => {
    const repo = stubRepo();
    const logins = stubLogins();
    const ctl = new IdentityController(repo, stubAudit(), stubCache().cache, logins.logins, await authorityFor());
    await logins.logins.teamRoster();
    await expect(ctl.upsert({ email: 'nope', displayName: 'x', emails: ['x@y.com'] }, REQ)).rejects.toThrow(
      BadRequestException,
    );
    await logins.logins.teamRoster();
    expect(logins.reads()).toBe(1);
  });
});

/**
 * #590. A role write used to land with nothing between it and what it left
 * behind, so the panel that assigns admin could also take the last one away —
 * and #588 made the way back an env var plus a redeploy.
 *
 * Both refusals are judged against the records the controller reads for this
 * request, never the admin cache: that snapshot lags the write by a refresh, so
 * a refusal computed from it would refuse or allow the wrong one.
 */
describe('IdentityController — a role write cannot leave the board unadministrable (#590)', () => {
  const ALICE = 'alice@example.com';
  const DEV = 'dev@example.com';
  const BOSS = 'boss@example.com';
  /** Holds a stored admin role, and left the team — the row #591 strands. */
  const EX = 'ex@example.com';

  const reqOf = (email: string) => ({ user: { email } });
  const admin = (...emails: string[]) => identityRecordFor({ emails, role: 'admin' });

  function controllerOver(repo: IdentityRepository, authority: AdminAuthority): IdentityController {
    return new IdentityController(repo, stubAudit(), stubCache().cache, stubLogins().logins, authority);
  }

  /** A full upsert payload, the shape the person editor submits. */
  const write = (keyEmail: string, over: Record<string, unknown> = {}) => ({
    email: keyEmail,
    displayName: 'Somebody',
    emails: [keyEmail],
    ...over,
  });

  it('refuses the write that takes the last admin who can sign in', async () => {
    const repo = stubRepo([admin(ALICE)]);
    const ctl = controllerOver(repo, await authorityFor({ roster: [ALICE, DEV] }));
    expect((await refusal(ctl.upsert(write(ALICE, { role: null }), reqOf(ALICE)))).message).toBe(
      WRITE_LEAVES_NO_USABLE_ADMIN,
    );
    expect(repo.calls).toHaveLength(0);
  });

  // The state the admin SET cannot see, and the reason the check asks the
  // authority whether anyone could arrive rather than counting the set. Alice is
  // the only admin who can sign in; the row next to hers belongs to somebody who
  // has left, and it keeps the set non-empty all the way down.
  it('refuses it even when a stranded admin row keeps the set looking healthy', async () => {
    const authority = await authorityFor({ roster: [ALICE, DEV] });
    const repo = stubRepo([admin(ALICE), admin(EX)]);
    const ctl = controllerOver(repo, authority);
    expect((await refusal(ctl.upsert(write(ALICE, { role: null }), reqOf(ALICE)))).message).toBe(
      WRITE_LEAVES_NO_USABLE_ADMIN,
    );
    expect(repo.calls).toHaveLength(0);
    // What the write would have left: a non-empty admin set that nobody can use.
    expect(authority.effectiveAdminEmails([EX])).toEqual([EX]);
  });

  it('allows it when the break-glass takes over — that is what BOARD_ADMIN_EMAILS is for', async () => {
    const repo = stubRepo([admin(ALICE)]);
    const ctl = controllerOver(repo, await authorityFor({ env: BOSS, roster: [ALICE, BOSS] }));
    await ctl.upsert(write(ALICE, { role: null }), reqOf(ALICE));
    expect(repo.calls).toHaveLength(1);
  });

  it('allows it while another admin who can sign in is left', async () => {
    const repo = stubRepo([admin(ALICE), admin(DEV)]);
    const ctl = controllerOver(repo, await authorityFor({ roster: [ALICE, DEV] }));
    await ctl.upsert(write(ALICE, { role: null }), reqOf(ALICE));
    expect(repo.calls).toHaveLength(1);
  });

  // The role never changes here: the addresses do. A check that only looked at
  // the incoming role would wave this through, and one that kept the row's
  // stored addresses would compute a board that the write does not produce.
  it('refuses an edit that keeps the role and moves the last admin off the roster', async () => {
    const repo = stubRepo([admin(ALICE, 'alice.alt@example.com')]);
    const ctl = controllerOver(repo, await authorityFor({ roster: [ALICE, DEV] }));
    const err = await refusal(
      ctl.upsert(
        // Keyed on the alias, so the write targets Alice's row and leaves it
        // holding only the address the roster does not have.
        write('alice.alt@example.com', { emails: ['alice.alt@example.com'], role: 'admin' }),
        reqOf(ALICE),
      ),
    );
    expect(err.message).toBe(WRITE_LEAVES_NO_USABLE_ADMIN);
    expect(repo.calls).toHaveLength(0);
  });

  it('allows the alias edit that keeps an address the roster has', async () => {
    const repo = stubRepo([admin(ALICE, 'alice.alt@example.com')]);
    const ctl = controllerOver(repo, await authorityFor({ roster: [ALICE, DEV] }));
    await ctl.upsert(write(ALICE, { emails: [ALICE, 'alice.new@example.com'], role: 'admin' }), reqOf(ALICE));
    expect(repo.calls).toHaveLength(1);
  });

  it('does not stand in the way of a board that already had nobody', async () => {
    // No stored admins and no break-glass: this write is not what broke it, and
    // refusing every edit on a board in that state helps nobody.
    const repo = stubRepo([]);
    const ctl = controllerOver(repo, await authorityFor({ roster: [ALICE, DEV] }));
    await ctl.upsert(write(DEV, { role: 'writer' }), reqOf(ALICE));
    expect(repo.calls).toHaveLength(1);
  });

  it('names the recovery the reader can reach from the panel they are in', () => {
    expect(WRITE_LEAVES_NO_USABLE_ADMIN).toMatch(/Admin role/);
    expect(WRITE_LEAVES_NO_USABLE_ADMIN).toMatch(/team roster/i);
    expect(WRITE_LEAVES_NO_USABLE_ADMIN).not.toMatch(/[A-Z]{3,}/); // no shouting
  });
});

/**
 * #590, the second refusal — the trap the README used to warn about and now
 * cannot spring. Give a colleague the Admin role while your own admin comes from
 * BOARD_ADMIN_EMAILS, and the break-glass goes dormant the instant their row
 * exists (#371), taking your admin with it. You are then locked out of the panel
 * you were standing in, and the board is administrable by somebody else.
 */
describe('IdentityController — a write cannot take the actor own admin away (#590)', () => {
  const ALICE = 'alice@example.com';
  const DEV = 'dev@example.com';
  const BOSS = 'boss@example.com';
  const EX = 'ex@example.com';

  const reqOf = (email: string) => ({ user: { email } });
  const admin = (...emails: string[]) => identityRecordFor({ emails, role: 'admin' });
  const write = (keyEmail: string, over: Record<string, unknown> = {}) => ({
    email: keyEmail,
    displayName: 'Somebody',
    emails: [keyEmail],
    ...over,
  });

  function controllerOver(repo: IdentityRepository, authority: AdminAuthority): IdentityController {
    return new IdentityController(repo, stubAudit(), stubCache().cache, stubLogins().logins, authority);
  }

  it('refuses to give a colleague the Admin role while that is where your own admin comes from', async () => {
    const repo = stubRepo([]);
    const ctl = controllerOver(repo, await authorityFor({ env: BOSS, roster: [BOSS, ALICE, DEV] }));
    expect((await refusal(ctl.upsert(write(ALICE, { role: 'admin' }), reqOf(BOSS)))).message).toBe(
      WRITE_DROPS_ACTOR_BREAK_GLASS_ADMIN,
    );
    expect(repo.calls).toHaveLength(0);
  });

  it('allows it once you have given yourself the Admin role first', async () => {
    const repo = stubRepo([admin(BOSS)]);
    const ctl = controllerOver(repo, await authorityFor({ env: BOSS, roster: [BOSS, ALICE, DEV] }));
    await ctl.upsert(write(ALICE, { role: 'admin' }), reqOf(BOSS));
    expect(repo.calls).toHaveLength(1);
  });

  it('lets a break-glass admin take their own account through the same door', async () => {
    const repo = stubRepo([]);
    const ctl = controllerOver(repo, await authorityFor({ env: BOSS, roster: [BOSS, ALICE] }));
    await ctl.upsert(write(BOSS, { role: 'admin' }), reqOf(BOSS));
    expect(repo.calls).toHaveLength(1);
  });

  // #591's arming rule decides this, not "a stored admin now exists": a row
  // nobody can sign in as leaves the break-glass armed, so the actor keeps their
  // admin and there is nothing to refuse.
  it('allows a promotion that leaves the break-glass armed', async () => {
    const repo = stubRepo([]);
    const ctl = controllerOver(repo, await authorityFor({ env: BOSS, roster: [BOSS, DEV] }));
    await ctl.upsert(write(EX, { role: 'admin' }), reqOf(BOSS));
    expect(repo.calls).toHaveLength(1);
  });

  // Narrow on purpose. Stepping down from a role you hold is a real thing to
  // want, and it is refused only when it leaves nobody (the check above).
  it('lets a stored admin step down while another admin who can sign in is left', async () => {
    const repo = stubRepo([admin(ALICE), admin(DEV)]);
    const ctl = controllerOver(repo, await authorityFor({ env: BOSS, roster: [ALICE, DEV] }));
    await ctl.upsert(write(ALICE, { role: null }), reqOf(ALICE));
    expect(repo.calls).toHaveLength(1);
  });

  it('names the recovery, which is your own account before theirs', () => {
    expect(WRITE_DROPS_ACTOR_BREAK_GLASS_ADMIN).toMatch(/BOARD_ADMIN_EMAILS/);
    expect(WRITE_DROPS_ACTOR_BREAK_GLASS_ADMIN).toMatch(/your own account/i);
    // No shouting — the env var is the one thing that gets to be in capitals,
    // because that is its name.
    expect(WRITE_DROPS_ACTOR_BREAK_GLASS_ADMIN.replace('BOARD_ADMIN_EMAILS', '')).not.toMatch(/[A-Z]{3,}/);
  });
});

/**
 * #591, at the write. A break-glass address the roster does not have cannot
 * administer the board, so it cannot be what makes a demotion safe either —
 * before this the guard read `BOARD_ADMIN_EMAILS` as a standing safety net and
 * let the only admin who could sign in step down behind it.
 */
describe('IdentityController — a break-glass nobody can use is not a safety net (#591)', () => {
  const ALICE = 'alice@example.com';
  const DEV = 'dev@example.com';
  /** Named in BOARD_ADMIN_EMAILS, and no longer in the team group. */
  const GHOST = 'ghost@example.com';

  it('refuses the demotion that leaves only an env address the roster does not have', async () => {
    const repo = stubRepo([identityRecordFor({ emails: [ALICE], role: 'admin' })]);
    const ctl = new IdentityController(
      repo,
      stubAudit(),
      stubCache().cache,
      stubLogins().logins,
      await authorityFor({ env: GHOST, roster: [ALICE, DEV] }),
    );
    const err = await refusal(
      ctl.upsert({ email: ALICE, displayName: 'Alice', emails: [ALICE], role: null }, { user: { email: ALICE } }),
    );
    expect(err.message).toBe(WRITE_LEAVES_NO_USABLE_ADMIN);
    expect(repo.calls).toHaveLength(0);
  });
});

/**
 * The guard must not be switchable off by the roster read that is narrower than
 * the gate. `PEOPLE_SOURCE` lists DIRECT members; `TeamAccessGuard` resolves
 * nested groups too, so an admin who belongs through a nested group signs in
 * perfectly well while reading here as somebody who cannot. A guard that stood
 * aside on that answer would disable itself for exactly the board it protects.
 */
describe('IdentityController — a roster that cannot see an admin does not disarm the guard (#590)', () => {
  const ALICE = 'alice@example.com';
  const DEV = 'dev@example.com';
  const GHOST = 'ghost@example.com';

  /** The roster read misses Alice — she is a member through a nested group. */
  const rosterWithoutAlice = { roster: [DEV] };

  function ctlOver(repo: IdentityRepository, authority: AdminAuthority): IdentityController {
    return new IdentityController(repo, stubAudit(), stubCache().cache, stubLogins().logins, authority);
  }

  it('still refuses the admin who reads as unusable demoting themself into a locked board', async () => {
    const repo = stubRepo([identityRecordFor({ emails: [ALICE], role: 'admin' })]);
    const ctl = ctlOver(repo, await authorityFor(rosterWithoutAlice));
    const err = await refusal(
      ctl.upsert({ email: ALICE, displayName: 'Alice', emails: [ALICE], role: null }, { user: { email: ALICE } }),
    );
    expect(err.message).toBe(WRITE_LEAVES_NO_USABLE_ADMIN);
    expect(repo.calls).toHaveLength(0);
  });

  // The other half of the same rule: a write that takes nothing away cannot be
  // the write that broke anything, so the repair path is open even when the
  // board reads as beyond repair.
  it('lets a repair land on a board that reads as unadministrable', async () => {
    const repo = stubRepo([identityRecordFor({ emails: [ALICE], role: 'admin' })]);
    const ctl = ctlOver(repo, await authorityFor(rosterWithoutAlice));
    // GHOST is not on the roster either, so the board still reads as dead after
    // this write. It removes nobody, which is what decides it.
    await ctl.upsert(
      { email: GHOST, displayName: 'Ghost', emails: [GHOST], role: 'admin' },
      { user: { email: ALICE } },
    );
    expect(repo.calls).toHaveLength(1);
  });
});
