import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gotoPath, initialRoute, isCurrentPath, issuePath, issuePathFromUrl, navTabFor, parseRoute, repoPath,
  REPO_SECTIONS, routePath, routePathname,
  routeTitle, TAB_LABEL, WALKED_HERE,
  type Route,
  type Tab,
} from './route';
import { DEFAULT_FILTERS } from './issues-viewer/filter-group';

describe('parseRoute', () => {
  it('maps / and unknown paths to the dashboard', () => {
    expect(parseRoute('/')).toEqual({ tab: 'dashboard' });
    expect(parseRoute('/assets/x.js')).toEqual({ tab: 'dashboard' });
    // `/nope` is the dashboard NARROWED to an org named nope since #714, because
    // `/{org}` is an address there (`/acme` is that org's Your work) and
    // one junk segment cannot be told from one org login. It is still the
    // dashboard tab, and the API answers 404 for an org it does not serve —
    // stated in `route.ts`'s `orgShellPath`. Two segments are safe: the second
    // has to name a tab that takes a shell, which is why `/assets/x.js` above
    // is untouched.
    expect(parseRoute('/nope')).toEqual({ tab: 'dashboard', org: 'nope' });
  });

  it('parses plain tabs', () => {
    expect(parseRoute('/team').tab).toBe('team');
    // `/projects` was here until #785 deleted the rollup that stood at it. The
    // projects tab is one board's page now, so its bare path names no page and
    // resolves to Your work — asserted outright under "projects routes" below,
    // where the board it still addresses is asserted beside it.
    expect(parseRoute('/projects/7').tab).toBe('projects');
    expect(parseRoute('/repos').tab).toBe('repos'); // #472, the fourth primary tab
  });

  it('routes the removed /gtm, /metrics and /roadmap surfaces to the dashboard (#197/#208/#209)', () => {
    // The tab is still the dashboard for all four. Since #714 the three
    // one-segment ones also name an org — see the note above; a bookmark to a
    // retired surface lands on Your work narrowed to an org nobody serves,
    // which the API answers 404 for rather than showing another org's numbers.
    expect(parseRoute('/gtm')).toEqual({ tab: 'dashboard', org: 'gtm' });
    expect(parseRoute('/metrics')).toEqual({ tab: 'dashboard', org: 'metrics' });
    expect(parseRoute('/roadmap')).toEqual({ tab: 'dashboard', org: 'roadmap' });
    // A DEEP retired link keeps exactly the answer it had: the second segment
    // names no shellable tab, so nothing is read as an org.
    expect(parseRoute('/roadmap/C3/kr/C3-KR5')).toEqual({ tab: 'dashboard' });
  });

  it('lands an old Admin Hub / Account / API-reference bookmark on Your work (#712)', () => {
    // Those six addresses were routes until #712, when the four areas became a
    // panel the account menu opens over the board. A bookmark to one must reach
    // the PLAIN dashboard: read as an org login — which every one of them is
    // shaped like — the reader would get a board narrowed to an org nobody
    // serves, refusing itself on every tab. That is the cost this reserves away.
    for (const path of ['/admin', '/admin/audit', '/account', '/preferences', '/feedback', '/docs']) {
      expect(parseRoute(path), path).toEqual({ tab: 'dashboard' });
    }
  });

  it('reserves a retired address in any casing (#712 review)', () => {
    // One capital was the whole gap: `/Admin` missed a case-sensitive list and
    // came back as a board narrowed to an org named `Admin`, which is precisely
    // the state the reservation above exists to prevent, one letter later.
    for (const path of ['/Admin', '/DOCS', '/Account', '/Preferences', '/FeedBack', '/Admin/audit']) {
      expect(parseRoute(path), path).toEqual({ tab: 'dashboard' });
    }
    // Same predicate, so a tab spelled oddly is refused as an org too.
    expect(parseRoute('/Repos')).toEqual({ tab: 'dashboard' });
  });

  it('collapses a retired /team/:person segment to the Unit page (#420)', () => {
    // The per-member page was retired; any trailing segment lands on the unit.
    expect(parseRoute('/team/octocat%40example.com')).toEqual({ tab: 'team' });
    expect(parseRoute('/team/octocat')).toEqual({ tab: 'team' });
  });

  it('never throws on malformed percent-encoding (would white-screen the app)', () => {
    // Browsers keep invalid escapes verbatim in location.pathname, and Caddy
    // serves index.html for every non-API path — parseRoute must survive them.
    // The raw segment is kept rather than decoded. #714 read a lone segment as
    // an org and carried the garbage onto the route with it; #714's review took
    // that back — a segment has to be shaped like a Github login before it is
    // read as one — so the route is the bare dashboard again. The property this
    // test exists for is unchanged either way: no throw, no white screen, and
    // the tab is the dashboard.
    expect(parseRoute('/%E0')).toEqual({ tab: 'dashboard' });
    expect(parseRoute('/%')).toEqual({ tab: 'dashboard' });
    expect(parseRoute('/team/%E0')).toEqual({ tab: 'team' });
  });
});

