import { githubPrincipal, PrincipalState } from '../auth/github-principal';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  bucketLinks,
  IIssueBucketsSource,
  ISSUE_BUCKETS_SOURCE,
  IssueBuckets,
} from './issue-buckets.types';
import { githubOrgs } from '../config/github-orgs';
import type { StaleOnWrite } from '../freshness/stale-on-write';

/**
 * Serves the dashboard Issues block (#185). Counts are cheap but not free (four
 * search queries), and the dashboard is the most-hit surface, so they are cached
 * for a short TTL and served **stale-while-revalidate**: a fresh cache returns
 * directly; a stale cache returns immediately while one background refresh runs,
 * so no request pays the fetch except the very first. `syncedAt` always reports
 * when the served counts were actually fetched, so the UI's "Synced" stamp tells
 * the truth even when the value is a few seconds stale.
 *
 * Every cache here is keyed by the SCOPE the counts were fetched over (#648,
 * #697): the answer is about a set of orgs, so counts covering one set can never
 * be served as another's — and narrowing the scope is a different answer, not a
 * cache hit.
 */
@Injectable()
export class IssueBucketsService implements StaleOnWrite {
  private readonly principalState = new PrincipalState(() => ({
    cacheByScope: new Map<string, IssueBuckets>() as Map<string, IssueBuckets>,
    inFlightByScope: new Map<string, Promise<IssueBuckets>>() as Map<string, Promise<IssueBuckets>>,
    epoch: 0 as number,
    lastGoodByScope: new Map<string, IssueBuckets>() as Map<string, IssueBuckets>
  }), true);
  private readonly logger = new Logger(IssueBucketsService.name);
  private get cacheByScope(): Map<string, IssueBuckets> { return this.principalState.current.cacheByScope; }
  private set cacheByScope(value: Map<string, IssueBuckets>) { this.principalState.current.cacheByScope = value; }
  /** Dedupes concurrent refreshes (background + cold), per scope. */
  private get inFlightByScope(): Map<string, Promise<IssueBuckets>> { return this.principalState.current.inFlightByScope; }
  private set inFlightByScope(value: Map<string, Promise<IssueBuckets>>) { this.principalState.current.inFlightByScope = value; }
  /** Moves on every drop, so a count read that went out before one cannot write
   *  what it read into the cache when it lands (#692). */
  private get epoch(): number { return this.principalState.current.epoch; }
  private set epoch(value: number) { this.principalState.current.epoch = value; }
  /** The last counts this served for each scope, RETIRED by a drop rather than
   *  deleted (#692) — served only when the read that should replace them fails. */
  private get lastGoodByScope(): Map<string, IssueBuckets> { return this.principalState.current.lastGoodByScope; }
  private set lastGoodByScope(value: Map<string, IssueBuckets>) { this.principalState.current.lastGoodByScope = value; }
  private readonly ttlMs: number;

