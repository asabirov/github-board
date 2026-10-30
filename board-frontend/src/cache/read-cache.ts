import { QueryClient, hashKey, type Query } from '@tanstack/react-query';
import { experimental_createQueryPersister, type PersistedQuery } from '@tanstack/query-persist-client-core';
import { get, set, del, clear, entries, createStore } from 'idb-keyval';
import { cachedOwner, clearSupersededVisibility, currentPayloadGeneration, currentSensitiveGeneration, supersededCopiesHeld } from './payload-cache';
import { hintPreviewActive, savedSessionPending } from '../auth/session-hint';
import { withdrawResponse, currentSupersededIdentity, isSensitiveResponse, markSensitiveResponse, responseDeadline, tagResponse, drawableResponseDeadline, requiresResponseDeadline, type ResponseDeadline } from '../auth/response-deadline';

const MAX_AGE = 24 * 60 * 60 * 1000;
const STORE_PREFIX = 'board-reads-v1';
const database = createStore('board-read-cache', 'reads');
const withdrawn = new Set<string>();
let cacheEpoch = 0;
let restoringEpoch = 0;
export const readKey = (path: string) => ['board-read', path] as const;
export interface ReadEntry {
  value: unknown;
  restored?: boolean;
  owner: string;
  at: number;
  persist: boolean;
  projection?: string;
  sensitive: boolean;
  lease?: ResponseDeadline;
  generation: number;
  sensitiveGeneration: number;
}

/** The default query function uses the same checked transport as API adapters. */
export const readClient = new QueryClient({ defaultOptions: { queries: {
  staleTime: 0,
  gcTime: MAX_AGE,
  retry: false,
  refetchOnWindowFocus: false,
  structuralSharing: false,
  queryFn: async ({ queryKey, signal }) => {
    const { networkFetch, ApiError, serverCode, serverMessage } = await import('../api/core');
    const path = String(queryKey[1]);
    const res = await networkFetch(path, { signal });
    if (!res.ok) throw new ApiError(res.status, `read ${res.status}`, undefined, undefined, await serverMessage(res), await serverCode(res));
    const value = await res.json();
    return readClient.getQueryData<ReadEntry>(readKey(path)) ?? entryFor(value, res.headers);
  },
} } });

function entryFor(value: unknown, headers: Headers): ReadEntry {
  const projection = headers.get?.('X-Board-Persist') ?? undefined;
  return { value, owner: cachedOwner()?.email ?? '', at: Date.now(),
    persist: !/\bno-store\b/i.test(headers.get?.('Cache-Control') ?? '') || projection === 'roster-without-aliases', projection,
    sensitive: isSensitiveResponse(value), lease: responseDeadline(value),
    generation: currentPayloadGeneration(), sensitiveGeneration: currentSensitiveGeneration() };
}

/** Only the transport stores answers: derived fallbacks and optimistic edits cannot reach disk. */
export function rememberRead(path: string, value: unknown, headers: Headers): void {
  if (!cachedOwner() || hintPreviewActive()) return;
  if (value === null) { forgetRead(path); return; }
  if (typeof value !== 'object') return;
  withdrawn.delete(path);
  readClient.setQueryData(readKey(path), entryFor(value, headers));
  retireSupersededVisibility();
}

/**
 * Drop the superseded visibility key once nothing is left that needs it (#1395).
 *
 * NOT ON THE FIRST SUCCESS, which is the obvious reading and is wrong. The
 * blocks of a page read separately: My work asks for the queue, the boards and
 * the filter options, and after an access change each still holds an answer
 * issued under the key that moved. If the first of them to land retired that
 * key, every block whose read had not landed yet would stop being drawable at
 * that moment, and the reader would watch them fall to placeholders one by one.
 * That is the defect this issue is about, arriving by a new route.
 *
 * So it is retired when no entry still stands on it. `rememberRead` has just
 * replaced one answer, so this is the moment to ask, and the answer is cheap:
 * the cache holds a handful of paths, and a restored open has loaded them all.
 */
let restored = true;
function retireSupersededVisibility(): void {
  const superseded = currentSupersededIdentity();
  if (superseded === null) return;
  // NOT BEFORE RESTORATION HAS FINISHED. The entries this counts arrive from
  // IndexedDB after the shell mounts, so a read that lands first would be
  // counted against an empty cache, retire the key, and take the copies it was
  // holding open for. The disk half below has the same ordering, and the two
  // together are why this waits rather than guessing.
  if (!restored) return;
  const inQueryCache = readClient.getQueryCache().getAll().some(query => {
    const entry = query.state.data as ReadEntry | undefined;
    return !!entry?.value && entry.lease?.visibilityKey === superseded;
  });
  // BOTH STORES. In production every route but the queue and the roster is
  // `private, no-store`, so the Projects strip, a board, the Repos map and the
  // filter options are in localStorage and nowhere else. Reading the query cache
  // alone retired the key as soon as the queue landed, and the next read of
  // those copies deleted them.
  if (!inQueryCache && !supersededCopiesHeld(superseded)) clearSupersededVisibility();
}

