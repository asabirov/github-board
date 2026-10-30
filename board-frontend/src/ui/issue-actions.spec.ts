import { describe, expect, it, vi } from 'vitest';
import {
  canOfferAssign,
  canOfferClose,
  issueActionItems,
  type ActionableIssue,
  type IssueActionEffects,
  type IssueActionOptions,
} from './issue-actions';

function mk(o: Partial<ActionableIssue> = {}): ActionableIssue {
  return {
    repo: 'acme',
    number: 1,
    title: 'An issue',
    htmlUrl: 'https://github.com/acme/acme/issues/1',
    ...o,
  };
}

function spies() {
  return {
    openExternal: vi.fn<IssueActionEffects['openExternal']>(),
    copy: vi.fn<IssueActionEffects['copy']>(),
    requestClose: vi.fn<IssueActionEffects['requestClose']>(),
    assignSelf: vi.fn<IssueActionEffects['assignSelf']>(),
    requestAssign: vi.fn<IssueActionEffects['requestAssign']>(),
  };
}

/** Every case states BOTH write verdicts, because neither `mayClose` nor
 *  `mayAssign` has a default: the option a surface forgets is the bug this menu
 *  had (#635). The close cases below keep `mayAssign: false`, so they read the
 *  same menu they read before the assign actions existed. */
const keys = (issue: ActionableIssue, opts: Partial<IssueActionOptions> = {}) =>
  issueActionItems(issue, { mayClose: true, mayAssign: false, ...opts }, spies()).map((i) => i.key);

const offers = (issue: ActionableIssue, opts: Partial<IssueActionOptions> = {}) =>
  canOfferClose(issue, { mayClose: true, mayAssign: false, ...opts });

/** A session that may assign and whose Github login is known — the state the two
 *  assign items are shaped by. Close is off, so each case reads one half. */
const assigning = (over: Partial<IssueActionOptions> = {}): IssueActionOptions => ({
  mayClose: false,
  mayAssign: true,
  viewerLogin: 'octocat',
  // The repo will assign the reader. A THIRD input since #752, and undefaulted
  // in the model for the reason the two verdicts are: absent withholds
  // `Assign to me`, so a case that means to read the whole assign menu has to
  // say so. The suite below asserts that gate directly.
  assignableLogins: ['octocat'],
  ...over,
});

const canAssign = (issue: ActionableIssue, over: Partial<IssueActionOptions> = {}) =>
  canOfferAssign(issue, assigning(over));

const items = (issue: ActionableIssue, opts: IssueActionOptions, fx = spies()) =>
  issueActionItems(issue, opts, fx);

// The whole point of #446 is that every surface renders ONE list — these lock
// the list's contents, order and labels so the four mount points can't drift.
describe('issueActionItems — the shared list', () => {
  it('is Open on GitHub · Copy link · Copy reference · Close, in that order', () => {
    expect(keys(mk())).toEqual(['open-github', 'copy-link', 'copy-reference', 'close']);
  });

  it('labels read exactly as they ship', () => {
    expect(issueActionItems(mk(), { mayClose: true, mayAssign: false }, spies()).map((i) => i.label)).toEqual([
      'Open on GitHub',
      'Copy link',
      'Copy reference',
      'Close issue…',
    ]);
  });

  it('marks only Close as the danger action', () => {
    const danger = issueActionItems(mk(), { mayClose: true, mayAssign: false }, spies()).filter((i) => i.danger).map((i) => i.key);
    expect(danger).toEqual(['close']);
  });

  it('Open on GitHub opens the issue URL', () => {
    const fx = spies();
    issueActionItems(mk({ htmlUrl: 'https://github.com/acme/board/issues/9' }), { mayClose: true, mayAssign: false }, fx)
      .find((i) => i.key === 'open-github')!
      .run();
    expect(fx.openExternal).toHaveBeenCalledWith('https://github.com/acme/board/issues/9');
  });

  it('Copy link copies the URL and confirms', () => {
    const fx = spies();
    issueActionItems(mk(), { mayClose: true, mayAssign: false }, fx).find((i) => i.key === 'copy-link')!.run();
    expect(fx.copy).toHaveBeenCalledWith('https://github.com/acme/acme/issues/1', 'Copied issue link');
  });

  it('Copy reference copies repo#number and confirms with it', () => {
    const fx = spies();
    issueActionItems(mk({ repo: 'board', number: 42 }), { mayClose: true, mayAssign: false }, fx)
      .find((i) => i.key === 'copy-reference')!
      .run();
    expect(fx.copy).toHaveBeenCalledWith('board#42', 'Copied board#42');
  });

  it('Close raises the confirm rather than writing directly', () => {
    const fx = spies();
    issueActionItems(mk(), { mayClose: true, mayAssign: false }, fx).find((i) => i.key === 'close')!.run();
    expect(fx.requestClose).toHaveBeenCalledTimes(1);
  });
});

