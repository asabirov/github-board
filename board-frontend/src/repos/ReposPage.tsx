import { badgeVariants } from '../ui/kit';
import { useBoardRead, useReadState } from '../cache/use-board-read';
import { scopeQuery } from '../api/core';
import { useReadSequence } from '../auth/use-read-sequence';
import { copyResponseDeadline } from '../auth/response-deadline';
import { useResponseDeadline } from '../auth/use-response-deadline';
import { useResponseState } from '../auth/use-response-state';
/** Repository search, ownership, health filters, and reading order share one map. */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { fetchRepos, fetchReposHealth, type ReposCiSpendView, type ReposPrFlowView, type ReposView } from '../api/repos';
import { drawable, type Recalled } from '../projects/projects-last-good';
import { saveRepos, savedRepos } from './repos-last-good';
import { forgetPayload, reposKey } from '../cache/payload-cache';
import { useLocationSearch } from '../location-search';
// #714 — the org the address narrowed to, and what the board says about it.
import { useScopeState } from '../org-scope/use-scope-state';
import { useOrgScope } from '../org-scope/OrgScopeProvider';
import { scopeRefusal, scopeWithdrawn, type ScopeRefusal } from '../org-scope/scope-copy';
import { ScopeRefusedState } from '../org-scope/ScopeRefusedState';
import { PageHeading, PAGE_WELL } from '../ui/PageHeading';
import { EmptyState } from '../ui/EmptyState';
import { useReportOutdated, useRenewalSignal, useAccessEpoch, useRefreshSignal } from '../sync/sync-status';
import { mayWrite, useMe, type Me } from '../use-me';
import { gotoPath, TAB_LABEL } from '../route';
import { FOCUS_RING, FOCUS_RING_WITHIN } from './controls';
import { Hint } from './repo-hint';
import { RepoTile } from './RepoTile';
import { OrderPicker } from './OrderPicker';
import { OwnerRow } from './OwnerRow';
import { decodeRepos, encodeRepos } from './repos-url';
import { LoadingStructure } from '../ui/LoadingStructure';
import {
  applyRepoLens, repoMetric, type RepoLens, type RepoLensData,
  healthMatch, healthFilterNotice, problemBadges, CLEAR_HEALTH_FILTER, type RepoHealthFilter,
  buildTiles,
  DEFAULT_ORDER,
  driOptionsFor,
  healthByRepo,
  type RepoOrderKey,
  type ReposHealth,
  noMatchTitle,
  NO_HEALTH,
  ownerControlOffered,
  ownerSlotFor,
  ownerSlots,
  scopeGapLines,
  repoRef,
  queueShare,
  SEARCH_KEY_HINT,
  tilesReady,
  visibleTiles,
  NO_MATCH_BODY,
} from './repos-vm';

/** The map runs the whole well, not the rail (#819) — it is measured in tile
 *  columns, so the cap's slack was a sixth column's worth of empty margin.
 *  `PAGE_WELL` says why board does not take the kit's `PageColumn` for this.
 *
 *  The page's two other states take it as well, and that argument does not
 *  reach them: a scope refusal and "unavailable" are sentences, not columns.
 *  They keep it anyway because they are the same page and its heading has one
 *  left origin — and it costs them nothing, since `EmptyState` centres its own
 *  text and the unavailable line is one short line rather than prose that
 *  wraps. A state that grew into a paragraph would want `PAGE_READING`. */
const ROOT = `${PAGE_WELL} pt-5 pb-[60px] max-[900px]:pt-3 max-[900px]:pb-10`;

/** Spacing separates the controls from the map — no rule under them, per the
 *  board's less-borders house rule. */
/** The controls row, and the gap above it.
 *
 *  `mt-[26px]` is the space under the page's H1. Below 900px there is no H1 to
 *  be under: #608 clips it to `sr-only` on a page whose heading only repeats the
 *  top bar's menu button, and a clipped heading is `position: absolute`, so it
 *  occupies no height and this margin was measuring from nothing — 26px of it
 *  plus the rail's own 12px of top padding, above the first thing on the page.
 *  Zeroed at exactly the width the heading stops drawing at, so the two cannot
 *  disagree; above 900px the heading is there and so is the gap, unchanged. */
const CONTROLS = 'mt-[26px] flex flex-wrap items-center gap-2 max-[900px]:mt-0';

/** The FilterBar's field shape (issues-viewer/FilterBar.tsx): borderless, the
 *  region's chrome tone, the icon inside, the input transparent. */
