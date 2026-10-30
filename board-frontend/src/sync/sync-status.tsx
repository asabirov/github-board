import { observeSync, type BoardFreshness, type SyncOperation } from './sync-operation';
/**
 * Global "Synced …" clock (#256). One place — the top bar — shows how fresh the
 * board's data is, instead of a copy inside each page.
 *
 * WHERE THAT TIME COMES FROM changed in #1169. It used to be reported UP from
 * whichever data surface happened to be mounted, each passing its payload's own
 * fetch time to a `useReportSync` hook, and the provider kept the most recent of
 * them. The Board sync panel's five rows meanwhile read `SyncOperation.sources` —
 * a record of one MANUAL run in this tab, absent until somebody presses the
 * button here. So the header and the panel were two readings of one fact, and
 * the screenshot in #1169 is them disagreeing: "Synced 8m ago" over five rows
 * reading "Not recorded", on a board whose sources had all just refreshed.
 *
 * Both read `GET /api/sync/sources` now — when each of the four sources last
 * refreshed, out of the caches the server is already serving from. It covers
 * every source whether or not its page is open, which reporting up never could,
 * and there is no second reading left to disagree with it.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { fetchSyncSources, startSyncOperation, readSyncOperation } from '../api/issues';
import { isSessionExpired, onSessionExpired } from '../auth/session-expiry';
import { resolveAutoRefreshMs, shouldRefreshOnFocus, shouldRefreshOnTick } from './auto-refresh';

/** Age past which the clock reads "stale" (amber dot). Set well beyond the slowest
 *  source TTL (issue-metrics ~10min) so amber signals a genuinely lagging refresh,
 *  not a normal cache cycle. */
export const STALE_AFTER_MS = 15 * 60_000;

interface SyncValue {
  /** When each of the four sources last refreshed, as the server reports it, or
   *  null before the first read of it has landed (#1169). The chip and the Board
   *  sync panel both draw from this and from nothing else. */
  freshness: BoardFreshness | null;
  pageMayBeOutdated: boolean;
  reportOutdated: (surface: symbol, outdated: boolean) => void;
  /** True while a manual "sync now" is in flight (#301). */
  syncing: boolean;
  /** True when the last manual sync failed — the stamp shows an error, not a
   *  silent no-op. Cleared when a new sync starts. */
  syncError: boolean;
  operation: SyncOperation | null;
  /** Bumped after each successful manual sync so data pages refetch (they add
   *  it to their fetch effect deps). */
  refreshNonce: number;
  /** Bumped once per COMPLETED Github access check (#892 review, C2). Read only
   *  by the surfaces a check does not reauthorize — see `useAccessEpoch`. */
  accessEpoch: number;
  renewalNonce: number;
  /** Trigger a manual sync: force-refresh the server caches, then signal pages
   *  to refetch. Ignores repeat presses while one is already running. */
  requestSync: () => void;
  /** Soft client-side bump of `refreshNonce` — no server round-trip (#384). A
   *  successful in-board write already refreshed GitHub + evicted the issue's
   *  server cache; this nudges OTHER mounted views (list/board/Unit/throughput),
   *  whose own caches still hold pre-edit values, to refetch (against the server's
   *  stale-while-revalidate caches) rather than stay stale until their TTL. */
  bump: () => void;
}

const SyncCtx = createContext<SyncValue>({
  freshness: null,
  pageMayBeOutdated: false,
  reportOutdated: () => {},
  syncing: false,
  syncError: false,
  operation: null,
  refreshNonce: 0,
  accessEpoch: 0,
  renewalNonce: 0,
  requestSync: () => {},
  bump: () => {},
});

/**
 * The event `App` fires once a fresh Github access check has answered (#892
 * review, C2).
 *
 * `App` owns the check — it holds the deadline and the probe — and the surfaces
 * that have to react to one are mounted well below it, so the signal travels the
 * way `refreshNonce` already does rather than as a prop through six components.
 * It is fired AFTER the probe succeeds, never at the expiry itself: a refetch
 * issued before the new check has answered would be authorized by the old one.
 */
export const ACCESS_VERIFIED_EVENT = 'board-github-verified';
export const ACCESS_RENEWED_EVENT = 'board-github-renewed';

