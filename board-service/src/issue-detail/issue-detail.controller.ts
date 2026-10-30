import { githubPrincipal } from '../auth/github-principal';
import {
  BadRequestException,
  ForbiddenException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HumanOnlyGuard } from '../account/human-only.guard';
import { Writes } from '../capability/writes.decorator';
import { carriesForgedFooter, composeComment, maxAuthorBody } from './comment-footer';
import type { Capability } from '../capability/capability';
import { CapabilityRegistry } from '../capability/capability.registry';
import { guardWrite } from '../capability/write-envelope';
import { capabilityGuardEnforcing } from '../capability/guard-enforcing';
import { Viewer } from '../auth/feedback-visibility';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.types';
import { TaskToggleError } from './body-tasks';
import { IssueDetailService } from './issue-detail.service';
import {
  ASSIGNEE_CHANGE_MAX,
  CHOSEN_CLOSE_REASONS,
  COMMENT_BODY_MAX,
  ChosenCloseReason,
  CreatedProject,
  FieldValue,
  IssueDetail,
  IssueEditOptions,
  IssueLabel,
  IssueNotFoundError,
  IssueState,
  Person,
  PostedComment,
  ProjectTitleTakenError,
  isChosenCloseReason,
} from './issue-detail.types';
import { githubOrgs } from '../config/github-orgs';
import { FreshnessRegistry } from '../freshness/freshness.registry';
import { isSurfacedProjectName } from '../projects/project-derive';
import { asMsg } from '../capability/github-refusal';

/** The board's own cap on a new project's name (#982). Github's schema states
 *  none, and a name it refused for length would arrive as a validation error
 *  the refusal classifier cannot name, which it answers as "try again". */
const PROJECT_TITLE_MAX = 256;

interface AuthedRequest {
  user?: Viewer;
}

/**
 * GET /api/issues/:owner/:repo/:number — the in-board issue page's data (#235).
 * A three-segment path, so it never collides with the sibling one-segment
 * routes (`/issues/buckets`, `/issues/mine`, `/issues/metrics`). `no-store` so
 * the browser never layers its own cache over the service's short TTL. Behind
 * the global SSO + team guards like every other read surface, and owner-gated
 * the way every write here is (#483): the owner has to be one this board
 * serves, which is an ALLOW-LIST rather than one fixed org (#649) — see
 * `servesOwner` below, which every gate in this file runs. 404 for an owner
 * outside it, and 404 when the issue doesn't exist; 400 on a non-numeric issue
 * under an owner that is served.
 */
