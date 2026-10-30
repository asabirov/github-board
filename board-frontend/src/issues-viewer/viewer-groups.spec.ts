import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, type GroupDim, NO_LABEL_KEY, NO_PROJECT_KEY, noTriageKey, type ViewerFilters } from './filter-group';
import { CATCH_ALL, triageDim } from './triage-labels';
import type { ViewerIssue } from './viewer-issue';
import { availableGroupDims, resolveGroupDim, viewerGroups, visibleCount } from './viewer-groups';
import { initViewer } from './use-viewer-state';
import { decodeViewer } from './viewer-url';

function mk(o: Partial<{ number: number; repo: string; state: 'open' | 'closed'; status: string; type: ViewerIssue['type']; labels: string[]; assignees: string[]; projects: string[]; parent: number; closedAt: string; createdAt: string; aging: boolean }>): ViewerIssue {
  return {
    repo: o.repo ?? 'r',
    number: o.number ?? 1,
    title: `t${o.number ?? 1}`,
    htmlUrl: `https://github.com/fixture/${o.repo ?? 'r'}/issues/${o.number ?? 1}`,
    state: o.state ?? 'open',
    assignees: o.assignees ?? [],
    labels: (o.labels ?? []).map((name) => ({ name, color: '' })),
    projects: o.projects ?? [],
    type: o.type ?? 'chore',
    status: o.status,
    createdAt: o.createdAt ?? '2026-07-01T00:00:00Z',
    closedAt: o.closedAt,
    aging: o.aging ?? false,
    parent: o.parent,
  };
}

const f = (partial: Partial<ViewerFilters>): ViewerFilters => ({ ...DEFAULT_FILTERS, ...partial });

const board: ViewerIssue[] = [
  mk({ number: 1, status: 'Backlog', labels: ['ui'], assignees: ['al'] }),
  mk({ number: 2, status: 'In progress', labels: ['auth'], assignees: ['bo'] }),
  mk({ number: 3, status: 'In review', labels: ['ui'] }),
  mk({ number: 4, status: 'Done', state: 'closed', labels: ['access'] }),
];

describe('viewerGroups — status (the Project home default) (#376)', () => {
  it('renders the workflow-ordered columns with tones', () => {
    const g = viewerGroups(board, { group: 'status', filters: f({}) });
    expect(g.map((x) => x.key)).toEqual(['Backlog', 'In progress', 'In review', 'Done']);
    expect(g.map((x) => x.tone)).toEqual(['neutral', 'warning', 'brand', 'success']);
  });

  it('keeps a terminal column populated under the Open filter (Done shows its closed item)', () => {
    const g = viewerGroups(board, { group: 'status', filters: f({ state: 'open' }) });
    const done = g.find((x) => x.key === 'Done')!;
    expect(done.rows.map((r) => r.item.number)).toEqual([4]);
  });

  it('keeps the full column set stable when a filter narrows (empty columns survive)', () => {
    const g = viewerGroups(board, { group: 'status', filters: f({ labels: ['ui'] }) });
    // All four columns remain; only #1 and #3 (label ui) have rows.
    expect(g.map((x) => x.key)).toEqual(['Backlog', 'In progress', 'In review', 'Done']);
    expect(visibleCount(g)).toBe(2);
    expect(g.find((x) => x.key === 'In progress')!.rows).toEqual([]);
  });
});

describe('viewerGroups — switching the group dimension re-groups (#376)', () => {
  it('groups by assignee', () => {
    const g = viewerGroups(board, { group: 'assignee', filters: f({ state: 'all' }) });
    expect(g.map((x) => x.key).sort()).toEqual(['al', 'bo']);
  });

  it('groups by label, duplicating a multi-label issue', () => {
    const g = viewerGroups(board, { group: 'label', filters: f({ state: 'all' }) });
    expect(g.map((x) => x.key).sort()).toEqual(['access', 'auth', 'ui']);
    expect(g.find((x) => x.key === 'ui')!.rows.map((r) => r.item.number).sort()).toEqual([1, 3]);
  });
});

