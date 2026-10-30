/**
 * What counts as a figure having moved (#824).
 *
 * The suite has no DOM: no effect fires, nothing re-renders,
 * and no transition runs. So the marked state is unreachable from here, and a
 * test that asserted it would be asserting a belief rather than a behaviour.
 * What IS reachable is the decision — `figureMove` is pure and is driven
 * directly — and the markup the component emits on the render a reader gets
 * first, which `renderToStaticMarkup` produces for real.
 *
 * The rules below are the ones a two-minute poll and a Crew press actually
 * exercise. Each was checked by mutation as well as by running: `figureMove` was
 * broken on purpose one clause at a time, and the assertion that should have
 * noticed did.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChangedFigure, FIGURE_MOVED_MS, figureMove } from './changed-figure';
import changedFigureSource from './changed-figure.tsx?raw';
// A stylesheet is the one thing `?raw` cannot fetch here — vitest's default
// `css: false` stubs every CSS module to the empty string, and a guard reading
// '' passes while proving nothing. `App.spec.ts` measured that and reaches for
// node:fs; this does the same, for the same reason, with the same apology about
// the package carrying no node types.
// @ts-expect-error node:fs is untyped here; it exists in vitest's node env.
import { readFileSync } from 'node:fs';

const CSS: string = readFileSync(new URL('../app.css', import.meta.url), 'utf8');
/** app.css without its comments, so prose about a duration cannot be read as a
 *  declaration of one. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The unit's own numbers, which is what both pages show with nobody selected. */
const ORG = 'org';
/** One person's, which is what a pressed Crew card narrows Issues and Throughput
 *  to. Any two different strings would do — `figureMove` never reads one. */
const ALICE = 'alice';

/** A reading, spelled the way the component builds one. */
const reading = (value: number | null, subject: string = ORG) => ({ value, subject });
/** One from a caller that never said what its figures count. Built as a literal
 *  rather than `reading(9, undefined)`, which takes the default above — a
 *  default parameter fires on an explicit `undefined`, and the test read as
 *  passing over the wrong pair while it was written that way. */
const unstated = (value: number | null) => ({ value, subject: undefined });

describe('a figure that moved, and one that only looks like it (#824)', () => {
  // The board draws every tile on arrival. If a first paint counted as a change
  // the whole strip would flash on load, which marks the page opening rather
  // than any number moving — and the load is the one moment a reader is already
  // looking at all three.
  it('marks nothing on the first paint, because nothing was there to move from', () => {
    expect(figureMove(reading(9), undefined)).toBeNull();
    expect(figureMove(reading(0), undefined)).toBeNull();
    expect(figureMove(reading(null), undefined)).toBeNull();
  });

  // The case that runs most. A poll every two minutes usually gets the same
  // answer back, so this is the answer for nearly every refresh the board makes,
  // and a strip that twitched on each one would be worse than one that never
  // moved at all.
  it('marks nothing when the same number arrives again', () => {
    expect(figureMove(reading(9), reading(9))).toBeNull();
    expect(figureMove(reading(0), reading(0))).toBeNull();
  });

  // A read that started or stopped working is a different fact from a queue that
  // grew or shrank, and drawing it as movement would report a failed API call as
  // news about the work.
  it('does not call a read starting or stopping a rise or a fall', () => {
    expect(figureMove(reading(7), reading(null))).toBeNull();
    expect(figureMove(reading(null), reading(7))).toBeNull();
    expect(figureMove(reading(null), reading(null))).toBeNull();
    // Including where the number either side of the absence is zero, which is
    // the pair a comparison against a falsy null would get wrong.
    expect(figureMove(reading(0), reading(null))).toBeNull();
    expect(figureMove(reading(null), reading(0))).toBeNull();
  });

  // "Throughput went from 4 to 9" and "from 9 to 4" are opposite news, and a
  // mark that could not tell them apart would say only that something happened.
  it('tells a rise from a fall', () => {
    expect(figureMove(reading(9), reading(4))).toBe('up');
    expect(figureMove(reading(4), reading(9))).toBe('down');
    // Across zero in both directions: a queue emptying and a queue opening are
    // the two readings a board is most likely to be glanced at for.
    expect(figureMove(reading(1), reading(0))).toBe('up');
    expect(figureMove(reading(0), reading(1))).toBe('down');
    // Negative figures are not drawn on this strip today, but the comparison is
    // arithmetic rather than a truthiness test, and this is what pins that.
    expect(figureMove(reading(-1), reading(-3))).toBe('up');
    expect(figureMove(reading(-3), reading(-1))).toBe('down');
  });
});

