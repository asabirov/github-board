import { repositoryFilter } from '../auth/github-target';
/**
 * A thin, typed URL codec for the IssuesViewer's state (#376). The router is
 * path-only (see route.ts); this adds a query layer for the viewer alone, so a
 * filtered/grouped view is shareable and back-button friendly. `route.ts`
 * delegates to these at its parse/serialize choke-points; the viewer's hook uses
 * them directly against `location.search`.
 *
 * Defensive by contract: `decodeViewer` ignores unknown/stale params and returns
 * `{}` when it recognises none (so an unrelated query never fabricates a viewer);
 * `encodeViewer` omits every default so a pristine view stays a clean URL.
 */
import { isViewerSort, type ViewerSort } from './triage-sort';
import type { PersonalIssueType } from '../api/types';
import { DEFAULT_FILTERS, type FixedGroupDim, type GroupDim, parseBoardToken, type ViewerFilters } from './filter-group';
import { triageDim, triagePropertyOf } from './triage-labels';

export interface ViewerState {
  sort?: ViewerSort;
  /** free-text search — mirrors `filters.q` (kept equal), surfaced for the URL. */
  q: string;
  group: GroupDim;
  view: 'list' | 'board';
  filters: ViewerFilters;
}

/** The Project page leads with the board's Status grouping (#376 Task 7); the
 *  codec omits `group` from the URL when it equals this. */
export const DEFAULT_GROUP: GroupDim = 'status';

export const DEFAULT_VIEWER: ViewerState = {
  q: '',
  group: DEFAULT_GROUP,
  view: 'list',
  filters: { ...DEFAULT_FILTERS },
};

/** Every FIXED grouping the viewer can carry — the decode allow-list, and the
 *  same allow-list a stored arrangement is validated against (#463). The
 *  `triage:` groupings cannot be listed here (#1099): which properties exist is
 *  decided by the labels on Github, so `isGroupDim` below tests their shape
 *  instead. */
export const GROUP_DIMS: FixedGroupDim[] = ['type', 'project', 'repo', 'assignee', 'label', 'status', 'openclosed'];

/**
 * The grouping a value names, in the one spelling the rest of the app uses — or
 * `null` for a value that names none. Every `?group=` and every stored
 * arrangement is read through here.
 *
 * A `triage:` dimension passes on SHAPE, not on existence, and that is the whole
 * difference between the two halves. A fixed dimension is a closed list, so an
 * unknown one is a typo. A triage property is whatever the org has labelled, so
 * a dimension this page's issues do not carry is not wrong — it is a queue
 * filtered differently, or a link from a repo that labels its work. Both are
 * already handled downstream: `availableGroupDims` never offers a property the
 * data lacks, and `resolveGroupDim` falls off it onto the host's own lead,
 * exactly as a `?group=status` link does on a queue with no Status field.
 *
 * It NORMALISES rather than only accepting, which is what a hand-written
 * `?group=triage:Deadline-Class` needs: `availableGroupDims` offers the folded
 * `triage:deadline-class`, so a dimension merely validated in its original
 * spelling would pass every test here and then fall off `resolveGroupDim` onto
 * the host's lead, which reads to a person as the link having been ignored.
 *
 * The fold is also the BOUND on what a stored arrangement may hold (#1108). A
 * grouping longer than any `triage:` label could name is not a grouping this
 * page can ever resolve, so `writeViewerPrefs` must not be able to park one in
 * `localStorage` in place of the arrangement that was there —
 * `MAX_TRIAGE_PROPERTY` is where that ceiling is derived.
 */
export function asGroupDim(v: unknown): GroupDim | null {
  if (typeof v !== 'string') return null;
  if ((GROUP_DIMS as string[]).includes(v)) return v as FixedGroupDim;
  const property = triagePropertyOf(v);
  return property === null ? null : triageDim(property);
}

/** Whether a value names a grouping this viewer could carry. The predicate half
 *  of `asGroupDim`, for the callers that only have to decide. */
export function isGroupDim(v: unknown): v is GroupDim {
  return asGroupDim(v) !== null;
}

/** Every `?tf=` value the decoder accepts; anything else falls back to 'any'. */
const TIMEFRAMES: ViewerFilters['timeframe'][] = ['opened-week', 'closed-week', 'closed-yesterday', 'aging'];
const KNOWN_PARAMS = [
  'q', 'group', 'view', 'sort', 'label', 'assignee', 'unassigned', 'project', 'board', 'repo', 'repoId', 'state', 'type', 'tf',
];

// A multi-select is carried as REPEATED params (`?label=a&label=b`), not a
// comma-joined value — Github label and project names can contain commas, and a
// joined-then-split codec corrupts them ("needs review, later" → two tokens).
// URLSearchParams encodes/decodes each value whole, so any value round-trips
// exactly. Empty tokens (a stale `?label=`) are dropped on decode.
const multi = (p: URLSearchParams, key: string): string[] => p.getAll(key).filter(Boolean);

/**
 * `defaultView` lets a host page (e.g. the Project page, board-by-default #429)
 * shift the "not worth writing to the URL" threshold to its own default instead
 * of the app-wide `list` — so landing on that default stays a clean URL, and only
 * a choice that DIFFERS from the host's default gets written (and therefore
 * survives reload/back). Omitted → the app-wide default, unchanged for every
 * existing caller.
 */
