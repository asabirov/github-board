/**
 * The single hook that owns the IssuesViewer's state (#376) and keeps it synced
 * to the URL. Every change dispatches through the pure `viewerReducer` and writes
 * the next state back with `gotoPath`, so a filtered view is shareable and the
 * back button restores it.
 *
 * The URL is READ on every render rather than mirrored into state (#461) — see
 * `syncViewer` for the navigation that moves it without saying so, and
 * `location-search.ts` for the mechanism, which the Unit page's own half uses
 * too. What the hook does hold is the URL it last WROTE, which is how it tells a
 * URL of its own from one somebody else put there.
 *
 * The reducer, `initViewer` and `syncViewer` are pure and exported, so the state
 * transitions and the reconciliation are unit-tested without a DOM; the hook
 * itself is the thin React wrapper.
 */
import type { ViewerSort } from './triage-sort';
import { useCallback, useRef, useState } from 'react';
import { gotoPath } from '../route';
import { readSearch, useLocationSearch } from '../location-search';
import type { GroupDim, ViewerFilters } from './filter-group';
import { DEFAULT_VIEWER, decodeViewer, encodeViewer, hasExplicitGroup, hasExplicitView, hasViewerParams, type ViewerState } from './viewer-url';
import { toggleValue } from './controlled-filter';
import { isPrefAction, readViewerPrefs, writeViewerPrefs, type HostKey, type ViewerPrefs } from './viewer-prefs';

/** The multi-select filter dimensions the viewer can toggle values within. */
export type FilterDim = 'labels' | 'assignees' | 'projects' | 'repos' | 'types';

export type ViewerAction =
  | { type: 'setSort'; sort: ViewerSort }
  | { type: 'setQuery'; q: string }
  | { type: 'setGroup'; group: GroupDim }
  | { type: 'setView'; view: 'list' | 'board' }
  | { type: 'toggleFilter'; dim: FilterDim; value: string }
  /** The no-assignee dimension (#462) — a boolean, so it toggles rather than
   *  taking a value like the multi-selects above. */
  | { type: 'toggleUnassigned' }
  | { type: 'setState'; state: 'open' | 'all' }
  | { type: 'replace'; state: ViewerState }
  | { type: 'toggleCustomField'; slug: string; value: string }
  | { type: 'setTimeframe'; tf: ViewerFilters['timeframe'] };

/** Pure state transition — no mutation, no side effects. */
export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  switch (action.type) {
    case 'setSort':
      return { ...state, sort: action.sort };
    case 'setQuery':
      // Top-level `q` mirrors `filters.q` (filterIssues reads the latter) — keep them equal.
      return { ...state, q: action.q, filters: { ...state.filters, q: action.q } };
    case 'setGroup':
      return { ...state, group: action.group };
    case 'setView':
      return { ...state, view: action.view };
    case 'toggleFilter':
      return { ...state, filters: { ...state.filters, [action.dim]: toggleValue(state.filters[action.dim], action.value) } };
    case 'toggleUnassigned':
      return { ...state, filters: { ...state.filters, unassigned: !state.filters.unassigned } };
    case 'setState':
      return { ...state, filters: { ...state.filters, state: action.state } };
    case 'replace':
      return action.state;
    case 'toggleCustomField': {
      const cur = state.filters.customFields[action.slug] ?? [];
      const next = cur.includes(action.value) ? cur.filter((v) => v !== action.value) : [...cur, action.value];
      const customFields = { ...state.filters.customFields };
      if (next.length) customFields[action.slug] = next; else delete customFields[action.slug];
      return { ...state, filters: { ...state.filters, customFields } };
    }
    case 'setTimeframe':
      return { ...state, filters: { ...state.filters, timeframe: action.tf } };
  }
}

/** Full viewer state from a `?query`, filling defaults for anything absent.
 *  `defaultView` (#429) overrides the app-wide `list` default ONLY when the URL
 *  doesn't name a view itself — an explicit `?view=` still wins, so a host page
 *  can lead with board mode without hijacking a shared/back-button link. Can't
 *  lean on plain object-spread precedence here: `decodeViewer` fills `view` with
 *  its OWN default ('list') the moment any other known param is present, so a
 *  naive `{...decoded}` after the override would silently undo it.
 *
 *  `stored` (#463) is a host page's remembered arrangement, and sits BELOW the
 *  URL and ABOVE the defaults: URL → stored → page default → app default. It is
 *  applied only when the query carries no viewer state at all, so a shared link
 *  opens as the sender left it (see `hasViewerParams`). Pure — the hook reads
 *  storage and passes the result in.
 *
 *  `defaultGroup` (#727) is the group half of `defaultView`, and it needs
 *  `hasExplicitGroup` for exactly the reason `view` needs its twin: `decodeViewer`
 *  resolves `group` to the app-wide 'status' the moment ANY known param is
 *  present, so `?label=bug` would otherwise outrank the host's own lead. With it,
 *  the same four-step precedence holds for both halves by construction rather
 *  than by whichever dimensions the data happens to offer. */
