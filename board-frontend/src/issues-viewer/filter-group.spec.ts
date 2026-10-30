import { describe, expect, it } from 'vitest';
import type { ViewerIssue } from './viewer-issue';
import {
  boardToken,
  DEFAULT_FILTERS,
  deriveCustomFields,
  filterIssues,
  groupIssues,
  NO_LABEL_KEY,
  NO_PROJECT_KEY,
  parseBoardToken,
  repoKey,
  REPO_REST_KEY,
  slug,
  titleFromSlug,
  type ViewerFilters,
} from './filter-group';

/** Minimal ViewerIssue fixture — `labels` given as plain names, lifted to the
 *  `{name,color}` shape the view-model carries. */
function mk(o: Partial<{ number: number; title: string; state: 'open' | 'closed'; type: ViewerIssue['type']; labels: string[]; assignees: string[]; projects: string[]; owner: string; repo: string; status: string; createdAt: string; closedAt: string; stateReason: ViewerIssue['stateReason']; aging: boolean; customFields: Record<string, string[]> }>): ViewerIssue {
  return {
    owner: o.owner,
    repo: o.repo ?? 'r',
    number: o.number ?? 1,
    title: o.title ?? 't',
    htmlUrl: 'u',
    state: o.state ?? 'open',
    assignees: o.assignees ?? [],
    labels: (o.labels ?? []).map((name) => ({ name, color: '' })),
    projects: o.projects ?? [],
    type: o.type ?? 'chore',
    status: o.status,
    createdAt: o.createdAt ?? '2026-07-01T00:00:00Z',
    closedAt: o.closedAt,
    stateReason: o.stateReason,
    aging: o.aging ?? false,
    customFields: o.customFields,
  };
}

const f = (partial: Partial<ViewerFilters>): ViewerFilters => ({ ...DEFAULT_FILTERS, ...partial });

describe('filterIssues (#376)', () => {
  it('ANDs across dimensions, ORs within a multi-select', () => {
    const items = [mk({ number: 1, labels: ['bug'], assignees: ['al'] }), mk({ number: 2, labels: ['feat'], assignees: ['bo'] })];
    expect(filterIssues(items, f({ labels: ['bug'], assignees: ['al'] })).map((i) => i.number)).toEqual([1]);
    // No overlap → AND yields nothing.
    expect(filterIssues(items, f({ labels: ['bug'], assignees: ['bo'] })).map((i) => i.number)).toEqual([]);
    // OR within the label multi-select.
    expect(filterIssues(items, f({ labels: ['bug', 'feat'] })).map((i) => i.number)).toEqual([1, 2]);
  });

  it('searches title and #number', () => {
    expect(filterIssues([mk({ number: 42, title: 'x' })], f({ q: '#42' })).length).toBe(1);
    expect(filterIssues([mk({ number: 7, title: 'Fix auth token' })], f({ q: 'AUTH' })).length).toBe(1);
    expect(filterIssues([mk({ number: 7, title: 'nope' })], f({ q: 'auth' })).length).toBe(0);
  });

  it('state:open drops closed; state:all keeps both', () => {
    const items = [mk({ number: 1, state: 'open' }), mk({ number: 2, state: 'closed' })];
    expect(filterIssues(items, f({ state: 'open' })).map((i) => i.number)).toEqual([1]);
    expect(filterIssues(items, f({ state: 'all' })).map((i) => i.number)).toEqual([1, 2]);
  });

  it('filters by project (OR within)', () => {
    const items = [mk({ number: 1, projects: ['A'] }), mk({ number: 2, projects: ['B'] })];
    expect(filterIssues(items, f({ projects: ['B'] })).map((i) => i.number)).toEqual([2]);
  });

  it('filters by repo (OR within) — the Repos map’s row link (#472)', () => {
    const items = [mk({ number: 1, repo: 'acme' }), mk({ number: 2, repo: 'board' }), mk({ number: 3, repo: 'roadmap' })];
    expect(filterIssues(items, f({ repos: ['board'] })).map((i) => i.number)).toEqual([2]);
    expect(filterIssues(items, f({ repos: ['board', 'roadmap'] })).map((i) => i.number)).toEqual([2, 3]);
    expect(filterIssues(items, f({ repos: [] })).map((i) => i.number)).toEqual([1, 2, 3]);
  });
});

