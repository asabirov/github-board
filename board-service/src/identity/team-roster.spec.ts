import { describe, expect, it } from 'vitest';
import { PEOPLE_ALIASES, type PersonAliases } from '../people/people-aliases';
import { identityRecordFor } from './identity.test-double';
import { mergeRoster } from './team-roster';

const alias = (over: Partial<PersonAliases> & { emails: string[] }): PersonAliases => ({
  displayName: 'Filed Person',
  clickupNames: [],
  githubLogin: null,
  ...over,
});

/** A real shipped row, so the file half of every assertion is anchored. */
const OCTOCAT = PEOPLE_ALIASES.find((a) => a.githubLogin === 'octocat')!;
const HUBOT = PEOPLE_ALIASES.find((a) => a.githubLogin === 'hubot')!;

/**
 * The one merge over the two sources the board has for "which handle belongs to
 * whom" (#541). Pure on purpose: the two fields carry two different precedence
 * rules and the edges live here, not in the resolver's cache.
 */
describe('mergeRoster — logins, person-level precedence', () => {
  it('a login only the roster knows appears in logins, and names resolves it', () => {
    const r = mergeRoster(
      [
        identityRecordFor({
          emails: ['maria.lopez@example.com'],
          displayName: 'Maria Lopez',
          githubLogin: 'mlopez',
        }),
      ],
      [],
    );
    expect(r.logins).toContain('mlopez');
    expect(r.names.get('mlopez')).toBe('Maria Lopez');
  });

  // The records array is deliberately NON-empty and describes somebody else:
  // mergeRoster([], aliases) is file-only by construction and would pass with
  // the known-email intersection deleted outright.
  it('a login only the file knows appears in logins, while the roster knows somebody else', () => {
    const r = mergeRoster(
      [
        identityRecordFor({
          emails: ['maria.lopez@example.com'],
          displayName: 'Maria Lopez',
          githubLogin: 'mlopez',
        }),
      ],
      [OCTOCAT],
    );
    expect(r.logins).toContain('octocat');
    expect(r.logins).toContain('mlopez');
  });

  it('when both sources describe the same person, logins carries only the roster handle', () => {
    const r = mergeRoster(
      [
        identityRecordFor({
          emails: ['octocat@example.com'],
          displayName: 'Octocat',
          githubLogin: 'renamed-handle',
        }),
      ],
      [OCTOCAT],
    );
    expect(r.logins).toContain('renamed-handle');
    expect(r.logins).not.toContain('octocat');
  });

  // #540 reaching the reverse direction. A plain union would put the cleared
  // handle straight back — the same bug, in a new place.
  it('a person the roster knows with a cleared handle contributes nothing to logins', () => {
    const r = mergeRoster(
      [
        identityRecordFor({
          emails: ['octocat@example.com'],
          displayName: 'Octocat',
          githubLogin: null,
        }),
      ],
      [OCTOCAT],
    );
    expect(r.logins).not.toContain('octocat');
  });
});

describe('mergeRoster — names, plain union', () => {
  // Sits next to the logins case above on purpose: one field forgets the
  // handle, the other keeps the name. A reader who sees only one unifies them.
  it('the cleared-handle person’s file login still resolves to their name', () => {
    const r = mergeRoster(
      [
        identityRecordFor({
          emails: ['octocat@example.com'],
          displayName: 'Octocat',
          githubLogin: null,
        }),
      ],
      [OCTOCAT],
    );
    expect(r.logins).not.toContain('octocat');
    expect(r.names.get('octocat')).toBe('Octocat');
  });

  it('a renamed handle leaves both spellings resolving to the person’s name', () => {
    const r = mergeRoster(
      [
        identityRecordFor({
          emails: ['octocat@example.com'],
          displayName: 'Octocat',
          githubLogin: 'renamed-handle',
        }),
      ],
      [OCTOCAT],
    );
    expect(r.names.get('octocat')).toBe('Octocat');
    expect(r.names.get('renamed-handle')).toBe('Octocat');
  });

  it('the roster’s display name wins for a login both sources know', () => {
    const r = mergeRoster(
      [
        identityRecordFor({
          emails: ['octocat@example.com'],
          displayName: 'Octocat S',
          githubLogin: 'octocat',
        }),
      ],
      [OCTOCAT],
    );
    expect(r.names.get('octocat')).toBe('Octocat S');
  });
});

describe('mergeRoster — case handling', () => {
  it('names is case-insensitive on the login', () => {
    const r = mergeRoster([], [HUBOT]);
    expect(r.names.get('hubot')).toBe('Hubot');
    expect(r.names.get('hubot'.toLowerCase())).toBe('Hubot');
    expect(r.names.get('HUBOT'.toLowerCase())).toBe('Hubot');
  });

  it('a roster handle in a different case collapses to one logins entry, in the file’s spelling', () => {
    const r = mergeRoster(
      [
        identityRecordFor({
          emails: ['hubot@example.com'],
          displayName: 'Hubot',
          githubLogin: 'HUBOT',
        }),
      ],
      [HUBOT, OCTOCAT],
    );
    expect(r.logins.filter((l) => l.toLowerCase() === 'hubot')).toEqual(['hubot']);
  });
});

describe('mergeRoster — the fixture-mode identity', () => {
  // FixtureIdentityRepository.list() IS the file, so every alias's emails are in
  // the known set: logins step 2 adds nothing and step 3 rebuilds today's list.
  it('merging the file with itself reproduces the file', () => {
    const records = PEOPLE_ALIASES.map((a) =>
      identityRecordFor({ emails: a.emails, displayName: a.displayName, githubLogin: a.githubLogin }),
    );
    const r = mergeRoster(records, PEOPLE_ALIASES);
    expect([...r.logins].sort()).toEqual(
      PEOPLE_ALIASES.map((a) => a.githubLogin).filter((l): l is string => !!l).sort(),
    );
    expect(r.names.get('octocat')).toBe('Octocat');
  });

  it('an alias entry with no login contributes to neither field', () => {
    const r = mergeRoster([], [alias({ emails: ['nohandle@x.com'], displayName: 'No Handle' })]);
    expect(r.logins).toEqual([]);
    expect(r.names.size).toBe(0);
  });
});
