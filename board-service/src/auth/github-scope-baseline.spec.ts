import { channel } from 'node:diagnostics_channel';
import { ConfigService } from '@nestjs/config';
import { afterEach, expect, it, vi } from 'vitest';
import type { GithubCredential, PrismaClient } from '../generated/prisma/client';
import { githubContext } from './github-principal';
import { GithubUserService, MIN_READ_HEADROOM_MS } from './github-user.service';
import { githubOrgs } from '../config/github-orgs';

vi.mock('@octokit/rest', async (original) => {
  const { Octokit } = await original<typeof import('@octokit/rest')>();
  return { Octokit: Octokit.defaults({ log: { debug() {}, info() {}, warn() {}, error() {} } }) };
});

const config = new ConfigService({ GITHUB_USER_APP_CLIENT_ID: 'test', GITHUB_ORGS: 'machine-only' });
const installation = (id: number, type = 'Organization', suspended_at: string | null = null) => ({ id, account: { id, login: type === 'User' ? `person${id}` : `org${id}`, type }, suspended_at, permissions: { issues: 'read' } });
const repository = (id: number) => ({ id, full_name: `org1/repo${id}`, name: `repo${id}`, owner: { login: 'org1' }, permissions: { pull: true } });
function service() {
  const service = new GithubUserService(config, {} as PrismaClient);
  vi.spyOn(service, 'credential').mockImplementation(async (boardSub?: string) => ({
    row: { version: 'v1', githubUserId: (boardSub ?? '').startsWith('alice') ? '99' : '100', githubLogin: boardSub } as GithubCredential,
    token: `${boardSub}@example.test`,
  }));
  return service;
}
function response(url: URL, data: unknown, headers: Record<string, string> = {}, status = 200) {
  const res = new Response(status === 304 ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  Object.defineProperty(res, 'url', { value: url.href });
  return res;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('keeps App organizations, own namespace and empty active owners independent of machine scope', async () => {
  const paths: string[] = [];
  let expectedToken = 'alice@example.test';
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    expect(new Headers(init.headers).get('authorization')).toBe(`token ${expectedToken}`);
    const url = new URL(String(input));
    paths.push(url.pathname);
    return response(url, url.pathname === '/user/installations'
      ? { total_count: 0, installations: [installation(1), installation(2), installation(3, 'Organization', '2026-01-01'), installation(99, 'User'), installation(100, 'User')] }
      : { total_count: 0, repositories: url.pathname.includes('/1/') ? [repository(8), repository(7), repository(8)] : [] });
  });
  const user = service();
  const alice = await user.principal('alice@example.test', 'alice');
  expect(alice.owners.map((o) => o.login)).toEqual(['org1', 'org2', 'person99']);
  expect(paths).not.toContain('/user/orgs');
  expect(paths).not.toContain('/user/installations/3/repositories');
  expect(paths).not.toContain('/user/installations/100/repositories');
  expect((alice as unknown as { scope: unknown }).scope).toEqual({ ownerIds: [1, 2, 99], repositoryIds: [7, 8] });
  githubContext.run({ principal: alice }, () => {
    // A person sees every owner their own Github App grants cover. The config
    // above holds `GITHUB_ORGS: 'machine-only'` and no owner pin at all, and
    // the line below is what the pins' retirement changed: with
    // `PROJECTS_OWNER: 'org1'` in the config this used to answer `['org1']`.
    expect(githubOrgs(config)).toEqual(['org1', 'org2', 'person99']);
  });
  expectedToken = 'bob@example.test';
  const bob = await user.principal('bob@example.test', 'bob');
  expect(bob.owners.map((o) => o.login)).toEqual(['org1', 'org2', 'person100']);
  expect(bob.cache).not.toBe(alice.cache);
  expect(bob.permissionCache).not.toBe(alice.permissionCache);
  expect(bob.key).not.toBe(alice.key);
  expect(githubOrgs(config)).toEqual(['machine-only']);
});

