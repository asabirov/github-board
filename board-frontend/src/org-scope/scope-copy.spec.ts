/**
 * Every sentence the board says about a NARROWED scope (#714), checked the way
 * `auth/org-scope-copy.spec.ts` checks the union's — the same shape, the same
 * closing pair of cases, because the two files are two halves of one voice.
 *
 * Pure strings here, no markup: what each surface DRAWS is pinned beside that
 * surface. This holds the wording and the choice between the wordings.
 */
import { describe, expect, it } from 'vitest';
import type { OrgReadState } from '../api/types';
import {
  emptyScopeSentence,
  refusedScopeCopy,
  scopeRefusal,
  scopeSentences,
  scopeStatus,
  scopeWithdrawn,
  unnarrowedSentence,
  unreadableScopeCopy,
} from './scope-copy';
import { REASSURING_WORDS, reassuringWordIn } from '../reassuring-words';

const read = (org: string): OrgReadState => ({ org, state: 'read', reason: null });
/** What the ORG GATE answers: the status, and the server's own message, which
 *  names the org — `repos.controller.ts` throws `unknown org gtm` and the
 *  service under it `the repo listing for gtm could not be read`. */
const gate = (status: number, org: string) => ({ status, message: `unknown org ${org}` });
/** The same status from anything else: a proxy with no upstream, a rolling
 *  deploy, a misrouted `/api/*`. It names no org, because it is not about one. */
const outage = (status: number) => ({ status, message: null });
const unread = (org: string, reason: string | null = null): OrgReadState =>
  ({ org, state: 'unreadable', reason });

describe('the tiles a narrowed board cannot narrow (#714)', () => {
  it('names the org and the tiles, so neither is left to the reader to supply', () => {
    expect(unnarrowedSentence('globex', 'Issues and Throughput'))
      .toBe('Issues and Throughput count every org, not just globex.');
  });

  it('says nothing on the union, where nothing was narrowed', () => {
    expect(unnarrowedSentence(null, 'Issues and Throughput')).toBeNull();
  });
});