export function initViewer(
  search: string,
  defaultView?: 'list' | 'board',
  stored?: ViewerPrefs | null,
  defaultGroup?: GroupDim,
): ViewerState {
  const decoded = decodeViewer(search);
  // A URL that speaks for the viewer silences storage whole, halves included.
  const prefs = hasViewerParams(search) ? null : stored;
  const view = hasExplicitView(search) ? decoded.view! : (prefs?.view ?? defaultView ?? DEFAULT_VIEWER.view);
  const group = hasExplicitGroup(search) ? decoded.group! : (prefs?.group ?? defaultGroup ?? DEFAULT_VIEWER.group);
  return {
    ...DEFAULT_VIEWER,
    ...decoded,
    ...(prefs?.sort ? { sort: prefs.sort } : {}),
    group,
    view,
    filters: { ...DEFAULT_VIEWER.filters, ...decoded.filters },
  };
}

/** The viewer's state together with the `?search` it belongs to. Pairing them is
 *  what lets the hook tell "the URL I just wrote" apart from "a URL somebody
 *  else wrote", which are the two cases that must behave differently. */
export interface OwnedViewer {
  search: string;
  state: ViewerState;
}

/**
 * The viewer reconciled against the URL as it is right now.
 *
 * This exists because the URL can move without the viewer hearing about it. The
 * hook used to hold its state in `useState`, seeded once and refreshed on
 * `popstate` alone — but `App.navigate` pushes history and re-renders WITHOUT
 * dispatching a popstate, so the viewer went on showing a selection the URL no
 * longer carried. On the Unit page that read as two answers to one question: the
 * tiles counted the whole unit while the queue below them still filtered to one
 * member, live assignee token and all, under a bare URL.
 *
 * `own.search === search` means the URL is the one this viewer last wrote, and
 * the held state stands — returned BY IDENTITY, so a commit that the codec omits
 * (a view equal to this host's default, say) is not thrown away on the popstate
 * that same commit fired. Anything else is a URL the viewer did not write, and
 * the URL wins: it is the shareable, reloadable statement of what is on screen.
 *
 * `stored` is a thunk rather than a value because it reads storage: a page that
 * remembers its arrangement would otherwise read it on every render, which on the
 * Project page is once per keystroke in the search box.
 */
export function syncViewer(
  own: OwnedViewer,
  search: string,
  defaultView: 'list' | 'board' | undefined,
  stored: () => ViewerPrefs | null,
  defaultGroup?: GroupDim,
): OwnedViewer {
  if (own.search === search) return own;
  return { search, state: initViewer(search, defaultView, stored(), defaultGroup) };
}

export interface ViewerControls {
  state: ViewerState;
  setSort: (sort: ViewerSort) => void;
  setQuery: (q: string) => void;
  setGroup: (group: GroupDim) => void;
  setView: (view: 'list' | 'board') => void;
  /** Toggle a value in a multi-select filter dimension (label/assignee/project/repo/type). */
  setFilter: (dim: FilterDim, value: string) => void;
  /** Turn the no-assignee filter on or off (#462). */
  toggleUnassigned: () => void;
  /** Switch the lifecycle filter (Open only / All). */
  setLifecycle: (state: 'open' | 'all') => void;
  /** Toggle a value in a custom field. */
  toggleCustomField: (slug: string, value: string) => void;
  /** Set the timeframe filter. */
  setTimeframe: (tf: ViewerFilters['timeframe']) => void;
}

