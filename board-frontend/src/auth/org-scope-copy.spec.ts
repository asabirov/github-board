import { describe, expect, it } from 'vitest';
import type { OrgReadState } from '../api/types';
import {
  missingOrgsNotice,
  orgScopeCopy,
  orgScopeSentences,
  partlyReadNotices,
  unreadableOrgs,
} from './org-scope-copy';
import { REASSURING_WORDS, reassuringWordIn } from '../reassuring-words';

const read = (org: string): OrgReadState => ({ org, state: 'read', reason: null });
const unread = (org: string, reason: string | null = null): OrgReadState =>
  ({ org, state: 'unreadable', reason });

describe('what the board says about a partly-read scope (#650)', () => {
  it('names the org it could not read', () => {
    const copy = orgScopeCopy([read('acme'), unread('globex')]);
    expect(copy?.notice).toBe('These numbers leave out globex. The board could not read it.');
  });

  it('carries Github’s own words, so a revoked grant reads differently from an outage', () => {
    const revoked = orgScopeCopy([unread('globex', 'Bad credentials')]);
    const down = orgScopeCopy([unread('globex', 'Server Error')]);
    expect(revoked?.reason).toBe('GitHub’s answer: globex — Bad credentials.');
    expect(down?.reason).toBe('GitHub’s answer: globex — Server Error.');
    expect(revoked?.reason).not.toBe(down?.reason);
  });

  it('names every unreadable org, and only those', () => {
    const copy = orgScopeCopy([read('acme'), unread('globex'), unread('initech')]);
    expect(copy?.notice).toContain('globex and initech');
    expect(copy?.notice).toContain('could not read them.');
    expect(copy?.notice).not.toContain('acme');
    expect(unreadableOrgs([read('acme'), unread('initech')]).map((o) => o.org)).toEqual(['initech']);
  });

  it('says nothing when every org was read', () => {
    expect(orgScopeCopy([read('acme'), read('globex')])).toBeNull();
    expect(orgScopeSentences([read('acme'), read('globex')])).toEqual([]);
  });

  it('says nothing on an empty list — the board is making no claim, not reporting good news', () => {
    // An old board-service sends no `orgs` and api.ts reads that as []. If this
    // ever returned copy, that deploy would gain a line it has no grounds for.
    expect(orgScopeCopy([])).toBeNull();
    expect(orgScopeSentences([])).toEqual([]);
  });

  it('omits the reason line when Github gave no words, and keeps the notice', () => {
    const copy = orgScopeCopy([unread('globex', null)]);
    expect(copy?.reason).toBeNull();
    expect(copy?.notice).toContain('globex');
    expect(orgScopeCopy([unread('globex', '  ')])?.reason).toBeNull();
  });
});

describe('the orgs whose repos ARE on the answer, with something unread (#718)', () => {
  // A different set from the one above, and the difference is the whole point.
  // An org in `orgScopeCopy`'s list contributed NO rows — "these numbers leave
  // it out" is exactly true. An org here contributed its rows and something
  // beside them could not be read, so the same sentence would be false: the
  // reader is looking at that org's repos while being told they are missing.

  it('names which read failed, because the board knows which', () => {
    expect(partlyReadNotices([{ org: 'globex', unread: 'alerts' }])).toEqual([
      'The repos are here for globex. The board could not read its alerts.',
    ]);
    expect(partlyReadNotices([{ org: 'globex', unread: 'owners' }])).toEqual([
      'The repos are here for globex. The board could not read its owners.',
    ]);
    expect(partlyReadNotices([{ org: 'globex', unread: 'both' }])).toEqual([
      'The repos are here for globex. The board could not read its owners or its alerts.',
    ]);
  });

  it('reads for three orgs the way it reads for one', () => {
    expect(partlyReadNotices([
      { org: 'globex', unread: 'alerts' },
      { org: 'gtm', unread: 'alerts' },
      { org: 'acme', unread: 'alerts' },
    ])).toEqual([
      'The repos are here for globex, gtm and acme. The board could not read their alerts.',
    ]);
  });

  it('groups the orgs by the read that failed, in the order they were served', () => {
    // One sentence per kind, never one blanket phrase over three different
    // facts: a reader who is told "something could not be read" cannot tell
    // whether the owners on screen are wrong or the alert counts are.
    expect(partlyReadNotices([
      { org: 'globex', unread: 'alerts' },
      { org: 'gtm', unread: 'owners' },
      { org: 'acme', unread: 'alerts' },
    ])).toEqual([
      'The repos are here for globex and acme. The board could not read their alerts.',
      'The repos are here for gtm. The board could not read its owners.',
    ]);
  });

  it('says nothing when nothing is unread — there is no reassuring state to draw', () => {
    expect(partlyReadNotices([])).toEqual([]);
  });
});

describe('the same sentence for a caller holding org NAMES (#718)', () => {
  it('is the sentence orgScopeCopy already writes, not a second copy of it', () => {
    // The Repos payload names its lost orgs as bare strings — there is no
    // per-org reason on it — so this adapter exists rather than a page
    // fabricating `OrgReadState`s to reach the sentence.
    expect(missingOrgsNotice(['gtm'])).toBe(orgScopeCopy([
      { org: 'gtm', state: 'unreadable', reason: null },
    ])?.notice);
    expect(missingOrgsNotice(['gtm'])).toBe('These numbers leave out gtm. The board could not read it.');
    expect(missingOrgsNotice(['gtm', 'acme'])).toContain('gtm and acme');
  });

  it('says nothing for an empty list', () => {
    expect(missingOrgsNotice([])).toBeNull();
  });
});

describe('the notice says nothing about the orgs it DID read (#650)', () => {
  it('never calls a scope clear, fine, healthy or safe — in any state it can be in', () => {
    // Same rule as the repo tile's (#613), same list, one const: a surface that
    // has read part of a scope may report what is missing and may not grade what
    // is left. There is no "all orgs read" line to write here at all — the only
    // copy this module produces is about an org it could NOT read.
    //
    // The sentences are read off `OrgScopeCopy`'s values rather than a list of
    // function names, so a line added to that shape is swept without anybody
    // adding it here.
    const said = [
      // The #718 sentences join the sweep by being written, the same way the
      // shape's own values do: they are copy from this module and answer for
      // the same partly-read scope.
      ...partlyReadNotices([{ org: 'globex', unread: 'alerts' }]),
      ...partlyReadNotices([{ org: 'globex', unread: 'owners' }]),
      ...partlyReadNotices([{ org: 'globex', unread: 'both' }, { org: 'gtm', unread: 'alerts' }]),
      missingOrgsNotice(['globex', 'gtm'])!,
      ...orgScopeSentences([unread('globex')]),
      ...orgScopeSentences([unread('globex', 'Bad credentials')]),
      ...orgScopeSentences([read('acme'), unread('globex'), unread('initech')]),
      ...orgScopeSentences([read('acme'), unread('globex', 'Not Found'), unread('initech', 'Server Error')]),
      ...orgScopeSentences([read('acme')]),
      ...orgScopeSentences([]),
    ];
    expect(said.length).toBeGreaterThan(5);
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
    expect(reassuringWordIn('These numbers leave out globex.')).toBeUndefined();
  });
});