it('isolates people with identical grants and uses each person’s token', async () => {
  let expectedToken = 'alice@example.test';
  const tokens: string[] = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    const authorization = new Headers(init.headers).get('authorization');
    expect(authorization).toBe(`token ${expectedToken}`);
    tokens.push(authorization!);
    const url = new URL(String(input));
    return response(url, url.pathname === '/user/installations'
      ? { total_count: 1, installations: [installation(1)] }
      : { total_count: 1, repositories: [repository(7)] });
  });
  const user = service();
  const alice = await user.principal('alice@example.test', 'alice');
  expectedToken = 'bob@example.test';
  const bob = await user.principal('bob@example.test', 'bob');
  expect(bob.scope).toEqual(alice.scope);
  expect(bob.owners).toEqual(alice.owners);
  expect(bob.repositories).toEqual(alice.repositories);
  expect(bob.key).not.toBe(alice.key);
  expect(bob.cache).not.toBe(alice.cache);
  expect(bob.permissionCache).not.toBe(alice.permissionCache);
  expect(tokens).toEqual(['token alice@example.test', 'token alice@example.test', 'token bob@example.test', 'token bob@example.test']);
});

it.each([
  { name: 'empty', owners: 0, repoPages: 0, installationPages: 1, perCheck: 1 },
  { name: 'two people', owners: 1, repoPages: 1, installationPages: 1, perCheck: 2 },
  { name: 'narrow', owners: 1, repoPages: 1, installationPages: 1, perCheck: 2 },
  { name: 'two orgs plus own', owners: 3, repoPages: 1, installationPages: 1, perCheck: 4 },
  { name: 'broad', owners: 10, repoPages: 2, installationPages: 1, perCheck: 21 },
  { name: 'installation pagination', owners: 101, repoPages: 1, installationPages: 2, perCheck: 103 },
])('measures one active person-hour with two concurrent tabs: $name', async (shape) => {
  // Only Date is virtual: Octokit's timeout and gzip still use real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = Date.parse('2026-09-27T00:00:00Z');
  vi.setSystemTime(start);
  const events: { status: number; source: string; resource: string }[] = [];
  const metrics = channel('board.github.request');
  const collect = (value: unknown) => events.push(value as typeof events[number]);
  metrics.subscribe(collect);
  const people = shape.name === 'two people' ? ['alice', 'bob'] : ['alice'];
  let wire = 0;
  vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
    wire++;
    const url = new URL(String(input));
    const page = Number(url.searchParams.get('page') ?? 1);
    const listing = url.pathname === '/user/installations';
    const pages = listing ? shape.installationPages : shape.repoPages;
    const next = new URL(url); next.searchParams.set('page', String(page + 1));
    const data = listing
      ? { total_count: 0, installations: Array.from({ length: shape.owners }, (_, i) => installation(i + 1, shape.name === 'two orgs plus own' && i === 2 ? 'User' : 'Organization')).map((item) => item.account.type === 'User' ? installation(99, 'User') : item).slice((page - 1) * 100, page * 100) }
      : { total_count: 0, repositories: [repository(Number(url.pathname.split('/')[3]) * 1000 + page)] };
    const etag = `"${shape.name}-${url.pathname}-${page}"`;
    const status = new Headers(init.headers).get('if-none-match') === etag ? 304 : 200;
    return response(url, data, { etag, ...(page < pages ? { link: `<${next.href}>; rel="next"` } : {}) }, status);
  });
  try {
    const user = service();
    for (let second = 0; second < 3600; second += 20) {
      vi.setSystemTime(start + second * 1000);
      await Promise.all(people.flatMap((person) => [user.principal(`${person}@example.test`, person, false, MIN_READ_HEADROOM_MS), user.principal(`${person}@example.test`, person, false, MIN_READ_HEADROOM_MS)]));
    }
    expect(wire).toBe(shape.perCheck * 180 * people.length);
    expect(events).toHaveLength(wire);
    expect(events.every((e) => e.source === 'discovery' && e.resource === 'core')).toBe(true);
    expect(events.filter((e) => e.status === 200)).toHaveLength(shape.perCheck * people.length);
    expect(events.filter((e) => e.status === 304)).toHaveLength(shape.perCheck * 179 * people.length);
    if (process.env.BOARD_MEASURE_GITHUB === '1') console.log(JSON.stringify({ shape: shape.name, activePersonHours: people.length, tabsPerPerson: 2, discoveries: 180 * people.length, requests: wire, callsPerActivePersonHour: wire / people.length, full: shape.perCheck * people.length, notModified: shape.perCheck * 179 * people.length, search: 0, graphql: 0 }));
  } finally { metrics.unsubscribe(collect); }
});
