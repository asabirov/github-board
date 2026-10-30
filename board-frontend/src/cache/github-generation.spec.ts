import { afterEach, expect, it, vi } from 'vitest';
import { fetchPeople } from '../api/people';
import { fetchProject } from '../api/projects';
import { claimFor, currentPayloadGeneration, currentSensitiveGeneration, forgetPayloads, forgetSensitivePayloads, isSensitivePayloadKey, readPayload, setPayloadStore, writePayload, type PayloadStore } from './payload-cache';
import { persistCell } from './use-cached-state';
afterEach(() => { vi.unstubAllGlobals(); setPayloadStore(null); });
it('rejects an old network response after a Github visibility change', async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { finish = r; })));
  const pending = fetchPeople();
  const rejection = expect(pending).rejects.toThrow('GitHub access changed');
  forgetPayloads(); finish(new Response('[]', { status: 200 }));
  await rejection;
});
it('rejects a response whose body finishes parsing after a visibility change', async () => {
  let finish!: (value: unknown) => void;
  const json = vi.fn(() => new Promise((r) => { finish = r; }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, json })));
  const pending = fetchPeople();
  const rejection = expect(pending).rejects.toThrow('GitHub access changed');
  await vi.waitFor(() => expect(json).toHaveBeenCalled());
  forgetPayloads(); finish([]); await rejection;
});
it('does not let a retired mounted component write into the new person cache', () => {
  const map = new Map<string,string>();
  const store: PayloadStore = { get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null, getItem: (k) => map.get(k) ?? null, setItem: (k,v) => { map.set(k,v); }, removeItem: (k) => { map.delete(k); } };
  setPayloadStore(store); claimFor('a@example.test', undefined, 'old');
  const old = currentPayloadGeneration();
  claimFor('b@example.test', undefined, 'new');
  persistCell({ key: 'people', value: [{ secret: 'a-private' }], stored: true, sensitiveAt: currentSensitiveGeneration() }, old);
  expect(readPayload('people')).toBeNull();
});

/**
 * What an expired access check drops, and what it leaves alone (#892 review, C2).
 *
 * A check that finds the same repositories releases a repository-bound answer
 * and reauthorizes nothing else, so the sensitive answers go at every expiry
 * while the rest of the board keeps what it is drawing.
 */
it('classifies the stored keys a re-checked visibility does not reauthorize', () => {
  for (const key of ['projects', 'projects:acme', 'projects/7', 'projects/7:acme', 'repos', 'repos:acme', 'issues/mine', 'issues/all', 'issues/filter-options']) {
    expect(isSensitivePayloadKey(key), key).toBe(true);
  }
  for (const key of ['people', 'delivery', 'issues/metrics']) {
    expect(isSensitivePayloadKey(key), key).toBe(false);
  }
});

it('drops only those entries from the disk, and leaves repository-only data and the roster', () => {
  const map = new Map<string, string>();
  const store: PayloadStore = { get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
  setPayloadStore(store);
  claimFor('octocat@example.com');
  writePayload('projects/7:acme', { name: 'a private board' });
  writePayload('repos:acme', { repos: [] });
  writePayload('people', [{ id: 'octocat@example.com' }]);
  forgetSensitivePayloads();
  expect(readPayload('projects/7:acme'), 'the private board is gone').toBeNull();
  expect(readPayload('repos:acme'), 'the map is gone').toBeNull();
  expect(readPayload('people'), 'the roster is untouched').not.toBeNull();
});

it('rejects a sensitive response still in flight, and lets an unmarked one land', async () => {
  for (const marked of [true, false] as const) {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { finish = r; })));
    const pending = fetchProject(7, 'acme');
    const rejection = marked ? expect(pending).rejects.toThrow('GitHub access changed') : null;
    forgetSensitivePayloads();
    finish(new Response(JSON.stringify({ number: 7, name: 'a private board' }), {
      status: 200,
      headers: marked ? { 'content-type': 'application/json', 'X-Board-Sensitive': '1' } : { 'content-type': 'application/json' },
    }));
    if (rejection) await rejection;
    else await expect(pending, 'an unmarked answer is not this generation`s business').resolves.toBeTruthy();
  }
});
