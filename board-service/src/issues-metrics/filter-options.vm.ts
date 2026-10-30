// Pure filter-options computation (#376). No I/O — the caller passes the already
// cached raw issue list and the cached project rollup (org+number+name), and this
// derives the org-wide sets a filter UI needs for autocomplete: the labels,
// assignees, and projects present across the tracked work. Runs off data the
// board already holds, so the endpoint costs no extra GitHub call.

import { RawIssue } from './issues-metrics.types';

/** The sets the shared IssuesViewer's filter chips autocomplete against.
 *  `labels` carry a `color` for parity with the issue-page label chips; the
 *  org-wide cached issue list has only names, so color is '' here (the Project
 *  page's own items carry real colors for display). */
export interface FilterOptions {
  labels: { name: string; color: string }[];
  assignees: string[];
  /** The boards a filter chip may name.
   *
   *  `org` is required, and it is what makes `number` readable at all (#697):
   *  a Github Projects number is unique only WITHIN an org, so the union
   *  `/api/projects` serves can hold two different boards both numbered 3.
   *  Together the pair addresses exactly one board; `number` alone addresses
   *  one per org and the menu used to offer the first of them only. A
   *  single-org deployment answers its one org on every entry, so nothing
   *  there changes except that the field is now said out loud. */
  projects: FilterProject[];
}

/** One board on the filter menu — the org-qualified address, plus its name. */
export interface FilterProject {
  org: string;
  number: number;
  name: string;
}

export function computeFilterOptions(issues: RawIssue[], projects: FilterProject[]): FilterOptions {
  const labels = [...new Set(issues.flatMap((i) => i.labels))]
    .sort()
    .map((name) => ({ name, color: '' }));

  const assignees = [...new Set(issues.flatMap((i) => i.assignees))].sort();

  // De-dupe boards by ORG AND number (a board can appear more than once across
  // the list query), then order by name for a stable autocomplete. The number
  // alone is not the board's identity across a union of orgs — keying on it
  // collapsed acme#3 onto globex#3 and served whichever came first,
  // which is a board silently missing from the menu (#697).
  const byBoard = new Map<string, FilterProject>();
  for (const p of projects) {
    const key = `${p.org}\u0000${p.number}`;
    if (!byBoard.has(key)) byBoard.set(key, { org: p.org, number: p.number, name: p.name });
  }
  // Sort is unchanged, and stable: two boards sharing a name keep the order the
  // union produced them in, which is the operator's configured org order.
  const projectList = [...byBoard.values()].sort((a, b) => a.name.localeCompare(b.name));

  return { labels, assignees, projects: projectList };
}
