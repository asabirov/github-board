/**
 * When a failed Projects read may draw the saved copy, and what the block says
 * over it (#1035). Pure functions over a fake store: the suite has no DOM and
 * runs no effect, so the page drawing it is checked in a
 * browser, not here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import SOURCE from './projects-last-good.ts?raw';
import { ApiError } from '../api/core';
import type { ProjectDetail, ProjectSummary } from '../api/projects';
import { setResponseIdentity } from '../auth/response-deadline';
import { UnverifiedSessionError } from '../auth/session-hint';
import { ISSUES_NOT_NOW_CODE } from '../team/overview-saved';
import {
  claimFor, currentPayloadGeneration, currentSensitiveGeneration, forgetPayloads, forgetSensitivePayloads,
  keepSaved, projectKey, readPayload, readSaved, projectsKey, setPayloadStore, writePayload, type PayloadStore,
} from '../cache/payload-cache';
import {
  ACCESS_NOT_NOW_CODE, BOARD_UNREADABLE, boardMark, drawable, projectsAfterFailure, PROJECTS_NOT_NOW_CODE,
  forgetSavedCopiesOnRefusal, SAVED_COPY_MAX_AGE_MS, saveBoard, savedBoard, savedBoardRollup, saveProjects, savedProjects,
  servableBoardFailure, servableFailure, transientFailure, withdrawsRead, type RecalledProjects,
} from './projects-last-good';
import { heldHeader } from './held-header';

/** The 503 board-api answers when every org's read was refused as "not now". */
const notNow = () => new ApiError(503, 'projects 503', undefined, undefined, 'GitHub GraphQL quota is cooling down', PROJECTS_NOT_NOW_CODE);
/** The 503 the auth layer answers when it could not establish who the reader is
 *  just now (#1066). Coded, and the code is the same whichever read asked. */
const accessNotNow = (said = 'Your GitHub connection is being renewed. Try again in a moment, or reconnect GitHub if it does not clear.') =>
  new ApiError(503, 'projects 503', undefined, undefined, said, ACCESS_NOT_NOW_CODE);

