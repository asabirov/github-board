/**
 * The one app rail caps at the design system's container, not at a number (#783).
 *
 * It was `max-w-[1180px]` — 260px under the `--grid-container-max` token
 * that `app.css` declares — so a window wide enough to draw a sixth board column spent
 * the room on margin instead. The cap is that token now, and these read the two
 * ways that can go quietly wrong.
 *
 * The first is `README.md`'s silent nothing under Frontend styling: a Tailwind
 * class off the preset's scales emits NO CSS, no warning, no error, and the page
 * simply draws uncapped. So the assertion is not that the constant reads well —
 * it is that the class the constant names has a rule in the stylesheet vite
 * actually built. That check needs `pnpm build` to have run, which `pnpm test`
 * requires anyway (CONTRIBUTING.md).
 *
 * The second is the fallback. `var(--grid-container-max, 1440px)` writes 1440
 * down a second time, and a second copy of a number is a thing to keep in step.
 * It is kept in step here rather than by hand: the fallback is compared with the
 * value `app.css` declares at `:root` (#1450 moved it there from the old kit sheet).
 *
 * The third is why the rail is written longhand at all. `PageHeading.tsx` used to
 * say there was no `maxWidth` scale, which is false — there is one, under
 * `theme.extend`, and #807 read only `theme` and did not find it. The reason for
 * the longhand is the fallback, so the claim that `max-w-container` exists is
 * read out of `tailwind.config.ts` here rather than left in a comment to rot.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error node:fs is untyped here; it exists in vitest's node env.
import { readFileSync, readdirSync } from 'node:fs';
import tailwindConfig from '../../tailwind.config';
import { PAGE_RAIL, PAGE_WELL } from './PageHeading';

/** The board's stylesheet, where the container token is declared. */
const sheetCss: string = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

/** Everything vite emitted — the only place a Tailwind class is real. */
const builtCss: string = (() => {
  const dir = new URL('../../dist/assets/', import.meta.url);
  const names: string[] = readdirSync(dir).filter((n: string) => n.endsWith('.css'));
  if (names.length === 0) throw new Error('no CSS under dist/assets — run `pnpm build` first');
  return names.map((n: string) => readFileSync(new URL(n, dir), 'utf8')).join('\n');
})();

/** Every source in the package, for the two harnesses that mirror the rail. */
const SOURCES = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const production = Object.entries(SOURCES).filter(([p]) => !/\.spec\.tsx?$/.test(p));

/** The rail's width cap, as the class list writes it. */
const cap = PAGE_RAIL.split(/\s+/).find((c) => c.startsWith('max-w-'));

/** A Tailwind class as it appears in a selector — every non-word run escaped. */
const selector = (cls: string) => `.${cls.replace(/[^\w-]/g, (ch) => `\\${ch}`)}`;

