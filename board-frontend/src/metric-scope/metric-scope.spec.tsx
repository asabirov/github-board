import { describe, it, expect } from 'vitest';
import { comparableScopes, type MetricScope } from './metric-scope';

const scope: MetricScope = {
  repositories: [{ id: 1, name: 'example/one', readable: true }], repositoryIds: [1], ownerIds: [10], digest: 'evidence',
  definition: 'issue-flow-v1', filters: { repo: null, label: null, cycle: null, longLivedLabels: [] }, timeZone: 'UTC',
  window: { start: '2026-09-21T00:00:00.000Z', end: '2026-09-28T00:00:00.000Z' },
  sourceUpdatedAt: '2026-09-28T00:00:00.000Z', freshUntil: '2026-09-28T00:10:00.000Z', completeness: 'complete',
};
const now = Date.parse('2026-09-28T00:01:00Z');
describe('metric comparison evidence', () => {
  it('allows the same complete, fresh scope and canonical repository sets', () => {
    expect(comparableScopes(scope, { ...scope }, now)).toBe(true);
    expect(comparableScopes({ ...scope, repositoryIds: [1, 2] }, { ...scope, repositoryIds: [2, 1] }, now)).toBe(true);
  });
  it.each([
    { repositoryIds: [2] }, { repositoryIds: null }, { ownerIds: null }, { digest: null },
    { definition: '' }, { definition: 'other' },
    { window: { ...scope.window, start: 'invalid' } }, { filters: { ...scope.filters, label: 'bug' } },
    { timeZone: 'Europe/London' }, { window: { ...scope.window, start: '2026-09-20T00:00:00.000Z' } },
    { completeness: 'partial' as const }, { completeness: 'unknown' as const },
    { sourceUpdatedAt: '2026-09-27T23:59:00.000Z' }, { freshUntil: '2026-09-28T00:00:00.000Z' },
  ])('refuses missing, mismatched or stale evidence: %j', change => {
    expect(comparableScopes(scope, { ...scope, ...change }, now)).toBe(false);
  });
  it('refuses legacy responses with no scope', () => expect(comparableScopes(undefined, undefined, now)).toBe(false));
});
it('does not consider two equally incomplete definitions or invalid windows comparable', () => {
  const noDefinition = { ...scope, definition: '' };
  const invalidWindow = { ...scope, window: { ...scope.window, start: 'invalid' } };
  expect(comparableScopes(noDefinition, noDefinition, now)).toBe(false);
  expect(comparableScopes(invalidWindow, invalidWindow, now)).toBe(false);
});
