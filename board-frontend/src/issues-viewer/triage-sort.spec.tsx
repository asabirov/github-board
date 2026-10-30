import { TooltipProvider } from '../ui/kit';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { compareTriage, sortViewerIssues } from './triage-sort';
import { DEFAULT_FILTERS } from './filter-group';
import { viewerGroups } from './viewer-groups';
import { BoardView } from './BoardView';
import { ListView } from './ListView';
import { decodeViewer, encodeViewer } from './viewer-url';
import { initViewer, syncViewer, viewerReducer } from './use-viewer-state';
import { isPrefAction, readViewerPrefs, writeViewerPrefs } from './viewer-prefs';
import type { ViewerIssue } from './viewer-issue';

const issue = (number: number, labels: string[] = [], parent?: number): ViewerIssue => ({
  number, labels: labels.map(name => ({ name, color: '' })), parent,
  repo: 'board', title: `Issue ${number}`, htmlUrl: `https://github.com/fixture/board/issues/${number}`,
  createdAt: '2026-09-01T00:00:00Z', state: 'open', status: 'Open', type: 'chore', assignees: ['alice'], projects: [],
});
const numbers = (items: ViewerIssue[]) => items.map(item => item.number);

describe('priority then size', () => {
  it('orders both scales, putting unset values last without mutating the input', () => {
    const items = [issue(1), issue(2, ['triage:P1']), issue(3, ['triage:P0', 'triage:XL']),
      issue(4, ['triage:P1', 'triage:XS']), issue(5, ['triage:S'])];
    expect(numbers(sortViewerIssues(items, 'priority-size'))).toEqual([3, 4, 2, 5, 1]);
    expect(numbers(items)).toEqual([1, 2, 3, 4, 5]);
    expect(sortViewerIssues(items)).toBe(items);
    const sizes = ['XL', 'L', 'M', 'S', 'XS'].map((size, i) => issue(i, [`triage:${size}`]));
    expect(numbers(sortViewerIssues(sizes, 'priority-size'))).toEqual([4, 3, 2, 1, 0]);
    const priorities = ['P3', 'P2', 'P1', 'P0'].map((priority, i) => issue(i, [`triage:${priority}`]));
    expect(numbers(sortViewerIssues(priorities, 'priority-size'))).toEqual([3, 2, 1, 0]);
  });
  it('normalizes duplicates, case and explicit forms; conflicts use the earliest recognized value', () => {
    const a = issue(1, ['triage:p2', 'TRIAGE:PRIORITY:P0', 'triage:P0', 'triage:SIZE:xs', 'triage:XL']);
    const b = issue(2, ['triage:P0', 'triage:XS']);
    expect(compareTriage(a, b)).toBe(0);
    expect(compareTriage(issue(3, ['triage:priority:urgent', 'triage:size:huge']), issue(4))).toBe(0);
    expect(numbers(sortViewerIssues([b, a], 'priority-size'))).toEqual([2, 1]);
  });
  it.each(['status', 'openclosed'] as const)('keeps parent-child adjacency in %s while sorting roots and siblings', group => {
    const items = [issue(1, ['triage:P2']), issue(2, ['triage:P3'], 1),
      issue(3, ['triage:P0'], 1), issue(4, ['triage:P1']), issue(5, ['triage:P0'], 2)];
    const rows = viewerGroups(items, { group, filters: DEFAULT_FILTERS, sort: 'priority-size' })[0].rows;
    expect(rows.map(({ item, depth }) => [item.number, depth])).toEqual([[4, 0], [1, 0], [3, 1], [2, 1], [5, 2]]);
    expect(viewerGroups(items, { group, filters: DEFAULT_FILTERS })[0].rows.map(r => r.item.number)).toEqual([1, 2, 5, 3, 4]);
  });
  it('sorts within each ordinary group', () => {
    const groups = viewerGroups([issue(1), issue(2, ['triage:P0'])], { group: 'type', filters: DEFAULT_FILTERS, sort: 'priority-size' });
    expect(groups[0].rows.map(r => r.item.number)).toEqual([2, 1]);
  });
});

describe('sort arrangement', () => {
  it('round-trips through URL, reducer, reload and navigation; default and invalid values stay unsorted', () => {
    const initial = initViewer('');
    const sorted = viewerReducer(initial, { type: 'setSort', sort: 'priority-size' });
    expect(initViewer(encodeViewer(sorted)).sort).toBe('priority-size');
    expect(decodeViewer('?sort=unknown').sort).toBeUndefined();
    expect(encodeViewer(viewerReducer(sorted, { type: 'setSort', sort: 'default' }))).toBe('');
    expect(syncViewer({ search: '?sort=priority-size', state: sorted }, '?view=board', undefined, () => null).state.sort).toBeUndefined();
    expect(isPrefAction({ type: 'setSort', sort: 'priority-size' })).toBe(true);
  });
  it('remembers sort without overriding shared URLs, and validates stored values', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    } });
    try {
      writeViewerPrefs('dashboard', { sort: 'priority-size' });
      expect(readViewerPrefs('dashboard')).toEqual({ sort: 'priority-size' });
      expect(initViewer('', undefined, readViewerPrefs('dashboard')).sort).toBe('priority-size');
      expect(initViewer('?view=board', undefined, readViewerPrefs('dashboard')).sort).toBeUndefined();
      writeViewerPrefs('dashboard', { sort: 'default' });
      expect(initViewer('', undefined, readViewerPrefs('dashboard')).sort).toBe('default');
      data.set('board_viewer:dashboard', '{"sort":"unknown"}');
      expect(readViewerPrefs('dashboard')).toBeNull();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});

describe('Queue triage rendering', () => {
  it.each(['board', 'list'] as const)('%s shows only present values, without a circle or route tag', view => {
    const render = (labels: string[], showTriage = true) => {
      const groups = viewerGroups([issue(1, labels)], { group: 'type', filters: DEFAULT_FILTERS });
      return renderToStaticMarkup(<TooltipProvider>{view === 'board'
        ? <BoardView groups={groups} dim="type" showTriage={showTriage} mayAssign={false} mayClose={false} />
        : <ListView groups={groups} showTriage={showTriage} hideLabels mayAssign={false} mayClose={false} />}</TooltipProvider>);
    };
    const html = render(['triage:p1', 'triage:priority:P1', 'triage:size:M', 'triage:agent']);
    expect(html).toContain('aria-label="Priority: P1"');
    expect(html).toContain('aria-label="Size: M"');
    expect(html.match(/data-triage="priority"/g)).toHaveLength(1);
    expect(html).not.toContain('data-triage="route"');
    expect(html).toMatch(/data-triage="priority"[^>]*>P1<\/span>/);
    expect(html.indexOf('data-triage="priority"')).toBeLessThan(html.indexOf('Issue 1</'));
    expect(render([])).not.toContain('data-triage');
    expect(render(['triage:P0'])).not.toContain('data-triage="size"');
    expect(render(['triage:S'])).not.toContain('data-triage="priority"');
    expect(render(['triage:P0'], false)).not.toContain('data-triage');
    expect(render(['triage:P2', 'triage:P0'])).toContain('Priority: P2/P0');
  });
});