describe('repoKey (#472)', () => {
  it('folds every form an issue carries onto the ingest’s short key', () => {
    // A queue row carries the short key already; a project board's item carries
    // `owner/name`; and the ingest strips the `.example.com` suffix.
    expect(repoKey('board')).toBe('board');
    expect(repoKey('acme/board')).toBe('board');
    expect(repoKey('board.example.com')).toBe('board');
    expect(repoKey('acme/Acme-UI')).toBe('acme-ui');
  });

  it('matches an issue whose repo is written the long way against a short filter key', () => {
    const items = [mk({ number: 1, repo: 'acme/board' }), mk({ number: 2, repo: 'acme' })];
    expect(filterIssues(items, f({ repos: ['board'] })).map((i) => i.number)).toEqual([1]);
  });
});

// #418 DoD at the predicate level: each dimension narrows to its matching subset
// and an empty selection is inactive (restores the full set). The identical
// narrow/restore contract is asserted through the render path in
// viewer-groups.spec.ts; the UI-reachability half lives in ui/command-menu.spec.ts.
describe('filterIssues — each dimension narrows, empty restores (#418)', () => {
  const now = Date.parse('2026-08-03T12:00:00Z');
  const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString();
  const set = [
    mk({ number: 1, type: 'bug', labels: ['ui'], assignees: ['al'], projects: ['GTM'], createdAt: daysAgo(2) }),
    mk({ number: 2, type: 'feature', labels: ['auth'], assignees: ['bo'], projects: ['Compliance'], createdAt: daysAgo(20) }),
    mk({ number: 3, type: 'chore', labels: ['ui'], assignees: ['al'], createdAt: daysAgo(30) }),
    mk({ number: 4, type: 'bug', labels: ['access'], assignees: ['bo'], state: 'closed', closedAt: daysAgo(1), createdAt: daysAgo(40) }),
  ];
  const nums = (partial: Partial<ViewerFilters>) => filterIssues(set, f({ state: 'all', ...partial }), now).map((i) => i.number);
  const FULL = [1, 2, 3, 4];

  it.each([
    ['assignee', { assignees: ['al'] } as Partial<ViewerFilters>, [1, 3]],
    ['label', { labels: ['ui'] }, [1, 3]],
    ['type', { types: ['bug'] as ViewerFilters['types'] }, [1, 4]],
    ['project', { projects: ['GTM'] }, [1]],
    ['timeframe', { timeframe: 'opened-week' as ViewerFilters['timeframe'] }, [1]],
  ])('%s narrows to its subset, then an empty selection restores all', (_dim, active, expected) => {
    expect(nums(active)).toEqual(expected);
    // Clearing that one dimension (back to the default empty/any) restores the set.
    const cleared = Object.fromEntries(Object.keys(active).map((k) => [k, k === 'timeframe' ? 'any' : []]));
    expect(nums(cleared as Partial<ViewerFilters>)).toEqual(FULL);
  });

  it('state Open drops the closed row; All restores it', () => {
    expect(filterIssues(set, f({ state: 'open' }), now).map((i) => i.number)).toEqual([1, 2, 3]);
    expect(filterIssues(set, f({ state: 'all' }), now).map((i) => i.number)).toEqual(FULL);
  });
});

