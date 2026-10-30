import { createHash } from 'node:crypto';
import { githubPrincipal } from '../auth/github-principal';
import type { IssueMetricsQuery } from './issues-metrics.types';
import { shortRepoKey } from './github-issues.source';

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

type Snapshot = {
  at: number;
  coverageReported: boolean;
  repoCoverageReported: boolean;
  repos: { id?: number; full: string; ok: boolean }[];
  orgs: { state: string }[];
};
const validId = (id: unknown): id is number => Number.isSafeInteger(id) && Number(id) > 0;

export function metricScope(snapshot: Snapshot, query: IssueMetricsQuery, now: string, longLived: Set<string>, ttl: number, definition = 'issue-flow-v1'): MetricScope {
  const principal = githubPrincipal();
  const selected = snapshot.repos.filter(repo => !query.repo || query.repo === 'all' || shortRepoKey(repo.full) === query.repo);
  const repositories = selected.map(repo => ({ id: validId(repo.id) ? repo.id : null, name: repo.full, readable: repo.ok }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const repositoryIds = snapshot.repoCoverageReported && repositories.every(repo => repo.id !== null)
    ? [...new Set(repositories.map(repo => repo.id!))].sort((a, b) => a - b) : null;
  const owners = principal?.owners.filter(owner => selected.some(repo => repo.full.split('/')[0].toLowerCase() === owner.login.toLowerCase())) ?? [];
  const ownerIds = principal && selected.every(repo => owners.some(owner => owner.login.toLowerCase() === repo.full.split('/')[0].toLowerCase())) && owners.every(owner => validId(owner.id)) ? [...new Set(owners.map(owner => owner.id!))].sort((a, b) => a - b) : null;
  const completeness = !snapshot.repoCoverageReported ? 'unknown' : snapshot.orgs.some(org => org.state === 'unreadable') || selected.some(repo => !repo.ok) ? 'partial' : 'complete';
  const basis = {
    repositoryIds, ownerIds, definition,
    filters: { repo: query.repo && query.repo !== 'all' ? query.repo : null, label: query.label ?? null, cycle: query.cycle ?? null, longLivedLabels: [...longLived].sort() },
    timeZone: query.timeZone ?? 'UTC',
    window: { start: new Date(Date.parse(now) - 7 * 86400000).toISOString(), end: now },
  };
  return {
    ...basis, repositories, completeness,
    digest: repositoryIds === null || ownerIds === null || completeness !== 'complete' ? null : createHash('sha256').update(JSON.stringify(basis)).digest('hex'),
    sourceUpdatedAt: new Date(snapshot.at).toISOString(),
    freshUntil: new Date(snapshot.at + ttl).toISOString(),
  };
}
