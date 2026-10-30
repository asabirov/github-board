import { describe, expect, it } from 'vitest';
import { computeOrgQueue, computePersonalIssues, computeProjectContributions } from './personal-issues.vm';
import { computeMetrics } from './issues-metrics.vm';
import { RawIssue } from './issues-metrics.types';
import type { ProjectMembership } from '../projects/project.types';

const NOW = '2026-07-11T12:00:00.000Z';
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * DAY).toISOString();

function issue(p: Partial<RawIssue> & { number: number }): RawIssue {
  return {
    owner: 'acme',
    repo: 'board',
    title: `Issue ${p.number}`,
    htmlUrl: `https://x/${p.number}`,
    state: 'open',
    createdAt: daysAgo(1),
    closedAt: null,
    // A synthetic row is told no reason, which is the state that COUNTS —
    // so every assertion written before #1014 keeps meaning what it meant.
    stateReason: null,
    author: null,
    assignees: [],
    labels: [],
    labelsComplete: true,
    // These rows are about counting, not about words (#516).
    submission: false,
    milestone: null,
    ...p,
  };
}

describe('computePersonalIssues', () => {
  it('returns an empty queue for an unmapped (null) login', () => {
    const r = computePersonalIssues([issue({ number: 1, assignees: ['octocat'] })], null, NOW);
    expect(r).toEqual({
      computedAt: NOW,
      timeZone: 'UTC',
      updatedAt: NOW,
      login: null,
      issues: [],
      throughput: { opened: 0, closed: 0 },
      throughputWeeks: [],
      throughputDays: { opened: [], closed: [], exited: [] },
      // Empty beside the empty day series, never a span of zeroes: a window
      // nobody counted is not a run of quiet days (#817).
      closedDays: [],
      recentlyClosed: [],
    });
  });

  it('carries state + closedAt on queue rows (open) (#407)', () => {
    const r = computePersonalIssues([issue({ number: 1, assignees: ['octocat'], state: 'open' })], 'octocat', NOW);
    expect(r.issues[0].state).toBe('open');
    expect(r.issues[0].closedAt).toBeNull();
  });

  it('recentlyClosed = my issues closed in the last 7 days, newest first; issues stays open-only (#407)', () => {
    const r = computePersonalIssues(
      [
        issue({ number: 1, assignees: ['octocat'], state: 'open' }),
        issue({ number: 2, assignees: ['octocat'], state: 'closed', closedAt: daysAgo(2) }),
        issue({ number: 3, assignees: ['octocat'], state: 'closed', closedAt: daysAgo(6) }),
        issue({ number: 4, assignees: ['octocat'], state: 'closed', closedAt: daysAgo(8) }), // too old
        issue({ number: 5, assignees: ['IvanRoslov'], state: 'closed', closedAt: daysAgo(1) }), // not mine
      ],
      'octocat',
      NOW,
    );
    // Open queue is untouched — no closed row leaks in.
    expect(r.issues.map((i) => i.number)).toEqual([1]);
    // Only my closes inside the window, most-recent (fewest days ago) first.
    expect(r.recentlyClosed!.map((i) => i.number)).toEqual([2, 3]);
    expect(r.recentlyClosed!.every((i) => i.state === 'closed')).toBe(true);
    expect(r.recentlyClosed![0].closedAt).toBe(daysAgo(2));
  });

  it('keeps only OPEN issues assigned to the login, excludes others incl. unassigned (#285)', () => {
    const r = computePersonalIssues(
      [
        issue({ number: 1, assignees: ['octocat'], state: 'open' }),
        issue({ number: 2, assignees: ['IvanRoslov'], state: 'open' }), // someone else → excluded
        issue({ number: 3, assignees: ['octocat'], state: 'closed', closedAt: daysAgo(30) }), // closed → excluded
        issue({ number: 4, assignees: [], state: 'open' }), // unassigned → excluded now (#285, was #231)
        issue({ number: 5, assignees: ['octocat', 'IvanRoslov'], state: 'open' }), // co-assigned → I'm on it
      ],
      'octocat',
      NOW,
    );
    expect(r.issues.map((i) => i.number).sort()).toEqual([1, 5]);
    expect(r.login).toBe('octocat');
    // Every queue row is now assigned to me.
    const flag = Object.fromEntries(r.issues.map((i) => [i.number, i.assignedToMe]));
    expect(flag).toEqual({ 1: true, 5: true });
  });

  it('derives type from labels — bug > feedback > feature > chore', () => {
    const r = computePersonalIssues(
      [
        issue({ number: 1, assignees: ['octocat'], labels: ['enhancement', 'bug'] }),
        issue({ number: 2, assignees: ['octocat'], labels: ['feedback'] }),
        issue({ number: 3, assignees: ['octocat'], labels: ['enhancement'] }),
        issue({ number: 4, assignees: ['octocat'], labels: ['discovery'] }),
      ],
      'octocat',
      NOW,
    );
    const byNum = Object.fromEntries(r.issues.map((i) => [i.number, i.type]));
    expect(byNum).toEqual({ 1: 'bug', 2: 'feedback', 3: 'feature', 4: 'chore' });
  });

  it('flags blocked from a `blocked` or `blocker` label and sorts blocked first, then oldest', () => {
    const r = computePersonalIssues(
      [
        issue({ number: 1, assignees: ['octocat'], createdAt: daysAgo(2) }),
        issue({ number: 2, assignees: ['octocat'], createdAt: daysAgo(10) }),
        issue({ number: 3, assignees: ['octocat'], createdAt: daysAgo(1), labels: ['blocker'] }),
      ],
      'octocat',
      NOW,
    );
    // #3 blocked → top; then #2 (older) before #1.
    expect(r.issues.map((i) => i.number)).toEqual([3, 2, 1]);
    expect(r.issues.find((i) => i.number === 3)?.blocked).toBe(true);
    expect(r.issues.find((i) => i.number === 1)?.blocked).toBe(false);
    expect(r.issues.find((i) => i.number === 2)?.ageDays).toBe(10);
  });

  it('carries author + assignees through and tags projects via the resolver', () => {
    const projectsOf = (url: string) =>
      url.endsWith('/1') ? ['Board re-platform', 'GTM'] : [];
    const r = computePersonalIssues(
      [
        issue({ number: 1, assignees: ['octocat', 'IvanRoslov'], author: 'IvanRoslov', htmlUrl: 'https://x/1' }),
        issue({ number: 2, assignees: ['octocat'], author: null, htmlUrl: 'https://x/2' }),
      ],
      'octocat',
      NOW,
      projectsOf,
    );
    const one = r.issues.find((i) => i.number === 1)!;
    const two = r.issues.find((i) => i.number === 2)!;
    expect(one.author).toBe('IvanRoslov');
    expect(one.assignees).toEqual(['octocat', 'IvanRoslov']); // card avatars (#230)
    expect(one.projects).toEqual(['Board re-platform', 'GTM']);
    expect(two.author).toBeNull();
    expect(two.projects).toEqual([]); // on no board → "No project" stack
  });

  it('counts trailing-7d throughput for the login only — unassigned queue items never count', () => {
    const r = computePersonalIssues(
      [
        issue({ number: 1, assignees: ['octocat'], createdAt: daysAgo(3) }), // opened this week
        issue({ number: 2, assignees: ['octocat'], state: 'closed', createdAt: daysAgo(30), closedAt: daysAgo(2) }), // closed this week
        issue({ number: 3, assignees: ['octocat'], state: 'closed', createdAt: daysAgo(40), closedAt: daysAgo(20) }), // closed long ago
        issue({ number: 4, assignees: ['IvanRoslov'], createdAt: daysAgo(1) }), // not mine
        issue({ number: 5, assignees: [], createdAt: daysAgo(1), state: 'open' }), // unassigned → not in my queue (#285) and not my throughput
      ],
      'octocat',
      NOW,
    );
    // Neither #4 (someone else's) nor #5 (unassigned) is mine, so neither counts.
    expect(r.throughput).toEqual({ opened: 1, closed: 1 });
  });

  it('emits a weekly throughput series whose last window equals the headline (#254)', () => {
    const r = computePersonalIssues(
      [
        issue({ number: 1, assignees: ['octocat'], createdAt: daysAgo(3) }), // opened, this week
        issue({ number: 2, assignees: ['octocat'], createdAt: daysAgo(10) }), // opened, 1w ago
        issue({ number: 3, assignees: ['octocat'], state: 'closed', createdAt: daysAgo(30), closedAt: daysAgo(2) }), // closed, this week
        issue({ number: 4, assignees: ['octocat'], state: 'closed', createdAt: daysAgo(40), closedAt: daysAgo(12) }), // closed, 1w ago
        issue({ number: 5, assignees: ['IvanRoslov'], createdAt: daysAgo(1) }), // not mine → never counts
      ],
      'octocat',
      NOW,
    );
    // 10 rolling windows, oldest → newest; the last is the trailing 7 days.
    expect(r.throughputWeeks).toHaveLength(10);
    expect(r.throughputWeeks[9]).toEqual(r.throughput); // last window == headline
    expect(r.throughputWeeks[9]).toEqual({ opened: 1, closed: 1 }); // #1 opened, #3 closed
    expect(r.throughputWeeks[8]).toEqual({ opened: 1, closed: 1 }); // #2 opened, #4 closed (1w ago)
    // Every one of my four issues was created inside the 10-week span, so all
    // four count as `opened` in their window; two also closed inside it. #5 is
    // someone else's and never lands in my series. → 4 opened + 2 closed.
    const opened = r.throughputWeeks.reduce((s, w) => s + w.opened, 0);
    const closed = r.throughputWeeks.reduce((s, w) => s + w.closed, 0);
    expect([opened, closed]).toEqual([4, 2]);
  });

  // The two series CANNOT agree exactly, and the reason is the point of the
  // field: the weekly window is rolling ([now-7d, now)), the day series is
  // calendar-aligned, so a close between now-7d and midnight of day −6 is in
  // the week but not in the last seven cells. Everything else must match.
  it('the last 7 day-cells equal the weekly window minus the closes that fell before the oldest cell began (#666)', () => {
    const r = computePersonalIssues(
      [
        issue({ number: 1, assignees: ['octocat'], state: 'closed', createdAt: daysAgo(30), closedAt: daysAgo(2) }), // 07-09, both
        issue({ number: 2, assignees: ['octocat'], state: 'closed', createdAt: daysAgo(30), closedAt: daysAgo(6) }), // 07-05, both
        issue({ number: 3, assignees: ['octocat'], state: 'closed', createdAt: daysAgo(30), closedAt: daysAgo(6.9) }), // 07-04 14:24 — in the rolling week, a day too early for the cells
      ],
      'octocat',
      NOW,
    );
    const cells = r.throughputDays.closed;
    const last7 = cells.slice(-7).reduce((s, n) => s + n, 0);
    expect(r.throughputWeeks[9].closed).toBe(3);
    expect(last7).toBe(2);
    // The single difference is #3, and it is not lost — it sits one cell older,
    // on 2026-07-04, so the whole span still carries all three closes.
    expect(cells.at(-8)!).toBe(1);
    expect(cells.reduce((s, n) => s + n, 0)).toBe(3);
  });

  // #817: the same closes as `throughputDays`, back to this person's first one,
  // so Your work can draw a whole calendar year of their closes.
  it('carries closes back to the first close the MIRROR holds, not this login\'s own (#817)', () => {
    const r = computePersonalIssues(
      [
        issue({ number: 1, assignees: ['octocat'], state: 'closed', createdAt: daysAgo(320), closedAt: daysAgo(300) }),
        issue({ number: 2, assignees: ['octocat'], state: 'closed', createdAt: daysAgo(10), closedAt: daysAgo(1) }),
        // SOMEBODY ELSE'S OLDER CLOSE WIDENS THE WINDOW, and that is the point.
        // The board was watching on the day it happened, so every day from there
        // is a day this login closed nothing on — a zero. Sized off this login's
        // own first close, those 200 days would arrive as ABSENT instead, and
        // the same person's `byMember` row on Overview would carry them as the
        // zeroes they are: one person reading two ways on two surfaces.
        issue({ number: 3, assignees: ['IvanRoslov'], state: 'closed', createdAt: daysAgo(600), closedAt: daysAgo(500) }),
      ],
      'octocat',
      NOW,
    );
    expect(r.closedDays).toHaveLength(501); // 500 days back, plus today
    expect(r.closedDays[0]).toBe(0); // the day of somebody else's close, counted for me as 0
    expect(r.closedDays[200]).toBe(1); // my own oldest, 300 days ago
    expect(r.closedDays.at(-2)).toBe(1);
    expect(r.closedDays.reduce((s, n) => s + n, 0)).toBe(2); // only MY closes are counted
    // The 98-day series beside it is untouched and holds only the recent close.
    expect(r.throughputDays.closed).toHaveLength(98);
    expect(r.throughputDays.closed.reduce((s, n) => s + n, 0)).toBe(1);
  });

  it('falls back to the sparks\' span when NOTHING in the mirror has closed (#817)', () => {
    const r = computePersonalIssues([issue({ number: 1, assignees: ['octocat'] })], 'octocat', NOW);
    expect(r.closedDays).toHaveLength(98);
    expect(r.closedDays.every((n) => n === 0)).toBe(true);
  });

  it('still spans the mirror when this login has closed nothing at all (#817)', () => {
    // The state a new joiner is in: the board has been watching for 500 days and
    // they have closed nothing. Every one of those days is a counted zero, not a
    // day nobody watched.
    const r = computePersonalIssues(
      [
        issue({ number: 1, assignees: ['octocat'] }),
        issue({ number: 2, assignees: ['IvanRoslov'], state: 'closed', createdAt: daysAgo(600), closedAt: daysAgo(500) }),
      ],
      'octocat',
      NOW,
    );
    expect(r.closedDays).toHaveLength(501);
    expect(r.closedDays.every((n) => n === 0)).toBe(true);
  });
});

