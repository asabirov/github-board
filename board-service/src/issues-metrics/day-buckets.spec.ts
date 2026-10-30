import { describe, expect, it } from 'vitest';
import { DAY_SPAN, HISTORY_MAX_DAYS, countByDay, dayIndex, historySpan } from '../time/day-span';
import type { CloseReason } from './close-reason';
import { earliestClosedMs, seriesByDay } from './day-buckets';

const DAY = 86_400_000;

describe('calendar-day bucketing (#666, #684)', () => {
  const NOW = Date.parse('2026-07-11T12:00:00.000Z');

  it('puts a millisecond either side of UTC midnight in adjacent buckets', () => {
    const before = dayIndex('2026-07-10T23:59:59.999Z', NOW);
    const after = dayIndex('2026-07-11T00:00:00.000Z', NOW);
    expect(after).toBe(DAY_SPAN - 1);
    expect(before).toBe(DAY_SPAN - 2);
  });

  it('ends on the calendar day `now` falls in, whatever time of day `now` is', () => {
    for (const now of ['2026-07-11T00:00:00.000Z', '2026-07-11T12:00:00.000Z', '2026-07-11T23:59:59.999Z']) {
      const days = seriesByDay([{ createdAt: '2026-07-11T00:00:00.000Z', closedAt: '2026-07-11T23:00:00.000Z', stateReason: null }], Date.parse(now));
      expect(days.opened).toHaveLength(DAY_SPAN);
      expect(days.closed).toHaveLength(DAY_SPAN);
      expect(days.opened[DAY_SPAN - 1]).toBe(1);
      expect(days.closed[DAY_SPAN - 1]).toBe(1);
      // Every other day of the span is present and empty — a grid with no holes.
      expect(days.opened.slice(0, DAY_SPAN - 1).every((n) => n === 0)).toBe(true);
      expect(days.closed.slice(0, DAY_SPAN - 1).every((n) => n === 0)).toBe(true);
    }
  });

  it('drops a timestamp older than the span rather than piling it into bucket 0', () => {
    const firstDay = new Date(NOW - (DAY_SPAN - 1) * DAY).toISOString().slice(0, 10);
    const days = seriesByDay(
      [
        { createdAt: `${firstDay}T00:00:00.000Z`, closedAt: null, stateReason: null }, // oldest day in span
        { createdAt: new Date(Date.parse(`${firstDay}T00:00:00.000Z`) - 1).toISOString(), closedAt: null, stateReason: null }, // one ms too old
        { createdAt: '2019-01-01T00:00:00.000Z', closedAt: '2019-02-01T00:00:00.000Z', stateReason: null }, // years too old
      ],
      NOW,
    );
    expect(days.opened[0]).toBe(1);
    expect(days.closed[0]).toBe(0);
    expect(dayIndex('2019-01-01T00:00:00.000Z', NOW)).toBeNull();
    const total = [...days.opened, ...days.closed].reduce((s, n) => s + n, 0);
    expect(total).toBe(1);
  });

  // #817: the grid stopped being sliced out of DAY_SPAN and now reaches back to
  // the first close there has ever been. These are the three edges the window
  // has — nothing closed, a normal young board, and a board older than the cap.
  it('sizes the closed history from the first close, with DAY_SPAN under it and HISTORY_MAX_DAYS over it (#817)', () => {
    expect(historySpan(null, NOW)).toBe(DAY_SPAN);
    // Six months of closes: the window is that many days plus the day itself.
    expect(historySpan(NOW - 182 * DAY, NOW)).toBe(183);
    // Four years: capped, or the series grows a number a day forever.
    expect(historySpan(NOW - 1460 * DAY, NOW)).toBe(HISTORY_MAX_DAYS);
    // A board younger than the sparks beside it still gets their span, so one
    // payload cannot carry a history SHORTER than the series it sits next to.
    expect(historySpan(NOW - 3 * DAY, NOW)).toBe(DAY_SPAN);
    // Clock skew is not history: a close dated tomorrow answers the floor.
    expect(historySpan(NOW + 2 * DAY, NOW)).toBe(DAY_SPAN);
  });

  it('reads the earliest close off the set, ignoring open rows and unparseable dates (#817)', () => {
    const items = [
      { closedAt: '2026-07-10T10:00:00.000Z' },
      { closedAt: '2025-09-01T10:00:00.000Z' },
      { closedAt: null },
      { closedAt: 'not-a-date' },
    ];
    expect(earliestClosedMs(items)).toBe(Date.parse('2025-09-01T10:00:00.000Z'));
    expect(earliestClosedMs([{ closedAt: null }])).toBeNull();
    expect(earliestClosedMs([])).toBeNull();
  });

  // The failure #817 is about: a close from last year is real, and on the
  // DAY_SPAN axis it is not merely uncounted — `dayIndex` drops it, so the grid
  // that draws that series can only ever be empty for eleven months of a year.
  it('carries a close a year old on the history span and drops it on DAY_SPAN (#817)', () => {
    const items = [
      { createdAt: '2025-06-01T00:00:00.000Z', closedAt: '2025-08-20T09:00:00.000Z', stateReason: null },
      { createdAt: '2026-07-01T00:00:00.000Z', closedAt: '2026-07-10T09:00:00.000Z', stateReason: null },
    ];
    const span = historySpan(earliestClosedMs(items), NOW);
    const history = countByDay(items, (i) => i.closedAt, NOW, span);

    expect(span).toBe(326); // 2025-08-20 → 2026-07-11 inclusive
    expect(history).toHaveLength(span);
    expect(history[0]).toBe(1); // the old close IS the first day of the window
    expect(history.at(-2)).toBe(1);
    expect(history.reduce((s, n) => s + n, 0)).toBe(2);
    // …and the same two closes on the sparks' span carry only the recent one.
    expect(seriesByDay(items, NOW).closed.reduce((s, n) => s + n, 0)).toBe(1);
  });

  // Three tiles draw these side by side at one third each. Two spans would be
  // two x-axes drawn as though they were one — a reading error no legend fixes.
  // The history span above is the one deliberate second axis, and it is drawn
  // under the tiles rather than beside them (#817).
  it('draws the wrapper and the primitive off one span constant, in one alignment', () => {
    // Pinned, because every other assertion here reads DAY_SPAN and so cannot
    // notice it moving. 98 = 14 whole weeks, and the sparks slice a week-aligned
    // 91 out of it — 7 spare days is the widest the current partial week can be.
    expect(DAY_SPAN).toBe(98);
    expect(DAY_SPAN % 7).toBe(0);

    const items = [
      { createdAt: '2026-05-01T00:00:00.000Z', closedAt: '2026-07-09T08:00:00.000Z', stateReason: null },
      { createdAt: '2026-06-02T00:00:00.000Z', closedAt: null, stateReason: null },
    ];
    const wrapped = seriesByDay(items, NOW);
    const direct = countByDay(items, (i) => i.closedAt, NOW);

    expect(wrapped.closed).toHaveLength(DAY_SPAN);
    expect(direct).toHaveLength(DAY_SPAN);
    expect(wrapped.closed).toEqual(direct);
  });
  // #1014: a close is only delivery when Github said it was. These pin the two
  // functions that every other close series on this payload is sized and cut by,
  // so a regression here moves the grid, the sparks and the window together.
  it('counts a completed and an unknown-reason close, and skips not-planned and duplicate (#1014)', () => {
    const at = '2026-07-10T09:00:00.000Z';
    const day = (stateReason: CloseReason) => seriesByDay([{ createdAt: '2026-07-01T00:00:00.000Z', closedAt: at, stateReason }], NOW).closed;
    expect(day('completed').at(-2)).toBe(1);
    // Never told why: it counts, deliberately. Excluding it would delete real
    // delivered work from every historical figure with nothing saying so.
    expect(day(null).at(-2)).toBe(1);
    expect(day('not_planned').at(-2)).toBe(0);
    expect(day('duplicate').at(-2)).toBe(0);
  });

  it('leaves the OPENED series alone whatever the close reason (#1014)', () => {
    // An issue that was opened was opened, whatever became of it later. This is
    // the assertion that stops a future "symmetry" refactor from filtering both.
    const opened = seriesByDay([{ createdAt: '2026-07-10T00:00:00.000Z', closedAt: '2026-07-10T09:00:00.000Z', stateReason: 'not_planned' }], NOW).opened;
    expect(opened.at(-2)).toBe(1);
  });

  it('sizes the history window from ANY close, including one that was not delivery (#1014)', () => {
    // The reach and the count are different questions. We were watching from the
    // abandoned close onward, so the months after it read zero-delivered — a real
    // reading. Sized off the first DELIVERED close, the window would clip to the
    // 98-day floor and draw all of them as nothing at all, which claims nobody
    // was counting about days somebody was.
    const items = [
      { closedAt: '2025-08-20T09:00:00.000Z', stateReason: 'not_planned' as const },
      { closedAt: '2026-07-10T09:00:00.000Z', stateReason: 'completed' as const },
    ];
    expect(earliestClosedMs(items)).toBe(Date.parse('2025-08-20T09:00:00.000Z'));
    expect(historySpan(earliestClosedMs(items), NOW)).toBe(326);
    // …and the abandoned close is still not COUNTED inside that window.
    const series = seriesByDay(items.map((i) => ({ ...i, createdAt: '2025-01-01T00:00:00.000Z' })), NOW, 326);
    expect(series.closed[0]).toBe(0);
    expect(series.closed.reduce((s, n) => s + n, 0)).toBe(1);
  });
});