// Close is the one write on these menus, and it is gated three times: by the
// issue itself (`canCloseIssue`), and by the two rules the caller composes into
// `mayClose` — the surface's, and the board credential's (#635).
describe('close eligibility', () => {
  it('offers Close on an open issue with a real Github issue URL', () => {
    expect(offers(mk())).toBe(true);
  });

  it('drops Close once the issue reads as closed', () => {
    expect(offers(mk(), { closed: true })).toBe(false);
    expect(keys(mk(), { closed: true })).toEqual(['open-github', 'copy-link', 'copy-reference']);
  });

  // The composed gate. It carries the read-only mirror's rule (product feedback
  // passes a flat false) AND the credential's — a board refused `issue.close`
  // must not be offered a Close it will be told no for (#635).
  it('drops Close when the caller says this menu may not close', () => {
    expect(offers(mk(), { mayClose: false })).toBe(false);
    expect(keys(mk(), { mayClose: false })).toEqual(['open-github', 'copy-link', 'copy-reference']);
  });

  it('drops Close when the URL is not a Github issue URL', () => {
    const pr = mk({ htmlUrl: 'https://github.com/acme/acme/pull/1' });
    expect(offers(pr)).toBe(false);
    expect(keys(pr)).toEqual(['open-github', 'copy-link', 'copy-reference']);
  });

  it('still offers Open on GitHub and both copies where Close is withheld', () => {
    expect(keys(mk(), { mayClose: false, closed: true })).toEqual([
      'open-github',
      'copy-link',
      'copy-reference',
    ]);
  });

  // Withdrawn means GONE, not present-and-dead. The menu is a dropdown: an item
  // has no label column beside it to say what was refused, and `facet-editors`
  // already settles that case for the four issue controls that are not rows.
  it('withdraws the item rather than disabling it', () => {
    expect(issueActionItems(mk(), { mayClose: false, mayAssign: false }, spies()).some((i) => i.key === 'close')).toBe(false);
  });
});

/**
 * The two assign actions (#751).
 *
 * They spend `issue.assignees` — the write `board-service` declares as
 * `@Writes('issue.assignees')` — so they are gated the way Close is: the
 * caller's composed `mayAssign`, and the issue itself having to be a real, still
 * open Github issue URL (owner and repo come off that URL; a row carries only a
 * short repo key).
 *
 * `Assign to me` needs one thing more that Close does not: the reader's Github
 * login. `/me` maps nobody to a handle on plenty of sessions, and "me" has no
 * value to write there — so that item alone goes and `Assign to…`, which asks
 * who, stays.
 */