/** Apply only an acknowledged write, retaining the read's owner, age and lease. */
export const currentWriteCacheGeneration = () => `${cacheEpoch}:${currentPayloadGeneration()}:${currentSensitiveGeneration()}`;

export async function patchReadAfterWrite<T>(path: string, update: (value: T) => T, epoch: string): Promise<void> {
  if (epoch !== currentWriteCacheGeneration() || hintPreviewActive()) return;
  await readClient.cancelQueries({ queryKey: readKey(path), exact: true });
  if (epoch !== currentWriteCacheGeneration() || hintPreviewActive()) return;
  const held = readClient.getQueryData<ReadEntry>(readKey(path));
  const value = readValue<T>(held);
  if (!held || value === null) return;
  readClient.setQueryData(readKey(path), { ...held, value: update(value) });
}

export function readValue<T>(raw: unknown): T | null {
  if (savedSessionPending() && !hintPreviewActive()) return null;
  const entry = raw as ReadEntry | undefined;
  if (!entry || !entry.value || entry.owner !== cachedOwner()?.email
    || entry.generation !== currentPayloadGeneration() || Date.now() - entry.at > MAX_AGE) return null;
  // Preview authority comes from App's matching session hint, never from a stored lease.
  if (hintPreviewActive()) return entry.value as T;
  if (entry.sensitive && (entry.sensitiveGeneration !== currentSensitiveGeneration()
    // `drawableResponseDeadline`, not the wire's `validResponseDeadline`: a copy
    // under the key this person's current one replaced is drawn, marked stale,
    // until a live read settles it (#1395, Artur's decision).
    || (entry.lease && !drawableResponseDeadline(entry.lease)) || (requiresResponseDeadline() && !entry.lease))) return null;
  if (entry.lease) tagResponse(entry.value, entry.lease);
  else if (entry.sensitive) markSensitiveResponse(entry.value);
  return entry.value as T;
}

export function persistableRead(query: Query): boolean {
  const entry = query.state.data as ReadEntry | undefined;
  return query.queryKey[0] === 'board-read'
    && !!entry?.value && entry.persist && entry.owner === cachedOwner()?.email
    && entry.generation === currentPayloadGeneration()
    && (!(entry.sensitive || entry.lease) || !!cachedOwner()?.hintId);
}

export function markReadStale(path: string): void {
  readClient.getQueryCache().find({ queryKey: readKey(path), exact: true })?.invalidate();
}

export function forgetRead(path: string): void {
  discardRead(path, true);
}
function discardRead(path: string, refused: boolean): void {
  withdrawn.add(path);
  void storageOperation(() => del(`${STORE_PREFIX}-${hashKey(readKey(path))}`, database));
  const held = readClient.getQueryData<ReadEntry>(readKey(path));
  if (held) {
    if (refused) withdrawResponse(held.value);
    readClient.setQueryData(readKey(path), { ...held, value: null, persist: false });
  }
}

// Serialize storage operations. A wipe follows earlier writes, and an old snapshot
// queued by a subscription cannot recreate another person's cache after that wipe.
let storageWork: Promise<unknown> = Promise.resolve();
function storageOperation(work: () => Promise<unknown>): Promise<void> {
  storageWork = storageWork.then(work, work).catch(() => {});
  return storageWork.then(() => {});
}
/** Personal aliases never survive the tab; the live roster stays complete. */
export function rosterForDisk<T extends { emails?: unknown }>(people: T[]): T[] {
  return people.map(person => ({ ...person, emails: [] }));
}
export function redactStoredRead(query: PersistedQuery): PersistedQuery {
  const entry = query.state.data as ReadEntry;
  if (entry.projection !== 'roster-without-aliases') return query;
  const value = entry.value as { people: Record<string, unknown>[] };
  return { ...query, state: { ...query.state, data: { ...entry, value: {
    ...value, people: rosterForDisk(value.people),
  } } } };
}

