import { patchReadAfterWrite, currentWriteCacheGeneration } from './read-cache';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryObserver } from '@tanstack/react-query';
const disk = vi.hoisted(() => new Map<string, string>());
vi.mock('idb-keyval', () => ({
  createStore: () => ({}),
  get: async (key: string) => disk.get(key),
  set: async (key: string, value: string) => { disk.set(key, value); },
  del: async (key: string) => { disk.delete(key); },
  clear: async () => { disk.clear(); },
  entries: async () => [...disk.entries()],
}));
import { cachedOwner, claimFor, forgetPayloads, setPayloadStore } from './payload-cache';
import { readClient, readKey, readValue, rememberRead, restoreReads, forgetRead } from './read-cache';
import { apiFetch } from '../api/core';
import { setResponseIdentity } from '../auth/response-deadline';
import { beginHintPreview, finishHintPreview } from '../auth/session-hint';

beforeEach(async () => {
  finishHintPreview(false);
  const local = new Map<string, string>();
  setPayloadStore({ getItem: key => local.get(key) ?? null, setItem: (key, value) => { local.set(key, value); }, removeItem: key => { local.delete(key); }, key: i => [...local.keys()][i] ?? null, get length() { return local.size; } });
  forgetPayloads();
  claimFor('alice@example.test', undefined, 'scope');
  setResponseIdentity('scope', false);
  await restoreReads();
});
afterEach(() => { vi.unstubAllGlobals(); readClient.clear(); });
const path = '/api/a-route-added-next-month';
const snapshot = () => [...disk.values()].join('');
it('keeps restored reads private until a session without a matching hint is verified', async () => {
  claimFor('alice@example.test', 'a'.repeat(64), 'scope');
  rememberRead(path, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(disk.size).toBe(1));
  readClient.clear();
  expect(beginHintPreview(cachedOwner(), '')).toBe(false);
  await restoreReads();
  expect(readValue(readClient.getQueryData(readKey(path)))).toBeNull();
  finishHintPreview(true);
  expect(readValue(readClient.getQueryData(readKey(path)))).toEqual({ count: 7 });
});
it('restores a new endpoint and revalidates through the default query function', async () => {
  rememberRead(path, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(snapshot()).toContain('"count":7'));
  readClient.clear();
  await restoreReads();
  let answer!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { answer = resolve; })));
  const observer = new QueryObserver(readClient, { queryKey: readKey(path) });
  const stop = observer.subscribe(() => {});
  expect(readValue(observer.getCurrentResult().data)).toEqual({ count: 7 });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  answer(Response.json({ count: 8 }));
  await vi.waitFor(() => expect(readValue(observer.getCurrentResult().data)).toEqual({ count: 8 }));
  await vi.waitFor(() => expect(snapshot()).toContain('"count":8'));
  stop();
});
it('a failed revalidation preserves last-good data across another visit', async () => {
  rememberRead(path, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(disk.size).toBe(1));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'access_not_now' }, { status: 503 })));
  await expect(readClient.fetchQuery({ queryKey: readKey(path) })).rejects.toThrow('read 503');
  readClient.clear();
  await restoreReads();
  expect(readValue(readClient.getQueryData(readKey(path)))).toEqual({ count: 7 });
  expect(snapshot()).not.toContain('"count":0');
});
it('a failed first read has no data to restore', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'access_not_now' }, { status: 503 })));
  await expect(readClient.fetchQuery({ queryKey: readKey(path) })).rejects.toThrow();
  expect(readValue(readClient.getQueryData(readKey(path)))).toBeNull();
  expect(disk.size).toBe(0);
});
it('a refusal removes the persisted answer as well as the visible one', async () => {
  rememberRead(path, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(disk.size).toBe(1));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 403 })));
  await expect(readClient.fetchQuery({ queryKey: readKey(path) })).rejects.toThrow();
  await vi.waitFor(() => expect(disk.size).toBe(0));
  expect(readValue(readClient.getQueryData(readKey(path)))).toBeNull();
});
it('late persistence cannot recreate a wiped owner', async () => {
  for (const owner of ['bob@example.test', 'carol@example.test']) {
    rememberRead(path, { marker: 'old-owner' }, new Headers());
    claimFor(owner, 'a'.repeat(64), 'scope');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(disk.size).toBe(0);
    expect(cachedOwner()?.email).toBe(owner);
  }
});
it('query collection never evicts a persisted answer', async () => {
  rememberRead(path, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(disk.size).toBe(1));
  readClient.removeQueries({ queryKey: readKey(path) });
  expect(disk.size).toBe(1);
});
it('no-store replaces and removes an older persisted response', async () => {
  rememberRead(path, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(disk.size).toBe(1));
  rememberRead(path, { count: 8 }, new Headers({ 'Cache-Control': 'private, no-store' }));
  await vi.waitFor(() => expect(disk.size).toBe(0));
  expect(readValue(readClient.getQueryData(readKey(path)))).toEqual({ count: 8 });
});
it('writes and auth probes never persist their response as a read', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ count: 7 })));
  await (await apiFetch(path, { method: 'POST' })).json();
  await (await apiFetch('/api/auth/me')).json();
  expect(disk.size).toBe(0);
  expect(readClient.getQueryCache().getAll()).toHaveLength(0);
});
it('only the stored roster loses personal aliases', async () => {
  const value = { people: [{ id: 'team@example.test', emails: ['personal@example.test'] }] };
  rememberRead('/api/people', value, new Headers({ 'Cache-Control': 'no-store', 'X-Board-Persist': 'roster-without-aliases' }));
  await vi.waitFor(() => expect(disk.size).toBe(1));
  expect(snapshot()).not.toContain('personal@example.test');
  expect(readValue(readClient.getQueryData(readKey('/api/people')))).toEqual(value);
});
it('corrupt and foreign stored answers are removed during restoration', async () => {
  disk.set('board-reads-v1-corrupt', '{');
  rememberRead(path, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(disk.size).toBe(2));
  for (const [key, raw] of disk) {
    if (raw === '{') continue;
    const query = JSON.parse(raw); query.state.data.owner = 'foreign'; disk.set(key, JSON.stringify(query));
  }
  readClient.clear();
  await restoreReads();
  expect(disk.size).toBe(0);
  expect(readClient.getQueryCache().getAll()).toHaveLength(0);
});
it('a refusal evicts disk even when the query was collected from memory', async () => {
  rememberRead(path, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(disk.size).toBe(1));
  readClient.removeQueries({ queryKey: readKey(path) });
  forgetRead(path);
  await vi.waitFor(() => expect(disk.size).toBe(0));
  await restoreReads();
  expect(readValue(readClient.getQueryData(readKey(path)))).toBeNull();
});
it('an older response cannot replace a later successful read in the cache', async () => {
  const pending: ((response: Response) => void)[] = [];
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => pending.push(resolve))));
  const older = apiFetch(path).then(response => response.json());
  const newer = apiFetch(path).then(response => response.json());
  pending[1](Response.json({ count: 8 }));
  await newer;
  pending[0](Response.json({ count: 7 }));
  await older;
  expect(readValue(readClient.getQueryData(readKey(path)))).toEqual({ count: 8 });
});
it('an aborted query cannot seed a response even if its transport ignores cancellation', async () => {
  let answer!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { answer = resolve; })));
  const controller = new AbortController();
  const reading = apiFetch(path, { signal: controller.signal }).then(response => response.json());
  controller.abort();
  answer(Response.json({ count: 7 }));
  await expect(reading).rejects.toThrow('cancelled');
  expect(readValue(readClient.getQueryData(readKey(path)))).toBeNull();
});

