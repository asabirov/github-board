/**
 * Pure URL ↔ app-state mapping (#79). No router dependency: App owns a Route,
 * pushes it with history.pushState, and re-parses on popstate.
 *
 * Scheme (Caddy serves index.html for every non-API path):
 *   /                                → dashboard (Your work)
 *   /overview                        → Overview; /team remains a legacy alias.
 *                                       Shared ?assignee= links keep their filters.
 *   /projects/:number                → one board (the GitHub Project v2 number).
 *                                       The number alone means what /api/projects
 *                                       means by it: the first configured org
 *                                       that holds it (#697). The number is not
 *                                       optional: #785 deleted the rollup that
 *                                       stood at /projects, so a projects path
 *                                       naming no board resolves to Your work.
 *   /:org/projects/:number           → THAT org's board (#697). A Projects v2
 *                                       number is unique only WITHIN an org, so
 *                                       a board this board serves from two orgs
 *                                       needs both halves to be addressable.
 *   /:org[/team|/repos|/projects…]   → the whole shell narrowed to one org
 *                                       (#714), the segment in front of the tab.
 *                                       The board folds several orgs together
 *                                       and there was no way to ask it about one
 *                                       of them, or to send anyone a link to
 *                                       that view. The UNION keeps no segment at
 *                                       all — `/`, `/team`, `/repos`,
 *                                       `/projects/7` are byte for byte what
 *                                       they were — and stays the
 *                                       default (#614). Only the four primary
 *                                       tabs take the shell (ORG_SCOPED below).
 *   /repos                           → Repos (the org's repos and their queue trend)
 *   /repo/:owner/:name               → one repo's own page (#575, not in nav) —
 *                                       reached from a tile on the map, and
 *                                       shaped after /issue/:owner/:repo/:number
 *                                       rather than nested under /repos, so the
 *                                       two deep pages this board has read alike.
 *   /repo/:owner/:name/issues        → that page's Issues, PRs and Members tabs
 *   /repo/:owner/:name/prs             (#828). Each tab is an ADDRESS, so a link
 *   /repo/:owner/:name/members         opens on the one it names. A fourth
 *                                       segment that is none of the three names
 *                                       no tab and draws Overview, the same
 *                                       disposition /repos/projects/3 gets:
 *                                       junk dropped rather than 404'd, since
 *                                       the two segments that address a page are
 *                                       both present and a page exists to draw.
 *   /account /preferences /feedback  → RETIRED by #712 and reserved below. Admin
 *   /admin /admin/audit /docs          Hub, the Account pages and the API
 *                                      reference are a panel the account menu
 *                                      opens over the board, at no address of
 *                                      their own. An old bookmark lands on Your
 *                                      work.
 *   /issue/:owner/:repo/:number      → in-board issue page (#235, not in nav)
 *     ?srcProject=<number>           → optional SOURCE project (#422): set when
 *                                       the issue was reached from a project
 *                                       board, so the breadcrumb reflects it.
 *                                       Absent for every other entry point —
 *                                       the route (and its breadcrumb) is then
 *                                       byte-identical to before #422. Named
 *                                       distinctly from the viewer's own
 *                                       `?project=` filter param (a DIFFERENT
 *                                       thing — the GH Projects a card belongs
 *                                       to, `viewer-url.ts`'s `filters.projects`)
 *                                       so the two never collide when decoded.
 */

// 'issue' (#235) and 'repo' (#575) are real, URL-resolvable tabs deliberately
// kept OUT of the visible primary nav (App's TAB_ORDER): an issue is reached by
// clicking any issue reference, a repo from a tile on the Repos map.
//
// Admin Hub, the Account pages and the API reference were tabs here until #712.
// They are areas of a panel the account menu opens OVER the board now, so they
// are not places the URL names — `area-panel/panel.ts` holds their state.
export type Tab =
  | 'dashboard' | 'people' | 'team' | 'projects' | 'repos' | 'repo' | 'issue';

/** Display label per tab — shared by the sidebar nav, breadcrumb, and titles. */
export const TAB_LABEL: Record<Tab, string> = {
  dashboard: 'My work',
  people: 'Person',
  team: 'Overview',
  projects: 'Projects',
  repos: 'Repos',
  repo: 'Repo',
  issue: 'Issue',
};

/** A mirrored Github issue reference — the in-board issue page's target (#235). */
export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * The repo page's tabs that have a segment of their own (#828). Overview is the
 * bare path and is deliberately not in this list: it is what a repo path with no
 * fourth segment means, so giving it a name here would be a second spelling of
 * the same address.
 *
 * The list is here rather than beside the labels in `repos/repo-tabs.ts` because
 * this is the file that has to READ a segment. One list, so a tab that exists in
 * the nav and not in the parser cannot happen.
 */
