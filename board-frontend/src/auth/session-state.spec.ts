import { describe, expect, it } from 'vitest';
import { mapError, nextSession, type SessionView } from './session-state';
import { type Route } from '../route';

const ME = { email: 'ivan.roslov@example.com', isAdmin: false };

describe('mapError', () => {
  it('sends the unauthenticated sentinel to the sign-in gate', () => {
    expect(mapError(new Error('unauthenticated'))).toEqual({ kind: 'login' });
  });

  it('sends the forbidden sentinel to the forbidden gate', () => {
    expect(mapError(new Error('forbidden'))).toEqual({ kind: 'forbidden' });
  });

  it('keeps any other message for the error gate', () => {
    expect(mapError(new Error('me 502'))).toEqual({ kind: 'error', message: 'me 502' });
  });
});

describe('nextSession on expiry', () => {
  it('moves a live session to expired, keeping who it was', () => {
    const ready: SessionView = { kind: 'ready', me: ME };
    expect(nextSession(ready, 'expired')).toEqual({ kind: 'expired', me: ME });
  });

  it('is idempotent — a stray second signal returns the SAME object', () => {
    // Object identity, not equality: a new object would re-render the app and
    // could re-run the effects that transition it.
    const expired = nextSession({ kind: 'ready', me: ME }, 'expired');
    expect(nextSession(expired, 'expired')).toBe(expired);
  });

  it('ignores an expiry while the mount probe is still running', () => {
    // An ordinary signed-out first load 401s on /api/auth/me. That is the
    // sign-in screen's job, not an expiry banner's.
    const loading: SessionView = { kind: 'loading' };
    expect(nextSession(loading, 'expired')).toBe(loading);
  });

  it('ignores an expiry at the sign-in and forbidden gates', () => {
    const login: SessionView = { kind: 'login' };
    const forbidden: SessionView = { kind: 'forbidden' };
    const failed: SessionView = { kind: 'error', message: 'me 502' };
    expect(nextSession(login, 'expired')).toBe(login);
    expect(nextSession(forbidden, 'expired')).toBe(forbidden);
    expect(nextSession(failed, 'expired')).toBe(failed);
  });
});


describe('nextSession over a session nothing has verified yet', () => {
  it('leaves an unverified session alone on an expiry signal', () => {
    // The mount probe's own answer is what settles this one, and it is coming.
    // A 401 raised before the probe answers wipes the cache in
    // `notifySessionExpired` and the probe's rejection puts the ordinary gate
    // up, so there is nothing for the expiry banner to do over a session that
    // was never live. `loading` is what that state is called since #892 removed
    // the `remembered` one this used to name.
    const loading: SessionView = { kind: 'loading' };
    expect(nextSession(loading, 'expired')).toBe(loading);
  });
});
