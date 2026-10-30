import { describe, expect, it } from 'vitest';
import type { Person } from '../api/people';
import type { ProjectSummary } from '../api/projects';
import type { SearchIssue } from '../api/issues';
import { groupByKind, issueItems, peopleItems, projectItems, searchItems } from './search-index';

describe('peopleItems', () => {
  it('links a person to the Unit page (per-member page retired, #420)', () => {
    const people = [
      { id: 'p@x.io', displayName: 'Priya Nair', emails: ['p@x.io'], clickupNames: [], githubLogin: 'priya' },
    ] as Person[];
    const [item] = peopleItems(people);
    expect(item.kind).toBe('person');
    expect(item.route).toEqual({ tab: 'team' });
    expect(item.title).toBe('Priya Nair');
  });
});

describe('projectItems (#214)', () => {
  it('links a project to its board route', () => {
    const [item] = projectItems([
      { number: 7, name: 'Go-To-Market', open: 3, closed: 9, pct: 75 } as ProjectSummary,
    ]);
    expect(item.kind).toBe('project');
    expect(item.route).toEqual({ tab: 'projects', project: 7 });
    expect(item.title).toBe('Go-To-Market');
    expect(item.sub).toContain('12 issues');
  });

  it('reads its subtitle as a sentence about one project (#694)', () => {
    const [item] = projectItems([
      { number: 7, name: 'Go-To-Market', open: 3, closed: 9, pct: 40 } as ProjectSummary,
    ]);
    expect(item.sub).toBe('Project, 40% done, 12 issues');
    expect(item.sub).not.toContain('·');
  });
});

describe('issueItems (#214)', () => {
  it('links an issue to the in-board issue page (#235)', () => {
    const issues: SearchIssue[] = [{ owner: 'acme', repo: 'acme', number: 218, title: 'Deploy bug' }];
    const [item] = issueItems(issues);
    expect(item.kind).toBe('issue');
    expect(item.route).toEqual({ tab: 'issue', issue: { owner: 'acme', repo: 'acme', number: 218 } });
    expect(item.sub).toBe('acme #218');
    // matchable by number alone
    expect(item.keywords).toContain('218');
  });
});

describe('searchItems', () => {
  const idx = peopleItems([
    { id: 'i@x.io', displayName: 'Ivan Roslov', emails: ['i@x.io'], clickupNames: [], githubLogin: 'ivan' },
    { id: 'a@x.io', displayName: 'Octocat', emails: ['a@x.io'], clickupNames: [], githubLogin: 'octocat' },
  ] as Person[]);

  it('requires every token to match (AND)', () => {
    expect(searchItems(idx, 'octocat').map((i) => i.id)).toContain('person:a@x.io');
    expect(searchItems(idx, 'octocat nonsense')).toHaveLength(0);
  });

  it('matches on github login metadata', () => {
    expect(searchItems(idx, 'ivan')[0]?.id).toBe('person:i@x.io');
  });

  it('returns [] for an empty query', () => {
    expect(searchItems(idx, '   ')).toEqual([]);
  });

  it('ranks a title-start hit above a mid-title hit', () => {
    const res = searchItems(
      [
        { kind: 'person', id: 'mid', chip: 'P', title: 'Boost activation', sub: '', keywords: 'boost activation' },
        { kind: 'person', id: 'start', chip: 'P', title: 'Activation lift', sub: '', keywords: 'activation lift' },
      ],
      'activation',
    );
    expect(res.map((r) => r.id)).toEqual(['start', 'mid']);
  });

  it('honours the limit', () => {
    expect(searchItems(idx, 'a', 1)).toHaveLength(1);
  });
});

describe('groupByKind', () => {
  it('groups people and drops empties', () => {
    const idx = peopleItems([
      { id: 'p', displayName: 'X', emails: [], clickupNames: [], githubLogin: 'x' },
    ] as Person[]);
    expect(groupByKind(idx).map((g) => g.kind)).toEqual(['person']);
    expect(groupByKind([])).toEqual([]);
  });

  it('orders projects, then people, then issues (#214)', () => {
    const idx = [
      ...issueItems([{ owner: 'o', repo: 'r', number: 1, title: 'Alpha' }]),
      ...peopleItems([{ id: 'p', displayName: 'Alpha One', emails: [], clickupNames: [], githubLogin: 'x' }] as Person[]),
      ...projectItems([{ number: 2, name: 'Alpha board', open: 1, closed: 0, pct: 0 } as ProjectSummary]),
    ];
    const hits = searchItems(idx, 'alpha');
    expect(groupByKind(hits).map((g) => g.kind)).toEqual(['project', 'person', 'issue']);
  });
});
