import { describe, expect, it } from 'vitest';
import type { IssueMetrics, OrgQueue, PersonalIssue } from '../api/issues';
import type { ReposView } from '../api/repos';
import { personView } from './person-view';

const row = (number: number, assignees: string[], state: 'open' | 'closed' = 'open') => ({ number, assignees, state, repo: 'repo', owner: 'acme', title: `Issue ${number}`, ageDays: 8, labels: [], type: 'bug', blocked: false, assignedToMe: false, author: null, projects: [], htmlUrl: `https://github.com/acme/repo/issues/${number}`, createdAt: '2026-09-01T00:00:00Z' }) as PersonalIssue;
const queue: OrgQueue = { updatedAt: '2026-09-09T12:00:00Z', issues: [row(1, ['IvanRoslov']), row(2, ['octocat']), row(3, []), row(4, ['IvanRoslov'], 'closed')] };
const metrics = { updatedAt: queue.updatedAt, computedAt: queue.updatedAt, days: { opened: [99, 99], closed: [99, 99] }, closedDays: [99, 99], byMember: [{ login: 'IvanRoslov', name: 'Ivan', opened: 2, closed: 3, days: { opened: [1, 1], closed: [3, 0] }, closedDays: [3, 0] }] } as IssueMetrics;
const repos = { repos: [{ full: 'acme/a', owner: { login: 'IvanRoslov', name: 'Ivan' } }, { full: 'acme/private-owner', owner: { login: 'IvanRoslov' }, ownerState: 'unreadable' }, { full: 'acme/b', owner: { login: 'octocat' } }, { full: 'acme/c', owner: null }] } as ReposView;

describe('person source boundary', () => {
  it('shows only exact-login assigned open issues and readable owned repositories', () => {
    const view = personView('IvanRoslov', [], queue, metrics, repos);
    expect(view.assigned?.map(issue => issue.number)).toEqual([1]);
    expect(view.owned?.map(repo => repo.full)).toEqual(['acme/a']);
    expect(view.member?.closed).toBe(3);
    expect(view.grid?.weeks.flat().filter(n => n !== null)).toEqual([3, 0]);
  });
  it('does not infer a person from a first name or substitute org history', () => {
    const view = personView('Ivan', [], queue, metrics, repos);
    expect(view.known).toBe(false);
    expect(view.member).toBeNull();
    expect(view.grid).toBeNull();
    expect(view.assigned).toEqual([]);
  });
  it('keeps independent unavailable sources unavailable', () => {
    const view = personView('IvanRoslov', [], queue, null, null);
    expect(view.assigned).toHaveLength(1);
    expect(view.member).toBeNull();
    expect(view.grid).toBeNull();
    expect(view.owned).toBeNull();
  });
  it('does not establish scoped presence from the global roster', () => {
    const roster = [{ id: 'ivan', displayName: 'Ivan', githubLogin: 'outside', emails: [], clickupNames: [] }];
    const view = personView('outside', roster, queue, metrics, repos);
    expect(view.known).toBe(false);
    expect(view.name).toBe('outside');
    expect(view.member).toBeNull();
  });
  it('does not turn missing member history into an all-zero grid', () => {
    const noHistory = { ...metrics, byMember: [{ login: 'IvanRoslov', name: 'Ivan', opened: 0, closed: 0 }] };
    expect(personView('IvanRoslov', [], queue, noHistory, repos).grid).toBeNull();
  });
});

describe('the person grid is dated by the snapshot, never by the freshness stamp (#1015)', () => {
  it('ignores updatedAt when computedAt is absent, rather than anchoring on cache age', () => {
    // `updatedAt` is overwritten by board-api with the raw-issue cache's fetch
    // time, which is served stale-while-revalidate with no bound while refreshes
    // fail — so it can sit days behind the day the series end on. Anchoring a
    // grid to it draws the closes on the wrong cells with the labels agreeing,
    // which is the whole defect #1015 fixed one layer up. Against a board-api
    // predating `computedAt` the honest anchor is the reader's own clock.
    const stale = { ...metrics, computedAt: undefined, updatedAt: '2026-01-02T00:00:00Z' } as IssueMetrics;
    const view = personView('IvanRoslov', [], queue, stale, repos);
    // Dated off `updatedAt` the grid would end in January 2026; dated off the
    // caller's clock it ends yesterday, whenever this test runs.
    const endsOn = view.grid?.endsOn;
    expect(endsOn).toBeDefined();
    expect(endsOn).toBeGreaterThan(Date.parse('2026-06-01T00:00:00Z'));
  });

  it('uses computedAt when it is there, whatever updatedAt says', () => {
    const skewed = { ...metrics, computedAt: '2026-09-09T12:00:00Z', updatedAt: '2026-01-02T00:00:00Z' } as IssueMetrics;
    expect(personView('IvanRoslov', [], queue, skewed, repos).grid?.endsOn).toBe(Date.UTC(2026, 8, 9));
  });
});

it('dates another person’s heatmap in the viewing person’s zone', () => {
  const local = { ...metrics, computedAt: '2026-09-25T22:30:00Z', timeZone: 'Europe/Berlin' };
  expect(personView('IvanRoslov', [], queue, local, repos).grid?.endsOn).toBe(Date.UTC(2026, 8, 26));
});
