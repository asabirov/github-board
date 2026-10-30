import { describe, expect, it } from 'vitest';
import { resolveOwner, resolveRepository } from './github-target';
import type { GithubPrincipal } from './github-principal';
import { resolveRequestTarget } from './github-target';
import { ConfigService } from '@nestjs/config';
import { githubContext } from './github-principal';
import { feedbackScopeFrom } from './feedback-visibility';
import type { ExecutionContext } from '@nestjs/common';
import { GithubPrincipalGuard } from './github-principal.guard';
import type { GithubUserService } from './github-user.service';

const principal = (name = 'new/widgets', id = 42): GithubPrincipal => ({
  key: 'alice', email: 'alice@example.test', login: 'alice', token: 'token', cache: new WeakMap(),
  owners: [{ id: 7, login: name.split('/')[0], type: 'Organization' }],
  repositories: [{ id, full_name: name, name: name.split('/')[1], owner: { login: name.split('/')[0] } }],
});
describe('stable GitHub targets', () => {
  it('follows the same account after a rename', () => {
    expect(resolveOwner(principal(), 7)).toBe('new');
  });
  it('follows a repository rename and transfer by id', () => {
    expect(resolveRepository(principal('other/renamed'), 42)).toBe('other/renamed');
  });
  it('refuses deletion instead of selecting a replacement at the old name', () => {
    expect(() => resolveRepository(principal('old/widgets', 99), 42)).toThrow(/no longer available/);
  });
  it('refuses a legacy name without historical identity', () => {
    expect(() => resolveRepository(principal('old/widgets', 99), undefined)).toThrow(/Select/);
  });
  it('does not treat a client id as access', () => {
    expect(() => resolveOwner(principal(), 999)).toThrow(/no longer available/);
  });
});

it('resolves a stable route before the controller sees the target', () => {
  const request = { params: { owner: 'old', repo: 'widgets' }, query: {}, headers: { 'x-github-repository-id': '42' } };
  resolveRequestTarget(request, principal('other/renamed'));
  expect(request.params).toEqual({ owner: 'other', repo: 'renamed' });
});
it('accepts an unambiguous name-only request', () => {
  const request = { params: { owner: 'new', repo: 'widgets' }, query: {}, headers: {} };
  expect(() => resolveRequestTarget(request, principal())).not.toThrow();
});

it('keeps a singleton feedback privacy scope attached to the same repository after rename', () => {
  const scope = feedbackScopeFrom(new ConfigService({ FEEDBACK_REPO: 'old/widgets', FEEDBACK_REPO_ID: 42 }));
  githubContext.run({ principal: principal('new/renamed') }, () => {
    expect({ owner: scope.owner, repo: scope.repo }).toEqual({ owner: 'new', repo: 'renamed' });
  });
});

async function guardedTarget(person: GithubPrincipal, id: string) {
  const request = { user: { email: person.email, boardSub: 'alice' }, method: 'GET', path: '/api/issues/old/widgets/1', params: { owner: 'old', repo: 'widgets' }, query: {}, headers: { 'x-github-repository-id': id } };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  const github = { principal: async () => person } as unknown as GithubUserService;
  await githubContext.run({ principal: null }, () => new GithubPrincipalGuard(github, new ConfigService({})).canActivate(context));
  return request.params;
}
it.each(['old/renamed', 'other/widgets'])('the request guard follows the same repo id to %s', async fullName => {
  const [owner, repo] = fullName.split('/');
  expect(await guardedTarget(principal(fullName), '42')).toEqual({ owner, repo });
});
it('the request guard refuses a deleted repo id', async () => {
  const person = principal(); person.repositories = [];
  await expect(guardedTarget(person, '42')).rejects.toThrow(/no longer available/);
});
it('the request guard refuses reuse of the saved repository name by a different id', async () => {
  await expect(guardedTarget(principal('old/widgets', 99), '42')).rejects.toThrow(/no longer available/);
});

it('accepts documented API token repo and org requests without new headers', async () => {
  const person = principal('old/widgets');
  expect(await guardedTarget(person, undefined as unknown as string)).toEqual({ owner: 'old', repo: 'widgets' });
  const request = { query: { org: 'old' }, headers: {} };
  resolveRequestTarget(request, person);
  expect(request.query.org).toBe('old');
});
it('refuses ambiguous name-only API targets', () => {
  const person = principal();
  person.repositories.push({ ...person.repositories[0], id: 99 });
  expect(() => resolveRequestTarget({ params: { owner: 'new', repo: 'widgets' } }, person)).toThrow();
});
