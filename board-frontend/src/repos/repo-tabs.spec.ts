/**
 * What the four tabs decide, away from the page that draws them (#828).
 *
 * The board's test env is `node` with no DOM, so every one of these decisions is
 * a pure function on purpose: which tab is current, what number a tab may print,
 * and which of the four sentences a list says about itself. `RepoPage.spec.tsx`
 * checks that the page draws them; this checks that they are right.
 */
import { describe, expect, it } from 'vitest';
import type { RepoMember, RepoOpenIssue, RepoOpenPr, RepoPageView, RepoPrFlow, RepoRow } from '../api/repos';
import { issuesTab, memberLine, membersTab, people, prsTab, repoTabs } from './repo-tabs';
import { ISSUES_UNREADABLE, issueFlowCard } from './repo-page-vm';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const REPO: RepoRow = {
  full: 'acme/board',
  name: 'board',
  key: 'board',
  htmlUrl: 'https://github.com/acme/board',
  description: null,
  weeks: Array.from({ length: 10 }, () => ({ opened: 1, closed: 1 })),
  open: 3,
  owner: null,
  language: null,
  pushedAt: ago(1),
};

const issues = (n: number, from = 500): RepoOpenIssue[] =>
  Array.from({ length: n }, (_, i) => ({
    number: from + i,
    title: `Something open (${i})`,
    htmlUrl: `https://github.com/acme/board/issues/${from + i}`,
    createdAt: ago(2 + i),
    author: 'octocat',
    labels: [],
  }));

const prs = (n: number, from = 800): RepoOpenPr[] =>
  Array.from({ length: n }, (_, i) => ({
    number: from + i,
    title: `Something in flight (${i})`,
    htmlUrl: `https://github.com/acme/board/pull/${from + i}`,
    createdAt: ago(1 + i),
    author: 'octocat',
    authorIsBot: false,
    draft: i === 0,
  }));

const READ_PRS = (over: Partial<Extract<RepoPrFlow, { state: 'read' }>> = {}): RepoPrFlow => ({
  state: 'read',
  open: 2,
  closedMerged: 40,
  weeks: Array.from({ length: 10 }, () => ({ opened: 1, merged: 1 })),
  openPrs: prs(2),
  ...over,
});

const member = (over: Partial<RepoMember> = {}): RepoMember => ({
  login: 'octocat',
  name: 'Octocat',
  assigned: 2,
  openedIssues: 5,
  openedPrs: 3,
  dri: false,
  ...over,
});

function view(over: Partial<RepoPageView> = {}): RepoPageView {
  return {
    updatedAt: ago(0),
    repo: REPO,
    readme: { state: 'absent' },
    pullRequests: READ_PRS(),
    ciSpend: { state: 'read', weeks: [] },
    openIssues: issues(3),
    members: { people: [member()], prsUnreadable: false },
    ...over,
  };
}

const tab = (v: RepoPageView, key: string) => repoTabs(v, undefined).find((t) => t.key === key)!;

describe('the tab row is four addresses, and each is one press (#828)', () => {
  it('names the four, in reading order, each at its own path', () => {
    expect(repoTabs(view(), undefined).map((t) => [t.label, t.href])).toEqual([
      ['Overview', '/repo/acme/board'],
      ['Issues', '/repo/acme/board/issues'],
      ['PRs', '/repo/acme/board/prs'],
      ['Members', '/repo/acme/board/members'],
    ]);
  });

  it('marks exactly one current, and the bare path marks Overview', () => {
    for (const section of [undefined, 'issues', 'prs', 'members'] as const) {
      const row = repoTabs(view(), section);
      expect(row.filter((t) => t.current).map((t) => t.key), String(section))
        .toEqual([section ?? 'overview']);
    }
  });

  it('counts what a reader is choosing between, and leaves Overview uncounted', () => {
    // Three trends and a readme: no one number is what somebody opens Overview
    // for, so it carries none rather than carrying an arbitrary one.
    const v = view();
    expect(tab(v, 'overview').count).toBeNull();
    expect(tab(v, 'issues').count).toBe(3);
    expect(tab(v, 'prs').count).toBe(2);
    expect(tab(v, 'members').count).toBe(1);
  });

  it('counts the repo’s open issues, not the rows the payload carried', () => {
    // The list is capped and the count is not. A tab reading `Issues 100` over a
    // repo with 137 open would be the cap drawn as the count.
    const v = view({ repo: { ...REPO, open: 137 }, openIssues: issues(100) });
    expect(tab(v, 'issues').count).toBe(137);
  });

  it('takes the count off a tab whose read failed', () => {
    // `PRs 0` over a read Github refused claims a repo has no open pull
    // requests. It is the one claim this page's whole design is against.
    const v = view({ pullRequests: { state: 'unreadable' } });
    expect(tab(v, 'prs').count).toBeNull();
  });

  it('takes the count off Members when the pull requests could not be read', () => {
    // The people found in the issues are real; the list is short by everybody
    // who only opens pull requests, so a number on the tab would present a part
    // as the whole.
    const v = view({ members: { people: [member()], prsUnreadable: true } });
    expect(tab(v, 'members').count).toBeNull();
  });

  it('takes the count off Members when this board was never sent them', () => {
    // A board-web that deploys before board-api meets a payload with no
    // `members` at all. Zero would be a claim about the repo.
    const v = view({ members: undefined });
    expect(tab(v, 'members').count).toBeNull();
  });
});