  constructor(
    @Inject(ISSUE_BUCKETS_SOURCE) private readonly source: IIssueBucketsSource,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {
    this.ttlMs = config.get<number>('ISSUE_BUCKETS_CACHE_TTL_MS', 60_000);
  }

  /** The orgs this read is about, resolved per read rather than at boot — the
   *  scope is a property of the answer, not of the process.
   *
   *  A SET, not one org: a board serving two orgs counts both (#697). The set
   *  is the person's own Github App grants, or GITHUB_ORGS where no person is
   *  acting. ISSUE_BUCKETS_ORG used to narrow it and is retired (#1209 part
   *  4). */
  private orgsForRead(): string[] {
    return githubOrgs(this.config);
  }

  /** The cache key for a scope: the whole list, in configured order, so two
   *  different scopes are two different answers and a narrowed scope can never
   *  be served the wider one's counts. */
  private static scopeKey(orgs: string[]): string {
    return orgs.join(',');
  }

  async getBuckets(): Promise<IssueBuckets> {
    const orgs = this.orgsForRead();
    const scope = IssueBucketsService.scopeKey(orgs);
    const now = Date.now();
    const cached = this.cacheByScope.get(scope);
    if (cached && now - Date.parse(cached.syncedAt) < this.ttlMs) return cached;

    // Stale but present: serve it now, refresh in the background (SWR).
    if (cached) {
      this.refresh(orgs).catch((err) =>
        this.logger.warn(`background bucket refresh failed: ${(err as Error).message}`),
      );
      return cached;
    }

    // Cold: must wait once, and the wait is the point — what this returns is
    // the source's answer, never the retired one. Only a FAILED read reaches
    // back for what a drop retired (#692); four searches against a rate-limited
    // Github used to 500 the dashboard's whole Issues block a moment after a
    // close, where it would have shown a one-off-by-one count before.
    return this.refresh(orgs).catch((err: unknown) => this.retired(scope, err));
  }

  /** The last counts a drop retired for this scope, when the read that should
   *  have replaced them failed. Unreachable on the success path by construction:
   *  it is only ever called from a `catch`. */
  private retired(scope: string, err: unknown): IssueBuckets {
    if (githubPrincipal()) throw err;
    const stale = this.lastGoodByScope.get(scope);
    if (!stale) throw err;
    this.logger.warn(
      `the counts for ${scope} could not be re-read after a write dropped them ` +
        `(${err instanceof Error ? err.message : String(err)}), so the counts from ${stale.syncedAt} are ` +
        'served rather than failing the block (#692).',
    );
    return stale;
  }

  /** When the current or retained counts for this scope were fetched (#1275).
   *  A write invalidates the current entry but keeps a copy; report that copy's
   *  time until a replacement arrives. A scope never read still has no time. */
  lastSyncedAt(): string | null {
    const scope = IssueBucketsService.scopeKey(this.orgsForRead());
    return this.cacheByScope.get(scope)?.syncedAt ?? this.lastGoodByScope.get(scope)?.syncedAt ?? null;
  }

  /** Force a fresh count fetch, replacing the cache (#301, "sync now"). Awaits
   *  the fetch so the served counts are current by the time this resolves. */
  async resync(): Promise<void> {
    await this.refresh(this.orgsForRead());
  }

  /** Declare these counts out of date (#692) — see `StaleOnWrite`. Closing one
   *  issue moves `open`, and moves `bugs`, `feedback` or `unassigned` with it
   *  depending on what the issue was, so no bucket survives a close.
   *
   *  EVERY scope's counts, not just the one this process reads: which org a
   *  write targeted is not a question this service is asked, and the caches it
   *  keeps for a scope nobody is reading cost nothing to rebuild.
   *
   *  NO `warmAfterWrite` (#692), and that is an answer rather than an
   *  omission: these four counts are four Github SEARCH queries, and search is
   *  limited to thirty requests a minute AND is eventually consistent — a refill
   *  on the write's own path would usually re-cache the count from before the
   *  close and hold it for a TTL. See `StaleOnWrite`. */
  dropCaches(): void {
    // RETIRED, not deleted — one entry per scope, replacing that scope's
    // previous retiree, so this map is bounded by the same key set the cache is.
    for (const [scope, counts] of this.cacheByScope) this.lastGoodByScope.set(scope, counts);
    this.cacheByScope.clear();
    this.inFlightByScope.clear();
    this.epoch++;
  }

  /** Fetch one scope's counts and replace that scope's cache. Deduped via
   *  `inFlightByScope`, so the dedupe is per-scope too. */
  private refresh(orgs: string[]): Promise<IssueBuckets> {
    const scope = IssueBucketsService.scopeKey(orgs);
    const running = this.inFlightByScope.get(scope);
    if (running) return running;
    const epoch = this.epoch;
    const p: Promise<IssueBuckets> = this.source
      .counts()
      .then((counts) => {
        const buckets: IssueBuckets = {
          ...counts,
          syncedAt: new Date().toISOString(),
          // The same orgs the counts were fetched over, through the same
          // `bucketQuery` the source counted with (#697).
          links: bucketLinks(orgs),
        };
        // Only while these counts still describe what is being served: a read
        // that went out before a write is answered to its own caller and never
        // cached, or it would put the pre-write counts back (#692).
        if (epoch === this.epoch) {
          this.cacheByScope.set(scope, buckets);
          // Nothing to fall back to while there is a current answer.
          this.lastGoodByScope.delete(scope);
        }
        return buckets;
      })
      .catch((err) => { if (githubPrincipal()) { this.cacheByScope.clear(); this.lastGoodByScope.clear(); } throw err; })
      .finally(() => {
        // Only its OWN slot. A drop clears the map, and a caller arriving after
        // that has started a read this one must not delete out from under.
        if (this.inFlightByScope.get(scope) === p) this.inFlightByScope.delete(scope);
      });
    this.inFlightByScope.set(scope, p);
    return p;
  }
}
