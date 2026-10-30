/**
 * In-board issue page (#235). One GitHub issue mirrored in full, read-only:
 * the issue plus its comment thread and any linked PRs. Distinct from
 * issues-metrics (flow analysis over tracked repos) and issue-buckets (org-wide
 * counts) — this is a single issue fetched on demand and cached per issue.
 */
import type { KnownLabels } from '../auth/feedback-visibility';
import type { Capability } from '../capability/capability';
import type { CloseReason } from '../issues-metrics/close-reason';

export const ISSUE_DETAIL_SOURCE = Symbol('ISSUE_DETAIL_SOURCE');

export type IssueState = 'open' | 'closed';

/**
 * The reasons a person may CHOOSE when closing an issue (#1006), as the
 * `state_reason` body field on `PATCH /repos/{owner}/{repo}/issues/{issue_number}`.
 *
 * Read off Github's REST reference on 2026-09-11, where API versions 2022-11-28
 * (what the board sends, having pinned none) and 2026-03-10 agree: `completed`,
 * `not_planned`, `duplicate`, `reopened`, `null`. `reopened` names a reopen and
 * `null` clears the reason, so neither closes anything; the three left do.
 * `duplicate` goes without `duplicate_issue_id`, which Github's schema marks
 * optional, so the issue is marked a duplicate without naming the one it copies.
 *
 * Not `CloseReason` in `issues-metrics/close-reason.ts` (#1014), which is what
 * the board READS off a closed issue, `reopened` and `null` included, to decide
 * whether the close counts as delivered. The `satisfies` keeps every choice one
 * that side recognises, so a close made here is never read back as unknown.
 */
export const CHOSEN_CLOSE_REASONS = [
  'completed',
  'not_planned',
  'duplicate',
] as const satisfies readonly NonNullable<CloseReason>[];
export type ChosenCloseReason = (typeof CHOSEN_CLOSE_REASONS)[number];

export function isChosenCloseReason(x: unknown): x is ChosenCloseReason {
  return (CHOSEN_CLOSE_REASONS as readonly unknown[]).includes(x);
}

/** What Github holds after a close (B2): the state, and the reason it KEPT.
 *  Github ignores `state_reason` unless the state changes, so closing an issue
 *  that was already closed answers with the reason it had, not the one asked
 *  for. That is a stale card's answer, and the page reports it as such. A
 *  string rather than `ChosenCloseReason`, because Github also answers
 *  `reopened` and may add words this list has not heard of.
 *
 *  `alreadyClosed` says the close changed nothing, because the issue was closed
 *  before the request. The close route writes no audit row for it. False where
 *  the source cannot tell, which keeps the row. */
export interface ClosedIssue {
  state: IssueState;
  stateReason: string | null;
  alreadyClosed: boolean;
}

/** Github's cap on one call to its add-assignees endpoint: "Adds up to 10
 *  assignees to an issue" (docs.github.com, REST "Assignees", read 2026-09-11).
 *  One issue holds at most ten as well, which is a different page: "Both issues
 *  and pull requests support up to 10 assignees", the line the picker's
 *  `MAX_ASSIGNEES` cites. A change naming more than ten on either side is
 *  refused. */
export const ASSIGNEE_CHANGE_MAX = 10;

/** A linked PR's state — GitHub distinguishes merged from plain closed. */
export type PrState = 'open' | 'closed' | 'merged';

/** A GitHub account as shown on the page: a login, plus a display name when known. */
export interface Person {
  login: string;
  /** Display name when the account exposes one (Users do; bots/orgs may not). */
  name: string | null;
}

export interface LinkedPr {
  number: number;
  url: string;
  title: string;
  state: PrState;
}

/** A label as GitHub renders it: name plus its hex color (no `#`), so the page
 *  can tint the chip its real GitHub color instead of a flat grey (#289). */
export interface IssueLabel {
  name: string;
  /** 6-digit hex without a leading `#`, e.g. `d73a4a` (GitHub's own format). */
  color: string;
}

export interface IssueComment {
  id?: number;
  viewerCanUpdate?: boolean;
  author: Person | null;
  bodyMarkdown: string;
  createdAt: string;
  /** Canonical GitHub permalink to this comment (`…/issues/N#issuecomment-ID`),
   *  so the page's timestamp can deep-link to the source comment (#383). */
  htmlUrl: string;
}

/**
 * One comment as the board hands it back the moment it posts one (#693) — the
 * same four fields `IssueDetail.comments[]` carries, so the page appends it to
 * the thread it is already rendering instead of re-reading the whole issue.
 *
 * Declared from `IssueComment` rather than beside it, so the two cannot drift
 * into different spellings of one thing. `htmlUrl` is the single difference and
 * it is widened, not narrowed: the read side takes the permalink from GraphQL,
 * which always selects `url`, while the REST create response leaves `html_url`
 * a field the API is not bound to fill. A missing permalink costs the reader a
 * link to Github, not the comment.
 */
