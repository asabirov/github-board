import { clearSessionHint } from './session-hint';
/**
 * The one place the app learns its session died (#512).
 *
 * A dead session produces a burst of 401s, not one: five land on the first load
 * of "/", twenty across a walk of six surfaces, three more on every focus. So
 * the signal is latched — the FIRST 401 after the app is live tells the app
 * once, and every 401 after it is silent until the latch is deliberately
 * re-armed by a fresh sign-in.
 *
 * The latch is module state rather than React state on purpose: it is set
 * before React has scheduled anything, so concurrent promise resolutions cannot
 * race it into a second transition.
 *
 * No React and no import from `api.ts` — `api.ts` imports this, and that must
 * stay a one-way edge. `cache/payload-cache.ts` is safe to import for the same
 * reason: it imports nothing of the app's, so both this file and `api.ts` can
 * reach it without either of them reaching each other.
 */
import { forgetPayloads } from '../cache/payload-cache';

let expired = false;
/** A sign-out this person asked for is under way. The 401s that follow are its
 *  own doing, not the session being lost (#682) — one gate, so no surface has
 *  to work out which kind of 401 it is looking at. */
let signingOut = false;
const listeners = new Set<() => void>();

/** Raised by `logout()` before the request goes out. */
export function beginSignOut(): void {
  signingOut = true;
}

/**
 * Lowered again by a sign-out that ends with the person still on the board —
 * `logout()`'s `unconfirmed`, where nothing was cleared as far as the browser
 * knows. It has to be explicit: nothing else lowers it inside a page load
 * (`resetSessionExpiry` runs once, on the mount probe), so a gate left up would
 * silence a genuine expiry for as long as the tab stays open.
 *
 * Not a "the session is live" claim. If that cookie turns out to be dead after
 * all, the expiry bar saying so is the right answer and not a contradiction.
 */
export function endSignOut(): void {
  signingOut = false;
}

/**
 * Called by `apiFetch` on any 401. Only the first call is delivered.
 *
 * The FIRST 401 is also where the cached payloads go (#824). It has to be here
 * rather than anywhere later: the latch swallows every 401 after this one, so
 * this line is the only moment a dead session is heard at all. A session that
 * has died is a browser that may be handed to somebody else, and the copy on
 * disk must not outlive it.
 *
 * The other way out of a session is a deliberate sign-out, and that is NOT this
 * branch — `signingOut` returns above, by design (#682). `logout()` forgets the
 * payloads itself, before the request goes out, so both exits are covered and
 * neither depends on the other's ordering.
 */
export function notifySessionExpired(): void {
  if (signingOut || expired) return;
  expired = true;
  clearSessionHint();
  forgetPayloads();
  for (const fn of listeners) fn();
}

/** Subscribe to the single expiry notification; returns the unsubscribe. */
export function onSessionExpired(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** True once the session has been seen to expire — read by the auto-refresh
 *  gate so a dead tab stops polling a server that keeps refusing it. */
export function isSessionExpired(): boolean {
  return expired;
}

/** Re-arm the latch. Called by App on a /me that answered (once, at mount) and
 *  by tests; lowers the sign-out gate too, that /me being proof they are signed
 *  in whatever was pressed a moment ago. */
export function resetSessionExpiry(): void {
  expired = false;
  signingOut = false;
}
