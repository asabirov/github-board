import { bindRouteTarget, resolveRouteTarget, targetQuery } from './auth/github-target';
import { resolvedTimezone } from './account/prefs';
import { useStaleReads } from './cache/use-board-read';
import { beginHintPreview, hintPreviewActive, savedSessionPending } from './auth/session-hint';
import { responseExpired } from './auth/response-deadline';
import { GithubAccessState, GithubConnection } from './auth/GithubConnection';
import { unreachedOwner, useOwnerRename } from './auth/owner-rename';
import { routeOrg as githubRouteOrg, ownerSwitch } from './route';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchMe } from './api/me';
import { IdentityContext } from './auth/identity-context';
import { fetchMyIssues, type PersonalIssues } from './api/issues';
import { IDENTITY_RECHECK_EVENT, resetIdentityRecheck, WithdrawnReadError, withdrawnRead } from './api/core';
import { PersonPage } from './person/PersonPage';
import { Dashboard } from './dashboard/Dashboard';
import { AuthScreen } from './auth/AuthScreen';
import { AccountShape, OrgSwitcherShape, RouteSkeleton, SyncShape } from './ui/ProbeShell';
import { TeamView } from './team/TeamView';
import ProjectsView from './projects/ProjectsView';
import { ReposPage } from './repos/ReposPage';
import { RepoPage } from './repos/RepoPage';
import { IssuePage } from './issue/IssuePage';
import { TooltipProvider } from './ui/kit';
import { Tip } from './ui/Tip';
import { SideAccount } from './SideAccount';
import { ThemeSwitch } from './ThemeSwitch';
import { AreaPanel } from './area-panel/AreaPanel';
import { PanelActionsProvider } from './area-panel/panel-ctx';
import type { Panel } from './area-panel/panel';
import { RouteProvider } from './route-ctx';
import { SyncStamp, TopBar } from './topbar/TopBar';
import { menuPageName } from './topbar/page-name';
import { GithubTargetState } from './auth/GithubTargetState';
import { ErrorBoundary, PAGE_FALLBACK } from './ErrorBoundary';
import { Route, Tab, TAB_LABEL, WALKED_HERE, initialRoute, isCurrentPath, navTabFor, parseRoute, routeOrg, routePath, routePathname, routeTitle } from './route';
import { PeopleProvider } from './people-ctx';
import { SyncProvider } from './sync/sync-status';
// The org the shell is narrowed to (#714) — read off the route, not held.
import { OrgScopeProvider } from './org-scope/OrgScopeProvider';
import { forgetOnRoute, readOrgPref, writeOrgPref } from './org-scope/org-pref';
import { CrumbTitleProvider } from './crumb-title';
import { consumeReturnTo, hasReturnTo, saveReturnTo } from './auth/return-to';
import { isSessionExpired, onSessionExpired, resetSessionExpiry } from './auth/session-expiry';
import { cachedOwner, currentPayloadGeneration, forgetSensitivePayloads } from './cache/payload-cache';
import { ACCESS_VERIFIED_EVENT } from './sync/sync-status';
import { mapError, nextSession, type SessionView } from './auth/session-state';
import { useIdentityGeneration } from './auth/identity-generation';

import { SessionNotice } from './auth/SessionNotice';
import { beginLogin } from './auth/oauth';
import { BoardIcon, HomeIcon, ReposIcon, SlidersIcon, UsersIcon } from './icons';

/*
 * Why board draws its own shell, and does not take the kit's.
 *
 * The old private kit shipped `AppShell`, `AppSidebar`, `TopBar` and `RailToggle` — a
 * whole console frame, and the headline of its 4.0.0. Board imports none of
 * them. The rail, the top bar and the main column below are board's own, in
 * this file and in `app.css`, and #711 asked out loud whether the bump across
 * seven kit majors should also move board onto them. Artur decided on
 * 2026-09-01, with both routes in front of him: NOT NOW, and here is the why,
 * so nobody has to ask a third time.
 *
 * What board's shell does that the kit's does not, today:
 *
 *   - The rail SLIDES. Below 900px it is a 200%-wide slider that pushes the
 *     board sideways rather than a sheet dropped over it, on one duration knob
 *     (`--side-slide-dur`) that reduced motion zeroes. #608 built it and named
 *     the failure it fixed.
 *   - The panel is not a page. Account, Preferences, Feedback, Admin, the audit
 *     log and the API reference are an `AreaPanel` over the board at no address
 *     of their own (#712), and `.area-panel-frame` is the positioning context a
 *     session notice draws inside (#741, fixed the day before this bump).
 *   - `.shell-main{overflow-x:clip}` contains a tooltip that would otherwise
 *     open a phantom sideways scroll (#329), and `check-phone-overflow.mjs`
 *     measures 34 elements against the boxes this grid draws.
 *
 * Adopting `AppShell` moves all three onto a surface that has its own answers,
 * and each of those answers is a bug that was found here, in a browser, and
 * fixed. The bump is one package.json line plus one component; the shell is a
 * separate piece of work with its own before-and-after, and it does not have to
 * ride on a dependency bump to happen.
 *
 * The cost of saying no, stated plainly: every kit release that improves the
 * console frame improves the Acme console and not this board, and the two
 * drift apart in look. #783 is that drift already visible — the board is capped
 * at 1180px where the kit's container is 1440px. That is the argument FOR
 * adopting it, and it is not settled here.
 */

