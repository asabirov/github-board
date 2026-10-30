import { describe, expect, it } from 'vitest';
import type { Person } from './api/people';
import { HUES, memberColor, memberColors, memberKey, memberSlots, memberWash } from './member-color';

function person(login: string | null, displayName: string, id = `${login}@example.com`): Person {
  return { id, displayName, emails: [id], clickupNames: [], githubLogin: login };
}

const CREW = [
  person('octocat', 'Octocat'),
  person('hubot', 'Hubot'),
  person('antonk', 'Anton K'),
];

/** Plausible next hires — the crew's growth cases, split by whether the rung
 *  they point at is one the crew already wears. */
const JOINERS = ['dana', 'erik', 'farah', 'gita', 'hugo', 'iris', 'marta', 'pavel'].map((l) =>
  person(l, l),
);

/** The rung a person's own identity points at, read through the public surface:
 *  alone in a unit, nobody can contend for it, so the slot they get IS it. */
const home = (p: Person) => memberSlots([p]).get(memberKey(p))!;

/** A deterministic pseudo-roster, so the sweeps below cover far more shapes than
 *  hand-written units without going random on every run. */
function unit(seed: number, size: number): Person[] {
  return Array.from({ length: size }, (_, i) => person(`u${seed}x${i}`, `U${seed}-${i}`));
}

