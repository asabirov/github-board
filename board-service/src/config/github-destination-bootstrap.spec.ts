import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubDestinationBootstrap } from './github-destination-bootstrap';
const { request, disconnect, events } = vi.hoisted(() => ({ request: vi.fn(), disconnect: vi.fn(async () => {}), events: [] as string[] }));
vi.mock('../sources/github-client', () => ({ buildOctokitClient: () => ({ request }) }));
vi.mock('../prisma', () => ({ createPrismaClient: () => ({
  githubDestination: { findUnique: async () => null, createMany: async () => { events.push('bind'); }, findUniqueOrThrow: async () => ({ repositoryId: 42n }) },
  $disconnect: disconnect,
}) }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe('destination background startup', () => {
  it('retries a destination failure with a stalled boot alert', async () => {
    vi.useFakeTimers();
    vi.stubEnv('FEEDBACK_REPO_ID', undefined);
    request.mockRejectedValue(new Error('GitHub down'));
    const config = new ConfigService({ FEEDBACK_REPO: 'o/r', GITHUB_STORE_DATABASE_URL: 'postgresql://localhost/test' });
    const service = new GithubDestinationBootstrap(config);
    const report = vi.fn(() => new Promise<void>(() => {}));
    expect(service.start(report)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(config.get('FEEDBACK_REPO_ID')).toBeUndefined();
    expect(report).toHaveBeenCalled();
    request.mockResolvedValue({ data: { id: 42, full_name: 'o/r' } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(config.get('FEEDBACK_REPO_ID')).toBe(42);
    await service.onModuleDestroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('reports a lasting 404 once and stops name requests across later retry ticks', async () => {
  vi.useFakeTimers();
  vi.stubEnv('FEEDBACK_REPO_ID', undefined);
  request.mockReset().mockRejectedValue({ status: 404 });
  const service = new GithubDestinationBootstrap(new ConfigService({ FEEDBACK_REPO: 'o/missing', GITHUB_STORE_DATABASE_URL: 'postgresql://localhost/test' }));
  const report = vi.fn(async () => {});
  service.start(report);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(report).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
  await service.onModuleDestroy();
});

it('pins without a database for the process lifetime and logs the limitation once', async () => {
  vi.useFakeTimers();
  vi.stubEnv('FEEDBACK_REPO_ID', undefined);
  request.mockReset().mockResolvedValue({ data: { id: 42, full_name: 'o/r' } });
  const log = vi.spyOn(Logger.prototype, 'log');
  const config = new ConfigService({ FEEDBACK_REPO: 'o/r' });
  const service = new GithubDestinationBootstrap(config);
  service.start(async () => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(config.get('FEEDBACK_REPO_ID')).toBe(42);
  expect(await service.bind('FEEDBACK_REPO', 99)).toBe(42);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(log.mock.calls.filter(([message]) => String(message).includes('not persisted'))).toHaveLength(1);
  expect(request).toHaveBeenCalledTimes(1);
  await service.onModuleDestroy();
  log.mockRestore();
});

it('waits for an in-flight destination attempt before disconnecting', async () => {
  vi.useFakeTimers();
  vi.stubEnv('FEEDBACK_REPO_ID', undefined);
  events.length = 0;
  disconnect.mockImplementation(async () => { events.push('disconnect'); });
  let release!: (value: unknown) => void;
  request.mockReset().mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const service = new GithubDestinationBootstrap(new ConfigService({ FEEDBACK_REPO: 'o/r', GITHUB_STORE_DATABASE_URL: 'postgresql://localhost/test' }));
  service.start(async () => {});
  await vi.advanceTimersByTimeAsync(0);
  const shutdown = service.onModuleDestroy();
  await Promise.resolve();
  expect(events).toEqual([]);
  release({ data: { id: 42, full_name: 'o/r' } });
  await shutdown;
  expect(events).toEqual(['bind', 'disconnect']);
  expect(vi.getTimerCount()).toBe(0);
});

it('backs transient failures off and never drains runtime errors on retry', async () => {
  vi.useFakeTimers();
  vi.stubEnv('FEEDBACK_REPO_ID', undefined);
  request.mockReset().mockRejectedValue({ status: 503 });
  const service = new GithubDestinationBootstrap(new ConfigService({ FEEDBACK_REPO: 'o/r', GITHUB_STORE_DATABASE_URL: 'postgresql://localhost/test' }));
  const report = vi.fn(async () => {});
  service.start(report);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(900_000);
  expect(request).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(request).toHaveBeenCalledTimes(5);
  expect(report).toHaveBeenCalledTimes(1);
  await service.onModuleDestroy();
});
