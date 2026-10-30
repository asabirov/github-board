import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureIdentityRepository } from './fixture-identity.repository';
import { GithubLoginResolver } from './github-login.resolver';
import type { IdentityRecord, IdentityRepository } from './identity.repository';
import { fakeIdentityStore, identityRecordFor, unreachableIdentityStore } from './identity.test-double';

/**
 * #520 second cycle. The board had two answers to "which Github handle belongs
 * to this address": the roster an admin edits, and the checked-in alias table
 * compiled into the build. They could disagree, and the page a person actually
 * looks at read the file. One path now, roster first — the same shape roles
 * already use (board-assigned wins, static default underneath).
 *
 * `octocat@example.com` → `octocat` is a real PEOPLE_ALIASES row, so the
 * fallback half of every assertion below is anchored on shipped data.
 */
describe('GithubLoginResolver', () => {
  it('the roster wins when the two sources disagree about the same address', async () => {
    const resolver = new GithubLoginResolver(
      fakeIdentityStore([
        identityRecordFor({
          emails: ['octocat@example.com'],
          displayName: 'Octocat',
          githubLogin: 'renamed-handle',
        }),
      ]),
    );
    expect(await resolver.forEmail('octocat@example.com')).toBe('renamed-handle');
  });

  it('an address only the checked-in table knows keeps resolving', async () => {
    const resolver = new GithubLoginResolver(fakeIdentityStore([]));
    expect(await resolver.forEmail('octocat@example.com')).toBe('octocat');
  });

  it('an address only the roster knows resolves — a new joiner needs no deploy', async () => {
    const resolver = new GithubLoginResolver(
      fakeIdentityStore([
        identityRecordFor({
          emails: ['maria.lopez@example.com'],
          displayName: 'Maria Lopez',
          githubLogin: 'mlopez',
        }),
      ]),
    );
    expect(await resolver.forEmail('maria.lopez@example.com')).toBe('mlopez');
  });

  // #540. The roster row IS the answer for the person it owns, cleared handle
  // and all. `octocat@example.com` → `octocat` is a real PEOPLE_ALIASES
  // row, so this only passes if a present row stops the file from answering.
  it('a handle cleared in the roster stays cleared, even for somebody the checked-in table knows', async () => {
    const resolver = new GithubLoginResolver(
      fakeIdentityStore([
        identityRecordFor({
          emails: ['octocat@example.com'],
          displayName: 'Octocat',
          githubLogin: null,
        }),
      ]),
    );
    expect(await resolver.forEmail('octocat@example.com')).toBeNull();
  });

  it('answers null when neither source claims the address', async () => {
    const resolver = new GithubLoginResolver(fakeIdentityStore([]));
    expect(await resolver.forEmail('stranger@example.com')).toBeNull();
    expect(await resolver.forEmail('  ')).toBeNull();
  });

  it('is case-insensitive on both sides', async () => {
    const roomy = new GithubLoginResolver(
      fakeIdentityStore([
        identityRecordFor({
          emails: ['maria.lopez@example.com'],
          displayName: 'Maria Lopez',
          githubLogin: 'mlopez',
        }),
      ]),
    );
    expect(await roomy.forEmail('Maria.Lopez@Example.com')).toBe('mlopez');
    const filed = new GithubLoginResolver(fakeIdentityStore([]));
    expect(await filed.forEmail('OCTOCAT@EXAMPLE.COM')).toBe('octocat');
  });

  it('an unreachable roster falls back to the checked-in table rather than losing the person', async () => {
    const resolver = new GithubLoginResolver(unreachableIdentityStore());
    expect(await resolver.forEmail('octocat@example.com')).toBe('octocat');
    expect(await resolver.forEmail('stranger@example.com')).toBeNull();
  });

  // Pins a boundary this change deliberately leaves alone. `buildPeople` links a
  // roster CARD by matching an email's local part against a display name; handle
  // resolution — both halves of it — matches addresses exactly. That gap is what
  // #520's first cycle was: Monalisa's card linked, his home page did not. Neither
  // source guesses, so an entry needs the address written down.
  it('neither source guesses an address from a display name', async () => {
    const resolver = new GithubLoginResolver(fakeIdentityStore([]));
    expect(await resolver.forEmail('octocat@example.net')).toBeNull();
  });

  it('with no database the answers are exactly the checked-in table’s', async () => {
    // IDENTITY_SOURCE != db ⇒ FixtureIdentityRepository, which reads the file.
    const resolver = new GithubLoginResolver(new FixtureIdentityRepository());
    expect(await resolver.forEmail('monalisa@example.com')).toBe('monalisa');
    expect(await resolver.forEmail('hubot@example.com')).toBe('hubot');
    expect(await resolver.forEmail('nobody@example.com')).toBeNull();
  });
});

