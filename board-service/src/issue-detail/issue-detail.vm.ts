// Pure shaping (#235): map GitHub's GraphQL issue payload to our IssueDetail.
// No I/O, no client — the source fetches, this reshapes, so it unit-tests directly.

import { LabelConnection, knownLabels } from '../auth/feedback-visibility';
import {
  FieldValue,
  IssueComment,
  IssueDetail,
  IssueProjectMembership,
  IssueRelation,
  IssueRelations,
  LinkedPr,
  Person,
  PrState,
  ProjectFieldDef,
} from './issue-detail.types';
import { GqlFieldNode, GqlFieldValueNode, mapFieldDefs, mapFieldValue } from './project-fields';

/** The slice of GitHub's GraphQL response we read. Optional throughout — a
 *  half-null payload (deleted author, no milestone) must never throw. */
export interface GqlIssue {
  viewerCanUpdate?: boolean;
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED';
  url: string;
  body: string | null;
  createdAt: string;
  updatedAt: string;
  author: { login: string; name?: string | null } | null;
  /** `totalCount` rides alongside the nodes so the shaping can say whether the
   *  page IS the issue's label set — see `labelsComplete` (#497). */
  labels?: { totalCount?: number | null; nodes?: { name: string; color?: string | null }[] | null } | null;
  assignees?: { nodes?: { login: string; name?: string | null }[] | null } | null;
  milestone?: { title: string } | null;
  /** GitHub's org-level issue type (#467) — absent on an untyped issue, and on
   *  any org that has not enabled issue types at all. */
  issueType?: { name: string } | null;
  /** Relations (#469). Every one optional: an issue with no parent, no
   *  sub-issues and no dependencies comes back with nulls throughout. */
  parent?: GqlIssueRef | null;
  subIssues?: { nodes?: (GqlIssueRef | null)[] | null } | null;
  subIssuesSummary?: { total?: number | null; completed?: number | null } | null;
  blockedBy?: { nodes?: (GqlIssueRef | null)[] | null } | null;
  blocking?: { nodes?: (GqlIssueRef | null)[] | null } | null;
  closedByPullRequestsReferences?: {
    nodes?: { number: number; url: string; title: string; state: 'OPEN' | 'CLOSED' | 'MERGED' }[] | null;
  } | null;
  comments?: {
    totalCount?: number;
    nodes?: { databaseId?: number; viewerCanUpdate?: boolean; url: string; author: { login: string; name?: string | null } | null; body: string | null; createdAt: string }[] | null;
  } | null;
  /** Projects v2 memberships (#384) — each item carries its project's field
   *  schema and this issue's fieldValues on that project. Optional throughout;
   *  a project with no matching field for a value (deleted field) is just
   *  dropped by `mapFieldValue`/`mapFieldDefs`, never thrown. */
  projectItems?: { nodes?: (GqlProjectItemNode | null)[] | null } | null;
}

/** One `ProjectV2Item` node: the issue's membership on a single project. */
export interface GqlProjectItemNode {
  id?: string;
  project?: {
    id?: string;
    number?: number;
    title?: string;
    /** The project's own creation time, which is how a field says it is the
     *  Status GitHub seeded the project with — `seededWithProject`. */
    createdAt?: string | null;
    fields?: { nodes?: (GqlFieldNode | null)[] | null } | null;
  } | null;
  fieldValues?: { nodes?: (GqlFieldValueNode | null)[] | null } | null;
}

/** One related issue as GitHub returns it (parent / sub-issue / dependency). */
export interface GqlIssueRef {
  number: number;
  title?: string | null;
  url?: string | null;
  state?: 'OPEN' | 'CLOSED' | null;
  repository?: { nameWithOwner?: string | null } | null;
  /** Selected so the #497 words gate can place this neighbour — a relation's
   *  TITLE is an end user's first line when the relation is a submission. */
  labels?: LabelConnection | null;
}

function person(a: { login: string; name?: string | null } | null | undefined): Person | null {
  if (!a) return null;
  return { login: a.login, name: a.name ?? null };
}

const PR_STATE: Record<string, PrState> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };

/**
 * One related issue → an `IssueRelation` (#469). `nameWithOwner` is what makes a
 * cross-repo reference renderable as `owner/repo#NN`; a reference that somehow
 * arrives without a repository falls back to the HOST issue's own owner/repo
 * (the only repo it could belong to), so the page never renders `undefined#NN`
 * the way a short repo key once did (#271).
 */
function relation(hostOwner: string, hostRepo: string, r: GqlIssueRef | null | undefined): IssueRelation | null {
  if (!r) return null;
  const [owner, repo] = (r.repository?.nameWithOwner ?? '').split('/');
  return {
    owner: owner || hostOwner,
    repo: repo || hostRepo,
    number: r.number,
    title: r.title ?? '',
    state: r.state === 'CLOSED' ? 'closed' : 'open',
    url: r.url ?? '',
    // Null when the fetch never established this neighbour's labels — a query
    // that stopped selecting them, or a page Github had more rows than. The
    // words gate treats not knowing as a possible submission (#497).
    labels: knownLabels(r.labels),
  };
}

