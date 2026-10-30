import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Octokit } from '@octokit/rest';
import type { GithubCredential, PrismaClient } from '../generated/prisma/client';
import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { CredentialCipher } from '../auth/github-credential-cipher';
import { FINGERPRINT_TTL_MS, GithubUserService } from '../auth/github-user.service';
import { GithubIssuesSource } from '../issues-metrics/github-issues.source';
import { buildOctokitClient } from './github-client';
import { GithubEtagStore, withGithubEtags } from './github-etag';

interface Wire { method: string; path: string; auth: string | null; ifNoneMatch: string | null; status: number }
interface Reply { body: unknown; raw?: string; status?: number; headers?: Record<string, string>; etag?: boolean }

let sequence = 0;
const unique = (name: string) => `${name}-${sequence++}`;

/** A Github that tags each answer with an ETag of its bytes and answers 304 to
 *  a request already holding it, with no body and none of the 200's own
 *  headers, so a replay that leaned on the 304 for either would show. */
function github(answer: (url: URL, auth: string | null) => Reply): Wire[] {
  const wire: Wire[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(String(input));
    const sent = new Headers(init.headers);
    const auth = sent.get('authorization');
    const reply = answer(url, auth);
    const text = reply.raw ?? JSON.stringify(reply.body);
    const etag = reply.etag === false ? undefined : `W/"${createHash('sha1').update(text).digest('hex')}"`;
    const ifNoneMatch = sent.get('if-none-match');
    const status = reply.status ?? (etag && ifNoneMatch === etag ? 304 : 200);
    wire.push({ method: init.method ?? 'GET', path: url.pathname + url.search, auth, ifNoneMatch, status });
    const response = new Response(status === 304 ? null : text, {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-github-request-id': String(wire.length),
        ...(etag ? { etag } : {}),
        ...(status === 304 ? {} : reply.headers),
      },
    });
    // paginate reads the response URL back for a list that counts its items.
    Object.defineProperty(response, 'url', { value: String(input) });
    return response;
  }));
  return wire;
}

