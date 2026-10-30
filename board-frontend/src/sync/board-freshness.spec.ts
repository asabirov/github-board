import { describe, expect, it } from 'vitest';
import { freshnessLabel, summariseFreshness } from './board-freshness';
import { SYNC_SOURCES, type BoardFreshness } from './sync-operation';

/**
 * The decision `board-freshness.ts` owns, at its two ends: what the header chip
 * is allowed to say about four sources (#1169).
 *
 * The chip and the Board sync panel are two readings of one record, so the chip
 * may report a time only where a row is showing that same time, and reports none
 * when no row has one. `board-sync-panel.spec.tsx` drives the ROWS against that
 * record; what is driven here is the chip's own WORDS, which are half of what
 * was decided — a summary carrying the right moment under the wrong sentence is
 * the reported defect over again.
 */
const MINUTE = 60_000;
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MINUTE).toISOString();

/** A server record with the named sources recorded and the rest not. */
function recording(times: Partial<Record<(typeof SYNC_SOURCES)[number], string>>): BoardFreshness {
  return {
    sources: Object.fromEntries(
      SYNC_SOURCES.map((key) => [key, { syncedAt: times[key] ?? null }]),
    ) as BoardFreshness['sources'],
  };
}

describe('what the chip may claim about four sources (#1169)', () => {
  /**
   * Criterion 2 at its sharpest: with nothing recorded anywhere there is no row
   * for the chip to be speaking for, so it may not use the word at all. "Sync
   * now" is what it has always said before anything has landed.
   */
  it('may not say the board is synced when not one source has a record', () => {
    const nothing = summariseFreshness(recording({}));
    expect(nothing.syncedAt).toBeNull();
    expect(freshnessLabel(nothing)).toBe('Sync now');
    expect(freshnessLabel(nothing)).not.toContain('Synced');
    // And before the board has answered at all, which is every first paint.
    expect(freshnessLabel(summariseFreshness(null))).toBe('Sync now');
  });

  /**
   * And the partial state, which is ordinary here: three of the four caches fill
   * on their surface's first read, so shortly after every boot some sources have
   * no record over a board whose data is perfectly fresh. The chip reports the
   * freshest source that HAS one, and the rows say which ones those are.
   *
   * The two assertions at the end are the readings the owner ruled out, pinned
   * so that re-opening the decision is a visible change rather than a drift:
   * "Synced 2h ago" is the board being only as fresh as its stalest source, and
   * "Sync now" is the time silenced while any source is unrecorded.
   */
  it('reports the freshest source that has a record, while two have none', () => {
    const partial = summariseFreshness(recording({ issues: at(2), projects: at(90) }));
    expect(partial).toMatchObject({ recorded: 2, total: 4 });
    expect(freshnessLabel(partial)).toBe('Synced 2m ago');
    expect(freshnessLabel(partial)).not.toBe('Synced 2h ago');
    expect(freshnessLabel(partial)).not.toBe('Sync now');
  });
});


describe('organisation coverage (#1185)', () => {
  it('cannot claim Synced when Projects is partial, even when every other source is recorded', () => {
    const record = recording(Object.fromEntries(SYNC_SOURCES.map((key) => [key, at(8)])));
    record.sources.projects = { syncedAt: at(2), organisations: { recorded: 2, total: 3 } };
    expect(freshnessLabel(summariseFreshness(record))).toBe('Sync incomplete');
    record.sources.projects.organisations = { recorded: 3, total: 3 };
    expect(freshnessLabel(summariseFreshness(record))).toBe('Synced 2m ago');
  });

  it('keeps an unread Projects scope distinct from a partial reading', () => {
    const record = recording({ issues: at(8) });
    record.sources.projects = { syncedAt: null, organisations: { recorded: 0, total: 3 } };
    expect(freshnessLabel(summariseFreshness(record))).toBe('Synced 8m ago');
  });
});

// Last-good boards remain on the page while the API reports these failed reads.
it.each([3, 1])('does not say Synced during an observed 0 of %i Projects outage', (total) => {
  const record = recording({ issues: at(2) });
  record.sources.projects = {
    syncedAt: null, organisations: { recorded: 0, total }, incomplete: true,
  };
  expect(freshnessLabel(summariseFreshness(record))).not.toContain('Synced');
  expect(freshnessLabel(summariseFreshness(record))).toBe('Sync incomplete');
});
