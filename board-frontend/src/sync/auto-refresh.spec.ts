import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTO_REFRESH_MS,
  FOCUS_REFRESH_THROTTLE_MS,
  MIN_AUTO_REFRESH_MS,
  resolveAutoRefreshMs,
  shouldRefreshOnFocus,
  shouldRefreshOnTick,
} from './auto-refresh';

describe('resolveAutoRefreshMs', () => {
  it('falls back to the default when unset/blank', () => {
    expect(resolveAutoRefreshMs(undefined)).toBe(DEFAULT_AUTO_REFRESH_MS);
    expect(resolveAutoRefreshMs(null)).toBe(DEFAULT_AUTO_REFRESH_MS);
    expect(resolveAutoRefreshMs('')).toBe(DEFAULT_AUTO_REFRESH_MS);
  });

  it('accepts a positive interval, floored to whole ms', () => {
    expect(resolveAutoRefreshMs('90000')).toBe(90_000);
    expect(resolveAutoRefreshMs('45000.7')).toBe(45_000);
  });

  it('treats 0 as "disable the periodic poll" — not floored', () => {
    expect(resolveAutoRefreshMs('0')).toBe(0);
  });

  it('raises a sub-floor positive value to the minimum', () => {
    expect(resolveAutoRefreshMs('100')).toBe(MIN_AUTO_REFRESH_MS);
    expect(MIN_AUTO_REFRESH_MS).toBe(15_000);
  });

  it('keeps a value exactly at the floor', () => {
    expect(resolveAutoRefreshMs('15000')).toBe(15_000);
  });

  it('rejects garbage and negatives → default', () => {
    expect(resolveAutoRefreshMs('nope')).toBe(DEFAULT_AUTO_REFRESH_MS);
    expect(resolveAutoRefreshMs('-1000')).toBe(DEFAULT_AUTO_REFRESH_MS);
    expect(resolveAutoRefreshMs('NaN')).toBe(DEFAULT_AUTO_REFRESH_MS);
  });
});

describe('shouldRefreshOnTick (#512)', () => {
  it('refreshes a visible tab with a live session', () => {
    expect(shouldRefreshOnTick({ expired: false, visible: true })).toBe(true);
  });

  it('stops the moment the session is known to be dead', () => {
    // Otherwise a tab left open overnight keeps calling a server that refuses
    // it, every two minutes, until the laptop closes.
    expect(shouldRefreshOnTick({ expired: true, visible: true })).toBe(false);
  });

  it('leaves a hidden tab alone', () => {
    expect(shouldRefreshOnTick({ expired: false, visible: false })).toBe(false);
  });
});

describe('shouldRefreshOnFocus (#512)', () => {
  const live = { expired: false, visible: true, sinceLastRefreshMs: FOCUS_REFRESH_THROTTLE_MS + 1 };

  it('refetches when a visible tab regains focus after the throttle window', () => {
    expect(shouldRefreshOnFocus(live)).toBe(true);
  });

  it('stops the moment the session is known to be dead', () => {
    // The reproduction measured three requests per focus event against a dead
    // session, forever.
    expect(shouldRefreshOnFocus({ ...live, expired: true })).toBe(false);
  });

  it('leaves a hidden tab alone', () => {
    expect(shouldRefreshOnFocus({ ...live, visible: false })).toBe(false);
  });

  it('still throttles rapid tab-flipping', () => {
    expect(shouldRefreshOnFocus({ ...live, sinceLastRefreshMs: 0 })).toBe(false);
    expect(shouldRefreshOnFocus({ ...live, sinceLastRefreshMs: FOCUS_REFRESH_THROTTLE_MS - 1 })).toBe(false);
  });
});