describe('memberSlots (#477) — the colour is pinned to the person', () => {
  it('gives every member of a unit their own slot', () => {
    const slots = memberSlots(CREW);
    expect(new Set(slots.values()).size).toBe(CREW.length);
  });

  it('does not depend on the order the roster arrives in', () => {
    const forward = memberSlots(CREW);
    const backward = memberSlots([...CREW].reverse());
    for (const p of CREW) expect(backward.get(p.githubLogin!)).toBe(forward.get(p.githubLogin!));
  });

  it('does not shift a member because a colleague sorts ahead of them', () => {
    // The exact bug this replaces: the slot came from a member's INDEX in the
    // sorted roster, so a newcomer sorting first pushed EVERY existing member one
    // hue along. Nothing about a name's place in the list reaches the hue now —
    // renaming a colleague to sort first leaves everyone else where they were.
    const late = [person('zoe', 'Zoe Last'), ...CREW.slice(1)];
    const early = [person('aaron', 'Aaron First'), ...CREW.slice(1)];
    for (const p of CREW.slice(1)) {
      expect(memberSlots(early).get(p.githubLogin!)).toBe(memberSlots(late).get(p.githubLogin!));
    }
  });

  it('repeats itself — the same unit paints the same colours on every call', () => {
    const a = memberSlots(CREW);
    const b = memberSlots(CREW);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it('spreads a small unit over the whole ladder, not its first rungs', () => {
    // Replaces "keeps a small unit inside the three strongest hues" (#509/#507).
    // The old scheme spanned exactly as many slots as the unit had people, so
    // three people always wore rungs 1-3 — and the modulus, and therefore
    // everyone's colour, moved the moment a fourth arrived. The ladder is fixed
    // now: a unit of three reads anywhere across the nine rungs.
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const slots = memberSlots(unit(i, 3));
      expect(new Set(slots.values()).size).toBe(3);
      for (const slot of slots.values()) {
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(slot).toBeLessThan(HUES);
        seen.add(slot);
      }
    }
    expect(seen.size).toBe(HUES);
  });

  it('grows to nine distinct hues — a seventh member repeats nobody', () => {
    // Replaces "grows into the weaker hues one at a time" (#509). That test
    // asserted the growth clamp — slots stayed under max(3, n) — which capped
    // the scheme at six and made the seventh member share a colleague's hue.
    const pool = [
      ...CREW,
      person('dana', 'Dana'),
      person('erik', 'Erik'),
      person('farah', 'Farah'),
      person('gita', 'Gita'),
      person('hugo', 'Hugo'),
      person('iris', 'Iris'),
    ];
    expect(pool).toHaveLength(HUES);
    for (let n = 1; n <= HUES; n++) {
      const slots = memberSlots(pool.slice(0, n));
      expect(new Set(slots.values()).size).toBe(n);
      expect(Math.max(...slots.values())).toBeLessThan(HUES);
    }
  });

  it('leaves the crew where they were when a colleague joins on a free rung', () => {
    // #507: the scheme spanned as many slots as the unit had people, so a fourth
    // arrival re-based the modulus and the person you had learned as teal came
    // back violet — every colour in the unit, for one arrival. The ladder is
    // fixed now, so a newcomer landing anywhere the crew is not asks nothing of
    // anybody.
    const before = memberSlots(CREW);
    const held = new Set(before.values());
    const joiners = JOINERS.filter((p) => !held.has(home(p)));
    expect(joiners.length).toBeGreaterThan(0);
    for (const joiner of joiners) {
      const after = memberSlots([...CREW, joiner]);
      for (const p of CREW) expect(after.get(memberKey(p))).toBe(before.get(memberKey(p)));
    }
  });

  it('moves at most the one person a joining colleague points at', () => {
    // The honest limit. Two identities can point at one rung, and a map of the
    // roster alone cannot know which of them was here first, so a contested
    // arrival is settled by the keys: one of the two walks to a free rung.
    // Often that is the newcomer and nobody moves at all. When it is not, the
    // person they landed on moves — that one, nobody else, and onto a rung the
    // crew was not wearing.
    const before = memberSlots(CREW);
    const held = new Set(before.values());
    const joiners = JOINERS.filter((p) => held.has(home(p)));
    expect(joiners.length).toBeGreaterThan(0);
    for (const joiner of joiners) {
      const after = memberSlots([...CREW, joiner]);
      const moved = CREW.filter((p) => after.get(memberKey(p)) !== before.get(memberKey(p)));
      expect(moved.length).toBeLessThanOrEqual(1);
      for (const p of moved) {
        expect(before.get(memberKey(p))).toBe(after.get(memberKey(joiner)));
        expect(held.has(after.get(memberKey(p))!)).toBe(false);
      }
    }
  });

  it('leaves the crew where they were whoever goes', () => {
    const before = memberSlots(CREW);
    for (const gone of CREW) {
      const rest = CREW.filter((p) => p !== gone);
      const after = memberSlots(rest);
      for (const p of rest) expect(after.get(memberKey(p))).toBe(before.get(memberKey(p)));
    }
  });

  it('never moves someone off their own rung when a colleague joins', () => {
    // The universal form of the two above, over units of every size the ladder
    // holds. A member sitting on the rung their identity points at holds it
    // against any arrival except one pointing at the same rung.
    for (let seed = 0; seed < 120; seed++) {
      const crew = unit(seed, 1 + (seed % 7));
      const joiner = person(`j${seed}`, `J${seed}`);
      const before = memberSlots(crew);
      const after = memberSlots([...crew, joiner]);
      for (const p of crew) {
        const key = memberKey(p);
        if (before.get(key) !== home(p) || home(joiner) === home(p)) continue;
        expect(after.get(key)).toBe(before.get(key));
      }
    }
  });

  it('never moves someone off their own rung when a colleague goes', () => {
    for (let seed = 0; seed < 120; seed++) {
      const crew = unit(seed, 2 + (seed % 7));
      const before = memberSlots(crew);
      for (let i = 0; i < crew.length; i++) {
        const rest = crew.filter((_, j) => j !== i);
        const after = memberSlots(rest);
        for (const p of rest) {
          const key = memberKey(p);
          if (before.get(key) !== home(p)) continue;
          expect(after.get(key)).toBe(before.get(key));
        }
      }
    }
  });

  it('shares a hue rather than inventing one when the unit outgrows the scheme', () => {
    const tooMany = Array.from({ length: HUES + 3 }, (_, i) => person(`p${i}`, `P${i}`));
    const slots = memberSlots(tooMany);
    expect(slots.size).toBe(tooMany.length);
    for (const slot of slots.values()) expect(slot).toBeGreaterThanOrEqual(0);
    for (const slot of slots.values()) expect(slot).toBeLessThan(HUES);
  });

  it('keys a member with no Github login by their stable id', () => {
    const noLogin = person(null, 'Sam Silent', 'sam@example.com');
    const slots = memberSlots([...CREW, noLogin]);
    expect(slots.get('sam@example.com')).toBeTypeOf('number');
  });
});

describe('memberColor (#477) — one source every per-member surface reads', () => {
  it('hands back a token from the member hue scheme', () => {
    expect(memberColor(CREW, 'octocat')).toMatch(/^var\(--seg-[1-9]\)$/);
  });

  it('gives the same person the same colour whichever alias names them', () => {
    expect(memberColor(CREW, 'Octocat')).toBe(memberColor(CREW, 'octocat'));
    expect(memberColor(CREW, 'octocat@example.com')).toBe(memberColor(CREW, 'octocat'));
  });

  it('is stable across calls — the same roster paints the same colours', () => {
    expect(memberColor(CREW, 'hubot')).toBe(memberColors(CREW)('hubot'));
  });

  it('falls back to the neutral for someone the roster cannot place', () => {
    expect(memberColor(CREW, 'drive-by-contributor')).toBe('var(--seg-none)');
  });

  it('falls back to the neutral when there is no roster at all', () => {
    // /api/people failed: nobody has a colour yet, and nothing should break.
    expect(memberColor([], 'octocat')).toBe('var(--seg-none)');
  });

  it('falls back to the neutral for no login at all', () => {
    expect(memberColor(CREW, null)).toBe('var(--seg-none)');
  });
});

describe('memberWash (#477)', () => {
  it('mixes a member colour toward the block surface', () => {
    expect(memberWash('var(--seg-2)', 12)).toBe('color-mix(in srgb, var(--seg-2) 12%, var(--surface))');
  });
});