@Controller('issues')
export class IssueDetailController {
  constructor(
    @Inject(IssueDetailService) private readonly service: IssueDetailService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CapabilityRegistry) private readonly registry: CapabilityRegistry,
    /** #982 — a new project whose add then fails is a change on Github that the
     *  write interceptor, which drops caches on success only, never hears of. */
    @Inject(FreshnessRegistry) private readonly freshness: FreshnessRegistry,
  ) {}

  private readonly logger = new Logger(IssueDetailController.name);
  /** The new projects being made right now in this process, by owner and name
   *  (#982), so two presses or two tabs cannot both get past the name check. */
  private readonly making = new Set<string>();

  /**
   * GET /api/issues/edit-options/:owner/:repo (#384) — the repo's autocomplete
   * catalog for the edit panel: labels (with colour), open milestones, and
   * repo-assignable logins. A read, so it needs only the global `board:read`
   * guards — no `HumanOnlyGuard` (it exposes only public repo metadata).
   * Owner-gated by `servesOwner` below — one of the orgs this board serves, not
   * one fixed org (#649) → 404 for anything outside that set.
   *
   * DECLARED BEFORE `:owner/:repo/:number`: a `:owner` param matches the literal
   * `edit-options` segment too, so with the parameterized route first Express
   * would bind owner=`edit-options`, number=`<repo>` and 400 on the non-numeric
   * number. Order — not the literal prefix alone — is what disambiguates them.
   */
  @Get('edit-options/:owner/:repo')
  @Header('Cache-Control', 'no-store')
  async editOptions(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
  ): Promise<IssueEditOptions> {
    if (!this.servesOwner(owner)) {
      // Not an org the board mirrors — 404 (don't reveal the constraint).
      throw new NotFoundException(`${owner}/${repo} not found`);
    }
    return this.service.editOptions(owner, repo);
  }

  /**
   * GET /api/issues/:owner/:repo/:number — the issue page's data. Owner-gated
   * by `servesOwner` below, the same cap every write on this controller
   * applies (#483): this returns the body and the full comment thread, so the
   * blast-radius cap has to hold for reading it too, not only for changing it.
   * The pin is checked FIRST — before the number — so an off-org request is
   * refused whatever else is wrong with it, matching `guardWrite`'s order.
   */
  @Get(':owner/:repo/:number')
  @Header('Cache-Control', 'no-store')
  async issue(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
    // Optional so the handler stays callable from a spec with no request. Nest
    // always injects it in production, and an absent viewer fails CLOSED (#497).
    @Req() req?: AuthedRequest,
  ): Promise<IssueDetail> {
    if (!this.servesOwner(owner)) {
      // Not an org the board mirrors — 404 (don't reveal the constraint).
      throw new NotFoundException(`issue ${owner}/${repo}#${number} not found`);
    }
    const n = Number(number);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('issue number must be a positive integer');
    const found = await this.service.getIssue(owner, repo, n, req?.user);
    if (!found) throw new NotFoundException(`issue ${owner}/${repo}#${n} not found`);
    return found;
  }

  /**
   * GET /api/issues/:owner/:repo/:number/assignees (#1009) — who holds the issue
   * on Github right now. The assign picker ticks its rows from this. It is read
   * from Github on every call and never through the issue cache, which serves a
   * stale copy of any age while it refreshes. Owner-pinned and number-checked in
   * the same order as the issue read above. It returns logins and names and no
   * body, so there are no words for the feedback gate to withhold.
   */
  @Get(':owner/:repo/:number/assignees')
  @Header('Cache-Control', 'no-store')
  async assignees(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
  ): Promise<{ assignees: Person[] }> {
    if (!this.servesOwner(owner)) throw new NotFoundException(`issue ${owner}/${repo}#${number} not found`);
    const n = Number(number);
    if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('issue number must be a positive integer');
    const held = await this.service.currentAssignees(owner, repo, n);
    if (!held) throw new NotFoundException(`issue ${owner}/${repo}#${n} not found`);
    return { assignees: held };
  }

  /**
   * POST /api/issues/:owner/:repo/:number/close (#287/#291) — board's first
   * edit-existing-state write. Human-only (an agent/PAT must not close on a
   * human's behalf) and gated on GITHUB_WRITE_ENABLED — a 503 when writes are
   * off, matching the documented contract. The `owner` is held to the owner
   * scope, so a close can never target a repo outside it even if the shared
   * token's scope is broader (CSO blast-radius cap). The cap did not loosen when
   * that scope became a SET at #649, nor when `PROJECTS_OWNER` was retired at
   * #1209 part 4: the scope is the acting person's own Github App grants, which
   * is narrower than the token's reach, and an empty one refuses every owner —
   * see `servesOwner` below. The action is audited.
   *
   * It hand-rolled those rungs inline until #584, and in a different order —
   * the number before the owner-pin — so an off-org close with a non-numeric
   * number answered 400 where every other write answered 404. It goes through
   * `guardWrite` now, which is also what puts it back inside every capability
   * rung the envelope gains.
   *
   * `{ reason }` (#1006) is Github's `state_reason`, one of `CHOSEN_CLOSE_REASONS`, so
   * a close can say "not planned" rather than always "completed". It rides the
   * same call, the same `issue.close` capability and the same credential scope
   * as before. The body is optional: a page from before this change sends none,
   * and Github then records `completed`, as it always did. It is read after
   * `guardWrite`, so an off-org, writes-off or refused close answers the same
   * whatever the body says. What comes back, and what the audit row names, is
   * the reason Github KEPT, which is not the one asked for when the issue was
   * already closed (see `ClosedIssue`).
   *
   * A close that finds the issue already closed writes no audit row: nothing
   * changed on Github, and a row saying "Closed" would record a close that did
   * not happen. The answer still comes back, so the page can say what is true.
   */
  @Writes('issue.close')
  @Post(':owner/:repo/:number/close')
  @Header('Cache-Control', 'no-store')
  @UseGuards(HumanOnlyGuard)
  async close(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
    @Req() req: AuthedRequest,
    @Body() body?: { reason?: unknown },
  ): Promise<{ state: IssueState; stateReason: string | null }> {
    const n = guardWrite(
      { kind: 'issue', owner, repo, name: number, email: req.user?.email },
      this.env('issue.close'),
    )!;
    const email = req.user?.email!;
    const reason = this.closeReason(body?.reason);

    let closed;
    try {
      // The word matches the `@Writes('issue.close')` this route declares (#584).
      closed = await this.service.closeIssue(owner, repo, n, 'issue.close', reason);
    } catch (err) {
      if (err instanceof IssueNotFoundError) throw new NotFoundException(err.message);
      throw err;
    }
    if (!closed.alreadyClosed) {
      await this.audit.record({
        actorEmail: email,
        action: 'issue.close',
        summary: closed.stateReason
          ? `Closed ${owner}/${repo}#${n} (${closed.stateReason})`
          : `Closed ${owner}/${repo}#${n}`,
        targetType: 'issue',
        targetId: `${owner}/${repo}#${n}`,
      });
    }
    return { state: closed.state, stateReason: closed.stateReason };
  }

  /** The close reason a request asked for, or undefined where it named none.
   *  `reopened` is refused although Github knows the word, because it names a
   *  reopen, and anything else is a 400 rather than a value passed on for
   *  Github to refuse. */
  private closeReason(raw: unknown): ChosenCloseReason | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (isChosenCloseReason(raw)) return raw;
    throw new BadRequestException(`A close reason is one of ${CHOSEN_CLOSE_REASONS.join(', ')}.`);
  }

  /** Whether the owner scope covers this owner — membership in a SET since
   *  #649, not equality with one name, matched case-insensitively because Github
   *  resolves owners that way. The scope is the acting person's own Github App
   *  grants, or `GITHUB_ORGS` where no person is acting.
   *
   *  One helper for the three direct gates in this file — the two GET routes
   *  above and the project-owner check inside `addProject` below — so they
   *  cannot drift into three slightly different tests. `env()` just underneath
   *  hands the same list to `guardWrite`, which runs the same rule as its first
   *  rung.
   *
   *  A null or empty owner is NOT covered, and neither is anything when the set
   *  is empty: `some` on an empty list is false, so a scope that resolved to no
   *  orgs gets a refusal rather than a missing check. Not an operator control —
   *  `PROJECTS_OWNER` narrowed this and is retired (#1209 part 4). The empty set
   *  arrives from a PERSON whose Github App grants cover no owner, or from a
   *  `ConfigService` a spec built without `GITHUB_ORGS`. */
  private servesOwner(owner: string | null | undefined): boolean {
    if (!owner) return false;
    const asked = owner.toLowerCase();
    return githubOrgs(this.config).some((o) => o.toLowerCase() === asked);
  }

  /** What the fail-closed envelope every native write shares is gated on: the
   *  owners the caller may write to, whether Github writes are on at all,
   *  and what the board has learned Github refuses it on THIS capability. The
   *  registry and the capability are both REQUIRED on `IssueWriteEnv`, so the
   *  target rung cannot be skipped by omitting either — dropping one from this
   *  object fails `tsc` on both call sites below.
   *
   *  `CAPABILITY_GUARD_ENFORCING` comes along for the same reason it reaches
   *  `CapabilityGuard`: it is one switch, and reporting mode has to mean the
   *  same thing at both halves of the capability check. Read through the one
   *  accessor that owns the fallback (#626). */
  private env(capability: Capability) {
    return {
      allowedOwners: githubOrgs(this.config),
      writesEnabled: this.config.get<boolean>('GITHUB_WRITE_ENABLED', false),
      registry: this.registry,
      capability,
      enforcing: capabilityGuardEnforcing(this.config),
    };
  }

  /**
   * Run one facet mutation through the shared envelope: `guardWrite`
   * (owner-pin 404 → number 400 → writes-off 503 → target capability 403 →
   * no-session 401), then the mutation, mapping `IssueNotFoundError` → 404,
   * then a rich audit record.
   *
   * B3 — `repo` is threaded so `targetId` is the REAL `owner/repo#n` (not a `…`
   * placeholder); the audit trail is the whole accountability story for a
   * shared-token write — and since #756 that is the design rather than a
   * compromise: the credential is a machine user's, Github's timeline names the
   * bot, and this row is the only place the person's name exists. #774 is what
   * stops a board from making this write with the row switched off. The optional trailing `detail` (Task 7) names WHICH
   * project/field changed — appended to the summary, not a separate column —
   * so the 4 existing native routes (which never pass it) are unaffected.
   */
  private async run<T>(
    owner: string,
    repo: string,
    numberRaw: string,
    email: string | undefined,
    /** #584 — the eight facets `run` serves all name an audit action that is ALSO
     *  a capability, and this type says so instead of a comment. `Extract` is the
     *  statement "the audit key and the capability are the same word" made
     *  checkable: a route passing `identity.role` here stops compiling, and a
     *  capability renamed out of the audit union does too. */
    action: Extract<AuditAction, Capability>,
    verb: string,
    fn: (n: number) => Promise<T>,
    /** #693 — a string OR a function of the RESULT. Some rows can only be joined
     *  to what they produced by something the write hands back: a comment's
     *  permalink exists once Github has stored it and never before, so a plain
     *  argument cannot carry it. Additive — every caller passing a string is
     *  unchanged. */
    detail?: string | ((out: T) => string),
  ): Promise<T> {
    const n = guardWrite({ kind: 'issue', owner, repo, name: numberRaw, email }, this.env(action))!;
    let out: T;
    try {
      out = await fn(n);
    } catch (err) {
      if (err instanceof IssueNotFoundError) throw new NotFoundException(err.message);
      // A toggle whose index maps to no task line is a client error (#426), not a
      // 500 — map it here so every route sharing `run` gets the same 400.
      if (err instanceof TaskToggleError) throw new BadRequestException(err.message);
      throw err;
    }
    const said = typeof detail === 'function' ? detail(out) : detail;
    await this.audit.record({
      actorEmail: email!,
      action,
      summary: said ? `${verb} ${owner}/${repo}#${n} (${said})` : `${verb} ${owner}/${repo}#${n}`,
      targetType: 'issue',
      targetId: `${owner}/${repo}#${n}`,
    });
    return out;
  }

  /**
   * B1 — Projects v2 node ids (`projectId`, `itemId`) are GLOBAL, not
   * constrained by the route's owner-pin: without this, a caller could pass
   * ids belonging to another org's project (or another issue's item on the
   * SAME project) and the shared token would mutate it. Re-read the issue
   * (its owner already checked, by `guardWrite`) and require the body's
   * `{projectId, itemId}` to match the SAME real entry in `issue.projects[]`.
   * Used by field-set and project-remove — project-add can't use this (the
   * issue isn't a member yet), so it checks `projectOwnerLogin` instead.
   */
  private async assertMembership(
    owner: string,
    repo: string,
    n: number,
    projectId: string,
    itemId: string,
    viewer: Viewer | undefined,
  ): Promise<void> {
    const issue = await this.service.getIssue(owner, repo, n, viewer);
    const isMember = issue?.projects.some((p) => p.projectId === projectId && p.itemId === itemId) ?? false;
    if (!isMember) {
      throw new NotFoundException(`project ${projectId} item ${itemId} not found on ${owner}/${repo}#${n}`);
    }
  }

  /**
   * PATCH /api/issues/:owner/:repo/:number/state (#384) — open/close the issue.
   * Echoes the state GitHub now holds (B2), never the client's input.
   */
  @Writes('issue.state')
  @Patch(':owner/:repo/:number/state')
  @Header('Cache-Control', 'no-store')
  @UseGuards(HumanOnlyGuard)
  async setState(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
    @Body() body: { state: IssueState },
    @Req() req: AuthedRequest,
  ): Promise<{ state: IssueState }> {
    return this.run(owner, repo, number, req.user?.email, 'issue.state', body.state === 'closed' ? 'Closed' : 'Reopened', (n) =>
      this.service.setState(owner, repo, n, body.state).then((state) => ({ state })),
    );
  }

  /**
   * PATCH /api/issues/:owner/:repo/:number/assignees (#384) — replace the
   * assignee set. Returns GitHub's ACCEPTED set (B2 coercion): a non-assignable
   * login is silently dropped upstream, so we echo what was stored.
   *
   * The audit detail is a function of that ACCEPTED set and never of
   * `body.logins` (#751): the request is what was asked for, and a row naming a
   * login Github dropped would record something that did not happen. An empty
   * accepted set is the outcome `Assign to…` produces when it clears the row, so
   * it is written out as `nobody` rather than left as an empty parenthetical —
   * an unassignment is the change most worth being able to find later.
   *
   * The row names who holds it now, not who was displaced: the previous holders
   * are only knowable from a re-read before the write, which is a second Github
   * call on every assignment. Successive rows on one issue carry the handover
   * for every assignment the board made.
   */
  @Writes('issue.assignees')
  @Patch(':owner/:repo/:number/assignees')
  @Header('Cache-Control', 'no-store')
  @UseGuards(HumanOnlyGuard)
  async setAssignees(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
    @Body() body: { logins: string[] },
    @Req() req: AuthedRequest,
  ): Promise<{ assignees: Person[] }> {
    return this.run(
      owner,
      repo,
      number,
      req.user?.email,
      'issue.assignees',
      'Set assignees on',
      (n) => this.service.setAssignees(owner, repo, n, body.logins).then((assignees) => ({ assignees })),
      (out) => (out.assignees.length ? out.assignees.map((a) => a.login).join(', ') : 'nobody'),
    );
  }

  /**
   * POST /api/issues/:owner/:repo/:number/assignees/change (#1009) — add some
   * people and remove others, and touch nobody else. `{ add, remove }` are
   * lists of logins, each at most `ASSIGNEE_CHANGE_MAX` long, with no login on
   * both sides.
   *
   * The assign picker saved through `PATCH …/assignees` above, which replaces
   * the whole set, and it built that set from a read that could be stale.
   * Somebody assigned on Github after the read was not in the set it sent, so
   * the save took them off and nobody was told. This route never tells Github
   * what the whole set is. Removals go to Github's remove endpoint and additions
   * to its add endpoint, so anyone neither list names stays as Github has them.
   *
   * Removals go first, so swapping one person on an issue at Github's cap of
   * ten never asks Github to hold eleven. What Github would answer to that is
   * not in its docs. Each call is its own `run`, with the envelope, the write
   * and an audit row naming who was asked for and who holds the issue after it.
   * If the add fails after the remove landed, the removal is still on record and
   * the refusal is what answers. Sending the same change again is meant to be
   * safe. Github's docs say an add leaves people already assigned alone. They
   * do not say what a remove does with somebody no longer assigned. The fixture
   * treats that as nothing, and real Github has not been asked.
   *
   * The body is read after the envelope, so an off-org, writes-off or refused
   * change answers the same whatever it says. An empty change is a 400, not an
   * audit row for a write that did nothing.
   */
  @Writes('issue.assignees')
  @Post(':owner/:repo/:number/assignees/change')
  @Header('Cache-Control', 'no-store')
  @UseGuards(HumanOnlyGuard)
  async changeAssignees(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
    @Body() body: { add?: unknown; remove?: unknown } | undefined,
    @Req() req: AuthedRequest,
  ): Promise<{ assignees: Person[] }> {
    const email = req.user?.email;
    guardWrite({ kind: 'issue', owner, repo, name: number, email }, this.env('issue.assignees'));
    const add = this.loginList(body?.add, 'add');
    const remove = this.loginList(body?.remove, 'remove');
    if (!add.length && !remove.length) throw new BadRequestException('A change names somebody to add or remove.');
    const both = add.filter((a) => remove.some((r) => r.toLowerCase() === a.toLowerCase()));
    if (both.length) throw new BadRequestException(`${both.join(', ')} cannot be both added and removed.`);

    const detail = (asked: string[]) => (out: { assignees: Person[] }) =>
      `asked ${asked.join(', ')}; now ${out.assignees.length ? out.assignees.map((a) => a.login).join(', ') : 'nobody'}`;
    let out: { assignees: Person[] } | undefined;
    if (remove.length) {
      out = await this.run(
        owner,
        repo,
        number,
        email,
        'issue.assignees',
        'Removed assignees from',
        (n) => this.service.removeAssignees(owner, repo, n, remove).then((assignees) => ({ assignees })),
        detail(remove),
      );
    }
    if (add.length) {
      out = await this.run(
        owner,
        repo,
        number,
        email,
        'issue.assignees',
        'Added assignees to',
        (n) => this.service.addAssignees(owner, repo, n, add).then((assignees) => ({ assignees })),
        detail(add),
      );
    }
    return out!;
  }

  /** One side of an assignee change: a list of logins, or nothing. Anything
   *  else is a 400 rather than something passed on for Github to guess at. */
  private loginList(raw: unknown, side: 'add' | 'remove'): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.some((l) => typeof l !== 'string' || !l.trim())) {
      throw new BadRequestException(`"${side}" is a list of GitHub logins.`);
    }
    if (raw.length > ASSIGNEE_CHANGE_MAX) {
      throw new BadRequestException(`"${side}" names at most ${ASSIGNEE_CHANGE_MAX} people.`);
    }
    return raw as string[];
  }

  /**
   * PATCH /api/issues/:owner/:repo/:number/labels (#384) — replace the label
   * set. Returns the labels GitHub now holds (B2).
   */
  @Writes('issue.labels')
  @Patch(':owner/:repo/:number/labels')
  @Header('Cache-Control', 'no-store')
  @UseGuards(HumanOnlyGuard)
  async setLabels(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
    @Body() body: { names: string[] },
    @Req() req: AuthedRequest,
  ): Promise<{ labels: IssueLabel[] }> {
    return this.run(owner, repo, number, req.user?.email, 'issue.labels', 'Set labels on', (n) =>
      this.service.setLabels(owner, repo, n, body.names).then((labels) => ({ labels })),
    );
  }

  /**
   * PATCH /api/issues/:owner/:repo/:number/milestone (#384) — set or clear
   * (`milestoneNumber: null`) the milestone. Returns the resulting milestone
   * title GitHub holds, or null (B2).
   */
  @Writes('issue.milestone')
  @Patch(':owner/:repo/:number/milestone')
  @Header('Cache-Control', 'no-store')
  @UseGuards(HumanOnlyGuard)
  async setMilestone(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
    @Body() body: { milestoneNumber: number | null },
    @Req() req: AuthedRequest,
  ): Promise<{ milestone: string | null }> {
    return this.run(owner, repo, number, req.user?.email, 'issue.milestone', 'Set milestone on', (n) =>
      this.service.setMilestone(owner, repo, n, body.milestoneNumber).then((milestone) => ({ milestone })),
    );
  }

  /**
   * PATCH /api/issues/:owner/:repo/:number/task (#426) — toggle one body
   * task-list checkbox. `{ line, checked }` sets the task on the given 1-based
   * SOURCE LINE to `checked`. The line comes from the client's GFM render (the
   * only authority on what is a checkbox — an occurrence count disagrees with the
   * renderer inside code fences/blockquotes); the server re-reads the current
   * body, flips exactly that line, writes the whole body back, and echoes GitHub's
   * resulting body markdown (B2) so the page reconciles its render to truth, not
   * the optimistic flip. A line that isn't a task → 400 (via `run`'s
   * TaskToggleError mapping). Same fail-closed envelope as every native write.
   */
  @Writes('issue.body.task')
  @Patch(':owner/:repo/:number/task')
  @Header('Cache-Control', 'no-store')
  @UseGuards(HumanOnlyGuard)
  async toggleTask(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
    @Body() body: { line: number; checked: boolean },
    @Req() req: AuthedRequest,
  ): Promise<{ bodyMarkdown: string }> {
    return this.run(
      owner,
      repo,
      number,
      req.user?.email,
      'issue.body.task',
      body.checked ? 'Checked a task on' : 'Unchecked a task on',
      // The viewer goes down with the write: what comes back is the issue's whole
      // body, and on a feedback submission that is somebody else's message and
      // address, so the words rule runs on it before it is served (#516). Depth
      // behind `HumanOnlyGuard` above, not a replacement for it.
      (n) =>
        this.service
          .toggleTask(owner, repo, n, body.line, body.checked, req.user)
          .then((bodyMarkdown) => ({ bodyMarkdown })),
      `task line ${body.line}`,
    );
  }

  /**
   * POST /api/issues/:owner/:repo/:number/comment (#693) — answer the issue from
   * the board instead of leaving for Github. `{ bodyMarkdown }` is posted
   * verbatim and lands on Github as markdown; what comes back is the comment
   * GITHUB STORED, in the same shape `IssueDetail.comments[]` carries, so the
   * page appends it to the thread it is already rendering without re-reading the
   * issue. Same fail-closed envelope as every native write, human-only for the
   * reason the whole controller is: a comment goes out in a person's name.
   *
   * The body is checked INSIDE the envelope's callback, so `guardWrite` has
   * already answered first: an off-org owner, a bad number, writes-off, a
   * refused capability and a missing session are all decided before the request
   * body is looked at, and an empty body cannot tell a caller apart from a 403.
   */
  @Writes('issue.comment')
  @Post(':owner/:repo/:number/comment')
  @Header('Cache-Control', 'no-store')
  @UseGuards(HumanOnlyGuard)
  async postComment(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
    @Body() body: { bodyMarkdown: string },
    @Req() req: AuthedRequest,
  ): Promise<PostedComment> {
    return this.run(
      owner,
      repo,
      number,
      req.user?.email,
      'issue.comment',
      'Commented on',
      (n) =>
        // Composed INSIDE the callback, so `guardWrite` has already established
        // the session: the address stamped on the comment is the one the guard
        // just refused to proceed without, never one the request supplied.
        this.service.addComment(owner, repo, n, this.commentBody(body?.bodyMarkdown, req.user!.email!)),
      // WHICH comment this row produced. Actor, action, issue and timestamp
      // cannot tell two board comments on one issue apart, and the footer above
      // is the only other record of who wrote which — so the row carries the
      // permalink Github hands back. `htmlUrl` is nullable because the REST
      // create response is not bound to fill `html_url`; a row that says so is
      // still a row that says the permalink is missing rather than one that
      // silently reads like every other.
      (posted) => posted.htmlUrl ?? 'Github returned no permalink',
    );
  }

  @Writes('issue.comment')
  @Patch(':owner/:repo/:number/text')
  @Header('Cache-Control', 'no-store')
  @UseGuards(HumanOnlyGuard)
  async editText(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
    @Body() body: { bodyMarkdown?: unknown; expectedBody?: unknown; commentId?: unknown },
    @Req() req: AuthedRequest,
  ): Promise<{ bodyMarkdown: string }> {
    return this.run(owner, repo, number, req.user?.email, 'issue.comment', 'Edited text on', async n => {
      if (!githubPrincipal()?.token) throw new ForbiddenException('Connect your GitHub account to edit this text.');
      if (typeof body?.bodyMarkdown !== 'string' || typeof body?.expectedBody !== 'string' ||
          (body.commentId !== undefined && (!Number.isSafeInteger(body.commentId) || Number(body.commentId) <= 0)) ||
          (body.commentId !== undefined && !body.bodyMarkdown.trim())) {
        throw new BadRequestException('Enter valid text and its original version before saving.');
      }
      if (body.bodyMarkdown.length > COMMENT_BODY_MAX || body.expectedBody.length > COMMENT_BODY_MAX) {
        throw new BadRequestException(`Shorten the text to ${COMMENT_BODY_MAX} characters or fewer.`);
      }
      return this.service.editText(owner, repo, n, body.bodyMarkdown, body.expectedBody, body.commentId as number | undefined);
    }, body?.commentId === undefined ? 'issue body' : `comment ${body.commentId}`);
  }

  /** Personal writes keep the author's markdown; shared writes need attribution.
   * Validate the final body against GitHub's cap and keep forged signatures out. */
  private commentBody(raw: unknown, email: string): string {
    const text = typeof raw === 'string' ? raw : '';
    if (!text.trim()) throw new BadRequestException('This comment is empty. Write something and send it again.');
    if (carriesForgedFooter(text)) {
      throw new BadRequestException(
        'A line in this comment renders as the board’s own signature, which is reserved for shared-account posts. Take that line out and send it again.',
      );
    }
    const sharedAccount = !githubPrincipal();
    const composed = sharedAccount ? composeComment(text, email) : text;
    if (composed.length > COMMENT_BODY_MAX) {
      throw new BadRequestException(
        sharedAccount
          ? `This comment is ${text.length} characters. The most that fits is ${maxAuthorBody(email)}, because the board adds its signature line inside GitHub’s cap of ${COMMENT_BODY_MAX}. Shorten it and send it again.`
          : `This comment is ${text.length} characters. GitHub’s limit is ${COMMENT_BODY_MAX}. Shorten it and send it again.`,
      );
    }
    return composed;
  }

  /**
   * POST /api/issues/:owner/:repo/:number/project (#384 Task 7) — add this
   * issue to a Projects v2 board. The issue isn't a member yet, so B1 can't
   * cross-check `issue.projects[]` here; instead it resolves the TARGET
   * project's owning org via `projectOwnerLogin` and requires `servesOwner` to
   * hold it — the route's `owner` gates the ISSUE, not the project, so without
   * this a caller could add the issue to a project in an org this board does not
   * serve. Audited with the projectId as detail (B3).
   */
  @Writes('issue.project.add')
  @Post(':owner/:repo/:number/project')
  @Header('Cache-Control', 'no-store')
  @UseGuards(HumanOnlyGuard)
  async addProject(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
    @Body() body: { projectId: string },
    @Req() req: AuthedRequest,
  ): Promise<{ itemId: string }> {
    return this.run(
      owner,
      repo,
      number,
      req.user?.email,
      'issue.project.add',
      'Added to project on',
      async (n) => {
        // Additional to the envelope `run` already put this write through: that
        // one pinned the ISSUE's owner, and this pins the PROJECT's, which is a
        // different string and can name a different org. It stays a check that
        // REFUSES — the set is asked whether it holds this owner, never asked
        // which owner to use.
        const projectOwner = await this.service.projectOwnerLogin(body.projectId);
        if (!this.servesOwner(projectOwner)) {
          throw new NotFoundException(`project ${body.projectId} not found`);
        }
        return this.service.addToProject(owner, repo, n, body.projectId);
      },
      body.projectId,
    );
  }

  /**
   * POST /api/issues/:owner/:repo/:number/project/new (#982) — make a new
   * Projects v2 project called `{ title }` under the issue's own owner, and put
   * this issue on it.
   *
   * Two Github writes, each its own `run` with the envelope, the write and an
   * audit row, the shape the assignee change takes (#1009). The project is made
   * under the route's `owner`, which `guardWrite` has already pinned to an owner
   * this board serves. The add is `addProject` above, the same path a pick from
   * the list takes, its project-owner check included.
   *
   * The issue is read, and both capabilities are asked, before anything is
   * made, so a missing issue, or an add the board already knows it may not
   * make, leaves no empty project behind. An add refused for the first time
   * still can. The project is then on Github and on record, and the answer says
   * so, names it, and drops the picker's catalog so the project can be picked.
   *
   * The title is read after the envelope, so an off-org, writes-off or refused
   * request answers the same whatever it says. A blank title, one over
   * `PROJECT_TITLE_MAX`, one holding a control character, or one the board would
   * hide from its own lists is a 400. A title an open project under this owner
   * already carries is a 409, because Github itself keeps two projects with one
   * name. That check is Github's search, so it misses what the search does not
   * return. One create per owner and name runs at a time in this process, which
   * covers a second press or a second tab here and not a second instance.
   */
  @Writes('issue.project.create', 'issue.project.add')
  @Post(':owner/:repo/:number/project/new')
  @Header('Cache-Control', 'no-store')
  @UseGuards(HumanOnlyGuard)
  async createProject(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
    @Body() body: { title?: unknown } | undefined,
    @Req() req: AuthedRequest,
  ): Promise<{ project: CreatedProject; itemId: string }> {
    const email = req.user?.email;
    guardWrite({ kind: 'issue', owner, repo, name: number, email }, this.env('issue.project.create'));
    guardWrite({ kind: 'issue', owner, repo, name: number, email }, this.env('issue.project.add'));
    const title = this.projectTitle(body?.title);

    // Taken before the first await, so a second request for the same name
    // arriving while this one is out finds it.
    const key = `${owner.toLowerCase()}::${title.toLowerCase()}`;
    if (this.making.has(key)) {
      throw new ConflictException(`A project called “${title}” is being made in ${owner} right now.`);
    }
    this.making.add(key);
    try {
      const project = await this.run(
        owner,
        repo,
        number,
        email,
        'issue.project.create',
        'Made a project from',
        (n) =>
          this.service.createProject(owner, repo, n, title).catch((err: unknown) => {
            if (err instanceof ProjectTitleTakenError) throw this.titleTaken(owner, err);
            throw err;
          }),
        (made) => `${made.title}, project ${made.number} of ${made.owner}`,
      );
      try {
        const { itemId } = await this.addProject(owner, repo, number, { projectId: project.id }, req);
        return { project, itemId };
      } catch (err) {
        throw this.madeButNotAdded(err, project);
      }
    } finally {
      this.making.delete(key);
    }
  }

  /** The name a new project gets: what was typed, trimmed. Each refusal is a
   *  400 here rather than something sent for Github to decide about. A control
   *  character would also carry a forged line into the log that names the
   *  project. A name the board hides from its own lists (`isSurfacedProjectName`)
   *  would make a project nobody could then find on the board. */
  private projectTitle(raw: unknown): string {
    const title = typeof raw === 'string' ? raw.trim() : '';
    if (!title) throw new BadRequestException('A new project needs a name.');
    if (title.length > PROJECT_TITLE_MAX) {
      throw new BadRequestException(`A project name here is at most ${PROJECT_TITLE_MAX} characters.`);
    }
    // C0 controls and DEL: nothing a one-line name holds.
    if (/[\u0000-\u001f\u007f]/.test(title)) {
      throw new BadRequestException('A project name is one line of text, with no tabs or line breaks.');
    }
    if (!isSurfacedProjectName(title)) {
      throw new BadRequestException(
        'The board does not show projects named “Acme” or with “untitled” in the name, so this one would not appear here. Choose another name.',
      );
    }
    return title;
  }

  /** A 409 that names the project already carrying the name, so the page can
   *  offer that one instead of making a second. */
  private titleTaken(owner: string, err: ProjectTitleTakenError): ConflictException {
    return new ConflictException({
      message: `${owner} already has a project called “${err.existing.title}”. Choose another name, or add this issue to that project.`,
      project: { ...err.existing, owner },
    });
  }

  /** The add failed after the project was made. The project is real, so the
   *  answer keeps the add's own status and reason and says what now exists.
   *  Something that was not an HTTP answer at all is a 502, as the refusal
   *  classifier answers an unreadable Github failure, and it is logged here,
   *  because Nest's filter logs no `HttpException` and this wraps it in one.
   *
   *  The catalog goes too. The write interceptor drops caches on a success
   *  only, and this answer is an error over a project that now exists. */
  private madeButNotAdded(err: unknown, project: CreatedProject): HttpException {
    this.freshness.invalidateAll(['issue.project.create']);
    this.logger.error(`project ${project.id} was made in ${project.owner}, and the add to it failed: ${asMsg(err)}`);
    const said = err instanceof HttpException ? err.getResponse() : null;
    const body = typeof said === 'object' && said !== null ? (said as Record<string, unknown>) : {};
    const why = typeof body.message === 'string' ? ` ${body.message}` : '';
    return new HttpException(
      {
        ...body,
        // Whatever code the inner answer carried belongs to the inner MESSAGE,
        // which this replaces. An auth-layer `access_not_now` reaching a reader
        // from here would say "keep what you have" about a write that did not
        // happen; `auth/access-not-now-code.spec.ts` is what holds this.
        code: undefined,
        message: `The project “${project.title}” was made in ${project.owner}, but this issue could not be added to it.${why}`,
        project,
      },
      err instanceof HttpException ? err.getStatus() : 502,
    );
  }

  /**
   * DELETE /api/issues/:owner/:repo/:number/project (#384 Task 7) — remove
   * this issue from a Projects v2 board. B1: re-reads the issue and requires
   * the body's `{projectId, itemId}` to match a real membership BEFORE
   * mutating, blocking both a foreign project and a foreign item on a project
   * this issue happens to share.
   */
  @Writes('issue.project.remove')
  @Delete(':owner/:repo/:number/project')
  @Header('Cache-Control', 'no-store')
  @UseGuards(HumanOnlyGuard)
  async removeProject(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
    @Body() body: { projectId: string; itemId: string },
    @Req() req: AuthedRequest,
  ): Promise<{ ok: true }> {
    return this.run(
      owner,
      repo,
      number,
      req.user?.email,
      'issue.project.remove',
      'Removed from project on',
      async (n) => {
        await this.assertMembership(owner, repo, n, body.projectId, body.itemId, req.user);
        await this.service.removeFromProject(owner, repo, n, body.itemId, body.projectId);
        return { ok: true as const };
      },
      body.projectId,
    );
  }

  /**
   * PATCH /api/issues/:owner/:repo/:number/field (#384 Task 7) — set one
   * Projects v2 custom field's value for this issue. B1: same membership
   * re-read as project-remove, before the write. Returns GitHub's stored value
   * (B2), not the client's input.
   */
  @Writes('issue.field')
  @Patch(':owner/:repo/:number/field')
  @Header('Cache-Control', 'no-store')
  @UseGuards(HumanOnlyGuard)
  async setField(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('number') number: string,
    @Body() body: { projectId: string; itemId: string; fieldId: string; value: FieldValue },
    @Req() req: AuthedRequest,
  ): Promise<{ value: FieldValue }> {
    return this.run(
      owner,
      repo,
      number,
      req.user?.email,
      'issue.field',
      'Set field on',
      async (n) => {
        await this.assertMembership(owner, repo, n, body.projectId, body.itemId, req.user);
        const value = await this.service.setFieldValue(owner, repo, n, body.projectId, body.itemId, body.fieldId, body.value);
        return { value };
      },
      body.fieldId,
    );
  }
}
