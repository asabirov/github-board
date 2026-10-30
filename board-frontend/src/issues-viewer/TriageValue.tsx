import type { ViewerIssue } from './viewer-issue';
import { triageFacets, triageValueLabel, triageValues } from './triage-labels';

const PRIORITY: Record<string, string> = {
  P0: 'bg-danger-fill text-danger',
  P1: 'bg-warn-fill text-warn',
  P2: 'bg-accent-fill text-accent',
};

export function TriageValue({ item, property }: { item: ViewerIssue; property: 'priority' | 'size' }) {
  const names = item.labels.map(l => l.name);
  const facets = triageFacets(names, property);
  const value = triageValues(names, property).map(value => triageValueLabel(
    property, value, facets.filter(f => f.value === value).map(f => f.spelling),
  )).join('/');
  if (!value) return null;
  const label = `${property === 'priority' ? 'Priority' : 'Size'}: ${value}`;
  const tone = (property === 'priority' && PRIORITY[value]) || 'bg-elevated text-dim';
  return <span data-triage={property} title={label} aria-label={label}
    className={`inline-flex shrink-0 items-center rounded-md px-[7px] py-[3px] text-[11px] font-medium leading-[1.5] tabular-nums [overflow-wrap:anywhere] ${tone}`}>{value}</span>;
}
