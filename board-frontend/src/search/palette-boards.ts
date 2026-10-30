import { copyResponseDeadline } from '../auth/response-deadline';
/**
 * What the ⌘K palette holds, and whether it owes a read (#714).
 *
 * ONE VALUE, and that is the whole of it: the boards and the org they were read
 * for are the same object, so "which org is this list?" and "which org have I
 * loaded?" cannot answer differently. They used to be two `useState`s in
 * `CommandPalette` — a `projects` list a clearing effect emptied on every org
 * change, and a `loadedFor` latch only the success handler ever wrote. On
 * `/acme` → `/globex` → `/acme` they drifted apart: the list was
 * emptied twice, the latch stayed on acme, and the guard `loadedFor ===
 * org` then refused to read again. The palette offered no boards at all, for the
 * life of the page, for an org it had already read successfully — and said
 * nothing, because an empty search index looks like a search index.
 *
 * The latch itself stays, and this is what it is for: a read that came BACK is
 * not repeated every time the palette opens on the same address. A read that did
 * not come back never calls `answered`, so the next open asks again — which is
 * what an org the board refuses (`/gtm`) depends on.
 *
 * Pure, and outside the component, because the frontend suite has no DOM:
 * effects do not fire under `environment: 'node'`, so a
 * decision left inside a `useEffect` cannot be pinned at all.
 * `palette-boards.spec.ts` walks the addresses a person walks.
 */
import type { ProjectSummary } from '../api/projects';

/** No boards, as ONE value rather than a fresh `[]` per reset — React bails out
 *  of a `setState` to the identical value, so clearing an already-empty index
 *  costs no render. `Dashboard` keeps the same constant for the same reason. */
export const NO_BOARDS: ProjectSummary[] = [];

/** The boards read for one address. `null` is "nothing read for this address" —
 *  which is every address until a read comes back, the union (`org: null`)
 *  included, and the two are told apart by the field rather than by the value. */
export type HeldBoards = { org: string | null; projects: ProjectSummary[] } | null;

export const NOTHING_HELD: HeldBoards = null;

/** What the palette still holds once the address names `org`: its own boards, or
 *  nothing. Another org's list is not emptied and kept — it goes WITH the org it
 *  was read for, in one write, which is why the two cannot drift. */
export function atAddress(held: HeldBoards, org: string | null): HeldBoards {
  return held !== null && held.org === org ? held : NOTHING_HELD;
}

/** The boards to offer, which is only ever a list `atAddress` let through. */
export function boardsOf(held: HeldBoards): ProjectSummary[] {
  return held === null ? NO_BOARDS : held.projects;
}

/** Whether an open palette owes `/api/projects` a read for this address. */
export function mustRead(held: HeldBoards, org: string | null, open: boolean): boolean {
  return open && !(held !== null && held.org === org);
}

/** What a read that CAME BACK leaves behind: its boards and its org together. */
export function answered(org: string | null, projects: ProjectSummary[]): HeldBoards {
  return copyResponseDeadline(projects, { org, projects });
}