describe('viewerGroups — project stacking (the retired IssueQueue #379 behaviour)', () => {
  const projected: ViewerIssue[] = [
    mk({ number: 1, projects: ['Go-To-Market'] }),
    mk({ number: 2, projects: [] }),
    mk({ number: 3, projects: ['Go-To-Market', 'Compliance'] }),
  ];

  it('stacks an issue on no project last, after the boards, fullest first (#776)', () => {
    const g = viewerGroups(projected, { group: 'project', filters: f({ state: 'all' }) });
    // Fullest-first: Go-To-Market (2) before Compliance (1); #2 (unattached) last.
    expect(g.map((x) => x.key)).toEqual(['Go-To-Market', 'Compliance', NO_PROJECT_KEY]);
    expect(g.find((x) => x.key === 'Go-To-Market')!.rows.map((r) => r.item.number)).toEqual([1, 3]);
    expect(g.find((x) => x.key === 'Compliance')!.rows.map((r) => r.item.number)).toEqual([3]);
    expect(g.find((x) => x.key === NO_PROJECT_KEY)!.rows.map((r) => r.item.number)).toEqual([2]);
  });

  // The count under the heading is `visibleCount` over these groups, so this is
  // the assertion that the header stops disagreeing with the queue it labels.
  it('counts every issue, on a board or not (#776)', () => {
    const g = viewerGroups(projected, { group: 'project', filters: f({ state: 'all' }) });
    // #3 is on two boards and so is drawn twice; every issue is reachable.
    expect(new Set(g.flatMap((x) => x.rows.map((r) => r.item.number)))).toEqual(new Set([1, 2, 3]));
  });

  it('renders one "No project" column when every issue is unattached', () => {
    const g = viewerGroups([mk({ number: 1 }), mk({ number: 2 })], { group: 'project', filters: f({ state: 'all' }) });
    expect(g.map((x) => x.key)).toEqual([NO_PROJECT_KEY]);
    expect(g[0].rows.map((r) => r.item.number)).toEqual([1, 2]);
  });
});

describe('viewerGroups — nesting + empty state (#376)', () => {
  it('nests a sub-issue under its parent in the same group', () => {
    const items = [mk({ number: 10, status: 'Backlog' }), mk({ number: 11, status: 'Backlog', parent: 10 })];
    const g = viewerGroups(items, { group: 'status', filters: f({}) });
    const rows = g.find((x) => x.key === 'Backlog')!.rows;
    expect(rows.map((r) => [r.item.number, r.depth])).toEqual([[10, 0], [11, 1]]);
  });

  it('a search that matches nothing yields zero visible rows (→ empty state)', () => {
    const g = viewerGroups(board, { group: 'status', filters: f({ q: 'zzz-no-match' }) });
    expect(visibleCount(g)).toBe(0);
  });
});

describe('viewerGroups — openclosed (the simplified Project home) (#376)', () => {
  it('splits into Open then Closed, ignoring the Open/All filter (grouping IS the split)', () => {
    const g = viewerGroups(board, { group: 'openclosed', filters: f({ state: 'open' }) });
    expect(g.map((x) => x.key)).toEqual(['open', 'closed']);
    expect(g.map((x) => x.label)).toEqual(['Open', 'Closed']);
    expect(g.find((x) => x.key === 'open')!.rows.map((r) => r.item.number)).toEqual([1, 2, 3]);
    expect(g.find((x) => x.key === 'closed')!.rows.map((r) => r.item.number)).toEqual([4]);
  });

  it('still narrows by search/label within each lifecycle group', () => {
    const g = viewerGroups(board, { group: 'openclosed', filters: f({ labels: ['ui'] }) });
    // Only #1 (open, ui) and #3 (open, ui) remain → one Open group, no Closed.
    expect(g.map((x) => x.key)).toEqual(['open']);
    expect(visibleCount(g)).toBe(2);
  });
});

describe('availableGroupDims (#376)', () => {
  it('offers status + openclosed on a board (items carry a Status field), hides project (single board)', () => {
    expect(availableGroupDims(board)).toEqual(['status', 'openclosed', 'type', 'assignee', 'label']);
  });

  it('hides status when no item carries one; openclosed always applies', () => {
    expect(availableGroupDims([mk({ number: 1 })])).toEqual(['openclosed', 'type', 'assignee', 'label']);
  });
});

