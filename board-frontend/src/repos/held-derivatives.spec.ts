import { afterEach, expect, it, vi } from 'vitest';
import type { ReposHealthView } from '../api/repos';
import { forgetSensitivePayloads } from '../cache/payload-cache';
import { responseDeadline, responseExpired, setResponseIdentity, tagResponse } from '../auth/response-deadline';
import { healthByRepo } from './repos-vm';

const fixtures = {
  health: (): ReposHealthView => ({ repos: [], unreadableOrgs: ['private org'] }),
};
afterEach(() => { setResponseIdentity(null, false); vi.useRealTimers(); });

it('health map keeps its source deadline through shell renewal and fresh replacement', () => {
  vi.useFakeTimers();
  const lease = { visibilityKey: 'reader', expiresAt: Date.now() + 60_000 };
  setResponseIdentity('reader', true, lease.expiresAt);
  const derive = () => healthByRepo(tagResponse(fixtures.health(), lease));
  const old = derive();
  expect(responseDeadline(old)).toEqual(lease);
  vi.advanceTimersByTime(30_000);
  const nextLease = { ...lease, expiresAt: Date.now() + 60_000 };
  setResponseIdentity('reader', true, nextLease.expiresAt);
  const fresh = healthByRepo(tagResponse(fixtures.health(), nextLease));
  expect(responseDeadline(old)).toEqual(lease);
  expect(responseDeadline(fresh)).toEqual(nextLease);
  vi.advanceTimersByTime(30_000);
  expect(responseExpired(old)).toBe(false);
  expect(responseExpired(fresh)).toBe(false);
  forgetSensitivePayloads();
  setResponseIdentity('reader', true, nextLease.expiresAt);
  expect(responseExpired(fresh)).toBe(true);
  const refill = healthByRepo(tagResponse(fixtures.health(), { ...nextLease }));
  expect(responseExpired(refill)).toBe(false);
});
