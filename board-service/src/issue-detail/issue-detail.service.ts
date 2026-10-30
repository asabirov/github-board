import { githubPrincipal, PrincipalState } from '../auth/github-principal';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FeedbackScope,
  Viewer,
  assertMayReadWords,
  feedbackScopeFrom,
  labelsOf,
  withheldFrom,
} from '../auth/feedback-visibility';
import type { Capability } from '../capability/capability';
import { hasSubmissionFooter } from '../auth/submission-footer';
import { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import {
  ClosedIssue,
  ChosenCloseReason,
  FieldValue,
  IIssueDetailSource,
  ISSUE_DETAIL_SOURCE,
  IssueDetail,
  IssueEditOptions,
  IssueLabel,
  IssueState,
  Person,
  PostedComment,
} from './issue-detail.types';
import { readableRelations } from './relation-visibility';
import type { StaleOnWrite } from '../freshness/stale-on-write';

interface Entry {
  value: IssueDetail | null; // null = a cached 404 (don't re-hammer GitHub for it)
  at: number;
  inFlight: Promise<IssueDetail | null> | null;
}

/**
 * Serves the in-board issue page (#235). Each issue is fetched on demand and
 * cached per `owner/repo#number` for a short TTL, served stale-while-revalidate
 * like the buckets: a fresh entry returns directly; a stale one returns now and
 * refreshes in the background. A refresh error degrades to the stale value
 * (`getIssue` never throws once we have any cached value) so a GitHub blip
 * doesn't blank a page that was working a second ago. A 404 is cached too, so a
 * mistyped URL doesn't spam the API.
 */
@Injectable()
export class IssueDetailService implements StaleOnWrite {
  private readonly principalState = new PrincipalState(() => ({
    cache: new Map<string, Entry>() as Map<string, Entry>,
    epoch: 0 as number,
    lastGood: new Map<string, { value: IssueDetail | null; at: number }>() as Map<string, { value: IssueDetail | null; at: number }>
  }));
  private readonly logger = new Logger(IssueDetailService.name);
  private get cache(): Map<string, Entry> { return this.principalState.current.cache; }
  private set cache(value: Map<string, Entry>) { this.principalState.current.cache = value; }
  private readonly ttlMs: number;
  /** Which issues are somebody else's words, for the one visibility decision. */
  private readonly feedback: FeedbackScope;
  /** Moves on every drop, so an issue read that went out before one cannot write
   *  what it read into the cache when it lands (#692). */
  private get epoch(): number { return this.principalState.current.epoch; }
  private set epoch(value: number) { this.principalState.current.epoch = value; }
  /** The last good copy of each issue this served, RETIRED by a drop rather than
   *  deleted (#692). It is what a post-drop read falls back to when Github
   *  refuses it — never what a successful one returns. Keyed and bounded exactly
   *  as `cache` is. */
  private get lastGood(): Map<string, { value: IssueDetail | null; at: number }> { return this.principalState.current.lastGood; }
  private set lastGood(value: Map<string, { value: IssueDetail | null; at: number }>) { this.principalState.current.lastGood = value; }

  constructor(
    @Inject(ISSUE_DETAIL_SOURCE) private readonly source: IIssueDetailSource,
    @Inject(ConfigService) config: ConfigService,
    // The shared issues cache, read for one thing only: the submission marker
    // the relations gate needs (#516). Same org-wide scan the metrics and
    // Projects surfaces already share — no extra Github call.
    @Inject(IssuesCacheService) private readonly issuesCache: IssuesCacheService,
  ) {
    this.ttlMs = config.get<number>('ISSUE_DETAIL_CACHE_TTL_MS', 60_000);
    this.feedback = feedbackScopeFrom(config);
  }

  /** Close the issue on Github (#287/#291), then drop its cache entry so the next
   *  read reflects the closed state instead of the stale-open cached copy. Errors
   *  (incl. `IssueNotFoundError`) propagate to the controller. */
  async closeIssue(
    owner: string,
    repo: string,
    number: number,
    /** #584 — the word the close route declares in its `@Writes`, carried down
     *  so a refused close is remembered as `issue.close` rather than as the
     *  `issue.state` it shares a Github call with. */
    capability: Capability = 'issue.close',
    /** #1006 — Github's `state_reason`; absent means none was stated. */
    reason?: ChosenCloseReason,
  ): Promise<ClosedIssue> {
    const closed = await this.source.close(owner, repo, number, capability, reason);
    this.evict(owner, repo, number);
    return closed;
  }

  /** Drop a cached detail so the next read reflects the just-written facet
   *  instead of the stale copy — the shared invalidation for every mutation. */
  private evict(owner: string, repo: string, number: number): void {
    this.cache.delete(`${owner}/${repo}#${number}`);
  }

  /** Declare every cached issue out of date (#692) — see `StaleOnWrite`.
   *
   *  `evict` above keeps its job: a facet write knows exactly which issue it
   *  changed, and dropping that one entry is what makes the page it came from
   *  right. This is the whole map, for the issues a write changed WITHOUT being
   *  told which they are — a close moves the state shown on every page that
   *  relates to it, and a write added later inherits this without naming any
   *  issue at all.
   *
   *  NO `warmAfterWrite` (#692): this cache is keyed per issue and filled on
   *  demand, so there is no org-wide answer to warm, and the next open of a page
   *  pays one read, exactly as it already does after a facet write. */
  dropCaches(): void {
    // RETIRED, not deleted. Every page here is one Github fetch, and a drop is
    // followed by a cold one: without this, a close done while Github was rate-
    // limiting turned every issue page in the board into a 500, where a second
    // earlier each would have shown the copy it already had. Only a FAILED read
    // reaches for these — see `refresh`.
    for (const [key, entry] of this.cache) {
      if (entry.at > 0) this.lastGood.set(key, { value: entry.value, at: entry.at });
    }
    this.cache.clear();
    this.epoch++;
  }

  // Native facet writes (#384). Each returns the source's AUTHORITATIVE result
  // (B2 — GitHub's coerced value, not the request) and then evicts, so a cold
  // read matches what the write actually stored.

  async setState(owner: string, repo: string, number: number, state: IssueState): Promise<IssueState> {
    const v = await this.source.setState(owner, repo, number, state);
    this.evict(owner, repo, number);
    return v;
  }

  async setAssignees(owner: string, repo: string, number: number, logins: string[]): Promise<Person[]> {
    const v = await this.source.setAssignees(owner, repo, number, logins);
    this.evict(owner, repo, number);
    return v;
  }

  async addAssignees(owner: string, repo: string, number: number, logins: string[]): Promise<Person[]> {
    const v = await this.source.addAssignees(owner, repo, number, logins);
    this.evict(owner, repo, number);
    return v;
  }

  async removeAssignees(owner: string, repo: string, number: number, logins: string[]): Promise<Person[]> {
    const v = await this.source.removeAssignees(owner, repo, number, logins);
    this.evict(owner, repo, number);
    return v;
  }

  /** Who holds the issue now, for the assign picker (#1009). Straight to the
   *  source every time and never through `read`: that path serves a stale entry
   *  of ANY age while it refreshes in the background, so a picker ticked from it
   *  could show a set Github stopped holding long ago. */
  async currentAssignees(owner: string, repo: string, number: number): Promise<Person[] | null> {
    return this.source.currentAssignees(owner, repo, number);
  }

  async setLabels(owner: string, repo: string, number: number, names: string[]): Promise<IssueLabel[]> {
    const v = await this.source.setLabels(owner, repo, number, names);
    this.evict(owner, repo, number);
    return v;
  }

  async setMilestone(owner: string, repo: string, number: number, milestoneNumber: number | null): Promise<string | null> {
    const v = await this.source.setMilestone(owner, repo, number, milestoneNumber);
    this.evict(owner, repo, number);
    return v;
  }

  /**
   * Toggle a body task-list checkbox (#426): the source rewrites + writes the
   * body, we return its authoritative result (B2) and evict so a cold read
   * matches. `TaskToggleError`/`IssueNotFoundError` propagate to the controller.
   *
   * The result is Github's WHOLE stored body, which on a feedback submission is
   * an end user's message under their address — so the words rule runs on it
   * before it is returned (#516). Nothing answered that question on this path
   * before, which made it the one route serving words without asking.
   *
   * This is depth, not the primary control: the route carries
   * `@UseGuards(HumanOnlyGuard)`, which is what actually keeps a static agent
   * token off it, for its own separate reason. Do not remove that guard on the
   * strength of this check. It costs a human nothing — `mayReadWords`
   * short-circuits on any caller with a real address, so `labels: null` here is
   * never reached for one; for anyone else it fails closed inside the feedback
   * repo, which is the intended answer.
   *
   * Note what it does NOT do. This gate runs on the read-back of a write that
   * has ALREADY landed on Github, so it stops the body being disclosed and stops
   * nothing else: the checkbox stays flipped, and the caller learns that much
   * from the refusal. Only `HumanOnlyGuard` keeps a static token from writing at
   * all, which is why it, not this, is the control that matters even where the
   * concern is disclosure.
   */
  async toggleTask(
    owner: string,
    repo: string,
    number: number,
    line: number,
    checked: boolean,
    viewer?: Viewer,
  ): Promise<string> {
    const body = await this.source.toggleTask(owner, repo, number, line, checked);
    // Evict BEFORE the gate: the write has already landed on Github, so refusing
    // to hand the body back must not also leave a stale copy cached behind it.
    this.evict(owner, repo, number);
    // KNOWN AND LEFT (#692): this eviction covers THIS issue, and the five other
    // caches a write invalidates are dropped by the interceptor, which fires
    // only on a 2xx. So a write that lands at Github and then throws here —
    // exactly the case the line above exists for — leaves those five serving
    // what it made wrong until their TTL. Dropping on error as well would fix it
    // and would also hand any caller a way to flush every cache in the process
    // by driving writes that fail, which is the worse of the two. Reviewed and
    // declined on purpose, not overlooked.
    assertMayReadWords(
      { owner, repo, htmlUrl: null, labels: null, submission: hasSubmissionFooter(body) },
      viewer,
      this.feedback,
    );
    return body;
  }

  /**
   * Answer an issue from the board (#693): write the comment through the source,
   * then evict THIS issue's cached detail so the next read carries the new entry
   * in its thread rather than the pre-write copy. The same write-then-evict every
   * facet above does; the other five caches a write invalidates are dropped by
   * the `StaleOnWrite` interceptor on the 2xx (#692), so there is no second
   * invalidation here.
   *
   * NO WORDS GATE, unlike `toggleTask` above, and the difference is whose words
   * come back. That one returns the issue's WHOLE body, which on a feedback
   * submission is an end user's message under their address — words the caller
   * never had. This returns the comment the caller has just written, plus the
   * three facts Github recorded about it: the author (the board's own write
   * credential), the time and the permalink. There is nothing here the caller
   * did not supply or already know, so `assertMayReadWords` would have no
   * disclosure to refuse. `HumanOnlyGuard` on the route is what keeps a static
   * token from writing in a person's name, and it is unchanged.
   */
  async editText(owner: string, repo: string, number: number, bodyMarkdown: string, expectedBody: string, commentId?: number): Promise<{ bodyMarkdown: string }> {
    const saved = await this.source.editText(owner, repo, number, bodyMarkdown, expectedBody, commentId);
    this.evict(owner, repo, number);
    return saved;
  }

  async addComment(owner: string, repo: string, number: number, bodyMarkdown: string): Promise<PostedComment> {
    const v = await this.source.addComment(owner, repo, number, bodyMarkdown);
    this.evict(owner, repo, number);
    return v;
  }

  /** The repo's edit-options catalog (#384) — a read, so no cache eviction. A
   *  plain pass-through: the call is cheap and infrequent (opened once when the
   *  panel's editors mount). */
  async editOptions(owner: string, repo: string): Promise<IssueEditOptions> {
    return this.source.editOptions(owner, repo);
  }

  // Projects v2 membership + custom fields (#384 Task 7). Node ids (projectId,
  // itemId) are global, so — unlike the native facets above — these are NOT
  // keyed by owner/repo/number in the source; that triple is threaded through
  // here PURELY to evict this issue's cache entry after the write (the
  // controller already has it from the route; see B1 for the security binding,
  // which happens in the controller BEFORE these are called).

  /** A read: which org/user owns a project node id — the controller's B1 check
   *  for project-add (no cache involved, so no eviction). */
  async projectOwnerLogin(projectId: string): Promise<string | null> {
    return this.source.projectOwnerLogin(projectId);
  }

  async addToProject(owner: string, repo: string, number: number, projectId: string): Promise<{ itemId: string }> {
    const v = await this.source.addToProject(owner, repo, number, projectId);
    this.evict(owner, repo, number);
    return v;
  }

  /** Make a project under `owner` (#982). No issue changes until the add that
   *  follows, which evicts; the catalog of an owner's projects is dropped by the
   *  write interceptor, which is told this route makes one. */
  async createProject(owner: string, repo: string, number: number, title: string) {
    return this.source.createProject(owner, repo, number, title);
  }

  async removeFromProject(owner: string, repo: string, number: number, itemId: string, projectId: string): Promise<void> {
    // `owner`/`repo` travel on to the source now (#584): the mutation addresses
    // a node id, and the capability registry keys on `owner/repo`.
    await this.source.removeFromProject(itemId, projectId, owner, repo);
    this.evict(owner, repo, number);
  }

  async setFieldValue(
    owner: string,
    repo: string,
    number: number,
    projectId: string,
    itemId: string,
    fieldId: string,
    value: FieldValue,
  ): Promise<FieldValue> {
    const v = await this.source.setFieldValue(projectId, itemId, fieldId, value, owner, repo);
    this.evict(owner, repo, number);
    return v;
  }

  /**
   * The issue page's data — and the two gates on it (#497).
   *
   * The first is the issue itself. This route returns the body and the whole
   * comment thread, and a feedback submission's body is an end user's message
   * beside a `Submitted by <address>` attribution — leading it since #749, under
   * it on everything filed before — so a static `BOARD_AGENT_TOKENS` token is
   * refused it. There is no redacted version worth serving, and the gate that
   * decides never looks at where the line sits.
   *
   * The second is its NEIGHBOURS, and it is why the first was not enough. The
   * page names an issue's parent, sub-issues and dependencies by title, and we
   * file submissions under umbrella issues as a matter of course — so an
   * ordinary team issue passed the gate and then handed a submission's first
   * line over in `relations`. That one is redacted rather than refused: the
   * neighbour's row is legitimately readable, only its words are not.
   *
   * Both gates sit OUTSIDE the cache, so they hold identically on a cold fetch,
   * a fresh hit and a stale one — a copy a teammate primed is not a way in. The
   * relations pass copies rather than edits, so a token's read leaves the cached
   * issue whole for the human who reads it next.
   *
   * `viewer` is optional only so the method stays callable from a spec without a
   * request; omitting it is the CLOSED case, not the open one — an unnamed caller
   * is refused a submission the same as a static token is.
   */
  async getIssue(
    owner: string,
    repo: string,
    number: number,
    viewer?: Viewer,
  ): Promise<IssueDetail | null> {
    const issue = await this.read(owner, repo, number);
    if (!issue) return issue;
    assertMayReadWords(
      {
        owner: issue.owner,
        repo: issue.repo,
        htmlUrl: issue.htmlUrl,
        // A page GitHub had more labels than is not this issue's label set, and
        // the decision must know the difference — see `KnownLabels`.
        labels: labelsOf(issue.labels.map((l) => l.name), issue.labelsComplete),
        // Read off the body this route already fetched (#516). No index, no
        // cache, no coupling: the route that serves the words is the route that
        // reads them, so this gate is right the moment the service boots.
        submission: hasSubmissionFooter(issue.bodyMarkdown),
      },
      viewer,
      this.feedback,
    );
    // A relation carries no body, so that gate reads the shared index (#516).
    // This route's OWN gate stays independent of it — it has the body — so the
    // issue you asked for is placed correctly even before the first ingest.
    //
    // Resolved only for a viewer the words are actually withheld from. For
    // anyone else `mayReadWords` answers true before `submission` is consulted,
    // so the index's value is provably dead — and reaching for it anyway put
    // this route on the shared issues cache for nothing. On a boot whose warm
    // failed that cache is cold, so a human's issue-page load would pay an
    // org-wide ~70-repo scan on a route that never touched it before, and a
    // burst of loads under a Github outage would fire a scan each (the in-flight
    // dedupe covers concurrent callers, not sequential ones).
    //
    // `withheldFrom` is the decision's own predicate, imported rather than
    // copied. It gates WORK, never an answer: the answer is still `mayReadWords`
    // inside `readableRelations`, which asks the same question for itself.
    const submissions = withheldFrom(viewer) ? await this.issuesCache.submissionIndex() : null;
    return { ...issue, relations: readableRelations(issue.relations, viewer, this.feedback, submissions) };
  }

  /** The cached read itself: fresh / stale-while-revalidate / cold. */
  private async read(owner: string, repo: string, number: number): Promise<IssueDetail | null> {
    const key = `${owner}/${repo}#${number}`;
    const now = Date.now();
    const hit = this.cache.get(key);

    if (hit && now - hit.at < this.ttlMs) return hit.value;

    // Stale but present: serve it now, refresh in the background.
    if (hit) {
      this.refresh(key, owner, repo, number).catch((err) =>
        this.logger.warn(`background issue refresh ${key} failed: ${asMsg(err)}`),
      );
      return hit.value;
    }

    // Cold: must wait once. A fetch failure propagates (nothing to fall back to).
    return this.refresh(key, owner, repo, number);
  }

  /** Fetch and replace the cache entry. Deduped via the entry's `inFlight`. */
  private refresh(key: string, owner: string, repo: string, number: number): Promise<IssueDetail | null> {
    const existing = this.cache.get(key);
    if (existing?.inFlight) return existing.inFlight;
    // A prior *completed* fetch (`at > 0`) is what we can fall back to on error —
    // not the placeholder entry this call is about to write for its in-flight.
    const own = existing && existing.at > 0 ? existing : null;
    // A drop leaves none, so the copy it retired stands in for one: that is what
    // stops a write turning a Github outage into a 500 on every issue page
    // (#692). Held apart from `own` because the two are not equally cacheable —
    // see the `catch` below. Both are read ONLY on the way into it.
    const retired = own ? null : (this.lastGood.get(key) ?? null);
    const stale = own ?? retired;

    const epoch = this.epoch;
    // Whether this read still describes the issue as it is now. A read that went
    // out before a write is answered to its own caller and cached for nobody —
    // caching it would put the pre-write issue back, and its `stale` fallback
    // would put back an issue older still (#692).
    const current = (): boolean => epoch === this.epoch;
    const inFlight = this.source
      .fetch(owner, repo, number)
      .then((value) => {
        if (current()) {
          this.cache.set(key, { value, at: Date.now(), inFlight: null });
          // Nothing to fall back to while there is a current answer.
          this.lastGood.delete(key);
        }
        return value;
      })
      .catch((err) => {
        if (githubPrincipal()) { this.cache.delete(key); this.lastGood.delete(key); throw err; }
        if (stale) {
          if (current()) {
            if (retired) {
              // SERVED to the caller who asked, and cached for nobody. Its `at`
              // is from before the write, so writing it back would leave an
              // entry that reads as FRESH for whatever is left of the TTL: one
              // failed read would suppress every read after it for up to a
              // minute, including the ones Github would have answered. The
              // other five caches gate their retired copy per call, and this is
              // how this one does (#692 review). Dropping the placeholder is
              // what makes the next reader cold, and therefore a caller of the
              // source.
              this.cache.delete(key);
            } else {
              // Keep serving the last good value (a background refresh failed).
              // Its `at` is its own, and already past the TTL — that is how this
              // entry came to be refreshed — so it suppresses nothing.
              this.cache.set(key, { value: stale.value, at: stale.at, inFlight: null });
            }
          }
          return stale.value;
        }
        // Cold fetch failed: drop the placeholder so a retry can try again, and
        // propagate — there's nothing to serve.
        if (current()) this.cache.delete(key);
        throw err;
      });

    this.cache.set(key, { value: stale?.value ?? null, at: stale?.at ?? 0, inFlight });
    return inFlight;
  }
}

function asMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