/**
 * The reverse direction (#541). Same join, same two sources, one memo — the
 * chart's row seed and its legend, rather than a per-request table read.
 *
 * The memo makes the resolver stateful: two `teamRoster()` calls on ONE instance
 * share a read by design, so a test that wants a fresh read builds a fresh
 * resolver.
 */
describe('GithubLoginResolver.teamRoster (#541)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A store whose `list` is counted, so the memo can be asserted on. */
  function counted(records: IdentityRecord[]) {
    const base = fakeIdentityStore(records);
    const list = vi.fn(() => base.list());
    const store: IdentityRepository = { ...base, list };
    return { store, list };
  }

  it('merges the store’s records with the checked-in table', async () => {
    const { store } = counted([
      identityRecordFor({
        emails: ['maria.lopez@example.com'],
        displayName: 'Maria Lopez',
        githubLogin: 'mlopez',
      }),
    ]);
    const roster = await new GithubLoginResolver(store).teamRoster();
    expect(roster.logins).toContain('mlopez');
    expect(roster.logins).toContain('octocat');
    expect(roster.names.get('mlopez')).toBe('Maria Lopez');
    expect(roster.names.get('octocat')).toBe('Octocat');
  });

  it('a second call inside the TTL does not read the store again', async () => {
    const { store, list } = counted([]);
    const resolver = new GithubLoginResolver(store);
    await resolver.teamRoster();
    await resolver.teamRoster();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('the memo expires', async () => {
    vi.useFakeTimers();
    const { store, list } = counted([]);
    const resolver = new GithubLoginResolver(store);
    await resolver.teamRoster();
    vi.advanceTimersByTime(60_001);
    await resolver.teamRoster();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('invalidateRoster() drops the memo', async () => {
    const { store, list } = counted([]);
    const resolver = new GithubLoginResolver(store);
    await resolver.teamRoster();
    resolver.invalidateRoster();
    await resolver.teamRoster();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('an unreachable store yields the file-only roster rather than throwing', async () => {
    const resolver = new GithubLoginResolver(unreachableIdentityStore());
    const roster = await resolver.teamRoster();
    expect(roster.logins).toContain('octocat');
    expect(roster.names.get('hubot')).toBe('Hubot');
  });

  it('the failure is not cached — the next call gets the real roster', async () => {
    const base = fakeIdentityStore([
      identityRecordFor({
        emails: ['maria.lopez@example.com'],
        displayName: 'Maria Lopez',
        githubLogin: 'mlopez',
      }),
    ]);
    let first = true;
    const store: IdentityRepository = {
      ...base,
      list: async () => {
        if (first) {
          first = false;
          throw new Error('db down');
        }
        return base.list();
      },
    };
    const resolver = new GithubLoginResolver(store);
    expect((await resolver.teamRoster()).logins).not.toContain('mlopez');
    expect((await resolver.teamRoster()).logins).toContain('mlopez');
  });

  it('with no database the roster is exactly the checked-in table’s', async () => {
    const roster = await new GithubLoginResolver(new FixtureIdentityRepository()).teamRoster();
    expect([...roster.logins].sort()).toEqual(['hubot', 'monalisa', 'octocat']);
  });

  // An admin's PUT can land while a read that started BEFORE it is still in
  // flight. Those records predate the write, so caching them would re-pin the
  // answer the admin has just changed for the whole TTL — the invalidation
  // silently discarded. Clearing the cache field alone does not cover this,
  // because the in-flight read writes it again on the way out.
  it('an invalidation issued mid-read is not discarded by the read that outlives it', async () => {
    const records = [
      identityRecordFor({
        emails: ['maria.lopez@example.com'],
        displayName: 'Maria Lopez',
        githubLogin: 'mlopez',
      }),
    ];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const list = vi.fn(async () => {
      await gate;
      return records;
    });
    const base = fakeIdentityStore(records);
    const resolver = new GithubLoginResolver({ ...base, list });

    const inFlight = resolver.teamRoster();
    resolver.invalidateRoster(); // the admin's PUT lands here
    release();
    await inFlight;

    await resolver.teamRoster();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('rosterGeneration moves on every invalidation, so a consumer can tell', async () => {
    const resolver = new GithubLoginResolver(fakeIdentityStore([]));
    const before = resolver.rosterGeneration();
    resolver.invalidateRoster();
    expect(resolver.rosterGeneration()).not.toBe(before);
  });
});

/**
 * #535. A third tier under the two above: a handle DERIVED from commit
 * authorship, reached only when neither store claims the address. So the whole
 * risk of this feature is that it changes an answer somebody already had, and
 * the first two tests below are the ones that would catch it.
 */
describe('the derived tier (#535)', () => {
  /** A warmed DerivedLoginsService over a fixed map — no timer, no source. */
  const derivedOf = (pairs: Array<[string, string]>) => ({
    loginFor: (e: string) => new Map(pairs).get(e.trim().toLowerCase()) ?? null,
  });

  it('never overrides a roster row, including one whose handle was cleared', async () => {
    // #540: a row with a null handle is the roster ANSWERING "no handle".
    // Derivation re-asserting one would overwrite a hand-correction with a guess.
    const r = new GithubLoginResolver(
      fakeIdentityStore([identityRecordFor({ emails: ['a@x.io'], githubLogin: null })]),
      derivedOf([['a@x.io', 'guessed']]) as never,
    );
    expect(await r.forEmail('a@x.io')).toBeNull();
  });

  it('never overrides the checked-in table', async () => {
    const r = new GithubLoginResolver(
      fakeIdentityStore([]),
      derivedOf([['octocat@example.com', 'wrong']]) as never,
    );
    expect(await r.forEmail('octocat@example.com')).toBe('octocat');
  });

  it('answers for somebody neither store claims — the whole point of the issue', async () => {
    const r = new GithubLoginResolver(fakeIdentityStore([]), derivedOf([['new@x.io', 'newbie']]) as never);
    expect(await r.forEmail('new@x.io')).toBe('newbie');
  });

  it('typedLoginFor stops before the derived tier', async () => {
    // What board_whoami and derivedRole read. A guess must not reach either.
    const r = new GithubLoginResolver(fakeIdentityStore([]), derivedOf([['new@x.io', 'newbie']]) as never);
    expect(await r.forEmail('new@x.io')).toBe('newbie');
    expect(await r.typedLoginFor('new@x.io')).toBeNull();
    expect(await r.typedLoginFor('octocat@example.com')).toBe('octocat');
  });

  it('typedLoginFor still answers from the roster', async () => {
    const r = new GithubLoginResolver(
      fakeIdentityStore([identityRecordFor({ emails: ['row@x.io'], githubLogin: 'rowed' })]),
      derivedOf([]) as never,
    );
    expect(await r.typedLoginFor('row@x.io')).toBe('rowed');
  });

  it('still resolves the first two tiers when the store is unreachable', async () => {
    const r = new GithubLoginResolver(unreachableIdentityStore(), derivedOf([]) as never);
    expect(await r.forEmail('octocat@example.com')).toBe('octocat');
  });

  it('constructs without a derived service, so the existing call sites keep compiling', async () => {
    const r = new GithubLoginResolver(fakeIdentityStore([]));
    expect(await r.forEmail('stranger@x.io')).toBeNull();
  });
});
