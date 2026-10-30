import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient, GithubCredential } from '../generated/prisma/client';
import { GithubUserService, FINGERPRINT_TTL_MS } from './github-user.service';
import { CredentialCipher } from './github-credential-cipher';
import { githubContext, githubPrincipal, ownerQuery, type GithubPrincipal } from './github-principal';
import { buildOctokitClient, tokenFor } from '../sources/github-client';
import { githubOrgs } from '../config/github-orgs';
import { CapabilityRegistry } from '../capability/capability.registry';
import { GithubIssueDetailSource } from '../issue-detail/github-issue-detail.source';
import { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import type { IIssuesSource } from '../issues-metrics/issues-metrics.types';

const cipher = new CredentialCipher({ key: () => Buffer.alloc(32, 7) });
// `FEEDBACK_REPO` has no default since #1175 and `IssuesCacheService` builds
// the submission-visibility scope from it in its constructor.
const config = new ConfigService({ FEEDBACK_REPO: 'acme/board', BOOT_ALERT_REPO: 'acme/repo', BOOT_ALERT_REPO_ID: 42, GITHUB_TOKEN: 'deployment', GITHUB_WRITE_TOKEN: 'deployment-write', GITHUB_USER_APP_CLIENT_ID: 'test-id', GITHUB_USER_APP_CLIENT_SECRET: 'test-secret', BOARD_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64') });
function row(email: string): GithubCredential {
  const id = `sub-${email}`;
  return { ownerEmail: email, boardSub: id, githubUserId: id, githubLogin: email.split('@')[0], accessCipher: cipher.encrypt(email, `${id}:access`), refreshCipher: cipher.encrypt('refresh', `${id}:refresh`), version: email, accessExpiresAt: new Date(Date.now() + 3600000), refreshExpiresAt: new Date(Date.now() + 7200000), scopes: '', refreshLeaseUntil: null, signInAdmittedAt: null, revokedAt: null, createdAt: new Date(), updatedAt: new Date() };
}
const person = (email: string): GithubPrincipal => ({ key: email, email, login: email, token: email, owners: [{ login: 'acme', type: 'Organization' }], repositories: [], cache: new WeakMap() });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('discovers only the token installation intersection and stops serving lost access after the TTL', async () => {
  vi.useFakeTimers();
  const rows = new Map(['a@example.test','b@example.test'].map((email) => [`sub-${email}`, row(email)]));
  const db = { githubCredential: { findUnique: vi.fn(({ where }) => Promise.resolve(rows.get(where.githubUserId))) } } as unknown as PrismaClient;
  let removed = false;
  const wire: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const token = new Headers(init.headers).get('authorization')!;
    wire.push(token);
    const a = token.endsWith('a@example.test');
    const data = String(url).includes('/repositories')
      ? { total_count: a ? 2 : 1, repositories: (a ? [1,2] : [1]).map((id) => ({ id, name: `repo${id}`, full_name: `acme/repo${id}`, owner: { login: 'acme' }, permissions: { admin: a } })) }
      : { total_count: removed && a ? 0 : 1, installations: removed && a ? [] : [{ id: 10, account: { id: 10, login: 'acme', type: 'Organization' }, suspended_at: null }] };
    const response = new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: String(url) });
    return response;
  }));
  const service = new GithubUserService(config, db);
  const a = await service.principal('a@example.test', 'sub-a@example.test');
  const b = await service.principal('b@example.test', 'sub-b@example.test');
  expect(a.owners).toEqual([{ id: 10, login: 'acme', type: 'Organization' }]);
  expect(a.installations?.[0].account.id).toBe(10);
  expect(a.repositories).toHaveLength(2); expect(b.repositories).toHaveLength(1);
  expect(a.cache).not.toBe(b.cache);
  const cached = await service.principal('a@example.test', 'sub-a@example.test');
  expect(cached.cache).toBe(a.cache);
  await vi.advanceTimersByTimeAsync(FINGERPRINT_TTL_MS);
  const renewed = await service.principal('a@example.test', 'sub-a@example.test');
  expect(renewed.cache).toBe(a.cache); // Raw issue reads remain repository-bound.
  expect(renewed.permissionCache).not.toBe(a.permissionCache); // Projects/security/billing must re-read.
  removed = true;
  await vi.advanceTimersByTimeAsync(FINGERPRINT_TTL_MS);
  const lost = await service.principal('a@example.test', 'sub-a@example.test');
  expect(lost.owners).toEqual([]); expect(lost.repositories).toEqual([]); expect(lost.cache).not.toBe(a.cache);
  expect(wire).not.toContain('token deployment');
  const machine = await service.principal('a@example.test', 'sub-a@example.test', true);
  expect(machine.token).toBeNull(); expect(machine.owners).toEqual([]);
});

