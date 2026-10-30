import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
// node:fs and not `?raw`: vitest runs `css: false`, which stubs every
// stylesheet import to '', and a contrast check reading '' has no colour to fail on.
// @ts-expect-error node:fs is untyped here; it exists in vitest's node env.
import { readFileSync } from 'node:fs';
import { DayGrid } from './DayGrid';
import { shadeScale, type DayCount } from './flow-strip.vm';

/**
 * Every number the day grid prints, against the fill it is printed on, in both
 * themes (#953) and with each accent (#1450).
 *
 * The ink used to flip at a hand-picked 90% and nothing measured it. On the
 * light board the cells from 87% to 94% printed their number below 4.5:1,
 * worst at 4.18:1 on the flip itself, and no flip point could have fixed that
 * with the kit's inks: `dayCellPaint` in DayGrid.tsx says why. This computes
 * the WCAG ratio for every per cent the ramp can produce, from the kit
 * stylesheet actually installed and app.css as it stands, so a kit bump or a
 * retuned surface that moves the crossing goes red here and names the cell.
 *
 * It reads the rendered markup rather than a copy of the rule, so what it checks
 * is what the component emits.
 */

type Tokens = Record<string, string>;
type Rgb = [number, number, number];
type Sheet = 'kit' | 'accents' | 'app';
type Theme = 'light' | 'dark';
type Accent = 'nebula' | 'phoenix' | 'ocean' | 'emerald';

/** Every innermost block of a stylesheet: its selector list split into members,
 *  and the custom properties it declares. Both stylesheets declare their tokens
 *  in plain blocks, so nothing nested is lost. A comma inside `:is()` splits
 *  wrongly, but only into members that match no layer, which fails below
 *  rather than passing. */
const blocksOf = (css: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)].map(([, sel, body]) => ({
    selectors: sel!.split(',').map((s) => s.trim()),
    tokens: Object.fromEntries([...body!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, n, v]) => [n!, v!.trim()])) as Tokens,
  }));

const BLOCKS: Record<Sheet, ReturnType<typeof blocksOf>> = {
  kit: blocksOf(readFileSync(new URL('../../node_modules/@apliteni/apliteni-ui/src/tokens/tokens.css', import.meta.url), 'utf8')),
  accents: blocksOf(readFileSync(new URL('../../node_modules/@apliteni/apliteni-ui/src/tokens/accents.css', import.meta.url), 'utf8')),
  app: blocksOf(readFileSync(new URL('../app.css', import.meta.url), 'utf8')),
};

// Merged in order of SPECIFICITY, not of source: app.css declares some `:root`
// blocks after its themed blocks, and the themed blocks still win in the browser.
// The board always stamps `data-theme`, so the kit's themed blocks always apply.
// Nebula is the kit's default and stamps no `data-accent`. Every other accent
// adds the kit's and the app's blocks for that theme and accent.
const BASE: Record<Theme, [Sheet, string][]> = {
  dark: [['kit', ':root'], ['kit', ':root[data-theme="dark"]'], ['app', ':root'], ['app', ':root:not([data-theme="light"])']],
  light: [['kit', ':root'], ['kit', ':root[data-theme="light"]'], ['app', ':root'], ['app', '[data-theme="light"]'], ['app', ':root[data-theme="light"]']],
};
const ACCENTS: Accent[] = ['nebula', 'phoenix', 'ocean', 'emerald'];
const layers = (theme: Theme, accent: Accent): [Sheet, string][] => {
  if (accent === 'nebula') return BASE[theme];
  const sel = `:root[data-theme="${theme}"][data-accent="${accent}"]`;
  const [kit, app] = [BASE[theme].filter(([s]) => s === 'kit'), BASE[theme].filter(([s]) => s === 'app')];
  return [...kit, ['accents', sel], ...app, ['app', sel]];
};
const ALL_LAYERS = (['dark', 'light'] as const).flatMap((t) => ACCENTS.flatMap((a) => layers(t, a)));

/** The tokens a theme resolves. A layer no block names throws instead of
 *  dropping out of the merge, because a dropped layer leaves the kit's colour
 *  standing where the page paints its own, and the check passing on it. */
function tokensFor(theme: Theme, accent: Accent): Tokens {
  return Object.assign({}, ...layers(theme, accent).map(([sheet, selector]) => {
    const found = BLOCKS[sheet].filter((b) => b.selectors.includes(selector));
    if (!found.length) throw new Error(`no block in ${sheet} names ${selector}, which ${theme} ${accent} is merged from`);
    return Object.assign({}, ...found.map((b) => b.tokens));
  }));
}

/** Blocks that set one of `names` under a selector no layer merges. The same
 *  failure from the other side: the page may paint from them, and this check
 *  would not know. */
