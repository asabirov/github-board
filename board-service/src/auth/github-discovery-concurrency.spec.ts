import { setImmediate } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import { afterEach, expect, it, vi } from 'vitest';
import type { GithubCredential, PrismaClient } from '../generated/prisma/client';
import { GithubUserService, MIN_READ_HEADROOM_MS } from './github-user.service';

const email = 'discovery@example.test';
const subject = 'discovery-subject';
function harness() {
  const credential = { version: 'v1', githubUserId: '99', githubLogin: 'person' } as GithubCredential;
  const service = new GithubUserService(new ConfigService({ GITHUB_USER_APP_CLIENT_ID: 'test' }), {} as PrismaClient);
  vi.spyOn(service, 'credential').mockResolvedValue({ row: credential, token: 'synthetic' });
  const installation = (id: number, type = 'Organization', suspended_at: string | null = null) => ({
    id, account: { id, login: `owner${id}`, type }, suspended_at, app_slug: 'board-app', permissions: { issues: 'read' },
  });
  const events: string[] = [];
  const pending = new Map<string, (fail?: boolean) => void>();
  let lists = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const url = new URL(String(input));
    const match = url.pathname.match(/installations\/(\d+)\/repositories/);
    const response = (data: unknown, headers = {}) => {
      const result = new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
      Object.defineProperty(result, 'url', { value: url.href });
      return result;
    };
    if (!match) {
      lists++;
      return response({ total_count: 6, installations: [installation(1), installation(2), installation(3), installation(4), installation(5, 'Organization', '2026-01-01'), installation(6, 'User')] });
    }
    const id = Number(match[1]);
    const page = Number(url.searchParams.get('page') ?? 1);
    const key = `${id}:${page}`;
    events.push(`start ${key}`);
    await new Promise<void>((resolve, reject) => pending.set(key, (fail = false) => {
      pending.delete(key);
      events.push(`finish ${key}`);
      if (fail) reject(new Error('synthetic discovery failure')); else resolve();
    }));
    const next = new URL(url);
    next.searchParams.set('page', '2');
    return response({ total_count: 2, repositories: [{ id: id * 10 + page, full_name: `owner${id}/repo${page}`, permissions: { pull: true } }] },
      page === 1 ? { link: `<${next.href}>; rel="next"` } : {});
  }));
  return { service, events, pending, lists: () => lists };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('overlaps three installation walks, preserves pagination and identity order, and shares the credential lease', async () => {
  const h = harness();
  let settled = false;
  const read = h.service.principal(email, subject, false, MIN_READ_HEADROOM_MS).then((value) => { settled = true; return value; });
  const joined = h.service.principal(email, subject, false, MIN_READ_HEADROOM_MS);
  await setImmediate();
  expect(h.events).toEqual(['start 1:1', 'start 2:1', 'start 3:1']);
  expect(settled).toBe(false);
  for (const id of [3, 2, 1]) {
    h.pending.get(`${id}:1`)!();
    await setImmediate();
    expect(h.events.indexOf(`start ${id}:2`)).toBeGreaterThan(h.events.indexOf(`finish ${id}:1`));
    expect(h.pending.has('4:1')).toBe(false);
    h.pending.get(`${id}:2`)!();
    await setImmediate();
  }
  expect([...h.pending.keys()]).toEqual(['4:1']);
  expect(settled).toBe(false);
  h.pending.get('4:1')!();
  await setImmediate();
  h.pending.get('4:2')!();
  const principal = await read;
  expect(await joined).toBe(principal);
  expect(principal.owners.map((owner) => owner.login)).toEqual(['owner1', 'owner2', 'owner3', 'owner4']);
  expect(principal.repositories.map((repo) => repo.id)).toEqual([11, 12, 21, 22, 31, 32, 41, 42]);
  expect(principal.installations?.map((item) => [item.id, item.repositoryCount, item.suspended])).toEqual([
    [1, 2, false], [2, 2, false], [3, 2, false], [4, 2, false], [5, null, true],
  ]);
  const calls = h.events.length;
  expect((await h.service.principal(email, subject, false, MIN_READ_HEADROOM_MS)).key).toBe(principal.key);
  expect(h.lists()).toBe(1);
  expect(h.events).toHaveLength(calls);
});

it('drains a failed batch before refreshAccess finishes and does not cache partial access', async () => {
  const h = harness();
  const read = h.service.principal(email, subject);
  const rejected = expect(read).rejects.toThrow('synthetic discovery failure');
  await setImmediate();
  let refreshed = false;
  const refresh = h.service.refreshAccess(subject).then(() => { refreshed = true; });
  h.pending.get('1:1')!(true);
  await setImmediate();
  expect(refreshed).toBe(false);
  for (const id of [2, 3]) {
    h.pending.get(`${id}:1`)!();
    await setImmediate();
    h.pending.get(`${id}:2`)!();
    await setImmediate();
  }
  await rejected;
  await refresh;
  expect(h.events).not.toContain('start 4:1');
  const retry = h.service.principal(email, subject);
  const retryRejected = expect(retry).rejects.toThrow('synthetic discovery failure');
  await setImmediate();
  expect(h.lists()).toBe(2);
  for (const id of [1, 2, 3]) h.pending.get(`${id}:1`)!(true);
  await retryRejected;
});
