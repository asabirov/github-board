/**
 * What the board draws while the identity probe is still in flight (#1229
 * step 1, #1187).
 *
 * `App` used to return a full-screen `AuthScreen` for every state that was not
 * `ready` or `expired`, so a browser with a live session met a spinner with no
 * nav, no page name and nothing to press for one round trip on every route —
 * measured at shell depth 1.0 everywhere. The shell goes up at parse time now,
 * and these are the shapes that stand in it until `/api/auth/me` answers.
 *
 * THE FURNITURE, NOT THE PERSON. That is the whole of why this step carries no
 * identity risk, and it is a rule about every shape in this file: nothing here
 * reads the cache, holds a figure, or names anybody. The account row, the
 * person's name and the org switcher are bars; the content column is the same
 * silhouette the route's own page draws while its read is pending. Painting a
 * remembered person's figures here is step 4 of the plan and needs the session
 * hint cookie the owner approved and which does not exist yet — a saved payload
 * says which person this device last belonged to and nothing about who is
 * holding it now, which is the argument `auth/session-state.ts` records #892
 * making, and it still holds.
 *
 * NOTHING HERE FETCHES, either. The probe is the only request the app makes
 * before it knows whose browser this is. Issuing the route's own read beside it
 * is step 1b of the same plan, and it has a transport rule of its own —
 * `apiFetch`'s `verified` argument holds the answer private until the probe
 * succeeds — which a skeleton reaching for data on its own would walk straight
 * past. So `PageCrumb` is a bar here rather than the real trail (on an issue
 * reached from a board it asks `/api/projects` for that board's name), and
 * `SyncStamp` is a bar rather than the chip (it reads `/api/sync/sources`).
 *
 * THE HANDOFF THIS FILE NAMED IS SETTLED. #1198 landed after #1233 and moved
 * the Issue route's shape here with it, which is what the pin between the two
 * files is for. The Issue page no longer draws a generic `LoadingStructure` in
 * a reading column while its read is pending — it draws `issue/IssueLoading`,
 * the issue page's own two-column silhouette — so this route draws that, from
 * the same file, rather than a second copy of it that could drift. What stays
 * this file's own is the crumb: the page draws the real `PageCrumb` there and
 * the probe cannot, for the reason above.
 *
 * Every root below is spelled the way the page it stands in for spells its own,
 * so the probe answering swaps a silhouette for a page rather than one layout
 * for another. `ProbeShell.spec.tsx` pins each against that page's source, and
 * `SHAPE` is a `Record<Tab, …>`, so a route added later cannot reach this file
 * without a skeleton: it fails to typecheck rather than opening on a white page.
 */
import type { ReactNode } from 'react';
import { BAR, LoadingStructure, Placeholder } from './LoadingStructure';
import { PAGE_RAIL, PAGE_WELL, PageHeading } from './PageHeading';
import { QUEUE_REGION } from './queue-region';
import { CRUMB_SLOT } from '../PageCrumb';
import { OverviewSkeleton } from '../projects/ProjectsView';
import { IssueLoading } from '../issue/IssueLoading';
import { TAB_LABEL, type Route, type Tab } from '../route';


/** The page roots, each spelled as its page spells it. */
const DASHBOARD_ROOT = `${PAGE_RAIL} pt-5 pb-[60px] max-[900px]:pt-3 max-[900px]:pb-10`;
const REPOS_ROOT = `${PAGE_WELL} pt-5 pb-[60px] max-[900px]:pt-3 max-[900px]:pb-10`;
const TEAM_ROOT = `${PAGE_RAIL} pt-5 pb-12 max-[900px]:pt-3 max-[900px]:pb-10`;
const PERSON_ROOT = `${PAGE_RAIL} flex flex-col gap-4 pt-5 pb-10`;
const PROJECTS_ROOT = `${PAGE_RAIL} pb-20 pt-[26px]`;
const ISSUE_ROOT = `${PAGE_RAIL} pb-24 pt-8 max-[900px]:pt-4`;

/** The crumb line's slot, holding a bar. It keeps the slot's own `min-h-6`, so
 *  the H1 under it sits where the drawn page will put it (#823 measured that
 *  4.5px and refused it). */
function CrumbShape() {
  return <div className={CRUMB_SLOT} aria-hidden="true"><Placeholder className={`h-3.5 w-24 ${BAR}`} /></div>;
}

/**
 * The org switcher's place in the rail, empty (`auth/GithubConnection.tsx`).
 *
 * Drawn on every probe, including on a board with no Github app configured,
 * where the answer turns out to be that there is no switcher. That is the
 * honest way round: the alternative is to know before the probe which rail this
 * person gets, and knowing that is the thing this step does not do.
 */
export function OrgSwitcherShape() {
  return <div className="mb-[14px]" aria-hidden="true">
    <div className="flex min-h-12 w-full items-center gap-2.5 rounded-[10px] px-3 py-2">
      <Placeholder className={`size-7 flex-none rounded-md ${BAR}`} />
      <Placeholder className={`h-3.5 w-28 ${BAR}`} />
    </div>
  </div>;
}

