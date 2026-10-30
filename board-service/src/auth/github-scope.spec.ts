import { expect, it } from 'vitest';
import { githubScopeIds } from './github-scope';
import type { GithubRepository } from './github-principal';

it('uses stable sorted identities across renames without changing the input order', () => {
  const owners = [{ id: 9, login: 'old', type: 'Organization' as const }, { id: 2, login: 'person', type: 'User' as const }];
  const repos = [{ id: 8, full_name: 'old/repo' }, { id: 3 }, { id: 8 }] as GithubRepository[];
  expect(githubScopeIds(owners, repos)).toEqual({ ownerIds: [2, 9], repositoryIds: [3, 8] });
  expect(githubScopeIds([{ ...owners[0], login: 'renamed' }, owners[1]], repos)).toEqual({ ownerIds: [2, 9], repositoryIds: [3, 8] });
  expect(owners.map((o) => o.id)).toEqual([9, 2]);
  expect(repos.map((r) => r.id)).toEqual([8, 3, 8]);
});
it('distinguishes unknown legacy identities from a known empty scope', () => {
  expect(githubScopeIds([{ login: 'legacy', type: 'Organization' }], [])).toBeNull();
  for (const id of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(githubScopeIds([], [{ id }] as GithubRepository[])).toBeNull();
  }
  expect(githubScopeIds([], [])).toEqual({ ownerIds: [], repositoryIds: [] });
});