// #727. The grouping the viewer actually renders, lifted out of the component so
// it can be checked at all — the suite has no DOM, so an inline ternary in JSX is
// unreachable from a test. A host names the groupings it leads with, best first,
// and the first one this data supports wins.
describe('resolveGroupDim (#727)', () => {
  const withProjects = [mk({ number: 1, projects: ['P'] }), mk({ number: 2, projects: ['Q'] })];
  const withoutProjects = [mk({ number: 1 }), mk({ number: 2 })];

  it('keeps the current grouping whenever the data offers it', () => {
    expect(resolveGroupDim('label', availableGroupDims(withProjects), ['project', 'type'])).toBe('label');
  });

  it('leads with the first entry the data supports — the two queues open on project', () => {
    expect(resolveGroupDim('project', availableGroupDims(withProjects), ['project', 'type'])).toBe('project');
  });

  it('falls to the NEXT entry on a queue whose issues carry no project — `type`, the '
    + 'grouping those queues showed before, and never whichever dimension sorts first', () => {
    const dims = availableGroupDims(withoutProjects);
    expect(dims[0]).toBe('openclosed');
    expect(resolveGroupDim('project', dims, ['project', 'type'])).toBe('type');
  });

  it('takes a single dimension as a list of one', () => {
    expect(resolveGroupDim('project', availableGroupDims(withoutProjects), 'type')).toBe('type');
  });

  it('falls to the first available dimension when the data supports nothing the host named', () => {
    expect(resolveGroupDim('project', availableGroupDims(withoutProjects), ['project', 'status'])).toBe('openclosed');
  });

  it('falls to the first available dimension when the host named none at all (unchanged)', () => {
    expect(resolveGroupDim('status', availableGroupDims(withoutProjects))).toBe('openclosed');
  });

  it('opens the two queues on project and remembers a pick, end to end — the URL, the '
    + 'stored arrangement and the data all go through the same two functions the '
    + 'viewer uses', () => {
    const lead = ['project', 'type'] as const;
    const dims = availableGroupDims(withProjects);
    const open = (search: string, stored: { group?: 'label' } | null = null) =>
      resolveGroupDim(initViewer(search, undefined, stored, lead[0]).group, dims, lead);

    expect(open('')).toBe('project');
    expect(open('?label=bug')).toBe('project');
    expect(open('?group=label')).toBe('label');
    expect(open('', { group: 'label' })).toBe('label');
    expect(open('', null)).toBe('project');
  });
});

