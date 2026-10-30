/**
 * The Projects rollup's saved copy, and when a page may draw it (#1035).
 *
 * The storage half is `keepSaved` / `readSaved` in `cache/payload-cache.ts`,
 * which says why the copy has to live outside the permission wipe. This file is
 * the policy half. Which failures it answers and how old it may be follow the
 * service's own copy of the same payload
 * (`board-service/src/projects/projects-last-good.ts`, #1003), so the two sides
 * agree about when a held board may stand in. One difference: the service also
 * drops its copy after a write or Sync now. This one is replaced by the next
 * successful read instead, and the note over it says how old it is.
 */
import { ApiError } from '../api/core';
import type { ProjectDetail, ProjectSummary } from '../api/projects';
import { currentResponseIdentity } from '../auth/response-deadline';
import { sessionUnverified } from '../auth/session-hint';
import {
  currentPayloadGeneration, currentSensitiveGeneration, forgetProjectsPayloads, forgetSavedCopies, keepSaved, projectKey, projectsKey, readSaved,
  type Saved, type SavedKey,
} from '../cache/payload-cache';

/**
 * How old a saved copy may be and still be drawn: two hours, the service's own
 * `PROJECTS_LAST_GOOD_MAX_MS` default. Github's quota refills hourly, so this
 * outlasts a whole cooldown with room over, which is the outage it is for.
 * Past it, a completion figure is more likely to mislead than to help, and the
 * disabled strip is the more honest answer. It is the one ceiling for every
 * saved copy, the Overview tiles' too (#1046), so no two surfaces disagree
 * about how old is too old.
 */
export const SAVED_COPY_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * The code board-api puts on the one 503 this copy may answer:
 * `ProjectsService.perOrg` found every org's read refused by Github as "not
 * now", a quota cooldown the usual case. Must match `PROJECTS_NOT_NOW_CODE` in
 * board-service's `projects/projects-last-good.ts`.
 */
export const PROJECTS_NOT_NOW_CODE = 'projects_not_now';

/**
 * The code board-api puts on a 503 from the AUTH LAYER that means "keep what
 * you have, ask again later" (#1066): a credential refresh in flight on another
 * instance, an access check with too little of its window left to start a long
 * read on, a discovery that ran past its own window, a session store that could
 * not be read. None of those is about the reader's access, and none of them is
 * about the surface that was asked for — they are thrown before any read runs,
 * which is why one code covers every read rather than each read owning its own.
 *
 * Every other 503 out of that layer is a withdrawal and stays uncoded, so this
 * carries no more than the coded read failures below do. The five sites that
 * may send it are pinned in board-service by `auth/access-not-now-code.spec.ts`.
 * Must match `ACCESS_NOT_NOW_CODE` in board-service's `auth/access-not-now.ts`.
 *
 * IT IS THE ONE SERVABLE FAILURE WHOSE IDENTITY WAS NOT RE-VERIFIED, and
 * whoever widens what may be drawn over it should know that before they do
 * (#1073 review, SF4). A saved copy is safe because `readSaved` refuses one
 * whose `seen` is not `currentResponseIdentity()`, and that identity is written
 * in one place: `api.ts`, off a `/api/auth/me` that answered. Three of the five
 * sites refuse `/api/auth/me` itself, so while one of them holds, the identity
 * is the last good one rather than a current one — frozen, for as long as the
 * fault lasts, against a copy that may live `SAVED_COPY_MAX_AGE_MS`. One of
 * them, the access check with too little of its window left, is self-sustaining
 * while discovery is slow: a fresh check is admitted only with 40 s of its 60 s
 * left, so a discovery costing more than 20 s refuses, and the next request
 * re-discovers and refuses again.
 *
 * A surface drawing a saved copy while `verified` is false must give this
 * code an identity it can check.
 */
export const ACCESS_NOT_NOW_CODE = 'access_not_now';