describe('groupIssues (#376)', () => {
  it('group-by-label duplicates an issue across each of its labels', () => {
    const g = groupIssues([mk({ number: 1, labels: ['a', 'b'] })], 'label');
    expect(g.map((x) => x.key).sort()).toEqual(['a', 'b']);
  });

  // #1099's last ruling: the Label grouping is about ordinary labels, and the
  // `triage:*` labels have Size, Priority and Route of their own. What made
  // hiding them look impossible was an issue wearing ONLY triage labels, which
  // `groupByMulti` would then file under nothing. The trailing stack is the
  // whole condition of the ruling, so the first spec below is the one that goes
  // red without it.
  it('group-by-label stacks an issue wearing only triage labels under "No label", last, rather than losing it', () => {
    const g = groupIssues(
      [mk({ number: 1, labels: ['bug', 'triage:P0'] }), mk({ number: 2, labels: ['triage:XS', 'triage:P1'] })],
      'label',
    );
    expect(g.map((x) => x.key)).toEqual(['bug', NO_LABEL_KEY]);
    expect(g[1].label).toBe('No label');
    expect(g[1].items.map((i) => i.number)).toEqual([2]);
    // No issue leaves the grouping.
    expect(new Set(g.flatMap((x) => x.items.map((i) => i.number)))).toEqual(new Set([1, 2]));
  });

  it('group-by-label draws no triage stack, whichever shape or spelling the label takes', () => {
    const g = groupIssues(
      [mk({ number: 1, labels: ['ui', 'triage:P0', 'Triage:xs', 'triage:effort:3', 'triage:tech_debt:x', 'triage:XXL'] })],
      'label',
    );
    expect(g.map((x) => x.key)).toEqual(['ui']);
  });

  it('group-by-label stacks an issue with no label at all under "No label" too', () => {
    const g = groupIssues([mk({ number: 1, labels: ['bug'] }), mk({ number: 2, labels: [] })], 'label');
    expect(g.map((x) => x.key)).toEqual(['bug', NO_LABEL_KEY]);
    expect(g[1].items.map((i) => i.number)).toEqual([2]);
  });

  it('group-by-label keeps "No label" last even when it is the fullest stack', () => {
    const g = groupIssues(
      [mk({ number: 1, labels: ['bug'] }), mk({ number: 2, labels: ['triage:S'] }), mk({ number: 3 }), mk({ number: 4 })],
      'label',
    );
    expect(g.map((x) => x.key)).toEqual(['bug', NO_LABEL_KEY]);
    expect(g[1].items.map((i) => i.number)).toEqual([2, 3, 4]);
  });

  it('group-by-label draws no "No label" stack when every issue carries an ordinary label', () => {
    const g = groupIssues([mk({ number: 1, labels: ['bug', 'triage:P0'] }), mk({ number: 2, labels: ['ui'] })], 'label');
    expect(g.map((x) => x.key)).toEqual(['bug', 'ui']);
  });

  it('group-by-label draws a label literally named "No label" as its own stack beside the trailing one', () => {
    const g = groupIssues([mk({ number: 1, labels: ['No label'] }), mk({ number: 2, labels: ['triage:S'] })], 'label');
    expect(g.map((x) => x.key)).toEqual(['No label', NO_LABEL_KEY]);
    expect(g.map((x) => x.label)).toEqual(['No label', 'No label']);
    expect(g[0].items.map((i) => i.number)).toEqual([1]);
    expect(g[1].items.map((i) => i.number)).toEqual([2]);
  });

  it('group-by-label asks the parser what a triage label is, so a bare prefix stays where the parser leaves it', () => {
    // `triage:` names no property, so no triage grouping shows it; the Label
    // grouping is the one place it can still be seen.
    const g = groupIssues([mk({ number: 1, labels: ['triage:'] })], 'label');
    expect(g.map((x) => x.key)).toEqual(['triage:']);
  });

  it('group-by-type orders and labels the taxonomy, dropping empty groups', () => {
    const g = groupIssues([mk({ number: 1, type: 'bug' }), mk({ number: 2, type: 'feature' })], 'type');
    expect(g.map((x) => x.key)).toEqual(['bug', 'feature']);
    expect(g[0].label).toBe('Bugs');
  });

  it('group-by-status only yields groups for items that carry a status', () => {
    const g = groupIssues([mk({ number: 1, status: 'In Progress' }), mk({ number: 2 })], 'status');
    expect(g.map((x) => x.key)).toEqual(['In Progress']);
  });

  // #776. An issue on no board used to be filed under nothing and vanish from
  // the render — with `visibleCount` summing the rendered rows, the header then
  // counted what was left. On the reporter's queue that was 8 of 102.
  it('group-by-project stacks issues on no board last, under "No project"', () => {
    const g = groupIssues([mk({ number: 1, projects: ['P'] }), mk({ number: 2, projects: [] })], 'project');
    expect(g.map((x) => x.key)).toEqual(['P', NO_PROJECT_KEY]);
    expect(g[0].items.map((i) => i.number)).toEqual([1]);
    expect(g[1].label).toBe('No project');
    expect(g[1].items.map((i) => i.number)).toEqual([2]);
  });

  it('group-by-project keeps "No project" last even when it is the fullest stack', () => {
    const g = groupIssues(
      [mk({ number: 1, projects: ['P'] }), mk({ number: 2 }), mk({ number: 3 }), mk({ number: 4 })],
      'project',
    );
    expect(g.map((x) => x.key)).toEqual(['P', NO_PROJECT_KEY]);
    expect(g[1].items.map((i) => i.number)).toEqual([2, 3, 4]);
  });

  it('group-by-project draws no "No project" stack when every issue is on a board', () => {
    const g = groupIssues([mk({ number: 1, projects: ['P'] }), mk({ number: 2, projects: ['Q'] })], 'project');
    expect(g.map((x) => x.key)).toEqual(['P', 'Q']);
  });

  // #415: the queue's "Group by Project" produced no/one group in practice.
  // The pure grouping core here was already correct (root cause was a fixture
  // data-availability gap upstream — see board-service's
  // issues-metrics.service.spec.ts) — this locks in the shape that gap hid: an
  // issue on several boards duplicates into each group.
  it('group-by-project duplicates a multi-project issue into each of its boards, real per-project groups', () => {
    const g = groupIssues(
      [
        mk({ number: 1, projects: ['GTM'] }),
        mk({ number: 2, projects: ['GTM', 'Compliance'] }),
        mk({ number: 3, projects: ['Compliance'] }),
        mk({ number: 4, projects: [] }),
      ],
      'project',
    );
    // Both boards have 2 items — a tie, broken alphabetically (byCountThenKey).
    // #4 is on neither, so it stacks last rather than being dropped (#776).
    expect(g.map((x) => x.key)).toEqual(['Compliance', 'GTM', NO_PROJECT_KEY]);
    expect(g.find((x) => x.key === 'GTM')!.items.map((i) => i.number)).toEqual([1, 2]);
    expect(g.find((x) => x.key === 'Compliance')!.items.map((i) => i.number)).toEqual([2, 3]);
    expect(g.find((x) => x.key === NO_PROJECT_KEY)!.items.map((i) => i.number)).toEqual([4]);
  });

  it('group-by-openclosed splits into Open then Closed, dropping an empty side', () => {
    const items = [mk({ number: 1, state: 'open' }), mk({ number: 2, state: 'closed' }), mk({ number: 3, state: 'open' })];
    const g = groupIssues(items, 'openclosed');
    expect(g.map((x) => [x.key, x.label])).toEqual([['open', 'Open'], ['closed', 'Closed']]);
    expect(g[0].items.map((i) => i.number)).toEqual([1, 3]);
    // No closed issues → only the Open group.
    expect(groupIssues([mk({ number: 4, state: 'open' })], 'openclosed').map((x) => x.key)).toEqual(['open']);
  });
});