class MapStore implements PayloadStore {
  readonly map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

const BOARDS = [{ number: 7, name: 'Delivery' }] as unknown as ProjectSummary[];

afterEach(() => {
  setPayloadStore(undefined);
  setResponseIdentity(null, false);
});

describe('a board page’s own read, and the "not now" code it now carries (#1065, #1107)', () => {
  // `/api/projects/:number` threw a bare `Error` when every org in scope failed
  // until #1107, so the browser met a quota cooldown here as an uncoded 500 and
  // cleared the board over it — #1003 says a cooldown leaves Projects drawn.
  // Both Projects reads throw through `ProjectsService.totalFailure` now, and
  // `projects-not-now-code.spec.ts` pins the code to it and both reads to it, so
  // the board read carries the same code the rollup does.
  it('keeps the three failures that are not board-api refusing this reader', () => {
    expect(servableBoardFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(servableBoardFailure(new ApiError(502, 'project 502'))).toBe(true);
    expect(servableBoardFailure(accessNotNow())).toBe(true);
  });

  it('keeps a cooled-down board, which is the whole of #1107', () => {
    expect(servableBoardFailure(notNow())).toBe(true);
    // The same answer the rollup gives it, which is the point: two reads that
    // answered one verdict differently is what #1107 is.
    expect(servableFailure(notNow())).toBe(true);
  });

  it('clears on the three refusals that are about this reader', () => {
    for (const status of [401, 403, 404]) {
      expect(servableBoardFailure(new ApiError(status, `project ${status}`)), String(status)).toBe(false);
    }
  });

  /**
   * #1395 cut this list, and the board page is where the cut is easiest to read.
   *
   * A 500 used to be how a withdrawn Github grant arrived, which is the argument
   * that put it on the clearing side. `ProjectsService.totalFailure` answers 403
   * for that now (#1395), and what is left on a 500 is a null pointer in
   * board-api, a failed Postgres connection or a proxy hiccup during a deploy. A 409 and an uncoded 503 are the same shape of
   * argument. Treating all of them as "this reader may not see this" is what
   * emptied the cache several times a day; a cold queue read that outlives its
   * 60-second access window IS an uncoded 503 from the expiry interceptor, and
   * a deploy is the 500 and the 409.
   *
   * The reader keeps their own last board, marked stale, and the next read
   * settles it. Only 401, 403 and 404 take it, which is the case above.
   */
  it.each([
    ['a 500, board-api failing', new ApiError(500, 'project 500')],
    ['a 409, access changed under the read', new ApiError(409, 'project 409')],
    ['an uncoded 503 from the expiry interceptor', new ApiError(503, 'project 503', undefined, undefined,
      'GitHub access needs rechecking before this view can be shown; retry')],
    ['a 502 carrying board-api’s own words', new ApiError(502, 'project 502', undefined, undefined, 'upstream said no')],
    ['a 502 carrying a code', new ApiError(502, 'project 502', undefined, undefined, undefined, PROJECTS_NOT_NOW_CODE)],
  ])('keeps the board on %s, which says nothing about this reader (#1395)', (_what, failure) => {
    expect(servableBoardFailure(failure)).toBe(true);
  });
});

/**
 * WHICH FAILURES WITHDRAW THE COPY THIS READER ALREADY HAS — `withdrawsRead`,
 * and `servableFailure`, which is its inverse and the question every saved-copy
 * caller asks.
 *
 * #1395 is this list. It had been the inverse: an allow-list of four transient
 * failures kept the copy and EVERYTHING ELSE deleted it, which made the routine
 * events of a working production board — an eight-hourly token refresh, a cold
 * queue read outliving its 60-second access window, several deploys a day —
 * each empty the cache. The complaint was that My work always opens on loading
 * placeholders, and four earlier issues each fixed one of those events under
 * the old rule before we accepted that the rule was the defect.
 *
 * A refusal is the server saying this reader may not see this: 401, 403, 404.
 * Nothing else is, so nothing else deletes.
 */
describe('which failures withdraw the copy this reader already has (#1395)', () => {
  it('only the three that are about the reader', () => {
    for (const status of [401, 403, 404]) {
      expect(withdrawsRead(new ApiError(status, `projects ${status}`)), String(status)).toBe(true);
      expect(servableFailure(new ApiError(status, `projects ${status}`)), String(status)).toBe(false);
    }
  });

  it.each([
    ['a 500', new ApiError(500, 'projects 500')],
    ['a 409, access changed under the read', new ApiError(409, 'Your GitHub access changed; reload this view.')],
    ['an uncoded 503, which is a cold read past its access window', new ApiError(503, 'projects 503', undefined, undefined, 'GitHub access needs rechecking before this view can be shown; retry')],
    ['a coded 503', notNow()],
    ['the auth layer’s shared 503', accessNotNow()],
    ['an empty 502, which is a deploy', new ApiError(502, 'projects 502')],
    ['a 502 carrying board-api’s own words', new ApiError(502, 'projects 502', undefined, undefined, 'upstream said no')],
    ['a 504', new ApiError(504, 'projects 504')],
    ['a 429', new ApiError(429, 'projects 429')],
    ['a dropped connection', new TypeError('Failed to fetch')],
    ['a body this board cannot read', new SyntaxError('Unexpected token')],
    ['something nobody can read', new Error('boom')],
  ])('keeps it through %s', (_what, failure) => {
    expect(withdrawsRead(failure)).toBe(false);
    expect(servableFailure(failure)).toBe(true);
  });

  // A failure is not an ApiError's status alone: a bare Error naming one is not
  // board-api's answer, and reading it as a 403 would delete a copy on the
  // strength of a message.
  it('reads the status off board-api’s own answer and nowhere else', () => {
    expect(withdrawsRead(new Error('projects 403'))).toBe(false);
    expect(withdrawsRead({ status: 403 })).toBe(false);
  });

  it('keeps the saved copy on an auth-layer 503, and hands it back', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveProjects('acme', BOARDS);
    expect(savedProjects('acme', accessNotNow())?.value).toEqual(BOARDS);
    expect(projectsAfterFailure('acme', accessNotNow())).toMatchObject({ keepHeld: true });
    // Still there for the next one, which is the strip not emptying.
    expect(savedProjects('acme', accessNotNow())?.value).toEqual(BOARDS);
  });

  it('hands the saved copy to a coded 503, and only for its own org', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveProjects('acme', BOARDS);
    expect(savedProjects('acme', notNow())?.value).toEqual(BOARDS);
    expect(savedProjects('globex', notNow())).toBeNull();
    expect(savedProjects('acme', notNow())?.value).toEqual(BOARDS);
  });

  // #1042 review, blocker 2 kept its shape through #1395: a refusal deletes the
  // copy, so the next coded 503 has nothing to draw. What changed is the LIST of
  // refusals — the 500, the uncoded 503 and the 409 that used to be on it are in
  // the "keeps" table below now, because none of them is board-api saying this
  // reader may not see this.
  it.each([
    ['a 401, no session at all', new ApiError(401, 'unauthenticated')],
    ['a 403, the board refusing this reader', new ApiError(403, 'forbidden')],
    ['an org 404', new ApiError(404, 'projects 404', undefined, undefined, 'unknown org acme')],
  ])('deletes the saved copy on %s, so the next coded 503 has nothing to draw', (_what, refusal) => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveProjects('acme', BOARDS);
    expect(savedProjects('acme', refusal)).toBeNull();
    expect(readSaved(projectsKey('acme'), 60_000)).toBeNull();
    expect(savedProjects('acme', notNow())).toBeNull();
  });

