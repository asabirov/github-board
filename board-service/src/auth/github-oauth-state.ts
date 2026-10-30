import { randomBytes } from 'node:crypto';

/**
 * The OAuth state for a GitHub sign-in (#1450). The state travels in an
 * `httpOnly` cookie and the `state` query parameter GitHub echoes back must
 * equal it, so a callback aimed at somebody else's flow is refused before any
 * code is spent. Clearing the cookie in the callback is housekeeping, not
 * enforcement: the credential's compare-and-swap on the row's version is what
 * refuses concurrent or replayed callbacks.
 */

/** The value that goes in the `state` query parameter. */
export const newStateValue = (): string => randomBytes(32).toString('base64url');
