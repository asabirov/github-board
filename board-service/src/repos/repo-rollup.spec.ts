import { describe, expect, it } from 'vitest';
import { REPO_WEEKS, rollUpRepos, weeklyFlowByRepo, type FlowIssue } from './repo-rollup';
import type { RepoDescriptor } from './repo.types';

const DAY_MS = 86_400_000;
const NOW = '2026-08-05T12:00:00.000Z';
const now = Date.parse(NOW);
const daysAgo = (d: number) => new Date(now - d * DAY_MS).toISOString();

function issue(over: Partial<FlowIssue> = {}): FlowIssue {
  return {
    owner: 'acme',
    repo: 'board',
    state: 'open' as const,
    createdAt: daysAgo(1),
    closedAt: null,
    // The default is the reason Github never gave us, which COUNTS as delivery
    // (#1014) — so every case written before the reason existed still asserts
    // what it asserted.
    stateReason: null,
    ...over,
  };
}

function descriptor(over: Partial<RepoDescriptor> = {}): RepoDescriptor {
  return {
    full: 'acme/board',
    name: 'board',
    key: 'board',
    htmlUrl: 'https://github.com/acme/board',
    description: null,
    language: null,
    pushedAt: null,
    createdAt: null,
    defaultBranch: 'main',
    ...over,
  };
}

describe('weeklyFlowByRepo (#472)', () => {
  it('buckets opens and closes into REPO_WEEKS rolling 7-day windows, oldest → newest', () => {
    const flow = weeklyFlowByRepo(
      [
        issue({ createdAt: daysAgo(1) }), // last window
        issue({ createdAt: daysAgo(2) }), // last window
        issue({ createdAt: daysAgo(20), closedAt: daysAgo(3), state: 'closed' }),
      ],
      NOW,
    );
    const weeks = flow.get('acme/board');
    expect(weeks).toHaveLength(REPO_WEEKS);
    expect(weeks?.[REPO_WEEKS - 1]).toEqual({ opened: 2, closed: 1 });
    // The 20-day-old open lands three windows back (ceil(20/7) = 3).
    expect(weeks?.[REPO_WEEKS - 3]).toEqual({ opened: 1, closed: 0 });
  });

  it('drops activity older than the window rather than folding it into the oldest bucket', () => {
    const flow = weeklyFlowByRepo([issue({ createdAt: daysAgo(400) }), issue({ createdAt: daysAgo(2) })], NOW);
    const weeks = flow.get('acme/board') ?? [];
    expect(weeks.reduce((n, w) => n + w.opened, 0)).toBe(1);
    expect(weeks[0]).toEqual({ opened: 0, closed: 0 });
  });

  it('keys by the repo key on the ingested issue, so each repo gets its own series', () => {
    const flow = weeklyFlowByRepo(
      [issue({ repo: 'board' }), issue({ repo: 'acme' }), issue({ repo: 'acme' })],
      NOW,
    );
    expect(flow.get('acme/board')?.[REPO_WEEKS - 1].opened).toBe(1);
    expect(flow.get('acme/acme')?.[REPO_WEEKS - 1].opened).toBe(2);
  });

  it('leaves a not-planned close out of the week it closed in, and keeps its open (#1014)', () => {
    // Three closes in one bucket, told apart by nothing but the reason. The
    // OPENED count stays 3: all three issues were opened, and only the claim
    // that one of them was finished is being withdrawn — a filter applied to the
    // whole row rather than to the close would take the open with it.
    const flow = weeklyFlowByRepo(
      [
        issue({ createdAt: daysAgo(2), closedAt: daysAgo(1), state: 'closed', stateReason: 'completed' }),
        issue({ createdAt: daysAgo(2), closedAt: daysAgo(1), state: 'closed', stateReason: 'not_planned' }),
        issue({ createdAt: daysAgo(2), closedAt: daysAgo(1), state: 'closed', stateReason: null }),
      ],
      NOW,
    );
    const weeks = flow.get('acme/board') ?? [];
    expect(weeks[REPO_WEEKS - 1]).toEqual({ opened: 3, closed: 2 });
    expect(weeks.reduce((n, w) => n + w.closed, 0)).toBe(2);
  });

  it('leaves a duplicate close out too — it is already counted under its twin (#1014)', () => {
    const flow = weeklyFlowByRepo(
      [issue({ createdAt: daysAgo(4), closedAt: daysAgo(3), state: 'closed', stateReason: 'duplicate' })],
      NOW,
    );
    const weeks = flow.get('acme/board') ?? [];
    expect(weeks.reduce((n, w) => n + w.closed, 0)).toBe(0);
    expect(weeks.reduce((n, w) => n + w.opened, 0)).toBe(1);
  });
});

