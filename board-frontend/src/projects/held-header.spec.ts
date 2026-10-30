import { describe, expect, it } from 'vitest';
import VIEW from './ProjectsView.tsx?raw';
import { heldHeader } from './held-header';

/**
 * Which board a stored rollup is allowed to answer for (#879).
 *
 * The function is pure and this is where the decision is testable at all: no
 * effect fires in this suite, so a render of the page can
 * never reach the state this feeds. The cases below are the ways the board can
 * be WRONG about identity, because that is the failure that matters here —
 * being slow costs a reader a second, and drawing the wrong board's name over
 * a page costs them their trust in every other figure on it.
 */

/** The fields `drawable` insists on, so a case can say what it changed. */
const board = (over: Record<string, unknown> = {}) => ({
  number: 7,
  name: 'Acme Go-To-Market',
  url: 'https://github.com/orgs/acme/projects/7',
  pct: 45,
  ...over,
});

describe('the board a stored rollup answers for', () => {
  it('answers the one row holding the number, when the address names no org', () => {
    expect(heldHeader([board({ number: 3 }), board()], 7)).toEqual({
      number: 7,
      name: 'Acme Go-To-Market',
      url: 'https://github.com/orgs/acme/projects/7',
      pct: 45,
      itemsComplete: undefined,
    });
  });

  it('carries the withholding flag through, so the ring declines where the card does', () => {
    expect(heldHeader([board({ itemsComplete: false })], 7)?.itemsComplete).toBe(false);
  });

  it('answers nothing when two orgs hold that number and the address says neither', () => {
    // A Projects v2 number is unique only within an org (#697), so this rollup
    // holds two different boards and the copy cannot say which one the API
    // would resolve. Drawing either is drawing one board's name on the other's
    // page.
    const two = [board({ org: 'acme' }), board({ org: 'globex', name: 'Compliance' })];
    expect(heldHeader(two, 7)).toBeNull();
  });

  it('answers only the row that SAYS it is the addressed org', () => {
    const two = [board({ org: 'acme' }), board({ org: 'globex', name: 'Compliance' })];
    expect(heldHeader(two, 7, 'globex')?.name).toBe('Compliance');
    expect(heldHeader(two, 7, 'someone-else')).toBeNull();
  });

  it('will not read a row that does not say its org as the addressed org’s', () => {
    // `ProjectSummary.org` is optional: a board-api that predates #697 sends no
    // org at all. Absent is unproven, not assumed, and the API's own
    // first-org-holding-the-number fallback is not borrowed onto a disk copy.
    expect(heldHeader([board()], 7, 'acme')).toBeNull();
  });

  it('answers nothing for a number the rollup does not hold', () => {
    expect(heldHeader([board({ number: 3 })], 7)).toBeNull();
  });

  it('answers nothing for a stored value that is not a rollup at all', () => {
    // `readPayload`'s guard for this key is `Array.isArray`, which says nothing
    // about the rows inside it.
    for (const junk of [null, undefined, {}, 'projects', 42]) expect(heldHeader(junk, 7)).toBeNull();
  });

  it('answers nothing for a row missing any field the header would draw', () => {
    // A day of rows written by the previous build outlives a change to
    // `ProjectSummary`, and a header is not worth inventing a name or a number
    // for.
    for (const missing of ['name', 'url', 'pct'] as const) {
      const row = board();
      delete (row as Record<string, unknown>)[missing];
      expect(heldHeader([row], 7)).toBeNull();
    }
    expect(heldHeader([board({ name: '' })], 7)).toBeNull();
    expect(heldHeader([board({ pct: Number.NaN })], 7)).toBeNull();
    expect(heldHeader([null, board()], 7)?.name).toBe('Acme Go-To-Market');
  });
});

/**
 * The wiring, pinned as text, for the reason `use-cached-state.spec.ts` pins
 * its own: the page reads the rollup during a RENDER, and this suite has no DOM
 * and runs no effect, so nothing here can observe that it happens. What can be
 * observed is that the source still says it.
 *
 * WHICH ROLLUP it reads changed with #1249 and the tests changed with it. It
 * was the STORED rollup, through `seedPayload`, and that entry is emptied by
 * every page load and, since #1243, by every walk — so this function was
 * unreachable in production for a release. It is the SAVED rollup now, which
 * survives both wipes and may be read only after a live read failed. The
 * two-key rule that used to be pinned here as source text moved to
 * `savedBoardRollup`, where `projects-last-good.spec.ts` drives it for real.
 */
describe('the board page’s use of the saved rollup', () => {
  it('reads it only while the board has neither an answer nor a refusal', () => {
    expect(VIEW).toContain('board === null && err === null && rollup !== null');
  });

  it('reads the recalled rollup and not the stored one', () => {
    // The distinction is the whole of #1249 item 2. `seedPayload` answers what
    // a reload would have opened on, which for a sensitive key is nothing; the
    // recalled copy is the one a failed read is allowed to fall back on.
    expect(VIEW).toContain('heldHeader(rollup.value, number, org)');
    // In code, that is: the docblock beside it still names the read it left.
    expect(VIEW.replace(/\/\/.*$/gm, ''), 'the stored rollup is not what this reads any more').not.toContain('seedPayload');
  });

  it('is reached only by a read that failed, never by one in flight', () => {
    // `rollup` is state set by a failure handler, and `savedBoardRollup` is
    // called from nowhere else. A loading board therefore has no rollup to
    // read, which is what stops the saved copy becoming a first paint.
    expect(VIEW.match(/savedBoardRollup\(/g) ?? []).toHaveLength(1);
    expect(VIEW.slice(VIEW.indexOf('const failed ='), VIEW.indexOf('const starting ='))).not.toContain('savedBoardRollup');
    const failed = VIEW.slice(VIEW.indexOf('const failed = (e: unknown)'));
    expect(failed.slice(0, failed.indexOf('};'))).toContain('savedBoardRollup');
  });

  it('never hands the viewer an invented item list', () => {
    // The header state draws the skeleton's rows. A synthesized `items: []`
    // would make every such open say "No issues on this board" — the false
    // zero #714 took a page down for, and the shape #1216 shipped on Repos.
    expect(VIEW).not.toContain('items: []');
  });
});

/**
 * What replaced the memo's sensitive-generation dependency (#892 review, C2
 * follow-up, revisited by #1249).
 *
 * The memo used to read a permission-sensitive entry itself, so the generation
 * that empties those entries had to be a reason to recompute — without it the
 * one case that never recomputed was a board still loading when the check
 * expired. The memo reads recalled STATE now, and `drawable` asks both
 * generations during the render that precedes it, so the rollup is already null
 * on the frame an expiry lands rather than one frame after.
 */
it('refuses a recalled rollup during render rather than after it', () => {
  expect(VIEW).toContain('const rollup = detail === null && copy === null ? drawable(savedRollup, org ?? null) : null;');
  expect(VIEW, 'and the memo must be reading that guarded value').toContain('[board, err, rollup, number, org]');
});