// #661. The seventh dimension. Its key is `repoKey`, which is what makes a
// group's key the same token the repo FILTER and a `?repo=` link use — so the
// two halves of the dimension cannot drift apart. The fixture deliberately
// gives the three repos DIFFERENT counts (3 / 2 / 2), or the fullest-first
// order would be indistinguishable from any other order.
describe('groupIssues — repo (#661)', () => {
  // The fullest repo is deliberately the alphabetically LAST one, so the
  // expected order is one a plain by-key sort could not produce.
  const spread = [
    mk({ number: 1, repo: 'acme/acme-ui' }),
    mk({ number: 2, repo: 'acme-ui' }),
    mk({ number: 3, repo: 'acme/Acme-UI' }),
    mk({ number: 4, repo: 'acme/board' }),
    mk({ number: 5, repo: 'board' }),
    mk({ number: 6, repo: 'docs' }),
    mk({ number: 7, repo: 'acme/docs' }),
  ];

  it('folds owner/name, a differently-cased owner/name and the short key into one group', () => {
    const g = groupIssues(spread, 'repo');
    expect(g.find((x) => x.key === 'acme-ui')!.items.map((i) => i.number)).toEqual([1, 2, 3]);
    // The key IS the short key — no group is ever named by a raw `owner/name`.
    expect(g.map((x) => x.key)).toEqual(g.map((x) => repoKey(x.key)));
    expect(g.find((x) => x.key === 'acme-ui')!.label).toBe('acme-ui');
    // ...and the `.example.com` suffix folds too: #4 and #5 are one repo.
    expect(g.find((x) => x.key === 'board')!.items.map((i) => i.number)).toEqual([4, 5]);
  });

  it('orders fullest repository first, ties broken by key', () => {
    const g = groupIssues(spread, 'repo');
    expect(g.map((x) => x.key)).toEqual(['acme-ui', 'board', 'docs']);
    expect(g.map((x) => x.items.length)).toEqual([3, 2, 2]);
  });

  it('puts each issue in exactly one group — a repo is single-valued', () => {
    const g = groupIssues(spread, 'repo');
    expect(g.reduce((n, x) => n + x.items.length, 0)).toBe(spread.length);
  });

  it('names every repository while they fit — no catch-all appears early', () => {
    // Five repos is far under the limit: five named groups, no trailing stack.
    const g = groupIssues(
      ['a', 'b', 'c', 'd', 'e'].map((r, n) => mk({ number: n + 1, repo: r })),
      'repo',
    );
    expect(g.map((x) => x.key)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(g.some((x) => x.key === REPO_REST_KEY)).toBe(false);
  });

  // The limit is 12. `wide(n)` builds n repos with DESCENDING issue counts, so
  // which repos survive the fold is decided by count and is not an artefact of
  // insertion or alphabetical order: repo `r00` has the most, `r{n-1}` the least.
  const wide = (n: number) =>
    Array.from({ length: n }, (_, r) =>
      Array.from({ length: n - r }, (_, k) => mk({ number: r * 100 + k, repo: `r${String(r).padStart(2, '0')}` })),
    ).flat();

  it('names 13 repositories rather than folding a single one into a stack of one', () => {
    // 13 repos = limit + 1. Folding here would trade one named column for a
    // trailing stack holding exactly one repo, which is strictly worse.
    const g = groupIssues(wide(13), 'repo');
    expect(g).toHaveLength(13);
    expect(g.some((x) => x.key === REPO_REST_KEY)).toBe(false);
  });

  it('folds everything past the 12 fullest into one trailing stack', () => {
    const g = groupIssues(wide(20), 'repo');
    expect(g).toHaveLength(13);
    // The 12 named ones are the 12 FULLEST, in that order.
    expect(g.slice(0, 12).map((x) => x.key)).toEqual(
      Array.from({ length: 12 }, (_, r) => `r${String(r).padStart(2, '0')}`),
    );
    const rest = g[12];
    expect(rest.key).toBe(REPO_REST_KEY);
    expect(rest.label).toBe('8 smaller repos');
    // r12..r19 hold 8+7+…+1 = 36 issues, and every one of them survives the fold.
    expect(rest.items).toHaveLength(36);
  });

  it('loses no issue to the fold, and no issue to both sides of it', () => {
    const all = wide(20);
    const g = groupIssues(all, 'repo');
    expect(g.reduce((n, x) => n + x.items.length, 0)).toBe(all.length);
    expect(new Set(g.flatMap((x) => x.items.map((i) => i.number))).size).toBe(all.length);
  });

  it('keeps the trailing stack clustered by repository, fullest first', () => {
    // The card names no repo, so adjacency is the only attribution the stack has.
    const rest = groupIssues(wide(20), 'repo').find((x) => x.key === REPO_REST_KEY)!;
    const order = rest.items.map((i) => i.repo);
    expect([...new Set(order)]).toEqual(order.filter((r, k) => order.indexOf(r) === k));
    expect([...new Set(order)]).toEqual(
      Array.from({ length: 8 }, (_, r) => `r${String(r + 12).padStart(2, '0')}`),
    );
  });

  it('never collides the trailing key with a real repository', () => {
    // `repoKey` drops everything before the last `/`, so it can never return a
    // key containing one — which is what makes REPO_REST_KEY safe.
    expect(repoKey(REPO_REST_KEY)).not.toBe(REPO_REST_KEY);
    expect(REPO_REST_KEY).toContain('/');
  });
});

describe('slug / titleFromSlug (#401)', () => {
  it('slug + titleFromSlug', () => {
    expect(slug('Story Points')).toBe('story-points');
    expect(titleFromSlug('story-points')).toBe('Story Points');
  });
});

describe('filterIssues — custom fields / types / timeframe (#401)', () => {
  it('filters by a custom field value (intersection); an issue lacking the field is excluded', () => {
    const a = mk({ number: 1, customFields: { priority: ['High'] } });
    const b = mk({ number: 2, customFields: { priority: ['Low'] } });
    const c = mk({ number: 3 }); // no priority field
    const filters = f({ customFields: { priority: ['High'] } });
    expect(filterIssues([a, b, c], filters).map((i) => i.number)).toEqual([1]);
  });

  it('timeframe opened-week boundary', () => {
    const now = Date.now();
    const opened = mk({ number: 1, createdAt: new Date(now - 2 * 86_400_000).toISOString() });
    const old = mk({ number: 2, createdAt: new Date(now - 20 * 86_400_000).toISOString() });
    expect(
      filterIssues([opened, old], f({ timeframe: 'opened-week', state: 'all' }), now).map((i) => i.number),
    ).toEqual([1]);
  });

  it('filters by type', () => {
    const bug = mk({ number: 1, type: 'bug' });
    const feat = mk({ number: 2, type: 'feature' });
    expect(filterIssues([bug, feat], f({ types: ['bug'] })).map((i) => i.number)).toEqual([1]);
  });

  it('closed-week matches an issue closed within 7 days, even under the default open state (#407)', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    const closedRecent = mk({ number: 1, state: 'closed', closedAt: '2026-08-01T00:00:00.000Z' });
    expect(filterIssues([closedRecent], f({ timeframe: 'closed-week' }), now)).toHaveLength(1); // state stays 'open'
  });

  it('closed-week rejects open issues and stale closes (#407)', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    const open = mk({ number: 2, state: 'open' });
    const closedOld = mk({ number: 3, state: 'closed', closedAt: '2026-07-20T00:00:00.000Z' });
    expect(filterIssues([open, closedOld], f({ timeframe: 'closed-week' }), now)).toHaveLength(0);
  });

  it('closed-week composes with assignee (#407)', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    const mine = mk({ number: 4, state: 'closed', closedAt: '2026-08-02T00:00:00.000Z', assignees: ['octocat'] });
    const other = mk({ number: 5, state: 'closed', closedAt: '2026-08-02T00:00:00.000Z', assignees: ['x'] });
    const got = filterIssues([mine, other], f({ timeframe: 'closed-week', assignees: ['octocat'] }), now);
    expect(got.map((i) => i.number)).toEqual([4]);
  });

  // #478: the aging window reads board-api's per-row verdict rather than working
  // an age out here. The two rows below are the same age on purpose — an age-based
  // filter would keep both, and the Oldest-open block one section up would then
  // report a different number than the queue for what looks like the same set.
  it('aging keeps the flagged rows and drops the rest, however old they look', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    const created = '2026-05-01T00:00:00.000Z'; // ~94 days — old by any reading
    const flagged = mk({ number: 1, createdAt: created, aging: true });
    const steady = mk({ number: 2, createdAt: created, aging: false }); // long-lived → never aging
    const young = mk({ number: 3, createdAt: '2026-08-01T00:00:00.000Z' });
    expect(filterIssues([flagged, steady, young], f({ timeframe: 'aging' }), now).map((i) => i.number)).toEqual([1]);
  });

  it('aging composes with the other dimensions and stays open-only', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    const mine = mk({ number: 1, aging: true, assignees: ['octocat'] });
    const theirs = mk({ number: 2, aging: true, assignees: ['x'] });
    const closed = mk({ number: 3, aging: true, assignees: ['octocat'], state: 'closed', closedAt: '2026-08-02T00:00:00.000Z' });
    const got = filterIssues([mine, theirs, closed], f({ timeframe: 'aging', assignees: ['octocat'] }), now);
    expect(got.map((i) => i.number)).toEqual([1]);
  });

  it('a row from a board-api that predates the flag is simply not aging', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z');
    const legacy = { ...mk({ number: 1, createdAt: '2026-01-01T00:00:00.000Z' }), aging: undefined };
    expect(filterIssues([legacy], f({ timeframe: 'aging' }), now)).toHaveLength(0);
  });
});