// #661. The render path for the seventh dimension, asserted through
// `viewerGroups`/`visibleCount` rather than the bare predicate: the Open/All
// lifecycle is gated TWICE (once in `matches`, once by the `openOnly` re-gate
// in viewerGroups), and only this path exercises both.
describe('viewerGroups — repo stacking (#661)', () => {
  // Three repositories with different counts, one of them spelled two ways, and
  // one closed issue — so the gate visibly moves both the count and the order.
  const spread: ViewerIssue[] = [
    mk({ number: 1, repo: 'acme/board' }),
    mk({ number: 2, repo: 'board' }),
    mk({ number: 3, repo: 'board' }),
    mk({ number: 4, repo: 'acme/acme-ui' }),
    mk({ number: 5, repo: 'acme-ui', state: 'closed' }),
    mk({ number: 6, repo: 'docs' }),
  ];

  it('stacks the fullest repository first', () => {
    const g = viewerGroups(spread, { group: 'repo', filters: f({ state: 'all' }) });
    expect(g.map((x) => x.key)).toEqual(['board', 'acme-ui', 'docs']);
    expect(g.map((x) => x.rows.length)).toEqual([3, 2, 1]);
    expect(visibleCount(g)).toBe(6);
  });

  it('folds the two spellings of one repository into a single stack', () => {
    const g = viewerGroups(spread, { group: 'repo', filters: f({ state: 'all' }) });
    expect(g.find((x) => x.key === 'board')!.rows.map((r) => r.item.number)).toEqual([1, 2, 3]);
    expect(g).toHaveLength(3);
  });

  it('drops a closed issue under the Open gate, which re-breaks the tie by key', () => {
    const g = viewerGroups(spread, { group: 'repo', filters: f({ state: 'open' }) });
    expect(visibleCount(g)).toBe(5);
    expect(g.find((x) => x.key === 'acme-ui')!.rows.map((r) => r.item.number)).toEqual([4]);
    // docs and acme-ui both hold 1 now — alphabetical between them.
    expect(g.map((x) => x.key)).toEqual(['board', 'acme-ui', 'docs']);
  });

  it('shows the closed issue again under All', () => {
    const g = viewerGroups(spread, { group: 'repo', filters: f({ state: 'all' }) });
    expect(visibleCount(g)).toBe(6);
    expect(g.find((x) => x.key === 'acme-ui')!.rows.map((r) => r.item.number)).toEqual([4, 5]);
  });

  it('offers repo only once the set spans more than one repository', () => {
    expect(availableGroupDims(spread)).toContain('repo');
    expect(availableGroupDims([mk({ number: 1, repo: 'docs' })])).not.toContain('repo');
  });

  it('counts two spellings of one repository as one — so it stays withheld', () => {
    // Without the shared normaliser this set reads as two repos and the menu
    // offers a grouping that produces exactly one column.
    const oneRepo = [mk({ number: 1, repo: 'acme/board' }), mk({ number: 2, repo: 'board' })];
    expect(availableGroupDims(oneRepo)).not.toContain('repo');
  });

  it('lists repo after project — the two "which board / which repo" dimensions sit together', () => {
    const spanning = [
      mk({ number: 1, repo: 'board', projects: ['P'], status: 'Backlog' }),
      mk({ number: 2, repo: 'docs', projects: ['Q'], status: 'Done' }),
    ];
    expect(availableGroupDims(spanning)).toEqual([
      'status', 'openclosed', 'type', 'assignee', 'label', 'project', 'repo',
    ]);
  });
});

// The render-path proof for #418's Definition of Done: every filter dimension
// actually narrows the visible set, and clearing it restores the whole set. This
// exercises `viewerGroups` → `visibleCount` (what the queue paints), not just the
// bare predicate. The dismiss bug that made the sub-pane dimensions unreachable
// from the UI is covered separately in ui/command-menu.spec.ts.
describe('viewerGroups — each filter dimension narrows, and clearing restores (#418)', () => {
  const NOW = Date.parse('2026-08-03T12:00:00Z');
  const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
  const set: ViewerIssue[] = [
    mk({ number: 1, type: 'bug', labels: ['ui'], assignees: ['al'], projects: ['GTM'], createdAt: daysAgo(2) }),
    mk({ number: 2, type: 'feature', labels: ['auth'], assignees: ['bo'], projects: ['Compliance'], createdAt: daysAgo(20) }),
    mk({ number: 3, type: 'chore', labels: ['ui'], assignees: ['al'], createdAt: daysAgo(30), aging: true }),
    mk({ number: 4, type: 'bug', labels: ['access'], assignees: ['bo'], state: 'closed', closedAt: daysAgo(1), createdAt: daysAgo(40) }),
  ];
  const FULL = 4;
  // Grouped by openclosed so the `state: 'all'` baseline shows every row; the
  // dimension under test is the only thing narrowing.
  const count = (partial: Partial<ViewerFilters>) =>
    visibleCount(viewerGroups(set, { group: 'openclosed', filters: f({ state: 'all', ...partial }) }, NOW));

  it('baseline (no active filter) shows the whole set', () => {
    expect(count({})).toBe(FULL);
  });

  it('assignee narrows to that person, then restores when cleared', () => {
    expect(count({ assignees: ['al'] })).toBe(2); // #1, #3
    expect(count({ assignees: [] })).toBe(FULL);
  });

  it('label narrows to that label, then restores', () => {
    expect(count({ labels: ['ui'] })).toBe(2); // #1, #3
    expect(count({ labels: [] })).toBe(FULL);
  });

  it('type narrows to that work type, then restores', () => {
    expect(count({ types: ['bug'] })).toBe(2); // #1, #4
    expect(count({ types: [] })).toBe(FULL);
  });

  it('project narrows to that board, then restores', () => {
    expect(count({ projects: ['GTM'] })).toBe(1); // #1
    expect(count({ projects: [] })).toBe(FULL);
  });

  it('timeframe (opened this week) narrows to recent, then restores on "any"', () => {
    expect(count({ timeframe: 'opened-week' })).toBe(1); // only #1 (created 2d ago)
    expect(count({ timeframe: 'any' })).toBe(FULL);
  });

  // #478. Both of the viewer's lifecycle gates run for this one — `filterIssues`
  // and the per-group re-gate in viewerGroups — so it is asserted here, at the
  // rendered count, and not only against the pure predicate. #4 is 40 days old and
  // closed, which is exactly the row an age-based aging filter would leak.
  it('timeframe (aging) narrows to the flagged rows, then restores on "any"', () => {
    expect(count({ timeframe: 'aging' })).toBe(1); // only #3
    expect(count({ timeframe: 'any' })).toBe(FULL);
  });

  it('state Open drops the closed row; All restores it', () => {
    const openOnly = visibleCount(viewerGroups(set, { group: 'type', filters: f({ state: 'open' }) }, NOW));
    const all = visibleCount(viewerGroups(set, { group: 'type', filters: f({ state: 'all' }) }, NOW));
    expect(openOnly).toBe(3); // drops closed #4
    expect(all).toBe(FULL);
  });

  it('a dimension combines with the search text (AND), then restores', () => {
    // "t1" matches only #1's title; adding the ui label keeps it, an off-label empties it.
    expect(count({ q: 't1', labels: ['ui'] })).toBe(1);
    expect(count({ q: 't1', labels: ['auth'] })).toBe(0);
    expect(count({ q: 't1' })).toBe(1);
  });
});