describe('routePath', () => {
  it('round-trips every shape', () => {
    const routes: Route[] = [
      { tab: 'dashboard' },
      { tab: 'team' },
      // `{ tab: 'projects' }` was in this list until #785, formatting to
      // `/projects` — which is no longer a shape `parseRoute` produces. It round-
      // trips again now that it formats as the page that path opens, and it is
      // asserted under "projects routes" below rather than here, where the point
      // is the shapes an address can carry. A board number is the whole of this
      // tab.
      { tab: 'projects', project: 7 },
      { tab: 'repos' },
      { tab: 'repo', repo: { owner: 'acme', name: 'acme' } },
      { tab: 'issue', issue: { owner: 'acme', repo: 'acme', number: 9 } },
    ];
    for (const r of routes) {
      expect(parseRoute(routePath(r))).toEqual(r);
    }
  });

  it('renders dashboard as /', () => {
    expect(routePath({ tab: 'dashboard' })).toBe('/');
  });
});

describe('retired /team/:person (#420)', () => {
  it('no longer parses a person segment — the unit is the only team route', () => {
    expect(parseRoute('/team/octocat')).toEqual({ tab: 'team' });
    expect(parseRoute('/team')).toEqual({ tab: 'team' });
  });

  it('routes and titles the bare unit', () => {
    expect(routePath({ tab: 'team' })).toBe('/overview');
    expect(routeTitle({ tab: 'team' })).toBe('Overview · Board');
  });
});

describe('issue routes (#235)', () => {
  it('parses /issue/:owner/:repo/:number', () => {
    expect(parseRoute('/issue/acme/acme/218')).toEqual({
      tab: 'issue', issue: { owner: 'acme', repo: 'acme', number: 218 },
    });
  });

  it('falls back to the dashboard on a malformed issue path', () => {
    expect(parseRoute('/issue/acme/acme')).toEqual({ tab: 'dashboard' }); // missing number
    expect(parseRoute('/issue/acme/acme/abc')).toEqual({ tab: 'dashboard' }); // non-numeric
    expect(parseRoute('/issue/acme/acme/0')).toEqual({ tab: 'dashboard' }); // non-positive
  });

  it('round-trips through routePath and builds a path from repo+number', () => {
    const r: Route = { tab: 'issue', issue: { owner: 'acme', repo: 'board', number: 4 } };
    expect(parseRoute(routePath(r))).toEqual(r);
    expect(issuePath('acme/acme', 218)).toBe('/issue/acme/acme/218');
  });

  it('builds the issue path from a canonical html URL, not a short repo key (#271)', () => {
    // The personal queue / oldest-open rows carry a short repo key ("acme"),
    // which would leave repo `undefined`; the html URL carries the true owner/repo.
    expect(issuePathFromUrl('https://github.com/acme/acme/issues/378'))
      .toBe('/issue/acme/acme/378');
    // Unparseable → fall back to the raw URL rather than an "undefined" route.
    expect(issuePathFromUrl('not-a-github-url')).toBe('not-a-github-url');
  });

  it('titles the issue page as "<repo> #<number> · Board"', () => {
    expect(routeTitle({ tab: 'issue', issue: { owner: 'acme', repo: 'acme', number: 218 } }))
      .toBe('acme #218 · Board');
  });
});

