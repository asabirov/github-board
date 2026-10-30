import { triageValueOrder, triageValues } from './triage-labels';
import type { ViewerIssue } from './viewer-issue';

export type ViewerSort = 'default' | 'priority-size';
export const isViewerSort = (value: unknown): value is ViewerSort => value === 'default' || value === 'priority-size';

function rank(item: ViewerIssue, property: string): number {
  const order = triageValueOrder(property) ?? [];
  const ranks = triageValues(item.labels.map(l => l.name), property)
    .map(value => order.indexOf(value)).filter(value => value >= 0);
  // Conflicts use the earliest known value; custom-only and absent values tie last.
  return ranks.length ? Math.min(...ranks) : order.length;
}

export function compareTriage(a: ViewerIssue, b: ViewerIssue): number {
  return rank(a, 'priority') - rank(b, 'priority') || rank(a, 'size') - rank(b, 'size');
}

export function sortViewerIssues(items: ViewerIssue[], sort?: ViewerSort): ViewerIssue[] {
  return sort === 'priority-size' ? [...items].sort(compareTriage) : items;
}