describe('viewerGroups — closed-week is lifecycle-crossing under the default open state (#407)', () => {
  const NOW = Date.parse('2026-08-03T12:00:00Z');
  const iso = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString();

  it('shows this-week closed rows even though the default state filter is open (regression: drill-in was empty)', () => {
    const issues = [
      mk({ number: 10, state: 'closed', closedAt: iso(1), assignees: ['al'] }),
      mk({ number: 11, state: 'closed', closedAt: iso(4), assignees: ['al'] }),
      mk({ number: 12, state: 'open', assignees: ['al'] }),
    ];
    // Default filters keep state:'open'; the tile drills in with only timeframe set.
    const g = viewerGroups(issues, { group: 'type', filters: f({ timeframe: 'closed-week' }) }, NOW);
    expect(visibleCount(g)).toBe(2);
  });

  it('excludes an open issue and a stale (>7d) close under closed-week', () => {
    const issues = [
      mk({ number: 13, state: 'open' }),
      mk({ number: 14, state: 'closed', closedAt: iso(9) }),
    ];
    const g = viewerGroups(issues, { group: 'type', filters: f({ timeframe: 'closed-week' }) }, NOW);
    expect(visibleCount(g)).toBe(0);
  });
});

it('counts one canonical issue once when project membership renders it in two groups (#924)', () => {
  const issue = { ...mk({ number: 1, projects: ['Delivery', 'Maintenance'] }), htmlUrl: 'https://github.com/acme/board/issues/1' };
  const groups = viewerGroups([issue], { group: 'project', filters: f({}) });
  expect(groups.map(g => g.rows.length)).toEqual([1, 1]);
  expect(visibleCount(groups)).toBe(1);
});


