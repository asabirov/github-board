// Auth is backend-mediated GitHub OAuth: the SPA just kicks off the login and the
// server sets an httpOnly session cookie. No tokens in JS.

import { forgetPayloads } from '../cache/payload-cache';
import { saveReturnTo } from './return-to';

// Same-origin only (see api.ts) — the cross-origin API base was removed (#112).
const API = '';

/** The board signs in with GitHub when a login endpoint is reachable. Always true in this build. */
export function authEnabled(): boolean {
  return true;
}

export function beginLogin(): void {
  // Whoever is about to sign in is not necessarily whoever this browser last
  // held (#824). This is the ordinary shared-machine path and not an edge case:
  // person B presses Sign in, comes back to '/' with their own cookie, and the
  // board painted person A's queue, roster and figures from the disk while
  // `/api/auth/me` was in flight — after B had authenticated. `claimFor` does
  // wipe on a change of owner, but only once that probe has answered, which is
  // exactly the round trip this window is.
  //
  // Before the redirect rather than after it: nothing here runs again once the
  // browser has left, and a wipe that depends on coming back is no wipe. The
  // cost of being wrong is one skeleton for the person signing back into their
  // own session, which is the same trade `logout()` makes.
  forgetPayloads();
  // The server callback always lands on '/' — stash the deep link so App can
  // replay it after the session is established (#79). Drop the callback's own
  // ?error= param first: on a retry after a failed attempt the current URL is
  // '/?error=auth_failed', which must not clobber the original stash
  // (saveReturnTo keeps the existing entry when the candidate is not worth
  // saving).
  const params = new URLSearchParams(window.location.search);
  params.delete('error');
  const qs = params.toString();
  saveReturnTo(window.location.pathname + (qs ? `?${qs}` : ''));
  window.location.href = `${API}/api/auth/github/login`;
}
// Sign-out lives in api.ts (logout) and sign-out-run.ts — it POSTs, reads the
// answer, and redirects only on a sign-out the board confirmed.