/**
 * `enabled` is false while the identity probe is still in flight (#1229
 * step 1): the shell is up, but `/api/sync/sources` is a read like any other
 * and the probe is the only request the board makes before it knows whose
 * browser this is. The top bar and the phone sheet draw the chip's place as a
 * placeholder for that one round trip (`ui/ProbeShell.tsx`).
 */
export function SyncProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const [outdatedSurfaces, setOutdatedSurfaces] = useState<ReadonlySet<symbol>>(() => new Set());
  const reportOutdated = useCallback((surface: symbol, outdated: boolean) => {
    setOutdatedSurfaces(current => {
      if (current.has(surface) === outdated) return current;
      const next = new Set(current);
      if (outdated) next.add(surface);
      else next.delete(surface);
      return next;
    });
  }, []);
  const [freshness, setFreshness] = useState<BoardFreshness | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(false);
  // Plain state: progress carries no Github data, so the server does not mark
  // it permission-sensitive and nothing here expires it (#976).
  const [operation, setOperation] = useState<SyncOperation | null>(null);
  const active = useRef<AbortController | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Bumped once per completed access check, and read only by the surfaces whose
  // answers a check does not release — see `useAccessEpoch`.
  const [accessEpoch, setAccessEpoch] = useState(0);
  const [renewalNonce, setRenewalNonce] = useState(0);
  // When the last refetch fired (manual OR auto), so the focus listener can
  // throttle rapid tab-flipping without touching render state.
  const lastRefreshAt = useRef(0);

  /**
   * Re-read when each source last refreshed (#1169).
   *
   * A FAILED read keeps what is held rather than blanking it. One poll that did
   * not answer is not evidence that four sources stopped being fresh, and a chip
   * that fell back to "Sync now" on a dropped request would be making exactly
   * the kind of claim this issue is about, in the other direction.
   */
  const readFreshness = useCallback(() => {
    fetchSyncSources().then(setFreshness).catch(() => {});
  }, []);

  // Soft refresh (#375): signal pages to refetch against the server's stale-
  // while-revalidate caches. No force "sync now", so it respects the source
  // TTLs and never storms GitHub. Drives the interval + focus auto-refresh.
  const softRefresh = useCallback(() => {
    lastRefreshAt.current = Date.now();
    setRefreshNonce((n) => n + 1);
  }, []);

  // The first read, and every later one a refresh asks for. On mount rather
  // than on the panel opening: the chip carries this time too, and it is the
  // thing a person reads without opening anything.
  useEffect(() => { if (enabled) readFreshness(); }, [enabled, readFreshness]);

  const stopSync = useCallback(() => {
    active.current?.abort();
    active.current = null;
    setOperation(null);
    setSyncing(false);
    setSyncError(false);
  }, [setOperation]);

  // Only a dead session stops watching a run. A Github access re-check does not
  // (#976): the run is not tied to one, and each progress read is authorized by
  // its own. A re-check that found different access changes the visibility key
  // App mounts this provider under, which ends the watch with the tree. One that
  // found the same access lets the next read carry on. Stopping here on every
  // re-check dropped runs that were fine, with no word said.
  useEffect(() => {
    const unsubscribe = onSessionExpired(stopSync);
    return () => {
      unsubscribe();
      active.current?.abort();
      active.current = null;
    };
  }, [stopSync]);

  const requestSync = useCallback(() => {
    if (active.current || isSessionExpired()) return;
    const controller = new AbortController();
    active.current = controller;
    setSyncing(true);
    setSyncError(false);
    setOperation(null);
    void observeSync(startSyncOperation, readSyncOperation, (next) => {
      if (active.current === controller && !controller.signal.aborted) setOperation(next);
    }, controller.signal).then((result) => {
      if (active.current !== controller || controller.signal.aborted) return;
      if (result.state === 'succeeded' && result.syncedAt) {
        // The four caches have just been refilled, so their record has moved.
        // Read it now rather than waiting for the next poll: the press is the
        // one moment a person is watching the chip.
        readFreshness();
        lastRefreshAt.current = Date.now();
        setRefreshNonce((n) => n + 1);
      } else setSyncError(true);
    }).catch(() => {
      if (active.current !== controller || controller.signal.aborted) return;
      setOperation(null);
      setSyncError(true);
    }).finally(() => {
      if (active.current !== controller) return;
      active.current = null;
      setSyncing(false);
    });
  }, [readFreshness, setOperation]);

  // Keep an open tab's data (and the "Synced" stamp) moving on its own (#375):
  // a periodic soft refresh plus one when the tab regains focus. Both are
  // paused/ignored while the tab is hidden, and the focus refetch is throttled
  // so rapid tab-flipping can't spam requests. Both also stop dead once the
  // session has expired (#512) — a dead tab must not keep calling a server that
  // refuses it.
  useEffect(() => {
    const intervalMs = resolveAutoRefreshMs(import.meta.env.VITE_AUTO_REFRESH_MS);
    const visible = () => document.visibilityState === 'visible';

    const refresh = () => {
      // The chip's own time comes from here now (#1169), not from the payloads
      // the refetch below produces, so the two go out together.
      readFreshness();
      softRefresh();
    };

    const onFocus = () => {
      const sinceLastRefreshMs = Date.now() - lastRefreshAt.current;
      if (!shouldRefreshOnFocus({ expired: isSessionExpired(), visible: visible(), sinceLastRefreshMs })) return;
      refresh();
    };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);

    let timer: ReturnType<typeof setInterval> | undefined;
    if (intervalMs > 0) {
      timer = setInterval(() => {
        if (shouldRefreshOnTick({ expired: isSessionExpired(), visible: visible() })) refresh();
      }, intervalMs);
    }

    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
      if (timer) clearInterval(timer);
    };
  }, [softRefresh, readFreshness]);

  useEffect(() => {
    const onVerified = () => setAccessEpoch((n) => n + 1);
    const onRenewed = () => setRenewalNonce((n) => n + 1);
    window.addEventListener(ACCESS_RENEWED_EVENT, onRenewed);
    window.addEventListener(ACCESS_VERIFIED_EVENT, onVerified);
    return () => {
      window.removeEventListener(ACCESS_VERIFIED_EVENT, onVerified);
      window.removeEventListener(ACCESS_RENEWED_EVENT, onRenewed);
    };
  }, []);

  const value = { pageMayBeOutdated: outdatedSurfaces.size > 0, reportOutdated, freshness, syncing, syncError, operation, refreshNonce, accessEpoch, renewalNonce, requestSync, bump: softRefresh };
  return <SyncCtx.Provider value={value}>{children}</SyncCtx.Provider>;
}

