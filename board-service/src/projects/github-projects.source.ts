import { mapFieldDefs, type GqlFieldNode } from '../issue-detail/project-fields';
import { ownerQuery, PrincipalState } from '../auth/github-principal';
import { mapLimit } from '../issues-metrics/github-issues.source';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { knownLabels } from '../auth/feedback-visibility';
import { hasSubmissionFooter } from '../auth/submission-footer';
import { buildOctokitClient } from '../sources/github-client';
import { closeReasonOf, isDeliveredClose, type CloseReason } from '../issues-metrics/close-reason';
import { tallyContributors } from './project-contributors';
import { completionPct, deriveIssueType, deriveProjectStatus, isSurfacedProjectName } from './project-derive';
import type {
  ActivityType,
  IProjectsSource,
  ProjectClose,
  ProjectDetailRaw,
  ProjectItemRaw,
  ProjectRollup,
  SourceCatalogEntry,
  SourceMembership,
} from './project.types';

/** Minimal shape of the GraphQL payloads we read (GitHub returns much more). */
interface GhClosedEvent {
  __typename: string;
  actor?: { login?: string } | null;
  createdAt?: string;
}
/** GitHub timeline `__typename` → our `ActivityType` (#259). Anything not listed
 *  (labels, subscriptions, …) is excluded at the query level via `itemTypes`. */
const ACTIVITY_BY_TYPENAME: Record<string, ActivityType> = {
  IssueComment: 'commented',
  ClosedEvent: 'closed',
  ReopenedEvent: 'reopened',
  AssignedEvent: 'assigned',
};
interface GhIssue {
  __typename: string;
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  /**
   * WHY the issue closed — Github's `Issue.stateReason`, the enum
   * `IssueStateReason` (#1014). SCREAMING_SNAKE on this API where the REST
   * ingest gets lowercase, so it is lower-cased before `closeReasonOf` narrows
   * it; typed as a bare string here because the payload is a cast, and a
   * declared union would claim a narrowing nobody checked.
   *
   * REQUIRED for the reason `body` below is required: a node from a query that
   * did not select it answers `undefined`, `closeReasonOf` maps that to "we were
   * not told", and the board counts that as delivery — so a document that
   * quietly dropped the field would put every abandoned issue back in the
   * throughput it was just taken out of, silently.
   *
   * WHAT ACTUALLY STOPS THAT IS A TEST, NOT THIS KEYWORD, and the difference is
   * worth stating in the file that argues "the type, not care". The REST ingest
   * builds an object literal, so its required field is compile-checked; here the
   * payload arrives through an unchecked generic assertion on `gql()`, so
   * `GhIssue` constrains nothing at runtime and dropping the field from a
   * selection still compiles. `github-projects.source.spec.ts` asserts both
   * `ROLLUP_ITEM_NODES` and `DETAIL_ITEM_NODES` name `stateReason`, which is the
   * guard that bites — and it covers the continuation queries too, because they
   * interpolate the same two constants.
   */
  stateReason: string | null;
  repository?: { nameWithOwner?: string } | null;
  /** Whoever OPENED the issue — what the rollup card's recency pick keys on
   *  (#488). Null on Github when the account is gone, which is not a bot. */
  author?: { login?: string } | null;
  assignees?: { nodes?: { login: string }[] } | null;
  closedByPullRequestsReferences?: { nodes?: { number: number; url: string }[] } | null;
  timelineItems?: { nodes?: GhClosedEvent[] } | null;
  /** Aliased `last:1` timeline over the meaningful event types (#259). `url` is a
   *  permalink to the event — present on IssueComment (the comment anchor); other
   *  event types carry none, so the row falls back to the issue URL (#376). */
  lastActivity?: { nodes?: { __typename: string; createdAt?: string; url?: string }[] } | null;
  /** Parent issue for native Github sub-issues (#273); null at top level. */
  parent?: { number: number } | null;
  /** Github labels (#376) — name + 6-digit hex color, no `#`. The rollup query
   *  asks for names alone (it places a close, it never renders a label, #497),
   *  so `color` is absent on that path; only `toItem`, on the detail path, reads
   *  it. Optional for that reason. `totalCount` rides with both, so the mapping
   *  can say whether the page IS the issue's label set (#497). */
  labels?: { totalCount?: number | null; nodes?: { name: string; color?: string }[] | null } | null;
  /**
   * The issue's markdown body — how a board ROW is placed by the footer the
   * feedback form wrote (#516) rather than by labels ordinary triage changes.
   *
   * REQUIRED, and the requirement is the point. A body that was never fetched is
   * not "no footer", it is "we could not tell", and everywhere else in this
   * control that distinction is carried as a third value and withheld on. There
   * is no third value here: `hasSubmissionFooter` answers a boolean, so an
   * unfetched body would collapse to an authoritative "not a submission" — the
   * exact fall-through that made #516 a bug. Rather than widen the type, the
   * requirement is enforced at the boundary: only a payload from a query that
   * SELECTS `body` may be typed as a `GhIssue`, so a node from a bodyless query
   * cannot be fed to `toItem` without a compile error.
   *
   * The rollup's item reads therefore do not — and must not — produce these.
   * They are every board times a hundred items on every rollup refresh, the read
   * #518 put a single-flight latch on; its closes are mapped inline in
   * `summarize` and get their marker from the shared submission index instead. Github types
   * `Issue.body` as `String!`, so any query that selects it gets a string.
   *
   * The body never leaves `toItem`. The mapper turns it into a boolean and drops
   * it, so no submission's words or address enter the Projects cache at all.
   */
  body: string;
}
/** The generic enumerable field-value nodes we read for `customFields` (#401) —
 *  single-select + iteration only (text/number/date are out of scope). Shape
 *  matches the inline fragments proven in `issue-detail/project-fields.ts`
 *  (PR2), except we read the value's own display name/title directly (`name` /
 *  `title`) instead of an option/iteration id — this is a read-only display
 *  list, not a write-back path, so no id → name lookup is needed. */
interface GhFieldValueNode {
  __typename?: string;
  name?: string;
  title?: string;
  field?: { id?: string; name?: string } | null;
}
interface GhItem {
  fieldValues?: { nodes?: GhFieldValueNode[]; pageInfo?: GhPageInfo } | null;
  content?: GhIssue | { __typename: string } | null;
}

/** lowercase, non-alphanumeric runs → `-`, trim leading/trailing `-` (#401).
 *  MUST stay identical to the frontend's `slug()` in `filter-group.ts` (Task 3)
 *  — a mismatch means a filter's slug won't match the issue's customFields key. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Fold a project item's `fieldValues` nodes into `customFields` (#401):
 *  fieldSlug → the value display-name(s) held for enumerable fields only
 *  (single-select option name, iteration title). Text/number/date and empty
 *  values are skipped. `undefined` when nothing enumerable is set, so the
 *  board can omit `customFields` entirely rather than carry `{}`. */
