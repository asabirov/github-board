/**
 * The ⌘K palette's board index, driven through the addresses a person walks
 * (#714). The palette went empty on `/acme` → `/globex` → `/acme`
 * and stayed empty for the life of the page: the clearing effect emptied the
 * LIST on every org change while the latch stayed on the org it had last read,
 * so the guard `loadedFor === org` refused to read again and nothing said so.
 *
 * The suite has no DOM, so the effects themselves cannot be
 * fired here — which is exactly why the decision is a module rather than three
 * lines inside a component. Each `it` below walks the addresses in order and
 * asserts the two things a palette can be, at each one: what it OFFERS, and
 * whether it still owes a read. The one rule underneath both: the list and the
 * org it was read for are one value, so they cannot disagree.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectSummary } from '../api/projects';
import { NOTHING_HELD, answered, atAddress, boardsOf, mustRead } from './palette-boards';

const board = (o: Partial<ProjectSummary>): ProjectSummary =>
  ({ number: 3, name: 'Delivery', open: 3, closed: 9, pct: 75, ...o }) as ProjectSummary;

const ACME = [board({ org: 'acme', number: 7, name: 'Acme Go-To-Market' })];
const APLITENI = [board({ org: 'globex', number: 2, name: 'Keitaro' })];

/** The palette as the shell drives it: an address, an open, an answer. `held`
 *  is the whole of its board state — there is no second value to keep in step. */
function palette() {
  let held = NOTHING_HELD;
  return {
    at: (org: string | null) => { held = atAddress(held, org); },
    offers: () => boardsOf(held).map((p) => p.name),
    owesRead: (org: string | null) => mustRead(held, org, true),
    /** The palette is shut: no read is owed whatever the latch says. */
    owesReadWhileShut: (org: string | null) => mustRead(held, org, false),
    reads: (org: string | null, projects: ProjectSummary[]) => { held = answered(org, projects); },
  };
}

describe('the palette offers the boards of the address it is on (#714)', () => {
  it('offers nothing, and owes a read, before anything has been read', () => {
    const p = palette();
    p.at('acme');
    expect(p.offers()).toEqual([]);
    expect(p.owesRead('acme')).toBe(true);
  });

  it('offers what came back, and does not ask twice for the same org', () => {
    const p = palette();
    p.at('acme');
    p.reads('acme', ACME);
    expect(p.offers()).toEqual(['Acme Go-To-Market']);
    // The latch, and it is the point of the latch: a read that SUCCEEDED is not
    // repeated every time the palette opens on the same address.
    expect(p.owesRead('acme')).toBe(false);
  });

  it('offers no other org’s boards the moment the address names one', () => {
    const p = palette();
    p.at('acme');
    p.reads('acme', ACME);
    p.at('globex');
    expect(p.offers()).toEqual([]);
    expect(p.owesRead('globex')).toBe(true);
  });

  it('comes back with boards after /acme → /globex → /acme', () => {
    const p = palette();
    p.at('acme');
    p.reads('acme', ACME);
    // Away and back, with the palette never opened in between — so nothing was
    // read for globex, and the latch was never moved off acme.
    p.at('globex');
    p.at('acme');
    // Whatever it holds, it holds ONE org's worth: either acme's boards
    // are there, or a read is owed for them. Empty AND settled is the bug.
    expect(
      p.offers().length > 0 || p.owesRead('acme'),
      'the palette offers no boards for /acme and will not read again',
    ).toBe(true);
    expect(p.offers()).toEqual([]);
    expect(p.owesRead('acme')).toBe(true);
  });

  it('reads each org once across a round trip that opened on both', () => {
    const p = palette();
    p.at('acme');
    p.reads('acme', ACME);
    p.at('globex');
    p.reads('globex', APLITENI);
    expect(p.offers()).toEqual(['Keitaro']);
    p.at('acme');
    expect(p.owesRead('acme')).toBe(true);
    p.reads('acme', ACME);
    expect(p.offers()).toEqual(['Acme Go-To-Market']);
  });

  it('owes nothing while it is shut, however long ago it read', () => {
    const p = palette();
    p.at('acme');
    expect(p.owesReadWhileShut('acme')).toBe(false);
  });

  it('keeps owing a read on an org the board refuses, and offers nothing', () => {
    // `/gtm` is not a configured org: the read rejects, so `answered` is never
    // called and the latch cannot move — the next open asks again (#714).
    const p = palette();
    p.at('acme');
    p.reads('acme', ACME);
    p.at('gtm');
    expect(p.offers()).toEqual([]);
    expect(p.owesRead('gtm')).toBe(true);
    expect(p.owesRead('gtm')).toBe(true);
  });

  it('reads for the union too, and tells it apart from an org', () => {
    const p = palette();
    p.at(null);
    expect(p.owesRead(null)).toBe(true);
    p.reads(null, ACME);
    expect(p.owesRead(null)).toBe(false);
    expect(p.owesRead('acme')).toBe(true);
  });
});
