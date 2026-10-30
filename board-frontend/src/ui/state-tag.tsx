/**
 * The board's one lifecycle badge — a tone-matched dot and the word for it, all
 * driven by a single `--iss-tone` hue var (`.iss-state`, app.css).
 *
 * It arrived as the issue page's `StatePill` (#423), where a writer can click it
 * to open or close the issue. The Feedback list needs the same fact stated on
 * every row (#451) with no affordance at all, so the read-only face and the two
 * lookups behind it live here and both surfaces import them. One definition,
 * because a second treatment for "is this open" is exactly the drift that makes
 * two pages look like two products.
 */
import type { CSSProperties } from 'react';
import type { IssueState } from '../api/types';

/** The hue a lifecycle state carries — green while the issue is live, brand blue
 *  once it's settled — and the word that names it. Read by the pill, by its
 *  menu's dots, and by the Feedback rows, so none of them can drift. */
export const STATE_TONE: Record<IssueState, string> = {
  open: 'var(--green)',
  closed: 'var(--accent)',
};
export const STATE_WORD: Record<IssueState, string> = { open: 'Open', closed: 'Closed' };

/** The tone var the whole badge hangs off — set on whatever element wears it. */
export function stateTone(state: IssueState): CSSProperties {
  return { '--iss-tone': STATE_TONE[state] } as CSSProperties;
}

/** A small tone-matched state dot — on the pill, on its two menu options, and on
 *  the Feedback rows. The hue is inline rather than inherited so the dot carries
 *  its own meaning. */
export function StateDot({ state, small = false }: { state: IssueState; small?: boolean }) {
  return (
    <span
      className={`${small ? 'size-1.5' : 'size-2'} flex-none rounded-full`}
      style={{ background: STATE_TONE[state] }}
      aria-hidden="true"
    />
  );
}

/**
 * The badge as a plain, unclickable statement of state — the issue page's reader
 * view of `StatePill`, and every row of the Feedback list.
 *
 * `small` is the same badge at list scale, not a different one: same shape, same
 * hue var, tightened to sit inside a 12px meta line without shouting over the
 * facts beside it.
 */
export function StateTag({ state, small = false }: { state: IssueState; small?: boolean }) {
  return (
    <span className={small ? 'iss-state iss-state-sm' : 'iss-state'} style={stateTone(state)}>
      <StateDot state={state} small={small} />
      {STATE_WORD[state]}
    </span>
  );
}