describe('computeOrgQueue (#284)', () => {
  it('keeps every OPEN issue regardless of assignee, excludes closed', () => {
    const r = computeOrgQueue(
      [
        issue({ number: 1, assignees: ['octocat'], state: 'open' }),
        issue({ number: 2, assignees: ['IvanRoslov'], state: 'open' }),
        issue({ number: 3, assignees: [], state: 'open' }), // unassigned → still on the org board
        issue({ number: 4, assignees: ['octocat'], state: 'closed', closedAt: daysAgo(3) }),
      ],
      NOW,
    );
    expect(r.issues.map((i) => i.number).sort()).toEqual([1, 2, 3]);
    // No "me" on the org queue.
    expect(r.issues.every((i) => i.assignedToMe === false)).toBe(true);
    expect(r).not.toHaveProperty('login');
    expect(r).not.toHaveProperty('throughput');
  });

  it('carries assignees (incl. unassigned → empty), type, projects, and blocked-then-oldest order', () => {
    const projectsOf = (url: string) => (url.endsWith('/2') ? ['GTM'] : []);
    const r = computeOrgQueue(
      [
        issue({ number: 1, assignees: ['octocat'], createdAt: daysAgo(2), labels: ['bug'] }),
        issue({ number: 2, assignees: [], createdAt: daysAgo(9), htmlUrl: 'https://x/2' }),
        issue({ number: 3, assignees: ['IvanRoslov'], createdAt: daysAgo(1), labels: ['blocked'] }),
      ],
      NOW,
      projectsOf,
    );
    expect(r.issues.map((i) => i.number)).toEqual([3, 2, 1]); // blocked #3 first, then older #2, then #1
    const two = r.issues.find((i) => i.number === 2)!;
    expect(two.assignees).toEqual([]); // unassigned → dashed placeholder on the card
    expect(two.projects).toEqual(['GTM']);
    expect(r.issues.find((i) => i.number === 1)!.type).toBe('bug');
  });
});

