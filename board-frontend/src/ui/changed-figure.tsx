/**
 * A figure that is seen to change (#824).
 *
 * The board refetches every two minutes. Until now a figure that moved was
 * simply a different number on the next paint: you look away, you look back, and
 * nothing on the page tells you whether anything happened, let alone which of
 * the nine numbers on the strip is the one that moved. This draws the figure and,
 * when its value is replaced by a different one ABOUT THE SAME THING, marks it
 * for well under a second with a small chevron saying which way it went. The
 * caller says what each figure is about; a slot that fills with somebody else's
 * number has not moved, and `figureMove` below is where that is decided.
 *
 * THE MARK SAYS "THIS MOVED" AND NOTHING ELSE. It does not say the move was good
 * or bad, because the strip cannot know: issues down is good news, throughput
 * down is bad news, releases either way is neither, and the three tiles are drawn
 * by one presentational component that is handed no opinion about any of them.
 * The first cut of this drew a rise in `--green` and a fall in
 * `--pink`, which painted an open-issue count falling from 10 to 9 —
 * unambiguously good — in the kit's colour for an error. One attention colour in
 * both directions, and the chevron alone carries the direction.
 *
 * The decision is `figureMove` below, a pure function, and the component is a
 * thin thing over it. That split is not taste: the frontend suite runs with
 * `environment: 'node'` and has no DOM, so no effect fires and
 * nothing re-renders under test. A spec that asserted the marked markup would be
 * asserting a state the test environment cannot reach. `figureMove` is the part
 * that can be driven directly, and `changed-figure.spec.tsx` drives it.
 *
 * It does NOT count up to the new number. Rolling the digits makes the figure
 * unreadable for the duration, which is the opposite of what a reader glancing
 * at a board wants, and the number is the thing being reported.
 *
 * The chevron is `aria-hidden` and there is no live region. The value itself is
 * in the DOM as it always was; announcing "went up" on three tiles every two
 * minutes would be a worse experience than the silence it replaced.
 */
import { useEffect, useRef, useState } from 'react';

/** Which way a figure went, or nothing worth marking. */
export type FigureMove = 'up' | 'down' | null;

/**
 * A figure and what it is about, which travel together because a value compared
 * without its subject is the whole of the defect below.
 *
 * `subject` is an opaque key. Nothing here parses it or shows it; two readings
 * are about the same thing when their subjects are the same string, and about
 * different things otherwise. `undefined` means nobody said, which is answered
 * separately in `figureMove`.
 */
export type Reading = { value: number | null; subject: string | undefined };

/**
 * Whether this figure moved, and which way.
 *
 * `now` is the reading this render holds. `seen` is the one the last render
 * drew, and the absences either side can carry are different facts, answered
 * differently:
 *
 * `undefined` for the whole of `seen` is FIRST PAINT — no render has drawn this
 * figure yet, so there is nothing it could have moved from. A strip that flashed
 * all three tiles on arrival would mark the page load, not a change.
 *
 * A DIFFERENT SUBJECT is not a move. On Overview a Crew card press re-scopes the
 * strip — Issues and Throughput become that person's while Releases stay
 * org-wide — and `<TeamView />` is rendered without a key, so the component
 * survives the press and meets a second number in the slot the first one was in.
 * Two of the tiles then animated a chevron claiming they rose or fell. They did
 * not: the number is not the same number, it is a different number about
 * somebody else. That is the same category as the first paint above, and the
 * canonicalisation `TeamView` runs after its queue lands reaches it with nobody
 * having pressed anything at all.
 *
 * AN UNSTATED SUBJECT is not a move either. A caller that says nothing about
 * what its figures are about cannot be told the number in this slot is still the
 * same number, and silence is the honest answer to a question nobody answered.
 *
 * `null` for a value on either side is a read that started or stopped working.
 * The tile draws no number at all in that state (`FlowStrip.tsx` says why), so
 * the pair `null -> 7` is not a rise from zero and `7 -> null` is not a fall to
 * it. Drawn as movement it would report a broken API call as news about the
 * queue.
 *
 * Equal values are not a change either, and this is the case that actually runs:
 * the poll usually gets the same answer back, and a strip that twitched on every
 * poll would be worse than one that never moved.
 *
 * A stored figure corrected by the first live read of the same subject IS a
 * move, and is marked. A return visit seeds the strip from yesterday's copy, so
 * the number a reader is looking at really is replaced by a different number
 * about the same thing, and which of the three moved overnight is exactly what
 * the mark is for. Telling that apart from a poll would mean knowing where a
 * value came from, which is provenance this component is not handed and should
 * not learn.
 */
export function figureMove(now: Reading, seen: Reading | undefined): FigureMove {
  if (seen === undefined) return null;
  if (now.subject === undefined || seen.subject === undefined) return null;
  if (now.subject !== seen.subject) return null;
  if (seen.value === null || now.value === null) return null;
  if (now.value === seen.value) return null;
  return now.value > seen.value ? 'up' : 'down';
}