describe('a number that changed subject has not moved (#824)', () => {
  // The live defect. `<TeamView />` is rendered without a key at App.tsx, so a
  // Crew press does not remount the strip: Issues and Throughput become that
  // person's, two figures are replaced in place, and both animated a chevron
  // saying they rose or fell. Neither did — 12 issues open across the unit and 3
  // open for Alice are not a fall from 12 to 3, they are two different numbers.
  it('marks nothing when a Crew press re-scopes the tile under the reader', () => {
    expect(figureMove(reading(3, ALICE), reading(12, ORG))).toBeNull();
    expect(figureMove(reading(12, ORG), reading(3, ALICE))).toBeNull();
  });

  // The same thing with nobody pressing anything: TeamView's canonicalisation
  // rewrites the URL once after the queue lands, so the selection can change on
  // first load. Whether a person pressed is not the rule — whether the figure is
  // about the same thing is.
  it('marks nothing when the subject changes with nobody pressing anything', () => {
    // Different values as well as different subjects: equal values are refused
    // by a clause of their own, so a pair like 4 -> 4 would pass this test with
    // the subject rule deleted.
    expect(figureMove(reading(7, 'alice'), reading(4, 'Alice'))).toBeNull();
  });

  // And it goes on marking a real move under a selection that is holding still,
  // which is what stops the rule above from being "never mark on Overview".
  it('still marks a move while the subject stays put', () => {
    expect(figureMove(reading(3, ALICE), reading(5, ALICE))).toBe('down');
  });

  // A caller that says nothing about what its figures count gets no marks. It
  // cannot be told the number in this slot is still the same number, and the
  // alternative — assuming it is — is the defect above.
  it('marks nothing while nobody has said what the figure is about', () => {
    expect(figureMove(unstated(9), unstated(4))).toBeNull();
    expect(figureMove(reading(9, ORG), unstated(4))).toBeNull();
    expect(figureMove(unstated(9), reading(4, ORG))).toBeNull();
  });

  // THE DECIDED CASE, kept rather than suppressed. A return visit seeds the
  // strip from the stored copy, so the first live read corrects yesterday's
  // number — same subject, different value — and it is marked. That is the
  // feature working: the reader is looking at a number that really is being
  // replaced, and which of the three moved overnight is the one thing the strip
  // could not say before. Telling it from a poll would need to know where a
  // value came from, and the component is handed no provenance.
  it('marks the first live read correcting a stored figure, which is the feature', () => {
    expect(figureMove(reading(11, ORG), reading(9, ORG))).toBe('up');
  });
});

describe('what the component emits before anything has moved', () => {
  const BIG = 'text-[27px] font-semibold';

  // The render a reader gets first, and the only one this environment can
  // produce. It has to be the plain figure: the caller's type, the number, and
  // no mark of any kind.
  it('draws the figure in the caller’s type, unmarked', () => {
    const markup = renderToStaticMarkup(<ChangedFigure value={9} subject={ORG} className={BIG} />);
    expect(markup).toContain('>9<');
    expect(markup).toContain(BIG);
    expect(markup).toContain('figure-moved');
    expect(markup).not.toContain('figure-moved-lit');
    // No chevron either. It is rendered only once something has moved, so its
    // absence here is the same fact as the two classes above.
    expect(markup).not.toContain('<svg');
  });

  // It emits exactly one element carrying the caller's type. `flow-strip.vm.spec.ts`
  // counts headline slots by counting `text-[27px]`, and a wrapper that repeated
  // the class would make that count read three tiles as six.
  it('carries the caller’s type on one element and not on two', () => {
    const markup = renderToStaticMarkup(<ChangedFigure value={9} subject={ORG} className="text-[27px]" />);
    expect(markup.match(/text-\[27px\]/g)).toHaveLength(1);
  });

  it('draws a zero as a zero', () => {
    expect(renderToStaticMarkup(<ChangedFigure value={0} subject={ORG} className={BIG} />)).toContain('>0<');
  });

  // A read that did not land draws nothing at all, not an em dash and not an
  // empty box in the caller's type. It stays a component rather than becoming
  // nothing, so it can be kept mounted across a read that stopped and started
  // again — which is the only way `figureMove`'s absence rule is reachable
  // through the component instead of only through the function.
  it('draws nothing at all for a read that did not land', () => {
    expect(renderToStaticMarkup(<ChangedFigure value={null} subject={ORG} className={BIG} />)).toBe('');
  });
});

