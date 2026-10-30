import type { Route } from '../route';

interface Targets {
  owners: { id?: number; login: string }[];
  repositories?: { id: number; full_name: string }[];
}
let targets: Targets | undefined;
const priorOwners = new Map<string, number>();
const priorRepositories = new Map<string, number>();
const reusedOwners = new Set<string>();
const reusedRepositories = new Set<string>();
const validId = (id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const LEGACY_TARGET = 'This old link or saved choice could point to a different GitHub account or repository. Choose it again from the menu.';
const MISSING_TARGET = 'This GitHub destination is no longer available with your current access.';

/** Live discovery supplies names for links, never permission for requests. */
export function installTargets(value: Targets | undefined): void {
  if (!value) {
    priorOwners.clear(); priorRepositories.clear(); reusedOwners.clear(); reusedRepositories.clear();
  } else {
    for (const owner of value.owners ?? []) {
      if (!validId(owner.id)) continue;
      const key = owner.login.toLowerCase();
      if (priorOwners.has(key) && priorOwners.get(key) !== owner.id) reusedOwners.add(key);
      priorOwners.set(key, owner.id);
    }
    for (const repo of value.repositories ?? []) {
      const key = repo.full_name.toLowerCase();
      if (priorRepositories.has(key) && priorRepositories.get(key) !== repo.id) reusedRepositories.add(key);
      priorRepositories.set(key, repo.id);
    }
  }
  targets = value;
}
export function hasStableTargets(): boolean { return targets?.repositories !== undefined; }
export function ownerId(login: string): number | undefined {
  const matches = targets?.owners.filter(owner => same(owner.login, login) && validId(owner.id)) ?? [];
  return matches.length === 1 ? matches[0].id : undefined;
}
export function repositoryId(fullName: string): number | undefined {
  const matches = targets?.repositories?.filter(repo => same(repo.full_name, fullName)) ?? [];
  return matches.length === 1 ? matches[0].id : undefined;
}
export function ownerName(id: number): string {
  const name = targets?.owners.find(owner => owner.id === id)?.login;
  if (!name) throw new Error(MISSING_TARGET);
  return name;
}
export function repositoryName(id: number): string {
  const name = targets?.repositories?.find(repo => repo.id === id)?.full_name;
  if (!name) throw new Error(MISSING_TARGET);
  return name;
}

export function targetQuery(route: Route): string {
  const p = new URLSearchParams();
  if (route.org || route.ownerId !== undefined) {
    const id = route.ownerId ?? (reusedOwners.has(route.org!.toLowerCase()) ? undefined : ownerId(route.org!));
    if (validId(id)) p.set('ownerId', String(id));
  }
  const repo = route.repo ? `${route.repo.owner}/${route.repo.name}` : route.issue ? `${route.issue.owner}/${route.issue.repo}` : undefined;
  const id = route.repositoryId ?? (repo && !reusedRepositories.has(repo.toLowerCase()) ? repositoryId(repo) : undefined);
  if (repo && validId(id)) p.set('repositoryId', String(id));
  return p.toString();
}

/** Bind unique current names once, then carry the identity through navigation. */
export function resolveRouteTarget(route: Route): Route {
  if (!hasStableTargets()) return route;
  let next = route;
  if (route.viewer?.filters) {
    const repos = route.viewer.filters.repos.map(value => {
      const bound = repositoryFilter(value);
      if (!value.startsWith('id:') && bound.startsWith('id:') && reusedRepositories.has(repositoryName(Number(bound.slice(3))).toLowerCase())) throw new Error(LEGACY_TARGET);
      if (!bound.startsWith('id:')) throw new Error(LEGACY_TARGET);
      repositoryName(Number(bound.slice(3)));
      return bound;
    });
    const boards = route.viewer.filters.boards.map(value => {
      const [org, ...rest] = value.split('/');
      if (!org.startsWith('id:') && reusedOwners.has(org.toLowerCase())) throw new Error(LEGACY_TARGET);
      const id = org.startsWith('id:') ? Number(org.slice(3)) : ownerId(org);
      if (!validId(id)) throw new Error(LEGACY_TARGET);
      ownerName(id);
      return [`id:${id}`, ...rest].join('/');
    });
    next = { ...next, viewer: { ...route.viewer, filters: { ...route.viewer.filters, repos, boards } } };
  }
  if (route.org || route.ownerId !== undefined) {
    if (route.ownerId === undefined && reusedOwners.has(route.org!.toLowerCase())) throw new Error(LEGACY_TARGET);
    const id = route.ownerId ?? ownerId(route.org!);
    if (!validId(id)) throw new Error(LEGACY_TARGET);
    next = { ...next, org: ownerName(id), ownerId: id };
  }
  if (route.repo || route.issue) {
    const full = route.repo ? `${route.repo.owner}/${route.repo.name}` : `${route.issue!.owner}/${route.issue!.repo}`;
    if (route.repositoryId === undefined && reusedRepositories.has(full.toLowerCase())) throw new Error(LEGACY_TARGET);
    const id = route.repositoryId ?? repositoryId(full);
    if (!validId(id)) throw new Error(LEGACY_TARGET);
    const [owner, name] = repositoryName(id).split('/');
    next = { ...next, repositoryId: id, ...(route.repo ? { repo: { ...route.repo, owner, name } } : {}), ...(route.issue ? { issue: { ...route.issue, owner, repo: name } } : {}) };
  }
  return next;
}

export function bindRouteTarget(route: Route): Route {
  const p = new URLSearchParams(targetQuery(route));
  if (route.viewer?.filters) route = { ...route, viewer: { ...route.viewer, filters: { ...route.viewer.filters, repos: route.viewer.filters.repos.map(repositoryFilter) } } };
  return { ...route, ...(p.has('ownerId') ? { ownerId: Number(p.get('ownerId')) } : {}), ...(p.has('repositoryId') ? { repositoryId: Number(p.get('repositoryId')) } : {}) };
}


export function targetHeaders(path: string, existing?: HeadersInit): Headers {
  const headers = new Headers(existing);
  if (!hasStableTargets()) return headers;
  const url = new URL(path, 'https://board.invalid');
  const org = url.searchParams.get('org');
  if (org) {
    const id = ownerId(org);
    if (id) headers.set('X-Github-Owner-Id', String(id));
  }
  const repo = /^\/api\/(?:repos|issues)\/(?:edit-options\/)?([^/]+)\/([^/]+)(?:\/|$)/.exec(url.pathname);
  if (repo) {
    const id = repositoryId(`${decodeURIComponent(repo[1])}/${decodeURIComponent(repo[2])}`);
    if (id) headers.set('X-Github-Repository-Id', String(id));
  }
  return headers;
}

export function repositoryFilter(value: string): string {
  if (value.startsWith('id:')) return value;
  const exact = repositoryId(value);
  if (exact) return reusedRepositories.has(value.toLowerCase()) ? value : `id:${exact}`;
  if (value.includes('/')) return value;
  const key = (name: string) => (name.split('/').pop() ?? name).replace(/\.example\.com$/i, '').toLowerCase();
  const matches = targets?.repositories?.filter(repo => key(repo.full_name) === key(value)) ?? [];
  return matches.length === 1 && !reusedRepositories.has(matches[0].full_name.toLowerCase()) ? `id:${matches[0].id}` : value;
}
export function repositoryFilterLabel(value: string): string {
  if (!value.startsWith('id:')) return value;
  try { return repositoryName(Number(value.slice(3))); } catch { return 'Unavailable repository'; }
}


export function issueRepositoryFilter(issue: { repo: string; htmlUrl: string }): string {
  try {
    const url = new URL(issue.htmlUrl);
    const match = /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+/.exec(url.pathname);
    if (url.hostname === 'github.com' && match) return repositoryFilter(`${match[1]}/${match[2]}`);
  } catch { /* Fixture rows can omit a complete GitHub URL. */ }
  return repositoryFilter(issue.repo);
}

/** Presentation only: resolution above remains the authority on whether a link opens. */
export function targetRefusal(route: Route, failure: string) {
  const candidates: { id: number; full_name: string }[] = [];
  if (failure === MISSING_TARGET) return {
    heading: 'This link is no longer available',
    reason: 'The GitHub account or repository in this link is no longer available with your current access.',
    candidates,
  };
  const names = route.viewer?.filters?.repos ?? [];
  const full = route.repo ? `${route.repo.owner}/${route.repo.name}` : route.issue ? `${route.issue.owner}/${route.issue.repo}` : undefined;
  const ownerNames = [route.ownerId === undefined ? route.org : undefined, ...(route.viewer?.filters?.boards ?? []).map(value => value.split('/')[0])];
  const key = (name: string) => (name.split('/').pop() ?? name).replace(/\.example\.com$/i, '').toLowerCase();
  const reused = ownerNames.some(name => name && reusedOwners.has(name.toLowerCase()))
    || [...names, ...(full ? [full] : [])].some(name => reusedRepositories.has(name.toLowerCase())
      || (!name.includes('/') && targets?.repositories?.some(repo => key(repo.full_name) === key(name) && reusedRepositories.has(repo.full_name.toLowerCase()))));
  if (reused) return {
    heading: 'This name has been reused',
    reason: 'This name now belongs to a different GitHub account or repository, so the old link cannot be opened safely.',
    candidates,
  };
  for (const name of names) {
    const matches = targets?.repositories?.filter(repo => name.includes('/') ? same(repo.full_name, name) : key(repo.full_name) === key(name)) ?? [];
    if (matches.length > 1) for (const repo of matches) if (!candidates.some(candidate => candidate.id === repo.id)) candidates.push(repo);
  }
  return candidates.length ? {
    heading: 'This link is ambiguous',
    reason: 'Several repositories you can access match the name in this old link.',
    candidates,
  } : {
    heading: 'This link no longer points anywhere you can open',
    reason: 'The board cannot match this old link to one GitHub account or repository you can access.',
    candidates,
  };
}