/**
 * Whether a failed read WITHDRAWS the copy this reader already has.
 *
 * THREE statuses, and #1395 is the issue that cut the list down to them. Each
 * one is the server answering the question the saved copy stands on — may this
 * person see this — with no.
 *
 *   - **401**: there is no session. `notifySessionExpired` empties the disk on
 *     the first one anyway; this is the same verdict read one layer up.
 *   - **403**: there is a session and it may not see this.
 *   - **404**: there is nothing here to see, under a name the board was holding
 *     data for. An org that moved out of scope answers this way.
 *
 * EVERY OTHER FAILURE IS "NOT NOW", and that is the change. A 500, a 502, a 503
 * coded or bare, a 409, a timeout, a dropped connection: none of them is a
 * server saying this reader may not see this. They say the board could not ask.
 * A copy the reader was already shown stays on their screen, marked stale, and
 * the next read that succeeds replaces it or the next refusal takes it.
 *
 * The rule it replaces was the inverse — an allow-list of four transient
 * failures, with everything else withdrawing — and `transientFailure` below is
 * that list, kept for the one question it is still the answer to. Under the old
 * rule the routine events emptied the cache daily: a cold queue read landing
 * after its 60-second access window is an UNCODED 503 from the expiry
 * interceptor, a deploy is a 500 or a 409 through the proxy, and both deleted
 * the copy and dropped the tab to loading placeholders with no message. #1395
 * collects the measurements. Four earlier issues each fixed one event under the
 * old rule, which is how we learned the rule was the defect.
 *
 * WHAT THIS DOES NOT WEAKEN. A failed read is still never drawn AS DATA — only
 * the reader's own last successful answer is, and only to the reader it was
 * saved for. Identity still governs that: a different person, or a different
 * session for the same person, still takes the whole cache with it
 * (`claimFor`). An answer still ON THE WIRE is still fenced by its response
 * deadline, so one authorized under a visibility key this app has not installed
 * is refused — `validResponseDeadline`, unchanged. (The reader's own SAVED copy
 * is read one key wider, which is `drawableResponseDeadline` and Artur's
 * decision on #1395; that is a separate rule, written where it lives.) What
 * changed here is only which FAILURES count as the server having withdrawn
 * permission, and a 500 never was one.
 */
export function withdrawsRead(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  return e.status === 401 || e.status === 403 || e.status === 404;
}

/**
 * Whether a failed read is one the saved copy may stand in for: anything that is
 * not a withdrawal (#1395). The saved-copy question has one answer, in one
 * place, so no caller can hold a narrower version of it — which is how the rule
 * came apart three times before #1060 put it here.
 *
 * ONE EXCEPTION, and it is not a failure of board-api's at all: a read the hint
 * probe never let run (#1324). Those rejections carry no verdict, so they
 * withdraw nothing — `forgetSavedCopiesOnRefusal` says so — but they must not
 * draw anything either, because nobody has verified who is holding this browser
 * yet. Neither a withdrawal nor servable. The copy waits on the disk for the
 * read that runs once the probe answers.
 */
export function servableFailure(e: unknown): boolean {
  return !withdrawsRead(e) && !sessionUnverified(e);
}

/**
 * Whether a failed read is worth ATTEMPTING AGAIN — a different question, and
 * the only one left that the endpoint's own "not now" code answers.
 *
 * AN ALLOW-LIST of four, the way the service's `servableRefusal` is one. Two
 * say board-api did not answer at all: a dropped connection (fetch rejects with
 * a `TypeError`), and a 502 with nothing from board-api in its body, which is
 * Caddy (`deploy/Caddyfile.platform`) with no upstream to reach. That is what a
 * board-api deploy looks like in production, and Caddy stands in front of every
 * `/api` read, so these two hold whichever read failed. The third is the 503
 * board-api codes as "not now" on THIS read. `code` is that read's own: the
 * Projects rollup's by default, and `ISSUES_NOT_NOW_CODE` for the Overview
 * tiles' queue and metrics (#1046). One read's code on another read's answer is
 * not a verdict that read's server reached, so it is not this read's "try again".
 *
 * The fourth is `ACCESS_NOT_NOW_CODE` (#1066), and it is the one code every read
 * takes. It comes from the auth layer, before any read has run, so it cannot
 * name a surface and no read has a version of it to own.
 *
 * NOT a bare 503, and not a 500. Both are real faults that a retry loop against
 * them turns into load on a server already in trouble — board-api answers 503
 * from the expiry interceptor, the Github principal guard and an unreadable
 * session store. They keep the saved copy now (`servableFailure` above), which
 * is what the reader needed from them; a retry is what the server needs us not
 * to do. Nor 408, 429 or 504: board-api sends none of them on this read.
 */