describe('issue route source project (#422)', () => {
  it('parses ?srcProject= into the issue route', () => {
    expect(parseRoute('/issue/acme/acme/218', '?srcProject=7')).toEqual({
      tab: 'issue', issue: { owner: 'acme', repo: 'acme', number: 218 }, project: 7,
    });
  });

  it('round-trips through routePath', () => {
    const r: Route = { tab: 'issue', issue: { owner: 'acme', repo: 'board', number: 4 }, project: 7 };
    const path = routePath(r);
    expect(path).toBe('/issue/acme/board/4?srcProject=7');
    const q = path.indexOf('?');
    expect(parseRoute(path.slice(0, q), path.slice(q))).toEqual(r);
  });

  it('ignores a malformed, zero, or absent ?srcProject= — the route is unchanged', () => {
    const base = { tab: 'issue', issue: { owner: 'acme', repo: 'acme', number: 218 } };
    expect(parseRoute('/issue/acme/acme/218')).toEqual(base);
    expect(parseRoute('/issue/acme/acme/218', '')).toEqual(base);
    expect(parseRoute('/issue/acme/acme/218', '?srcProject=abc')).toEqual(base);
    expect(parseRoute('/issue/acme/acme/218', '?srcProject=0')).toEqual(base);
    expect(parseRoute('/issue/acme/acme/218', '?srcProject=-3')).toEqual(base);
  });

  it('does not collide with the viewer\'s own ?project= filter param', () => {
    // `viewer-url.ts` already uses `project` for the multi-select project-filter
    // dimension (`filters.projects`) — a plain `?project=7` on an issue route
    // must NOT be read as the source project (it isn't `srcProject`), and must
    // decode as ordinary (harmless) viewer state, not corrupt `route.project`.
    const r = parseRoute('/issue/acme/acme/218', '?project=7');
    expect(r.project).toBeUndefined();
    expect(r.viewer?.filters?.projects).toEqual(['7']);
  });

  it('every existing issue-path builder stays generic (no project) when unset', () => {
    // The DoD: the generic breadcrumb entry points are unaffected by #422.
    expect(issuePath('acme/acme', 218)).toBe('/issue/acme/acme/218');
    expect(issuePathFromUrl('https://github.com/acme/acme/issues/378'))
      .toBe('/issue/acme/acme/378');
  });

  it('issuePath and issuePathFromUrl thread an explicit source project into ?srcProject=', () => {
    expect(issuePath('acme/acme', 218, 7)).toBe('/issue/acme/acme/218?srcProject=7');
    expect(issuePathFromUrl('https://github.com/acme/acme/issues/378', 9))
      .toBe('/issue/acme/acme/378?srcProject=9');
  });
});

describe('routeTitle', () => {
  it('names tabs', () => {
    expect(routeTitle({ tab: 'dashboard' })).toBe('My work · Board');
    expect(routeTitle({ tab: 'team' })).toBe('Overview · Board');
  });
});

describe('repos route (#472)', () => {
  it('is a real tab at /repos, labelled and titled', () => {
    expect(parseRoute('/repos')).toEqual({ tab: 'repos' });
    expect(routePath({ tab: 'repos' })).toBe('/repos');
    expect(TAB_LABEL.repos).toBe('Repos');
    expect(routeTitle({ tab: 'repos' })).toBe('Repos · Board');
  });

  it('sits beside Your work, Overview and Projects in the primary nav labels', () => {
    // The four primary tabs are the four labels the sidebar renders (App's
    // TAB_ORDER) — guarding them here catches a rename that tsc cannot.
    expect([TAB_LABEL.dashboard, TAB_LABEL.team, TAB_LABEL.projects, TAB_LABEL.repos])
      .toEqual(['My work', 'Overview', 'Projects', 'Repos']);
  });

  it('carries a repo filter into the Unit queue through the viewer query (#472)', () => {
    const path = routePath({ tab: 'team', viewer: { filters: { ...DEFAULT_FILTERS, repos: ['board'] } } });
    expect(path).toBe('/overview?repo=board');
    const q = path.indexOf('?');
    expect(parseRoute(path.slice(0, q), path.slice(q)).viewer?.filters?.repos).toEqual(['board']);
  });
});

