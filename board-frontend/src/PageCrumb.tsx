/**
 * The one page breadcrumb (#382), in the content area (moved out of the top bar).
 * A quiet inline trail of a page's ANCESTORS — no current-page segment, because
 * the page's own name is the big H1 below it (PageHeading, #391, "T1"). Repeating
 * that name in the crumb was exactly what we struck out: the H1 names the page,
 * the crumb shows only how to get back up.
 *
 * So `trail()` returns ancestor segments only, and a page with no ancestor to
 * name gets no trail: Your work, Unit and Repos, which are the rail's own, and
 * since #785 a board page, whose ancestor was the Projects rollup and is gone.
 * Every returned segment with an in-app destination is a link (there's no
 * "current" segment to leave un-linked anymore); clicking it navigates via
 * `gotoPath`. This is the single breadcrumb style across every page.
 *
 * Having no ancestor is not the same as being top-level, and #823 is where the
 * two came apart: a board page is a page the reader drilled in to, and so is a
 * repo page, whose `Repos` crumb names the canonical list rather than the view
 * they left. Both fill this slot with something that is not a trail — a single
 * `← Back`, the control #664 built for an issue reached without a source board.
 * Where there is nothing to go back to, a repo or person page shows that same
 * control naming its ancestor instead, `← Repos` (#1047). `crumbSlot()` below
 * decides between the four, and is the pure function to test.
 */
import { Fragment, useEffect } from 'react';
import { Route, Tab, TAB_LABEL, routePath, gotoPath, walkedHere } from './route';
import { useRoute } from './route-ctx';
import { fetchProjects, type ProjectSummary } from './api/projects';
import { copyResponseDeadline } from './auth/response-deadline';
import { useResponseState } from './auth/use-response-state';
import { useAccessEpoch, useRenewalSignal } from './sync/sync-status';
import { FOCUS_RING } from './repos/controls';
import { tileOpens } from './repos/tile-nav';

/** One breadcrumb segment. `route` present ⇒ an in-app destination ⇒ a link. */
type Crumb = { label: string; route?: Route };

/** What the crumb slot holds on this route: an ancestor trail, a back control,
 *  the back control's shape naming where it goes when it cannot go back (#1047),
 *  or nothing at all. */
export type Slot =
  | { kind: 'trail'; crumbs: Crumb[] }
  | { kind: 'back' }
  | { kind: 'up'; label: string; route: Route }
  | { kind: 'none' };

/**
 * A route's ancestor path — never the current page itself (its name is the H1).
 * Returns [] for a top-level page, and PageCrumb then renders nothing.
 *
 * `projectName` (#422) is the resolved name of an issue's SOURCE project
 * (`route.project`), fetched async by the `PageCrumb` component below — pure and
 * unit-testable, so this stays a plain function rather than a hook. Absent
 * (loading or unresolved) falls back to the bare project number.
 */