export function transientFailure(e: unknown, code: string | null = PROJECTS_NOT_NOW_CODE): boolean {
  if (e instanceof TypeError) return true;
  if (!(e instanceof ApiError)) return false;
  if (e.status === 502) return e.serverMessage === undefined && e.code === undefined;
  return e.status === 503 && ((code !== null && e.code === code) || e.code === ACCESS_NOT_NOW_CODE);
}

/**
 * The same question for a BOARD PAGE'S OWN READ, `/api/projects/:number`
 * (#1065, and the code it was missing, #1107).
 *
 * Every read takes a `code` because the "not now" verdict is the read's own,
 * and until #1107 this read had none: the board's detail went through
 * `ProjectsService.detailInScope`, which walked the scope itself and threw a
 * bare `Error` when every org failed, so a browser met a quota cooldown here as
 * an uncoded 500 — the same answer a Github FORBIDDEN arrives as. #1065 read
 * that honestly and cleared the board, which reversed #1003 on this one page:
 * everywhere else a cooldown leaves Projects drawn.
 *
 * Board-api ends the tie rather than this file guessing at it. Both reads throw
 * through `ProjectsService.totalFailure` now, so a total failure that says "not
 * now" is a 503 carrying `PROJECTS_NOT_NOW_CODE` on the board read as much as on
 * the rollup, and `board-service/src/projects/projects-not-now-code.spec.ts`
 * pins the code to that one method and both reads to that one call. So this
 * read's own code IS the default, and the wrapper stays for the name: the board
 * page's rule has one place to be read, and the day the two reads carry
 * different codes it is the line that has to change.
 *
 * THE DEPLOY WINDOW IS STILL ITS OWN CASE, and it cannot be anything else.
 * Caddy's empty 502 is `deploy/Caddyfile.platform`'s `reverse_proxy` with no
 * upstream to reach: board-api never ran, so there is no body for board-api to
 * put a code in. A code says which verdict a server reached; that 502 says no
 * server reached one. `servableFailure`'s own 502 arm is the whole of it, and
 * what makes it safe is the same fact — an EMPTY body, with no message and no
 * code, is the one thing board-api itself never sends.
 */
export function servableBoardFailure(e: unknown): boolean {
  return servableFailure(e);
}

/**
 * A saved copy recalled by a failed read, with what it was recalled under: the
 * org it is for, and the two cache generations. A wipe of either kind moves a
 * generation, and a copy recalled before it is not drawn after it.
 */
export type Recalled<T> = Saved<T> & { org: string | null; generation: number; sensitive: number };
export type RecalledProjects = Recalled<ProjectSummary[]>;

/** Save a live answer for this org. Not one the service answered from ITS
 *  copy: that is old already, and saving it would stamp it as read now. */
export function saveProjects(org: string | null, projects: ProjectSummary[]): void {
  if (projects.some((p) => p.lastGoodCopy === true)) return;
  keepSaved(projectsKey(org), projects);
}

/**
 * The saved copy under `key` for a failed read, or null when there is none
 * inside the ceiling or this failure withdrew it.
 *
 * A failure that may not fall back on it also DELETES it (#1042 review). Only a
 * 403 and an org 404 used to, as a withdrawal. A Github FORBIDDEN reaches the
 * browser as a 500, though, so a 500 left the copy on the disk, and the next
 * coded 503 inside the two hours drew it again over a board the refusal had
 * just withheld. Every refusal still ends it — the list of what counts as one
 * is `withdrawsRead`'s, which #1395 cut to 401, 403 and 404.
 *
 * And it deletes EVERY saved copy, not `key`'s alone (#1042 round 3). The union
 * copy `/` draws holds acme's boards too, so a 403 on /acme that
 * took only `projects:acme` left them for the next coded 503 on `/`. The
 * Overview's union queue holds every org's issues the same way (#1046), so a
 * refusal on any of these reads takes the Projects copies and the tiles' alike.
 *
 * It is here, once, and not in each caller, because a caller that forgot it
 * would keep a copy a refusal had already ruled out (#1046). A copy `accept`
 * refuses, or one past the ceiling, is deleted as well, by `readSaved`: kept, it
 * would be read and refused again at every failure until the next save.
 *
 * NO `code` SINCE #1395. The endpoint's own "not now" code decided which 503
 * kept the copy while the rule was an allow-list of transient failures; now
 * every non-withdrawal keeps it, so the code answers nothing here. It is still
 * the retry question's, and `transientFailure` still takes it.
 */