describe('the triage groupings (#1099)', () => {
  // A queue as it really arrives: some issues triaged, most not.
  const queue: ViewerIssue[] = [
    mk({ number: 1, labels: ['triage:L', 'triage:P0', 'bug'] }),
    mk({ number: 2, labels: ['triage:XS', 'triage:P0'] }),
    mk({ number: 3, labels: ['triage:XS'] }),
    mk({ number: 4, labels: ['triage:P2', 'triage:agent'] }),
    mk({ number: 5, labels: ['bug'] }),
    mk({ number: 6, labels: [] }),
  ];
  const keys = (dim: GroupDim, issues = queue) =>
    viewerGroups(issues, { group: dim, filters: f({ state: 'all' }) }).map((g) => g.key);
  const labels = (dim: GroupDim, issues = queue) =>
    viewerGroups(issues, { group: dim, filters: f({ state: 'all' }) }).map((g) => g.label);

  it('offers one grouping per property the labels carry, straight after Label', () => {
    expect(availableGroupDims(queue)).toEqual([
      'openclosed', 'type', 'assignee', 'label', 'triage:priority', 'triage:route', 'triage:size',
    ]);
  });

  it('offers none of them for a queue whose issues carry no triage label', () => {
    expect(availableGroupDims([mk({ number: 1, labels: ['bug'] })])).toEqual([
      'openclosed', 'type', 'assignee', 'label',
    ]);
  });

  it('offers a family added on Github with no code change, off the three-segment shape', () => {
    // The second acceptance criterion of #1099, as a test: nothing in this repo
    // knows the word "effort".
    expect(availableGroupDims([mk({ number: 1, labels: ['triage:effort:3'] })])).toContain('triage:effort');
  });

  it('stacks Size on its own scale, smallest first, not fullest first', () => {
    // XS holds two issues and L holds one, so a count ranking would lead with XS.
    // The keys are folded (#1108) and the headings are not — see `triageValueLabel`.
    expect(keys('triage:size')).toEqual(['xs', 'l', noTriageKey('size')]);
    expect(labels('triage:size')).toEqual(['XS', 'L', 'No size']);
  });

  it('stacks Priority in its declared order', () => {
    expect(keys('triage:priority')).toEqual(['p0', 'p2', noTriageKey('priority')]);
    expect(labels('triage:priority')).toEqual(['P0', 'P2', 'No priority']);
  });

  it('groups the issues by the label value, not by the label name', () => {
    const g = viewerGroups(queue, { group: 'triage:size', filters: f({ state: 'all' }) });
    expect(g.find((x) => x.key === 'xs')!.rows.map((r) => r.item.number)).toEqual([2, 3]);
    expect(g.find((x) => x.key === 'l')!.rows.map((r) => r.item.number)).toEqual([1]);
  });

  it('stacks the untriaged work last rather than dropping it (#776 again)', () => {
    const g = viewerGroups(queue, { group: 'triage:size', filters: f({ state: 'all' }) });
    const rest = g[g.length - 1];
    expect(rest.label).toBe('No size');
    expect(rest.rows.map((r) => r.item.number)).toEqual([4, 5, 6]);
    // And the header count is the whole queue, not the triaged part of it.
    expect(visibleCount(g)).toBe(6);
  });

  it('draws no trailing stack when every issue carries the property', () => {
    const all = [mk({ number: 1, labels: ['triage:S'] }), mk({ number: 2, labels: ['triage:M'] })];
    expect(labels('triage:size', all)).toEqual(['S', 'M']);
  });

  it('ranks a property with no declared scale fullest first, like every other dimension', () => {
    const effort = [
      mk({ number: 1, labels: ['triage:effort:3'] }),
      mk({ number: 2, labels: ['triage:effort:1'] }),
      mk({ number: 3, labels: ['triage:effort:1'] }),
    ];
    expect(keys('triage:effort', effort)).toEqual(['1', '3']);
  });

  it('shows a value the families table does not name, under Triage', () => {
    // `triage:XXL` added ahead of its table row: visible, named, in a stack of
    // its own. Silently absent is what this must never be.
    const ahead = [mk({ number: 1, labels: ['triage:XXL'] }), mk({ number: 2, labels: ['triage:L'] })];
    expect(availableGroupDims(ahead)).toContain(triageDim(CATCH_ALL));
    expect(labels(triageDim(CATCH_ALL), ahead)).toEqual(['XXL', 'No triage']);
  });

  it('keeps the triage labels out of the Label grouping, and no issue with them', () => {
    // The issue's other open question, answered: Label is about ordinary labels
    // now that Size, Priority and Route have groupings of their own. #2, #3 and
    // #4 carry triage labels and nothing else, and #6 carries nothing; a Label
    // grouping that only hid the prefix would stop drawing all four. They stack
    // last instead, under "No label", and the header count is the whole queue.
    const g = viewerGroups(queue, { group: 'label', filters: f({ state: 'all' }) });
    expect(g.map((x) => x.key)).toEqual(['bug', NO_LABEL_KEY]);
    expect(g.map((x) => x.label)).toEqual(['bug', 'No label']);
    expect(g[0].rows.map((r) => r.item.number)).toEqual([1, 5]);
    expect(g[1].rows.map((r) => r.item.number)).toEqual([2, 3, 4, 6]);
    expect(visibleCount(g)).toBe(6);
  });

  it('narrows with the filters like any other grouping', () => {
    const g = viewerGroups(queue, { group: 'triage:size', filters: f({ state: 'all', labels: ['bug'] }) });
    expect(visibleCount(g)).toBe(2);
    expect(g.map((x) => x.key)).toEqual(['l', noTriageKey('size')]);
  });
});