export interface PostedComment extends Omit<IssueComment, 'htmlUrl'> {
  htmlUrl: string | null;
}

/**
 * The longest issue-comment body the board will send (#693).
 *
 * GITHUB'S OWN LIMIT: an issue comment body is capped at 65536 characters, and
 * a longer one comes back a 422 from the create call. Refused here instead, so
 * an over-long body is the client error it is rather than an upstream failure
 * the page has to read as the board breaking.
 */
export const COMMENT_BODY_MAX = 65536;

/** A Projects v2 custom field's data type — the kinds the board can render + edit. */
export type FieldDataType = 'single_select' | 'text' | 'number' | 'date' | 'iteration';

/** One choice of a single-select field (carries GitHub's colour name). */
export interface FieldOption {
  id: string;
  name: string;
  color: string | null;
}

/** One iteration of an iteration field. */
export interface FieldIteration {
  id: string;
  title: string;
}

/** A project's definition of one custom field — its schema, not this issue's value. */
export interface ProjectFieldDef {
  fieldId: string;
  name: string;
  dataType: FieldDataType;
  /** Present for single_select. */
  options?: FieldOption[];
  /** Present for iteration. */
  iterations?: FieldIteration[];
  /** This is the Status field GitHub seeded the project with, as far as the
   *  timestamps can tell (`mapFieldDefs`) — the page's one way to know a
   *  single-select field by what it IS rather than by what it is called
   *  (#1199). Absent means "not established", never "definitely not": two
   *  single-selects sharing the project's instant leave it off BOTH. */
  builtInStatus?: boolean;
}

/** The issue's current value for one field (shape depends on dataType). */
export type FieldValue =
  | { kind: 'single_select'; optionId: string | null }
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number | null }
  | { kind: 'date'; date: string | null } // ISO yyyy-mm-dd
  | { kind: 'iteration'; iterationId: string | null };

/** One Projects v2 board this issue sits on, with the board's field schema and
 *  this issue's value per field (#384). */
export interface IssueProjectMembership {
  projectId: string; // Projects v2 node id
  itemId: string; // the ProjectV2Item id for THIS issue
  number: number; // project number
  title: string;
  fields: ProjectFieldDef[]; // the project's field schema
  values: Record<string, FieldValue>; // fieldId → this issue's value
}

/** One issue referenced BY another — a parent, a sub-issue, or a dependency
 *  (#469). Carries its own owner/repo because a relation is routinely
 *  cross-repo: the page writes a same-repo reference `#NN` and any other
 *  `owner/repo#NN`, and links it to the board or to Github accordingly. */
export interface IssueRelation {
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: IssueState;
  /** Canonical GitHub URL — the link target when the reference is off-board. */
  url: string;
  /** The relation's label names, or null when the fetch could not establish
   *  them (#497). It rides here so the words gate can place a NEIGHBOUR the way
   *  it places the issue itself — a submission filed under an ordinary umbrella
   *  is house practice, and its title is the end user's first line.
   *  `readableRelations` strips this before the payload: the page never renders
   *  a relation's labels, so serving them would only widen the response.
   *  Optional, and an absent value reads as null — a construction site that
   *  forgets it fails closed rather than opening a hole. */
  labels?: KnownLabels;
}

/** How one issue sits among others (#469). Always present; an issue with no
 *  relations carries empty ones rather than null, so the page tests emptiness
 *  in one place instead of guarding four shapes. */
export interface IssueRelations {
  parent: IssueRelation | null;
  /** The first page of sub-issues (see the query's cap) — NOT necessarily all
   *  of them, which is why the counts below come from GitHub's own summary. */
  subIssues: IssueRelation[];
  /** GitHub's `subIssuesSummary` counts across ALL sub-issues, so "8 of 19 done"
   *  stays true past the fetched page. Falls back to counting the fetched page
   *  when GitHub returns no summary. */
  subIssuesTotal: number;
  subIssuesClosed: number;
  /** Issues that must land before this one can (GitHub's `blockedBy`). */
  blockedBy: IssueRelation[];
  /** Issues waiting on this one (GitHub's `blocking`). */
  blocking: IssueRelation[];
}

/** Autocomplete catalog for the issue's repo (labels carry colour; milestones are open). */
export interface IssueEditOptions {
  labels: IssueLabel[]; // {name,color}
  milestones: { number: number; title: string }[];
  assignableLogins: string[]; // repo-assignable users
  assignablePeople?: Person[];
}

