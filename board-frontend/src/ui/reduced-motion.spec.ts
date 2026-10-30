/**
 * Nothing on the board may pulse at a reader who asked for less motion (#1044).
 *
 * The kit has a reduced-motion block and it does not reach `animate-pulse`.
 * Tailwind v4 compiles that utility to `animation: var(--animate-pulse)`, and
 * `--animate-pulse` is the whole shorthand, `pulse 2s ... infinite`, so the
 * duration is written into the declaration itself. The kit zeroes
 * `--tw-animation-duration` and the `--motion-duration-*` tokens; the shorthand
 * reads neither, and nothing anywhere goes red. `LoadingStructure.tsx` carries
 * the workaround, one class.
 *
 * So this is the guard over the CALLERS, and it holds two things that a browser
 * cannot hold cheaply and the rest of this suite cannot hold at all:
 *
 *  1. The trap is still live in the board's kit copy and its stylesheet. If a
 *     change ever fixes it there, this goes red and says to delete the
 *     workaround rather than carrying two rules that say the same thing.
 *  2. Every production source that reaches the kit's `Skeleton` states what it
 *     does under reduced motion, instead of inheriting a pulse by accident.
 *
 * This reads class strings, not pixels, because the suite has no DOM. That a
 * paused reader really stops is measured in a browser, not here: see #1033.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error node:fs is untyped here; it exists in vitest's node env.
import { readFileSync } from 'node:fs';
import { PULSE_UNLESS_REDUCED } from './LoadingStructure';

/** The board's stylesheet, which carries the reduced-motion block, and its copy of the kit `Skeleton` (#1450). */
const kitCss: string = readFileSync(new URL('../app.css', import.meta.url), 'utf8');
const kitJs: string = readFileSync(new URL('./kit/skeleton.tsx', import.meta.url), 'utf8');

/** Tailwind's own theme, where `--animate-pulse` is declared. */
const tailwindCss: string = readFileSync(
  new URL('../../node_modules/tailwindcss/theme.css', import.meta.url),
  'utf8',
);

/** Every source in the package, minus the specs. */
const SOURCES = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const production = Object.entries(SOURCES).filter(([p]) => !/\.spec\.tsx?$/.test(p));

/** Only the `@media (prefers-reduced-motion: reduce)` bodies of the sheet. */
function reducedMotionBlocks(css: string): string {
  const out: string[] = [];
  const at = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/g;
  for (let m = at.exec(css); m; m = at.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const from = i;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(css.slice(from, i - 1));
  }
  return out.join('\n');
}

describe('the kit cannot stop a pulse, so board does (#1044)', () => {
  // A file read that found nothing passes every assertion after it.
  it('reads the kit copy, the stylesheet, Tailwind and the package sources', () => {
    expect(kitCss).toContain('prefers-reduced-motion');
    expect(kitJs).toContain('animate-pulse');
    expect(tailwindCss).toContain('--animate-pulse:');
    expect(production.length).toBeGreaterThan(20);
  });

  it('the kit ships the pulse it cannot stop: `Skeleton` pulses by default', () => {
    // Not a copy of the kit's class list — the assertion is that `animate-pulse`
    // is in the base classes `Skeleton` hands out with no `className` at all.
    const base = kitJs.match(/cn\(\s*['"]([^'"]*animate-pulse[^'"]*)['"]\s*,\s*className/)?.[1];
    expect(base, 'the kit no longer builds Skeleton from a literal base class list').toBeTruthy();
    expect(base).toContain('animate-pulse');
  });

  it('Tailwind writes the duration into the shorthand, where a token cannot reach it', () => {
    const shorthand = tailwindCss.match(/--animate-pulse:\s*([^;]+);/)?.[1]?.trim();
    expect(shorthand).toMatch(/^pulse\s+\d+(\.\d+)?s\b/);
    // The one thing that would make board's workaround unnecessary: a duration
    // read out of a variable the kit already zeroes.
    expect(shorthand).not.toContain('--tw-animation-duration');
    expect(shorthand).not.toContain('--motion-duration');
  });

  it('the kit\'s reduced-motion block still stops nothing named `pulse`', () => {
    const reduced = reducedMotionBlocks(kitCss);
    expect(reduced).toContain('--tw-animation-duration');
    // If the kit ever adds one of these, delete `PULSE_UNLESS_REDUCED` and this
    // file rather than keeping two rules that say the same thing.
    // The sheet stops named animations such as `.goal-flame` one by one. Only a
    // rule on every element, or on the pulse itself, would stop a placeholder.
    const reach = [...reduced.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, sel]) => /\*|animate-pulse/.test(sel)).map(([, , body]) => body).join('\n');
    expect(reach).not.toMatch(/animation(-name)?\s*:\s*none/);
    expect(reduced).not.toContain('--animate-pulse');
  });

  it('`Placeholder` is the only thing in the app that renders the kit `Skeleton`', () => {
    // The rule is ONE call site, not "every call site remembers the class". The
    // weaker rule does not hold: a file that merely IMPORTS `PULSE_UNLESS_REDUCED`
    // and then drops it from the class list passes a check that looks for the
    // name anywhere in the source, which is how this spec first read.
    const renders = production.filter(([, src]) => /<\s*Skeleton\b/.test(src)).map(([p]) => p);
    expect(renders).toEqual(['./LoadingStructure.tsx']);
    // And nothing else even reaches the import, so a second `Placeholder` cannot
    // be written beside the first with its own idea about motion.
    const imports = production
      .filter(([, src]) => /import\s*\{[^}]*\bSkeleton\b[^}]*\}\s*from\s*'\.\/kit'/.test(src))
      .map(([p]) => p);
    expect(imports).toEqual(['./LoadingStructure.tsx']);
  });

  it('that one call site states the motion on every path through it', () => {
    const src = SOURCES['./LoadingStructure.tsx'];
    expect(src, 'the one call site moved; point this spec at it').toBeTruthy();
    const call = src.match(/<Skeleton\b[^>]*\/>/)?.[0];
    expect(call).toBeTruthy();
    // Both branches named in the one class list: pulsing, or explicitly still.
    expect(call).toContain('PULSE_UNLESS_REDUCED');
    expect(call).toContain("'!animate-none'");
    expect(PULSE_UNLESS_REDUCED).toBe('motion-reduce:animate-none');
  });

  it('nobody writes the pulse or its stop by hand', () => {
    // `animate-pulse` inline would be a placeholder outside `Placeholder`, and
    // `motion-reduce:animate-none` spelled out is a second copy of the constant.
    const inline = production
      .filter(([p]) => p !== './LoadingStructure.tsx' && p !== './kit/skeleton.tsx')
      .filter(([, src]) => /className[^\n]*\banimate-pulse\b/.test(src)
        || /'motion-reduce:animate-none'|"motion-reduce:animate-none"/.test(src)
        || /'!animate-none'|"!animate-none"/.test(src))
      .map(([p]) => p);
    expect(inline).toEqual([]);
  });
});