it.each([401, 403, 404])('a %s refusal withdraws live and persisted data', async status => {
  rememberRead(path, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(disk.size).toBe(1));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status })));
  await expect(readClient.fetchQuery({ queryKey: readKey(path) })).rejects.toThrow();
  expect(readValue(readClient.getQueryData(readKey(path)))).toBeNull();
  await vi.waitFor(() => expect(disk.size).toBe(0));
});

/**
 * #1395, and this list is the bug. Every one of these used to take the reader's
 * saved answer off the screen and off the disk, so the next open had nothing to
 * paint — and the three at the front are what a working production board does
 * several times a day: a cold read outliving its 60-second access window is the
 * uncoded 503, and a deploy is the 500 and the 409.
 *
 * The answer stays, and the query is left in its error state, which is what the
 * stale marker reads (`hasStaleReads`). A failure is still never drawn as data;
 * what is drawn is the reader's own last successful answer.
 */
it.each([500, 409, 503, 400, 408, 429, 504, 502])('a %s failure keeps the answer drawn and on disk', async status => {
  rememberRead(path, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(disk.size).toBe(1));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'failed' }, { status })));
  await expect(readClient.fetchQuery({ queryKey: readKey(path) })).rejects.toThrow();
  expect(readValue(readClient.getQueryData(readKey(path)))).toEqual({ count: 7 });
  expect(disk.size).toBe(1);
  // And it survives a reload, which is the half the reported bug was about: the
  // open after the failure had nothing saved to paint.
  readClient.clear();
  await restoreReads();
  expect(readValue(readClient.getQueryData(readKey(path)))).toEqual({ count: 7 });
});
it('successful top-level null withdraws the previous answer and disk copy', async () => {
  rememberRead(path, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(disk.size).toBe(1));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(null)));
  await readClient.fetchQuery({ queryKey: readKey(path) });
  expect(readValue(readClient.getQueryData(readKey(path)))).toBeNull();
  await vi.waitFor(() => expect(disk.size).toBe(0));
});
it('ordinary apiFetch returns the saved body while its replacement is pending', async () => {
  rememberRead(path, { count: 7 }, new Headers());
  let answer!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { answer = resolve; })));
  const result = apiFetch(path).then(r => r.json());
  await expect(Promise.race([result, new Promise(resolve => setTimeout(() => resolve('waiting'), 50))])).resolves.toEqual({ count: 7 });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  answer(Response.json({ count: 8 }));
  await vi.waitFor(() => expect(readValue(readClient.getQueryData(readKey(path)))).toEqual({ count: 8 }));
});
it('saved-copy refusal withdraws sensitive union and scoped reads even after collection', async () => {
  const { forgetSavedCopiesOnRefusal } = await import('../projects/projects-last-good');
  const { ApiError } = await import('../api/core');
  const { markSensitiveResponse } = await import('../auth/response-deadline');
  claimFor('alice@example.test', 'a'.repeat(64), 'scope');
  for (const url of ['/api/projects', '/api/projects?org=one', '/api/projects/7?org=one']) {
    rememberRead(url, markSensitiveResponse({ projects: [7] }), new Headers());
  }
  await vi.waitFor(() => expect(disk.size).toBe(3));
  readClient.removeQueries({ queryKey: readKey('/api/projects?org=one') });
  forgetSavedCopiesOnRefusal(new ApiError(403, 'refused'));
  expect(readValue(readClient.getQueryData(readKey('/api/projects')))).toBeNull();
  await vi.waitFor(() => expect(disk.size).toBe(0));
  await restoreReads();
  expect(readValue(readClient.getQueryData(readKey('/api/projects?org=one')))).toBeNull();
});
it('saved-copy refusal keeps an unrelated live queue under its own authorization', async () => {
  const { forgetSavedCopiesOnRefusal } = await import('../projects/projects-last-good');
  const { ApiError } = await import('../api/core');
  const { markSensitiveResponse } = await import('../auth/response-deadline');
  const queue = markSensitiveResponse({ issues: [7] });
  rememberRead('/api/issues/mine', queue, new Headers());
  forgetSavedCopiesOnRefusal(new ApiError(403, 'refused'));
  expect(readValue(readClient.getQueryData(readKey('/api/issues/mine')))).toBe(queue);
});
/**
 * The saved-copy policy no longer reads the body (#1395). Every row here used to
 * turn on whether the endpoint's own "not now" code was present and belonged to
 * this read; all of them keep now, because none of them is a 401, a 403 or a
 * 404. The code is still read — by `transientFailure`, to decide whether to try
 * again — and `projects-last-good.spec.ts` is where that is pinned.
 *
 * The rows are kept rather than deleted so the shapes board-api really sends go
 * on being driven through the transport.
 */
