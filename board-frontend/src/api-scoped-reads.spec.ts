/**
 * The three reads an address can narrow (#714), pinned to the URL they ask for.
 *
 * Nothing pinned this before, and nothing could: the fetchers read the org out
 * of `window.location`, the suite runs on node with no window, so the org was
 * always null under test. A reviewer stripped
 * the query from all three and the whole suite stayed green. Threading the org
 * as an argument is what makes the claim testable, and this is the test.
 *
 * `api-project-org.spec.ts` is the same check for `fetchProject`, written for
 * #697; this is its three siblings. Scoped and unscoped are both pinned,
 * because the union sending a byte-identical request is the promise #614 makes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProjectPreview, fetchProjectCatalog, fetchProjects } from './api/projects';
import { fetchRepos, fetchReposHealth } from './api/repos';

/** Answer the next fetch with a body, and hand back the spy so the URL that was
 *  asked for can be read off it. */
function mockOk(body: unknown) {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fn);
  return fn as unknown as ReturnType<typeof vi.fn>;
}

const asked = (fn: ReturnType<typeof vi.fn>): string => String(fn.mock.calls[0][0]);

afterEach(() => vi.unstubAllGlobals());

/** Each narrowable read: what to call it, the path it owns, and a body it will
 *  accept. Written as a table so a fourth one joins every case below at once. */
const READS: [name: string, path: string, call: (org?: string) => Promise<unknown>, body: unknown][] = [
  ['fetchProjectPreview', '/api/projects/preview', (org) => fetchProjectPreview(org), []],
  ['fetchProjectCatalog', '/api/projects/catalog', (org) => fetchProjectCatalog(org), []],
  ['fetchProjects', '/api/projects', (org) => fetchProjects(org), { projects: [] }],
  ['fetchRepos', '/api/repos', (org) => fetchRepos(org), { repos: [], updatedAt: '', driOptions: [] }],
  ['fetchReposHealth', '/api/repos/health', (org) => fetchReposHealth(org), { repos: [] }],
];

describe('a narrowed page asks for a narrowed URL (#714)', () => {
  for (const [name, path, call, body] of READS) {
    it(`${name} carries the org it was given`, async () => {
      const fn = mockOk(body);
      await call('globex');
      expect(asked(fn)).toBe(`${path}?org=globex`);
    });

    it(`${name} encodes an org that needs it, rather than splicing it into the path`, async () => {
      const fn = mockOk(body);
      await call('a b&c');
      expect(asked(fn)).toBe(`${path}?org=a+b%26c`);
    });

    it(`${name} sends no query at all for the union`, async () => {
      const fn = mockOk(body);
      await call();
      expect(asked(fn)).toBe(path);
    });

    it(`${name} treats an empty org as the union rather than as an org named ""`, async () => {
      const fn = mockOk(body);
      await call('');
      expect(asked(fn)).toBe(path);
    });
  }
});
