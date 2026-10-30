/** Pages read through the query layer; legacy payload APIs remain only for migration tests and saved-copy policy. */
import { describe, expect, it } from 'vitest';
// @ts-expect-error node:fs is untyped here; it exists in vitest's node env.
import { readdirSync, readFileSync, statSync } from 'node:fs';

/** `src/`, as a path. Through the URL the way every other source-reading spec
 *  in this suite does it, so the walk starts from this file rather than from
 *  whatever directory vitest was launched in. */
const SRC: string = new URL('..', import.meta.url).pathname;

/** Every `.ts`/`.tsx` file under `src/` that ships, which is every one that is
 *  not a spec and not this file's own directory. */
function shipped(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = `${dir}/${name}`;
    if (statSync(path).isDirectory()) {
      if (name !== 'cache') shipped(path, found);
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.spec\.tsx?$/.test(name)) continue;
    found.push(path);
  }
  return found;
}

/** The file with its comments taken out, so a docblock that mentions the raw
 *  read by name — several do, and should — is not read as a call to it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('what a page may read the cache through', () => {
  it('finds files to check at all, so a broken walk cannot pass by finding none', () => {
    const files = shipped(SRC);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('/repos/ReposPage.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('/team/TeamView.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('/projects/ProjectsView.tsx'))).toBe(true);
  });

  it('never uses the legacy payload reader or writer outside the cache itself', () => {
    const offenders = shipped(SRC)
      .filter((path: string) => /\b(?:readPayload|seedPayload|writePayload|useCachedState)\b/.test(code(readFileSync(path, 'utf8'))))
      .map((path: string) => path.slice(SRC.length));
    expect(
      offenders,
      'page reads belong in useBoardRead, whose persistence and revalidation are the defaults',
    ).toEqual([]);
  });

  it('catches the thing it is looking for, so its emptiness means something', () => {
    expect(/\b(?:readPayload|seedPayload|writePayload|useCachedState)\b/.test(code('const held = readPayload<X>(k);'))).toBe(true);
    expect(/\b(?:readPayload|seedPayload|writePayload|useCachedState)\b/.test(code('/** readPayload is the raw read. */'))).toBe(false);
    expect(/\b(?:readPayload|seedPayload|writePayload|useCachedState)\b/.test(code('// seeded, not readPayload'))).toBe(false);
  });
});