describe('computeProjectContributions (#380)', () => {
  // Three boards; every board's issue URLs point at the issues below by URL.
  // One org, as a single-org deployment reads — the two-org collision these rows
  // cannot express is driven end-to-end in `issues-metrics.service.spec.ts` (#697).
  const ORG = 'acme';
  const memberships: ProjectMembership[] = [
    { org: ORG, number: 4, name: 'Acme', issueUrls: ['https://x/1', 'https://x/2', 'https://x/3'] },
    { org: ORG, number: 7, name: 'GTM', issueUrls: ['https://x/4', 'https://x/5'] },
    { org: ORG, number: 9, name: 'Compliance', issueUrls: ['https://x/6', 'https://x/7'] },
  ];

  it('returns [] for an unmapped (null) login', () => {
    expect(computeProjectContributions([issue({ number: 1 })], null, NOW, memberships)).toEqual([]);
  });

  it('counts only MY closes in the window and marks moving vs slipping', () => {
    const rows = computeProjectContributions(
      [
        // Acme: two of mine closed this week (2 closed), one open.
        issue({ number: 1, htmlUrl: 'https://x/1', assignees: ['octocat'], state: 'closed', closedAt: daysAgo(1) }),
        issue({ number: 2, htmlUrl: 'https://x/2', assignees: ['octocat'], state: 'closed', closedAt: daysAgo(3) }),
        issue({ number: 3, htmlUrl: 'https://x/3', assignees: ['octocat'], state: 'open' }),
        // GTM: someone else's close (not mine) + a close 20d ago by me, plus open work → slipping.
        issue({ number: 4, htmlUrl: 'https://x/4', assignees: ['IvanRoslov'], state: 'closed', closedAt: daysAgo(2) }),
        issue({ number: 5, htmlUrl: 'https://x/5', assignees: ['octocat'], state: 'open' }),
        // Compliance: my last close was 12d ago, nothing open now → drops off the radar.
        issue({ number: 6, htmlUrl: 'https://x/6', assignees: ['octocat'], state: 'closed', closedAt: daysAgo(12) }),
        issue({ number: 7, htmlUrl: 'https://x/7', assignees: ['IvanRoslov'], state: 'open' }),
      ],
      'octocat',
      NOW,
      memberships,
    );
    // Acme is moving (2 closed) and sorts first; GTM is slipping (open work, 0 closed);
    // Compliance drops (no open work, no close this week).
    expect(rows.map((r) => r.name)).toEqual(['Acme', 'GTM']);

    const acme = rows.find((r) => r.name === 'Acme')!;
    expect(acme.closed7d).toBe(2);
    expect(acme.openAssigned).toBe(1);
    expect(acme.slipping).toBe(false);
    expect(acme.lastClosedAtISO).toBe(daysAgo(1));

    const gtm = rows.find((r) => r.name === 'GTM')!;
    expect(gtm.closed7d).toBe(0); // #4's close isn't mine
    expect(gtm.openAssigned).toBe(1);
    expect(gtm.slipping).toBe(true);
    expect(gtm.lastClosedAtISO).toBeNull(); // I've never closed anything on GTM
  });

  it('sorts most-closed first, then most-recent close', () => {
    const rows = computeProjectContributions(
      [
        issue({ number: 1, htmlUrl: 'https://x/1', assignees: ['octocat'], state: 'closed', closedAt: daysAgo(4) }),
        issue({ number: 4, htmlUrl: 'https://x/4', assignees: ['octocat'], state: 'closed', closedAt: daysAgo(1) }),
        issue({ number: 5, htmlUrl: 'https://x/5', assignees: ['octocat'], state: 'closed', closedAt: daysAgo(2) }),
      ],
      'octocat',
      NOW,
      memberships,
    );
    // Acme 1 close (4d), GTM 2 closes (1d, 2d) → GTM leads on count.
    expect(rows.map((r) => r.name)).toEqual(['GTM', 'Acme']);
  });
});

