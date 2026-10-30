import { describe, expect, it } from 'vitest';
import type { IssueMetrics, PersonalIssue } from '../api/issues';
import {
  selectedIssues,
  throughputFor,
} from './pulse-filter';

// Local factories, no shared helpers — the board-frontend convention.

function issue(o: Partial<PersonalIssue> & { number: number }): PersonalIssue {
  return {
    repo: 'board',
    owner: 'acme',
    title: `Issue ${o.number}`,
    htmlUrl: `https://github.com/acme/board/issues/${o.number}`,
    createdAt: '2026-01-01T00:00:00Z',
    ageDays: 10,
    labels: [],
    type: 'feature',
    blocked: false,
    assignedToMe: false,
    assignees: [],
    author: null,
    projects: [],
    ...o,
  };
}

function metrics(byMember: IssueMetrics['byMember']): IssueMetrics {
  return {
    updatedAt: '2026-08-11T00:00:00Z',
    repos: [],
    labels: [],
    cycles: [],
    filter: {},
    totals: { open: 0, openFlow: 0, steadyState: 0, closed90: 0, unassigned: 0 },
    weeks: Array.from({ length: 12 }, (_, i) => ({ opened: i, closed: i })),
    recent4: { opened: 0, closed: 0 },
    byMember,
    load: [],
    ttc: { medianDays: 0, p90Days: 0, n: 0 },
    stale: [],
    steadyByType: [],
  };
}

describe('selectedIssues (#461, #866)', () => {
  const open = (rows: PersonalIssue[], logins: string[]) => selectedIssues(rows, logins).length;

  it('takes only the issues assigned to the selected member', () => {
    const rows = [
      issue({ number: 1, assignees: ['octocat'] }),
      issue({ number: 2, assignees: ['IvanRoslov'] }),
      issue({ number: 3, assignees: [] }),
    ];
    expect(open(rows, ['octocat'])).toBe(1);
    expect(open(rows, ['IvanRoslov'])).toBe(1);
  });

  it('ORs two selected members rather than intersecting them (D4d)', () => {
    const rows = [
      issue({ number: 1, assignees: ['octocat'] }),
      issue({ number: 2, assignees: ['IvanRoslov'] }),
      issue({ number: 3, assignees: ['anton-khovanskiy'] }),
    ];
    expect(open(rows, ['octocat', 'IvanRoslov'])).toBe(2);
  });

  it('matches logins case-SENSITIVELY, the one comparator `filter-group.ts` uses — a '
    + 'tile that counted a login the queue below then matched nothing for is the exact '
    + 'drift the tile exists to end (C2)', () => {
    const rows = [issue({ number: 1, assignees: ['IvanRoslov'] })];
    expect(open(rows, ['IvanRoslov'])).toBe(1);
    expect(open(rows, ['ivanroslov'])).toBe(0);
  });

  it('takes an issue assigned to two people for each of them — member totals '
    + 'therefore exceed the org total, which is correct for "what is on their plate"', () => {
    const rows = [issue({ number: 1, assignees: ['octocat', 'IvanRoslov'] })];
    expect(open(rows, ['octocat'])).toBe(1);
    expect(open(rows, ['IvanRoslov'])).toBe(1);
  });

  it('takes the whole queue when nobody is selected — the flow strip\u2019s Issues tile '
    + 'and the list below it read this same source, so they cannot contradict each '
    + 'other (A)', () => {
    const rows = [
      issue({ number: 1, assignees: ['octocat'], labels: ['bug'] }),
      issue({ number: 2, assignees: ['IvanRoslov'], labels: ['bug'] }),
      issue({ number: 3, assignees: [], labels: ['feedback'] }),
    ];
    expect(selectedIssues(rows, [])).toEqual(rows);
  });

  it('hands back the ISSUES and not a count, which is what lets the Issues tile and '
    + 'the oldest-issue tile read one filter (#866)', () => {
    // `bucketsFor(...).open` was a one-field record and the oldest-issue tile
    // cannot be answered from a number. Two readers, one call, so a selection
    // cannot mean two different sets on one strip.
    const rows = [
      issue({ number: 1, assignees: ['octocat'] }),
      issue({ number: 2, assignees: ['IvanRoslov'] }),
    ];
    expect(selectedIssues(rows, ['IvanRoslov']).map((i) => i.number)).toEqual([2]);
  });
});

