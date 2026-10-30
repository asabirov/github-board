import { githubPrincipal, PrincipalState } from '../auth/github-principal';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { feedbackScopeFrom, originFromHtmlUrl } from '../auth/feedback-visibility';
import type { StaleOnWrite } from '../freshness/stale-on-write';
import { IssueStoreSignal } from '../github-store/issue-store';
import type { OrgReadOutcome, RepoReadOutcome } from './github-issues.source';
import { IIssuesSource, ISSUES_SOURCE, RawIssue } from './issues-metrics.types';

export type { OrgReadOutcome, RepoReadOutcome };

/**
 * A source that can say how each configured org's read went (#647).
 *
 * Optional, and read structurally rather than declared on `IIssuesSource`: the
 * fixture source has no orgs to report, and a required method would have it
 * answer a question it cannot answer. A source that does not implement this
 * claims NO orgs — never a `read` one, because an invented `read` is the exact
 * reassurance an unreadable org must not produce.
 */
export interface OrgReportingSource {
  orgOutcomes(): OrgReadOutcome[];
}

/**
 * A source that can say how each REPO's own fetch went (#837).
 *
 * Optional and read structurally, for the same reason `OrgReportingSource` is:
 * the fixture source fetches nothing and would be answering a question it cannot
 * answer. A source that does not implement this claims NO repos — never an
 * `ok: false`, because an invented failure would put "could not read" on a page
 * that read perfectly well.
 */
export interface RepoReportingSource {
  repoOutcomes(): RepoReadOutcome[];
}

/** One cached scan: the union every surface reads, and which orgs it covers. */
interface IssuesSnapshot {
  at: number;
  /** The webhook store's signal when this read began (#1007, V5). A delivery
   *  that changed the store moves the signal past it, and the snapshot is then
   *  refilled at its next read however young it is. */
  generation: number;
  issues: RawIssue[];
  /** Per configured org, how its read went. The union above CANNOT carry this —
   *  an org whose enumeration failed contributes no rows and is indistinguishable
   *  inside the list from an org that is genuinely quiet — and the two must never
   *  draw the same. Empty when the source cannot say. */
  orgs: OrgReadOutcome[];
  /** Per repo the ingest asked about, whether its own fetch answered (#837).
   *  The same argument as `orgs` one level down: `fetchRepo` swallows a per-repo
   *  failure so the run survives it, which leaves that repo contributing no rows
   *  and looking, inside the union, exactly like a repo with nothing open. The
   *  Repo page draws one repo's whole queue, so it is the surface where the two
   *  must not read the same. Empty when the source cannot say. */
  repos: RepoReadOutcome[];
  /** Distinguishes an empty live scan from a fixture with no reporting API. */
  coverageReported: boolean;
  repoCoverageReported: boolean;
}

/**
 * Which issues carry the board feedback form's footer, for the two surfaces that
 * fetch no body of their own (#516) — the Projects rollup's recency line and the
 * issue page's relations.
 *
 * THREE-valued, and the third value is the whole point:
 *  - `true` — an indexed row for this issue, and it carries the footer.
 *  - `false` — an indexed row for this issue, and it does not.
 *  - `null` — NO ROW for this issue, for any reason: it is newer than the cache,
 *    its repo was not fetched, or its Github URL did not parse.
 *
 * `null` must not be read as a falsy `false`. `false` is an authoritative "not a
 * submission" that lets the label rule decide; `null` is "we could not tell",
 * and the words rule withholds on it. Collapsing the two reproduces #516 one
 * level up: a submission filed at 14:00 and relabelled at 14:03, against a cache
 * last refreshed at 13:58, would hand the submitter's sentence over at 14:05.
 */
export interface SubmissionIndex {
  lookup(owner: string, repo: string, number: number): boolean | null;
}

const keyOf = (owner: string, repo: string, number: number): string =>
  `${owner}/${repo}#${number}`.toLowerCase();

/**
 * Build the index from a cached issue list, or answer `null` when it cannot
 * cover the one repo that matters.
 *
 * An empty index is NEVER covered. A cache that resolves but holds no row from
 * `FEEDBACK_REPO` returns `null`, not an index that answers `false` to
 * everything — that shape is `projects.service.ts`'s `catch → []`, which is
 * right for a weekly-close join and fail-OPEN here: it would hand over every
 * title in the feedback repo while looking like a working control.
 *
 * Keys are parsed from each row's Github URL rather than composed from
 * `RawIssue.repo`; see `originFromHtmlUrl` for why. A row whose URL does not
 * parse is simply not indexed, so it looks up as `null` — withheld.
 */
