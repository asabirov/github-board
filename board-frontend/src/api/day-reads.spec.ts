import { afterEach, expect, it, vi } from 'vitest';
import { fetchIssueMetrics, fetchMyIssues } from './issues';
import { getTimezone, resolvedTimezone, setTimezone, systemTimezone } from '../account/prefs';
import { forgetPayloads } from '../cache/payload-cache';

afterEach(() => { forgetPayloads(); vi.unstubAllGlobals(); });

it('resolves an unset preference to the browser zone', () => {
  expect(resolvedTimezone('')).toBe(systemTimezone());
  expect(resolvedTimezone('invalid/zone')).toBe(systemTimezone());
});

it('carries a saved timezone over from the old `lessly_timezone` key once (#1450)', () => {
  const stored = new Map<string, string>([['lessly_timezone', 'Europe/Berlin']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    get length() { return stored.size; },
    key: (i: number) => [...stored.keys()][i] ?? null,
  });
  expect(getTimezone()).toBe('Europe/Berlin');
  expect(stored.get('board_timezone')).toBe('Europe/Berlin');
  expect(stored.has('lessly_timezone')).toBe(false);
});

it('separates simultaneous and saved metric reads by the selected device zone', async () => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    get length() { return stored.size; },
    key: (i: number) => [...stored.keys()][i] ?? null,
  });
  const fetch = vi.fn(async (input: string) => {
    const timeZone = new URL(input, 'https://board.test').searchParams.get('timeZone');
    return new Response(JSON.stringify({ timeZone }), { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  setTimezone('Europe/Berlin');
  const berlin = [fetchIssueMetrics(), fetchMyIssues()];
  setTimezone('America/Los_Angeles');
  const la = [fetchIssueMetrics(), fetchMyIssues()];
  expect(await Promise.all(berlin)).toEqual([{ timeZone: 'Europe/Berlin' }, { timeZone: 'Europe/Berlin' }]);
  expect(await Promise.all(la)).toEqual([{ timeZone: 'America/Los_Angeles' }, { timeZone: 'America/Los_Angeles' }]);
  expect(fetch).toHaveBeenCalledTimes(4);
});