describe('an address naming an org this board refused (#714, #718)', () => {
  it('says the board does not cover it, and names it', () => {
    expect(refusedScopeCopy('gtm', gate(404, 'gtm'))?.notice)
      .toBe('This board does not cover gtm, so no count here contains its work.');
  });

  // `repos.controller.ts` splits these two on purpose: 404 is "not this board's
  // org at all", 503 is "this board's org, and the read failed". A reader who
  // got one for the other goes looking in the wrong place.
  it('tells an org it does not cover from one it covers and could not read', () => {
    const unserved = refusedScopeCopy('globex', gate(404, 'globex'))!;
    const unreadable = refusedScopeCopy('globex', gate(503, 'globex'))!;
    expect(unserved.notice).not.toBe(unreadable.notice);
    expect(unserved.notice).toContain('does not cover globex');
    expect(unreadable.notice).toContain('could not read globex');
  });

  it('says the same thing about an unread org however the board learned it', () => {
    // From the read that came back 503, and from the session's own org report:
    // one fact, one sentence, so the two surfaces cannot phrase it differently.
    expect(refusedScopeCopy('globex', gate(503, 'globex'))?.notice)
      .toBe(unreadableScopeCopy('globex', [read('acme'), unread('globex')])?.notice);
  });

  it('says nothing on the union, whatever the read answered', () => {
    for (const status of [404, 503, 500]) {
      expect(refusedScopeCopy(null, gate(status, 'globex')), String(status)).toBeNull();
    }
    expect(refusedScopeCopy(null, null)).toBeNull();
  });

  it('says nothing about a failure that is not a refusal of this org', () => {
    // A 500, a 403 and a dropped connection are the page's own failure to
    // report; claiming the board does not cover an org it serves is worse than
    // "unavailable right now".
    for (const status of [200, 403, 500, 502]) {
      expect(refusedScopeCopy('globex', gate(status, 'globex')), String(status)).toBeNull();
    }
    expect(refusedScopeCopy('globex', null)).toBeNull();
  });

  // #714 review: the STATUS alone was the whole test, so a reverse proxy with no
  // healthy upstream, a rolling deploy and a misrouted `/api/*` were all
  // reported to the reader as "this board does not cover acme" — about an
  // org the board serves. The org gate names the org it refused; nothing else
  // does, and that is what tells them apart.
  it('says nothing when the refusal is not the org gate’s, whatever its status', () => {
    for (const status of [404, 503]) {
      expect(refusedScopeCopy('acme', outage(status)), String(status)).toBeNull();
      // A body that names some OTHER org is not about this one either.
      expect(refusedScopeCopy('acme', { status, message: 'unknown org globex' })).toBeNull();
    }
  });

  // #1046. Github's quota is not the gate's verdict about an org, and the page
  // may draw a saved copy over it, which "no count here contains its work"
  // would contradict. The code decides, not whether the message names the org.
  it('says nothing over a refusal the server coded, even one naming the org', () => {
    const message = 'issues for acme could not be read';
    expect(refusedScopeCopy('acme', { status: 503, message, code: 'issues_not_now' })).toBeNull();
    expect(refusedScopeCopy('acme', { status: 503, message })?.notice).toContain('acme');
  });

  it('reads the server’s code off what the fetchers reject with', () => {
    const e = Object.assign(new Error('org-issues 503'), { status: 503, serverMessage: 'x', code: 'issues_not_now' });
    expect(scopeRefusal(e)).toEqual({ status: 503, message: 'x', code: 'issues_not_now' });
  });

  it('reads the gate’s verdict whichever case the address spelled the org in', () => {
    // Github org names are case-insensitive and the service folds them, so the
    // message comes back in the board's spelling and the address may be in any.
    expect(refusedScopeCopy('Acme', { status: 404, message: 'unknown org acme' })?.notice)
      .toContain('Acme');
  });

  it('reads the server’s own message off what the fetchers reject with', () => {
    const e = Object.assign(new Error('repos 404'), { status: 404, serverMessage: 'unknown org gtm' });
    expect(scopeRefusal(e)).toEqual({ status: 404, message: 'unknown org gtm' });
    // A fetcher that carried no server message leaves the message null, and the
    // page then draws its ordinary outage line rather than a claim about an org.
    expect(scopeRefusal(new Error('repos 404'))).toEqual({ status: 404, message: null });
    expect(scopeRefusal(new Error('forbidden'))).toBeNull();
  });

  it('reads the status off what the fetchers actually reject with', () => {
    // `ApiError` carries it as a field; a bare Error names it in the message,
    // which is what the repos and projects fetchers threw before this.
    expect(scopeStatus(Object.assign(new Error('repos 404'), { status: 404 }))).toBe(404);
    expect(scopeStatus(new Error('repos 404'))).toBe(404);
    expect(scopeStatus(new Error('projects 503'))).toBe(503);
    expect(scopeStatus(new Error('forbidden'))).toBeNull();
    expect(scopeStatus(new Error('unauthenticated'))).toBeNull();
    expect(scopeStatus(null)).toBeNull();
    expect(scopeStatus(undefined)).toBeNull();
    // A number in the message that is not a status must not be read as one.
    expect(scopeStatus(new Error('repos 4041'))).toBeNull();
  });
});

describe('a narrowed read that worked and came back empty (#714)', () => {
  it('names the org, so it is not read as the union having no boards', () => {
    expect(emptyScopeSentence('globex', 'project boards')).toBe('No project boards in globex yet.');
  });

  it('leaves the union’s own sentence byte for byte what it was', () => {
    expect(emptyScopeSentence(null, 'project boards')).toBe('No project boards yet.');
  });
});

