import type { MetricScope } from '../metric-scope/metric-scope';
import { currentWriteCacheGeneration, patchReadAfterWrite } from '../cache/read-cache';
import { copyResponseDeadline } from '../auth/response-deadline';
import { resolvedTimezone } from '../account/prefs';
import { API, ApiError, networkFetch as apiFetch, refusalOf, scopeQuery, retryAt, overviewNetworkFetch, serverCode, serverMessage } from './core';
import type { IssueState, IssueLabel, PersonalIssueType, ProjectContribution, MeResponse, SyncOperation, BoardFreshness, RefusalReason } from './types';
import type { ChosenCloseReason, CloseReason } from '../close-reason';

// ── issue-flow metrics (#120) ────────────────────────────────────────────────
export interface IssueMetrics {
  metricScope?: MetricScope;
  /** Calendar anchor and underlying closes from this exact metric snapshot. */
  computedAt?: string;
  timeZone?: string;
  openedEvents?: { htmlUrl: string; createdAt: string; assignees: string[] }[];
  closeEvents?: { htmlUrl: string; closedAt: string; assignees: string[] }[];
  closedYesterday?: PersonalIssue[];

  updatedAt: string;
  repos: string[];
  labels: string[];
  cycles: string[];
  filter: { repo?: string; label?: string; cycle?: string };
  totals: { open: number; openFlow: number; steadyState: number; closed90: number; unassigned: number };
  weeks: { opened: number; closed: number }[];
  /** The same throughput per viewer calendar day (#666, #684), oldest → newest,
   *  DAY_SPAN long — the flow strip and the day grid. `weeks` above is untouched
   *  and still drives the trend chart. Optional across the deploy window:
   *  board-web ships before board-api. */
  days?: { opened: number[]; closed: number[]; exited?: number[] };
  /** Closes per viewer calendar day over the whole history the grid draws (#817),
   *  oldest → newest, ending on the day this payload was built. Its LENGTH is
   *  how far back it reaches — there is no start date beside it, because a
   *  stored date is a second definition of the same day and drifts from the
   *  array it describes. `days` above is untouched and still feeds the sparks.
   *  Optional across the deploy window. */
  closedDays?: number[];
  recent4: { opened: number; closed: number };
  /** trailing-7d throughput per assignee, most closed first (the team pulse) */
  byMember: {
    login: string;
    name: string;
    opened: number;
    closed: number;
    // Github searches behind the two counts (#303) — null when no org derived.
    closedHref?: string | null;
    openedHref?: string | null;
    // This member's own 12-week opened/closed series (#336) — filters the trend
    // chart. Optional: guards the deploy window where board-web ships before
    // board-api adds it (fall back to the org-wide `weeks`).
    weeks?: { opened: number; closed: number }[];
    // This member's own calendar days (#666, #684) — same span and alignment as
    // the org-wide `days`, attributed by assignee, so a per-member day grid
    // needs no second request. Optional across the deploy window.
    days?: { opened: number[]; closed: number[]; exited?: number[] };
    // This member's own `closedDays` (#817) — same rule and same last day as
    // the org-wide one, attributed by assignee. Optional across the deploy
    // window.
    closedDays?: number[];
  }[];
  load: { name: string; login: string | null; count: number }[];
  ttc: {
    medianDays: number; p90Days: number; n: number;
    // Optional while an older API or saved payload predates Org lag (#843).
    meanDays?: number | null;
    windowDays?: number;
    readable?: boolean;
    comparison?: {
      startAt: string;
      endAt: string;
      previousStartAt: string;
      previousN: number;
      previousMeanDays: number | null;
      deltaDays: number | null;
      weekly: { startAt: string; endAt: string; n: number; meanDays: number | null }[];
      /** Rolling 90-day means from the prior comparison endpoint to the current one. */
      rolling?: { startAt: string; endAt: string; n: number; meanDays: number | null }[];
    } | null;
  };
  /** `owner` is the Github org the aging row came from (#650) — required, for
   *  the same reason `PersonalIssue.owner` is. */
  stale: { repo: string; owner: string; number: number; title: string; ageDays: number; who: string; assignees: string[]; htmlUrl: string }[];
  /** How many issues are aging in total (#478) — `stale` is only the head of that
   *  set, so the Oldest-open header reports this. Optional: guards the deploy
   *  window where board-web ships before board-api adds it (falls back to the row
   *  count, which is what the header showed before). */
  staleTotal?: number;
  steadyByType: { label: string; count: number }[];
}