/**
 * #478 — the Oldest-open block and the Unit queue sit one section apart and used
 * to answer "how much work is aging?" differently: the block counted open FLOW
 * issues past the threshold, the queue counted every open issue, and a single
 * `discovery`-labelled issue made the two numbers differ by one. Both now run on
 * `isAging`, and these are the tests that would have caught the drift.
 */
describe('the aging flag on queue rows (#478)', () => {
  const LONG = new Set(['discovery']);
  // Deliberately the shape of the real disagreement: one long-lived issue that is
  // OLDER than everything else, so a rule that forgot the labels would count it.
  const all = [
    issue({ number: 1, createdAt: daysAgo(200), labels: ['discovery'] }),
    issue({ number: 2, createdAt: daysAgo(60) }),
    issue({ number: 3, createdAt: daysAgo(30) }), // exactly at the threshold → aging
    issue({ number: 4, createdAt: daysAgo(29) }), // one day short → not aging
    issue({ number: 5, createdAt: daysAgo(90), state: 'closed', closedAt: daysAgo(2) }),
  ];

  it('flags open flow issues past the threshold, and nothing else', () => {
    const r = computeOrgQueue(all, NOW, () => [], LONG);
    const flag = (n: number) => r.issues.find((i) => i.number === n)?.aging;
    expect(flag(1)).toBe(false); // steady-state, however old
    expect(flag(2)).toBe(true);
    expect(flag(3)).toBe(true);
    expect(flag(4)).toBe(false);
    expect(r.issues.find((i) => i.number === 5)).toBeUndefined(); // closed → not on the queue
  });

  it('a closed row carried alongside the queue is never aging', () => {
    const r = computePersonalIssues(
      [issue({ number: 5, assignees: ['octocat'], createdAt: daysAgo(90), state: 'closed', closedAt: daysAgo(2) })],
      'octocat',
      NOW,
      () => [],
      LONG,
    );
    expect(r.recentlyClosed?.[0].aging).toBe(false);
  });

  it('the queue rows and the metrics total agree on the same raw list', () => {
    const flagged = computeOrgQueue(all, NOW, () => [], LONG).issues.filter((i) => i.aging).length;
    expect(flagged).toBe(computeMetrics(all, NOW, {}, (l) => l, LONG).staleTotal);
    // …and the disagreement it replaces was real: without the label set, the same
    // list yields one MORE aging issue on both surfaces, in step.
    const unconfigured = computeOrgQueue(all, NOW).issues.filter((i) => i.aging).length;
    expect(unconfigured).toBe(flagged + 1);
    expect(unconfigured).toBe(computeMetrics(all, NOW, {}, (l) => l).staleTotal);
  });
});