const FIELD = `flex min-h-9 w-[248px] flex-none items-center gap-2 rounded-[10px] bg-[var(--queue-chrome)] px-3.5 max-[560px]:w-full ${FOCUS_RING_WITHIN}`;
const INPUT =
  'min-w-[40px] flex-1 border-0 bg-transparent p-0 text-[13px] text-fg outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden';
const CLEAR =
  `flex size-4 flex-none cursor-pointer items-center justify-center rounded-[5px] text-muted hover:bg-[color-mix(in_srgb,var(--text)_7%,transparent)] hover:text-fg ${FOCUS_RING}`;
const KBD = 'flex-none rounded px-1 text-[11px] text-muted bg-[color-mix(in_srgb,var(--text)_7%,transparent)]';

const PROBLEM_BADGE = `min-h-6 cursor-pointer tabular-nums ${FOCUS_RING}`;

const ROW_END = 'ml-auto flex items-center gap-2.5';
/** One grid geometry, independent of the help tooltip. */
const GRID_COLUMNS = 'grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-3';
const GRID = `mt-[18px] ${GRID_COLUMNS}`;

/**
 * The scope lines above the grid (#718): the gap to the controls row is the same
 * 18px the legend and the held line take, and the type is `OrgScopeNotice`'s —
 * 12.5px at 1.5, in the tertiary tone, quiet and with no amber, for the reasons
 * written on that component.
 *
 * The values are repeated here rather than shared because that component takes
 * `OrgReadState[]` and draws ONE sentence from them; this page has two, over two
 * different org sets. What matters is single-sourced anyway — both sentences are
 * `auth/org-scope-copy.ts`'s, which is the rule `narrowed-surfaces.spec.ts`
 * enforces. If a third surface ever needs two lines, that component growing a
 * `sentences` prop is the move, and this constant goes with it.
 */
const NOTICE = 'mt-[18px] text-[12.5px] leading-[1.5] text-muted';

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-[15px] flex-none text-muted" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);
const XIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="size-2.5" aria-hidden="true">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

type Load = { kind: 'pending' } | { kind: 'ready'; view: ReposView } | { kind: 'failed' };

/** The waiting state as ONE value, not a fresh object per reset: React bails
 *  out of a `setState` to the identical value, so putting the page back to
 *  pending on mount — which the org-reset effect below does on its first run —
 *  costs no render at all. */
const PENDING: Load = { kind: 'pending' };

/**
 * May this person actually change a repo's owner? `mayWrite` (`use-me.ts`) is
 * the whole answer, and all this adds is the name of the write: `repo.dri`,
 * the key board-service's `@Writes(...)` decorator gives it. Both halves and
 * why they are those halves are stated there, once, rather than retyped at
 * every control that gates on a capability.
 *
 * The refused half bites now. It was unreachable for two tasks, because
 * `/api/auth/me` reports every capability as `unknown` while
 * `CAPABILITY_GUARD_ENFORCING` is false — the guard's deny branches log and let
 * the write through, so there was no refusal to report. Task 8 turned the flag
 * on, the same field started carrying real verdicts, and this line began to
 * bite with nothing here changed.
 *
 * The spec still carries it: a refusal only reaches the browser once the
 * board's credential has actually been refused something, so nothing on screen
 * would notice this half being deleted or hardcoded, and `ReposPage.spec.tsx`
 * asserts the inputs directly — which is also why this is exported rather than
 * inlined.
 *
 * This is credential-wide only, which is honest about what the board knows:
 * `/api/auth/me` reports no per-repo verdict, so a repo this credential in
 * particular cannot write is refused at the moment of writing rather than
 * greyed out in advance.
 */
export const canSetDri = (me: Me | null) => mayWrite(me, 'repo.dri');