export async function fetchIssueMetrics(filter: {
  org?: string;
  repo?: string;
  label?: string;
  cycle?: string;
  timeZone?: string;
} = {}, read = apiFetch): Promise<IssueMetrics> {
  const q = new URLSearchParams();
  if (filter.org) q.set('org', filter.org);
  if (filter.repo) q.set('repo', filter.repo);
  if (filter.label) q.set('label', filter.label);
  if (filter.cycle) q.set('cycle', filter.cycle);
  q.set('timeZone', filter.timeZone ?? resolvedTimezone());
  const qs = q.toString();
  const res = await read(`${API}/api/issues/metrics${qs ? `?${qs}` : ''}`);
  // The code too, which tells the 503 a saved copy may answer from every other (#1046).
  if (!res.ok) throw new ApiError(res.status, res.status === 403 ? 'forbidden' : `issue-metrics ${res.status}`, undefined, undefined, await serverMessage(res), await serverCode(res), retryAt(res));
  return res.json();
}
// ── dashboard Issues block (#185) ────────────────────────────────────────────
/** The four org-wide open-issue buckets, and when they were last fetched.
 *
 *  The Unit page's stat tiles used to print these counts and open the Github
 *  searches board-api ships beside them. Since #461 they count the org queue —
 *  the same list the tile opens — so neither the counts nor the `links` are read
 *  by anything, and `links` is left out of this type rather than described as
 *  though something consumed it. `syncedAt` is the whole of what we still use:
 *  it is the freshest clock the "Synced" stamp has (short server-side TTL). */
export interface IssueBuckets {
  open: number;
  bugs: number;
  feedback: number;
  unassigned: number;
  syncedAt: string;
}

export async function fetchIssueBuckets(): Promise<IssueBuckets> {
  const res = await apiFetch(`${API}/api/issues/buckets`);
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(`issue-buckets ${res.status}`);
  return res.json();
}

// ── personal home: "Your work" queue (#206) ──────────────────────────────────
/** One open issue in the signed-in user's queue — assigned to them or unassigned (#231). */
export interface PersonalIssue {
  repo: string;
  /** The Github org this row came from (#650). Required: the server sends it on
   *  every row, and a row whose org is unknown cannot be told apart from a row
   *  belonging to the org the reader is looking at. */
  owner: string;
  number: number;
  title: string;
  htmlUrl: string;
  createdAt: string;
  ageDays: number;
  labels: string[];
  type: PersonalIssueType;
  blocked: boolean;
  /** In the aging set (#478) — open flow work at or past the 30-day threshold.
   *  Decided by board-api, by the same predicate the Oldest-open block's count
   *  runs on, so the queue's Aging filter narrows to exactly what the block
   *  reports. Optional across the deploy window (→ treated as not aging). */
  aging?: boolean;
  /** True when assigned to the signed-in user; false for an unassigned queue item (#231). */
  assignedToMe: boolean;
  /** GitHub assignee logins (may be empty → unassigned) — the card avatars (#230). */
  assignees: string[];
  /** GitHub login of the issue's author/creator (card avatar), or null. */
  author: string | null;
  /** GitHub Project name(s) this issue is on — [] → omitted from the Project stack view (#379). */
  projects: string[];
  /** Lifecycle state (#407) — 'open' for queue rows, 'closed' for recentlyClosed. Optional
   *  so board-web tolerates a board-api that predates it (→ treated as open). */
  state?: 'open' | 'closed';
  /** ISO close timestamp when closed, else null/absent (#407). */
  closedAt?: string | null;
  /** WHY it closed (#1014) — the field `deliveredCloseAt` reads to decide whether
   *  the close beside it is delivered work. Never read on its own: `close-reason.ts`
   *  holds the one predicate on this side, as board-service does on its own.
   *
   *  Optional here where board-api's copy of this type REQUIRES it — the
   *  deploy-window rule `aging` and `state` above both state, and it decides
   *  what absence means as well as tolerating it. Absent counts, the same answer
   *  the service gives an unknown reason and the answer this board gave every
   *  close before #1014; the other reading would drop real throughput out of a
   *  drill-in for as long as a reader sits on an older board-api.
   *
   *  On the wire at all because the viewer's `closed-yesterday` and `closed-week`
   *  filters count client-side over whatever list is loaded — the one surface
   *  here that does not inherit board-api's filtering. */
  stateReason?: CloseReason;
}

