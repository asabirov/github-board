import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminsUnreadPane, AuditHealthNotice, emptyText, incompleteText } from './AuditSection';
import { readAuditLog, type AuditHealth } from '../api/account';

// Node test env, no DOM: render to a static string, the shape
// ConnectedClients.spec.tsx uses.

const health = (over: Partial<AuditHealth> = {}): AuditHealth => ({
  recording: 'ok',
  failures: 0,
  lastFailureAt: null,
  // #812 — a count with no instance and no window is what an older board-api
  // sends; every case below that is about the count itself carries a real one,
  // so the default is the shape today's server actually answers with.
  instance: 'abc12345',
  since: '2026-09-02T09:00:00.000Z',
  gaps: { events: 0, lastAt: null },
  ...over,
});

const markup = (h: AuditHealth | null) => renderToStaticMarkup(<AuditHealthNotice health={h} />);

/**
 * The screen the issue is about (#781).
 *
 * A `db` board whose Postgres is unreachable performs every Github write and
 * records none, and before this it rendered the same "No audit events yet" a
 * board that had done nothing rendered. An operator could not tell them apart,
 * which is the state #774 was filed on, reached by a different route.
 */
describe('an operator can tell a quiet board from a failing one (#781)', () => {
  it('says the log is incomplete, and how many rows are missing', () => {
    const html = markup(health({ recording: 'failing', failures: 3 }));
    expect(html).toContain('This log is incomplete');
    expect(html).toContain('3 events could not be recorded');
  });

  it('does not say "yet" under a failing log, where nothing is pending', () => {
    expect(emptyText(health({ recording: 'failing', failures: 1 }), false)).toBe('Nothing reached the log.');
    expect(emptyText(health(), false)).toBe('No audit events yet.');
  });

  it('draws no warning while records are landing', () => {
    // #781 drew nothing here at all. #812 replaced that silence with the scope
    // line below, because `ok` was being read as a claim about the board — what
    // must not appear is the accusation, not the sentence.
    const html = markup(health());
    expect(html).not.toContain('This log is incomplete');
    expect(html).not.toContain('could not be recorded');
  });

  it('draws nothing for an older deploy that has no opinion', () => {
    // Absence is not health. A banner here would accuse a board of losing rows
    // on the evidence of a field its build predates.
    expect(markup(null)).toBe('');
    expect(emptyText(null, false)).toBe('No audit events yet.');
  });

  it('counts one loss in the singular', () => {
    expect(markup(health({ recording: 'failing', failures: 1 }))).toContain('1 event could not be recorded');
  });

  it('separates a board with no database from one that is losing rows', () => {
    const html = markup(health({ recording: 'disabled' }));
    expect(html).toContain('No database is configured');
    expect(html).not.toContain('incomplete');
    expect(emptyText(health({ recording: 'disabled' }), false)).toBe('Nothing is recorded on this board.');
  });

  it('keeps the filter answer, which is about the filter and not the store', () => {
    expect(emptyText(health({ recording: 'failing', failures: 2 }), true)).toBe(
      'No audit events match those filters.',
    );
  });
});

describe('readAuditLog (#781 envelope, and the deploy that predates it)', () => {
  it('reads the envelope', () => {
    const log = readAuditLog({
      events: [],
      health: {
        recording: 'failing',
        failures: 2,
        lastFailureAt: null,
        instance: 'abc12345',
        since: '2026-09-02T09:00:00.000Z',
        gaps: { events: 1, lastAt: '2026-09-02T02:05:00.000Z' },
      },
    });
    expect(log.health).toEqual({
      recording: 'failing',
      failures: 2,
      lastFailureAt: null,
      instance: 'abc12345',
      since: '2026-09-02T09:00:00.000Z',
      gaps: { events: 1, lastAt: '2026-09-02T02:05:00.000Z' },
    });
  });

  // #812 — a board-api built between #781 and this sends the count with nothing
  // saying whose it is. Empty strings and a null gap count, so the pane can tell
  // that apart from a real answer and declines to narrow a number it cannot.
  it('reads a #781-era envelope as a count with no instance, window or trail read', () => {
    const log = readAuditLog({ events: [], health: { recording: 'failing', failures: 2, lastFailureAt: null } });
    expect(log.health).toEqual({
      recording: 'failing',
      failures: 2,
      lastFailureAt: null,
      instance: '',
      since: '',
      gaps: null,
    });
  });

  it('reads a malformed gaps field as null — not counted is not none', () => {
    const bad = (gaps: unknown) =>
      readAuditLog({ events: [], health: { recording: 'ok', failures: 0, gaps } }).health?.gaps;
    expect(bad(null)).toBeNull();
    expect(bad('none')).toBeNull();
    expect(bad({ lastAt: null })).toBeNull();
    expect(bad({ events: 2, lastAt: null })).toEqual({ events: 2, lastAt: null });
  });

  it('reads a bare array from an old deploy as rows with no health', () => {
    expect(readAuditLog([])).toEqual({ events: [], health: null });
  });

  it('refuses a recording value it does not know rather than drawing it', () => {
    expect(readAuditLog({ events: [], health: { recording: 'green' } }).health).toBeNull();
  });
});

