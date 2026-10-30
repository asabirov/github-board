import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/core';
import type { ReposView } from '../api/repos';
import { setResponseIdentity } from '../auth/response-deadline';
import { claimFor, forgetPayloads, forgetSensitivePayloads, keepSaved, reposKey, setPayloadStore } from '../cache/payload-cache';
import { ACCESS_NOT_NOW_CODE, drawable, SAVED_COPY_MAX_AGE_MS } from '../projects/projects-last-good';
import { saveRepos, savedRepos } from './repos-last-good';

const view: ReposView = { updatedAt: '2026-09-25T09:00:00Z', repos: [], driOptions: [] };
const outage = () => new ApiError(502, 'repos 502');
beforeEach(() => {
  const map = new Map<string, string>();
  setPayloadStore({ get length() { return map.size; }, key: i => [...map.keys()][i] ?? null,
    getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, removeItem: key => { map.delete(key); } });
  claimFor('reader@example.com');
  setResponseIdentity('reader-github', true);
});
afterEach(() => { setPayloadStore(undefined); setResponseIdentity(null, false); vi.useRealTimers(); });

describe('saved repo maps', () => {
  it('recalls the map after sensitive reads are cleared on reload', () => {
    saveRepos(null, view);
    forgetSensitivePayloads();
    expect(savedRepos(null, outage())?.value).toEqual(view);
  });
  it('accepts a network failure and the auth-layer cooldown', () => {
    saveRepos(null, view);
    expect(savedRepos(null, new TypeError('Failed to fetch'))?.value).toEqual(view);
    expect(savedRepos(null, new ApiError(503, 'repos 503', undefined, undefined, undefined, ACCESS_NOT_NOW_CODE))?.value).toEqual(view);
  });
  it('never recalls another organization or identity', () => {
    saveRepos('one', view);
    expect(savedRepos('two', outage())).toBeNull();
    setResponseIdentity('other-github', true);
    expect(savedRepos('one', outage())).toBeNull();
  });
  it.each([401, 403, 404])('forgets every scope after refusal %i', status => {
    saveRepos(null, view);
    saveRepos('one', view);
    expect(savedRepos('one', new ApiError(status, 'refused'))).toBeNull();
    expect(savedRepos(null, outage())).toBeNull();
  });

  // #1395. These three were on the list above, and the repos map is where it
  // showed worst: a 409 or a 500 during a deploy emptied the page, and the next
  // open had no map saved to draw.
  it.each([409, 500, 503])('keeps every scope through a %i, which is not a refusal', status => {
    saveRepos(null, view);
    saveRepos('one', view);
    expect(savedRepos('one', new ApiError(status, 'failed'))?.value).toEqual(view);
    expect(savedRepos(null, outage())?.value).toEqual(view);
  });
  it('rejects an expired or malformed map', () => {
    vi.useFakeTimers();
    saveRepos(null, view);
    vi.advanceTimersByTime(SAVED_COPY_MAX_AGE_MS + 1);
    expect(savedRepos(null, outage())).toBeNull();
    keepSaved(reposKey(null), { updatedAt: '', repos: [{}], driOptions: [] });
    expect(savedRepos(null, outage())).toBeNull();
  });
  it('stops drawing a recalled map after an organization change or sign-out', () => {
    saveRepos('one', view);
    const copy = savedRepos('one', outage());
    expect(drawable(copy, 'one')).not.toBeNull();
    expect(drawable(copy, 'two')).toBeNull();
    forgetPayloads();
    expect(drawable(copy, 'one')).toBeNull();
  });
});
