import { describe, expect, it, vi } from 'vitest';
import {
  knownRepos,
  OWNER_LOGIN,
  probeSet,
  RENAME_AGREEMENT,
  RENAME_PROBES,
  whereOwnerWent,
  type AskRepo,
  type KnownRepo,
} from './owner-rename';

/**
 * The four cases the board has to tell apart when somebody opens a path under
 * an owner it does not serve (#1167), and the two it must never confuse.
 *
 * Every `ask` here answers the way the live API answered on 2026-09-17 — see
 * the measurements quoted in `owner-rename.ts`. A repository that moved answers
 * with its own unchanged id under the new owner; everything else answers null,
 * because a 404 on `/repos/<old>/<name>` is all Github gives for a login that
 * never existed and for one whose organisation simply refuses this person.
 */

/** The board's own repositories under the organisation as it is named today. */
const SERVED: KnownRepo[] = [
  { id: 101, owner: 'acme', name: 'board' },
  { id: 102, owner: 'acme', name: 'acme' },
  { id: 103, owner: 'acme', name: 'team-guidebook' },
];

/** Github after the rename: every one of those repositories still answers at
 *  its old address, with the id it has always had. */
const renamed = (from: string): AskRepo => async (owner, name) => {
  if (owner.toLowerCase() !== from) return null;
  const repo = SERVED.find((r) => r.name === name);
  return repo ? { id: repo.id, owner: repo.owner } : null;
};

/** Github for a login that was never anybody's, and for a live organisation
 *  this person is not in: a 404 on every repository path either way. */
const nothing: AskRepo = async () => null;