describe('repo page route (#575)', () => {
  it('parses /repo/:owner/:name', () => {
    expect(parseRoute('/repo/acme/board')).toEqual({
      tab: 'repo', repo: { owner: 'acme', name: 'board' },
    });
  });

  it('falls back to the dashboard on a malformed repo path', () => {
    // Same reason as the issue route: half a reference cannot address a page,
    // and a broken page is worse than the dashboard.
    expect(parseRoute('/repo')).toEqual({ tab: 'dashboard' }); // neither segment
    expect(parseRoute('/repo/acme')).toEqual({ tab: 'dashboard' }); // no name
    expect(parseRoute('/repo//board')).toEqual({ tab: 'dashboard' }); // no owner
  });

  it('round-trips through routePath, and builds a path from a row’s owner/name', () => {
    const r: Route = { tab: 'repo', repo: { owner: 'acme', name: 'board' } };
    expect(routePath(r)).toBe('/repo/acme/board');
    expect(parseRoute(routePath(r))).toEqual(r);
    expect(repoPath('acme/board')).toBe('/repo/acme/board');
  });

  it('encodes both segments, and re-parses them back to what went in', () => {
    // A repo name is not URL-safe by construction — Github allows a dot and an
    // underscore, and a hand-built path would break on anything needing escape.
    const r: Route = { tab: 'repo', repo: { owner: 'a b', name: 'c/d?e#f' } };
    expect(routePath(r)).toBe('/repo/a%20b/c%2Fd%3Fe%23f');
    expect(parseRoute(routePath(r))).toEqual(r);
    expect(repoPath('a b/c d')).toBe('/repo/a%20b/c%20d');
  });

  it('titles the repo page after the repo, the way the issue page is titled', () => {
    expect(routeTitle({ tab: 'repo', repo: { owner: 'acme', name: 'board' } }))
      .toBe('board · Board');
  });

  it('is labelled, so the nav-less tab still names itself in a title and a crumb', () => {
    expect(TAB_LABEL.repo).toBe('Repo');
  });
});

describe('the repo page’s four tabs are four addresses (#828)', () => {
  const REPO = { owner: 'acme', name: 'board' };
  const PAGE = '/repo/acme/board';

  it('parses each tab, and round-trips every one of the four', () => {
    // Overview is the bare path and the other three take a fourth segment. All
    // four have to survive the trip, or a tab is reachable and not linkable.
    const routes: Route[] = [
      { tab: 'repo', repo: { ...REPO } },
      ...REPO_SECTIONS.map((section) => ({ tab: 'repo' as const, repo: { ...REPO, section } })),
    ];
    expect(routes).toHaveLength(4);
    for (const r of routes) {
      expect(parseRoute(routePath(r)), routePath(r)).toEqual(r);
    }
    expect(routePath(routes[0])).toBe(PAGE);
    expect(routePath(routes[1])).toBe(`${PAGE}/issues`);
    expect(routePath(routes[2])).toBe(`${PAGE}/prs`);
    expect(routePath(routes[3])).toBe(`${PAGE}/members`);
  });

  it('drops a fourth segment that names no tab, and draws Overview', () => {
    // The same disposition `/repos/projects/3` gets: both segments that address
    // a page are there and the page exists, so junk comes off rather than
    // 404ing a repo somebody can see. A 404 here would be a page refusing
    // itself over a segment it does not need. `Issues` is in the list because
    // the segment is matched exactly: the three are written into links by this
    // file and are not a casing a person types.
    for (const junk of ['/issue', '/Issues', '/pulls', '/%20']) {
      expect(parseRoute(PAGE + junk), junk).toEqual({ tab: 'repo', repo: { ...REPO } });
    }
  });

  it('drops what trails a tab, and keeps the tab', () => {
    // A fifth segment addresses nothing either, and dropping it is the same
    // treatment `/team/:person` has had since #420 — the page it names still
    // exists, so it is drawn rather than refused.
    expect(parseRoute(`${PAGE}/members/2`))
      .toEqual({ tab: 'repo', repo: { ...REPO, section: 'members' } });
  });

  it('leaves the bare path meaning exactly what it meant before', () => {
    // Every link written before #828 is this shape, and none of them may move.
    expect(parseRoute(PAGE)).toEqual({ tab: 'repo', repo: REPO });
    expect(repoPath('acme/board')).toBe(PAGE);
    expect(routePathname({ tab: 'repo', repo: { ...REPO } })).toBe(PAGE);
  });

  it('builds a tab path from a row’s owner/name', () => {
    expect(repoPath('acme/board', 'members')).toBe(`${PAGE}/members`);
    expect(repoPath('a b/c d', 'prs')).toBe('/repo/a%20b/c%20d/prs');
  });

  it('titles every tab after the repo, and never after the tab', () => {
    // The browser tab says which repo you are on. Which of ITS tabs you are on
    // is on the page, and a title that changed under a reader's saved tab would
    // be a second name for one thing.
    for (const section of REPO_SECTIONS) {
      expect(routeTitle({ tab: 'repo', repo: { ...REPO, section } }), section)
        .toBe('board · Board');
    }
    expect(routeTitle({ tab: 'repo', repo: REPO })).toBe('board · Board');
  });
});

