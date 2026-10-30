// User-facing strings require rows in scripts/copy-gate/reviewed/board-frontend/src/sync/board-freshness.ts.tsv.
import { SYNC_SOURCES, type BoardFreshness, type SyncSource } from './sync-operation';

/** The chip and rows share the server's cache record (#1169). Unread sources
 *  do not silence moments from recorded ones. An explicitly partial source is
 *  different: its moment cannot support a Synced claim (#1185).
 *  Healthy readings still report the freshest recorded source. */
export interface FreshnessSummary {
  partial: boolean;
  /** The moment the chip reports, or null when it may not report one. */
  syncedAt: string | null;
  /** How many of the four have a record at all. */
  recorded: number;
  /** How many there are, so a caller never hard-codes four. */
  total: number;
}

/** The four moments, oldest first, with the sources that have no record left out. */
function recordedTimes(freshness: BoardFreshness | null): number[] {
  if (!freshness) return [];
  return SYNC_SOURCES
    .map((key) => freshness.sources[key]?.syncedAt)
    .filter((at): at is string => typeof at === 'string' && !Number.isNaN(Date.parse(at)))
    .map((at) => Date.parse(at))
    .sort((a, b) => a - b);
}

/** The chip's summary of the board's freshness. See this module's docblock for
 *  what it may claim, and why unread and partial sources differ. */
export function summariseFreshness(freshness: BoardFreshness | null): FreshnessSummary {
  const times = recordedTimes(freshness);
  return {
    partial: SYNC_SOURCES.some((key) => {
      const source = freshness?.sources[key];
      const coverage = source?.organisations;
      return source?.incomplete === true ||
        (!!coverage && coverage.recorded > 0 && coverage.recorded < coverage.total);
    }),
    syncedAt: times.length === 0 ? null : new Date(times[times.length - 1]).toISOString(),
    recorded: times.length,
    total: SYNC_SOURCES.length,
  };
}

/**
 * Which of the three coarse ages a moment falls in — the board is near-live, not
 * to-the-second, so a jittery seconds counter would read as noise.
 *
 * The labels below are written out in full rather than assembled from this,
 * which is deliberate: `pnpm run copy` reads a sentence a screen draws, and a
 * sentence built as `'Synced ' + somethingElse(iso)` reaches that gate as
 * `Synced {}`, which is not a sentence a writer can review. The thresholds are
 * here, once; the words are where they can be read.
 */
function coarseAge(iso: string): { minutes: number; hours: number } {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  const minutes = Math.round(seconds / 60);
  return { minutes: seconds < 45 ? -1 : minutes, hours: Math.round(minutes / 60) };
}

/** A source's age on its own row of the Board sync panel (#1169), under a
 *  heading that has already said what these times are about. */
export function agoLabel(iso: string): string {
  const { minutes, hours } = coarseAge(iso);
  if (minutes < 0) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${hours}h ago`;
}

/** The same age as the header chip says it. */
export function syncedLabel(iso: string): string {
  const { minutes, hours } = coarseAge(iso);
  if (minutes < 0) return 'Synced just now';
  if (minutes < 60) return `Synced ${minutes}m ago`;
  return `Synced ${hours}h ago`;
}

/**
 * The words the chip carries when no run is in flight and none has failed — the
 * decision this module owns, all the way to the characters on the screen.
 *
 * It lives here rather than in `TopBar.tsx` so that the decision above is made
 * in one file. The header draws what this returns; a syncing or failed run is a
 * different subject and stays where the run is known.
 */
export function freshnessLabel(summary: FreshnessSummary): string {
  if (summary.partial) return 'Sync incomplete';
  return summary.syncedAt ? syncedLabel(summary.syncedAt) : 'Sync now';
}

/** One source's own recorded moment, for its row. Null where the server has no
 *  record, which the row says in words rather than filling in. */
export function sourceSyncedAt(freshness: BoardFreshness | null, key: SyncSource): string | null {
  const at = freshness?.sources[key]?.syncedAt;
  return typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : null;
}
