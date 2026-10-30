import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  AdminAuthority,
  BOOT_ADMIN_ROSTER_UNREAD,
  BOOT_ADMINS_UNREACHABLE_BREAK_GLASS,
  BOOT_ADMINS_UNREACHABLE_NO_BREAK_GLASS,
  BOOT_BREAK_GLASS_ACTIVE,
  BOOT_NO_ADMINS_RESOLVE,
} from './admin-authority';
import { AdminEmailCache } from './group-admins/admin-email-cache';
import type { IPeopleSource } from '../people/people-source';
import type { AuthenticatedActor } from './static-agent';

/** An actor as the guards leave it, with the scope claim a token carries. */
type Caller = AuthenticatedActor & { scopes?: string[] };

function config(env = ''): ConfigService {
  return {
    get: (key: string, def?: unknown) => (key === 'BOARD_ADMIN_EMAILS' ? env : def),
  } as unknown as ConfigService;
}

/** Lets the background roster read `teamRoster` kicks off settle. It is `void`ed
 *  there on purpose — `isAdmin` is sync — so there is no promise to await. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** `assigned` = emails with a board-assigned `admin` role (the AdminEmailCache snapshot). */
function authority(opts: { env?: string; assigned?: string[] } = {}): AdminAuthority {
  return new AdminAuthority(config(opts.env ?? ''), { emails: () => opts.assigned ?? [] });
}

/** The team roster as `IPeopleSource` hands it over: the addresses that could
 *  pass sign-in, or an Error for a read that fails cold. */
function rosterOf(emails: string[] | Error): IPeopleSource {
  return {
    listMemberEmails: async () => {
      if (emails instanceof Error) throw emails;
      return emails;
    },
  };
}

/**
 * An authority whose roster HAS been read — `onModuleInit` awaited, the way Nest
 * settles it before any `onApplicationBootstrap` runs. Everything about #591
 * hangs on that read having happened, so a spec that skips the await is testing
 * the unknown-roster state instead.
 */
async function warmed(
  opts: { env?: string; assigned?: string[]; roster: string[] | Error } = { roster: [] },
): Promise<AdminAuthority> {
  const a = new AdminAuthority(
    config(opts.env ?? ''),
    { emails: () => opts.assigned ?? [] },
    rosterOf(opts.roster),
  );
  // A cold roster failure logs its own error; swallow it so it cannot be
  // mistaken for a boot-guard message in a spy installed after this resolves.
  const quiet = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  await a.onModuleInit();
  quiet.mockRestore();
  return a;
}

/**
 * The one message a boot-guard spy was called with — and proof, before any
 * assertion reads it, that there was exactly ONE call and that it carried a
 * string. Both halves are load-bearing: the boot guard's whole job is to say one
 * thing about the board's admin posture, so a second call (two branches firing)
 * or a non-string first argument is itself the defect, and reading `calls[0][0]`
 * straight would let either through as long as the message that IS there matches.
 */
function onlyMessage(spy: MockInstance): string {
  expect(spy).toHaveBeenCalledOnce();
  const [first] = spy.mock.calls[0] as unknown[];
  expect(typeof first).toBe('string');
  return first as string;
}

/** An AdminEmailCache whose only read threw — cold boot with the source down. */
async function unreadCache(): Promise<AdminEmailCache> {
  const cache = new AdminEmailCache(
    { listAdminEmails: async () => { throw new Error('postgres down'); } },
    config(),
  );
  // The cache logs the failure itself; swallow it so it cannot be mistaken for
  // the boot guard's message in a spy installed after this resolves.
  const quiet = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  await cache.onModuleInit();
  quiet.mockRestore();
  return cache;
}

