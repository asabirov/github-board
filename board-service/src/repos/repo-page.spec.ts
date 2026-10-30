import { describe, expect, it } from 'vitest';
import {
  COMPARED_WEEKS,
  ciSpendWindows,
  completedDayChange,
  membersFor,
  monthsSpanning,
  openIssuesAt,
  openIssuesFor,
  openPrsAt,
  previousPeriod,
  pullRequestWindows,
  windowStart,
  OPEN_ISSUES_CAP,
} from './repo-page';
import { HIDDEN_FEEDBACK_TITLE } from '../auth/feedback-visibility';
import type { PageIssue } from './repo-page';
import { REPO_WEEKS } from './repo-rollup';
import type { ActionsUsageDay, RepoOpenPr, RepoPrRead, RepoPrRecord } from './repo.types';

const NOW = '2026-08-14T12:00:00.000Z';
const DAY_MS = 86_400_000;
const daysBefore = (d: number): string => new Date(Date.parse(NOW) - d * DAY_MS).toISOString();

const pr = (
  number: number,
  createdAt: string,
  mergedAt: string | null = null,
  author: string | null = null,
  authorIsBot = false,
): RepoPrRecord => ({
  number,
  createdAt,
  mergedAt,
  // A merge is a close; a PR closed unmerged is written out where it matters.
  closedAt: mergedAt,
  author,
  authorIsBot,
});

/** The same record, opened by a machine — dependabot on the live repo. */
const botPr = (number: number, createdAt: string, mergedAt: string | null = null): RepoPrRecord =>
  pr(number, createdAt, mergedAt, 'dependabot', true);

const openPr = (
  number: number,
  createdAt: string,
  author: string | null = null,
  authorIsBot = false,
): RepoOpenPr => ({
  number,
  title: `PR #${number}`,
  htmlUrl: `https://github.com/acme/board/pull/${number}`,
  createdAt,
  author,
  authorIsBot,
  draft: false,
});

const usage = (full: string, date: string, minutes: number, netUsd: number): ActionsUsageDay => ({
  full,
  date,
  minutes,
  netUsd,
});

