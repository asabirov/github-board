/**
 * Whether a close counts as delivered work, on this side of the wire (#1014) —
 * the frontend twin of `board-service/src/issues-metrics/close-reason.ts`, which
 * holds the argument in full. The short version: an issue abandoned as
 * not-planned, or closed as a duplicate of the issue that did the work, is not
 * throughput. A reason we do not recognise, and a reason we were not sent, both
 * COUNT — an over-count somebody can see beats an under-count nobody can.
 *
 * Copied rather than imported, the way `refusal.ts` copies board-service's
 * refusal vocabulary and for the same reason: the two packages have separate
 * tsconfigs and import nothing from each other. `github-projects.source.ts` says
 * the same thing from the other direction about `slug()`. What keeps this copy
 * honest is `close-reason.spec.ts`, which READS the service file and checks this
 * function agrees with it on every reason that file names, so a reason added or
 * moved there turns a test red here rather than leaving one board counting what
 * the other refuses.
 *
 * One definition on this side too, for the reason the service gives: the join
 * between a reason and an instant is a single decision, and a call site
 * restating it as `stateReason !== 'not_planned'` is how a second one is born.
 * Exactly one surface reads it today — the viewer's `closed-yesterday` and
 * `closed-week` filters in `filter-group.ts`, which select client-side over
 * whatever list is loaded. Every other close figure on this board is counted
 * server-side and arrives already filtered.
 */

/** Github's `state_reason`, narrowed to what this board recognises — the
 *  service's list, unchanged, and pinned to it by the spec. `null` is a real
 *  member meaning "we were not told why this closed", never a stand-in for
 *  `completed`. */
export type CloseReason = 'completed' | 'not_planned' | 'duplicate' | 'reopened' | null;

/**
 * When this row's close counts as delivered work, or `null` when it does not.
 *
 * Returns the row's own `closedAt` untouched, so a call site swaps `i.closedAt`
 * for `deliveredCloseAt(i)` and keeps the arithmetic it already had. That is the
 * service's shape, kept here so the two read alike.
 *
 * BOTH FIELDS ARE OPTIONAL HERE where board-service requires them, and that is
 * the one deliberate difference between the copies. `ViewerIssue.closedAt` is
 * `string | undefined`, and `stateReason` is optional on every wire type in
 * `api.ts` because board-web and board-api deploy separately — an SPA that has
 * landed can be reading a board-api that has not. So absent has to mean what
 * unknown means, count it, which is what this board did before #1014. Reading it
 * the other way would delete real delivered throughput from a reader on an older
 * board-api, silently, for as long as that deploy window lasts.
 *
 * The service guards its own leniency with a REQUIRED field, so a source that
 * does not answer fails to compile. This side cannot borrow that guard, and does
 * not pretend to: what stands in for it is that only one surface here counts
 * closes at all, and the spec next door pins that it stays one.
 */
export function deliveredCloseAt(i: { closedAt?: string | null; stateReason?: CloseReason }): string | null {
  if (i.closedAt == null) return null;
  return i.stateReason === 'not_planned' || i.stateReason === 'duplicate' ? null : i.closedAt;
}

/**
 * The reasons a person may CHOOSE when closing an issue from the card menu
 * (#1006): the `state_reason` values that close one. A smaller set than
 * `CloseReason`, which is what the board READS off a closed issue: `reopened`
 * names a reopen and `null` clears the reason, so neither closes anything.
 * board-service's `CHOSEN_CLOSE_REASONS` is the list the close route accepts,
 * and says where the set was read from. `Extract` keeps this set inside
 * `CloseReason`.
 *
 * The choices live here rather than beside the close dialog because this is the
 * one source file on this side that may name a reason: `close-reason.spec.ts`
 * fails any other that does, so a second reading of a reason cannot start in a
 * component.
 */
export type ChosenCloseReason = Extract<CloseReason, 'completed' | 'not_planned' | 'duplicate'>;

/** The reasons the close dialog offers, in Github's own order and under
 *  Github's own names, which say when each fits without help (#1048). The one
 *  note is the thing a label cannot say: `duplicate` goes without naming the
 *  other issue. The dialog shows it while Duplicate is the choice. */
export const CLOSE_CHOICES: readonly { reason: ChosenCloseReason; label: string; note?: string }[] = [
  { reason: 'completed', label: 'Completed' },
  { reason: 'not_planned', label: 'Not planned' },
  { reason: 'duplicate', label: 'Duplicate', note: 'The board won’t link it to the issue it duplicates.' },
];

/** Github's own default, and where every opening of the close dialog starts. */
export const DEFAULT_CLOSE_CHOICE: ChosenCloseReason = 'completed';

/** A reason the way a sentence says it: "not planned" rather than the wire
 *  spelling. A word Github answers with that `CloseReason` has not heard of is
 *  shown as Github spells it, with its underscores as spaces. */
export function reasonWords(reason: string): string {
  return reason === 'duplicate' ? 'a duplicate' : reason.replace(/_/g, ' ');
}