export function buildSubmissionIndex(issues: RawIssue[], feedbackRepo: string): SubmissionIndex | null {
  const rows = new Map<string, boolean>();
  const folded = feedbackRepo.toLowerCase();
  let covered = false;
  for (const issue of issues) {
    const origin = originFromHtmlUrl(issue.htmlUrl);
    if (!origin) continue;
    rows.set(keyOf(origin.owner, origin.repo, issue.number), issue.submission);
    if (`${origin.owner}/${origin.repo}`.toLowerCase() === folded) covered = true;
  }
  if (!covered) return null;
  return { lookup: (owner, repo, number) => rows.get(keyOf(owner, repo, number)) ?? null };
}

/** How stale a covered index may get before it says so. Stale-while-revalidate
 *  hides a failing refresh behind a served cache, and the window a relabelled
 *  submission stays readable through the two body-less surfaces is bounded by
 *  one TTL only while refreshes succeed — past that it is unbounded, and silent. */
const STALE_INDEX_TTLS = 3;

/** How long a read waits for the refill a webhook delivery asked for before it
 *  takes the snapshot it already had (#1007, V5). A refill the store answers
 *  whole is one query, far under this. */
const CATCH_UP_WAIT_MS = 2_000;

/**
 * Owns the raw-issues cache — the single org-wide issue scan shared by the
 * metrics surface (IssuesMetricsService) and the Projects rollup
 * (ProjectsService, #391). Both read through `getIssues()`, so the heavy
 * ~70-repo paging fetch runs once per TTL for the whole app, not once per
 * consumer. This is a leaf service: it imports nothing from metrics/projects,
 * so both of those modules can import it without a cycle.
 *
 * The list is served **stale-while-revalidate** (#175): a fresh cache is
 * returned directly; a stale cache is returned immediately while a single
 * background refresh runs, so no user request ever pays the cold fetch except
 * the very first one (which the boot-time warm usually absorbs).
 */
@Injectable()
export class IssuesCacheService implements OnModuleInit, StaleOnWrite {
  private readonly principalState = new PrincipalState(() => ({
    cache: null as IssuesSnapshot | null,
    inFlight: null as Promise<IssuesSnapshot> | null,
    reconciling: false as boolean,
    epoch: 0 as number,
    lastGood: null as IssuesSnapshot | null,
    indexed: null as { of: IssuesSnapshot; index: SubmissionIndex | null } | null,
    warnedUncovered: false as boolean,
    warnedStale: false as boolean,
    caughtUpTo: 0 as number
  }), true);
  private readonly logger = new Logger(IssuesCacheService.name);
  private get cache(): IssuesSnapshot | null { return this.principalState.current.cache; }
  private set cache(value: IssuesSnapshot | null) { this.principalState.current.cache = value; }
  /** Dedupes concurrent refreshes (background + cold + boot warm). */
  private get inFlight(): Promise<IssuesSnapshot> | null { return this.principalState.current.inFlight; }
  private set inFlight(value: Promise<IssuesSnapshot> | null) { this.principalState.current.inFlight = value; }
  /** Whether the read in flight is a reconcile, which a later reconcile can
   *  join. An ordinary read may be answered by the webhook store, so a "Sync
   *  now" pressed during one starts its own (#1007, V5). */
  private get reconciling(): boolean { return this.principalState.current.reconciling; }
  private set reconciling(value: boolean) { this.principalState.current.reconciling = value; }
  /** Moves on every drop, so an ingest that went out before one cannot write
   *  what it read into the cache when it lands (#692), and when a reconcile
   *  overtakes an ordinary read, for the same reason (#1007, V5). */
  private get epoch(): number { return this.principalState.current.epoch; }
  private set epoch(value: number) { this.principalState.current.epoch = value; }
  /** The last snapshot this served, RETIRED by a drop rather than deleted
   *  (#692). It is served only when the read that replaces it fails — see
   *  `getIssues` — and it is what `lastIngestOrgs()` falls back to, because the
   *  orgs a run covered describe org health and no close can change them. */
  private get lastGood(): IssuesSnapshot | null { return this.principalState.current.lastGood; }
  private set lastGood(value: IssuesSnapshot | null) { this.principalState.current.lastGood = value; }
  private readonly ttlMs: number;
  /** `owner/name` of the repo the old feedback form filed into — the one repo the
   *  submission index has to cover to be worth anything (#516). */
  private readonly feedbackScope: ReturnType<typeof feedbackScopeFrom>;
  private get feedbackRepo(): string { return `${this.feedbackScope.owner}/${this.feedbackScope.repo}`; }
  /** The index built from this cache snapshot, so a read that hits the same
   *  snapshot does not rebuild the map. */
  private get indexed(): { of: IssuesSnapshot; index: SubmissionIndex | null } | null { return this.principalState.current.indexed; }
  private set indexed(value: { of: IssuesSnapshot; index: SubmissionIndex | null } | null) { this.principalState.current.indexed = value; }
  /** Latches, so the two warnings below announce a state change rather than
   *  repeating on every request — and announce it again if it recovers and
   *  returns. */
  private get warnedUncovered(): boolean { return this.principalState.current.warnedUncovered; }
  private set warnedUncovered(value: boolean) { this.principalState.current.warnedUncovered = value; }
  private get warnedStale(): boolean { return this.principalState.current.warnedStale; }
  private set warnedStale(value: boolean) { this.principalState.current.warnedStale = value; }
  /** Highest generation attempted by a catch-up. A failed refresh is retried
   * only after another relevant delivery or the ordinary TTL, not per request. */
  private get caughtUpTo(): number { return this.principalState.current.caughtUpTo; }
  private set caughtUpTo(value: number) { this.principalState.current.caughtUpTo = value; }