describe('the mark is quiet, and reduced motion keeps it', () => {
  // Under a second, end to end. The two numbers compose one way and not the
  // other: the fade IN runs inside the dwell, because the timer starts when the
  // class goes on, and only the fade OUT is added after the dwell expires. So
  // the mark is on screen for `FIGURE_MOVED_MS + fade`, not for the dwell plus a
  // fade at each end. Asserted rather than described because "quiet and short"
  // is the constraint the whole design is under, and because getting that
  // composition wrong is what this assertion caught while it was being written.
  it('is gone inside a second', () => {
    // What keeps this block honest: on an empty read every assertion below would
    // agree about nothing, which is the failure `App.spec.ts` records having had.
    expect(CSS.length).toBeGreaterThan(1000);
    expect(RULES).toContain('.figure-moved {');
    const fadeMs = Number(/--figure-moved-dur: ([\d.]+)s/.exec(RULES)![1]) * 1000;
    expect(fadeMs).toBeGreaterThan(0);
    expect(FIGURE_MOVED_MS + fadeMs).toBeLessThan(1000);
  });

  // The house convention for motion, which `--side-slide-dur` set: a named
  // duration property, zeroed inside the reduced-motion query. Read off the
  // stylesheet because nothing in this environment can evaluate a media query.
  it('zeroes its one duration knob under prefers-reduced-motion', () => {
    // `[^}]*` cannot cross a closing brace, so this only passes while the
    // declaration really is inside the query — moved out to the top level, or
    // into a neighbouring rule, it stops matching.
    expect(RULES).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.figure-moved\s*\{[^}]*--figure-moved-dur:\s*0s/,
    );
  });

  // And it does not go silent there. The mark itself is information — which of
  // nine numbers moved — so reduced motion drops the fade and keeps the mark.
  // The dwell is a JS constant and no media query can reach it, which is what
  // makes that true; this pins that it stays that way.
  it('holds the mark for the same time under reduced motion, having no query on the dwell', () => {
    expect(changedFigureSource).not.toMatch(/prefers-reduced-motion/);
    expect(changedFigureSource).toMatch(/FIGURE_MOVED_MS = \d+/);
  });

  // Direction is carried by the chevron's shape, and since the tint is one colour
  // in both directions the shape is now the ONLY thing carrying it. The two paths
  // differ, so the glyph itself points.
  it('points with a shape, which is the only thing saying which way', () => {
    const paths = [...changedFigureSource.matchAll(/(up|down): '(M[^']+)'/g)];
    expect(paths).toHaveLength(2);
    expect(paths[0][2]).not.toBe(paths[1][2]);
  });

  // It does not roll the digits. A count-up makes the figure unreadable for the
  // length of the mark, which is the opposite of what the number is for.
  it('does not count up to the new number', () => {
    expect(changedFigureSource).not.toMatch(/requestAnimationFrame|setInterval/);
  });
});

describe('the mark says a figure moved and never that the move was good', () => {
  /** Every rule whose selector names the mark, as `[selector, body]`. Scoped that
   *  way because app.css uses `--pink` legitimately elsewhere — the flash
   *  pill and the OKR error line — and a file-wide grep would read those as this
   *  rule breaking. */
  const MARK_RULES = [...RULES.matchAll(/([^{}]*figure-moved[^{}]*)\{([^}]*)\}/g)]
    .map((m) => [m[1].trim(), m[2].trim()]);

  it('found the rules it is judging, so an empty match cannot pass this block', () => {
    expect(MARK_RULES.length).toBeGreaterThanOrEqual(4);
    expect(MARK_RULES.map(([sel]) => sel).join(' ')).toContain('.figure-moved-lit');
  });

  // The defect this replaced, in one line. Issues fell from 10 to 9 — good news —
  // and the board drew it in the kit's colour for an error. Whether a move is good
  // depends on which tile it is on: issues down is good, throughput down is bad,
  // releases either way is neither. The strip is presentational and holds no such
  // opinion, so the mark states the fact and stops.
  it('tints in neither the kit’s good colour nor its bad one', () => {
    for (const [sel, body] of MARK_RULES) {
      for (const verdict of ['--green', '--pink', '--amber']) {
        expect(body, `${sel} tints the mark with ${verdict}, which is a verdict the strip cannot make`)
          .not.toContain(verdict);
      }
    }
  });

  // And the structural half, which is what actually keeps it that way: the
  // direction never reaches a class name, so the stylesheet cannot tell a rise
  // from a fall and has nothing to hang a second colour on. Re-adding red and
  // green means re-adding a per-direction class first, and this is what notices.
  it('gives the stylesheet no way to tell a rise from a fall', () => {
    for (const [sel] of MARK_RULES) {
      expect(sel, `${sel} names a direction, which is how a per-direction colour gets back in`)
        .not.toMatch(/figure-moved-(up|down|rise|fall)/);
    }
    expect(changedFigureSource).toContain("' figure-moved-lit'");
    expect(changedFigureSource).not.toMatch(/figure-moved-\$\{/);
  });

  // The one colour it does use, named. `--text` is what the figure already
  // is; the two quiet tokens would make a marked figure recede; the three verdict
  // tokens are the thing above. That leaves the board's attention colour.
  it('marks in the board’s attention colour', () => {
    const lit = MARK_RULES.find(([sel]) => sel === '.figure-moved-lit');
    expect(lit).toBeDefined();
    expect(lit![1]).toContain('var(--accent)');
  });
});