describe('AdminAuthority (#143, #332)', () => {
  it('a board-assigned admin role makes an admin (source=assigned)', () => {
    const a = authority({ assigned: ['owner@example.com'] });
    expect(a.isAdmin('owner@example.com')).toBe(true);
    expect(a.sourceOf('owner@example.com')).toBe('assigned');
  });

  it('a break-glass bootstrap email is an admin (source=bootstrap)', () => {
    const a = authority({ env: 'boss@example.com' });
    expect(a.isAdmin('boss@example.com')).toBe(true);
    expect(a.sourceOf('boss@example.com')).toBe('bootstrap');
  });

  it('the bootstrap is DORMANT once any stored admin exists (#371)', () => {
    // boss is in BOARD_ADMIN_EMAILS but owner holds a stored admin role, so the
    // env goes inert — boss is not an admin, and the admin list is the stored set.
    const a = authority({ env: 'boss@example.com', assigned: ['owner@example.com'] });
    expect(a.isAdmin('owner@example.com')).toBe(true);
    expect(a.isAdmin('boss@example.com')).toBe(false);
    expect(a.listAdminEmails()).toEqual(['owner@example.com']);
  });

  it('the bootstrap ACTIVATES when there are zero stored admins (#371)', () => {
    const a = authority({ env: 'boss@example.com, other@example.com' });
    expect(a.isAdmin('boss@example.com')).toBe(true);
    expect(a.listAdminEmails().sort()).toEqual(['boss@example.com', 'other@example.com']);
  });

  it('is case-insensitive and ignores blanks', () => {
    // Stored-admin case-insensitivity (its own path):
    const stored = authority({ assigned: ['Owner@example.com'] });
    expect(stored.isAdmin('OWNER@example.com')).toBe(true);
    // Active-bootstrap case-insensitivity (no stored admins → env active):
    const boot = authority({ env: 'Boss@example.com' });
    expect(boot.isAdmin('BOSS@example.com')).toBe(true);
    expect(boot.isAdmin('')).toBe(false);
    expect(boot.isAdmin('  ')).toBe(false);
  });

  it('a plain member (neither assigned role nor bootstrap) is not an admin', () => {
    const a = authority({ env: 'boss@example.com', assigned: ['owner@example.com'] });
    expect(a.isAdmin('member@example.com')).toBe(false);
  });

  it('an assigned role covers an email that is ALSO in the bootstrap — source stays assigned', () => {
    const a = authority({ env: 'both@example.com', assigned: ['both@example.com'] });
    expect(a.sourceOf('both@example.com')).toBe('assigned');
  });

  it('boot guard warns in break-glass mode — env active, no stored admins (#371)', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    authority({ env: 'boss@example.com' }).onApplicationBootstrap();
    // The behaviour: this branch, at WARN, and no error alongside it.
    expect(onlyMessage(warn)).toBe(BOOT_BREAK_GLASS_ACTIVE);
    expect(err).not.toHaveBeenCalled();
    // The env is granting admin, and the way out really is open: this caller can
    // reach the panel, so the message names it.
    expect(BOOT_BREAK_GLASS_ACTIVE).toContain('Admin › Access');
    warn.mockRestore();
    err.mockRestore();
  });

  // #588. With zero admins the reader cannot open Admin › Access — that panel is
  // behind AdminGuard — so the message must not send them there, and the env var
  // alone is not enough either: BOARD_GROUP_SOURCE=directory means an address
  // outside the allow list is still refused at sign-in.
  it('boot guard errors when ZERO admins resolve, naming the only route that works (#588)', () => {
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    authority({}).onApplicationBootstrap();
    // The behaviour: this branch, at ERROR, and no warning alongside it.
    expect(onlyMessage(err)).toBe(BOOT_NO_ADMINS_RESOLVE);
    expect(warn).not.toHaveBeenCalled();
    // ...and what that message has to carry. Asserted on the constant, so the
    // requirements sit next to the identity check above rather than in a regex
    // that a reword can satisfy while losing the point: the impossible
    // instruction is sending the reader to assign a role, because the panel that
    // assigns one needs the admin they do not have. The env var is the only way
    // in, and not on its own — an address outside the allow list is still
    // refused at sign-in under BOARD_GROUP_SOURCE=directory.
    expect(BOOT_NO_ADMINS_RESOLVE).toContain('BOARD_ADMIN_EMAILS');
    expect(BOOT_NO_ADMINS_RESOLVE).toMatch(/allow list/i);
    expect(BOOT_NO_ADMINS_RESOLVE).toMatch(/Admin › Access cannot repair this/);
    err.mockRestore();
    warn.mockRestore();
  });

  /**
   * #588, the arming rule. The break-glass activates on EVIDENCE that the board
   * has no admins — a roster read that succeeded and came back empty — never on
   * the absence of a successful read.
   *
   * These use a real `AdminEmailCache` over a throwing source rather than a
   * hand-written stub, because the state under test is one only the cache can
   * produce: its catch keeps the last-good snapshot, and at cold boot there
   * isn't one. A stub returning `[]` is a different state that happens to have
   * looked identical — which is exactly the bug.
   */
  it('does NOT arm the break-glass when the roster was never read (#588)', async () => {
    const a = new AdminAuthority(config('boss@example.com'), await unreadCache());
    expect(a.isAdmin('boss@example.com')).toBe(false);
    expect(a.listAdminEmails()).toEqual([]);
  });

  it('arms it again on the first read that SUCCEEDS and finds nobody (#588)', async () => {
    // The same env, the same empty result — but read, not assumed. The
    // break-glass is meant to fire here, so the rule above cannot be "never".
    const a = authority({ env: 'boss@example.com', assigned: [] });
    expect(a.isAdmin('boss@example.com')).toBe(true);
  });

  it('boot guard says the roster is unread rather than claiming nobody resolves (#588)', async () => {
    const cache = await unreadCache();
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    // BOARD_ADMIN_EMAILS is set, so before #588 this took the break-glass branch
    // and reported the env var as granting admin — while it was not, and could
    // not know whether it should.
    new AdminAuthority(config('boss@example.com'), cache).onApplicationBootstrap();
    expect(onlyMessage(err)).toBe(BOOT_ADMIN_ROSTER_UNREAD);
    expect(warn).not.toHaveBeenCalled();
    // Neither of the other two branches may be what an unread roster prints:
    // both are claims about a roster nobody has read.
    expect(BOOT_ADMIN_ROSTER_UNREAD).not.toBe(BOOT_BREAK_GLASS_ACTIVE);
    expect(BOOT_ADMIN_ROSTER_UNREAD).not.toBe(BOOT_NO_ADMINS_RESOLVE);
    err.mockRestore();
    warn.mockRestore();
  });

  it('boot guard is silent once a stored admin exists (#371)', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    authority({ env: 'boss@example.com', assigned: ['owner@example.com'] }).onApplicationBootstrap();
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });
});