export function trail(route: Route, projectName?: string): Crumb[] {
  switch (route.tab) {
    case 'people':
      return [{ label: TAB_LABEL.team, route: { tab: 'team', org: route.org } }];
    case 'team':
      // Unit is top-level (the per-member page was retired, #420) — no crumb.
      return [];
    case 'projects':
      // A board had ONE ancestor, the Projects rollup, and #785 deleted it. A
      // board page names no ancestor now — not because it stopped being a deep
      // page, but because there is no longer anywhere above it to send a reader:
      // the rollup was the only page dedicated to boards, and `/projects`
      // resolves to Your work. A crumb reading "Projects" that landed on Your
      // work would name a page that does not exist.
      //
      // It is still a deep page, and #823 is where that started mattering:
      // `isDeepPage` says so and `crumbSlot` gives it back. Overview lists every
      // board in its Projects block and is where the walk usually starts, but it
      // is not named here — a crumb reading "Overview" over a board would assert
      // the reader came through Overview, which is the claim #664 struck off the
      // issue page.
      return [];
    case 'issue':
      // An issue has ancestors only when it was opened from a project board
      // (`route.project`, #422) — that walk really happened, and the board crumb
      // retraces it. Every other entry point (pasted link, ⌘K, a queue row,
      // a repo tile) reaches the issue without passing through a board, so
      // asserting that ancestry was a claim about history that did not happen
      // (#664); those routes get no trail, and `crumbSlot` offers back instead.
      // The board's own `#number` is not a segment here: the H1 carries it inline
      // (#391), and this function returns ancestors only.
      // The "Projects" ancestor above the board came off with the rollup (#785),
      // for the reason on the case above. The BOARD crumb stays: that half of
      // the walk really happened and the board page it points at still renders.
      return route.issue && route.project
        ? [
            {
              label: projectName ?? `Project ${route.project}`,
              // `route.org` (#697) qualifies the number the walk really passed
              // through. Absent, the crumb is the one it has always been.
              route: { tab: 'projects', org: route.org, project: route.project },
            },
          ]
        : [];
    case 'repo':
      // A repo page is reached from the map, and the map is where it belongs —
      // one ancestor, linked, exactly as the issue crumb links Projects. The
      // repo's own `owner/name` is the H1, so it is not repeated here. A route
      // with no repo cannot resolve to a page at all, so it gets no crumb.
      //
      // Since #823 this is the COLD-LOAD answer rather than the usual one: it
      // names the whole map at its resting order, which is the right thing to
      // offer a reader who arrived on a pasted link and the wrong thing to offer
      // one who arrived from a narrowed view of it. `crumbSlot` prefers back
      // wherever there is an entry behind this one, and falls through to here,
      // drawing this one crumb as `← Repos` in the back control's shape (#1047).
      return route.repo ? [{ label: TAB_LABEL.repos, route: { tab: 'repos' } }] : [];
    default:
      // dashboard, repos, team — top-level, no ancestors. Admin Hub, the Account
      // pages and the API reference had cases here until #712; they are panel
      // areas now, where the rail names the area and the H1 names the section.
      return [];
  }
}

/**
 * Which tabs are a page a reader DRILLED IN to — reached from a list rather than
 * from the rail, and so one they need a way out of. The rail names Your work,
 * Overview and Repos; the other three are every page it does not (#823).
 *
 * Each answer is a predicate rather than a flag, because a tab with nothing to
 * resolve — `{ tab: 'repo' }` with no repo — is not a page at all: it draws
 * nothing and has nowhere to go back from. That is the guard `trail` applies one
 * case at a time.
 *
 * A `Record<Tab, …>` rather than a switch with a default, so a tab added later
 * does not fall silently into "not deep" and ship another page with no way out.
 * TypeScript refuses the missing key; nothing has to remember to look.
 */
const DEEP_PAGE: Record<Tab, (route: Route) => boolean> = {
  dashboard: () => false,
  people: (r) => !!r.person,
  team: () => false,
  repos: () => false,
  projects: (r) => !!r.project,
  repo: (r) => !!r.repo,
  issue: (r) => !!r.issue,
};

export function isDeepPage(route: Route): boolean {
  return DEEP_PAGE[route.tab](route);
}