it('sends reads and writes from a singleton source as the acting person, and deployment work separately', async () => {
  const wire: { auth: string | null; method: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    wire.push({ auth: new Headers(init.headers).get('authorization'), method: init.method! });
    return new Response(JSON.stringify({ id: 42 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  const source = new GithubIssueDetailSource(config);
  for (const token of ['a','b']) await githubContext.run({ principal: { ...person(token), repositories: [{ id: 42, full_name: 'acme/repo', name: 'repo', owner: { login: 'acme' } }] } }, async () => {
    await source.setState('acme', 'repo', 1, 'closed');
    await buildOctokitClient(config).request('GET /user');
  });
  await source.setState('acme', 'repo', 1, 'closed');
  expect(wire.map((w) => w.auth)).toEqual(['token a','token a','token a','token b','token b','token b','token deployment-write','token deployment-write']);
  expect(wire.map((w) => w.method)).toEqual(['GET','PATCH','GET','GET','PATCH','GET','GET','PATCH']);
  githubContext.run({ principal: { ...person('unconnected'), token: null, owners: [] } }, () => {
    expect(githubOrgs(config)).toEqual([]);
    expect(() => tokenFor(config, 'read')).toThrow('Sign in with GitHub');
    expect(() => tokenFor(config, 'write')).toThrow('Sign in with GitHub');
  });
});

it('isolates capability refusals and 401 invalidation even for identical repo sets', () => {
  const registry = new CapabilityRegistry(config);
  const a = person('a'); const b = person('b');
  githubContext.run({ principal: a }, () => registry.recordSuccess('issue.labels'));
  githubContext.run({ principal: b }, () => {
    expect(registry.state('issue.labels').state).toBe('unknown');
    registry.invalidateAll('synthetic invalidation');
  });
  githubContext.run({ principal: a }, () => expect(registry.state('issue.labels').state).toBe('available'));
  expect(registry.state('issue.labels').state).toBe('unknown');
});

it('never serves a warm wide issue snapshot to a cold narrow read or its delayed refill', async () => {
  const source = { listIssues: vi.fn(async () => [{ title: githubPrincipal()?.key ?? 'deployment' }]) } as unknown as IIssuesSource;
  const cache = new IssuesCacheService(source, config);
  const a = person('wide'); const b = person('narrow');
  const wide = await githubContext.run({ principal: a }, () => cache.getIssues());
  const narrow = await githubContext.run({ principal: b }, () => cache.getIssues());
  expect(wide.issues[0].title).toBe('wide'); expect(narrow.issues[0].title).toBe('narrow');
  expect(narrow).not.toBe(wide);
  await githubContext.run({ principal: a }, () => { cache.dropCaches(); return cache.warmAfterWrite(); });
  expect(await githubContext.run({ principal: b }, () => cache.getIssues())).toBe(narrow);
});

it('personal Projects use the user root with a stable response alias and refuse mutation documents', () => {
  githubContext.run({ principal: { ...person('a'), owners: [{ login: 'a', type: 'User' }] } }, () => {
    expect(ownerQuery('query { organization(login:$owner){id} }', 'a')).toContain('organization:user(login:');
    expect(() => ownerQuery('mutation { organization(login:$owner){id} }', 'a')).toThrow();
  });
});