describe('which primary nav item a route lights (#575 follow-up)', () => {
  it('keeps Repos lit while you are on one of its repos', () => {
    // A repo page is INSIDE Repos — the same grouping the Account area makes
    // for its three tabs. The sidebar went dark on a repo page, so the only
    // thing saying where you were was the breadcrumb.
    expect(navTabFor('repo')).toBe('repos');
    expect(navTabFor('repos')).toBe('repos');
  });

  it('leaves every other tab lighting itself', () => {
    // Every tab there is, less the one exception above — read off TAB_LABEL so
    // a tab added later is swept without editing this list.
    for (const t of (Object.keys(TAB_LABEL) as Tab[]).filter((t) => t !== 'repo' && t !== 'people')) {
      expect(navTabFor(t), t).toBe(t);
    }
  });
});

describe('projects routes', () => {
  // #785 deleted the rollup that stood at `/projects`, so an opened board is the
  // whole of this tab and a projects path naming no board names no page. Both
  // expectations below changed from `{ tab: 'projects' }` to `{ tab: 'dashboard' }`
  // for that reason — the same fallback `tabPath` already gives a malformed
  // `/issue` or `/repo`, a path that parses but addresses nothing.
  it('parses an opened board, and falls back to Your work with no board number', () => {
    expect(parseRoute('/projects/4')).toEqual({ tab: 'projects', project: 4 });
    expect(parseRoute('/projects')).toEqual({ tab: 'dashboard' });
  });

  it('ignores a non-numeric board segment', () => {
    expect(parseRoute('/projects/abc')).toEqual({ tab: 'dashboard' });
  });

  it('round-trips a board route through routePath', () => {
    const board: Route = { tab: 'projects', project: 7 };
    expect(routePath(board)).toBe('/projects/7');
    expect(parseRoute(routePath(board))).toMatchObject({ tab: 'projects', project: 7 });
  });

  // `project` is optional on `Route`, so a projects route with no board is a
  // shape TypeScript accepts and code can build. It formatted as `/projects`
  // while `parseRoute` read that path as Your work, which made the two stop
  // being inverse for a shape that compiles — a link written to a page nobody
  // can open. Both directions are asserted here so they cannot drift apart
  // again.
  it('formats a projects route with no board as the page that path opens', () => {
    expect(routePath({ tab: 'projects' })).toBe('/');
    expect(routePath({ tab: 'projects', org: 'acme' })).toBe('/acme');
    expect(parseRoute(routePath({ tab: 'projects' }))).toEqual({ tab: 'dashboard' });
  });

  // What a bookmarked `/projects` is corrected to at load (#785). App's mount
  // rewrites the address bar to `routePathname(initialRoute(...))` whenever it
  // disagrees with the path that was opened, and this is that answer, taken
  // without a browser: the bar says the page the person is actually on, so the
  // address they copy out of it opens the same page for whoever receives it.
  //
  // A malformed `/issue/x` is corrected the same way now. The difference that
  // made this worth fixing is not the parse — both fall to Your work — it is
  // that `/projects` was an address people held.
  it('corrects a bookmarked /projects to the page it lands on', () => {
    expect(routePathname(initialRoute('/projects', '', null))).toBe('/');
    expect(routePathname(initialRoute('/acme/projects', '', null))).toBe('/acme');
    // The remembered org is consulted for `/` and nothing else, so a bare
    // `/projects` on a device narrowed to an org still lands on the union.
    expect(routePathname(initialRoute('/projects', '', 'acme'))).toBe('/');
    // And an address that already says where it lands is left alone.
    expect(routePathname(initialRoute('/projects/7', '', null))).toBe('/projects/7');
    expect(routePathname(initialRoute('/team', '', null))).toBe('/overview');
  });

  it('titles an opened board', () => {
    // The `{ tab: 'projects' }` title assertion that stood here titled the
    // rollup, and #785 deleted it — no address resolves to that route now.
    // One title shape, and an opened board is not an exception to it (#694):
    // the subject names itself, and the middot only separates it from Board.
    expect(routeTitle({ tab: 'projects', project: 4 })).toBe('Project 4 · Board');
  });
});