/**
 * What the crumb slot holds (#664, #823). Three answers, in this order.
 *
 * A RECORDED WALK keeps its trail. An issue carrying `?srcProject=` really came
 * off that board (#422), the board's name says more than the word "Back", and
 * the link lands on the one page that number can mean. Nothing else on this
 * board records where the reader came from, so this is the one case.
 *
 * Otherwise a DEEP PAGE offers `← Back`, whenever there is an entry behind this
 * one. This is the case #823 was filed on, and it is a way back rather than a
 * way UP: the ancestor a crumb can name is the canonical list, and the reader
 * left a particular VIEW of it. Measured at 390x844 on 2026-09-04, walking from
 * `/acme/repos?owner=octocat` into a repo and pressing the `Repos` crumb
 * landed on `/repos` — 2 tiles in, 8 tiles out. `history.back()` from the same
 * place lands on the 2. A board page had neither control and offered nothing at
 * all.
 *
 * Scroll comes back with it, and only since #824. A crumb is a PUSH, so there is
 * no position to restore and the reader lands at the top whatever the browser
 * would have done; a back is a pop, and the browser restores the position if the
 * page has height by the time it tries. Before #824 the map refetched on mount
 * and had none — 354px in, 0px out — so this measurement read the same both ways
 * and this comment said the reader's place was lost either way. On a base that
 * paints from the cached payload it is 354px in and 354px out, measured twice.
 *
 * Failing both, a deep page loaded cold offers its one ANCESTOR, in the back
 * control's shape and under the ancestor's own name (#1047) — `← Repos` on a
 * repo page, `← Overview` on a person page. A pasted link has no entry behind
 * it, so `history.back()` there is a no-op in a fresh tab and a walk off the
 * site in a tab with history in front of it, and a control reading "Back" that
 * went to `/repos` would say the reader came from a page they never saw. So the
 * control is the same one in the same place however the reader arrived, and
 * its word is always true: "Back" where it goes back, the page's name where it
 * goes there instead. Until #1047 this case drew the plain one-crumb trail,
 * which read as a label and not as a way out. A board page has no ancestor to
 * name since #785, so it gets nothing, and an issue with no source board none.
 *
 * `canGoBack` is the caller's MEASURED fact, never read from history in here,
 * so every case below is decidable without a DOM.
 */
export function crumbSlot(route: Route, canGoBack: boolean, projectName?: string): Slot {
  const recordedWalk = route.tab === 'issue' && !!route.issue && !!route.project;
  const drilledIn = !recordedWalk && isDeepPage(route);
  if (drilledIn && canGoBack) return { kind: 'back' };
  const crumbs = trail(route, projectName);
  const [ancestor] = crumbs;
  if (drilledIn && crumbs.length === 1 && ancestor.route) {
    return { kind: 'up', label: ancestor.label, route: ancestor.route };
  }
  return crumbs.length ? { kind: 'trail', crumbs } : { kind: 'none' };
}

/**
 * Whether this entry was pushed by an in-board navigation, and so has a board
 * page behind it (`WALKED_HERE` in `route.ts`, which is where the whole argument
 * for a marker over `history.length` is written down).
 *
 * What it guarantees: `history.back()` is never a no-op and never leaves this
 * site, because the only entries carrying the marker are ones this app pushed on
 * top of another of its own. What it does NOT guarantee: that the entry behind
 * us is the list this page was opened from. A reader who walked board → issue
 * and pressed the issue's board crumb is on a marked board entry with the issue
 * behind it, and `← Back` returns them to the issue — the same thing the
 * browser's own back button does from that position, and the accepted cost of
 * not tracking history ourselves.
 */
function canGoBackNow(): boolean {
  return typeof window !== 'undefined' && walkedHere(window.history.state);
}

/** Resolve an issue route's SOURCE project number to its board name (#422), or
 *  `undefined` while loading / when there's no source project / on a fetch
 *  error / once the answer that named it has expired (#905) — `trail` falls back
 *  to the bare number in every one of those cases, so neither a slow lookup nor
 *  a withdrawn one ever blocks the crumb. */
