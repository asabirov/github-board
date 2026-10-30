import { DAY_SPAN, countByDay } from '../time/day-span';
import { MAX_MERGES, MAX_RELEASES, type DeliveryData, type DeliveryView } from './delivery.types';

/** Newest first — the ordering both feeds already have within one org, applied
 *  again across orgs so the union is interleaved by time rather than stacked
 *  org after org. */
const newestFirst = (a: { atISO: string }, b: { atISO: string }) =>
  Date.parse(b.atISO) - Date.parse(a.atISO);

/** "a", "a and b", "a, b, and c" — the same grammar `ScopeLine.tsx` uses for the
 *  other list in the sentence it prints this into, rather than a second joiner
 *  spelling the same idea differently on the way there. */
const SCOPE = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/**
 * Several orgs' rollups as ONE (#697).
 *
 * `parts` is what actually came back — an org whose read failed is absent, not a
 * zeroed entry, which is why `unassignedPrs` may be summed without inventing a
 * count for an org nobody could see, and why `releaseScope` names the orgs the
 * numbers cover rather than the orgs the operator configured. Callers guarantee
 * at least one part: no part at all is a failed read, and that is thrown before
 * it reaches here.
 *
 * Both feeds are re-sliced. Each part is already its own org's newest
 * `MAX_RELEASES` / `MAX_MERGES`, so the union of them, re-sorted and cut to the
 * same length, is the newest of the whole scope — the feed keeps claiming what
 * it always claimed, and does not grow a lane per org.
 *
 * `releasesPartial` is an OR: one org that could not be seen whole makes the day
 * series a floor for the scope, and a union that hid that behind the org that
 * read cleanly would draw the confident lie the flag exists to prevent.
 */
export function mergeDelivery(parts: readonly DeliveryData[]): DeliveryData {
  return {
    releases: parts.flatMap((p) => p.releases).sort(newestFirst).slice(0, MAX_RELEASES),
    merges: parts.flatMap((p) => p.merges).sort(newestFirst).slice(0, MAX_MERGES),
    unassignedPrs: parts.reduce((n, p) => n + p.unassignedPrs, 0),
    releaseDates: parts.flatMap((p) => p.releaseDates),
    releasesPartial: parts.some((p) => p.releasesPartial),
    releaseScope: SCOPE.format(parts.map((p) => p.releaseScope)),
  };
}

/**
 * The cached rollup with its freshness stamped on — what one read starts from.
 */
type StampedDelivery = DeliveryData & { updatedAt: string };

/**
 * Buckets at READ time, never at fetch time. Cached pre-bucketed, the 98
 * integers freeze at fetch and "yesterday" is wrong for up to a full TTL after
 * every UTC midnight. Days are UTC calendar days (see `dayIndex`), so a release
 * cut late in the evening west of UTC lands on the next day's cell.
 */
export function toDeliveryView(data: StampedDelivery, now: number): DeliveryView {
  const { releaseDates, ...rest } = data;
  return { ...rest, releaseDays: countByDay(releaseDates, (d) => d, now, DAY_SPAN) };
}
