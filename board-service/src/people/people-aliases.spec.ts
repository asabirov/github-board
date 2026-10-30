import { describe, expect, it } from 'vitest';
import { PEOPLE_ALIASES, buildPeople, githubLoginFor, type PersonAliases } from './people-aliases';

const ALIASES: PersonAliases[] = [
  {
    displayName: 'Octocat',
    emails: ['octocat@example.com', 'octocat@example.org'],
    clickupNames: ['Octocat', 'Octocat'],
    githubLogin: 'octocat',
  },
  {
    displayName: 'Monalisa',
    emails: [],
    clickupNames: ['Monalisa'],
    githubLogin: 'monalisa',
  },
];

describe('buildPeople', () => {
  it('links a member email listed in the alias entry', () => {
    const [p] = buildPeople(['octocat@example.com'], ALIASES);
    expect(p).toMatchObject({
      id: 'octocat@example.com',
      displayName: 'Octocat',
      githubLogin: 'octocat',
    });
    expect(p.emails).toContain('octocat@example.org');
  });

  it('links via the email local part when the alias has no emails', () => {
    const [p] = buildPeople(['monalisa@example.com'], ALIASES);
    expect(p.displayName).toBe('Monalisa');
    expect(p.githubLogin).toBe('monalisa');
  });

  it('keeps an unmapped member on the roster with a derived display name', () => {
    const [p] = buildPeople(['maria.lopez@example.com'], ALIASES);
    expect(p).toMatchObject({
      displayName: 'Maria Lopez',
      clickupNames: [],
      githubLogin: null,
    });
  });

  it('collapses two group addresses of the same person into one', () => {
    const people = buildPeople(['octocat@example.com', 'octocat@example.org'], ALIASES);
    expect(people).toHaveLength(1);
  });

  it('is case-insensitive on member emails and skips blanks', () => {
    const people = buildPeople(['OCTOCAT@EXAMPLE.COM', '', '  '], ALIASES);
    expect(people).toHaveLength(1);
    expect(people[0].id).toBe('octocat@example.com');
  });

  it('#76 regression: a literal duplicate member email yields ONE person, not two cards', () => {
    const unmapped = buildPeople(['maria.lopez@x.com', 'Maria.Lopez@x.com '], ALIASES);
    expect(unmapped).toHaveLength(1);
    const mapped = buildPeople(['octocat@example.com', 'octocat@example.com'], ALIASES);
    expect(mapped).toHaveLength(1);
    expect(mapped[0].emails.filter((e) => e === 'octocat@example.com')).toHaveLength(1);
  });

  it('a second group address matched via the name (not listed in alias.emails) folds into the person', () => {
    const people = buildPeople(
      ['monalisa@example.com', 'monalisa@gmail.com'],
      ALIASES,
    );
    expect(people).toHaveLength(1);
    // The address must survive: the frontend resolves ClickUp DRIs by email first.
    expect(people[0].emails).toContain('monalisa@gmail.com');
  });

  it('nameMatchDomains fences the local-part fallback: outside domains never capture an identity', () => {
    const opts = { nameMatchDomains: ['example.com'] };
    // Impostor gmail whose local part title-cases to a teammate's name: own card, no aliases.
    const [impostor] = buildPeople(['monalisa@gmail.com'], ALIASES, opts);
    expect(impostor.githubLogin).toBeNull();
    expect(impostor.clickupNames).toEqual([]);
    // The workspace address still links by name…
    const [monalisa] = buildPeople(['monalisa@example.com'], ALIASES, opts);
    expect(monalisa.githubLogin).toBe('monalisa');
    // …and an explicitly listed alias email links regardless of domain.
    const [octocat] = buildPeople(['octocat@example.org'], ALIASES, opts);
    expect(octocat.displayName).toBe('Octocat');
  });

  it('a departed person simply is not in the input — nothing filters them, they never appear', () => {
    const people = buildPeople(['octocat@example.com'], ALIASES);
    expect(people.some((p) => p.displayName.startsWith('Alexey'))).toBe(false);
  });

  it('seed aliases: display names are unique and logins non-conflicting', () => {
    const names = PEOPLE_ALIASES.map((a) => a.displayName.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const logins = PEOPLE_ALIASES.map((a) => a.githubLogin).filter(Boolean);
    expect(new Set(logins).size).toBe(logins.length);
  });

  it('seed aliases: no name variant (display or ClickUp) is claimed by two entries', () => {
    // The frontend's names set merges displayName + clickupNames per person;
    // a variant shared across entries would make resolution guess (#76 class).
    const perEntry = PEOPLE_ALIASES.map(
      (a) => new Set([a.displayName.toLowerCase(), ...a.clickupNames.map((n) => n.toLowerCase())]),
    );
    const all = perEntry.flatMap((s) => [...s]);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('githubLoginFor over the seed table', () => {
  // #520 — "Your work" asks this function, with the signed-in Google address,
  // who the caller is on GitHub. Every teammate the board can attribute work to
  // must answer here, or their home page reads zeros over "No Github identity
  // linked to your account yet". The local-part fallback that links the roster
  // card (buildPeople) does NOT reach this path, so an entry with a login and no
  // emails is silently invisible to the one surface that matters most.
  it('resolves every seeded work address to that person\'s login', () => {
    for (const a of PEOPLE_ALIASES) {
      if (a.githubLogin === null) continue;
      expect(a.emails.length, `${a.displayName} has a login but no email to reach it by`).toBeGreaterThan(0);
      for (const email of a.emails) expect(githubLoginFor(email)).toBe(a.githubLogin);
    }
  });

  it('resolves Monalisa\'s workspace address (#520)', () => {
    expect(githubLoginFor('monalisa@example.com')).toBe('monalisa');
    expect(githubLoginFor('MONALISA@EXAMPLE.COM')).toBe('monalisa');
  });

  it('still answers null for an address nobody claims', () => {
    expect(githubLoginFor('stranger@example.com')).toBeNull();
  });
});