function useSourceProjectName(number: number | undefined, org: string | undefined): string | undefined {
  // THE ROW, NOT THE NAME (#905, R3). A name is a string and the response
  // metadata `copyResponseDeadline` moves is keyed by object, so a held name
  // carries no deadline and nothing can withdraw it. The row comes out of the
  // marked response already carrying its lease, and `useResponseState` drops it
  // on that response's own clock. Nothing above does it for us: `IssuePage`
  // draws this crumb from its not-found branch too, and the shell re-checks
  // behind `hidden` rather than unmounting.
  const [held, setHeld] = useResponseState<ProjectSummary | null>(null, null);
  const renewal = useRenewalSignal();
  const accessEpoch = useAccessEpoch();
  // The address, twice, and they are not the same thing — `CommandPalette` makes
  // the same pair for the same reason. At RENDER, so a walk from one board's
  // issue to another's never paints the first board's name: an effect runs after
  // the browser has drawn, which is exactly that frame. In an EFFECT, so the row
  // is let go rather than kept aside for a return visit.
  const named = number !== undefined && held && atSourceAddress(held, number, org) ? held : null;
  useEffect(() => { setHeld(null); }, [number, org]);
  useEffect(() => {
    if (!number) return;
    let alive = true;
    // Deliberately UNSCOPED (#714). An issue takes no org shell, so there is no
    // scope to carry; the pair `(number, srcProjectOrg)` is the board's whole
    // address and `sourceProject` matches on both, so the union is exactly the
    // list that can hold it however the reader arrived.
    fetchProjects()
      .then((d) => {
        // The copy covers the rollback case: an answer marked sensitive with no
        // lease headers is marked but undated, and this carries the array's
        // reading onto the row either way.
        if (alive) setHeld(copyResponseDeadline(d.projects, sourceProject(d.projects, number, org) ?? null));
      })
      .catch(() => {
        // Falls back to the bare project number — no error state on a crumb. A
        // REFUSED renewal falls back to that too, and not one moment sooner: the
        // row it failed to replace keeps its own original deadline. No grace.
      });
    return () => { alive = false; };
    // Renewal and epoch, like every other sensitive holder: without them this
    // reads once per route and no renewal can ever replace the row. Clearing is
    // deliberately NOT done here — it blanked the crumb for the length of every
    // renewal request, which the browser gate measures.
  }, [number, org, renewal, accessEpoch]);
  return named?.name;
}

/**
 * Whether this board IS the one `?srcProject=` named (#697) — the ONE
 * comparison, used by the search below and by the hook's render-time fence, so
 * a held row and a chosen row can never disagree about which board that is.
 *
 * With an `org` the pair is the board's whole address and only that board
 * answers: an org holding no such number names NOTHING, and the crumb falls
 * back to the bare number rather than to a board the reader has never seen.
 * Without one the first match wins, which is what `/api/projects/:n` resolves
 * for the same URL — so a link shared before #697 names what it always named.
 *
 * Pure, so the choice is testable without the fetch around it.
 */
export function atSourceAddress(p: ProjectSummary, number: number, org?: string): boolean {
  return p.number === number && (!org || p.org === org);
}

/** The board that address names, out of whatever `/api/projects` answered. */
export function sourceProject(
  projects: ProjectSummary[],
  number: number,
  org?: string,
): ProjectSummary | undefined {
  return projects.find((p) => atSourceAddress(p, number, org));
}

/** That board's NAME. A projection off `sourceProject` rather than its own
 *  `.find`, so the hook above can hold the row — which carries the response's
 *  lease — while the trail goes on being handed a string. Two `.find`s here
 *  would be two answers to "which board", which is the drift #697 closed. */
export function sourceProjectName(
  projects: ProjectSummary[],
  number: number,
  org?: string,
): string | undefined {
  return sourceProject(projects, number, org)?.name;
}

/** The slot's own quiet register — shared by the trail and the back control so
 *  the two occupy the same line at the same weight. */
/**
 * `min-h-6` is on the SLOT rather than on the control inside it, so the two
 * things this slot can hold are the same height (#823). A 13px line is 19.5px
 * and the back control needs 24 to clear WCAG 2.5.8's hit target, and putting
 * the floor on one of them moved the H1 by 4.5px between a repo page reached
 * cold and the same page reached by walking — measured in Chrome, 119.5 to 124.
 * A page that moves depending on how you arrived at it is worse than a page
 * whose crumb line is 4.5px taller than it was.
 */
