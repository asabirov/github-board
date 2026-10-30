import { channel } from 'node:diagnostics_channel';
import { ConfigService } from '@nestjs/config';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { buildOctokitClient } from './github-client';

const events: Record<string, unknown>[] = [];
const metrics = channel('board.github.request');
const collect = (event: unknown) => events.push(event as Record<string, unknown>);
metrics.subscribe(collect);
afterAll(() => metrics.unsubscribe(collect));
afterEach(() => { events.length = 0; vi.unstubAllGlobals(); });

function client(id: string) {
  const principal: GithubPrincipal = { key: id, githubUserId: id, email: `${id}@example.test`, login: id, token: `secret-${id}`, owners: [], repositories: [], cache: new WeakMap() };
  return githubContext.run({ principal }, () => buildOctokitClient(new ConfigService()));
}

it('counts conditional wire responses before ETag replay and separates people without exposing identity', async () => {
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const status = new Headers(init.headers).has('if-none-match') ? 304 : 200;
    return new Response(status === 304 ? null : '[]', { status, headers: { etag: '"v1"', 'content-type': 'application/json', 'x-ratelimit-remaining': '4999', 'x-ratelimit-used': '1', 'x-ratelimit-reset': '2000000000' } });
  });
  const alice = client('metrics-alice');
  await alice.request('GET /repos/private/project/issues');
  await alice.request('GET /repos/private/project/issues');
  await client('metrics-bob').request('GET /repos/private/project/issues');
  expect(events.map((e) => [e.source, e.resource, e.status])).toEqual([
    ['surface', 'core', 200], ['surface', 'core', 304], ['surface', 'core', 200],
  ]);
  expect(events[0].identity).toBe(events[1].identity);
  expect(events[0].identity).not.toBe(events[2].identity);
  expect(events[0]).toMatchObject({ remaining: 4999, used: 1, reset: 2000000000 });
  expect(JSON.stringify(events)).not.toMatch(/metrics-alice|metrics-bob|secret-|example.test|private|project/);
});

it('records search failures and GraphQL calls separately, without inventing point costs', async () => {
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(String(url).includes('/graphql') ? { data: { viewer: { login: 'hidden' } } } : { message: 'denied' }), {
    status: String(url).includes('/graphql') ? 200 : 403, headers: { 'content-type': 'application/json' },
  }));
  const octokit = client('metrics-failure');
  await expect(octokit.request('GET /search/issues', { q: 'secret' })).rejects.toThrow();
  await octokit.graphql('{ viewer { login } }');
  expect(events.map((e) => [e.resource, e.status, e.graphqlCost])).toEqual([['search', 403, undefined], ['graphql', 200, undefined]]);
});

it('counts transport failure without changing the rejection', async () => {
  vi.stubGlobal('fetch', async () => { throw new Error('synthetic network failure'); });
  await expect(client('metrics-network').request('GET /user')).rejects.toThrow('synthetic network failure');
  expect(events).toHaveLength(1);
  expect(events[0].status).toBe(0);
});

it('marks machine calls separately and records only explicitly returned GraphQL cost', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ data: { rateLimit: { cost: 4 } } }), { headers: { 'content-type': 'application/json' } }));
  await buildOctokitClient(new ConfigService({ GITHUB_TOKEN: 'synthetic-machine' })).graphql('{ rateLimit { cost } }');
  expect(events[0]).toMatchObject({ actor: 'machine', graphqlCost: 4 });
  await client('metrics-cost').graphql('{ rateLimit { cost } }');
  expect(events[1]).toMatchObject({ actor: 'person', graphqlCost: 4 });
});