export function encodeViewer(s: ViewerState, defaultView: 'list' | 'board' = DEFAULT_VIEWER.view): string {
  const p = new URLSearchParams();
  if (s.sort === 'priority-size') p.set('sort', s.sort);
  if (s.q) p.set('q', s.q);
  if (s.group !== DEFAULT_GROUP) p.set('group', s.group);
  if (s.view !== defaultView) p.set('view', s.view);
  for (const l of s.filters.labels) p.append('label', l);
  for (const a of s.filters.assignees) p.append('assignee', a);
  // A boolean dimension (#462): written only when on, so it costs nothing in a
  // pristine URL, and read strictly — anything but `1` is off.
  if (s.filters.unassigned) p.set('unassigned', '1');
  for (const pr of s.filters.projects) p.append('project', pr);
  // `?board=` qualifies `?project=` rather than standing in for it (#782): a
  // board name is unique to nobody, and two orgs' "Roadmap" filtered and lit as
  // one board until the address travelled with the name. Repeated params for
  // `?label=`'s reason, and a token holds `/` on purpose — `URLSearchParams`
  // percent-encodes each value whole, so the address round-trips exactly.
  //
  // Written only beside the name it qualifies, which is what stops it outliving
  // one. The FilterBar's chip owns `projects` and knows nothing about addresses,
  // so dropping a chip leaves its token behind; carried forward, the token would
  // re-narrow the name the moment the reader picked it off the menu again — a
  // board they never pressed, chosen for them by a press they had undone.
  const named = new Set(s.filters.projects);
  for (const b of s.filters.boards) {
    const at = parseBoardToken(b);
    if (at !== null && named.has(at.name)) p.append('board', b);
  }
  for (const r of s.filters.repos) {
    const value = repositoryFilter(r);
    p.append(value.startsWith('id:') ? 'repoId' : 'repo', value.startsWith('id:') ? value.slice(3) : value);
  }
  if (s.filters.state !== 'open') p.set('state', s.filters.state);
  for (const t of s.filters.types) p.append('type', t);
  if (s.filters.timeframe !== 'any') p.set('tf', s.filters.timeframe);
  for (const [k, vals] of Object.entries(s.filters.customFields)) for (const v of vals) p.append('cf_' + k, v);
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

/** One reading of a `?query`, whether or not it arrives with its `?` — every
 *  question below is asked of the same string. */
const params = (search: string): URLSearchParams =>
  new URLSearchParams(search.startsWith('?') ? search : search ? `?${search}` : '');

/** Whether the URL names `view` explicitly, as opposed to `decodeViewer` filling
 *  it in from the app-wide default. `decodeViewer` can't surface this itself — it
 *  always resolves `view` to a concrete `'list' | 'board'` once ANY known param is
 *  present, so `list` there is ambiguous between "chosen" and "defaulted". A host
 *  with its own default (#429) needs the unambiguous version to know whether to
 *  override it. */
export function hasExplicitView(search: string): boolean {
  const p = params(search);
  return p.has('view');
}

/** The same signal for the grouping (#727), and it exists for the same reason:
 *  `decodeViewer` resolves `group` to `DEFAULT_GROUP` once ANY known param is
 *  present, so `/?label=bug` arrives claiming `status` — indistinguishable from
 *  somebody asking for status. A host that leads with its own grouping needs to
 *  sit above that fill-in without ever overriding a URL that names one. */
export function hasExplicitGroup(search: string): boolean {
  const p = params(search);
  return p.has('group');
}

/** Whether a query carries viewer state at all. A `cf_`-prefixed param
 *  (custom-field filter, #401) counts as recognised too, since its key is dynamic
 *  and can't live in KNOWN_PARAMS verbatim.
 *
 *  This is the "the URL is speaking for the viewer" test, and it's whole-state on
 *  purpose (#463): the codec omits every default, so a sender whose grouping was
 *  the default shares a URL that names only, say, `?label=bug`. Restoring a
 *  remembered grouping over that would show the receiver a different board than
 *  the link promised. */
export function hasViewerParams(search: string): boolean {
  const p = params(search);
  return KNOWN_PARAMS.some((k) => p.has(k)) || [...p.keys()].some((k) => k.startsWith('cf_'));
}

export function decodeViewer(search: string): Partial<ViewerState> {
  const p = params(search);
  // Nothing we recognise → not a viewer URL. Return {} rather than a defaults
  // object so an unrelated query can never masquerade as viewer state.
  if (!hasViewerParams(search)) return {};

  const q = p.get('q') ?? '';
  const sort = p.get('sort');
  const group = asGroupDim(p.get('group')) ?? DEFAULT_GROUP;
  const view = p.get('view') === 'board' ? 'board' : 'list';
  const filters: ViewerFilters = {
    ...DEFAULT_FILTERS,
    q,
    labels: multi(p, 'label'),
    assignees: multi(p, 'assignee'),
    unassigned: p.get('unassigned') === '1',
    projects: multi(p, 'project'),
    // Anything that is not an address is dropped here rather than downstream: a
    // token nothing can parse would qualify no name, which is the same answer,
    // but leaving it in the state means `encodeViewer` writes it back out and a
    // hand-edited URL survives every round trip.
    boards: multi(p, 'board').filter((t) => parseBoardToken(t) !== null),
    repos: [...multi(p, 'repo'), ...multi(p, 'repoId').map(id => `id:${id}`)],
    state: p.get('state') === 'all' ? 'all' : 'open',
    types: multi(p, 'type').filter((t): t is PersonalIssueType =>
      (['bug', 'feedback', 'feature', 'chore'] as string[]).includes(t),
    ),
    timeframe: TIMEFRAMES.includes(p.get('tf') as ViewerFilters['timeframe'])
      ? (p.get('tf') as ViewerFilters['timeframe'])
      : 'any',
    customFields: Object.fromEntries(
      [...new Set([...p.keys()].filter((k) => k.startsWith('cf_')))].map((k) => [k.slice(3), multi(p, k)]),
    ),
  };
  return { q, group, view, filters, ...(isViewerSort(sort) ? { sort } : {}) };
}
