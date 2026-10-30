/**
 * The words the board uses about a WRITE that did not land (#1079), and whether
 * the control that caused it may stay armed under them.
 *
 * `session-copy.ts` next door answers the same question for a read, and the two
 * are meant to be read as one product. They are separate modules because what
 * they share is not the same half. `loadFailureText` shares the SENTENCE: five
 * surfaces hand it a subject and it writes the whole line, and it can, because
 * "Couldn't load X" fits all five and the only offer any of them has is a
 * reload. A write has no such sentence — "the token wasn't created", "Claude
 * Desktop wasn't revoked" and "these changes weren't saved" are three different
 * shapes, and each surface still has the control that caused the failure sitting
 * on the screen beside the line. So what is shared here is the BRANCH: which
 * answer means what, and whether a second press could clear it. The sentences
 * stay where they are read, keyed on the kind by an exhaustive record, so a new
 * kind fails to compile at all three call sites rather than falling through one.
 */
import { ADMINS_UNREAD_CODE } from '../api/account';
import { ApiError, withdrawnRead } from '../api/core';
import { ACCESS_NOT_NOW_CODE } from '../projects/projects-last-good';

/**
 * START AT THE GLOBAL PROVIDERS. Enumerating what a route can throw by reading
 * its controller and its `@UseGuards` cannot see a guard that is not written
 * there, and on this service most of the refusals are not: `app.module.ts:112`
 * registers FIVE `APP_GUARD`s — `JwtAuthGuard`, `TeamAccessGuard`,
 * `RequiredScopesGuard`, `GithubPrincipalGuard`, `CapabilityGuard` — and every
 * one of them runs on every route that is not `@Public`, BEFORE the
 * controller's own. The first cut of this header enumerated four of the five
 * correctly and then said `TeamAccessGuard` "refuses /api/auth/me first", which
 * is a claim about a different route standing in for a reading of this one; the
 * guard was answering all three of these too, with the 403 a browser is most
 * likely to actually meet. #1083 walked into the same blind spot from the other
 * side. `account.controller.ts:27` names the chain in its own header, so the
 * correction was one grep away from where the wrong claim was written.
 *
 * WHAT CAN ACTUALLY REACH THESE VARIABLES, per route, re-derived against the
 * global providers and the controllers together (#1102 review, B1 and B2):
 *
 *   POST /api/account/tokens — the mint sheet. 400 for each of the five
 *     sentences `personal-token.service.ts` writes for this exact spot; 500 for
 *     a store that threw. 403 from `TeamAccessGuard` (see below), which is the
 *     ONLY 403 here: `HumanOnlyGuard` and `RequiredScopesGuard` refuse a SCOPED
 *     actor and a browser session is not one, `CapabilityGuard` passes a route
 *     whose `@Writes()` declares nothing, and `GithubPrincipalGuard` does not
 *     cover /api/account. The 503 `personal-token.repository.ts` answers a board
 *     with no database is real and unreachable from the sheet: that page has
 *     replaced its whole body and has no New token button.
 *
 *   DELETE /api/account/clients/:id — the revoke on a grant row. 404 "No such
 *     connected client." when the grant is already gone; 500 for a store that
 *     threw. The same single 403 producer as above.
 *
 *   PUT /api/admin/identity — the identity edit dialog. 400 for each of the
 *     fifteen sentences `identity.validation.ts` writes, 409 for the two
 *     `identity.controller.ts` refuses the board's own governance with — so
 *     seventeen service sentences reach this dialog, counted off
 *     `board-service/scripts/message-gate/answered.tsv`, which is the repo's own
 *     inventory of them. 503 twice over, from two different places: the roster
 *     is a fixture and cannot be edited, and `AdminGuard` answering
 *     `ADMINS_UNREAD_REFUSAL` with a machine code when the board has never once
 *     read its admin roster. 500 for a store that threw. And 403 from TWO
 *     producers, `TeamAccessGuard` and then `AdminGuard`, in that order.
 *
 *   all three — 401 whenever the session ended, raised by `apiFetch` before the
 *     status is read. And `WithdrawnReadError`, which is the board pulling its
 *     OWN request: `forgetPayloads` moves the cache generation on a sign-out, a
 *     Github disconnect and an expired session, and a write already in flight
 *     when that happens is rejected without anybody knowing whether it landed.
 */

