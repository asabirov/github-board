import { type SyncSource } from './sync-operation';

/**
 * A source that can say when its cached answer was read
 * (#1169).
 *
 * The Board sync panel used to read `SyncOperation.sources`, which is a record
 * of one MANUAL run in one tab: null until the button is pressed there, gone on
 * reload, and pruned five minutes after the run ends. The header chip mean-
 * while reads the freshest payload timestamp any mounted page reported. Two
 * readings of one fact, and the screenshot in #1169 is them disagreeing — a chip
 * saying "Synced 8m ago" over four rows saying "Not recorded", on a board whose
 * sources had all just refreshed.
 *
 * DERIVED, never stamped. Each implementation answers out of a cache it
 * already holds and already timestamps for the payload it serves, so there is no
 * second record to keep in step with the first. A stamp written beside a cache
 * fill is a stamp that can be written where a fill is not, and missed where one
 * is; this cannot drift, because there is nothing to drift from.
 *
 * It must NOT read Github, and must not start a read that would. Opening a panel
 * is not a reason to pay for four fetches, and a `lastSyncedAt` that filled its
 * own cache would answer "just now" on every first call — which is the shape of
 * a reading that can never say "nothing has read this yet".
 *
 * `null` is a real answer and the one thing this may not invent a time for: three
 * of the four caches fill lazily on their surface's first read, and all four are
 * per-principal, so "nothing has read this yet under this person's access" is an
 * ordinary state shortly after a boot or a sign-in. It is not a failure and it
 * is not a sync.
 */
export interface ReportsFreshness {
  lastSyncedAt(): string | null;
}

/** What `GET /api/sync/sources` answers for one source. */
export interface SourceFreshness {
  /** When the current or retained cached answer was read. Null when no
   *  timestamp is available; a retained answer may need revalidation. */
  syncedAt: string | null;
  /** Rollup entries in scope, excluding last-good fallbacks. */
  organisations?: { recorded: number; total: number };
  /** An observed failed or partial read; absent on a genuinely unread source. */
  incomplete?: boolean;
}

/** What that route answers for the board: one entry per source, always all four,
 *  so a reader never has to tell a source that is missing from the payload from
 *  one that has no record. */
export interface BoardFreshness {
  sources: Record<SyncSource, SourceFreshness>;
}