/** GET /api/issues/mine — the signed-in user's open queue + trailing-7d
 *  throughput. `login` is null when the caller's email maps to no GitHub
 *  identity (→ empty queue). */
export interface PersonalIssues {
  metricScope?: MetricScope;
  /** The clock board-api bucketed the day series below BY, and the day their
   *  last cell is for (#1015) — the `me` scope's twin of `IssueMetrics`'
   *  `computedAt`, added for the same reason and read at the same place.
   *
   *  `stripModel` dates every cell of the grid off it. It must not fall back to
   *  the caller's `Date.now()` where a stamp exists: this payload is cached in
   *  `localStorage` for up to `PAYLOAD_MAX_AGE_MS` and stays on screen through a
   *  failed live read, so the reader's clock can be a day or two past the day
   *  these counts were counted to — and the grid then draws yesterday's closes
   *  on today's cell, with the labels agreeing.
   *
   *  NOT `updatedAt`, which board-api overwrites with the raw-issue cache's
   *  fetch time and which can therefore sit behind the day the series ends on.
   *
   *  Optional across the deploy window, and absent on `MINE_UNAVAILABLE`, which
   *  stamps no freshness at all and carries no series to misdate. Absent means
   *  no claim, and the caller's clock is then the only anchor there is. */
  computedAt?: string;
  timeZone?: string;
  updatedAt: string;
  login: string | null;
  issues: PersonalIssue[];
  throughput: { opened: number; closed: number };
  /** Rolling 7-day throughput windows, oldest → newest — the last equals
   *  `throughput`. Powers the Closed/Opened cards' sparklines (#254). */
  throughputWeeks: { opened: number; closed: number }[];
  /** Opened/closed per viewer calendar day (#666, #684), oldest → newest, DAY_SPAN
   *  long, the last cell being the day `updatedAt` falls in. Optional across the
   *  deploy window: board-web ships before board-api. */
  throughputDays?: { opened: number[]; closed: number[]; exited?: number[] };
  /** This person's own closes per viewer day over the whole history the grid draws
   *  (#817) — same rule and same last day as the org-wide `closedDays`.
   *  Optional across the deploy window.
   *
   *  SAME RULE MEANS THE WINDOW REACHES BACK TO THE FIRST CLOSE THE MIRROR
   *  HOLDS, not to this person's own first close, and the difference is a
   *  correctness one rather than a matter of consistency. Before the day they
   *  first closed something the board WAS watching and they closed nothing,
   *  which is a zero; sized off their own issues those days come back absent,
   *  and the grid draws absent as nothing at all — "nobody was counting" about
   *  months somebody was. The same person's `byMember` row on Overview is sized
   *  off the org's whole filtered set, so it drew them as the zeroes they are,
   *  and one person read two ways on two surfaces. Re-scoping this to the reader
   *  looks like the tighter answer and is the one that lies. */
  closedDays?: number[];
  /** The caller's GitHub Projects with recent contribution (#380). Optional:
   *  guards the deploy window where board-web ships before board-api adds it. */
  projectContributions?: ProjectContribution[];
  /** Issues I closed in the trailing 7 days (#407), newest first — fed alongside `issues`
   *  into the Your-work viewer so the "Closed this week" tile drills in-board. Optional
   *  across the deploy window. */
  recentlyClosed?: PersonalIssue[];
}

export async function fetchMyIssues(org?: string, verified?: Promise<MeResponse>, timeZone = resolvedTimezone()): Promise<PersonalIssues> {
  const res = await apiFetch(`${API}/api/issues/mine${dayQuery(org, timeZone)}`, undefined, verified);
  if (!res.ok) throw new ApiError(res.status, res.status === 403 ? 'forbidden' : `my-issues ${res.status}`, undefined, undefined, await serverMessage(res));
  return res.json();
}

/** The whole unit's open queue (#284) — the same stackable rows as `mine`, at
 *  org scope, for the Unit page's shared queue. No login/throughput. */
export interface OrgQueue {
  metricScope?: MetricScope;
  updatedAt: string;
  issues: PersonalIssue[];
}

export async function fetchOrgIssues(org?: string, read = apiFetch): Promise<OrgQueue> {
  const res = await read(`${API}/api/issues/all${scopeQuery(org)}`);
  // The code too, which tells the 503 a saved copy may answer from every other (#1046).
  if (!res.ok) throw new ApiError(res.status, res.status === 403 ? 'forbidden' : `org-issues ${res.status}`, undefined, undefined, await serverMessage(res), await serverCode(res), retryAt(res));
  return res.json();
}