  // #1042 round 3. The union copy `/` draws holds every org's boards, so a
  // refusal on one org's page has to take it too. As the verifier reproduced
  // it: /acme answers 500, then / answers the coded 503.
  it.each([
    ['a 401', new ApiError(401, 'unauthenticated')],
    ['a 403', new ApiError(403, 'forbidden')],
    ['an org 404', new ApiError(404, 'projects 404', undefined, undefined, 'unknown org acme')],
  ])('deletes the union copy and every other org’s after %s on one org', (_what, refusal) => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveProjects(null, BOARDS);
    saveProjects('acme', BOARDS);
    saveProjects('globex', BOARDS);
    expect(savedProjects('acme', refusal)).toBeNull();
    expect(savedProjects(null, notNow())).toBeNull();
    expect(savedProjects('globex', notNow())).toBeNull();
  });

  it('deletes every saved copy, including one under a key this file does not know', () => {
    const store = new MapStore();
    setPayloadStore(store);
    claimFor('octocat@example.com');
    saveProjects(null, BOARDS);
    const stranger = 'board_payload:saved/issues/all:acme';
    store.setItem(stranger, store.getItem('board_payload:saved/projects') ?? '');
    store.setItem('board_payload:people', '{}');
    savedProjects(null, new ApiError(403, 'forbidden'));
    expect([...store.map.keys()].filter((k) => k.startsWith('board_payload:saved/'))).toEqual([]);
    // The seeded copies and the owner are not this rule's to take.
    expect(store.getItem('board_payload:people')).toBe('{}');
    expect(store.getItem('board_payload_owner')).not.toBeNull();
  });

  // Caddy sits in front of board-api, so a board-api deploy reaches the browser
  // as Caddy's 502 with nothing from board-api in it: the same fact as a
  // dropped connection. Both now KEEP the copy, and so does a 502 that carries
  // board-api's own message — the body is what tells a deploy from a verdict,
  // and that distinction is the retry question's, not this one's.
  it('keeps the copy through a deploy, whatever the 502 carried', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveProjects(null, BOARDS);
    const deploy = new ApiError(502, 'projects 502');
    expect(transientFailure(deploy), 'and it is worth trying again').toBe(true);
    expect(savedProjects(null, deploy)?.value).toEqual(BOARDS);
    expect(savedProjects(null, notNow())?.value).toEqual(BOARDS);
    const said = new ApiError(502, 'projects 502', undefined, undefined, 'GitHub could not be reached');
    expect(savedProjects(null, said)?.value, 'board-api said something, but not "not you"').toEqual(BOARDS);
    expect(transientFailure(said), 'a body means a server answered, so no retry').toBe(false);
  });
});

/**
 * WHICH FAILURES ARE WORTH TRYING AGAIN — `transientFailure`, and since #1395
 * that is the only question the endpoint's own "not now" code answers.
 *
 * It was `servableFailure` and it decided the saved copy too. The two questions
 * came apart when #1395 measured what the saved-copy rule cost: a 500 and a bare
 * 503 are real faults that a retry loop only adds load to, and they are also
 * failures that say nothing about whether this reader may see what they are
 * holding. So the copy stays (the describe below) and the retry does not happen
 * (here). `retry-overview-read.ts` is the one caller.
 */
describe('which failures are worth trying again', () => {
  it('a dropped connection, and the 503 board-api codes "not now"', () => {
    expect(transientFailure(new TypeError('Failed to fetch'))).toBe(true);
    expect(transientFailure(notNow())).toBe(true);
  });

  // Two packages and no shared module, so each side declares the literal and
  // each side's spec pins it. That is what stops a rename on one side alone:
  // board-service's `auth/access-not-now-code.spec.ts` pins the other half.
  it('declares the shared auth code as the literal board-api sends', () => {
    expect(ACCESS_NOT_NOW_CODE).toBe('access_not_now');
    expect(SOURCE).toContain("export const ACCESS_NOT_NOW_CODE = 'access_not_now';");
  });

  // #1042 review, blocker 1. Each sentence is one board-api really sends with a
  // 503 on this read. The CODE decides, never the sentence: an uncoded 503 is
  // refused whatever it says, which is what keeps every withdrawal out.
  it.each([
    ['the expiry interceptor', 'GitHub access needs rechecking before this view can be shown; retry'],
    ['the expiry interceptor, after a fresh check', 'GitHub access changed during this read; retry'],
    ['the principal guard', 'Your GitHub connection is being renewed. Try again in a moment, or reconnect GitHub if it does not clear.'],
    ['the principal guard, on a spent window', 'GitHub access check has too little left to start this read; retry'],
    ['the session check', 'The board cannot confirm your sign-in right now. Try again in a moment.'],
  ])('never a 503 from %s, which carries no code', (_who, said) => {
    expect(transientFailure(new ApiError(503, 'projects 503', undefined, undefined, said))).toBe(false);
  });

  /**
   * #1066. The five transient auth-layer 503s carry a code of their own now, and
   * it is servable on every read — it is thrown before any read runs, so it says
   * nothing about the surface and no read has a version of it to own. The three
   * sentences here are the ones that changed sides; the two above that did not
   * are the expiry interceptor's, which are withdrawals and stay uncoded.
   *
   * The sentence is passed only to show it is not what decides: the same words
   * with no code are refused by the case above, and the same code under any
   * words is servable here.
   */
  it.each([
    ['a refresh in flight on another instance', 'Your GitHub connection is being renewed. Try again in a moment, or reconnect GitHub if it does not clear.'],
    ['an access check with too little left', 'GitHub access check has too little left to start this read; retry'],
    ['a discovery past its own window', 'Checking your GitHub access took too long. Try again.'],
    ['a session store that could not be read', 'The board cannot confirm your sign-in right now. Try again in a moment.'],
    ['words this file has never seen', 'something board-api has not said yet'],
  ])('a 503 coded "access not now" is servable — %s', (_what, said) => {
    expect(transientFailure(accessNotNow(said))).toBe(true);
    // And on a read whose own code is a different one: this code is every
    // read's, which is the whole of why there is one of it.
    expect(transientFailure(accessNotNow(said), ISSUES_NOT_NOW_CODE)).toBe(true);
  });


  it('never a 503 carrying some other code, or either code on another status', () => {
    expect(transientFailure(new ApiError(503, 'projects 503', undefined, undefined, 'x', 'admins_unread'))).toBe(false);
    // Another read's own code on this read's answer is not a verdict this
    // read's server reached. The shared one is the deliberate exception.
    expect(transientFailure(new ApiError(503, 'projects 503', undefined, undefined, 'x', ISSUES_NOT_NOW_CODE))).toBe(false);
    for (const status of [408, 429, 500, 504]) {
      expect(transientFailure(new ApiError(status, `projects ${status}`)), String(status)).toBe(false);
      expect(transientFailure(new ApiError(status, `projects ${status}`, undefined, undefined, 'x', PROJECTS_NOT_NOW_CODE)), String(status)).toBe(false);
      expect(transientFailure(new ApiError(status, `projects ${status}`, undefined, undefined, 'x', ACCESS_NOT_NOW_CODE)), String(status)).toBe(false);
    }
  });

  // #1046. The Overview tiles' reads code their own "not now", and one read's
  // code is not a verdict another read's server reached.
  it('takes the read’s own code and no other read’s', () => {
    const coded = (code: string) => new ApiError(503, 'x 503', undefined, undefined, 'x', code);
    expect(transientFailure(coded('issues_not_now'), 'issues_not_now')).toBe(true);
    expect(transientFailure(coded(PROJECTS_NOT_NOW_CODE), 'issues_not_now')).toBe(false);
    expect(transientFailure(coded('issues_not_now'))).toBe(false);
    expect(transientFailure(new TypeError('Failed to fetch'), 'issues_not_now')).toBe(true);
  });

  it('never a refusal about the reader, a changed access, or an error nobody can read', () => {
    for (const status of [401, 403, 404, 409, 400]) {
      expect(transientFailure(new ApiError(status, `projects ${status}`)), String(status)).toBe(false);
    }
    expect(transientFailure(new SyntaxError('Unexpected token'))).toBe(false);
    expect(transientFailure(new Error('boom'))).toBe(false);
    // A bare Error naming the status is not board-api's coded answer either.
    expect(transientFailure(new Error('projects 503'))).toBe(false);
  });

});

