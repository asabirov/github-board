import { isSensitiveResponse, copyResponseDeadline, responseExpired, responseDeadline, requiresResponseDeadline } from '../auth/response-deadline';
import { useResponseDeadline } from '../auth/use-response-deadline';
/**
 * `useState<T | null>(null)` that opens on the last answer instead of on
 * nothing (#824), for one of the keys `payload-cache.ts` allows and no other.
 *
 * A page swaps ONE line and keeps everything else it was written with — its own
 * error states, its org scoping, its refusal handling, the arguments #714 and
 * #512 left in its handlers. That is the whole point of the shape: this is not
 * a fetching hook and no page's effect is rewritten onto it. The tuple is the
 * same tuple, the setter takes a value or an updater the same way, and the only
 * two differences are that the initial value comes off the disk and that
 * values arrival can read are written back to it. Permission-sensitive values stay in memory unless
 * the arrival rule permits them, such as My work under a running lease.
 *
 * The key may vary — by org, by board number — and when it changes the state
 * re-seeds from the new key. That is what an identity change already meant on
 * these pages: `/acme` to `/globex`, or one board to the next, used to
 * be an effect blanking the surface so the previous org's rows could not be
 * read as this one's. Re-seeding does that job better, because it also has the
 * new key's own answer to put there.
 *
 * The write is a `useEffect`, not something the setter does, so the updater
 * handed to `setState` stays pure and StrictMode's double invocation costs
 * nothing. It writes only what was SET, never what was seeded: re-storing a
 * value that came off the disk would refresh its timestamp on every visit, and
 * an entry that is re-stamped for being read can outlive `PAYLOAD_MAX_AGE_MS`
 * indefinitely.
 *
 * The suite has no DOM and runs no effect, so what is testable
 * here is the pure half — `seedCell`, `nextCell` and `persistCell` are exported
 * for that, and `use-cached-state.spec.ts` pins the wiring between them as text.
 */
import { useCallback, useEffect, useState, useRef, type Dispatch, type SetStateAction } from 'react';
import { seedPayload, canSeedPayload, writePayload, currentPayloadGeneration, currentSensitiveGeneration, isSensitivePayloadKey, type PayloadKey } from './payload-cache';

/** The state this hook actually holds: a value, the key it belongs to, and
 *  whether it was set by the page (and so wants storing) or seeded off the disk
 *  (and so does not). */
export interface CachedCell<T> {
  key: PayloadKey;
  value: T | null;
  stored: boolean;
  /** The sensitive generation this value was seeded or set under (#892 review,
   *  C2 follow-up). Compared during RENDER for a permission-sensitive key, so an
   *  answer the expiry has just unauthorized is never painted — not even for the
   *  one frame between the check landing and the clearing effect running. */
  sensitiveAt: number;
}

/** What a key opens on, and a note that this did not come from the page: for
 *  EVERY key, whatever the cache has for it that a fresh DOCUMENT would also
 *  have opened on, and nothing else.
 *
 *  Through `seedPayload` and not `readPayload` (#1027): a client-side arrival
 *  runs no mount wipe, so without that a page opened on an answer a reload of
 *  the same URL had already decided not to draw, and the two paths showed
 *  different figures for the whole of the new read. `seedPayload` asks
 *  `droppedByWipe`, which is the wipe's own function, so the two agree by
 *  construction rather than by being kept in step.
 *
 *  The five keys this used to say it did not cover are covered now, and two of
 *  them change nothing. `issues/all`, `projects` and `repos` match
 *  `isSensitivePayloadKey`, so the wipe takes them at every load and they no
 *  longer open on a stored answer on a walk either. `issues/metrics` and
 *  `people` are not on that list, so they open on the copy on disk exactly
 *  when a load would — which is whenever the service did not mark the answer
 *  sensitive and attached no lease. `issues/filter-options` is on the list and
 *  is covered the same way as the first three.
 *
 *  `accept` is the caller's shape test, forwarded to `readPayload` and defaulted
 *  there. Pass one wherever the value goes straight into something that would
 *  throw on the wrong shape — `Array.isArray` for a list that gets `.map`ped. */