export const readPersister = experimental_createQueryPersister({
  prefix: STORE_PREFIX, buster: '1', maxAge: MAX_AGE,
  storage: {
    getItem: key => get<string>(key, database).catch(() => undefined),
    setItem: (key, value) => storageOperation(async () => {
      const entry = (JSON.parse(value) as PersistedQuery).state.data as ReadEntry;
      if (entry.generation === currentPayloadGeneration() && entry.owner === cachedOwner()?.email
        && (!entry.sensitive || entry.sensitiveGeneration === currentSensitiveGeneration())) await set(key, value, database);
    }),
    removeItem: key => storageOperation(() => del(key, database)),
    entries: () => entries<string, string>(database).catch(() => []),
  },
  serialize: query => JSON.stringify(redactStoredRead(query)),
  deserialize: raw => {
    const query = JSON.parse(raw) as PersistedQuery;
    if (!Array.isArray(query.queryKey) || query.queryKey[0] !== 'board-read' || typeof query.queryKey[1] !== 'string') throw new Error('Invalid saved key');
    const entry = query.state.data as ReadEntry;
    if (restoringEpoch !== cacheEpoch || withdrawn.has(String(query.queryKey[1]))) throw new Error('Read withdrawn during restoration');
    if (!entry?.value || entry.owner !== cachedOwner()?.email || !entry.persist
      || !Number.isFinite(entry.at) || entry.at > Date.now() + 5000 || Date.now() - entry.at > MAX_AGE) throw new Error('Unusable saved read');
    if ((entry.sensitive || entry.lease) && restoreSensitiveGeneration !== currentSensitiveGeneration()) throw new Error('Access changed during restoration');
    entry.restored = true;
    entry.generation = currentPayloadGeneration();
    entry.sensitiveGeneration = currentSensitiveGeneration();
    const live = readClient.getQueryState(query.queryKey);
    return live && live.dataUpdatedAt > query.state.dataUpdatedAt ? { ...query, state: live } : query;
  },
});

export function clearReads(): void {
  cacheEpoch++;
  withdrawn.clear();
  readClient.clear();
  void storageOperation(() => clear(database));
}
export const savedReadPath = (path: string) => /^\/api\/(?:projects(?:[/?]|$)|issues\/(?:all|metrics)(?:[/?]|$))/.test(path);
let savedReadEpoch = 0;
export const currentReadRefusalEpoch = (path: string) => savedReadPath(path) ? savedReadEpoch : 0;
/** The same families as legacy SavedKey, across union and scoped URLs. */
export function clearSavedReads(): void {
  savedReadEpoch++;
  clearMatchingReads((path) => savedReadPath(path));
}
export function clearSensitiveReads(): void {
  clearMatchingReads((_path, entry) => !!(entry.sensitive || entry.lease));
}
function clearMatchingReads(matches: (path: string, entry: ReadEntry) => boolean): void {
  cacheEpoch++;
  // Collected queries still have disk copies, including union and scoped reads.
  void storageOperation(async () => {
    for (const [key, raw] of await entries<string, string>(database)) {
      try {
        const query = JSON.parse(raw) as PersistedQuery;
        if (matches(String(query.queryKey[1]), query.state.data as ReadEntry)) await del(key, database);
      } catch { await del(key, database); }
    }
  });
  for (const query of readClient.getQueryCache().getAll()) {
    const entry = query.state.data as ReadEntry | undefined;
    // Removing saved fallback eligibility does not refuse other live answers.
    if (entry && matches(String(query.queryKey[1]), entry)) discardRead(String(query.queryKey[1]), false);
  }
}

let stopPersistence: (() => void) | undefined;
let restoreSensitiveGeneration: number | undefined;
/** Startup gives local restoration a short head start before mounting routes. */
let restoration: Promise<void> = Promise.resolve();
export const waitForReadRestoration = () => restoration;
export function restoreReads(): Promise<void> {
  restoration = restoreStoredReads();
  return restoration;
}
async function restoreStoredReads(): Promise<void> {
  stopPersistence?.();
  restored = false;
  restoringEpoch = cacheEpoch;
  restoreSensitiveGeneration = currentSensitiveGeneration();
  await storageWork;
  await readPersister.restoreQueries(readClient);
  restored = true;
  stopPersistence = readClient.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (persistableRead(event.query)) void readPersister.persistQuery(event.query).catch(() => {});
    else void storageOperation(() => del(`${STORE_PREFIX}-${event.query.queryHash}`, database));
  });
  // A fast network response can arrive while IndexedDB is opening.
  for (const query of readClient.getQueryCache().getAll()) {
    if (persistableRead(query)) void readPersister.persistQuery(query).catch(() => {});
  }
}
