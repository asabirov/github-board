/**
 * Every sentence the board says about the org an ADDRESS narrowed it to (#714).
 *
 * `auth/org-scope-copy.ts` answers a different question — which of the orgs the
 * board was told to read it could not — and it is right for the union, which is
 * still the default. This file is the second half: once `/globex/repos` names
 * one org, three new things are true and none of them had words.
 *
 *   1. Some surfaces cannot narrow at all. `/api/issues/metrics|mine|all`,
 *      `/api/issues/buckets` and `/api/delivery` take no `org` — checked
 *      against the controllers — so their tiles go on counting every org while
 *      the address above them names one. Silently, that is a bigger number than
 *      the scope promises, which is the same class of lie #650 fixed in the
 *      other direction.
 *   2. The address may name an org this board DOES NOT SERVE. `/gtm/repos`, and
 *      a stale bookmark like `/roadmap` that now reads as an org named roadmap.
 *      `repos.controller.ts` and `projects.controller.ts` both answer 404 for
 *      those, and a page that draws its ordinary "unavailable right now" for it
 *      sends the reader to look for an outage that is not there.
 *   3. The org may be one this board SERVES AND COULD NOT READ — a 503 from
 *      under the same gate, or an `unreadable` entry in the session's own org
 *      report. Then every narrowed surface is empty, and an empty page is
 *      indistinguishable from an org with nothing in it (#613, #650).
 *
 * 2 and 3 are one sentence each and they are NOT interchangeable: "this board
 * does not cover X" and "this board covers X and could not read it" send a
 * reader to two different places. The split is `repos.controller.ts`'s own
 * (its `servedOrg` gate 404s, `ReposService` 503s below it) and it is inherited
 * here rather than re-decided.
 *
 * The org is NAMED in every sentence, never called "the org" (#614, #650), and
 * none of them grades what is left (#613) — `scope-copy.spec.ts` sweeps both
 * rules over every string this file can produce.
 *
 * Pure strings, no JSX, so the render and the vocabulary sweep can both hold
 * them — the shape `org-scope-copy.ts` already uses.
 */
import type { OrgReadState } from '../api/types';

/**
 * One thing to say about the selected org, and Github's own words under it when
 * there are any. Same shape `auth/org-scope-copy.ts`'s `OrgScopeCopy` has, so a
 * surface draws either of them the same way.
 */
export interface ScopeNotice {
  notice: string;
  reason: string | null;
}

/**
 * "These counts still cover every org."
 *
 * `subjects` is what the page draws — "Issues and Throughput" on the flow strip,
 * the four bucket labels on the Overview tiles. Dropped entirely for the union,
 * where nothing has been narrowed and there is nothing to warn about.
 */
export function unnarrowedSentence(org: string | null, subjects: string): string | null {
  if (org === null) return null;
  return `${subjects} count every org, not just ${org}.`;
}

/** The same fact as a qualifier, for a hover that has room for one. Null on the
 *  union, where nothing was narrowed and there is nothing to qualify. */
export function unnarrowedCountNote(org: string | null): string | null {
  return org === null ? null : `Every org, not just ${org}.`;
}

/**
 * A narrowed read that WORKED and came back with nothing (#714).
 *
 * The one state where narrowing succeeded and produced a different answer from
 * the union's, and the one that used to draw the union's own string — `No
 * project boards yet.` on `/globex/projects`, which reads as a board with no
 * boards anywhere. The org is named, as it is in every other sentence here
 * (#614, #650), and nothing grades what is left (#613): an org with no boards
 * is not a quiet org, it is an org with no boards.
 *
 * The union's sentence is byte-identical to what it has always been, which is
 * the promise every unscoped surface makes.
 */
export function emptyScopeSentence(org: string | null, plural: string): string {
  return org === null ? `No ${plural} yet.` : `No ${plural} in ${org} yet.`;
}

/** An org the board serves and could not read. One wording, whether that was
 *  learned from a 503 or from the session's org report — see `refusedScopeCopy`. */
const unreadSentence = (org: string) =>
  `The board could not read ${org}, so no count here contains its work.`;

/** An org this board does not serve at all. Deliberately not `unreadSentence`'s
 *  words: nothing failed, and there is nothing to come back and retry. */
const unservedSentence = (org: string) =>
  `This board does not cover ${org}, so no count here contains its work.`;

/**
 * What a narrowed read was refused with: the status, and the server's own
 * message when the body carried one (#714).
 *
 * Both halves are needed and neither is enough. The status says WHICH refusal;
 * the message says whether it came from the org gate at all.
 */
export interface ScopeRefusal {
  status: number;
  message: string | null;
  /** The server's machine code, when its body carried one (#1046). A coded
   *  refusal is a verdict of its own and never the org gate's. */
  code?: string;
}

