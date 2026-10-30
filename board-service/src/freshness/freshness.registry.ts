import { Inject, Injectable, Logger, OnApplicationBootstrap, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { IssueBucketsService } from '../issue-buckets/issue-buckets.service';
import { IssueDetailService } from '../issue-detail/issue-detail.service';
import { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import { ProjectsService } from '../projects/projects.service';
import type { Capability } from '../capability/capability';
import type { StaleOnWrite } from './stale-on-write';

/**
 * Every cache a Github write can leave out of date (#692) — the issue-derived
 * ones, which is all four of them: the Projects rollup and per-board detail, the
 * shared raw-issues ingest, the dashboard buckets and the issue page. An issue
 * closed from the board appears in all four, so a write that dropped only the row that was clicked is the bug this
 * list closes.
 *
 * A TYPED list, not a string of tokens: adding a fifth cache is one line here
 * and a `dropCaches()` on the service, and dropping a service from the graph is
 * a compile error rather than a silent no-op.
 *
 * EXPORTED because `freshness.spec.ts` drives this list rather than a copy of
 * it: a fifth cache added here with no driver beside it fails that spec by
 * name, which is the one way a hand-written test list cannot forget one.
 */
export const HOLDERS: Type<StaleOnWrite>[] = [
  ProjectsService,
  IssuesCacheService,
  IssueBucketsService,
  IssueDetailService,
];

/**
 * Resolves those four and drops them together.
 *
 * They are looked up through `ModuleRef` with `strict: false` — the whole
 * container rather than one module's own providers — and NOT injected. Two
 * reasons, and the first is the load-bearing one:
 *
 *  - every one of the four is built by a `useFactory` with an explicit `inject`
 *    array in its own module, so an extra constructor argument would mean
 *    editing four modules to register a mechanism none of them is about. The
 *    dependency points one way instead: freshness knows the caches, the caches
 *    know nothing about freshness beyond the method name they already needed.
 *  - a spec or a deployment that builds a subset of the graph loses the caches
 *    it never built and keeps the rest, rather than failing to construct.
 *
 * Resolution happens once, at `onApplicationBootstrap` (#692 review): a cache
 * this cannot reach is a fault of the module graph, so it belongs in the deploy
 * log beside the other boot lines rather than in one `logger.warn` at whenever
 * somebody first writes — which is both late and easy to miss. The result is
 * memoised either way; these are singletons, so it is the same four instances for
 * the life of the process, and a write done before the hook (there is none) or a
 * spec that never fires it still resolves lazily on first use.
 */
@Injectable()
export class FreshnessRegistry implements OnApplicationBootstrap {
  private readonly logger = new Logger(FreshnessRegistry.name);
  private holders: StaleOnWrite[] | null = null;

  constructor(@Inject(ModuleRef) private readonly moduleRef: ModuleRef) {}

  /** After every module is instantiated, so the lookup below can succeed, and
   *  before any request has been served, so its verdict is in the boot log. */
  onApplicationBootstrap(): void {
    this.resolve();
  }

  /**
   * Declare every cached answer out of date, then start the refills that are
   * allowed to run here. Called after a write, once.
   *
   * SYNCHRONOUS, and it returns nothing to await. The drops finish before the
   * write's response is written, so nothing can be served from a cache the write
   * invalidated; the refills are started and left running, so the write's answer
   * never waits on Github. Making this `async` and awaiting them would hold a
   * confirm dialog open for as long as an org-wide scan takes — which is the
   * whole trade this shape refuses.
   *
   * Not every cache is refilled, and the two that are not are not an
   * oversight: they refill from Github SEARCH, which is rate-limited an order of
   * magnitude tighter than core REST and is eventually consistent, so a refill
   * issued this close to a write tends to cache the answer from BEFORE it. Each
   * cache answers for itself by having a `warmAfterWrite` or not, and
   * `StaleOnWrite` carries the argument.
   */
  invalidateAll(written?: readonly Capability[]): void {
    const holders = this.resolve();
    for (const holder of holders) {
      // Guarded PER HOLDER, because the loop is the thing that must not stop.
      // A cache that threw on its own drop would otherwise leave every cache
      // after it in the list serving what the write invalidated, and fail a
      // write that already landed at Github.
      try {
        holder.dropCaches(written);
      } catch (err: unknown) {
        this.logger.warn(
          `drop of ${holder.constructor.name} after a write failed, so it is still serving what the ` +
            `write invalidated: ${asMsg(err)} (#692)`,
        );
      }
    }
    // Then the refills, for the caches that offer one — started here and NEVER
    // awaited, so the write's answer does not wait on Github. Which caches those
    // are is each cache's own answer, given by having a `warmAfterWrite` at all:
    // see `StaleOnWrite`, where the budget argument that decides it lives. There
    // is deliberately no list of exceptions here to keep in sync with that.
    for (const holder of holders) {
      if (!holder.warmAfterWrite) continue;
      try {
        void holder.warmAfterWrite().catch((err: unknown) => this.warmFailed(holder, err));
      } catch (err: unknown) {
        // A `warmAfterWrite` that throws BEFORE returning a promise — the drop
        // has already happened either way, and the next reader is what refills.
        this.warmFailed(holder, err);
      }
    }
  }

  /** A refill that fails is a warning, never the write's error: the drop already
   *  landed, so the next reader pays a cold read and gets a right answer. */
  private warmFailed(holder: StaleOnWrite, err: unknown): void {
    this.logger.warn(
      `re-warm of ${holder.constructor.name} after a write failed, so the next reader pays a cold ` +
        `read: ${asMsg(err)} (#692)`,
    );
  }

  private resolve(): StaleOnWrite[] {
    if (this.holders) return this.holders;
    const found: StaleOnWrite[] = [];
    const missing: string[] = [];
    for (const token of HOLDERS) {
      try {
        // `strict: false` searches the whole container. It THROWS on a provider
        // the graph does not hold, which is the subset case above, not an error.
        found.push(this.moduleRef.get<StaleOnWrite>(token, { strict: false }));
      } catch {
        missing.push(token.name);
      }
    }
    if (missing.length > 0) {
      // Said out loud, because the failure it describes is invisible: a cache
      // this cannot reach keeps serving what a write invalidated, and every
      // request after that looks exactly like a request before it.
      this.logger.warn(
        `not reachable from the container, so a write will not drop ${missing.length === 1 ? 'it' : 'them'}: ` +
          `${missing.join(', ')} (#692)`,
      );
    }
    this.holders = found;
    return found;
  }
}

/** A thrown value's message, whatever it is. `(err as Error).message` THROWS on
 *  anything that is not an Error — `undefined`, a string, a plain object — and a
 *  throw inside the handler above would fail the write it is reporting about.
 *  Same shape `issue-detail.service.ts` uses. */
function asMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
