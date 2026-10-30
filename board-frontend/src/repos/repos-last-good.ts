import type { ReposView } from '../api/repos';
import { keepSaved, reposKey } from '../cache/payload-cache';
import { recallSaved, type Recalled } from '../projects/projects-last-good';

function savedMapShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const view = value as ReposView;
  return typeof view.updatedAt === 'string' && Array.isArray(view.driOptions)
    && Array.isArray(view.repos) && view.repos.every(row => row !== null
      && typeof row.full === 'string' && typeof row.name === 'string'
      && Array.isArray(row.weeks));
}

export function saveRepos(org: string | null, view: ReposView): void {
  keepSaved(reposKey(org), view);
}

/** Reuse the saved-copy policy; Repos has no surface-specific cooldown code. */
export function savedRepos(org: string | null, error: unknown): Recalled<ReposView> | null {
  return recallSaved(reposKey(org), org, error, savedMapShape);
}