/**
 * The boards an OPEN page is already holding, which followed a weaker rule than
 * the saved copy until #1060: they came off only on a WITHDRAWAL, a 403 or an
 * org 404. A Github FORBIDDEN reaches the browser as a 500, so a reader whose
 * access had just been taken away kept seeing them on a page they already had
 * open, with an outdated-data notice.
 *
 * `keepHeld` is the whole of what the two pages read, so these are the cases
 * that decide what is on their screens. What each page DOES with the answer is
 * pinned as text in `Pulse.spec.tsx` and `Dashboard.spec.ts` — no effect fires
 * in this suite — and driven mounted, in a real browser, by
 * scripts/check-projects-preview.mjs, mode `held-refusal`.
 */
describe('what a failed read leaves the page holding (#1060)', () => {
  const held = (org: string | null, e: unknown) => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveProjects(org, BOARDS);
    writePayload(projectsKey(org), BOARDS);
    const after = projectsAfterFailure(org, e);
    return { ...after, stored: readPayload(projectsKey(org), Array.isArray) };
  };

  // The refusals, which since #1395 are the three that are about the reader.
  // #1060's own argument is untouched: ONE rule decides the boards on screen,
  // the stored copy and the saved copy together, and a refusal takes all three.
  // What #1395 changed is which failures are refusals.
  it.each([
    ['a 401, no session at all', new ApiError(401, 'unauthenticated')],
    ['a 403, the board refusing this reader', new ApiError(403, 'forbidden')],
    ['an org 404', new ApiError(404, 'projects 404', undefined, undefined, 'unknown org acme')],
  ])('takes the held boards, the stored copy and the saved one on %s', (_what, refusal) => {
    const after = held('acme', refusal);
    expect(after.keepHeld).toBe(false);
    expect(after.saved).toBeNull();
    expect(after.stored).toBeNull();
    expect(readSaved(projectsKey('acme'), 60_000)).toBeNull();
  });

  // And the same on the union, which is where a 403 arrives with no org at all
  // — the case `scopeWithdrawn` answers on the reader rather than the address,
  // and the one a narrower reading of the status has got wrong twice.
  it('takes them on the union read too, which carries no org', () => {
    const after = held(null, new ApiError(403, 'forbidden'));
    expect(after.keepHeld).toBe(false);
    expect(after.stored).toBeNull();
  });

  // #1042's third round, one key up, driven in a browser before it was written
  // down: the union copy `/` draws holds acme's boards too. A 500 on
  // /acme that took only `projects:acme` left them in `projects`,
  // and moving back to `/` inside the same document — no page load, so no
  // sensitive wipe — met a coded 503 there and drew them again.
  it('takes the stored union copy on a refusal about one org, and every other org’s', () => {
    const store = new MapStore();
    setPayloadStore(store);
    claimFor('octocat@example.com');
    for (const org of [null, 'acme', 'globex']) {
      saveProjects(org, BOARDS);
      writePayload(projectsKey(org), BOARDS);
    }
    // A per-board read, which is a different answer from a different route and
    // is out of this rule's reach. The board page drops its own board's copy
    // itself, on its own failed read (#1065, #1107), so this key is here to hold
    // the prefix walk to the rollup keys rather than to claim it is cleaned: a
    // refusal on the rollup says nothing about a board somebody has open.
    writePayload(projectKey(7, 'acme'), { number: 7 });
    expect(projectsAfterFailure('acme', new ApiError(403, 'forbidden')).keepHeld).toBe(false);
    for (const org of [null, 'acme', 'globex']) {
      expect(readPayload(projectsKey(org), Array.isArray), String(org)).toBeNull();
    }
    expect([...store.map.keys()].filter((k) => k.startsWith('board_payload:saved/'))).toEqual([]);
    expect(readPayload(projectKey(7, 'acme'))).not.toBeNull();
  });

  // The other half of #1035, which this must not undo — and since #1395 it is
  // the longer half. The last three are the ones that moved: each is a fault
  // the board hit while asking, not an answer about this reader, and each was
  // taking the reader's own boards off their screen several times a day.
  it.each([
    ['a dropped connection', new TypeError('Failed to fetch')],
    ['the 503 board-api codes "not now"', notNow()],
    ['Caddy’s empty 502 during a board-api deploy', new ApiError(502, 'projects 502')],
    ['a 500, board-api failing', new ApiError(500, 'projects 500')],
    ['a bare 503, the expiry interceptor withholding a read that outlived its window', new ApiError(503, 'projects 503', undefined, undefined, 'GitHub access needs rechecking before this view can be shown; retry')],
    ['a 409, access changed under the read', new ApiError(409, 'Your GitHub access changed; reload this view.')],
  ])('leaves all three on %s, which is not an answer about this reader', (_what, outage) => {
    const after = held('acme', outage);
    expect(after.keepHeld).toBe(true);
    expect(after.saved?.value).toEqual(BOARDS);
    expect(after.stored).toEqual(BOARDS);
  });

  // The table above goes red when a re-derived `projectsAfterFailure` DROPS a
  // branch: nine failures drive it, three refusals and six outages. It cannot
  // go red the other way. Give `servableFailure` a fourth servable case and
  // only its own suite moves, while a `projectsAfterFailure` that had re-read
  // the statuses for itself would quietly disagree with the saved copy about
  // which failures are servable, which is the second rule #1060 deleted.
  //
  // So this pins the delegation. It is a claim about wiring TEXT and nothing
  // else — the same thing `Pulse.spec.tsx` and `Dashboard.spec.ts` do for their
  // pages — and the behaviour behind it is the table above.
  it('asks servableFailure rather than re-deriving it (#1060)', () => {
    expect(SOURCE).toContain('if (servableFailure(e)) return { keepHeld: true, saved };');
  });

  // `keepHeld` is not "there is a copy": a servable failure with nothing saved
  // still leaves the boards the page holds, which is the ONLY thing on screen
  // after a refresh fails inside one document.
  it('keeps the held boards even when no copy was ever saved', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    const after = projectsAfterFailure('acme', notNow());
    expect(after.keepHeld).toBe(true);
    expect(after.saved).toBeNull();
  });
});

