import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
// @ts-expect-error node:fs is untyped here; it exists in vitest's node env.
import { readFileSync, readdirSync } from 'node:fs';
import { tooltipSurface } from '../ui/kit';
import { CHIP_CLASS, CHIP_CLEARANCE, CHIP_W, DayGrid, HOVER_CELL, chipPlacement } from './DayGrid';
import { decodeViewer, encodeViewer, DEFAULT_VIEWER } from '../issues-viewer/viewer-url';
import { shadeScale, type DayCount } from './flow-strip.vm';
// The components' own source, as text. Vite's `?raw` — the test env is `node`
// with no DOM to press a button in, and jsdom is a dependency this lane may not
// add.
import flowStripSource from './FlowStrip.tsx?raw';
import dayGridSource from './DayGrid.tsx?raw';

// The board's test env is `node` — same rationale as OrgScopeNotice.spec.tsx:
// render to a static HTML string and assert against the markup.
const ENDS_ON = Date.UTC(2026, 7, 23); // Sunday 23 Aug 2026
const SCALE = shadeScale([0, 1, 1, 2, 3, 4, 8, 13, 20]);
/** The group's accessible name, which `FlowStrip` composes from the block's own
 *  caption and the span (`flow-strip.vm.spec.ts` asserts the sentence it builds).
 *  Any sentence does here: what these are about is that the group carries one. */
const LABEL = 'Issues closed, 91 days to Sun 23 Aug';

/** `cols` columns, the last `lastLen` days long — the shape the vm hands over
 *  once the running week rides on the end. */
const weeksOf = (cols: number, lastLen = 7): DayCount[][] =>
  Array.from({ length: cols }, (_, c) =>
    Array.from({ length: c === cols - 1 ? lastLen : 7 }, (_, r) => (c * 7 + r) % 5));

/** The same shape with its first `n` days unobserved — the head of a 52-week
 *  grid, where the window reaches back further than board-api's first close. */
const weeksFrom = (cols: number, blank: number, lastLen = 7): DayCount[][] => {
  const weeks = weeksOf(cols, lastLen);
  for (let i = 0; i < blank; i++) weeks[Math.floor(i / 7)]![i % 7] = null;
  return weeks;
};

const html = (cols: number, lastLen = 7, endsOn = ENDS_ON) =>
  renderToStaticMarkup(<DayGrid weeks={weeksOf(cols, lastLen)} scale={SCALE} endsOn={endsOn} label={LABEL} />);

const count = (markup: string, needle: RegExp) => (markup.match(needle) ?? []).length;

describe('relative cell backgrounds (#1293)', () => {
  it('renders faint low counts and a full maximum without fading the numbers', () => {
    const values = [0, 1, 5, 50, 84];
    const markup = renderToStaticMarkup(
      <DayGrid weeks={[values]} scale={shadeScale(values)} endsOn={ENDS_ON} label={LABEL} />,
    );
    for (const [n, pct] of [[1, 1], [5, 6], [50, 60], [84, 100]]) {
      expect(markup).toContain(`background:color-mix(in srgb, var(--accent-strong) ${pct}%, var(--surface));color:color-mix(in srgb, var(--day-ink-on-deep) clamp(0%, calc((${pct} - var(--day-ink-flip) + 1) * 100%), 100%), var(--day-ink-on-pale));box-shadow:inset 0 0 0 1px var(--border)">${n}</span>`);
    }
    expect(markup).not.toContain('opacity:');
    expect(markup).toContain('background:var(--surface);box-shadow:inset 0 0 0 1px var(--border)');
  });
});

describe('one outline for every day (#1308)', () => {
  it('outlines unrecorded, zero, faint, filled and burning cells alike', () => {
    const values: DayCount[] = [null, 0, 1, 50, 100, 101];
    const markup = renderToStaticMarkup(
      <DayGrid weeks={[values]} scale={shadeScale([0, 1, 50, 100, 101])} endsOn={ENDS_ON} label={LABEL} dailyGoal={100} />,
    );
    expect(count(markup, /box-shadow:inset 0 0 0 1px var\(--border\)/g)).toBe(7);
    expect(count(markup, /data-day=/g)).toBe(5);
    expect(count(markup, /data-goal-flame=/g)).toBe(2);
    expect(markup).toContain('class="goal-count">101</span>');
    expect(markup).not.toContain('>0</span>');
  });
});

