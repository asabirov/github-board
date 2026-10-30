import { describe, expect, it } from 'vitest';
import { mergeDelivery, toDeliveryView } from './delivery.vm';
import { MAX_MERGES, MAX_RELEASES, type DeliveryData } from './delivery.types';

const NOW = Date.parse('2026-08-25T12:00:00Z');
const base = { releases: [], merges: [], unassignedPrs: 0, updatedAt: '2026-08-25T12:00:00Z', releasesPartial: false, releaseScope: 'acme' };

describe('toDeliveryView', () => {
  it('puts a release either side of UTC midnight in adjacent cells', () => {
    const v = toDeliveryView({ ...base, releaseDates: ['2026-08-23T23:59:59.999Z', '2026-08-24T00:00:00.000Z'] }, NOW);
    expect(v.releaseDays.at(-2)).toBe(1); // 08-24
    expect(v.releaseDays.at(-3)).toBe(1); // 08-23
  });

  it('drops a release older than the span rather than piling it into cell 0', () => {
    const v = toDeliveryView({ ...base, releaseDates: ['2026-01-01T00:00:00Z'] }, NOW);
    expect(v.releaseDays[0]).toBe(0);
    expect(v.releaseDays.reduce((a, b) => a + b, 0)).toBe(0);
  });

  // The test that pins "bucket at read time, never at fetch time".
  it('re-aligns the same cached data across a UTC midnight', () => {
    const data = { ...base, releaseDates: ['2026-08-25T09:00:00Z'] };
    const before = toDeliveryView(data, Date.parse('2026-08-25T23:55:00Z'));
    const after = toDeliveryView(data, Date.parse('2026-08-26T00:05:00Z'));
    expect(before.releaseDays.at(-1)).toBe(1);
    expect(after.releaseDays.at(-1)).toBe(0);
    expect(after.releaseDays.at(-2)).toBe(1);
  });
});

/**
 * The union of several orgs' rollups (#697). Every part here carries MORE than
 * its share of a cap, because the caps are what a union can breach and a fixture
 * under them exercises no slice at all.
 */
describe('mergeDelivery', () => {
  /** `n` hours after a fixed epoch — a bigger `n` is newer, and the numbers stay
   *  readable in the expectations below. */
  const at = (n: number) => new Date(Date.UTC(2026, 7, 1) + n * 3_600_000).toISOString();

  /** One org's rollup. Release and merge times are given as `at` offsets, so an
   *  expectation can name them back. */
  function part(
    org: string,
    releases: number[],
    merges: number[],
    over: Partial<DeliveryData> = {},
  ): DeliveryData {
    return {
      releases: releases.map((n) => ({
        repo: `${org}-web`,
        tag: `${org}-${n}`,
        name: null,
        htmlUrl: `https://x/${org}/rel/${n}`,
        atISO: at(n),
      })),
      merges: merges.map((n) => ({
        repo: `${org}-web`,
        number: n,
        title: `${org} #${n}`,
        htmlUrl: `https://x/${org}/pr/${n}`,
        author: 'octocat',
        atISO: at(n),
      })),
      unassignedPrs: 0,
      releaseDates: releases.map(at),
      releasesPartial: false,
      releaseScope: org,
      ...over,
    };
  }

  /** Three orgs, each already at its own cap-worth and interleaved with the
   *  others, so the union is 15 releases and 18 merges against caps of 8 and 12
   *  — and the newest of the whole scope is never one org's newest. */
  const THREE = [
    part('a', [30, 27, 24, 21, 18], [60, 57, 54, 51, 48, 45]),
    part('b', [29, 26, 23, 20, 17], [59, 56, 53, 50, 47, 44]),
    part('c', [28, 25, 22, 19, 16], [58, 55, 52, 49, 46, 43]),
  ];

  it('cuts the union back to MAX_RELEASES, newest of the whole scope first', () => {
    const merged = mergeDelivery(THREE);

    expect(merged.releases).toHaveLength(MAX_RELEASES);
    expect(merged.releases.map((r) => r.tag)).toEqual([
      'a-30', 'b-29', 'c-28', 'a-27', 'b-26', 'c-25', 'a-24', 'b-23',
    ]);
  });

  it('cuts the union back to MAX_MERGES, newest of the whole scope first', () => {
    const merged = mergeDelivery(THREE);

    expect(merged.merges).toHaveLength(MAX_MERGES);
    expect(merged.merges.map((m) => m.number)).toEqual([
      60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 49,
    ]);
  });

  it('keeps every release DATE, because the day series counts what the feed cannot show', () => {
    // `releaseDates` is the pre-slice set — the eight rows are a feed, the day
    // series is a count, and slicing the second to the first would draw a
    // sparkline of the eight newest releases rather than of the scope.
    expect(mergeDelivery(THREE).releaseDates).toHaveLength(15);
  });

  it('sums unassigned PRs and ORs partialness across the parts', () => {
    const merged = mergeDelivery([
      part('a', [3], [3], { unassignedPrs: 30 }),
      part('b', [2], [2], { unassignedPrs: 7, releasesPartial: true }),
    ]);

    expect(merged.unassignedPrs).toBe(37);
    expect(merged.releasesPartial).toBe(true);
  });

  it('names the orgs in the grammar ScopeLine prints into', () => {
    // One string, and the list grammar is `Intl.ListFormat`'s — the same one the
    // frontend uses for the other list in that sentence. Three orgs is the form
    // no other test reaches, and the one a plain join gets wrong.
    const scope = (n: number) =>
      mergeDelivery(['org-alpha', 'org-beta', 'org-gamma'].slice(0, n).map((o) => part(o, [1], [1])))
        .releaseScope;

    expect(scope(1)).toBe('org-alpha');
    expect(scope(2)).toBe('org-alpha and org-beta');
    expect(scope(3)).toBe('org-alpha, org-beta, and org-gamma');
  });
});
