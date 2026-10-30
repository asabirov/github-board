import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError, WithdrawnReadError } from '../api/core';
import { forgetPayloads, forgetSensitivePayloads, forgetSavedCopies } from '../cache/payload-cache';
import { retryOverviewRead } from './retry-overview-read';

beforeEach(() => { vi.useFakeTimers(); forgetPayloads(); });
afterEach(() => vi.useRealTimers());
const transient = () => new ApiError(503, 'not now', undefined, undefined, undefined, 'access_not_now');
const run = (read: () => Promise<unknown>, signal = new AbortController().signal) => retryOverviewRead(read, '/api/issues/all', 'issues_not_now', signal);
it.each([new TypeError('offline'), new ApiError(502, 'proxy'), transient(), new ApiError(503, 'quota', undefined, undefined, undefined, 'issues_not_now')])('recovers from %s without refreshing the page', async error => {
  const read = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('fresh');
  const pending = run(read);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(pending).resolves.toBe('fresh');
  expect(read).toHaveBeenCalledTimes(2);
});
it('continues beyond the renewal lease with a capped delay', async () => {
  let available = false;
  const read = vi.fn(async () => { if (!available) throw transient(); return 'fresh'; });
  const pending = run(read);
  await vi.advanceTimersByTimeAsync(121000);
  expect(read).toHaveBeenCalledTimes(9);
  available = true;
  await vi.advanceTimersByTimeAsync(30000);
  await expect(pending).resolves.toBe('fresh');
});
it('honours a cooldown across an effect restart', async () => {
  const controller = new AbortController();
  const error = new ApiError(503, 'quota', undefined, undefined, undefined, 'access_not_now', Date.now() + 90000);
  const read = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('fresh');
  const stopped = expect(run(read, controller.signal)).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(1000);
  controller.abort();
  await stopped;
  const pending = run(read);
  await vi.advanceTimersByTimeAsync(88999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toBe('fresh');
});
it.each([401, 403, 404, 409, 500, 503])('does not retry a refusal (%s)', async status => {
  const error = new ApiError(status, 'refused'), read = vi.fn().mockRejectedValue(error);
  await expect(run(read)).rejects.toBe(error);
  expect(read).toHaveBeenCalledTimes(1);
});
it('does not retry withdrawn or unrelated coded reads', async () => {
  for (const error of [new WithdrawnReadError('changed'), new ApiError(503, 'wrong family', undefined, undefined, undefined, 'projects_not_now')]) {
    const read = vi.fn().mockRejectedValue(error);
    await expect(run(read)).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  }
});
it.each(['navigation', 'identity', 'access', 'refusal'])('cancels a pending retry after %s', async boundary => {
  const controller = new AbortController(), error = transient(), read = vi.fn().mockRejectedValue(error);
  const verdict = expect(run(read, controller.signal)).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(1);
  if (boundary === 'navigation') controller.abort();
  if (boundary === 'identity') forgetPayloads();
  if (boundary === 'access') forgetSensitivePayloads();
  if (boundary === 'refusal') forgetSavedCopies();
  await vi.runAllTimersAsync();
  await verdict;
  expect(read).toHaveBeenCalledTimes(1);
});
it('settles a later refresh immediately instead of retrying an already loaded block', async () => {
  const error = transient(), read = vi.fn().mockRejectedValue(error);
  await expect(retryOverviewRead(read, '/api/issues/all', 'issues_not_now', new AbortController().signal, () => false)).rejects.toBe(error);
  await vi.runAllTimersAsync();
  expect(read).toHaveBeenCalledTimes(1);
});
it('stops a scheduled retry if another read completes the opening load', async () => {
  let opening = true;
  const error = transient(), read = vi.fn().mockRejectedValue(error);
  const verdict = expect(retryOverviewRead(read, '/api/issues/all', 'issues_not_now', new AbortController().signal, () => opening)).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(1);
  opening = false;
  await vi.runAllTimersAsync();
  await verdict;
  expect(read).toHaveBeenCalledTimes(1);
});
