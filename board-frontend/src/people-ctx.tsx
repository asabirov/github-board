import { useReadState } from './cache/use-board-read';
/**
 * App-wide person identity (#94/#95): one /api/people fetch shared via context,
 * plus a resolver that maps any cross-system identity string (display name,
 * ClickUp username, GitHub login, email) to the canonical Person. Components
 * use it to render real GitHub profile photos and to deep-link to /team/:slug.
 *
 * Resolution mirrors team-vm's precedence — email, exact name/login variant,
 * then the tolerant first-name match only when it's unambiguous. A miss
 * returns null and callers degrade to initials / plain text, never a guess.
 */

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { type Person, fetchPeople } from './api/people';
import { sameName } from './team/team-vm';

const Ctx = createContext<Person[]>([]);

/**
 * `enabled` is false for exactly one state: the identity probe is still in
 * flight (#1229 step 1). The shell is drawn by then, but nothing under it names
 * a person yet, and the probe is the only request the board makes before it
 * knows whose browser this is — so the people table is read once the probe has
 * answered, as it always was, rather than a beat earlier for a table nothing on
 * screen is using. Issuing a page's own read beside the probe is step 1b of the
 * same plan and has a transport rule of its own.
 */
export function PeopleProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const [heldPeople, setPeople] = useReadState<Person[], { people: Person[] }>('/api/people', value => value.people);
  const people = enabled ? heldPeople ?? [] : [];
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    // Best-effort: identity enrichment only — on failure everything renders
    // exactly as before this feature (initials, unlinked names).
    fetchPeople().then(
      (list) => { if (alive) setPeople(list); },
      () => {},
    );
    return () => { alive = false; };
  }, [enabled]);
  return <Ctx.Provider value={people}>{children}</Ctx.Provider>;
}

export function usePeople(): Person[] {
  return useContext(Ctx);
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Resolve a name/login/email (+ optional explicit email) to a Person, or null. */
export function resolvePerson(
  people: Person[],
  name: string | null | undefined,
  email?: string | null,
): Person | null {
  // Email is the strongest key, but a duplicated alias email (bad alias
  // edit) means the table itself is ambiguous — resolve to nobody rather
  // than whoever enumerates first. Same rule team-vm applies to names.
  const byEmail = (e: string) => people.filter((p) => p.emails.some((x) => norm(x) === e));
  const ne = email ? norm(email) : null;
  if (ne) {
    const hits = byEmail(ne);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  if (!name || !name.trim()) return null;
  const nn = norm(name);
  if (nn.includes('@')) {
    const hits = byEmail(nn);
    return hits.length === 1 ? hits[0] : null;
  }
  const exact = people.filter(
    (p) =>
      norm(p.displayName) === nn ||
      p.clickupNames.some((x) => norm(x) === nn) ||
      (p.githubLogin != null && norm(p.githubLogin) === nn),
  );
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const fuzzy = people.filter((p) => sameName(p.displayName, name));
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

/** URL slug for /team/:person — GitHub login when known, else the stable id. */
export function personSlug(p: Person): string {
  return p.githubLogin ?? p.id;
}
