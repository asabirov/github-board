import { describe, expect, it } from 'vitest';
import type { Person } from './api/people';
import { personSlug, resolvePerson } from './people-ctx';

// The resolver's contract (#94/#95): map a cross-system identity string to
// exactly one Person or to null — NEVER a guess. Every ambiguous case below
// must come back null; a false-positive merge would deep-link one person's
// name to another person's page and photo.

function person(over: Partial<Person>): Person {
  return {
    id: 'x@example.com', displayName: 'X', emails: [], clickupNames: [],
    githubLogin: null, ...over,
  };
}

const octocat = person({
  id: 'octocat@example.com',
  displayName: 'Octocat',
  emails: ['octocat@example.com', 'octocat@personal.example'],
  clickupNames: ['Octocat'],
  githubLogin: 'octocat',
});
const anton1 = person({
  id: 'anton.i@example.com', displayName: 'Anton Ivanov',
  emails: ['anton.i@example.com'], githubLogin: 'antoni',
});
const anton2 = person({
  id: 'anton.p@example.com', displayName: 'Anton Petrov',
  emails: ['anton.p@example.com'], githubLogin: null,
});

describe('resolvePerson', () => {
  const people = [octocat, anton1, anton2];

  it('resolves by explicit email first, regardless of the name', () => {
    expect(resolvePerson(people, 'Someone Else', 'OCTOCAT@example.com')).toBe(octocat);
  });

  it('falls back to name matching when the explicit email is unknown', () => {
    expect(resolvePerson(people, 'Octocat', 'ghost@nowhere.io')).toBe(octocat);
  });

  it('treats an @-name as an email lookup only', () => {
    expect(resolvePerson(people, 'anton.i@example.com')).toBe(anton1);
    expect(resolvePerson(people, 'ghost@nowhere.io')).toBeNull();
  });

  it('matches exact displayName, clickup name and github login (case-insensitive)', () => {
    expect(resolvePerson(people, 'octocat')).toBe(octocat);
    expect(resolvePerson(people, 'Octocat')).toBe(octocat); // clickup variant
    expect(resolvePerson(people, 'OCTOCAT')).toBe(octocat); // github login
  });

  it('returns null when two people share an alias email (bad alias edit)', () => {
    const a = person({ id: 'a@x.io', displayName: 'Alpha One', emails: ['dup@x.io'] });
    const b = person({ id: 'b@x.io', displayName: 'Beta Two', emails: ['dup@x.io'] });
    expect(resolvePerson([a, b], 'Ghost Name', 'dup@x.io')).toBeNull();
    expect(resolvePerson([a, b], 'dup@x.io')).toBeNull();
  });

  it('returns null when an exact variant is claimed by two people', () => {
    const a = person({ id: 'a@x.io', displayName: 'A', clickupNames: ['sam'] });
    const b = person({ id: 'b@x.io', displayName: 'B', githubLogin: 'sam' });
    expect(resolvePerson([a, b], 'sam')).toBeNull();
  });

  it('first-name fuzzy match only when unambiguous', () => {
    expect(resolvePerson([octocat, anton1], 'anton')).toBe(anton1);
    expect(resolvePerson(people, 'anton')).toBeNull(); // two Antons → never guess
  });

  it('never chains a multi-word name into a different multi-word person', () => {
    expect(resolvePerson(people, 'Anton Weiss')).toBeNull();
  });

  it('returns null for empty/blank/missing names', () => {
    expect(resolvePerson(people, null)).toBeNull();
    expect(resolvePerson(people, undefined)).toBeNull();
    expect(resolvePerson(people, '   ')).toBeNull();
    expect(resolvePerson([], 'Octocat')).toBeNull();
  });
});

describe('personSlug', () => {
  it('prefers the github login, falls back to the stable id', () => {
    expect(personSlug(octocat)).toBe('octocat');
    expect(personSlug(anton2)).toBe('anton.p@example.com');
  });
});
