import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML } from 'linkedom';
import { AccountShape, OrgSwitcherShape, RouteSkeleton, SyncShape } from './ProbeShell';
import { TAB_LABEL, type Route, type Tab } from '../route';
import PROBE_SOURCE from './ProbeShell.tsx?raw';
import DASHBOARD from '../dashboard/Dashboard.tsx?raw';
import REPOS from '../repos/ReposPage.tsx?raw';
import TEAM from '../team/TeamView.tsx?raw';
import PERSON from '../person/PersonPage.tsx?raw';
import PROJECTS from '../projects/ProjectsView.tsx?raw';
import ISSUE from '../issue/IssuePage.tsx?raw';
import ISSUE_LOADING from '../issue/IssueLoading.tsx?raw';
import CRUMB from '../PageCrumb.tsx?raw';
import SIDE_ACCOUNT from '../SideAccount.tsx?raw';
import EXPIRED_GUARD from '../../scripts/check-expired-panel.mjs?raw';

/**
 * What the board draws while the identity probe is in flight (#1229 step 1,
 * #1187).
 *
 * Two things have to hold, and they are different kinds of thing.
 *
 * The first is that EVERY route draws something. The old gate drew one
 * full-screen spinner for all of them, so there was nothing per-route to get
 * wrong; a per-route skeleton has a route it forgot. `SHAPE` is a
 * `Record<Tab, …>`, so a tab added to `route.ts` without a shape does not
 * compile — but a shape that returns nothing, or returns an empty box, would.
 * So this renders every tab and reads what came out.
 *
 * The second is that NONE of it names a person. That is the whole reason this
 * step could ship ahead of the session hint cookie: it draws the furniture, not
 * the person. A render here is the place to hold it, because the rule is about
 * what reaches the markup rather than about which branch was taken.
 */

/** One route per tab, each carrying the subject `App` requires before it will
 *  render that tab's page at all. */
const ROUTES: Record<Tab, Route> = {
  dashboard: { tab: 'dashboard' },
  people: { tab: 'people', person: 'octocat' },
  team: { tab: 'team' },
  projects: { tab: 'projects', project: 7 },
  repos: { tab: 'repos' },
  repo: { tab: 'repo', repo: { owner: 'acme', name: 'board' } },
  issue: { tab: 'issue', issue: { owner: 'acme', repo: 'board', number: 1229 } },
};

const drawn = (route: Route) => renderToStaticMarkup(<RouteSkeleton route={route} />);

/** The visible words in a render: its text with the screen-reader-only status
 *  lines (`Loading repositories…`) taken out, since those are the skeleton
 *  saying it is a skeleton. */
function visibleText(html: string): string {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  for (const status of document.querySelectorAll('p[role="status"].sr-only')) status.remove();
  return document.body.textContent.trim();
}

/** Every class on a render, as WHOLE TOKENS — the way `querySelector('.x')`
 *  reads them, so `side-acct-who` is not `side-acct`. Substring matching is
 *  what would let this spec pass over the bug it exists to catch. */
function classTokens(html: string): Set<string> {
  const out = new Set<string>();
  for (const attr of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of attr[1].split(/\s+/)) if (token) out.add(token);
  }
  return out;
}

describe('every route the probe can open on draws a skeleton (#1229)', () => {
  const tabs = Object.keys(TAB_LABEL) as Tab[];

  it.each(tabs)('%s draws placeholders, not an empty page', (tab) => {
    const html = drawn(ROUTES[tab]);
    // A route with nothing in it is the failure this step must not ship: the
    // old gate at least drew a spinner, and a blank white column would be worse
    // than what it replaced.
    expect(html).not.toBe('');
    expect(html).toContain('animate-pulse');
    // Named for a screen reader, which is how `LoadingStructure` says "this is
    // coming" to somebody who cannot see the bars.
    expect(html).toMatch(/aria-busy="true"|aria-hidden="true"/);
  });

  it('covers every tab route.ts has', () => {
    // `SHAPE` is typed `Record<Tab, …>`, so this is the runtime half of a check
    // the compiler already makes — it catches a `Tab` union widened through a
    // cast or an `as`, which typing alone would let past.
    expect(Object.keys(ROUTES).sort()).toEqual(tabs.sort());
  });

  it('draws nothing for a route that addresses no page', () => {
    // `App`'s own guards: since #785 a projects address with no board names no
    // page, and the same holds for a repo, issue or person route with no
    // subject. A skeleton there would put a page up that then vanished.
    expect(drawn({ tab: 'projects' })).toBe('');
    expect(drawn({ tab: 'repo' })).toBe('');
    expect(drawn({ tab: 'issue' })).toBe('');
    expect(drawn({ tab: 'people' })).toBe('');
  });
});

