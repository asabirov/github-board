/**
 * Pure view-model for the Unit roster (#64, slimmed in #197).
 *
 * The roster is one card per team-table member (the Google group). The OKR/AOR
 * decorations it used to carry were retired with the roadmap; what remains is
 * identity — name, email, GitHub login for the profile photo + deep link.
 *
 * `sameName` also backs people-ctx's email→person resolution, so it stays here.
 */

import type { Person } from '../api/people';

export interface RosterPerson {
  /** Stable key for selection — the person-table id. */
  key: string;
  /** URL segment for /team/:person (#94) — github login when known, else id. */
  slug: string;
  /** GitHub login when known — real profile photo avatars (#95). */
  githubLogin: string | null;
  /** Display name. */
  name: string;
  email: string | null;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function firstWord(s: string): string {
  return norm(s).split(/\s+/)[0] ?? '';
}

/**
 * Do two name variants refer to the same person?
 * Exact normalized match, or one name is exactly the first word of the other
 * ("octocat" ~ "Octocat"). GitHub logins that share only a prefix
 * ("octocats-dev") intentionally do NOT match.
 */
export function sameName(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  return firstWord(na) === nb || firstWord(nb) === na;
}

/** One card per person-table member, sorted by name. */
export function buildRosterFromPeople(people: Person[]): RosterPerson[] {
  return people
    .map((p) => ({
      key: p.id,
      slug: p.githubLogin ?? p.id,
      githubLogin: p.githubLogin,
      name: p.displayName,
      email: p.id,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
