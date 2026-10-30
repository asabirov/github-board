import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginSignOut,
  endSignOut,
  isSessionExpired,
  notifySessionExpired,
  onSessionExpired,
  resetSessionExpiry,
} from './session-expiry';

beforeEach(() => resetSessionExpiry());

describe('session-expiry latch (#512)', () => {
  it('tells a subscriber the session ended', () => {
    const seen = vi.fn();
    onSessionExpired(seen);
    notifySessionExpired();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('collapses a stampede of 401s into ONE notification', () => {
    // Measured against production: five concurrent 401s on the first load of
    // '/', twenty across a six-surface walk. Every one of them calls notify;
    // the person must be told once.
    const seen = vi.fn();
    onSessionExpired(seen);
    for (let i = 0; i < 10; i++) notifySessionExpired();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('reports the expired state before and after the first notification', () => {
    expect(isSessionExpired()).toBe(false);
    notifySessionExpired();
    expect(isSessionExpired()).toBe(true);
  });

  it('re-arms on reset, so a later expiry fires again', () => {
    const seen = vi.fn();
    onSessionExpired(seen);
    notifySessionExpired();
    resetSessionExpiry();
    expect(isSessionExpired()).toBe(false);
    notifySessionExpired();
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('stops delivering to an unsubscribed listener', () => {
    const seen = vi.fn();
    const off = onSessionExpired(seen);
    off();
    notifySessionExpired();
    expect(seen).not.toHaveBeenCalled();
  });

  it('delivers the single notification to every subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    onSessionExpired(a);
    onSessionExpired(b);
    notifySessionExpired();
    notifySessionExpired();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does not throw when nobody is listening', () => {
    expect(() => notifySessionExpired()).not.toThrow();
  });
});

describe('a sign-out silences the expiry signal (#682)', () => {
  it('says nothing when the 401s are the sign-out the person asked for', () => {
    // Signing out clears the cookie, and the polling surfaces then 401 with the
    // page still mounted. Unsilenced, that reads as "your session ended" over a
    // sign-out notice — and App stashes the deep link on the way, for the next
    // person on a shared machine to be sent to.
    const seen = vi.fn();
    onSessionExpired(seen);
    beginSignOut();
    notifySessionExpired();
    expect(seen).not.toHaveBeenCalled();
    expect(isSessionExpired()).toBe(false);
  });

  it('is lowered again by a sign-out that ends with the person still here', () => {
    // The gate is raised for the whole page load, and only a fresh /me lowers it
    // — so a sign-out that failed to leave would silence every later 401 for as
    // long as the tab stays open. `endSignOut` is what a caller that is staying
    // calls, and after it the expiry machinery works normally again.
    const seen = vi.fn();
    onSessionExpired(seen);
    beginSignOut();
    endSignOut();
    notifySessionExpired();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(isSessionExpired()).toBe(true);
  });

  it('is not a permanent mute — a live session again, and a later expiry is heard', () => {
    const seen = vi.fn();
    onSessionExpired(seen);
    beginSignOut();
    notifySessionExpired();
    resetSessionExpiry();
    notifySessionExpired();
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