export function toCustomFields(nodes: GhFieldValueNode[] | undefined | null): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  for (const n of nodes ?? []) {
    const fieldName = n.field?.name;
    const value =
      n.__typename === 'ProjectV2ItemFieldSingleSelectValue'
        ? n.name
        : n.__typename === 'ProjectV2ItemFieldIterationValue'
          ? n.title
          : undefined;
    if (!fieldName || !value) continue; // ignore text/number/date + empty values (scope A)
    const key = slug(fieldName);
    (out[key] ??= []).push(value);
  }
  return Object.keys(out).length ? out : undefined;
}
/** A Github connection's cursor half. `hasNextPage` is optional because a
 *  payload without one is a payload that never said there was more — which is
 *  how every read here terminates, and how a fixture without paging behaves. */
interface GhPageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}
interface GhItemsConnection {
  /** What Github says the board holds, which is what the read is checked
   *  against once its pages run out (#690) — not a log line.
   *
   *  OPTIONAL, because these payloads are cast rather than checked and a
   *  document that stopped selecting the field would produce exactly this: a
   *  required declaration would only make the compiler agree with a lie, and
   *  quietly, since `checkComplete` reads an absent total as "nothing to check
   *  against". `ITEMS_CONNECTION_HEAD` and its test are what actually keep the
   *  field in the four documents. */
  totalCount?: number;
  pageInfo?: GhPageInfo | null;
  nodes: GhItem[];
}
interface GhProject {
  createdAt?: string | null;
  fields?: { nodes?: (GqlFieldNode | null)[]; pageInfo?: GhPageInfo } | null;
  number: number;
  title: string;
  url: string;
  closed: boolean;
  /** Optional for the same reason: a board node arriving without its items
   *  connection is a payload this code has to survive, not a shape the compiler
   *  can promise. `pageItems` is where that is handled, and what it returns
   *  always has one — see `PagedProject`. */
  items?: GhItemsConnection;
}

/**
 * How a page walk ended (#690). `end` is Github saying there is nothing after
 * this page; every other arm is the walk stopping while it was still being told
 * there was more, and the shortfall line names which — a repeated cursor is not
 * a board that outgrew the cap, and neither is a page that failed.
 */
type StopReason =
  | { kind: 'end' }
  | { kind: 'capped' }
  | { kind: 'stalled'; cursor: string }
  | { kind: 'cursorless' }
  | { kind: 'failed'; error: string };

/**
 * A board whose items have been walked, and whether the walk got all of them
 * (#690). `itemsComplete` is the source's answer to the field of the same name
 * on `ProjectRollup`: only this layer holds the `totalCount` Github reports
 * beside the items, so only this layer can say whether the read is whole.
 */
type PagedProject = Omit<GhProject, 'items'> & { items: GhItemsConnection; itemsComplete: boolean };

/** The cursor to ask for next, or null when this page is the last one. */
const nextCursor = (info: GhPageInfo | null | undefined): string | null =>
  info?.hasNextPage ? (info.endCursor ?? null) : null;

/** Github said there was another page and gave nothing to ask for it with — a
 *  contradiction, not an end (#690). `nextCursor` answers null for both, so the
 *  walk stops either way; this is what keeps the two from being REPORTED as the
 *  same thing, since one of them is a board that changed under the read and the
 *  other is a payload that does not add up. */
const cursorless = (info: GhPageInfo | null | undefined): boolean => !!info?.hasNextPage && !info.endCursor;

/** The minimal identity the board list reads (#404) — node id, number, title,
 *  url, closed — deliberately without `items`, so the query stays light. The
 *  picker's catalog and, since #1007, the rollup's own board walk both read it. */
interface GhCatalogProject {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
}

const isIssue = (c: GhItem['content']): c is GhIssue => !!c && c.__typename === 'Issue';

/** A GraphQL issue node in the shape the shared close predicate reads (#1014).
 *  Github's GraphQL enum is SCREAMING_SNAKE (`NOT_PLANNED`) where the REST
 *  ingest's field is lowercase (`not_planned`), so the case is folded once here
 *  rather than at each of the five counts below — a second spelling of the fold
 *  is how one of them would end up counting an abandoned issue. */
const closeOf = (i: GhIssue): { closedAt: string | null; stateReason: CloseReason } => ({
  closedAt: i.closedAt ?? null,
  stateReason: closeReasonOf(i.stateReason?.toLowerCase()),
});

/** The issue's most recent meaningful timeline event (#259). Falls back to
 *  `opened` at `createdAt` when the issue has no comment/close/reopen/assign yet. */
function lastActivityOf(i: GhIssue): { type: ActivityType; atISO: string; href?: string } {
  const node = (i.lastActivity?.nodes ?? [])[0];
  const type = node && ACTIVITY_BY_TYPENAME[node.__typename];
  // `node.url` is the event permalink (comment anchor); undefined for events that
  // carry none → the row links to the issue instead (#376).
  if (type && node?.createdAt) return { type, atISO: node.createdAt, href: node.url };
  return { type: 'opened', atISO: i.createdAt ?? '' };
}

/** One connection page, and the most pages any of the THREE walks below will
 *  take (#690) — a board's items, the board list, and the catalog, which got
 *  both guards in this issue's fix round.
 *
 *  Github caps a connection at 100 per page; twenty of them is 2000 items, past
 *  anything on these boards. What the cap bounds is a connection that keeps
 *  saying there is more while its cursor keeps MOVING: a read that reaches it
 *  serves what it has and says so, rather than throwing or withholding the
 *  board. A cursor handed back unchanged is a different fault and is stopped by
 *  the stall check one round trip in, not nineteen — the cap used to be the only
 *  thing standing between that payload and a loop, which is why it once claimed
 *  the job. */
const ITEMS_PER_PAGE = 100;
const MAX_PAGES = 20;
/** How many boards' items the rollup reads at once (#1007). Enough that an org
 *  of ordinary size pays one round trip after the board list, and few enough
 *  that one wide org is not a burst for Github's secondary limit. */
const BOARD_CONCURRENCY = 8;