describe('rollUpRepos (#472)', () => {
  it('includes a repo whose queue is empty, with a zeroed series', () => {
    const rows = rollUpRepos(
      [descriptor({ full: 'acme/status', name: 'status', key: 'status' })],
      [],
      NOW,
      () => null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].open).toBe(0);
    expect(rows[0].weeks).toHaveLength(REPO_WEEKS);
    expect(rows[0].owner).toBeNull();
  });

  it('counts the repo current open issues', () => {
    const rows = rollUpRepos(
      [descriptor()],
      [issue(), issue(), issue({ state: 'closed', closedAt: daysAgo(1) })],
      NOW,
      () => null,
    );
    expect(rows[0].open).toBe(2);
  });

  it('ships the window’s weeks and no verdict on them (#607)', () => {
    // A queue that grew every week of the window used to come back carrying a
    // boolean saying so. The weeks are the whole of what the rollup says about
    // flow now — the surface draws them and decides for itself.
    const issues = Array.from({ length: REPO_WEEKS }, (_, w) => issue({ createdAt: daysAgo(w * 7 + 1) }));
    const rows = rollUpRepos([descriptor()], issues, NOW, () => null);
    expect(rows[0].weeks.filter((w) => w.opened > w.closed)).toHaveLength(REPO_WEEKS);
    expect(Object.keys(rows[0])).not.toContain('growing');
  });

  it('carries the resolved owner through', () => {
    const rows = rollUpRepos([descriptor()], [], NOW, () => ({ login: 'octocat', name: 'Octocat Octocat' }));
    expect(rows[0].owner).toEqual({ login: 'octocat', name: 'Octocat Octocat' });
  });

  // #647. Both orgs the board is about to read own a repo called
  // `design-system`, so the short key `design-system` is claimed twice. Keyed on
  // the short key alone this yields ONE row carrying the sum of two queues; the
  // join carries the owner now, so each org keeps its own.
  it('keeps same-named repos in two orgs apart', () => {
    const rows = rollUpRepos(
      [
        descriptor({ full: 'acme/design-system', name: 'design-system', key: 'design-system' }),
        descriptor({ full: 'globex/design-system', name: 'design-system', key: 'design-system' }),
      ],
      [
        issue({ owner: 'acme', repo: 'design-system' }),
        issue({ owner: 'globex', repo: 'design-system' }),
      ],
      NOW,
      () => null,
    );
    expect(rows.map((r) => r.full).sort()).toEqual(['acme/design-system', 'globex/design-system']);
    expect(rows.every((r) => r.open === 1)).toBe(true);
    expect(rows.every((r) => r.weeks[REPO_WEEKS - 1].opened === 1)).toBe(true);
  });

  it('sorts by full name so the map is stable between reads', () => {
    const rows = rollUpRepos(
      [
        descriptor({ full: 'acme/status', name: 'status', key: 'status' }),
        descriptor({ full: 'acme/acme', name: 'acme', key: 'acme' }),
      ],
      [],
      NOW,
      () => null,
    );
    expect(rows.map((r) => r.name)).toEqual(['acme', 'status']);
  });
});

// Security and CI left the row with #571 — they are a second read on their own
// endpoint now, and their assertions moved to repos.service.spec.ts with them.
// What stays here is what the rollup still derives per repo.
describe('rollUpRepos — the facts the row still carries', () => {
  it("carries each repo's language onto its row", () => {
    const rows = rollUpRepos([descriptor({ language: 'TypeScript' })], [], NOW, () => null);
    expect(rows[0].language).toBe('TypeScript');
  });

  it('draws no security or CI field at all, so the row never says "zero" about a fact it has not got', () => {
    const rows = rollUpRepos([descriptor()], [], NOW, () => null);
    expect(Object.keys(rows[0])).not.toContain('security');
    expect(Object.keys(rows[0])).not.toContain('ci');
  });

  it("carries each repo's last push onto its own row, not another's (#572)", () => {
    // Different values per repo on purpose: one shared value would pass even if
    // the rollup handed every row the first descriptor's push.
    const rows = rollUpRepos(
      [
        descriptor({ full: 'acme/status', name: 'status', key: 'status', pushedAt: daysAgo(2) }),
        descriptor({ full: 'acme/acme', name: 'acme', key: 'acme', pushedAt: daysAgo(140) }),
      ],
      [],
      NOW,
      () => null,
    );
    // Sorted by full name: acme, then status.
    expect(rows.map((r) => r.pushedAt)).toEqual([daysAgo(140), daysAgo(2)]);
  });

  it('a repo that has never been pushed to carries a null last push (#572)', () => {
    const rows = rollUpRepos([descriptor({ pushedAt: null })], [], NOW, () => null);
    expect(rows[0].pushedAt).toBeNull();
  });

});