/**
 * The account row at the foot of the rail, empty (`SideAccount.tsx`). The
 * avatar, the name and the address are the three most person-specific things
 * the board draws, and they are three bars until the probe says whose.
 *
 * IT DOES NOT ANSWER TO `.side-acct`, and no shape in this file may (#1233).
 * `scripts/check-expired-panel.mjs` reads that class off the live page as proof
 * the probe has answered and then presses it for the account menu, and it gates
 * merges. A placeholder wearing it answers yes one round trip early, and the
 * guard presses a `div` with no menu behind it — guards went red that way on a
 * runner where the probe was slow. So this
 * row is drawn in utilities and borrows no class of that family, leaving the
 * selector to the thing that can be pressed; `app.css` states the rule beside
 * the class, and `ProbeShell.spec.tsx` holds the line.
 *
 * `.side-foot` stays. It is the rail's foot rather than the account block,
 * nothing reads it as identity, and the border it draws above this row is what
 * keeps the rail from changing shape when the probe answers.
 */
export function AccountShape() {
  return <div className="side-foot" aria-hidden="true">
    <div className="flex w-full min-w-0 items-center gap-[9px] rounded-[9px] px-1.5 py-1.5">
      <Placeholder className={`size-6 flex-none rounded-full ${BAR}`} />
      <span className="flex min-w-0 flex-col gap-1.5">
        <Placeholder className={`h-3 w-24 ${BAR}`} />
        <Placeholder className={`h-2.5 w-32 ${BAR}`} />
      </span>
    </div>
  </div>;
}

/** The sync chip's place in the top bar and in the phone sheet, empty
 *  (`topbar/TopBar.tsx`'s `SyncStamp`). */
export function SyncShape() {
  return <div className="flex min-w-0 items-center gap-1" aria-hidden="true">
    <Placeholder className={`size-7 flex-none rounded-md ${BAR}`} />
    <Placeholder className={`h-3 w-20 ${BAR}`} />
  </div>;
}

/**
 * The content column, per route.
 *
 * A `Record<Tab, …>` rather than a switch, so the census is the type system's:
 * adding a tab to `route.ts` without a shape here does not compile. The guards
 * on `route.repo`, `route.issue`, `route.person` and `route.project` mirror
 * `App`'s own — a route with no subject addresses no page there, and drawing a
 * skeleton for one would put a page up that then vanished.
 */
const SHAPE: Record<Tab, (route: Route) => ReactNode> = {
  dashboard: () => <div className={DASHBOARD_ROOT}>
    <PageHeading showScope={false} className="mb-[22px]">{TAB_LABEL.dashboard}</PageHeading>
    <LoadingStructure surface="work" label="your work" className="mb-3 min-h-[92px]" />
    <LoadingStructure surface="queue" housed label="your queue" className={`${QUEUE_REGION} min-h-[220px]`} />
  </div>,
  team: () => <div className={TEAM_ROOT}><LoadingStructure surface="overview" label="overview" /></div>,
  repos: () => <div className={REPOS_ROOT}>
    <PageHeading>{TAB_LABEL.repos}</PageHeading>
    <LoadingStructure surface="repos" label="repositories" />
  </div>,
  // `PersonPage` has no one pending state — it draws a card per section as each
  // read lands — so this is its first two: the name it takes from the address,
  // as a bar, and the assigned-issues silhouette it draws under it.
  people: (route) => route.person ? <div className={PERSON_ROOT}>
    <CrumbShape />
    <div className="flex items-center gap-3.5" aria-hidden="true">
      <Placeholder className={`size-12 flex-none rounded-full ${BAR}`} />
      <Placeholder className={`h-6 w-48 max-w-full ${BAR}`} />
    </div>
    <LoadingStructure surface="work" label="assigned issues" />
  </div> : null,
  // `OverviewSkeleton` with no `held`: the held header is the boards rollup on
  // disk (#879), and nothing on this screen is drawn off the disk.
  projects: (route) => route.project != null ? <div className={PROJECTS_ROOT}>
    <CrumbShape />
    <OverviewSkeleton />
  </div> : null,
  repo: (route) => route.repo ? <div className={PAGE_RAIL}>
    <div className="pt-8">
      <CrumbShape />
      <LoadingStructure surface="repo" label="repository" />
    </div>
  </div> : null,
  // `IssuePage`'s own pending branch, which is `IssueLoading` under the crumb
  // slot in the page's rail — the same component, not a copy of its shape.
  issue: (route) => route.issue ? <div className={ISSUE_ROOT}>
    <CrumbShape />
    <IssueLoading />
  </div> : null,
};

export function RouteSkeleton({ route }: { route: Route }) {
  return <>{SHAPE[route.tab](route)}</>;
}
