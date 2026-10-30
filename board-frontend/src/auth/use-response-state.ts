import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { currentSensitiveGeneration } from '../cache/payload-cache';
import { copyResponseDeadline, responseExpired } from './response-deadline';
import { useResponseDeadline } from './use-response-deadline';

/** Held answers and optimistic patches keep the authorization of their source.
 *  A hard invalidation also clears legacy answers with no response metadata. */
export function useResponseState<T>(initial: T | (() => T), empty: T): [T, Dispatch<SetStateAction<T>>] {
  const [cell, setCell] = useState(() => ({ value: typeof initial === 'function' ? (initial as () => T)() : initial, generation: currentSensitiveGeneration() }));
  const expired = useResponseDeadline(cell.value);
  const stale = expired || cell.generation !== currentSensitiveGeneration();
  const value = stale ? empty : cell.value;
  if (stale) setCell({ value: empty, generation: currentSensitiveGeneration() });
  const set = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    setCell(prev => {
      const seen = prev.generation === currentSensitiveGeneration() && !responseExpired(prev.value) ? prev.value : empty;
      const next = typeof update === 'function' ? copyResponseDeadline(seen, (update as (v: T) => T)(seen)) : update;
      return { value: next, generation: currentSensitiveGeneration() };
    });
  }, [empty]);
  return [value, set];
}