// Nav-item icon per tab (#200/#201 sidebar refresh). `repo`, `issue` and — since
// #750 — `projects` are not in TAB_ORDER, so their icons are never rendered in
// the nav; present only to satisfy the exhaustive Record.
const TAB_ICON: Record<Tab, typeof HomeIcon> = {
  dashboard: HomeIcon,
  people: UsersIcon,
  team: UsersIcon,
  // Off the nav since #750; the route and the pages behind it are unchanged.
  projects: BoardIcon,
  repos: ReposIcon,
  // A repo page is not in TAB_ORDER either — same icon as the map it opens from.
  repo: ReposIcon,
  issue: HomeIcon,
};

// The theme switch lives in the sidebar header, next to the wordmark (#322) —
// restored there after #320 dropped it. See ThemeSwitch.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// The nav, in order. `projects` came off it in #750: the question the rollup
// answered — which board is this work on — is now asked where the work is, by
// pressing a Contributions ring on Your work, which narrows the queue under it
// instead of navigating away. The tab is what goes; `/projects` and
// `/projects/:number` still resolve and still render, so every link already
// shared answers what it answered. See `dashboard/project-filter.ts`.
export const TAB_ORDER: Tab[] = ['team', 'dashboard', 'repos'];

// The session state machine lives in auth/session-state.ts (#512) so it can be
// tested outside a component.

/** Below 900px the sidebar is a sheet the menu button opens (#608). Above it,
 *  neither class changes anything: both bodies live inside a max-width query. */
const SIDE_OPEN = 'side side-open';
const SIDE_SHUT = 'side';
/** The twin of the `max-width: 900px` queries in app.css: below it the sidebar
 *  is the sheet, above it the desktop column. Move one and move the other. */
const SHEET_QUERY = '(max-width: 900px)';

/**
 * How many times a WITHDRAWN answer is asked again before it is allowed to
 * reach the gate (#1061). See the branch in the mount probe for what a
 * withdrawal is; three, because a withdrawal that keeps repeating has stopped
 * being bookkeeping and a fault belongs on the gate (#1004).
 */
const WITHDRAWN_REASKS = 3;

/** The speculative queue read an open starts beside its identity probe (#1098).
 *  `org` and `timeZone` are what it ASKED for, so the page that receives it can
 *  refuse an answer to another question. */
type OpeningMine = { org?: string; timeZone: string; generation: number; read: Promise<PersonalIssues> };