describe('what is saved', () => {
  it('not an answer the service gave from its own copy, which is old already', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveProjects(null, [{ number: 7, name: 'Delivery', lastGoodCopy: true }] as unknown as ProjectSummary[]);
    expect(readSaved(projectsKey(null), 60_000)).toBeNull();
    saveProjects(null, BOARDS);
    expect(readSaved(projectsKey(null), 60_000)?.value).toEqual(BOARDS);
  });
});

describe('a recalled copy is drawn only while nothing has moved under it', () => {
  const recalled = (over: Partial<RecalledProjects> = {}): RecalledProjects => ({
    at: Date.now(), value: BOARDS, seen: 'who:1:1:aaaa', org: 'acme',
    generation: currentPayloadGeneration(), sensitive: currentSensitiveGeneration(), ...over,
  });

  it('drops out once the check reports different access', () => {
    setResponseIdentity('who:1:1:aaaa', true);
    const saved = recalled();
    expect(drawable(saved, 'acme')).toBe(saved);
    setResponseIdentity('who:1:1:bbbb', true);
    expect(drawable(saved, 'acme')).toBeNull();
    expect(drawable(null, 'acme')).toBeNull();
  });

  it('is never drawn for another org, even for the one frame before a reset', () => {
    setResponseIdentity('who:1:1:aaaa', true);
    expect(drawable(recalled(), 'globex')).toBeNull();
    expect(drawable(recalled({ org: null }), null)).not.toBeNull();
  });

  it('drops out after an expired check or a whole wipe, until a failed read recalls it again', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    setResponseIdentity('who:1:1:aaaa', true);
    const beforeCheck = recalled();
    forgetSensitivePayloads();
    expect(drawable(beforeCheck, 'acme')).toBeNull();
    const beforeWipe = recalled();
    forgetPayloads();
    expect(drawable(beforeWipe, 'acme')).toBeNull();
  });
});

/**
 * A BOARD'S own saved copy (#1249).
 *
 * Driven for real, against a fake store, because this half can be: the page
 * that draws it cannot be reached here (no effect fires), but
 * the policy is pure functions over a disk and a disk is a Map. What a browser
 * has to prove instead is that the page reaches these states at all, which is
 * `scripts/check-board-copy.mjs`.
 */
const BOARD = {
  number: 7,
  name: 'Board hardening',
  url: 'https://github.com/orgs/acme/projects/7',
  pct: 50,
  org: 'acme',
  items: [{ repo: 'acme/board', number: 1, title: 'A board item' }],
} as unknown as ProjectDetail;