/**
 * How long the mark stays up, in milliseconds.
 *
 * This and `--figure-moved-dur` in `app.css` are two different facts, not one
 * number written twice: this is how long the mark is raised, that is how long
 * the raising and the lowering each take. Under reduced motion the CSS one goes
 * to zero and this one does not, which is the whole of what reduced motion
 * changes here — the mark still appears, it just stops fading.
 *
 * 600ms plus a 250ms fade either side is about 850ms end to end, so the mark is
 * gone inside a second. `flash()`'s pill sits for 1900ms, but a pill is a
 * confirmation of something you did; this is a footnote on something that
 * happened while you were not looking, and it may fire on three tiles at once.
 */
export const FIGURE_MOVED_MS = 600;

/** The chevron, in a 10x10 box. Up is a rise. Direction is carried by the shape
 *  rather than by the tint, so it survives a reader who cannot tell the green
 *  from the red. */
const CHEVRON: Record<'up' | 'down', string> = {
  up: 'M2 6.5 5 3.5 8 6.5',
  down: 'M2 3.5 5 6.5 8 3.5',
};

/** A raised mark, or one on its way back down. `live` is what the CSS reads; the
 *  direction outlives it so the chevron keeps its shape through the fade out
 *  rather than flipping over halfway.
 *
 *  The direction never reaches a class name, and that is the point rather than a
 *  detail: the stylesheet is handed no way to tell a rise from a fall, so it
 *  cannot grow a rule that colours one of them differently. */
type Mark = { dir: 'up' | 'down'; live: boolean };

/**
 * The figure, marked when it moves.
 *
 * It holds the previous reading itself. That is the point of it being a component
 * at all: the flow strip is presentational and its caller passes it a model, so
 * the one place that can remember what was on screen a moment ago is the thing
 * that drew it. The reading it keeps is the value AND the subject, never the
 * value alone — kept apart, the two go out of step exactly once, on the render
 * where the subject changed, which is the render that matters.
 *
 * The mark is raised from an effect rather than during the render that brings
 * the new number in, and that ordering is load-bearing twice over. A class
 * applied in the same commit as the element it is on starts no transition, so
 * the mark would appear fully formed instead of arriving. And the new figure
 * paints first, unmarked, which is the order a reader wants: the number, then
 * the note about it.
 *
 * Under StrictMode the effect runs twice on mount. The second run compares the
 * value against itself, because the first already recorded it, so the double
 * invoke marks nothing.
 */
export function ChangedFigure({ value, subject, className }: {
  /** `null` is a read that did not land, and it draws NOTHING — no figure, no
   *  mark, not an em dash. `FlowStrip.tsx` argues that case: a rule-shaped glyph
   *  level with the real figures beside it reads as a redaction bar. Taking
   *  `number | null` rather than `number` is what lets the component stay mounted
   *  across a read that stopped and started again, which is the only way the
   *  absence rule in `figureMove` above is reachable through the component at
   *  all. */
  value: number | null;
  /** What this figure is about, as an opaque key — see `Reading`. Written
   *  without a `?` so every call site has to say something, including the word
   *  `undefined`: the slot a figure sits in is not what it is about, and the
   *  defect this fixes is a component that could not tell the two apart. */
  subject: string | undefined;
  /** The type the figure is drawn in, which stays with the caller — the flow
   *  strip's `BIG` is one 27px definition and this component has no opinion
   *  about size. */
  className: string;
}) {
  const seen = useRef<Reading | undefined>(undefined);
  const [mark, setMark] = useState<Mark | null>(null);

  useEffect(() => {
    const dir = figureMove({ value, subject }, seen.current);
    seen.current = { value, subject };
    if (dir !== null) setMark({ dir, live: true });
  }, [value, subject]);

  // A raised mark takes itself down. Kept apart from the effect above so the
  // timer is cleared only by the thing that set it: folded together, a value
  // change that marks nothing would still cancel a mark already up and leave it
  // raised for good.
  useEffect(() => {
    if (!mark?.live) return;
    const t = window.setTimeout(() => setMark({ dir: mark.dir, live: false }), FIGURE_MOVED_MS);
    return () => window.clearTimeout(t);
  }, [mark]);

  // After the hooks, never before them: an early return above a `useEffect` is
  // the one shape React forbids, and the effects have to keep running so the
  // absent read is recorded as the value it was.
  if (value === null) return null;

  const lit = mark?.live ? ' figure-moved-lit' : '';
  return (
    <span className={`${className} figure-moved${lit}`}>
      {value}
      {mark && (
        <svg className="figure-moved-caret" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path
            d={CHEVRON[mark.dir]}
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}
