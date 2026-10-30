/**
 * The words the board uses when it could read some of its Github orgs and not
 * others (#650).
 *
 * The case: `GITHUB_ORGS=acme,globex` with globex's grant revoked.
 * acme enumerates, the ingest correctly carries on, and every number on a
 * union surface is now the answer for part of the scope. Silently, that is
 * indistinguishable from globex having had a quiet week — a smaller answer
 * that looks complete.
 *
 * `loadFailureText` above is not reused here, and the reason is that it answers
 * a different question. It is for a surface that FAILED — "Couldn't load X" —
 * and these surfaces did not fail: they loaded, with less in them than their
 * labels promise. Borrowing its sentence would say the page is broken when the
 * page is merely incomplete, and would leave nowhere to name which org is
 * missing.
 *
 * Pure functions, no JSX, so both the render and the vocabulary sweep in
 * `org-scope-copy.spec.ts` can hold them.
 */
import type { OrgReadState } from '../api/types';

/** Every org the board was told to read and could not. */
export function unreadableOrgs(orgs: readonly OrgReadState[]): OrgReadState[] {
  return orgs.filter((o) => o.state === 'unreadable');
}

/**
 * Every line a surface may put on the page about a partly-read scope.
 *
 * `notice` is the sentence that has to be there; `reason` is Github's own words,
 * for a surface with room for a second line. The reason is carried rather than
 * summarised because it is the whole difference between a revoked credential and
 * a Github outage, and the board cannot tell those apart on the reader's behalf.
 */
export interface OrgScopeCopy {
  notice: string;
  reason: string | null;
}

/** "a", "a and b", "a, b and c". */
function join(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What to say about this session's scope, or null when there is nothing to say.
 *
 * Null is the answer for an empty list as much as for an all-read one, and the
 * two are null for DIFFERENT reasons: an all-read list has nothing worth a line,
 * an empty list is a board making no claim at all. Neither may draw a word — see
 * `MeResponse.orgs`. Only an explicit `unreadable` entry produces copy.
 */
export function orgScopeCopy(orgs: readonly OrgReadState[]): OrgScopeCopy | null {
  const missing = unreadableOrgs(orgs);
  if (missing.length === 0) return null;
  const names = missing.map((o) => o.org);
  const them = missing.length === 1 ? 'it' : 'them';
  const withReason = missing.filter((o) => o.reason !== null && o.reason.trim() !== '');
  return {
    notice: `These numbers leave out ${join(names)}. The board could not read ${them}.`,
    reason:
      withReason.length === 0
        ? null
        : `GitHub’s answer: ${withReason
            .map((o) => `${o.org} — ${o.reason!.trim().replace(/\.$/, '')}`)
            .join('; ')}.`,
  };
}

/**
 * Which of an org's reads failed, for an org whose repos ARE on the answer.
 *
 * Two independent reads sit beside a repo row and either can refuse on its own:
 * the org's `dri` ownership property and its three alert lists. `both` is not a
 * third thing, it is the two together — and it is a separate arm because the
 * sentence has to name what is missing, and "something" is not a name.
 */
export type UnreadRead = 'owners' | 'alerts' | 'both';

/** One org whose rows are on the answer with something unread beside them. */
export interface OrgPartlyRead {
  org: string;
  unread: UnreadRead;
}

/** What each arm calls the thing that could not be read, possessive agreeing
 *  with how many orgs are in front of it. */
const WHAT: Record<UnreadRead, (its: string) => string> = {
  owners: (its) => `${its} owners`,
  alerts: (its) => `${its} alerts`,
  both: (its) => `${its} owners or ${its} alerts`,
};

/**
 * The line for orgs whose repos are on the map with something beside them
 * unread (#718) — one sentence per kind of failed read, or none at all.
 *
 * A SECOND sentence, and not a widening of the one above, because the two are
 * about different orgs and only one of them can say "leave out". An org here
 * contributed its rows: the reader is looking at them. Telling that reader the
 * numbers leave the org out is false, and it is the specific falsehood this
 * exists to stop — a page saying an org is missing while three of its repos sit
 * under the sentence.
 *
 * Grouped by kind rather than listed per org, so three orgs whose alerts all
 * refused read as one sentence and not as three. Kinds come out in the order
 * they first appear, which is the order the orgs were served in.
 *
 * The tail is the same tail as `orgScopeCopy`'s, and the possessive follows the
 * same singular/plural rule it uses for `it`/`them`. One voice: the difference
 * between the two lines is what is claimed, never how the board sounds.
 */
export function partlyReadNotices(orgs: readonly OrgPartlyRead[]): string[] {
  const kinds: UnreadRead[] = [];
  for (const { unread } of orgs) if (!kinds.includes(unread)) kinds.push(unread);
  return kinds.map((kind) => {
    const named = orgs.filter((o) => o.unread === kind).map((o) => o.org);
    const its = named.length === 1 ? 'its' : 'their';
    return `The repos are here for ${join(named)}. The board could not read ${WHAT[kind](its)}.`;
  });
}

/**
 * The sentence above this one, for a caller holding org NAMES.
 *
 * The Repos payload lists its lost orgs as bare strings — it carries no per-org
 * reason, so there is no `OrgReadState` to be had — and a page fabricating one
 * to reach this sentence would be a page that knows how the sentence is built.
 * `null` for an empty list, on `orgScopeCopy`'s own terms.
 */
export function missingOrgsNotice(orgs: readonly string[]): string | null {
  return orgScopeCopy(orgs.map((org) => ({ org, state: 'unreadable' as const, reason: null })))?.notice ?? null;
}

/**
 * Every sentence this module can put in front of a person, for one session.
 *
 * Read off `OrgScopeCopy`'s own values rather than a list of function names, so
 * a line added to that shape joins the vocabulary sweep by being written and not
 * by somebody remembering to enrol it (#649).
 */
export function orgScopeSentences(orgs: readonly OrgReadState[]): string[] {
  const copy = orgScopeCopy(orgs);
  if (copy === null) return [];
  return Object.values(copy).filter((v): v is string => typeof v === 'string');
}