/**
 * WHY A 403 IS TWO DIFFERENT ANSWERS HERE, and what tells them apart.
 *
 * `TeamAccessGuard` (`team-access.guard.ts:58`) answers
 * `403 Access restricted to the Acme team (…)` whenever `isMember` is false,
 * and `DirectoryGroupMembership.isMember` FAILS CLOSED WITHOUT CACHING on any
 * Directory error — a `LEG_TIMEOUT_MS` abort, a JWT mint that threw, a 200 from
 * something that was not Google. Its own comment says why: "A failure is not an
 * answer about anyone's membership […] The next request asks again." So the
 * common 403 on a fully loaded page is TRANSIENT. The page behind it is fine,
 * one write was refused, and the very next press asks Google again and lands.
 * Calling that permanent and withdrawing the control is worse than saying
 * nothing: it is a recoverable failure dressed as a final one, over a button
 * the reader can no longer press.
 *
 * Nothing on the wire separates that from a person genuinely dropped from the
 * team group, and nothing can: the guard is answering `isMember === false` in
 * both, and the service declines to read the error to tell them apart, on
 * purpose (`directory.membership.ts:121`). So the board does not guess. That
 * whole class is `access-unconfirmed`, the control stays armed, and the
 * sentence says the check refused it and also refuses that way when it cannot
 * run at all.
 *
 * `AdminGuard` (`admin.guard.ts:72`) is the one 403 the board CAN place. It
 * answers `admin access required` only after the admin roster was read
 * successfully and the caller was not in it — an unread roster is the 503 above,
 * not this — so it is a stated verdict on a stable fact, and a second press gets
 * it again. `adminCache.invalidate()` on a role write makes it immediate, which
 * is how an admin editing a person meets it: their own role was taken away while
 * this dialog stood open.
 *
 * The discriminator is the SERVER's own sentence on the body, read through
 * `ApiError.serverMessage` (#714) — which exists for exactly this, and which
 * `scope-copy.ts` already uses to tell the org gate's verdict from an outage on
 * a shared status. It is not a guess about prose: `answered.tsv` is a gated
 * inventory of every sentence this service can answer with, and CI fails a
 * change to one that is not re-recorded. A body the board cannot read, or one
 * carrying any other words — an ingress page, a proxy's own 403 — is not placed,
 * which leaves the control armed. That is the safe direction to fall in: the
 * cost of a wrong `access-unconfirmed` is one press that gets the same answer,
 * and the cost of a wrong `refused` is a write the person could have completed.
 *
 * None of the three routes above carries a machine `reason`, which is why this
 * reads the sentence instead.
 */

