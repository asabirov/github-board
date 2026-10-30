export const SYNC_SOURCES = ['issues', 'issueBuckets', 'projects', 'repos'] as const;
export type SyncSource = typeof SYNC_SOURCES[number];
export type SyncSourceState = 'pending' | 'running' | 'succeeded' | 'degraded' | 'failed' | 'skipped' | 'unknown';
export interface SyncOperation {
  operationId: string;
  state: 'running' | 'succeeded' | 'partial' | 'failed' | 'interrupted';
  startedAt: string;
  /** When the server gives up on the run and marks it interrupted (#976). */
  expiresAt: string;
  finishedAt?: string;
  syncedAt?: string;
  sources: Record<SyncSource, { state: SyncSourceState; startedAt?: string; finishedAt?: string }>;
}
/**
 * When each source last refreshed, as `GET /api/sync/sources` reports it
 * (#1169).
 *
 * This is what the Board sync panel's rows and the header chip BOTH read. They
 * used to read two different things: the chip took the freshest payload
 * timestamp any mounted page reported, the rows took `SyncOperation.sources` —
 * a record of one manual run in THIS tab, absent until the button is pressed
 * here and gone on reload. So a board whose sources had all just refreshed
 * drew "Synced 8m ago" over rows reading "Not recorded".
 *
 * `syncedAt` is `null` where the server has no record, which is an ordinary
 * state rather than a failure: three of the four caches fill on their surface's
 * first read. It is never a guess — the server will not invent one.
 */
export interface SourceFreshness {
  syncedAt: string | null;
  /** Rollup entries in scope, excluding last-good fallbacks. */
  organisations?: { recorded: number; total: number };
  /** An observed failed or partial read; absent on a genuinely unread source. */
  incomplete?: boolean;
}
export interface BoardFreshness {
  sources: Record<SyncSource, SourceFreshness>;
}

export const SOURCE_NAMES: Record<SyncSource, string> = {
  issues: 'Issue metrics', issueBuckets: 'Issue buckets', projects: 'Projects', repos: 'Repos',
};
/** What each row of the Board sync popover says about its source. One plain word
 *  per state wherever there is one: `skipped` read "Not applicable" until #979,
 *  which is a form's word for a blank field, not an account of a source the run
 *  passed over, and `unknown` read "Outcome unavailable" beside five one-word
 *  siblings when "Unknown" is what that column is for. */
export const SOURCE_STATES: Record<SyncSourceState, string> = {
  pending: 'Waiting', running: 'Refreshing', succeeded: 'Refreshed', degraded: 'Incomplete', failed: 'Failed', skipped: 'Skipped', unknown: 'Unknown',
};
/** How long one request may go unanswered before it counts as failed. */
export const SYNC_REQUEST_MS = 30_000;
/** How long past the server's own deadline a run may still read as running.
 *  The server marks it interrupted there, so this only covers a server that
 *  stopped keeping its word. */
export const SYNC_DEADLINE_GRACE_MS = 30_000;
/** Failed progress reads in a row that are asked again. A slow or refused
 *  access check during a run is one failed read, not a failed run (#976). */
export const SYNC_READ_RETRIES = 3;

/** One abortable pause; hidden tabs issue no status reads until visible again. */
export function waitForSyncPoll(signal: AbortSignal, delay = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    let elapsed = false;
    const cleanup = () => { clearTimeout(timer); document.removeEventListener('visibilitychange', ready); signal.removeEventListener('abort', abort); };
    const ready = () => { if (elapsed && document.visibilityState === 'visible') { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(new DOMException('Sync observation stopped', 'AbortError')); };
    const timer = setTimeout(() => { elapsed = true; ready(); }, delay);
    document.addEventListener('visibilitychange', ready);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** A failed read worth asking again: the network, a request that timed out, or
 *  the server's 5xx. A 4xx or a 409 is an answer, and stops the watch. */
function worthAskingAgain(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status !== 'number' || status >= 500;
}

const stopped = () => new DOMException('Sync observation stopped', 'AbortError');

/**
 * Source transitions come only from the server. A missing record throws; it is
 * not five failed reads.
 *
 * Each request is bounded on its own, and nothing counts down between requests
 * (#976). A countdown over the whole run kept running while a hidden tab
 * paused, so a run that had finished read as a failure when the tab came back,
 * and it gave up before the server's own bound, so a run that finished in its
 * last seconds did too. The server marks a run interrupted at `expiresAt`, so a
 * read there always ends the watch.
 */
export async function observeSync(
  start: (signal: AbortSignal) => Promise<SyncOperation>,
  read: (id: string, signal: AbortSignal) => Promise<SyncOperation>,
  report: (operation: SyncOperation) => void,
  signal: AbortSignal,
  pause: (signal: AbortSignal) => Promise<void> = waitForSyncPoll,
): Promise<SyncOperation> {
  const observer = new AbortController();
  const abort = () => observer.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const within = <T>(ask: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const request = new AbortController();
    const cancel = () => request.abort();
    observer.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, SYNC_REQUEST_MS);
    const refused = new Promise<never>((_, reject) => request.signal.addEventListener('abort', () => reject(stopped()), { once: true }));
    if (observer.signal.aborted) cancel();
    return Promise.race([ask(request.signal), refused]).finally(() => {
      clearTimeout(timer);
      observer.signal.removeEventListener('abort', cancel);
    });
  };
  try {
    let operation = await within(start);
    report(operation);
    let failures = 0;
    while (operation.state === 'running') {
      if (Date.now() > Date.parse(operation.expiresAt) + SYNC_DEADLINE_GRACE_MS) throw stopped();
      await pause(observer.signal);
      if (observer.signal.aborted) throw stopped();
      const id = operation.operationId;
      try { operation = await within((requestSignal) => read(id, requestSignal)); }
      catch (err) {
        if (observer.signal.aborted || failures >= SYNC_READ_RETRIES || !worthAskingAgain(err)) throw err;
        failures += 1;
        continue;
      }
      failures = 0;
      report(operation);
    }
    return operation;
  } finally { signal.removeEventListener('abort', abort); observer.abort(); }
}