it.each([
  ['/api/projects', 503, { code: 'projects_not_now' }, true],
  ['/api/issues/all', 503, { code: 'issues_not_now' }, true],
  [path, 502, {}, true],
  [path, 502, { message: 'refused' }, true],
  [path, 503, { code: 'projects_not_now' }, true],
  [path, 503, { code: '' }, true],
  ['/api/projects', 503, { code: 'issues_not_now' }, true],
  [path, 403, { message: 'forbidden' }, false],
  ['/api/projects', 404, { message: 'unknown org' }, false],
] as const)('applies the saved-copy policy to %s / %s / %j', async (url, status, body, keep) => {
  rememberRead(url, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(disk.size).toBe(1));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));
  await expect(readClient.fetchQuery({ queryKey: readKey(url) })).rejects.toThrow();
  expect(readValue(readClient.getQueryData(readKey(url)))).toEqual(keep ? { count: 7 } : null);
  await vi.waitFor(() => expect(disk.size).toBe(keep ? 1 : 0));
});

it.each([500, 503, 429, 504])('an auxiliary %s failure keeps its own read and the Overview copies', async status => {
  const overview = ['/api/issues/all', '/api/issues/metrics?timeZone=UTC', '/api/projects'];
  for (const url of [...overview, '/api/issues/filter-options']) rememberRead(url, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(disk.size).toBe(4));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status })));
  await expect(readClient.fetchQuery({ queryKey: readKey('/api/issues/filter-options') })).rejects.toThrow();
  // Its own copy stays too since #1395: a failed filter-options read says
  // nothing about whether this reader may see the filter options they were
  // shown a minute ago. The dropdown keeps its choices instead of emptying.
  for (const url of [...overview, '/api/issues/filter-options']) {
    expect(readValue(readClient.getQueryData(readKey(url))), url).toEqual({ count: 7 });
  }
  expect(disk.size).toBe(4);
  readClient.clear();
  await restoreReads();
  for (const url of overview) expect(readValue(readClient.getQueryData(readKey(url)))).toEqual({ count: 7 });
});

