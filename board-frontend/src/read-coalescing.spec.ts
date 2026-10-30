import { afterEach, expect, it, vi } from 'vitest';
import { fetchMe } from './api/me';
import { fetchProjectCatalog, fetchProject, fetchProjects } from './api/projects';
import { SENSITIVE_HEADER } from './api/core';
import { forgetPayloads, forgetSensitivePayloads } from './cache/payload-cache';

afterEach(() => vi.unstubAllGlobals());
const answer = (body: unknown) => new Response(JSON.stringify(body), { headers: { [SENSITIVE_HEADER]: '1' } });
function delayed() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  const fetch = vi.fn(() => promise);
  vi.stubGlobal('fetch', fetch);
  return { fetch, resolve };
}

it('joins overlapping rollup reads but a later refresh still goes to the server', async () => {
  const { fetch, resolve } = delayed();
  const a = fetchProjects('one');
  const b = fetchProjects('one');
  expect(fetch).toHaveBeenCalledTimes(1);
  resolve(answer({ projects: [] }));
  expect(await a).toEqual(await b);
  fetch.mockImplementation(async () => answer({ projects: [] }));
  await fetchProjects('one');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not join different owners or boards', async () => {
  const fetch = vi.fn(async () => answer({ projects: [] }));
  vi.stubGlobal('fetch', fetch);
  await Promise.all([fetchProjects('one'), fetchProjects('two'), fetchProjects(), fetchProject(1, 'one'), fetchProject(2, 'one'), fetchProject(1, 'two')]);
  expect(fetch).toHaveBeenCalledTimes(6);
});

it('shares a failed read without caching its refusal', async () => {
  const { fetch, resolve } = delayed();
  const a = expect(fetchProjects()).rejects.toMatchObject({ status: 403 });
  const b = expect(fetchProjects()).rejects.toMatchObject({ status: 403 });
  resolve(new Response('{}', { status: 403 }));
  await Promise.all([a, b]);
  fetch.mockImplementation(async () => answer({ projects: [] }));
  await expect(fetchProjects()).resolves.toEqual({ projects: [] });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([forgetPayloads, forgetSensitivePayloads])('starts a new read after invalidation and refuses the older response', async (invalidate) => {
  const { fetch, resolve } = delayed();
  const old = expect(fetchProjects()).rejects.toMatchObject({ status: 409 });
  invalidate();
  fetch.mockImplementation(async () => answer({ projects: [{ title: 'new' }] }));
  const fresh = fetchProjects();
  resolve(answer({ projects: [{ title: 'old' }] }));
  await old;
  await expect(fresh).resolves.toEqual({ projects: [{ title: 'new' }] });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('joins simultaneous session probes without retaining a completed identity answer', async () => {
  const { fetch, resolve } = delayed();
  const a = fetchMe();
  const b = fetchMe();
  resolve(answer({ email: 'reader@example.test' }));
  expect(await a).toEqual(await b);
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(async () => answer({ email: 'reader@example.test' }));
  await fetchMe();
  expect(fetch).toHaveBeenCalledTimes(2);
});

// #911 review, R1. Overview asks for the catalog on every cold visit now, and
// two of them can be mounted across one pending return — so the scope has to be
// in the join key, or the union's answer satisfies an org's reader.
it('does not join catalog reads across owners, and joins the ones that agree', async () => {
  const fetch = vi.fn(async () => answer([]));
  vi.stubGlobal('fetch', fetch);
  await Promise.all([fetchProjectCatalog('one'), fetchProjectCatalog('two'), fetchProjectCatalog()]);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('shares one owner’s pending catalog read with a reader who arrives during it', async () => {
  const { fetch, resolve } = delayed();
  const a = fetchProjectCatalog('one');
  const b = fetchProjectCatalog('one');
  expect(fetch).toHaveBeenCalledTimes(1);
  resolve(answer([{ id: 'P7', org: 'one', number: 7, title: 'Held' }]));
  expect(await a).toEqual(await b);
});

it('asks again after a refused catalog read rather than handing back the refusal', async () => {
  const { fetch, resolve } = delayed();
  const a = expect(fetchProjectCatalog('one')).rejects.toThrow();
  const b = expect(fetchProjectCatalog('one')).rejects.toThrow();
  resolve(new Response('{}', { status: 500 }));
  await Promise.all([a, b]);
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(async () => answer([]));
  await expect(fetchProjectCatalog('one')).resolves.toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('shares a pending catalog read and performs a fresh read after settlement', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetch = vi.fn(async () => { await gate; return answer([]); });
  vi.stubGlobal('fetch', fetch);
  const a = fetchProjectCatalog();
  const b = fetchProjectCatalog();
  release();
  await Promise.all([a, b]);
  expect(fetch).toHaveBeenCalledTimes(1);
  await fetchProjectCatalog();
  expect(fetch).toHaveBeenCalledTimes(2);
});
