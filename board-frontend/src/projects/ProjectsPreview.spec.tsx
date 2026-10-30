import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectsPreviewCard, answerFor, rememberScope } from './ProjectsPreview';
// Vite's `?raw`, the rule `PageCrumb.spec.ts` states: this package carries no
// node types.
import source from './ProjectsPreview.tsx?raw';

afterEach(() => vi.unstubAllGlobals());

describe('Projects catalog preview', () => {
  it('links names by organization and number without inventing progress or weekly counts', () => {
    vi.stubGlobal('window', { location: { pathname: '/alpha/team', search: '' } });
    const html = renderToStaticMarkup(<ProjectsPreviewCard projects={[
      { id: 'A', org: 'alpha', number: 7, title: 'Private Alpha' },
      { id: 'B', org: 'beta', number: 7, title: 'Private Beta' },
    ]} />);
    expect(html).toContain('href="/alpha/projects/7"');
    expect(html).toContain('href="/beta/projects/7"');
    expect(html).toContain('Private Alpha');
    expect(html).toContain('Private Beta');
    expect(html).toContain('Loading completion and weekly activity');
    expect(html).not.toContain('%');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('Nothing opened');
    expect(html).not.toContain('0 closed');
  });

  it('does not call an empty or unavailable catalog an empty Projects rollup', () => {
    const html = renderToStaticMarkup(<ProjectsPreviewCard projects={[]} />);
    expect(html).toContain('Loading completion and weekly activity');
    expect(html).not.toContain('No projects');
    expect(html).not.toContain('0 projects');
  });

  /**
   * #1395. A bare 503 on the rollup keeps this preview now, because it is not a
   * refusal. The names stay, and the note under them has to stop saying that
   * something is loading: the completion those names are waiting for is not
   * coming until a later read succeeds.
   */
  it('says the completion could not be read once the rollup has failed', () => {
    const html = renderToStaticMarkup(<ProjectsPreviewCard failed projects={[
      { id: 'A', org: 'alpha', number: 7, title: 'Private Alpha' },
    ]} />);
    expect(html).toContain('Private Alpha');
    expect(html).toContain('Couldn’t load completion');
    expect(html).not.toContain('Loading completion and weekly activity');
  });

  // #911 review, R2. The union puts two owners in one column and both can spell
  // the same title, so the OWNER goes in the anchor's own text — which is the
  // link's accessible name as well as what a reader sees.
  it('names the owner when two of them are on the list, so no two links read alike', () => {
    vi.stubGlobal('window', { location: { pathname: '/team', search: '' } });
    const html = renderToStaticMarkup(<ProjectsPreviewCard projects={[
      { id: 'A', org: 'acme', number: 7, title: 'Shared Roadmap' },
      { id: 'B', org: 'globex', number: 7, title: 'Shared Roadmap' },
    ]} />);
    // Compared as the markup this component itself renders, which is known and
    // whole. Stripping tags with a regex to recover the text would be a
    // sanitizer, and a sanitizer written for markup nobody has to sanitize is
    // one nobody can get right (#925 CodeQL). The owner has to sit in the
    // anchor's own TEXT for it to reach the accessible name, and comparing the
    // whole span says so where a stripped string could not.
    const nameMarkup = (org: string) =>
      `<span class="block truncate">Shared Roadmap<span class="font-normal text-muted"> in ${org}</span></span>`;
    const names = [...html.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map(([, inner]) => inner);
    expect(names).toEqual([nameMarkup('acme'), nameMarkup('globex')]);
    expect(new Set(names).size).toBe(2);
  });

  it('stays compact when one owner answers, because nothing is ambiguous there', () => {
    vi.stubGlobal('window', { location: { pathname: '/alpha/team', search: '' } });
    const html = renderToStaticMarkup(<ProjectsPreviewCard projects={[
      { id: 'A', org: 'alpha', number: 7, title: 'One Board' },
      { id: 'B', org: 'alpha', number: 8, title: 'Another Board' },
    ]} />);
    expect(html).toContain('One Board');
    expect(html).not.toContain(' in alpha');
  });
});

/**
 * The wiring the mounted guards drive, pinned as text for the reason
 * `PageCrumb.spec.ts` pins its own: this suite's env is `node`, no effect fires,
 * and every one of these claims is about which effect runs when. What the
 * mounted view DOES is `scripts/check-projects-preview.mjs` and the `overview`
 * surface of `scripts/check-held-responses.mjs`.
 */
describe('the preview holds a response, not a copy of one (#911 review, I1)', () => {
  it('holds the marked answer itself, through the shared response-state hook', () => {
    expect(source).toContain('useResponseState<ProjectCatalogEntry[] | null>(null, null)');
    // A wrapper object built around the array carries none of the response
    // metadata, which is keyed by object — the R3 defect, one surface along.
    expect(source).not.toMatch(/setHeld\(\{/);
  });

  it('refills once on a verified check, never on the invalidation that precedes it', () => {
    expect(source).toContain('}, [org, renewal, accessEpoch, setHeld]);');
    expect(source).not.toContain('currentSensitiveGeneration');
  });

  it('fences the address at render as well as clearing it in an effect', () => {
    expect(source).toContain('useEffect(() => { setHeld(null); }, [org, setHeld]);');
    expect(source).toContain('answerFor(held, org)');
  });

  it('draws an answer only at the address it was asked for', () => {
    const narrowed = rememberScope([{ id: 'A', org: 'alpha', number: 7, title: 'Alpha board' }], 'alpha');
    const union = rememberScope([{ id: 'B', org: 'beta', number: 7, title: 'Beta board' }], undefined);
    expect(answerFor(narrowed, 'alpha')).toBe(narrowed);
    expect(answerFor(union, undefined)).toBe(union);
    // Owner equality alone would pass this one: every row of a narrowed answer
    // belongs to an owner, and the union asks about no owner at all.
    expect(answerFor(narrowed, undefined)).toEqual([]);
    expect(answerFor(union, 'alpha')).toEqual([]);
    expect(answerFor(narrowed, 'beta')).toEqual([]);
    // And an answer nobody recorded an address for draws at none of them.
    expect(answerFor([{ id: 'C', org: 'alpha', number: 9, title: 'Unrecorded' }], 'alpha')).toEqual([]);
    expect(answerFor(null, 'alpha')).toEqual([]);
  });

  it('adds no preview deadline, storage or completed cache of its own', () => {
    expect(source).not.toMatch(/localStorage|sessionStorage|setTimeout|expiresAt/);
  });
});