const relations = (hostOwner: string, hostRepo: string, nodes: (GqlIssueRef | null)[] | null | undefined): IssueRelation[] =>
  (nodes ?? []).map((n) => relation(hostOwner, hostRepo, n)).filter((r): r is IssueRelation => r != null);

/**
 * Shape the four relation kinds (#469). The sub-issue COUNTS come from GitHub's
 * own `subIssuesSummary` rather than the fetched nodes, because the node list is
 * a capped page — counting it would quietly under-report "8 of 19 done" on a big
 * umbrella. Only when GitHub returns no summary do we count what we have.
 */
function shapeRelations(owner: string, repo: string, issue: GqlIssue): IssueRelations {
  const subIssues = relations(owner, repo, issue.subIssues?.nodes);
  const summary = issue.subIssuesSummary;
  return {
    parent: relation(owner, repo, issue.parent),
    subIssues,
    subIssuesTotal: summary?.total ?? subIssues.length,
    // NOT GATED ON THE CLOSE REASON, and knowingly so (#1014). Everywhere else a
    // close is counted this board now asks whether it was delivery, so an
    // umbrella reading "11 of 19 done" beside a grid counting 8 is a real
    // disagreement — on the one screen that says the word "done".
    //
    // It stays because closing it is not a filter. The primary branch is
    // Github's own `subIssuesSummary.completed`, which Github does not split by
    // reason, so honouring the rule means dropping that branch entirely; and the
    // fallback cannot help either, because `DETAIL_ITEM_NODES` never selects a
    // reason for sub-issues and `IssueRelation` carries none. Both need a read
    // this change does not make. Recorded here rather than left for somebody to
    // find as a contradiction.
    subIssuesClosed: summary?.completed ?? subIssues.filter((s) => s.state === 'closed').length,
    blockedBy: relations(owner, repo, issue.blockedBy?.nodes),
    blocking: relations(owner, repo, issue.blocking?.nodes),
  };
}

/**
 * Reshape one GraphQL issue into an IssueDetail. `commentsMax` caps the thread —
 * the query already asks for at most that many, but we also read `totalCount` to
 * flag truncation honestly rather than pretend the cap is the whole thread.
 */
export function shapeIssue(
  owner: string,
  repo: string,
  issue: GqlIssue,
  commentsMax: number,
): IssueDetail {
  const commentNodes = issue.comments?.nodes ?? [];
  const comments: IssueComment[] = commentNodes.slice(0, commentsMax).map((c) => ({
    id: c.databaseId,
    viewerCanUpdate: c.viewerCanUpdate === true,
    author: person(c.author),
    bodyMarkdown: c.body ?? '',
    createdAt: c.createdAt,
    htmlUrl: c.url,
  }));
  const totalComments = issue.comments?.totalCount ?? comments.length;

  const linkedPrs: LinkedPr[] = (issue.closedByPullRequestsReferences?.nodes ?? []).map((pr) => ({
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: PR_STATE[pr.state] ?? 'open',
  }));

  const projects: IssueProjectMembership[] = (issue.projectItems?.nodes ?? [])
    .filter((n): n is GqlProjectItemNode => n != null)
    .map((node) => {
      // The whole list at once, not field by field: which single-select is
      // the seeded Status is answered against its siblings (`mapFieldDefs`).
      const fields: ProjectFieldDef[] = mapFieldDefs(node.project?.fields?.nodes ?? [], node.project?.createdAt);

      const values: Record<string, FieldValue> = {};
      for (const v of node.fieldValues?.nodes ?? []) {
        if (!v) continue;
        const mapped = mapFieldValue(v);
        if (mapped) values[mapped.fieldId] = mapped.value;
      }

      return {
        projectId: node.project?.id ?? '',
        itemId: node.id ?? '',
        number: node.project?.number ?? 0,
        title: node.project?.title ?? '',
        fields,
        values,
      };
    });

  return {
    owner,
    repo,
    number: issue.number,
    viewerCanUpdate: issue.viewerCanUpdate === true,
    title: issue.title,
    state: issue.state === 'CLOSED' ? 'closed' : 'open',
    htmlUrl: issue.url,
    author: person(issue.author),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    bodyMarkdown: issue.body ?? '',
    labels: (issue.labels?.nodes ?? []).map((l) => ({ name: l.name, color: l.color ?? '6a737d' })),
    // The page renders whatever labels came back; the gate needs to know whether
    // that IS the whole set, because a partial one reads as "no `feedback`
    // label here" and would serve a submission's body (#497).
    labelsComplete: knownLabels(issue.labels) != null,
    assignees: (issue.assignees?.nodes ?? []).map((a) => person(a)!).filter(Boolean),
    milestone: issue.milestone?.title ?? null,
    issueType: issue.issueType?.name ?? null,
    relations: shapeRelations(owner, repo, issue),
    linkedPrs,
    comments,
    totalComments,
    commentsTruncated: totalComments > comments.length,
    projects,
  };
}
