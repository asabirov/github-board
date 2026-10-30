import { afterEach, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client';
import { PrismaIssueStore, type StoreRead } from './issue-store';

const repo = { id: 101, full: 'org/repo' };
const answer: StoreRead = { served: new Map([[101, []]]), liveOwners: new Set(['org']) };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('gives a queued read its query budget after acquiring a slot and logs both durations', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const releases: ((value: StoreRead) => void)[] = [];
  const transaction = vi.fn(() => new Promise<StoreRead>((resolve) => releases.push(resolve)));
  const store = new PrismaIssueStore({ $transaction: transaction } as unknown as PrismaClient, 3_600_000);
  const first = store.read([repo]).catch(() => null);
  const second = store.read([repo]).catch(() => null);
  const third = store.read([repo]);
  let settled = false;
  void third.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(3_500);
  expect(settled).toBe(false);
  releases[0](answer);
  releases[1](answer);
  await vi.advanceTimersByTimeAsync(2_500);
  releases[2](answer);
  expect(await third).toEqual(answer);
  expect(log).toHaveBeenCalledWith(expect.stringMatching(/queue wait 3500 ms, query 2500 ms/));
  await Promise.all([first, second]);
});

it('bounds stalled work, removes expired waiters and recovers both slots after settlement', async () => {
  vi.useFakeTimers();
  const releases: ((value: StoreRead) => void)[] = [];
  const transaction = vi.fn(() => new Promise<StoreRead>((resolve) => releases.push(resolve)));
  const store = new PrismaIssueStore({ $transaction: transaction } as unknown as PrismaClient, 3_600_000);
  const reads = [store.read([repo]), store.read([repo])].map((read) => read.catch((err: Error) => err));
  await vi.advanceTimersByTimeAsync(3_001);
  expect(await Promise.race([reads[0], Promise.resolve('still waiting')])).toBeInstanceOf(Error);
  const queued = store.read([repo]).catch((err: Error) => err);
  await vi.advanceTimersByTimeAsync(10_001);
  expect(await Promise.race([queued, Promise.resolve('still waiting')])).toBeInstanceOf(Error);
  expect(transaction).toHaveBeenCalledTimes(2);
  releases[0](answer);
  releases[1](answer);
  await vi.advanceTimersByTimeAsync(0);
  expect(transaction).toHaveBeenCalledTimes(2);
  const fresh = [store.read([repo]), store.read([repo])];
  expect(transaction).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(2_999);
  releases[2](answer);
  releases[3](answer);
  expect(await Promise.all(fresh)).toEqual([answer, answer]);
});

it('warns for a slow query without logging routine reads at INFO', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  const transaction = vi.fn(() => new Promise<StoreRead>((resolve) => setTimeout(() => resolve(answer), 2_100)));
  const store = new PrismaIssueStore({ $transaction: transaction } as unknown as PrismaClient, 3_600_000);
  const pending = store.read([repo]);
  await vi.advanceTimersByTimeAsync(2_100);
  expect(await pending).toEqual(answer);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/query 2100 ms/));
  expect(log).not.toHaveBeenCalled();
});

it('bounds the queue wait for a blocking read while hung queries retain their slots', async () => {
  vi.useFakeTimers();
  const transaction = vi.fn(() => new Promise<StoreRead>(() => {}));
  const store = new PrismaIssueStore({ $transaction: transaction } as unknown as PrismaClient, 3_600_000);
  const first = store.read([repo]).catch(() => null);
  const second = store.read([repo]).catch(() => null);
  const blocking = store.read([repo], undefined, 2_000).catch((error: Error) => error);
  let settled = false;
  void blocking.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await blocking).toBeInstanceOf(Error);
  expect(transaction).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1_001);
  await Promise.all([first, second]);
});
