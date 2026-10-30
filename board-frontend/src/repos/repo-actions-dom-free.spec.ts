/**
 * The gate behind `repo-actions.ts`'s DOM-free promise (#606).
 *
 * That module injects its effects — open a tab, navigate, copy — rather than
 * importing them, so the action list and every handler can be unit-tested in a
 * suite with no DOM (`vitest.config.ts` sets `environment: 'node'`). Until now
 * only the file's own header said so, and the rule is one keyword deep: the
 * import of `MenuAction` from `../ui/ActionMenu` is `import type`, and dropping
 * that one word pulls React, Radix and `../icons` in at import time with nothing
 * to stop it.
 *
 * So the promise is checked here instead of asserted in prose, in two halves.
 *
 * Statically, the module's transitive VALUE imports must reach no React and no
 * component package — type-only imports are erased before anything runs, so
 * they cannot drag a dependency in. This is the half the `type` keyword guards.
 *
 * At runtime, importing the module in this DOM-less environment must simply
 * work. That is the stronger half and it needs no source scanning: if anything
 * in the graph touched `window` or `document` while being evaluated, the import
 * would throw here, because in `environment: 'node'` there is no such global.
 *
 * What is deliberately NOT asserted is that no file in the graph mentions the
 * DOM anywhere. `route.ts` is in the graph for `routePath`, which is pure, and
 * also holds `gotoPath`, which drives `window.history` inside a function body.
 * That is correct and is the whole point of injecting effects: the DOM-using
 * function is never called from here, and a check that banned its presence
 * would be banning the file rather than the coupling.
 *
 * Sources come from Vite's raw glob rather than `node:fs`: this package carries
 * no `@types/node`, and a gate is not worth a dependency.
 */
import { describe, expect, it } from 'vitest';
import { repoActionItems } from './repo-actions';

/** Every source file in the app, as text, keyed by its path from the root. */
const SOURCES = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const ENTRY = '/src/repos/repo-actions.ts';

/** Packages that mean a DOM, directly or by rendering into one. */
const FORBIDDEN_PACKAGES = [/^react$/, /^react-dom/, /^@radix-ui/, /^@globex\//, /^react-markdown$/];

/** Every `from '...'` that survives to runtime. `import type { X } from` is
 *  erased wholesale, so it is skipped; an inline `{ type X }` inside a value
 *  import is NOT skipped, which errs toward reporting more than really loads. */
function valueImports(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(re)) {
    if (/^type\b/.test(m[1].trim())) continue; // `import type { … } from` — erased
    out.push(m[2]);
  }
  return out;
}

/** Resolve a relative specifier against a `/src/...` key, the way Vite does. */
function resolveLocal(fromKey: string, spec: string): string | null {
  const segments = fromKey.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  const base = segments.join('/');
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (candidate in SOURCES) return candidate;
  }
  return null;
}

/** The transitive value-import graph: every local file reached, and every bare
 *  package specifier reached along the way. */
function graphFrom(entry: string): { files: string[]; packages: string[] } {
  const files: string[] = [];
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);

    for (const spec of valueImports(SOURCES[file])) {
      if (spec.startsWith('.')) {
        const next = resolveLocal(file, spec);
        expect(next, `unresolved import ${spec} from ${file}`).not.toBeNull();
        queue.push(next!);
      } else {
        packages.add(spec);
      }
    }
  }
  return { files, packages: [...packages].sort() };
}

describe('repo-actions stays DOM-free (#606)', () => {
  it('reaches no React and no component package, transitively', () => {
    // The glob resolved and the entry is in it — without this the walk below
    // could be traversing an empty map and asserting nothing at all.
    expect(Object.keys(SOURCES).length, 'the raw glob found the app').toBeGreaterThan(50);
    expect(SOURCES[ENTRY], 'the entry is readable').toContain('repoActionItems');

    const { files, packages } = graphFrom(ENTRY);
    expect(files.length, 'the walk reached the entry and its imports').toBeGreaterThan(1);
    expect(files).toContain(ENTRY);

    for (const pkg of packages) {
      for (const banned of FORBIDDEN_PACKAGES) {
        expect(banned.test(pkg), `${pkg} is reachable from repo-actions.ts`).toBe(false);
      }
    }
  });

  it('imports and builds its list with no DOM in the room at all', () => {
    // The environment first, so this cannot pass by accident in a suite that
    // grew a DOM: with `window` defined, importing a DOM-touching module would
    // succeed and prove nothing.
    expect(globalThis.window, 'the suite has no DOM').toBeUndefined();
    expect(globalThis.document, 'the suite has no DOM').toBeUndefined();

    const items = repoActionItems(
      { key: 'board', full: 'acme/board.example.com', htmlUrl: 'https://github.com/acme/board.example.com' },
      { openExternal: () => {}, goto: () => {}, copy: () => {} },
      { queue: true },
    );
    expect(items.map((i) => i.key)).toEqual(['open-queue', 'open-github', 'copy-link', 'copy-reference']);
    // …and every handler runs without one either.
    for (const item of items) expect(() => item.run()).not.toThrow();
  });

  it('would notice: ActionMenu, one hop away, is exactly what the type keyword holds back', () => {
    // The mutation this gate exists for, pinned as a fact rather than left to a
    // reviewer's memory. `../ui/ActionMenu` is imported for `MenuAction` alone,
    // and it is a component: were that import a value import, the graph above
    // would reach React through it.
    expect(SOURCES[ENTRY]).toMatch(/import type \{[^}]*MenuAction[^}]*\} from '\.\.\/ui\/ActionMenu'/);

    const menu = resolveLocal(ENTRY, '../ui/ActionMenu');
    expect(menu, 'ActionMenu resolves').not.toBeNull();
    expect(graphFrom(menu!).packages).toContain('react');
  });
});