  constructor(
    // Explicit token via the module factory (tsx/esbuild emit no param metadata,
    // so an undecorated param would crash the compiled boot — see the DI note).
    @Inject(ISSUES_SOURCE) private readonly source: IIssuesSource,
    @Inject(ConfigService) private readonly config: ConfigService,
    // Moves when a webhook delivery changes the store (#1007, V5). Absent when
    // the store is off, and then nothing below reads it.
    @Optional() @Inject(IssueStoreSignal) private readonly signal?: IssueStoreSignal,
  ) {
    this.ttlMs = config.get<number>('ISSUES_METRICS_CACHE_TTL_MS', 600_000);
    // Through the one parser, so this can never drift from what the words rule
    // and the write path read.
    const scope = feedbackScopeFrom(config);
    this.feedbackScope = scope;
  }

  /** Warm the cache at boot so the first visitor never eats the cold fetch. */
  onModuleInit(): void {
    // The store signal exists only when the shared webhook store is on.
    // This ingest refreshes its baselines for signed-in readers too.
    if (!this.config.get<boolean>('AUTH_DISABLED', false) && !this.signal) return;
    this.refresh(Date.now()).catch((err) =>
      this.logger.warn(`initial issues warm failed: ${(err as Error).message}`),
    );
  }

  /** When the snapshot this is serving was read (#1169). The ingest's own
   *  `at`, which is the number every surface joined against it already
   *  reports as its freshness. Null before the boot warm lands and after a
   *  drop, and never filled by asking: see `ReportsFreshness`. */
  lastSyncedAt(): string | null {
    const held = this.cache;
    return held ? new Date(held.at).toISOString() : null;
  }

  /** Force a fresh pull from the source, replacing the cache (#301, "sync now").
   *  Awaits the fetch so the cache is warm — and every surface reading through it
   *  is current — by the time this resolves. It reads Github for every repo,
   *  never the webhook store, and that read is the store's catch-up: each repo
   *  read becomes its new baseline (#1007, V5). */
  async resync(): Promise<void> {
    await this.refresh(Date.now(), { reconcile: true });
  }

  /** Outcome from the same raw ingest, including partial org/repo coverage. */
  async resyncWithOutcome(): Promise<'succeeded' | 'degraded'> {
    const snapshot = await this.refresh(Date.now(), { reconcile: true });
    return snapshot.orgs.some((org) => org.state === 'unreadable') || snapshot.repos.some((repo) => !repo.ok)
      ? 'degraded' : 'succeeded';
  }