function unmerged(names: Set<string>): string[] {
  return (['kit', 'accents', 'app'] as const).flatMap((sheet) => {
    const merged = new Set(ALL_LAYERS.filter(([s]) => s === sheet).map(([, sel]) => sel));
    return BLOCKS[sheet]
      .filter((b) => Object.keys(b.tokens).some((n) => names.has(n)) && !b.selectors.some((s) => merged.has(s)))
      .map((b) => `${sheet} sets ${Object.keys(b.tokens).filter((n) => names.has(n)).join(', ')} in ${b.selectors.join(', ')}`);
  });
}

/** WCAG AA for normal text. The number is 12px medium, well short of "large". */
const AA = 4.5;

function resolve(tokens: Tokens, value: string, read: Set<string>, seen: string[] = []): string {
  const ref = value.trim().match(/^var\((--[\w-]+)\s*(?:,\s*(.+))?\)$/);
  if (!ref) return value.trim();
  const [, name, fallback] = ref;
  if (seen.includes(name!)) throw new Error(`${[...seen, name].join(' -> ')} is a cycle`);
  read.add(name!);
  const next = tokens[name!] ?? fallback;
  if (next === undefined) throw new Error(`${name} is declared nowhere this check reads`);
  return resolve(tokens, next, read, [...seen, name!]);
}

function rgb(tokens: Tokens, value: string, read: Set<string>): Rgb {
  const hex = resolve(tokens, value, read).toLowerCase();
  const long = /^#[0-9a-f]{3}$/.test(hex) ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
  if (!/^#[0-9a-f]{6}$/.test(long)) throw new Error(`${value} resolves to ${hex}, which this check cannot read as a colour`);
  return [1, 3, 5].map((i) => parseInt(long.slice(i, i + 2), 16)) as Rgb;
}

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
/** `color-mix(in srgb, a p%, b)` is a straight blend of the encoded channels.
 *  Rounded to the 8 bits the screen paints, since that is the colour read. */
const mixSrgb = (a: Rgb, b: Rgb, pct: number) =>
  a.map((c, i) => Math.round((c * pct + b[i]! * (100 - pct)) / 100)) as Rgb;

// Include a positive count that rounds to 0%, then every whole fill percentage.
const SCALE = shadeScale([10_000]);
const FLOOR = 0;
const CEILING = 100;
const counts = [1, ...Array.from({ length: 100 }, (_, i) => (i + 1) * 100)];
const weeks: DayCount[][] = [];
for (let i = 0; i < counts.length; i += 7) weeks.push(counts.slice(i, i + 7));
const MARKUP = renderToStaticMarkup(
  <DayGrid weeks={weeks} scale={SCALE} endsOn={Date.UTC(2026, 7, 23)} label="Issues closed" />,
);

// The ink is a step: the deep ink from `--day-ink-flip` up, the pale ink below.
const CELL = new RegExp(
  String.raw`background:color-mix\(in srgb, var\((--[\w-]+)\) (\d+)%, var\((--[\w-]+)\)\);` +
  String.raw`color:color-mix\(in srgb, var\((--[\w-]+)\) clamp\(0%, calc\(\((\d+) - var\((--[\w-]+)\) \+ 1\) \* 100%\), 100%\), var\((--[\w-]+)\)\)`,
  'g',
);
const cells = [...MARKUP.matchAll(CELL)].map(([, brand, pct, surface, deep, inkPct, flip, pale]) => ({
  brand: brand!, pct: Number(pct), surface: surface!, deep: deep!, inkPct: Number(inkPct), flip: flip!, pale: pale!,
}));

describe('every day-grid number is readable against its fill (#953)', () => {
  it('draws one cell for every per cent the ramp can produce', () => {
    // Not vacuous: a change to the fill's markup that this pattern stops
    // matching leaves nothing to measure, and that has to fail here.
    expect(FLOOR).toBe(0);
    expect(CEILING).toBe(100);
    expect(cells.map((c) => c.pct).sort((a, b) => a - b)).toEqual(
      Array.from({ length: CEILING - FLOOR + 1 }, (_, i) => FLOOR + i),
    );
    expect(cells.every((c) => c.inkPct === c.pct)).toBe(true);
  });

  for (const theme of ['light', 'dark'] as const) {
    for (const accent of ACCENTS) {
      it(`clears ${AA}:1 at every fill in ${theme} ${accent}`, () => {
        // Each case stands on its own: over an empty list nothing is below 4.5:1.
        expect(cells).toHaveLength(101);
        const t = tokensFor(theme, accent);
        const read = new Set<string>();
        const below = cells.flatMap(({ brand, pct, surface, deep, flip, pale }) => {
          const at = Number(resolve(t, `var(${flip})`, read));
          if (!Number.isInteger(at)) throw new Error(`${flip} is not a whole number in ${theme} ${accent}`);
          const ink = pct >= at ? deep : pale;
          const fill = mixSrgb(rgb(t, `var(${brand})`, read), rgb(t, `var(${surface})`, read), pct);
          const ratio = contrast(fill, rgb(t, `var(${ink})`, read));
          return ratio < AA ? [`${pct}% in ${ink}: ${ratio.toFixed(2)}:1`] : [];
        });
        expect(unmerged(read)).toEqual([]);
        expect(below).toEqual([]);
      });
    }
  }
});
