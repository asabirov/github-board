import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { githubContext, type GithubPrincipal } from './github-principal';
import { OwnerRenameController } from './owner-rename.controller';
import { buildOctokitClient } from '../sources/github-client';

vi.mock('../sources/github-client', () => ({ buildOctokitClient: vi.fn() }));

const config = {} as ConfigService;

/** One person, holding the repositories the board serves under the name the
 *  organisation has today. */
function person(overrides: Partial<GithubPrincipal> = {}): GithubPrincipal {
  return {
    key: 'k',
    email: 'octocat@example.com',
    login: 'octocat',
    token: 'ghu_person',
    owners: [{ login: 'acme', type: 'Organization' }],
    repositories: [
      { id: 101, full_name: 'acme/board', name: 'board', owner: { login: 'acme' } },
      { id: 102, full_name: 'acme/acme', name: 'acme', owner: { login: 'acme' } },
    ],
    cache: new WeakMap(),
    ...overrides,
  };
}

/** A Github that serves the rename redirect for this board's repositories and
 *  404s everything else — what the live API does, quoted in `owner-rename.ts`. */
function github(moved: Record<string, { id: number; owner: string }>) {
  // Two arguments, the way `octokit.request` is really called: the route
  // template first, the parameters that fill it second. A mock that read the
  // first argument as the parameters would answer 404 to everything and pass
  // every negative case in this file while proving none of them.
  const request = vi.fn(async (route: string, { owner, repo }: { owner: string; repo: string }) => {
    expect(route).toBe('GET /repos/{owner}/{repo}');
    const hit = moved[`${owner}/${repo}`];
    if (!hit) throw Object.assign(new Error('Not Found'), { status: 404 });
    return { data: { id: hit.id, owner: { login: hit.owner } } };
  });
  vi.mocked(buildOctokitClient).mockReturnValue({ request } as never);
  return request;
}

const ask = (principal: GithubPrincipal | null, login: string) =>
  githubContext.run({ principal }, () => new OwnerRenameController(config).owner(login));

describe('GET /api/auth/owners/:login', () => {
  it('names where a renamed organisation went', async () => {
    github({
      'old-org/board': { id: 101, owner: 'acme' },
      'old-org/acme': { id: 102, owner: 'acme' },
    });
    expect(await ask(person(), 'old-org')).toEqual({ login: 'old-org', renamedTo: 'acme' });
  });

  it('claims nothing for an organisation this person simply cannot reach', async () => {
    github({});
    expect(await ask(person(), 'private-org')).toEqual({ login: 'private-org', renamedTo: null });
  });

  it('claims nothing for a login that never existed', async () => {
    github({});
    expect(await ask(person(), 'zzq-never-existed-org')).toEqual({
      login: 'zzq-never-existed-org',
      renamedTo: null,
    });
  });

  it('answers a body rather than throwing when there is no Github on the session', async () => {
    const request = github({});
    // `githubPrincipal` throws on an unresolved context, and a refusal screen
    // meeting a 500 here would have nothing better to say than it already does.
    await expect(ask(null, 'acme')).resolves.toEqual({ login: 'acme', renamedTo: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('answers a body rather than throwing when this person holds no token', async () => {
    const request = github({});
    expect(await ask(person({ token: null }), 'acme')).toEqual({ login: 'acme', renamedTo: null });
    expect(request).not.toHaveBeenCalled();
  });

  it('survives a Github that refuses every ask', async () => {
    vi.mocked(buildOctokitClient).mockReturnValue({
      request: vi.fn(async () => { throw new Error('socket hang up'); }),
    } as never);
    expect(await ask(person(), 'acme')).toEqual({ login: 'acme', renamedTo: null });
  });

  it('asks Github about nothing at all for a login off an address bar', async () => {
    const request = github({});
    expect(await ask(person(), '..')).toEqual({ login: '..', renamedTo: null });
    expect(request).not.toHaveBeenCalled();
  });
});
