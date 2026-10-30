/**
 * The URL's `?search` as something read during render (#461).
 *
 * The app pushes history in two ways. `gotoPath` dispatches a synthetic popstate
 * afterwards; `App`'s own `navigate` does not — it pushes and re-renders, and a
 * listener is never told. Anything that mirrors the URL into state therefore
 * goes stale on the second kind, and stays stale until something else moves it.
 *
 * The Unit page had both halves doing this and only one of them fixed, which is
 * the worst arrangement of the three: the tiles above cleared on a sidebar press
 * and the queue below went on filtering to a member, under a bare URL. So the
 * mechanism lives in one place now and both halves call it. The subscription is
 * only the signal that a re-render is due — the value comes from `location`
 * itself, so ANY render sees the current URL, whatever caused it.
 */
import { useSyncExternalStore } from 'react';

/** The `?search` as the browser holds it, right now. */
export const readSearch = (): string => window.location.search;

/** Re-render on any history transition. Module-level, so React subscribes once
 *  rather than on every render. */
export function subscribeToHistory(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  return () => window.removeEventListener('popstate', onChange);
}

/** The current `?search`, refreshed on every render and on every history move. */
export function useLocationSearch(): string {
  return useSyncExternalStore(subscribeToHistory, readSearch);
}
