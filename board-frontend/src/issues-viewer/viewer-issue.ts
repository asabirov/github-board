/**
 * The shared IssuesViewer view-model (#376). The board has two divergent issue
 * shapes today — `ProjectItem` (a board's item, carrying a Status field) and
 * `PersonalIssue` (a queue row, carrying a derived `type`/`labels`/`projects`).
 * `ViewerIssue` is the one normalized shape the viewer's pure filter/group/render
 * logic sees, so the component never branches on where an issue came from.
 *
 * A `from*` adapter per source keeps the viewer source-agnostic. Optional fields
 * (`status`, `milestone`, `closedAt`, `lastActivity`, `parent`) are absent for
 * lists that don't carry them — e.g. `status` exists only for project items, so
 * the Status grouping option only appears where the data actually has it.
 */
import type { ActivityType, ProjectItem } from '../api/projects';
import type { IssueLabel, PersonalIssueType } from '../api/types';
import type { PersonalIssue } from '../api/issues';
import type { CloseReason } from '../close-reason';

export interface ViewerIssue {
  /** owner/name (or short key) of the issue's repo. */
  repo: string;
  /**
   * The Github org this row's repo belongs to (#782), when the source says.
   *
   * `repo` above cannot answer it: a queue row carries the SHORT key, with the
   * owner already dropped. The project filter needs it to tell two orgs' boards
   * of the same name apart — see `ViewerFilters.boards`.
   *
   * Absent for a board's own items, which are the board being viewed and carry
   * no `projects` to qualify, and for any source that does not say. Absent is
   * read as "unknown", never as "not that org": the filter keeps a row it was
   * told nothing about rather than hiding it.
   */
  owner?: string;
  number: number;
  title: string;
  /** Canonical Github URL — the row/card deep-links through it. */
  htmlUrl: string;
  state: 'open' | 'closed';
  assignees: string[];
  labels: IssueLabel[];
  /** Github Project name(s) this issue is on (queue rows carry these; a board's
   *  own items don't repeat their board name → []). */
  projects: string[];
  /** Coarse work type derived from labels (bug/feedback/feature/chore). */
  type: PersonalIssueType;
  milestone?: string;
  /** The board's Status field value — present only for project items. */
  status?: string;
  createdAt: string;
  /** Last time the issue itself changed. It was the Last-activity fallback until
   *  #822 replaced that column with an age off `createdAt`, so nothing in the app
   *  reads it today: both mappers still fill it, and it stays filled because it is
   *  the only "recent" signal the payload carries and the next surface that wants
   *  one should not have to re-plumb it. Kept, not read. */
  updatedAt?: string;
  closedAt?: string;
  /** WHY it closed (#1014), when the source says — the other half of the close
   *  the timeframe filters count, and read only through `deliveredCloseAt`.
   *
   *  Absent means count it, which is what `close-reason.ts` decides and not
   *  something a caller re-decides. Both sources fill it today — the queue rows
   *  and the board's own items — so absence is the deploy window alone, and the
   *  mappers never default it to `completed` on the way through: inventing a
   *  reason here would be the second definition this field exists to avoid. */
  stateReason?: CloseReason;
  lastActivity?: { type: ActivityType; atISO: string; href?: string };
  /** Parent issue number for a native Github sub-issue (nesting), else absent. */
  parent?: number;
  /** Blocked by a dependency (queue rows carry this) — surfaced in the board's
   *  Copy-for-agent markdown, matching the retired IssueQueue. Absent for project
   *  items, which don't carry the flag. */
  blocked?: boolean;
  /** In the aging set (#478) — what the Unit page's Oldest-open block counts.
   *  Decided by board-api so the block and the queue's Aging filter can't drift
   *  apart; the viewer never re-derives it from `createdAt`. Absent for project
   *  items, which the queue's aging filter doesn't serve. */
  aging?: boolean;
  /** Enumerable custom-field values (#401): fieldSlug → value name(s). Optional for
   *  queue items; present only for project items. */
  customFields?: Record<string, string[]>;
}

/** Adapt one board item into the normalized view-model. A project item has no
 *  `projects` of its own (it *is* on the board being viewed) and no derived
 *  `type`/`labels` on an older board-api, so those default. An empty board
 *  Status becomes `undefined` so Status-grouping never yields a blank group. */
export function fromProjectItem(item: ProjectItem): ViewerIssue {
  return {
    repo: item.repo,
    number: item.number,
    title: item.title,
    htmlUrl: item.url,
    state: item.state,
    closedAt: item.closedAt ?? undefined,
    stateReason: item.stateReason,
    assignees: item.assignees ?? [],
    labels: item.labels ?? [],
    projects: [],
    type: item.type ?? 'chore',
    status: item.status || undefined,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    lastActivity: item.lastActivity,
    parent: item.parent ?? undefined,
    customFields: item.customFields,
  };
}

/** Adapt one personal-queue / org-queue row into the normalized view-model.
 *  Open queue rows are always open; recentlyClosed rows carry state:'closed' (#407).
 *  Queue rows never carry a board Status. Their `labels` are plain names (no colors),
 *  lifted into the `{name,color}` shape with an empty color so the viewer renders
 *  them uniformly. */
export function fromPersonalIssue(i: PersonalIssue): ViewerIssue {
  return {
    repo: i.repo,
    owner: i.owner,
    number: i.number,
    title: i.title,
    htmlUrl: i.htmlUrl,
    state: i.state ?? 'open',
    assignees: i.assignees ?? [],
    labels: (i.labels ?? []).map((name) => ({ name, color: '' })),
    projects: i.projects ?? [],
    type: i.type,
    status: undefined,
    createdAt: i.createdAt,
    closedAt: i.closedAt ?? undefined,
    stateReason: i.stateReason,
    blocked: i.blocked,
    aging: i.aging ?? false,
  };
}