describe('a board’s own saved copy (#1249)', () => {
  it('hands a landed board back to a coded 503, and only for its own address', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveBoard(7, 'acme', BOARD);
    expect(savedBoard(7, 'acme', notNow())?.value).toEqual(BOARD);
    // Another board's number, and the same number in another org: two boards,
    // two keys, and a Projects v2 number is unique only within an org (#697).
    expect(savedBoard(8, 'acme', notNow())).toBeNull();
    expect(savedBoard(7, 'globex', notNow())).toBeNull();
  });

  it('answers the walk and the reload alike, which is the hole #1243 exposed', () => {
    // The stored copy under `projects/7` is what a walk used to repaint from
    // and a reload never did, because the key is sensitive and the mount wipe
    // takes it. The SAVED copy survives that wipe, so both routes get it.
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    writePayload(projectKey(7, 'acme'), BOARD);
    saveBoard(7, 'acme', BOARD);
    forgetSensitivePayloads();
    expect(readPayload(projectKey(7, 'acme')), 'the stored copy is gone, as it always was on a reload').toBeNull();
    expect(savedBoard(7, 'acme', notNow())?.value, 'and the saved copy is what both routes now have').toEqual(BOARD);
  });

  it('refuses a copy whose shape drifted, rather than drawing a board out of it', () => {
    // #1216 is this mistake shipped once: a Repos card whose read failed drew a
    // chart asserting zero activity. A copy written by another build can be
    // missing anything, and `items` is the field that decides whether the page
    // says "No issues on this board".
    for (const broken of [
      { ...BOARD, items: undefined },
      { ...BOARD, name: '' },
      { ...BOARD, pct: Number.NaN },
      { ...BOARD, number: 8 },
      { ...BOARD, url: undefined },
    ]) {
      setPayloadStore(new MapStore());
      claimFor('octocat@example.com');
      keepSaved(projectKey(7, 'acme'), broken as unknown as ProjectDetail);
      expect(savedBoard(7, 'acme', notNow()), JSON.stringify(Object.keys(broken))).toBeNull();
    }
  });

  it('refuses to save a shape it would refuse to read back', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveBoard(7, 'acme', { ...BOARD, items: undefined } as unknown as ProjectDetail);
    expect(readSaved(projectKey(7, 'acme'), SAVED_COPY_MAX_AGE_MS)).toBeNull();
  });

  it('does not save a board the service answered from ITS own copy', () => {
    // Saving one would stamp an old answer as read now, which is `saveProjects`'
    // rule and the same argument: the two sides of this agree about age.
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveBoard(7, 'acme', { ...BOARD, lastGoodCopy: true } as unknown as ProjectDetail);
    expect(savedBoard(7, 'acme', notNow())).toBeNull();
  });

  it('deletes every saved copy on a refusal, the board’s and the rollup’s alike', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveBoard(7, 'acme', BOARD);
    saveProjects('acme', BOARDS);
    expect(savedBoard(7, 'acme', new ApiError(403, 'forbidden'))).toBeNull();
    expect(savedProjects('acme', notNow()), 'the rollup went with it (#1042)').toBeNull();
  });

  it('is past the ceiling at the age the rollup is', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveBoard(7, 'acme', BOARD);
    const at = Date.now;
    try {
      Date.now = () => at() + SAVED_COPY_MAX_AGE_MS + 1;
      expect(savedBoard(7, 'acme', notNow())).toBeNull();
    } finally {
      Date.now = at;
    }
  });
});

/**
 * #824's cross-identity rule, over the copy #1249 adds (#824).
 *
 * PROVED HERE RATHER THAN ASSUMED FROM THE SHARED PREDICATE, which is the
 * instruction this was written under. The two refusals are different: `o` is
 * who the browser last saw signed in, and `seen` is the Github visibility the
 * answer was served under, so one covers "somebody else opened this browser"
 * and the other covers "the same person, different access". A board is the
 * first saved copy that is one NAMED thing rather than a list, so being wrong
 * here means drawing one person's private board on another person's screen.
 */
describe('a board saved by one person is never drawn for another (#824)', () => {
  it('is gone the moment the browser is claimed for somebody else', () => {
    const store = new MapStore();
    setPayloadStore(store);
    claimFor('octocat@example.com');
    saveBoard(7, 'acme', BOARD);
    claimFor('someone-else@example.com');
    expect(savedBoard(7, 'acme', notNow())).toBeNull();
    // And not merely unreadable: `claimFor` takes the entries off the disk
    // before the new person's first read is stored under them.
    expect([...store.map.keys()].filter((k) => k.includes('saved/'))).toEqual([]);
  });

  it('is refused for the same person seen through different Github access', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    setResponseIdentity('octocat:1:1:aaaa', true);
    saveBoard(7, 'acme', BOARD);
    setResponseIdentity('octocat:1:1:bbbb', true);
    expect(savedBoard(7, 'acme', notNow())).toBeNull();
    // Refused AND deleted, so restoring the old visibility does not restore the
    // board: an answer from a check that has been superseded is not coming back.
    setResponseIdentity('octocat:1:1:aaaa', true);
    expect(savedBoard(7, 'acme', notNow())).toBeNull();
  });

  it('is refused for a browser nobody has claimed at all', () => {
    const store = new MapStore();
    setPayloadStore(store);
    claimFor('octocat@example.com');
    saveBoard(7, 'acme', BOARD);
    forgetPayloads();
    expect(savedBoard(7, 'acme', notNow())).toBeNull();
  });

  it('is refused by `drawable` when the check behind it expired mid-render', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveBoard(7, 'acme', BOARD);
    const recalled = savedBoard(7, 'acme', notNow());
    expect(drawable(recalled, 'acme')?.value).toEqual(BOARD);
    forgetSensitivePayloads();
    expect(drawable(recalled, 'acme'), 'the generation moved under the copy').toBeNull();
    expect(drawable(recalled, 'globex'), 'and the org moved under it').toBeNull();
  });
});