export function ReposPage() {
  // The org the ADDRESS names, read straight off the context `useScopeState`
  // reads below rather than mirrored, so the two cannot disagree. It is needed
  // up here because the seed below is per org and the scope state cannot be
  // built until the load state exists.
  const { org: addressOrg } = useOrgScope();
  // The request URL includes the organization, so one scope cannot seed another.
  const [heldLoad, setLoad] = useReadState<Load, ReposView>(`/api/repos${scopeQuery(addressOrg ?? undefined)}`, view => ({ kind: 'ready', view }));
  const [savedCopy, setSavedCopy] = useState<Recalled<ReposView> | null>(null);
  const copy = drawable(savedCopy, addressOrg ?? null);
  const load: Load = heldLoad?.kind === 'ready' ? heldLoad
    : copy !== null ? { kind: 'ready', view: copy.value } : heldLoad ?? PENDING;
  useReportOutdated(load !== heldLoad && copy !== null);
  // Whether a LIVE narrowed read has answered. #714 remembers an org on the
  // strength of one coming back with rows, and a seeded page has not made that
  // read yet, so the copy on disk must not be what causes an org to be
  // remembered. Set beside `setLoad`, so the render it schedules reads it.
  const answered = useRef(false);
  // Whether there are rows ON SCREEN, from a live read or from the copy on disk
  // (#824). The failure handler below cannot read `load` for itself — its effect
  // is keyed on the refresh nonce, so the closure holds whatever the map was
  // when that effect was made — and this is the one question it has to answer.
  const holdsMap = useRef(load.kind === 'ready');
  // IndexedDB restoration can draw rows after mount, before the live read settles.
  holdsMap.current = load.kind === 'ready';
  // The map's second read (#571), held apart from the first because it is the
  // slow one — three org-level alert APIs and an Actions lookup per repo, while
  // the rows are one list call. `null` is "not landed", and every tile under it
  // says so rather than showing a zero it would have to correct.
  const [health, setHealth] = useState<ReposHealth>(null);
  // The orgs whose ALERT lists refused (#718), which only the health payload
  // names. The row read names the orgs whose enumeration failed, and the rows
  // themselves name the orgs whose ownership read did — three sources,
  // `scopeGapLines` folds them into the two sentences the page draws.
  const [unreadHealthOrgs, setUnreadHealthOrgs] = useResponseState<readonly string[] | null>(null, null);
  const refresh = useRefreshSignal();
  const accessEpoch = useAccessEpoch();
  const renewal = useRenewalSignal(); // reauthorize the map (#892 review, C2)
  const { me } = useMe();
  // The URL is READ here and never mirrored into state, which is the mechanism
  // `location-search.ts` exists for and the Unit page already uses. Held in
  // state it went stale on any navigation that fires no popstate — the
  // sidebar's own "Repos" item goes through App's `navigate`, which pushes and
  // re-renders without one, so from `/repos?order=recent&owner=octocat` a
  // press cleared the URL to `/repos` while the grid went on drawing Artur's
  // repos in push order. Read during render, ANY re-render refreshes it; the
  // subscription's only job is to make sure Back causes one.
  const search = useLocationSearch();
  // #714: the status the rows read was refused with, or null — the one thing
  // the frontend cannot know in advance. `/api/auth/me` carries `orgs`, but it
  // answers `[]` on a fixture board and `[]` is the board making no claim, so
  // whether this deployment serves the org in the address is learned HERE, from
  // the refusal, and nowhere else.
  const [refusal, setRefusal] = useState<ScopeRefusal | null>(null);
  // What the board has to say about that org: `scope-copy.ts`'s sentence, the
  // same one every other narrowed surface draws. The second argument is this
  // page's half of what the device remembers (#714): an org is remembered only
  // once a narrowed read on it came back with rows.
  const scope = useScopeState(refusal, load.kind === 'ready' && answered.current);

  // The previous org's map, and the previous org's refusal, both go the moment
  // the address names another org — before the new read lands, not after it.
  // Held, `/gtm/repos` → `/acme/repos` drew "This board does not cover
  // gtm" over a board that does cover acme, because nothing cleared the
  // 404 the last org left behind. Its own effect, keyed on the org ALONE: the
  // read below re-runs on the refresh signal too, and a Sync now has never
  // blanked this page (see the note on that effect).
  // The org this effect has already cleared for, and NOT a "have I run once"
  // boolean (#824). `main.tsx` wraps the app in `StrictMode`, which runs every
  // effect twice on mount: a boolean is spent by the first run and the second
  // one clears for real, which threw away the map the seed above had just put
  // on screen. Measured in a browser, not reasoned about — `/repos` drew
  // "Loading…" over a stored map of 8 repos until this held the org instead.
  // `undefined` is "has not run", which no org can be.
  const clearedFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // Nothing to clear on the way IN. This effect exists to drop the PREVIOUS
    // org's leftovers, and on mount there is no previous org: all four of these
    // were already at the value they would be set to, except the map, which was
    // just seeded from this org's own copy.
    if (clearedFor.current === undefined || clearedFor.current === scope.org) {
      clearedFor.current = scope.org;
      return;
    }
    clearedFor.current = scope.org;
    answered.current = false;
    holdsMap.current = false;
    setLoad(PENDING);
    setHealth(null);
    setUnreadHealthOrgs(null);
    setRefusal(null);
  }, [scope.org]);

  // Two reads, side by side and neither waiting on the other. Whichever lands
  // first is drawn with; the page is on screen as soon as the rows are.
  //
  // A REFUSED health read settles the map at `NO_HEALTH` rather than failing
  // anything: losing it costs the CI conclusion, and a page notice reports
  // the failed read (#1194). Settling at four zeros was a clean bill of
  // health for a map nobody could look at. Losing the rows still fails the view
  // — there is no map without them.
  //
  // Neither piece is reset when the refresh signal fires. The rows have never
  // been (a Sync now has never blanked this page), and blanking the health
  // would put the placeholder bars back across a map somebody is reading — and,
  // under the security order, take the grid away from them.
  /**
   * The access epoch (#892 review, C2) is in the deps below beside the refresh
   * nonce, and this is what makes the two behave differently.
   *
   * `ReposService` holds the map on ONE permission-sensitive state, beside the
   * security alerts and the Actions billing, so the whole payload is data a
   * re-checked visibility does not reauthorize. When the epoch moves the rows
   * and the health go off the screen before the new read is issued, and
   * `holdsMap` goes with them so a read that FAILS leaves the refused state
   * rather than the map the expired check authorized. A refresh nonce still
   * does none of that: it is a background poll over a map somebody is reading.
   */
  const rowsExpired = useResponseDeadline(load.kind === 'ready' ? load.view : null);
  const healthExpired = useResponseDeadline(health);
  const readKey = JSON.stringify([scope.org, accessEpoch]);
  const beginRows = useReadSequence(readKey);
  const beginHealth = useReadSequence(readKey);
  const seenEpoch = useRef(accessEpoch);
  if (seenEpoch.current !== accessEpoch || rowsExpired || healthExpired) {
    seenEpoch.current = accessEpoch;
    if (savedCopy !== null) setSavedCopy(null);
    holdsMap.current = false;
    answered.current = false;
    if (load.kind !== 'pending') setLoad(PENDING);
    if (health !== null) setHealth(null);
  }

  useEffect(() => {
    const acceptRows = beginRows();
    const acceptHealth = beginHealth();
    fetchRepos(scope.org ?? undefined).then(
      // The refusal is cleared on the way IN as well as on the way out: a read
      // that answered is the end of whatever the last one said.
      (view) => {
        if (!acceptRows()) return;
        saveRepos(scope.org, view);
        setSavedCopy(null);
        answered.current = true;
        holdsMap.current = true;
        setLoad({ kind: 'ready', view });
        setRefusal(null);
      },
      // #714: the refusal's STATUS is kept beside the load state, not on it,
      // because `ReposMap.spec.tsx` pins this handler's text — the claim it
      // holds is that a lost ROW read fails the view and a lost health read
      // does not, and widening `Load` broke the pin without touching the claim.
      //
      // WHICH of the two reads is load-bearing is what that claim is about, and
      // it is unchanged: this one fails the view and the health one never does.
      // What #824 splits is a case that did not exist when the claim was
      // written, because a first read and a refresh were the same thing then. A
      // lost row read still fails the view when there is nothing on screen yet.
      // Over a map somebody is reading it keeps the rows, which is the decision
      // every other surface on this board now makes about a background failure.
      //
      // With TWO exceptions, where the board has taken the map away rather than
      // failed to fetch it. A hiccup costs nothing; a withdrawal costs the map.
      // WHICH is which is `scopeWithdrawn`'s and no longer this page's (#860):
      // the same question was answered here and in `Pulse.tsx`, in two
      // hand-written expressions, and they drifted — a 503 was a hiccup here and
      // a withdrawal there, so one outage on `/gtm/team` cost the boards and
      // left the map beside them standing. Both surfaces ask the one predicate
      // now, so the two answers cannot differ again; `scope-copy.spec.ts` drives
      // every (org, status) pair either page can hand it.
      //
      // The two exceptions, unchanged, and written out there rather than here:
      // a 404 through the org gate NAMING the org, which is #714's — the board
      // has disowned it and rows held under that would leave `/gtm/repos`
      // asserting gtm's repos for as long as the tab stays open — and a 403,
      // which is #824's review and is the board declining to serve this READER.
      // A 503 is neither: the board SERVES the org and its listing failed on
      // this build, which is what the failed branch below says, and reading it
      // as a withdrawal blanked a map somebody was reading and deleted the
      // stored copy under it.
      //
      // The 403 half needed `fetchRepos` to carry the status: a bare
      // `Error('forbidden')` names no number, `scopeStatus` read null out of it,
      // and with rows on screen this handler did nothing at all — no failed
      // state, no sentence, no tell.
      //
      // And the disk goes with the tab. Nothing removed the entry, so a reload
      // after either withdrawal put the whole map back and did it again on
      // every visit for the freshness ceiling's whole day.
      (e: unknown) => {
        if (!acceptRows()) return;
        setSavedCopy(savedRepos(scope.org, e));
        const refused = scopeRefusal(e);
        setRefusal(refused);
        const withdrawn = scopeWithdrawn(scope.org, refused);
        if (withdrawn) forgetPayload(reposKey(scope.org));
        // `holdsMap` means rows ON SCREEN, and the line below takes them off.
        // Left standing, the next failed read on this page would read "there
        // are rows" over a page drawing the refused state.
        if (withdrawn) holdsMap.current = false;
        if (withdrawn || !holdsMap.current) setLoad({ kind: 'failed' });
      },
    );
    fetchReposHealth(scope.org ?? undefined).then(
      // The second setter carries the orgs whose alert lists refused (#718). A
      // REFUSED read below names none of them — that is this board losing the
      // whole payload rather than one org going unread, and what says THAT is
      // the page notice accompanying `NO_HEALTH` (#1194).
      (view) => { if (acceptHealth()) { setHealth(healthByRepo(view)); setUnreadHealthOrgs(copyResponseDeadline(view, view.unreadableOrgs ?? [])); } },
      // The orgs go with the payload they came off (#718). Held, a Sync now
      // whose health read fails leaves the last read's sentence on screen —
      // naming one org's alerts — over a map whose whole health read failed.
      //
      // This is the one read on the allowlist that is NOT kept on disk (#824),
      // and this handler is why. `NO_HEALTH` exists because settling at four
      // zeros was "a clean bill of health for a map nobody could look at"; an
      // alert count restored from yesterday and drawn as current is the same
      // claim by another route. Every other surface here can afford to open on
      // an answer that is a few hours old. A security count cannot.
      () => { if (acceptHealth()) { setHealth(NO_HEALTH); setUnreadHealthOrgs(null); } },
    );
    // The ORG is in the key (#714): both reads carry `?org=` off the address, so
    // `/acme/repos` → `/globex/repos` is a different request and not a
    // re-render of the same one. Without it the tab never changed.
  }, [refresh, scope.org, accessEpoch, renewal, beginRows, beginHealth]);

  if (load.kind === 'pending') return <div className={ROOT}><PageHeading>{TAB_LABEL.repos}</PageHeading><LoadingStructure surface="repos" label="repositories" /></div>;
  if (load.kind === 'failed') {
    // #714/#718. `GET /api/repos?org=` narrows the map, and its gate refuses two
    // ways: 404 for an org this board does not serve at all, 503 for one it
    // serves and whose repo listing failed on this build. "Unavailable right
    // now" is true of the second and a lie about the first — the map is not
    // broken, the address named somebody else's org — and the two send a reader
    // to different places, so `scope-copy.ts` writes a sentence for each and
    // this page picks between them.
    //
    // The PAGE SHAPE survives either way. This returned a bare `state` div,
    // which replaced the whole body — no heading, no rail — and read as a render
    // that had failed rather than as an answer. The heading stays and the answer
    // goes in the content well, which is also where the way back to the union
    // lives: `App`'s `tabRoute` carries the org onto every sidebar link, so from
    // `/gtm` all four tabs stay inside gtm.
    return (
      <div className={ROOT}>
        <PageHeading>{TAB_LABEL.repos}</PageHeading>
        {scope.notice !== null && scope.org !== null ? (
          <ScopeRefusedState org={scope.org} notice={scope.notice} />
        ) : (
          <div className="state">The repo map couldn’t be read just now. Reload the page to try again.</div>
        )}
      </div>
    );
  }

  return (
    <ReposMap
      view={load.view}
      health={health}
      unreadHealthOrgs={unreadHealthOrgs ?? []}
      canWrite={canSetDri(me)}
      search={search}
      org={scope.org}
    />
  );
}