/**
 * AND THE SAME READING FOR 503, which the first two rounds did not do.
 *
 * "Start at the global providers" was applied to 403 alone. The same five
 * `APP_GUARD`s answer 503 on all three routes, before any handler runs, and
 * four of those 503s are explicitly TRANSIENT:
 * `SessionRevocationService:174` when the session store cannot be read, and
 * `GithubUserService` at :300, :312 and :443 when a refresh lease is held on
 * another instance or a discovery ran past its own window. Every one of them
 * carries `ACCESS_NOT_NOW_CODE` in its body, which is the code #1066 added for
 * exactly this reading, and which `projects-last-good.ts:112` already takes on
 * the READ path. Calling them standing withdrew the control and then printed
 * the service's own "retry or reconnect" over it, which is worse than saying
 * nothing and worse than what `origin/main` did (#1102 review, the 503 round).
 *
 * So the code is the discriminator here, the way the sentence is on 403, and it
 * is a stronger one: a machine field board-service pins in
 * `auth/access-not-now-code.spec.ts`, not prose.
 *
 * WHICH 503 REACHES THESE THREE ROUTES, all of it re-derived rather than
 * carried over:
 *
 *   coded `access_not_now` — the four above. `not-now`, armed, and the sentence
 *     is the surface's own. That was first written as "a log phrase on a screen
 *     is the whole of #1079", and #1083 has since rewritten all four FOR a
 *     reader — "The board cannot confirm your sign-in right now. Try again in a
 *     moment." — so the reason has to be the one that survives that rewrite,
 *     and it does: none of them can say which write was refused. They are the
 *     same words whichever of the three routes they answer, and "the token
 *     wasn't created" is the half the reader is standing in front of.
 *   coded `admins_unread` — `AdminGuard`, identity route only, and the one 503
 *     sentence here that names the reader's own situation rather than the
 *     board's. `standing`, withdrawn, and its words are repeated because the
 *     code places them.
 *   uncoded — two of them, and they pull in opposite directions. The roster
 *     fixture's "This board is reading a fixed roster, so it cannot be edited
 *     here." is a 503 sentence the service wrote for this dialog, and it agrees
 *     with the withdrawal. `GithubUserService:245`'s "Your GitHub connection
 *     changed while this was running. Try again." is board-service's own
 *     classification of a withdrawal, and its own words ask for a press this arm
 *     has just removed. So `standing` repeats a 503's sentence only where the
 *     board can PLACE it — by the code, or by `FIXED_ROSTER` below — and says
 *     nothing otherwise. Falling to the surface's own sentence is the safe
 *     direction: it claims nothing the board cannot stand behind, and the arming
 *     does not move either way.
 *
 *   `GithubExpiryInterceptor`'s two 503s reach no write: it returns early
 *     unless `req.method === 'GET'`. `GithubUserService:357`'s reaches none
 *     either, because the guard asks for headroom only on a GET and the sync
 *     POST, and `principal` returns before that throw when the headroom is 0.
 */

/** What a failed write was, as far as the board can honestly tell. */
export type WriteFailureKind =
  /** The session ended under it. The bar over the page says the rest. */
  | 'session-ended'
  /** The service refused it, and the board can name which refusal. A second
   *  press is answered the same way. */
  | 'refused'
  /** A 403 the board cannot place: refused, or the access check could not be
   *  run and failed closed. A second press may well land. */
  | 'access-unconfirmed'
  /** The board dropped its own request, so it cannot say whether this landed. */
  | 'interrupted'
  /** The service described a standing condition — the row is gone, the roster is
   *  a fixture, the board has no database. The same press is answered the same
   *  way until that changes. */
  | 'standing'
  /** The auth layer could not establish who the reader is JUST NOW, and said so
   *  in a machine code. Nothing about their access changed and nothing they can
   *  do fixes it; it clears on its own, so the control stays armed. */
  | 'not-now'
  /** Everything else: the service said what is wrong with the payload, or
   *  nobody knows. Either way a second press is worth offering. */
  | 'failed';

/**
 * Whether the control that caused the write may stay armed under each kind.
 * False withdraws it: nothing the person can do from that control clears the
 * failure, so offering the press again is a promise the service will break.
 *
 * It is a table on the KIND, and not a third value computed beside the kind, so
 * that the sentence and the button cannot disagree. They did: the first cut let
 * `writeFailure` decide arming from the status while each surface wrote its
 * sentence from the kind alone, and a 404 with no body came out as a withdrawn
 * Revoke under a line ending "Try again." (#1102 review, B3 and S1).
 */
const MAY_PRESS_AGAIN: Record<WriteFailureKind, boolean> = {
  'session-ended': false,
  refused: false,
  'access-unconfirmed': true,
  interrupted: false,
  standing: false,
  'not-now': true,
  failed: true,
};

export interface WriteFailure {
  kind: WriteFailureKind;
  /**
   * The service's own sentence, on the statuses where it is writing for the
   * reader rather than for a log. Null everywhere else, including a 500, whose
   * body carries Nest's "Internal server error" and is exactly the kind of
   * string this issue exists to keep off a screen. Null too whenever the body
   * could not be read at all, which is a body an ingress wrote; the surface's
   * own sentence for the kind stands in, and the arming does not move.
   */
  serverSaid: string | null;
  /** `MAY_PRESS_AGAIN[kind]`, carried so no call site re-derives it. */
  retry: boolean;
}

