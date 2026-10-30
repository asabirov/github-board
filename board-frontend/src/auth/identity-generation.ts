/**
 * Which generation of the board is on screen — the key `App` mounts
 * `PeopleProvider` under (#824, reworked for #1229 step 1).
 *
 * #824's rule is the only thing counted here, and it has not changed: the tree
 * is wiped when one person's board is replaced by another's, so the new person
 * meets skeletons and their own reads rather than the last person's figures
 * still on screen. `claimFor` has already wiped the disk by then; this is what
 * makes the tree wiped too.
 *
 * WHAT CHANGED is that the shell is now drawn before `/api/auth/me` answers, so
 * the tree exists during a window in which the board knows nobody. Keying that
 * window on a constant and then on the person made the FIRST answer a change of
 * identity, and a change of identity remounts — taking `TopBar` with it, and
 * with `TopBar` the open search box this step puts up as the reader's way out of
 * a wrong route. Typed text vanished one round trip in with no visible cause.
 *
 * The first answer has nothing to wipe: `PeopleProvider` is disabled while the
 * probe is out, every shape under it is furniture, and no page has read
 * anything. So generation 0 spans the probe and whoever it turns out to be, and
 * only a SECOND, different identity turns it over. Counting rather than naming
 * also keeps the signed-in address out of a React key, which is the one place on
 * that screen it had no reason to be.
 */
import { useState } from 'react';

/** What the board is keyed on: the identity it has settled on, and how many
 *  times that has been replaced. */
export type IdentityGeneration = { known: string | null; generation: number };

/**
 * The next state after a render that sees `identity`.
 *
 * Returns the SAME object when nothing moved, which is what lets the hook below
 * decide whether to set state at all. Three cases, and the middle one is the
 * fix:
 *
 * - nobody, or the same person again → unchanged.
 * - the first identity of this mount (`known` is null) → recorded, generation
 *   held, so the probe answering does not remount anything.
 * - a different identity → recorded, generation turned over, so the tree under
 *   it is thrown away.
 *
 * An identity going back to null — a session that expires into the login gate —
 * leaves `known` where it was, so signing back in as the same person keeps the
 * generation and remounts nothing.
 */
export function nextIdentity(state: IdentityGeneration, identity: string | null): IdentityGeneration {
  if (identity === null || identity === state.known) return state;
  return { known: identity, generation: state.known === null ? state.generation : state.generation + 1 };
}

/** `nextIdentity` as the key `App` renders under. The set during render is the
 *  update React documents for state derived from a prop — it re-renders this
 *  component before touching the DOM — and the returned generation is read off
 *  the NEXT state, so the children never see the stale one. */
export function useIdentityGeneration(identity: string | null): number {
  const [state, setState] = useState<IdentityGeneration>(() => nextIdentity({ known: null, generation: 0 }, identity));
  const next = nextIdentity(state, identity);
  if (next !== state) setState(next);
  return next.generation;
}