export type RepoSection = 'issues' | 'prs' | 'members';
export const REPO_SECTIONS: RepoSection[] = ['issues', 'prs', 'members'];

/** One repo on the board — the repo page's target (#575). `owner/name` is the
 *  same canonical Github key `RepoRow.full` carries, split across the two path
 *  segments so neither has to be re-derived from the other. */
export interface RepoRef {
  owner: string;
  name: string;
  /** Which of the page's four tabs the address names (#828). Absent is Overview,
   *  which is what every link written before that issue says and what a bare
   *  `/repo/:owner/:name` keeps meaning. */
  section?: RepoSection;
}

import { ownerId, targetQuery } from './auth/github-target';
import { DEFAULT_VIEWER, decodeViewer, encodeViewer, type ViewerState } from './issues-viewer/viewer-url';

export interface Route {
  ownerId?: number;
  repositoryId?: number;
  person?: string;
  tab: Tab;
  /** Projects: the opened board's GitHub Project (v2) number (a path segment,
   *  `/projects/:number`). Issue: the SOURCE project it was opened from (#422) —
   *  optional, carried as the issue route's `?srcProject=` query (never a path
   *  segment, since the same issue is reachable from many boards or none). */
  project?: number;
  /**
   * The org the shell is narrowed to (#714) — one org's board rather than every
   * configured org folded together. It is a path segment in front of the tab,
   * `/acme/repos`, on each of the four primary tabs (ORG_SCOPED below);
   * `routeOrg` is the one reader of it in that sense.
   *
   * With a board NUMBER beside it on the projects tab it means what #697 made
   * it mean and no more: that org's board. The segment is still in the path and
   * the shell is not narrowed — `takesOrgShell` is where that is decided.
   *
   * On the ISSUE tab it means what #697 made it mean and nothing more: the
   * SOURCE board's org, qualifying `project`, carried in the query as
   * `?srcProjectOrg=` and never as a path shell. An issue names its own owner
   * already, so it takes no shell — nor does a repo page, for the same reason.
   * `org` without `project` on that tab addresses nothing and is dropped on
   * parse and ignored on format.
   *
   * Absent is a real answer rather than a gap: it means the URL named no org.
   * That is the UNION — every org this board serves, folded together — which is
   * the default (#614) and is what `/api/projects/:n` without `?org=` resolves
   * against, the first configured org holding that number. Every link shared
   * before #697 and #714 is that case, so they keep opening what they opened.
   */
  org?: string;
  /** Issue only: the mirrored issue (#235). */
  issue?: IssueRef;
  /** Repo only: the repo whose page is open (#575). */
  repo?: RepoRef;
  /** IssuesViewer state carried in the query string (#376) — filters/group/view/
   *  search. Absent when the URL has no viewer query; a partial decode when it
   *  does. Only surfaces (Project page) that host the viewer read/write it. */
  viewer?: Partial<ViewerState>;
}

const TABS: Tab[] = ['dashboard', 'people', 'team', 'projects', 'repos', 'repo', 'issue'];

/**
 * Path segments that were tabs until #712 and address nothing now.
 *
 * They must be RESERVED rather than merely dropped. Every one of them is shaped
 * like a Github login, so `orgShellPath` would read a stale `/admin` bookmark as
 * a board narrowed to an org named admin — a board that refuses itself on every
 * tab. Reserved, the bookmark lands on Your work, which is the cost #712 chose.
 */
// Queue retired in #1299; reserve its old address, including org-scoped links.
const RETIRED_PATHS = ['queue', 'account', 'admin', 'feedback', 'docs', 'preferences'];

/** Whether a path segment is exactly one of the tabs above. Internal: what
 *  callers outside this file want is `isReservedSegment`, which is the wider
 *  question and the one that has to agree with itself in two places. */
function isTab(seg: string): seg is Tab {
  return TABS.includes(seg as Tab);
}

/**
 * Whether a segment is spoken for by this app and can therefore never be read
 * as an org — a tab name or a retired address, in any casing.
 *
 * ONE predicate, because there are two callers and they were drifting apart.
 * `orgShellPath` decides what an address means; `org-scope/org-pref.ts` decides
 * what a stored org may be. When #712 cut `Tab` from eleven names to six, the
 * storage guard silently stopped refusing five of them while its comment went on
 * promising it did. Case-insensitive for the same reason the list is shared:
 * `/Admin` differs from `/admin` by one letter and used to come back as a board
 * narrowed to an org named `Admin`, refusing itself on every tab — the exact
 * failure the reservation exists to prevent. The cost is that an org really
 * spelled like a tab or a retired page gets no shell, which was already true
 * for the tabs and is stated in `parsePath` below.
 */