// ── in-board issue page (#235) — a read-only mirror of one Github issue ───────
export type PrState = 'open' | 'closed' | 'merged';
/** A Github account on the issue page: a login + display name when known. Named
 *  `Actor` to avoid colliding with the people-map `Person` below. */
export interface Actor {
  login: string;
  name: string | null;
}
export interface LinkedPr {
  number: number;
  url: string;
  title: string;
  state: PrState;
}
export interface IssueComment {
  id?: number;
  viewerCanUpdate?: boolean;
  author: Actor | null;
  bodyMarkdown: string;
  createdAt: string;
  /** Github permalink to this comment (`…/issues/N#issuecomment-ID`) — the
   *  timestamp deep-links here (#383). Null when there is no permalink to give:
   *  every comment the thread READ carries one, and `postIssueComment` (#693)
   *  answers with the same shape for a comment just written, where Github may
   *  not have handed one back. `TimeLink` already draws a null href as plain
   *  text, so the thread renders such a comment without a special case. */
  htmlUrl: string | null;
}
/** Activity is additive so older cached payloads and clients remain compatible. */
export interface IssueActivityEvent {
  id: string;
  kind: 'labeled' | 'unlabeled' | 'assigned' | 'unassigned' | 'milestoned' | 'demilestoned' | 'cross-referenced' | 'referenced' | 'closed' | 'reopened';
  createdAt: string;
  actor: Actor | null;
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

export interface IssueDetail {
  viewerCanUpdate?: boolean;
  activity?: IssueActivity;
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: IssueState;
  htmlUrl: string;
  author: Actor | null;
  createdAt: string;
  updatedAt: string;
  bodyMarkdown: string;
  labels: IssueLabel[];
  assignees: Actor[];
  milestone: string | null;
  /** Github's org-level issue type — "Task", "Bug", "Feature" — null when the
   *  issue carries none (#467). Mirrors board-service `IssueDetail.issueType`.
   *  Not the label-derived coarse type the queue groups by; different field. */
  issueType: string | null;
  /** Parent, sub-issues and both dependency directions (#469) — empty
   *  throughout when the issue stands alone. Mirrors the backend shape. */
  relations: IssueRelations;
  linkedPrs: LinkedPr[];
  comments: IssueComment[];
  totalComments: number;
  commentsTruncated: boolean;
  /** Projects v2 boards this issue sits on — empty when on none — each with the
   *  board's field schema and this issue's current field values (#384). Mirrors
   *  board-service IssueDetail.projects. */
  projects: IssueProjectMembership[];
}

// ── An issue's relations (#469) — mirrors the backend types ──────────────────
/** One issue referenced by another: a parent, a sub-issue, or a dependency.
 *  Carries its own owner/repo because relations are routinely cross-repo. */
export interface IssueRelation {
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: IssueState;
  /** Canonical Github URL — the link target for an off-board reference. */
  url: string;
}

/** How one issue sits among others. Always present; empty when it stands alone. */
export interface IssueRelations {
  parent: IssueRelation | null;
  /** The first page of sub-issues — the counts below cover all of them. */
  subIssues: IssueRelation[];
  subIssuesTotal: number;
  subIssuesClosed: number;
  /** Issues that must land before this one can. */
  blockedBy: IssueRelation[];
  /** Issues waiting on this one. */
  blocking: IssueRelation[];
}

// ── Projects v2 custom fields on an issue (#384) — mirrors the backend types ──
/** A Projects v2 custom field's data type — the kinds the board renders + edits. */
export type FieldDataType = 'single_select' | 'text' | 'number' | 'date' | 'iteration';

/** One choice of a single-select field (carries Github's colour enum name). */
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
  /** The Status field GitHub seeded this project with, as the service
   *  establishes it (`project-fields.ts`, `seededWithProject`) — never the
   *  field's NAME, which a project can change and a project can reuse. It is
   *  what tells a fixed set of workflow states apart from an ordinary
   *  single-select field somebody added (#1199). Absent means "not
   *  established": the page then treats the field as the ordinary kind. */
  builtInStatus?: boolean;
}

/** The issue's current value for one field (shape depends on data type). */
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

