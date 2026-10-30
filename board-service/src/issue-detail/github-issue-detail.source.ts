import { PrincipalState, githubPrincipal } from '../auth/github-principal';
import { ConflictException, ForbiddenException, BadGatewayException, Logger, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { buildOctokitClient } from '../sources/github-client';
import { classifyGithubError, refusalToHttp, type Refusal } from '../capability/github-refusal';
import { learnRefusal } from '../capability/learn-refusal';
import type { Capability } from '../capability/capability';
import type { CapabilityRegistry } from '../capability/capability.registry';
import { setTaskChecked } from './body-tasks';
import {
  ClosedIssue,
  ChosenCloseReason,
  CreatedProject,
  FieldValue,
  IIssueDetailSource,
  IssueDetail,
  IssueEditOptions,
  IssueLabel,
  IssueNotFoundError,
  IssueState,
  Person,
  PostedComment,
  ProjectTitleTakenError,
} from './issue-detail.types';
import { readActivity } from './issue-activity';
import { GqlIssue, shapeIssue } from './issue-detail.vm';
import { isFieldClear, toGqlFieldValue } from './project-fields';

/**
 * One issue + its comments + linked PRs in a GraphQL round-trip (#235).
 * Activity is read separately through the paginated REST timeline (#882), so
 * a failed activity read does not hide an otherwise readable issue or thread.
 * GraphQL lets us pull the body, labels/assignees/milestone, the org-level
 * `issueType` (#467), the issue's relations (#469), the linked-PR references
 * (same field the Projects source uses) and the comment page at once, rather
 * than several REST calls. Comments are capped at `commentsMax`; the query also
 * returns `totalCount` so the page can say "N more on Github" honestly.
 *
 * The relation edges are capped too — a first page of sub-issues and of each
 * dependency direction — which is exactly why `subIssuesSummary` is selected
 * alongside them: the COUNTS come from GitHub's summary over all sub-issues, so
 * "8 of 19 done" stays honest on an umbrella bigger than the page.
 *
 * `rel` is the one shape every relation renders from. `repository` is part of it
 * because relations are routinely cross-repo (an umbrella in one repo, its
 * children in another), and the page needs the full `owner/repo#NN` to decide
 * between an in-board link and a Github one.
 *
 * `labels` is part of it for a different reason (#497): a relation's TITLE is an
 * end user's first line when the relation is a feedback submission, and we file
 * submissions under umbrella issues as a matter of course — so the words gate
 * has to place each neighbour, and it places issues by their labels. The page
 * renders none of them; `readableRelations` strips them on the way out.
 * `totalCount` rides with every label page here and on the issue itself, because
 * a page we cannot show reached the end is not an issue's label set, and a gate
 * that mistook a partial page for a complete one would read "no `feedback` label
 * here" and hand the words over.
 */
const QUERY = `
  fragment rel on Issue { number title url state repository { nameWithOwner } labels(first: 20) { totalCount nodes { name } } }

  query ($owner: String!, $repo: String!, $number: Int!, $comments: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        number title state url body createdAt updatedAt viewerCanUpdate
        author { login ... on User { name } }
        labels(first: 20) { totalCount nodes { name color } }
        assignees(first: 10) { nodes { login name } }
        milestone { title }
        issueType { name }
        parent { ...rel }
        subIssues(first: 50) { nodes { ...rel } }
        subIssuesSummary { total completed }
        blockedBy(first: 20) { nodes { ...rel } }
        blocking(first: 20) { nodes { ...rel } }
        closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
          nodes { number url title state }
        }
        comments(first: $comments) {
          totalCount
          nodes { databaseId viewerCanUpdate url author { login ... on User { name } } body createdAt }
        }
        projectItems(first: 10) {
          nodes {
            id
            project { id number title createdAt
              fields(first: 30) { nodes {
                __typename
                ... on ProjectV2FieldCommon { id name dataType createdAt }
                ... on ProjectV2SingleSelectField { id name options { id name color } }
                ... on ProjectV2IterationField { id name configuration { iterations { id title } } }
              } } }
            fieldValues(first: 30) { nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue { field { ... on ProjectV2FieldCommon { id } } optionId }
              ... on ProjectV2ItemFieldTextValue     { field { ... on ProjectV2FieldCommon { id } } text }
              ... on ProjectV2ItemFieldNumberValue   { field { ... on ProjectV2FieldCommon { id } } number }
              ... on ProjectV2ItemFieldDateValue     { field { ... on ProjectV2FieldCommon { id } } date }
              ... on ProjectV2ItemFieldIterationValue{ field { ... on ProjectV2FieldCommon { id } } iterationId }
            } }
          }
        }
      }
    }
  }
`;

export class GithubIssueDetailSource implements IIssueDetailSource {
  private readonly principalState = new PrincipalState(() => ({
    readClient: null as ReturnType<typeof buildOctokitClient> | null,
    writeClient: null as ReturnType<typeof buildOctokitClient> | null
  }));
  private readonly logger = new Logger(GithubIssueDetailSource.name);
  private get readClient(): ReturnType<typeof buildOctokitClient> | null { return this.principalState.current.readClient; }
  private set readClient(value: ReturnType<typeof buildOctokitClient> | null) { this.principalState.current.readClient = value; }
  private get writeClient(): ReturnType<typeof buildOctokitClient> | null { return this.principalState.current.writeClient; }
  private set writeClient(value: ReturnType<typeof buildOctokitClient> | null) { this.principalState.current.writeClient = value; }
  private readonly commentsMax: number;

  constructor(
    private readonly config: ConfigService,
    /** #584 — optional so this file's spec keeps constructing the source with a
     *  config alone. The `useFactory` provider passes it explicitly. */
    private readonly registry?: CapabilityRegistry,
  ) {
    this.commentsMax = config.get<number>('ISSUE_COMMENTS_MAX', 100);
  }

  /**
   * The READ credential's client — GITHUB_TOKEN (#625).
   *
   * Every question this source asks Github goes out through it: `fetch`,
   * `editOptions`, `projectOwnerLogin`, the body re-read that opens
   * `toggleTask`, the issue node-id lookup that opens `addToProject`, and the
   * 404 re-read in `learn`. The split is per CALL, not per method — a write
   * method that reads first reads as the reader.
   *
   * `learn`'s re-read is the one worth naming, because moving it would change
   * what it MEANS. Its whole job is to ask whether the READ credential can
   * still see the issue, and that is what earns a 404 the right to be
   * classified as a refusal rather than an absence. Asked under the write
   * credential it answers a different question, and an issue that credential
   * cannot see would start reading as an issue that is not there.
   */
  private octokit() {
    if (!this.readClient) this.readClient = buildOctokitClient(this.config, 'read');
    return this.readClient;
  }

  /**
   * The WRITE credential's client — GITHUB_WRITE_TOKEN when one is set, and
   * GITHUB_TOKEN when it is not (#625).
   *
   * Every mutation on this source goes out through it: `setState` (and `close`,
   * which shares that call), `setAssignees`, `addAssignees`, `removeAssignees`,
   * `setLabels`, `setMilestone`, `toggleTask`'s body write, `addComment`, and
   * the five Projects v2 mutation documents, `createProject`'s among them (#982). Thirteen CALLS — the unit this
   * docblock counts in. The `refuse` and `refuseMutation` docblocks below count
   * METHODS instead: `close` shares `setState`'s call, and `setFieldValue` sends
   * one of two documents depending on whether the value clears.
   *
   * Before #625 the nine there were then shared the read client above, so setting
   * GITHUB_WRITE_TOKEN moved only the three writers that build their own client
   * — `repo.dri`, `feedback.submit` and the boot alert — and left these behind.
   *
   * `write-credential.spec.ts` measures which credential each one actually goes
   * out under, on the wire. The boot probe in `capability/capability.registry.ts`
   * rests on that measurement: it seeds credential-wide verdicts read from the
   * write token, and those are only true of the writes while the writes ride it.
   */
  private writeOctokit() {
    if (!this.writeClient) this.writeClient = buildOctokitClient(this.config, 'write');
    return this.writeClient;
  }

  private gql() {
    return this.octokit().graphql;
  }

  /**
   * Classify what Github refused and teach the registry (#584).
   *
   * The key is `owner/repo`, NOT `owner/repo#n`. Two reasons and they agree.
   * Github makes no per-issue permission distinction — issue permissions ARE
   * repository permissions — and the write envelope can only key on
   * `owner/repo`, because a guard that has parsed the number still pins the
   * repo. A per-issue key would leave that rung matching nothing on nine of the
   * board's eleven write ROUTES — the nine whose subject is an issue, which is
   * every route this source serves — silently, since a rung that matches
   * nothing throws nothing. The number stays in the log line below, where it
   * helps.
   */
  private async learn(
    cap: Capability,
    owner: string,
    repo: string,
    /** The issue to re-read, or null where there is nothing worth re-reading. */
    n: number | null,
    err: unknown,
  ): Promise<Refusal> {
    const target = `${owner}/${repo}`;
    return learnRefusal({
      registry: this.registry,
      capability: cap,
      target,
      refusal: classifyGithubError(err, { capability: cap, target }),
      // The REST writes address an issue by number and can ask for it back,
      // which is what earns a 404 the right to be read as a refusal. The three
      // Projects v2 mutations address a project ITEM by node id, and a GraphQL
      // NOT_FOUND there may be the project rather than the issue — so they pass
      // no re-read, and their 404 is learned nowhere.
      reread:
        n == null
          ? undefined
          : async () => {
              try {
                // `issues.get`, NOT `rest.issues.get`. Every call in this file
                // reaches Github through `this.octokit().issues.…`, and a `rest`
                // segment would be a second shape for the same client that no
                // stub in this file's spec provides.
                await this.octokit().issues.get({ owner, repo, issue_number: n });
                return true;
              } catch (e) {
                if (classifyGithubError(e, { capability: cap }).reason === 'not-found') return false;
                throw e;
              }
            },
    });
  }

  /**
   * What the REST writes throw — one shape, because they refuse alike.
   *
   * `createProject`'s opening read takes it too (#1057), and it is not a REST
   * write. What it shares is the two rungs this shape is: an issue addressed by
   * number, so the 404 can be re-read, and a refusal that is genuinely about the
   * capability it names. `refuseMutation` below is for the calls that have
   * neither.
   *
   * `IssueNotFoundError` still carries the genuinely-absent case, so the 404
   * these routes answer today they answer unchanged, message and all, and both
   * `IssueDetailService` and the close route keep catching the class they
   * already catch. The predicate is the CLASSIFIED reason rather than
   * `isNotFound`: the same question asked once instead of twice, and a 404 whose
   * re-read succeeded has already become `not-permitted` by the time it is
   * asked — which is how a write refused on an issue the board can still read
   * now answers 403 where it answered 404.
   *
   * Everything else answered 500 with an empty body until now.
   */
  private async refuse(
    cap: Capability,
    owner: string,
    repo: string,
    number: number,
    verb: string,
    err: unknown,
  ): Promise<Error> {
    const refusal = await this.learn(cap, owner, repo, number, err);
    if (refusal.reason === 'not-found') return new IssueNotFoundError(owner, repo, number);
    const message = `issue ${owner}/${repo}#${number} ${verb} failed: ${asMsg(err)}`;
    // A refusal the person sees and can act on is an expected answer, not an
    // error. Only a try-again — the board never reached Github at all — stays
    // at error.
    if (refusal.reason === 'try-again') this.logger.error(message);
    else this.logger.warn(message);
    return refusalToHttp(refusal);
  }

  /**
   * What the Projects v2 mutations throw (#584).
   *
   * They had no `catch` at all: their errors arrive HTTP 200 with an `errors`
   * array, so they fell through the controller's envelope untouched and became a
   * 500. There is no `IssueNotFoundError` rung to preserve here and no issue to
   * re-read, so this is learn-then-answer and nothing else.
   */
  private async refuseMutation(
    cap: Capability,
    owner: string,
    repo: string,
    verb: string,
    err: unknown,
  ): Promise<Error> {
    const refusal = await this.learn(cap, owner, repo, null, err);
    this.logger.error(`${owner}/${repo} could not ${verb}: ${asMsg(err)}`);
    return refusalToHttp(refusal);
  }

  async fetch(owner: string, repo: string, number: number): Promise<IssueDetail | null> {
    let data: { repository?: { issue?: GqlIssue | null } | null };
    try {
      data = await this.gql()<typeof data>(QUERY, { owner, repo, number, comments: this.commentsMax });
    } catch (err) {
      // A missing repo/issue comes back as a GraphQL NOT_FOUND — that's a 404,
      // not an outage, so answer null. Anything else propagates (the service
      // then degrades to its stale cache rather than masking a real failure).
      if (isNotFound(err)) return null;
      this.logger.error(`issue ${owner}/${repo}#${number} fetch failed: ${asMsg(err)}`);
      throw err;
    }
    const issue = data.repository?.issue;
    if (!issue) return null;
    const detail = shapeIssue(owner, repo, issue, this.commentsMax);
    if (!githubPrincipal()?.token) {
      detail.viewerCanUpdate = false;
      detail.comments = detail.comments.map(comment => ({ ...comment, viewerCanUpdate: false }));
    }
    detail.activity = await readActivity(
      (args) => this.octokit().issues.listEventsForTimeline(args),
      // `viewerCredential` says whose eyes that timeline was read with, which is
      // what lets a mention in another repository keep its link (#1331). It is
      // the same question `octokit()` above just answered by building the client.
      { owner, repo, number, viewerCredential: githubPrincipal()?.token != null },
    );
    return detail;
  }

  /** Set the issue's open/closed state on Github via REST (#384). A 404 the
   *  board cannot re-read is still an `IssueNotFoundError` (the controller
   *  answers 404); every other refusal now answers its own status.
   *
   *  `capability` is a parameter rather than a hard-coded `'issue.state'`
   *  because `close` shares this write. Without it a refused close would record
   *  `issue.state` — and once the guard enforces, closing one issue would
   *  disable the state toggle on every issue. */
  async setState(
    owner: string,
    repo: string,
    number: number,
    state: IssueState,
    capability: Capability = 'issue.state',
  ): Promise<IssueState> {
    await this.writeState(owner, repo, number, state, capability);
    return state;
  }

  /** Close the issue (#287/#291) through `setState`'s own call, so the two stay
   *  one write. The capability travels with it, so the registry hears
   *  `issue.close`, and so does the reason (#1006). */
  async close(
    owner: string,
    repo: string,
    number: number,
    capability: Capability = 'issue.close',
    reason?: ChosenCloseReason,
  ): Promise<ClosedIssue> {
    return this.writeState(owner, repo, number, 'closed', capability, reason);
  }

  /** The one `issues.update` call behind `setState` and `close`. It answers with
   *  what Github stored rather than what was sent: the reason in particular can
   *  differ, see `ClosedIssue`. No `state_reason` goes out when none was asked
   *  for, which is exactly what this call sent before #1006. */
  private async writeState(
    owner: string,
    repo: string,
    number: number,
    state: IssueState,
    capability: Capability,
    reason?: ChosenCloseReason,
  ): Promise<ClosedIssue> {
    try {
      const res = await this.writeOctokit().issues.update({
        owner,
        repo,
        issue_number: number,
        state,
        ...(reason ? { state_reason: reason } : {}),
      });
      const data = res?.data;
      return {
        state: data?.state === 'open' ? 'open' : state,
        stateReason: data?.state_reason ?? null,
        alreadyClosed: state === 'closed' && closedBefore(data?.closed_at, res?.headers?.date),
      };
    } catch (err) {
      throw await this.refuse(capability, owner, repo, number, 'setState', err);
    }
  }

  /** Replace the issue's assignees. Returns GitHub's ACCEPTED set (B2) — the API
   *  silently drops non-assignable logins, so we echo what it stored, not the
   *  request. */
  async setAssignees(owner: string, repo: string, number: number, logins: string[]): Promise<Person[]> {
    try {
      const { data } = await this.writeOctokit().issues.update({ owner, repo, issue_number: number, assignees: logins });
      return (data.assignees ?? []).map((a) => ({ login: a.login, name: a.name ?? null }));
    } catch (err) {
      throw await this.refuse('issue.assignees', owner, repo, number, 'setAssignees', err);
    }
  }

  /** Add the named people and nobody else (#1009): Github's `POST …/assignees`,
   *  where "Users already assigned to an issue are not replaced". Answers with
   *  the whole set the issue holds afterwards. */
  async addAssignees(owner: string, repo: string, number: number, logins: string[]): Promise<Person[]> {
    try {
      const { data } = await this.writeOctokit().issues.addAssignees({ owner, repo, issue_number: number, assignees: logins });
      return (data.assignees ?? []).map((a) => ({ login: a.login, name: a.name ?? null }));
    } catch (err) {
      throw await this.refuse('issue.assignees', owner, repo, number, 'addAssignees', err);
    }
  }

  /** Remove the named people and nobody else (#1009): Github's
   *  `DELETE …/assignees`. Answers with the whole set the issue holds afterwards. */
  async removeAssignees(owner: string, repo: string, number: number, logins: string[]): Promise<Person[]> {
    try {
      const { data } = await this.writeOctokit().issues.removeAssignees({
        owner,
        repo,
        issue_number: number,
        assignees: logins,
      });
      return (data.assignees ?? []).map((a) => ({ login: a.login, name: a.name ?? null }));
    } catch (err) {
      throw await this.refuse('issue.assignees', owner, repo, number, 'removeAssignees', err);
    }
  }

  /** Who holds the issue now (#1009): one REST `issues.get` on the READ
   *  credential, with no cache in front of it. A 404 is null, like `fetch`. */
  async currentAssignees(owner: string, repo: string, number: number): Promise<Person[] | null> {
    try {
      const { data } = await this.octokit().issues.get({ owner, repo, issue_number: number });
      return (data.assignees ?? []).map((a) => ({ login: a.login, name: a.name ?? null }));
    } catch (err) {
      if (isNotFound(err)) return null;
      this.logger.error(`issue ${owner}/${repo}#${number} assignees read failed: ${asMsg(err)}`);
      throw err;
    }
  }

  /** Replace the issue's labels. Returns the labels GitHub now holds (B2). */
  async setLabels(owner: string, repo: string, number: number, names: string[]): Promise<IssueLabel[]> {
    try {
      const { data } = await this.writeOctokit().issues.setLabels({ owner, repo, issue_number: number, labels: names });
      return data.map((l) => ({ name: l.name, color: l.color ?? '' }));
    } catch (err) {
      throw await this.refuse('issue.labels', owner, repo, number, 'setLabels', err);
    }
  }

  /** Set (or clear, with `null`) the issue's milestone. Returns the resulting
   *  milestone title GitHub holds, or null when cleared/absent (B2). */
  async setMilestone(owner: string, repo: string, number: number, milestoneNumber: number | null): Promise<string | null> {
    try {
      const { data } = await this.writeOctokit().issues.update({ owner, repo, issue_number: number, milestone: milestoneNumber });
      return data.milestone?.title ?? null;
    } catch (err) {
      throw await this.refuse('issue.milestone', owner, repo, number, 'setMilestone', err);
    }
  }

  /** Toggle one body task-list checkbox (#426). Re-reads the CURRENT body first
   *  (it may have changed since the page loaded), flips the task on 1-based `line`
   *  to `checked`, writes the WHOLE body back, and returns GitHub's stored body (B2
   *  echo) so the client reconciles to truth. A `TaskToggleError` (that line is no
   *  longer a task) surfaces as-is → the controller answers 400; a 404 becomes an
   *  `IssueNotFoundError`.
   *
   *  The re-read and the write sit in SEPARATE `try` blocks, and only the write's
   *  is the one that classifies. A read that fails says nothing about what the
   *  board may write: put it inside the classifying block and a 403 on the fetch
   *  teaches the registry that `issue.body.task` is refused on this repo — a
   *  refusal that never happened — and tells the person they are not permitted to
   *  do something the board simply could not look up. */
  async toggleTask(owner: string, repo: string, number: number, line: number, checked: boolean): Promise<string> {
    let current: { body?: string | null };
    try {
      ({ data: current } = await this.octokit().issues.get({ owner, repo, issue_number: number }));
    } catch (err) {
      // Unchanged from before task 5, deliberately: a 404 is the issue being
      // absent, everything else is a real failure that propagates as it was
      // thrown. Nothing is classified here and nothing is learned.
      if (isNotFound(err)) throw new IssueNotFoundError(owner, repo, number);
      this.logger.error(`issue ${owner}/${repo}#${number} toggleTask failed: ${asMsg(err)}`);
      throw err;
    }
    // Outside both blocks. A `TaskToggleError` is a client error, not a Github
    // answer at all; classifying it would file one as `try-again` and pay for a
    // re-read to do it. Raising it where no `catch` can reach it is what keeps
    // that true without a rung to remember.
    const next = setTaskChecked(current.body ?? '', line, checked);
    try {
      const { data } = await this.writeOctokit().issues.update({ owner, repo, issue_number: number, body: next });
      return data.body ?? '';
    } catch (err) {
      throw await this.refuse('issue.body.task', owner, repo, number, 'toggleTask', err);
    }
  }

  /** Post one comment on the issue (#693) and return what Github STORED.
   *
   *  One REST write under the WRITE credential, wrapped in the same `refuse` the
   *  writes above use — so a Github refusal on `issue.comment` is LEARNED
   *  into the registry rather than swallowed, and the page can withhold the
   *  composer next time instead of offering it and failing. A 404 the board
   *  cannot re-read is still an `IssueNotFoundError` (the route answers 404).
   *
   *  The four fields are the read side's, spelled the way `shapeIssue` spells
   *  them — that function reads GraphQL comment nodes and this response is REST,
   *  so the names are shared and the mapping is not. `created_at` is REST's own
   *  ISO string, and `html_url` is the `#issuecomment-…` permalink the thread
   *  already deep-links each comment by. */
  async editText(owner: string, repo: string, number: number, bodyMarkdown: string, expectedBody: string, commentId?: number): Promise<{ bodyMarkdown: string }> {
    if (!githubPrincipal()?.token) throw new ForbiddenException('Connect your GitHub account to edit this text.');
    const client = this.writeOctokit();
    try {
      const current = commentId === undefined
        ? await client.issues.get({ owner, repo, issue_number: number })
        : await client.issues.getComment({ owner, repo, comment_id: commentId });
      if (commentId !== undefined && (!('issue_url' in current.data) ||
          String(current.data.issue_url).toLowerCase() !== `https://api.github.com/repos/${owner}/${repo}/issues/${number}`.toLowerCase())) {
        throw new NotFoundException('This comment does not belong to this issue.');
      }
      // GitHub has no conditional body update: an edit between this read and write can still be overwritten.
      if ((current.data.body ?? '') !== expectedBody) {
        throw new ConflictException('The text changed on GitHub; your draft is kept.');
      }
      const { data } = commentId === undefined
        ? await client.issues.update({ owner, repo, issue_number: number, body: bodyMarkdown })
        : await client.issues.updateComment({ owner, repo, comment_id: commentId, body: bodyMarkdown });
      return { bodyMarkdown: data.body ?? '' };
    } catch (err) {
      if (err instanceof ConflictException || err instanceof NotFoundException) throw err;
      const status = (err as { status?: number })?.status;
      if (status === 403) throw new ForbiddenException('GitHub no longer allows you to edit this text. Your draft is kept.');
      if (status === 404) throw new NotFoundException('This text is no longer available on GitHub.');
      throw new BadGatewayException('Could not save to GitHub. Your draft is kept. Try again.');
    }
  }

  async addComment(owner: string, repo: string, number: number, bodyMarkdown: string): Promise<PostedComment> {
    try {
      const { data } = await this.writeOctokit().issues.createComment({
        owner,
        repo,
        issue_number: number,
        // Verbatim. Github stores markdown and renders it, so anything done to
        // this string here would be done to somebody's words.
        body: bodyMarkdown,
      });
      let permission: { id?: number; viewerCanUpdate?: boolean } = {};
      if (githubPrincipal()?.token) {
        permission = { id: data.id, viewerCanUpdate: false };
        try {
          const result = await this.gql()<{ node?: { viewerCanUpdate?: boolean } }>(
            'query ($id: ID!) { node(id: $id) { ... on IssueComment { viewerCanUpdate } } }', { id: data.node_id },
          );
          permission.viewerCanUpdate = result.node?.viewerCanUpdate === true;
        } catch { /* The comment was posted; a failed permission read must not invite another post. */ }
      }
      return {
        ...permission,
        author: data.user ? { login: data.user.login, name: data.user.name ?? null } : null,
        bodyMarkdown: data.body ?? '',
        createdAt: data.created_at,
        htmlUrl: data.html_url ?? null,
      };
    } catch (err) {
      throw await this.refuse('issue.comment', owner, repo, number, 'addComment', err);
    }
  }

  /** The repo's autocomplete catalog (#384): all labels (with colour), open
   *  milestones, and repo-assignable logins — each fully paginated so a repo
   *  with >100 of any doesn't silently truncate the editor's choices. */
  async editOptions(owner: string, repo: string): Promise<IssueEditOptions> {
    const ok = this.octokit();
    const [labels, milestones, assignees] = await Promise.all([
      ok.paginate(ok.issues.listLabelsForRepo, { owner, repo, per_page: 100 }),
      ok.paginate(ok.issues.listMilestones, { owner, repo, state: 'open', per_page: 100 }),
      this.assignablePeople(owner, repo),
    ]);
    return {
      labels: labels.map((l) => ({ name: l.name, color: l.color ?? '' })),
      milestones: milestones.map((m) => ({ number: m.number, title: m.title })),
      assignableLogins: assignees.map((a) => a.login),
      assignablePeople: assignees,
    };
  }

  private async assignablePeople(owner: string, repo: string): Promise<Person[]> {
    const people: Person[] = [];
    let after: string | null = null;
    do {
      const answer: { repository: { assignableUsers: {
        nodes: (Person | null)[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      } } | null } = await this.octokit().graphql(`
        query ($owner: String!, $repo: String!, $after: String) {
          repository(owner: $owner, name: $repo) {
            assignableUsers(first: 100, after: $after) {
              nodes { login name }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`, { owner, repo, after });
      if (!answer.repository) throw new NotFoundException();
      const page = answer.repository.assignableUsers;
      people.push(...page.nodes.filter((person): person is Person => person !== null));
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return people;
  }

  // --- Projects v2 mutations (GraphQL, #384 Task 8) ------------------------

  /** Resolves a project's owning org/user login so the add-to-project route
   *  can require it to be in the owner scope (B1). Returns null when the node isn't
   *  a ProjectV2 / not visible to us — a weaker signal there would weaken
   *  that security check, so an absent owner must map to null, not throw. */
  async projectOwnerLogin(projectId: string): Promise<string | null> {
    const data: {
      node?: { owner?: { __typename?: string; login?: string } | null } | null;
    } = await this.octokit().graphql(
      `query($id:ID!){ node(id:$id){ ... on ProjectV2 { owner { __typename ... on Organization { login } ... on User { login } } } } }`,
      { id: projectId },
    );
    return data?.node?.owner?.login ?? null;
  }

  /** Adds the issue to a Projects v2 board. Resolves the issue's node id
   *  first, then calls `addProjectV2ItemById`. Returns the new item id (S1) —
   *  the route needs it to address the item for subsequent field writes.
   *
   *  The node-id lookup is a READ and stays outside the classifying `try` — it
   *  had no `catch` before task 5 and it still has none, so a lookup that fails
   *  propagates exactly as it did. Inside, it would have made a 403 on the query
   *  record `issue.project.add` as refused on this repo, which is a claim the
   *  lookup's failure does not support. */
  async addToProject(owner: string, repo: string, number: number, projectId: string): Promise<{ itemId: string }> {
    const { repository }: { repository?: { issue?: { id: string } | null } } = await this.octokit().graphql(
      `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){id}}}`,
      { o: owner, r: repo, n: number },
    );
    try {
      const res: { addProjectV2ItemById: { item: { id: string } } } = await this.writeOctokit().graphql(
        `mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}`,
        { p: projectId, c: repository?.issue?.id },
      );
      return { itemId: res.addProjectV2ItemById.item.id };
    } catch (err) {
      throw await this.refuseMutation('issue.project.add', owner, repo, `add to project ${projectId}`, err);
    }
  }

  /** Makes a Projects v2 project under `owner` (#982) and answers with what
   *  Github made.
   *
   *  One READ first. It asks three things. Is the issue there? A project made
   *  for an issue that is not is an empty project on Github with nothing to add
   *  to it, so a missing issue or repo, which Github answers with NOT_FOUND, is
   *  `IssueNotFoundError` before anything is written. What is the owner's node
   *  id, which the mutation is addressed by? And which of the owner's open
   *  projects does Github's search return for the name? One with the same title,
   *  ignoring case and surrounding spaces, stops the write with
   *  `ProjectTitleTakenError`.
   *
   *  THAT READ IS CLASSIFIED, where `addToProject`'s is not, and the difference
   *  is what the two ask for. `addToProject` reads `repository{issue{id}}`,
   *  which wants only what the issue page has already read; a 403 there says
   *  nothing about projects, so classifying it would record a refusal its own
   *  failure does not support. This one also reads `repositoryOwner`'s
   *  `projectsV2`, which wants a PROJECTS READ permission on top — so a
   *  FORBIDDEN or an INSUFFICIENT_SCOPES here is Github refusing this credential
   *  the owner's projects, which is exactly the claim `issue.project.create`
   *  makes. Outside the `try` it was neither answered nor learned: only
   *  NOT_FOUND was mapped, so a FORBIDDEN reached the controller unclassified
   *  and became a 500 with no body, the page said "Try again", and the registry
   *  heard nothing, so the second press was offered too.
   *
   *  `refuse` is the same rung the REST writes take, and it keeps both ends
   *  true. NOT_FOUND still answers `IssueNotFoundError` — a 404 — unless the
   *  re-read finds the issue readable, which is #577's distinction and earns a
   *  403. FORBIDDEN answers 403 and teaches the registry on this owner/repo, so
   *  the next `/api/auth/me` withholds "New project" rather than arming a press
   *  that cannot work. A GraphQL error nobody has classified, a RATE_LIMITED and
   *  a dropped socket stay `try-again` — a 502 the page may offer a retry for,
   *  and a scope the registry believes nowhere.
   *
   *  Only `issue.project.create` is learned. The add is a different write
   *  against a different project, and this read refuses nothing about it.
   *
   *  The title search can miss: it reads the first 100 matches, it sees only
   *  projects this credential can read, and a title carrying search syntax
   *  changes the search. Github itself allows the duplicate it misses.
   *
   *  The project is not linked to `repo`. That is a separate Github write, and
   *  nothing the board shows needs it. */
  async createProject(owner: string, repo: string, number: number, title: string): Promise<CreatedProject> {
    let found: {
      repository?: { issue?: { id: string } | null } | null;
      repositoryOwner?: {
        id: string;
        login: string;
        projectsV2?: { nodes?: ({ id: string; number: number; title: string; closed: boolean } | null)[] | null } | null;
      } | null;
    };
    try {
      found = await this.octokit().graphql(
        `query($o:String!,$r:String!,$n:Int!,$q:String!){repository(owner:$o,name:$r){issue(number:$n){id}} repositoryOwner(login:$o){id login ... on ProjectV2Owner{projectsV2(first:100,query:$q){nodes{id number title closed}}}}}`,
        { o: owner, r: repo, n: number, q: `is:open ${title}` },
      );
    } catch (err) {
      throw await this.refuse('issue.project.create', owner, repo, number, 'createProject read', err);
    }
    const { repository, repositoryOwner } = found;
    if (!repository?.issue) throw new IssueNotFoundError(owner, repo, number);
    if (!repositoryOwner) throw new NotFoundException(`${owner} was not found`);
    const wanted = title.trim().toLowerCase();
    const taken = (repositoryOwner.projectsV2?.nodes ?? []).find(
      (p) => p != null && !p.closed && p.title.trim().toLowerCase() === wanted,
    );
    if (taken) throw new ProjectTitleTakenError({ id: taken.id, number: taken.number, title: taken.title });
    try {
      const res: {
        createProjectV2: { projectV2: { id: string; number: number; title: string; url?: string | null } };
      } = await this.writeOctokit().graphql(
        `mutation($o:ID!,$t:String!){createProjectV2(input:{ownerId:$o,title:$t}){projectV2{id number title url}}}`,
        { o: repositoryOwner.id, t: title },
      );
      const made = res.createProjectV2.projectV2;
      return { id: made.id, number: made.number, title: made.title, url: made.url ?? null, owner: repositoryOwner.login };
    } catch (err) {
      throw await this.refuseMutation('issue.project.create', owner, repo, `create project ${title}`, err);
    }
  }

  /** Removes an item from a Projects v2 board. Param order matches the
   *  interface: (itemId, projectId), with `owner`/`repo` appended (#584) — the
   *  mutation addresses a node id, and the registry keys on `owner/repo`. */
  async removeFromProject(itemId: string, projectId: string, owner: string, repo: string): Promise<void> {
    try {
      await this.writeOctokit().graphql(
        `mutation($p:ID!,$i:ID!){deleteProjectV2Item(input:{projectId:$p,itemId:$i}){deletedItemId}}`,
        { p: projectId, i: itemId },
      );
    } catch (err) {
      throw await this.refuseMutation('issue.project.remove', owner, repo, `remove item ${itemId}`, err);
    }
  }

  /** Writes one project field value for an item. GitHub's mutation echoes
   *  only the item id back, not the stored value, so on success we return
   *  the `value` we sent (B2) — it IS what's now stored.
   *
   *  `updateProjectV2ItemFieldValue` cannot clear a field with a null value —
   *  GitHub added the dedicated `clearProjectV2ItemFieldValue` mutation
   *  precisely because update-with-null doesn't clear. So a clearing value
   *  (`isFieldClear`) routes there instead of through `update…`.
   *
   *  Both value functions run BEFORE the classifying `try`, and neither is a
   *  Github call. `isFieldClear` and `toGqlFieldValue` read the request's own
   *  `value`, so a value this process cannot express throws a plain TypeError —
   *  and inside the block, that TypeError was classified as a Github answer:
   *  measured, `try-again` and HTTP 502 "Github could not be reached on
   *  acme/board", over a request Github never saw. (The registry stores
   *  nothing: `recordRefusal` drops every reason but the two permission ones.
   *  What it costs is the answer, and a retry the client is invited to make.) */
  async setFieldValue(
    projectId: string,
    itemId: string,
    fieldId: string,
    value: FieldValue,
    owner: string,
    repo: string,
  ): Promise<FieldValue> {
    const clearing = isFieldClear(value);
    const v = clearing ? null : toGqlFieldValue(value);
    try {
      if (clearing) {
        await this.writeOctokit().graphql(
          `mutation($p:ID!,$i:ID!,$f:ID!){clearProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f}){projectV2Item{id}}}`,
          { p: projectId, i: itemId, f: fieldId },
        );
        return value; // the cleared/empty value is the stored value (B2)
      }
      await this.writeOctokit().graphql(
        `mutation($p:ID!,$i:ID!,$f:ID!,$v:ProjectV2FieldValue!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:$v}){projectV2Item{id}}}`,
        { p: projectId, i: itemId, f: fieldId, v },
      );
      return value;
    } catch (err) {
      throw await this.refuseMutation('issue.field', owner, repo, `set field ${fieldId}`, err);
    }
  }
}

/** #584 — the classifier owns the shape; this stays a predicate so its call
 *  sites keep reading the way they do. The `capability` is a placeholder that
 *  reaches nothing: the predicate reads only the reason, and no registry is
 *  touched here. Task 5 is where these paths learn. */
function isNotFound(err: unknown): boolean {
  return classifyGithubError(err, { capability: 'issue.state' }).reason === 'not-found';
}

function asMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How long before Github's answer an issue's `closed_at` must be for the close
 *  to count as already done. A close this request made is stamped a second or
 *  two before the answer, and both times have one-second grain. The price is
 *  the other direction: somebody else's close in the half-minute before this
 *  one reads as this one's, and keeps its audit row. */
const CLOSED_BEFORE_SLACK_MS = 30_000;

/** Whether the issue was closed before this request (#1006), from the update's
 *  own answer and no second call. Both times are Github's, `closed_at` and the
 *  response's `Date` header, so no clock of ours is compared with theirs.
 *  Anything missing or unreadable answers false, which keeps the audit row.
 *
 *  It rests on Github leaving `closed_at` alone when a closed issue is closed
 *  again. Github's docs say `state_reason` is "Ignored unless state is changed"
 *  and say nothing about `closed_at`. Every spec sets it by hand. If Github
 *  restamps it, this answers false every time and the row comes back, as before
 *  #1006's review. */
export function closedBefore(closedAt: string | null | undefined, answeredAt: string | undefined): boolean {
  const closed = closedAt ? Date.parse(closedAt) : NaN;
  const answered = answeredAt ? Date.parse(answeredAt) : NaN;
  return Number.isFinite(closed) && Number.isFinite(answered) && closed < answered - CLOSED_BEFORE_SLACK_MS;
}