/** Exported because `ui/ProbeShell.tsx` draws the same slot empty while the
 *  identity probe is in flight, and the two must be one height (#1229 step 1). */
export const CRUMB_SLOT = 'mb-4 flex min-h-6 items-center text-[13px] text-muted';
const TRAIL = `${CRUMB_SLOT} flex-wrap gap-1.5 tabular-nums`;
/**
 * The back control's own additions to the slot's register (#823). None is
 * decoration.
 *
 * The negative left margin against `px-1.5`: the padding gives the pointer a
 * box either side of a 13px word, and the margin puts the arrow back at x=12,
 * where the trail's first crumb starts. Both measured in Chrome.
 *
 * `cursor-pointer`, because Tailwind v4's preflight leaves a `<button>` on the
 * default arrow — the same note `repos/OwnerPicker.tsx` and
 * `projects/ContributionTip.tsx` carry.
 *
 * `FOCUS_RING`, because Chrome's default ring is very nearly invisible on this
 * background; `repos/controls.ts` owns that argument and this is the only
 * keyboard affordance the control has. The `Repos` link it replaces on a walked
 * page had one by being a link. The transition names `color` alone rather than
 * `transition-colors`, which includes `outline-color` — a focus ring that fades
 * up from the tertiary grey is a ring arriving late on the one press that needs
 * it now. And the radius is spelt with a value: bare `rounded` computes to `0px`
 * against this Tailwind config, measured, so the ring would have squared off a
 * box nothing else here squares off.
 */
const BACK = `${CRUMB_SLOT} ${FOCUS_RING} -ml-1.5 cursor-pointer gap-1.5 rounded-[5px] px-1.5 transition-[color] hover:text-fg`;
const CRUMB_LINK = 'text-link transition-colors hover:text-fg';

export function PageCrumb() {
  const route = useRoute();
  const onIssue = route.tab === 'issue';
  const projectName = useSourceProjectName(
    onIssue ? route.project : undefined,
    onIssue ? route.org : undefined,
  );
  const slot = crumbSlot(route, canGoBackNow(), projectName);

  // A top-level page has no ancestors — its H1 alone is the identity.
  if (slot.kind === 'none') return null;

  // One back control is not a breadcrumb, so it is a button and carries no
  // `nav`/`aria-label="Breadcrumb"`. The arrow is decoration; the name is "Back".
  if (slot.kind === 'back') {
    return (
      <button type="button" onClick={() => window.history.back()} className={BACK}>
        <span aria-hidden="true">←</span>
        Back
      </button>
    );
  }

  // Loaded cold, so there is nothing to go back to (#1047): the same control in
  // the same place, naming the page it goes to instead. A link rather than a
  // button, because it has an address; `tileOpens` leaves every modified press
  // to the browser, so a new-tab press opens the ancestor. `w-fit` because an
  // `<a>` given `flex` stretches to the row, where the button did not, and the
  // hit target and the focus ring would have run the width of the page.
  if (slot.kind === 'up') {
    const link = routePath(slot.route);
    return (
      <a
        href={link}
        onClick={(e) => {
          if (!tileOpens(e)) return;
          e.preventDefault();
          gotoPath(link);
        }}
        className={`${BACK} w-fit no-underline`}
      >
        <span aria-hidden="true">←</span>
        {slot.label}
      </a>
    );
  }

  return (
    <nav
      aria-label="Breadcrumb"
      className={TRAIL}
    >
      {slot.crumbs.map((c, i) => {
        // Every ancestor with a destination is a link (no un-linked "current" now).
        const link = c.route ? routePath(c.route) : null;
        return (
          <Fragment key={i}>
            {i > 0 && <span className="opacity-40" aria-hidden="true">/</span>}
            {link ? (
              <a
                href={link}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.button !== 0) return;
                  e.preventDefault();
                  gotoPath(link);
                }}
                className={CRUMB_LINK}
              >
                {c.label}
              </a>
            ) : (
              <span>{c.label}</span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
