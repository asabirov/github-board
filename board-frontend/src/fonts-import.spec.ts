import { describe, expect, it } from 'vitest';
// The package carries no node types, so every spec reaching the filesystem says
// so the same way — see `App.spec.ts` and `head.spec.ts`, which read the same
// bytes for the same reason.
// @ts-expect-error node:fs is untyped here; it exists in vitest's node env.
import { readFileSync } from 'node:fs';
// @ts-expect-error node:path is untyped here; it exists in vitest's node env.
import { dirname, resolve } from 'node:path';
// @ts-expect-error node:url is untyped here; it exists in vitest's node env.
import { fileURLToPath } from 'node:url';

/**
 * The fonts import, which the build cannot guard (#794 review).
 *
 * The build is a real guard for HALF of it: a wrong specifier is a resolution error, so
 * `pnpm build` cannot succeed with the line wrong. An ABSENT line resolves to
 * nothing at all — the build is green, `pnpm test` is green, and both browser
 * guards are green, with every surface in a system fallback. That half had no
 * guard, and this is it.
 *
 * It reads the source rather than the module graph because the failure mode is
 * a line nobody wrote: importing `main.tsx` here would need a DOM and would
 * prove only that the file it did import was the one it imported.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = readFileSync(resolve(HERE, 'main.tsx'), 'utf8');
/** The import statements alone, so a name in a comment does not count. */
const IMPORTS = MAIN.split('\n').filter((l: string) => /^import /.test(l)).join('\n');

describe('main.tsx font faces', () => {
  it('imports the IBM Plex Sans faces, because the kit tokens name the family and ship no face', () => {
    for (const weight of [400, 500, 600, 700]) {
      expect(IMPORTS).toMatch(new RegExp(`^import ['"]@fontsource/ibm-plex-sans/${weight}\\.css['"];$`, 'm'));
    }
  });

  it('imports the kit tokens before app.css, so the board rules win the specificity tie', () => {
    const tokens = IMPORTS.indexOf("'@apliteni/apliteni-ui/tokens'");
    const accents = IMPORTS.indexOf("'@apliteni/apliteni-ui/accents'");
    const app = IMPORTS.indexOf("'./app.css'");
    expect(tokens).toBeGreaterThanOrEqual(0);
    expect(accents).toBeGreaterThan(tokens);
    expect(app).toBeGreaterThan(accents);
  });

  it('references nothing under the deleted public/fonts/ directory', () => {
    expect(IMPORTS).not.toMatch(/\/fonts\/[\w-]+\.woff2/);
  });
});