describe('the rollup copy a board with none of its own falls back on (#879, #1249)', () => {
  it('asks the address’s own key first and the union entry second', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveProjects(null, [{ number: 7, name: 'From the union' }] as unknown as ProjectSummary[]);
    saveProjects('acme', [{ number: 7, name: 'From the org', org: 'acme' }] as unknown as ProjectSummary[]);
    expect(savedBoardRollup('acme', notNow())?.value).toEqual([{ number: 7, name: 'From the org', org: 'acme' }]);
  });

  it('falls back to the union entry, which is where an unnarrowed page saved it', () => {
    // The ordinary reader: an unnarrowed `/team` saves `projects`, and its rows
    // link to `/acme/projects/7`, which reads `projects:acme` and
    // finds nothing. Without the second read this board has no header at all.
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveProjects(null, BOARDS);
    expect(savedBoardRollup('acme', notNow())?.value).toEqual(BOARDS);
    // Recalled under the PAGE's org, so `drawable` refuses it once the page moves.
    expect(savedBoardRollup('acme', notNow())?.org).toBe('acme');
  });

  it('answers nothing for a failure that may not fall back on a copy', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveProjects(null, BOARDS);
    expect(savedBoardRollup('acme', new ApiError(403, 'forbidden'))).toBeNull();
  });

  it('is a header and never an item list, so no board is called empty (#714)', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveProjects('acme', [{ number: 7, name: 'Delivery', url: 'u', pct: 50, org: 'acme' }] as unknown as ProjectSummary[]);
    const recalled = savedBoardRollup('acme', notNow());
    expect(heldHeader(recalled?.value, 7, 'acme')).toEqual({ name: 'Delivery', number: 7, url: 'u', pct: 50, itemsComplete: undefined });
    expect(heldHeader(recalled?.value, 7, 'acme')).not.toHaveProperty('items');
  });
});

/**
 * The mark, which is what a reader actually sees (#1249).
 *
 * A word beside the heading rather than a line of prose over the block — the
 * vocabulary #1236 settled on the Overview cards.
 */
describe('the mark a board page wears', () => {
  const AT = Date.parse('2026-09-21T12:00:00.000Z');

  it('says nothing at all about a live board', () => {
    expect(boardMark('live', null)).toBeNull();
    expect(boardMark('live', AT)).toBeNull();
  });

  it('says the word while the read is still out, so the pulse is not the only sign', () => {
    // #1251's review, F2: `motion-reduce:animate-none` takes the pulse off both
    // states that draw no board, and before this word the two were the same
    // seventeen still placeholders with one word between them — a page waiting
    // on something that was never coming, drawn exactly like a page waiting on
    // something that was. #1236's own cards never had that hole.
    const loading = boardMark('loading', null);
    expect(loading?.text).toBe('Loading');
    expect(loading?.pending).toBe(true);
    // No accessible name of its own: the skeleton it sits in is already an
    // `aria-busy` region named "Loading project", and repeating those words in
    // a status inside it would say them twice.
    expect(loading?.label).toBeUndefined();
  });

  it('is the one mark that means a read is still coming', () => {
    // What `OverviewSkeleton` reads to decide whether the bars pulse. Every
    // other mark is about a read that is over.
    expect(boardMark('loading', null)?.pending).toBe(true);
    expect(boardMark('saved', AT)?.pending).toBe(false);
    expect(boardMark('unreadable', null)?.pending).toBe(false);
  });

  it('tells the three marks apart by their words alone', () => {
    // The whole of F2's fix: no two of them read the same with the motion off.
    const words = (['loading', 'saved', 'unreadable'] as const).map((s) => boardMark(s, AT)?.text);
    expect(new Set(words).size).toBe(words.length);
  });

  it('names the copy and its age, because a copy with no age reads as current', () => {
    expect(boardMark('saved', AT, AT + 12 * 60_000)?.text).toBe('Saved copy 12 minutes ago');
    expect(boardMark('saved', AT, AT + 90 * 60_000)?.text).toBe('Saved copy 1 hour ago');
    expect(boardMark('saved', AT, AT + 30_000)?.text).toBe('Saved copy less than a minute ago');
  });

  it('gives the copy mark an accessible name matching its text', () => {
    const now = AT + 12 * 60_000;
    expect(boardMark('saved', AT, now)?.label).toBe('Saved copy 12 minutes ago');
    expect(boardMark('saved', null, now)?.label).toBe('Saved copy');
  });

  it('tells a failed read from a stale one, in the label and in the words', () => {
    const failed = boardMark('unreadable', null);
    expect(failed).toEqual({ text: 'Unavailable', label: BOARD_UNREADABLE, pending: false });
    // It makes NO claim about a copy, which is the half `heldCopyNote`'s
    // docblock insists on: there is nothing on the screen to be showing.
    expect(failed?.label).not.toContain('Showing');
    expect(failed?.text).not.toBe(boardMark('saved', AT)?.text);
  });
});