describe('throughputFor (#461)', () => {
  const weeks = Array.from({ length: 12 }, (_, i) => ({ opened: 1, closed: i }));

  it('returns the member’s own counts and their own 12-week series', () => {
    const m = metrics([{ login: 'IvanRoslov', name: 'Ivan', opened: 2, closed: 5, weeks }]);
    const got = throughputFor(m, ['IvanRoslov']);
    expect(got).toEqual({ kind: 'known', closed: 5, opened: 2, weeks });
  });

  it('folds login case, because `byMember` is a different keying from the queue’s and '
    + 'the roster’s — one person can hold a row under either spelling', () => {
    const m = metrics([{ login: 'IvanRoslov', name: 'Ivan', opened: 2, closed: 5, weeks }]);
    expect(throughputFor(m, ['ivanroslov'])).toMatchObject({ kind: 'known', closed: 5 });
  });

  it('never falls back to the org-wide series when the member carries none — an '
    + 'org chart under one person’s name is a lie, so the trend is simply absent', () => {
    const m = metrics([{ login: 'IvanRoslov', name: 'Ivan', opened: 2, closed: 5 }]);
    expect(throughputFor(m, ['IvanRoslov'])).toEqual({ kind: 'known', closed: 5, opened: 2, weeks: null });
  });

  it('says UNKNOWN, not zero, for a login absent from byMember — the same argument the '
    + '`weeks: null` branch makes: a member board-api does not know about has no '
    + 'throughput to report, and two confident zeros under their name are a claim', () => {
    const m = metrics([{ login: 'octocat', name: 'Octocat', opened: 1, closed: 1, weeks }]);
    expect(throughputFor(m, ['nobody'])).toEqual({ kind: 'unknown' });
  });

  it('sums two case-variant rows for one person rather than racing them (S7)', () => {
    const m = metrics([
      { login: 'IvanRoslov', name: 'Ivan', opened: 1, closed: 3, weeks: [{ opened: 1, closed: 3 }] },
      { login: 'ivanroslov', name: 'Ivan', opened: 2, closed: 4, weeks: [{ opened: 2, closed: 4 }] },
    ]);
    expect(throughputFor(m, ['IvanRoslov'])).toEqual({
      kind: 'known', closed: 7, opened: 3, weeks: [{ opened: 3, closed: 7 }],
    });
  });

  it('sums two selected members (D4d — the same OR the queue applies)', () => {
    const m = metrics([
      { login: 'octocat', name: 'Octocat', opened: 1, closed: 2, weeks: [{ opened: 1, closed: 2 }] },
      { login: 'IvanRoslov', name: 'Ivan', opened: 3, closed: 4, weeks: [{ opened: 3, closed: 4 }] },
    ]);
    expect(throughputFor(m, ['octocat', 'IvanRoslov'])).toEqual({
      kind: 'known', closed: 6, opened: 4, weeks: [{ opened: 4, closed: 6 }],
    });
  });

  it('right-aligns series of DIFFERENT lengths on the most recent week — a member '
    + 'board-api has fewer windows for must land against the right end of a longer '
    + 'series, not its left', () => {
    const m = metrics([
      {
        login: 'octocat',
        name: 'Octocat',
        opened: 0,
        closed: 150,
        weeks: [
          { opened: 1, closed: 10 },
          { opened: 2, closed: 20 },
          { opened: 3, closed: 30 },
          { opened: 4, closed: 40 },
          { opened: 5, closed: 50 },
        ],
      },
      {
        login: 'IvanRoslov',
        name: 'Ivan',
        opened: 0,
        closed: 16,
        weeks: [
          { opened: 100, closed: 7 },
          { opened: 200, closed: 9 },
        ],
      },
    ]);
    // Ivan's two weeks are the two most recent, so they add to the 4th and 5th
    // entries. Left-aligned they would land on the 1st and 2nd, which the fixture
    // is built to make impossible to confuse: every value is distinct.
    expect(throughputFor(m, ['octocat', 'IvanRoslov'])).toMatchObject({
      weeks: [
        { opened: 1, closed: 10 },
        { opened: 2, closed: 20 },
        { opened: 3, closed: 30 },
        { opened: 104, closed: 47 },
        { opened: 205, closed: 59 },
      ],
    });
  });
});


