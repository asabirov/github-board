import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SyncSources } from '../topbar/TopBar';
import { summariseFreshness, sourceSyncedAt } from './board-freshness';
import { syncedLabel } from './board-freshness';
import { SOURCE_NAMES, SYNC_SOURCES, type BoardFreshness, type SyncOperation } from './sync-operation';

/**
 * #1169 — the header chip said "Synced 8m ago" over five rows saying "Not
 * recorded", on a board whose five sources had all just refreshed.
 *
 * The two were reading different things. The chip took the freshest payload
 * timestamp any mounted page reported; the rows took `SyncOperation.sources`,
 * which is a record of one MANUAL run in one tab and is absent until somebody
 * presses the button there. Both read one server record now, and what this
 * drives is that they cannot say different things about it.
 *
 * `SyncSources` is rendered on its own because the popover portals its content
 * and a portal draws nothing without a DOM — the same reason `struck-copy.spec`
 * renders it that way.
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

const ALL_FOUR = recording({
  issues: at(8), issueBuckets: at(8), projects: at(8), repos: at(8),
});

const panel = (props: Partial<Parameters<typeof SyncSources>[0]>) => renderToStaticMarkup(createElement(SyncSources, {
  titleId: 'sync-title', statusId: 'sync-status', label: 'Sync now', syncing: false,
  syncError: false, operation: null, freshness: null, requestSync: () => {}, ...props,
}));
const text = (markup: string) => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

/** What one row says about its source: the `<li>`'s words with the source's own
 *  name taken off the front. Read off the `<li>` rather than off the whole
 *  panel's text, so the last row cannot pick up the button beneath it. */
function rowFor(markup: string, key: (typeof SYNC_SOURCES)[number]): string {
  const rows = markup.match(/<li\b[^>]*>[\s\S]*?<\/li>/g) ?? [];
  const name = SOURCE_NAMES[key];
  const row = rows.map((li) => text(li).trim()).find((words) => words.startsWith(name));
  if (row === undefined) throw new Error(`no row for ${name} among ${rows.length} rows`);
  return row.slice(name.length).trim();
}

describe('the chip reports a recent sync, so every source that synced shows its time (#1169, criterion 1)', () => {
  it('shows a recorded time on every row, and "Not recorded" on none of them', () => {
    const markup = panel({ freshness: ALL_FOUR });
    expect(text(markup)).not.toContain('Not recorded');
    for (const key of SYNC_SOURCES) expect(rowFor(markup, key), SOURCE_NAMES[key]).toBe('8m ago');
  });

  it('carries the exact moment beside the coarse one, for a reader who needs it', () => {
    const markup = panel({ freshness: ALL_FOUR });
    for (const key of SYNC_SOURCES) {
      expect(markup).toContain(`title="${ALL_FOUR.sources[key].syncedAt}"`);
    }
  });

  // The whole of the report: a chip claiming a sync and rows claiming none.
  it('says the same thing as the chip, out of the same record', () => {
    const summary = summariseFreshness(ALL_FOUR);
    expect(summary.syncedAt).not.toBeNull();
    expect(syncedLabel(summary.syncedAt as string)).toBe('Synced 8m ago');
    expect(text(panel({ freshness: ALL_FOUR }))).toContain('8m ago');
  });

  it('reports each source’s own age, not one age for all four', () => {
    const mixed = recording({
      issues: at(2), issueBuckets: at(8), projects: at(90), repos: at(0),
    });
    const markup = panel({ freshness: mixed });
    expect(rowFor(markup, 'issues')).toBe('2m ago');
    expect(rowFor(markup, 'projects')).toBe('2h ago');
    expect(rowFor(markup, 'repos')).toBe('just now');
  });
});