it('keeps closes on their UTC date across midnight', () => {
  const closes = ['2026-08-30T16:59:59-07:00', '2026-08-30T17:00:00-07:00'];
  expect(countByDay(closes.slice(0, 1), (at) => at, Date.parse('2026-08-30T23:59:59Z'), 2))
    .toEqual([0, 1]);
  expect(countByDay(closes, (at) => at, Date.parse('2026-08-31T00:00:00Z'), 2))
    .toEqual([1, 1]);
});

describe('viewer calendar days', () => {
  it('counts the same close on different local days in Berlin and Los Angeles', () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    const items = [{ createdAt: '2026-09-25T22:30:00Z', closedAt: '2026-09-25T22:30:00Z', stateReason: null }];
    expect(seriesByDay(items, now, 2, 'Europe/Berlin').closed).toEqual([0, 1]);
    expect(seriesByDay(items, now, 2, 'America/Los_Angeles').closed).toEqual([1, 0]);
  });

  it.each([
    ['2026-03-30T00:30:00+02:00', '2026-03-29T00:30:00+01:00'],
    ['2026-10-26T00:30:00+01:00', '2026-10-25T00:30:00+02:00'],
  ])('keeps consecutive calendar days across DST at %s', (now, previous) => {
    expect(dayIndex(previous, Date.parse(now), 3, 'Europe/Berlin')).toBe(1);
  });
});
