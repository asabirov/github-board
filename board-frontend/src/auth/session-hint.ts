/** A hint opens a read-only paint window; it never establishes response identity. */
export const SESSION_HINT_COOKIE = 'board_session_hint';

/**
 * What every read held behind an unverified probe is rejected with (#1324).
 *
 * A NAMED error because the rejection is not a verdict: the read never left the
 * browser, so board-api refused nobody. `probeMe` already decides what a failed
 * probe costs the disk — below 500 it wipes, at 500 and above it wipes nothing —
 * and a rejection read as a refusal undoes that decision from the other side.
 */
export class UnverifiedSessionError extends Error {
  constructor() {
    super('Session was not verified');
    this.name = 'UnverifiedSessionError';
  }
}

/** Whether this rejection is a read the probe never let run. */
export const sessionUnverified = (e: unknown): boolean => e instanceof UnverifiedSessionError;
let pending: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } | null = null;
let checkingSavedOwner = false;

/**
 * Whether this device may paint its saved copy while `/api/auth/me` is out.
 *
 * THE TEST IS THE PERSON (#1395). The hint id is an HMAC of the board subject
 * under the server key, so it names the PERSON and is the same across their
 * devices and their sign-ins, not a per-session value. `hint.id ===
 * owner.hintId` therefore says the cookie this browser is sending and the copy
 * on its disk belong to the same person. That is what authorizes an inert
 * preview of that copy.
 *
 * It used to also require that key to MATCH the one glued onto the stored
 * owner's address, and that is what #1395 removed: the eight-hourly token
 * refresh moves the key, so the copy was there, the person was right, and the
 * board drew loading placeholders until the probe answered anyway. A moved key
 * is compared by `claimFor` instead, once the probe has said what Github reports
 * now. That is the right place for it, because here there is nothing to compare
 * it against that the server has vouched for.
 *
 * THE KEY MUST STILL BE PRESENT, and that is a different test from matching it.
 * OAuth sets this cookie with the id and NO visibility key, because the board
 * has not asked Github anything yet. A preview started on that cookie paints
 * the last session's saved copy before the probe has said who signed in, which
 * on a shared iPad is somebody else's work on screen.
 * `check-reauth-cache.mjs` drives exactly that, and it caught this.
 */
export function beginHintPreview(owner: { hintId?: string } | null, cookie = typeof document === 'undefined' ? '' : document.cookie): boolean {
  if (pending) return true;
  // Hold the copy private until the live probe has said who this is, rather than
  // deleting it on mount. `savedSessionPending` is what the readers below ask.
  checkingSavedOwner = !!owner?.hintId;
  try {
    const raw = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_HINT_COOKIE}=`));
    if (!raw || !owner?.hintId) return false;
    const hint = JSON.parse(decodeURIComponent(raw.slice(SESSION_HINT_COOKIE.length + 1)));
    if (!hint || typeof hint.id !== 'string' || !/^[a-f0-9]{64}$/.test(hint.id)
      || hint.id !== owner.hintId
      || typeof hint.visibilityKey !== 'string' || !hint.visibilityKey) return false;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    pending = { promise, resolve, reject };
    return true;
  } catch { return false; }
}
export const hintPreviewActive = () => pending !== null;
export const savedSessionPending = () => checkingSavedOwner;
export const waitForHintProbe = () => pending?.promise ?? Promise.resolve();
export function finishHintPreview(verified: boolean): void {
  checkingSavedOwner = false;
  const held = pending;
  pending = null;
  if (verified) held?.resolve();
  else held?.reject(new UnverifiedSessionError());
}
export function clearSessionHint(): void {
  try {
    if (typeof document !== 'undefined') document.cookie = `${SESSION_HINT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  } catch { /* A denied cookie store must not stop server sign-out or the cache wipe. */ }
  finishHintPreview(false);
}
