import { describe, expect, it } from 'vitest';
import { computeFilterOptions } from './filter-options.vm';
import type { RawIssue } from './issues-metrics.types';

const raw = (over: Partial<RawIssue>): RawIssue => ({
  owner: 'acme',
  repo: 'acme',
  number: 1,
  title: 't',
  htmlUrl: 'https://github.com/acme/acme/issues/1',
  state: 'open',
  createdAt: '2026-07-01T00:00:00Z',
  closedAt: null,
  // A synthetic row is told no reason, which is the state that COUNTS —
  // so every assertion written before #1014 keeps meaning what it meant.
  stateReason: null,
  author: 'octocat',
  assignees: [],
  labels: [],
  labelsComplete: true,
  // These rows are about counting, not about words (#516).
  submission: false,
  milestone: null,
  ...over,
});

describe('computeFilterOptions (#376)', () => {
  it('derives de-duplicated, sorted label / assignee / project sets from cached data', () => {
    const issues = [
      raw({ number: 1, labels: ['bug', 'blocked'], assignees: ['octocat', 'IvanRoslov'] }),
      raw({ number: 2, labels: ['bug', 'feature'], assignees: ['octocat'] }),
      raw({ number: 3, labels: [], assignees: [] }),
    ];
    const projects = [
      { org: 'acme', number: 7, name: 'Acme Go-To-Market' },
      { org: 'acme', number: 4, name: 'Acme' },
      { org: 'acme', number: 7, name: 'Acme Go-To-Market' }, // dup by org+number → collapsed
    ];

    const opts = computeFilterOptions(issues, projects);

    expect(opts.labels.map((l) => l.name)).toEqual(['blocked', 'bug', 'feature']);
    expect(opts.labels.every((l) => 'color' in l)).toBe(true);
    expect(opts.assignees).toEqual(['IvanRoslov', 'octocat']);
    // Projects de-duped by org+number, sorted by name.
    expect(opts.projects).toEqual([
      { org: 'acme', number: 4, name: 'Acme' },
      { org: 'acme', number: 7, name: 'Acme Go-To-Market' },
    ]);
  });

  // The de-dupe key, stated on its own. Two orgs may number their boards however
  // they like, so the number is not a board's identity across the union the
  // rollup now serves (#697) — keying on it alone dropped the second board from
  // the menu outright, and a user could not filter to work on their own screen.
  it('keeps both boards when two orgs number one the same', () => {
    const opts = computeFilterOptions([], [
      { org: 'acme', number: 3, name: 'Platform' },
      { org: 'globex', number: 3, name: 'Delivery' },
    ]);

    expect(opts.projects).toEqual([
      { org: 'globex', number: 3, name: 'Delivery' },
      { org: 'acme', number: 3, name: 'Platform' },
    ]);
  });

  it('returns empty sets for an empty cache', () => {
    expect(computeFilterOptions([], [])).toEqual({ labels: [], assignees: [], projects: [] });
  });
});