describe('the page rail is capped by the container token, not by a number (#783)', () => {
  // A source scan and a file read that found nothing pass everything after them.
  it('reads the stylesheet, the build and the package sources', () => {
    expect(sheetCss).toContain('--grid-container-max');
    expect(builtCss).toContain('.mx-auto{');
    expect(production.length).toBeGreaterThan(20);
  });

  it('names the container token and no width of its own', () => {
    expect(cap).toBe('max-w-[var(--grid-container-max,1440px)]');
    // The old cap, and any successor spelled as a bare measurement.
    expect(PAGE_RAIL).not.toMatch(/max-w-\[\d/);
  });

  it('falls back to exactly what the stylesheet declares', () => {
    const fallback = cap?.match(/--grid-container-max,\s*([^)\]]+)/)?.[1];
    const declared = sheetCss.match(/--grid-container-max:\s*([^;]+);/)?.[1]?.trim();
    expect(declared).toBe('1440px');
    expect(fallback).toBe(declared);
  });

  it('emits a real rule — an off-scale utility would emit nothing at all', () => {
    expect(builtCss).toContain(`${selector(cap!)}{max-width:var(--grid-container-max,1440px)}`);
  });

  // The config DOES carry the shorthand; the longhand above is for the fallback, not
  // for a class that is missing. Read one level down from where #807 looked: the
  // config puts an addition under `theme.extend`, so `theme.maxWidth` being absent
  // says nothing about whether the scale is there.
  it('the shorthand exists — the rail is written longhand for the fallback, not for a gap', () => {
    const extended = tailwindConfig.theme.extend.maxWidth;
    expect(extended.container).toBe('1440px');
    // And it reaches the build: the class the comment names emits a literal, not
    // the token, which is the difference between it and the rail's own cap.
    expect(builtCss).toContain('.max-w-container{max-width:1440px}');
  });

  // The dev-only variant page draws its columns at the rail's width, so a shot is
  // what the board page really gives a card. It moved with the rail in #783 and is
  // written in the same token, so the next move carries it too. `ring-preview.tsx`
  // was the other one and #786 deleted it; the sweep below is what would notice a
  // third arriving with the old number pasted into it.
  it('the preview harness is written in the same token as the rail', () => {
    expect(SOURCES['../vouch-preview.tsx']).toContain('w-[var(--grid-container-max,1440px)]');
    const stale = production.filter(([, src]) => /\bw-\[1180px\]/.test(src)).map(([p]) => p);
    expect(stale).toEqual([]);
  });
});

/**
 * The Repos page draws in the whole well, not in the rail (#819).
 *
 * Artur read the board in a browser on 2026-09-02 and said `/repos` was too
 * narrow. `scripts/repos-well-width.mjs` is the reading behind that: at a 1920px
 * window the well is 1672px, the page was 1440px, and the 232px difference sat
 * as 116px of empty margin on each side while the tile grid drew five across.
 *
 * So the page takes `PAGE_WELL` instead. These pin the three ways that can go
 * wrong quietly: a cap creeping back onto the constant, the gutter going with
 * the cap, and the page root drifting back onto the rail with the constant left
 * exported and unused.
 */
describe('the Repos page fills the well it is given (#819)', () => {
  it('is the rail without the cap, and without the mx-auto that centred it', () => {
    expect(PAGE_WELL).not.toMatch(/max-w-/);
    // `mx-auto` on a full-width column is inert, and an inert class is a reader
    // wondering what centres what.
    expect(PAGE_WELL).not.toMatch(/\bmx-auto\b/);
  });

  // The gutter is the thing the kit's own `PageColumn width="full"` would have
  // lost — it is `grid grid-cols-1 gap-5` and nothing else, because `AppShell`
  // spells the inset once and board does not use `AppShell` (src/App.tsx).
  it('keeps the rail’s gutter — the tiles do not go flush to the window edge', () => {
    const gutter = (cls: string) => cls.split(/\s+/).filter((c) => /(^|:)px-/.test(c));
    expect(gutter(PAGE_WELL)).toEqual(['px-6', 'max-[900px]:px-3']);
    expect(gutter(PAGE_RAIL)).toEqual(gutter(PAGE_WELL));
  });

  // Same silent nothing as the rail's own cap: an off-scale utility emits no CSS
  // and no warning, and the page draws with no gutter at all.
  it('emits real rules for every class it names', () => {
    expect(PAGE_WELL.split(/\s+/)).toEqual(['w-full', 'px-6', 'max-[900px]:px-3']);
    expect(builtCss).toContain('.w-full{width:100%}');
    expect(builtCss).toContain('.px-6{padding-inline:24px}');
    expect(builtCss).toContain(`${selector('max-[900px]:px-3')}{padding-inline:12px}`);
  });

  // Read out of the source rather than out of the constant: `ROOT` is a template
  // string, and both spellings would render a class list that looks plausible.
  it('the Repos page root is built from the well and not from the rail', () => {
    const src = SOURCES['../repos/ReposPage.tsx'];
    expect(src).toMatch(/^const ROOT = `\$\{PAGE_WELL\} /m);
    expect(src).not.toMatch(/\bPAGE_RAIL\b/);
  });
});