  /** Declare the ingest out of date (#692) — see `StaleOnWrite`. This is the
   *  org-wide list every issue-derived number is joined against, so a close the
   *  board did is wrong in the metrics, the Projects pulse and the submission
   *  marker until this goes. The built index goes with it: it is derived from a
   *  snapshot that no longer exists. */
  dropCaches(): void {
    // RETIRED, not deleted. A drop is followed by a cold read, and a cold read
    // against a rate-limited Github used to answer 500 on five endpoints that
    // would have served a stale number a moment earlier. This copy is what they
    // fall back to, and only when that read FAILS.
    this.lastGood = this.cache ?? this.lastGood;
    this.cache = null;
    this.inFlight = null;
    this.reconciling = false;
    this.indexed = null;
    this.epoch++;
  }

  /** Re-fill after a write, in the background (#692) — see `StaleOnWrite`. This
   *  one is warmed because of what it reads against: core REST, 5000 an hour,
   *  strongly consistent, and the slowest read the board makes. Every issue-derived
   *  number joins against it, so leaving it cold charges the whole ~70-repo scan
   *  to whoever opens a dashboard next. It is the same refill "Sync now" runs;
   *  the difference is only that nobody waits for this one. */
  warmAfterWrite(): Promise<void> {
    return this.resync();
  }

  /**
   * The cached raw-issues list, served fresh / stale-while-revalidate / cold.
   * A fresh cache returns directly; a stale cache returns immediately while a
   * single background refresh runs; a cold read (no cache yet) awaits the fetch
   * once and propagates a failure as an error.
   */
  async getIssues(now = Date.now()): Promise<IssuesSnapshot> {
    // Fresh: serve directly, unless a webhook delivery has changed the store
    // since this snapshot was read (#1007, V5).
    if (this.cache && now - this.cache.at < this.ttlMs) {
      const signal = this.signal;
      // Behind a delivery, and this delivery has not had its one try yet.
      const behind = signal && this.cache.repos.some((repo) =>
        signal.generationFor(repo) > Math.max(this.cache!.generation, this.caughtUpTo));
      return behind ? this.catchUp(now, this.cache) : this.cache;
    }
    // Stale: serve the old data now, refresh in the background (SWR) — no user waits.
    if (this.cache) {
      this.refresh(now).catch((err) =>
        this.logger.warn(`background issues refresh failed: ${(err as Error).message}`),
      );
      return this.cache;
    }
    // Cold: must wait once, and the wait is the point — the answer this returns
    // is the source's, never the retired one. Only a FAILED read reaches back
    // for what a drop retired (#692); a boot with nothing retired propagates as
    // it always did.
    return this.refresh(now).catch((err: unknown) => this.retired(err));
  }

  /**
   * A young snapshot the webhook store has moved past (#1007, V5). The refill
   * reads the changed repositories and keeps the others from `held`, so it usually pages nothing
   * from Github and is waited for, up to `CATCH_UP_WAIT_MS`: a change Github
   * reported shows on the first read after it arrives rather than a TTL later.
   * A refill that takes longer carries on in the background and this read gets
   * the snapshot it held. So does a refill that fails, which says so and leaves
   * the cache as it was. With a read already in flight, a sync say, this read
   * gets the held snapshot at once: that read lands in the cache anyway, and a
   * delivery it began before is caught up on at the read after it.
   */
  private catchUp(now: number, held: IssuesSnapshot): Promise<IssuesSnapshot> {
    if (this.inFlight) return Promise.resolve(held);
    // Before the read, and whatever the read does: what this records is that
    // the try was spent, so a failure costs one read of the scope and not one
    // per request until the TTL (#1070, S3).
    this.caughtUpTo = this.signal?.generation ?? 0;
    const read = this.refresh(now, { reuse: held }).catch((err: unknown) => {
      this.logger.warn(`issues refill after a webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`);
      return held;
    });
    const wait = new Promise<IssuesSnapshot>((resolve) => {
      setTimeout(() => resolve(held), CATCH_UP_WAIT_MS).unref();
    });
    return Promise.race([read, wait]);
  }

