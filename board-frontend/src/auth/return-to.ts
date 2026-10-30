// Deep links must survive the OAuth round-trip (#79): beginLogin() leaves the
// SPA entirely and the server callback always redirects to '/', so the
// pre-login URL is stashed in sessionStorage and replayed by App once the
// session is live. sessionStorage is per-tab and survives the redirect chain.

const KEY = 'board.returnTo';

// --- Pure logic (unit-tested; no storage access) ---

/**
 * Only same-app absolute paths may be replayed: no schemes, no
 * protocol-relative '//host', and '/' itself is not worth saving.
 */
export function isReturnTarget(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && v !== '/';
}

// --- Environment wrappers (not unit-tested) ---

/** Called right before the login redirect with `pathname + search`. */
export function saveReturnTo(path: string): void {
  try {
    if (isReturnTarget(path)) sessionStorage.setItem(KEY, path);
  } catch {
    // Storage unavailable (e.g. blocked cookies/storage) — login still works,
    // the user just lands on the dashboard.
  }
}

/**
 * Whether a deep link is waiting to be replayed — READ ONLY, so the replay above
 * still gets it.
 *
 * App asks before applying the remembered org (#714): both act on the bare `/`
 * the OAuth callback lands on, and the org would rewrite the address out from
 * under the replay, which keys on that path being exactly `/`. A login in
 * flight wins; there is nowhere else this needs to be asked.
 */
export function hasReturnTo(): boolean {
  try {
    return isReturnTarget(sessionStorage.getItem(KEY));
  } catch {
    return false;
  }
}

/** Reads AND clears the stashed path; null when absent or invalid. */
export function consumeReturnTo(): string | null {
  try {
    const v = sessionStorage.getItem(KEY);
    if (v !== null) sessionStorage.removeItem(KEY);
    return isReturnTarget(v) ? v : null;
  } catch {
    return null;
  }
}
