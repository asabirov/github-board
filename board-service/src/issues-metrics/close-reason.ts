// WHY an issue was closed, and the one predicate that decides whether that
// close is delivery (#1014). Github has four reasons; the board counted a close
// as a close and read none of them, so an issue abandoned as "not planned" was
// throughput exactly like one that shipped. Measured on `acme` the day
// this landed: 382 of 3,318 closed issues, 11.5% org-wide — and 54% of the last
// 56 closes in `acme/acme`, which is what a per-repo sparkline moves by.
//
// Pure, and importing nothing. That is deliberate: `projects/project-pulse.ts`
// keeps itself free of this module's neighbours to stay acyclic, and a shared
// predicate is only shared if every counter can reach it. The mapping and the
// predicate live together because they are one decision read twice — a value we
// do not recognise and a value we recognise as abandonment must not be able to
// drift apart.

/**
 * Github's `state_reason`, narrowed to the values this board recognises.
 *
 * `null` is a REAL member and not a stand-in for "completed": a source that did
 * not select the field, a fixture written before it existed, a value Github adds
 * after this code ships. Absent, empty and zero are three states everywhere else
 * on this board, and "we were not told why this closed" is a fourth one here.
 *
 * `reopened` is on the list because Github sends it, not because a counter will
 * see it: it belongs to an issue that is OPEN, whose `closedAt` is null, so it
 * falls out at the `closedAt` gate before the reason is ever consulted. Naming
 * it anyway is what keeps `closeReasonOf` a total function over what Github
 * actually sends, so the unrecognised branch means "new to us" and not "we never
 * bothered with that one".
 */
export type CloseReason = 'completed' | 'not_planned' | 'duplicate' | 'reopened' | null;

/** Every reason we recognise, as the set `closeReasonOf` narrows against. */
const KNOWN: readonly string[] = ['completed', 'not_planned', 'duplicate', 'reopened'];

/**
 * Github's raw `state_reason` as a `CloseReason` — anything unrecognised, and
 * anything absent, becomes `null`.
 *
 * TOTAL, AND IT NARROWS RATHER THAN PATTERN-MATCHES. A mapper written as
 * `raw === 'not_planned' ? … : 'completed'` folds every future value into
 * delivery silently; this one folds it into `null`, which is the state that
 * means "we do not know" and which `deliveredCloseAt` then counts. The number
 * does not move either way, and the value survives for a reader to notice.
 *
 * The caller is what logs an unrecognised value — this module has no logger and
 * wants none. `unknownCloseReason` below is the test for it.
 */
export function closeReasonOf(raw: string | null | undefined): CloseReason {
  return raw != null && KNOWN.includes(raw) ? (raw as CloseReason) : null;
}

/**
 * Whether Github sent a reason this build does not recognise — the one thing a
 * caller needs to decide whether to log, without re-deriving the mapping.
 *
 * True only for a non-empty string that is not in `KNOWN`. An ABSENT reason is
 * not unknown in this sense: it is the ordinary state of a source that does not
 * select the field, and logging it would fire on every row of that source.
 */
export function unknownCloseReason(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && raw !== '' && !KNOWN.includes(raw);
}

/**
 * When this issue's close counts as DELIVERED WORK, or `null` when it does not —
 * the single gate every close count on this board reads.
 *
 * It returns the row's own `closedAt` untouched, so a call site swaps
 * `i.closedAt` for `deliveredCloseAt(i)` and keeps its arithmetic exactly as it
 * was. That is the whole point of the shape: every counter here was already
 * written as `if (i.closedAt)` or `countByDay(items, (i) => i.closedAt, …)`, and
 * a predicate that returned a boolean instead would have made each of the two
 * dozen sites restate the join between the reason and the instant.
 *
 * NOT PLANNED AND DUPLICATE ARE THE TWO THAT DO NOT COUNT, for different
 * reasons. Not-planned is abandonment: the work was dropped, and counting it as
 * throughput is the claim being corrected. A duplicate is real work that IS
 * being counted — under its twin — so counting both counts one piece of work
 * twice; `acme` holds none today, and the value is handled here rather
 * than left for the first one to arrive unnoticed.
 *
 * AN UNKNOWN REASON COUNTS, and that direction is chosen rather than fallen
 * into. This change exists to stop counting a close somebody explicitly marked
 * abandoned. It does not exist to stop counting closes we cannot classify — and
 * treating unknown as abandoned would silently delete real delivered throughput
 * from every historical figure, with nothing on screen saying it had happened.
 * An over-count somebody can see beats an under-count nobody can. `DayGrid`
 * already holds this line one level down: a day nobody counted says "not
 * recorded", never "nothing closed".
 *
 * The guard against that leniency sits outside this function. On the REST
 * ingest it is the TYPE: `stateReason` is required on `RawIssue`, which is built
 * from an object literal, so a source that does not answer fails to compile. On
 * the GraphQL side the type cannot bite — that payload arrives through an
 * unchecked assertion — so the guard there is a spec asserting both item
 * selections name the field. Two mechanisms, one rule, and the second is named
 * here because assuming the first covers it is the mistake to avoid.
 */
export function deliveredCloseAt(i: { closedAt: string | null; stateReason: CloseReason }): string | null {
  if (i.closedAt === null) return null;
  return i.stateReason === 'not_planned' || i.stateReason === 'duplicate' ? null : i.closedAt;
}

/** `deliveredCloseAt` as a predicate, for the sites that filter rather than
 *  read an instant — `issues.filter(isDeliveredClose)` says what it means where
 *  `.filter((i) => deliveredCloseAt(i) !== null)` says how it works. */
export function isDeliveredClose(i: { closedAt: string | null; stateReason: CloseReason }): boolean {
  return deliveredCloseAt(i) !== null;
}

/**
 * The Github search qualifier that narrows a query to the closes this board
 * counts — so a "12 closed" figure and the link behind it agree.
 *
 * Verified against the live search API: `org:acme is:issue is:closed`
 * returns 3,318 and the same query with this appended returns 2,936, against
 * 382 for `reason:not-planned`. Github spells the qualifier with a HYPHEN where
 * the API field uses an underscore, which is why this string is written once
 * here rather than assembled from `CloseReason` at each call site.
 *
 * IT IS NARROWER THAN `deliveredCloseAt`, AND THAT GAP IS ACCEPTED. The
 * predicate also refuses a `duplicate`; this qualifier cannot, so a member whose
 * week held one would see a count of 3 behind a link returning 4. `acme`
 * holds no duplicate close at all today, and the alternative — dropping the
 * qualifier so the link is uniformly wrong by the larger number — is worse. If
 * Github ever exposes `reason:duplicate`, this is the one line to extend.
 */
export const DELIVERED_CLOSE_QUALIFIER = '-reason:not-planned';