describe('the day grid’s geometry (#666, #684)', () => {
  // The preview drew a hardcoded 13 columns, so a filtered or short series
  // silently lost days off the end. The number of weeks is a property of the
  // columns handed in, and nothing else.
  it('takes its column count from the weeks, not from a 13', () => {
    expect(count(html(12), /data-week=/g)).toBe(12);
    expect(count(html(14), /data-week=/g)).toBe(14);
    expect(count(html(13), /data-week=/g)).toBe(13);
  });

  it('draws one cell per day', () => {
    expect(count(html(12), /data-day=/g)).toBe(84);
    expect(count(html(14), /data-day=/g)).toBe(98);
  });

  // Seven rows deep whatever the span is. It used to be seven rows of a fixed
  // 24px, which at 53 columns is a 6px-wide slot 24px tall on a phone — seven
  // rows of vertical dashes rather than a grid of days (#817). The cell takes
  // its height from its own width now, so the block's height follows the rail
  // instead of being declared.
  it('keeps every slot square and declares no height of its own', () => {
    for (const n of [12, 52, 53]) {
      const markup = html(n);
      expect(markup).not.toMatch(/height:\d+px/);
      // One square slot per day of a seven-row grid, drawn or not: the cells
      // and the unreached slots together.
      expect(count(markup, /aspect-ratio:1/g)).toBe(n * 7);
    }
  });

  it('lays the labels and the columns out in ONE grid, so the rows line up', () => {
    // The weekday labels used to be a flex column of fixed-pitch spans beside a
    // flex row of columns, which only aligned because both were 24px. They
    // divide the row's own height now, and the row is as tall as a column of
    // square cells — so there is one thing deciding the geometry and not two.
    const markup = html(53);
    expect(markup).toContain('grid-template-columns:26px repeat(53, minmax(36px, 1fr))');
    expect(markup).not.toContain('flex-1 text-[10px]');
  });
});