describe('what the session says about an org it could not read (#714)', () => {
  it('carries Github’s own words when it has them, and drops the line when it does not', () => {
    const withReason = unreadableScopeCopy('globex', [unread('globex', 'Bad credentials.')]);
    expect(withReason?.reason).toBe('GitHub’s answer: Bad credentials.');
    expect(unreadableScopeCopy('globex', [unread('globex', null)])?.reason).toBeNull();
    expect(unreadableScopeCopy('globex', [unread('globex', '  ')])?.reason).toBeNull();
  });

  it('says nothing on an empty list — the board is making no claim, not reporting good news', () => {
    // `/api/auth/me` answers `orgs: []` on a fixture board. If this returned
    // copy, that deployment would gain a line it has no grounds for.
    expect(unreadableScopeCopy('globex', [])).toBeNull();
    expect(unreadableScopeCopy('globex', [read('globex')])).toBeNull();
  });
});

describe('every sentence this file can put in front of a person (#614, #650)', () => {
  /** The whole vocabulary, for one org, read off the notices' own values rather
   *  than a list of function names — so a sentence added to `ScopeNotice` is
   *  swept without anybody enrolling it here. */
  const said = [
    ...scopeSentences('globex', [read('acme'), unread('globex', 'Bad credentials')]),
    ...scopeSentences('globex', [read('acme'), unread('globex', null)]),
    ...scopeSentences('globex', []),
    ...scopeSentences('acme', [read('acme')]),
    ...scopeSentences(null, [unread('globex')]),
  ];

  it('never writes “the org” singular, in any sentence it can produce', () => {
    expect(said.length).toBeGreaterThan(5);
    for (const sentence of said) {
      expect(sentence, sentence).not.toMatch(/\bthe org\b/);
    }
  });

  it('names the org in every sentence that makes a claim about one', () => {
    // The claim sentences, not the `reason` line under them: that one is a
    // QUOTATION of Github's words, it refers to no org, and the notice
    // immediately above it has already named the one it is about.
    const claims = [
      unnarrowedSentence('globex', 'Issues and Throughput'),
      refusedScopeCopy('globex', gate(404, 'globex'))?.notice,
      refusedScopeCopy('globex', gate(503, 'globex'))?.notice,
      emptyScopeSentence('globex', 'project boards'),
      unreadableScopeCopy('globex', [unread('globex', 'Bad credentials')])?.notice,
    ];
    expect(claims.filter((c) => typeof c === 'string')).toHaveLength(claims.length);
    for (const sentence of claims) {
      expect(sentence, String(sentence)).toContain('globex');
    }
  });

  it('never calls a scope clear, fine, healthy or safe — in any state it can be in', () => {
    for (const sentence of said) {
      expect(reassuringWordIn(sentence), sentence).toBeUndefined();
    }
  });

  it('the sweep above can fail — it catches a banned word in a sentence', () => {
    // The sweep is only worth its green if it discriminates. Every banned word,
    // fed through the same matcher the sweep uses, is caught; and the match is a
    // substring, so a word buried in a longer one is caught too.
    for (const word of REASSURING_WORDS) {
      expect(reassuringWordIn(`the scope is ${word} today`)).toBe(word);
    }
    expect(reassuringWordIn('the picture is unclear')).toBe('clear');
    expect(reassuringWordIn('This board does not cover gtm.')).toBeUndefined();
  });
});

/**
 * Which refusals take a scope AWAY, and which are the board having a bad
 * moment (#860).
 *
 * The predicate lives here because two components were reading the same refusal
 * and answering it differently — `ReposPage` kept its rows through a 503 and
 * `Pulse` deleted its stored boards for the same one, so a single outage on
 * `/gtm/team` cost the boards and left the map beside them standing.
 * `refusedScopeCopy` was doing the deciding in both, and it is the wrong
 * predicate for it: it answers non-null for BOTH of the gate's statuses because
 * both get a sentence, and only one of them is a withdrawal.
 */