describe('deriveCustomFields (#401)', () => {
  it('unions values with counts, sorted count-desc then name', () => {
    const facets = deriveCustomFields([
      mk({ number: 1, customFields: { priority: ['High'] } }),
      mk({ number: 2, customFields: { priority: ['High'] } }),
      mk({ number: 3, customFields: { priority: ['Low'] } }),
    ]);
    expect(facets).toEqual([
      {
        slug: 'priority',
        name: 'Priority',
        values: [
          { name: 'High', count: 2 },
          { name: 'Low', count: 1 },
        ],
      },
    ]);
  });

  it('omits the status facet even when issues carry customFields.status', () => {
    // Status is the board's dedicated column/grouping dimension (ViewerIssue.status);
    // it must not also surface as a duplicate custom-field filter facet.
    const facets = deriveCustomFields([
      mk({ number: 1, customFields: { status: ['Done'], priority: ['High'] } }),
    ]);
    expect(facets.map((c) => c.slug)).toEqual(['priority']);
  });
});

describe('the unassigned filter (#462)', () => {
  it('keeps only issues nobody is assigned to', () => {
    const items = [
      mk({ number: 1, assignees: [] }),
      mk({ number: 2, assignees: ['al'] }),
      mk({ number: 3, assignees: [] }),
    ];
    expect(filterIssues(items, f({ unassigned: true })).map((i) => i.number)).toEqual([1, 3]);
  });

  it('is inactive when off — every issue survives it', () => {
    const items = [mk({ number: 1, assignees: [] }), mk({ number: 2, assignees: ['al'] })];
    expect(filterIssues(items, f({ unassigned: false })).map((i) => i.number)).toEqual([1, 2]);
  });

  it('ANDs with the other dimensions like every filter does', () => {
    const items = [
      mk({ number: 1, assignees: [], type: 'bug' }),
      mk({ number: 2, assignees: [], type: 'chore' }),
      mk({ number: 3, assignees: ['al'], type: 'bug' }),
    ];
    expect(filterIssues(items, f({ unassigned: true, types: ['bug'] })).map((i) => i.number)).toEqual([1]);
  });
});