export function seedCell<T>(key: PayloadKey, accept?: (v: unknown) => boolean): CachedCell<T> {
  return { key, value: seedPayload<T>(key, accept), stored: false, sensitiveAt: currentSensitiveGeneration() };
}

/** The setter's rule, without React. A plain value replaces; an updater is
 *  called with what the page last saw, which is null when the key has just
 *  changed under it and the previous value was about something else. */
export function nextCell<T>(prev: CachedCell<T>, key: PayloadKey, update: SetStateAction<T | null>): CachedCell<T> {
  const seen = prev.key === key && !staleSensitive(prev) ? prev.value : null;
  let value = typeof update === 'function' ? (update as (p: T | null) => T | null)(seen) : update;
  if (typeof update === 'function') value = copyResponseDeadline(seen, value);
  return { key, value, stored: true, sensitiveAt: currentSensitiveGeneration() };
}

/** Write a cell through, when it has anything to write. A null is the page
 *  saying it has no answer, and an absent entry is how the cache says the same
 *  thing, so nothing is stored for it. */
export function persistCell<T>(cell: CachedCell<T>, generation = currentPayloadGeneration()): void {
  if (generation !== currentPayloadGeneration()) return;
  // The same refusal on the other generation: a sensitive value the expiry has
  // unauthorized must not be written back to the disk it was just taken off.
  if (staleSensitive(cell)) return;
  if (cell.stored && cell.value !== null && canSeedPayload(cell.key, cell.value)) writePayload(cell.key, cell.value);
}

/** Whether this cell holds a permission-sensitive value from before the current
 *  access check. Asked during render, which is what makes the answer arrive
 *  before the paint rather than after it. */
export function staleSensitive<T>(cell: CachedCell<T>): boolean {
  return (isSensitivePayloadKey(cell.key) || isSensitiveResponse(cell.value)) && (cell.sensitiveAt !== currentSensitiveGeneration() || responseExpired(cell.value) || (cell.value !== null && requiresResponseDeadline() && !responseDeadline(cell.value)));
}

export function useCachedState<T>(
  key: PayloadKey,
  accept?: (v: unknown) => boolean,
): [T | null, Dispatch<SetStateAction<T | null>>] {
  const generation = useRef(currentPayloadGeneration());
  const [cell, setCell] = useState<CachedCell<T>>(() => seedCell<T>(key, accept));

  useResponseDeadline(cell.value);

  // Adjusting state during render, which React documents for exactly this case:
  // the key changed, so what is held is about something else and must not be
  // painted for one frame first. React re-runs this component before touching
  // the DOM, so `live` is what the rest of the render sees and no effect from
  // the discarded pass runs.
  //
  // The second reason to re-seed is the access check (#892 review, C2
  // follow-up): a permission-sensitive value from before the current one is not
  // this document's to paint. Asked HERE and not in the effect below, because an
  // effect runs after the browser has already drawn the frame — which is exactly
  // the one stale frame this is about. Re-seeding reads the disk, which the
  // expiry has already emptied of these keys, so the page meets its skeleton and
  // its own new read. Nothing else on the page is touched.
  let live = cell;
  if (cell.key !== key || staleSensitive(cell)) {
    live = seedCell<T>(key, accept);
    setCell(live);
  }

  useEffect(() => {
    persistCell(live, generation.current);
  }, [live]);

  // `accept` is deliberately out of this dep list: it is a shape test, and a
  // caller writing an inline arrow would make a new setter on every render for
  // a predicate that never changes. The seed above reads it when the key does.
  const set = useCallback<Dispatch<SetStateAction<T | null>>>(
    (update) => { setCell((prev) => nextCell(prev, key, update)); },
    [key],
  );

  return [live.value, set];
}