/** Activity is additive so older cached payloads and clients remain compatible. */
export interface IssueActivityEvent {
  id: string;
  kind: 'labeled' | 'unlabeled' | 'assigned' | 'unassigned' | 'milestoned' | 'demilestoned' | 'cross-referenced' | 'referenced' | 'closed' | 'reopened';
  createdAt: string;
  actor: Person | null;
  label?: string | null;
  assignee?: string | null;
  milestone?: string | null;
  /** Validated Github reference, without the referenced issue's title. */
  reference?: {url: string; label: string} | null;
}
export interface IssueActivity {
  state: 'read' | 'partial' | 'unreadable';
  events: IssueActivityEvent[];
}

/** The full read-only mirror of one issue. */
export interface IssueDetail {
  viewerCanUpdate?: boolean;
  activity?: IssueActivity;
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: IssueState;
  /** Canonical GitHub URL — the page's one "Open on Github" action. */
  htmlUrl: string;
  author: Person | null;
  createdAt: string;
  updatedAt: string;
  /** Raw GitHub-flavored markdown — rendered client-side. */
  bodyMarkdown: string;
  labels: IssueLabel[];
  /** True when `labels` is the issue's WHOLE set — false when GitHub held more
   *  than the query's page (#497). The words gate keys on a label being present,
   *  so a partial page would read as "no `feedback` label here" and serve a
   *  submission's body; false makes the gate treat the issue as one it cannot
   *  place. Required, not optional, so a new source has to answer rather than
   *  inherit an opening default. */
  labelsComplete: boolean;
  assignees: Person[];
  milestone: string | null;
  /** GitHub's ORG-LEVEL issue type — "Task", "Bug", "Feature" — as the org
   *  defines it, null when the issue carries none (#467). This is the real
   *  `issueType` field, NOT the label heuristic `deriveIssueType` reads off
   *  label names for the queue's coarse grouping; the two are different
   *  taxonomies and must never be substituted for one another. */
  issueType: string | null;
  /** Parent, sub-issues (+ their completion counts) and both dependency
   *  directions (#469) — empty throughout when the issue stands alone. */
  relations: IssueRelations;
  linkedPrs: LinkedPr[];
  /** Up to `commentsMax` comments, oldest-first. */
  comments: IssueComment[];
  /** Total comment count on GitHub (may exceed `comments.length`). */
  totalComments: number;
  /** True when GitHub has more comments than we returned (see the cap). */
  commentsTruncated: boolean;
  /** Projects v2 boards this issue sits on — empty when on none — each with the
   *  board's field schema and this issue's current field values (#384). */
  projects: IssueProjectMembership[];
}

/** A source of one issue's full detail — GitHub, or a local fixture. Returns
 *  null when the issue doesn't exist (→ the controller answers 404). */