/**
 * #782 — the project dimension matched a board NAME, and two orgs can each hold
 * a board called "Roadmap". Pressing one board's ring narrowed the queue to
 * both.
 *
 * `filters.boards` is the qualifier: a `<org>/<number>/<name>` token says WHICH
 * board of that name was meant, and a row is kept only if its own org is the
 * one that was named. A name the filter carries no address for matches exactly
 * as it always did, so the FilterBar's chip — which writes a name and knows no
 * address — is untouched.
 */
describe('a board address narrows the project filter to one board (#782)', () => {
  const onHub = mk({ number: 1, owner: 'acme', projects: ['Roadmap'] });
  const onGlobex = mk({ number: 2, owner: 'globex', projects: ['Roadmap'] });
  const nums = (f2: Partial<ViewerFilters>) => filterIssues([onHub, onGlobex], f(f2)).map((i) => i.number);

  it('matches on the name alone when no address qualifies it', () => {
    expect(nums({ projects: ['Roadmap'] })).toEqual([1, 2]);
  });

  it('keeps only the org whose board was named', () => {
    expect(nums({ projects: ['Roadmap'], boards: ['acme/3/Roadmap'] })).toEqual([1]);
    expect(nums({ projects: ['Roadmap'], boards: ['globex/5/Roadmap'] })).toEqual([2]);
  });

  it('unions two addresses wearing one name — both rings pressed is both boards', () => {
    expect(nums({ projects: ['Roadmap'], boards: ['acme/3/Roadmap', 'globex/5/Roadmap'] })).toEqual([1, 2]);
  });

  it('leaves a row whose org nothing said in, rather than hiding work', () => {
    // A board item carries no owner, and neither does a queue row from a
    // board-api that predates the field. Excluding it would be this filter
    // hiding an issue on the strength of something it was never told.
    const unowned = mk({ number: 3, projects: ['Roadmap'] });
    expect(filterIssues([unowned], f({ projects: ['Roadmap'], boards: ['acme/3/Roadmap'] }))).toHaveLength(1);
  });

  it('ignores an address for a name the filter does not carry', () => {
    // A stale `?board=` left behind when the chip dropped its name qualifies
    // nothing, and must not narrow the name that IS selected.
    expect(nums({ projects: ['Roadmap'], boards: ['acme/9/Onboarding'] })).toEqual([1, 2]);
  });

  it('qualifies only the name it names, leaving a second selected board alone', () => {
    const onOther = mk({ number: 4, owner: 'globex', projects: ['Onboarding'] });
    const kept = filterIssues(
      [onHub, onGlobex, onOther],
      f({ projects: ['Roadmap', 'Onboarding'], boards: ['acme/3/Roadmap'] }),
    );
    expect(kept.map((i) => i.number)).toEqual([1, 4]);
  });
});

