/**
 * The board's session state machine (#512), lifted out of App so it can be
 * tested at all. `mapError` is the mount probe's mapping, unchanged, and
 * `expired` is the state a live session moves to when a request comes back 401.
 *
 * A loading session may paint a hinted cache preview. It has no verified identity.
 */

export type Me = Pick<import('../api/types').MeResponse, 'email' | 'isAdmin'> & Partial<import('../api/types').MeResponse>;

export type SessionView =
  | { kind: 'loading'; hint?: boolean }
  | { kind: 'ready'; me: Me }
  /** Live a moment ago, refused now. The page stays mounted underneath — the
   *  banner is what changes — so nothing half-written is thrown away. */
  | { kind: 'expired'; me: Me }
  | { kind: 'login' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string };

/** What the mount probe's rejection means. */
export function mapError(e: unknown): { kind: 'login' } | { kind: 'forbidden' } | { kind: 'error'; message: string } {
  const msg = (e as Error).message;
  if (msg === 'unauthenticated') return { kind: 'login' };
  if (msg === 'forbidden') return { kind: 'forbidden' };
  return { kind: 'error', message: msg };
}

export type SessionEvent = 'expired';

/**
 * Only a session that was live can expire. Anything else — the mount probe
 * still running, or a gate already on screen — keeps the state it has, and it
 * keeps the same object, so a stray signal cannot cause a re-render.
 */
export function nextSession(current: SessionView, event: SessionEvent): SessionView {
  if (event === 'expired' && current.kind === 'ready') return { kind: 'expired', me: current.me };
  return current;
}