describe('a day the series does not reach draws a dimmed cell (#817)', () => {
  // The first close in either org is 2026-03-08, so a 52-week grid opens on
  // months nobody watched. A zero cell there would report a quiet spring that
  // never happened, and `flow-strip.vm.ts` keeps absent, empty, zero and
  // unobserved as four states for exactly this reason. It drew NOTHING at first
  // and Artur turned that down on the rendered page — "make empty cells, dont
  // just leave empty space" — so it is a cell, dimmed, and still not a reading.
  const BLANK = renderToStaticMarkup(
    <DayGrid weeks={weeksFrom(13, 21)} scale={SCALE} endsOn={ENDS_ON} label={LABEL} />,
  );

  it('draws a swatch for every slot, and a button for only the ones with a reading', () => {
    // 91 slots, 21 of them unobserved: 91 swatches, 70 buttons and 70 names. A
    // name is counted by the day it opens with — the group around the cells
    // carries an `aria-label` of its own now, and it is not a cell's.
    expect(count(BLANK, /aspect-ratio:1/g)).toBe(91);
    expect(count(BLANK, /height:92%/g)).toBe(91);
    expect(count(BLANK, /<button/g)).toBe(70);
    expect(count(BLANK, /data-day=/g)).toBe(70);
    expect(count(BLANK, /aria-label="(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) /g)).toBe(70);
    // Not vacuous: the same shape with everything observed draws all 91.
    expect(count(html(13), /<button/g)).toBe(91);
  });

  it('uses the zero-cell fill without changing the unobserved state', () => {
    // #947 changes colour only: an unobserved day is still null, absent from
    // the keyboard/accessibility path, and keeps its distinct hover sentence.
    const zeroFill = /background:var\(--surface\);box-shadow:inset 0 0 0 1px var\(--border\)/g;
    // The 21 unobserved swatches now intentionally share the 14 recorded-zero
    // swatches, so the exact style occurs once per zero-or-unobserved cell.
    expect(count(BLANK, zeroFill)).toBe(35);
    expect(BLANK).not.toContain('45%,transparent');
    expect(count(BLANK, /<button/g)).toBe(70);
  });

  it('says "not recorded" and never "nothing closed" about a day nobody counted', () => {
    // The chip is state and opens on hover, which nothing here can do, so the
    // sentence is checked where it would have to come back from.
    expect(dayGridSource).toContain('not recorded');
    expect(dayGridSource).toMatch(/unreachedSentence\(dayOf\(c, r\)\)/);
    // The two sentences are separate functions on purpose: one is about a count
    // and this day has none.
    expect(dayGridSource).not.toMatch(/unreachedSentence[^\n]*nothing closed/);
    // And it is a UTC day like every other cell (#1034).
    expect(dayGridSource).toContain('`${dateLabel(t)}, not recorded`');
  });

  it('leaves the column standing, so the grid keeps its shape', () => {
    // The three empty columns are still there and still seven slots deep —
    // taking them out would move every later column and shift the calendar.
    expect(count(BLANK, /data-week=/g)).toBe(13);
    expect(BLANK).toContain('data-week="0"');
  });

  it('does not turn it into a recorded zero', () => {
    // The fill is shared, but unobserved slots remain outside the 70 button
    // readings and retain their distinct hover/accessibility source branch.
    expect(count(BLANK, /style="aspect-ratio:1" aria-hidden="true"/g)).toBe(21);
    expect(count(BLANK, /data-day=/g)).toBe(70);
    // Mon 25 May is the grid's first slot and unobserved; had it been observed
    // its count would be 0. Mon 15 Jun is the first day with a reading.
    expect(BLANK).not.toContain('aria-label="Mon 25 May,');
    expect(BLANK).toContain('aria-label="Mon 15 Jun, 1 closed"');
  });

  it('puts the tab stop on the last cell that exists, not the last slot', () => {
    expect(count(BLANK, /tabindex="0"/g)).toBe(1);
    expect(BLANK).toContain(`data-day="${12 * 7 + 6}" tabindex="0"`);
  });

  it('still gives one tab stop when the FIRST columns are the empty ones', () => {
    // The cursor is clamped at render to a cell that exists, and unobserved
    // days are a contiguous head of the grid — so the clamp has to hold at the
    // left edge as well as at the right, which is the case a year switch makes
    // ordinary.
    const mostlyBlank = renderToStaticMarkup(
      <DayGrid weeks={weeksFrom(13, 12 * 7)} scale={SCALE} endsOn={ENDS_ON} label={LABEL} />,
    );
    expect(count(mostlyBlank, /<button/g)).toBe(7);
    expect(count(mostlyBlank, /tabindex="0"/g)).toBe(1);
  });
});

describe('the month row over the grid (#817)', () => {
  /** The month names actually drawn. The empty spans render nothing between the
   *  tags, so this counts labels rather than columns. Read off the label row's
   *  own tone class and not off `aria-hidden`, which the last test here is
   *  about: the two would otherwise pass and fail together. The weekday labels
   *  set two letters and are excluded by the third. */
  const months = (markup: string) =>
    [...markup.matchAll(/text-muted[^>]*>([A-Z][a-z]{2})</g)].map((m) => m[1]);

  it('names every month of a calendar year that opens on a Monday', () => {
    // 1 January 2029 is a Monday, so the year begins exactly on column 0 — and
    // column 0 was never asked whether a month starts there, only whether it
    // differs from the column before, which does not exist. The year rendered
    // `Feb Mar Apr May Jun ...` with January the one month with no name over it.
    const y2029 = renderToStaticMarkup(
      <DayGrid weeks={weeksOf(53, 1)} scale={SCALE} endsOn={Date.UTC(2029, 11, 31)} label={LABEL} />,
    );
    expect(new Date(Date.UTC(2029, 0, 1)).getUTCDay()).toBe(1); // the fixture really is that year
    expect(months(y2029)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  });

  it('still names nothing over a first column that opens mid-month', () => {
    // The trailing window's first column is a part-month whose earlier days are
    // not on the grid at all — naming it would put a month over four of its
    // days. This is the case column 0 was skipped for, and it is unchanged: the
    // test is the month's own first day, not the column's position.
    const trailing = html(53);
    expect(new Date(ENDS_ON - 370 * 86_400_000).getUTCDate()).not.toBe(1);
    expect(months(trailing)[0]).toBe('Sep');
    expect(months(trailing)).toHaveLength(12);
  });

  it('says the months to the eye and not to a screen reader', () => {
    // They sit inside the grid element, which is the `role="group"` holding 367
    // buttons, so an unhidden month row reads twelve bare words out in front of
    // the first day a reader can point at — each of them already in the sentence
    // every cell under it carries.
    const markup = html(53);
    expect(months(markup)).toHaveLength(12);
    expect(count(markup, /aria-hidden="true">[A-Z][a-z]{2}</g)).toBe(12);
  });

  it('names the group it is drawn in', () => {
    // The group had no name at all, new or old: a reader landing in it heard
    // "group" and 367 buttons.
    expect(html(13)).toContain(`role="group" aria-label="${LABEL}"`);
  });
});

describe('where the hover chip goes (#817)', () => {
  it('keeps a wider goal tooltip inside the visible scrolled interval', () => {
    const left = chipPlacement({ left: 1200, top: 100, width: 36, cell: 36 }, 334, 900, 320).left;
    expect(left - 160).toBeGreaterThanOrEqual(900);
    expect(left + 160).toBeLessThanOrEqual(1234);
  });
  // The chip renders on hover and this suite has no DOM to hover with, so the
  // placement is a pure function of the cell's box — see `chipPlacement`.
  const box = (over: Partial<{ left: number; top: number; width: number; cell: number }> = {}) =>
    ({ left: 0, top: 0, width: 19, cell: 19, ...over });
  /** The block's inner width at a 390px phone, measured for #817. */
  const PHONE = 334;

  it('opens downward while the cell is inside one chip-height of the top', () => {
    // A one-line chip is 30.5px plus a 6px standoff (#1028). Above that the chip
    // clears the grid; inside it, opening upward draws the chip over the caption —
    // 12.69px of it at 390px, measured on the built page while the chip could
    // still wrap.
    expect(chipPlacement(box({ top: 0 }), PHONE).below).toBe(true);
    expect(chipPlacement(box({ top: 26 }), PHONE).below).toBe(true);
    expect(chipPlacement(box({ top: 36 }), PHONE).below).toBe(true);
    expect(chipPlacement(box({ top: 40 }), PHONE).below).toBe(false);
  });

  it('keeps the chip inside the block at both edges', () => {
    // Centred on the cell and shifted by half its own width, so a cell in the
    // first or last column would otherwise hang half a chip outside the card.
    const HALF = CHIP_W / 2;
    for (const c of [0, 1, 26, 51, 52]) {
      const left = chipPlacement(box({ left: c * 6.3, width: 6 }), PHONE).left;
      expect(left - HALF).toBeGreaterThanOrEqual(0);
      expect(left + HALF).toBeLessThanOrEqual(PHONE);
    }
    // Not vacuous: a cell with room on both sides is centred on itself and not
    // pushed anywhere.
    expect(chipPlacement(box({ left: 100, width: 20 }), PHONE).left).toBe(110);
  });

  it('centres on the cell before the block has been measured', () => {
    // A wrapper with no width yet cannot say where its edges are, and a clamp
    // against 0 would park every chip on the left edge.
    expect(chipPlacement(box({ left: 300, width: 20 }), 0).left).toBe(310);
  });

  it('keeps both edges inside the visible interval after scrolling', () => {
    for (const width of [334, 1080]) {
      for (const scrollLeft of [0, 417, 1600]) {
        for (const offset of [0, 18, width / 2, width - 36]) {
          const left = chipPlacement(box({ left: scrollLeft + offset, width: 36 }), width, scrollLeft).left;
          expect(left - CHIP_W / 2).toBeGreaterThanOrEqual(scrollLeft);
          expect(left + CHIP_W / 2).toBeLessThanOrEqual(scrollLeft + width);
        }
      }
    }
  });
});

describe('the running week just stops (#709)', () => {
  // Off a Saturday: 13 whole weeks and Monday through Friday. The right-hand
  // edge steps down, and the shortness is the whole of the signal that says the
  // newest column is unfinished.
  const SHORT = html(14, 5);

  it('draws fewer than seven cells in the last column, and no swatch in the rest', () => {
    expect(count(SHORT, /data-day=/g)).toBe(13 * 7 + 5);
    expect(count(SHORT, /data-week=/g)).toBe(14);
    // A day that has not happened yet draws NOTHING: no swatch, no outline, no
    // button, no focus stop. Every cell that exists is a button, so counting
    // them is counting the days drawn.
    expect(count(SHORT, /<button/g)).toBe(13 * 7 + 5);
  });

  it('keeps the block exactly seven rows tall while the column is short', () => {
    // The two unreached slots still occupy their square, so the grid does not
    // grow or shrink as the week fills in.
    expect(count(SHORT, /aspect-ratio:1/g)).toBe(14 * 7);
  });

  it('starts the roving tab stop on the last cell that EXISTS', () => {
    // It used to start at row 6 of the last column, which is an empty slot six
    // days in seven — a tab into the grid landing on nothing.
    const stops = [...SHORT.matchAll(/data-day="(\d+)" tabindex="0"/g)].map((m) => m[1]);
    expect(stops).toEqual([String(13 * 7 + 4)]);
  });

  it('dates the last drawn cell as endsOn, and counts back from there', () => {
    // `endsOn` is UTC midnight of the last DRAWN day — the last cell of the
    // short column, not of a seven-long one that is not there.
    const friday = Date.UTC(2026, 7, 28); // Friday 28 Aug 2026
    const markup = html(14, 5, friday);
    expect(markup).toContain('aria-label="Fri 28 Aug,');
    expect(markup).toContain('aria-label="Mon 24 Aug,'); // the short column's first day
  });
});

describe('a day names its date and its count, and no slice (#817)', () => {
  // The type switcher is gone, so a cell has no slice left to be wrong about.
  // "no bugs closed" existed because "nothing closed" was a falsehood on a day
  // that closed no bugs and twelve chores; with nothing narrowing the grid, the
  // sentence goes back to what it said before the filter existed. Since #709
  // took the key off the grid this is the whole of what decodes a cell.
  const ONE_WEEK = renderToStaticMarkup(
    <DayGrid weeks={[[0, 3, 0, 0, 0, 0, 0]]} scale={SCALE} endsOn={ENDS_ON} label={LABEL} />,
  );

  it('says "nothing closed" for a zero and "3 closed" for a count', () => {
    expect(ONE_WEEK).toContain(', nothing closed"');
    expect(ONE_WEEK).toContain(', 3 closed"');
  });

  it('names only the weekday, date and closed count (#1121)', () => {
    // The browser guard checks that the visible chip matches this aria-label.
    expect(ONE_WEEK).toContain('aria-label="Mon 17 Aug, nothing closed"');
    expect(ONE_WEEK).toContain('aria-label="Tue 18 Aug, 3 closed"');
    // Every cell has the same date-only shape.
    const markup = html(53);
    expect(count(markup, /aria-label="(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+ [A-Z][a-z]{2}, (?:nothing closed|\d+ closed)"/g)).toBe(count(markup, /data-day=/g));
    expect(count(markup, /data-day=/g)).toBe(371);
  });

  it('names no type anywhere, in the markup or in the source', () => {
    // The chip is state and renders on hover, which nothing here can do, so the
    // sentence it would draw is checked where it would have to come back.
    expect(ONE_WEEK).not.toMatch(/, no \w+ closed"/);
    expect(dayGridSource).not.toMatch(/typeWord/);
  });
});

describe('recorded zero cells stay quiet but remain distinguishable (#927)', () => {
  const markup = renderToStaticMarkup(
    <DayGrid weeks={[[0, 3, 0, 0, 0, 0, 0]]} scale={SCALE} endsOn={ENDS_ON} label={LABEL} />,
  );

  it('does not print a number for zero while keeping nonzero counts readable', () => {
    expect(markup).not.toContain('>0</span>');
    expect(markup).toContain('>3</span>');
    expect(markup).toContain('background:var(--surface);box-shadow:inset 0 0 0 1px var(--border)');
  });

});

/**
 * The chip is the kit's tooltip, in the type it was measured in (#1028).
 *
 * Read out of the kit and out of the build, never written here as literals.
 * Since #1450 the kit is the board's own copy in `src/ui/kit/`, so "the kit"
 * below means `src/ui/kit/tooltip.tsx` and the regex reads that source.
 * #937 pinned the chip's classes as strings, and a pin like that stays green
 * over an edit that changes the kit's tooltip, or its `text-xs`,
 * while the chip drifts off both. #937 answered #927 with a black chip and a 2px
 * black ring; #1028 struck both. Until 7.4.0 the kit wrote its tooltip's look
 * inline and this spec scraped it out of `dist`; from 7.4.0 the kit exports it
 * as `tooltipSurface`, so the chip is built on that export and this spec reads
 * the same one, plus one look into `dist` to hold that `TooltipContent` still
 * wears it, which is what makes the export the tooltip and not a stray string.
 *
 * That one look is a regex over the kit's built chunk, and three shapes of a
 * kit release that draws the same tooltip will still redden it (#1114's
 * review staged each): a `TooltipContent` no longer wrapped in `forwardRef`,
 * `tooltipSurface` handed to `cn(` in any position but the first, and a
 * definition whose `cn(` sits more than 800 characters past `forwardRef(`.
 * Each fails loudly, with the message below or `toMatch`'s, where the pin it
 * replaced went on passing. When one of them fires, fix the regex, not the
 * chip.
 */
describe('the chip wears the kit’s tooltip (#1028, #1034)', () => {
  /** The kit's `TooltipContent`, up to the `cn(` it hands its classes to. */
  const kitTooltipContent: string = (() => {
    const src: string = readFileSync(new URL('../ui/kit/tooltip.tsx', import.meta.url), 'utf8');
    const found = src.match(/\bTooltipContent = [\w$.]*forwardRef\b[\s\S]{0,800}?\bcn\(\s*[^)]+/);
    if (found) return found[0];
    throw new Error('no TooltipContent in src/ui/kit/tooltip.tsx');
  })();

  /** Of `tooltipSurface`, the width cap and the wrapping the chip replaces with
   *  one line. Written again here rather than imported from `DayGrid`, so the
   *  chip widening what it drops goes red. */
  const WRAPS = /^(max-w-|overflow-|break-)/;
  const surface = tooltipSurface.split(/\s+/);
  const kitLook = surface.filter((c) => !WRAPS.test(c));

  /** The chip's own classes: hand placement, the one line `CHIP_CLEARANCE` is
   *  derived from, and digits that do not jump as a count changes. */
  const CHIP_OWN = ['pointer-events-none', 'absolute', 'z-10', 'w-max', 'whitespace-nowrap', 'tabular-nums'];
  const chip = CHIP_CLASS.split(/\s+/);

  /** Everything vite emitted, which is the only place a Tailwind class is real. */
  const builtCss: string = (() => {
    const dir = new URL('../../dist/assets/', import.meta.url);
    const names: string[] = readdirSync(dir).filter((n: string) => n.endsWith('.css'));
    if (names.length === 0) throw new Error('no CSS under dist/assets — run `pnpm build` first');
    return names.map((n: string) => readFileSync(new URL(n, dir), 'utf8')).join('\n');
  })();
  const selector = (cls: string) => `.${cls.replace(/[^\w-]/g, (ch) => `\\${ch}`)}`;
  const rule = (cls: string) => builtCss.match(new RegExp(`${selector(cls).replace(/[.\\]/g, '\\$&')}\\{([^}]*)\\}`))?.[1];
  /** A length in the built CSS, in px: `.6875rem`, `6px`, or a `var()` fallback. */
  const px = (v: string | undefined) => {
    const m = v?.match(/(?:var\([^,]+,\s*)?([\d.]+)(rem|px)?/);
    if (!m) throw new Error(`no length in ${v}`);
    return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
  };
  const decl = (body: string | undefined, prop: string) => body?.match(new RegExp(`(?:^|;)${prop}:([^;]+)`))?.[1];

  it('reads a real surface out of the kit, and the kit’s tooltip wears it', () => {
    // A `tooltipSurface` that is not what `TooltipContent` draws would pass
    // every loop below while the chip drifts off the board's other tooltips.
    expect(kitLook.length).toBeGreaterThanOrEqual(6);
    expect(surface.length).toBeGreaterThan(kitLook.length);
    expect(kitTooltipContent).toMatch(/\bcn\(\s*tooltipSurface\b/);
  });

  it('carries every class of the kit tooltip’s look, and none of its wrapping', () => {
    for (const cls of kitLook) expect(chip, `the kit tooltip has ${cls} and the chip does not`).toContain(cls);
    for (const cls of surface.filter((c) => WRAPS.test(c))) expect(chip, `${cls} wraps, and the chip is one line`).not.toContain(cls);
  });

  it('adds nothing to it but its own placement and shape', () => {
    // Which is what keeps #937's `bg-fg` from coming back beside it.
    for (const cls of chip) expect([...kitLook, ...CHIP_OWN], `${cls} is neither the kit's nor the chip's own`).toContain(cls);
  });

  it('emits a real rule for every class it names', () => {
    // An off-scale utility emits no CSS and no warning, so the chip would draw
    // without it and every assertion above would still pass.
    for (const cls of chip) expect(rule(cls), `no rule for .${cls} in dist/assets`).toBeDefined();
  });

  it('is one line in the built text-xs, which CHIP_W and CHIP_CLEARANCE were measured in', () => {
    // The sizes the chip was measured at on 2026-09-11: 11px, 1.5 leading, 0.02em
    // tracking, the former UTC sentence widest at 206.77px, 30.5px tall.
    // If the kit moves any of them this goes red, so re-measure `CHIP_W` on the
    // page and update it with these numbers.
    const xs = rule('text-xs');
    const size = px(decl(xs, 'font-size'));
    const leading = Number(decl(xs, 'line-height')?.match(/([\d.]+)\)?$/)?.[1]);
    const tracking = decl(xs, 'letter-spacing')?.match(/([\d.]+em)\)?$/)?.[1];
    expect({ size, leading, tracking }).toEqual({ size: 11, leading: 1.5, tracking: '.02em' });
    // The height is derived rather than read: a line, the padding and the border.
    const height = size * leading + 2 * px(decl(rule('py-1.5'), 'padding-block')) + 2 * px(decl(rule('border'), 'border-width'));
    expect(height).toBe(30.5);
    // Plus the 6px standoff in the chip's transform, rounded up.
    expect(CHIP_CLEARANCE).toBe(Math.ceil(height + 6));
  });

  it('rings the hovered cell 1px in a colour the kit declares in both themes', () => {
    const token = HOVER_CELL.boxShadow.match(/^inset 0 0 0 1px var\((--[\w-]+)\)$/)?.[1];
    expect(token, 'the ring is no longer a 1px inset ring in one token').toBeDefined();
    const kitCss: string = readFileSync(new URL('../../node_modules/@apliteni/apliteni-ui/src/tokens/tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const declaredIn = [...kitCss.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .filter(([, , body]) => new RegExp(`${token}\\s*:`).test(body!))
      .flatMap(([, sel]) => sel!.split(',').map((s) => s.trim()));
    expect(declaredIn).toEqual(expect.arrayContaining([':root[data-theme="dark"]', ':root[data-theme="light"]']));
  });
});

describe('the grid keeps exactly one tab stop, whatever shape it is (#709)', () => {
  // The roving tabindex is initialised once and this component is never
  // remounted, so a stored column outlives a change of shape. Sunday into
  // Monday the running column goes away, 14 becomes 13, and a cursor still on
  // column 13 matched no cell: every button fell to -1 and the grid left the
  // tab order until a reload. Clamping at render is what fixes it, and the
  // suite has no DOM to move a cursor with — so this asserts the property that
  // breaks, on the shape that breaks it.
  const tabStops = (markup: string) => (markup.match(/tabindex="0"/g) ?? []).length;

  it('gives one cell tabindex 0 on a grid with a short last column', () => {
    expect(tabStops(html(13, 5))).toBe(1);
  });

  it('still gives one after the running column goes away on a Monday', () => {
    expect(tabStops(html(13))).toBe(1);
    expect(tabStops(html(12))).toBe(1);
  });
});

describe('the year choice is component state, never a URL param', () => {
  // The hazard, live: the queue's search box below the strip rebuilds the whole
  // query string from viewer state alone on every keystroke, so any param it
  // does not know is gone by the second letter typed (`crew-filter.ts` documents
  // the same trap). This asserts the destruction actually happens, so the guard
  // below is guarding something real.
  it('loses an unknown param when a sibling keystroke re-encodes the URL', () => {
    const search = '?viewer=assigned&q=a&flowType=bug';
    const next = encodeViewer({ ...DEFAULT_VIEWER, ...decodeViewer(search), q: 'ab' });
    expect(next).toContain('q=ab');
    expect(next).not.toContain('flowType');
  });

  // And the guard: FlowStrip holds the choice in component state and reads no
  // URL at all, so that keystroke cannot reach it. Asserted against the source
  // because the test env has no DOM to press a button in, and jsdom is a
  // dependency this lane may not add.
  it('FlowStrip holds the choice in useState and touches no URL', () => {
    const src = flowStripSource;
    expect(src).toMatch(/useState<YearChoice>/);
    for (const forbidden of [/encodeViewer/, /decodeViewer/, /useSearchParams/, /location\.search/, /window\.history/]) {
      expect(src).not.toMatch(forbidden);
    }
  });
});

describe('what the strip says once, and only once (#707)', () => {
  // The chip is state — it renders on hover and on focus, and neither happens
  // under `renderToStaticMarkup`, so its markup is absent whatever the component
  // holds. Asserting on the markup here would pass over a line still shipping.
  // The source is the thing that can fail.
  it('drops the day chip’s attribution line, so the chip is the reading and stops', () => {
    expect(dayGridSource).not.toMatch(/Attributed to whoever/);
  });

  // The counterpart of the vm's `gridFor` test, at the wiring: the component
  // must not cut a scale of its own for a filtered view, or a Bugs-only grid
  // repaints itself across the whole ramp and stops being comparable with All.
  it('paints from the scale it is handed and derives none of its own', () => {
    expect(dayGridSource).not.toMatch(/shadeScale/);
    expect(flowStripSource).toMatch(/scale=\{grid\.scale\}/);
  });

  // The pitch was the grid's one knob on its own proportions and it is gone
  // (#817). Anything placing something off a row height reads the cell's own
  // box, which is the only thing that is still true at 6px and at 19px.
  it('keeps no row pitch to place the chip from', () => {
    expect(dayGridSource).not.toMatch(/ROW_PITCH|GRID_HEIGHT/);
    expect(dayGridSource).toMatch(/cell: el\.offsetHeight/);
  });
});

it('prints nonzero counts while recorded zero cells stay quiet (#904, #927)', () => {
  const markup = renderToStaticMarkup(<DayGrid weeks={[[null, 0, 1, 99, 999]]} scale={SCALE} endsOn={ENDS_ON} label={LABEL} />);
  expect(markup).not.toContain('>0</span>');
  for (const n of [1, 99, 999]) expect(markup).toContain(`>${n}</span>`);
  expect(count(markup, /data-day=/g)).toBe(4);
  expect(markup).toContain('minmax(36px, 1fr)');
  expect(markup).toContain('overflow-x-auto');
});

it.each([[100, 1], [200, 2], [300, 3]])('names the reached flame level at exactly %i closed', (closed, level) => {
  const markup = renderToStaticMarkup(
    <DayGrid weeks={[[closed]]} scale={SCALE} endsOn={ENDS_ON} label={LABEL} dailyGoal={100} level2Goal={200} level3Goal={300} />,
  );
  expect(markup).toContain(`data-flame-level="${level}"`);
  expect(markup).toContain(`aria-label="Sun 23 Aug, ${closed} closed, at or over level ${level} (${closed} closed)"`);
});
