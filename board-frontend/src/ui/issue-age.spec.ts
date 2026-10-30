import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ageDaysSince, ageLabel, ageToneClass } from './issue-age';
import { IssueListRow } from './IssueListRow';

// This module paints the only colour on two different rows, and every one of its
// answers is a branch a mutation can flip without a single spec noticing: a
// reviewer set `ageLabel(null)` to `NEVER`, dropped the clamp, returned danger
// for an unknown date and repointed `IssueListRow`'s resting class, and the
// whole 2582-test suite stayed green each time. So the table below is the pin.
//
// `now` is fixed rather than read off the clock: an age computed against
// `Date.now()` means something different tomorrow, which is the one thing a
// threshold spec cannot afford.

const NOW = Date.parse('2026-09-02T12:00:00Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** An ISO instant `ms` before `NOW`. */
const before = (ms: number) => new Date(NOW - ms).toISOString();

const LIST_RESTING = 'text-muted';
const ROW_RESTING = 'text-dim';

/**
 * `IssueListRow`'s private `ageClass`, exactly as it stood at `b9e267f` before
 * #822 moved the thresholds into the shared module. The claim this file exists
 * to keep honest is that the "Oldest open" row renders what it always did, and
 * the only way to say that is to keep the old function here and compare.
 */
function ageClassBefore(days: number): string {
  if (days >= 90) return 'text-danger';
  if (days >= 60) return 'text-warn';
  return 'text-dim';
}

describe('ageDaysSince', () => {
  it('says nothing rather than "brand new" when there is no usable date', () => {
    expect(ageDaysSince(undefined, NOW)).toBeNull();
    expect(ageDaysSince('', NOW)).toBeNull();
    expect(ageDaysSince('last Tuesday', NOW)).toBeNull();
  });

  it('clamps a future date to 0 instead of counting backwards', () => {
    expect(ageDaysSince(before(-5 * DAY), NOW)).toBe(0);
    expect(ageDaysSince(before(-1), NOW)).toBe(0);
  });

  // The server rounds (`personal-issues.vm.ts`, `issues-metrics.vm.ts`), and on
  // /team its number is drawn directly above this one. Rounding here is what
  // stops the two blocks disagreeing by a day for twelve hours out of every
  // twenty-four.
  it('rounds to the nearest whole day, the way board-api does', () => {
    expect(ageDaysSince(before(59 * DAY + 10 * HOUR), NOW)).toBe(59);
    expect(ageDaysSince(before(59 * DAY + 14 * HOUR), NOW)).toBe(60);
    expect(ageDaysSince(before(89 * DAY + 10 * HOUR), NOW)).toBe(89);
    expect(ageDaysSince(before(89 * DAY + 14 * HOUR), NOW)).toBe(90);
    expect(ageDaysSince(before(12 * HOUR), NOW)).toBe(1);
    expect(ageDaysSince(before(11 * HOUR), NOW)).toBe(0);
  });

  it('agrees with the server on the same instant, to the whole day', () => {
    const serverAgeDays = (iso: string) => Math.round((NOW - Date.parse(iso)) / DAY);
    for (const hours of [0, 1, 11, 12, 13, 36, 1_415, 1_416, 2_147, 2_148]) {
      const iso = before(hours * HOUR);
      expect(ageDaysSince(iso, NOW)).toBe(serverAgeDays(iso));
    }
  });
});

describe('ageLabel', () => {
  it('says one thing down the whole column: whole days with a d', () => {
    expect(ageLabel(0)).toBe('0d');
    expect(ageLabel(1)).toBe('1d');
    expect(ageLabel(117)).toBe('117d');
  });

  it('draws an em dash for an age it does not know', () => {
    expect(ageLabel(null)).toBe('—');
  });
});

describe('ageToneClass', () => {
  it('rests when the age is unknown, whichever resting class the caller rests at', () => {
    expect(ageToneClass(null, LIST_RESTING)).toBe(LIST_RESTING);
    expect(ageToneClass(null, ROW_RESTING)).toBe(ROW_RESTING);
  });

  it('steps at 60 and at 90, and nowhere else', () => {
    expect(ageToneClass(59, LIST_RESTING)).toBe(LIST_RESTING);
    expect(ageToneClass(60, LIST_RESTING)).toBe('text-warn');
    expect(ageToneClass(89, LIST_RESTING)).toBe('text-warn');
    expect(ageToneClass(90, LIST_RESTING)).toBe('text-danger');
  });

  // The claim in #822's pull request is that the "Oldest open" block renders
  // unchanged. These are the inputs that block can hand it, including the ones
  // an `ageDays` off a stale fixture has actually produced.
  it('returns what IssueListRow\'s deleted private ageClass returned', () => {
    const inputs = [-400, -1, 0, 0.5, 1, 29.5, 59, 59.5, 60, 60.4, 89, 89.9, 90, 117, 400];
    for (const days of inputs) {
      expect([days, ageToneClass(days, ROW_RESTING)]).toEqual([days, ageClassBefore(days)]);
    }
  });
});

describe('IssueListRow spends the shared tone', () => {
  const row = (ageDays: number) =>
    renderToStaticMarkup(
      createElement(IssueListRow, {
        row: {
          repo: 'board',
          number: 129,
          title: 'A row of the Oldest open block',
          ageDays,
          htmlUrl: 'https://github.com/acme/board/issues/129',
        },
        mayClose: false,
      }),
    );

  /** The age cell is the last span on the row and the only `tabular-nums` one
   *  carrying a day count. */
  const ageCellClass = (html: string) =>
    html.match(/class="([^"]*tabular-nums[^"]*)"[^>]*>\s*\d+ days?/)?.[1] ?? '';

  it('rests at text-dim, one step brighter than the list', () => {
    expect(ageCellClass(row(5))).toContain(ROW_RESTING);
    expect(ageCellClass(row(5))).not.toContain('text-danger');
  });

  it('paints its two warm steps on the shared thresholds', () => {
    expect(ageCellClass(row(60))).toContain('text-warn');
    expect(ageCellClass(row(90))).toContain('text-danger');
  });
});