export function recallSaved<T>(
  key: SavedKey, org: string | null, e: unknown, accept: (v: unknown) => boolean,
): Recalled<T> | null {
  if (withdrawsRead(e)) {
    forgetSavedCopiesOnRefusal(e);
    return null;
  }
  // A READ THE PROBE NEVER LET RUN TOUCHES NOTHING (#1324), and it has to be
  // said here rather than left to `servableFailure`. The withdrawal question
  // above is `withdrawsRead`'s, and that one cannot see an unverified session —
  // so without this line the rejection falls through to `readSaved`, which
  // DELETES a copy it refuses. Nobody has verified who is holding this browser,
  // so the copy is not readable yet and `readSaved` would refuse it, and the one
  // transient 503 on `/api/auth/me` that #1324 is about would empty the disk
  // again. The copy waits for the read that runs once the probe answers.
  if (sessionUnverified(e)) return null;
  const saved = readSaved<T>(key, SAVED_COPY_MAX_AGE_MS, accept);
  return saved === null ? null
    : { ...saved, org, generation: currentPayloadGeneration(), sensitive: currentSensitiveGeneration() };
}

/**
 * A refusal deletes every saved copy, including those other pages saved.
 *
 * A READ THE PROBE NEVER LET RUN IS NOT ONE (#1324). While the session hint
 * holds a paint window open, every read waits on `/api/auth/me`, and a probe
 * that does not verify rejects all of them at once. Those rejections carry no
 * verdict — nothing reached board-api — and `probeMe` has already said what a
 * failed probe costs the disk: below 500 it wipes everything, and at 500 and
 * above it wipes nothing, because there the server said nothing about who is
 * holding this browser. Read as refusals, they deleted the copies that arm had
 * just decided to keep, so one transient 503 on the probe emptied the disk and
 * the next cooled-down rollup drew the disabled strip over a reader who had
 * seen their boards a minute earlier.
 *
 * Only the delete is withheld. `servableFailure` is unchanged, so nothing is
 * drawn over an unverified session either: the page holds no boards, and the
 * copy waits on the disk for the read that runs once the probe answers.
 */
export function forgetSavedCopiesOnRefusal(e: unknown): void {
  // The unverified rejection is already out: it is not an `ApiError`, so
  // `withdrawsRead` is false for it. Asked by name anyway, because this is the
  // rule #1324 is about and a reader of it should not have to work out that the
  // other predicate happens to cover it.
  if (withdrawsRead(e) && !sessionUnverified(e)) forgetSavedCopies();
}

/** The Projects rollup's saved copy for a failed read. */
export function savedProjects(org: string | null, e: unknown): RecalledProjects | null {
  return recallSaved<ProjectSummary[]>(projectsKey(org), org, e, Array.isArray);
}

/**
 * What a failed rollup read leaves a page with.
 *
 * Both halves of one question, answered together because asking it twice is how
 * the two came apart (#1060).
 */
export interface AfterFailedProjects {
  /** Whether the boards the page ALREADY has on screen may stay. */
  keepHeld: boolean;
  /** The saved copy to draw when it has none, or null when there is none inside
   *  the ceiling or this failure may not fall back on one. */
  saved: RecalledProjects | null;
}

/**
 * The one thing a page asks after its rollup read failed (#1060).
 *
 * The saved copy has been drawn only for a `servableFailure` since #1035. The
 * boards a page was already HOLDING came off on a narrower question — was this
 * a withdrawal, a 403 or an org 404 — so every other refusal left them on
 * screen with an outdated-data notice. A Github FORBIDDEN reaches the
 * browser as a 500, which is not a withdrawal by that reading, so a reader
 * whose access had just been taken away went on reading the boards on a page
 * they already had open. The stored copy behind them was forgotten on the same
 * narrow question, which was the rule written a third time.
 *
 * One rule now, and it is this file's. A refusal takes the boards on screen and
 * every copy of them on the disk, stored and saved, under any org's key. A
 * failure that says "not now" takes none of them.
 *
 * EVERY org's, not this read's alone, for the reason #1042's third round gave
 * about the saved copies: the union copy `/` draws holds acme's boards
 * too. A 500 on /acme that took only `projects:acme` left them in
 * `projects`, and a reader who moved back to `/` inside the same document and
 * met a coded 503 there was shown them again. The page-load wipe was the bound
 * the narrow forget was written under, and a navigation is not a page load.
 */
