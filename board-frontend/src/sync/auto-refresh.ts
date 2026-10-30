/**
 * Auto-refresh cadence for the board's data surfaces (#375). An open tab pulls
 * fresh data on an interval and when it regains focus, so the "Synced" clock
 * tracks real freshness instead of climbing to hours on an idle-but-open tab.
 *
 * The interval drives a SOFT refresh — a refetch against the server's stale-
 * while-revalidate caches (bump the refresh nonce), NOT a force "sync now". So
 * it respects the server TTLs (issue-metrics ~10min, buckets ~1min) and never
 * storms GitHub: each poll costs at most one revalidation per mounted surface,
 * and a fetch inside a source's TTL is served straight from cache.
 */

/** Default poll interval: 2 minutes. Longer than the shortest source TTL (~1min
 *  buckets) so a poll costs at most one revalidation per surface, short enough
 *  that the stamp reads minutes — never hours — and stays well under the 15-min
 *  stale threshold. Override with VITE_AUTO_REFRESH_MS; 0 disables the periodic
 *  poll (the focus refetch stays). */
export const DEFAULT_AUTO_REFRESH_MS = 120_000;

/** Ignore a focus/visibility refetch landing within this window of the last
 *  refresh, so rapid tab-flipping can't spam refetches. Does not apply to the
 *  periodic poll (that interval IS the cadence). */
export const FOCUS_REFRESH_THROTTLE_MS = 30_000;

/** Floor for any positive interval, so a mis-set value (e.g. `100`) can't storm
 *  the server. 0 still disables the poll — the floor only applies to positives. */
export const MIN_AUTO_REFRESH_MS = 15_000;

/** Resolve the configured interval from a raw env string. Absent/blank/invalid/
 *  negative → the default; 0 disables the periodic poll; any positive value is
 *  floored to whole ms and clamped up to MIN_AUTO_REFRESH_MS. */
export function resolveAutoRefreshMs(raw: string | undefined | null): number {
  if (raw == null || raw === '') return DEFAULT_AUTO_REFRESH_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_AUTO_REFRESH_MS;
  if (n === 0) return 0; // explicit "disable the poll"
  return Math.max(MIN_AUTO_REFRESH_MS, Math.floor(n));
}

/** Whether the periodic poll should fire. An expired session stops it (#512):
 *  a dead tab must not keep calling a server that refuses it. */
export function shouldRefreshOnTick(o: { expired: boolean; visible: boolean }): boolean {
  return !o.expired && o.visible;
}

/** Whether a focus/visibility change should refetch — same expiry stop, plus
 *  the existing anti-tab-flipping throttle (#512, #375). */
export function shouldRefreshOnFocus(o: {
  expired: boolean;
  visible: boolean;
  sinceLastRefreshMs: number;
}): boolean {
  if (!shouldRefreshOnTick(o)) return false;
  return o.sinceLastRefreshMs >= FOCUS_REFRESH_THROTTLE_MS;
}