describe('parseBoardToken (#782)', () => {
  it('reads org, number and the whole rest as the name', () => {
    expect(parseBoardToken('acme/3/Roadmap')).toEqual({ org: 'acme', number: 3, name: 'Roadmap' });
    expect(parseBoardToken('acme/3/Q3/Q4 push')).toEqual({ org: 'acme', number: 3, name: 'Q3/Q4 push' });
  });

  it('refuses anything that is not one', () => {
    expect(parseBoardToken('Roadmap')).toBeNull();
    expect(parseBoardToken('acme/3/')).toBeNull();
    expect(parseBoardToken('acme/x/Roadmap')).toBeNull();
    expect(parseBoardToken('/3/Roadmap')).toBeNull();
    expect(parseBoardToken('')).toBeNull();
  });

  it('round-trips a board through the token it writes', () => {
    expect(parseBoardToken(boardToken({ org: 'globex', number: 12, name: 'Growth, later' })!)).toEqual({
      org: 'globex', number: 12, name: 'Growth, later',
    });
  });

  it('writes no token for a board that named no org — there is no address to write', () => {
    expect(boardToken({ number: 3, name: 'Roadmap' })).toBeNull();
  });
});

describe('closed yesterday UTC (#913)', () => {
  it('uses a half-open calendar day independently of the open-state default', () => {
    const rows = [
      mk({ number: 1, state: 'closed', closedAt: '2026-09-07T00:00:00Z' }),
      mk({ number: 2, state: 'closed', closedAt: '2026-09-07T23:59:59Z' }),
      mk({ number: 3, state: 'closed', closedAt: '2026-09-08T00:00:00Z' }),
      mk({ number: 4, state: 'closed', closedAt: '2026-09-06T23:59:59Z' }),
    ];
    expect(filterIssues(rows, { ...DEFAULT_FILTERS, timeframe: 'closed-yesterday' }, Date.parse('2026-09-08T23:59:00Z')).map((i) => i.number)).toEqual([1, 2]);
  });
});