describe('the assign actions', () => {
  it('sit after the read actions and before Close', () => {
    expect(keys(mk(), { mayClose: true, mayAssign: true, viewerLogin: 'octocat', assignableLogins: ['octocat'] })).toEqual([
      'open-github',
      'copy-link',
      'copy-reference',
      'assign-self',
      'assign-other',
      'close',
    ]);
  });

  it('label as they ship', () => {
    expect(items(mk(), assigning()).map((i) => i.label)).toEqual([
      'Open on GitHub',
      'Copy link',
      'Copy reference',
      'Assign to me',
      'Assign to…',
    ]);
  });

  /**
   * The menu had six items and ONE rule, before `Close issue…` (#752).
   *
   * So the two assign items were welded to the copy group and read as a third
   * copy action on first pass. They are not: Open, Copy link and Copy reference
   * leave the row exactly as it was, and the assign pair changes who owns the
   * issue. The order was already right — read-only, then mutate, then destroy —
   * and what was missing was the line saying where one group ends.
   */
  it('open with a rule, so they do not read as a third way of copying', () => {
    const menu = items(mk(), { mayClose: true, mayAssign: true, viewerLogin: 'octocat', assignableLogins: ['octocat'] });
    const ruled = menu.filter((i) => i.separator || i.danger).map((i) => i.key);
    expect(ruled).toEqual(['assign-self', 'close']);
  });

  // The rule belongs to the GROUP, not to `Assign to me` — which is withheld on
  // any repo that will not assign the reader, and would take the boundary with
  // it if it owned it.
  it('keeps the rule when only Assign to… is offered', () => {
    const menu = items(mk(), assigning({ viewerLogin: null }));
    expect(menu.filter((i) => i.separator).map((i) => i.key)).toEqual(['assign-other']);
  });

  // A rule and a tone are two different statements. `danger` is the one write
  // that cannot be taken back on Github; an assignment is one click to undo.
  it('are not danger actions', () => {
    const danger = items(mk(), { mayClose: true, mayAssign: true, viewerLogin: 'octocat', assignableLogins: ['octocat'] })
      .filter((i) => i.danger)
      .map((i) => i.key);
    expect(danger).toEqual(['close']);
  });

  it('Assign to me hands the reader’s own login to the write', () => {
    const fx = spies();
    items(mk(), assigning({ viewerLogin: 'octocat', assignableLogins: ['octocat'] }), fx)
      .find((i) => i.key === 'assign-self')!
      .run();
    expect(fx.assignSelf).toHaveBeenCalledWith('octocat');
  });

  it('Assign to… raises the picker rather than writing anything', () => {
    const fx = spies();
    items(mk(), assigning(), fx).find((i) => i.key === 'assign-other')!.run();
    expect(fx.requestAssign).toHaveBeenCalledTimes(1);
    expect(fx.assignSelf).not.toHaveBeenCalled();
  });
});

// The same three-way gate Close has, plus the login. Withheld means GONE, for
// the reason `issue-actions.ts` gives above `issueActionItems`.
describe('assign eligibility', () => {
  it('offers both on an open issue with a real Github issue URL', () => {
    expect(canAssign(mk())).toBe(true);
  });

  it('drops both where the caller says this menu may not assign', () => {
    expect(canAssign(mk(), { mayAssign: false })).toBe(false);
    expect(keys(mk(), { mayClose: false, mayAssign: false, viewerLogin: 'octocat', assignableLogins: ['octocat'] })).toEqual([
      'open-github',
      'copy-link',
      'copy-reference',
    ]);
  });

  // The default the surfaces had before this existed, and the one every surface
  // that has not opted in still passes: the menu is what it was.
  it('leaves the pre-assign menu byte-identical where the surface says no', () => {
    expect(keys(mk(), { mayClose: true, mayAssign: false })).toEqual([
      'open-github',
      'copy-link',
      'copy-reference',
      'close',
    ]);
  });

  it('drops both once the issue reads as closed', () => {
    expect(canAssign(mk(), { closed: true })).toBe(false);
    expect(keys(mk(), assigning({ closed: true }))).toEqual([
      'open-github',
      'copy-link',
      'copy-reference',
    ]);
  });

  it('drops both when the URL is not a Github issue URL', () => {
    const pr = mk({ htmlUrl: 'https://github.com/acme/acme/pull/1' });
    expect(canAssign(pr)).toBe(false);
    expect(keys(pr, assigning())).toEqual(['open-github', 'copy-link', 'copy-reference']);
  });

  // A session /me maps to no Github handle. There is nobody to write, so the
  // item that would write "me" goes — and the one that asks who stays, because
  // handing the issue to somebody else is still a thing this reader can do.
  it('drops only Assign to me when the reader has no Github login', () => {
    for (const viewerLogin of [null, '']) {
      expect(keys(mk(), assigning({ viewerLogin }))).toEqual([
        'open-github',
        'copy-link',
        'copy-reference',
        'assign-other',
      ]);
    }
  });

  it('withdraws the items rather than disabling them', () => {
    const withheld = items(mk(), assigning({ mayAssign: false })).map((i) => i.key);
    expect(withheld).not.toContain('assign-self');
    expect(withheld).not.toContain('assign-other');
  });
});

