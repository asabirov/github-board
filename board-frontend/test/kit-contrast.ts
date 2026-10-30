/**
 * The colours the board PAINTS, and the WCAG ratio between two of them (#763).
 *
 * Two stylesheets, layered the way the browser layers them: `@apliteni/apliteni-ui`'s
 * shipped tokens, then `src/app.css`'s per-theme overrides of them. The kit
 * alone is not what a reader sees: until #1450 `app.css` gave a light card
 * `#ffffff` against the old kit's `#f2f3f4`, and the withheld ring's rule over
 * it read 6.19:1 by the kit and 6.87:1 on the page. So a figure read off the
 * kit alone can be about a colour the board never paints.
 *
 * Read off DISK, not through an import: vitest's `css: false` stubs every CSS
 * import to the empty string — the route `App.spec.ts` takes — and a guard
 * reading '' would pass while proving nothing. A file that stops declaring the
 * block it is read for throws in `declared`.
 *
 * OUTSIDE `src/`, because it is test-only and until #763 only a comment said so:
 * its exports autocomplete into an app module, and such an import survives
 * `tsc -b` and `vite build` and breaks in a browser, which reads no files. It
 * had also joined the sweeps that take every non-`.spec.` module under `src/`
 * for an app surface. `tsconfig.json` includes this directory, so CI typechecks
 * it; it throws rather than calling `expect`, so it needs no test runner either.
 */
// The package carries no node types, hence both of these; they exist in
// vitest's node env, which is the only place this module runs.
// @ts-expect-error node:fs is untyped here.
import { readFileSync } from 'node:fs';
// @ts-expect-error node:module is untyped here, for the same reason.
import { createRequire } from 'node:module';

const KIT_CSS: string = readFileSync(createRequire(import.meta.url).resolve('@apliteni/apliteni-ui/tokens'), 'utf8');
const APP_CSS: string = readFileSync(new URL('../src/app.css', import.meta.url), 'utf8');

/** The two themes the board ships, so a caller loops over one list rather than
 *  spelling out which CSS selector each one is. */
export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];

/** Where a theme's tokens come from, in cascade order — last wins. The board's
 *  selectors tie with the kit's on specificity (`:root[data-theme="light"]` and
 *  `:root:not([data-theme="light"])`) and `main.tsx` loads `app.css` last, so
 *  laying the second block over the first is what the browser does. */
const CASCADE: Record<Theme, { css: string; file: string; selector: string }[]> = {
  dark: [
    { css: KIT_CSS, file: '@apliteni/apliteni-ui', selector: ':root[data-theme="dark"]' },
    { css: APP_CSS, file: 'src/app.css', selector: ':root:not([data-theme="light"])' },
  ],
  light: [
    { css: KIT_CSS, file: '@apliteni/apliteni-ui', selector: ':root[data-theme="light"]' },
    { css: APP_CSS, file: 'src/app.css', selector: ':root[data-theme="light"]' },
  ],
};

/** Every hex colour or token alias one selector's blocks declare, lowercased. Throws
 *  when no block is left: a stylesheet that stopped declaring what it is being
 *  read for would otherwise resolve to the layer underneath it, silently. */
function declared(css: string, file: string, selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  let found = false;
  // Every block under the selector, in source order: app.css splits a theme
  // over several blocks, and a later one wins in the browser as it does here.
  for (let at = css.indexOf(`${selector} {`); at >= 0; at = css.indexOf(`${selector} {`, at + 1)) {
    if (at > 0 && !/\s/.test(css[at - 1])) continue;
    found = true;
    const block = css.slice(at, css.indexOf('}', at));
    for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6}|var\(--[\w-]+\))/gi)) out[m[1]] = m[2].toLowerCase();
  }
  if (!found) throw new Error(`${file} no longer declares ${selector}`);
  return out;
}

/** A theme's tokens as the page resolves them. */
export function themeTokens(theme: Theme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of CASCADE[theme]) Object.assign(out, declared(layer.css, layer.file, layer.selector));
  const resolve = (name: string, seen: string[] = []): string => {
    if (seen.includes(name)) throw new Error(`Colour token cycle: ${[...seen, name].join(' -> ')}`);
    const value = out[name];
    if (!value) throw new Error(`Missing colour token: ${name}`);
    const alias = value.match(/^var\((--[\w-]+)\)$/);
    return alias ? resolve(alias[1], [...seen, name]) : value;
  };
  // The kit also declares `rgba()` and `color-mix()` values, which `declared`
  // does not read. A token that aliases one of them has no hex here, so it is
  // left out, and a caller that needs it gets no colour rather than a wrong one.
  const hexOnly = (name: string): boolean => {
    try {
      resolve(name);
      return true;
    } catch (e) {
      if (String(e).includes('Missing colour token')) return false;
      throw e;
    }
  };
  return Object.fromEntries(Object.keys(out).filter(hexOnly).map((name) => [name, resolve(name)]));
}

export type RGB = [number, number, number];

/** `#rrggbb` as three channels. Six-digit hex only, which is all either file
 *  declares. */
export const rgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;

/** Relative luminance, WCAG 2.1. */
const luminance = ([r, g, b]: RGB): number => {
  const f = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

/** Contrast ratio, WCAG 2.1 — order-independent, 1:1 to 21:1. */
export const contrast = (a: RGB, b: RGB): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
