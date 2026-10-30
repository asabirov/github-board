import { patchIssueResponse } from '../issue/held-issue';
import { addProjectToIssue } from '../issue/facet-editors';
import { createFacetEdit } from '../issue/use-facet-edit';
import { afterEach, expect, it, vi } from 'vitest';
import { claimFor, writePayload, readPayload, forgetSensitivePayloads, setPayloadStore, PAYLOAD_CACHE_PREFIX, type PayloadKey } from '../cache/payload-cache';
import { setResponseIdentity, tagResponse, responseDeadline, responseExpired, copyResponseDeadline } from './response-deadline';
import { nextCell, seedCell, staleSensitive } from '../cache/use-cached-state';
import { answered } from '../search/palette-boards';
import { fetchDelivery } from '../api/delivery';
import { fetchIssue, fetchFilterOptions, fetchMyIssues, fetchOrgIssues, type IssueDetail } from '../api/issues';
import { fetchProjectCatalog, type ProjectSummary } from '../api/projects';

function setup() {
  vi.useFakeTimers();
  const data = new Map<string, string>();
  setPayloadStore({ getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: k => { data.delete(k); }, key: i => [...data.keys()][i] ?? null, get length() { return data.size; } });
  claimFor('reader');
  setResponseIdentity('reader', true, Date.now() + 60_000);
  return data;
}
const lease = () => ({ expiresAt: Date.now() + 60_000, visibilityKey: 'reader' });
afterEach(() => { setPayloadStore(undefined); setResponseIdentity(null, false); vi.useRealTimers(); vi.unstubAllGlobals(); });
it.each<PayloadKey>(['issues/filter-options', 'issues/mine', 'issues/all', 'delivery'])('restores metadata for marked %s past its old deadline', key => {
  setup();
  const source = tagResponse({ projects: [{ name: 'private' }] }, lease());
  writePayload(key, source);
  expect(responseDeadline(readPayload(key))).toEqual(responseDeadline(source));
  vi.advanceTimersByTime(60_000);
  setResponseIdentity('reader', true, Date.now() + 60_000);
  expect(readPayload(key)).toEqual(source);
});
it('hard invalidation removes metadata-sensitive entries outside the known keys', () => {
  const data = setup();
  writePayload('delivery', tagResponse({ private: true }, lease()));
  forgetSensitivePayloads();
  expect(data.has(PAYLOAD_CACHE_PREFIX + 'delivery')).toBe(false);
});
it.each<PayloadKey>(['issues/filter-options', 'issues/mine', 'issues/all'])('rejects unleased legacy %s under the supported protocol and discards it on legacy expiry', key => {
  setup();
  writePayload(key, { projects: ['private'] });
  expect(readPayload(key)).toBeNull();
  setResponseIdentity(null, false);
  writePayload(key, { projects: ['private'] });
  expect(readPayload(key)).not.toBeNull();
  forgetSensitivePayloads();
  expect(readPayload(key)).toBeNull();
});
it('invalidates marked held answers across hard generations even with the same identity and future expiry', () => {
  setup();
  const source = tagResponse({ projects: [] }, lease());
  forgetSensitivePayloads();
  setResponseIdentity('reader', true, Date.now() + 60_000);
  expect(responseExpired(source)).toBe(true);
});
it('preserves the old lease through optimistic cached updates, without giving stale state to an updater', () => {
  setup();
  const source = tagResponse({ projects: ['private'], title: 'old' }, lease());
  writePayload('issues/mine', source);
  const patched = nextCell(seedCell<typeof source>('issues/mine'), 'issues/mine', prev => ({ ...prev!, title: 'edited' }));
  expect(responseDeadline(patched.value)).toEqual(responseDeadline(source));
  vi.advanceTimersByTime(60_000);
  expect(staleSensitive(patched)).toBe(false);
  const update = vi.fn(v => v);
  nextCell(patched, 'issues/mine', update);
  expect(update).toHaveBeenCalledWith(patched.value);
});
it('preserves leases for selected nested projects and palette envelopes', () => {
  setup();
  const source = tagResponse({ projects: [{ name: 'private' }] }, lease());
  expect(responseDeadline(source.projects[0])).toEqual(responseDeadline(source));
  const held = answered(null, source.projects as ProjectSummary[]);
  expect(responseDeadline(held)).toEqual(responseDeadline(source));
});