describe('pullRequestWindows (#575)', () => {
  it('buckets opened and merged into the same windows the issue weeks use', () => {
    const flow = pullRequestWindows(
      {
        state: 'read',
        open: 1,
        closedMerged: 312,
        coveredFrom: null,
        prs: [pr(1, daysBefore(2), daysBefore(1)), pr(2, daysBefore(3)), pr(3, daysBefore(9), daysBefore(8))],
        openPrs: [],
      },
      NOW,
    );
    expect(flow.state).toBe('read');
    if (flow.state !== 'read') return;
    expect(flow.weeks).toHaveLength(REPO_WEEKS);
    expect(flow.weeks[REPO_WEEKS - 1]).toEqual({ opened: 2, merged: 1 });
    expect(flow.weeks[REPO_WEEKS - 2]).toEqual({ opened: 1, merged: 1 });
    expect(flow.open).toBe(1);
    expect(flow.closedMerged).toBe(312);
  });

  it('counts a PR opened before the window and merged inside it as merged only', () => {
    const flow = pullRequestWindows(
      {
        state: 'read',
        open: 0,
        closedMerged: 1,
        coveredFrom: null,
        prs: [pr(1, daysBefore(400), daysBefore(2))],
        openPrs: [],
      },
      NOW,
    );
    if (flow.state !== 'read') throw new Error('expected a read');
    expect(flow.weeks[REPO_WEEKS - 1]).toEqual({ opened: 0, merged: 1 });
    // Nothing was invented in the window its creation would have landed in.
    expect(flow.weeks.filter((w) => w && w.opened > 0)).toHaveLength(0);
  });

  it('reports a window the read never reached as unknown, never as zero', () => {
    const flow = pullRequestWindows(
      {
        state: 'read',
        open: 1,
        closedMerged: 312,
        // The cap ran out 15 days back — everything older is unread.
        coveredFrom: daysBefore(15),
        prs: [pr(1, daysBefore(2), daysBefore(1))],
        openPrs: [],
      },
      NOW,
    );
    if (flow.state !== 'read') throw new Error('expected a read');
    // The two most recent windows are covered; the eight before them are not.
    expect(flow.weeks[REPO_WEEKS - 1]).toEqual({ opened: 1, merged: 1 });
    expect(flow.weeks[REPO_WEEKS - 2]).toEqual({ opened: 0, merged: 0 });
    expect(flow.weeks.slice(0, REPO_WEEKS - 2).every((w) => w === null)).toBe(true);
  });

  it('covers every window when the read reached the whole history', () => {
    const flow = pullRequestWindows(
      { state: 'read', open: 0, closedMerged: 0, coveredFrom: null, prs: [], openPrs: [] },
      NOW,
    );
    if (flow.state !== 'read') throw new Error('expected a read');
    expect(flow.weeks.every((w) => w !== null)).toBe(true);
    expect(flow.weeks[0]).toEqual({ opened: 0, merged: 0 });
  });

  it('stays unreadable when the read itself did not answer', () => {
    expect(pullRequestWindows({ state: 'unreadable' }, NOW)).toEqual({ state: 'unreadable' });
  });

  // #828 — the PRs tab's list rides on the `read` variant, so a repo with no
  // open pull requests and a repo Github would not answer for cannot be told
  // apart by a length alone.
  it('carries the open list through untouched, and tells an EMPTY one from an unread one', () => {
    const flow = pullRequestWindows(
      {
        state: 'read',
        open: 2,
        closedMerged: 0,
        coveredFrom: null,
        prs: [],
        openPrs: [openPr(9, daysBefore(1), 'octocat'), openPr(8, daysBefore(40), null)],
      },
      NOW,
    );
    if (flow.state !== 'read') throw new Error('expected a read');
    expect(flow.openPrs.map((p) => p.number)).toEqual([9, 8]);
    // A PR older than the whole window is still on the list: it is what is
    // OPEN, not what happened lately, and the stale ones are the point.
    expect(flow.openPrs[1].author).toBeNull();

    const empty = pullRequestWindows(
      { state: 'read', open: 0, closedMerged: 4, coveredFrom: null, prs: [], openPrs: [] },
      NOW,
    );
    if (empty.state !== 'read') throw new Error('expected a read');
    expect(empty.openPrs).toEqual([]);

    // Not an empty list: no list at all, and a state saying why.
    const unread = pullRequestWindows({ state: 'unreadable' }, NOW);
    expect(unread.state).toBe('unreadable');
    expect(unread).not.toHaveProperty('openPrs');
  });

  it('keeps a bot’s open pull request on the list, marked (#828)', () => {
    // The members tab does not count it; the PRs tab still has to draw it.
    // Eight of board's own open PRs are dependabot's, and a tab that hid them
    // would report a queue of nothing on a repo with eight things to merge.
    const flow = pullRequestWindows(
      {
        state: 'read',
        open: 2,
        closedMerged: 0,
        coveredFrom: null,
        prs: [],
        openPrs: [openPr(9, daysBefore(1), 'dependabot', true), openPr(8, daysBefore(2), 'octocat')],
      },
      NOW,
    );
    if (flow.state !== 'read') throw new Error('expected a read');
    expect(flow.openPrs.map((p) => [p.author, p.authorIsBot])).toEqual([
      ['dependabot', true],
      ['octocat', false],
    ]);
  });

  it('reports the cap as a page of `open`, never as the count', () => {
    // 100 rows against a total of 312: the two disagree on purpose, and the
    // payload has to keep both so the tab can say which is which.
    const flow = pullRequestWindows(
      {
        state: 'read',
        open: 312,
        closedMerged: 0,
        coveredFrom: null,
        prs: [],
        openPrs: Array.from({ length: 100 }, (_, i) => openPr(i, daysBefore(i))),
      },
      NOW,
    );
    if (flow.state !== 'read') throw new Error('expected a read');
    expect(flow.openPrs).toHaveLength(100);
    expect(flow.open).toBe(312);
  });
});

describe('ciSpendWindows (#582)', () => {
  it('sums this repo’s net cost and minutes per window, ignoring every other repo', () => {
    const spend = ciSpendWindows(
      [
        usage('acme/board', daysBefore(1), 1383, 7.48),
        usage('acme/board', daysBefore(3), 200, 1.2),
        usage('acme/acme', daysBefore(1), 9999, 60),
        usage('acme/board', daysBefore(9), 100, 0.6),
      ],
      'acme/board',
      NOW,
    );
    if (spend.state !== 'read') throw new Error('expected a read');
    expect(spend.weeks).toHaveLength(REPO_WEEKS);
    expect(spend.weeks[REPO_WEEKS - 1]).toEqual({ minutes: 1583, netUsd: 8.68 });
    expect(spend.weeks[REPO_WEEKS - 2]).toEqual({ minutes: 100, netUsd: 0.6 });
  });

  it('keeps a week of real minutes billed at $0 apart from a week that ran nothing', () => {
    const spend = ciSpendWindows(
      [usage('acme/acme-docs', daysBefore(2), 293, 0)],
      'acme/acme-docs',
      NOW,
    );
    if (spend.state !== 'read') throw new Error('expected a read');
    // Ran, cost nothing — the allowance absorbed it.
    expect(spend.weeks[REPO_WEEKS - 1]).toEqual({ minutes: 293, netUsd: 0 });
    // Ran nothing at all. Same dollars, different fact.
    expect(spend.weeks[REPO_WEEKS - 2]).toEqual({ minutes: 0, netUsd: 0 });
  });

  it('drops usage older than the window rather than piling it into the oldest one', () => {
    const spend = ciSpendWindows(
      [usage('acme/roadmap', daysBefore(400), 5000, 30)],
      'acme/roadmap',
      NOW,
    );
    if (spend.state !== 'read') throw new Error('expected a read');
    expect(spend.weeks.every((w) => w.minutes === 0 && w.netUsd === 0)).toBe(true);
  });

  it('is unreadable when the billing report could not be read', () => {
    expect(ciSpendWindows(null, 'acme/roadmap', NOW)).toEqual({ state: 'unreadable' });
  });
});