/**
 * #591. A stored `admin` role is only worth counting if the person holding it
 * could actually arrive: `TeamAccessGuard` refuses anyone outside the allow list
 * at sign-in, before `AdminGuard` is ever consulted. An ex-employee's row used to
 * keep the break-glass dormant while nobody at all could administer the board,
 * and boot printed nothing because the admin set was not empty.
 *
 * The roster here is the same one the sign-in gate is judged against — the team
 * group in production, BOARD_ALLOWED_EMAILS in fixture mode — read through the
 * exported PEOPLE_SOURCE.
 */
describe('AdminAuthority — a stored admin counts only if they could sign in (#591)', () => {
  const OUTSIDE = 'ex@example.com';
  const MEMBER = 'owner@example.com';
  const BOSS = 'boss@example.com';

  it('a stored admin outside the team roster arms the break-glass beside them', async () => {
    const a = await warmed({ env: BOSS, assigned: [OUTSIDE], roster: [MEMBER, BOSS] });
    // This state says so on the first call — asserted on its own further down;
    // silenced here so the run's output stays pristine.
    const said = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    // BOTH, and that is the point. Usability decides whether the break-glass
    // arms, never who is in the set: the roster is read with `members.list`,
    // which — unlike the `hasMember` the sign-in gate uses — does not resolve
    // nested groups, so dropping a row on it would strip a real admin of admin
    // on an incomplete answer. Keeping the row costs nothing, because
    // TeamAccessGuard refuses them at sign-in on every request anyway.
    expect(a.listAdminEmails().sort()).toEqual([BOSS, OUTSIDE].sort());
    expect(a.isAdmin(BOSS)).toBe(true);
    said.mockRestore();
  });

  // The union, stated once with both halves in one assertion: the stranded row
  // is in the set AND the board is in the stranded posture. Dropping the row
  // would satisfy the second half alone, which is what this guards against —
  // that version stripped a stored admin of admin on a roster read that cannot
  // see nested groups, and hid the row from the Access panel that removes it.
  it('the effective set carries the stranded admin AND the armed break-glass, and boot calls it stranded', async () => {
    const a = await warmed({ env: BOSS, assigned: [OUTSIDE], roster: [MEMBER, BOSS] });
    expect(a.effectiveAdminEmails([OUTSIDE]).sort()).toEqual([BOSS, OUTSIDE].sort());
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    a.onApplicationBootstrap();
    expect(onlyMessage(warn)).toBe(BOOT_ADMINS_UNREACHABLE_BREAK_GLASS);
    expect(err).not.toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it('one stored admin on the roster keeps the break-glass dormant, stranded row and all', async () => {
    const a = await warmed({ env: BOSS, assigned: [MEMBER, OUTSIDE], roster: [MEMBER] });
    expect(a.listAdminEmails().sort()).toEqual([MEMBER, OUTSIDE].sort());
    expect(a.isAdmin(BOSS)).toBe(false);
  });

  it('a stored admin on the roster keeps the break-glass dormant, exactly as before', async () => {
    const a = await warmed({ env: BOSS, assigned: [MEMBER], roster: [MEMBER, BOSS] });
    expect(a.isAdmin(MEMBER)).toBe(true);
    expect(a.isAdmin(BOSS)).toBe(false);
  });

  // Unknown is not nobody, twice over. A roster read that failed says nothing
  // about who is a member, and neither does one that came back empty — a group
  // that reads as empty is far more likely to be a misconfigured group than a
  // company with no employees. Dropping the stored admins on either would turn a
  // Google outage into a lockout, which is #588's defect one level down.
  it('a roster read that FAILED never drops a stored admin', async () => {
    const a = await warmed({ env: BOSS, assigned: [OUTSIDE], roster: new Error('directory down') });
    // A failed read leaves the snapshot stale, so each call below retries it —
    // and the retry says nothing, because the same failure is reported on the
    // change and not once per read (#623). `warmed` already swallowed the line
    // this one would have repeated.
    const quiet = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    expect(a.isAdmin(OUTSIDE)).toBe(true);
    expect(a.isAdmin(BOSS)).toBe(false);
    // Those calls kicked a fresh read each; let them settle inside the spy, so
    // a line that did land lands here and not in the run's output afterwards.
    await flush();
    expect(quiet).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it('a roster that reads back EMPTY never drops a stored admin either', async () => {
    const a = await warmed({ env: BOSS, assigned: [OUTSIDE], roster: [] });
    expect(a.isAdmin(OUTSIDE)).toBe(true);
    expect(a.isAdmin(BOSS)).toBe(false);
  });

  /**
   * #623. "Never drops a stored admin" above is only half of what an empty read
   * must not do. The other half is the break-glass, and it moves the opposite
   * way: from 'stranded' the roster IS known, no stored row is on it, and the
   * env var is the only thing holding the board open. Clearing the roster on an
   * empty read counted every stored row again, emptied the bootstrap, and shut
   * that door — a transition only an empty SUCCESS could make, since a failure
   * has always kept the last-good roster.
   *
   * A source whose answer changes between reads, because that is the whole
   * subject: a roster that has been read, and then a read that comes back
   * empty. `warmed` cannot express it — its roster is fixed at construction.
   */
  it('an empty read never clears a roster already read, so an armed break-glass stays armed', async () => {
    let answer: string[] = [MEMBER, BOSS];
    const a = new AdminAuthority(config(BOSS), { emails: () => [OUTSIDE] }, {
      listMemberEmails: async () => answer,
    });
    await a.onModuleInit();

    // The stranded posture, armed: OUTSIDE holds the stored role and cannot
    // sign in, so BOSS is the board's only way in. It says so once, at warn.
    const quiet = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    expect(a.isAdmin(BOSS)).toBe(true);
    quiet.mockClear();

    answer = [];
    // The same awaited read a TTL refresh makes, through the same method boot
    // uses — no private field touched, and nothing about the wiring faked.
    await a.onModuleInit();

    expect(a.isAdmin(BOSS)).toBe(true);
    expect(a.effectiveAdminEmails([OUTSIDE]).sort()).toEqual([BOSS, OUTSIDE].sort());
    // A KNOWN roster was refused, so it is reported — at warn, because a source
    // answering `[]` is not a failed read and the fixture does it every boot.
    expect(onlyMessage(quiet)).toContain('came back empty');
    quiet.mockRestore();
  });

  it('an empty read stamps no clock either, so the next question asks again — and says so once', async () => {
    let answer: string[] = [MEMBER];
    let reads = 0;
    const a = new AdminAuthority(config(BOSS), { emails: () => [MEMBER] }, {
      listMemberEmails: async () => {
        reads += 1;
        return answer;
      },
    });
    // Date.now rather than fake timers: nothing else in this file runs on a
    // clock, and the only interval that matters is "has GROUP_CACHE_TTL_MS
    // passed", which two readings answer.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    await a.onModuleInit();
    expect(reads).toBe(1);

    now.mockReturnValue(1_000 + 400_000); // past the 300s TTL, so a read is due
    answer = [];
    const quiet = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    await a.onModuleInit();
    expect(reads).toBe(2);

    // The empty read set no `rosterAt`, so every question asks again instead of
    // holding a non-answer for a whole TTL — exactly what the failed path does.
    for (let gate = 0; gate < 10; gate++) {
      a.isAdmin(MEMBER);
      await flush();
    }
    expect(reads).toBe(12);
    // ...and all twelve of them are ONE line (#623). Not stamping the clock is
    // deliberate, so a line per read is a line per gate call, which is the same
    // as no line at all. Said on the change into the state, the way a posture is.
    expect(onlyMessage(quiet)).toContain('came back empty');
    now.mockRestore();
    quiet.mockRestore();
  });

  /**
   * #623. The failed read has the same shape of problem and a sharper cause:
   * with `DirectoryPeopleSource`'s failure floor in place, most of the rejections
   * this catch sees are the REMEMBERED failure handed straight back, so a line
   * per rejection reports reads that were never issued.
   */
  it('a read that keeps failing the same way says so once, and a new failure is still heard', async () => {
    let failure = new Error('invalid_grant');
    const a = new AdminAuthority(config(BOSS), { emails: () => [MEMBER] }, {
      listMemberEmails: async () => {
        throw failure;
      },
    });
    const quiet = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    for (let read = 0; read < 8; read++) await a.onModuleInit();
    expect(onlyMessage(quiet)).toContain('invalid_grant');

    // Keyed on the message, not on a flag: a second thing going wrong is not
    // swallowed by the first having already been reported.
    quiet.mockClear();
    failure = new Error('the operation was aborted');
    for (let read = 0; read < 8; read++) await a.onModuleInit();
    expect(onlyMessage(quiet)).toContain('the operation was aborted');
    quiet.mockRestore();
  });

  /**
   * #623. Said on the CHANGE into the state, not once and never again: a group
   * emptied in August and emptied again in October is two things happening, and
   * the second one has to be as visible as the first.
   *
   * The empty read at BOOT deliberately says nothing HERE. With no roster ever
   * read this end cannot tell a directory group that lists nobody from the
   * fixture source answering `[]` because BOARD_ALLOWED_EMAILS is unset, which
   * is normal operation — so that line belongs to `DirectoryPeopleSource`, which
   * knows it walked a real members page. Its spec holds the proof.
   */
  it('a group emptied, refilled and emptied again is reported both times, once each', async () => {
    let answer: string[] = [MEMBER];
    const a = new AdminAuthority(config(BOSS), { emails: () => [MEMBER] }, {
      listMemberEmails: async () => answer,
    });
    const quiet = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    await a.onModuleInit();

    answer = [];
    for (let read = 0; read < 5; read++) await a.onModuleInit();
    expect(onlyMessage(quiet)).toContain('keeping the roster already known');

    quiet.mockClear();
    answer = [MEMBER];
    await a.onModuleInit();
    answer = [];
    for (let read = 0; read < 5; read++) await a.onModuleInit();
    expect(onlyMessage(quiet)).toContain('keeping the roster already known');
    quiet.mockRestore();
  });

  it('the roster is unknown until onModuleInit has read it — an unwarmed authority arms nothing', async () => {
    const a = new AdminAuthority(config(BOSS), { emails: () => [OUTSIDE] }, rosterOf([MEMBER]));
    // Asserted on the ARMING, not on the set: the stranded row is in the set
    // either way, so only this tells a roster that has been read from one that
    // has not.
    expect(a.isAdmin(BOSS)).toBe(false);
    const said = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    await a.onModuleInit();
    expect(a.isAdmin(BOSS)).toBe(true);
    said.mockRestore();
  });

  it('boot warns that the stored admins cannot sign in and the env has taken over', async () => {
    const a = await warmed({ env: BOSS, assigned: [OUTSIDE], roster: [MEMBER, BOSS] });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    a.onApplicationBootstrap();
    expect(onlyMessage(warn)).toBe(BOOT_ADMINS_UNREACHABLE_BREAK_GLASS);
    expect(err).not.toHaveBeenCalled();
    // BOOT_BREAK_GLASS_ACTIVE would be a lie here: board-assigned admins DO
    // exist, they just cannot arrive. #588 was about exactly that kind of claim.
    expect(BOOT_ADMINS_UNREACHABLE_BREAK_GLASS).not.toBe(BOOT_BREAK_GLASS_ACTIVE);
    // The env is granting admin, so this reader can open the panel — and what
    // they have to do there is put the role on an account that can sign in.
    expect(BOOT_ADMINS_UNREACHABLE_BREAK_GLASS).toContain('Admin › Access');
    expect(BOOT_ADMINS_UNREACHABLE_BREAK_GLASS).toMatch(/allow list/i);
    warn.mockRestore();
    err.mockRestore();
  });

  it('boot errors when the stored admins cannot sign in and there is no break-glass to arm', async () => {
    const a = await warmed({ assigned: [OUTSIDE], roster: [MEMBER] });
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    a.onApplicationBootstrap();
    expect(onlyMessage(err)).toBe(BOOT_ADMINS_UNREACHABLE_NO_BREAK_GLASS);
    expect(warn).not.toHaveBeenCalled();
    // Nobody can reach the panel in this state, so the message must not send
    // them there — the env var is the only door, and only for an address the
    // sign-in gate will let through (#588).
    expect(BOOT_ADMINS_UNREACHABLE_NO_BREAK_GLASS).toContain('BOARD_ADMIN_EMAILS');
    expect(BOOT_ADMINS_UNREACHABLE_NO_BREAK_GLASS).toMatch(/allow list/i);
    expect(BOOT_ADMINS_UNREACHABLE_NO_BREAK_GLASS).toMatch(/Admin › Access cannot repair this/);
    expect(BOOT_ADMINS_UNREACHABLE_NO_BREAK_GLASS).not.toBe(BOOT_NO_ADMINS_RESOLVE);
    err.mockRestore();
    warn.mockRestore();
  });

  it('boot stays silent when a stored admin is on the roster', async () => {
    const a = await warmed({ env: BOSS, assigned: [MEMBER], roster: [MEMBER] });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    a.onApplicationBootstrap();
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  // A set that becomes unusable at 11am must not stay quiet until the next
  // rollout — and must not print on every refresh either, or the line nobody
  // reads is the one that mattered.
  it('says so when the admin set goes unusable at runtime — once, not on every call', async () => {
    let assigned = [MEMBER];
    const a = new AdminAuthority(config(BOSS), { emails: () => assigned }, rosterOf([MEMBER, BOSS]));
    await a.onModuleInit();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    a.listAdminEmails();
    expect(warn).not.toHaveBeenCalled();
    // The member leaves the board's admin set; all that is left is the ex-employee.
    assigned = [OUTSIDE];
    a.listAdminEmails();
    a.listAdminEmails();
    a.isAdmin(BOSS);
    expect(onlyMessage(warn)).toBe(BOOT_ADMINS_UNREACHABLE_BREAK_GLASS);
    warn.mockRestore();
  });

  it('says it again after the posture recovers and goes bad a second time', async () => {
    let assigned = [OUTSIDE];
    const a = new AdminAuthority(config(BOSS), { emails: () => assigned }, rosterOf([MEMBER, BOSS]));
    await a.onModuleInit();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    a.listAdminEmails();
    assigned = [MEMBER]; // repaired — an admin who can sign in
    a.listAdminEmails();
    assigned = [OUTSIDE]; // and broken again
    a.listAdminEmails();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('boot and the first request do not say the same thing twice', async () => {
    const a = await warmed({ env: BOSS, assigned: [OUTSIDE], roster: [MEMBER, BOSS] });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    a.onApplicationBootstrap();
    a.listAdminEmails();
    expect(onlyMessage(warn)).toBe(BOOT_ADMINS_UNREACHABLE_BREAK_GLASS);
    warn.mockRestore();
  });
});

/**
 * #590. `effectiveAdminEmails` answers WHO the admins are; this answers whether
 * any of them could arrive. The two part company on exactly one state — stored
 * rows that are all outside the allow list, with no break-glass to take over —
 * and that state is reachable by a role write the Access panel allows, which is
 * why the check the panel needs is this one and not the set's emptiness.
 */
describe('AdminAuthority.isAdministrable — could ANYBODY administer this board (#590)', () => {
  const OUTSIDE = 'ex@example.com';
  const MEMBER = 'owner@example.com';
  const BOSS = 'boss@example.com';

  it('a stored admin on the roster is enough, with no break-glass set', async () => {
    const a = await warmed({ assigned: [], roster: [MEMBER] });
    expect(a.isAdministrable([MEMBER])).toBe(true);
  });

  it('a break-glass is enough with no stored admin at all', async () => {
    const a = await warmed({ env: BOSS, roster: [MEMBER, BOSS] });
    expect(a.isAdministrable([])).toBe(true);
  });

  it('neither one is nobody', async () => {
    const a = await warmed({ roster: [MEMBER] });
    expect(a.isAdministrable([])).toBe(false);
  });

  // The state the set alone cannot see, and the whole reason this method exists.
  it('stored admins who are all outside the roster, with no break-glass, is nobody', async () => {
    const a = await warmed({ assigned: [], roster: [MEMBER] });
    expect(a.isAdministrable([OUTSIDE])).toBe(false);
    // ...while the effective set is not empty at all: the stranded row stays in
    // it (#591), so a caller judging this question by `length` would allow the
    // write that produces exactly this board.
    expect(a.effectiveAdminEmails([OUTSIDE])).toEqual([OUTSIDE]);
  });

  it('the same stranded rows ARE administrable once the break-glass can take over', async () => {
    const a = await warmed({ env: BOSS, assigned: [], roster: [MEMBER, BOSS] });
    expect(a.isAdministrable([OUTSIDE])).toBe(true);
  });

  it('reads its argument, not the cache — the set a caller is about to write', async () => {
    // The cache still holds the pre-write admin, and the answer is about the set
    // handed over. `AdminEmailCache` is stale-while-revalidate, so a caller
    // deciding a write on the cache would decide it on the previous one.
    const a = await warmed({ assigned: [MEMBER], roster: [MEMBER] });
    expect(a.isAdministrable([])).toBe(false);
  });

  it('an unknown roster counts every stored row, so an outage cannot make a board look dead', async () => {
    const a = new AdminAuthority(config(''), { emails: () => [] }, rosterOf([MEMBER]));
    // No onModuleInit: the roster has never been read, which is not evidence
    // that OUTSIDE cannot sign in.
    expect(a.isAdministrable([OUTSIDE])).toBe(true);
  });

  it('normalizes the set it is handed', async () => {
    const a = await warmed({ roster: [MEMBER] });
    expect(a.isAdministrable([' Owner@example.com '])).toBe(true);
  });
});

/**
 * #551 follow-up. The break-glass rule — the assigned set, or the env bootstrap
 * only when that set is empty — had grown a second implementation in
 * `AdminAccessService`, over the identity records the Access panel has just
 * loaded rather than over the admin cache. The rule now lives here alone and
 * takes the assigned set as an argument, so each caller keeps its own data path.
 *
 * Keeping the panel's path was the point. `AdminEmailCache` is
 * stale-while-revalidate and `identity.controller` calls `invalidate()` without
 * awaiting it, so for the request right after a role write the snapshot is still
 * the pre-write one. Handing the panel `listAdminEmails()` would have traded a
 * duplicated rule for a panel that shows the admin you just made as not one.
 */
describe('AdminAuthority.effectiveAdminEmails — the break-glass rule, in one place', () => {
  it('is the assigned set whenever it has anyone in it — the bootstrap stays dormant', () => {
    const a = authority({ env: 'boss@example.com' });
    expect(a.effectiveAdminEmails(['owner@example.com'])).toEqual(['owner@example.com']);
  });

  it('activates the bootstrap only when the assigned set is empty', () => {
    const a = authority({ env: 'boss@example.com, other@example.com' });
    expect(a.effectiveAdminEmails([]).sort()).toEqual(['boss@example.com', 'other@example.com']);
  });

  it('normalizes and dedupes whatever set it is handed', () => {
    const a = authority({ env: 'boss@example.com' });
    expect(a.effectiveAdminEmails(['Owner@example.com', ' owner@example.com '])).toEqual([
      'owner@example.com',
    ]);
  });

  it('is the rule behind both of the authority own answers — the cache view and the address test', () => {
    const a = authority({ env: 'boss@example.com', assigned: ['Owner@example.com'] });
    // listAdminEmails is this rule over the cache snapshot, nothing more.
    expect(a.listAdminEmails()).toEqual(a.effectiveAdminEmails(['Owner@example.com']));
    // ...and isAdmin is membership of exactly that set.
    expect(a.isAdmin('owner@example.com')).toBe(true);
    expect(a.isAdmin('boss@example.com')).toBe(false);
  });
});

// #551 — `isAdmin` answers about an ADDRESS. Whether a caller may act as an
// admin is a second question, and the board had two different answers to it: the
// reporting surface composed personhood at the call site, the gate did not ask
// at all. `isAdminActor` is the one place that composition now lives.
describe('AdminAuthority.isAdminActor (#551)', () => {
  it('a static agent is not an admin however its address got into the set', () => {
    expect(authority({ env: 'agent:ci' }).isAdminActor({ email: 'agent:ci', staticAgent: true })).toBe(false);
    expect(
      authority({ assigned: ['agent:ci'] }).isAdminActor({ email: 'agent:ci', staticAgent: true }),
    ).toBe(false);
  });

  // #525: the predicate reads the flag `jwt-auth.guard` writes, never the shape
  // of the address. A token named `claude@ci` authenticates as
  // `agent:claude@ci`, which every address-shaped test reads as a person.
  it('a static agent with a person-shaped name is still not an admin', () => {
    const a = authority({ env: 'agent:claude@ci' });
    expect(a.isAdminActor({ email: 'agent:claude@ci', agent: true, staticAgent: true })).toBe(false);
    // The address is genuinely in the admin set — the refusal is the personhood
    // test, not a lookup that quietly missed.
    expect(a.isAdmin('agent:claude@ci')).toBe(true);
  });

  it('a scoped actor that is NOT a static agent keeps its admin — PAT and MCP session alike', () => {
    const a = authority({ assigned: ['boss@example.com'] });
    // Typed as the shared actor plus the scope claim, the same intersection
    // me.controller.ts uses: the decision deliberately ignores scopes (that is
    // the scope layer's separate job), and these carry them anyway so the
    // fixtures are the actor shapes jwt-auth.guard really builds.
    const pat: Caller = { email: 'boss@example.com', scopes: ['board:read', 'board:admin'] };
    const mcpSession: Caller = { email: 'boss@example.com', agent: true, scopes: ['board:read'] };
    expect(a.isAdminActor(pat)).toBe(true);
    expect(a.isAdminActor(mcpSession)).toBe(true);
  });

  it('a signed-in human admin is unaffected, by either path (#371)', () => {
    expect(authority({ assigned: ['owner@example.com'] }).isAdminActor({ email: 'owner@example.com' })).toBe(true);
    expect(authority({ env: 'boss@example.com' }).isAdminActor({ email: 'boss@example.com' })).toBe(true);
  });

  it('a non-admin person is still not an admin, and an absent actor is not one either', () => {
    const a = authority({ assigned: ['owner@example.com'] });
    expect(a.isAdminActor({ email: 'dev@example.com' })).toBe(false);
    expect(a.isAdminActor(undefined)).toBe(false);
    expect(a.isAdminActor({})).toBe(false);
  });

  it('isAdmin still answers the address question on its own — the two are different questions', () => {
    // The surviving method is what `consent.controller` and `account.controller`
    // call, both under HumanOnlyGuard. It must keep answering about the address.
    const a = authority({ env: 'agent:ci' });
    expect(a.isAdmin('agent:ci')).toBe(true);
    expect(a.isAdminActor({ email: 'agent:ci', staticAgent: true })).toBe(false);
  });
});

/**
 * #591, the half the first pass left out. A break-glass address gets the same
 * roster question as a stored role, because `TeamAccessGuard` asks it of
 * everybody: BOARD_ADMIN_EMAILS naming somebody outside the allow list is not a
 * typo case, it is an address that was right when it was set and drifted when
 * that person left the group.
 */
describe('AdminAuthority — the break-glass is roster-tested too (#591)', () => {
  const OUTSIDE = 'ex@example.com';
  const MEMBER = 'owner@example.com';
  const BOSS = 'boss@example.com';

  it('an env address the roster does not have cannot administer the board either', async () => {
    const a = await warmed({ env: OUTSIDE, roster: [MEMBER, BOSS] });
    expect(a.isAdministrable([])).toBe(false);
  });

  it('an env address the roster does have still can', async () => {
    const a = await warmed({ env: BOSS, roster: [MEMBER, BOSS] });
    expect(a.isAdministrable([])).toBe(true);
  });

  it('an unknown roster leaves the break-glass exactly as it was, this half included', async () => {
    // Never read: not evidence that the env address cannot sign in, so it counts.
    const a = new AdminAuthority(config(BOSS), { emails: () => [] }, rosterOf([MEMBER]));
    expect(a.isAdministrable([])).toBe(true);
  });

  it('boot calls a set-but-unusable break-glass what it is: nobody, at error', async () => {
    const a = await warmed({ env: OUTSIDE, roster: [MEMBER] });
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    a.onApplicationBootstrap();
    // Not BOOT_BREAK_GLASS_ACTIVE: that one sends its reader to Admin › Access,
    // and this reader cannot get through the front door to reach it.
    expect(onlyMessage(err)).toBe(BOOT_NO_ADMINS_RESOLVE);
    expect(warn).not.toHaveBeenCalled();
    err.mockRestore();
    warn.mockRestore();
  });

  it('and says the same of stranded stored admins beside a break-glass nobody can use', async () => {
    const a = await warmed({ env: OUTSIDE, assigned: [OUTSIDE], roster: [MEMBER] });
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    a.onApplicationBootstrap();
    expect(onlyMessage(err)).toBe(BOOT_ADMINS_UNREACHABLE_NO_BREAK_GLASS);
    expect(warn).not.toHaveBeenCalled();
    // The message no longer gets to say the env var is unset, because this is
    // the branch a set-but-unusable one lands in.
    expect(BOOT_ADMINS_UNREACHABLE_NO_BREAK_GLASS).toMatch(/BOARD_ADMIN_EMAILS names nobody who can/);
    err.mockRestore();
    warn.mockRestore();
  });
});

/**
 * #591 follow-up. The runtime line existed for one of the postures that can
 * arrive at 11am and covered only that one, so the two that hurt most were
 * silent until the next rollout: the last stored role revoked (the break-glass
 * quietly taking over), and the admin cache going unread (everybody losing
 * admin at once).
 */
describe('AdminAuthority — every posture says itself, once (#591)', () => {
  const MEMBER = 'owner@example.com';
  const BOSS = 'boss@example.com';

  it('says it when the last stored admin role is revoked and the env takes over', async () => {
    let assigned: string[] | null = [MEMBER];
    const a = new AdminAuthority(config(BOSS), { emails: () => assigned }, rosterOf([MEMBER, BOSS]));
    await a.onModuleInit();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    a.listAdminEmails();
    expect(warn).not.toHaveBeenCalled();
    assigned = [];
    a.listAdminEmails();
    a.listAdminEmails();
    expect(onlyMessage(warn)).toBe(BOOT_BREAK_GLASS_ACTIVE);
    warn.mockRestore();
  });

  it('says it when the admin cache stops answering, rather than losing everyone quietly', async () => {
    let assigned: string[] | null = [MEMBER];
    const a = new AdminAuthority(config(BOSS), { emails: () => assigned }, rosterOf([MEMBER, BOSS]));
    await a.onModuleInit();
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    a.listAdminEmails();
    assigned = null; // the read that has never succeeded since — unknown, not nobody
    expect(a.listAdminEmails()).toEqual([]);
    a.listAdminEmails();
    expect(onlyMessage(err)).toBe(BOOT_ADMIN_ROSTER_UNREAD);
    err.mockRestore();
  });

  it('says the new one when the posture moves between two bad states', async () => {
    let assigned: string[] | null = [];
    const a = new AdminAuthority(config(BOSS), { emails: () => assigned }, rosterOf([MEMBER, BOSS]));
    await a.onModuleInit();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    a.listAdminEmails(); // empty, break-glass active
    assigned = ['ex@example.com']; // now stranded, break-glass still active
    a.listAdminEmails();
    a.listAdminEmails();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([m]) => m)).toEqual([
      BOOT_BREAK_GLASS_ACTIVE,
      BOOT_ADMINS_UNREACHABLE_BREAK_GLASS,
    ]);
    warn.mockRestore();
  });
});

/**
 * Boot says the posture, and the first request must not say it again. Covered
 * for every state rather than the one it was first written for: each records
 * through the same field, and a state that forgot to would double every line an
 * operator reads at startup.
 */
describe('AdminAuthority — boot and the first request, in that order (#591)', () => {
  const MEMBER = 'owner@example.com';
  const BOSS = 'boss@example.com';

  it('does not repeat the break-glass line on the first request', async () => {
    const a = await warmed({ env: BOSS, assigned: [], roster: [MEMBER, BOSS] });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    a.onApplicationBootstrap();
    a.listAdminEmails();
    a.listAdminEmails();
    expect(onlyMessage(warn)).toBe(BOOT_BREAK_GLASS_ACTIVE);
    warn.mockRestore();
  });

  it('does not repeat the unread line on the first request', async () => {
    const a = new AdminAuthority(config(BOSS), { emails: () => null }, rosterOf([MEMBER, BOSS]));
    await a.onModuleInit();
    const err = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    a.onApplicationBootstrap();
    a.listAdminEmails();
    expect(onlyMessage(err)).toBe(BOOT_ADMIN_ROSTER_UNREAD);
    err.mockRestore();
  });
});

it('regression: admin authority ignores the domain admission setting', async () => {
  const values: Record<string, string> = {
    BOARD_ALLOWED_DOMAINS: 'example.com',
    BOARD_ADMIN_EMAILS: 'admin@example.com',
  };
  const a = new AdminAuthority(
    { get: (key: string, fallback: unknown) => values[key] ?? fallback } as ConfigService,
    { emails: () => [] },
    rosterOf(['admin@example.com', 'new@example.com']),
  );
  await a.onModuleInit();
  expect(a.isAdmin('admin@example.com')).toBe(true);
  expect(a.isAdmin('new@example.com')).toBe(false);
});