it('keeps the earlier lease when optimistic data combines two responses', () => {
  setup();
  const old = tagResponse({}, lease());
  vi.advanceTimersByTime(30_000);
  const fresh = tagResponse({}, lease());
  const merged = copyResponseDeadline(fresh, copyResponseDeadline(old, {}));
  expect(responseDeadline(merged)).toEqual(responseDeadline(old));
});
it('a pending facet retains its source metadata past the old deadline', async () => {
  setup();
  const source = tagResponse({}, lease());
  let finish!: (v: string) => void;
  const apply = vi.fn();
  const store = createFacetEdit({ initial: 'private field', source, commit: () => new Promise<string>(resolve => { finish = resolve; }), apply });
  const pending = store.edit('edited private field');
  vi.advanceTimersByTime(30_000);
  store.reset('fresh field', tagResponse({}, lease()));
  expect(responseDeadline(store.getSnapshot())).toEqual(responseDeadline(source));
  vi.advanceTimersByTime(30_000);
  finish('old field reply');
  await pending;
  expect(apply).toHaveBeenCalled();
  expect(responseExpired(store.getSnapshot())).toBe(false);
});
it('does not persist a response from a hard-invalidated generation with a future lease', () => {
  setup();
  const old = tagResponse({ private: true }, lease());
  forgetSensitivePayloads();
  setResponseIdentity('reader', true, Date.now() + 60_000);
  writePayload('delivery', old);
  expect(readPayload('delivery')).toBeNull();
});

it.each([
  ['issue', () => fetchIssue('acme', 'repo', 905)],
  ['catalog', () => fetchProjectCatalog()],
  ['options', () => fetchFilterOptions()],
  ['personal queue', () => fetchMyIssues()],
  ['team queue', () => fetchOrgIssues()],
] as const)('rejects an older %s read after a newer refusal', async (_name, read) => {
  setup();
  forgetSensitivePayloads();
  setResponseIdentity('reader', true, Date.now() + 60_000);
  let release!: (r: Response) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const fetch = vi.fn(() => pending);
  vi.stubGlobal('fetch', fetch);
  const old = expect(read()).rejects.toMatchObject({ status: 409 });
  setResponseIdentity('reader', true, Date.now() + 90_000);
  fetch.mockImplementation(async () => new Response('{}', { status: 403 }));
  await expect(read()).rejects.toThrow('forbidden');
  release(new Response('{}', { headers: { 'X-Board-Sensitive': '1', 'X-Board-Access-Expires-At': String(Date.now() + 60_000), 'X-Board-Visibility': 'reader' } }));
  await old;
});
it('keeps legacy sensitivity metadata even outside known keys and rejects it after protocol upgrade', async () => {
  const data = setup();
  setResponseIdentity(null, false);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"private":true}', { headers: { 'X-Board-Sensitive': '1' } })));
  const value = await fetchDelivery();
  writePayload('delivery', value);
  const stored = data.get(PAYLOAD_CACHE_PREFIX + 'delivery')!;
  forgetSensitivePayloads();
  expect(readPayload('delivery')).toBeNull();
  data.set(PAYLOAD_CACHE_PREFIX + 'delivery', stored);
  setResponseIdentity('reader', true, Date.now() + 60_000);
  expect(readPayload('delivery')).toBeNull();
});
it('preserves leases on newly derived nested collections without restamping shared fresh children', () => {
  setup();
  const source = tagResponse({ projects: [{ name: 'private' }] }, lease());
  vi.advanceTimersByTime(30_000);
  const fresh = tagResponse({ name: 'new' }, lease());
  const derived = copyResponseDeadline(source, { projects: [...source.projects, fresh] });
  expect(responseDeadline(derived.projects)).toEqual(responseDeadline(source));
  expect(responseDeadline(fresh)?.expiresAt).toBe(Date.now() + 60_000);
});
it('an optimistic catalog membership keeps the catalog lease when the issue renewed more recently', () => {
  setup();
  const catalog = tagResponse({ id: 'PVT_old', number: 7, title: 'private', org: 'acme' }, lease());
  vi.advanceTimersByTime(30_000);
  const issue = tagResponse({ projects: [] } as unknown as IssueDetail, lease());
  const added = addProjectToIssue(issue, catalog, 'item');
  expect(responseDeadline(added)).toEqual(responseDeadline(catalog));
  expect(responseDeadline(added.projects)).toEqual(responseDeadline(catalog));
  expect(responseDeadline(issue)?.expiresAt).toBe(Date.now() + 60_000);
});
it('passes the write source to the patch callback even when its reconciled value is scalar', async () => {
  setup();
  const source = tagResponse({}, lease());
  let authorization: unknown;
  const edit = createFacetEdit({ initial: 'old', source, commit: async () => 'reconciled', apply: (_actual, held) => { authorization = held; } });
  await edit.edit('requested');
  expect(responseDeadline(authorization)).toEqual(responseDeadline(source));
});
it('applying an older partial patch to a newer issue never extends its private data', () => {
  setup();
  const patch = tagResponse({ projects: [{ title: 'private' }] }, lease());
  vi.advanceTimersByTime(30_000);
  const issue = tagResponse({ projects: [] } as unknown as IssueDetail, lease());
  const merged = patchIssueResponse(issue, patch as Partial<IssueDetail>);
  expect(responseDeadline(merged)).toEqual(responseDeadline(patch));
  vi.advanceTimersByTime(30_000);
  expect(responseExpired(merged)).toBe(false);
  expect(responseExpired(issue)).toBe(false);
});
it('cannot re-scope old private data by copying a shorter lease from another identity', () => {
  setup();
  const old = tagResponse({ private: true }, { ...lease(), expiresAt: Date.now() + 90_000 });
  setResponseIdentity('other', true, Date.now() + 60_000);
  const fresh = tagResponse({}, { visibilityKey: 'other', expiresAt: Date.now() + 60_000 });
  expect(responseExpired(copyResponseDeadline(fresh, old))).toBe(true);
});