describe('gotoPath history mode (#376)', () => {
  const push = vi.fn();
  const replace = vi.fn();
  const dispatch = vi.fn();
  const stub = {
    location: { pathname: '/projects/7', search: '' },
    // `state` is part of the stub since #823: `gotoPath`'s replace reads it to
    // carry it through, so a stub without one made the carry unobservable.
    history: { pushState: push, replaceState: replace, state: null as unknown },
    dispatchEvent: dispatch,
  };

  beforeEach(() => {
    push.mockClear(); replace.mockClear(); dispatch.mockClear();
    stub.history.state = null;
    (globalThis as unknown as { window: typeof stub }).window = stub;
    // The node test env has no DOM PopStateEvent; gotoPath dispatches one.
    (globalThis as unknown as { PopStateEvent: unknown }).PopStateEvent = class {};
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    delete (globalThis as unknown as { PopStateEvent?: unknown }).PopStateEvent;
  });

  it('pushes a new history entry by default (nav callers)', () => {
    gotoPath('/team');
    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    // MARKED (#823). A count says an entry was added and nothing about what it
    // carries, and what it carries is the whole of whether the destination can
    // offer a way back. `pushState(null` here passes every count in this file.
    expect(push).toHaveBeenCalledWith(WALKED_HERE, '', '/team');
  });

  it('replaces the current entry with { replace: true } (in-page viewer state)', () => {
    // A whole search/filter session collapses to one entry, so Back leaves the page.
    gotoPath('/projects/7?q=auth', { replace: true });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    // And CARRIES what the entry already had (#823) rather than clearing it, so
    // a filter change on a walked-to page does not delete that page's own way
    // back. The stub's state is whatever `window.history.state` reads as here.
    expect(replace).toHaveBeenCalledWith(stub.history.state, '', '/projects/7?q=auth');
  });

  it('carries a marked entry through a replace, and an unmarked one through unchanged', () => {
    // The two states that exist, asked of the real function rather than of the
    // source: a page the reader walked to keeps its way back across a filter
    // change, and the entry a tab booted on does not gain one.
    stub.history.state = WALKED_HERE;
    gotoPath('/projects/7?q=auth', { replace: true });
    expect(replace).toHaveBeenCalledWith(WALKED_HERE, '', '/projects/7?q=auth');

    replace.mockClear();
    stub.history.state = null;
    gotoPath('/projects/7?q=other', { replace: true });
    expect(replace).toHaveBeenCalledWith(null, '', '/projects/7?q=other');
  });

  it('no-ops (neither push nor replace) when the URL is unchanged', () => {
    gotoPath('/projects/7', { replace: true });
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  // The guard above is one rule with two readers (#712): `gotoPath` declines to
  // write, and App.navigate — which cannot use `gotoPath`, needing to set a Route
  // object rather than re-parse the URL — has to tell "already here" from "going
  // somewhere" before it decides whether an open panel's history entry gets
  // replaced or handed back. Both ask this.
  it('isCurrentPath answers on path AND query, since the viewer state is the query', () => {
    expect(isCurrentPath('/projects/7')).toBe(true);
    expect(isCurrentPath('/projects/7?q=auth')).toBe(false);
    expect(isCurrentPath('/team')).toBe(false);
  });

  it('isCurrentPath compares the query too when the browser is carrying one', () => {
    stub.location.search = '?q=auth';
    expect(isCurrentPath('/projects/7?q=auth')).toBe(true);
    expect(isCurrentPath('/projects/7')).toBe(false);
    stub.location.search = '';
  });
});

it('uses overview URLs while keeping union and scoped team bookmarks', () => {
  for (const org of [undefined, 'acme']) {
    const shell = org ? '/' + org : '';
    const expected = org ? { tab: 'team', org } : { tab: 'team' };
    expect(parseRoute(shell + '/overview')).toEqual(expected);
    expect(parseRoute(shell + '/team')).toEqual(expected);
    expect(routePathname(parseRoute(shell + '/team'))).toBe(shell + '/overview');
  }
  expect(parseRoute('/overview/projects/7')).toEqual({ tab: 'team' });
  expect(parseRoute('/Overview')).toEqual({ tab: 'dashboard' });
});


describe('retired Queue links (#1299)', () => {
  it.each(['/queue', '/queue/', '/Queue'])('opens My work for %s without treating queue as an org', path => {
    expect(parseRoute(path)).toEqual({ tab: 'dashboard' });
    expect(routePath(parseRoute(path))).toBe('/');
  });
  it('keeps the org and viewer state on an old scoped link', () => {
    const search = '?group=triage%3Apriority&view=list&sort=priority-size&label=bug';
    expect(parseRoute('/acme/queue', search)).toEqual(parseRoute('/acme', search));
    expect(parseRoute('/queue', search)).toEqual(parseRoute('/', search));
  });
});
