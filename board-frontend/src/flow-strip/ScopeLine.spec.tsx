import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScopeLine } from './ScopeLine';

// The board's test env is `node`, so — the OrgScopeNotice.spec.tsx idiom —
// render to a static HTML string and assert against the markup. Nothing strips
// tags to recover the words, so no hand-rolled sanitizer sits here to be copied
// somewhere a hostile string can reach.

// THE RELEASES SENTENCE IS NOT HERE SINCE #816, and the person sentence is not
// here since #1450. "Issues and Throughput are octocat’s." repeated the name
// the page header already shows, behind an icon the owner could not place, and
// named a Throughput tile the strip no longer has. The org-naming rule the
// Releases sentence carried (#614, #650, #697) is asserted where the orgs are
// still named: `scope-copy.ts` and `auth/org-scope-copy.ts`, which
// `narrowed-surfaces.spec.ts` sweeps.
describe('the line that says which scope each tile counted (#666)', () => {
  // Your work, and Overview with no card pressed. It drew the Releases sentence
  // alone until #816; with that gone and nothing narrowing, there is no fact left
  // for this line to state, and an empty line is the honest answer rather than a
  // sentence kept alive to fill it.
  it('draws nothing at all when nobody is selected and nothing is narrowed', () => {
    expect(renderToStaticMarkup(<ScopeLine />)).toBe('');
  });

  // #614/#650: GITHUB_ORGS is a list, so no surface may write "the org"
  // singular. Swept over the markup, class names and all — there is nowhere in
  // it the phrase may hide.
  it('never writes “the org” singular, whatever it is handed', () => {
    const notice = { notice: 'This board does not cover globex.', reason: null };
    const cases = [
      <ScopeLine />,
      <ScopeLine narrowed />,
      <ScopeLine scope={{ org: 'globex', notice: null }} />,
      <ScopeLine scope={{ org: 'globex', notice }} narrowed />,
    ];
    for (const [i, line] of cases.entries()) {
      expect(renderToStaticMarkup(line), String(i)).not.toMatch(/\bthe org\b/);
    }
  });
});
