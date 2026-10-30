import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as destinations from './github-destination';

beforeEach(() => { for (const key of ['FEEDBACK_REPO_ID', 'BOOT_ALERT_REPO_ID']) vi.stubEnv(key, undefined); });
afterEach(() => vi.unstubAllEnvs());
const logger = () => ({ log: vi.fn(), error: vi.fn() });
const memory = () => {
  const ids = new Map<string, number>();
  return {
    read: async (key: string) => ids.get(key),
    bind: async (key: string, id: number) => { if (!ids.has(key)) ids.set(key, id); return ids.get(key)!; },
  };
};

describe('configured repository boot migration', () => {
  it.each([new Error('GitHub unreachable')])('keeps boot available on a failed destination and retries it', async error => {
    const config = new ConfigService({ FEEDBACK_REPO: 'o/feedback', BOOT_ALERT_REPO: 'o/alerts' });
    let unavailable = true;
    const client = { request: async (_route: unknown, args: { repo: string }) => {
      if (args.repo === 'feedback' && unavailable) throw error;
      return { data: { id: args.repo === 'feedback' ? 42 : 44, full_name: `o/${args.repo}` } };
    } };
    const log = logger();
    const store = memory();
    await expect(destinations.initializeDestinations(config, client as never, log, store)).resolves.toBe(false);
    expect(config.get('FEEDBACK_REPO_ID')).toBeUndefined();
    expect(config.get('BOOT_ALERT_REPO_ID')).toBe(44);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('FEEDBACK_REPO'));
    unavailable = false;
    await destinations.initializeDestinations(config, client as never, log, store);
    expect(config.get('FEEDBACK_REPO_ID')).toBe(42);
  });
  it('follows a returned 301 to the numeric repository identity', async () => {
    const request = vi.fn(async (route: string) => route === 'GET /repos/{owner}/{repo}'
      ? { status: 301, headers: { location: 'https://api.github.com/repositories/42' }, data: { message: 'Moved Permanently' } }
      : { status: 200, data: { id: 42, full_name: 'old/renamed' } });
    expect(await destinations.repositoryAtName({ request } as never, 'old/name')).toBe(42);
  });
  it('keeps a persisted id across boots when the name is reused', async () => {
    const store = memory();
    const first = new ConfigService({ FEEDBACK_REPO: 'o/feedback' });
    await destinations.initializeDestinations(first, { request: async () => ({ data: { id: 42, full_name: 'o/feedback' } }) } as never, logger(), store);
    vi.stubEnv('FEEDBACK_REPO_ID', undefined);
    const next = new ConfigService({ FEEDBACK_REPO: 'o/feedback' });
    const log = logger();
    await destinations.initializeDestinations(next, { request: async () => ({ data: { id: 99, full_name: 'o/feedback' } }) } as never, log, store);
    expect(next.get('FEEDBACK_REPO_ID')).toBe(42);
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/42.*99/));
  });
  it('uses explicit ids without requiring GitHub or storage availability', async () => {
    const config = new ConfigService({ FEEDBACK_REPO: 'old/name', FEEDBACK_REPO_ID: 77 });
    const store = memory();
    await store.bind('FEEDBACK_REPO', 42);
    await destinations.initializeDestinations(config, { request: async () => { throw new Error('offline'); } } as never, logger(), store);
    expect(destinations.destinationId(config, 'FEEDBACK_REPO')).toBe(77);
  });
});

it('restores a persisted identity even when GitHub is down on a later boot', async () => {
  const store = memory();
  await store.bind('FEEDBACK_REPO', 42);
  const config = new ConfigService({ FEEDBACK_REPO: 'old/name' });
  expect(await destinations.initializeDestinations(config, { request: async () => { throw new Error('offline'); } }, logger(), store)).toBe(false);
  expect(config.get('FEEDBACK_REPO_ID')).toBe(42);
});

it.each(['https://attacker.example/repositories/42', 'https://api.github.com/repos/new/name'])('refuses an unverified redirect %s', async location => {
  const request = vi.fn().mockResolvedValue({ status: 301, headers: { location }, data: { message: 'Moved Permanently' } });
  await expect(destinations.repositoryAtName({ request }, 'old/name')).rejects.toThrow(/redirect could not be verified/);
  expect(request).toHaveBeenCalledTimes(1);
});

it('refuses and alerts on a cross-owner redirect before first binding', async () => {
  const request = vi.fn(async (route: string) => route === 'GET /repos/{owner}/{repo}'
    ? { status: 301, headers: { location: 'https://api.github.com/repositories/42' }, data: {} }
    : { status: 200, data: { id: 42, full_name: 'other/name' } });
  const config = new ConfigService({ FEEDBACK_REPO: 'old/name' });
  const store = memory();
  const log = logger();
  await destinations.initializeDestinations(config, { request } as never, log, store);
  expect(config.get('FEEDBACK_REPO_ID')).toBeUndefined();
  expect(await store.read('FEEDBACK_REPO')).toBeUndefined();
  expect(log.error).toHaveBeenCalledWith(expect.stringContaining('owner'));
});