describe('one stack per thing, one heading per stack (#1108)', () => {
  // Github enforces label case-uniqueness per REPOSITORY, and this queue spans
  // repositories: `triage:p0` in one and `triage:P0` in another arrive together.
  it('draws one Priority stack over two spellings, not two adjacent ones', () => {
    const spread = [
      mk({ number: 1, labels: ['triage:P0'] }),
      mk({ number: 2, labels: ['triage:p0'] }),
      mk({ number: 3, labels: ['triage:P1'] }),
    ];
    const g = viewerGroups(spread, { group: 'triage:priority', filters: f({ state: 'all' }) });
    expect(g.map((x) => x.label)).toEqual(['P0', 'P1']);
    expect(g[0].rows.map((r) => r.item.number)).toEqual([1, 2]);
  });

  it('heads a stack the families table does not name by a rule, not by arrival', () => {
    // Two spellings of one effort, in each order. A heading taken from whichever
    // label the queue returned first would differ between these two reads.
    const forwards = [mk({ number: 1, labels: ['triage:effort:Low'] }), mk({ number: 2, labels: ['triage:effort:low'] })];
    const backwards = [mk({ number: 1, labels: ['triage:effort:low'] }), mk({ number: 2, labels: ['triage:effort:Low'] })];
    const head = (issues: ViewerIssue[]) =>
      viewerGroups(issues, { group: 'triage:effort', filters: f({ state: 'all' }) })[0].label;
    expect(head(forwards)).toBe(head(backwards));
  });

  it('files three spellings of one property in one stack, not three under one heading', () => {
    // Before #1108 these were three dimensions — `tech-debt`, `tech_debt` and
    // `tech debt` — and the menu drew all three as "tech debt".
    const spelled = [
      mk({ number: 1, labels: ['triage:tech-debt:yes'] }),
      mk({ number: 2, labels: ['triage:tech_debt:yes'] }),
      mk({ number: 3, labels: ['triage:tech debt:yes'] }),
    ];
    expect(availableGroupDims(spelled).filter((d) => d.startsWith('triage:'))).toEqual(['triage:tech-debt']);
    const g = viewerGroups(spelled, { group: 'triage:tech-debt', filters: f({ state: 'all' }) });
    expect(g.map((x) => x.label)).toEqual(['yes']);
    expect(g[0].rows.map((r) => r.item.number)).toEqual([1, 2, 3]);
  });

  it('resolves a hand-written grouping whatever case and separator it was typed in', () => {
    // N1: only the folded spelling used to resolve, so this link silently landed
    // on the host's lead instead of on the grouping it names.
    const spelled = [mk({ number: 1, labels: ['triage:Deadline-Class:soon'] })];
    const dims = availableGroupDims(spelled);
    for (const typed of ['triage:Deadline-Class', 'triage:deadline_class', 'triage:DEADLINE CLASS']) {
      expect(resolveGroupDim(decodeViewer(`?group=${typed}`).group!, dims, 'type')).toBe('triage:deadline-class');
    }
  });
});