describe('a source with no recorded sync (#1169, criterion 2)', () => {
  it('points missing-time rows to sync without replacing recorded ages (#1275)', () => {
    const markup = panel({ freshness: recording({ issues: at(8), repos: at(8) }) });
    expect(rowFor(markup, 'issues')).toBe('8m ago');
    expect(rowFor(markup, 'projects')).toBe('Sync to refresh');
    expect(text(markup).match(/Sync to refresh/g)?.length).toBe(2);
  });

  /**
   * With NO source recorded the chip may not claim the board is synced.
   *
   * This is the criterion at its sharpest, and it is the state the reporter's
   * screenshot would have been in had the rows been telling the truth: nothing
   * recorded anywhere, so nothing for a chip to report.
   */
  it('leaves the chip with nothing to report when not one source has a record', () => {
    expect(summariseFreshness(recording({})).syncedAt).toBeNull();
    expect(summariseFreshness(null).syncedAt).toBeNull();
    expect(text(panel({ freshness: recording({}) })).match(/Sync to refresh/g)?.length).toBe(4);
  });

  it('counts what is recorded, so the chip can say how much of the board it speaks for', () => {
    expect(summariseFreshness(recording({ issues: at(8), repos: at(8) }))).toMatchObject({ recorded: 2, total: 4 });
    expect(summariseFreshness(ALL_FOUR)).toMatchObject({ recorded: 4, total: 4 });
  });

  // A record the server could not have written: the chip must not date the
  // board off a string that is not a moment, and the row must not print it.
  it('reads an unparseable time as no record rather than as a time', () => {
    const rubbish = { sources: { ...recording({}).sources, issues: { syncedAt: 'whenever' } } } as BoardFreshness;
    expect(sourceSyncedAt(rubbish, 'issues')).toBeNull();
    expect(summariseFreshness(rubbish).syncedAt).toBeNull();
    expect(rowFor(panel({ freshness: rubbish }), 'issues')).toBe('Sync to refresh');
  });
});

describe('the rows are announced while a run is moving, and not while a clock ticks (#1169)', () => {
  /**
   * The live region was put on this list so a source settling during a sync is
   * announced as it settles. With the rows carrying an AGE, and that age
   * recomputed every twenty seconds by `SyncStamp`'s own tick, a panel left open
   * would read all four rows aloud every twenty seconds to report that eight
   * minutes had become nine.
   */
  it('is a polite live region only while a run is in flight', () => {
    expect(panel({ freshness: ALL_FOUR })).toContain('aria-live="off"');
    expect(panel({ freshness: recording({}) })).toContain('aria-live="off"');
    const running = panel({
      freshness: ALL_FOUR,
      syncing: true,
      operation: {
        operationId: 'op-2', state: 'running', startedAt: at(0), expiresAt: at(-2),
        sources: {
          issues: { state: 'running' }, issueBuckets: { state: 'pending' },
          projects: { state: 'pending' }, repos: { state: 'pending' },
        },
      },
    });
    expect(running).toContain('aria-live="polite"');
  });
});

describe('a manual run in this tab still takes the rows while it is moving (#1169)', () => {
  const RUNNING: SyncOperation = {
    operationId: 'op-1', state: 'running', startedAt: at(0), expiresAt: at(-2),
    sources: {
      issues: { state: 'succeeded' }, issueBuckets: { state: 'running' },
      projects: { state: 'pending' }, repos: { state: 'degraded' },
    },
  };

  /** A press is watched, so what each source is DOING beats how old it was. */
  it('shows what each source is doing, over the times it would otherwise show', () => {
    const markup = panel({ freshness: ALL_FOUR, operation: RUNNING, syncing: true, label: 'Syncing, 1/4 finished' });
    expect(rowFor(markup, 'issues')).toBe('Refreshed');
    expect(rowFor(markup, 'issueBuckets')).toBe('Refreshing');
    expect(rowFor(markup, 'projects')).toBe('Waiting');
    expect(text(markup)).not.toContain('8m ago');
  });

  /** And once it is over, the rows go back to the record — which by then has
   *  moved, because the run refilled the four caches it reports on. */
  it('returns to the record once the run is no longer held', () => {
    const after = recording({
      issues: at(0), issueBuckets: at(0), projects: at(0), repos: at(0),
    });
    const markup = panel({ freshness: after, operation: null });
    for (const key of SYNC_SOURCES) expect(rowFor(markup, key)).toBe('just now');
  });
});


it('shows Projects coverage beside its real moment in partial and healthy states (#1185)', () => {
  const freshness = recording({ projects: at(8) });
  freshness.sources.projects.organisations = { recorded: 2, total: 3 };
  expect(rowFor(panel({ freshness }), 'projects')).toBe('2 of 3 organisations, 8m ago');
  freshness.sources.projects.organisations.recorded = 3;
  expect(rowFor(panel({ freshness }), 'projects')).toBe('3 of 3 organisations, 8m ago');
});