/**
 * The forget that rides on the recall, and the caller that has no recall to
 * ride on (#1249 review, finding 1).
 *
 * The sequence this is written against was reproduced from the source by a
 * reviewer and is worth stating whole, because every step of it is documented
 * behaviour and only the combination is wrong: an access check expires, so
 * `forgetSensitivePayloads` takes the stored board and deliberately walks past
 * the saved one; the re-read issued by the new check is REFUSED, so the page
 * draws the failure sentence and keeps nothing; two minutes later the soft
 * refresh meets a quota cooldown, recalls the saved copy, and repaints the
 * board the refusal had just withheld. The copy passes every guard it meets:
 * it is inside the ceiling, a new check that finds the same repositories has
 * the same visibility key, and `drawable` compares generations the copy was
 * recalled UNDER, which is after the expiry moved them.
 */
describe('a refusal that recalls nothing still forgets (#1249 review)', () => {
  it('takes every saved copy on a refusal, exactly as a recall would', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveBoard(7, 'acme', BOARD);
    saveProjects('acme', BOARDS);
    forgetSavedCopiesOnRefusal(new ApiError(403, 'forbidden'));
    expect(savedBoard(7, 'acme', notNow())).toBeNull();
    expect(savedProjects('acme', notNow())).toBeNull();
  });

  it('keeps them on every failure that is not about the reader (#1395)', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveBoard(7, 'acme', BOARD);
    forgetSavedCopiesOnRefusal(notNow());
    forgetSavedCopiesOnRefusal(new TypeError('Failed to fetch'));
    forgetSavedCopiesOnRefusal(accessNotNow());
    forgetSavedCopiesOnRefusal(new ApiError(500, 'projects 500'));
    forgetSavedCopiesOnRefusal(new ApiError(409, 'projects 409'));
    forgetSavedCopiesOnRefusal(new ApiError(503, 'projects 503', undefined, undefined, 'GitHub access needs rechecking before this view can be shown; retry'));
    expect(savedBoard(7, 'acme', notNow())?.value).toEqual(BOARD);
  });

  /**
   * The read the hint probe never let run is not a refusal (#1324).
   *
   * `probeMe` already decides what a failed probe costs the disk: a 403 or any
   * answer below 500 wipes it, and a 5xx, an abort and a dropped connection
   * wipe nothing, because at 500 and above board-api said nothing about who is
   * holding this browser. A probe that fails then rejects every read held
   * behind it, and this rule read those rejections as refusals and deleted the
   * copies the probe had just decided to keep — so one transient 503 on
   * `/api/auth/me` emptied the disk, and the next cooled-down rollup had
   * nothing to draw but the disabled strip.
   */
  it('keeps them when the probe never let the read run (#1324)', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveBoard(7, 'acme', BOARD);
    saveProjects('acme', BOARDS);
    forgetSavedCopiesOnRefusal(new UnverifiedSessionError());
    expect(savedBoard(7, 'acme', notNow())?.value).toEqual(BOARD);
    expect(savedProjects('acme', notNow())?.value).toEqual(BOARDS);
  });

  /**
   * And RECALLING under one takes nothing either, which is the half #1395 nearly
   * lost. `recallSaved` asks `withdrawsRead` now, and that predicate cannot see
   * an unverified session — so the rejection fell through to `readSaved`, which
   * deletes a copy it refuses, and one transient 503 on `/api/auth/me` emptied
   * the disk again. `check-saved-copy-probe.mjs` drives the same sequence in a
   * browser.
   */
  it('and recalling under an unverified probe does not delete them either', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveProjects('acme', BOARDS);
    saveBoard(7, 'acme', BOARD);
    expect(savedProjects('acme', new UnverifiedSessionError()), 'nothing is drawn over an unverified session').toBeNull();
    expect(savedBoard(7, 'acme', new UnverifiedSessionError())).toBeNull();
    // Still on the disk for the read that runs once the probe answers.
    expect(savedProjects('acme', notNow())?.value).toEqual(BOARDS);
    expect(savedBoard(7, 'acme', notNow())?.value).toEqual(BOARD);
  });

  it('draws nothing over it either: the page waits, the disk keeps (#1324)', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    saveProjects('acme', BOARDS);
    // Not servable — nobody has verified who is reading — so the page holds no
    // boards and is handed none. The copy is still there for the read that runs
    // once the probe answers.
    expect(projectsAfterFailure('acme', new UnverifiedSessionError()))
      .toEqual({ keepHeld: false, saved: null });
    expect(savedProjects('acme', notNow())?.value).toEqual(BOARDS);
  });

  it('is the whole of the sequence: an expiry, a refusal, then a cooldown', () => {
    setPayloadStore(new MapStore());
    claimFor('octocat@example.com');
    writePayload(projectKey(7, 'acme'), BOARD);
    saveBoard(7, 'acme', BOARD);
    // The check expires. The stored board goes; the saved copy is outside that
    // wipe by design (#1035) and stays.
    forgetSensitivePayloads();
    expect(readPayload(projectKey(7, 'acme'))).toBeNull();
    // The re-read the new check issues is refused. This is the line the epoch
    // arm was missing.
    forgetSavedCopiesOnRefusal(new ApiError(403, 'forbidden'));
    // Two minutes later, a quota cooldown. Nothing is left to draw.
    expect(savedBoard(7, 'acme', notNow())).toBeNull();
  });

  it('asks the one question `recallSaved` asks, rather than a second copy of it', () => {
    // Pinned as text because the failure mode is a rule written twice and
    // answered differently in each place, which is what #1042 was.
    expect(SOURCE).toContain('forgetSavedCopiesOnRefusal(e);');
    expect(SOURCE.match(/forgetSavedCopies\(\);/g) ?? [], 'one call site, inside the rule')
      .toHaveLength(1);
  });
});
