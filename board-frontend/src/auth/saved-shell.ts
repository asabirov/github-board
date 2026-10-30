import type { MeResponse } from '../api/types';

/** Display only. Never pass this snapshot to the identity or response contexts. */
export interface SavedShell {
  email: string;
  github?: Pick<NonNullable<MeResponse['github']>, 'configured' | 'connected' | 'owners'>;
  account?: { name: string; githubLogin: string | null };
}

/** Project both server answers and stored JSON onto the fields the shell paints. */
export function savedShell(value: unknown): SavedShell | undefined {
  if (!value || typeof value !== 'object') return;
  const raw = value as Record<string, unknown>;
  if (typeof raw.email !== 'string' || !raw.email.trim()) return;
  const shell: SavedShell = { email: raw.email };
  if (raw.github && typeof raw.github === 'object') {
    const github = raw.github as Record<string, unknown>;
    if (typeof github.connected === 'boolean' && Array.isArray(github.owners)
      && github.owners.every(owner => owner && typeof owner.login === 'string'
        && (owner.type === 'Organization' || owner.type === 'User'))) {
      shell.github = {
        connected: github.connected,
        ...(typeof github.configured === 'boolean' ? { configured: github.configured } : {}),
        owners: github.owners.map(({ login, type }) => ({ login, type })),
      };
    }
  }
  if (raw.account && typeof raw.account === 'object') {
    const account = raw.account as Record<string, unknown>;
    if (typeof account.name === 'string'
      && (account.githubLogin === null || typeof account.githubLogin === 'string')) {
      shell.account = { name: account.name, githubLogin: account.githubLogin };
    }
  }
  return shell;
}
