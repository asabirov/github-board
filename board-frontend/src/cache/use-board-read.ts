import { useAccessEpoch, useRefreshSignal, useRenewalSignal } from '../sync/sync-status';
import { hintPreviewActive } from '../auth/session-hint';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useState, useRef, useEffect, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { readClient, readKey, readValue, type ReadEntry } from './read-cache';
import { currentPayloadGeneration, currentSensitiveGeneration } from './payload-cache';
import { useResponseDeadline } from '../auth/use-response-deadline';
import { copyResponseDeadline, responseExpired } from '../auth/response-deadline';

function useReadQuery<T>(path: string, enabled: boolean, subscribed = true) {
  const refresh = `${useAccessEpoch()}:${useRefreshSignal()}:${useRenewalSignal()}`;
  const previous = useRef({ path, refresh });
  useEffect(() => {
    if (enabled && previous.current.path === path && previous.current.refresh !== refresh) {
      void readClient.invalidateQueries({ queryKey: readKey(path), exact: true });
    }
    previous.current = { path, refresh };
  }, [path, refresh, enabled]);
  const query = useQuery<ReadEntry>({ queryKey: readKey(path), enabled, subscribed }, readClient);
  const data = readValue<T>(query.data);
  const expired = useResponseDeadline(hintPreviewActive() ? null : data);
  return { ...query, data: expired ? null : data, sourceRevision: query.data };
}

/** Successful reads persist and revalidate by default. Edits remain local until re-read. */
export function useBoardRead<T>(path: string, enabled = true) {
  const query = useReadQuery<T>(path, enabled, enabled);
  const [data, setData] = usePresentationState<T>(path, query.data, query.sourceRevision);
  return { ...query, data, setData };
}

/** Existing screens retain their refresh effects during the migration. */
export function useReadState<T, Wire = T>(path: string, select?: (wire: Wire) => T, subscribed = true): [T | null, Dispatch<SetStateAction<T | null>>] {
  const query = useReadQuery<Wire>(path, false, subscribed);
  return usePresentationState<T, Wire>(path, query.data, query.sourceRevision, select);
}

function usePresentationState<T, Wire = T>(path: string, source: Wire | null, revision: unknown, select?: (wire: Wire) => T): [T | null, Dispatch<SetStateAction<T | null>>] {
  const generation = `${currentPayloadGeneration()}:${currentSensitiveGeneration()}`;
  const seed = source === null ? null : select ? copyResponseDeadline(source, select(source)) : source as unknown as T;
  // A second null is a new withdrawal, not the original empty source that a
  // local fallback may have been set against before the first answer arrived.
  const latest = useRef({ source: revision, seed });
  latest.current = { source: revision, seed };
  const [local, setLocal] = useState<{ path: string; generation: string; source: unknown; value: T | null } | null>(null);
  const value = local?.path === path && local.generation === generation && local.source === revision
    ? local.value : seed;
  const expired = useResponseDeadline(hintPreviewActive() ? null : value);
  const set = useCallback<Dispatch<SetStateAction<T | null>>>(update => {
    setLocal(previous => {
      const { source, seed } = latest.current;
      const held = previous?.path === path && previous.generation === generation && previous.source === source ? previous.value : seed;
      const seen = responseExpired(held) ? null : held;
      const next = typeof update === 'function' ? copyResponseDeadline(seen, (update as (v: T | null) => T | null)(seen)) : update;
      return { path, generation, source, value: next };
    });
  }, [path, generation]);
  return [expired ? null : value, set];
}

const subscribeToReads = (listener: () => void) => readClient.getQueryCache().subscribe(listener);
const hasStaleReads = () => readClient.getQueryCache().getAll().some(query => {
  const entry = query.state.data as ReadEntry | undefined;
  return query.getObserversCount() > 0 && readValue(entry) !== null
    && (entry?.restored || query.state.isInvalidated || query.state.fetchStatus === 'fetching' || query.state.status === 'error');
});
/** One status line covers stale data on every route, including migrated effects. */
export function useStaleReads(): boolean {
  return useSyncExternalStore(subscribeToReads, hasStaleReads, () => false);
}
