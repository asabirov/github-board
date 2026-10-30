import { describe, expect, it } from 'vitest';
import { computeMetrics, toSearchIndex } from './issues-metrics.vm';
import { RawIssue } from './issues-metrics.types';

const NOW = '2026-07-11T12:00:00.000Z';
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * DAY).toISOString();

const name = (login: string) => (login === 'IvanRoslov' ? 'Ivan Roslov' : login);

function issue(p: Partial<RawIssue> & { number: number }): RawIssue {
  return {
    owner: 'acme',
    repo: 'acme',
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

describe('toSearchIndex (#214)', () => {
  it('projects OPEN issues, with the owner off the issue and the repo off the html URL', () => {
    const idx = toSearchIndex([
      issue({ number: 218, title: 'Deploy bug', htmlUrl: 'https://github.com/acme/acme/issues/218' }),
      issue({ number: 4, title: 'Web thing', htmlUrl: 'https://github.com/acme/board/issues/4' }),
      issue({ number: 9, state: 'closed', htmlUrl: 'https://github.com/acme/acme/issues/9' }), // closed → dropped
      issue({ number: 7, htmlUrl: 'https://x/7' }), // unparseable URL → dropped
    ]);
    expect(idx).toEqual([
      { owner: 'acme', repo: 'acme', number: 218, title: 'Deploy bug' },
      { owner: 'acme', repo: 'board', number: 4, title: 'Web thing' },
    ]);
  });

  // #650: the owner used to be re-parsed out of `htmlUrl` — a second derivation
  // of a fact the issue already carries, and the two can disagree. `owner` is
  // what the ingest read the issue under; the URL is a string that came back
  // with it. This fixture pins which of the two wins.
  it('takes the owner off the issue even when the URL names a different org', () => {
    const idx = toSearchIndex([
      issue({
        number: 11,
        title: 'Transferred',
        owner: 'globex',
        repo: 'design-system',
        htmlUrl: 'https://github.com/acme/design-system/issues/11',
      }),
    ]);
    expect(idx).toEqual([
      { owner: 'globex', repo: 'design-system', number: 11, title: 'Transferred' },
    ]);
  });
});

/** #650 — `repo` is a short key that folds across orgs, so an aging row that
 *  carries only `repo` cannot say which `design-system` it came from. */
describe('computeMetrics stale rows name their org (#650)', () => {
  it('two repos with the SAME short key in different orgs give two distinguishable rows', () => {
    const m = computeMetrics(
      [
        issue({ number: 1, owner: 'acme', repo: 'design-system', createdAt: daysAgo(40) }),
        issue({ number: 2, owner: 'globex', repo: 'design-system', createdAt: daysAgo(50) }),
      ],
      NOW,
      {},
      name,
    );
    // Sorted oldest-first by the VM, so #2 (globex) leads. Two DIFFERENT
    // expected owners on the same field: no single constant satisfies both, so
    // a row that hardcoded or dropped the org fails here.
    expect(m.stale.map((s) => `${s.owner}/${s.repo}#${s.number}`)).toEqual([
      'globex/design-system#2',
      'acme/design-system#1',
    ]);
  });

  it('an aging row from the second org reports that org, not the first', () => {
    const m = computeMetrics(
      [
        issue({ number: 1, owner: 'acme', repo: 'board', createdAt: daysAgo(60) }),
        issue({ number: 2, owner: 'globex', repo: 'keitaro', createdAt: daysAgo(40) }),
      ],
      NOW,
      {},
      name,
    );
    expect(m.stale.find((s) => s.number === 2)!.owner).toBe('globex');
    expect(m.stale.find((s) => s.number === 1)!.owner).toBe('acme');
  });
});

describe('computeMetrics', () => {
  it('counts open, unassigned, and closed-in-90d totals', () => {
    const m = computeMetrics(
      [
        issue({ number: 1, state: 'open', assignees: ['IvanRoslov'] }),
        issue({ number: 2, state: 'open', assignees: [] }),
        issue({ number: 3, state: 'closed', createdAt: daysAgo(10), closedAt: daysAgo(3) }),
        issue({ number: 4, state: 'closed', createdAt: daysAgo(200), closedAt: daysAgo(120) }),
      ],
      NOW,
      {},
      name,
    );
    expect(m.totals.open).toBe(2);
    expect(m.totals.unassigned).toBe(1);
    expect(m.totals.closed90).toBe(1); // #4 closed 120d ago is outside the 90d window
  });

  it('attributes trailing-7d throughput per assignee (byMember), most closed first', () => {
    const m = computeMetrics(
      [
        // Ivan: opened+closed this week (counts in both)
        issue({ number: 1, assignees: ['IvanRoslov'], createdAt: daysAgo(5), state: 'closed', closedAt: daysAgo(1) }),
        // Ivan: opened this week, still open
        issue({ number: 2, assignees: ['IvanRoslov'], createdAt: daysAgo(3) }),
        // Octocat: closed this week (created earlier, so opened is NOT bumped)
        issue({ number: 3, assignees: ['octocat'], createdAt: daysAgo(20), state: 'closed', closedAt: daysAgo(2) }),
        // Unassigned closed this week → attributed to nobody
        issue({ number: 4, assignees: [], createdAt: daysAgo(4), state: 'closed', closedAt: daysAgo(1) }),
        // Older activity outside the 7d window → ignored
        issue({ number: 5, assignees: ['octocat'], createdAt: daysAgo(40), state: 'closed', closedAt: daysAgo(20) }),
      ],
      NOW,
      {},
      name,
    );
    // hrefs are null here — the fixture URLs (https://x/N) carry no github owner.
    // `weeks`, `days` and `closedDays` are the per-member series (#336, #666,
    // #817), asserted separately; strip all three here so this stays a focused
    // check on the trailing-7d totals.
    expect(m.byMember.map(({ weeks, days, closedDays, ...r }) => r)).toEqual([
      { login: 'IvanRoslov', name: 'Ivan Roslov', opened: 2, closed: 1, closedHref: null, openedHref: null },
      { login: 'octocat', name: 'octocat', opened: 0, closed: 1, closedHref: null, openedHref: null },
    ]);
  });

  it('folds two spellings of one login into a single member row', () => {
    const m = computeMetrics(
      [
        // Github hands back whatever case the assignment carries; the roster
        // below stores a third spelling. Keyed raw these are three people.
        issue({ number: 1, assignees: ['ivanroslov'], createdAt: daysAgo(3), state: 'closed', closedAt: daysAgo(1) }),
        issue({ number: 2, assignees: ['IVANROSLOV'], createdAt: daysAgo(2) }),
      ],
      NOW,
      {},
      name,
      new Set(),
      ['IvanRoslov'],
    );
    expect(m.byMember).toHaveLength(1);
    const [row] = m.byMember;
    // The roster seeds first, so its spelling is the one reported — and the one
    // the per-member Github search links are built from.
    expect(row.login).toBe('IvanRoslov');
    expect(row.name).toBe('Ivan Roslov');
    expect(row).toMatchObject({ opened: 2, closed: 1 });
    // The 12-week series has to fold too, or the row shows work with a flat
    // trend while a second key quietly holds the series.
    expect(row.weeks[11]).toEqual({ opened: 2, closed: 1 });
  });

  // #817: the calendar grid draws a whole year, and DAY_SPAN cannot hold one.
  // The span is sized once off the FILTERED set and every row of the payload —
  // the org series and each member's — is counted over that same window.
  it('carries closes back to the first one in the filtered set, on one axis for the whole payload (#817)', () => {
    const m = computeMetrics(
      [
        // Ivan closed something 400 days ago — the oldest close on the board.
        issue({ number: 1, assignees: ['IvanRoslov'], createdAt: daysAgo(420), state: 'closed', closedAt: daysAgo(400) }),
        // Octocat has only ever closed one thing, two days ago.
        issue({ number: 2, assignees: ['octocat'], createdAt: daysAgo(30), state: 'closed', closedAt: daysAgo(2) }),
      ],
      NOW,
      {},
      name,
      new Set(),
      // Rostered, because a row only exists for a teammate the trailing week
      // touched or the roster seeds — and Ivan's only close here is 400 days
      // old, which is exactly the history this field exists to carry.
      ['IvanRoslov', 'octocat'],
    );
    expect(m.closedDays).toHaveLength(401); // 400 days back, plus today
    expect(m.closedDays[0]).toBe(1);
    expect(m.closedDays.at(-3)).toBe(1);
    expect(m.closedDays.reduce((s, n) => s + n, 0)).toBe(2);
    // The 98-day span beside it is untouched, and carries only the recent close.
    expect(m.days.closed).toHaveLength(98);
    expect(m.days.closed.reduce((s, n) => s + n, 0)).toBe(1);

    // Octocat's own history starts 2 days ago. His row is still 401 long, because
    // a shorter row would be a second x-axis under the same grid with nothing
    // saying so — his months before the first close are counted zeroes, which is
    // the truth about him on this board.
    const octocat = m.byMember.find((r) => r.login === 'octocat')!;
    const ivan = m.byMember.find((r) => r.login === 'IvanRoslov')!;
    expect(octocat.closedDays).toHaveLength(401);
    expect(ivan.closedDays).toHaveLength(401);
    expect(octocat.closedDays[0]).toBe(0);
    expect(ivan.closedDays[0]).toBe(1);
    // Every member row partitions the org series, index for index.
    for (let d = 0; d < m.closedDays.length; d++) {
      expect(octocat.closedDays[d] + ivan.closedDays[d]).toBe(m.closedDays[d]);
    }
  });

  // The window is the FILTERED set's, not the org's: a repo filter that hides
  // the oldest close must shorten the window, or the narrowed board is drawn as
  // eleven quiet months it was never asked about.
  it('sizes the closed history off the filtered set, not the whole one (#817)', () => {
    const all = [
      issue({ number: 1, repo: 'acme', createdAt: daysAgo(420), state: 'closed', closedAt: daysAgo(400) }),
      issue({ number: 2, repo: 'board', createdAt: daysAgo(150), state: 'closed', closedAt: daysAgo(120) }),
    ];
    expect(computeMetrics(all, NOW, {}, name).closedDays).toHaveLength(401);
    expect(computeMetrics(all, NOW, { repo: 'board' }, name).closedDays).toHaveLength(121);
    // Nothing closed in scope at all → the floor, never a zero-length series.
    expect(computeMetrics([], NOW, {}, name).closedDays).toHaveLength(98);
  });

  it('gives each member a 12-week opened/closed series attributed by assignee (#336)', () => {
    const m = computeMetrics(
      [
        // Ivan: #1 opened+closed in the trailing week; #2 opened ~10d ago (prev window)
        issue({ number: 1, assignees: ['IvanRoslov'], createdAt: daysAgo(3), state: 'closed', closedAt: daysAgo(1) }),
        issue({ number: 2, assignees: ['IvanRoslov'], createdAt: daysAgo(10) }),
        // Octocat: #3 closed in the trailing week (created long ago)
        issue({ number: 3, assignees: ['octocat'], createdAt: daysAgo(40), state: 'closed', closedAt: daysAgo(2) }),
        // Unassigned → attributed to nobody's series
        issue({ number: 4, assignees: [], createdAt: daysAgo(2), state: 'closed', closedAt: daysAgo(1) }),
      ],
      NOW,
      {},
      name,
    );
    const ivan = m.byMember.find((r) => r.login === 'IvanRoslov')!;
    const octocat = m.byMember.find((r) => r.login === 'octocat')!;
    expect(ivan.weeks).toHaveLength(12);
    // trailing window (index 11): Ivan opened #1 and closed #1
    expect(ivan.weeks[11]).toEqual({ opened: 1, closed: 1 });
    // previous window (index 10): Ivan opened #2
    expect(ivan.weeks[10].opened).toBe(1);
    // Octocat closed #3 in the trailing window, opened nothing
    expect(octocat.weeks[11]).toEqual({ opened: 0, closed: 1 });
    // the unassigned #4 never lands in anyone's series
    const total = m.byMember.reduce((s, r) => s + r.weeks[11].closed, 0);
    expect(total).toBe(2); // Ivan #1 + Octocat #3 only
  });

  it('builds per-member Github drill-in links from the window + org (#303)', () => {
    const m = computeMetrics(
      [
        issue({ number: 1, assignees: ['octocat'], htmlUrl: 'https://github.com/acme/acme/issues/1', createdAt: daysAgo(2), state: 'closed', closedAt: daysAgo(1) }),
      ],
      NOW,
      {},
      name,
    );
    const row = m.byMember.find((r) => r.login === 'octocat')!;
    // Window start = 7 days before NOW → 2026-07-04, org derived from the URL.
    // The `-reason:not-planned` qualifier is what makes the LINK return the
    // count it sits behind (#1014): this field exists so a number can be
    // validated against the actual issues it stands for, and without it the
    // search answers with the abandoned closes the count no longer holds.
    expect(row.closedHref).toBe(
      'https://github.com/search?q=' +
        encodeURIComponent('org:acme is:issue assignee:octocat closed:>=2026-07-04 -reason:not-planned') +
        '&type=issues',
    );
    expect(row.openedHref).toBe(
      'https://github.com/search?q=' +
        encodeURIComponent('org:acme is:issue assignee:octocat created:>=2026-07-04') +
        '&type=issues',
    );
  });

  it('seeds the roster so a quiet teammate still shows at 0/0 (#173 "where is Anton?")', () => {
    const m = computeMetrics(
      [issue({ number: 1, assignees: ['octocat'], createdAt: daysAgo(2), state: 'closed', closedAt: daysAgo(1) })],
      NOW,
      {},
      name,
      new Set(),
      ['octocat', 'IvanRoslov', 'anton-khovanskiy'], // roster
    );
    const logins = m.byMember.map((r) => r.login);
    expect(logins).toContain('anton-khovanskiy'); // present despite zero activity
    expect(logins).toContain('IvanRoslov');
    expect(m.byMember.find((r) => r.login === 'anton-khovanskiy')).toMatchObject({ opened: 0, closed: 0 });
    expect(m.byMember[0].login).toBe('octocat'); // active member still leads
  });

  it('buckets throughput into 12 rolling windows, newest last', () => {
    const m = computeMetrics(
      [
        issue({ number: 1, createdAt: daysAgo(2) }), // this week
        issue({ number: 2, createdAt: daysAgo(10), state: 'closed', closedAt: daysAgo(2) }),
      ],
      NOW,
      {},
      name,
    );
    expect(m.weeks).toHaveLength(12);
    expect(m.weeks[11].opened).toBe(1); // #1 opened in the trailing 7 days
    expect(m.weeks[11].closed).toBe(1); // #2 closed in the trailing 7 days
    expect(m.weeks[10].opened).toBe(1); // #2 opened 10d ago → previous window
  });

  it('sorts load by count with the unassigned bucket always last', () => {
    const m = computeMetrics(
      [
        issue({ number: 1, assignees: ['octocat'] }),
        issue({ number: 2, assignees: ['IvanRoslov'] }),
        issue({ number: 3, assignees: ['IvanRoslov'] }),
        issue({ number: 4, assignees: [] }),
        issue({ number: 5, assignees: [] }),
        issue({ number: 6, assignees: [] }),
      ],
      NOW,
      {},
      name,
    );
    expect(m.load.map((r) => [r.name, r.count])).toEqual([
      ['Ivan Roslov', 2],
      ['octocat', 1],
      ['Unassigned', 3],
    ]);
  });

  it('computes median and p90 time-to-close over the 90d window', () => {
    const closed = [1, 2, 3, 4, 10].map((d, i) =>
      issue({ number: i, state: 'closed', createdAt: daysAgo(20), closedAt: daysAgo(20 - d) }),
    );
    const m = computeMetrics(closed, NOW, {}, name);
    expect(m.ttc.n).toBe(5);
    // nearest-rank on [1,2,3,4,10] with idx = floor(p*(n-1)):
    expect(m.ttc.medianDays).toBe(3); // idx 2
    expect(m.ttc.p90Days).toBe(4); //   idx 3
  });

  // #478: `stale` used to be "the N oldest open issues, whatever their age", so a
  // five-day-old issue rode the Oldest-open block on a quiet week and the header's
  // count was the size of the slice. It is now the AGING SET — open flow work at
  // or past AGING_DAYS — with `staleTotal` reporting the whole of it.
  it('returns the aging set as the stale list, oldest first, with anything under the threshold left out', () => {
    const m = computeMetrics(
      [
        issue({ number: 1, createdAt: daysAgo(30) }), // exactly at the threshold → in
        issue({ number: 2, createdAt: daysAgo(5) }), // young → out
        issue({ number: 3, createdAt: daysAgo(60), assignees: ['IvanRoslov'] }),
        issue({ number: 4, createdAt: daysAgo(29) }), // one day short → out
      ],
      NOW,
      {},
      name,
    );
    expect(m.stale.map((s) => s.number)).toEqual([3, 1]);
    // The header's count is the whole aging set, not the rows carried.
    expect(m.staleTotal).toBe(2);
    expect(m.stale[0].who).toBe('Ivan Roslov');
    // Logins ride alongside `who` for the Oldest-open avatars (#207).
    expect(m.stale[0].assignees).toEqual(['IvanRoslov']);
    expect(m.stale[1].who).toBe('unassigned');
    expect(m.stale[1].assignees).toEqual([]);
  });

  it('carries only the head of a large aging set, and still reports its true size', () => {
    // 14 aging issues, ages 40…53 days — more than the response is willing to
    // carry, which is the case the Oldest-open block's "See all N" exists for.
    const many = Array.from({ length: 14 }, (_, k) => issue({ number: k + 1, createdAt: daysAgo(40 + k) }));
    const m = computeMetrics(many, NOW, {}, name);
    expect(m.staleTotal).toBe(14);
    expect(m.stale.length).toBeLessThan(14);
    // Whatever it carries is the OLDEST end of the set, in order.
    expect(m.stale.map((s) => s.ageDays)).toEqual([...m.stale.map((s) => s.ageDays)].sort((a, b) => b - a));
    expect(m.stale[0].ageDays).toBe(53);
  });

  it('reports nothing aging when every open issue is young', () => {
    const m = computeMetrics([issue({ number: 1, createdAt: daysAgo(3) })], NOW, {}, name);
    expect(m.stale).toEqual([]);
    expect(m.staleTotal).toBe(0);
  });

  it('filters by repo, label, and cycle', () => {
    const all = [
      issue({ number: 1, repo: 'board', labels: ['bug'], milestone: null }),
      issue({ number: 2, repo: 'acme', labels: ['bug'], milestone: 'C3' }),
      issue({ number: 3, repo: 'acme', labels: ['ux'], milestone: 'C3' }),
    ];
    expect(computeMetrics(all, NOW, { repo: 'board' }, name).totals.open).toBe(1);
    expect(computeMetrics(all, NOW, { label: 'bug' }, name).totals.open).toBe(2);
    expect(computeMetrics(all, NOW, { cycle: 'C3', label: 'ux' }, name).totals.open).toBe(1);
    // facets are drawn from the unfiltered set
    expect(computeMetrics(all, NOW, { repo: 'board' }, name).repos).toEqual(['acme', 'board']);
  });

  it('excludes clock-skewed closures (future or before-created) from close time', () => {
    const m = computeMetrics(
      [
        // legitimate: created 20d ago, closed 3d ago → 17d to close
        issue({ number: 1, state: 'closed', createdAt: daysAgo(20), closedAt: daysAgo(3) }),
        // closedAt in the future relative to `now` → negative age, must be dropped
        issue({ number: 2, state: 'closed', createdAt: daysAgo(10), closedAt: daysAgo(-2) }),
        // closedAt earlier than createdAt → negative TTC, must be dropped
        issue({ number: 3, state: 'closed', createdAt: daysAgo(5), closedAt: daysAgo(9) }),
      ],
      NOW,
      {},
      name,
    );
    expect(m.totals.closed90).toBe(1);
    expect(m.ttc.n).toBe(1);
    expect(m.ttc.medianDays).toBe(17);
    expect(m.ttc.p90Days).toBe(17);
  });

  it('is safe on an empty set', () => {
    const m = computeMetrics([], NOW, {}, name);
    expect(m.totals).toEqual({ open: 0, openFlow: 0, steadyState: 0, closed90: 0, unassigned: 0 });
    expect(m.ttc).toMatchObject({ medianDays: 0, p90Days: 0, n: 0, meanDays: null, windowDays: 90, readable: true });
    expect(m.ttc.comparison?.deltaDays).toBeNull();
    expect(m.ttc.comparison?.weekly.every((week) => week.n === 0 && week.meanDays === null)).toBe(true);
    expect(m.weeks).toHaveLength(12);
    expect(m.load).toEqual([]);
    expect(m.stale).toEqual([]);
    expect(m.staleTotal).toBe(0);
  });
});

describe('rolling Org lag direction (#1384)', () => {
  it('plots the same means as the adjacent comparison even when weekly means decline', () => {
    const close = (number: number, age: number, duration: number) => issue({ number, state: 'closed', closedAt: daysAgo(age), createdAt: daysAgo(age + duration) });
    const ttc = computeMetrics([close(1, 100, 3.7), close(2, 80, 6.8), close(3, 1, 2)], NOW, {}, name).ttc;
    const comparison = ttc.comparison!;
    const rolling = comparison.rolling!;
    expect(rolling).toHaveLength(14);
    expect(rolling[0]).toEqual({ startAt: daysAgo(180), endAt: daysAgo(90), n: comparison.previousN, meanDays: comparison.previousMeanDays });
    expect(rolling.at(-1)).toEqual({ startAt: daysAgo(90), endAt: NOW, n: ttc.n, meanDays: ttc.meanDays });
    expect(rolling.at(-1)!.meanDays! - rolling[0].meanDays!).toBeCloseTo(comparison.deltaDays!);
    expect(comparison.deltaDays).toBeCloseTo(0.7);
    expect(rolling.every(point => Date.parse(point.endAt) - Date.parse(point.startAt) === 90 * DAY)).toBe(true);
    expect(rolling.map(point => point.endAt)).toEqual([daysAgo(90), ...Array.from({ length: 13 }, (_, i) => daysAgo(84 - 7 * i))]);
  });

  it('retains null windows, zero durations and exact cohort boundaries', () => {
    const close = (number: number, age: number) => issue({ number, state: 'closed', closedAt: daysAgo(age), createdAt: daysAgo(age) });
    const rolling = computeMetrics([close(1, 180), close(2, 90), close(3, 0)], NOW, {}, name).ttc.comparison!.rolling!;
    expect(rolling[0]).toMatchObject({ n: 1, meanDays: 0 });
    expect(rolling.at(-1)).toMatchObject({ n: 1, meanDays: 0 });
    expect(computeMetrics([], NOW, {}, name).ttc.comparison!.rolling!.every(point => point.n === 0 && point.meanDays === null)).toBe(true);
  });
});

describe('adjacent Org lag cohorts (#977)', () => {
  const closed = (number: number, age: number, duration: number) => issue({ number, state: 'closed', closedAt: daysAgo(age), createdAt: daysAgo(age + duration) });

  it('preserves the current population and assigns exact adjacent boundaries once', () => {
    const metrics = computeMetrics([
      closed(1, 0, 10), closed(2, 89, 20), closed(3, 1, 50),
      closed(4, 90, 7), closed(5, 179, 9), closed(6, 180, 100),
      closed(7, -1, 5), closed(8, 1, -1),
      { ...closed(9, 1, 90), state: 'open' as const },
    ], NOW, {}, name);
    expect(metrics.ttc.n).toBe(3);
    expect(metrics.ttc.meanDays).toBeCloseTo(80 / 3);
    expect(metrics.ttc.comparison).toMatchObject({ previousN: 2, previousMeanDays: 8, startAt: daysAgo(90), endAt: NOW, previousStartAt: daysAgo(180) });
    expect(metrics.ttc.comparison?.deltaDays).toBeCloseTo(80 / 3 - 8);
    const weekly = metrics.ttc.comparison!.weekly;
    expect(weekly).toHaveLength(13);
    expect(weekly.reduce((sum, week) => sum + week.n, 0)).toBe(3);
    expect(weekly[0]).toMatchObject({ n: 1, meanDays: 20 });
    expect(weekly[12]).toMatchObject({ n: 2, meanDays: 30 });
    expect(weekly[1]).toMatchObject({ n: 0, meanDays: null });
    expect(weekly.map((week) => (Date.parse(week.endAt) - Date.parse(week.startAt)) / DAY)).toEqual([6, ...Array(12).fill(7)]);
    expect(weekly.map((week) => week.endAt)).toEqual(Array.from({ length: 13 }, (_, i) => daysAgo(7 * (12 - i))));
    expect(weekly[0].startAt).toBe(daysAgo(90));
  });

  it('counts each close in the same week Throughput counts it in (#1041)', () => {
    // Off every bound, because the two count a bound's own millisecond on
    // opposite sides. Anchored at the window's far edge, a close 6.5 days ago
    // was "1 week ago" here and "this week" in Throughput.
    const ages = [0.5, 6.5, 7.5, 13.5, 20.5, 41.5, 83.5];
    const m = computeMetrics(ages.map((age, i) => closed(i + 1, age, 1)), NOW, {}, name);
    expect(m.ttc.comparison!.weekly.slice(1).map((week) => week.n)).toEqual(m.weeks.map((week) => week.closed));
  });

  it('keeps exact-zero observations distinct from absent cohorts', () => {
    const zero = computeMetrics([closed(1, 0, 0)], NOW, {}, name).ttc;
    expect(zero.meanDays).toBe(0);
    expect(zero.comparison?.weekly[12]).toMatchObject({ n: 1, meanDays: 0 });
    expect(zero.comparison).toMatchObject({ previousN: 0, previousMeanDays: null, deltaDays: null });
    const previousOnly = computeMetrics([closed(1, 90, 2)], NOW, {}, name).ttc;
    expect(previousOnly).toMatchObject({ n: 0, meanDays: null });
    expect(previousOnly.comparison).toMatchObject({ previousN: 1, previousMeanDays: 2, deltaDays: null });
  });

  it('places a closure on a weekly boundary in exactly one bucket', () => {
    const weekly = computeMetrics([closed(1, 84, 1), closed(2, 84 - 1 / DAY, 2)], NOW, {}, name).ttc.comparison!.weekly;
    expect(weekly[0]).toMatchObject({ n: 1, meanDays: 1 });
    expect(weekly[1]).toMatchObject({ n: 1, meanDays: 2 });
    expect(weekly.reduce((sum, week) => sum + week.n, 0)).toBe(2);
  });
});

describe('computeMetrics — steady-state classification (long-lived types)', () => {
  const LONG = new Set(['aor', 'roadmap-root', 'roadmap-goal', 'roadmap-kr', 'discovery']);
  // A permanent AOR + an OKR node + a hypothesis, all old; plus two real flow issues.
  const issues = [
    issue({ number: 1, labels: ['aor'], assignees: ['IvanRoslov'], createdAt: daysAgo(400) }),
    issue({ number: 2, labels: ['roadmap-kr'], assignees: ['IvanRoslov'], createdAt: daysAgo(300) }),
    issue({ number: 3, labels: ['discovery'], assignees: ['octocat'], createdAt: daysAgo(200) }),
    issue({ number: 4, labels: ['bug'], assignees: ['octocat'], createdAt: daysAgo(90) }),
    issue({ number: 5, labels: [], assignees: [], createdAt: daysAgo(5) }),
  ];

  it('keeps long-lived issues out of the aging list — only flow issues can be stale', () => {
    const m = computeMetrics(issues, NOW, {}, name, LONG);
    // #1 (400d), #2 (300d) and #3 (200d) are the three oldest issues here and are
    // all past the threshold — they are excluded for being steady-state, not for
    // being young, which is the whole point of the rule. #4 (90d flow) is the one
    // aging issue; #5 (5d flow) is under the threshold (#478).
    expect(m.stale.map((s) => s.number)).toEqual([4]);
    expect(m.staleTotal).toBe(1);
  });

  // The same set with NO long-lived labels configured: now #1/#2/#3 are ordinary
  // flow work and do age. Without this the assertion above could pass on the
  // threshold alone, never exercising the steady-state exclusion.
  it('the exclusion is the labels, not the ages — unconfigured, the same old issues do age', () => {
    const m = computeMetrics(issues, NOW, {}, name);
    expect(m.stale.map((s) => s.number)).toEqual([1, 2, 3, 4]);
    expect(m.staleTotal).toBe(4);
  });

  it('splits the open headline into flow vs steady-state', () => {
    const m = computeMetrics(issues, NOW, {}, name, LONG);
    expect(m.totals.open).toBe(5); // total unchanged
    expect(m.totals.openFlow).toBe(2); // #4, #5
    expect(m.totals.steadyState).toBe(3); // #1, #2, #3
    expect(m.totals.unassigned).toBe(1); // only the flow unassigned (#5), not steady-state
  });

  it('counts per-person load from flow work only, not owned AORs/KRs', () => {
    const m = computeMetrics(issues, NOW, {}, name, LONG);
    // Ivan owns #1 (aor) + #2 (kr) — both steady-state → he is NOT in the load list.
    expect(m.load.find((r) => r.login === 'IvanRoslov')).toBeUndefined();
    // octocat owns #4 (a flow bug) → load 1; #3 (discovery) doesn't count.
    expect(m.load.find((r) => r.login === 'octocat')?.count).toBe(1);
  });

  it('tracks steady-state as its own typed breakdown, most first', () => {
    const more = [...issues, issue({ number: 6, labels: ['aor'], createdAt: daysAgo(50) })];
    const m = computeMetrics(more, NOW, {}, name, LONG);
    // aor: #1,#6 → 2 ; roadmap-kr: 1 ; discovery: 1
    expect(m.steadyByType).toEqual([
      { label: 'aor', count: 2 },
      { label: 'discovery', count: 1 },
      { label: 'roadmap-kr', count: 1 },
    ]);
  });

  it('with no long-lived labels configured, everything is flow (back-compat)', () => {
    const m = computeMetrics(issues, NOW, {}, name); // default empty set
    expect(m.totals.openFlow).toBe(5);
    expect(m.totals.steadyState).toBe(0);
    expect(m.steadyByType).toEqual([]);
  });
});


describe('Org lag (#843)', () => {
  it('uses the arithmetic mean of full elapsed durations, including issues opened before the window', () => {
    const rows = [1, 2, 120].map((duration, index) => issue({
      number: index, state: 'closed', closedAt: daysAgo(1), createdAt: daysAgo(1 + duration),
    }));
    const m = computeMetrics(rows, NOW, {}, name);
    expect(m.ttc.meanDays).toBe(41);
    expect(m.ttc.medianDays).toBe(2);
    expect(m.ttc.n).toBe(3);
    expect(m.ttc.windowDays).toBe(90);
  });

  it('keeps fractional days and a real zero, but no sample has no mean', () => {
    const closed = (createdAt: string) => issue({ number: 1, state: 'closed', closedAt: NOW, createdAt });
    expect(computeMetrics([closed(daysAgo(0.25)), closed(NOW)], NOW, {}, name).ttc.meanDays).toBe(0.125);
    expect(computeMetrics([closed(NOW)], NOW, {}, name).ttc.meanDays).toBe(0);
    expect(computeMetrics([], NOW, {}, name).ttc.meanDays).toBeNull();
  });

  it('uses (now - 90 days, now], current closed state, and valid ordered timestamps', () => {
    const rows = [
      { closedAt: daysAgo(90) },
      { closedAt: new Date(Date.parse(daysAgo(90)) + 1).toISOString() },
      { closedAt: NOW },
      { closedAt: new Date(Date.parse(NOW) + 1).toISOString() },
      { closedAt: daysAgo(1), state: 'open' as const },
      { closedAt: null },
      { closedAt: 'invalid' },
      { closedAt: daysAgo(1), createdAt: 'invalid' },
      { closedAt: daysAgo(1), createdAt: NOW },
    ].map((over, number) => issue({ number, state: 'closed', createdAt: daysAgo(100), ...over }));
    const m = computeMetrics(rows, NOW, {}, name);
    expect(m.ttc.n).toBe(2);
    expect(m.ttc.meanDays).toBeCloseTo((110 + 1 / DAY) / 2, 8);
  });

  it('measures instants across offsets, including a daylight-saving transition', () => {
    const m = computeMetrics([issue({ number: 1, state: 'closed',
      createdAt: '2026-03-08T01:30:00-05:00', closedAt: '2026-03-08T03:30:00-04:00',
    })], '2026-03-09T00:00:00Z', {}, name);
    expect(m.ttc.meanDays).toBeCloseTo(1 / 24);
  });
});

describe('closed metric evidence (#907, #913)', () => {
  it('carries the exact UTC yesterday rows and unassigned/multi-assigned events without widening a repo filter', () => {
    const rows = [
      issue({ number: 1, closedAt: '2026-07-10T00:00:00Z', state: 'closed', assignees: ['a', 'b'] }),
      issue({ number: 2, closedAt: '2026-07-10T23:59:59Z', state: 'closed' }),
      issue({ number: 3, closedAt: '2026-07-11T00:00:00Z', state: 'closed' }),
      issue({ number: 4, closedAt: '2026-07-09T23:59:59Z', state: 'closed' }),
      issue({ number: 5, repo: 'other', closedAt: '2026-07-10T12:00:00Z', state: 'closed' }),
    ];
    const m = computeMetrics(rows, NOW, { repo: 'acme' }, name);
    expect(m.computedAt).toBe(NOW);
    expect(m.closedYesterday?.map((i) => i.number)).toEqual([1, 2]);
    expect(m.closeEvents).toHaveLength(4);
    expect(m.days.closed.at(-2)).toBe(m.closedYesterday?.length);
    expect(m.weeks.at(-1)?.closed).toBe(4);
    expect(m.closeEvents?.filter((i) => Date.parse(i.closedAt) >= Date.parse(NOW) - 7 * DAY && Date.parse(i.closedAt) < Date.parse(NOW))).toHaveLength(4);
  });
});

describe('a close is only delivery when Github said it was (#1014)', () => {
  /** One completed close and one not-planned close, same assignee, same day.
   *  Every figure below is derived from that pair, so a call site that missed
   *  the predicate reads 2 where its neighbours read 1. */
  const pair = () => computeMetrics(
    [
      issue({ number: 1, assignees: ['octocat'], createdAt: daysAgo(10), state: 'closed', closedAt: daysAgo(1), stateReason: 'completed' }),
      issue({ number: 2, assignees: ['octocat'], createdAt: daysAgo(30), state: 'closed', closedAt: daysAgo(1), stateReason: 'not_planned' }),
    ],
    NOW,
    {},
    name,
  );

  // ONE TEST, MANY ASSERTIONS, deliberately. A case per figure would pass with
  // any single site fixed; what actually catches a missed one is every figure
  // over a single fixture, where one disagreeing number stands out.
  it('leaves the abandoned close out of every org figure at once', () => {
    const m = pair();
    expect(m.weeks.at(-1)!.closed).toBe(1);
    expect(m.days.closed.at(-2)).toBe(1);
    expect(m.closedDays!.at(-2)).toBe(1);
    expect(m.recent4.closed).toBe(1);
    expect(m.totals.closed90).toBe(1);
    expect(m.byMember.find((r) => r.login === 'octocat')!.closed).toBe(1);
    expect(m.byMember.find((r) => r.login === 'octocat')!.closedDays!.at(-2)).toBe(1);
    expect(m.closeEvents).toHaveLength(1);
    expect(m.closedYesterday).toHaveLength(1);
    expect(m.ttc.n).toBe(1);
  });

  it('still counts the OPENS of an issue that was later abandoned', () => {
    // Both issues were opened, and dropping the close does not un-open one.
    // Both opens are older than the trailing week, so the assertion that carries
    // the point is the day series, which reaches them: two opens, one close.
    const m = pair();
    expect(m.days.opened.reduce((s, n) => s + n, 0)).toBe(2);
    expect(m.days.opened.at(-11)).toBe(1);
    expect(m.days.opened.at(-31)).toBe(1);
    expect(m.days.closed.reduce((s, n) => s + n, 0)).toBe(1);
  });

  it('moves the time-to-close MEDIAN, not just its n', () => {
    // The movement most likely to be misread on release: abandoned issues skew
    // old, so removing them makes Org lag look better because data left. Here
    // the 30-day abandonment is the slower of the two and its removal halves
    // the median rather than merely dropping the sample count.
    const m = pair();
    expect(m.ttc.n).toBe(1);
    expect(m.ttc.medianDays).toBe(9);
  });

  it('keeps the grid’s reach at the first close of any kind, and counts only the delivered ones inside it', () => {
    // Two questions, deliberately answered differently: the WINDOW says how far
    // back the board was watching, and an abandoned close is evidence it was.
    // The COUNT inside it is delivery only. Clipping the window to the first
    // delivered close would draw 300 observed days as nothing at all.
    const m = computeMetrics(
      [
        issue({ number: 1, createdAt: daysAgo(400), state: 'closed', closedAt: daysAgo(300), stateReason: 'not_planned' }),
        issue({ number: 2, createdAt: daysAgo(10), state: 'closed', closedAt: daysAgo(1), stateReason: 'completed' }),
      ],
      NOW,
      {},
      name,
    );
    expect(m.closedDays).toHaveLength(301); // reaches the abandoned close…
    expect(m.closedDays!.at(-2)).toBe(1);
    expect(m.closedDays![0]).toBe(0); // …and reads zero on its day
    expect(m.closedDays!.reduce((s, n) => s + n, 0)).toBe(1);
  });

  it('leaves it out of the per-member 12-week series too', () => {
    // The one counting site nothing else here reaches: `memberWeeks` drives the
    // Crew card's own sparkline, and a mutation reverting it to `closedAt` passed
    // the entire suite. The trailing window is asserted separately above; this is
    // the SERIES, which is a different loop over the same rows.
    const m = pair();
    const row = m.byMember.find((r) => r.login === 'octocat')!;
    expect(row.weeks.at(-1)).toEqual({ opened: 0, closed: 1 });
    expect(row.weeks.reduce((s, w) => s + w.closed, 0)).toBe(1);
  });

  it('counts a close whose reason we were never told', () => {
    // The lenient branch, pinned at the payload level and not only in
    // close-reason.spec.ts: a row from a source that did not select the field
    // keeps counting exactly as it did before #1014.
    const m = computeMetrics(
      [issue({ number: 1, assignees: ['octocat'], createdAt: daysAgo(10), state: 'closed', closedAt: daysAgo(1), stateReason: null })],
      NOW,
      {},
      name,
    );
    expect(m.weeks.at(-1)!.closed).toBe(1);
    expect(m.closeEvents).toHaveLength(1);
  });
});
