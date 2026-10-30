import { githubContext } from '../auth/github-principal';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DERIVED_LOGINS_SOURCE, type DerivedLoginsSource } from './derived-logins.source';

/**
 * The derived email → login map, warmed in the background (#535).
 *
 * `loginFor` is SYNCHRONOUS and reads memory. That is the design, not an
 * optimisation. `me.controller.ts` awaits the resolver, and its comment records
 * in writing that `/me` is the app's mount gate — "the frontend renders no
 * chrome until it answers" — and that a store hiccup cannot blank the board.
 * Putting a rate-limited third-party search on that path would have made a
 * Github outage a board outage. Nothing here can: a cold map answers null, which
 * is the board's behaviour before this tier existed.
 *
 * Nothing is persisted. A derived handle is an inference, and writing one into
 * the Identity table would make it indistinguishable from a handle an admin
 * typed — which is what #535's Definition of Done forbids.
 *
 * The cache is replaced only by a COMPLETE run. Github refusing requests is not
 * evidence that anybody lost their account.
 */
@Injectable()
export class DerivedLoginsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DerivedLoginsService.name);
  private readonly intervalMs: number;
  private map = new Map<string, string>();
  private inFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  /**
   * Moves on every invalidation, and it is the WHOLE of the drop.
   *
   * A run already in flight would otherwise write on its way out with data that
   * predates the invalidation, re-pinning exactly what was dropped — the same
   * argument `github-login.resolver.ts` makes for the roster.
   */
  private generation = 0;
  /** The generation `start()` stamped on the run currently in flight. Lives here
   *  beside its sibling because `refresh()` is unreadable without it. */
  private inFlightGeneration = 0;

  constructor(
    @Inject(DERIVED_LOGINS_SOURCE) private readonly source: DerivedLoginsSource,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.intervalMs = config.get<number>('GITHUB_LOGIN_DERIVATION_INTERVAL_MS', 43_200_000);
  }

  onModuleInit(): void {
    // Fire-and-forget: boot must not wait on Github, and `refresh` never rejects.
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    // Do not hold the process open for this alone.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The derived handle for `email`, or null. Memory only — never a Github call. */
  loginFor(email: string): string | null {
    return this.map.get(email.trim().toLowerCase()) ?? null;
  }

  /**
   * Mark the map stale. Deliberately does NOT clear it.
   *
   * `run()` keeps the previous map when a derive comes back incomplete — and
   * there is no previous map to keep if this emptied it first. A "Sync now"
   * during a Github outage would then blank every derived attribution for the
   * whole interval, which is exactly what this class promises not to do: Github
   * refusing requests is not evidence anybody lost their account.
   *
   * Stale-while-revalidate, the shape every other cache on this board uses.
   */
  invalidate(): void {
    this.generation += 1;
  }

  /**
   * Rebuild, and never reject — both callers are fire-and-forget.
   *
   * A run already in flight is joined ONLY if no invalidation has landed since
   * it started. Otherwise its result is already destined for the bin, and
   * handing that promise back would have the caller believe a refresh happened
   * when nothing was kept.
   */
  refresh(): Promise<void> {
    if (githubContext.getStore()) return githubContext.exit(() => this.refresh());
    if (this.inFlight && this.inFlightGeneration === this.generation) return this.inFlight;
    if (this.inFlight) return this.inFlight.then(() => this.refresh());
    return this.start();
  }

  private start(): Promise<void> {
    this.inFlightGeneration = this.generation;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const startedAt = this.generation;
    try {
      const { map, complete } = await this.source.derive();
      if (!complete) {
        this.logger.warn('derived login refresh incomplete — keeping the previous map');
        return;
      }
      // Only if no invalidation arrived while we were deriving.
      if (this.generation === startedAt) this.map = map;
    } catch (err) {
      this.logger.warn(`derived login refresh failed: ${(err as Error).message}`);
    }
  }
}