describe('whereOwnerWent', () => {
  it('names the new owner when the repositories under the old login are the ones we already reach', async () => {
    expect(await whereOwnerWent('old-org', SERVED, renamed('old-org'))).toBe('acme');
  });

  it('spells the new owner the way Github spells it, not the way the address bar did', async () => {
    // The person's bookmark shouts; the link the board offers must not.
    expect(await whereOwnerWent('OLD-ORG', SERVED, renamed('old-org'))).toBe('acme');
  });

  it('says nothing about a login that never existed', async () => {
    expect(await whereOwnerWent('zzq-never-existed-org', SERVED, nothing)).toBeNull();
  });

  it('says nothing about an organisation that is alive and does not admit this person', async () => {
    // The case acceptance criterion 2 protects. Github answers this person 404
    // on `private-org/<anything>` exactly as it answers for a login nobody
    // registered, so the board may claim no more here than it does above.
    expect(await whereOwnerWent('private-org', SERVED, nothing)).toBeNull();
  });

  it('says nothing about an owner this person already reaches', async () => {
    expect(await whereOwnerWent('acme', SERVED, renamed('acme'))).toBeNull();
  });

  it('refuses a login that is not a Github login at all', async () => {
    const ask = vi.fn<AskRepo>(async () => null);
    expect(await whereOwnerWent('../../etc', SERVED, ask)).toBeNull();
    expect(ask, 'a login off an address bar must not reach Github').not.toHaveBeenCalled();
  });

  it('will not call one repository a rename, because that is what a transfer looks like', async () => {
    // One repository leaving `other-org` for `acme` is a transfer between two
    // unrelated organisations, and `other-org` may be alive and somebody's. The
    // board saying "other-org is now acme" would send this person into an
    // organisation that is not theirs, which is this issue's own defect with
    // the sign flipped.
    const onlyOne: AskRepo = async (owner, name) =>
      owner === 'other-org' && name === 'board' ? { id: 101, owner: 'acme' } : null;
    expect(await whereOwnerWent('other-org', SERVED, onlyOne)).toBeNull();
  });

  it('believes two repositories making the same move', async () => {
    const two: AskRepo = async (owner, name) => {
      if (owner !== 'other-org') return null;
      const repo = SERVED.find((r) => r.name === name);
      return repo && repo.id !== 103 ? { id: repo.id, owner: repo.owner } : null;
    };
    expect(RENAME_AGREEMENT).toBe(2);
    expect(await whereOwnerWent('other-org', SERVED, two)).toBe('acme');
  });

  it('refuses a same-named repository that is not ours, however many answer', async () => {
    // A stranger's organisation really holding `old-org/board`
    // answers 200 with a repository of its own. Only the id separates that from
    // a rename, and without the id check every one of these would read as one.
    const impostor: AskRepo = async (owner) => (owner === 'old-org' ? { id: 900_001, owner: 'old-org' } : null);
    expect(await whereOwnerWent('old-org', SERVED, impostor)).toBeNull();
  });

  it('says nothing when two owners each carry repositories out of the old login', async () => {
    const split: AskRepo = async (owner, name) => {
      if (owner !== 'old-org') return null;
      const repo = SERVED.find((r) => r.name === name);
      return repo ? { id: repo.id, owner: repo.owner } : null;
    };
    const twoWays: KnownRepo[] = [
      { id: 1, owner: 'acme', name: 'a' },
      { id: 2, owner: 'acme', name: 'b' },
      { id: 3, owner: 'globex', name: 'c' },
      { id: 4, owner: 'globex', name: 'd' },
    ];
    const both: AskRepo = async (owner, name) => {
      if (owner !== 'old-org') return null;
      const repo = twoWays.find((r) => r.name === name);
      return repo ? { id: repo.id, owner: repo.owner } : null;
    };
    expect(await whereOwnerWent('old-org', SERVED, split)).toBe('acme');
    expect(await whereOwnerWent('old-org', twoWays, both)).toBeNull();
  });

  it('loses a witness to a repository renamed after the organisation was, and says so', async () => {
    // Github keys a redirect on the literal historical `owner/name`, and this
    // module can only ask about the name a repository has TODAY. So a
    // repository renamed since the organisation was has no record at the
    // address the question constructs: measured live on 2026-09-17,
    // `/repos/zeit/now` answers 301 and `/repos/zeit/vercel` answers 404.
    //
    // THIS REPOSITORY IS ONE OF THEM — the board repo was renamed
    // on 2026-09-17, a day after the organisation moved.
    // What that costs is margin, and the two assertions below are the whole of
    // it: with a repository to spare the rename is still proved, and with none
    // to spare a real rename reads as the ordinary refusal.
    const rebranded = (name: string): AskRepo => async (owner, asked) => {
      if (owner.toLowerCase() !== 'old-org' || asked === name) return null;
      const repo = SERVED.find((r) => r.name === asked);
      return repo ? { id: repo.id, owner: repo.owner } : null;
    };
    expect(await whereOwnerWent('old-org', SERVED, rebranded('board'))).toBe('acme');
    const twoLeft = SERVED.slice(0, RENAME_AGREEMENT);
    expect(await whereOwnerWent('old-org', twoLeft, rebranded('board'))).toBeNull();
  });

  it('asks about nothing at all when this person reaches no repositories', async () => {
    const ask = vi.fn<AskRepo>(async () => null);
    expect(await whereOwnerWent('old-org', [], ask)).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('probeSet', () => {
  it('asks the oldest repositories first, because a newer one never lived at the old address', async () => {
    const repos: KnownRepo[] = [900, 5, 700, 3, 800, 1, 600].map((id) => ({ id, owner: 'acme', name: `r${id}` }));
    expect(probeSet(repos).map((r) => r.id)).toEqual([1, 3, 5, 600, 700]);
  });

  it('spends a bounded number of round trips on a refusal screen', () => {
    const repos: KnownRepo[] = Array.from({ length: 70 }, (_, i) => ({ id: i + 1, owner: 'acme', name: `r${i}` }));
    expect(RENAME_PROBES).toBe(5);
    expect(probeSet(repos)).toHaveLength(RENAME_PROBES);
  });

  it('leaves the caller’s list alone', () => {
    const repos: KnownRepo[] = [{ id: 9, owner: 'o', name: 'b' }, { id: 1, owner: 'o', name: 'a' }];
    probeSet(repos);
    expect(repos.map((r) => r.id)).toEqual([9, 1]);
  });
});

describe('knownRepos', () => {
  it('reads a principal’s repositories into the question’s own shape', () => {
    expect(
      knownRepos([
        { id: 7, full_name: 'acme/board', name: 'board', owner: { login: 'acme' } },
      ]),
    ).toEqual([{ id: 7, owner: 'acme', name: 'board' }]);
  });
});

describe('OWNER_LOGIN', () => {
  it('accepts what Github accepts and refuses what an address bar can carry', () => {
    for (const good of ['acme', 'old-org', 'a', 'a'.repeat(39), 'A1-b2']) {
      expect(OWNER_LOGIN.test(good), good).toBe(true);
    }
    for (const bad of ['', '-leading', 'a'.repeat(40), 'has space', 'has/slash', 'has.dot', '..']) {
      expect(OWNER_LOGIN.test(bad), bad).toBe(false);
    }
  });
});
