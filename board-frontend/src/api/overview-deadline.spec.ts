import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { overviewNetworkFetch as networkFetch, OVERVIEW_READ_TIMEOUT_MS, retryAt, WithdrawnReadError } from './core';
import { forgetPayloads } from '../cache/payload-cache';
import { readClient, readKey } from '../cache/read-cache';
import { fetchOverviewProjects as fetchProjects } from './projects';

beforeEach(() => { vi.useFakeTimers(); forgetPayloads(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('aborts a metrics request that never receives headers', async () => {
  const fetch = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal('fetch', fetch);
  const pending = expect(networkFetch('/api/issues/metrics')).rejects.toBeInstanceOf(TypeError);
  await vi.advanceTimersByTimeAsync(OVERVIEW_READ_TIMEOUT_MS);
  await pending;
  expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal?.aborted).toBe(true);
});
it('times out a stalled successful body and fences its late cache write', async () => {
  let release!: (body: unknown) => void;
  const response = new Response('{}');
  response.json = () => new Promise(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const res = await networkFetch('/api/issues/metrics');
  const pending = expect(res.json()).rejects.toBeInstanceOf(TypeError);
  await vi.advanceTimersByTimeAsync(OVERVIEW_READ_TIMEOUT_MS);
  await pending;
  release({ stale: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(readClient.getQueryData(readKey('/api/issues/metrics'))).toBeUndefined();
});
it.each([401, 403, 502, 503])('preserves a known status %s when its body stalls', async status => {
  const response = new Response('{}', { status });
  response.clone = () => ({ json: () => new Promise(() => {}) }) as Response;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const pending = expect(networkFetch('/api/issues/metrics')).rejects.toMatchObject({ status, code: 'response_incomplete' });
  await vi.advanceTimersByTimeAsync(OVERVIEW_READ_TIMEOUT_MS);
  await pending;
});
it('releases a hung Projects deduplication entry so the next read can succeed', async () => {
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(new Response('{"projects":[]}'));
  vi.stubGlobal('fetch', fetch);
  const pending = expect(fetchProjects()).rejects.toBeInstanceOf(TypeError);
  await vi.advanceTimersByTimeAsync(OVERVIEW_READ_TIMEOUT_MS);
  await pending;
  await expect(fetchProjects()).resolves.toEqual({ projects: [] });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('keeps caller cancellation distinct from a network timeout', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const controller = new AbortController();
  const pending = expect(networkFetch('/api/issues/metrics', { signal: controller.signal })).rejects.toBeInstanceOf(WithdrawnReadError);
  controller.abort();
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});
it('reads Retry-After seconds and dates without accepting invalid values', () => {
  for (const [value, expected] of [['90', Date.now() + 90000], [new Date(Date.now() + 120000).toUTCString(), Math.floor(Date.now() / 1000) * 1000 + 120000], ['invalid', undefined]] as const) {
    expect(retryAt(new Response('', { headers: { 'Retry-After': value } }))).toBe(expected);
  }
});

it('keeps a downloaded response after the pending-read deadline', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{"projects":[{"name":"Kept"}]}'));
  vi.stubGlobal('fetch', fetch);
  await expect(fetchProjects()).resolves.toEqual({ projects: [{ name: 'Kept' }] });
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(61000);
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
});
