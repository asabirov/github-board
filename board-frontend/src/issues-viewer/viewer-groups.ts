/**
 * The IssuesViewer's render-model (#376): turn a `ViewerIssue[]` + the current
 * filter/group state into the ordered, tone-tagged groups the List/Board views
 * paint. Pure — no component state, no DOM — so the viewer's behaviour (default
 * grouping, re-group on switch, a filter narrowing rows, the empty state) is unit
 * tested here, in the repo's pure-function style.
 *
 * The generic dimensions (type/assignee/label/project) run straight through the
 * foundation's `groupIssues`. `status` is special: it carries the board's Status
 * workflow — a fixed backlog→doing→review→done order, tone chips, a fallback for
 * items with no Status field, a stable full column set (so a filtered board keeps
 * its empty columns in the board view), sub-issue nesting, and the terminal-column
 * exemption from the Open filter (Done keeps its recently-closed items). This
 * preserves the Project page's `BoardBody` behaviour the viewer replaces.
 */
import { sortViewerIssues, type ViewerSort } from './triage-sort';
import { filterIssues, groupIssues, repoKey, type FixedGroupDim, type GroupDim, type ViewerFilters } from './filter-group';
import { triageDim, triageProperties } from './triage-labels';
import type { ViewerIssue } from './viewer-issue';
import type { Tone } from '../ui/StatusChip';

/** A rendered group: a stable key, a display label, a tone for its chip, and its
 *  rows (each with a nesting depth for sub-issues). */
export interface RenderGroup {
  key: string;
  label: string;
  tone: Tone;
  rows: { item: ViewerIssue; depth: number }[];
}

/** The Status field value for grouping, with a fallback so an item that carries
 *  none still groups (mirrors BoardBody.statusKey) instead of vanishing. */
export function statusKeyOf(i: ViewerIssue): string {
  return i.status || (i.state === 'closed' ? 'Closed' : 'Open');
}

/** Workflow order for the free-text Status field: backlog → doing → review →
 *  done. Terminal statuses (rank ≥ 5) keep their recently-closed items under the
 *  Open filter. */
export function statusRank(status: string): number {
  const s = status.toLowerCase();
  if (/todo|backlog|triage|new|ready|open/.test(s)) return 1;
  if (/progress|drafting|doing|started/.test(s)) return 2;
  if (/review|counsel|monitoring|qa/.test(s)) return 3;
  if (/done|closed|shipped|complete|merged/.test(s)) return 5;
  return 4;
}

export const isTerminalStatus = (status: string) => statusRank(status) >= 5;

/** Bucket a free-text Status into a tone. Review reads as brand (blue) so it
 *  stays distinct from In Progress (amber). */
export function toneOfStatus(status: string): Tone {
  const s = status.toLowerCase();
  if (/done|closed|shipped|complete|merged/.test(s)) return 'success';
  if (/block/.test(s)) return 'danger';
  if (/review|counsel|qa/.test(s)) return 'brand';
  if (/progress|drafting|monitoring|doing|started/.test(s)) return 'warning';
  return 'neutral';
}

/** The board's full, stable set of Status columns (from ALL items, so the set
 *  doesn't shrink as filters narrow), ordered by the workflow rank. */
export function orderedStatuses(issues: ViewerIssue[]): string[] {
  return [...new Set(issues.map(statusKeyOf))].sort(
    (a, b) => statusRank(a) - statusRank(b) || a.localeCompare(b),
  );
}

/** Order a group's issues so native Github sub-issues render indented directly
 *  under their parent; a child whose parent isn't in the same group falls back to
 *  top level, so nothing is hidden (one level deep in practice; walk handles more). */
