import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUDIT_REPOSITORY,
  AuditEventRow,
  AuditFilter,
  AuditGaps,
  AuditHealth,
  AuditRepository,
  RecordAudit,
} from './audit.types';

/**
 * A connection string's credentials out of anything about to be logged.
 *
 * Prisma names the store it could not reach by quoting `DATABASE_URL` in full,
 * user and password included, and `record` logs that message at `error` — the
 * level alerting, error-only retention and any third-party error tracker read.
 * So the credential goes before the line does, and the host and port stay,
 * which are the halves an operator reading a lost-audit line actually needs.
 *
 * The userinfo cannot contain an unescaped `/`, so the class stops at one: that
 * keeps a URL whose *path or query* carries an `@` — a support link with an
 * email in it, say — from being read as credentials and mangled down to its
 * host. Both halves of the userinfo go, not just the password: a user name is
 * half a credential and naming it buys an operator nothing.
 */
export function redactDsn(message: string): string {
  return message.replace(/:\/\/[^@\s/]*@/g, '://***@');
}

/**
 * Records + serves the audit trail (#212). `record` is **best-effort**: an audit
 * failure is logged and swallowed so it never fails the action being audited —
 * an unrecorded event is better than a blocked token revoke. `list` powers the
 * read-only admin log.
 *
 * Swallowing is the only ordering that works, because every caller is
 * write-then-audit and the Github write has already happened by the time the
 * record fails. What it used to cost was visibility (#781): a `db` board with
 * unreachable Postgres performed writes, recorded none, and showed an operator
 * the same "No audit events yet" a genuinely quiet board shows. `health()` is
 * what tells those apart, and `AuditSection` renders it.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  /** This process, as something a response can name (#812). Random per boot: it
   *  identifies the counter's owner, and is not a stable address for anything. */
  private readonly instance = randomUUID().slice(0, 8);
  private readonly startedAt = new Date();
  private failures = 0;
  private lastFailureAt: Date | null = null;
  /** Losses this process has not yet managed to put into the trail (#812) — the
   *  part of `failures` that still exists only here, and dies with the process
   *  if the store never comes back. */
  private unmarked = 0;
  private unmarkedFrom: Date | null = null;
  /** Single-flight over the marker write: a burst of records that all find the
   *  store back must write ONE marker, not one each. */
  private marking: Promise<void> | null = null;

  constructor(@Inject(AUDIT_REPOSITORY) private readonly repo: AuditRepository) {}

  async record(e: RecordAudit): Promise<void> {
    try {
      await this.repo.record(e);
    } catch (err) {
      this.failures += 1;
      this.lastFailureAt = new Date();
      this.unmarked += 1;
      this.unmarkedFrom ??= this.lastFailureAt;
      // `error`, not `warn`: a lost row is a hole in an append-only trail, and
      // the only other place it is now countable is a page nobody has open.
      //
      // REDACTED, because the level moved. Prisma's unreachable-store message
      // quotes the whole DSN back — `Can't reach
      // postgresql://board:hunter2@db.internal:5432/board` — and at `warn` that
      // sat in a stream nothing forwards. `error` is what feeds alerting,
      // error-only retention and a third-party error tracker, so raising it
      // widened who can read the password without anyone deciding to.
      this.logger.error(
        `audit record LOST (${e.action} by ${e.actorEmail}): ${redactDsn((err as Error).message)}`,
      );
      return;
    }
    // The store just answered, so a gap this process is still carrying can go
    // somewhere a restart and a sibling replica can both read it (#812).
    await this.markGap();
  }

  /**
   * Write the losses this process is carrying into the trail as one `audit.gap`
   * row, and stop carrying them (#812).
   *
   * `failures` is NOT cleared by this and must not be: it is what this instance
   * lost since it booted, the trail row is where that fact goes to outlive the
   * instance, and zeroing the counter on a successful write would make the two
   * disagree about the same outage. `unmarked` is the part that has nowhere else
   * to live yet, and only that is cleared.
   *
   * Best-effort like `record` itself, and it must be: this runs on the back of
   * an action that has already happened, and a marker that cannot be written is
   * not a reason to fail one. A failure leaves `unmarked` alone, so the next
   * successful write tries again with the whole stretch.
   */
  private markGap(): Promise<void> {
    if (this.unmarked === 0) return Promise.resolve();
    if (this.marking) return this.marking;
    this.marking = this.writeGapMarker().finally(() => {
      this.marking = null;
    });
    return this.marking;
  }

  private async writeGapMarker(): Promise<void> {
    const lost = this.unmarked;
    const from = this.unmarkedFrom?.toISOString() ?? 'an unknown time';
    const to = this.lastFailureAt?.toISOString() ?? 'an unknown time';
    try {
      await this.repo.record({
        actorEmail: 'system',
        action: 'audit.gap',
        summary:
          `${lost} audit record${lost === 1 ? '' : 's'} could not be written between ${from} and ` +
          `${to} — the actions happened and this trail does not have them`,
        targetType: 'instance',
        targetId: this.instance,
      });
      this.unmarked -= lost;
      if (this.unmarked === 0) this.unmarkedFrom = null;
    } catch (err) {
      this.logger.error(
        `audit gap marker LOST (${lost} records still counted only in this process): ${
          redactDsn((err as Error).message)
        }`,
      );
    }
  }

  list(filter: AuditFilter): Promise<AuditEventRow[]> {
    return this.repo.list(filter);
  }

  /**
   * Since boot, and never cleared — see `AuditHealth.failures`. The message the
   * store failed with is deliberately NOT here: Prisma names the host, the port
   * and the user it could not reach, and this rides an HTTP body. The log line
   * above carries it instead, with its credentials taken out by `redactDsn` —
   * that line is at `error`, so it reaches further than the body ever would.
   *
   * Async since #812, because one of the numbers it answers with is read out of
   * the trail rather than counted in this process. `recording` is the OR of the
   * two: a gap another instance left, or one this instance left before its last
   * restart, is a failing trail whichever process is asked. Nothing about
   * `failures` widened — it is still this instance's count, and now says so.
   *
   * It also takes the one write a read here can make. An operator opening the
   * Audit-log pane is very often the first thing to touch the store after a
   * recovery, so this is where a gap still carried in memory gets its chance to
   * become a row; skip it and the pane reports a gap it could have made durable
   * a second earlier.
   */
  async health(): Promise<AuditHealth> {
    await this.markGap();
    const gaps = await this.readGaps();
    return {
      recording:
        this.failures > 0 || (gaps?.events ?? 0) > 0
          ? 'failing'
          : this.repo.enabled
            ? 'ok'
            : 'disabled',
      failures: this.failures,
      lastFailureAt: this.lastFailureAt?.toISOString() ?? null,
      instance: this.instance,
      since: this.startedAt.toISOString(),
      gaps,
    };
  }

  /** The trail's own account of what is missing, or `null` when the store could
   *  not be asked — which is not the same answer as "nothing is missing", and is
   *  drawn as neither by the pane. */
  private async readGaps(): Promise<AuditGaps | null> {
    try {
      const { events, lastAt } = await this.repo.countGaps();
      return { events, lastAt: lastAt?.toISOString() ?? null };
    } catch (err) {
      this.logger.warn(`audit gap count unavailable: ${redactDsn((err as Error).message)}`);
      return null;
    }
  }
}
