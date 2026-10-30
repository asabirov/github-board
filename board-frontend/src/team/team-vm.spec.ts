import { describe, expect, it } from 'vitest';
import type { Person } from '../api/people';
import { buildRosterFromPeople, sameName } from './team-vm';

describe('sameName', () => {
  it('matches exact names case-insensitively', () => {
    expect(sameName('Octocat', 'octocat')).toBe(true);
  });
  it('matches a first name against a full name', () => {
    expect(sameName('ivan', 'Ivan Roslov')).toBe(true);
    expect(sameName('Ivan', 'IVAN ROSLOV')).toBe(true);
  });
  it('does not match a mere prefix or different names', () => {
    expect(sameName('octocats-dev', 'Octocat')).toBe(false);
    expect(sameName('anton', 'octocat')).toBe(false);
  });
  it('does not merge two full names sharing only a first name', () => {
    expect(sameName('Ivan Roslov', 'Ivan Petrov')).toBe(false);
  });
});

function person(over: Partial<Person> & { id: string; displayName: string }): Person {
  return { emails: [over.id], clickupNames: [], githubLogin: null, ...over };
}

const OCTOCAT = person({
  id: 'octocat@example.com',
  displayName: 'Octocat',
  githubLogin: 'octocat',
});
const IVAN = person({
  id: 'ivan.roslov@example.com',
  displayName: 'Ivan Roslov',
  githubLogin: 'IvanRoslov',
});

describe('buildRosterFromPeople', () => {
  it('one card per person, name-sorted', () => {
    const roster = buildRosterFromPeople([IVAN, OCTOCAT]);
    expect(roster.map((p) => p.name)).toEqual(['Ivan Roslov', 'Octocat']);
  });

  it('carries github login (for the profile photo) and the group email', () => {
    const [octocat] = buildRosterFromPeople([OCTOCAT]);
    expect(octocat.githubLogin).toBe('octocat');
    expect(octocat.slug).toBe('octocat');
    expect(octocat.email).toBe('octocat@example.com');
    expect(octocat.key).toBe('octocat@example.com');
  });

  it('falls back to the person id as slug when no github login', () => {
    const newbie = person({ id: 'maria.lopez@example.com', displayName: 'Maria Lopez' });
    const [p] = buildRosterFromPeople([newbie]);
    expect(p.slug).toBe('maria.lopez@example.com');
    expect(p.githubLogin).toBeNull();
  });

  it('returns an empty roster for no people', () => {
    expect(buildRosterFromPeople([])).toEqual([]);
  });
});
