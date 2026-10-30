import { describe, expect, it, vi } from 'vitest';
import type { LogoutOutcome } from '../api/core';
import { createSignOut } from './sign-out-run';
import type { SignOutNoticeState } from './sign-out-copy';

const SENTENCE = 'Signed out of this browser, but connected clients could not be revoked.';

/** A logout that answers the given outcomes in order, one per call, and only
 *  when the test releases it — so two presses can genuinely overlap. */
function queuedLogout(...outcomes: LogoutOutcome[]) {
  const releases: Array<() => void> = [];
  const calls = vi.fn(() => new Promise<LogoutOutcome>((resolve) => {
    const outcome = outcomes[releases.length] ?? { kind: 'clean' as const };
    releases.push(() => resolve(outcome));
  }));
  return { logout: calls, release: (i = 0) => releases[i](), pending: () => releases.length };
}

const shown: SignOutNoticeState[] = [];
const wiring = (logout: () => Promise<LogoutOutcome>) => {
  const show = vi.fn((n: SignOutNoticeState | null) => { if (n) shown.push(n); });
  const leave = vi.fn();
  return { logout, show, leave };
};

describe('one sign-out at a time (#682)', () => {
  it('shows the server’s sentence and stays put when the revocation was refused', async () => {
    const deps = wiring(async () => ({ kind: 'refused', message: SENTENCE }));
    await createSignOut(deps)();
    expect(deps.show).toHaveBeenCalledTimes(1);
    expect(deps.show.mock.calls[0][0]?.message).toBe(SENTENCE);
    expect(deps.leave).not.toHaveBeenCalled();
  });

  it('draws nothing and leaves when the sign-out was clean', async () => {
    const deps = wiring(async () => ({ kind: 'clean' }));
    await createSignOut(deps)();
    expect(deps.show).toHaveBeenCalledWith(null);
    expect(deps.leave).toHaveBeenCalledTimes(1);
  });

  it('ignores a second press while one is in flight', async () => {
    // Three controls call this — the fallback button, the menu item, and the
    // notice's own Try again — and a flaky network is exactly when somebody
    // presses twice.
    const q = queuedLogout({ kind: 'refused', message: SENTENCE });
    const deps = wiring(q.logout);
    const signOut = createSignOut(deps);
    const first = signOut();
    const second = signOut();
    expect(q.pending()).toBe(1);
    q.release(0);
    await Promise.all([first, second]);
    expect(q.logout).toHaveBeenCalledTimes(1);
  });

  it('cannot lose a refused notice to a second sign-out settling behind it', async () => {
    // The defect: refused settles first, a clean one settles second, `show(null)`
    // unmounts the dialog and `leave()` navigates — the sentence gone unread.
    const q = queuedLogout({ kind: 'refused', message: SENTENCE }, { kind: 'clean' });
    const deps = wiring(q.logout);
    const signOut = createSignOut(deps);
    const first = signOut();
    const second = signOut();
    q.release(0);
    await Promise.all([first, second]);
    expect(deps.show).toHaveBeenCalledTimes(1);
    expect(deps.show).not.toHaveBeenCalledWith(null);
    expect(deps.leave).not.toHaveBeenCalled();
  });

  it('is not a one-shot — a press after the last one settled runs again', async () => {
    const q = queuedLogout({ kind: 'refused', message: SENTENCE }, { kind: 'clean' });
    const deps = wiring(q.logout);
    const signOut = createSignOut(deps);
    const first = signOut();
    q.release(0);
    await first;
    const second = signOut();
    q.release(1);
    await second;
    expect(q.logout).toHaveBeenCalledTimes(2);
    expect(deps.leave).toHaveBeenCalledTimes(1);
  });

  it('retries from the notice, through the same one-at-a-time gate', async () => {
    const q = queuedLogout({ kind: 'unconfirmed' }, { kind: 'clean' });
    const deps = wiring(q.logout);
    const first = createSignOut(deps)();
    q.release(0);
    await first;
    const notice = deps.show.mock.calls[0][0]!;
    notice.onAction();          // "Try again"
    notice.onAction();          // …pressed twice, as people do
    expect(q.pending()).toBe(2); // one new attempt, not two
    q.release(1);
    await Promise.resolve();
    expect(q.logout).toHaveBeenCalledTimes(2);
  });
});