export default function App() {
  const staleReads = useStaleReads();
  // The URL is the source of truth for the active tab (#79) and, since #714, for
  // the org the shell is narrowed to. `search` is passed through too (#422) so
  // the issue route's `?srcProject=` (and any `viewer` query) survive the initial
  // load, not just in-session navigation.
  //
  // The one thing the URL cannot say is which org this device was last in, and
  // that is consulted for exactly one address: `/`, which names nothing at all.
  // Every other address is taken literally, so a `/team` link opens as the union
  // for whoever receives it.
  //
  // The bar is then corrected to say where the load actually landed, whatever
  // made it land there — the remembered org, or a path that parses to another
  // page. Until #785 this fired only on `/`, and the page it was written for was
  // the only one that needed it; then `/projects` stopped naming a page and
  // started resolving to Your work, and a bookmark to it sat in the bar naming a
  // page nobody was on. Copying that address hands a colleague the same lie and
  // a reload reproduces it, which is the difference between this and a malformed
  // `/issue/x`: nobody bookmarked a malformed path.
  //
  // The PATH is rewritten and the query is carried through verbatim — three
  // pages read `window.location.search` for viewer state that no `Route` holds,
  // so re-emitting the query from the route would drop their `cf_*` params.
  // A bare `/` is left alone when a login is about to replay a deep link over
  // it: `routePathname` answers `/` there, so this does nothing and the replay
  // still sees the bare `/` it keys on.
  const [storedRoute, setRoute] = useState<Route>(() => {
    const start = initialRoute(
      window.location.pathname,
      window.location.search,
      hasReturnTo() ? null : readOrgPref(),
    );
    const canonical = routePathname(start);
    if (canonical !== window.location.pathname) {
      // Carries the entry's state through (#823). A reload of a page the reader
      // walked to keeps its marker, so its back control survives the reload; a
      // cold load has nothing to carry and stays unmarked.
      const search = new URLSearchParams(window.location.search);
      new URLSearchParams(targetQuery(start)).forEach((value, key) => search.set(key, value));
      window.history.replaceState(window.history.state, '', canonical + (search.size ? '?' + search.toString() : ''));
    }
    return start;
  });
  // A matching companion cookie permits an inert cache preview. The session
  // stays loading until the server answers; no account or write flag is seeded.
  const [openingShell] = useState(() => cachedOwner()?.shell);
  const [session, setSession] = useState<SessionView>(() => ({ kind: 'loading', hint: beginHintPreview(cachedOwner()) }));
  const { route, targetFailure } = useMemo(() => {
    if (session.kind !== 'ready') return { route: storedRoute, targetFailure: null };
    try { return { route: resolveRouteTarget(storedRoute), targetFailure: null }; }
    catch (error) { return { route: storedRoute, targetFailure: (error as Error).message }; }
  }, [storedRoute, session]);
  useEffect(() => {
    if (session.kind !== 'ready' || targetFailure) return;
    if (JSON.stringify(storedRoute) !== JSON.stringify(route)) setRoute(route);
    const search = new URLSearchParams(window.location.search);
    if (route.viewer?.filters) {
      for (const key of ['repo', 'repoId', 'board']) search.delete(key);
      const canonical = new URL(routePath(route), window.location.origin).searchParams;
      for (const key of ['repo', 'repoId', 'board']) canonical.getAll(key).forEach(value => search.append(key, value));
    }
    new URLSearchParams(targetQuery(route)).forEach((value, key) => search.set(key, value));
    const query = search.toString();
    window.history.replaceState(window.history.state, '', routePathname(route) + (query ? '?' + query : ''));
  }, [route, storedRoute, session.kind, targetFailure]);
  // These flags belong only to the user's Account > GitHub actions.
  const [verified, setVerified] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const openingMine = useRef<OpeningMine | null>(null);
  /**
   * The one opening queue read, and WHO STARTS IT.
   *
   * Either side may be first, and that is the whole of #1409. On a warm open
   * the saved copy paints, so `Dashboard` mounts in the same commit as `App`
   * and React runs a child's effects before its parent's — so the probe below
   * armed the read AFTER the page had already asked for it and given up, and
   * the open sent the queue read twice. Whoever asks first starts it; the other
   * one finds it started and adds nothing.
   *
   * ONLY WHILE THE DOCUMENT IS STILL OPENING. A later walk to My work is an
   * ordinary read on an identity this app has already verified, and an opening
   * read there would ask `/api/auth/me` a second time to fence it with.
   *
   * `fetchMe` joins, so the probe this hands to `fetchMyIssues` is the SAME
   * probe the identity effect reads and the same request on the wire. The
   * response stays private until it answers (#1098, `networkFetch`'s
   * `verified`), and the replay guard below is the rest of that fence.
   */
  const openingStarted = useRef(false);
  const probeAnswered = useRef(false);
  const startOpeningMine = useCallback((org: string | undefined, timeZone: string): OpeningMine | null => {
    if (openingStarted.current || probeAnswered.current) return null;
    openingStarted.current = true;
    const read = fetchMyIssues(org, fetchMe(), timeZone);
    const held: OpeningMine = { org, timeZone, generation: currentPayloadGeneration(), read };
    void read.catch(() => {
      if (openingMine.current === held) openingMine.current = null;
    });
    return held;
  }, []);
  // The TIME ZONE the asking page keys its own cache on, rather than this
  // component's reading of the preference: the page stores the answer under
  // `dayQuery(org, timeZone)`, and a read sent under another zone lands on a
  // key nothing on that page looks at.
  const takeOpeningMine = useCallback((org?: string, timeZone = resolvedTimezone()) => {
    const held = openingMine.current ?? startOpeningMine(org, timeZone);
    openingMine.current = null;
    if (!held || held.org !== org || held.timeZone !== timeZone) return undefined;
    return held.read.then(value => {
      // A browser-history change may delay the first Dashboard mount. Never
      // replay a response that expired or lost its owner while it waited.
      if (held.generation !== currentPayloadGeneration() || responseExpired(value)) {
        throw new WithdrawnReadError('Your GitHub access changed; reload this view.');
      }
      return value;
    });
  }, [startOpeningMine]);
  const tab = route.tab;

  // The phone's menu sheet (#608). It holds the sidebar itself — the same nav,
  // the same account row, the same theme switch — rather than a second copy of
  // them, so there is nothing to keep in sync.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const closeMenu = () => {
    setMenuOpen(false);
    menuButton.current?.focus();
  };

  // Admin Hub, the Account pages and the API reference (#712). They are areas of
  // ONE panel over the board — never two — and they have no address: the URL
  // says which board page you are on and nothing about what is open over it.
  const [panel, setPanel] = useState<Panel | null>(null);
  // Opening pushes a history entry at the SAME url, so the browser's Back closes
  // the panel instead of leaving the board entirely. This says the entry
  // is ours to consume: the X and Escape go back through it, so closing leaves
  // history exactly where opening found it.
  const panelEntry = useRef(false);
  // `useCallback`, and it is not a micro-optimisation: a fresh `onClose` on every
  // App render re-ran the panel's effects, and one of them focuses the panel —
  // so pressing a rail row, or a session expiring mid-panel, pulled focus off
  // whatever the reader was on. The panel's own effects hold the rest of that
  // fix; these two just have to stop changing identity.
  const openPanel = useCallback((next: Panel) => {
    // Only the FIRST open pushes, and the ref is the test rather than `panel`
    // itself: a ref is always current, so this stays a stable callback. Moving
    // between sections, and the reference link inside Access & agents replacing
    // the panel, cost no entry — one press of Back closes whatever is open,
    // which is the one thing Back should mean here.
    if (!panelEntry.current) {
      // UNMARKED, and that is the point (#823). This entry is the one push this
      // app makes that is not a navigation — nothing is behind it but the page
      // the panel opened over, which is the page still rendering underneath.
      // Marking it would put a back control on a page that has not moved.
      window.history.pushState(null, '', window.location.href);
      panelEntry.current = true;
    }
    setPanel(next);
    // On a phone the panel is opened FROM the menu sheet and then covers the
    // whole screen, so a sheet left open is a second overlay nobody can see —
    // with its own Escape handler and its own scroll lock under the panel's.
    setMenuOpen(false);
  }, []);
  const closePanel = useCallback(() => {
    setPanel(null);
    if (!panelEntry.current) return;
    panelEntry.current = false;
    window.history.back();
  }, []);
  /**
   * EVERY in-board navigation goes through here, and giving up an open panel is
   * part of what navigating means (#712) — not something the call sites are
   * asked to remember.
   *
   * Two things have to happen together. The panel closes, because the URL is
   * about to name a page it does not belong to and nothing about it says which
   * page it was opened over. And the history entry opening it pushed is SPENT:
   * the destination REPLACES that entry rather than stacking in front of it, so
   * Back still leads to the page the panel was opened over instead of to a dead
   * entry that looks like a press doing nothing. When the destination is where
   * we already are there is nothing to replace it with, so the entry goes back
   * the way it came — `closePanel` is what does that, and it is reached for
   * rather than repeated so there is one copy of the rule.
   *
   * It lives HERE rather than at the callers because the caller that broke this
   * never knew the rule existed: the ⌘K palette binds its shortcut on `window`
   * and `inert` stops focus and clicks but not a window listener, and its dialog
   * portals to `document.body` above the panel — so it was the one thing that
   * could still reach `navigate` from behind an open panel, and picking a result
   * changed the board's URL underneath it. Anything wired up next is correct
   * without having to know any of that.
   *
   * `useCallback` so the identity is stable for `TopBar` and for the panel
   * context below; every dependency is a ref or a stable setter.
   */
  const navigate = useCallback((next: Route, preservedSearch?: string) => {
    next = bindRouteTarget(next);
    const carried = new URLSearchParams(preservedSearch);
    new URLSearchParams(targetQuery(next)).forEach((value, key) => carried.set(key, value));
    const path = preservedSearch === undefined ? routePath(next) : routePathname(next) + (carried.size ? '?' + carried.toString() : '');
    const samePath = isCurrentPath(path);
    // The ref rather than `panel`, and not only to stay out of the deps: it is
    // the ENTRY that is being spent, and openPanel sets the two together.
    if (panelEntry.current) {
      if (samePath) {
        closePanel();
        return;
      }
      // Marked, unlike the entry it replaces (#823). The panel's own push is the
      // one entry this app makes that leads nowhere, and spending it on a real
      // destination turns it into one that does: behind it is the page the panel
      // was opened over.
      window.history.replaceState(WALKED_HERE, '', path);
      panelEntry.current = false;
      setPanel(null);
    } else if (!samePath) {
      window.history.pushState(WALKED_HERE, '', path);
    }
    setRoute(next);
  }, [closePanel]);

  const panelActions = useMemo(() => ({ open: openPanel }), [openPanel]);

  /** Where the nav goes for a tab — the SAME org, so a scope survives a tab
   *  change: from `/acme/repos`, Overview is `/acme/team` and not
   *  `/team` (#714). `routeOrg` and not `route.org`, so an issue page's source
   *  board org is never mistaken for the shell's scope. */
  function tabRoute(t: Tab): Route {
    const org = routeOrg(route);
    return org ? { tab: t, org } : { tab: t };
  }

  // Arriving anywhere closes the sheet — one rule for every way a route can
  // change (a nav item, a gotoPath, the browser's back button), because each of
  // them lands here with a fresh Route.
  useEffect(() => { setMenuOpen(false); }, [route]);

  useEffect(() => {
    const onPop = () => {
      // Back closes the panel (#712) — either the browser's, or ours consuming
      // the entry we pushed. Both land here, and both leave the board alone.
      panelEntry.current = false;
      setPanel(null);
      setRoute(parseRoute(window.location.pathname, window.location.search));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => { document.title = routeTitle(route); }, [route]);

  // Half of what the device remembers (#714): FORGETTING, when an org-scoped
  // address names no org. Asking for the union by name is what keeps it
  // reachable at `/` once an org has been opened.
  //
  // Remembering is deliberately not here. An address can name an org this board
  // has never heard of — one visit to a stale `/roadmap` bookmark wrote
  // `roadmap` into storage, and that device's `/` then opened a board refusing
  // itself on every tab, for good — so an org is remembered only once a narrowed
  // read on it came back served, which is a page's answer and not a route's
  // (`use-scope-state.ts`). `forgetOnRoute` holds the rule and is tested
  // without a browser.
  useEffect(() => { if (forgetOnRoute(route)) writeOrgPref(null); }, [route]);

  // Post-login deep-link replay (#79): the OAuth callback always redirects to
  // '/', so once the session probe succeeds, restore the URL stashed by
  // beginLogin(). Only from the bare landing path — a deliberately opened deep
  // link wins over a stale stash (which is consumed either way).
  useEffect(() => {
    if (session.kind !== 'ready') return;
    const saved = consumeReturnTo();
    if (!saved || window.location.pathname !== '/') return;
    // Restored through the same correction the mount does, not verbatim: a stash
    // written before #785 can hold `/projects`, which now resolves to Your work,
    // and replaying it verbatim would put back exactly the lying address bar the
    // mount rewrite exists to stop. The stashed query rides along untouched, for
    // the reason stated there.
    const q = saved.indexOf('?');
    const query = q === -1 ? '' : saved.slice(q);
    const next = parseRoute(q === -1 ? saved : saved.slice(0, q), query);
    // Carries state through, like the mount rewrite above (#823). This replaces
    // the entry the reader landed back on after signing in, which is the entry
    // the tab booted on — so there is nothing to carry, and saying so here keeps
    // the two rewrites reading the same way.
    window.history.replaceState(window.history.state, '', routePathname(next) + query);
    setRoute(next);
  }, [session.kind]);

  // Identity is read once on open. Subsequent probes follow an explicit
  // Account > GitHub action; ordinary reads report their own refusals.
  useEffect(() => {
    let alive = true;
    let sequence = 0;
    let mounted = false;
    let reasked = 0;
    const probe = (opening = false) => {
      const own = ++sequence;
      const identity = fetchMe();
      if (opening && route.tab === 'dashboard' && !route.org) {
        openingMine.current = startOpeningMine(githubRouteOrg(route) ?? undefined, resolvedTimezone());
      }
      return identity.then(
        (me) => {
          // The document's opening probe has answered, whatever it answered, so
          // no later read may call itself an opening read (`startOpeningMine`).
          probeAnswered.current = true;
          if (!alive || own !== sequence) return;
          reasked = 0;
          resetSessionExpiry();
          mounted = true;
          setSession({ kind: 'ready', me });
          setVerified(true);
          setCheckFailed(false);
          // NOT FOR THE OPENING CHECK (#1395). This event is what the surfaces a
          // check does not reauthorize listen to, and its whole job is to
          // invalidate data authorized under a PREVIOUS check (#892 review, C2).
          // On open there is no previous check in this document: a page is
          // holding either nothing or its own saved copy, which its own mount
          // read is already revalidating.
          //
          // Fired on the opening probe it did the opposite of its purpose. The
          // Repos map and an open board went back to loading placeholders the
          // moment the probe answered, every single time, and each of them
          // issued a second read — which is the reported bug on those two pages.
          // It was invisible while `App` remounted the content column on the
          // same event, because a fresh mount seeds its own epoch ref; taking
          // that remount out (it is what sent every read on the tab twice) is
          // what brought it into view.
          if (!opening) window.dispatchEvent(new Event(ACCESS_VERIFIED_EVENT));
        },
        (e) => {
          probeAnswered.current = true;
          if (!alive || own !== sequence) return;
          const mapped = mapError(e);
          if (mapped.kind === 'login' || mapped.kind === 'forbidden') { setSession(mapped); return; }
          // Finish a withdrawn identity read under the replacement generation.
          // This bounded retry never schedules a future access check.
          if (withdrawnRead(e) && reasked < WITHDRAWN_REASKS) { reasked += 1; void probe(); return; }
          if (!mounted) setSession(mapped);
          setCheckFailed(true);
          // The probe this failure belongs to may be the one a read asked for
          // (#1395). Re-arm that request, or a tab whose access really moved
          // asks once, never hears back, and stays quiet until a reload.
          resetIdentityRecheck();
        },
      );
    };
    const onGithubAction = () => {
      setVerified(false);
      setCheckFailed(false);
      forgetSensitivePayloads();
      void probe();
    };
    // A read came back authorized under access this app has not installed, so
    // the transport asked for the identity to be re-read (#1395,
    // `askForFreshIdentity`). The probe, and NOT the wipe above: the reader is
    // looking at their own last answer, and Artur's decision is that it stays,
    // marked stale, until a live read settles it. `claimFor` records the moved
    // key and the next read replaces what is on screen.
    //
    // Deliberately a second event rather than a second caller of
    // `board-github-changed`. That one means the reader just pressed something
    // on the Account page, where clearing out and starting fresh is the right
    // answer; this one means the server mentioned a change the reader did not
    // ask for.
    const onIdentityStale = () => {
      setCheckFailed(false);
      void probe();
    };
    window.addEventListener('board-github-changed', onGithubAction);
    window.addEventListener(IDENTITY_RECHECK_EVENT, onIdentityStale);
    if (!hintPreviewActive() && !savedSessionPending()) forgetSensitivePayloads({ preserveLiveMine: true });
    void probe(true);
    return () => {
      alive = false;
      window.removeEventListener('board-github-changed', onGithubAction);
      window.removeEventListener(IDENTITY_RECHECK_EVENT, onIdentityStale);
    };
  }, []);

  // The session died mid-session (#512). api.ts raises this once, however many
  // 401s land, so this handler runs once. It writes the return path FIRST —
  // synchronously, while the URL still says where the person was — and only
  // then moves the state. `sessionKind` is a ref because the subscription is
  // set up once and must read the CURRENT session, not the one it closed over.
  const sessionKind = useRef(session.kind);
  useEffect(() => { sessionKind.current = session.kind; });
  useEffect(() => {
    const onExpired = () => {
      if (sessionKind.current !== 'ready') return;
      saveReturnTo(window.location.pathname + window.location.search);
      setSession((s) => nextSession(s, 'expired'));
    };
    // A 401 that landed before this effect ran still counts.
    if (isSessionExpired()) onExpired();
    return onSessionExpired(onExpired);
  }, []);

  // The open sheet's keyboard contract (#608): Escape closes it and hands focus
  // back to the button that opened it, and opening it moves focus inside — a
  // sheet you can open but not reach is a menu only a mouse can use. The page
  // behind it does not scroll while it is up.
  useEffect(() => {
    if (!menuOpen) return;
    // The sheet itself takes focus, not its first button: focusing the wordmark
    // pops its tooltip over the nav, and Tab from the panel reaches the same
    // items in the same order anyway.
    sheet.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    const scrollWas = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Widen past the sheet's breakpoint and there is nothing left for an open
    // sheet to be — the sidebar is the desktop column again. Left open, its
    // scrim would sit in the shell's grid as a stray child (taking the 248px
    // column and pushing the content onto a second row), and the page behind it
    // would stay locked against scrolling. So crossing the line closes it, and
    // the cleanup below gives the page its scroll back.
    const sheetWidth = window.matchMedia(SHEET_QUERY);
    const onViewport = () => { if (!sheetWidth.matches) setMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    sheetWidth.addEventListener('change', onViewport);
    return () => {
      window.removeEventListener('keydown', onKey);
      sheetWidth.removeEventListener('change', onViewport);
      document.body.style.overflow = scrollWas;
    };
  }, [menuOpen]);

  // #1167 — the owner in the address that this render is about to refuse, and
  // where it went if board-service can prove it moved. ABOVE the gate below,
  // because the gate returns and a hook may not be reached conditionally; the
  // argument is null in every state that has no owner to ask about, which is
  // every state the gate answers.
  const refusedOwner = unreachedOwner(
    session.kind === 'ready' || session.kind === 'expired' ? session.me.github : undefined,
    githubRouteOrg(route),
  );
  const renamedTo = useOwnerRename(refusedOwner);

  // ABOVE THE GATE, because it is a hook and the gate below returns early.
  // Spelled against `session` rather than `me`, which is only narrowed past the
  // gate — `login`, `forbidden` and `error` name nobody, and read as "no
  // identity yet" here, so signing back in as the same person keeps the
  // generation it had.
  //
  // THE PERSON, NOT THE ACCESS CHECK (#1395). This was the address plus the
  // visibility key, on the argument that #892 moves that key when what the
  // person may see changes, and that a changed key must throw the tree away for
  // the same reason a changed address does. The key moved on every eight-hour
  // token refresh as well, though, so the argument was being applied to an event
  // it was never about: the tree was discarded, every page effect re-ran, and
  // the reader watched their board rebuild for no reason. `claimFor` is where a
  // genuinely moved key is answered now, against what is on the disk.
  //
  // The session hint id is in it because `claimFor` wipes on it: a different
  // session for the same address takes the cache, and a tree keyed only on the
  // address would be left standing over data that had just gone.
  const who = session.kind === 'ready' || session.kind === 'expired' ? session.me : null;
  const peopleGeneration = useIdentityGeneration(who ? who.email + ':' + (who.sessionHintId ?? '') : null);

  // Not authenticated: full-screen landing gate — NO app chrome/nav.
  //
  // THREE states reach it, and each of them is an ANSWER: the board asked who
  // this is and was told nobody, or not you, or that the question could not be
  // put. A full screen is the right size for those, because there is no board
  // behind them to keep.
  //
  // `loading` was the fourth until #1229, and it is the one that was not an
  // answer. It is the board with the question still in the air, and it drew the
  // same full-screen spinner — no nav, no page name, nothing to press — for one
  // round trip on every route, measured at shell depth 1.0 everywhere. It falls
  // through now: the shell mounts, and `RouteSkeleton` stands in the content
  // column until the probe speaks. `AuthScreen` has no `loading` view left to
  // render, so this cannot quietly grow back (`auth/AuthScreen.tsx`).
  //
  // An EXPIRED session is deliberately not this gate either (#512): swapping
  // the tree would throw away a half-written feedback message and any open edit
  // panel. The page stays; SessionNotice sits over it.
  if (session.kind === 'login' || session.kind === 'forbidden' || session.kind === 'error') {
    return <AuthScreen view={session} />;
  }
  // Cached shell labels are display-only; controls wait for session.me.
  const probing = session.kind === 'loading';
  const preview = session.kind === 'loading' && session.hint === true;
  const me = session.kind === 'loading' ? null : session.me;
  const shell = me ?? (preview ? openingShell : undefined);
  const expired = session.kind === 'expired';
  // A repo page is inside Repos (#575), so the map's nav item stays lit while
  // you are on one of its repos. Derived in route.ts so it is testable without
  // rendering the shell.
  const navTab = navTabFor(tab);
  // What the menu button prints on a phone, and — when it is non-null — the
  // signal that the page's drawn H1 would only say it twice (#608).
  const pageName = menuPageName(route);

  return (
    // Keyed on WHO the board is drawing for (#824), counted rather than named —
    // see `useIdentityGeneration`. It turns over in exactly one case: the board
    // is drawing for one person and the probe, or a re-check, comes back naming
    // somebody else. `claimFor` has already wiped the cache by then, and this is
    // what makes the tree wiped too, so the new person meets skeletons and their
    // own reads rather than the last person's figures. The same person keys the
    // same, so the ordinary case remounts nothing and the reads already in
    // flight are undisturbed — and the probe's FIRST answer is the ordinary
    // case, because nothing person-specific was drawn under it (#1229 step 1).
    <IdentityContext.Provider value={me}>
    <PeopleProvider enabled={!probing} key={peopleGeneration}>
    <SyncProvider enabled={!probing}>
    <CrumbTitleProvider>
    <RouteProvider route={route}>
    {/* Inside RouteProvider: the org the shell is narrowed to is read off the
        route, so this holds nothing of its own (#714). */}
    <OrgScopeProvider>
    {/* One tooltip delay/skin for the whole app (#334) — styled kit tooltips via <Tip>. */}
    <TooltipProvider delayDuration={300} skipDelayDuration={200}>
    {/* Both surfaces that open an area are inside this: the account menu at the
        foot of the sidebar, and the reference link inside Access & agents. */}
    <PanelActionsProvider value={panelActions}>
    <div className="shell">
      {/* The scrim only exists while the sheet is open, and only below 900px —
          it is the tap-anywhere-else dismissal, and it is what makes the sheet
          read as sitting over the page rather than beside it. `.side-scrim`
          keeps the arrow, as the area panel's backdrop does (#1023). */}
      {menuOpen && (
        <button
          type="button"
          className="side-scrim"
          aria-label="Close the menu"
          onClick={closeMenu}
        />
      )}
      {/* The board is INERT while a panel is open (#712), on both halves of the
          shell — the panel is a sibling, so there is no one ancestor to mark.
          Without it Tab walked straight out of the panel and onto the nav behind
          the scrim: Enter there navigated the board with the panel still up, two
          h1s in the document, and the pushed history entry left stranded. It is
          also what makes the panel's `aria-modal` true rather than a claim. */}
      <aside
        className={menuOpen ? SIDE_OPEN : SIDE_SHUT}
        id="shell-menu"
        inert={panel !== null}
        ref={sheet}
        // -1: never in the tab order, but the open sheet can be given focus, so
        // the next Tab lands on its first item rather than back at the page.
        tabIndex={-1}
      >
        <div className="side-logo">
          {/* The wordmark is the way home, and since #712 that is ALL it is: it
              used to double as the way out of the Admin Hub / Account / docs
              drill-in, which is exactly what that issue found — a way out you
              had to already know about. Those areas are a panel with an X now.
              The tooltip stays, for the smaller reason it was also there: a
              wordmark does not otherwise say it is a button. */}
          <Tip label="My work" side="bottom">
          <button
            type="button"
            className="side-logo-mark"
            onClick={() => navigate(tabRoute('dashboard'))}
            aria-label="Go to My work"
          >
            board<span className="dot">.</span>
          </button>
          </Tip>
          <ThemeSwitch />
        </div>

        {!shell ? <OrgSwitcherShape /> : shell.github && (
          <GithubConnection
            github={shell.github}
            disabled={probing}
            owner={githubRouteOrg(route)}
            // So the switcher does not say "No access" about the organisation
            // the page beside it has just called renamed and reachable (#1167).
            renamedTo={renamedTo}
            // The page you were on survives the switch; only what belonged to
            // the owner you left does not. `ownerSwitch` owns that rule (#892).
            navigate={(org) => navigate(ownerSwitch(route, org))}
          />
        )}
        <nav className="side-nav">
          {TAB_ORDER.map((t) => {
            const Icon = TAB_ICON[t];
            return (
              <button
                key={t}
                className={`side-item${navTab === t ? ' side-item-on' : ''}`}
                onClick={() => navigate(tabRoute(t), t === 'dashboard' && tab === 'dashboard' ? window.location.search : undefined)}
              >
                <span className="inline-flex items-center gap-[11px]">
                  <Icon size={17} />
                  {TAB_LABEL[t]}
                </span>
              </button>
            );
          })}
          {me?.github && githubRouteOrg(route) && <button
            type="button" className="side-item"
            onClick={() => openPanel({ area: 'organisation', section: 'goals' })}
          >
            <span className="inline-flex items-center gap-[11px]">
              <SlidersIcon size={17} />
              Organisation settings
            </span>
          </button>}
        </nav>

        {/* When the board last synced, in words. The row above keeps only the
            freshness dot and the refresh glyph on a phone (#608), so the sheet
            is where the sentence lives; above 900px the top bar says it in full
            and this is not rendered at all. */}
        <div className="side-sync">
          {probing ? <SyncShape /> : <SyncStamp />}
        </div>

        {/* identity is global chrome — it sits below the nav */}
        {probing ? openingShell && preview ? <SideAccount preview={openingShell} /> : <AccountShape /> : <SideAccount />}
      </aside>

      {/* The compact header no longer prints the page name; keep its H1 visible. */}
      <div className="shell-main" inert={panel !== null}>
        {/* One sticky band at the top of the content column (#512): when the
            session dies the bar sits above the top bar, in the same eyeline as
            the page title the person is already reading — not at the bottom,
            where a tall page can hide it below the fold. In flow, so it
            displaces the page rather than covering it. */}
        <div className={expired ? 'shell-top shell-top-alert' : 'shell-top'}>
          {/* NOT while a panel is open (#741 review). The panel draws its own
              copy, and leaving this one in the markup was measured at 1280 to
              put a SECOND Sign in on the screen: the panel is inset there, so
              46px of this 65px bar and the whole of its button sit in the right
              gutter, outside the panel and plainly visible. `elementFromPoint`
              at that button's centre answers `DIV.area-scrim`, whose onClick is
              `onClose` — so the reader sees two Sign in buttons, presses the one
              at the top of the screen, and loses the panel instead of signing
              in. `inert` keeps it out of the accessibility tree but not off the
              glass. At 390 the two bars coincide at y=0 and nothing shows, which
              is why only a browser at 1280 finds it.
              One notice in the DOM at a time; closing the panel puts this one
              back, and the shell's copy is unchanged in every other state. */}
          {!panel && <SessionNotice session={session} onSignIn={beginLogin} />}
          <ErrorBoundary>
            <TopBar
              route={route}
              onNavigate={navigate}
              pageName={pageName}
              menuOpen={menuOpen}
              onMenuToggle={() => setMenuOpen((o) => !o)}
              menuButtonRef={menuButton}
              savedData={!preview && staleReads}
              probing={probing}
            />
          </ErrorBoundary>
        </div>

        {/* Wrapped like every other page (#523). These two are opened first and
            most, and were the last two that could still take the shell down —
            nav, theme switch and all — on a malformed 200.

            Every page boundary carries a FALLBACK (#824 follow-up). The
            boundary's own default is `null`, which is right for the top bar
            above and wrong here: a caught page throw drew the shell with an
            empty body and no message, which reads as a board with nothing on it
            rather than as a render that failed. The top bar keeps the default
            on purpose. */}
        {/* NO `key` HERE (#1395). It was `preview ? 'saved-preview' :
            'verified-page'`, so the identity answer — the one event that ends
            the preview — remounted this whole subtree, and every page effect
            under it ran a second time. Measured on the audit's headless run:
            each of My work's reads went out TWICE on every open, the queue, the
            boards and the filter options alike, once from the preview mount and
            once from the remount. That took a warm open from 13 requests to 9.

            THE QUEUE READ WAS STILL SENT TWICE after that, from a second
            cause the key did not touch: React runs a child's effects before its
            parent's, so the Dashboard asked before `App` had published the
            speculative read to join, and gave up. #1409 ended it by letting
            whichever of the two asks first START that read — `startOpeningMine`
            above. A warm open makes 8 requests now, and
            `scripts/check-opening-reads.mjs` counts them.

            Nothing needed the remount. The preview and the verified page draw
            the same components from the same cache; what differs is `inert`,
            which is an attribute, and the reads, which revalidate on their own.
            Identity turnover is `peopleGeneration`'s job, above, and it still
            throws this tree away when the person really changes. */}
        <div data-board-content inert={preview}>
        {/* The probe has not answered, so the board knows neither who this is
            nor what Github has granted them, and every branch below asks one of
            those. The route's own skeleton stands here instead — the same
            silhouette the page draws while its read is pending, so what the
            probe settles is which page fills it, not what the screen looks
            like (#1229 step 1). */}
        {!me && !preview ? <RouteSkeleton route={route} /> :
        targetFailure && !refusedOwner ? (
          <GithubTargetState route={route} failure={targetFailure} />
        ) :
        me?.github && (!me.github.connected || me.github.owners.length === 0 || (githubRouteOrg(route) && !me.github.owners.some((o) => o.login.toLowerCase() === githubRouteOrg(route)?.toLowerCase()))) ?
          <GithubAccessState
            configured={me.github.configured}
            connected={me.github.connected}
            owner={githubRouteOrg(route) ?? undefined}
            renamedTo={renamedTo}
            // The page they asked for, under the name it answers to now.
            // `ownerSwitch` is the switcher's own rule (#892), so arriving by
            // this link and arriving by the switcher land on the same page.
            renamedPath={renamedTo ? routePath(ownerSwitch(route, renamedTo)) : undefined}
          /> : <>
        {tab === 'dashboard' && <ErrorBoundary fallback={PAGE_FALLBACK}><Dashboard takeOpeningMine={takeOpeningMine} /></ErrorBoundary>}

        {tab === 'people' && route.person && <ErrorBoundary fallback={PAGE_FALLBACK}><PersonPage key={JSON.stringify([route.org, route.person])} login={route.person} /></ErrorBoundary>}

        {tab === 'team' && <ErrorBoundary fallback={PAGE_FALLBACK}><TeamView /></ErrorBoundary>}

        {/* `route.project` guards this the way `route.repo` guards the repo page
            below: since #785 the projects tab is one board's page and nothing
            else, so a route with no board addresses no page. `route.ts` already
            resolves such a path to Your work, and this is the second half of the
            same pair — a route built in code rather than parsed cannot render a
            board page with no board. */}
        {tab === 'projects' && route.project != null && (
          <ErrorBoundary fallback={PAGE_FALLBACK}>
            <ProjectsView route={route} />
          </ErrorBoundary>
        )}

        {tab === 'repos' && <ErrorBoundary fallback={PAGE_FALLBACK}><ReposPage /></ErrorBoundary>}

        {tab === 'repo' && route.repo && (
          <ErrorBoundary fallback={PAGE_FALLBACK}><RepoPage repoRef={route.repo} /></ErrorBoundary>
        )}

        {tab === 'issue' && route.issue && (
          <ErrorBoundary fallback={PAGE_FALLBACK}><IssuePage issueRef={route.issue} /></ErrorBoundary>
        )}
        </>}
        </div>

      </div>

      {/* Over the board, never instead of it (#712). The page behind stays
          rendered with its nav intact, so closing puts you back where you were. */}
      {panel && (
        <AreaPanel
          panel={panel}
          org={githubRouteOrg(route) ?? null}
          // #741: the shell's own notice is behind this panel and inert while
          // it is open, so the panel draws its own from the same state.
          session={session}
          githubVerified={verified}
          githubCheckFailed={checkFailed}
          onSignIn={beginLogin}
          onClose={closePanel}
          onOpen={openPanel}
        />
      )}
    </div>
    </PanelActionsProvider>
    </TooltipProvider>
    </OrgScopeProvider>
    </RouteProvider>
    </CrumbTitleProvider>
    </SyncProvider>
    </PeopleProvider>
    </IdentityContext.Provider>
  );
}
