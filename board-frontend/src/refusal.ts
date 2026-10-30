/**
 * The board-service refusal vocabulary (#584), copied rather than imported: the
 * two packages do not import each other.
 * `board-service/src/capability/github-refusal.ts` holds the same six names, and
 * the join between them is that file's REFUSAL_CONTRACT plus the exhaustive
 * `Record<RefusalReason, …>` in `use-facet-edit.ts` — a seventh reason fails to
 * compile on both sides rather than arriving here as a string nobody handles.
 *
 * It lives in its own file because both readers need it and neither should
 * import the other: `api.ts` narrows the reason off the wire, `use-facet-edit.ts`
 * keys a table on it. One declaration, so the two tables cannot drift.
 */
export const REFUSAL_REASONS = [
  'not-permitted',
  'not-permitted-yet',
  'wrong-value',
  'try-again',
  'not-found',
  'unauthenticated',
] as const;

export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** `refusalOf` reads JSON off a failure path, so the reason arriving is an
 *  unchecked string until this narrows it. Anything unrecognised becomes
 *  `undefined` and the status table answers instead. */
export function isRefusalReason(x: unknown): x is RefusalReason {
  return typeof x === 'string' && (REFUSAL_REASONS as readonly string[]).includes(x);
}

/**
 * The words a refusal is said in, declared ONCE (#635 design review 7).
 *
 * Two surfaces say them: a write that came back refused (`use-facet-edit`'s
 * failure table) and a control withheld before anyone presses it (the issue
 * editor's rows). A third, the feedback form, went with #1450. They were three
 * typed copies, so rewording the failure table left the withheld row saying the
 * old thing with no test noticing — and the account page reached into the issue editor's
 * popover module to borrow one, dragging that dependency graph across a domain
 * boundary for a string.
 *
 * It names no subject on purpose: nine editors share it, so any subject would
 * be wrong on eight of them, and the surface supplies one (a row's label
 * column, a form's own sentence). `PropertyRow` sets that out at length.
 *
 * It lives here for the reason the file's own header gives: both readers need
 * it and neither should import the other.
 */
export const REFUSED_REASON = 'The board isn’t allowed';

/**
 * What one control is, for this session (#635):
 *
 * `armed`      — offer it. The session writes and the board has not been refused
 *                this capability.
 * `refused`    — withdraw it AND say why. The board's credential has already
 *                been told no for this exact write, so offering it would be a
 *                promise the server will break.
 * `read-only`  — withdraw it and say nothing. This session simply doesn't write.
 *
 * The last two are drawn differently on purpose. `REFUSED_REASON` is a statement
 * about the board's CREDENTIAL; on a session that does not write at all it would
 * be a lie about a credential nobody asked. That covers more than a reader:
 * `writesEnabled` is a human session AND `GITHUB_WRITE_ENABLED`, so turning the
 * write flag off — the obvious rollback lever — lands every surface here, and it
 * is also where a page sits while `/api/auth/me` is still in flight or came back
 * a 500. "Could not ask" and "was told no" are not the same answer.
 */
export type ControlVerdict = 'armed' | 'refused' | 'read-only';

/**
 * The tiebreak between the two withdrawn cases, in one place so two surfaces
 * cannot answer it differently.
 *
 * `armed` is the caller's own composition of the session with the ONE capability
 * its control writes — `mayWrite(me, cap)` for a row. This adds only the bit that says which withdrawal a person is owed,
 * and that bit is `writesEnabled`: never `canWrite`, which folds in all nine
 * issue refusals and would call a real refusal `read-only`, drawing the control
 * away with nothing on screen saying the board had been told no (#626).
 */
export function controlVerdict(armed: boolean, writesEnabled: boolean): ControlVerdict {
  if (armed) return 'armed';
  return writesEnabled ? 'refused' : 'read-only';
}
