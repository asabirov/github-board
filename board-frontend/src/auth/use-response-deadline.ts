import { useSyncExternalStore } from 'react';
import { responseExpired, responseRevision, subscribeResponseChanges } from './response-deadline';

/** Held data changes only with its owner or a real refusal, never a timer. */
export function useResponseDeadline(value: unknown): boolean {
  useSyncExternalStore(subscribeResponseChanges, responseRevision, responseRevision);
  return responseExpired(value);
}