/**
 * The count belongs to one process, and the pane now says so (#812).
 *
 * `failures` is since boot and never clears, which is right. It is also a
 * number about ONE board-api process, and #781 drew it bare: an operator whose
 * request landed on a healthy replica while another was losing rows read `ok`,
 * and so did one reading a board that had restarted since the loss. Neither
 * needed a misconfiguration to reach — a rolling deploy runs two processes for
 * the length of the overlap, and every board restarts.
 *
 * Two things changed. The count says whose it is and from when, so nobody reads
 * it as the board's; and a loss written into the trail as a row is surfaced
 * beside it, because that half survives the process and reaches every replica.
 */
describe('the lost-record count says whose it is (#812)', () => {
  it('scopes a healthy board to this instance and this boot, rather than claiming ok', () => {
    const html = markup(health({ since: '2026-09-02T09:00:00.000Z' }));
    expect(html).toContain('on this instance');
    // The restart that used to be invisible: the window moved, and it is on screen.
    expect(html).toContain('2026');
  });

  it('says the trail was not asked, rather than reporting an all-clear it does not have', () => {
    // `gaps: null` is a store that would not answer. Drawn as `0` it would be
    // the board inventing the reassurance it most needs not to invent.
    expect(markup(health({ gaps: null }))).toContain('could not be asked');
    expect(markup(health())).not.toContain('could not be asked');
  });

  it('stays silent for a #781-era deploy, which has no scope to report', () => {
    // Nothing narrower is knowable there, so it says nothing rather than
    // inventing a window for a number that has none.
    expect(markup(health({ instance: '', since: '' }))).toBe('');
  });

  it('names the instance the count belongs to, not the board', () => {
    const text = incompleteText(health({ recording: 'failing', failures: 3, since: '2026-09-02T09:00:00.000Z' }));
    expect(text).toContain('3 events could not be recorded by this instance');
  });

  it('reports a gap the trail carries even when this instance has lost nothing', () => {
    // The replica case, and the restart case: this process is clean, the trail
    // is not, and the pane must not answer for the process.
    const html = markup(health({
      recording: 'failing',
      failures: 0,
      gaps: { events: 2, lastAt: '2026-09-02T02:05:00.000Z' },
    }));
    expect(html).toContain('This log is incomplete');
    expect(html).toContain('2 stretches of lost records');
    expect(html).toContain('another instance');
    // And it does not invent a count for this process while doing it.
    expect(html).not.toContain('could not be recorded by this instance');
  });

  it('does not add the two counts together', () => {
    // They overlap: a stretch this process is carrying may already have been
    // written down. Summing would double-count the very case the row exists for.
    const text = incompleteText(health({
      recording: 'failing',
      failures: 2,
      gaps: { events: 1, lastAt: '2026-09-02T02:05:00.000Z' },
    }));
    expect(text).toContain('2 events could not be recorded by this instance');
    expect(text).toContain('1 stretch of lost records');
    // NOT `not.toContain('3')` (#839). The sentence carries two relative times,
    // and `ago()` reads the real clock against these fixed fixture timestamps —
    // so about thirteen hours after `since` it says "13h ago" and the bare
    // character assertion failed against a tree nobody had touched. `3h`, `23h`,
    // `3m`, `30m` and `3d` do the same at other offsets, which is several red
    // windows a day. What the test means is that neither count was summed into
    // the other, so it says that: no sentence here reports a 3 of anything.
    expect(text).not.toMatch(/\b3 (events?|stretch(es)?)\b/);
  });
});

/**
 * The pane an operator could not reach (#811).
 *
 * On a `db` board whose Postgres was unreachable before it booted, the admin
 * roster has never been read, so nobody resolves as admin and this endpoint
 * answered `403`. The pane said "This section is for admins only" — an
 * accusation about the reader, over the one page that would have named the
 * outage. The refusal stands; the sentence is what changes.
 */
describe('the Audit pane when the board cannot say who its admins are (#811)', () => {
  const html = renderToStaticMarkup(<AdminsUnreadPane />);

  it('names the store instead of the reader', () => {
    expect(html).toContain('cannot read who its admins are');
    expect(html).not.toContain('for admins only');
  });

  it('says the trail is losing records too, which is the same outage', () => {
    // The store that cannot answer "who are the admins" is the store the trail
    // is written to, so an operator reading this is looking at a live gap.
    expect(html).toContain('being lost');
  });
});