export function projectsAfterFailure(org: string | null, e: unknown): AfterFailedProjects {
  const saved = savedProjects(org, e);
  if (servableFailure(e)) return { keepHeld: true, saved };
  forgetProjectsPayloads();
  return { keepHeld: false, saved: null };
}

/**
 * The copy a render may draw, or null. Asked during render, the way
 * `useCachedState` asks its own `staleSensitive`, because the page can change
 * under a recalled copy before the next paint: the org moved, a check reported
 * different Github access, an expired check dropped the permission-sensitive
 * answers, or a sign-out or a 401 wiped the store. Any of those, and the copy
 * waits for the next failed read to recall it again, if it still may.
 */
export function drawable<T>(saved: Recalled<T> | null, org: string | null): Recalled<T> | null {
  return saved !== null && saved.org === org && saved.seen === currentResponseIdentity()
    && saved.generation === currentPayloadGeneration() && saved.sensitive === currentSensitiveGeneration()
    ? saved : null;
}

function ago(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'} ago`;
}

/**
 * A BOARD'S own saved copy (#1249), on the rollup's terms above.
 *
 * `/projects/:number` was the one cached surface with no saved copy at all, and
 * #1243 is what made the hole visible rather than what dug it. Until then a walk
 * back to a board during an outage repainted it out of `board_payload:projects/7`
 * and a RELOAD never did, because that key is an `isSensitivePayloadKey` entry
 * and the mount wipe takes it. #1243 made the seed ask the wipe's own question,
 * so both routes lost it together. The owner's decision on #1249 is that the
 * board gets what every other cached page has instead.
 *
 * Saved on exactly the rollup's terms and read back on exactly the rollup's
 * terms, through the same two functions, so there is no second rule for one
 * page to drift on. What is board-specific is only this: the key is one board's
 * address, and the shape test below is one board's.
 */

/**
 * Whether a saved entry can be drawn as THIS board.
 *
 * The address is checked against the copy rather than trusted from the key,
 * which is the same rule `heldHeader` gives for the rollup and for the same
 * reason: a Projects v2 number is unique only within an org (#697), and a key
 * written before an org was in it names a board this deployment may now resolve
 * somewhere else. A copy that does not SAY it is board `number` is a copy that
 * cannot be proven, not one that may be assumed.
 *
 * `items` must be an ARRAY and is not defaulted. "No issues on this board" is a
 * sentence the page says off `items.length === 0`, and a copy whose items field
 * went missing across a deploy would say it to a reader whose board is full —
 * the false zero #714 took a whole page down for, and the shape #1216 shipped on
 * the Repos grid when a failed read drew a chart asserting zero activity.
 */
export function savedBoardShape(number: number): (v: unknown) => boolean {
  return (v: unknown): boolean => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
    const row = v as Record<string, unknown>;
    return row.number === number
      && typeof row.name === 'string' && row.name !== ''
      && typeof row.url === 'string' && row.url !== ''
      && typeof row.pct === 'number' && Number.isFinite(row.pct)
      && Array.isArray(row.items);
  };
}

/**
 * Save a board a live read just answered. Not one the service answered from ITS
 * copy, for `saveProjects`' reason: that is old already, and saving it would
 * stamp it as read now.
 *
 * This is the board's only disk copy. The hook keeps the live answer in memory
 * but does not persist it: arrival cannot seed a permission-sensitive board.
 * Quota eviction leaves saved copies alone, so a failed write retains the
 * previous fallback rather than discarding it to make room.
 */
export function saveBoard(number: number, org: string | null, detail: ProjectDetail): void {
  if (detail.lastGoodCopy === true) return;
  if (!savedBoardShape(number)(detail)) return;
  keepSaved(projectKey(number, org), detail);
}

/** This board's saved copy for a failed read, or null. */
export function savedBoard(number: number, org: string | null, e: unknown): Recalled<ProjectDetail> | null {
  return recallSaved<ProjectDetail>(projectKey(number, org), org, e, savedBoardShape(number));
}