export function isReservedSegment(seg: string): boolean {
  const s = seg.toLowerCase();
  return s === 'overview' || TABS.some((t) => t === s) || RETIRED_PATHS.includes(s);
}

/**
 * The tabs an org shell addresses (#714) — the four in App's primary nav, and
 * only those.
 *
 * The rest are excluded because narrowing them to an org means nothing. An
 * issue page and a repo page name their own owner in the path already. A `Route`
 * naming an org on either keeps it (the issue route needs it for
 * `?srcProjectOrg=`) and formats without a shell.
 */
const ORG_SCOPED: Tab[] = ['dashboard', 'people', 'team', 'projects', 'repos'];

/**
 * Whether this route's org narrows the SHELL — which is a different question
 * from whether it appears in the path.
 *
 * The four primary tabs take the shell, with one exception, and the exception is
 * the whole of #714's review finding: a projects route WITH a board number
 * addresses THAT BOARD, exactly as `org` meant on that route in #697, and
 * narrows nothing. The rollup gave every card the board's own org, so under the
 * widened reading a click on any card in the UNION rollup silently narrowed all
 * four tabs and wrote that org into the device's memory — a scope gained by
 * opening a board, which nobody asked for. The rollup is gone (#785) and the
 * finding is not: `search-index.ts` and Your work's Contributions rings both
 * still address a board by `(org, number)`, and neither should narrow the shell.
 *
 * `/acme/projects`, with no number, no longer reaches this function on the
 * projects tab at all — `tabPath` resolves it to that org's Your work (#785), so
 * the route it produces is `{ tab: 'dashboard', org }` and narrows as a dashboard
 * route. Every `/projects/:number` link either issue shared still opens what it
 * opened, byte for byte.
 */
export function takesOrgShell(r: Route): boolean {
  if (!ORG_SCOPED.includes(r.tab)) return false;
  return !(r.tab === 'projects' && r.project !== undefined);
}

/** The org this route NARROWS to, or null for the union — the one reading of
 *  `Route.org` that means the shell's scope. Null on every tab that takes no
 *  shell, so an issue route's source-board org can never be mistaken for it,
 *  and null on an opened board, which addresses a board. */
export function routeOrg(r: Route): string | null {
  return r.org && takesOrgShell(r) ? r.org : null;
}

/** The org that appears in the PATH, which is not the same thing: an opened
 *  board keeps `/acme/projects/7` — the org qualifies the number there
 *  (#697) — while narrowing no shell. Formatting reads this; everything about
 *  scope reads `routeOrg`. */
function pathOrg(r: Route): string | null {
  return r.org && ORG_SCOPED.includes(r.tab) ? r.org : null;
}

/**
 * Whether a path segment could be a Github org login at all (#714 review).
 *
 * Github allows alphanumerics and hyphens, up to 39 characters, and must not
 * lead with a hyphen. `route.ts` took ANY segment off the address bar and passed
 * it into "This board does not cover ${org}" — React escapes it, so there was no
 * injection — while `org-pref.ts` validated the LESS hostile source, a value
 * this board wrote itself. That asymmetry is what this closes, and it is one
 * function so the two readers cannot drift.
 *
 * Exported for `org-pref.ts`, which validates the same thing about storage.
 */
export function isOrgLogin(seg: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(seg);
}

/**
 * decodeURIComponent throws URIError on malformed percent-encoding ('%E0',
 * a bare '%'), and browsers pass such pathnames through verbatim — Caddy
 * serves index.html for every non-API path, so parseRoute sees them. It runs
 * inside App's useState initializer; a throw would white-screen the whole app
 * on a mistyped URL. Keep the raw segment instead.
 */
