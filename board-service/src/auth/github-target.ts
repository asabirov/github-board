import { ConflictException, NotFoundException } from '@nestjs/common';
import type { GithubPrincipal } from './github-principal';

export function targetId(value: unknown): number {
  const id = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) throw new ConflictException('Select the GitHub destination again. This saved reference has no verified identity.');
  return id;
}

export function resolveOwner(person: GithubPrincipal, value: unknown): string {
  const id = targetId(value);
  const owner = person.owners.find(row => row.id === id);
  if (!owner) throw new NotFoundException('This GitHub account is no longer available with your current access.');
  return owner.login;
}

export function resolveRepository(person: GithubPrincipal, value: unknown): string {
  const id = targetId(value);
  const repo = person.repositories.find(row => row.id === id);
  if (!repo) throw new NotFoundException('This GitHub repository is no longer available with your current access.');
  return repo.full_name;
}

function uniqueNameId(rows: { id?: number; name: string }[], name: string): number {
  const matches = rows.filter(row => row.name.toLowerCase() === name.toLowerCase());
  if (!matches.length) throw new NotFoundException('This GitHub destination is no longer available with your current access.');
  if (matches.length !== 1) throw new ConflictException('This GitHub name is ambiguous. Select the destination by ID.');
  return targetId(matches[0].id);
}

interface TargetRequest {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}
export function resolveRequestTarget(request: TargetRequest, person: GithubPrincipal): void {
  // Fixture principals have no discovered account identities.
  if (!person.owners.some(owner => owner.id !== undefined)) return;
  const params = request.params;
  if (params?.owner && (params.repo || params.name)) {
    const id = request.headers?.['x-github-repository-id'] ?? request.query?.repositoryId ?? uniqueNameId(person.repositories.map(row => ({ id: row.id, name: row.full_name })), `${params.owner}/${params.repo || params.name}`);
    const fullName = resolveRepository(person, id);
    const [owner, repo] = fullName.split('/');
    params.owner = owner;
    params[params.repo ? 'repo' : 'name'] = repo;
  }
  const query = request.query;
  if (query?.org) {
    const id = request.headers?.['x-github-owner-id'] ?? query.ownerId ?? uniqueNameId(person.owners.map(row => ({ id: row.id, name: row.login })), String(query.org));
    const org = resolveOwner(person, id);
    Object.defineProperty(request, 'query', { configurable: true, value: { ...query, org } });
  }
}