describe('the two client-side close windows count delivered closes only (#1014)', () => {
  // These windows are the one place the frontend decides what a close is. The
  // tile they drill in behind is counted by board-api, which stopped counting an
  // abandoned close, so a row that survives here and not there is the list
  // contradicting the figure it was opened from.
  const NOW = Date.parse('2026-09-08T23:59:00Z');
  const YESTERDAY = '2026-09-07T12:00:00Z';
  const window = (rows: ViewerIssue[], timeframe: 'closed-yesterday' | 'closed-week') =>
    filterIssues(rows, f({ timeframe }), NOW).map((i) => i.number);

  const rows = [
    mk({ number: 1, state: 'closed', closedAt: YESTERDAY, stateReason: 'completed' }),
    mk({ number: 2, state: 'closed', closedAt: YESTERDAY, stateReason: null }),
    mk({ number: 3, state: 'closed', closedAt: YESTERDAY }),
    mk({ number: 4, state: 'closed', closedAt: YESTERDAY, stateReason: 'not_planned' }),
    mk({ number: 5, state: 'closed', closedAt: YESTERDAY, stateReason: 'duplicate' }),
  ];

  it('drops a not-planned close and a duplicate from closed-yesterday', () => {
    expect(window(rows, 'closed-yesterday')).toEqual([1, 2, 3]);
  });

  it('drops them from closed-week too, which is a different branch of the same rule', () => {
    expect(window(rows, 'closed-week')).toEqual([1, 2, 3]);
  });

  it('keeps a close whose reason is null, and one carrying no reason at all', () => {
    // Rows 2 and 3 above, said plainly: unknown counts and absent counts. A
    // board-api predating the field sends nothing, and this is the whole of what
    // stands between that reader and a queue that appears to have closed less.
    const unknown = [rows[1]!, rows[2]!];
    expect(window(unknown, 'closed-yesterday')).toEqual([2, 3]);
    expect(window(unknown, 'closed-week')).toEqual([2, 3]);
  });
});

it('filters yesterday using the viewing person’s calendar boundary', () => {
  const rows = [mk({ number: 1, state: 'closed', closedAt: '2026-09-25T22:30:00Z' })];
  const now = Date.parse('2026-09-26T12:00:00Z');
  const filters = { ...DEFAULT_FILTERS, timeframe: 'closed-yesterday' as const };
  expect(filterIssues(rows, filters, now, 'Europe/Berlin')).toEqual([]);
  expect(filterIssues(rows, filters, now, 'America/Los_Angeles')).toHaveLength(1);
});