describe('the Issues tab tells an empty queue from a capped list (#828)', () => {
  it('draws the whole list it was given, and says how many are open', () => {
    const t = issuesTab(view());
    expect(t.kind).toBe('read');
    if (t.kind !== 'read') return;
    expect(t.issues).toHaveLength(3);
    expect(t.meta).toBe('3 open');
    // Nothing was withheld, so nothing is said about withholding and no row
    // offers to show what is already on screen.
    expect(t.capped).toBeNull();
    expect(t.showAll).toBeNull();
  });

  it('says the list is capped rather than drawing the cap as the count', () => {
    const t = issuesTab(view({ repo: { ...REPO, open: 137 }, openIssues: issues(100) }));
    expect(t.kind).toBe('read');
    if (t.kind !== 'read') return;
    expect(t.meta).toBe('137 open');
    expect(t.capped).toBe('The newest 100 issues are here.');
    expect(t.showAll).toBe('Show all 137 open issues');
  });

  it('says an empty queue is empty of OPEN issues, and offers no rest', () => {
    // True of a repo whose queue is entirely closed as well as of one that never
    // had an issue (#826).
    const t = issuesTab(view({ repo: { ...REPO, open: 0 }, openIssues: [] }));
    expect(t).toEqual({ kind: 'nothing', line: 'No open issues.' });
  });
});

describe('the Issues tab tells a measured zero from a read that failed (#837)', () => {
  // The block had two answers where the three cards beside it have three. One
  // repo timing out on a secondary rate limit contributes no rows, and
  // `repo.open` is rolled up from the same ingest and reads zero too — so both
  // halves agreed on "nothing here" while neither had looked.
  it('says the read failed rather than drawing an empty queue', () => {
    const t = issuesTab(view({ repo: { ...REPO, open: 0 }, openIssues: [], openIssuesState: 'unreadable' }));
    expect(t).toEqual({ kind: 'unreadable', line: ISSUES_UNREADABLE });
    // The one thing it must never say.
    expect(t.kind === 'unreadable' && t.line).not.toBe('No open issues.');
  });

  it('says so even where the ingest happened to carry rows for it', () => {
    // `unreadable` is settled before the list is looked at: a stale row from an
    // earlier build is not evidence this build read anything.
    const t = issuesTab(view({ openIssuesState: 'unreadable' }));
    expect(t.kind).toBe('unreadable');
  });

  it('takes the count off the tab, rather than drawing a zero nobody measured', () => {
    const v = view({ repo: { ...REPO, open: 0 }, openIssues: [], openIssuesState: 'unreadable' });
    expect(tab(v, 'issues').count).toBeNull();
  });

  it('keeps today’s answer for a board-api that sends no state at all', () => {
    // Absent is a fact about the PAYLOAD, not about the read. Both services ship
    // from `main` independently, so a board-web can meet a board-api older than
    // #837 — and drawing "could not be read" over every page would be this same
    // defect pointing the other way.
    const t = issuesTab(view({ repo: { ...REPO, open: 0 }, openIssues: [], openIssuesState: undefined }));
    expect(t).toEqual({ kind: 'nothing', line: 'No open issues.' });
    expect(tab(view({ openIssuesState: undefined }), 'issues').count).toBe(REPO.open);
  });

  // The half of #837 the first pass missed. The Overview's issue-flow card and
  // this tab are two drawings of ONE ingest read, one click apart, and an
  // unread repo's `weeks` are zero for the reason its list is empty — so the
  // Overview said "Nothing opened or closed in ten weeks" beside a tab saying
  // the read failed. Same page, same read, opposite answers, and the Overview's
  // is the false positive.
  it('and the Overview card beside it never disagree about one read', () => {
    const v = view({
      repo: { ...REPO, open: 0, weeks: Array.from({ length: 10 }, () => ({ opened: 0, closed: 0 })) },
      openIssues: [],
      openIssuesState: 'unreadable',
    });
    const card = issueFlowCard(v.repo, NOW, v.openIssuesState);
    const t = issuesTab(v);
    expect(card.kind).toBe('unreadable');
    expect(t.kind).toBe('unreadable');
    // Not merely both unreadable — the same sentence, from the one constant.
    expect(card.kind !== 'read' && card.line).toBe(t.kind !== 'read' ? t.line : null);
    expect(card.kind !== 'read' && card.line).toBe(ISSUES_UNREADABLE);
  });
});