/** Autocomplete catalog for an issue's repo — labels (with colour), open
 *  milestones, and repo-assignable logins (#384). Fed to the panel's editors. */
export interface IssueEditOptions {
  labels: IssueLabel[];
  milestones: { number: number; title: string }[];
  assignableLogins: string[];
  assignablePeople?: Actor[];
}

/** A lean open-issue row for the ⌘K palette index (#214). */
export interface SearchIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
}

/** The palette's open-issue index — all tracked-repo open issues, projected. */
export async function fetchSearchIssues(): Promise<SearchIssue[]> {
  const res = await apiFetch(`${API}/api/issues/search-index`);
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(`search-index ${res.status}`);
  return res.json();
}

/** One issue's full detail. Throws `not-found` on 404 so the page can show a
 *  distinct not-found state (vs a transient error). */
export async function fetchIssue(owner: string, repo: string, number: number): Promise<IssueDetail> {
  const path = `${API}/api/issues/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`;
  const res = await apiFetch(path);
  if (res.status === 403) throw new Error('forbidden');
  if (res.status === 404) throw new Error('not-found');
  if (!res.ok) throw new Error(`issue ${res.status}`);
  return res.json();
}

/** Close an issue on Github (#287/#291) — board's first edit-existing-state write.
 *  Human-only server-side; gated on GITHUB_WRITE_ENABLED (503 when off). Rejects
 *  with an `ApiError` carrying the status (#584) — 403 for a non-human/agent
 *  caller, 503 when the write path is off, 404 for an issue the credential
 *  cannot see — so the confirm dialog can explain rather than fail silently.
 *  `CloseIssueAlert`'s `reason()` is the one reader, and it keys on the refusal
 *  reason first and the status second: three of the reasons the service can
 *  refuse with answer 403, and the dialog has a different sentence for two of
 *  them.
 *
 *  #1006 — `reason` goes as `{ reason }`, and what resolves is the reason Github
 *  KEPT, which is not the one sent when the issue was already closed. Null where
 *  the service did not say, which a deploy from before #1006 never does. */
export async function closeIssue(
  owner: string,
  repo: string,
  number: number,
  reason?: ChosenCloseReason,
): Promise<{ stateReason: string | null }> {
  const path = `${API}/api/issues/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/close`;
  const res = await apiFetch(
    path,
    reason
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }
      : { method: 'POST' },
  );
  if (!res.ok) {
    const r = await refusalOf(res);
    throw new ApiError(res.status, `close ${res.status}`, r.reason, r.authorizeUrl);
  }
  const body = (await res.json().catch(() => null)) as { stateReason?: unknown } | null;
  return { stateReason: typeof body?.stateReason === 'string' ? body.stateReason : null };
}

// ── in-board issue edits (#384) ──────────────────────────────────────────────
// Each write is human-only + gated on GITHUB_WRITE_ENABLED server-side, so they
// share closeIssue's failure shape: an `ApiError` carrying the status (#584) —
// 401 unauthenticated, 403 a scoped/agent caller who is never a writer, 503 the
// write path switched off, 404 a target the credential cannot see. B2 — every
// mutation RESOLVES with the response's authoritative facet (Github coerces
// silently: e.g. a non-assignable login is dropped), which the Task-10 edit hook
// reconciles local state to rather than trusting the optimistic guess.

const issueBase = (owner: string, repo: string, number: number) =>
  `${API}/api/issues/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`;

/** Shared write helper for the issue mutations — the fail-closed error mapping in
 *  one place. Rejects with an `ApiError` carrying the status the server answered
 *  with AND the refusal reason from its body, so the control that failed can say
 *  which failure it was (#584). `parse` is false for a no-content-shaped
 *  response. */
async function issueWrite<T>(path: string, method: string, body?: unknown, parse = true): Promise<T> {
  const res = await apiFetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // #584 — the status reaches the surface. Four hand-mapped strings ('forbidden',
  // 'write-disabled', 'not-found', `issue-write ${status}`) went into a plain
  // Error that `describeEditFailure` could not read, so every refusal on all
  // EIGHT writers this helper serves rendered as "Couldn’t save" beside a Retry
  // that could not work. `setRepoDri` has thrown ApiError since #577; this is
  // the same fix for the eight.
  //
  // The REASON rides along with the status, because the status alone cannot
  // tell "the board may not" from "the board may, once somebody authorizes it"
  // — both answer 403, and only the second is something a person can fix.
  //
  // The server's OWN sentence rides along too (#693). A 400 here is the board
  // refusing this particular text — an over-long body, or one that has typed the
  // board's signature line itself — and it names the length or the line. No
  // wording on this side can restate that without keeping a second copy of both
  // in step, so the surface reads the server's. The other seven writers gain a
  // populated field and read nothing new.
  if (!res.ok) {
    const r = await refusalOf(res);
    throw new ApiError(res.status, `issue-write ${res.status}`, r.reason, r.authorizeUrl, await serverMessage(res));
  }
  return (parse ? await res.json() : undefined) as T;
}

