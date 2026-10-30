import { describe, expect, it } from 'vitest';
import { nextIdentity, type IdentityGeneration } from './identity-generation';

/**
 * The key the board's tree is mounted under (#824, reworked for #1229 step 1).
 *
 * Driven as a sequence rather than a render, because what is being asserted is
 * a sequence: the same state, fed one identity after another, is exactly what
 * `App` does across renders, and it is testable here without a browser.
 */

const START: IdentityGeneration = { known: null, generation: 0 };

/** Feed a run of renders and report the generation each one keyed on. */
function run(identities: Array<string | null>): number[] {
  let state = START;
  return identities.map((identity) => {
    state = nextIdentity(state, identity);
    return state.generation;
  });
}

const A = 'octocat@example.com';
const B = 'someone-else@example.com';

describe('the probe answering does not remount the board (#1233)', () => {
  it('spans the probe and the person it turns out to be with one generation', () => {
    // THE FIX. The shell is on screen before `/api/auth/me` answers, so the
    // tree exists through a window in which the board knows nobody. If the
    // first answer turned the key over, React would remount everything under
    // it — including `TopBar`, and with it the open search box this step puts
    // up as the reader's way out of a wrong route, discarding what was typed.
    expect(run([null, null, A, A])).toEqual([0, 0, 0, 0]);
  });

  it('holds the generation while nobody has answered', () => {
    expect(run([null, null, null])).toEqual([0, 0, 0]);
  });
});

describe('a different person still wipes the tree (#824)', () => {
  it('turns the key over when one person replaces another', () => {
    // #824's rule, unchanged: `claimFor` has wiped the disk by then, and this
    // is what makes the tree wiped too, so the new person meets skeletons and
    // their own reads rather than the last person's figures.
    expect(run([null, A, B])).toEqual([0, 0, 1]);
    expect(run([null, A, B, A])).toEqual([0, 0, 1, 2]);
  });

  it('counts the visibility generation as part of who this is (#892)', () => {
    // `App` spells the identity as the address plus the visibility key, so a
    // re-check that changes what this person may see reads as a new identity.
    expect(run([null, `${A}v1`, `${A}v2`])).toEqual([0, 0, 1]);
  });

  it('remounts nothing while the same person is re-rendered', () => {
    expect(run([null, A, A, A, A])).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('a session that goes away and comes back', () => {
  it('keeps the generation when the same person signs back in', () => {
    // `login`, `forbidden` and `error` name nobody, so they read as "no
    // identity yet" and leave `known` where it was. Signing back in as the
    // same person has nothing to wipe.
    expect(run([null, A, null, A])).toEqual([0, 0, 0, 0]);
  });

  it('still turns over when somebody else signs in instead', () => {
    expect(run([null, A, null, B])).toEqual([0, 0, 0, 1]);
  });
});

describe('the state object', () => {
  it('is returned unchanged when nothing moved, so no render sets state', () => {
    // What `useIdentityGeneration` reads to decide whether to update at all.
    const settled = nextIdentity(START, A);
    expect(nextIdentity(settled, A)).toBe(settled);
    expect(nextIdentity(settled, null)).toBe(settled);
    expect(nextIdentity(START, null)).toBe(START);
  });
});