describe('the PRs tab (#828)', () => {
  it('lists what came back and says how many are open', () => {
    const t = prsTab(READ_PRS());
    expect(t.kind).toBe('read');
    if (t.kind !== 'read') return;
    expect(t.prs).toHaveLength(2);
    expect(t.meta).toBe('2 open');
    expect(t.capped).toBeNull();
  });

  it('says the list is capped where the repo has more open than it carries', () => {
    const t = prsTab(READ_PRS({ open: 118, openPrs: prs(100) }));
    expect(t.kind).toBe('read');
    if (t.kind !== 'read') return;
    expect(t.meta).toBe('118 open');
    expect(t.capped).toBe('The newest 100 pull requests are here.');
  });

  it('words a failed read exactly as the trend card does', () => {
    // One read, drawn in two places. Two wordings would let a reader think two
    // things failed.
    const t = prsTab({ state: 'unreadable' });
    expect(t).toEqual({ kind: 'unreadable', line: 'Pull requests couldn’t be read just now.' });
  });

  it('tells a repo with none from a repo with none open', () => {
    expect(prsTab(READ_PRS({ open: 0, closedMerged: 0, openPrs: [] })))
      .toEqual({ kind: 'nothing', line: 'No pull requests in this repo.' });
    expect(prsTab(READ_PRS({ open: 0, closedMerged: 40, openPrs: [] })))
      .toEqual({ kind: 'nothing', line: 'No open pull requests.' });
  });

  it('never draws a count with no list as an empty queue', () => {
    // The deploy window: a board-api that predates `openPrs` answers `read` with
    // the count and no list. "No open pull requests" would be a lie about the
    // repo told by a fact about the payload.
    const t = prsTab(READ_PRS({ open: 4, openPrs: undefined }));
    expect(t.kind).toBe('unlisted');
    if (t.kind !== 'unlisted') return;
    expect(t.line).toBe('4 pull requests open, and none of them are in what this board was sent.');
    expect(t.line).not.toContain('No open');
  });
});

describe('the Members tab (#828)', () => {
  it('lists the people and counts them', () => {
    const t = membersTab({ people: [member(), member({ login: 'ivan', name: null })], prsUnreadable: false });
    expect(t.kind).toBe('read');
    if (t.kind !== 'read') return;
    expect(t.people).toHaveLength(2);
    expect(t.meta).toBe('2 people');
    expect(t.short).toBeNull();
  });

  it('says a person, singular, for one', () => {
    expect(people(1)).toBe('1 person');
    expect(people(0)).toBe('0 people');
  });

  it('says the list is short when the pull requests could not be read', () => {
    const t = membersTab({ people: [member()], prsUnreadable: true });
    expect(t.kind).toBe('read');
    if (t.kind !== 'read') return;
    // The list is still drawn: those people are real. What it may not do is read
    // as the whole of who works here.
    expect(t.short).toContain('Pull requests couldn’t be read just now.');
    expect(t.short).toContain('anybody who only opens them is missing');
    // …and it carries no count of its own beside a sentence saying it is short.
    expect(t.meta).toBeNull();
  });

  it('does not say nobody works here when the half that would name them failed', () => {
    const t = membersTab({ people: [], prsUnreadable: true });
    expect(t.kind).toBe('unreadable');
    if (t.kind !== 'unreadable') return;
    expect(t.line).toContain('Pull requests couldn’t be read just now.');
    expect(t.line).not.toContain('Nobody has opened an issue or a pull request here in the last 10 weeks');
  });

  it('says nobody works here only when both halves were read', () => {
    const t = membersTab({ people: [], prsUnreadable: false });
    expect(t.kind).toBe('nothing');
    if (t.kind !== 'nothing') return;
    expect(t.line).toContain('in the last 10 weeks');
  });

  it('tells a list this board was never sent from an empty one', () => {
    const t = membersTab(undefined);
    expect(t).toEqual({ kind: 'unlisted', line: 'This board hasn’t been sent who works on this repo.' });
  });
});

describe('a member’s row prints no number that was not measured (#828)', () => {
  it('says what they did, in the plural the number wants', () => {
    expect(memberLine(member({ assigned: 1, openedIssues: 1, openedPrs: 1 }), false))
      .toBe('1 open issue assigned, opened 1 issue and 1 pull request');
    expect(memberLine(member(), false)).toBe('2 open issues assigned, opened 5 issues and 3 pull requests');
  });

  it('drops a clause at zero rather than printing the zero', () => {
    expect(memberLine(member({ assigned: 0 }), false)).toBe('opened 5 issues and 3 pull requests');
    expect(memberLine(member({ openedIssues: 0, openedPrs: 0 }), false)).toBe('2 open issues assigned');
  });

  it('counts no pull requests at all when the pull-request read failed', () => {
    // `openedPrs` is 0 for everybody in that case. Printed, it says this person
    // opened none, which is the absence-drawn-as-zero this page is against; the
    // list says why in one sentence above instead.
    expect(memberLine(member({ openedPrs: 3 }), true)).toBe('2 open issues assigned, opened 5 issues');
  });

  it('says nothing at all for the owner with nothing to their name', () => {
    // The DRI is in the list at three zeros because the org names them. The row
    // says that with its owner mark, not with a line of noughts.
    expect(memberLine(member({ assigned: 0, openedIssues: 0, openedPrs: 0, dri: true }), false)).toBeNull();
  });
});
