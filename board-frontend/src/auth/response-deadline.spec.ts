import { afterEach, expect, it, vi } from 'vitest';
import { responseExpired, responseDeadline, setResponseIdentity, tagResponse, copyResponseDeadline } from './response-deadline';
import { fetchProjects } from '../api/projects';
import { SENSITIVE_HEADER } from '../api/core';
import { ACCESS_DEADLINE_HEADER, ACCESS_VISIBILITY_HEADER } from './response-deadline';

afterEach(() => { setResponseIdentity(null, false); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('retains old sensitive data past its deadline until the identity changes', () => {
  vi.useFakeTimers();
  setResponseIdentity('reader', true);
  const old = tagResponse({ projects: [] }, { expiresAt: Date.now() + 60_000, visibilityKey: 'reader' });
  vi.advanceTimersByTime(30_000);
  setResponseIdentity('reader', true);
  const fresh = tagResponse({ projects: [] }, { expiresAt: Date.now() + 60_000, visibilityKey: 'reader' });
  vi.advanceTimersByTime(30_000);
  expect(responseExpired(old.projects)).toBe(false);
  expect(responseExpired(fresh.projects)).toBe(false);
  setResponseIdentity('other-reader', true);
  expect(responseExpired(fresh.projects)).toBe(true);
});
it('carries the original deadline through derived health or header data', () => {
  setResponseIdentity('reader', true);
  const raw = tagResponse({}, { expiresAt: Date.now() + 1000, visibilityKey: 'reader' });
  expect(responseDeadline(copyResponseDeadline(raw, {}))).toBe(responseDeadline(raw));
});
it.each(['missing', 'different-reader'])('refuses a %s sensitive response deadline', async (kind) => {
  setResponseIdentity('reader', true);
  const headers: Record<string, string> = { [SENSITIVE_HEADER]: '1' };
  if (kind !== 'missing') {
    headers[ACCESS_DEADLINE_HEADER] = String(Date.now() + (kind === 'expired' ? -1 : 60_000));
    headers[ACCESS_VISIBILITY_HEADER] = kind === 'different-reader' ? 'other' : 'reader';
  }
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"projects":[]}', { headers })));
  await expect(fetchProjects()).rejects.toMatchObject({ status: 409 });
});

it('does not join reads from different checks or let an older answer replace a newer one', async () => {
  const start = Date.now();
  setResponseIdentity('reader', true, start + 60_000);
  let release!: (r: Response) => void;
  const pending = new Promise<Response>((resolve) => { release = resolve; });
  const fetch = vi.fn(() => pending);
  vi.stubGlobal('fetch', fetch);
  const old = expect(fetchProjects('reorder')).rejects.toMatchObject({ status: 409 });
  setResponseIdentity('reader', true, start + 90_000);
  const answer = (deadline: number) => new Response('{"projects":[]}', { headers: {
    [SENSITIVE_HEADER]: '1', [ACCESS_DEADLINE_HEADER]: String(deadline), [ACCESS_VISIBILITY_HEADER]: 'reader',
  } });
  fetch.mockImplementation(async () => answer(start + 90_000));
  await expect(fetchProjects('reorder')).resolves.toEqual({ projects: [] });
  expect(fetch).toHaveBeenCalledTimes(2);
  release(answer(start + 60_000));
  await old;
});

it('does not let a concurrent legacy probe downgrade response checks before hard invalidation', async () => {
  setResponseIdentity('reader', true, Date.now() + 60_000);
  setResponseIdentity('reader', false, Date.now() + 30_000);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"projects":[]}', { headers: { [SENSITIVE_HEADER]: '1' } })));
  await expect(fetchProjects('legacy')).rejects.toMatchObject({ status: 409 });
});

it('accepts a successful response body finishing past the old deadline', async () => {
  vi.useFakeTimers();
  setResponseIdentity('reader', true);
  const end = Date.now() + 60_000;
  let release!: (v: unknown) => void;
  const body = new Promise((resolve) => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, headers: new Headers({
    [SENSITIVE_HEADER]: '1', [ACCESS_DEADLINE_HEADER]: String(end), [ACCESS_VISIBILITY_HEADER]: 'reader',
  }), json: () => body })));
  const result = expect(fetchProjects('slow-body')).resolves.toEqual({ projects: [] });
  await Promise.resolve(); await Promise.resolve();
  vi.advanceTimersByTime(60_000);
  release({ projects: [] });
  await result;
});

it('retains a stored Project past its old access deadline', async () => {
  const { claimFor, projectsKey, readPayload, writePayload } = await import('../cache/payload-cache');
  vi.useFakeTimers();
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    key: (index: number) => [...stored.keys()][index] ?? null,
    get length() { return stored.size; },
  });
  claimFor('reader@example.test', undefined, 'reader');
  setResponseIdentity('reader', true, Date.now() + 60_000);
  const projects = tagResponse([{ name: 'private' }], { expiresAt: Date.now() + 60_000, visibilityKey: 'reader' });
  writePayload(projectsKey(), projects);
  expect(readPayload(projectsKey(), Array.isArray)).toEqual(projects);
  vi.advanceTimersByTime(30_000);
  setResponseIdentity('reader', true, Date.now() + 60_000);
  vi.advanceTimersByTime(30_000);
  expect(readPayload(projectsKey(), Array.isArray)).toEqual(projects);
});

it('never accepts an older pending response after a newer read refuses the same Project', async () => {
  const start = Date.now();
  setResponseIdentity('reader', true, start + 60_000);
  let release!: (r: Response) => void;
  const pending = new Promise<Response>((resolve) => { release = resolve; });
  const fetch = vi.fn(() => pending);
  vi.stubGlobal('fetch', fetch);
  const old = expect(fetchProjects('revoked')).rejects.toMatchObject({ status: 409 });
  setResponseIdentity('reader', true, start + 90_000);
  fetch.mockImplementation(async () => new Response('{}', { status: 403 }));
  await expect(fetchProjects('revoked')).rejects.toMatchObject({ status: 403 });
  release(new Response('{"projects":[]}', { headers: {
    [SENSITIVE_HEADER]: '1', [ACCESS_DEADLINE_HEADER]: String(start + 60_000), [ACCESS_VISIBILITY_HEADER]: 'reader',
  } }));
  await old;
});
