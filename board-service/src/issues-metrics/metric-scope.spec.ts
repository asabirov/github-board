import { describe, it, expect } from 'vitest';
import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { metricScope } from './metric-scope';
const now = '2026-09-28T00:00:00.000Z';
const snapshot = { at: Date.parse(now), coverageReported: true, repoCoverageReported: true, orgs: [{ state: 'read' }], repos: [
  { id: 2, full: 'example/two', ok: true }, { id: 1, full: 'example/one', ok: true },
] };
const principal: GithubPrincipal = { key: 'viewer', email: 'person@example.com', login: 'person', token: null, cache: new WeakMap(), owners: [{ id: 10, login: 'example', type: 'Organization' }], repositories: [] };
const build = (change = {}, query = {}) => githubContext.run({ principal }, () => metricScope({ ...snapshot, ...change }, query, now, new Set(['steady']), 600_000));
describe('metric scope evidence', () => {
  it('keeps snapshot evidence stable while request windows and filters change', () => {
    const at = Date.parse(now);
    const read = (offset: number, query = {}) => githubContext.run({ principal }, () =>
      metricScope(snapshot, query, new Date(at + offset).toISOString(), new Set(), 600_000));
    const first = read(0);
    for (const offset of [30_000, 60_001]) {
      const later = read(offset);
      expect(later).toMatchObject({
        repositoryIds: first.repositoryIds, ownerIds: first.ownerIds,
        sourceUpdatedAt: first.sourceUpdatedAt, freshUntil: first.freshUntil,
        definition: first.definition, filters: first.filters, timeZone: first.timeZone,
        completeness: 'complete',
        window: { start: new Date(at + offset - 7 * 86400000).toISOString(), end: new Date(at + offset).toISOString() },
      });
      expect(later.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(later.digest).not.toBe(first.digest);
    }
    const filtered = read(30_000, { label: 'bug' });
    expect(filtered.filters).toEqual({ ...first.filters, label: 'bug' });
    expect(filtered.digest).not.toBe(read(30_000).digest);
  });
  it('uses every scanned repository, including empty repos, and canonical stable IDs', () => {
    expect(build()).toMatchObject({ repositoryIds: [1, 2], ownerIds: [10], completeness: 'complete', sourceUpdatedAt: now, freshUntil: '2026-09-28T00:10:00.000Z' });
    expect(build().digest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('narrows by the actual repository filter and retains the definition filters', () => {
    expect(build({}, { repo: 'one', label: 'bug', cycle: 'current' })).toMatchObject({ repositoryIds: [1], filters: { repo: 'one', label: 'bug', cycle: 'current', longLivedLabels: ['steady'] } });
  });
  it('makes renamed equal-ID scope comparable, but changes the digest with filters', () => {
    const renamed = build({ repos: snapshot.repos.map(repo => ({ ...repo, full: repo.full + '-renamed' })) });
    expect(renamed.digest).toBe(build().digest);
    expect(build({}, { label: 'bug' }).digest).not.toBe(build().digest);
  });
  it('refuses comparison evidence after missing IDs or a failed read', () => {
    expect(build({ repos: [{ full: 'example/one', ok: true }] }).digest).toBeNull();
    expect(build({ repos: [{ id: 1, full: 'example/one', ok: false }] })).toMatchObject({ completeness: 'partial', digest: null });
    expect(build({ orgs: [{ state: 'unreadable' }] })).toMatchObject({ completeness: 'partial', digest: null });
  });
  it('distinguishes known empty from unreported coverage', () => {
    expect(build({ repos: [] })).toMatchObject({ repositoryIds: [], completeness: 'complete' });
    expect(build({ repos: [], coverageReported: false, repoCoverageReported: false })).toMatchObject({ repositoryIds: null, completeness: 'unknown', digest: null });
  });
});

it('does not treat organization reporting alone as exact repository coverage', () => {
  expect(build({ repoCoverageReported: false, repos: [] })).toMatchObject({ repositoryIds: null, digest: null, completeness: 'unknown' });
});
it('refuses an unresolved repository owner identity', () => {
  expect(build({ repos: [{ id: 4, full: 'unresolved/one', ok: true }] })).toMatchObject({ ownerIds: null, digest: null });
});