/** Whether a server message is ABOUT the org that was asked for.
 *
 *  The two refusals the org gate produces both name it — `unknown org gtm` from
 *  `servedOrg`, `the repo listing for gtm could not be read` from the service
 *  under it — and that is the only thing in the answer that identifies the gate.
 *  A reverse proxy with no healthy upstream, a rolling deploy and a misrouted
 *  `/api/*` all answer 404 or 503 naming nothing, and telling a reader "this
 *  board does not cover acme" about an org it serves is a worse lie than
 *  "unavailable right now".
 *
 *  Folded, because Github org names are case-insensitive and the service folds
 *  them too: `?org=Acme` is answered, and refused, about `acme`. */
function namesOrg(message: string | null, org: string): boolean {
  if (message === null) return false;
  return message.toLowerCase().includes(org.trim().toLowerCase());
}

/**
 * What the board answered when a narrowed read was refused.
 *
 * `refusal` is what that read came back with, read off the rejection by
 * `scopeRefusal`. Four things have to hold before this says a word about the
 * ORG: the address named one, the status is one of the two the org gate
 * produces, the server's own message names that org, and the answer carries no
 * code of its own (#1046). Every other failure —
 * a 500, a 403, a dropped connection, a 404 from something that is not this
 * gate — is the page's own to report, and it gets `null` here so the page draws
 * its ordinary outage line instead.
 *
 * Null for the union too: an unscoped read carries no `?org=`, so a 404 from it
 * is about something else entirely.
 */
export function refusedScopeCopy(org: string | null, refusal: ScopeRefusal | null): ScopeNotice | null {
  if (org === null || refusal === null) return null;
  // A refusal the server CODED is not the gate's (#1046). `issues_not_now` is
  // Github's quota, which a saved copy may answer, and "no count here contains
  // its work" drawn over that copy would contradict the figures under it.
  if (refusal.code !== undefined) return null;
  if (!namesOrg(refusal.message, org)) return null;
  if (refusal.status === 404) return { notice: unservedSentence(org), reason: null };
  if (refusal.status === 503) return { notice: unreadSentence(org), reason: null };
  return null;
}

/**
 * Whether a refusal is the board TAKING THIS SCOPE AWAY, rather than failing to
 * fetch it (#860).
 *
 * A surface holding a copy of an org's work — rows on screen, an entry under
 * `board_payload:...` — has to know which of the two it just met, because the
 * answers are opposite. A withdrawal means nothing on this device may go on
 * asserting that org: the copy comes off the page and off the disk. A hiccup
 * means the board still serves the org and this build could not read it, and a
 * copy taken before it is the best thing anybody has — dropping it makes the
 * reload after a transient failure cold as well as blank.
 *
 * Two components were deciding this separately and had drifted apart.
 * `ReposPage` narrowed to a 404 and kept its rows through a 503; `Pulse` asked
 * `refusedScopeCopy` and deleted its stored boards for either, so one outage on
 * `/gtm/team` cost `board_payload:projects:gtm` while the repo map beside it
 * survived the same failure. `refusedScopeCopy` is the wrong predicate for the
 * question — it answers non-null for BOTH of the gate's statuses because both
 * get a sentence, and only one of them is a withdrawal.
 *
 * Two things withdraw a scope, and they are withdrawals from different people:
 *
 *   - **404 through the org gate.** The board does not cover this org. It is
 *     `repos.controller.ts`'s `servedOrg` and `projects.controller.ts` beside
 *     it, and it is withdrawn from everybody. `refusedScopeCopy` is the reading
 *     rather than the status alone, so the message must NAME the org: a proxy
 *     with no upstream and a misrouted `/api/*` also answer 404, about nothing,
 *     and deleting somebody's stored org over one of those is the same lie in
 *     the other direction.
 *   - **403.** The board declines to serve this READER. It draws no sentence at
 *     all — `refusedScopeCopy` answers null for it, so a page standing down on
 *     that verdict does not stand down here — and a copy held under it is the
 *     same assertion by another route. Gated on NEITHER the message nor the
 *     org: this refusal is about the reader, it has no reason to name an org,
 *     and it arrives on the union as readily as on a narrowed address.
 *     `/api/projects` sits behind `JwtAuthGuard` then `TeamAccessGuard`, which
 *     answers 403 for a reader whatever `?org=` says, so the union read reaches
 *     this predicate with `org` null and a copy on disk under `projects`. The
 *     first cut of this function put `org === null` ahead of the 403 arm and
 *     handed that reader their stored boards back — the defect #824 fixed,
 *     reintroduced by the move that was meant to unify the reading (#862
 *     review). The ORDER of the two lines below is the fix, and
 *     `scope-copy.spec.ts` drives the union 403 through it.
 *
 * A 503 is the third thing the gate can say and it is not here: it means the
 * board SERVES this org and its listing failed on this build. That is the
 * hiccup, and it keeps what the device already holds.
 */
