/**
 * Compact relative-time label ("3m ago", "yesterday", "Mar 4"). Lifted out of
 * the retired notifications module (#197); the Projects table still uses it.
 */
export function relTime(at: number, now: number = Date.now()): string {
  if (!at) return '';
  const diff = now - at;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'yesterday';
  if (day < 7) return `${day}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
