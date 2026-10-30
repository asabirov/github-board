import { githubPrincipal, PrincipalState } from '../auth/github-principal';
import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { feedbackScopeFrom } from '../auth/feedback-visibility';
import { githubOrgs } from '../config/github-orgs';
import { ISSUE_STORE, type IssueStore, type StoreRead, type StoreRepo } from '../github-store/issue-store';
import { IssueStoreHealth } from '../github-store/issue-store-health';
import { buildOctokitClient } from '../sources/github-client';
import { logGithubFailure, quotaRetryAt } from '../sources/github-quota';
import { unknownCloseReason } from './close-reason';
import { IIssuesSource, ListIssuesOptions, RawIssue } from './issues-metrics.types';
import { rawIssueOf, storedIssueOf, type StoredIssue } from './stored-issue';

/**
 * How one configured org's read went, and what it cost (#647).
 *
 * This record is the ONLY thing that lets a surface tell "globex has no work
 * this week" from "globex was not readable". The issue list itself is a union
 * and cannot say which org it covers, so an org whose enumeration failed
 * contributes nothing to it and is indistinguishable, inside the list, from an
 * org that is genuinely quiet. Those two must never draw the same, and this is
 * where the difference is kept.
 */
export interface OrgReadOutcome {
  org: string;
  /** `read` — the org's repo list came back. `unreadable` — the enumeration
   *  failed, so NOTHING is known about this org's work. Never a counted zero. */
  state: 'read' | 'unreadable';
  /** WHY it was unreadable, in Github's own words, or `null` when it was read.
   *
   *  The record replaced a throw, so it carries what the throw carried. Without
   *  it the cause exists only in a log line, and no surface can read a log line
   *  — which would leave "globex is unreadable" on screen with nothing to say
   *  whether that is a credential, a 404, or a Github outage. */
  reason: string | null;
  /** Paginated LIST calls made against this org: one for the enumeration, plus
   *  one for each repo paged afterwards. Each is at least one HTTP request and
   *  more when the list spans pages, so this is a floor, not a total — it is
   *  here to answer how much a second org actually costs, which nothing has
   *  measured. A failed enumeration still counts its one call. */
  calls: number;
}

/**
 * How ONE repo's issue read went on the last ingest (#837).
 *
 * `fetchRepo` never throws — a repo that loses its pagination to a secondary
 * rate limit resolves `{ ok: false, issues: [] }` and the run carries on, which
 * is right: one repo must not blank an org. But the issue list is a union and
 * cannot say which repo it covers, so that repo is indistinguishable inside it
 * from a repo with nothing open. `OrgReadOutcome` is the same argument one level
 * up and cannot answer this one: the org's ENUMERATION succeeded, so the org is
 * `read` while one of its repos is not.
 *
 * The Repo page is where the difference shows: it draws one repo's whole open
 * queue, so an unread repo draws "No open issues." as a positive fact about a
 * queue nobody read.
 */
export interface RepoReadOutcome {
  id?: number;
  fromStore?: boolean;
  /** `owner/name`, exactly as the ingest asked Github for it — the same
   *  owner-qualified key `repoJoinKey` composes, and never the short key, which
   *  carries no owner and folds two orgs' same-named repos together (#647). */
  full: string;
  /** False when this repo's own fetch failed. A `false` is the ONLY thing that
   *  makes a surface say "could not read": absent from the list is not a failure,
   *  it is a repo the ingest never asked about. */
  ok: boolean;
}

/**
 * 'acme/board' → 'board'; 'acme/acme' → 'acme'.
 *
 * Lossy, and knowingly kept that way (#484). A repo literally named `board`
 * alongside `board.example.com` derives the same key, and anything keyed by it
 * alone answers for both. The key is not private to the ingest: `?repo=` is a
 * shareable board URL and an API query value, so changing it would silently
 * change what every link that carries one means. The collision is reported
 * instead — see `reportRepoKeyCollisions`, which the ingest runs over its scope.
 *
 * What a collision costs narrowed with #647, and only there. `RawIssue.owner`
 * carries the org now, so what JOINS an issue to a repo keys on `owner/repo`
 * and is unaffected; this key stays the DISPLAY value and the `?repo=` filter
 * value, and those still fold.
 */