it('counts a shared issue once in Crew throughput and its trend (#924)', () => {
  const m = {
    computedAt: '2026-09-08T12:00:00Z', weeks: [{ opened: 1, closed: 1 }],
    byMember: [{ login: 'a', opened: 1, closed: 1 }, { login: 'b', opened: 1, closed: 1 }],
    openedEvents: [{ htmlUrl: 'shared', createdAt: '2026-09-07T12:00:00Z', assignees: ['a', 'b'] }],
    closeEvents: [{ htmlUrl: 'shared', closedAt: '2026-09-07T15:00:00Z', assignees: ['a', 'b'] }],
  } as IssueMetrics;
  expect(throughputFor(m, ['a', 'b'])).toEqual({ kind: 'known', opened: 1, closed: 1, weeks: [{ opened: 1, closed: 1 }] });
});


it('keeps Crew Throughput on rolling seven-day boundaries, independently of UTC yesterday (#924)', () => {
  const events = [
    ['start', '2026-09-01T12:00:00Z'],
    ['before', '2026-09-01T11:59:59Z'],
    ['end', '2026-09-08T12:00:00Z'],
    ['yesterday', '2026-09-07T12:00:00Z'],
  ];
  const m = {
    computedAt: '2026-09-08T12:00:00Z', weeks: [{ opened: 0, closed: 0 }, { opened: 0, closed: 0 }],
    byMember: [{ login: 'a', opened: 4, closed: 4 }, { login: 'b', opened: 4, closed: 4 }],
    openedEvents: events.map(([htmlUrl, createdAt]) => ({ htmlUrl, createdAt, assignees: ['a', 'b'] })),
    closeEvents: events.map(([htmlUrl, closedAt]) => ({ htmlUrl, closedAt, assignees: ['a', 'b'] })),
  } as IssueMetrics;
  expect(throughputFor(m, ['a', 'b'])).toEqual({ kind: 'known', opened: 2, closed: 2,
    weeks: [{ opened: 1, closed: 1 }, { opened: 2, closed: 2 }] });
});


describe('throughputFor counts the closes board-api sent, and defines none of its own (#1014)', () => {
  // The 12-week series is rebuilt here from `m.closeEvents`, which board-api
  // filters with `deliveredCloseAt` before sending (`issues-metrics.vm.ts`), so
  // an abandoned close never reaches this function. That is the whole of what
  // makes this re-count inherit #1014 — there is no reason rule below.
  const m = {
    computedAt: '2026-09-08T12:00:00Z',
    weeks: [{ opened: 0, closed: 0 }],
    byMember: [{ login: 'a', opened: 9, closed: 9 }],
    openedEvents: [{ htmlUrl: 'one', createdAt: '2026-09-07T12:00:00Z', assignees: ['a'] }],
    closeEvents: [
      { htmlUrl: 'one', closedAt: '2026-09-07T12:00:00Z', assignees: ['a'] },
      { htmlUrl: 'two', closedAt: '2026-09-07T13:00:00Z', assignees: ['a'] },
    ],
  } as IssueMetrics;

  it('counts every event it was given, not the row totals beside them', () => {
    expect(throughputFor(m, ['a'])).toEqual({ kind: 'known', opened: 1, closed: 2, weeks: [{ opened: 1, closed: 2 }] });
  });

  it('is given no reason to re-decide on, which is what keeps the definition single', () => {
    // The tripwire for a fourth definition of a close: writing one here would
    // mean putting a reason on this event, and `close-reason.ts` is where that
    // decision already lives.
    expect(Object.keys(m.closeEvents![0]!).sort()).toEqual(['assignees', 'closedAt', 'htmlUrl']);
  });
});