const config = (token = 'deployment') => new ConfigService({ GITHUB_TOKEN: token });
function person(id: string): GithubPrincipal {
  return { githubUserId: id, key: id, email: `${id}@example.test`, login: id, token: `token-of-${id}`, owners: [], repositories: [], cache: new WeakMap(), permissionCache: new WeakMap() };
}
function as<T>(who: GithubPrincipal, read: (client: Octokit) => Promise<T>): Promise<T> {
  return githubContext.run({ principal: who }, () => read(buildOctokitClient(config())));
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('conditional Github REST reads (#1007)', () => {
  it('answers a 304 with the stored 200, and sends the ETag only for the same person and the exact URL', async () => {
    const a = person(unique('a'));
    const b = person(unique('b'));
    const wire = github((url, auth) => ({ body: [{ number: 1, seenBy: auth, perPage: url.searchParams.get('per_page') }] }));
    const read = (who: GithubPrincipal, perPage = 100) =>
      as(who, (c) => c.request('GET /repos/{owner}/{repo}/issues', { owner: 'acme', repo: 'r', per_page: perPage }));

    const first = await read(a);
    const again = await read(a);
    expect(wire.map((w) => w.status)).toEqual([200, 304]);
    expect(wire[1].ifNoneMatch).toBe(first.headers.etag);
    expect(again.status).toBe(200);
    expect(again.data).toEqual([{ number: 1, seenBy: `token token-of-${a.githubUserId}`, perPage: '100' }]);

    // Another page size is another resource.
    await read(a, 50);
    expect(wire[2]).toMatchObject({ ifNoneMatch: null, status: 200 });
    // Another person asks the same URL with nothing held, and gets their own.
    const theirs = await read(b);
    expect(wire[3]).toMatchObject({ ifNoneMatch: null, status: 200 });
    expect(theirs.data).toEqual([{ number: 1, seenBy: `token token-of-${b.githubUserId}`, perPage: '100' }]);
    // So does a deployment token, which is nobody's.
    await buildOctokitClient(config(unique('deployment'))).request('GET /repos/{owner}/{repo}/issues', { owner: 'acme', repo: 'r', per_page: 100 });
    expect(wire[4]).toMatchObject({ ifNoneMatch: null, status: 200 });
  });

  it('follows the stored Link header through paginate, sending each page its own ETag', async () => {
    const who = person(unique('pages'));
    const next = 'https://api.github.com/repositories/7/issues?state=all&per_page=2&page=2';
    const wire = github((url) => url.searchParams.get('page') === '2'
      ? { body: [{ number: 3 }] }
      : { body: [{ number: 1 }, { number: 2 }], headers: { link: `<${next}>; rel="next"` } });
    const all = () => as(who, (c) => c.paginate('GET /repos/{owner}/{repo}/issues', { owner: 'acme', repo: 'r', state: 'all', per_page: 2 }));

    const first = await all();
    const again = await all();
    expect(first.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(again).toEqual(first);
    expect(wire.map((w) => `${w.status} ${w.path}`)).toEqual([
      '200 /repos/acme/r/issues?state=all&per_page=2',
      '200 /repositories/7/issues?state=all&per_page=2&page=2',
      '304 /repos/acme/r/issues?state=all&per_page=2',
      '304 /repositories/7/issues?state=all&per_page=2&page=2',
    ]);
    expect(wire[2].ifNoneMatch).not.toBe(wire[3].ifNoneMatch);
  });

  it('reads in full when the resource changed, and forgets an answer Github sent without an ETag', async () => {
    const who = person(unique('changes'));
    let body: unknown = [{ number: 1 }];
    let tagged = true;
    const wire = github(() => ({ body, etag: tagged }));
    const read = async () => (await as(who, (c) => c.request('GET /repos/{owner}/{repo}/labels', { owner: 'acme', repo: 'r' }))).data;

    await read();
    body = [{ number: 1 }, { number: 2 }];
    expect(await read()).toEqual([{ number: 1 }, { number: 2 }]);
    expect(await read()).toEqual([{ number: 1 }, { number: 2 }]);
    expect(wire.map((w) => w.status)).toEqual([200, 200, 304]);

    tagged = false;
    body = [{ number: 3 }];
    expect(await read()).toEqual([{ number: 3 }]);
    tagged = true;
    await read();
    expect(wire.slice(3).map((w) => [w.status, w.ifNoneMatch])).toEqual([[200, expect.any(String)], [200, null]]);
  });

  it('keeps the ETag and its body together: a read whose entry is evicted in flight is still answered', async () => {
    const store = new GithubEtagStore(64 * 1024);
    let crowd = false;
    const wire = github(() => {
      // Sixteen other answers the size of a sixteenth of the store push the
      // one this read holds out of it while the read is at Github.
      if (crowd) for (let i = 0; i < 17; i++) store.put(`filler-${i}`, { etag: 'x', blob: Buffer.alloc(0), bytes: 4096 });
      return { body: { name: 'r', size: 1 } };
    });
    const client = withGithubEtags(new Octokit({ auth: 'solo' }), unique('solo'), store);
    const read = () => client.request('GET /repos/{owner}/{repo}', { owner: 'acme', repo: 'r' });

    await read();
    crowd = true;
    const answered = await read();
    crowd = false;
    expect(wire[1].status).toBe(304);
    expect(answered.data).toEqual({ name: 'r', size: 1 });
    // Gone from the store, so the next read asks without an ETag rather than
    // sending one it holds no body for.
    await read();
    expect(wire[2]).toMatchObject({ ifNoneMatch: null, status: 200 });
  });

  it('hands every caller its own copy of the body', async () => {
    const who = person(unique('copies'));
    github(() => ({ body: [{ number: 1, labels: ['bug'] }] }));
    const read = async () => (await as(who, (c) => c.request('GET /repos/{owner}/{repo}/issues', { owner: 'acme', repo: 'r' }))).data as unknown as { labels: string[] }[];

    (await read())[0].labels.push('edited by the first caller');
    (await read())[0].labels.push('edited by the second');
    expect(await read()).toEqual([{ number: 1, labels: ['bug'] }]);
  });

  it('lays the 304\'s own headers over the stored ones, and keeps the stored rest', async () => {
    const who = person(unique('headers'));
    github(() => ({ body: { total_count: 0, workflow_runs: [] }, headers: { 'x-kept': 'from the 200' } }));
    const read = () => as(who, (c) => c.request('GET /repos/{owner}/{repo}/actions/runs', { owner: 'acme', repo: 'r', per_page: 1 }));

    const first = await read();
    const again = await read();
    expect(first.headers['x-github-request-id']).toBe('1');
    expect(again.headers['x-github-request-id']).toBe('2');
    expect(again.headers['x-kept']).toBe('from the 200');
    expect(again.headers.etag).toBe(first.headers.etag);
  });

  it('still answers a body it cannot keep, and does not condition the next read on it', async () => {
    const who = person(unique('bigint'));
    // Past 2^53, so Octokit's parser hands back a BigInt, which JSON cannot write.
    const wire = github(() => ({ body: null, raw: '[{"id":12345678901234567890}]' }));
    const read = async () => (await as(who, (c) => c.request('GET /repos/{owner}/{repo}/labels', { owner: 'acme', repo: 'r' }))).data as unknown as { id: unknown }[];

    expect(typeof (await read())[0].id).toBe('bigint');
    expect(typeof (await read())[0].id).toBe('bigint');
    expect(wire.map((w) => [w.status, w.ifNoneMatch])).toEqual([[200, null], [200, null]]);
  });

  it('conditions nothing but a GET, and a refusal is still the refusal', async () => {
    const who = person(unique('writes'));
    const wire = github((url) => url.pathname.endsWith('/readme') ? { body: { message: 'Not Found' }, status: 404 } : { body: { data: { viewer: { login: 'x' } } } });
    await as(who, async (c) => {
      for (let i = 0; i < 2; i++) {
        await c.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', { owner: 'acme', repo: 'r', issue_number: 1, state: 'closed' });
        await c.graphql('{ viewer { login } }');
        // The README reader's own 404 branch is what says "absent", so the
        // refusal has to reach it as one.
        await expect(c.request('GET /repos/{owner}/{repo}/readme', { owner: 'acme', repo: 'r' })).rejects.toMatchObject({ status: 404 });
      }
    });
    expect(wire.map((w) => `${w.method} ${w.status} ${w.ifNoneMatch}`)).toEqual([
      'PATCH 200 null', 'POST 200 null', 'GET 404 null',
      'PATCH 200 null', 'POST 200 null', 'GET 404 null',
    ]);
  });
});

describe('readers see the same answer through a 304 (#1007)', () => {
  // `FEEDBACK_REPO` has no default since #1175 and the ingest builds the
  // submission-visibility scope from it; a case that means another value passes
  // its own.
  const cfg = (vars: Record<string, string>) =>
    ({ get: (k: string, d?: unknown) => ({ FEEDBACK_REPO: 'acme/board', ...vars })[k] ?? d }) as unknown as ConfigService;
  const ghIssue = (number: number, state: 'open' | 'closed' = 'open') => ({
    number, title: `Issue ${number}`, html_url: `https://github.com/acme/x/issues/${number}`, state,
    created_at: '2026-07-24T00:00:00Z', closed_at: state === 'closed' ? '2026-07-25T00:00:00Z' : null,
    user: { login: 'someone' }, assignees: [], labels: [], milestone: null, body: '',
  });

  it('the issue ingest reads every issue back from an all-304 refresh, and pays only for the repo that changed', async () => {
    let designSystem = [ghIssue(2, 'closed')];
    const next = 'https://api.github.com/repositories/1/issues?state=all&per_page=100&page=2';
    const wire = github((url) => {
      if (url.pathname === '/orgs/acme/repos') {
        return { body: [
          { name: 'acme', archived: false, fork: false, has_issues: true },
          { name: 'design-system', archived: false, fork: false, has_issues: true },
        ] };
      }
      if (url.pathname === '/repos/acme/acme/issues') return { body: [ghIssue(1)], headers: { link: `<${next}>; rel="next"` } };
      if (url.pathname === '/repositories/1/issues') return { body: [ghIssue(3)] };
      if (url.pathname === '/repos/acme/design-system/issues') return { body: designSystem };
      return { body: [] };
    });
    const source = new GithubIssuesSource(cfg({ GITHUB_TOKEN: unique('ingest'), GITHUB_ORGS: 'acme' }));
    const read = async () => {
      const from = wire.length;
      const issues = (await source.listIssues()).map((i) => `${i.repo}#${i.number}:${i.state}`).sort();
      return { issues, wire: wire.slice(from) };
    };

    const cold = await read();
    expect(cold.issues).toEqual(['acme#1:open', 'acme#3:open', 'design-system#2:closed']);
    const warm = await read();
    expect(warm.issues).toEqual(cold.issues);
    expect(warm.wire.map((w) => w.status)).toEqual(cold.wire.map(() => 304));

    designSystem = [ghIssue(2, 'closed'), ghIssue(4)];
    const changed = await read();
    expect(changed.issues).toEqual(['acme#1:open', 'acme#3:open', 'design-system#2:closed', 'design-system#4:open']);
    expect(changed.wire.filter((w) => w.status === 200).map((w) => w.path)).toEqual(['/repos/acme/design-system/issues?state=all&per_page=100']);
  });

  it('an access check that finds nothing changed costs only 304s and yields the same principal', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const email = `${unique('person')}@example.test`;
    const cipher = new CredentialCipher({ key: () => Buffer.alloc(32, 7) });
    const row: GithubCredential = {
      ownerEmail: email, boardSub: `sub-${email}`, githubUserId: `sub-${email}`, githubLogin: 'person',
      accessCipher: cipher.encrypt(email, `sub-${email}:access`), refreshCipher: cipher.encrypt('refresh', `sub-${email}:refresh`),
      version: 'v1', accessExpiresAt: new Date(Date.now() + 3600000), refreshExpiresAt: new Date(Date.now() + 7200000),
      scopes: '', refreshLeaseUntil: null, signInAdmittedAt: null, revokedAt: null, createdAt: new Date(), updatedAt: new Date(),
    };
    const db = { githubCredential: { findUnique: vi.fn(() => Promise.resolve(row)) } } as unknown as PrismaClient;
    const userConfig = new ConfigService({ GITHUB_USER_APP_CLIENT_ID: 'test-id', GITHUB_USER_APP_CLIENT_SECRET: 'test-secret', BOARD_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64') });
    const wire = github((url) => url.pathname.endsWith('/repositories')
      ? { body: { total_count: 1, repositories: [{ id: 1, name: 'repo1', full_name: 'acme/repo1', owner: { login: 'acme' }, permissions: { admin: false } }] } }
      : { body: { total_count: 1, installations: [{ id: 10, account: { id: 10, login: 'acme', type: 'Organization' }, suspended_at: null }] } });
    const service = new GithubUserService(userConfig, db);

    const first = await service.principal(email, `sub-${email}`);
    vi.setSystemTime(Date.now() + FINGERPRINT_TTL_MS);
    const renewed = await service.principal(email, `sub-${email}`);
    expect(wire.map((w) => w.status)).toEqual([200, 200, 304, 304]);
    expect(renewed.repositories).toEqual(first.repositories);
    expect(renewed.repositories).toHaveLength(1);
    // The same fingerprint, so the check changes nothing the browser keys on.
    expect(renewed.key).toBe(first.key);
    expect(renewed.expiresAt).toBeGreaterThan(first.expiresAt!);
  });
});

describe('what the store holds and says', () => {
  const entry = (bytes: number) => ({ etag: 'e', blob: Buffer.alloc(0), bytes });

  it('evicts the least recently used answer first, and keeps none larger than a sixteenth of the whole', () => {
    const store = new GithubEtagStore(16_000);
    for (let i = 0; i < 17; i++) store.put(`k${i}`, entry(900));
    expect(store.bytes).toBe(15_300);
    store.take('k0');
    store.put('k17', entry(900));
    expect(store.take('k1')).toBeUndefined();
    expect(store.take('k0')).toBeDefined();
    expect(store.bytes).toBeLessThanOrEqual(16_000);
    store.put('k0', entry(1001));
    expect(store.take('k0')).toBeUndefined();
  });

  it('logs once a minute how many reads came back 304, and nothing in a minute without reads', () => {
    vi.useFakeTimers();
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const store = new GithubEtagStore();
    store.count(true);
    store.count(true);
    store.count(false);
    expect(log).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('2 answered 304 Not Modified');
    expect(String(log.mock.calls[0][0])).toContain('1 read in full');
    vi.advanceTimersByTime(120_000);
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