/**
 * `Assign to me` is a one-press, unconfirmed REPLACE, so it needs one thing more
 * than a capability verdict: the repo has to be willing to assign the reader
 * (#752).
 *
 * `PATCH …/assignees` replaces the set and Github DROPS a login the repo will
 * not assign, answering 200 with what it kept. So a reader without push access
 * pressing this on a report somebody was triaging took that person off it and
 * put nobody on — a silent hand-over to nobody, and the report left the person's
 * Your-work queue, which is the inverse of what #751 built the item for.
 * `Assign to…` is not exposed to this: its list IS the assignable set, so it
 * can only offer somebody Github will take.
 *
 * Absent means WITHHELD, not allowed. The set is a read and it is in flight for
 * the first moments of a page; saying nothing there must not mean yes (#635) —
 * and `Assign to…`, which asks who and carries the same list, is still offered.
 */
describe('Assign to me asks whether the repo will assign the reader (#752)', () => {
  const assignable = (logins: string[] | null, viewerLogin = 'octocat') =>
    keys(mk(), { mayClose: false, mayAssign: true, viewerLogin, assignableLogins: logins });

  it('offers it where the reader is on the repo’s assignable list', () => {
    expect(assignable(['anton', 'octocat'])).toContain('assign-self');
  });

  it('withholds it where the reader is not, and keeps Assign to…', () => {
    expect(assignable(['anton', 'IvanRoslov'])).toEqual([
      'open-github',
      'copy-link',
      'copy-reference',
      'assign-other',
    ]);
  });

  it('withholds it while the list is still being read, and where the read failed', () => {
    expect(assignable(null)).not.toContain('assign-self');
    expect(keys(mk(), { mayClose: false, mayAssign: true, viewerLogin: 'octocat' })).not.toContain('assign-self');
  });

  it('withholds it where the repo will assign nobody at all', () => {
    expect(assignable([])).not.toContain('assign-self');
  });

  // A login crosses a system boundary here. `me.githubLogin` is the handle
  // somebody actually typed (`github-login.resolver.ts`); `assignableLogins` is
  // Github's canonical casing. Comparing them exactly withholds the item from a
  // reader who is on the list — the same mis-casing that made the write report
  // its own success as a failure, one file over.
  it('matches the reader against the list however either is cased', () => {
    expect(assignable(['IvanRoslov'], 'ivanroslov')).toContain('assign-self');
    expect(assignable(['ivanroslov'], 'IvanRoslov')).toContain('assign-self');
  });

  // The gate is about the reader, not about the menu. `Assign to…` is offered
  // on exactly the terms it was, because every name it lists comes off this
  // list to begin with.
  it('leaves Assign to… alone', () => {
    for (const list of [null, [], ['somebody-else']]) {
      expect(assignable(list)).toContain('assign-other');
    }
  });
});
