import { githubPrincipal, PrincipalState } from '../auth/github-principal';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DELIVERY_SOURCE,
  DeliveryData,
  DeliveryView,
  IDeliverySource,
} from './delivery.types';
import { mergeDelivery, toDeliveryView } from './delivery.vm';
import { githubOrgs } from '../config/github-orgs';

/** One org's cached rollup: the payload + when it was fetched. */
type Entry = { at: number; data: DeliveryData };

/**
 * Serves the delivery stream (#173 Phase 2). The rollup is one GraphQL round-trip
 * across the org, so it is served **stale-while-revalidate** (mirrors #175): a
 * fresh cache returns directly; a stale cache returns immediately while one
 * background refresh runs, so no dashboard load pays the cold fetch except the
 * first. The boot warm absorbs that read when authentication is disabled.
 *
 * The rollup is about one org, so both caches are keyed by the org the fetch was
 * made against (#648) — no org's stream can ever be served as another's. A
 * deployment naming several orgs therefore holds several entries and refreshes
 * each on its own clock; what a read returns is their union (#697).
 */
@Injectable()
export class DeliveryService implements OnModuleInit {
  private readonly principalState = new PrincipalState(() => ({
    cacheByOrg: new Map<string, Entry>() as Map<string, Entry>,
    inFlightByOrg: new Map<string, Promise<Entry>>() as Map<string, Promise<Entry>>
  }), true);
  private readonly logger = new Logger(DeliveryService.name);
  private get cacheByOrg(): Map<string, Entry> { return this.principalState.current.cacheByOrg; }
  private set cacheByOrg(value: Map<string, Entry>) { this.principalState.current.cacheByOrg = value; }
  /** Dedupes concurrent refreshes (background + cold + boot warm), per org. */
  private get inFlightByOrg(): Map<string, Promise<Entry>> { return this.principalState.current.inFlightByOrg; }
  private set inFlightByOrg(value: Map<string, Promise<Entry>>) { this.principalState.current.inFlightByOrg = value; }
  private readonly ttlMs: number;

