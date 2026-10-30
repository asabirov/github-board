export interface MetricScope {
  repositories: { id: number | null; name: string; readable: boolean }[];
  repositoryIds: number[] | null;
  ownerIds: number[] | null;
  digest: string | null;
  definition: string;
  filters: { repo: string | null; label: string | null; cycle: string | null; longLivedLabels: string[] };
  timeZone: string;
  window: { start: string; end: string };
  sourceUpdatedAt: string;
  freshUntil: string;
  completeness: 'complete' | 'partial' | 'unknown';
}

const ids = (values: number[] | null) => Array.isArray(values) && values.every(id => Number.isSafeInteger(id) && id > 0)
  ? JSON.stringify([...new Set(values)].sort((a, b) => a - b)) : null;

// Rolling request windows may differ by up to one minute; the source snapshot must still match.
const sameWindowInstant = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 60_000;

export function comparableScopes(a: MetricScope | undefined, b: MetricScope | undefined, now = Date.now()): boolean {
  if (!a || !b) return false;
  const usable = (s: MetricScope) => s.completeness === 'complete' && !!s.digest
    && typeof s.definition === 'string' && s.definition.length > 0
    && typeof s.timeZone === 'string' && s.timeZone.length > 0
    && Number.isFinite(Date.parse(s.window?.start)) && Date.parse(s.window?.end) > Date.parse(s.window.start)
    && s.filters != null && Array.isArray(s.filters.longLivedLabels)
    && s.filters.longLivedLabels.every(label => typeof label === 'string')
    && [s.filters.repo, s.filters.label, s.filters.cycle].every(value => value === null || typeof value === 'string')
    && ids(s.repositoryIds) !== null && ids(s.ownerIds) !== null
    && Number.isFinite(Date.parse(s.sourceUpdatedAt)) && Date.parse(s.freshUntil) > now;
  return usable(a) && usable(b) && ids(a.repositoryIds) === ids(b.repositoryIds)
    && ids(a.ownerIds) === ids(b.ownerIds) && a.definition === b.definition
    && a.timeZone === b.timeZone && sameWindowInstant(a.window.start, b.window.start) && sameWindowInstant(a.window.end, b.window.end)
    && a.sourceUpdatedAt === b.sourceUpdatedAt
    && a.filters.repo === b.filters.repo && a.filters.label === b.filters.label && a.filters.cycle === b.filters.cycle
    && JSON.stringify([...a.filters.longLivedLabels].sort()) === JSON.stringify([...b.filters.longLivedLabels].sort());
}

export function notComparableScopes(a: MetricScope | undefined, b: MetricScope | undefined, now = Date.now()): boolean {
  return !!a && !!b && Date.parse(a.freshUntil) > now && Date.parse(b.freshUntil) > now
    && !comparableScopes(a, b, now);
}