describe('monthsSpanning (#575)', () => {
  it('names every calendar month the window touches, oldest first', () => {
    expect(monthsSpanning(Date.parse('2026-06-06T00:00:00Z'), Date.parse('2026-08-14T12:00:00Z'))).toEqual([
      { year: 2026, month: 6 },
      { year: 2026, month: 7 },
      { year: 2026, month: 8 },
    ]);
  });

  it('names one month when the window sits inside one', () => {
    expect(monthsSpanning(Date.parse('2026-08-02T00:00:00Z'), Date.parse('2026-08-14T00:00:00Z'))).toEqual([
      { year: 2026, month: 8 },
    ]);
  });

  it('names FOUR months when the window spans four, which it does on 110 days of the year', () => {
    // 2026-01-01's 10-week window opens on 2025-10-23. A read that assumed
    // three months would fetch nothing for the oldest windows, and windows
    // fetched from nothing draw as `minutes: 0` — "nothing ran".
    const end = Date.parse('2026-01-01T00:00:00Z');
    expect(monthsSpanning(windowStart('2026-01-01T00:00:00Z'), end)).toEqual([
      { year: 2025, month: 10 },
      { year: 2025, month: 11 },
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
    ]);
  });

  it('crosses a year boundary as 1-12 months, not 0-11', () => {
    expect(monthsSpanning(Date.parse('2025-12-20T00:00:00Z'), Date.parse('2026-01-05T00:00:00Z'))).toEqual([
      { year: 2025, month: 12 },
      { year: 2026, month: 1 },
    ]);
  });
});

describe('windowStart (#575)', () => {
  it('opens the window exactly REPO_WEEKS × 7 days before now', () => {
    expect(windowStart(NOW)).toBe(Date.parse(NOW) - REPO_WEEKS * 7 * DAY_MS);
  });
});

