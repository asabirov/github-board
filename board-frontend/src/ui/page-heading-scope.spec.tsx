/**
 * The page heading says which board you are on (#714 review).
 *
 * Pixel-diffed, `/` and `/acme` differed in 25 rows out of 1800, 794px
 * below the heading — and every occurrence of the org name on a narrowed page
 * sat inside a sentence about what was NOT narrowed ("count every org, not just
 * acme", "the whole of acme and globex"): five mentions on
 * `/acme/team`, not one of them affirmative. A person sent that link could
 * not tell which board they were looking at.
 *
 * So the heading names the scope, at its own size, in `text-muted` so
 * the hierarchy does not move. It is built HERE and not by four pages, and it is
 * read off the scope rather than passed in, so a fifth page cannot forget it.
 *
 * The reporter selected “for” for visible scoped headings (#972). It remains
 * accessible text; document-title separators are a separate surface.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageHeading } from './PageHeading';
import { RouteProvider } from '../route-ctx';
import { OrgScopeProvider } from '../org-scope/OrgScopeProvider';
import type { Route } from '../route';

/** The heading as the app draws it on a given address. */
function heading(route: Route, text = 'Your work'): string {
  return renderToStaticMarkup(
    <RouteProvider route={route}>
      <OrgScopeProvider>
        <PageHeading>{text}</PageHeading>
      </OrgScopeProvider>
    </RouteProvider>,
  );
}

describe('a narrowed board says so in its heading (#714)', () => {
  it('names the org after the page name, on every tab that takes the shell', () => {
    for (const [tab, label] of [['dashboard', 'Your work'], ['team', 'Overview'], ['repos', 'Repos'], ['projects', 'Projects']] as const) {
      const html = heading({ tab, org: 'acme' }, label);
      expect(html, tab).toContain(label);
      expect(html, tab).toContain('acme');
      expect(html, tab).toContain('> for </span>');
      expect(html, tab).not.toContain('·');
      expect(html, tab).not.toContain('aria-hidden');
    }
  });

  it('draws the org at the heading’s own size, quieter — one h1, no second element', () => {
    const html = heading({ tab: 'repos', org: 'acme' }, 'Repos');
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toMatch(/text-muted[^>]*>acme</);
    // No font-size class on the org: it rides the h1's own ramp, so narrowing a
    // page cannot change the hierarchy of the band it is in.
    expect(html).not.toMatch(/>acme<[\s\S]*text-\[\d/);
  });

  it('leaves the union’s heading byte for byte what it was', () => {
    const bare = renderToStaticMarkup(<PageHeading>Your work</PageHeading>);
    expect(heading({ tab: 'dashboard' })).toBe(bare);
    expect(heading({ tab: 'repos' }, 'Repos')).toBe(renderToStaticMarkup(<PageHeading>Repos</PageHeading>));
  });

  it('says nothing on a surface no org narrows', () => {
    // An issue route's `org` is the SOURCE board's, never a shell (#697). The
    // personal and admin surfaces were swept here too until #712 took their
    // addresses away; the panel re-provides the union around itself for the
    // same reason, so their headings still name no org.
    for (const tab of ['issue', 'repo'] as const) {
      expect(heading({ tab, org: 'acme', project: 3 }, 'Thing'), tab).not.toContain('acme');
    }
  });

  it('says nothing on an opened board, which addresses a board and not a shell', () => {
    // #714 review, decided: `/acme/projects/7` addresses THAT board — what
    // `org` meant on that route in #697 — and does not narrow the shell. Its
    // heading is the board's name and the org would be a claim about the page.
    expect(heading({ tab: 'projects', org: 'acme', project: 7 }, 'Delivery'))
      .toBe(renderToStaticMarkup(<PageHeading>Delivery</PageHeading>));
  });
});


it('lets My work keep its title without an organization suffix (#923)', () => {
  const html = renderToStaticMarkup(
    <RouteProvider route={{ tab: 'dashboard', org: 'globex' }}><OrgScopeProvider>
      <PageHeading showScope={false}>My work</PageHeading>
    </OrgScopeProvider></RouteProvider>,
  );
  expect(html).toContain('My work');
  expect(html).not.toContain('globex');
});