  /** The last snapshot a drop retired, when the read that should have replaced
   *  it failed. Unreachable on the success path by construction: it is only ever
   *  called from a `catch`. */
  private retired(err: unknown): IssuesSnapshot {
    if (githubPrincipal()) throw err;
    const stale = this.lastGood;
    if (!stale) throw err;
    this.logger.warn(
      `the ingest could not be re-read after a write dropped it (${err instanceof Error ? err.message : String(err)}), ` +
        `so the list from ${new Date(stale.at).toISOString()} is served instead of failing the surfaces that ` +
        'join against it (#692).',
    );
    return stale;
  }

  /**
   * The submission marker for the two surfaces that fetch no body (#516).
   *
   * NEVER rejects. Any failure of `getIssues()` — including the cold-cache case,
   * which propagates — resolves as `null`. Propagating would turn a data-hiding
   * control into a 500 for humans on the Projects page, which is a worse outcome
   * than a hidden title and not the trade this is making.
   *
   * `null` means the caller could not establish anything, and the words rule
   * withholds on it: static agent tokens read `Feedback submission (hidden)` in
   * place of feedback-repo titles on those two surfaces until the next
   * successful ingest. That is bounded by the repo gate — every other repo a
   * token reads all day is untouched — and it is logged, because `FEEDBACK_REPO`
   * IS the board's own repo, so the state is otherwise invisible to whoever runs
   * the service.
   */
  async submissionIndex(now = Date.now()): Promise<SubmissionIndex | null> {
    let snapshot: IssuesSnapshot;
    try {
      snapshot = await this.getIssues(now);
    } catch (err) {
      return this.uncovered(`the issues cache is unavailable (${(err as Error).message})`);
    }
    const { issues, at } = snapshot;
    let indexed = this.indexed;
    // Keyed on the snapshot itself rather than its `at`: a catch-up after a
    // webhook delivery keeps the `at` of the snapshot it refreshed (#1007, V5).
    if (!indexed || indexed.of !== snapshot) {
      indexed = { of: snapshot, index: buildSubmissionIndex(issues, this.feedbackRepo) };
      // MEMOISED only while this snapshot is the one being served. `getIssues()`
      // answers a read a write disowned to its own caller (#692) — that is the
      // deal — but the index built from it must not be kept, or the disowned
      // read puts back the very thing `dropCaches()` nulled two lines up. The
      // ownership test is the snapshot itself: a disowned one is not the cache.
      if (this.cache === snapshot) this.indexed = indexed;
    }
    if (!indexed.index) {
      return this.uncovered(`the issues cache holds no row from ${this.feedbackRepo}`);
    }
    this.warnedUncovered = false;
    this.reportStaleness(now, at);
    return indexed.index;
  }

  /** Say once that the marker is unavailable, and answer null. */
  private uncovered(why: string): null {
    if (!this.warnedUncovered) {
      this.warnedUncovered = true;
      this.logger.warn(
        `submissionIndex unavailable: ${why}. Titles from ${this.feedbackRepo} are withheld from static ` +
          'agent tokens on the Projects and issue-relations surfaces until the next successful ingest (#516).',
      );
    }
    return null;
  }

  /** Say once when a covered index has gone far past its TTL. Stale-while-
   *  revalidate serves an old cache indefinitely when refreshes keep failing, and
   *  a marker that old is exactly where a relabelled submission stays readable. */
  private reportStaleness(now: number, at: number): void {
    const stale = now - at > STALE_INDEX_TTLS * this.ttlMs;
    if (stale && !this.warnedStale) {
      this.warnedStale = true;
      this.logger.warn(
        `submissionIndex is ${Math.round((now - at) / 1000)}s old, past ${STALE_INDEX_TTLS} refresh intervals — ` +
          'refreshes are failing behind stale-while-revalidate, so a newly filed submission may not be marked (#516).',
      );
    }
    if (!stale) this.warnedStale = false;
  }

