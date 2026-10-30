import { issueRepositoryFilter, ownerId, ownerName } from '../auth/github-target';
import { calendarDate } from '../flow-strip/calendar-day';
/**
 * The IssuesViewer's pure filter + group logic (#376). No component state, no
 * I/O — the viewer holds a `ViewerFilters` + a `GroupDim` and runs the fetched
 * `ViewerIssue[]` through these two functions to produce the rendered stacks.
 * All the correctness lives here, unit-tested against fixtures.
 */
import type { PersonalIssueType } from '../api/types';
import { deliveredCloseAt } from '../close-reason';
import {
  isTriageLabel,
  triageFacets,
  triagePropertyLabel,
  triagePropertyOf,
  triageValueLabel,
  triageValueOrder,
  triageValues,
  type TriageDim,
} from './triage-labels';
import type { ViewerIssue } from './viewer-issue';

/** The viewer's filter state. Multi-selects OR within a dimension; the
 *  dimensions AND together. `state` gates lifecycle (Open only / All). */
export interface ViewerFilters {
  /** free-text over title + `#number` */
  q: string;
  /** label names (OR) */
  labels: string[];
  /** assignee logins (OR) */
  assignees: string[];
  /** Only issues nobody is assigned to (#462). A boolean, not a value in
   *  `assignees`, because "no one" isn't a login — and because the two ARE
   *  separable dimensions: they AND like everything else, so turning both on
   *  narrows to nothing rather than quietly meaning "either". The Unit page's
   *  Unassigned tile drills in through this. */
  unassigned: boolean;
  /** Github Project names (OR) */
  projects: string[];
  /**
   * Board ADDRESSES qualifying `projects` (#782), one `<org>/<number>/<name>`
   * token each.
   *
   * A Projects v2 name is unique to nobody: two orgs can each hold a board
   * called "Roadmap", and `projects` — the dimension the FilterBar draws and the
   * queue matches on — cannot tell them apart. A token here says WHICH of the
   * boards wearing that name was meant, so a row is kept only when its own org
   * is one that was named.
   *
   * It qualifies rather than replaces: a name carrying no token here matches
   * exactly as it always did. That is what keeps the chip honest — it writes a
   * name and knows no address — and it is what an old shared link keeps doing.
   */
  boards: string[];
  /** Short repo keys (OR), e.g. 'board' (#472). The Repos map's rows link into a
   *  queue through this dimension, so a repo's row opens the board's own issue
   *  list rather than leaving for github.com. */
  repos: string[];
  /** Coarse work type (bug/feedback/feature/chore), OR within (#401) */
  types: PersonalIssueType[];
  /** Custom-field filters (#401): fieldSlug -> selected value names (OR within
   *  a field); an issue missing the field is excluded once that field is active. */
  customFields: Record<string, string[]>;
  /** Recency window (#401/#407/#478): 'opened-week' = created in the last 7 days;
   *  'closed-week' = closed in the last 7 days (lifecycle-crossing — see `matches`);
   *  'aging' = in the aging set the Oldest-open block counts. */
  timeframe: 'any' | 'opened-week' | 'closed-week' | 'closed-yesterday' | 'aging';
  state: 'open' | 'all';
}

export const DEFAULT_FILTERS: ViewerFilters = {
  q: '',
  labels: [],
  assignees: [],
  unassigned: false,
  projects: [],
  boards: [],
  repos: [],
  types: [],
  customFields: {},
  timeframe: 'any',
  state: 'open',
};

/** lowercase, non-alphanumeric runs → `-`, trim leading/trailing `-` (#401).
 *  MUST stay character-for-character identical to the backend's `slug()` in
 *  `board-service/src/projects/github-projects.source.ts` — a mismatch means a
 *  filter's slug won't match the issue's `customFields` key. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** slug -> display Title Case, e.g. `story-points` -> `Story Points`. Used
 *  in place of threading the field's original display name through, since
 *  `ViewerIssue.customFields` is keyed by slug only (#401). */
