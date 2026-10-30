import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ADMIN_SOURCE, IAdminSource } from './admin-source';

/**
 * Holds a SYNCHRONOUS snapshot of the board's admin emails (#143, #332) so
 * `AdminAuthority.isAdmin` — and therefore the whole guard chain — stays sync
 * with no async refactor. The underlying source is board-assigned roles from the
 * identity store (people whose stored role is `admin`) in db mode, or a fixture
 * list for dev/test. Warms once on boot, then refreshes lazily on a TTL
 * (stale-while-revalidate): the getter never blocks.
 *
 * Fails toward the last-good snapshot. A source outage can therefore only fail
 * to ADD a newly-assigned admin until it recovers; it never drops admins it has
 * already seen.
 *
 * Before the first SUCCESSFUL read there is no last-good snapshot to fail
 * toward, and `emails()` returns `null` rather than `[]` (#588). The two are
 * different facts and the caller must not confuse them: `[]` is a read that
 * succeeded and found no admins, `null` is no answer at all. They used to be the
 * same value, so a Postgres outage during a rollout looked exactly like an empty
 * admin table — and AdminAuthority armed the BOARD_ADMIN_EMAILS break-glass on
 * it, granting admin from an env var while real admins sat unread in the
 * database. Returning `null` makes that state impossible to read past by
 * accident: the type forces the caller to say what it does with "unknown".
 */
@Injectable()
export class AdminEmailCache implements OnModuleInit {
  private readonly logger = new Logger(AdminEmailCache.name);
  private readonly ttlMs: number;
  // `null` until a read SUCCEEDS — never set from the catch below, which is the
  // whole point: only a completed read may fill this in.
  private snapshot: string[] | null = null;
  private at = 0;
  // Single-flight: a burst of stale getter calls must share ONE refresh, not
  // each fire a source read.
  private refreshing: Promise<void> | null = null;
  // Set by invalidate() so its intent survives a refresh that is already in
  // flight (and reading pre-write state) when it lands — without it, that
  // in-flight read resolves, stamps `at` fresh, and the invalidate is lost for a
  // full TTL (a revoked admin would keep access up to ADMIN_CACHE_TTL_MS).
  private dirty = false;

  constructor(
    @Inject(ADMIN_SOURCE) private readonly source: IAdminSource,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.ttlMs = config.get<number>('ADMIN_CACHE_TTL_MS', 300000);
  }

  /**
   * Warm the snapshot before the first request. Never throws (would crash boot).
   *
   * The `await` is load-bearing and not a formality. Nest settles every
   * `onModuleInit` before it runs any `onApplicationBootstrap`, so awaiting here
   * is the only reason `AdminAuthority.onApplicationBootstrap` reads a cache
   * that has already tried its source rather than an untouched one. Drop the
   * await for a faster boot and that guard reports the roster as unread on every
   * healthy start. Nothing else enforces the ordering, and no test asserts it —
   * three specs in this file do go red, but only incidentally, because the
   * warm-up read would still be in flight and single-flight would fold their
   * read into it. Fail-closed either way: nobody resolves as admin in that
   * window, so the break-glass stays disarmed.
   */
  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** The cached admin emails (lowercased), or `null` when no read has succeeded
   *  yet — see the class note: `null` is "unknown", `[]` is "nobody".
   *  Triggers a background refresh when stale. */
  emails(): string[] | null {
    if (Date.now() - this.at >= this.ttlMs) void this.refresh();
    return this.snapshot;
  }

  /** Force a refresh against post-write state — called after a role write so a
   *  newly-assigned (or revoked) admin takes effect promptly, not on the TTL.
   *  Marks the cache dirty so the intent isn't lost to a refresh already in
   *  flight over pre-write data; that read then chains a second, post-write read. */
  invalidate(): void {
    this.at = 0;
    this.dirty = true;
    // Kick a read now if none is running; if one is, `dirty` makes it re-run.
    void this.refresh();
  }

  private refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    // Claim this read as covering the current invalidate intent. A later
    // invalidate mid-flight re-sets `dirty`, triggering another read on finally.
    this.dirty = false;
    this.refreshing = this.source
      .listAdminEmails()
      .then((emails) => {
        this.snapshot = emails;
        this.at = Date.now();
      })
      .catch((err: unknown) => {
        // Deliberately does NOT touch `snapshot`: a failed read keeps the
        // last-good one, and leaves it `null` if there has never been one.
        const kept = this.snapshot === null ? 'no snapshot yet' : `${this.snapshot.length} cached`;
        this.logger.error(`admin emails refresh failed, keeping ${kept}: ${
          err instanceof Error ? err.message : String(err)
        }`);
      })
      .finally(() => {
        this.refreshing = null;
        // An invalidate that landed while this read was in flight was reading
        // stale (pre-write) data — run once more to capture the write.
        if (this.dirty) void this.refresh();
      });
    return this.refreshing;
  }
}