  constructor(
    // Explicit token — tsx/vitest (esbuild) emit no design:paramtypes metadata.
    @Inject(DELIVERY_SOURCE) private readonly source: IDeliverySource,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {
    this.ttlMs = config.get<number>('DELIVERY_CACHE_TTL_MS', 600_000);
  }

  /** The orgs this read is about, resolved per read rather than at boot — the
   *  scope is a property of the answer, not of the process.
   *
   *  A SET, not one org, which is the whole of #697: delivery asks which orgs
   *  it COVERS, and the answer is every owner the caller can read — the person's
   *  own Github App grants, or `GITHUB_ORGS` where no person is acting.
   *  `DELIVERY_OWNER` used to narrow it and is retired (#1209 part 4). */
  private orgsForRead(): string[] {
    return githubOrgs(this.config);
  }

  /** Warm every org's cache at boot so the first visitor never eats the cold
   *  fetch — one warm per org, because the caches are per org. */
  onModuleInit(): void {
    // Signed-in reads use person-scoped state; only auth-disabled readers use this warm.
    if (!this.config.get<boolean>('AUTH_DISABLED', false)) return;
    const now = Date.now();
    for (const org of this.orgsForRead()) {
      this.refresh(org, now).catch((err) =>
        this.logger.warn(`initial delivery warm failed for ${org}: ${(err as Error).message}`),
      );
    }
  }

  /** Fetch one org's rollup and replace that org's cache. Deduped via
   *  `inFlightByOrg` so a background refresh, a cold load and the boot warm never
   *  stampede GitHub — and so the dedupe stays per-org. */
  private refresh(org: string, now: number): Promise<Entry> {
    const running = this.inFlightByOrg.get(org);
    if (running) return running;
    const p: Promise<Entry> = this.source
      .load(org)
      .then((data) => {
        const entry: Entry = { at: now, data };
        this.cacheByOrg.set(org, entry);
        return entry;
      })
      .catch((err) => { if (githubPrincipal()) this.cacheByOrg.delete(org); throw err; })
      .finally(() => {
        // Only its OWN slot — the shape `ProjectsService` and
        // `IssueBucketsService` carry (#692). Nothing here clears the map today,
        // this being the one cache of the six with no `dropCaches()`, so the
        // check never fires; it is what keeps a landing read from deleting a
        // newer read's slot the day delivery grows one.
        if (this.inFlightByOrg.get(org) === p) this.inFlightByOrg.delete(org);
      });
    this.inFlightByOrg.set(org, p);
    return p;
  }

  /** ONE org's entry, under stale-while-revalidate. Rejects only on a cold read
   *  that failed — a stale entry is served whatever the refresh behind it does. */
  private orgRollup(org: string, now: number): Promise<Entry> {
    const cached = this.cacheByOrg.get(org);
    // Fresh: serve directly.
    if (cached && now - cached.at < this.ttlMs) return Promise.resolve(cached);
    // Stale: serve the old data now, refresh in the background (SWR) — no user waits.
    if (cached) {
      this.refresh(org, now).catch((err) =>
        this.logger.warn(`background delivery refresh failed for ${org}: ${(err as Error).message}`),
      );
      return Promise.resolve(cached);
    }
    // Cold (no cache yet): must wait once; a fetch failure propagates as an error.
    return this.refresh(org, now);
  }

  /**
   * Every configured org's entry, read concurrently and tolerated separately —
   * the shape `issues-metrics`' `resolveScope` already has (#647), for the same
   * reason (#697).
   *
   * One org failing is NOT the read failing: the orgs that answered carry real
   * releases and real merges, and blanking them because a second org 404d would
   * lose work that was read successfully. EVERY org failing still throws, as it
   * always did, and with one configured org those are the same case — which is
   * what makes a single-org deployment behave exactly as before.
   *
   * `allSettled` rather than `all`, because `all` rejects on the first failure
   * and abandons the answers that were already in hand. Order is the configured
   * order, which is the order `releaseScope` then names the orgs in.
   */
  private async rollups(now: number): Promise<Entry[]> {
    const orgs = this.orgsForRead();
    if (orgs.length === 0) {
      // A scope with no org in it. NOT an operator control: no setting narrows
      // this feed any more, `DELIVERY_OWNER` having been retired (#1209 part 4),
      // and `GITHUB_ORGS` refuses to parse to nothing. What reaches here is a
      // PERSON whose Github App grants cover no owner, and the floor under the
      // states Joi does not catch — a `ConfigService` built straight from an
      // object, which is every spec in this tree. There is no honest payload
      // either way: an empty feed would read as a quiet org rather than as no
      // org at all.
      throw new Error(
        'delivery: the owner scope names no org, so there is nothing to read — connect Github, ' +
          'or set GITHUB_ORGS to the org login(s) this board serves.',
      );
    }
    const settled = await Promise.allSettled(orgs.map((org) => this.orgRollup(org, now)));
    const entries: Entry[] = [];
    const failures: Error[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        entries.push(r.value);
        return;
      }
      const err = r.reason as Error;
      failures.push(err);
      // Named in the log, because the payload cannot say it: an org that
      // contributed nothing is absent from `releaseScope`, and absent is where
      // "quiet" and "unreadable" would otherwise look the same.
      this.logger.warn(`delivery: ${orgs[i]} unreadable: ${err.message}`);
    });
    if (entries.length === 0) {
      // Nothing was read at all, so every number downstream would be wrong with
      // nothing to say so. Carries each org's own reason, and the first as
      // `cause`, because with several orgs there may be several.
      throw new Error(failures.map((e) => e.message).join('; '), { cause: failures[0] });
    }
    return entries;
  }

  /** The cache holds raw release times; the day series is derived HERE, against
   *  this request's clock. Bucketing at fetch time instead would freeze the
   *  series for up to a full TTL, so a dashboard opened just after UTC midnight
   *  would print the wrong "yesterday" — see `toDeliveryView`. */
  async getDelivery(): Promise<DeliveryView> {
    const now = Date.now();
    const entries = await this.rollups(now);
    // The OLDEST entry's fetch time, because freshness is a claim about the
    // whole payload: stamping the newest would date the union by the org that
    // happened to refresh last and hide a second org's staleness behind it.
    const at = Math.min(...entries.map((e) => e.at));
    const data = mergeDelivery(entries.map((e) => e.data));
    return toDeliveryView({ ...data, updatedAt: new Date(at).toISOString() }, now);
  }
}