describe('nothing person-specific is drawn before the probe answers (#1229, #892)', () => {
  const tabs = Object.keys(TAB_LABEL) as Tab[];

  it.each(tabs)('%s says only its own page name', (tab) => {
    const text = visibleText(drawn(ROUTES[tab]));
    // The page names are the board's own words and belong to the route, not to
    // whoever is holding the browser. Everything else has to be a bar.
    const allowed = new Set<string>([TAB_LABEL.dashboard, TAB_LABEL.repos, '']);
    expect(allowed.has(text), `"${text}" is drawn before the probe answers`).toBe(true);
  });

  it('the rail and the top bar draw their person-specific rows as bars', () => {
    // The three the plan names: the account row, the person's name and the org
    // switcher. Each is shape only — no email, no login, no figure.
    for (const html of [
      renderToStaticMarkup(<AccountShape />),
      renderToStaticMarkup(<OrgSwitcherShape />),
      renderToStaticMarkup(<SyncShape />),
    ]) {
      expect(visibleText(html)).toBe('');
      expect(html).toContain('animate-pulse');
    }
  });

  it('reads nothing off the disk and asks nothing of the network', () => {
    // The rule this file's docblock states, held as an import list: a skeleton
    // that reached the payload cache or a fetcher would be painting a
    // remembered person, which is step 4 of the plan and needs the cookie.
    expect(PROBE_SOURCE).not.toMatch(/from '\.\.\/(api|cache)\//);
    expect(PROBE_SOURCE).not.toMatch(/\bfetch\(/);
    // And over the one skeleton this file does not draw itself. Since #1198 the
    // issue route renders the PAGE's `IssueLoading` rather than a copy of its
    // shape, which is what keeps the two from drifting — but it also puts a
    // module outside this file inside the probe window, where the rule above
    // still has to hold. A warm skeleton reaching for the cached issue would
    // pass every check written about `ProbeShell.tsx` alone.
    expect(ISSUE_LOADING).not.toMatch(/from '\.\.\/(api|cache)\//);
    expect(ISSUE_LOADING).not.toMatch(/\bfetch\(/);
    expect(ISSUE_LOADING).not.toMatch(/\buse[A-Z]/);
    // `PageCrumb` is the one that looks safe and is not: on an issue opened from
    // a board it asks `/api/projects` for that board's name.
    expect(CRUMB).toContain('fetchProjects()');
    expect(PROBE_SOURCE).not.toContain('<PageCrumb');
  });

  it('wears no class a browser guard reads as “the probe has answered” (#1233)', () => {
    // `.side-acct` is the pressable account block and nothing else.
    // `check-expired-panel` reads it off the live page as proof `/api/auth/me`
    // has answered and then clicks it for the account menu, and it gates merges.
    // A placeholder wearing the class answers yes one round trip early, and the
    // guard presses a `div` with no menu behind it — which is what took guards
    // red on a runner where the probe was slow. Whole tokens, on every shape and every route.
    for (const html of [
      renderToStaticMarkup(<AccountShape />),
      renderToStaticMarkup(<OrgSwitcherShape />),
      renderToStaticMarkup(<SyncShape />),
      ...(Object.keys(TAB_LABEL) as Tab[]).map((tab) => drawn(ROUTES[tab])),
    ]) {
      // The whole family, not just the one class the guards name today: the
      // shape draws its row with utilities and wears none of them.
      for (const token of classTokens(html)) expect(token.startsWith('side-acct')).toBe(false);
    }
    // Not vacuous on either side: the real block wears it, and the gating
    // guard presses exactly that selector.
    expect([...classTokens('<x class="a side-acct b" />')]).toContain('side-acct');
    expect([...classTokens('<x class="side-acct-who" />')]).not.toContain('side-acct');
    expect(SIDE_ACCOUNT).toContain('className="side-acct ');
    expect(EXPIRED_GUARD).toContain("document.querySelector('.side-acct')");
  });
});

/**
 * The skeleton stands where the page will stand.
 *
 * Each root is spelled here as its page spells its own, so the probe answering
 * swaps a silhouette for a page rather than one layout for another. Pinned as
 * TEXT against the page's own source, because both are template strings and two
 * different spellings would each render a plausible-looking class list.
 */
describe('each skeleton sits at the edges its page sits at (#1229)', () => {
  const ROOTS: [string, string][] = [
    ['const DASHBOARD_ROOT = `${PAGE_RAIL} pt-5 pb-[60px] max-[900px]:pt-3 max-[900px]:pb-10`;', DASHBOARD],
    ['const REPOS_ROOT = `${PAGE_WELL} pt-5 pb-[60px] max-[900px]:pt-3 max-[900px]:pb-10`;', REPOS],
    ['const TEAM_ROOT = `${PAGE_RAIL} pt-5 pb-12 max-[900px]:pt-3 max-[900px]:pb-10`;', TEAM],
    ['const ISSUE_ROOT = `${PAGE_RAIL} pb-24 pt-8 max-[900px]:pt-4`;', ISSUE],
  ];

  it.each(ROOTS)('%s is the page’s own root', (declaration, pageSource) => {
    expect(PROBE_SOURCE).toContain(declaration);
    const classes = declaration.slice(declaration.indexOf('`'), declaration.lastIndexOf('`') + 1);
    expect(pageSource).toContain(classes);
  });

  it('the person and projects roots match theirs too', () => {
    // Written inline in their pages rather than as a named constant, so they
    // are matched on the class list alone.
    expect(PERSON).toContain('${PAGE_RAIL} flex flex-col gap-4 pt-5 pb-10');
    expect(PROBE_SOURCE).toContain('const PERSON_ROOT = `${PAGE_RAIL} flex flex-col gap-4 pt-5 pb-10`;');
    expect(PROJECTS).toContain('${PAGE_RAIL} pb-20 pt-[26px]');
    expect(PROBE_SOURCE).toContain('const PROJECTS_ROOT = `${PAGE_RAIL} pb-20 pt-[26px]`;');
  });

  it('draws the surface each page draws while its own read is pending', () => {
    // The pairs that can silently diverge: a page changing its silhouette and
    // leaving the probe's copy behind. Read off both sources rather than off the
    // render, because a surface name is what decides the shape.
    expect(DASHBOARD).toContain('<LoadingStructure surface="work" label="your work" className="mb-3 min-h-[92px]" />');
    expect(PROBE_SOURCE).toContain('<LoadingStructure surface="work" label="your work" className="mb-3 min-h-[92px]" />');
    expect(REPOS).toContain('<LoadingStructure surface="repos" label="repositories" />');
    expect(PROBE_SOURCE).toContain('<LoadingStructure surface="repos" label="repositories" />');
    expect(TEAM).toContain('<LoadingStructure surface="overview" label="overview" />');
    expect(PROBE_SOURCE).toContain('<LoadingStructure surface="overview" label="overview" />');
    // #1198 moved this one off `LoadingStructure` and onto the issue page's own
    // two-column silhouette, and this pair is what made the probe's copy come
    // with it. Both sides now name the same COMPONENT rather than the same
    // surface, so the shape is shared instead of described twice.
    expect(ISSUE).toContain('<IssueLoading />');
    expect(PROBE_SOURCE).toContain('<IssueLoading />');
    expect(PROBE_SOURCE).not.toContain('surface="issue"');
    expect(PERSON).toContain('<LoadingStructure surface="work" label="assigned issues" />');
    expect(PROBE_SOURCE).toContain('<LoadingStructure surface="work" label="assigned issues" />');
  });
});