/**
 * The two fields every items connection is read for besides its nodes (#690):
 * what Github says the board holds, and the cursor to ask for the next page
 * with. Written once and interpolated into all four documents, because these
 * are the fields the mechanism RUNS on and a document quietly missing one fails
 * silently in the worst direction: without `totalCount` the payload's field is
 * `undefined`, `checkComplete` has nothing to check against and calls every
 * board whole, and each board over a hundred items goes back to drawing its day
 * series off its oldest hundred — green suite, clean `tsc`, #690 reinstated.
 * The type cannot catch that, and no longer pretends to: `GhItemsConnection`
 * declares `totalCount?: number` precisely because these payloads are cast
 * rather than checked, so a required declaration would only have the compiler
 * agreeing with a document that had stopped selecting the field. What keeps the
 * field in all four documents is this constant and the test asserting every
 * items connection contains it.
 */
export const ITEMS_CONNECTION_HEAD = `totalCount pageInfo{ hasNextPage endCursor }`;

/**
 * The item nodes the ROLLUP reads, written once and interpolated into
 * `ROLLUP_ITEMS_PAGE_QUERY`, which reads every page of a board's rollup items,
 * the first one included since #1007 (#690).
 *
 * `labels` is here for one reason only (#497): the recency line names a closed
 * issue by title, and a feedback submission triaged onto a board has the end
 * user's first line for a title, so `ProjectsService` needs the labels to tell a
 * submission from a team issue before it picks one. Names only — the rollup
 * never renders a label — and the same page size as the detail query, so the two
 * reads agree on what an issue's labels are. It documented `LIST_QUERY` until
 * #690 moved the selection into this constant.
 *
 * Shared rather than copied, because a divergent copy would break silently in
 * both directions. It must keep `labels(first:20){ totalCount ... }` — the #497
 * gate withholds when `knownLabels` cannot show the page reached the end, so a
 * continuation page without the totalCount would read as "no feedback label
 * here" and print an end user's first line. And it must NOT grow `body`: that
 * is twenty boards times a hundred markdown documents per refresh, which is
 * what the rollup shape test guards against.
 *
 * Exported for that test alone: it asserts that both documents contain this
 * whole string, so the two cannot come apart in ANY field rather than in the
 * three a spot check happened to name.
 */
export const ROLLUP_ITEM_NODES = `
nodes{ content{ __typename
  ... on Issue{
    number title url state closedAt stateReason
    repository{ nameWithOwner }
    author{ login }
    labels(first:20){ totalCount nodes{ name } }
    assignees(first:1){ nodes{ login } }
    timelineItems(itemTypes:[CLOSED_EVENT], last:1){ nodes{ __typename ... on ClosedEvent{ actor{ login } } } }
  } } }`;

/**
 * The item nodes the DETAIL read maps, shared between `DETAIL_QUERY` and its
 * continuation for the same reason (#690) — and here the requirement is the
 * mirror image: it MUST select `body`. `toItem`'s `GhIssue.body` is required so
 * that an unfetched body cannot collapse to an authoritative "not a submission"
 * (#516), and a continuation page missing it would put every feedback row on
 * that page back in the clear.
 *
 * Exported for the same test, for the same reason.
 */
// GitHub permits 50 project fields, including built-ins. Read up to the API's
// 100-entry page maximum and require a complete connection before using it.
// https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects
export const DETAIL_ITEM_NODES = `
nodes{
  fieldValues(first: 100) {
    pageInfo { hasNextPage }
    nodes {
      __typename
      ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { id name } } }
      ... on ProjectV2ItemFieldIterationValue    { title field { ... on ProjectV2FieldCommon { name } } }
    }
  }
  content{ __typename
    ... on Issue{
      number title url state createdAt updatedAt closedAt stateReason
      repository{ nameWithOwner }
      author{ login }
      parent{ number }
      body
      labels(first:20){ totalCount nodes{ name color } }
      assignees(first:5){ nodes{ login } }
      closedByPullRequestsReferences(first:5, includeClosedPrs:true){ nodes{ number url } }
      timelineItems(itemTypes:[CLOSED_EVENT], last:1){ nodes{ __typename ... on ClosedEvent{ actor{ login } createdAt } } }
      lastActivity: timelineItems(itemTypes:[ISSUE_COMMENT, CLOSED_EVENT, REOPENED_EVENT, ASSIGNED_EVENT], last:1){ nodes{ __typename ... on IssueComment{ createdAt url } ... on ClosedEvent{ createdAt } ... on ReopenedEvent{ createdAt } ... on AssignedEvent{ createdAt } } }
    } } }`;

/** One board's page of ROLLUP items, addressed by board number (#690). With no
 *  `$after` it is the first page, which is how the rollup reads every board
 *  since #1007: the board list comes from `CATALOG_QUERY`, and each board's
 *  items are asked for only once that list has shown the board is there. */
const ROLLUP_ITEMS_PAGE_QUERY = `
query($owner:String!,$number:Int!,$after:String){
  organization(login:$owner){
    projectV2(number:$number){
      items(first:${ITEMS_PER_PAGE}, after:$after){
        ${ITEMS_CONNECTION_HEAD}
        ${ROLLUP_ITEM_NODES}
      }
    }
  }
}`;

const DETAIL_QUERY = `
query($owner:String!,$number:Int!){
  organization(login:$owner){
    projectV2(number:$number){
      number title url closed createdAt
      fields(first: 100) { pageInfo { hasNextPage } nodes {
        __typename
        ... on ProjectV2FieldCommon { id name createdAt }
      } }
      items(first:${ITEMS_PER_PAGE}){
        ${ITEMS_CONNECTION_HEAD}
        ${DETAIL_ITEM_NODES}
      }
    }
  }
}`;

/** The board page's next page of items (#690) — same selection as the query it
 *  continues, `body` included. */
const DETAIL_ITEMS_PAGE_QUERY = `
query($owner:String!,$number:Int!,$after:String!){
  organization(login:$owner){
    projectV2(number:$number){
      items(first:${ITEMS_PER_PAGE}, after:$after){
        ${ITEMS_CONNECTION_HEAD}
        ${DETAIL_ITEM_NODES}
      }
    }
  }
}`;

/** Every open board's identity, paginated — no `items`, so it stays cheap
 *  regardless of board size (#404, the add-to-project picker's candidate list,
 *  and since #1007 the rollup's board list). */
const CATALOG_QUERY = `
query($owner:String!,$after:String){
  organization(login:$owner){
    projectsV2(first:50, after:$after, query:"is:open"){
      totalCount
      nodes{ id number title url closed }
      pageInfo{ hasNextPage endCursor }
    }
  }
}`;

export class StatusResolutionError extends Error {
  constructor(detail: string) {
    super(`Cannot resolve project status: ${detail}`);
    this.name = 'StatusResolutionError';
  }
}

const asMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The board itself stopped being there mid-walk — deleted, archived or made
 * private between page one and page two (#697).
 *
 * A type rather than a message, because `getProject` has to tell this apart from
 * every other way a page can fail: this one means "no such board", and a 502 on
 * the same continuation means "this org could not be read". Both used to come
 * back as a null board, and a caller reading two orgs cannot act on a null that
 * means either.
 */
class BoardGoneError extends Error {}

/**
 * Live Projects source: the org's **GitHub Projects (v2)** boards, read over
 * GraphQL. A board's issues are its project items; completion is closed-share.
 * Auto-titled personal boards ("@x's untitled project") and closed boards are
 * hidden. Requires the token to carry project read (read:project / a GitHub App
 * with organization_projects: read).
 */
export class GithubProjectsSource implements IProjectsSource {
  private readonly principalState = new PrincipalState(() => ({
    graphql: null as ReturnType<typeof buildOctokitClient>['graphql'] | null,
    boardsInFlightByOrg: new Map<string, Promise<PagedProject[]>>() as Map<string, Promise<PagedProject[]>>
  }));
  private readonly logger = new Logger(GithubProjectsSource.name);
  /** The count of abandoned closes last reported per owner and project number,
   *  so the "closed issues were not delivered" line is logged once per change
   *  of the count rather than once per rollup refresh (#1450). Two owners may
   *  each hold a project with the same number, so the key carries both. */
  private readonly abandonedClosesByProject = new Map<string, number>();
  private get graphql(): ReturnType<typeof buildOctokitClient>['graphql'] | null { return this.principalState.current.graphql; }
  private set graphql(value: ReturnType<typeof buildOctokitClient>['graphql'] | null) { this.principalState.current.graphql = value; }
  /** The list read currently in flight PER ORG, if any — see `listBoardNodes`
   *  (#518). Keyed by org since #697: one instance now serves every org the
   *  board covers, and a single latch would have handed one org's boards to a
   *  caller that asked about another. */
  private get boardsInFlightByOrg(): Map<string, Promise<PagedProject[]>> { return this.principalState.current.boardsInFlightByOrg; }
  private set boardsInFlightByOrg(value: Map<string, Promise<PagedProject[]>>) { this.principalState.current.boardsInFlightByOrg = value; }

  // No `owner` field, and that absence is the whole of #697 on this class.
  //
  // It used to hold `orgFor(config, 'PROJECTS_OWNER')`, settled in the
  // constructor for the instance's whole life — which is why a deployment naming
  // two orgs in `GITHUB_ORGS` served the first org's boards and nothing else:
  // `PROJECTS_OWNER` carried no Joi default and was unset everywhere we ran, so
  // `orgFor` fell to `GITHUB_ORGS[0]` and there was nowhere to put the second.
  // Both that key and `orgFor` are gone (#1209 part 4).
  //
  // The `$owner: String!` in every document below is still ONE login, and always
  // will be — Github's `organization(login:)` takes one org. What changed is
  // where that one login comes from: an argument on each method rather than a
  // field, so the same instance answers about whichever org it is asked about.
  // The set-valued question — which orgs does this surface cover — is asked one
  // layer up, by `ProjectsService`, whose caches are already per org.
  constructor(private readonly config: ConfigService) {}

  private gql() {
    if (!this.graphql) this.graphql = buildOctokitClient(this.config).graphql;
    return this.graphql;
  }

  /**
   * The org's boards with their first hundred items — the one payload BOTH
   * `listProjects` and `projectMemberships` are made of (#518).
   *
   * Filling the Projects cache asks for the rollup and the membership index
   * together, and each used to send the list query for itself: the same boards,
   * the same hundred items, the same label names #497 added, fetched twice on
   * every cold read. Callers already in flight share the round trip here, so a
   * cold read costs one.
   *
   * A latch, not a cache: it holds nothing once the fetch lands. How stale a
   * board list may be is `ProjectsService`'s decision (it owns the TTL), and a
   * second, quieter expiry down here is exactly the kind of thing that makes
   * two caches disagree about what "now" means.
   *
   * Per ORG since #697, because the rollup now fans out across every configured
   * org at once: an org-blind latch would have handed the second org's caller
   * the first org's boards, which is a worse bug than the extra round trip it
   * was saving.
   */
  private listBoardNodes(org: string): Promise<PagedProject[]> {
    const running = this.boardsInFlightByOrg.get(org);
    if (running) return running;
    const flight = this.fetchBoards(org)
      // Released on failure too, so a bad minute doesn't pin every later read to
      // the same rejection. Its OWN slot: a read that failed must not delete a
      // later read's latch for the same org.
      .finally(() => {
        if (this.boardsInFlightByOrg.get(org) === flight) this.boardsInFlightByOrg.delete(org);
      });
    this.boardsInFlightByOrg.set(org, flight);
    return flight;
  }

  /**
   * Forget the board read held for `org`, or every org's when none is named
   * (#713) — see `IProjectsSource.disownInFlightReads`. The latch above is the
   * one piece of read state in this class a write cannot otherwise see, and a
   * write that does not say this is answered with the boards from before it.
   *
   * Deleting the slot, and nothing else: the fetch behind it keeps running and
   * still resolves for whoever is already awaiting it — it is owed them, and
   * `ProjectsService`'s epoch is what stops its answer being cached. What
   * changes is that the next caller starts its own read instead of joining it.
   *
   * The `.finally` above deletes only the slot still holding ITS OWN promise, so
   * a forgotten flight landing after a newer one went out cannot take the newer
   * one's latch with it.
   *
   * Per org when it is given one (#697), which is what `ProjectsService.refill`
   * passes: "Sync now" for one org must not make another org's readers pay for a
   * fresh walk. `dropCaches` names no org and so clears every slot, because a
   * write is not told which org it landed in — see the argument there.
   */
  disownInFlightReads(org?: string): void {
    if (org === undefined) this.boardsInFlightByOrg.clear();
    else this.boardsInFlightByOrg.delete(org);
  }

  /**
   * Every open board a read will surface, with every one of its items (#690).
   *
   * Two connections page here, and both used to stop silently at their first
   * page: `projectsV2` at twenty boards, and each board's `items` at a hundred.
   * A board over the item cap was served short with nothing but a log line
   * saying so — and because Github returns items in board position order, the
   * tail that fell off was the most recently added end, so the error was
   * invisible at ten-week resolution and total at day resolution.
   *
   * Inside the latch, so both `listProjects` and `projectMemberships` still
   * share one read however many pages it takes (#518).
   *
   * The board list first, then each board's items by number (#1007). It used to
   * be one document asking for twenty boards with a hundred items each, and
   * Github prices a GraphQL document by what it COULD return rather than by what
   * it does: 60 points per org per refill, whether the org had twenty boards or
   * none, re-paid at every access re-check. Now the list costs 1 point per fifty
   * boards and each board's first page 3, so an org pays for the boards it has.
   */
  private async fetchBoards(org: string): Promise<PagedProject[]> {
    const boards = await this.boardList(org, `projectsV2 for ${org}`);
    // Surfaced BEFORE paged, the way `getProject` has always done it: a board no
    // read shows — the "Acme" umbrella, an auto-titled personal board (#202) —
    // is dropped by both callers moments later, so a read spent on one buys a
    // page of items nobody will ever be served. Both callers still filter for
    // themselves; the filter is pure and cheap, and this one is about what the
    // read COSTS rather than about what it returns.
    //
    // In parallel, a few at a time: every surfaced board is a round trip now, and
    // one after another would be slower still. It is still two round trips where
    // there was one, so a cold rollup is slower whenever Github answers in about
    // the same time whatever the size: 1.5 to 3.4 times, measured at a flat
    // 300 ms in the #1025 review. That is the price of the points saved. A
    // board's own later pages stay sequential inside `boardItems`, because each
    // needs the cursor the page before it returned.
    const paged = await mapLimit(boards.filter((b) => this.surfaced(b)), BOARD_CONCURRENCY, (board) => this.boardItems(org, board));
    return paged.filter((p): p is PagedProject => p !== null);
  }

  /**
   * Every open board's identity, walked to the end of the connection (#690),
   * for the rollup and for the add-to-project picker alike (#1007). Throws when a
   * page cannot be read; a walk that ends short is served and said, through
   * `checkComplete`, under `what`.
   */
  private async boardList(org: string, what: string): Promise<GhCatalogProject[]> {
    const boards: GhCatalogProject[] = [];
    // Every node the walk SAW, which is what `totalCount` counts, null ones
    // included.
    let seen = 0;
    let totalCount: number | null = null;
    let after: string | null = null;
    let pages = 0;
    let stop: StopReason = { kind: 'end' };
    for (;;) {
      const data = await this.gql()<{
        organization?: { projectsV2?: { totalCount?: number; pageInfo?: GhPageInfo | null; nodes?: (GhCatalogProject | null)[] } };
      }>(ownerQuery(CATALOG_QUERY, org), { owner: org, after });
      const conn = data.organization?.projectsV2;
      const nodes = conn?.nodes ?? [];
      seen += nodes.length;
      boards.push(...nodes.filter((n): n is GhCatalogProject => !!n));
      totalCount ??= conn?.totalCount ?? null;
      pages += 1;
      const next = nextCursor(conn?.pageInfo);
      if (next === null) {
        if (cursorless(conn?.pageInfo)) stop = { kind: 'cursorless' };
        break;
      }
      // The cursor we were just handed is the cursor we asked with: the page
      // after this one IS this one, so the nineteen further round trips the cap
      // allows would each read the same page again.
      if (next === after) {
        stop = { kind: 'stalled', cursor: next };
        break;
      }
      if (pages >= MAX_PAGES) {
        stop = { kind: 'capped' };
        break;
      }
      after = next;
    }
    this.checkComplete(what, 'boards', seen, totalCount, stop);
    return boards;
  }

  /**
   * One board's rollup items, every page, or `null` for a board that went away
   * between the list and this read (#1007) — deleted, archived or made private,
   * which is a board the rollup no longer has rather than a failure. Any other
   * failure of the FIRST page throws and takes the org's read with it, as a
   * failed list read always did; a later page fails under `serve-short`.
   */
  private async boardItems(org: string, board: GhCatalogProject): Promise<PagedProject | null> {
    const data = await this.gql()<{ organization?: { projectV2?: { items?: GhItemsConnection } | null } }>(
      ownerQuery(ROLLUP_ITEMS_PAGE_QUERY, org),
      { owner: org, number: board.number, after: null },
    );
    const found = data.organization?.projectV2;
    if (!found) {
      this.logger.warn(`project #${board.number} "${board.title}" went away between the board list and its items read`);
      return null;
    }
    const { number, title, url, closed } = board;
    // `serve-short`: the rollup asks about every board at once, so one board's
    // flaky second page must cost that board its tail and not every other board
    // with it. See `pageItems`.
    return this.pageItems(org, { number, title, url, closed, items: found.items }, ROLLUP_ITEMS_PAGE_QUERY, 'serve-short');
  }

  /**
   * One board's items, followed to the end of the connection (#690).
   *
   * `continuation` is the query for the next page, and it carries the SAME item
   * selection as the query that fetched the first one — see `ROLLUP_ITEM_NODES`
   * and `DETAIL_ITEM_NODES` for what a divergent copy would quietly break.
   *
   * Its TYPE is the union of the two documents rather than `string`, and that is
   * load-bearing rather than pedantry — the same shape `github-repos.source.ts`
   * carries on its route parameter. The census in
   * `capability/github-write-census.contract.ts` proves a graphql READ from a
   * document it can resolve statically and calls everything else a write, so a
   * `string` here turns CI red with
   * `GithubProjectsSource.pageItems → graphql(a document read at run time)`.
   * Both arms open with `query`, so the census reads it for what it is.
   *
   * `onFailure` is where the two reads genuinely differ, and it exists because
   * this lane created the failure: before #690 page two was never asked for, so
   * it could not fail. The rollup asks about every board at once, so a 502 on
   * board 9's second page must cost board 9 its tail and nothing else —
   * `serve-short` keeps the pages already in hand, lets `checkComplete` say the
   * read came up short with the error in the line, and the board serves no day
   * series because `itemsComplete` comes back false. The board page asks about
   * ONE board, and half a board rendered as a whole one is the one answer it
   * must not give, so it takes `throw`. What `getProject` then does with the
   * throw depends on which failure it was (#697): a `BoardGoneError` is a board
   * this org no longer holds and becomes a null, anything else is this org being
   * unreadable and travels on up.
   */
  private async pageItems(
    org: string,
    p: GhProject,
    continuation: typeof ROLLUP_ITEMS_PAGE_QUERY | typeof DETAIL_ITEMS_PAGE_QUERY,
    onFailure: 'serve-short' | 'throw',
  ): Promise<PagedProject> {
    // Every read of the first page goes through `?.`: a board node without an
    // items connection used to throw a TypeError right here, OUTSIDE the try
    // below, which rejected the rollup and every other board on it — the
    // isolation `serve-short` promises, defeated by the shape of one payload.
    const nodes = [...(p.items?.nodes ?? [])];
    let after = nextCursor(p.items?.pageInfo);
    let pages = 1;
    // The first page came from the query that fetched the board, so its own
    // pageInfo is judged here rather than in the loop it never enters.
    let stop: StopReason = cursorless(p.items?.pageInfo) ? { kind: 'cursorless' } : { kind: 'end' };
    while (after !== null) {
      let page: GhItemsConnection | undefined;
      try {
        const data = await this.gql()<{ organization?: { projectV2?: { items?: GhItemsConnection } | null } }>(
          ownerQuery(continuation, org),
          { owner: org, number: p.number, after },
        );
        page = data.organization?.projectV2?.items;
      } catch (err) {
        if (onFailure === 'throw') throw err;
        stop = { kind: 'failed', error: asMsg(err) };
        break;
      }
      // A payload that answered no items connection at all: not an end — Github
      // said there was another page — so it is the same failure as a thrown
      // page and takes the same mode. Octokit does not throw for it: a board
      // deleted, archived or made private between page one and page two comes
      // back as a well-formed `{organization:{projectV2:null}}` with no
      // `errors` array, so this failure arrives as a SHAPE. Serving it short on
      // the board page would hand `getProject` half a board, and that route
      // renders `items` without consulting `itemsComplete`.
      if (!page) {
        const err = new BoardGoneError('the continuation answered no items connection');
        if (onFailure === 'throw') throw err;
        stop = { kind: 'failed', error: err.message };
        break;
      }
      nodes.push(...(page.nodes ?? []));
      pages += 1;
      const next = nextCursor(page.pageInfo);
      if (next === null) {
        if (cursorless(page.pageInfo)) stop = { kind: 'cursorless' };
        break;
      }
      if (next === after) {
        stop = { kind: 'stalled', cursor: next };
        break;
      }
      if (pages >= MAX_PAGES) {
        stop = { kind: 'capped' };
        break;
      }
      after = next;
    }
    // Checked against the total the FIRST page reported — the figure the read
    // started against. A board that grew while the pages were being walked would
    // otherwise report a shortfall it did not have.
    const itemsComplete = this.checkComplete(
      `project #${p.number} "${p.title}"`,
      'items',
      nodes.length,
      p.items?.totalCount,
      stop,
    );
    return { ...p, items: { ...p.items, nodes }, itemsComplete };
  }

  /**
   * Did the read get everything Github said was there (#690)?
   *
   * Serving short is the right answer once the pages have been walked — a board
   * that changed under a paged read is the usual cause, and it heals itself on
   * the next refresh, so failing loudly for it would be worse than the bug this
   * replaces. Serving short SILENTLY is not: both numbers go in the line, so the
   * shortfall is visible from outside the process.
   *
   * The answer is RETURNED as well as logged, because a log line is only visible
   * to an operator and this decides something a reader sees: a board that came
   * up short serves no day series at all (#663), the trailing bucket being made
   * of exactly the newest items a short read loses. A payload that reported no
   * total takes the COUNT half of the gate out of play — nothing there can fail
   * — and leaves the other half standing: a walk that ended capped, stalled,
   * cursorless or failed still answers false and still warns, with `against no
   * total Github stated` where the two numbers would be. Every false carries a
   * line, whichever half produced it, so the flag and the log can never disagree
   * about one read.
   *
   * And the line says WHY the walk ended, because each ending is a different
   * fault wanting a different answer. A board that changed under the read fixes
   * itself on the next refresh; a repeated cursor is Github contradicting itself
   * and worth a bug report; a promised page with no cursor to ask for it is the
   * same contradiction in another spelling; the page cap is a board that outgrew
   * the walk; a failed page is a bad minute on the network. A reader told only
   * "it came up short" has to guess which.
   */
  private checkComplete(
    subject: string,
    unit: 'items' | 'boards',
    read: number,
    totalCount: number | null | undefined,
    stop: StopReason,
  ): boolean {
    const short = totalCount != null && read < totalCount;
    // BOTH have to hold. The count agreeing is not the walk finishing: a board
    // that reported 150, grew by 100 while its pages were walked and then had a
    // page fail has read 200 of 150 and is still missing whatever came after
    // the failure. Blessing that would serve a day series off a board nobody
    // followed to the end — which is #690 again, wearing a total that adds up.
    if (!short && stop.kind === 'end') return true;
    const why =
      stop.kind === 'capped'
        ? `and stopped at the ${MAX_PAGES}-page cap`
        : stop.kind === 'stalled'
          ? `and stopped because Github repeated the cursor ${stop.cursor}`
          : stop.kind === 'cursorless'
            ? 'and stopped because Github promised another page and gave no cursor to ask for it'
            : stop.kind === 'failed'
              ? `and stopped because a page failed: ${stop.error}`
              : // Only reachable while short: a walk that reached the end with
                // the count satisfied returned above.
                'after paging to the end — it changed while we read it';
    const against =
      totalCount == null
        ? `read ${read} ${unit}, against no total Github stated,`
        : short
          ? `read ${read} of ${totalCount} ${unit}`
          : `read ${read} ${unit}, as many as the ${totalCount} Github first reported,`;
    // Every false says why, out loud, on every path — a false with no line is
    // the silent shortfall this whole issue exists to remove.
    // What is known here is only that the opening total has already been met, so
    // it bounds nothing. WHY the walk stopped is in `why` and is not always
    // growth: a repeated cursor is Github contradicting itself and a failed page
    // is a failed page, so the line must not name a cause it cannot see.
    const pastTotal =
      short || totalCount == null
        ? ''
        : ' — the total it started against was met before the walk stopped, so nothing here says what is still missing';
    this.logger.warn(`${subject}: ${against} ${why}${pastTotal}; serving ${read}`);
    return false;
  }

  /** Closed boards plus the boards `isSurfacedProjectName` filters out (auto-named
   *  personal boards + the "Acme" umbrella, #202) don't belong on the rollup —
   *  or on any other read, including the catalog (#404). Typed on the minimal
   *  `closed`/`title` shape so both `GhProject` and the lighter `GhCatalogProject`
   *  satisfy it. */
  private surfaced(p: Pick<GhProject, 'closed' | 'title'>): boolean {
    return !p.closed && isSurfacedProjectName(p.title);
  }

  private summarize(p: PagedProject, nowMs: number, org: string): ProjectRollup {
    const issues = p.items.nodes.map((n) => n.content).filter(isIssue);
    // Everything this board holds that the counts below leave out (#517): pull
    // requests, draft items, and any item whose content the token could not
    // read. Off the nodes we actually READ, which since #690 is every item the
    // board has — whether the read reached the end of the connection is checked
    // once, in `checkComplete`, where the paging finishes. Logged for the same
    // reason that shortfall is: a number the board chose not to count should be
    // visible from the outside.
    const excludedItems = p.items.nodes.length - issues.length;
    if (excludedItems > 0) {
      this.logger.warn(
        `project #${p.number} "${p.title}": ${excludedItems} of ${p.items.nodes.length} items are not issues; counts cover issues only`,
      );
    }
    const open = issues.filter((i) => i.state === 'OPEN').length;
    const closedRows = issues.filter((i) => i.state === 'CLOSED');
    // DELIVERED closes only (#1014). `state === 'CLOSED'` counted an issue
    // abandoned as "not planned" as throughput, which on `acme` was 382 of
    // 3,318 closes. Filtered ONCE, here, because `closed`, the completion
    // percentage, the status chip and both contributor rings are all cut from
    // this one list — and the ring's runs only sum to `closed` while they are
    // cut from the same set as `closed` is. A closed row Github sent no instant
    // for falls out with them, which `recentCloses` already dropped and which
    // Github does not produce for a closed issue.
    const closedIssues = closedRows.filter((i) => isDeliveredClose(closeOf(i)));
    const closed = closedIssues.length;
    // The other half of the accounting above, on the same ground: a number the
    // board chose not to count should be visible from the outside. Kept apart
    // from `excludedItems` rather than added to it — that field means "this item
    // is not an issue" both in its own docblock and in the sentence the card
    // prints from it, and an abandoned issue is very much an issue. It also
    // leaves `completionPct`'s denominator, which is intended: an issue nobody
    // is going to do is neither open work nor delivered work.
    const abandonedCloses = closedRows.length - closed;
    if (abandonedCloses > 0) {
      const message =
        `project #${p.number} "${p.title}": ${abandonedCloses} of ${closedRows.length} closed issues were not delivered (not planned, duplicate, or closed with no time); they are out of closed, out of the ring and out of the completion denominator`;
      // The count moves only when an issue closes as not delivered or a board
      // changes, so a steady count is an expected state and repeats only at
      // debug; a change is the news worth a warn line.
      const key = `${org}/${p.number}`;
      if (this.abandonedClosesByProject.get(key) === abandonedCloses) {
        this.logger.debug(message);
      } else {
        this.abandonedClosesByProject.set(key, abandonedCloses);
        this.logger.warn(message);
      }
    }

    // Every DELIVERED close, newest first — not just the newest one. Which close the
    // rollup card may name depends on who is asking (#497), so the pick happens
    // in `ProjectsService`; the source's job is to hand up the candidates in
    // order. The board's own status still comes off the newest close whoever
    // asks, so the chip and the counts read the same for every caller.
    const recentCloses: ProjectClose[] = [...closedIssues]
      .sort((a, b) => Date.parse(b.closedAt as string) - Date.parse(a.closedAt as string))
      .map((i) => ({
        repo: i.repository?.nameWithOwner ?? '',
        number: i.number,
        title: i.title,
        url: i.url,
        by: (i.timelineItems?.nodes ?? [])[0]?.actor?.login ?? null,
        // Who opened it (#488) — the field the recency pick keys on. Distinct
        // from `by` above on every dependabot PR a teammate merges, which is
        // most of them.
        author: i.author?.login ?? null,
        atISO: i.closedAt as string,
        labels: knownLabels(i.labels),
      }));
    return {
      number: p.number,
      name: p.title,
      url: p.url,
      open,
      closed,
      pct: completionPct(open, closed),
      excludedItems,
      // Off the paging that actually happened, not a constant and not a
      // derivation from the counts above (#690) — `checkComplete` compared what
      // the walk read against the `totalCount` the board reported, and this is
      // its answer. `ProjectsService` withholds the day series on a false.
      itemsComplete: p.itemsComplete,
      // `abandonedCloses` rides along so the chip cannot call a board nobody
      // delivered on "just-started" when it in fact worked through issues and
      // dropped them (#1014). It enters no count — see `deriveProjectStatus`.
      status: deriveProjectStatus({ open, closed, lastClosedAtISO: recentCloses[0]?.atISO ?? null, abandoned: abandonedCloses }, nowMs),
      recentCloses,
      // The weekly close-rate is derived org-wide by ProjectsService from the
      // bulk issues list joined to memberships (#391); the source seeds empty.
      weeklyClosed: [],
      closedThisWeek: 0,
      // Seeded 0 like its pair (#851). The live source can answer neither — both
      // come from the org-wide join `ProjectsService` runs — and the seed is only
      // what the fallback lands on when that join produced nothing, which on this
      // source means a genuinely quiet week.
      openedThisWeek: 0,
      // The ring's per-member runs (#454), both attributions, from fields the
      // rollup query already carries — the close event's actor (read for
      // `lastClosed` above) and the issue's first assignee. No extra round-trip.
      contributors: tallyContributors(closedIssues.map((i) => (i.timelineItems?.nodes ?? [])[0]?.actor?.login)),
      // First assignee only. Github orders assignees, and splitting one closed
      // issue across two people would either double-count it or need fractions
      // — either way the runs would stop summing to `closed`, which is the one
      // property the ring depends on.
      contributorsByAssignee: tallyContributors(closedIssues.map((i) => (i.assignees?.nodes ?? [])[0]?.login)),
    };
  }

  private toItem(i: GhIssue): ProjectItemRaw {
    // `status` rides on the project item, not the issue — attached by the caller.
    // `color` is only asked for on the detail query — the rollup reads names
    // alone (#497) — and a row without one renders on the label's name, not a
    // swatch, which is already how a colourless fixture label behaves.
    const labels = (i.labels?.nodes ?? []).map((l) => ({ name: l.name, color: l.color ?? '' }));
    return {
      repo: i.repository?.nameWithOwner ?? '',
      number: i.number,
      title: i.title,
      url: i.url,
      status: '',
      state: i.state === 'CLOSED' ? 'closed' : 'open',
      closedAt: i.closedAt ?? null,
      // Beside `closedAt`, from the same node, through the same fold the counts
      // used (#1014) — so a row on the drill-in table and the `closed` figure
      // above it were decided by one reading of one field, and a reader can see
      // which of the closes in front of them the board counted.
      stateReason: closeOf(i).stateReason,
      labels,
      labelsComplete: knownLabels(i.labels) != null,
      // The body is read HERE and nowhere else (#516): it becomes a boolean and
      // is dropped, so a submission's words never reach the Projects cache.
      //
      // `toItem` may only ever be fed a payload from a query that SELECTS
      // `body`. `GhIssue.body` is required for that reason: an unfetched body
      // would answer `false` — an authoritative "not a submission" — and put
      // every feedback-repo row on the board back in the clear, which is #516
      // itself. Today the only such queries are `DETAIL_QUERY` and its
      // continuation `DETAIL_ITEMS_PAGE_QUERY` (#690), both built from
      // `DETAIL_ITEM_NODES`, and the only call site is `getProject`.
      submission: hasSubmissionFooter(i.body),
      type: deriveIssueType(labels.map((l) => l.name)),
      assignees: (i.assignees?.nodes ?? []).map((a) => a.login),
      prs: (i.closedByPullRequestsReferences?.nodes ?? []).map((pr) => ({
        number: pr.number,
        url: pr.url,
      })),
      createdAt: i.createdAt ?? '',
      updatedAt: i.updatedAt ?? '',
      lastActivity: lastActivityOf(i),
      parent: i.parent?.number ?? null,
    };
  }

  async listProjects(org: string): Promise<ProjectRollup[]> {
    const nowMs = Date.now();
    let nodes: PagedProject[];
    try {
      nodes = await this.listBoardNodes(org);
    } catch (err) {
      this.logger.error(`projectsV2 list failed for ${org}: ${asMsg(err)}`);
      throw err;
    }
    return nodes
      .filter((p) => this.surfaced(p))
      .map((p) => this.summarize(p, nowMs, org))
      .sort((a, b) => b.open + b.closed - (a.open + a.closed));
  }

  async projectMemberships(org: string): Promise<SourceMembership[]> {
    let nodes: PagedProject[];
    try {
      nodes = await this.listBoardNodes(org);
    } catch (err) {
      this.logger.error(`projectsV2 memberships failed for ${org}: ${asMsg(err)}`);
      throw err;
    }
    return nodes
      .filter((p) => this.surfaced(p))
      .map((p) => ({
        number: p.number,
        name: p.title,
        issueUrls: p.items.nodes.map((n) => n.content).filter(isIssue).map((i) => i.url),
      }));
  }

  /**
   * One board, or `null` — and `null` means exactly one thing (#697): this org
   * holds no surfaced board with that number.
   *
   * It used to mean that OR "this org could not be read", because the catch
   * below swallowed every error into the same null. `ProjectsService` walks
   * every configured org for a number now, and those two are different answers
   * there: an org that answered "not mine" is settled, and an org that could not
   * be read has said nothing and must not have its silence cached as a fact or
   * counted as the scope having looked. So a failure throws, and the caller
   * decides.
   *
   * The one failure that is genuinely an absence still answers null:
   * `BoardGoneError`, the board deleted, archived or made private between page
   * one and page two. A 502 on that same continuation is not — it is this org
   * being unreadable for this board, and #690's rule that half a board is never
   * served as a whole one is kept by throwing, which serves no board at all.
   */
  async getProject(org: string, number: number): Promise<ProjectDetailRaw | null> {
    const nowMs = Date.now();
    let p: PagedProject;
    try {
      const data = await this.gql()<{ organization?: { projectV2?: GhProject | null } }>(ownerQuery(DETAIL_QUERY, org), {
        owner: org,
        number,
      });
      const first = data.organization?.projectV2;
      // Surfaced first, then paged: a board this read answers null for is not
      // worth the round trips its remaining pages would cost.
      if (!first || !this.surfaced(first)) return null;
      p = await this.pageItems(org, first, DETAIL_ITEMS_PAGE_QUERY, 'throw');
    } catch (err) {
      if (err instanceof BoardGoneError) {
        this.logger.warn(`projectV2 ${org}#${number} went away mid-read: ${asMsg(err)}`);
        return null;
      }
      this.logger.warn(`projectV2 ${org}#${number} fetch failed: ${asMsg(err)}`);
      throw err;
    }
    const summary = this.summarize(p, nowMs, org);
    // Share the Issue page's identity heuristic, but require complete evidence.
    if (p.fields?.pageInfo?.hasNextPage !== false || !p.fields.nodes) {
      throw new StatusResolutionError(`${org}#${number} field definitions are incomplete`);
    }
    const statusFieldId = mapFieldDefs(p.fields?.nodes ?? [], p.createdAt)
      .find((field) => field.builtInStatus)?.fieldId;
    if (!statusFieldId) {
      throw new StatusResolutionError(`${org}#${number} has no uniquely identifiable seeded Status field`);
    }
    for (const node of p.items.nodes) {
      if (isIssue(node.content) && (node.fieldValues?.pageInfo?.hasNextPage !== false || !node.fieldValues.nodes)) {
        throw new StatusResolutionError(`${org}#${number} issue ${node.content.number} field values are incomplete`);
      }
    }
    // Narrowed through `isIssue` rather than cast, so `toItem`'s required `body`
    // is a constraint the compiler actually checks here (#516). It is not a
    // proof: `isIssue` keys on `__typename` alone, so what ultimately guarantees
    // a body is that this is the only call site and `DETAIL_QUERY` plus its
    // `DETAIL_ITEMS_PAGE_QUERY` continuation (#690) are the only queries that
    // reach it — which the query-shape tests in `github-projects.source.spec.ts`
    // pin from both directions.
    const items = p.items.nodes
      .flatMap((n) =>
        isIssue(n.content)
          ? [{
              ...this.toItem(n.content),
              status: n.fieldValues?.nodes?.find((value) =>
                value.__typename === 'ProjectV2ItemFieldSingleSelectValue' && value.field?.id === statusFieldId,
              )?.name ?? '',
              customFields: toCustomFields(n.fieldValues?.nodes),
            }]
          : [],
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return { ...summary, items };
  }

  /** Every open, surfaced board's id/number/title (#404) — the add-to-project
   *  picker's candidate list. Gated through the same `surfaced()` filter as
   *  `listProjects`/`projectMemberships`/`getProject` — the "Acme" umbrella
   *  and auto-titled personal boards aren't add-to-project candidates either.
   *  Paginated over all boards, fifty to a page and no `items`, so a wide org
   *  doesn't cost a heavy fetch.
   *
   *  The walk is `boardList`, the rollup's own, so its guards are the ones the
   *  rollup's walk carries (#690): a connection that never says it ended stops
   *  at the page cap or on a repeated cursor rather than spinning here. Nothing
   *  is withheld on a short catalog — a picker missing a board is a picker
   *  missing a board, and refusing to draw any would be worse — but the shortfall
   *  is said out loud. It counts every board the walk SAW, which is what
   *  `totalCount` counts, not just the surfaced ones, or every org that owns an
   *  umbrella board (#202) would report a shortfall. */
  async listProjectCatalog(org: string): Promise<SourceCatalogEntry[]> {
    let boards: GhCatalogProject[];
    try {
      boards = await this.boardList(org, `projectsV2 catalog for ${org}`);
    } catch (err) {
      this.logger.error(`projectsV2 catalog failed for ${org}: ${asMsg(err)}`);
      throw err;
    }
    return boards.filter((n) => this.surfaced(n)).map((n) => ({ id: n.id, number: n.number, title: n.title }));
  }
}
