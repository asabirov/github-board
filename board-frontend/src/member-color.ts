/**
 * A member's colour (#477) — one hue per person, decided here, read everywhere.
 *
 * Before this, colour was something a chart chose: the Projects ring picked its
 * own hues and then printed a legend to explain what it had picked (#454). The
 * colour now belongs to the person, so the crew cards on Unit teach it and every
 * later surface just spends it — the ring, the assignee avatars on issue rows,
 * anything per-member that follows. That is also why the legends came off: the
 * cards above already say who is teal and who is rose.
 *
 * The colour is pinned to the person: not to where they sit in the roster (see
 * `memberKey`), not to the size of the unit (see `HUES`), and not to who
 * arrived first (see `memberSlots`).
 *
 * Identity never rests on the hue alone: the crew card carries the face and the
 * name, and the ring's hover (`ContributionTip`) names every run it paints —
 * which is what carries the load at nine, where the rungs sit close enough that
 * two of them want a second look.
 */
import type { Person } from './api/people';
import { resolvePerson } from './people-ctx';

/** How many rungs the ladder has (`--seg-1` … `--seg-9`, app.css). Nine is what
 *  the free hue arc can supply at a separation the eye still resolves — see the
 *  palette note in app.css for where it stops being comfortable.
 *
 *  Fixed, rather than sized to the unit (#507). It used to depend on one more
 *  thing: how many people were in the unit. Six hues came from three ramps, so
 *  slots 4-6 were weaker steps of the same three families as 1-3, and a unit of
 *  three hashing freely across all six could wear two teals. The scheme bought
 *  its way out by spanning exactly as many slots as the unit had people — which
 *  put the modulus, and so everybody's colour, on the roster's headcount. A
 *  fourth colleague arrived and the person you had learned as teal came back
 *  violet, and a colour you have to relearn is doing less for you than no colour
 *  at all.
 *
 *  The ladder is fixed at nine rungs now (#509), so the rung a person points at
 *  is theirs whatever the unit does. Someone joins, and they take a free rung;
 *  someone leaves, and their rung simply empties. */
export const HUES = 9;

/** A person's identity in the roster, independent of which alias a board's
 *  issues happen to use. Falls back to the stable id for a member with no
 *  linked Github login.
 *
 *  The rung a person gets is a hash of this key, so it is pinned to them rather
 *  than to a position. The scheme this replaces read it off a member's INDEX in
 *  the sorted roster, so a new colleague whose login sorted first pushed every
 *  existing member one hue along — a colour that changes because someone else's
 *  name begins with an A is not the person's colour. Nothing about where a
 *  member sits in the list reaches `memberSlots` now: it takes the roster as a
 *  SET, and the same unit yields the same map on every page, session and reload,
 *  whatever order /api/people returned. */
export const memberKey = (p: Person): string => (p.githubLogin ?? p.id).toLowerCase();

/** FNV-1a over the identity key. Any stable hash would do; what matters is that
 *  it reads the person and nothing else. */
function hash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The roster's identity keys → their rungs on the ladder.
 *
 * Everyone claims the rung their identity points at. When two people point at
 * one rung the lower key keeps it — a deterministic tie-break, not an arrival
 * order — and the other walks forward to the first free rung. A unit larger
 * than the whole ladder shares hues rather than inventing colours the theme has
 * not validated.
 *
 * That tie-break is the honest limit of the scheme. A map of the roster alone
 * cannot know which of two people was here first, so the keys settle it: anyone
 * standing on the rung they point at holds it through any arrival but one
 * pointing at the same rung, and only someone already walked forward off their
 * own rung can be moved by a departure. Never a bystander, and never the whole
 * unit at once the way headcount did.
 */
export function memberSlots(people: Person[]): Map<string, number> {
  const keys = [...new Set(people.map(memberKey))].sort();
  const pref = (key: string) => hash(key) % HUES;
  const slots = new Map<string, number>();
  const taken = new Set<number>();
  // Pass 1: uncontested (or lowest-key) claims.
  const winner = new Map<number, string>();
  for (const key of keys) if (!winner.has(pref(key))) winner.set(pref(key), key);
  for (const [slot, key] of winner) {
    slots.set(key, slot);
    taken.add(slot);
  }
  // Pass 2: everyone displaced probes forward from their own preference.
  for (const key of keys) {
    if (slots.has(key)) continue;
    let slot = pref(key);
    for (let step = 0; step < HUES && taken.has(slot); step++) slot = (slot + 1) % HUES;
    if (taken.has(slot)) slot = pref(key); // unit outgrew the ladder — share a hue
    else taken.add(slot);
    slots.set(key, slot);
  }
  return slots;
}

/** The colour token for a name, login or email, as a CSS colour value. Anyone
 *  the roster cannot place — a drive-by contributor, or everyone at all when
 *  /api/people failed — gets the neutral, which fills the same slot without
 *  pretending to be an identity. */
export function memberColors(people: Person[]): (who: string | null | undefined) => string {
  const slots = memberSlots(people);
  return (who) => {
    if (!who) return 'var(--seg-none)';
    const person = resolvePerson(people, who);
    const slot = person ? slots.get(memberKey(person)) : undefined;
    return slot === undefined ? 'var(--seg-none)' : `var(--seg-${slot + 1})`;
  };
}

/** One-shot form of `memberColors` for a surface that paints a single person. */
export function memberColor(people: Person[], who: string | null | undefined): string {
  return memberColors(people)(who);
}

/** A member's colour mixed toward the block surface — for fills and washes,
 *  where the hue at full strength would shout. `pct` is how much hue survives. */
export function memberWash(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, var(--surface))`;
}