/** Set the issue's open/closed state → the authoritative resulting state. */
export function setIssueState(owner: string, repo: string, number: number, state: IssueState) {
  return issueWrite<{ state: IssueState }>(`${issueBase(owner, repo, number)}/state`, 'PATCH', { state });
}

/** Replace the issue's assignees. Replace-semantics (the full desired set): two
 *  concurrent editors are last-write-wins, and reconciling to the returned set
 *  (B2) converges both views to Github's actual state. → accepted assignees. */
export function setIssueAssignees(owner: string, repo: string, number: number, logins: string[]) {
  return issueWrite<{ assignees: Actor[] }>(`${issueBase(owner, repo, number)}/assignees`, 'PATCH', { logins });
}

/** Add some people to an issue and remove others, touching nobody else (#1009)
 *  → the whole set Github holds afterwards, which can name people this change
 *  never mentioned. The picker saves through this rather than
 *  `setIssueAssignees`, because a replace built from an older read takes off
 *  anyone assigned on Github since. */
export function changeIssueAssignees(
  owner: string,
  repo: string,
  number: number,
  change: { add: string[]; remove: string[] },
) {
  return issueWrite<{ assignees: Actor[] }>(`${issueBase(owner, repo, number)}/assignees/change`, 'POST', change);
}

/** Who holds the issue on Github right now (#1009), read past the service's
 *  issue cache. Throws `not-found` on 404 and `forbidden` on 403, like
 *  `fetchIssue`, so the picker says the same things for both reads. */
export async function fetchIssueAssignees(owner: string, repo: string, number: number): Promise<string[]> {
  const res = await apiFetch(`${issueBase(owner, repo, number)}/assignees`);
  if (res.status === 403) throw new Error('forbidden');
  if (res.status === 404) throw new Error('not-found');
  if (!res.ok) throw new Error(`assignees ${res.status}`);
  const body = (await res.json()) as { assignees: Actor[] };
  return body.assignees.map((a) => a.login);
}

/** Replace the issue's labels (replace-semantics, same last-write-wins note as
 *  setIssueAssignees) → the stored label set. */
export function setIssueLabels(owner: string, repo: string, number: number, names: string[]) {
  return issueWrite<{ labels: IssueLabel[] }>(`${issueBase(owner, repo, number)}/labels`, 'PATCH', { names });
}

/** Set (or clear, with null) the issue's milestone → the resulting title|null. */
export function setIssueMilestone(owner: string, repo: string, number: number, milestoneNumber: number | null) {
  return issueWrite<{ milestone: string | null }>(
    `${issueBase(owner, repo, number)}/milestone`,
    'PATCH',
    { milestoneNumber },
  );
}

/** Toggle one body task-list checkbox (#426): set the task on 1-based source
 *  `line` to `checked`, persisting to Github. The line comes from react-markdown's
 *  own GFM parse (the authority on what is a checkbox), so it can't disagree with
 *  the render the way an occurrence count could. Resolves with the issue's
 *  resulting body markdown (B2 echo) so the page reconciles its render to Github's
 *  truth, not the optimistic flip. Same fail-closed error language as the others. */
export function toggleIssueTask(owner: string, repo: string, number: number, line: number, checked: boolean) {
  return issueWrite<{ bodyMarkdown: string }>(`${issueBase(owner, repo, number)}/task`, 'PATCH', { line, checked });
}

/** Answer the issue from the board (#693) — the one write here that ADDS to the
 *  thread rather than changing a facet of the issue.
 *
 *  It resolves with the posted comment in `IssueComment`'s own shape, not with a
 *  bare ok, so the page appends what the server actually stored and never a
 *  local echo of what was typed: Github is the authority on the author, the
 *  timestamp and the permalink, and only the body came from this browser.
 *
 *  Route and both payload shapes are pinned with board-service; `comment-write.spec.ts`
 *  is the copy of that pin on this side, so a rename fails a test rather than
 *  404ing at somebody who just wrote a paragraph. Same fail-closed error language
 *  as the facet writers — an `ApiError` carrying the status and the refusal
 *  reason (#584). */
