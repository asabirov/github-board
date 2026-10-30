import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import { ProjectsService } from './projects.service';
import type { IProjectsSource, ProjectRollup } from './project.types';
import type { CloseReason } from '../issues-metrics/close-reason';
import {
  PULSE_DAYS,
  PULSE_WEEKS,
  WEEK_DAYS,
  dailyByProject,
  openedThisWeekOf,
  weeklyClosedByProject,
  type PulseIssue,
} from './project-pulse';

const NOW = '2026-07-11T12:00:00.000Z';
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * DAY).toISOString();

/** A row for the join. `stateReason` defaults to `null` — the "we were not told
 *  why" that COUNTS as delivery (#1014) — so every assertion written before the
 *  reason existed keeps meaning what it meant. */
function issue(url: string, closedDaysAgo: number | null, stateReason: CloseReason = null): PulseIssue {
  return { htmlUrl: url, closedAt: closedDaysAgo == null ? null : daysAgo(closedDaysAgo), stateReason };
}

describe('weeklyClosedByProject (#391)', () => {
  const memberships = [
    { number: 4, issueUrls: ['https://x/1', 'https://x/2', 'https://x/3', 'https://x/4'] },
    { number: 7, issueUrls: [] }, // a board with no memberships
  ];

  it('buckets closes into 10 slots, current week last, empty weeks are 0', () => {
    const out = weeklyClosedByProject(
      [
        issue('https://x/1', 1), // this week
        issue('https://x/2', 3), // this week
        issue('https://x/3', 10), // one week back (slot 8)
        issue('https://x/4', null), // still open → never counts
      ],
      memberships,
      NOW,
    );
    expect(out[4]).toHaveLength(PULSE_WEEKS);
    // last slot = current week holds the two recent closes.
    expect(out[4][9]).toBe(2);
    // 10 days ago lands one window back.
    expect(out[4][8]).toBe(1);
    // every other week saw nothing.
    expect(out[4].reduce((s, v) => s + v, 0)).toBe(3);
    expect(out[4].filter((v) => v === 0)).toHaveLength(8);
  });

  it('excludes a close older than the 10-week window', () => {
    const out = weeklyClosedByProject(
      [
        issue('https://x/1', 71), // > 10 weeks ago → dropped
        issue('https://x/2', 70), // exactly 10 weeks ago → oldest slot
      ],
      memberships,
      NOW,
    );
    expect(out[4][0]).toBe(1); // the 70-day close sits in the oldest slot
    expect(out[4].reduce((s, v) => s + v, 0)).toBe(1); // the 71-day one is gone
  });

  it('gives a board with no memberships an all-zero series', () => {
    const out = weeklyClosedByProject([issue('https://x/1', 1)], memberships, NOW);
    expect(out[7]).toEqual(new Array(PULSE_WEEKS).fill(0));
  });

  it('counts every close on the board, not one assignee — assignees are irrelevant here', () => {
    // The helper never looks at assignees; two closes on the same board both count.
    const out = weeklyClosedByProject(
      [issue('https://x/1', 2), issue('https://x/2', 4)],
      [{ number: 4, issueUrls: ['https://x/1', 'https://x/2'] }],
      NOW,
    );
    expect(out[4][9]).toBe(2);
  });

  it('skips a not-planned close inside the window and still counts one with no reason (#1014)', () => {
    // All three land in the SAME bucket, so the only thing separating them is
    // the reason — a window or a bucketing bug cannot produce this answer.
    const out = weeklyClosedByProject(
      [
        issue('https://x/1', 2, 'completed'),
        issue('https://x/2', 2, 'not_planned'), // abandoned → never throughput
        issue('https://x/3', 2, null), // "we were not told why" → counts
      ],
      [{ number: 4, issueUrls: ['https://x/1', 'https://x/2', 'https://x/3'] }],
      NOW,
    );
    expect(out[4][PULSE_WEEKS - 1]).toBe(2);
    expect(out[4].reduce((s, v) => s + v, 0)).toBe(2);
  });

  it('skips a duplicate close for the same reason a not-planned one is skipped (#1014)', () => {
    // Counted under its twin already, so counting it here counts one piece of
    // work twice.
    const out = weeklyClosedByProject(
      [issue('https://x/1', 3, 'duplicate')],
      [{ number: 4, issueUrls: ['https://x/1'] }],
      NOW,
    );
    expect(out[4].reduce((s, v) => s + v, 0)).toBe(0);
  });
});