export function scopeWithdrawn(org: string | null, refusal: ScopeRefusal | null): boolean {
  if (refusal === null) return false;
  // Ahead of the org guard, and that is the whole of the bullet above: a 403 is
  // about the reader, so the union read meets it too.
  if (refusal.status === 403) return true;
  // The 404 arm needs one, because it is `refusedScopeCopy`'s reading and that
  // reading is "the message names THIS org". A 404 with no org in the address
  // is about something else entirely.
  if (org === null) return false;
  return refusal.status === 404 && refusedScopeCopy(org, refusal) !== null;
}

/**
 * The HTTP status a rejected read carries, or null when it names none.
 *
 * Two spellings, because the fetchers have had both: `ApiError` carries the
 * status as a field (#577), and a bare `Error` names it at the end of its
 * message ("repos 404") — the shape `fetchRepos` and `fetchProjects` threw
 * before this. Reading the field first means the message form is a fallback
 * rather than the contract.
 *
 * Anything else is null, including a number in the message that is not a status
 * at all: a wrong sentence about somebody's org is worse than no sentence.
 */
export function scopeStatus(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const status = (e as { status?: unknown }).status;
  if (typeof status === 'number' && Number.isInteger(status)) return status;
  const message = (e as { message?: unknown }).message;
  if (typeof message !== 'string') return null;
  const m = /(?:^|\s)([1-5]\d\d)$/.exec(message.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The whole refusal a rejected read carries, or null when it names no status.
 *
 * `serverMessage` is what the SERVER said (`ApiError`, #714), never the board's
 * own `message` — which is `repos 404`, names no org, and would make every 404
 * on a `/gtm` page read as the org gate's verdict again.
 */
export function scopeRefusal(e: unknown): ScopeRefusal | null {
  const status = scopeStatus(e);
  if (status === null) return null;
  const said = (e as { serverMessage?: unknown }).serverMessage;
  const code = (e as { code?: unknown }).code;
  return { status, message: typeof said === 'string' ? said : null, ...(typeof code === 'string' ? { code } : {}) };
}

/**
 * What to say when the session's own org report says the selected org is one
 * the board could not read.
 *
 * Not `orgScopeCopy`'s sentence: that one says numbers "leave out" an org, which
 * is true of a union missing a member and reads as a footnote here, where the
 * org is the whole scope. It has to hold on two different pages at once — a
 * narrowed surface showing nothing, and an unnarrowed one showing every OTHER
 * org's work — so it says what is true of both: no count on the page contains
 * this org.
 *
 * `null` for every other case, including an org the session makes no claim about
 * — an empty `orgs` list is a board saying nothing, never a board saying fine.
 */
export function unreadableScopeCopy(
  org: string | null,
  orgs: readonly OrgReadState[],
): ScopeNotice | null {
  if (org === null) return null;
  // Folded: Github org names are case-insensitive and the service folds them,
  // so `/Acme/repos` is answered about `acme` and an exact match
  // here would leave that address with no line at all (#714).
  const folded = org.trim().toLowerCase();
  const state = orgs.find((o) => o.org.trim().toLowerCase() === folded);
  if (!state || state.state !== 'unreadable') return null;
  const reason = state.reason?.trim().replace(/\.$/, '') ?? '';
  return {
    notice: unreadSentence(org),
    reason: reason === '' ? null : `GitHub’s answer: ${reason}.`,
  };
}

/**
 * Every sentence this module can put in front of a person, for one org.
 *
 * Read off the notices' own VALUES rather than a list of function names, so a
 * line added to `ScopeNotice` joins the vocabulary sweep in `scope-copy.spec.ts`
 * by being written and not by somebody remembering to enrol it (#649).
 */
export function scopeSentences(org: string | null, orgs: readonly OrgReadState[]): string[] {
  const gate = (status: number): ScopeRefusal => ({ status, message: `unknown org ${org}` });
  const notices = [
    unreadableScopeCopy(org, orgs),
    refusedScopeCopy(org, gate(404)),
    refusedScopeCopy(org, gate(503)),
  ];
  return [
    unnarrowedSentence(org, 'Issues and Throughput'),
    unnarrowedCountNote(org),
    emptyScopeSentence(org, 'project boards'),
    ...notices.flatMap((n) => (n === null ? [] : Object.values(n))),
  ].filter((s): s is string => typeof s === 'string');
}