export function postIssueComment(owner: string, repo: string, number: number, bodyMarkdown: string) {
  return issueWrite<IssueComment>(`${issueBase(owner, repo, number)}/comment`, 'POST', { bodyMarkdown });
}

/** The repo's edit-options catalog (labels/milestones/assignables) — a read, so
 *  it maps only 401/403 (N1 non-colliding path). */
export async function fetchEditOptions(owner: string, repo: string): Promise<IssueEditOptions> {
  const path = `${API}/api/issues/edit-options/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const res = await apiFetch(path);
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(`edit-options ${res.status}`);
  return res.json();
}

/** Add the issue to a Projects v2 board → the new item id (S1) the field writes
 *  then target. */
export function addIssueToProject(owner: string, repo: string, number: number, projectId: string) {
  return issueWrite<{ itemId: string }>(`${issueBase(owner, repo, number)}/project`, 'POST', { projectId });
}

/** A project the board made from the issue page (#982), as Github answered it. */
export interface MadeProject {
  id: string;
  number: number;
  title: string;
  /** Github's page for it, where the answer carried one. */
  url: string | null;
  /** The login it was made under, which is the issue's own owner. */
  owner: string;
}

/**
 * A failed new project (#982). It carries what no other write's failure does:
 * which project the failure is about. On a 409 that is the project that already
 * has the name; when the project was made and the issue could not be added, it
 * is the project that now exists. Either way the page can offer to add the issue
 * to it. Null where the answer named none.
 */
export class ProjectCreateError extends ApiError {
  constructor(
    status: number,
    message: string,
    reason: RefusalReason | undefined,
    authorizeUrl: string | undefined,
    serverMessage: string | undefined,
    readonly project: MadeProject | null,
  ) {
    super(status, message, reason, authorizeUrl, serverMessage);
    this.name = 'ProjectCreateError';
  }
}

/** The project a failed create named, read as defensively as `refusalOf`
 *  reads a reason, because this runs on a failure path. */
async function projectNamedIn(res: Response): Promise<MadeProject | null> {
  try {
    const body = (await res.clone().json()) as { project?: Record<string, unknown> };
    const p = body?.project;
    if (!p || typeof p.id !== 'string' || typeof p.number !== 'number') return null;
    if (typeof p.title !== 'string' || typeof p.owner !== 'string') return null;
    return { id: p.id, number: p.number, title: p.title, owner: p.owner, url: typeof p.url === 'string' ? p.url : null };
  } catch {
    return null;
  }
}

/** Make a Projects v2 project called `title` under the issue's owner and put
 *  the issue on it (#982) → the project and the issue's new item id on it. */
export async function createProjectForIssue(
  owner: string,
  repo: string,
  number: number,
  title: string,
): Promise<{ project: MadeProject; itemId: string }> {
  const res = await apiFetch(`${issueBase(owner, repo, number)}/project/new`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    const r = await refusalOf(res);
    throw new ProjectCreateError(
      res.status,
      `project-create ${res.status}`,
      r.reason,
      r.authorizeUrl,
      await serverMessage(res),
      await projectNamedIn(res),
    );
  }
  return res.json();
}

/** Remove the issue from a board (owner-bound to this issue's membership). */
export function removeIssueFromProject(
  owner: string,
  repo: string,
  number: number,
  projectId: string,
  itemId: string,
) {
  return issueWrite<void>(`${issueBase(owner, repo, number)}/project`, 'DELETE', { projectId, itemId }, false);
}

/** Set one custom-field value on the issue's project item → the stored value (B2). */
export function setIssueField(
  owner: string,
  repo: string,
  number: number,
  projectId: string,
  itemId: string,
  fieldId: string,
  value: FieldValue,
) {
  return issueWrite<{ value: FieldValue }>(`${issueBase(owner, repo, number)}/field`, 'PATCH', {
    projectId,
    itemId,
    fieldId,
    value,
  });
}

/** Force a "sync now" (#301) — refreshes the board's server-side read caches
 *  from GitHub, so the next fetch is fresh. Not a GitHub write; human-only
 *  server-side. Returns when the refresh has completed, so the caller can
 *  refetch against warm caches. Throws so the pill can show an error state. */
export async function triggerSync(): Promise<{ syncedAt: string }> {
  const res = await apiFetch(`${API}/api/sync`, { method: 'POST' });
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(`sync ${res.status}`);
  return res.json() as Promise<{ syncedAt: string }>;
}

/** Additive progress API; the synchronous triggerSync contract remains available. */
export async function startSyncOperation(signal: AbortSignal): Promise<SyncOperation> {
  const res = await apiFetch(`${API}/api/sync/operations`, { method: 'POST', signal, cache: 'no-store' });
  if (!res.ok) throw new ApiError(res.status, `sync ${res.status}`);
  return res.json() as Promise<SyncOperation>;
}

/**
 * When each of the six sources last refreshed (#1169) — the one record the
 * header chip and the Board sync panel both read.
 *
 * `no-store`, like the two progress reads beside it: the answer is six moments
 * and its whole value is being current. It carries no Github data and needs no
 * per-person token, so it answers on a board that has none.
 */
export async function fetchSyncSources(signal?: AbortSignal): Promise<BoardFreshness> {
  const res = await apiFetch(`${API}/api/sync/sources`, { signal, cache: 'no-store' });
  if (!res.ok) throw new ApiError(res.status, `sync sources ${res.status}`);
  return res.json() as Promise<BoardFreshness>;
}

/** Throws with the status, so a watcher can tell a refusal from a 5xx worth
 *  asking again (#976). */
export async function readSyncOperation(id: string, signal: AbortSignal): Promise<SyncOperation> {
  const res = await apiFetch(`${API}/api/sync/operations/${encodeURIComponent(id)}`, { signal, cache: 'no-store' });
  if (!res.ok) throw new ApiError(res.status, `sync ${res.status}`);
  return res.json() as Promise<SyncOperation>;
}

// ── shared IssuesViewer filter options (#376) ────────────────────────────────
/** The org-wide sets the shared IssuesViewer's filters autocomplete against —
 *  labels/assignees from the cached issue list, projects from the cached rollup.
 *  `labels[].color` is '' on this org-wide list (the cached issues carry only
 *  names); the Project page's own items carry real colors for display. */
export interface FilterOptions {
  labels: IssueLabel[];
  assignees: string[];
  projects: FilterProject[];
}

/** One board on the filter menu. `org` (#697) is what tells two boards numbered
 *  the same apart — the endpoint used to de-dupe on the number alone and drop
 *  one of them, so a board a reader could see was a board they could not filter
 *  to. Optional for the deploy-window reason `ProjectSummary.org` states. */
export interface FilterProject {
  org?: string;
  number: number;
  name: string;
}

/** The empty autocomplete set — the resting/degraded value for the IssuesViewer's
 *  filter options (the FilterBar unions this with on-board values, so a fetch
 *  hiccup never blocks the list). */
export const EMPTY_FILTER_OPTIONS: FilterOptions = { labels: [], assignees: [], projects: [] };

export async function fetchFilterOptions(): Promise<FilterOptions> {
  const res = await apiFetch(`${API}/api/issues/filter-options`);
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) throw new Error(`filter-options ${res.status}`);
  return res.json();
}

/** Part of the request URL, so both in-flight and persisted reads vary by zone. */
export function dayQuery(org?: string, timeZone = resolvedTimezone()): string {
  const query = new URLSearchParams();
  if (org) query.set('org', org);
  query.set('timeZone', timeZone);
  return `?${query}`;
}

export async function editIssueText(owner: string, repo: string, number: number, bodyMarkdown: string, expectedBody: string, commentId?: number) {
  const path = issueBase(owner, repo, number);
  const epoch = currentWriteCacheGeneration();
  const saved = await issueWrite<{ bodyMarkdown: string }>(`${path}/text`, 'PATCH', { bodyMarkdown, expectedBody, commentId });
  await patchReadAfterWrite<IssueDetail>(path, issue => copyResponseDeadline(issue, {
    ...issue,
    ...(commentId === undefined ? saved : { comments: issue.comments.map(comment => comment.id === commentId ? { ...comment, ...saved } : comment) }),
  }), epoch);
  return saved;
}

export const fetchOverviewOrgIssues = (org?: string) => fetchOrgIssues(org, overviewNetworkFetch);
export const fetchOverviewIssueMetrics = (filter: Parameters<typeof fetchIssueMetrics>[0] = {}) => fetchIssueMetrics(filter, overviewNetworkFetch);