/** #650 — one builder (`shapeQueueIssue`) shapes every queue row, personal and
 *  org-wide, and it dropped the org on the floor. `repo` is a short key that
 *  folds across orgs, so `design-system` alone names two different repos. */
describe('queue rows name their org (#650)', () => {
  const twoOrgs = [
    issue({ number: 1, owner: 'acme', repo: 'design-system', assignees: ['octocat'] }),
    issue({ number: 2, owner: 'globex', repo: 'design-system', assignees: ['octocat'] }),
  ];

  it('two repos with the SAME short key in different orgs give two distinguishable rows', () => {
    const r = computePersonalIssues(twoOrgs, 'octocat', NOW);
    // Two DIFFERENT expected owners on the same field: no single constant
    // satisfies both, so a row that hardcoded or dropped the org fails here.
    expect(r.issues.map((i) => `${i.owner}/${i.repo}#${i.number}`).sort()).toEqual([
      'acme/design-system#1',
      'globex/design-system#2',
    ]);
  });

  it('a row from the second org reports that org on the org-wide queue too', () => {
    const q = computeOrgQueue(twoOrgs, NOW);
    expect(q.issues.find((i) => i.number === 2)!.owner).toBe('globex');
    expect(q.issues.find((i) => i.number === 1)!.owner).toBe('acme');
  });

  it('a closed row in recentlyClosed carries it as well', () => {
    const r = computePersonalIssues(
      [issue({ number: 3, owner: 'globex', repo: 'design-system', assignees: ['octocat'], state: 'closed', closedAt: daysAgo(2) })],
      'octocat',
      NOW,
    );
    expect(r.recentlyClosed![0].owner).toBe('globex');
  });
});