/** `defaultView` (#429): a host page's own list/board default, used ONLY when the
 *  URL doesn't name a view (see `initViewer`). Threaded into `encodeViewer` too,
 *  so landing-on-default stays a clean URL and an explicit choice that departs
 *  from THIS page's default (not the app-wide one) is what gets written/reloaded.
 *
 *  `persistKey` (#463): opt in to remembering this page's arrangement. Given one,
 *  the grouping and the view are restored from storage on a bare visit and
 *  re-written whenever you deliberately change either. Omitted → the viewer
 *  behaves exactly as before, which is what every host but the Project page
 *  wants: the Unit queue shouldn't start remembering a grouping nobody asked it
 *  to keep.
 *
 *  A `HostKey` may be a LIST (#697) — the key to write plus the keys this page
 *  used to be stored under. Pass a stable one (memoise the array): it is a
 *  dependency of the reads below, and a fresh array each render would re-read
 *  storage and re-make `commit` on every pass.
 *
 *  `defaultGroup` (#727): the host's own grouping, used ONLY when the URL doesn't
 *  name one and nothing is stored. It is NOT threaded into `encodeViewer` the way
 *  `defaultView` is — that threshold exists for #429's clean-URL rule, and landing
 *  on a host default writes no URL either way, since `commit` runs only on a
 *  deliberate change. */
export function useViewerState(defaultView?: 'list' | 'board', persistKey?: HostKey, defaultGroup?: GroupDim): ViewerControls {
  // The URL is READ on every render, not mirrored into state and refreshed on
  // popstate — see `syncViewer` for the navigation that fires no popstate. The
  // subscription is only the signal that a re-render is needed; the value comes
  // from `location` itself, so any render at all sees the current URL.
  const search = useLocationSearch();
  const stored = useCallback(
    () => (persistKey ? readViewerPrefs(persistKey) : null),
    [persistKey],
  );
  const [own, setOwn] = useState<OwnedViewer>(
    () => ({ search: readSearch(), state: initViewer(readSearch(), defaultView, persistKey ? readViewerPrefs(persistKey) : null, defaultGroup) }),
  );
  const current = syncViewer(own, search, defaultView, stored, defaultGroup);
  // React's own "adjust state while rendering" — it discards this pass and
  // re-renders immediately, which beats an effect that would paint the stale
  // view first. Guarded by the identity `syncViewer` returns, so it cannot loop.
  if (current !== own) setOwn(current);
  const state = current.state;
  // A ref so `commit` always reads the latest state without re-subscribing.
  const ref = useRef(state);
  ref.current = state;

  const commit = useCallback((action: ViewerAction) => {
    const before = ref.current;
    const next = viewerReducer(before, action);
    ref.current = next;
    // In-page viewer changes replace the current history entry rather than
    // pushing one — a whole search/filter session stays a single entry, so
    // Back leaves the page instead of stepping back through every keystroke
    // (#376). A shared/deep-linked URL still hydrates the viewer on load.
    const nextSearch = encodeViewer(next, defaultView);
    gotoPath(window.location.pathname + nextSearch, { replace: true });
    // Claim the URL this write produced, so the popstate it fired reconciles to
    // "I wrote that" rather than re-deriving. It also carries the change when
    // `gotoPath` writes nothing at all, which happens whenever the codec omits
    // what changed — a view set back to this host's own default leaves the URL
    // bare and would otherwise never reach the screen.
    setOwn({ search: nextSearch, state: next });
    // Remember only a deliberate arrangement choice, and only on mount-free
    // moments — see `isPrefAction` for why arriving somewhere must not write.
    if (persistKey && isPrefAction(action)) writeViewerPrefs(persistKey, { group: next.group, view: next.view, sort: next.sort });
  }, [defaultView, persistKey]);

  return {
    state,
    setSort: useCallback((sort: ViewerSort) => commit({ type: 'setSort', sort }), [commit]),
    setQuery: useCallback((q: string) => commit({ type: 'setQuery', q }), [commit]),
    setGroup: useCallback((group: GroupDim) => commit({ type: 'setGroup', group }), [commit]),
    setView: useCallback((view: 'list' | 'board') => commit({ type: 'setView', view }), [commit]),
    setFilter: useCallback((dim: FilterDim, value: string) => commit({ type: 'toggleFilter', dim, value }), [commit]),
    toggleUnassigned: useCallback(() => commit({ type: 'toggleUnassigned' }), [commit]),
    setLifecycle: useCallback((s: 'open' | 'all') => commit({ type: 'setState', state: s }), [commit]),
    toggleCustomField: useCallback((slug: string, value: string) => commit({ type: 'toggleCustomField', slug, value }), [commit]),
    setTimeframe: useCallback((tf: ViewerFilters['timeframe']) => commit({ type: 'setTimeframe', tf }), [commit]),
  };
}