it.each(['/api/sync/operations/deployed-away', '/api/sync/sources'])('a missing sync read %s keeps Overview in memory and on disk', async url => {
  const overview = ['/api/issues/all', '/api/issues/metrics', '/api/projects'];
  for (const path of overview) rememberRead(path, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(disk.size).toBe(3));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ message: 'Sync progress unavailable' }, { status: 404 })));
  await expect(readClient.fetchQuery({ queryKey: readKey(url) })).rejects.toThrow();
  for (const path of overview) expect(readValue(readClient.getQueryData(readKey(path)))).toEqual({ count: 7 });
  readClient.clear();
  await restoreReads();
  for (const path of overview) expect(readValue(readClient.getQueryData(readKey(path)))).toEqual({ count: 7 });
  expect(disk.size).toBe(3);
});

it.each([401, 403, 404])('an explicit auxiliary %s refusal still withdraws all Overview copies', async status => {
  for (const url of ['/api/issues/all', '/api/issues/metrics', '/api/projects']) rememberRead(url, { count: 7 }, new Headers());
  await vi.waitFor(() => expect(disk.size).toBe(3));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status })));
  await expect(readClient.fetchQuery({ queryKey: readKey('/api/issues/filter-options') })).rejects.toThrow();
  for (const url of ['/api/issues/all', '/api/issues/metrics', '/api/projects']) expect(readValue(readClient.getQueryData(readKey(url)))).toBeNull();
  await vi.waitFor(() => expect(disk.size).toBe(0));
});

it('persists an acknowledged text edit without renewing the saved read', async () => {
  rememberRead(path, { bodyMarkdown: 'original' }, new Headers());
  const before = readClient.getQueryData<Record<string, unknown>>(readKey(path));
  await patchReadAfterWrite<{ bodyMarkdown: string }>(path, value => ({ ...value, bodyMarkdown: 'saved' }), currentWriteCacheGeneration());
  expect(readClient.getQueryData(readKey(path))).toMatchObject({ ...before, value: { bodyMarkdown: 'saved' } });
  await vi.waitFor(() => expect(snapshot()).toContain('"bodyMarkdown":"saved"'));
  readClient.clear();
  await restoreReads();
  expect(readValue(readClient.getQueryData(readKey(path)))).toEqual({ bodyMarkdown: 'saved' });
});
it('does not apply an old write to a newly signed-in person', async () => {
  rememberRead(path, { bodyMarkdown: 'alice' }, new Headers());
  const epoch = currentWriteCacheGeneration();
  claimFor('bob@example.test', undefined, 'scope');
  rememberRead(path, { bodyMarkdown: 'bob' }, new Headers());
  await patchReadAfterWrite(path, () => ({ bodyMarkdown: 'alice edit' }), epoch);
  expect(readValue(readClient.getQueryData(readKey(path)))).toEqual({ bodyMarkdown: 'bob' });
});
