/**
 * What the sidebar offers (#750).
 *
 * `TAB_ORDER` is the whole of the nav: `App` maps it to render the items, so a
 * name here is a nav item and a name absent from it is not one. The tab list
 * itself (`route.ts`'s `TABS`) is a different thing — what the URL can address —
 * and the two are deliberately not equal: `repo` and `issue` have always been
 * addressable without being in the nav, and since #750 `projects` is too.
 *
 * Written because nothing else in this suite could tell the nav had four items
 * from three: the removal was invisible to 2,433 tests. This is the check that
 * fails if `projects` comes back without anybody meaning it to.
 */
import { describe, expect, it } from 'vitest';
import { TAB_ORDER } from './App';
import { TAB_LABEL, parseRoute, routePath, type Tab } from './route';

describe('the sidebar nav (#750)', () => {
  it('offers Overview, My work and Repos, in that order', () => {
    expect(TAB_ORDER).toEqual(['team', 'dashboard', 'repos']);
    expect(TAB_ORDER.map((t) => TAB_LABEL[t])).toEqual(['Overview', 'My work', 'Repos']);
    expect(TAB_ORDER.map((tab) => routePath({ tab, org: 'acme' })))
      .toEqual(['/acme/overview', '/acme', '/acme/repos']);
  });

  it('does not offer Projects — the rings on Your work answer it now', () => {
    expect(TAB_ORDER).not.toContain('projects');
  });

  it('every nav item has a label', () => {
    for (const t of TAB_ORDER) expect(TAB_LABEL[t]).toBeTruthy();
  });

  // The other half of #750's promise: coming off the nav is not coming out of
  // the app. A link already shared to one BOARD still resolves to the page it
  // always resolved to.
  //
  // The rollup half of that promise was withdrawn by #785, which deleted the
  // page: `/projects` named a rollup nothing pointed at, so it now falls to Your
  // work the way any path that parses but names no page does. #750 kept it
  // addressable on the reasoning that a shared link should still land; #785 is
  // the answer to what a link should land on once there is nothing there.
  it('keeps /projects/:number addressable, and lands a bare /projects on Your work', () => {
    expect(parseRoute('/projects')).toEqual({ tab: 'dashboard' });
    expect(parseRoute('/projects/7')).toEqual({ tab: 'projects', project: 7 });
    expect(parseRoute('/acme/projects/7')).toEqual({ tab: 'projects', project: 7, org: 'acme' });
  });

  // Formatting is the inverse of the parse above, and has to stay it: `project`
  // is optional on `Route`, so `{ tab: 'projects' }` is a shape TypeScript
  // accepts (the `as Tab` cast below is only because `Tab` no longer includes a
  // nav item for it). #785 left it formatting as `/projects` while the parse had
  // stopped reading that path as this tab — a `routePath` a `parseRoute` could
  // not undo, which is a link to a page nobody can open. It writes the address
  // the path actually opens instead.
  it('writes a board path, and writes Your work for a projects route with no board', () => {
    expect(routePath({ tab: 'projects' as Tab, project: 7 })).toBe('/projects/7');
    expect(routePath({ tab: 'projects' as Tab })).toBe('/');
    expect(routePath({ tab: 'projects' as Tab, org: 'acme' })).toBe('/acme');
    expect(parseRoute(routePath({ tab: 'projects' as Tab }))).toEqual({ tab: 'dashboard' });
  });
});