function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * Map a URL to a Route. `pathname` picks the tab/params; the optional `search`
 * (the `?query`) is decoded into `route.viewer` at this single choke-point (#376),
 * so a viewer's filter/group/view/search state round-trips through the URL.
 * `search` defaults empty → no `viewer` key, so every existing caller and the
 * path-only tests are unaffected.
 */
export function parseRoute(pathname: string, search = ''): Route {
  const base = parsePath(pathname);
  const identity = new URLSearchParams(search);
  for (const key of ['ownerId', 'repositoryId'] as const) {
    if (identity.has(key)) base[key] = Number(identity.get(key));
  }
  // The issue route's SOURCE project (#422) rides the query, not the path — so
  // it's only ever attached to an `issue` route, and a malformed/absent value
  // just leaves the route exactly as it was before #422.
  const src = base.tab === 'issue' && base.issue ? parseIssueProject(search) : undefined;
  const route = src ? { ...base, ...src } : base;
  const viewer = search ? decodeViewer(search) : {};
  return Object.keys(viewer).length ? { ...route, viewer } : route;
}

/**
 * The route a page LOAD starts on (#714) — `parseRoute`, plus the one thing an
 * address cannot say.
 *
 * `rememberedOrg` is what this device was last narrowed to
 * (`org-scope/org-pref.ts`), and it is consulted when the address names nothing
 * at all — exactly `/`. Every other address is taken literally, and that is the
 * whole rule: a `/team` link sent to a colleague opens as the union for them,
 * rather than in THEIR last org showing them numbers they would read as the
 * sender's. An address that names an org beats what was remembered too, because
 * it is an address.
 *
 * Pure — the storage read happens at the call site, so this stays testable
 * without a browser and `route.ts` keeps holding no environment.
 */
export function initialRoute(pathname: string, search: string, rememberedOrg: string | null): Route {
  const r = parseRoute(pathname, search);
  if (pathname === '/' && rememberedOrg?.startsWith('id:')) return { ...r, ownerId: Number(rememberedOrg.slice(3)) };
  return pathname === '/' && rememberedOrg ? { ...r, org: rememberedOrg } : r;
}

/** Parse the issue route's optional `?srcProject=` (#422) and its `?srcProjectOrg=`
 *  (#697) — a positive integer plus, when present, the org that qualifies it, or
 *  `undefined` on anything else (absent, non-numeric, zero/negative), same
 *  tolerance as the `/projects/:number` path parse. Deliberately NOT `project`:
 *  that key already means the viewer's project-filter dimension
 *  (`viewer-url.ts`'s `KNOWN_PARAMS`), and reusing it here would make
 *  `decodeViewer` misread this issue route as viewer state. `srcProjectOrg` is
 *  outside `KNOWN_PARAMS` for the same reason and by the same test.
 *
 *  An org with no number is dropped rather than carried: half an address
 *  addresses nothing, and a `Route` holding `org` alone would format back to a
 *  URL that no longer holds it. */
function parseIssueProject(search: string): { project: number; org?: string } | undefined {
  if (!search) return undefined;
  const p = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  const n = Number(p.get('srcProject'));
  if (!Number.isInteger(n) || n <= 0) return undefined;
  const org = p.get('srcProjectOrg');
  return org ? { project: n, org } : { project: n };
}

/**
 * `/:org/…` — the shell narrowed to one org (#697 for a board, #714 for the
 * whole shell). Called with a first segment already known not to be a tab.
 *
 * The remainder is read as if it were an unscoped path, and the org goes on
 * whatever that leaves — so there is ONE reading of `/projects/7` and not a
 * second one written out here, and `/acme/projects/abc` drops the
 * unusable number exactly as `/projects/abc` does. What #697 required and #714
 * dropped is the board NUMBER: an org on its own is a whole address now, so
 * `/acme` is that org's Your work — and so, since #785 deleted the
 * rollup, is `/acme/projects`, which names no page to be that org's.
 *
 * Two segments make an org shell only when the SECOND names a tab that takes
 * one. Otherwise the whole path is the plain dashboard, org and all: `/assets/x.js`
 * and `/roadmap/C3/kr/C3-KR5` are the paths this rule is for — Caddy serves
 * index.html for a missing asset, and a retired surface's deep links outlive it,
 * and neither may come back reading as a narrowed board. `/acme/issue/…`
 * lands here too: an issue names its own owner and takes no shell (#714).
 *
 * A single junk segment cannot be told from an org and is read as one —
 * `/gtm` is an org named gtm, which the API answers 404 for. That is the cost of
 * `/{org}` being an address at all, and it is stated rather than enforced for
 * the same reason the tab-wins cost below is: this file is pure and cannot see
 * which orgs the deployment serves.
 */
function orgShellPath(seg: string[]): Route {
  const org = seg[0];
  // A segment that could not be a Github login is not an org, and reading it as
  // one put unvalidated address-bar text into a sentence about the board. Nor is
  // one this app has spoken for — that is where a stale `/admin` bookmark is
  // turned into Your work rather than into a board nobody serves.
  if (!isOrgLogin(org) || isReservedSegment(org)) return { tab: 'dashboard' };
  if (seg.length === 1) return { tab: 'dashboard', org };
  const asked = seg[1] === 'overview' ? 'team' : seg[1];
  // A retired address BEHIND an org shell is that org's Your work, not the
  // union's: `/acme/docs` was a page of acme's board, and dropping
  // the org made `forgetOnRoute` true, so one visit to a stale link wiped the
  // scope the device was in.
  if (RETIRED_PATHS.includes(asked.toLowerCase())) return { tab: 'dashboard', org };
  if (!isTab(asked) || !ORG_SCOPED.includes(asked)) return { tab: 'dashboard' };
  return { ...tabPath(seg.slice(1)), org };
}

function parsePath(pathname: string): Route {
  const seg = pathname.split('/').filter(Boolean).map(safeDecode);

  if (seg.length === 0) return { tab: 'dashboard' };

  const tab = seg[0] === 'overview' ? 'team' : TABS.find((t) => t === seg[0]);
  // An ORG lives in the same position as a tab name (#697), so one of the two has
  // to win when a segment could be either. THE TAB WINS, always, and the org
  // shell is only ever read out of a first segment that is not a tab at all.
  //
  // The rule is that way round because it is the only one that cannot break a
  // URL somebody already holds: every path that resolved before #697 resolves to
  // the same route after it, byte for byte, and no reading of an org can change
  // that. Trying it the other way — "second segment is `projects` ⇒ org shell" —
  // reads `/issue/projects/board/5`, a real issue in a repo owned by someone
  // spelled `projects`, as org `issue`, and there is no way to tell the two
  // apart from the path alone.
  //
  // What it costs: an org named like one of the six tabs above or one of the
  // five retired addresses (`repos`, `team`, `admin`, …), in any casing, gets no
  // org shell — `/repos/projects/3` is the Repos tab and the number is dropped,
  // and `/Repos/projects/3` is Your work. Such a board stays reachable at
  // `/projects/3`, which resolves to the FIRST configured org holding 3, so it
  // is only unreachable when a second org holds 3 too and sorts earlier. No org
  // this board serves is spelled that way today; a check here cannot see the
  // configured orgs (this file is pure and holds no session), so the guard is
  // the tab list itself and the cost is stated rather than enforced.
  if (!tab) return orgShellPath(seg);
  return tabPath(seg);
}

/**
 * The route a path names once any org shell has been taken off the front —
 * segments already decoded, `seg[0]` a tab or nothing. Split out of `parsePath`
 * for #714 so a scoped path and its union twin are read by the same code: this
 * is called once with the whole path, and once with everything after the org.
 */
function tabPath(seg: string[]): Route {
  const tab = seg[0] === 'overview' ? 'team' : TABS.find((t) => t === seg[0]);
  if (!tab) return { tab: 'dashboard' };
  // /team/:person retired (#420) — any trailing segment collapses to the Overview page.
  if (tab === 'projects') {
    // /projects/:number → an opened board (GitHub Project v2 number), which is
    // the whole of this tab since #785 deleted the rollup that sat at
    // `/projects` with no number. So a `projects` path that names no usable
    // board names no page, and falls back to Your work exactly as a malformed
    // `/issue` or `/repo` does two branches below — the rule this function
    // already had for a path that parses but addresses nothing.
    //
    // Behind an org shell that is THAT org's Your work, not the union's
    // (`orgShellPath` spreads the org back on), which is the same treatment
    // `RETIRED_PATHS` gets there and for the same reason: dropping the org
    // would make `forgetOnRoute` true and one visit to a stale
    // `/acme/projects` link would wipe the scope the device was in.
    const n = Number(seg[1]);
    return Number.isInteger(n) && n > 0 ? { tab: 'projects', project: n } : { tab: 'dashboard' };
  }
  if (tab === 'people') {
    return seg.length === 2 && isOrgLogin(seg[1]) ? { tab, person: seg[1] } : { tab: 'dashboard' };
  }
  if (tab === 'issue') {
    // /issue/:owner/:repo/:number — all three required and the number a positive
    // integer; anything malformed falls back to the dashboard rather than a
    // broken page.
    const n = Number(seg[3]);
    if (seg[1] && seg[2] && Number.isInteger(n) && n > 0) {
      return { tab: 'issue', issue: { owner: seg[1], repo: seg[2], number: n } };
    }
    return { tab: 'dashboard' };
  }
  if (tab === 'repo') {
    // /repo/:owner/:name — both required, for the same reason the issue route
    // requires all three: half a reference cannot address a page, and a broken
    // page is worse than the dashboard.
    if (seg[1] && seg[2]) {
      const repo: RepoRef = { owner: seg[1], name: seg[2] };
      // /repo/:owner/:name/:section (#828). A fourth segment naming none of the
      // three tabs is DROPPED rather than 404'd: both segments that address a
      // page are there, the page exists, and the reader gets it at its own tab.
      // The same call `/repos/projects/3` gets one branch up.
      //
      // The key is left off rather than set to `undefined`, so a parsed bare
      // path is the object it was before this issue and every stored route
      // compares the way it always did.
      const section = REPO_SECTIONS.find((s) => s === seg[3]);
      if (section) repo.section = section;
      return { tab: 'repo', repo };
    }
    return { tab: 'dashboard' };
  }
  return { tab };
}

export function routePath(r: Route): string {
  const parts = [issueProjectQuery(r), viewerQueryParams(r), targetQuery(r)].filter(Boolean);
  return basePath(r) + (parts.length ? `?${parts.join('&')}` : '');
}

/**
 * The PATH this route lives at, with no query — what the address bar has to say
 * for the bar and the page to agree (#785).
 *
 * `routePath` cannot answer that question at page load: the query it writes is
 * the route's own re-encoding, and three pages read `window.location.search`
 * directly (`location-search.ts`), including `cf_*` custom-field params no
 * `Route` holds. So a load-time correction rewrites the path and carries the
 * query it was given through untouched, and this is the half it rewrites.
 */
export function routePathname(r: Route): string {
  return basePath(r);
}

/** The issue route's `?srcProject=` query contribution (#422), without the
 *  leading '?' — merged with the viewer's query by `routePath`. Empty for every
 *  other tab, and for an issue route with no source project (the default,
 *  unchanged case).
 *
 *  `?srcProjectOrg=` rides beside it only when the source board's org is known
 *  (#697), so an issue reached from an unqualified board produces the same
 *  query it produced before — the crumb then resolves the number the way the
 *  API does, against the first org holding it. */
function issueProjectQuery(r: Route): string {
  if (r.tab !== 'issue' || !r.project) return '';
  const q = `srcProject=${r.project}`;
  return r.org ? `${q}&srcProjectOrg=${encodeURIComponent(r.org)}` : q;
}

/** The path-only portion of a route (the query is appended by routePath). */
function basePath(r: Route): string {
  // The org shell goes on only when the route narrows to one (#697, #714); the
  // union — and every tab that takes no shell — stays at the address it has
  // always had, byte for byte.
  // `pathOrg`, not `routeOrg`: an opened board keeps its org segment while
  // narrowing no shell, which is what makes `/acme/projects/7` format
  // byte for byte as #697 wrote it.
  const org = pathOrg(r);
  const shell = org ? `/${encodeURIComponent(org)}` : '';
  // `/acme` is a whole address: the org's Your work.
  if (r.tab === 'dashboard') return shell || '/';
  if (r.tab === 'people') return r.person && isOrgLogin(r.person) ? `${shell}/people/${encodeURIComponent(r.person)}` : shell || '/';
  // A projects route with no board number is not an address: #785 deleted the
  // rollup that sat at `/projects`, and `tabPath` parses that path back as Your
  // work. Formatting it as `/projects` would have made `routePath` and
  // `parseRoute` stop being inverse for a shape TypeScript accepts (`project`
  // is optional), which is how a `/projects` nobody can open got written into a
  // link. It formats as the page that path opens instead — the org's Your work
  // behind a shell, the union's without one.
  if (r.tab === 'projects') return r.project ? `${shell}/projects/${r.project}` : shell || '/';
  if (r.tab === 'issue' && r.issue) {
    const { owner, repo, number } = r.issue;
    return `/issue/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`;
  }
  if (r.tab === 'repo' && r.repo) {
    const { owner, name, section } = r.repo;
    const page = `/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
    // The section is one of three literals this file owns, so it is written as
    // it stands: encoding a value that came from `REPO_SECTIONS` would only be
    // able to change it if the list itself grew a segment that needs escaping.
    return section ? `${page}/${section}` : page;
  }
  // Team and Repos, the two remaining tabs, both take the shell.
  return `${shell}/${r.tab === 'team' ? 'overview' : r.tab}`;
}

/** The viewer state's query contribution (#376), without the leading '?' — merged
 *  with other contributors (the issue route's `?srcProject=`) by `routePath`. Empty
 *  when `r.viewer` is absent. Fills defaults for a partial so a hand-set `viewer`
 *  still encodes fully. */
function viewerQueryParams(r: Route): string {
  if (!r.viewer) return '';
  const s: ViewerState = {
    ...DEFAULT_VIEWER,
    ...r.viewer,
    filters: { ...DEFAULT_VIEWER.filters, ...r.viewer.filters },
  };
  const qs = encodeViewer(s);
  return qs ? qs.slice(1) : '';
}

/** Build the in-board issue path from a card's `owner/repo` + number (#235).
 *  `sourceProject` (#422) is the GitHub Project (v2) board the link is rendered
 *  from — pass it only when navigating out of a project board (encoded as
 *  `?srcProject=`), so the issue's breadcrumb can reflect it; every other
 *  caller omits it and the path is unchanged. `sourceOrg` (#697) is that board's
 *  org — pass it whenever the board said which org it is, so the crumb walks back
 *  to THAT board rather than to whichever org holds the number first. */
export function issuePath(
  repoNameWithOwner: string,
  number: number,
  sourceProject?: number,
  sourceOrg?: string,
): string {
  const [owner, repo] = repoNameWithOwner.split('/');
  return routePath({ tab: 'issue', issue: { owner, repo, number }, project: sourceProject, org: sourceOrg });
}

/**
 * Which PRIMARY nav item a route lights (#575 follow-up).
 *
 * Usually itself. The exception is the repo page: it is a tab of its own so it
 * can resolve from a URL, but it sits INSIDE Repos — you reach it from a tile on
 * the map and the breadcrumb says so. Comparing `tab === t` in the sidebar left
 * the whole nav dark there, so the only thing naming where you were was the
 * crumb. Same grouping App already makes with `inAccount` for its three account
 * tabs, expressed here so it is testable without rendering the shell.
 */
export function navTabFor(tab: Tab): Tab {
  return tab === 'repo' ? 'repos' : tab === 'people' ? 'team' : tab;
}

/** Build the in-board repo path from a row's `full` — the `owner/name` key every
 *  repo surface already carries (#575), so a tile links to the page without
 *  re-deriving either half. Mirrors `issuePath`: one canonical key in, one
 *  encoded path out.
 *
 *  `section` (#828) names one of the page's tabs; omitted, the path is Overview
 *  and is byte for byte what every caller written before that issue produced. */
export function repoPath(fullName: string, section?: RepoSection): string {
  const [owner, name] = fullName.split('/');
  return routePath({ tab: 'repo', repo: { owner, name, section } });
}

/** Build the in-board issue path from a Github issue's canonical html URL
 *  (github.com/:owner/:repo/issues/:number). The personal-queue and oldest-open
 *  sources carry a *short* repo key for display ("acme", not "acme/acme"),
 *  so their rows must resolve owner/repo from the URL — passing the short key to
 *  `issuePath` leaves repo `undefined` and 404s the route as "undefined #NN" (#271).
 *  Falls back to the raw URL when unparseable so the link still points somewhere.
 *  `sourceProject` / `sourceOrg` (#422, #697): see `issuePath` — pass them only
 *  from a project board's own rows. */
export function issuePathFromUrl(htmlUrl: string, sourceProject?: number, sourceOrg?: string): string {
  const m = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(htmlUrl);
  if (!m) return htmlUrl;
  return routePath({
    tab: 'issue',
    issue: { owner: m[1], repo: m[2], number: Number(m[3]) },
    project: sourceProject,
    org: sourceOrg,
  });
}

/** Resolve owner/repo/number from a Github issue's canonical html URL — the
 *  full ref the close write needs (#287), since a card carries only a short repo
 *  key. Null when the URL isn't a github issue URL. */
export function issueRefFromUrl(htmlUrl: string): IssueRef | null {
  const m = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(htmlUrl);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/**
 * Navigate from components that don't have App's `navigate` in props (deep
 * person links, #94). pushState (or replaceState) + a synthetic popstate —
 * App's listener re-parses the URL, so this is exactly a back/forward-style
 * transition.
 *
 * `replace` swaps the current history entry instead of adding one — used for
 * in-page state that shouldn't cost a Back press (the IssuesViewer's search/
 * filter/group/view mutations, #376), so a whole filtering session collapses to
 * a single entry and Back leaves the page. Default is push (every other caller).
 */
export function gotoPath(path: string, opts?: { replace?: boolean }): void {
  // No duplicate history entries. `isCurrentPath` and not the comparison spelt
  // out again: App.navigate asks the same question and used to spell it out too,
  // and two copies of "is this where we already are" is two things to keep in
  // step over a rule that has exactly one right answer.
  if (isCurrentPath(path)) return;
  // A replace CARRIES the current entry's state rather than clearing it (#823):
  // replacing a walked-to entry leaves it walked-to, and replacing the entry the
  // tab booted on leaves that one unwalked. Passing `null` here would have a
  // filter change on a repo page delete the page's own way out.
  if (opts?.replace) window.history.replaceState(window.history.state, '', path);
  else window.history.pushState(WALKED_HERE, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * What a history entry this app PUSHED carries, and the entry a tab booted on
 * does not (#823).
 *
 * The question a back control has to answer is whether there is a board page
 * behind this one. `history.length` was asked first and cannot answer it: it
 * counts entries rather than depth, so it reads the same one press of Back later
 * — and the account panel pushes an entry of its own (`App.openPanel`), so
 * opening and closing the panel raised it with no navigation at all. That left a
 * `← Back` on a cold-loaded page that was a no-op in a fresh tab and a walk off
 * the site in a tab with history in front of it. Inverted, a reload replaces the
 * current entry without changing the length, so the baseline was re-read equal
 * to it and the control vanished from a page that had one.
 *
 * A marker on the entry answers both, because it says what the length cannot:
 * this entry was pushed BY a navigation, so a page of ours is behind it. It
 * survives a reload, because the browser keeps an entry's state across one. And
 * the panel's push is unmarked, so it is invisible to the question.
 *
 * Every push the app makes is here or in `App.navigate`, and the panel's is the
 * one that must stay unmarked. `PageCrumb.spec.ts` pins that list, reading the
 * source of both files, so an unmarked push added later has to say why.
 */
export const WALKED_HERE = { boardWalked: true } as const;

/** Whether a history entry was pushed by an in-board navigation — pure, so the
 *  measurement the back control turns on is decidable without a browser. */
export function walkedHere(state: unknown): boolean {
  return !!state && typeof state === 'object'
    && (state as { boardWalked?: unknown }).boardWalked === true;
}

/**
 * Is `path` the address the browser is already at? Path AND query, because the
 * viewer's whole state lives in the query (#376) and a filter change is a real
 * move even though the pathname does not budge.
 *
 * Exported for App.navigate, which needs the answer for a different reason than
 * `gotoPath` does: with a panel open it has an entry to spend and no navigation
 * to spend it on, so it has to tell "already here" from "going somewhere" before
 * it decides whether to replace, push, or hand the entry back (#712).
 */
export function isCurrentPath(path: string): boolean {
  return path === window.location.pathname + window.location.search;
}

/** Document title for a route. */
export function routeTitle(r: Route): string {
  // `<subject> · Board` is the one title shape here, the middot separating the
  // subject from the board rather than joining two facts. An opened project is
  // not an exception: it names itself by number (#694).
  if (r.tab === 'projects' && r.project) return `Project ${r.project} · Board`;
  if (r.tab === 'issue' && r.issue) return `${r.issue.repo} #${r.issue.number} · Board`;
  // Same form as the issue title above: the subject names itself, not its tab.
  if (r.tab === 'repo' && r.repo) return `${r.repo.name} · Board`;
  if (r.tab === 'people' && r.person) return `${r.person} · Board`;
  return `${TAB_LABEL[r.tab]} · Board`;
}

/**
 * The address to land on when somebody picks a different Github owner (#892).
 *
 * Switching owner used to mean `{ tab: 'repos', org }` — every switch dropped
 * you on the Repos map whatever you were reading, and threw away the rest of the
 * route with it. That is wrong in one direction and right in the other, and the
 * two halves have to be told apart:
 *
 * - The four `ORG_SCOPED` tabs are OWNER-AGNOSTIC. Your work, Overview,
 *   Projects and Repos all mean the same thing about whichever owner they are
 *   pointed at, so the tab is kept and only the owner changes.
 * - The entity REFERENCES on the route are not. A board number belongs to one
 *   owner's Projects; an issue and a repo name their owner in the path. Carried
 *   across a switch they address something the new owner does not have, so they
 *   are dropped — and a route that was nothing BUT such a reference falls back
 *   to the tab that lists them, which is the page the reference came from.
 *
 * `viewer` goes with `project`: it is that board's filter and grouping state,
 * and it has no meaning over a board that is not open.
 */
export function ownerSwitch(route: Route, owner: string | null): Route {
  const tab: Tab = route.tab === 'repo' ? 'repos' : route.tab === 'issue' ? 'dashboard' : route.tab;
  return { tab, ...(tab === 'people' && route.person ? { person: route.person } : {}), ...(owner ? { org: owner, ...(ownerId(owner) ? { ownerId: ownerId(owner) } : {}) } : {}) };
}