describe('the personal payload carries the clock it was bucketed by (#1015)', () => {
  it('stamps computedAt with the same `now` the day series were counted against', () => {
    const r = computePersonalIssues([
      issue({ number: 1, assignees: ['octocat'], state: 'closed', closedAt: daysAgo(1) }),
    ], 'octocat', NOW);
    // The stamp names the day the LAST cell is for, so a reader can date every
    // other cell by counting back from it. Yesterday's close is the second-last.
    expect(r.computedAt).toBe(NOW);
    expect(r.closedDays.at(-2)).toBe(1);
  });

  it('answers both stamps off the same clock, so a caller can tell which it is reading', () => {
    // The vm can only pin that the two START equal — the divergence is the
    // SERVICE's, which overwrites `updatedAt` with the raw-issue cache's fetch
    // time. That is held one layer up, in `issues-metrics.service.spec.ts`,
    // because a test here could only re-assert a property it just set.
    const r = computePersonalIssues([], 'octocat', NOW);
    expect(r.computedAt).toBe(NOW);
    expect(r.updatedAt).toBe(NOW);
  });
});

describe('a personal close is only delivery when Github said it was (#1014)', () => {
  const mine = (stateReason: 'completed' | 'not_planned' | null) => computePersonalIssues(
    [issue({ number: 1, assignees: ['octocat'], createdAt: daysAgo(9), state: 'closed', closedAt: daysAgo(2), stateReason })],
    'octocat',
    NOW,
  );

  it('keeps the tile and the list behind it in step', () => {
    // `throughput.closed` is the "Closed this week" figure and `recentlyClosed`
    // is its drill-in. Gated apart, the list would name a close the tile refuses
    // to count, which is the disagreement a reader would report as a bug.
    const dropped = mine('not_planned');
    expect(dropped.throughput.closed).toBe(0);
    expect(dropped.recentlyClosed).toHaveLength(0);
    expect(dropped.throughputDays!.closed.at(-3)).toBe(0);
    expect(dropped.closedDays.at(-3)).toBe(0);

    const kept = mine('completed');
    expect(kept.throughput.closed).toBe(1);
    expect(kept.recentlyClosed).toHaveLength(1);
    expect(kept.throughputDays!.closed.at(-3)).toBe(1);
    expect(kept.closedDays.at(-3)).toBe(1);
  });

  it('counts a close whose reason we were never told', () => {
    expect(mine(null).throughput.closed).toBe(1);
  });

  it('carries the reason onto the queue row, because the viewer filters closes of its own', () => {
    // The one thing the frontend cannot inherit: `closed-week` and
    // `closed-yesterday` select client-side over the rows they were handed.
    expect(mine('completed').recentlyClosed![0].stateReason).toBe('completed');
  });
});

describe('computeProjectContributions and abandoned work (#1014)', () => {
  it('reads a board as slipping when the week’s only close there was abandoned', () => {
    // The inversion worth pinning: `slipping` means "you still hold open work
    // here and have moved nothing this week". An abandoned close is not moving
    // it, and before #1014 it read as though the board had been worked.
    const memberships: ProjectMembership[] = [{
      org: 'acme', number: 7, name: 'Board', issueUrls: ['https://x/1', 'https://x/2'],
    }];
    const rows = computeProjectContributions(
      [
        issue({ number: 1, assignees: ['octocat'], htmlUrl: 'https://x/1', state: 'closed', closedAt: daysAgo(2), stateReason: 'not_planned' }),
        issue({ number: 2, assignees: ['octocat'], htmlUrl: 'https://x/2' }),
      ],
      'octocat',
      NOW,
      memberships,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ closed7d: 0, openAssigned: 1, slipping: true });
    // …and it has no last-close to name either, because that close was not one.
    expect(rows[0].lastClosedAtISO).toBeNull();
  });
});
