import type { GithubOwner, GithubRepository } from './github-principal';

/** The App's accessible organizations plus this person's own namespace.
 * Other personal installations and organization membership alone grant nothing. */
export function isPersonalScopeOwner(account: { id: number; type: string }, githubUserId: string): boolean {
  return account.type === 'Organization' || (account.type === 'User' && String(account.id) === githubUserId);
}

/** Discovery identity only. It neither authorizes access nor establishes metric
 * comparability: filters, windows, permissions and completeness also matter. */
export interface GithubScopeIds {
  ownerIds: number[];
  repositoryIds: number[];
}
export function githubScopeIds(owners: GithubOwner[], repositories: GithubRepository[]): GithubScopeIds | null {
  const valid = (id: number | undefined): id is number => Number.isSafeInteger(id) && (id ?? 0) > 0;
  const ownerIds = owners.map((owner) => owner.id);
  const repositoryIds = repositories.map((repo) => repo.id);
  // A legacy principal without identities cannot establish equal scope.
  if (!ownerIds.every(valid) || !repositoryIds.every(valid)) return null;
  const sorted = (ids: number[]) => [...new Set(ids)].sort((a, b) => a - b);
  return { ownerIds: sorted(ownerIds), repositoryIds: sorted(repositoryIds) };
}