describe('dailyByProject day boundaries (#663)', () => {
  const memberships = [
    { number: 4, issueUrls: ['https://x/1', 'https://x/2', 'https://x/3', 'https://x/4'] },
    { number: 7, issueUrls: [] }, // a board with no memberships
  ];
  const at = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
  const closedAt = (url: string, ms: number, stateReason: CloseReason = null): PulseIssue => ({
    htmlUrl: url,
    closedAt: at(ms),
    createdAt: at(ms),
    stateReason,
  });

  it('holds the 24h boundary: exactly 24h and a millisecond under land last, 24h+1ms falls back one', () => {
    const out = dailyByProject(
      [closedAt('https://x/1', DAY), closedAt('https://x/2', DAY - 1), closedAt('https://x/3', DAY + 1)],
      memberships,
      NOW,
    );
    expect(out[4].closed).toHaveLength(PULSE_DAYS);
    expect(out[4].closed[PULSE_DAYS - 1]).toBe(2);
    expect(out[4].closed[PULSE_DAYS - 2]).toBe(1);
    // The opened series buckets the same instants through the same arithmetic.
    expect(out[4].opened[PULSE_DAYS - 1]).toBe(2);
    expect(out[4].opened[PULSE_DAYS - 2]).toBe(1);
  });

  it('drops a close in the future and one older than the window, keeping the exact window edge', () => {
    const out = dailyByProject(
      [
        { htmlUrl: 'https://x/1', closedAt: new Date(Date.parse(NOW) + DAY).toISOString(), createdAt: NOW, stateReason: null },
        closedAt('https://x/2', PULSE_DAYS * DAY + 1), // a millisecond past the window
        closedAt('https://x/3', PULSE_DAYS * DAY), // exactly the window edge → oldest slot
      ],
      memberships,
      NOW,
    );
    expect(out[4].closed[0]).toBe(1);
    expect(out[4].closed.reduce((s, v) => s + v, 0)).toBe(1);
    expect(out[4].opened.reduce((s, v) => s + v, 0)).toBe(1);
  });

  it('counts a close that lands in the last weekly bucket in the day series too', () => {
    const issues = [closedAt('https://x/1', 3 * DAY)];
    const weekly = weeklyClosedByProject(issues, memberships, NOW);
    const daily = dailyByProject(issues, memberships, NOW);
    expect(weekly[4][PULSE_WEEKS - 1]).toBe(1);
    expect(daily[4].closed[PULSE_DAYS - 3]).toBe(1);
    expect(daily[4].closed.reduce((s, v) => s + v, 0)).toBe(1);
  });

  it('gives a board with no memberships two all-zero series', () => {
    const out = dailyByProject([closedAt('https://x/1', DAY)], memberships, NOW);
    expect(out[7].opened).toEqual(new Array(PULSE_DAYS).fill(0));
    expect(out[7].closed).toEqual(new Array(PULSE_DAYS).fill(0));
  });

  it('skips a not-planned close inside the window and still counts one with no reason (#1014)', () => {
    // Same day, same board, same bucket — and the opened series is untouched by
    // the exclusion, because an issue later abandoned was still opened. That is
    // the half of the pair a filter applied one level too early would break.
    const out = dailyByProject(
      [
        closedAt('https://x/1', DAY, 'completed'),
        closedAt('https://x/2', DAY, 'not_planned'),
        closedAt('https://x/3', DAY, null),
      ],
      memberships,
      NOW,
    );
    expect(out[4].closed[PULSE_DAYS - 1]).toBe(2);
    expect(out[4].closed.reduce((s, v) => s + v, 0)).toBe(2);
    expect(out[4].opened[PULSE_DAYS - 1]).toBe(3);
  });

  it('leaves the opened series empty for an issue whose createdAt the caller could not supply', () => {
    const out = dailyByProject(
      [{ htmlUrl: 'https://x/1', closedAt: at(DAY), stateReason: null }],
      memberships,
      NOW,
    );
    expect(out[4].closed[PULSE_DAYS - 1]).toBe(1);
    expect(out[4].opened.reduce((s, v) => s + v, 0)).toBe(0);
  });
});

/**
 * The gate in front of both day series (#663 follow-up) used to withhold them
 * from any board whose three item counts summed to the source's old
 * single-page read (100) — a full page proved nothing about what Github held
 * after it. #690 made the source page every board's items to the end of the
 * connection instead of stopping at one page, so that heuristic is gone: a
 * board draws its series regardless of how many items it holds, at 100 or
 * past it. What decides now is the source's own `itemsComplete`, read from the
 * paging that actually happened. Driven through the real
 * `ProjectsService.listProjects`, because that is where the gate sits.
 */
