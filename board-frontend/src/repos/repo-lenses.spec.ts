import { describe, expect, it } from 'vitest';
import { decodeRepos, encodeRepos } from './repos-url';
import { applyRepoLens, repoMetric, type RepoTile } from './repos-vm';
import type { RepoPrFlow, RepoRow } from '../api/repos';

const tile = (name: string, open = 0): RepoTile => ({
  row: { name, full: `org/${name}`, open, weeks: [], openIssuesState: 'read' } as unknown as RepoRow,
  health: { ci: null, ciUrl: null, security: { state: 'read', depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null } },
});

describe('Repos metric lenses', () => {
  it('orders by the selected figure, with a measured zero ahead of an unavailable figure', () => {
    const tiles = [tile('unknown', 99), tile('zero', 20), tile('costly', 1)];
    const data = new Map([
      ['org/zero', { ciSpend: { state: 'read' as const, weeks: [{ netUsd: 0, minutes: 90 }] } }],
      ['org/costly', { ciSpend: { state: 'read' as const, weeks: [{ netUsd: 12.34, minutes: 1 }] } }],
    ]);
    expect(applyRepoLens(tiles, 'issues').map(t => t.row.name)).toEqual(['unknown', 'zero', 'costly']);
    const cost = applyRepoLens(tiles, 'ci-cost', data);
    expect(cost.map(t => t.row.name)).toEqual(['costly', 'zero', 'unknown']);
    expect(cost.map(t => t.metric?.label)).toEqual(['$12.34', '$0.00', 'Unavailable']);
    expect(cost[1].metric?.series).toEqual([0]);
    expect(cost[1].metric?.hint).not.toContain('nothing ran');
  });

  it('never turns unsupported or unread security and issues into zero', () => {
    const repo = tile('personal');
    repo.health!.security.state = 'not-applicable';
    expect(repoMetric(repo, 'security')).toMatchObject({ value: null, label: 'Not applicable', series: [] });
    repo.health!.security.state = 'unreadable';
    expect(repoMetric(repo, 'security').value).toBeNull();
    repo.row.openIssuesState = 'unreadable';
    expect(repoMetric(repo, 'issues').value).toBeNull();
    expect(repoMetric(repo, 'ci-cost', { ciSpend: { state: 'unreadable' } }).value).toBeNull();
  });

  it('uses current alert totals for security and never invents historical points', () => {
    const repo = tile('alerts');
    Object.assign(repo.health!.security, { depHigh: 2, depModerate: 3, codeScanning: 4, secrets: 1 });
    expect(repoMetric(repo, 'security')).toMatchObject({ value: 10, series: [] });
  });

  it('uses weekly net dollars, including idle zero, independently of minutes', () => {
    const metric = repoMetric(tile('ci'), 'ci-cost', { ciSpend: { state: 'read', weeks: [
      { netUsd: 8, minutes: 10 }, { netUsd: 1, minutes: 200 }, { netUsd: 0, minutes: 0 },
    ] } });
    expect(metric.series).toEqual([8, 1, 0]);
    expect(metric.value).toBe(0);
    expect(metric.hint).toContain('nothing ran');
  });
});


it('PR lens uses open counts and weekly opened flow, retaining unknown windows', () => {
  const flow: RepoPrFlow = { state: 'read', open: 4, closedMerged: 2, openPrs: [],
    weeks: [null, { opened: 6, merged: 2 }] };
  const result = applyRepoLens([tile('unknown', 100), tile('prs', 1)], 'prs',
    new Map([['org/prs', { pullRequests: flow }]]));
  expect(result.map(t => t.row.name)).toEqual(['prs', 'unknown']);
  expect(result[0].metric).toMatchObject({ value: 4, label: '4', series: [null, 6] });
  expect(result[1].metric?.value).toBeNull();
});


it('retains the selected lens with owner and health filters in the URL', () => {
  for (const lens of ['prs', 'ci-cost', 'security'] as const) {
    const state = { lens, owner: 'alice', health: 'ci' as const, order: 'name' as const };
    expect(decodeRepos(encodeRepos(state))).toEqual(state);
  }
  expect(decodeRepos('?lens=unknown')).toEqual({});
});


it.each([0, 1, 2])('uses singular lens hints only for a count of one (%i)', count => {
  const repo = tile('counts', count);
  repo.health!.security.depHigh = count;
  const suffix = count === 1 ? '' : 's';
  expect(repoMetric(repo, 'issues').hint).toBe(`${count} open issue${suffix}`);
  expect(repoMetric(repo, 'security').hint).toBe(`${count} open security alert${suffix}`);
  expect(repoMetric(repo, 'prs', { pullRequests: {
    state: 'read', open: count, closedMerged: 0, openPrs: [], weeks: [],
  } }).hint).toBe(`${count} open PR${suffix}`);
  expect(repoMetric(repo, 'ci-cost', { ciSpend: {
    state: 'read', weeks: [{ netUsd: count, minutes: 1 }],
  } }).hint).toBe(`$${count}.00 net billed USD in the trailing 7 days`);
});
