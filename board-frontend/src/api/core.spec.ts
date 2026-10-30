import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as readCache from '../cache/read-cache';
import { beginHintPreview, finishHintPreview } from '../auth/session-hint';
import { fetchProjects } from './projects';
import { fetchMe } from './me';
import { SENSITIVE_HEADER, WithdrawnReadError, apiFetch, joinRead } from './core';
import { fetchDelivery } from './delivery';
import { forgetPayloads } from '../cache/payload-cache';
import { ACCESS_DEADLINE_HEADER, ACCESS_VISIBILITY_HEADER, setResponseIdentity } from '../auth/response-deadline';

beforeEach(() => forgetPayloads());
afterEach(() => {
  setResponseIdentity(null, false);
  finishHintPreview(false);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function sensitiveAnswer(expiresAt: number) {
  return new Response('{}', { headers: {
    [SENSITIVE_HEADER]: '1',
    [ACCESS_DEADLINE_HEADER]: String(expiresAt),
    [ACCESS_VISIBILITY_HEADER]: 'reader',
  } });
}

// Exercise the transport imported by adapters without adding an adapter export.
const coreDelivery = async () => (await apiFetch('/api/delivery')).json();

describe('the adapters share one API core', () => {
  it.each(['adapter', 'core'] as const)('joins a Projects read started through %s with the other route', async (first) => {
    const response = deferred<Response>();
    const fetch = vi.fn(() => response.promise.then((answer) => answer.clone()));
    vi.stubGlobal('fetch', fetch);
    const routes = {
      adapter: () => fetchProjects(),
      core: () => joinRead('projects', async () => (await apiFetch('/api/projects')).json()),
    };
    const pending = routes[first]();
    const joined = routes[first === 'adapter' ? 'core' : 'adapter']();
    response.resolve(new Response('{"projects":[]}'));
    const [one, two] = await Promise.all([pending, joined]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(joined).toBe(pending);
    expect(one).toEqual({ projects: [] });
    expect(two).toBe(one);
  });

  it('withdraws an adapter read when another adapter’s identity refusal changes the generation', async () => {
    const response = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn()
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(new Response('{}', { status: 403 })));
    const pending = fetchDelivery();
    const refused = expect(pending).rejects.toBeInstanceOf(WithdrawnReadError);
    await expect(fetchMe()).rejects.toThrow('forbidden');
    response.resolve(new Response('{}', { headers: { [SENSITIVE_HEADER]: '1' } }));
    await refused;
  });

  describe.each([
    { name: 'adapter then core', older: fetchDelivery, newer: coreDelivery },
    { name: 'core then adapter', older: coreDelivery, newer: fetchDelivery },
  ])('$name', ({ older, newer }) => {
    it('shares withdrawal order across routes', async () => {
      const response = deferred<Response>();
      const fetch = vi.fn().mockReturnValueOnce(response.promise)
        .mockResolvedValueOnce(new Response('{}', { status: 403 }));
      vi.stubGlobal('fetch', fetch);
      const pending = older();
      const refused = expect(pending).rejects.toMatchObject({
        name: 'WithdrawnReadError', message: 'This view was refused by a later read.',
      });
      // The raw transport returns 403; the public adapter rejects it.
      await newer().catch((error: unknown) => { expect(error).toEqual(new Error('forbidden')); });
      response.resolve(new Response('{}', { headers: { [SENSITIVE_HEADER]: '1' } }));
      await refused;
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('shares response deadlines after the newer body lands', async () => {
      vi.useFakeTimers();
      setResponseIdentity('reader', true);
      const now = Date.now();
      const body = deferred<unknown>();
      const reading = deferred<void>();
      const response = sensitiveAnswer(now + 60_000);
      response.json = () => { reading.resolve(); return body.promise; };
      const fetch = vi.fn().mockResolvedValueOnce(response)
        .mockResolvedValueOnce(sensitiveAnswer(now + 90_000));
      vi.stubGlobal('fetch', fetch);
      const pending = older();
      const refused = expect(pending).rejects.toMatchObject({
        name: 'WithdrawnReadError', message: 'A newer authorized response already replaced this view.',
      });
      await reading.promise;
      await expect(newer()).resolves.toEqual({});
      body.resolve({});
      await refused;
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  it('holds a response until the injected identity verification completes', async () => {
    let verify!: () => void;
    const verified = new Promise<void>((resolve) => { verify = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    const settled = vi.fn();
    const pending = apiFetch('/api/issues/mine', undefined, verified).then(settled);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).not.toHaveBeenCalled();
    verify();
    await pending;
    expect(settled).toHaveBeenCalledOnce();
  });
});

it('a paint hint cannot send a write or release a read before verification', async () => {
  const { beginHintPreview, finishHintPreview } = await import('../auth/session-hint');
  const id = 'a'.repeat(64);
  beginHintPreview({ hintId: id }, `board_session_hint=${encodeURIComponent(JSON.stringify({ id, visibilityKey: 'key' }))}`);
  const fetch = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  await expect(apiFetch('/api/repos/test/dri', { method: 'POST' })).rejects.toThrow('Session was not verified');
  const read = apiFetch('/api/repos');
  expect(fetch).not.toHaveBeenCalled();
  finishHintPreview(true);
  await read;
  expect(fetch).toHaveBeenCalledTimes(1);
});

describe('reads survive unavailable restoration during hint preview', () => {
  it.each(['hangs', 'throws'])('returns network content when restoration %s', async mode => {
    vi.useFakeTimers();
    vi.spyOn(readCache, 'waitForReadRestoration').mockImplementation(() => mode === 'hangs'
      ? new Promise<void>(() => {}) : Promise.reject(new Error('Storage blocked')));
    const id = 'a'.repeat(64);
    beginHintPreview({ hintId: id },
      `board_session_hint=${encodeURIComponent(JSON.stringify({ id, visibilityKey: 'key' }))}`);
    const fetch = vi.fn(async () => Response.json({ repos: ['network repo'] }));
    vi.stubGlobal('fetch', fetch);
    const result = apiFetch('/api/repos').then(response => response.json()).catch(error => error);
    await vi.advanceTimersByTimeAsync(450);
    expect(fetch).not.toHaveBeenCalled();
    finishHintPreview(true);
    expect(await result).toEqual({ repos: ['network repo'] });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