describe('ProjectsService serves the day series on every board, whatever its item count (#690)', () => {
  /** A board whose three item counts sum to `open + closed + excludedItems`,
   *  read whole unless the caller says otherwise. */
  const board = (
    number: number,
    open: number,
    closed: number,
    excludedItems: number,
    itemsComplete = true,
  ): ProjectRollup => ({
    number,
    name: `Board ${number}`,
    url: `https://github.com/orgs/x/projects/${number}`,
    status: 'active',
    open,
    closed,
    pct: 50,
    excludedItems,
    itemsComplete,
    recentCloses: [],
    weeklyClosed: [],
    closedThisWeek: 0,
    openedThisWeek: 0,
    contributors: [],
    contributorsByAssignee: [],
  });

  function service(boards: ProjectRollup[]): ProjectsService {
    const source: IProjectsSource = {
      listProjects: async () => boards,
      getProject: async () => null,
      projectMemberships: async () => [],
      listProjectCatalog: async () => [],
      disownInFlightReads: () => {},
    };
    // `FEEDBACK_REPO` and `GITHUB_ORGS` have no defaults since #1175, and the
    // service reads both in its constructor.
    const config = {
      get: (k: string, d?: unknown) =>
        k === 'FEEDBACK_REPO' ? 'acme/board' : k === 'GITHUB_ORGS' ? 'acme' : d,
    } as unknown as ConfigService;
    const issuesCache = {
      getIssues: async () => ({ issues: [], at: Date.now() }),
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    return new ProjectsService(source, config, issuesCache);
  }

  it('draws the series at the old page size and past it alike', async () => {
    // Board 9: 34 + 85 + 0 = 119, past the old 100-item heuristic — the exact
    // shape #690 was filed against. Board 10: 29 + 69 + 2 = 100, the old page
    // size itself, which the removed gate also called incomplete.
    const [pastOldGate, atOldGate] = await service([board(9, 34, 85, 0), board(10, 29, 69, 2)]).listProjects(
      undefined,
    );

    expect(pastOldGate.itemsComplete).toBe(true);
    expect(pastOldGate.dailyOpened).toHaveLength(PULSE_DAYS);
    expect(pastOldGate.dailyClosed).toHaveLength(PULSE_DAYS);

    expect(atOldGate.itemsComplete).toBe(true);
    expect(atOldGate.dailyOpened).toHaveLength(PULSE_DAYS);
    expect(atOldGate.dailyClosed).toHaveLength(PULSE_DAYS);
  });

  it('withholds both series from a board the SOURCE says it could not read whole', async () => {
    // The two cases a read still falls short in (#690): the source's 20-page
    // cap, and a board that changed under a paged read. Neither is reachable
    // from the counts on this shape — only the source, which held the
    // `totalCount` Github reported, can say it happened, so the field is its
    // answer and this gate is downstream of it.
    const [short] = await service([board(9, 34, 85, 0, false)]).listProjects(undefined);

    expect(short.itemsComplete).toBe(false);
    // Empty, not fourteen zeros: items come back in board order, so the tail a
    // short read lost is the newest one — the whole of the trailing bucket.
    expect(short.dailyOpened).toEqual([]);
    expect(short.dailyClosed).toEqual([]);
  });
});

describe('openedThisWeekOf (#851)', () => {
  const memberships = [{ number: 4, issueUrls: ['https://x/1', 'https://x/2', 'https://x/3'] }];

  const opened = (url: string, daysAgo_: number): PulseIssue => ({
    htmlUrl: url,
    closedAt: null,
    createdAt: daysAgo(daysAgo_),
    stateReason: null,
  });

  it('sums the trailing seven day-buckets and no more', () => {
    const daily = dailyByProject(
      [
        opened('https://x/1', 1), // inside the week
        opened('https://x/2', 6), // inside the week
        opened('https://x/3', 9), // in the day series, outside the week
      ],
      memberships,
      NOW,
    );

    expect(daily[4].opened).toHaveLength(PULSE_DAYS);
    expect(openedThisWeekOf(daily[4].opened)).toBe(2);
  });

  it('sums an empty series to 0 rather than throwing', () => {
    // The shape a withheld board carries. Callers gate on
    // `joinedFiguresWithheld` and never render this, but a helper that threw
    // would turn a withholding into a 500.
    expect(openedThisWeekOf([])).toBe(0);
  });

  /**
   * The one property the card's line rests on (#851): "This week: N closed, M
   * opened" is two counts over ONE interval, not two nearly-equal ones.
   *
   * `closedThisWeek` is the last slot of a 7-day-wide series and the opened
   * figure is the last seven slots of a 1-day-wide one. Both go through
   * `pulseSlot` off the same `nowIso`, so they should agree exactly — including
   * at the boundary, which is where two hand-rolled windows would part company.
   *
   * Read it as a pair: the same instant, moved one millisecond, has to leave
   * BOTH windows at once. One issue opened and closed at that instant is what
   * makes the two figures comparable at all.
   */
  it('covers the same interval as the week series, to the millisecond', () => {
    const now = Date.parse(NOW);
    const onTheEdge = new Date(now - 7 * DAY + 1).toISOString(); // just inside
    const overTheEdge = new Date(now - 7 * DAY - 1).toISOString(); // just outside

    for (const [at, expected] of [
      [onTheEdge, 1],
      [overTheEdge, 0],
    ] as const) {
      const issues: PulseIssue[] = [{ htmlUrl: 'https://x/1', closedAt: at, createdAt: at, stateReason: null }];
      const week = weeklyClosedByProject(issues, memberships, NOW);
      const daily = dailyByProject(issues, memberships, NOW);

      expect(week[4][PULSE_WEEKS - 1]).toBe(expected);
      expect(openedThisWeekOf(daily[4].opened)).toBe(expected);
    }
  });

  it('is seven days wide, and says so', () => {
    // The constant is exported so the divisor is named once. A drift here is a
    // card whose two figures cover different windows while reading as a pair.
    expect(WEEK_DAYS).toBe(7);
    expect(openedThisWeekOf(Array.from({ length: PULSE_DAYS }, () => 1))).toBe(WEEK_DAYS);
  });
});
