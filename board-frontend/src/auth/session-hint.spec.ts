import { afterEach, expect, it } from 'vitest';
import { beginHintPreview, finishHintPreview, hintPreviewActive, waitForHintProbe } from './session-hint';
const id = 'a'.repeat(64);
const owner = { email: 'person@example.test', at: Date.now(), hintId: id };
const cookie = `board_session_hint=${encodeURIComponent(JSON.stringify({ id, visibilityKey: 'visible' }))}`;
afterEach(() => finishHintPreview(false));
it('starts a paint preview only for the matching session', () => {
  expect(beginHintPreview(owner, cookie)).toBe(true);
  expect(hintPreviewActive()).toBe(true);
  finishHintPreview(true);
  expect(beginHintPreview({ ...owner, hintId: 'b'.repeat(64) }, cookie)).toBe(false);
});

/**
 * #1395. This used to require the cookie's visibility key to match the one glued
 * onto the stored owner's address, and that is the assertion the reported bug
 * lived behind: the key moves on every eight-hour Github token refresh, so the
 * copy was on the disk, the person was right, and the board drew loading
 * placeholders anyway until the probe came back.
 *
 * A changed key is still answered — by `claimFor`, once `/api/auth/me` has said
 * what Github reports now, which is the only reading of it the server has
 * vouched for. The preview this authorizes is inert and draws nothing but the
 * reader's own last answer.
 */
it('does not refuse the session over a visibility key that moved', () => {
  expect(beginHintPreview(owner, `board_session_hint=${encodeURIComponent(JSON.stringify({ id, visibilityKey: 'moved' }))}`)).toBe(true);
});
it('rejects absent and malformed hints', () => {
  for (const value of ['', 'board_session_hint=%', 'board_session_hint=null']) {
    expect(beginHintPreview(owner, value)).toBe(false);
  }
});
it('holds reads until the probe succeeds and refuses them on failure', async () => {
  beginHintPreview(owner, cookie);
  let released = false;
  const pending = waitForHintProbe().then(() => { released = true; });
  await Promise.resolve();
  expect(released).toBe(false);
  finishHintPreview(true);
  await pending;
  expect(released).toBe(true);
  beginHintPreview(owner, cookie);
  const refused = expect(waitForHintProbe()).rejects.toThrow('Session was not verified');
  finishHintPreview(false);
  await refused;
});

it('does not turn a hint into response identity', async () => {
  const { currentResponseIdentity, setResponseIdentity } = await import('./response-deadline');
  setResponseIdentity(null, false);
  beginHintPreview(owner, cookie);
  expect(currentResponseIdentity()).toBeNull();
});