/** The service is telling the reader what is wrong with what they sent. Editing
 *  the form and pressing again is the way out, so the control stays armed. */
const ABOUT_THE_PAYLOAD = new Set([400, 409]);
/** The service is describing a standing condition — the row is gone, the roster
 *  is a fixture. The same press is answered the same way, so it is withdrawn.
 *  503 is read before this set rather than out of it, because on these routes
 *  four of its verdicts are not standing at all. */
const ABOUT_THE_BOARD = new Set([404, 503]);

/** `AdminGuard`'s refusal, word for word (`admin.guard.ts:72`, and row 36 of
 *  `answered.tsv`). The one 403 sentence on these three routes that names a
 *  verdict the board may repeat to a reader. */
export const ADMIN_ACCESS_REQUIRED = 'admin access required';

/**
 * `fixture-identity.repository.ts`'s 503, word for word — the ONE 503 sentence
 * these three routes can send that the service wrote for a reader rather than
 * for a log. `answered.tsv` says so in a column: it is the only 503 row there
 * marked `screen`, and every other one, including all four `access_not_now`
 * sentences, is marked `answer`.
 *
 * Placed on the sentence and not on a code because it has none — this is the
 * same mechanism and the same justification as `ADMIN_ACCESS_REQUIRED` above,
 * on a gated inventory CI fails a silent change to. An exact match, because
 * nothing is interpolated into it. Give that 503 a machine code in board-service
 * and this constant retires.
 */
export const FIXED_ROSTER = 'This board is reading a fixed roster, so it cannot be edited here.';

export function writeFailure(err: unknown): WriteFailure {
  const say = (kind: WriteFailureKind, serverSaid: string | null = null): WriteFailure =>
    ({ kind, serverSaid, retry: MAY_PRESS_AGAIN[kind] });
  // First, because it is an ApiError too and none of the tests below are true
  // of it: a withdrawal sits on top of a request that may well have succeeded.
  if (withdrawnRead(err)) return say('interrupted');
  // Not an ApiError at all: the network, or an answer this side could not read.
  // Nothing here says the write was refused, so the offer stands.
  if (!(err instanceof ApiError)) return say('failed');
  if (err.message === 'unauthenticated') return say('session-ended');
  const words = err.serverMessage?.trim() || null;
  if (err.status === 403) {
    return words?.includes(ADMIN_ACCESS_REQUIRED) ? say('refused') : say('access-unconfirmed');
  }
  // The status decides the arming; the body only decides whether the service's
  // own sentence is available to print. The two used to be one test, which put
  // an unreadable 404 or 503 body on the armed default (#1102 review, S1).
  if (ABOUT_THE_PAYLOAD.has(err.status)) return say('failed', words);
  // A 503, read through the code the auth layer puts beside its message. Before
  // the status table, because the status alone answers for four transient
  // verdicts and two standing ones here (see the header).
  if (err.status === 503) {
    if (err.code === ACCESS_NOT_NOW_CODE) return say('not-now');
    // And on the withdrawing half, the sentence is repeated only where the
    // board can place it. Otherwise `Your GitHub connection changed while this
    // was running. Try again.` prints over a Save that is already gone, which
    // is the fault this round is about wearing its other face.
    const placed = err.code === ADMINS_UNREAD_CODE || words === FIXED_ROSTER;
    return say('standing', placed ? words : null);
  }
  if (ABOUT_THE_BOARD.has(err.status)) return say('standing', words);
  return say('failed');
}

/** The developer's half: what the write actually answered. Called from the
 *  handler that caught the rejection, never from a render. */
export function logWriteFailure(subject: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  const said = err instanceof ApiError ? err.serverMessage : undefined;
  console.warn(`write failed: ${subject}: ${detail}${said ? ` (${said})` : ''}`);
}