describe('a withdrawal, told apart from a hiccup (#860)', () => {
  it('takes the scope away when the board has disowned the org', () => {
    expect(scopeWithdrawn('gtm', gate(404, 'gtm'))).toBe(true);
  });

  it('takes it away when the board refuses this reader', () => {
    // A 403 draws no sentence at all — `refusedScopeCopy` answers null for it —
    // and it is still the board withdrawing the scope, from this reader rather
    // than from everybody. Nothing on screen may go on asserting it.
    expect(scopeWithdrawn('gtm', { status: 403, message: null })).toBe(true);
    expect(refusedScopeCopy('gtm', { status: 403, message: null })).toBeNull();
  });

  it('keeps it through a 503, which is the board saying it serves the org', () => {
    // The gate's own split: a 404 means this board does not cover gtm, a 503
    // means it does and the listing failed on this build. Reading the second as
    // a withdrawal is what made a reload after a hiccup cold as well as blank.
    const hiccup = { status: 503, message: 'the project listing for gtm could not be read' };
    expect(refusedScopeCopy('gtm', hiccup)).not.toBeNull();
    expect(scopeWithdrawn('gtm', hiccup)).toBe(false);
  });

  it('keeps it through a status that is about something other than this org', () => {
    // A misrouted `/api/*` and a proxy with no upstream both answer statuses the
    // gate also uses, and name no org. Deleting a stored scope over one of those
    // is the same lie in the other direction.
    expect(scopeWithdrawn('gtm', outage(404))).toBe(false);
    expect(scopeWithdrawn('gtm', outage(503))).toBe(false);
  });

  it('keeps it on the union, and when the read named no status at all', () => {
    expect(scopeWithdrawn(null, gate(404, 'gtm'))).toBe(false);
    expect(scopeWithdrawn('gtm', null)).toBe(false);
  });

  it('takes it away from a refused reader on the UNION too (#862 review)', () => {
    // The regression this test was written against, and it was written from the
    // failure rather than from the code: the first cut of `scopeWithdrawn` read
    // `if (org === null || refusal === null) return false;` before the 403 arm,
    // so a reader the board had just refused kept `board_payload:projects` and
    // the boards drawn off it. That is what #824 fixed on `/team`, undone by the
    // move meant to unify the reading. The line above it is the reason the guard
    // looked right: the union has no org to disown, and a 403 has nothing to do
    // with an org.
    //
    // `/api/projects` is behind `JwtAuthGuard` then `TeamAccessGuard`, which
    // answers for the READER whatever `?org=` says, so `/team` with no org in
    // the address reaches here with `org` null and a stored copy under
    // `projects`. This is the case that costs somebody something.
    expect(scopeWithdrawn(null, { status: 403, message: null })).toBe(true);
    // And with a message that names an org the address did not: the 403 arm
    // reads no message at all, so this must not turn on one either way.
    expect(scopeWithdrawn(null, { status: 403, message: 'forbidden' })).toBe(true);
  });

  it('answers every (org, status) pair the two callers can hand it', () => {
    // One table, because the point of this function is that `Pulse` and
    // `ReposPage` cannot disagree any more — they both ask it, so a row here is
    // a claim about both pages at once. Narrowed and union side by side is what
    // catches a guard that fires one line too early: read down the 403 column.
    const withdrawnBy = (org: string | null, r: { status: number; message: string | null }) =>
      scopeWithdrawn(org, r);
    // Narrowed to gtm, and the message names gtm.
    expect(withdrawnBy('gtm', gate(404, 'gtm'))).toBe(true);
    expect(withdrawnBy('gtm', { status: 403, message: null })).toBe(true);
    expect(withdrawnBy('gtm', gate(503, 'gtm'))).toBe(false);
    expect(withdrawnBy('gtm', outage(500))).toBe(false);
    // The union, where there is no org to be disowned and still a reader to be
    // refused.
    expect(withdrawnBy(null, gate(404, 'gtm'))).toBe(false);
    expect(withdrawnBy(null, { status: 403, message: null })).toBe(true);
    expect(withdrawnBy(null, gate(503, 'gtm'))).toBe(false);
    expect(withdrawnBy(null, outage(500))).toBe(false);
  });
});