export function shortRepoKey(full: string): string {
  return (full.split('/')[1] ?? full).replace(/\.example\.com$/, '');
}

/**
 * How many announced collision keys `ReportedCollisions` remembers before it
 * drops the oldest. A bound, not a policy: the number of colliding keys in any
 * scope is a handful, and a dropped key is simply announced once more on the
 * next refresh that still sees it (#1450).
 */
const REPORTED_COLLISIONS_MAX = 256;

/**
 * The keys this process has already announced a collision for, bounded so a
 * process that keeps meeting new colliding keys cannot grow without a limit.
 * The oldest key is dropped first, and a dropped key costs only that its
 * collision is announced once more when it reappears (#1450).
 */
export class ReportedCollisions {
  private readonly keys = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly max = REPORTED_COLLISIONS_MAX) {}
  has(key: string): boolean { return this.keys.has(key); }
  add(key: string): void {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.order.push(key);
    if (this.order.length > this.max) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.keys.delete(oldest);
    }
  }
}

/** What `reportRepoKeyCollisions` needs of the set it records announcements
 *  in, so a spec can pass a plain `Set` and the source a bounded one. */
interface AnnouncedCollisions {
  has(key: string): boolean;
  add(key: string): void;
}

/**
 * Announce every short key that more than one repo in scope claims, at most
 * once per process per key until the bound drops it (#484, #1450). One message
 * per key, ordered by key, naming the key and each repo behind it. A collision
 * that repeats on every ingest refresh is an expected state, not an error, so
 * it is logged at warn once per key; `reported` is the set of keys this process
 * has already announced, which the source keeps bounded for its whole life and
 * a spec passes its own to read the announcements back.
 *
 * It was silent for one org — no pair among `acme`'s repos collides, which
 * is why the trap in `shortRepoKey` never showed itself. A SECOND org fires it on
 * real repositories: two orgs may each own a `design-system`, and neither is a
 * naming mistake anybody can fix. So the message names the claimants and says
 * what folds, rather than reading as a clash inside one org.
 *
 * Reported rather than thrown, on purpose: a fold must not blank the whole
 * board, so the ingest runs on and what it costs goes on the record instead of
 * hiding inside a filter.
 *
 * Keys are compared case-folded even though `shortRepoKey` keeps their case: the
 * viewer's `repoKey` lowercases before it filters, so `Board.example.com` and
 * `board` collapse together on the `?repo=` filter even where the ingest keys
 * stay apart. Same trap, so it earns the same report.
 */