export interface IIssueDetailSource {
  editText(owner: string, repo: string, number: number, bodyMarkdown: string, expectedBody: string, commentId?: number): Promise<{ bodyMarkdown: string }>;
  fetch(owner: string, repo: string, number: number): Promise<IssueDetail | null>;
  /** Close the issue on the source of truth (#287/#291) — board's first
   *  edit-existing-state write. Throws `IssueNotFoundError` when the issue
   *  doesn't exist so the controller can answer 404. Kept; the impl delegates
   *  to `setState(...,'closed')` internally. */
  /** #584 — `capability` travels so a refused CLOSE is remembered as
   *  `issue.close` and not as `issue.state`. Without it one refused close
   *  would, once the guard enforces, disable the state toggle on every issue.
   *  Trailing and defaulted, so the callers that never named it keep working. */
  /** #1006 — `reason` is Github's `state_reason`, absent for "not stated", which
   *  Github records as `completed`. The answer is what Github STORED, see
   *  `ClosedIssue`. */
  close(
    owner: string,
    repo: string,
    number: number,
    capability?: Capability,
    reason?: ChosenCloseReason,
  ): Promise<ClosedIssue>;
  // B2 — native mutations RETURN GitHub's authoritative resulting facet (GitHub
  // coerces silently: e.g. issues.update drops non-assignable logins and returns
  // the accepted subset). The controller echoes THIS, never the client's input,
  // and the frontend reconciles local state to it. No more optimistic-only truth.
  setState(
    owner: string,
    repo: string,
    number: number,
    state: IssueState,
    capability?: Capability,
  ): Promise<IssueState>;
  setAssignees(owner: string, repo: string, number: number, logins: string[]): Promise<Person[]>;
  /** Add or remove the named people and nobody else (#1009), through Github's
   *  own add and remove endpoints. Each answers with the whole set the issue
   *  holds afterwards, which may name people this request never mentioned. */
  addAssignees(owner: string, repo: string, number: number, logins: string[]): Promise<Person[]>;
  removeAssignees(owner: string, repo: string, number: number, logins: string[]): Promise<Person[]>;
  /** Who holds the issue on Github right now, read past every cache (#1009).
   *  Null when the issue does not exist. */
  currentAssignees(owner: string, repo: string, number: number): Promise<Person[] | null>;
  setLabels(owner: string, repo: string, number: number, names: string[]): Promise<IssueLabel[]>;
  setMilestone(owner: string, repo: string, number: number, milestoneNumber: number | null): Promise<string | null>;
  /** Toggle one body task-list checkbox (#426): set the task on 1-based source
   *  `line` to `checked` and write the whole body back. The line comes from the
   *  client's GFM render (the authority on what is a checkbox); the server flips
   *  exactly that line. Returns GitHub's resulting body markdown (B2 echo), NOT
   *  the client's optimistic flip. Throws `IssueNotFoundError` for a missing
   *  issue, `TaskToggleError` when the line is not a task-list item. */
  toggleTask(owner: string, repo: string, number: number, line: number, checked: boolean): Promise<string>;
  /** Post one comment on the issue (#693) and return what Github STORED — the
   *  author it recorded, the body it kept, its creation time and its permalink
   *  — never the request echoed back, so the page renders the real thread entry.
   *  `bodyMarkdown` travels verbatim: Github stores markdown and renders it, and
   *  anything done to it here would be done to somebody's words. Throws
   *  `IssueNotFoundError` for a missing issue. */
  addComment(owner: string, repo: string, number: number, bodyMarkdown: string): Promise<PostedComment>;
  editOptions(owner: string, repo: string): Promise<IssueEditOptions>;
  // B1 — Projects v2 node ids are NOT owner-scoped, so the route owner-pin does
  // NOT constrain them. `projectOwnerLogin` resolves a project's owning org/user
  // login so the ADD path can require it to be IN the owner scope; the SET/REMOVE paths
  // instead cross-check the body's {projectId,itemId} against the issue's actual
  // memberships (see Task 7). Both close the cross-org / cross-item write hole.
  projectOwnerLogin(projectId: string): Promise<string | null>;
  addToProject(owner: string, repo: string, number: number, projectId: string): Promise<{ itemId: string }>; // S1: returns the new item id
  /** Make a Projects v2 project called `title` under `owner`, the issue's own
   *  owner, for issue `number`, and answer with what Github made (#982). `repo`
   *  is also the capability target, the key every other refusal on this source
   *  is remembered under. Before anything is written it throws
   *  `IssueNotFoundError` when the issue is not there, and
   *  `ProjectTitleTakenError` when an open project under that owner already
   *  carries the name. */
  createProject(owner: string, repo: string, number: number, title: string): Promise<CreatedProject>;
  // #584 — `owner` and `repo` are APPENDED, never inserted. A Projects v2 item
  // is addressed by node id, so neither signature carried them; the capability
  // registry keys on `owner/repo`, because that is the only key task 9's
  // envelope can read — it has the owner, the repo and the issue number, and no
  // node id at all. Trailing parameters bind positionally to nothing they did
  // not already bind; an `owner` inserted first would have an implementer bind
  // `itemId` to an owner, silently, with a green typecheck.
  removeFromProject(itemId: string, projectId: string, owner: string, repo: string): Promise<void>;
  setFieldValue(
    projectId: string,
    itemId: string,
    fieldId: string,
    value: FieldValue,
    owner: string,
    repo: string,
  ): Promise<FieldValue>; // returns the stored value
}

/** A project `createProject` made, as Github answered it (#982). `owner` is
 *  the login Github holds for the owner it was made under. */
export interface CreatedProject {
  id: string;
  number: number;
  title: string;
  /** Github's page for it, or null where the answer carried none. */
  url: string | null;
  owner: string;
}

/** An open project under the owner already carries the name asked for (#982).
 *  Github keeps two projects with one name without complaint, so the board is
 *  what refuses, and it names the project that has the name. */
export class ProjectTitleTakenError extends Error {
  constructor(readonly existing: { id: string; number: number; title: string }) {
    super(`a project called ${existing.title} already exists`);
    this.name = 'ProjectTitleTakenError';
  }
}

/** Thrown by a source's `close` when the target issue doesn't exist — the
 *  controller maps it to a 404 (vs a 500 for a real upstream failure). */
export class IssueNotFoundError extends Error {
  constructor(owner: string, repo: string, number: number) {
    super(`issue ${owner}/${repo}#${number} not found`);
    this.name = 'IssueNotFoundError';
  }
}