it('keeps only still-leased My work on mount, then enforces identity without timed expiry', () => {
  setup();
  const originalLease = lease();
  writePayload('issues/mine', tagResponse({ issues: ['private'] }, originalLease));
  writePayload('issues/mine:acme', tagResponse({ issues: ['scoped'] }, originalLease));
  writePayload('issues/filter-options', tagResponse({ projects: ['private'] }, originalLease));
  forgetSensitivePayloads({ preserveLiveMine: true });
  setResponseIdentity('reader', true, Date.now() + 120_000);
  expect(readPayload('issues/mine')).toEqual({ issues: ['private'] });
  expect(readPayload('issues/mine:acme')).toEqual({ issues: ['scoped'] });
  expect(responseDeadline(readPayload('issues/mine'))).toEqual(originalLease);
  expect(readPayload('issues/filter-options')).toBeNull();
  vi.advanceTimersByTime(60_000);
  expect(readPayload('issues/mine')).toEqual({ issues: ['private'] });
  expect(readPayload('issues/mine:acme')).toEqual({ issues: ['scoped'] });
});
it.each(['owner', 'visibility', 'revocation'])('does not restore retained My work after a changed %s', change => {
  setup();
  writePayload('issues/mine', tagResponse({ issues: ['private'] }, lease()));
  forgetSensitivePayloads({ preserveLiveMine: true });
  if (change === 'owner') claimFor('someone else');
  if (change === 'visibility') setResponseIdentity('another grant', true, Date.now() + 60_000);
  if (change === 'revocation') forgetSensitivePayloads();
  expect(readPayload('issues/mine')).toBeNull();
});
it('drops expired and unleased My work entries on mount', () => {
  const data = setup();
  writePayload('issues/mine', tagResponse({ issues: [] }, lease()));
  setResponseIdentity(null, false);
  writePayload('issues/mine:legacy', { issues: [] });
  vi.advanceTimersByTime(60_000);
  forgetSensitivePayloads({ preserveLiveMine: true });
  expect(data.has(PAYLOAD_CACHE_PREFIX + 'issues/mine')).toBe(false);
  expect(data.has(PAYLOAD_CACHE_PREFIX + 'issues/mine:legacy')).toBe(false);
});