  /**
   * The orgs the last SUCCESSFUL ingest covered, or `null` when none has run
   * yet (#650).
   *
   * Three-valued for the same reason `submissionIndex` is: `null` is "there is
   * no run to describe", `[]` is "a run happened and could say nothing about
   * any org", and a filled list is a run's own verdict. Only `null` lets the
   * boot probe answer instead — see `composeOrgReadState`.
   *
   * Read off the cached snapshot, so it moves with the numbers every surface is
   * reading rather than with a second clock — and off the snapshot a WRITE
   * retired when there is no cached one (#692). A close changes issues, not
   * whether an org could be read, so a drop that reset this to `null` would hand
   * `/api/auth/me` back to the boot probe hours after boot: the exact
   * outliving-its-run failure `composeOrgReadState` exists to prevent. The
   * window the probe answers in stays what it was — process start until the
   * first successful ingest.
   */
  lastIngestOrgs(): OrgReadOutcome[] | null {
    return (this.cache ?? this.lastGood)?.orgs ?? null;
  }

  /** How the source says each configured org's read went, or none when it
   *  cannot say. Never a fabricated `read`. */
  private orgsRead(): OrgReadOutcome[] {
    return (this.source as Partial<OrgReportingSource>).orgOutcomes?.() ?? [];
  }

  /** How the source says each repo's own fetch went, or none when it cannot say.
   *  Never a fabricated failure, and never a fabricated `ok`. */
  private reposRead(): RepoReadOutcome[] {
    return (this.source as Partial<RepoReportingSource>).repoOutcomes?.() ?? [];
  }

  /**
   * Fetch the raw list and replace the cache. Deduped via `inFlight` so a
   * background refresh, a cold load and the boot warm never stampede GitHub.
   *
   * With the webhook store on (#1007, V5), two reads differ from the ordinary
   * one. A reconcile reads Github for every repo, so it joins only a read in
   * flight that is itself a reconcile, and disowns an ordinary one it overtakes,
   * which could otherwise land after it and put the older list back. A catch-up
   * (`reuse`) keeps the `at` of the snapshot it refreshes, so the TTL still runs
   * from the last time the repos it kept were read, and when it fails it leaves
   * the cache alone: that snapshot was going to be served until its TTL anyway.
   * With the store off, every read is the ordinary one, as before V5.
   */
  private refresh(now: number, mode: { reconcile?: boolean; reuse?: IssuesSnapshot } = {}): Promise<IssuesSnapshot> {
    const reconcile = Boolean(mode.reconcile && this.signal);
    const reuse = this.signal ? mode.reuse : undefined;
    if (this.inFlight) {
      if (!reconcile || this.reconciling) return this.inFlight;
      this.epoch++;
    }
    const epoch = this.epoch;
    const generation = this.signal?.generation ?? 0;
    const listed = reconcile
      ? this.source.listIssues({ reconcile: true })
      : reuse
        ? this.source.listIssues({ reuse: { issues: reuse.issues, repos: reuse.repos, changedRepos: this.signal!.changed(reuse.repos, reuse.generation) } })
        : this.source.listIssues();
    const read = listed
      // Read AFTER the list resolves, because that is the run it describes.
      .then((issues) => {
        const snapshot: IssuesSnapshot = {
          at: reuse ? reuse.at : now,
          generation,
          issues,
          orgs: this.orgsRead(),
          repos: this.reposRead(),
          repoCoverageReported: typeof (this.source as Partial<RepoReportingSource>).repoOutcomes === 'function',
          coverageReported: typeof (this.source as Partial<OrgReportingSource>).orgOutcomes === 'function'
            || typeof (this.source as Partial<RepoReportingSource>).repoOutcomes === 'function',
        };
        // Only while this read still describes the current generation. A read
        // disowned by a write (#692) is returned to whoever asked for it and
        // cached for nobody.
        if (epoch === this.epoch) {
          this.cache = snapshot;
          // Nothing to fall back to while there is a current answer, and this
          // one holds every issue in the org — so it is released rather than
          // kept for a failure that now has a fresher thing to serve.
          this.lastGood = null;
        }
        return snapshot;
      })
      // Only a read that still owns the cache may empty it. A disowned one
      // failing late would otherwise throw away the answer that overtook it.
      .catch((err) => {
        if (epoch === this.epoch && !reuse && githubPrincipal()) { this.cache = null; this.lastGood = null; }
        throw err;
      })
      .finally(() => {
        // Never null a slot this read no longer owns: a drop has already
        // cleared it, and a newer read may be sitting in it.
        if (this.inFlight === read) {
          this.inFlight = null;
          this.reconciling = false;
        }
      });
    this.inFlight = read;
    this.reconciling = reconcile;
    return read;
  }
}