describe('openIssuesFor (#575, #826, #836)', () => {
  /** The scope the board actually runs, with `FEEDBACK_REPO` set to the board's
   *  own repo the way this deployment sets it, so the queue the old form filed into
   *  IS the queue this page draws. There is no default behind that since #1175:
   *  a board that names no feedback repository does not boot. */
  const SCOPE = { owner: 'acme', repo: 'board', labels: ['feedback'] };

  const issue = (repo: string, number: number, createdAt: string, owner = 'acme') => ({
    owner,
    repo,
    number,
    title: `#${number}`,
    htmlUrl: `https://github.com/acme/board/issues/${number}`,
    state: 'open' as const,
    createdAt,
    closedAt: null as string | null,
    author: 'octocat',
    assignees: [],
    labels: ['bug'],
    labelsComplete: true,
    submission: false,
  });

  const closedIssue = (repo: string, number: number, createdAt: string, owner = 'acme') => ({
    ...issue(repo, number, createdAt, owner),
    state: 'closed' as const,
  });

  it('takes this repo’s issues newest first', () => {
    const rows = openIssuesFor(
      [issue('board', 1, daysBefore(9)), issue('acme', 2, daysBefore(1)), issue('board', 3, daysBefore(2))],
      { full: 'acme/board', key: 'board' }, SCOPE,
    );
    expect(rows.map((r) => r.number)).toEqual([3, 1]);
    expect(rows[0].title).toBe('#3');
    expect(rows[0].labels).toEqual(['bug']);
  });

  it('caps the list at a hundred (#828)', () => {
    const many = Array.from({ length: 140 }, (_, i) => issue('board', i, daysBefore(i)));
    // A hundred, written as a hundred. Asserting `OPEN_ISSUES_CAP` here would
    // check the constant against itself and stay green whatever it was changed
    // to; the cap is a decision about the payload and moving it owes a test of
    // its own. It was five until #828 gave the Issues tab the whole queue.
    expect(openIssuesFor(many, { full: 'acme/board', key: 'board' }, SCOPE)).toHaveLength(100);
    expect(OPEN_ISSUES_CAP).toBe(100);
  });

  it('is empty for a repo with an empty queue', () => {
    expect(
      openIssuesFor([issue('board', 1, daysBefore(1))], { full: 'acme/status', key: 'status' }, SCOPE),
    ).toEqual([]);
  });

  // #647, the same collision the rollup guards: two orgs each own a
  // `design-system`, so a page keyed on the short key alone lists the other
  // org's issues under this one's name.
  it('lists no issue from another org’s repo of the same name', () => {
    const rows = openIssuesFor(
      [
        issue('design-system', 1, daysBefore(1), 'acme'),
        issue('design-system', 2, daysBefore(2), 'globex'),
      ],
      { full: 'globex/design-system', key: 'design-system' }, SCOPE,
    );
    expect(rows.map((r) => r.number)).toEqual([2]);
  });

  // #826. board's own page drew ten rows sorted by `createdAt`, six of them
  // closed, so the newest closed issue outranked every open one under it.
  it('drops the closed rows, however new they are', () => {
    const rows = openIssuesFor(
      [
        closedIssue('board', 128, daysBefore(1)),
        issue('board', 126, daysBefore(2)),
        closedIssue('board', 119, daysBefore(3)),
        issue('board', 117, daysBefore(4)),
      ],
      { full: 'acme/board', key: 'board' }, SCOPE,
    );
    expect(rows.map((r) => r.number)).toEqual([126, 117]);
  });

  // #828. The cap is the payload's limit, not the block's size: a repo with
  // eight open issues gets eight rows, where the five-row block gave it five and
  // said nothing about the three it dropped.
  it('hands back every open issue when there are fewer than the cap, newest first', () => {
    const rows = openIssuesFor(
      Array.from({ length: 8 }, (_, i) => issue('board', i, daysBefore(i))),
      { full: 'acme/board', key: 'board' }, SCOPE,
    );
    expect(rows.map((r) => r.number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('takes the NEWEST hundred when there are more, not the first hundred it met', () => {
    // Oldest first in the input, so a cap applied before the sort would answer
    // with the hundred oldest — the rows nobody opened this tab for.
    const rows = openIssuesFor(
      Array.from({ length: 120 }, (_, i) => issue('board', i, daysBefore(120 - i))),
      { full: 'acme/board', key: 'board' }, SCOPE,
    );
    expect(rows).toHaveLength(100);
    expect(rows[0].number).toBe(119);
    expect(rows[99].number).toBe(20);
  });

  it('is empty for a repo whose issues are all closed, rather than falling back', () => {
    expect(
      openIssuesFor(
        [closedIssue('board', 1, daysBefore(1)), closedIssue('board', 2, daysBefore(2))],
        { full: 'acme/board', key: 'board' }, SCOPE,
      ),
    ).toEqual([]);
  });

  // #836. The repo page showed open issues by title and ran no words rule, while
  // every other surface carrying a title runs one. On a board whose
  // `FEEDBACK_REPO` is its own repo, as SCOPE above has it, the queue this page
  // draws IS where the old feedback form filed: an end user's first line was the row
  // a signed-out reader met here.
  it('replaces a submission’s title, and keeps its row', () => {
    const submitted = {
      ...issue('board', 42, daysBefore(1)),
      title: 'your billing page charged me twice, octocat@example.com',
      submission: true,
    };
    const rows = openIssuesFor([submitted], { full: 'acme/board', key: 'board' }, SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
    // The ROW survives: number, address, age and labels are what the count, the
    // sort and the link are built from, and none of them is somebody's sentence.
    expect(rows[0].number).toBe(42);
    expect(rows[0].htmlUrl).toBe('https://github.com/acme/board/issues/42');
  });

  it('hides a submission the triage relabelled, off the footer alone', () => {
    // The labels are the older marker and on their own they were #516: the moment
    // somebody swapped `feedback` for `bug` the label test said "not a submission".
    const relabelled = { ...issue('board', 43, daysBefore(1)), title: 'the export is broken', submission: true };
    expect(relabelled.labels).toEqual(['bug']);
    const rows = openIssuesFor([relabelled], { full: 'acme/board', key: 'board' }, SCOPE);
    expect(rows[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
  });

  it('hides a row whose label set could not be established, inside the feedback repo', () => {
    const partial = { ...issue('board', 44, daysBefore(1)), labels: [], labelsComplete: false };
    const rows = openIssuesFor([partial], { full: 'acme/board', key: 'board' }, SCOPE);
    expect(rows[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
  });

  it('leaves the team’s own issues alone, in the feedback repo and out of it', () => {
    // The bound on withholding is the repo gate, and it is why an unestablished
    // fact costs a reader nothing on the 70-odd repos that are not the form's.
    const ours = openIssuesFor(
      [issue('board', 45, daysBefore(1))],
      { full: 'acme/board', key: 'board' },
      SCOPE,
    );
    expect(ours[0].title).toBe('#45');
    const elsewhere = openIssuesFor(
      [{ ...issue('acme', 46, daysBefore(1)), htmlUrl: 'https://github.com/acme/acme/issues/46', labels: [], labelsComplete: false }],
      { full: 'acme/acme', key: 'acme' },
      SCOPE,
    );
    expect(elsewhere[0].title).toBe('#46');
  });
});

describe('membersFor (#828)', () => {
  const BOARD = { full: 'acme/board', key: 'board', owner: null };
  const NAMES = new Map([
    ['octocat', 'Octocat Octocat'],
    ['ivanroslov', 'Ivan Roslov'],
  ]);

  const issue = (over: Partial<PageIssue> = {}): PageIssue => ({
    owner: 'acme',
    repo: 'board',
    number: 1,
    title: 'an issue',
    htmlUrl: 'https://github.com/acme/board/issues/1',
    state: 'open',
    createdAt: daysBefore(1),
    closedAt: null,
    author: null,
    assignees: [],
    labels: [],
    labelsComplete: true,
    submission: false,
    ...over,
  });

  const read = (prs: RepoPrRecord[]): RepoPrRead => ({
    state: 'read',
    open: 0,
    closedMerged: prs.length,
    prs,
    coveredFrom: null,
    openPrs: [],
  });

  it('counts open assignments, issues opened and PRs opened, and names people through the roster', () => {
    const members = membersFor(
      [
        issue({ number: 1, author: 'octocat', assignees: ['IvanRoslov'] }),
        issue({ number: 2, author: 'IvanRoslov', assignees: ['IvanRoslov'] }),
      ],
      read([pr(7, daysBefore(2), null, 'IvanRoslov')]),
      BOARD,
      NAMES,
      NOW,
    );
    expect(members.prsUnreadable).toBe(false);
    expect(members.people).toEqual([
      { login: 'IvanRoslov', name: 'Ivan Roslov', assigned: 2, openedIssues: 1, openedPrs: 1, dri: false },
      { login: 'octocat', name: 'Octocat Octocat', assigned: 0, openedIssues: 1, openedPrs: 0, dri: false },
    ]);
  });

  it('leaves a login the roster does not carry unnamed rather than inventing one', () => {
    const members = membersFor([issue({ author: 'dependabot' })], read([]), BOARD, NAMES, NOW);
    expect(members.people).toEqual([
      { login: 'dependabot', name: null, assigned: 0, openedIssues: 1, openedPrs: 0, dri: false },
    ]);
  });

  it('orders the list totally: the DRI, then the busiest, then alphabetically', () => {
    // `zoe` and `ada` are deliberately tied on 2 each, and `zoe` is met first —
    // an order that broke the tie by arrival would put her above `ada` and would
    // read differently the day an issue is opened.
    const members = membersFor(
      [
        issue({ number: 1, author: 'zoe', assignees: ['zoe'] }),
        issue({ number: 2, author: 'ada', assignees: ['ada'] }),
        issue({ number: 3, author: 'mo', assignees: ['mo'] }),
        issue({ number: 4, author: 'mo', assignees: ['mo'] }),
      ],
      read([]),
      { ...BOARD, owner: { login: 'quiet-owner', name: null } },
      NAMES,
      NOW,
    );
    expect(members.people.map((p) => [p.login, p.assigned + p.openedIssues + p.openedPrs])).toEqual([
      ['quiet-owner', 0],
      ['mo', 4],
      ['ada', 2],
      ['zoe', 2],
    ]);
  });

  it('leaves out somebody with nothing open and nothing opened lately, and keeps the DRI at zero', () => {
    // The assignee of a CLOSED issue from last spring: real, and not somebody
    // with anything open here or anything opened lately. A list that kept them
    // would say a repo nobody has touched all quarter still has people on it.
    // Nobody is filtered out to make that true — a person with no count is
    // never counted in the first place — and the DRI is the one row put there
    // without one.
    const members = membersFor(
      [issue({ state: 'closed', createdAt: daysBefore(300), author: 'gone', assignees: ['gone'] })],
      read([]),
      { ...BOARD, owner: { login: 'octocat', name: 'Octocat Octocat' } },
      NAMES,
      NOW,
    );
    expect(members.people).toEqual([
      { login: 'octocat', name: 'Octocat Octocat', assigned: 0, openedIssues: 0, openedPrs: 0, dri: true },
    ]);
  });

  it('counts assignments on OPEN issues only, and openings inside the window whatever the state', () => {
    const members = membersFor(
      [
        // Closed, inside the window: an opening, never an assignment.
        issue({ number: 1, state: 'closed', createdAt: daysBefore(3), author: 'mo', assignees: ['mo'] }),
        // Open, opened long before the window: an assignment, never an opening.
        issue({ number: 2, state: 'open', createdAt: daysBefore(400), author: 'mo', assignees: ['mo'] }),
      ],
      read([]),
      BOARD,
      NAMES,
      NOW,
    );
    expect(members.people).toEqual([
      { login: 'mo', name: null, assigned: 1, openedIssues: 1, openedPrs: 0, dri: false },
    ]);
  });

  // Measured on acme/board on 2026-09-03: all 8 open pull
  // requests are dependabot's, and 8 of the last 100 are, against 1 from the
  // second person on the repo. Counting them ranked a machine above a teammate
  // on that repo's own tab, on day one.
  it('counts a bot’s pull requests for nobody, and puts no bot in the list', () => {
    const members = membersFor(
      [],
      read([
        botPr(1, daysBefore(1)),
        botPr(2, daysBefore(2)),
        botPr(3, daysBefore(3)),
        pr(4, daysBefore(4), null, 'anton-khovanskiy'),
      ]),
      BOARD,
      NAMES,
      NOW,
    );
    expect(members.people).toEqual([
      { login: 'anton-khovanskiy', name: null, assigned: 0, openedIssues: 0, openedPrs: 1, dri: false },
    ]);
  });

  it('keeps a ghost account out of the bot rule — a deleted person is not a machine', () => {
    // `author: null`, `authorIsBot: false`. Nobody is counted either way here,
    // but for a different reason, and a rule that folded the two would go wrong
    // the moment a bot's login stopped being readable.
    const members = membersFor([], read([pr(1, daysBefore(1), null, null, false)]), BOARD, NAMES, NOW);
    expect(members.people).toEqual([]);
  });

  it('counts a PR opened inside the window and drops one older than it', () => {
    const members = membersFor(
      [],
      read([pr(1, daysBefore(2), daysBefore(1), 'mo'), pr(2, daysBefore(400), daysBefore(399), 'mo')]),
      BOARD,
      NAMES,
      NOW,
    );
    expect(members.people).toEqual([
      { login: 'mo', name: null, assigned: 0, openedIssues: 0, openedPrs: 1, dri: false },
    ]);
  });

  // #647, the same collision `openIssuesFor` and the rollup guard: two orgs each
  // own a `design-system`, and a page keyed on the short key alone counts the
  // other org's people into this one's list.
  it('counts nobody from another org’s repo of the same name', () => {
    const members = membersFor(
      [
        issue({ owner: 'acme', repo: 'design-system', number: 1, author: 'mine', assignees: ['mine'] }),
        issue({ owner: 'globex', repo: 'design-system', number: 2, author: 'theirs', assignees: ['theirs'] }),
      ],
      read([]),
      { full: 'globex/design-system', key: 'design-system', owner: null },
      NAMES,
      NOW,
    );
    expect(members.people.map((p) => p.login)).toEqual(['theirs']);
  });

  it('folds one person’s logins together and displays the spelling first seen', () => {
    const members = membersFor(
      [issue({ number: 1, author: 'Octocat', assignees: ['OCTOCAT'] })],
      read([pr(7, daysBefore(1), null, 'octocat')]),
      BOARD,
      NAMES,
      NOW,
    );
    expect(members.people).toHaveLength(1);
    expect(members.people[0]).toEqual({
      login: 'Octocat',
      name: 'Octocat Octocat',
      assigned: 1,
      openedIssues: 1,
      openedPrs: 1,
      dri: false,
    });
  });

  it('displays the DRI as the org records them, however an issue spells it', () => {
    const members = membersFor(
      [issue({ author: 'OCTOCAT' })],
      read([]),
      { ...BOARD, owner: { login: 'octocat', name: 'Octocat Octocat' } },
      NAMES,
      NOW,
    );
    expect(members.people.map((p) => p.login)).toEqual(['octocat']);
    expect(members.people[0].dri).toBe(true);
  });

  it('counts nobody for a ghost author, rather than inventing a person', () => {
    const members = membersFor([issue({ author: null })], read([pr(7, daysBefore(1), null, null)]), BOARD, NAMES, NOW);
    expect(members.people).toEqual([]);
  });

  // The rule the whole payload is built on: absence, zero and unreadable are
  // three answers. An unreadable PR read leaves `openedPrs` at 0 for everybody
  // and drops anyone active only in pull requests, which is indistinguishable
  // from a repo nobody sends PRs to unless the payload says so.
  it('says the PR half could not be read, rather than serving it as nobody having sent one', () => {
    const unread = membersFor([issue({ author: 'mo' })], { state: 'unreadable' }, BOARD, NAMES, NOW);
    expect(unread.prsUnreadable).toBe(true);
    expect(unread.people).toEqual([
      { login: 'mo', name: null, assigned: 0, openedIssues: 1, openedPrs: 0, dri: false },
    ]);

    // The same counts, from a read that ANSWERED and found no pull requests.
    const quiet = membersFor([issue({ author: 'mo' })], read([]), BOARD, NAMES, NOW);
    expect(quiet.prsUnreadable).toBe(false);
    expect(quiet.people).toEqual(unread.people);
  });
});

describe('the previous period (#962)', () => {
  const BOARD = { full: 'acme/board', key: 'board' };
  const OLD = { ...BOARD, createdAt: daysBefore(400) };
  const opensAt = windowStart(NOW);
  const noPrs: RepoPrRead = { state: 'read', open: 0, closedMerged: 0, coveredFrom: null, openPrs: [], prs: [] };
  const issueAt = (created: number, closed: number | null, repo = 'board'): PageIssue => ({
    owner: 'acme',
    repo,
    number: created,
    title: `#${created}`,
    htmlUrl: `https://github.com/acme/board/issues/${created}`,
    state: closed == null ? 'open' : 'closed',
    createdAt: daysBefore(created),
    closedAt: closed == null ? null : daysBefore(closed),
    author: null,
    assignees: [],
    labels: [],
    labelsComplete: true,
    submission: false,
  });

  it('counts the issues open when the window opened, off the list the open count comes from', () => {
    const issues = [
      issueAt(100, null), // open then and now
      issueAt(101, 30), // open then, closed inside the window
      issueAt(102, 80), // closed before the window opened
      issueAt(20, null), // opened inside the window, so not open then
      issueAt(103, null, 'acme'), // another repo's
    ];
    expect(openIssuesAt(issues, BOARD, opensAt)).toBe(2);
  });

  it('winds the open pull requests back from the true total rather than counting records', () => {
    // Five open now, and four of them are in no record: opened long ago, never
    // touched since. Since the window opened, three were opened (one still open,
    // one merged, one closed unmerged) and two older ones were closed.
    const read: RepoPrRead = {
      ...noPrs,
      open: 5,
      prs: [
        pr(1, daysBefore(10)),
        pr(2, daysBefore(20), daysBefore(19)),
        { ...pr(3, daysBefore(30)), closedAt: daysBefore(25) },
        pr(4, daysBefore(200), daysBefore(40)),
        { ...pr(5, daysBefore(300)), closedAt: daysBefore(50) },
      ],
    };
    // The four untouched ones, plus 4 and 5, which were open then.
    expect(openPrsAt(read, opensAt)).toEqual({ state: 'read', value: 6 });
  });

  it('does not know the count where the walk stopped short of the window, or failed', () => {
    expect(openPrsAt({ ...noPrs, open: 5, coveredFrom: daysBefore(14) }, opensAt)).toEqual({ state: 'unknown' });
    expect(openPrsAt({ state: 'unreadable' }, opensAt)).toEqual({ state: 'unknown' });
  });

  it('says unknown rather than a negative count when a reopen breaks the sum', () => {
    expect(openPrsAt({ ...noPrs, prs: [pr(1, daysBefore(3))] }, opensAt)).toEqual({ state: 'unknown' });
  });

  it('totals the spend of the ten weeks before the window, on the page’s own windows', () => {
    const full = BOARD.full;
    const spend = ciSpendWindows(
      [
        usage(full, daysBefore(3), 10, 1.25), // this window
        usage(full, daysBefore(80), 10, 2.5), // the previous one
        usage(full, daysBefore(130), 10, 0.75), // the previous one
        usage(full, daysBefore(150), 10, 9), // before both
      ],
      full,
      NOW,
      COMPARED_WEEKS,
    );
    expect(previousPeriod([], OLD, noPrs, spend, NOW, true).ciNetUsd).toEqual({ state: 'read', value: 3.25 });
  });

  it('has no previous period for a repo younger than both windows together', () => {
    const young = previousPeriod([issueAt(20, null)], { ...BOARD, createdAt: daysBefore(100) }, noPrs, { state: 'read', weeks: [] }, NOW, true);
    expect(young).toEqual({ openIssues: { state: 'none' }, openPrs: { state: 'none' }, ciNetUsd: { state: 'none' } });
  });

  it('claims nothing when Github did not say when the repo was created', () => {
    const prev = previousPeriod([], { ...BOARD, createdAt: null }, noPrs, { state: 'read', weeks: [] }, NOW, true);
    expect(prev).toEqual({ openIssues: { state: 'unknown' }, openPrs: { state: 'unknown' }, ciNetUsd: { state: 'unknown' } });
  });

  it('counts no issues off an ingest that failed for this repo, and no spend off a failed report', () => {
    const prev = previousPeriod([issueAt(100, null)], OLD, noPrs, { state: 'unreadable' }, NOW, false);
    expect(prev.openIssues).toEqual({ state: 'unknown' });
    expect(prev.ciNetUsd).toEqual({ state: 'unknown' });
  });
});

describe('completedDayChange (#1239)', () => {
  const repo = { full: 'acme/board', key: 'board', createdAt: daysBefore(400) };
  const empty: RepoPrRead = { state: 'read', open: 0, closedMerged: 0, coveredFrom: null, openPrs: [], prs: [] };

  it('uses the same completed UTC day boundaries for counts and spend', () => {
    const from = '2026-08-13T00:00:00.000Z';
    const to = '2026-08-14T00:00:00.000Z';
    const issues: PageIssue[] = [
      { owner: 'acme', repo: 'board', number: 1, title: 'one', htmlUrl: '',
        state: 'open', createdAt: from, closedAt: null, author: null, assignees: [],
        labels: [], labelsComplete: true, submission: false },
    ];
    const read: RepoPrRead = { ...empty, open: 2, prs: [pr(1, from), pr(2, to)] };
    const change = completedDayChange(issues, repo, read, [
      usage(repo.full, '2026-08-12T00:00:00Z', 10, 1.11),
      usage(repo.full.toUpperCase(), from, 10, 0.1),
      usage(repo.full, '2026-08-13T23:59:59.999Z', 10, 0.2),
      usage(repo.full, to, 10, 99),
      usage('another/board', from, 10, 99),
      usage(repo.full, '2026-08-11T23:59:59.999Z', 10, 99),
    ], NOW, true);
    expect(change).toEqual({
      day: '2026-08-13', previousDay: '2026-08-12',
      openIssues: { state: 'read', value: 1 },
      openPrs: { state: 'read', value: 1 },
      ciNetUsd: { state: 'read', value: -0.81 },
    });
    expect(completedDayChange(issues, repo, read, [], '2026-08-13T20:00:00-04:00', true).day).toBe(change.day);
  });

  it('winds both counts back, excluding changes at today’s boundary', () => {
    const issue: PageIssue = {
      owner: 'acme', repo: 'board', number: 1, title: 'one', htmlUrl: '',
      state: 'closed', createdAt: daysBefore(10), closedAt: '2026-08-13T00:00:00Z',
      author: null, assignees: [], labels: [], labelsComplete: true, submission: false,
    };
    const read: RepoPrRead = { ...empty, prs: [pr(1, daysBefore(10), issue.closedAt)] };
    const change = completedDayChange([issue], repo, read, [], NOW, true);
    expect(change.openIssues).toEqual({ state: 'read', value: -1 });
    expect(change.openPrs).toEqual({ state: 'read', value: -1 });
    const boundary = '2026-08-14T00:00:00Z';
    const atEnd = completedDayChange([{ ...issue, closedAt: boundary }], repo,
      { ...empty, prs: [pr(1, daysBefore(10), boundary)] }, [], NOW, true);
    expect(atEnd.openIssues).toEqual({ state: 'read', value: 0 });
    expect(atEnd.openPrs).toEqual({ state: 'read', value: 0 });
  });

  it.each([
    ['2026-01-01T00:00:00Z', '2025-12-31', '2025-12-30'],
    ['2026-03-01T23:59:59Z', '2026-02-28', '2026-02-27'],
    ['2026-03-09T00:30:00-04:00', '2026-03-08', '2026-03-07'],
  ])('keeps calendar rollover and timezone offsets on UTC days at %s', (now, day, previousDay) => {
    expect(completedDayChange([], repo, empty, [], now, true)).toMatchObject({ day, previousDay });
  });

  it('requires PR coverage back to the earlier count boundary', () => {
    const change = completedDayChange([], repo, { ...empty, coveredFrom: '2026-08-13T00:00:00.001Z' }, [], NOW, true);
    expect(change.openPrs).toEqual({ state: 'unknown' });
  });

  it.each([[[]], [[1]], [[2]], [[0]]])('does not invent spend for a missing comparison day: %j', (offsets) => {
    const change = completedDayChange([], repo, empty, offsets.map((d) => usage(repo.full, daysBefore(d), 10, 0)), NOW, true);
    expect(change.ciNetUsd).toEqual({ state: 'unknown' });
  });

  it('keeps missing billing days distinct from an observed zero change', () => {
    const rows = [
      usage(repo.full, daysBefore(2), 10, 0),
      usage(repo.full, daysBefore(1), 10, 0),
      usage(repo.full, NOW, 10, 0),
    ];
    const zero = completedDayChange([], repo, empty, rows, NOW, true);
    const absent = completedDayChange([], repo, empty, [], NOW, true);
    expect(zero.ciNetUsd).toEqual({ state: 'read', value: 0 });
    expect(absent.ciNetUsd).toEqual({ state: 'unknown' });
    expect(absent.ciNetUsd).not.toEqual(zero.ciNetUsd);
    expect(zero.openIssues).toEqual({ state: 'read', value: 0 });
    expect(zero.openPrs).toEqual({ state: 'read', value: 0 });
  });

  it('keeps failed issue and PR reads distinct from zero change', () => {
    const failed = completedDayChange([], repo, { state: 'unreadable' }, null, NOW, false);
    expect(failed.openIssues).toEqual({ state: 'unknown' });
    expect(failed.openPrs).toEqual({ state: 'unknown' });
    expect(failed.ciNetUsd).toEqual({ state: 'unknown' });
  });

  it('does not claim history before the repository existed or when its age is unknown', () => {
    const young = completedDayChange([], { ...repo, createdAt: NOW }, empty, [], NOW, true);
    expect(young.openIssues).toEqual({ state: 'none' });
    expect(young.openPrs).toEqual({ state: 'none' });
    expect(young.ciNetUsd).toEqual({ state: 'none' });
    const unknown = completedDayChange([], { ...repo, createdAt: null }, empty, [], NOW, true);
    expect(unknown.openIssues).toEqual({ state: 'unknown' });
    expect(unknown.openPrs).toEqual({ state: 'unknown' });
    expect(unknown.ciNetUsd).toEqual({ state: 'unknown' });
  });
});