export function reportRepoKeyCollisions(
  fulls: string[],
  logger: { warn(message: string): void },
  reported: AnnouncedCollisions,
): void {
  const claimants = new Map<string, string[]>();
  for (const full of new Set(fulls)) {
    const key = shortRepoKey(full).toLowerCase();
    const seen = claimants.get(key);
    if (seen) seen.push(full);
    else claimants.set(key, [full]);
  }

  for (const [key, repos] of [...claimants].sort(([a], [b]) => a.localeCompare(b))) {
    if (repos.length < 2 || reported.has(key)) continue;
    reported.add(key);
    logger.warn(
      `Short repo key collision on '${key}': ${[...repos].sort().join(', ')} — ` +
        'they fold to one display key, so a `?repo=` filter on it shows both queues ' +
        'rather than either one (#484). Counts are keyed on owner and repo together ' +
        'and are not folded (#647).',
    );
  }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order
 *  in the result. A worker-pool drain: each of `limit` workers pulls the next
 *  index until the list is exhausted. `fn` is expected not to throw (fetchRepo
 *  swallows its own errors); an unexpected throw rejects the whole batch. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Fold `FEEDBACK_REPO` into a resolved repo list, at most once (#516).
 *
 * The submission index the Projects and relations surfaces read is only as good
 * as the ingest's coverage of that one repo, so a scope that leaves it out
 * would make the index permanently null and blank the board's own titles for
 * exactly the tokens meant to read them.
 *
 * The comparison is case-folded, and that is the whole trap. Org enumeration
 * already yields `acme/board` in production, so a plain append
 * would page that repo twice and emit every board issue twice into the shared
 * cache — doubling the open counts, the throughput windows, the aging tile, both
 * queues and the palette index. A plain `Set` catches the exact match and misses
 * `FEEDBACK_REPO=Acme/board`, which validates clean and is the
 * casing drift `feedbackScopeFrom` already folds for. Compare folded, keep the
 * enumerated spelling.
 *
 * An EMPTY list is left alone, and still must be. Empty means nothing was in
 * scope to begin with: no org and no pins are configured, or no configured org
 * holds a repo that survives the filter.
 *
 * A failed enumeration CAN arrive here, and since #647 that is deliberate: one
 * org failing while another returns real repos must still ingest, and those
 * repos reach this function like any others. `orgRepos` still throws, but per
 * ORG, and `resolveScope` catches it.
 *
 * What cannot arrive is an EMPTY list with a failure behind it, and that is the
 * only condition the early return below needs. The rule that replaced the
 * unconditional throw is exactly it: a scope resolving EMPTY with any org
 * unreadable dies in `resolveScope`.
 *
 * That is why appending to an empty list stays wrong. Adding the feedback repo
 * to a scope that resolved to nothing produces a board-repo-only dataset that
 * fetches successfully and is served as though it were org-wide — every count,
 * throughput window and aging figure silently wrong, and no error anywhere. An
 * empty result is at least visibly empty, and a failure is visibly a failure.
 */
export function withFeedbackRepo(repos: string[], feedbackRepo: string): string[] {
  if (repos.length === 0) return repos;
  const folded = feedbackRepo.toLowerCase();
  return repos.some((r) => r.toLowerCase() === folded) ? repos : [...repos, feedbackRepo];
}

// How many repos to page at once. The org-wide set is ~70 repos (#257); firing
// all of them at GitHub at once risks secondary-rate-limit throttling and a big
// memory spike, while serial pagination makes the cold-cache caller wait for the
// sum of every repo. A small pool is the middle ground.
const FETCH_CONCURRENCY = 8;

/**
 * How one repo's issues were obtained, whoever answered. `error` is carried
 * only by a Github read that failed, and is what lets `listIssues` tell a scope
 * lost to quota from any other (#1046); a repo answered from the webhook store
 * or kept from the last read never fails, so it never sets one.
 */
type RepoRead = { ok: boolean; issues: RawIssue[]; error?: unknown };

/**
 * The code on the one 503 a browser's saved Overview copy may answer (#1046):
 * the ingest lost its whole scope, and every failure behind that was Github
 * refusing on quota, which lifts on its own within the hour. It travels in the
 * body the way `PROJECTS_NOT_NOW_CODE` does, and for the same reason: board-api
 * answers 503 for things a copy must not be drawn over, the expiry interceptor
 * and the Github principal guard among them, so the status alone says nothing.
 *
 * Its own name rather than the Projects one, because it is a different verdict
 * reached by a different test. The Projects rollup reads GraphQL and asks
 * `servableRefusal`, which also passes Github's 408, 429 and 5xx. This ingest
 * reads REST and asks `quotaRetryAt`, the test `logGithubFailure` already logs a
 * quota refusal by, which passes a quota refusal and nothing else. A REST rate
 * limit arrives as a 403, which `servableRefusal` reads as "not you". One name
 * would say one test decided both, and a browser matching it on the wrong read
 * would accept a verdict that read's server never reached.
 *
 * Must match `ISSUES_NOT_NOW_CODE` in board-frontend's `team/overview-saved.ts`.
 */
export const ISSUES_NOT_NOW_CODE = 'issues_not_now';

/**
 * The coded 503 for a scope lost to quota alone, or null when any failure
 * behind it was something else, which stays the plain error it always was and
 * reaches the browser as a 500.
 *
 * The message names no org and repeats nothing Github said: the refusal is
 * about the token's budget, not about an org, and "check GitHub credentials /
 * access" is the wrong advice for it.
 */
function quotaRefusal(failures: readonly unknown[]): ServiceUnavailableException | null {
  const until = failures.map((e) => quotaRetryAt(e));
  if (until.length === 0 || until.some((at) => at === undefined)) return null;
  const lifts = new Date(Math.max(...(until as number[]))).toISOString();
  return new ServiceUnavailableException(
    { message: `issue metrics: GitHub quota is cooling down until ${lifts}`, code: ISSUES_NOT_NOW_CODE },
    { cause: failures[0] },
  );
}

/**
 * Live issue source (#120, #257) — pages each in-scope repo's Issues API (open +
 * closed, PRs excluded) and normalises to RawIssue.
 *
 * Scope: every non-archived, non-fork repo with issues in EVERY owner the
 * caller can read is enumerated (`githubOrgs` in `config/github-orgs.ts`
 * answers which), so the metrics are org-wide (throughput/aging/load span every
 * repo the team works in, not just board + the product repo — #257). An explicit
 * `ISSUES_METRICS_REPOS` list used to win over the walk, and it is retired
 * (#1209 part 4) — it narrowed a person to a list an operator chose, which is
 * the ceiling that lane removes.
 *
 * Three failures, three answers. A per-repo failure is logged and skipped, so one
 * unreachable repo never blanks the surface. ONE org's enumeration failing is
 * recorded against that org and the ingest runs on, because the orgs that
 * answered still carry real work (#647). Losing the scope ENTIRELY — every org
 * failing, or an empty scope with any org unreadable — is thrown (#528), because
 * a board drawn without it is a board where nobody has any work.
 */
@Injectable()
export class GithubIssuesSource implements IIssuesSource {
  private readonly principalState = new PrincipalState(() => ({
    outcomes: [] as OrgReadOutcome[],
    repoReads: [] as RepoReadOutcome[]
  }), true);
  private readonly logger = new Logger(GithubIssuesSource.name);
  /** Short keys this process has already announced a collision for, bounded
   *  so the report is once per key until the bound drops the oldest (#484,
   *  #1450). */
  private readonly reportedCollisions = new ReportedCollisions();
  /** Owners to enumerate, in discovery order for a person and configured order
   *  for the no-person path. */
  private get orgs(): string[] { return githubOrgs(this.config); }
  /** How the last run's enumeration went, per org — see `orgOutcomes`. */
  private get outcomes(): OrgReadOutcome[] { return this.principalState.current.outcomes; }
  private set outcomes(value: OrgReadOutcome[]) { this.principalState.current.outcomes = value; }
  /** How the last run's per-repo fetch went — see `repoOutcomes` (#837). */
  private get repoReads(): RepoReadOutcome[] { return this.principalState.current.repoReads; }
  private set repoReads(value: RepoReadOutcome[]) { this.principalState.current.repoReads = value; }
  /** `owner/name` of the repo the old feedback form filed into — always in scope, so
   *  the submission marker has a row for every submission (#516). */
  private readonly feedbackScope: ReturnType<typeof feedbackScopeFrom>;
  private get feedbackRepo(): string { return `${this.feedbackScope.owner}/${this.feedbackScope.repo}`; }

  constructor(
    private readonly config: ConfigService,
    // The webhook store (#1007, V5), or null while it is off. The module's
    // factory builds this class with an explicit `new`; the decorators keep an
    // ordinary construction from crashing the compiled boot.
    @Optional() @Inject(ISSUE_STORE) private readonly store: IssueStore | null = null,
    @Optional() @Inject(IssueStoreHealth) private readonly storeHealth?: IssueStoreHealth,
  ) {
    // Through the one parser, so this can never drift from what the words rule
    // and the write path read.
    const scope = feedbackScopeFrom(this.config);
    this.feedbackScope = scope;
  }

  async listIssues(options: ListIssuesOptions = {}): Promise<RawIssue[]> {
    const octokit = buildOctokitClient(this.config);
    const { repos: resolved, byOrg, ids } = await this.resolveScope(octokit);
    const person = githubPrincipal();
    const repos = !person || person.repositories.some((r) => r.full_name.toLowerCase() === this.feedbackRepo.toLowerCase()) ? withFeedbackRepo(resolved, this.feedbackRepo) : resolved;

    // Check the resolved scope before anything is keyed by a short key (#484).
    // This is the widest scope in the service — the Repos map reads the same
    // config and can only ever narrow it further (a pinned repo it drops for
    // being archived, say) — so a collision anywhere downstream is a collision
    // here, and reporting it once, here, covers every surface keyed on it.
    reportRepoKeyCollisions(repos, this.logger, this.reportedCollisions);

    // The webhook store answers first, for exactly the repos in this scope that
    // it may answer for now (#1007, V5), and every other repo is paged from
    // Github as before. It is asked only about ids `resolveScope` took from the
    // person's own repository list, so it can never widen what a person sees.
    // A reconcile reads everything from Github and still asks, because the
    // answer also says which owners' repos are worth a baseline.
    const kept = options.reuse ? keptFrom(options.reuse, repos) : null;
    const changed = options.reuse?.changedRepos ? new Set(options.reuse.changedRepos.map((r) => r.toLowerCase())) : null;
    // Unchanged repositories need no store query. Missing or ambiguous cached
    // rows still take the ordinary read so scope changes cannot hide data.
    const targets = repos.filter((full) => !changed || changed.has(full.toLowerCase()) || !kept?.has(full.toLowerCase()));
    const stored = await this.readStore(targets, ids, Boolean(options.reuse) && !options.reconcile);
    if (!stored) this.storeHealth?.record(this.store ? 'unavailable' : 'off');
    // A catch-up without the store's answer would keep every old row and stamp
    // it current, dropping the delivery that asked for it until the TTL. It
    // fails instead, and the cache keeps its snapshot and tries again.
    if (options.reuse && !stored) throw new Error('the webhook store could not be read, so the refill after a delivery was not made');
    // Otherwise it keeps, from the snapshot it refreshes, the repos the store
    // was never going to answer, and pages nothing a read already paged within
    // the TTL.
    let answeredByStore = 0;
    const fromGithub: string[] = [];
    const baselines: Promise<void>[] = [];
    const served = new Set<string>();

    // Page repos through a bounded pool rather than all-at-once (#257: ~70 repos)
    // or serially (#175: caller waits for the sum). A per-repo failure resolves to
    // `ok:false` and is skipped, so one unreachable repo never blanks the surface.
    const results = await mapLimit(repos, FETCH_CONCURRENCY, (full) => {
      const held = kept?.get(full.toLowerCase());
      if (held && changed && !changed.has(full.toLowerCase())) {
        if (options.reuse?.repos.some((r) => r.full.toLowerCase() === full.toLowerCase() && r.fromStore)) served.add(full);
        return Promise.resolve(held);
      }
      const id = ids.get(full.toLowerCase());
      const rows = id === undefined || options.reconcile ? undefined : stored?.served.get(id);
      if (rows) {
        answeredByStore += 1;
        served.add(full);
        return Promise.resolve(this.fromStore(full, rows));
      }
      // A repo with an id whose owner is live, and which the store did not
      // answer, may be one the delivery itself took off the store: a tie, a
      // forget, an owner just gone live. It is read from Github, not kept.
      if (held && !changed && (id === undefined || !stored?.liveOwners.has(ownerOf(full)))) return Promise.resolve(held);
      fromGithub.push(full);
      const baseline = id !== undefined && stored?.liveOwners.has(ownerOf(full)) ? { id, full } : null;
      return this.fetchRepo(octokit, full, baseline, baselines);
    });
    // Waited for, so the read after this one finds them, but only so long: a
    // store that stalls costs this read a bounded wait and never its answer.
    await within(Promise.all(baselines), STORE_WRITE_WAIT_MS, 'the webhook store\'s baselines').catch((err: unknown) =>
      this.logger.warn(`${(err as Error).message}; they carry on in the background`),
    );
    if (stored) {
      this.storeHealth?.record('serving');
      const keptCount = repos.length - answeredByStore - fromGithub.length;
      this.logger.log(
        `issue ingest: ${answeredByStore} of ${repos.length} repos answered from the webhook store, ` +
          (kept ? `${keptCount} kept from the last read, ` : '') +
          `${fromGithub.length} read from Github${options.reconcile ? ' to reconcile it' : ''}`,
      );
    }
    // One paginated call per repo read from Github, attributed to the org that
    // owns it. A repo outside every enumerated org — `FEEDBACK_REPO` in a foreign
    // owner, a pin — is counted nowhere, because there is no org record it
    // belongs to.
    for (const full of fromGithub) {
      const owner = byOrg.get(full.split('/')[0]);
      if (owner) owner.calls += 1;
    }
    const anyOk = results.some((r) => r.ok);
    const out = results.flatMap((r) => r.issues);
    // Recorded off the SAME `results`, in the same order as `repos`, so the two
    // cannot disagree about which repo answered (#837). Written before the throw
    // below on purpose: a run where every repo failed still describes every repo.
    this.repoReads = repos.map((full, i) => ({
      full, ok: results[i].ok, id: ids.get(full.toLowerCase()), fromStore: served.has(full),
    }));

    // Distinguish "genuinely no issues" from "every fetch failed" (e.g. missing
    // or invalid GitHub creds): the latter must surface as an error, not a
    // plausible all-zero dashboard served with 200.
    //
    // `repos.length > 0` now means what it reads as. It is here to let a scope
    // that is genuinely empty through — nothing was fetched, so `anyOk` is false
    // without anything having gone wrong — and losing the scope no longer arrives
    // that way: `resolveScope` throws instead of returning [] (#528), so an outage
    // never reaches this line disguised as an empty org.
    if (repos.length > 0 && !anyOk) {
      // Unless Github refused every one on quota, which is "not now" (#1046).
      throw quotaRefusal(results.map((r) => r.error)) ?? new Error(
        'issue metrics: every repo fetch failed — check GitHub credentials / access',
      );
    }
    return out;
  }

  /**
   * How each configured org's read went on the last `listIssues()` (#647).
   *
   * Empty until a run has happened, and empty for a run with no owner in scope
   * — there is no org read to report in either case, and an invented `read`
   * would be worse than silence.
   */
  orgOutcomes(): OrgReadOutcome[] {
    return this.outcomes;
  }

  /**
   * How each repo's own issue fetch went on the last `listIssues()` (#837).
   *
   * Empty until a run has happened. A repo ABSENT from this list is not a failed
   * read — it is one this ingest never asked about, which is ordinary for a repo
   * on the map whose owner was not in scope. Only an `ok: false` says Github
   * refused, and only that may make a surface draw "could not read".
   */
  repoOutcomes(): RepoReadOutcome[] {
    return this.repoReads;
  }

  /**
   * Resolve the repos to page, and record how each org's enumeration went.
   *
   * One org failing does NOT fail the ingest: the other orgs still carry real
   * rows, and blanking them because a second org 404d would lose work that was
   * read successfully. What replaces the throw is the outcome record — the org
   * is marked `unreadable`, so a surface can say so rather than draw a zero.
   *
   * EVERY org failing is still a throw, and that is #528 unchanged. Then nothing
   * is known about the scope at all, every count downstream would be wrong with
   * nothing to say so, and a board drawn from it is a board where nobody has any
   * work. With one configured org the two cases are the same case, which is why
   * a single-org deployment behaves exactly as it did.
   */
  private async resolveScope(
    octokit: ReturnType<typeof buildOctokitClient>,
  ): Promise<{ repos: string[]; byOrg: Map<string, OrgReadOutcome>; ids: Map<string, number> }> {
    const byOrg = new Map<string, OrgReadOutcome>();
    // Github's id for each repo in scope, keyed on the folded `owner/name`: the
    // only key the webhook store answers on (#1007, V5). A person's come from
    // their own repository list, the deployment's from its org listing, and a
    // repo with no id here, a pin on the deployment path say, is read from Github.
    const ids = new Map<string, number>();
    const person = githubPrincipal();
    for (const r of person?.repositories ?? []) ids.set(r.full_name.toLowerCase(), r.id);

    const repos: string[] = [];
    const failures: Error[] = [];
    for (const org of this.orgs) {
      // The enumeration itself, counted before it can fail: a call that 404s
      // still spent a request.
      const outcome: OrgReadOutcome = { org, state: 'read', reason: null, calls: 1 };
      byOrg.set(org, outcome);
      try {
        repos.push(...(await this.orgRepos(octokit, org, ids)));
      } catch (err) {
        outcome.state = 'unreadable';
        outcome.reason = (err as Error).message;
        failures.push(err as Error);
        // A quota refusal is a warning that says when, not a boot alert (#986).
        logGithubFailure(this.logger, err, (err as Error).message, `repo list for ${org} deferred`);
      }
    }
    this.outcomes = [...byOrg.values()];

    // An empty scope is honest only when NOTHING failed. Anything downstream
    // that could have caught this cannot: `withFeedbackRepo` leaves an empty
    // list alone, and the "every repo fetch failed" guard needs a repo to have
    // been fetched. So an empty scope with a failure in it dies here, carrying
    // every reason — one org answering with no ingestable repo must never
    // launder another org's outage into a board where nobody has any work.
    if (failures.length > 0 && repos.length === 0) {
      // A quota refusal on every org is "not now", coded for the browser (#1046).
      throw quotaRefusal(failures) ?? new Error(failures.map((e) => e.message).join('; '), { cause: failures[0] });
    }
    return { repos, byOrg, ids };
  }

  /**
   * Enumerate the org's ingestable repos: non-archived, non-fork, issues on.
   * Returns `owner/name` full keys.
   *
   * THROWS when the enumeration itself fails, and that is the contract (#528).
   * It used to log and return [], which put a fetch that failed and an org that
   * is genuinely empty into the same value — and since the "every repo fetch
   * failed" guard only fires on a non-empty scope, an outage here resolved as no
   * issues at all and drew a board on which nobody has any work.
   *
   * A failure cannot be a return value here, because this function has nothing
   * to say about the scope beyond its own org: an empty array from it is
   * indistinguishable from an org that holds no ingestable repo. Throwing is what
   * makes that unignorable — a caller can forget to check a value, but not an
   * exception. The original error travels as `cause`.
   *
   * What the throw MEANS is now the caller's to decide, which is the #647 change:
   * `resolveScope` catches it per org and records the org unreadable with its
   * reason. When the scope as a whole came to nothing it throws a NEW error
   * joining every per-org message, carrying the first as `cause` — not this one
   * re-raised, because with several orgs there may be several. So an
   * empty result HERE is never a fault — this org holds no repo that survives the
   * filter — and it is no longer the last word on whether the board has a scope.
   */
  private async orgRepos(
    octokit: ReturnType<typeof buildOctokitClient>,
    org: string,
    ids: Map<string, number>,
  ): Promise<string[]> {
    const person = githubPrincipal();
    if (person) return person.repositories.filter((r) => r.owner.login.toLowerCase() === org.toLowerCase() && !r.archived && !r.fork && r.has_issues).map((r) => r.full_name);
    try {
      const repos = await octokit.paginate(octokit.repos.listForOrg, {
        org,
        type: 'all',
        per_page: 100,
      });
      return repos
        .filter((r) => !r.archived && !r.fork && r.has_issues)
        .map((r) => {
          ids.set(`${org}/${r.name}`.toLowerCase(), r.id);
          return `${org}/${r.name}`;
        });
    } catch (err) {
      throw new Error(
        `issue metrics: the repo list for ${org} could not be read ` +
          `(${(err as Error).message}) — check GitHub credentials / access`,
        { cause: err },
      );
    }
  }

  /**
   * Page one repo's issues (PRs excluded) → RawIssue[]. Never throws; a failure
   * is logged and reported as `{ ok: false, error }` so callers can skip it, and
   * `listIssues` can tell a scope lost to quota from any other (#1046).
   *
   * When `baseline` names the repo, what was read is also written to the
   * webhook store as the repo's baseline (#1007, V5), which is what lets the
   * next read of it come from the store. The write joins `baselines` rather
   * than holding up the next repo, and a store that refuses it costs a log line
   * and never the read.
   */
  private async fetchRepo(
    octokit: ReturnType<typeof buildOctokitClient>,
    full: string,
    baseline: StoreRepo | null,
    baselines: Promise<void>[],
  ): Promise<RepoRead> {
    const [owner, repo] = full.split('/');
    const key = shortRepoKey(full);
    // Before the first page is asked for, so a delivery that lands while the
    // pages are read is newer than the baseline and survives it.
    const startedAt = Date.now();
    try {
      const listed = await octokit.paginate(octokit.issues.listForRepo, {
        owner,
        repo,
        state: 'all',
        per_page: 100,
      });
      // The Issues API lists PRs too.
      const issues = listed.filter((i) => !i.pull_request).map((i) => storedIssueOf(i));
      this.reportUnknownReasons(full, issues);
      if (baseline && this.store) {
        baselines.push(this.store.baseline(baseline, issues, startedAt).catch((err: unknown) =>
          this.logger.warn(
            `the webhook store could not take ${full}'s baseline, so its next read goes to Github too: ${(err as Error).message}`,
          ),
        ));
      }
      return { ok: true, issues: issues.map((s) => rawIssueOf(owner, key, s)) };
    } catch (err) {
      this.logger.warn(`Issue list failed for ${full}: ${(err as Error).message}`);
      return { ok: false, issues: [], error: err };
    }
  }

  /** One repo answered from the webhook store: the same `RawIssue`s a Github
   *  read of it would have produced, through the same mapper. */
  private fromStore(full: string, rows: StoredIssue[]): RepoRead {
    this.reportUnknownReasons(full, rows);
    const [owner] = full.split('/');
    return { ok: true, issues: rows.map((s) => rawIssueOf(owner, shortRepoKey(full), s)) };
  }

  /**
   * Ask the webhook store about the repos in scope that have an id, or answer
   * null when there is no store or it cannot be read. Null reads every repo from
   * Github and writes no baseline, which is exactly the board before V5, so a
   * store that is down costs requests and never an answer.
   */
  private async readStore(repos: string[], ids: Map<string, number>, catchUp: boolean): Promise<StoreRead | null> {
    if (!this.store) return null;
    const targets = repos.flatMap((full) => {
      const id = ids.get(full.toLowerCase());
      return id === undefined ? [] : [{ id, full }];
    });
    try {
      const read = this.store.read(targets, undefined, catchUp ? undefined : 2_000);
      return await (catchUp ? read : within(read, 3_000, 'the webhook store read'));
    } catch (err) {
      this.logger.warn(`the webhook store could not be read, so this read takes nothing from it: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Reasons Github sent that this build does not recognise, gathered per repo
   * and logged ONCE rather than per row (#1014). A new `state_reason` counts as
   * delivery until somebody decides otherwise, so this line is the only thing
   * that says a decision is waiting. An unrecognised value is logged rather than
   * folded into either answer: a number the board chose not to count should be
   * visible from the outside, and so should a reason it could not classify.
   */
  private reportUnknownReasons(full: string, issues: StoredIssue[]): void {
    const unknown = new Set(issues.map((i) => i.stateReason).filter((r): r is string => unknownCloseReason(r)));
    if (unknown.size === 0) return;
    this.logger.warn(
      `Unrecognised issue close reason${unknown.size === 1 ? '' : 's'} in ${full}: ` +
        `${[...unknown].sort().join(', ')} — counted as delivered until close-reason.ts names them`,
    );
  }
}

/** The owner half of `owner/name`, folded the way the store keys owners. */
function ownerOf(full: string): string {
  return (full.split('/')[0] ?? '').toLowerCase();
}

const STORE_WRITE_WAIT_MS = 5_000;

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * What a catch-up may keep from the snapshot it refreshes (#1007, V5): each
 * repo's rows as that read left them, by folded `owner/name`, for the repos it
 * read. A repo it failed on is left out, and paged again. So is a repo whose
 * short key another repo shares under the same owner, in this scope or in that
 * snapshot's: a row carries its owner and short key, not its full name, so the
 * two cannot be told apart.
 */
function keptFrom(
  reuse: NonNullable<ListIssuesOptions['reuse']>,
  repos: string[],
): Map<string, RepoRead> {
  const joinKey = (owner: string, key: string) => `${owner.toLowerCase()}/${key}`;
  const keyOf = (full: string) => joinKey(full.split('/')[0] ?? '', shortRepoKey(full));
  const sharing = new Map<string, number>();
  const counted = new Set<string>();
  for (const full of [...repos, ...reuse.repos.map((r) => r.full)]) {
    if (counted.has(full.toLowerCase())) continue;
    counted.add(full.toLowerCase());
    sharing.set(keyOf(full), (sharing.get(keyOf(full)) ?? 0) + 1);
  }
  const rows = new Map<string, RawIssue[]>();
  for (const issue of reuse.issues) {
    const key = joinKey(issue.owner, issue.repo);
    const list = rows.get(key);
    if (list) list.push(issue);
    else rows.set(key, [issue]);
  }
  const kept = new Map<string, RepoRead>();
  for (const outcome of reuse.repos) {
    const key = keyOf(outcome.full);
    if (!outcome.ok || (sharing.get(key) ?? 0) > 1) continue;
    kept.set(outcome.full.toLowerCase(), { ok: true, issues: rows.get(key) ?? [] });
  }
  return kept;
}