/**
 * The page's state: what has been typed, whose repos are showing, and which
 * order the tiles are in.
 *
 * Two of the three ride in the URL (#587, widened #583), because they are the
 * two a link has to reproduce: "the repos we pushed to this week" and "Ivan's
 * repos" are views you send somebody, and a reload that dropped them would be a
 * view you cannot keep. The typed query does not, and nothing has asked it to.
 *
 * Those two are DERIVED from the query string on every render — the string
 * arrives as a prop from `ReposPage`, which reads it through
 * `useLocationSearch` — and are never copied into state. A copy is what this
 * page had, and a copy goes stale the moment the URL moves without a popstate:
 * pressing the sidebar's own "Repos" item bared the URL and left the grid
 * narrowed to whoever the link had named. The URL is the state; there is
 * nothing here to keep in step with it.
 *
 * They are written back together with `replace` — an in-page arrangement is not
 * a place you navigated to, so a session of trying orders and faces collapses
 * to one history entry and Back still leaves the page. Together matters: each
 * control writes the OTHER's value alongside its own, or choosing a face would
 * drop the order out of the link.
 */
export function ReposMap({
  view,
  health,
  unreadHealthOrgs = [],
  canWrite,
  search,
  org = null,
}: {
  view: ReposView;
  /** The health read, or `null` while it is still in flight (#571). */
  health: ReposHealth;
  /** The orgs the HEALTH read could not build for (#718). Defaulted, so a
   *  caller that has not read it draws the page it drew before. */
  unreadHealthOrgs?: readonly string[];
  canWrite: boolean;
  search: string;
  /** The org used by the metric reads, or null for the union. */
  org?: string | null;
}) {
  // Derive all URL controls from one parse.
  const fromUrl = useMemo(() => decodeRepos(search), [search]);
  const owner = fromUrl.owner;
  const orderKey = fromUrl.order ?? DEFAULT_ORDER;
  const healthFilter = fromUrl.health ?? 'all';
  const lens = fromUrl.lens ?? 'issues';
  const lensPath = `/api/repos/${lens === 'prs' ? 'pr-flow' : 'ci-spend'}${scopeQuery(org ?? undefined)}`;
  const { data: lensAnswer } = useBoardRead<ReposCiSpendView | ReposPrFlowView>(lensPath, lens === 'prs' || lens === 'ci-cost');
  const lensData = lensAnswer ? new Map(lensAnswer.repos.map(row => [row.full, row])) : undefined;
  const [query, setQuery] = useState('');
  const field = useRef<HTMLInputElement>(null);
  // Written on the press rather than from an effect, so the page only ever
  // touches the URL when somebody chose something: a mount that rewrote the
  // query string would strip any param this page does not know about. The write
  // is also the whole of the press — `gotoPath` announces the move and the read
  // above picks it up, so there is no second copy to set.
  const write = (next: { order: RepoOrderKey; owner: string | null | undefined; health?: RepoHealthFilter; lens?: RepoLens }) => {
    gotoPath(window.location.pathname + encodeRepos({ lens, ...next }), { replace: true });
  };
  const chooseOrder = (key: RepoOrderKey) => write({ order: key, owner, health: healthFilter });
  const chooseOwner = (next: string | null | undefined) => write({ order: orderKey, owner: next, health: healthFilter });

  // `/` puts the cursor in the field from anywhere on the page — the shortcut a
  // search-first surface owes a keyboard, and the one every list on the web
  // uses. Never while something else is already taking typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (el?.isContentEditable) return;
      e.preventDefault();
      field.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={ROOT}>
      <PageHeading>{TAB_LABEL.repos}</PageHeading>
      <ReposBody
        view={view}
        health={health}
        unreadHealthOrgs={unreadHealthOrgs}
        canWrite={canWrite}
        query={query}
        owner={owner}
        orderKey={orderKey}
        lens={lens}
        lensData={lensData}
        onLens={lens => write({ order: DEFAULT_ORDER, owner, health: healthFilter, lens })}
        healthFilter={healthFilter}
        onHealth={(health) => write({ order: orderKey, owner, health })}
        onQuery={setQuery}
        onOwner={chooseOwner}
        onOrder={chooseOrder}
        fieldRef={field}
      />
    </div>
  );
}