/** The global sync state, for the top-bar stamp. */
export function useSyncStatus(): SyncValue {
  return useContext(SyncCtx);
}

/** The refresh signal (#301) — a counter that increments on each successful
 *  manual sync. A data page adds it to its fetch effect's deps so a "sync now"
 *  re-pulls the surface. */
export function useRefreshSignal(): number {
  return useContext(SyncCtx).refreshNonce;
}

/**
 * The access epoch (#892 review, C2) — a counter that moves once per COMPLETED
 * Github access check.
 *
 * A permission-sensitive surface adds it to its fetch effect's deps and clears
 * what it is holding when it moves. `forgetSensitivePayloads` has already taken
 * the stored copy and rejected anything in flight by the time this fires, so the
 * surface has nothing left to draw until its own new read lands — and a read
 * that FAILS leaves it with nothing, which is the honest state for data whose
 * authorization has expired.
 *
 * It is not `refreshNonce`: that one refetches every mounted surface, and doing
 * that once a minute would put the whole board's reads on a 60s cadence to
 * reauthorize the two that need it.
 */
export function useAccessEpoch(): number {
  return useContext(SyncCtx).accessEpoch;
}

/** The soft refresh-nonce bump (#384) — call after a successful in-board write so
 *  other mounted views (which listen on `useRefreshSignal`) refetch. */
export function useRefreshBump(): () => void {
  return useContext(SyncCtx).bump;
}

/** Early renewal replaces sensitive responses while their old deadlines hold. */
export function useRenewalSignal(): number {
  return useContext(SyncCtx).renewalNonce;
}

/** Report a mounted surface's stale data; one surface cannot clear another's warning. */
export function useReportOutdated(outdated: boolean): void {
  const { reportOutdated } = useContext(SyncCtx);
  const surface = useRef(Symbol('surface'));
  useEffect(() => {
    const key = surface.current;
    reportOutdated(key, outdated);
    return () => reportOutdated(key, false);
  }, [outdated, reportOutdated]);
}