export function titleFromSlug(s: string): string {
  return s
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Normalise a repo reference to the short key the ingest stores (#472). An issue
 * carries either `owner/name` (a board's items) or the already-short key (a queue
 * row), and the Repos map hands out the short key — so both sides are folded to
 * the same thing before they are compared. MUST stay in step with the backend's
 * `shortRepoKey` (`issues-metrics/github-issues.source.ts`): drop the owner, drop
 * the `.example.com` suffix, case-fold.
 *
 * The rule is lossy the same way the backend's is (#484): two repos can fold to
 * one key, and this filter would then show both queues under either name. Since
 * the key is what a shared `?repo=` URL carries, it is left lossy on both sides
 * and the ingest reports a collision instead — `reportRepoKeyCollisions` in that
 * same backend file, which case-folds exactly as this does so a pair that
 * collides only here is reported too.
 */
export function repoKey(repo: string): string {
  return (repo.split('/').pop() ?? repo).replace(/\.example\.com$/i, '').toLowerCase();
}

/** A board's whole address (#697/#782) — the org it was read from, its number
 *  within that org, and the name it wears. Neither half of the address is unique
 *  on its own. */
export interface BoardRef {
  org: string;
  number: number;
  name: string;
}

/**
 * A board address as one URL-safe token: `<org>/<number>/<name>`.
 *
 * Parsed from the LEFT and only from the left. An org login holds no `/` and a
 * board number is digits, so the first two segments are fixed-shape and
 * everything after the second `/` is the name, verbatim — which is what a board
 * called "Q3/Q4 push" needs. A right-to-left split, or a `split('/')` taking
 * three parts, would cut that name in half and qualify nothing.
 *
 * Anything that is not that shape is `null` rather than a guess. A stale or
 * hand-edited token then qualifies no name, and the filter falls back to
 * matching the name alone — which is the answer it gave before addresses
 * existed, and never a narrower one.
 */
export function parseBoardToken(token: string): BoardRef | null {
  const m = /^([^/]+)\/(\d+)\/(.+)$/.exec(token);
  if (!m) return null;
  let org = m[1];
  if (org.startsWith('id:')) {
    try { org = ownerName(Number(org.slice(3))); } catch { /* Retain an unresolved ID; never fall back to a name. */ }
  }
  return { org, number: Number(m[2]), name: m[3] };
}

/** The token for a board, or `null` for a board that named no org — there is no
 *  address to write, and half of one would qualify nobody. That is the shape a
 *  board-api predating `org` (#697) still sends, and it degrades to the
 *  name-only filter it has always had. */
export function boardToken(at: { org?: string; number: number; name: string }): string | null {
  if (at.org === undefined || at.name === '') return null;
  const id = ownerId(at.org);
  return `${id ? 'id:' + id : at.org}/${at.number}/${at.name}`;
}

/**
 * Whether this row is on one of the boards the filter named under `name`.
 *
 * Three answers, and the order matters. A name nothing addressed is unqualified
 * and matches as it always did. A row whose own org is unknown is kept: a board
 * item carries no owner and neither does a queue row from a board-api predating
 * the field, and excluding it would be this filter hiding work on the strength
 * of something it was never told. Otherwise the row's org has to be one of the
 * orgs that was named.
 */
function onOneOfTheBoardsNamed(i: ViewerIssue, name: string, boards: readonly string[]): boolean {
  const orgs = boards
    .map(parseBoardToken)
    .filter((b): b is BoardRef => b !== null && b.name === name)
    .map((b) => b.org);
  return orgs.length === 0 || i.owner === undefined || orgs.includes(i.owner);
}

const WEEK_MS = 7 * 86_400_000;

/** The dimensions the viewer can stack by. Three are conditional, and
 *  `availableGroupDims` in viewer-groups.ts is what withholds them: `status`
 *  only when the data carries it (project items), `project` only when issues
 *  carry cross-board membership, `repo` only when the set spans more than one
 *  repository (#661 — every issue has a repo, so ungated it would offer a
 *  single-column grouping on a one-repo page). `openclosed` splits by lifecycle
 *  into Open/Closed (the Project page's simplified grouping, #376); the others
 *  apply to any list. */
export type FixedGroupDim = 'type' | 'project' | 'repo' | 'assignee' | 'label' | 'status' | 'openclosed';

/** Every grouping the viewer can carry. The fixed seven above, plus one per
 *  `triage:` property the labels actually carry (#1099) — `triage:size`,
 *  `triage:priority`, and whatever family somebody adds next, which is why this
 *  half of the union is a shape rather than a list. `availableGroupDims` is
 *  still what decides which ones a given set of issues is offered. */
export type GroupDim = FixedGroupDim | TriageDim;

/** One rendered stack: a stable `key`, a display `label`, and its issues. */
export interface IssueGroup {
  key: string;
  label: string;
  items: ViewerIssue[];
}

const labelNames = (i: ViewerIssue): string[] => i.labels.map((l) => l.name);
/** The labels the Label grouping stacks by: every label the parser does not
 *  read as a triage label (#1099). */
const ordinaryLabelNames = (i: ViewerIssue): string[] => labelNames(i).filter((name) => !isTriageLabel(name));

/** True when the issue satisfies every active filter dimension. A multi-select
 *  dimension matches when the issue carries at least one of the chosen values
 *  (OR); the dimensions combine with AND. An empty multi-select is inactive.
 *  `now` anchors the `timeframe` window (injected so it's deterministic in
 *  tests; callers default to `Date.now()`). */
function matches(i: ViewerIssue, f: ViewerFilters, now: number, timeZone: string): boolean {
  // #407: closed-week is a lifecycle-crossing recency window — it shows issues
  // closed in the last 7 days regardless of the Open/All state gate, so a user can
  // pick "Closed this week" alone (default state is 'open') and still see them.
  // Both windows read `deliveredCloseAt` and not `closedAt` (#1014). These two
  // are the ONLY close counts on this board that board-api does not filter
  // first — they select client-side over whatever list is loaded — so on
  // `closedAt` alone the drill-in behind a tile lists closes the tile above it
  // has stopped counting, which is the number and its own evidence disagreeing.
  if (f.timeframe === 'closed-yesterday') {
    const today = calendarDate(now, timeZone);
    const closed = calendarDate(Date.parse(deliveredCloseAt(i) ?? ''), timeZone);
    if (!(closed >= today - 86_400_000 && closed < today)) return false;
  } else if (f.timeframe === 'closed-week') {
    const delivered = deliveredCloseAt(i);
    if (!(i.state === 'closed' && delivered != null && Date.parse(delivered) >= now - WEEK_MS)) return false;
  } else if (f.state === 'open' && i.state !== 'open') {
    return false;
  }

  const q = f.q.trim().toLowerCase();
  if (q) {
    const hay = `${i.title} #${i.number}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }

  if (f.labels.length) {
    const names = new Set(labelNames(i));
    if (!f.labels.some((l) => names.has(l))) return false;
  }
  if (f.unassigned && i.assignees.length > 0) return false;
  if (f.assignees.length) {
    const login = (value: string) => f.timeframe === 'closed-yesterday' ? value.toLowerCase() : value;
    const who = new Set(i.assignees.map(login));
    if (!f.assignees.some((a) => who.has(login(a)))) return false;
  }
  if (f.projects.length) {
    const on = new Set(i.projects);
    if (!f.projects.some((p) => on.has(p) && onOneOfTheBoardsNamed(i, p, f.boards))) return false;
  }
  if (f.repos.length) {
    const key = repoKey(i.repo);
    if (!f.repos.some((r) => r.startsWith('id:') ? issueRepositoryFilter(i) === r : repoKey(r) === key)) return false;
  }
  if (f.types.length && !f.types.includes(i.type)) return false;

  for (const [k, vals] of Object.entries(f.customFields)) {
    if (!vals.length) continue; // inactive dimension
    const held = new Set(i.customFields?.[k] ?? []);
    if (!vals.some((v) => held.has(v))) return false; // issue lacking the field → excluded
  }

  if (f.timeframe === 'opened-week' && Date.parse(i.createdAt) < now - WEEK_MS) return false;
  // #478: the aging window. Deliberately NOT an age computed here — board-api
  // decides it (open flow work past the threshold, steady-state excluded) and
  // ships it per row, so this filter narrows to exactly the set the Oldest-open
  // block counts. Re-deriving it from `createdAt` is what made the two disagree.
  if (f.timeframe === 'aging' && !i.aging) return false;
  return true;
}

export function filterIssues(issues: ViewerIssue[], f: ViewerFilters, now: number = Date.now(), timeZone = 'UTC'): ViewerIssue[] {
  return issues.filter((i) => matches(i, f, now, timeZone));
}

/** One catalog entry for a filterable custom field: its slug, display name,
 *  and every value seen across the set with a count (#401). */
export interface CustomFieldFacet {
  slug: string;
  name: string;
  values: { name: string; count: number }[];
}

/** Union every issue's `customFields` into a per-slug catalog for the filter
 *  bar (#401): values sorted count-desc then name; facets themselves sorted by
 *  slug. The `status` slug is skipped — Status is already the board's dedicated
 *  column/grouping dimension (`ViewerIssue.status`), so surfacing it again as a
 *  custom-field facet would be a duplicate, confusing filter dimension. */
export function deriveCustomFields(issues: ViewerIssue[]): CustomFieldFacet[] {
  const bySlug = new Map<string, Map<string, number>>();
  for (const i of issues) {
    for (const [k, vals] of Object.entries(i.customFields ?? {})) {
      if (k === 'status') continue; // Status stays the column, not a facet
      const counts = bySlug.get(k) ?? bySlug.set(k, new Map()).get(k)!;
      for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  return [...bySlug.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([s, counts]) => ({
      slug: s,
      name: titleFromSlug(s),
      values: [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, count]) => ({ name, count })),
    }));
}

// ── grouping ────────────────────────────────────────────────────────────────
/** Fixed display order for the `type` dimension — shared with the FilterBar's
 *  Type sub-pane (#401) so grouping and filtering agree on order + labels. */
export const TYPE_ORDER: PersonalIssueType[] = ['bug', 'feedback', 'feature', 'chore'];
export const TYPE_LABEL: Record<PersonalIssueType, string> = {
  bug: 'Bugs', feedback: 'Feedback', feature: 'Features', chore: 'Other',
};

/** Group by a single-value dimension (`type` / `status`), preserving a fixed
 *  order for type and count-desc for the rest. Issues missing the value are
 *  dropped (Status-grouping shows no empty group; see the spec). */
function groupBySingle(
  issues: ViewerIssue[],
  keyOf: (i: ViewerIssue) => string | undefined,
): Map<string, ViewerIssue[]> {
  const map = new Map<string, ViewerIssue[]>();
  for (const i of issues) {
    const k = keyOf(i);
    if (!k) continue;
    (map.get(k) ?? map.set(k, []).get(k)!).push(i);
  }
  return map;
}

/** Group by a multi-value dimension (`label` / `assignee` / `project` / a triage
 *  property): an issue lands in every group it belongs to, so a 2-label issue
 *  appears twice — and an issue carrying NO value lands in none. `project`
 *  (#776), the triage properties and `label` (#1099) fill that hole with the
 *  trailing stack `withUnattached` adds; `assignee` still drops, which is what it
 *  has always done and what neither queue opens on. */
function groupByMulti(
  issues: ViewerIssue[],
  valuesOf: (i: ViewerIssue) => string[],
): Map<string, ViewerIssue[]> {
  const map = new Map<string, ViewerIssue[]>();
  for (const i of issues) {
    for (const v of valuesOf(i)) {
      (map.get(v) ?? map.set(v, []).get(v)!).push(i);
    }
  }
  return map;
}

/** How many repositories the `repo` grouping names before the rest fold into one
 *  trailing stack (#661).
 *
 *  This is a BOARD constraint leaking into a shared function, and it is worth
 *  naming as such. Board mode draws one column per group at a 210px floor, so an
 *  org-wide queue draws far more board than fits. Measured against the live org
 *  queue on 2026-08-21, in the browser at a 1440px viewport: without a limit, 45
 *  columns spanning 10,066px — seven screens. With this limit, 13 columns
 *  spanning 2,963px — just over two.
 *
 *  #674 asked for this number to be revisited once the card names its repository,
 *  which it now does. Re-measured on 2026-08-21 in the running app, at the 210px
 *  floor with the board's 14px gap: the queue region is 972px wide at a 1280px
 *  viewport and 1,120px at 1440px AND at 1920px — the shell caps it, so widening
 *  the window past 1440 buys no column. Four columns fit without scrolling at
 *  1280, five at 1440 and above. Thirteen columns span 2,898px (2.6 screens at
 *  1440); 44 unfolded span 9,842px (8.8).
 *
 *  #783 moved the ceiling and the last two sentences above are no longer true of
 *  a wide screen. Re-measured 2026-09-02 the same way — headless Chrome over CDP
 *  against the built `dist/` and `scripts/fixtures/team-api.json`, at
 *  `/team?group=label&view=board`, counting the columns wholly inside the
 *  scroller — the region is 972px at 1280 (four columns, unchanged to the pixel),
 *  1,132px at 1440 (five) and 1,612px at 1920 (SEVEN). The board is measured by
 *  the content column now, so a wider window does buy columns, and the thirteen
 *  still span 2,898px: 2.6 screens at 1440, 1.8 at 1920.
 *
 *  So the number stays at 12, for a reason that has changed twice. It used to be
 *  paid for in information: the card printed a bare `#number`, so a card in the
 *  trailing stack did not say where it came from. That cost is gone. What is left
 *  is scroll distance, and the screen no longer fixes it at five columns — the
 *  widest window here shows seven of thirteen, so raising the limit still
 *  lengthens the scroll and removing it still restores six screens of it at 1920
 *  and nine at 1440. Twelve is what keeps the fold within reach at BOTH widths,
 *  and 1280 — where nothing moved — is still the one that binds hardest.
 */
const REPO_GROUP_LIMIT = 12;

/** The trailing stack's key. A leading `/` is unreachable for a real group,
 *  because `repoKey` takes the last `/`-separated segment and so never returns a
 *  key containing one — this therefore cannot collide with a repository. */
export const REPO_REST_KEY = '/rest';

/** The trailing "on no board" stack's key and label under `project` grouping
 *  (#776). A GitHub Projects v2 title is free text, so no printable key can be
 *  proved unreachable the way `REPO_REST_KEY` can — the leading NUL is what a
 *  board title cannot carry, because nothing types one into the GitHub UI. The
 *  key is a React key and a group identity, never displayed; `NO_PROJECT_LABEL`
 *  is what a reader sees, and a board genuinely named "No project" would draw
 *  its own stack beside this one rather than merging into it. */
export const NO_PROJECT_KEY = '\u0000no-project';
export const NO_PROJECT_LABEL = 'No project';

/** The same trailing stack for a triage property (#1099), and it is here for
 *  #776's reason rather than by analogy to it: most issues in a queue carry no
 *  size and no priority, so a Size grouping that dropped them would draw four
 *  small stacks over a queue of a hundred and put "12 issues" in the header
 *  above them. The unlabelled work is the biggest thing this grouping has to
 *  say. Same unreachable key as the board above — a GitHub label cannot carry a
 *  NUL — so a family that genuinely spelled a value "No size" would draw its own
 *  stack beside this one rather than merging into it. */
export const noTriageKey = (property: string): string => `\u0000no-triage:${property}`;
export const noTriageLabel = (property: string): string => `No ${triagePropertyLabel(property)}`;

/** The same trailing stack under `label` (#1099), and it is the condition on
 *  which the Label grouping was allowed to stop listing `triage:*` at all. Once
 *  those have groupings of their own the Label grouping is about ordinary labels,
 *  but `groupByMulti` files an issue under every value it carries and an issue
 *  with none under nothing, so an issue wearing ONLY triage labels would have
 *  left the grouping with them. It stacks here instead, with every issue that
 *  never had a label. Same unreachable key again: a Github label cannot carry a
 *  NUL, so a label genuinely named "No label" draws its own stack beside this
 *  one rather than merging into it. */
export const NO_LABEL_KEY = '\u0000no-label';
export const NO_LABEL_LABEL = 'No label';

/** The trailing stack itself (#776): every issue `valuesOf` gave no value for,
 *  after the named stacks and outside their ranking, and no stack at all when
 *  there is no such issue. One function for `project`, the triage properties and
 *  `label`, so the three cannot drift apart on where the stack goes or when it
 *  is drawn. */
function withUnattached(
  named: IssueGroup[],
  issues: ViewerIssue[],
  valuesOf: (i: ViewerIssue) => string[],
  key: string,
  label: string,
): IssueGroup[] {
  const none = issues.filter((i) => valuesOf(i).length === 0);
  return none.length === 0 ? named : [...named, { key, label, items: none }];
}

/** Fullest group first, ties broken by key — the shared order for every
 *  count-ranked dimension. */
function byCountThenKey(a: [string, ViewerIssue[]], b: [string, ViewerIssue[]]): number {
  return b[1].length - a[1].length || a[0].localeCompare(b[0]);
}

/**
 * Stack one `triage:` property (#1099): a group per value the labels carry, then
 * everything carrying none.
 *
 * A stack's KEY is the folded value, so `triage:p0` from one repository and
 * `triage:P0` from another are one Priority stack and not two adjacent ones —
 * Github enforces label case-uniqueness per repository and this queue spans
 * repositories, so the two really do arrive together. Its HEADING is one
 * spelling picked by `triageValueLabel`, which is the other half of the same
 * invariant: nothing renders under a heading that is not a spelling of what is
 * in the stack.
 *
 * The values rank in the order the family declared, where it declared one —
 * Size reads XS to XL rather than fullest-first, because ranking a scale by
 * population puts XL between S and M. A value the family never declared, and
 * every value of a property nobody declared an order for, ranks fullest-first
 * after the declared ones, which is what every other count-ranked dimension
 * here does.
 */
function groupByTriage(issues: ViewerIssue[], property: string): IssueGroup[] {
  const valuesOf = (i: ViewerIssue) => triageValues(labelNames(i), property);
  const map = groupByMulti(issues, valuesOf);
  // Every spelling each stack's value arrived under, gathered before any heading
  // is chosen — the choice is a rule over the whole set, not the first row in.
  const spellings = new Map<string, string[]>();
  for (const i of issues) {
    for (const facet of triageFacets(labelNames(i), property)) {
      (spellings.get(facet.value) ?? spellings.set(facet.value, []).get(facet.value)!).push(facet.spelling);
    }
  }
  const order = triageValueOrder(property);
  const rank = (key: string) => {
    const at = order ? order.indexOf(key) : -1;
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const named = [...map.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || byCountThenKey(a, b))
    .map(([key, items]) => ({ key, label: triageValueLabel(property, key, spellings.get(key) ?? []), items }));
  return withUnattached(named, issues, valuesOf, noTriageKey(property), noTriageLabel(property));
}

export function groupIssues(issues: ViewerIssue[], dim: GroupDim): IssueGroup[] {
  if (dim === 'openclosed') {
    // Lifecycle split — Open first, then Closed; empty side dropped.
    const order: ('open' | 'closed')[] = ['open', 'closed'];
    return order
      .map((s) => ({ key: s, label: s === 'open' ? 'Open' : 'Closed', items: issues.filter((i) => i.state === s) }))
      .filter((g) => g.items.length > 0);
  }
  if (dim === 'type') {
    const map = groupBySingle(issues, (i) => i.type);
    return TYPE_ORDER
      .filter((t) => map.has(t))
      .map((t) => ({ key: t, label: TYPE_LABEL[t], items: map.get(t)! }));
  }
  if (dim === 'status') {
    const map = groupBySingle(issues, (i) => i.status);
    return [...map.entries()].sort(byCountThenKey).map(([key, items]) => ({ key, label: key, items }));
  }
  if (dim === 'repo') {
    // #661. The key is `repoKey`, the same normaliser the repo filter compares
    // with in `matches` above — so an issue carrying `owner/name` and one
    // carrying the short key group together instead of splitting into two
    // stacks under two spellings of one repository, and a group's key is
    // exactly what a `?repo=` link would carry for it.
    const map = groupBySingle(issues, (i) => repoKey(i.repo));
    const ranked = [...map.entries()].sort(byCountThenKey);
    const named = ranked.map(([key, items]) => ({ key, label: key, items }));
    // Folding one repository into "1 smaller repo" is strictly worse than just
    // showing it, so the tail has to be worth more than the column it costs.
    if (ranked.length <= REPO_GROUP_LIMIT + 1) return named;
    const tail = ranked.slice(REPO_GROUP_LIMIT);
    return [
      ...named.slice(0, REPO_GROUP_LIMIT),
      {
        key: REPO_REST_KEY,
        label: `${tail.length} smaller repos`,
        // Still ranked, so the tail's cards cluster by repository (fullest
        // first) rather than interleaving — the most attribution a stack can
        // carry while the card itself names no repo.
        items: tail.flatMap(([, items]) => items),
      },
    ];
  }
  const property = triagePropertyOf(dim);
  if (property) return groupByTriage(issues, property);
  // #1099. The Label grouping skips the `triage:*` labels, which have groupings
  // of their own now: measured on the fixture queue, they were thirteen of the
  // twenty-two stacks it drew over ten issues, all but one of them a stack of
  // one. The test for "is this a triage label" is the parser's own, and not a
  // prefix match written here — see `isTriageLabel` for why it must be the same
  // question. The Label FILTER is untouched: a filter hides no row it is not
  // asked to, and somebody hunting `triage:P0` by hand should still find it.
  const valuesOf =
    dim === 'label' ? ordinaryLabelNames : dim === 'assignee' ? (i: ViewerIssue) => i.assignees : (i: ViewerIssue) => i.projects;
  const map = groupByMulti(issues, valuesOf);
  const named = [...map.entries()].sort(byCountThenKey).map(([key, items]) => ({ key, label: key, items }));
  if (dim === 'label') return withUnattached(named, issues, valuesOf, NO_LABEL_KEY, NO_LABEL_LABEL);
  if (dim !== 'project') return named;
  // #776. `project` is what both queues now OPEN on (#727), so an issue on no
  // board being filed under nothing stopped being a quirk of one grouping and
  // became the default view of Your work hiding work. The reporter's queue drew
  // 8 of the 102 issues assigned to them, and `visibleCount` — which sums the
  // rendered rows — put "8 issues" in the header over it.
  //
  // Last, and outside the count ranking above: the boards are what the grouping
  // is FOR, so they lead however long this stack gets. #415 refused this
  // catch-all on the reading that a queue's issues are all on boards. On the
  // queue that reported this, 94 of 102 are not.
  return withUnattached(named, issues, valuesOf, NO_PROJECT_KEY, NO_PROJECT_LABEL);
}