export function ReposBody({
  view,
  health,
  unreadHealthOrgs = [],
  canWrite,
  query,
  owner,
  orderKey,
  onQuery,
  onOwner,
  onOrder,
  fieldRef,
  healthFilter = 'all',
  onHealth,
  lens,
  lensData,
  onLens,
}: {
  view: ReposView;
  /** The health read, or `null` while it is still in flight (#571). */
  health: ReposHealth;
  /** The orgs the HEALTH read could not build for (#718) — one of the three
   *  sources behind the page's scope lines. Defaulted to none. */
  unreadHealthOrgs?: readonly string[];
  canWrite: boolean;
  query: string;
  /** The login narrowing the map, `null` for the repos nobody owns, `undefined`
   *  for the whole map. */
  owner?: string | null;
  orderKey: RepoOrderKey;
  lens?: RepoLens;
  lensData?: ReadonlyMap<string, RepoLensData>;
  onLens?: (lens: RepoLens) => void;
  healthFilter?: RepoHealthFilter;
  onHealth?: (filter: RepoHealthFilter) => void;
  onQuery: (q: string) => void;
  onOwner: (owner: string | null | undefined) => void;
  onOrder: (key: RepoOrderKey) => void;
  fieldRef?: RefObject<HTMLInputElement | null>;
}) {
  // What the board could not read, in words (#718). Off the whole answer, never
  // off what a search left: a sentence about an org must not come and go as
  // somebody types.
  const gaps = scopeGapLines(view, unreadHealthOrgs);
  const healthFailed = health === NO_HEALTH;
  const reportedAlertOrgs = new Set(unreadHealthOrgs
    .filter(org => !view.unreadableOrgs?.some(absent => absent.toLowerCase() === org.toLowerCase()))
    .map(org => org.toLowerCase()));
  if (healthFailed) gaps.push('Repository health could not be read; sync again to retry security alerts and CI results.');
  const ordered = buildTiles(view, orderKey, health);
  const tiles = !lens ? ordered : lens === 'issues' && orderKey !== DEFAULT_ORDER
    ? ordered.map(tile => ({ ...tile, metric: repoMetric(tile, lens) }))
    : applyRepoLens(ordered, lens, lensData);
  // Off the WHOLE map, never off `shown`. A share read from what a search box
  // or a pressed face left would move under the reader: the same repo would be
  // heavy on one screen and ordinary on the next, and the number its hover
  // states would change with it. The org's shape is what the count is judged
  // against, and narrowing the grid does not change the org.
  const share = queueShare(tiles.map((t) => t.row));
  const slots = ownerSlots(tiles);
  // Resolved against the slots rather than trusted as given, so a link naming
  // somebody who owns nothing today shows the map instead of emptying it.
  const chosen = ownerSlotFor(slots, owner);
  const narrowed = visibleTiles(tiles, chosen, query);
  const shown = narrowed.filter(t => healthMatch(t, healthFilter) === 'match');
  const healthNotice = healthFilterNotice(narrowed, healthFilter);
  const problems = problemBadges(narrowed);
  // Health filters wait for observations; search and owner controls remain usable.
  const ready = tilesReady(healthFilter, health);
  // The legend belongs to the grid and waits with it, read off the tiles the
  // reader is actually looking at — a held grid draws no figure, and neither
  // does a map narrowed to repos with an empty window.

  return (
    <>
      <div className={CONTROLS}>
        <span className={FIELD}>
          <SearchIcon />
          <input
            ref={fieldRef}
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            // Escape clears what was typed rather than closing anything — there
            // is nothing here to close, and a search you can't empty from the
            // keyboard is one you have to reach for the mouse to undo.
            onKeyDown={(e) => { if (e.key === 'Escape') onQuery(''); }}
            placeholder="Search repos"
            aria-label="Search repos by name or description"
            autoComplete="off"
            spellCheck={false}
            className={INPUT}
          />
          {query.trim() ? (
            <button type="button" aria-label="Clear search" className={CLEAR} onClick={() => onQuery('')}>
              <XIcon />
            </button>
          ) : (
            <Hint label={SEARCH_KEY_HINT}>
              <kbd className={KBD}>/</kbd>
            </Hint>
          )}
        </span>

        {problems.map(problem => (
          <button key={problem.key} type="button" data-health={problem.key}
            aria-pressed={healthFilter === problem.key} title={problem.hint}
            className={`${badgeVariants({ variant: problem.key === 'secrets' ? 'danger-subtle' : 'warning-subtle' })} ${PROBLEM_BADGE} ${healthFilter === problem.key ? 'ring-1 ring-current' : ''}`}
            onClick={() => onHealth?.(healthFilter === problem.key ? 'all' : problem.key)}>
            {problem.label}
          </button>
        ))}
        {ready && healthFilter !== 'all' && !problems.some(problem => problem.key === healthFilter) && (
          <button type="button" className={`cursor-pointer text-xs text-dim text-link ${FOCUS_RING}`}
            onClick={() => onHealth?.('all')}>{CLEAR_HEALTH_FILTER}</button>
        )}
        <OwnerRow slots={slots} chosen={chosen?.login} onOwner={onOwner} />

        <span className={ROW_END}>
          <OrderPicker orderKey={orderKey} onOrder={onOrder} lens={lens} onLens={onLens} />
        </span>
      </div>

      {/* The orgs the board could not fully read (#718), under the controls row
          and above the grid — with what it qualifies, which is the reasoning
          `OrgScopeNotice` gives for not putting a line like this at the top of a
          page. Up to two sentences, because an org with no rows here and an org
          whose rows ARE here with something unread beside them are two different
          claims; `scopeGapLines` decides which, and `auth/org-scope-copy.ts`
          writes both.

          Nothing at all when there is nothing to say. There is no reassuring
          state to draw — the same rule `OrgScopeNotice` keeps. */}
      {gaps.length > 0 && (
        <section className={NOTICE}>
          {gaps.map((line) => <span key={line} className="block">{line}</span>)}
        </section>
      )}

      {/* A held health-filtered grid remains distinct from the empty state:
          unresolved rows are not filter results. Reuse the page loading shape
          without repeating the controls that are already usable above. */}
      {ready && healthNotice && <p role="status" className={NOTICE}>{healthNotice}</p>}
      {!ready ? <LoadingStructure surface="repos" label="repository health" reposControls={false} /> : shown.length > 0 ? (
        <>
          {/* A sibling of the grid rather than a child: a text node inside
              `grid` would take a cell. */}
          <div className={GRID}>
            {shown.map((tile) => (
              // A tile's only writable thing is its owner, so `canWrite` here is
              // "may the owner be changed" — false for a viewer who may not
              // write, and false again where the org's `dri` property cannot take
              // a value from this board (#577, #649). The state is the row's own
              // org's, not the view's union: the union takes the first state
              // that is not `writable`, so one personal owner's `not-applicable`
              // hid the control on every org repo (#1444). Which writabilities those
              // are is `ownerControlOffered`'s question and is answered there,
              // in one place, rather than inline at this call site where it had
              // already grown a state at a time; the writability itself goes
              // down beside it, because the
              // tile has a different sentence to print for one of them.
              //
              // Withholding the control is not the only way the picker goes away.
              // `OwnerPicker` withholds it a second way, on the options being
              // empty — and the options are this repo's OWN org's, not the
              // union of every served org's (#728): the write gate compares
              // against one org's list, so offering more than that is offering
              // a login the press would be refused for. That second withholding
              // is worth stating plainly because it is a trade rather than a
              // free win:
              //
              // One failed schema read caches `{driOptions: [], ownerWritability:
              // 'unreadable'}` on the view for the whole REPOS_CACHE_TTL_MS, and
              // for that window every tile loses its picker with nothing on screen
              // saying why — while the board may be perfectly able to write. It
              // also strands `ownerWriteEnv`'s re-read-on-press, which exists so a
              // retry after a failed read can succeed: with no control there is no
              // press. Several things age that view out — Sync now, the TTL, a
              // roster-generation bump — so nobody is stuck permanently.
              //
              // Chosen anyway, because the alternative is a menu whose only row is
              // "No owner" — a control that cannot do the thing it is for, whose
              // one reachable action is destructive and, if the read recovers on
              // that very press, lands. A silent map beats that.
              <RepoTile
                key={tile.row.full}
                tile={tile}
                alertsReportedAbove={healthFailed || reportedAlertOrgs.has(repoRef(tile.row).owner.toLowerCase())}
                driOptions={driOptionsFor(view, tile.row)}
                canWrite={canWrite && ownerControlOffered(tile.row.ownerWritability ?? view.ownerWritability)}
                writability={tile.row.ownerWritability ?? view.ownerWritability}
                share={share}
              />
            ))}
          </div>
        </>
      ) : (
        <Nothing query={query} filtered={healthFilter !== 'all'} />
      )}
    </>
  );
}

function Nothing({ query, filtered }: { query: string; filtered: boolean }): ReactNode {
  return (
    <EmptyState
      className="mt-[18px]"
      icon={<SearchIcon />}
      title={filtered ? "No repo matches these filters" : noMatchTitle(query)}
      description={filtered ? "Try another health filter, owner, or search." : NO_MATCH_BODY}
    />
  );
}
