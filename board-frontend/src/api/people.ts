import { API, networkFetch as apiFetch } from './core';

/** Mirrors board-service/src/people/people-aliases.ts Person (#73). */
export interface Person {
  /** Stable id — the person's group email (lowercased). */
  id: string;
  displayName: string;
  emails: string[];
  clickupNames: string[];
  githubLogin: string | null;
}

/**
 * The team roster: Google group members × the server's alias table.
 * Unlike the other fetches, the Team page's loading gate BLOCKS on this call —
 * a hung backend must reject (→ legacy name-merge fallback + notice), not pin
 * the whole page on "Loading…", hence the explicit timeout.
 */
export async function fetchPeople(): Promise<Person[]> {
  const res = await apiFetch(`${API}/api/people`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(`people ${res.status}`);
  return (await res.json()).people;
}