/**
 * The ROLLUP'S saved copy, for a board that has none of its own (#1249).
 *
 * This is what makes `held-header.ts` reachable again, which is item 2 of
 * #1249. Both entries in turn and never merged, the way the page read the
 * stored rollup before: the rollup is saved under the org the READER'S ADDRESS
 * narrowed to, and the app's own board links are org-qualified off the row, so
 * an unnarrowed `/team` saves `projects` while its rows point at
 * `/acme/projects/7`, which reads `projects:acme` and finds nothing.
 *
 * Both are recalled under the PAGE's org rather than under the key's, because
 * `drawable` asks "is this still the org on screen" and the answer for either
 * entry is this page's address. Which key it came off decides nothing later.
 */
export function savedBoardRollup(org: string | null, e: unknown): RecalledProjects | null {
  return recallSaved<ProjectSummary[]>(projectsKey(org), org, e, Array.isArray)
    ?? recallSaved<ProjectSummary[]>(projectsKey(null), org, e, Array.isArray);
}

/** The read failed without a copy to draw. */
export const BOARD_UNREADABLE = 'This board couldn’t be read just now.';

/** Which authority the board on screen has. `saved` covers both copies a
 *  failed read can leave drawn: the whole board out of its own saved entry, and
 *  the header alone out of the rollup's. `loading` is the board that has no
 *  answer YET, which wears a mark of its own for the reason `boardMark` gives. */
export type BoardSource = 'live' | 'loading' | 'saved' | 'unreadable';

/** What the mark slot beside the board's heading holds (#1249). */
export interface BoardMark {
  /** The word or two a reader sees. */
  text: string;
  /** What a screen reader is told instead, where the words on screen are the
   *  short form of a longer sentence. Absent when the text says the whole
   *  thing, which is the loading mark: the page's own `aria-busy` region
   *  already names the wait, and a second copy of those words would be said
   *  twice. */
  label?: string;
  /** A read is still in flight. The placeholders under this mark pulse, and
   *  everything else this mark can say means they must hold still. */
  pending: boolean;
}

/**
 * The MARK a board page wears, or null when the board is live (#1249).
 *
 * A mark and not a line of prose. The board settled this vocabulary on the
 * Overview cards in #1236 — a word beside the heading, `Loading`, `Saved copy`
 * or `Unavailable`, over placeholders that pulse while a read is pending and
 * hold STILL when it failed — and the owner's standing instruction for this
 * board is that a sentence describing the block is the wrong shape. So the
 * sentence the three rollup surfaces say is not extended onto a fourth surface:
 * it becomes this mark's ACCESSIBLE NAME, which is where #1236 put it, and a
 * reader on a screen reader is told the same thing in the same words as before.
 *
 * `loading` SAYS THE WORD RATHER THAN LEAVING THE SLOT EMPTY (#1251 review, F2).
 * The pulse used to be the whole of what told a pending read from a failed one
 * for a sighted reader, and `motion-reduce:animate-none` takes the pulse away
 * from a reader who asked for less motion — leaving two identical screens, one
 * of which is waiting for something that is never coming. #1236's own cards do
 * not have that hole: `OldestTile` and `FlowStrip` draw `Loading` beside the
 * caption and `Unavailable` in its place, so the two states differ by TEXT
 * under any motion setting. This is that word, on the board's own mark slot.
 *
 * The age is in the visible text and not only in the name, because a copy with
 * no age reads as current. `at` is null only where there is no saved record to date the board on
 * screen: a refresh that failed over a board this document already had, past
 * the ceiling that would have dated it.
 */
export function boardMark(source: BoardSource, at: number | null, now = Date.now()): BoardMark | null {
  if (source === 'live') return null;
  // No `label`: the skeleton this mark sits in is an `aria-busy` region already
  // named "Loading project", and a status repeating those words would say them
  // twice. What the word is here for is the reader who can see the screen.
  if (source === 'loading') return { text: 'Loading', pending: true };
  if (source === 'unreadable') return { text: 'Unavailable', label: BOARD_UNREADABLE, pending: false };
  return {
    text: at === null ? 'Saved copy' : `Saved copy ${ago(at, now)}`,
    label: at === null ? 'Saved copy' : `Saved copy ${ago(at, now)}`,
    pending: false,
  };
}