export function orderNested(items: ViewerIssue[]): { item: ViewerIssue; depth: number }[] {
  const present = new Set(items.map((i) => i.number));
  const kids = new Map<number, ViewerIssue[]>();
  const roots: ViewerIssue[] = [];
  for (const i of items) {
    if (i.parent != null && present.has(i.parent)) {
      (kids.get(i.parent) ?? kids.set(i.parent, []).get(i.parent)!).push(i);
    } else {
      roots.push(i);
    }
  }
  const out: { item: ViewerIssue; depth: number }[] = [];
  const walk = (i: ViewerIssue, depth: number) => {
    out.push({ item: i, depth });
    for (const c of kids.get(i.number) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** The dimensions worth offering for this issue set, in menu order. `status`
 *  appears only when the data carries a real Status field; `project` only when
 *  issues carry cross-board membership (a single board's items don't — matching
 *  #379, so the Project home hides it); `repo` only when the set actually spans
 *  more than one repository (#661 — every issue carries a repo, so an ungated
 *  offer would hand a one-repo page a grouping with exactly one column).
 *  type/assignee/label always apply. */
export function availableGroupDims(issues: ViewerIssue[]): GroupDim[] {
  const dims: FixedGroupDim[] = ['status', 'openclosed', 'type', 'assignee', 'label', 'project', 'repo'];
  const offered: GroupDim[] = dims.filter((d) => {
    if (d === 'status') return issues.some((i) => i.status);
    if (d === 'project') return issues.some((i) => i.projects.length > 0);
    if (d === 'repo') return new Set(issues.map((i) => repoKey(i.repo))).size > 1;
    return true;
  });
  // #1099. Derived, not listed: one grouping per `triage:` property these labels
  // actually carry, so a family added on Github appears here on the next read
  // with nothing rebuilt. They sit directly after Label because that is what
  // they are made of — a reader looking for Size is looking where the label
  // dimensions are — and they are alphabetical among themselves so the menu does
  // not reorder itself as issues get labelled. See `triage-labels.ts` for which
  // label shapes name a property and which only imply one.
  const triage = triageProperties(issues.flatMap((i) => i.labels.map((l) => l.name))).map(triageDim);
  if (triage.length === 0) return offered;
  const afterLabel = offered.indexOf('label') + 1;
  return [...offered.slice(0, afterLabel), ...triage, ...offered.slice(afterLabel)];
}

/**
 * The grouping a viewer actually renders: the state's own dimension when this
 * data supports it, else the first of the host's leads that it does, else the
 * first dimension on offer — so nothing ever renders an empty grouping.
 *
 * `defaultGroup` is a LIST, best first (#727). Your work and the Unit queue lead
 * with `project` and fall back to `type`: their issues usually carry a board, and
 * a queue whose issues carry none must land on the grouping those two queues
 * showed before rather than on `dims[0]`, which is whatever `availableGroupDims`
 * happens to put first for that data — an order, not an answer anybody chose. A
 * single dimension is a list of one.
 *
 * It lives here, beside `availableGroupDims`, rather than inline in the JSX that
 * used to hold it: the suite has no DOM, so a pure function is
 * the only shape of this decision a test can reach.
 */
export function resolveGroupDim(
  group: GroupDim,
  dims: GroupDim[],
  defaultGroup?: GroupDim | readonly GroupDim[],
): GroupDim {
  if (dims.includes(group)) return group;
  const leads = typeof defaultGroup === 'string' ? [defaultGroup] : defaultGroup ?? [];
  return leads.find((d) => dims.includes(d)) ?? dims[0];
}

export interface ViewerRenderState {
  sort?: ViewerSort;
  group: GroupDim;
  filters: ViewerFilters;
}

/**
 * The ordered groups to render. Search/label/assignee/project/type/custom-field/
 * timeframe narrow the set; the Open/All lifecycle is applied here (not by the
 * pre-filter) so status can exempt its terminal columns. Status grouping returns
 * the full stable column set (empty columns included — the board view shows
 * them, the list view drops them); every other dimension returns only its
 * non-empty groups. `now` anchors the `timeframe` filter (#401) — default
 * `Date.now()` so callers don't need to thread it through unless a test wants a
 * fixed instant; this function computes no `now` of its own to pin.
 */
export function viewerGroups(issues: ViewerIssue[], vs: ViewerRenderState, now: number = Date.now(), timeZone = 'UTC'): RenderGroup[] {
  // Narrow by everything EXCEPT lifecycle (state) — that's applied per-group so
  // status can keep terminal columns populated.
  const narrowed = filterIssues(issues, { ...vs.filters, state: 'all' }, now, timeZone);
  // #407: the closed-week timeframe is lifecycle-crossing — it deliberately shows
  // issues closed in the last 7 days. `filterIssues` already honours that (it
  // bypasses the open gate for closed-week); this per-group open-only re-gate must
  // do the same, or it would strip exactly the closed rows the filter just kept.
  const openOnly = vs.filters.state === 'open' && vs.filters.timeframe !== 'closed-week' && vs.filters.timeframe !== 'closed-yesterday';

  if (vs.group === 'openclosed') {
    // The grouping IS the lifecycle split, so show both sides regardless of the
    // Open/All filter (the Project page's simplified two-group list). Open first.
    const split: { key: 'open' | 'closed'; label: string; tone: Tone }[] = [
      { key: 'open', label: 'Open', tone: 'neutral' },
      { key: 'closed', label: 'Closed', tone: 'neutral' },
    ];
    return split
      .map((s) => ({ ...s, items: narrowed.filter((i) => i.state === s.key) }))
      .filter((s) => s.items.length > 0)
      .map((s) => ({ key: s.key, label: s.label, tone: s.tone, rows: orderNested(sortViewerIssues(s.items, vs.sort)) }));
  }

  if (vs.group === 'status') {
    return orderedStatuses(issues).map((status) => {
      let g = narrowed.filter((i) => statusKeyOf(i) === status);
      if (openOnly && !isTerminalStatus(status)) g = g.filter((i) => i.state === 'open');
      return { key: status, label: status, tone: toneOfStatus(status), rows: orderNested(sortViewerIssues(g, vs.sort)) };
    });
  }

  const gated = openOnly ? narrowed.filter((i) => i.state === 'open') : narrowed;
  return groupIssues(gated, vs.group).map((grp) => ({
    key: grp.key,
    label: grp.label,
    tone: 'neutral' as Tone,
    rows: sortViewerIssues(grp.items, vs.sort).map((item) => ({ item, depth: 0 })),
  }));
}

/** Count each issue once even when it appears in several project or assignee groups. */
export function visibleCount(groups: RenderGroup[]): number {
  return new Set(groups.flatMap(g => g.rows.map(({ item }) => item.htmlUrl))).size;
}
