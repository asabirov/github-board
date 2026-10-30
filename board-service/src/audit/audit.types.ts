import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { PrismaClient } from '../generated/prisma/client';

/**
 * Append-only audit trail (#212): who did what across board's write + governance
 * actions. Recording is best-effort (a failed audit write never fails the action);
 * the log is read-only in the admin hub. The `db` backend is Postgres via Prisma;
 * the `disabled` backend stands in when no database is configured (dev/test) —
 * recording is a no-op and the log is simply empty.
 */
export const AUDIT_REPOSITORY = 'AUDIT_REPOSITORY';

/** Machine action keys — one per audited write path. */
export type AuditAction =
  | 'identity.seed'
  | 'identity.upsert'
  | 'goal.team.update'
  | 'identity.role'
  | 'token.mint'
  | 'token.revoke'
  | 'agent.revoke'
  /** No longer written (#1450). The audit log is append-only, and old rows carry it. */
  | 'feedback.submit'
  | 'issue.close'
  | 'issue.state'
  | 'issue.assignees'
  | 'issue.labels'
  | 'issue.milestone'
  | 'issue.body.task'
  /** A reader answered an issue from the board itself, rather than on Github (#693). */
  | 'issue.comment'
  | 'issue.project.add'
  /** A reader made a new Projects v2 project from an issue page (#982). */
  | 'issue.project.create'
  | 'issue.project.remove'
  | 'issue.field'
  | 'repo.dri'
  /** An OAuth2 grant was issued to a client at a code exchange (#456). */
  | 'oauth.grant'
  /** A grant was cut off — by its owner, or by a client calling /revoke (#456). */
  | 'oauth.revoke'
  /**
   * A refresh token was presented after its holder had already spent it, so the
   * whole grant was killed (#456). Distinct from `oauth.revoke` on purpose: this is the
   * only moment board learns a token may have been stolen, and folding it into
   * ordinary revocation would make a theft indistinguishable from a client bug.
   */
  | 'oauth.reuse'
  /**
   * Board filed or commented on a Github issue about its own failed boot (#781).
   * The one write that is on nobody's behalf, so its actor is `system` — see
   * `boot-alert.notifier.ts`. One key for both writes: which of the two it made
   * is a dedupe detail, already in the summary, and the event is the same one.
   */
  | 'boot.alert'
  /**
   * A stretch of records this board could not write, put into the trail once the
   * store came back (#812). Actor `system`, like `boot.alert`: it is board
   * reporting itself, not a person acting.
   *
   * It exists because an in-memory count is the wrong place to keep a hole in an
   * append-only trail. That count dies with the process, so a restart clears it,
   * and it belongs to one process, so a second replica never sees it. A row in
   * the trail is read by whichever instance an operator's request lands on, and
   * is still there tomorrow.
   */
  | 'audit.gap';

export interface RecordAudit {
  actorEmail: string;
  action: AuditAction;
  summary: string;
  targetType?: string | null;
  targetId?: string | null;
}

export interface AuditEventRow {
  id: string;
  at: Date;
  actorEmail: string;
  action: string;
  summary: string;
  targetType: string | null;
  targetId: string | null;
}

export interface AuditFilter {
  /** Substring match on the actor email (case-insensitive). */
  actor?: string;
  /** Exact action key. */
  action?: string;
  limit?: number;
}

/**
 * The one thing a caller outside Nest's injector needs (#781). `AuditService`
 * satisfies it structurally, so `boot-alert.notifier.ts` — a plain function, no
 * DI metadata — can record without importing the service or its module.
 */
export interface AuditRecorder {
  record(e: RecordAudit): Promise<void>;
}

/**
 * Whether the trail is actually holding what it is handed (#781).
 *
 * Three states, because an empty log has three causes and only one of them is
 * "nothing happened": `disabled` is a board with no database, `failing` is a
 * board whose writes are landing on Github and not in Postgres, and `ok` is a
 * board that is genuinely quiet. Before this they rendered one screen.
 */
export interface AuditHealth {
  recording: 'ok' | 'failing' | 'disabled';
  /**
   * Records lost since this process started. It never clears: a transient that
   * already dropped rows left a hole in an append-only trail, and Postgres
   * coming back does not fill it in.
   *
   * It is a count for ONE instance over ONE window, which is why `instance` and
   * `since` travel with it (#812). Read as a claim about the board it is wrong
   * in two directions at once; `gaps` below is the half that is not.
   */
  failures: number;
  /** ISO timestamp of the most recent loss, or null. */
  lastFailureAt: string | null;
  /**
   * Which process `failures` and `lastFailureAt` were counted in (#812), and
   * when that process started — the window they cover, and nothing wider.
   *
   * Before these two the count was reported bare, so a reader took it for the
   * board's. It is not. `deploy/Caddyfile.platform` sends every `/api/*` route
   * to one `{$BOARD_API_UPSTREAM}`, but that variable is set outside this repo
   * and Caddy's `reverse_proxy` takes a list, so a platform that scales board-api
   * would answer from whichever replica it picked; and a rolling deploy is a
   * second replica for the length of the overlap even at a target of one.
   * `docs/ops/board-api-replicas.md` is what this repo can say about that number.
   *
   * The single-replica case has the same hole in it. The count starts at zero
   * every boot, so a board that lost rows at 02:00 and restarted at 02:05
   * reported `ok` at 09:00 with the gap still missing from the trail. Naming the
   * instance and the window does not make the count the board's — it stops a
   * reader believing it was.
   */
  instance: string;
  /** ISO timestamp of `instance`'s start. */
  since: string;
  /**
   * The losses the TRAIL itself carries: `audit.gap` rows, written by any
   * instance whose store came back (#812). Unlike `failures` this survives a
   * restart and is readable from every replica, because it is a row and not a
   * counter.
   *
   * `null` is "the store could not be asked", which is not "none" — the same
   * distinction `AdminEmailCache` draws between an empty read and no read.
   */
  gaps: AuditGaps | null;
}

/** How much of the trail is missing, according to the trail (#812). */
export interface AuditGaps {
  /** `audit.gap` rows in the trail. Each is a stretch of records, not one. */
  events: number;
  /** ISO timestamp of the most recent one, or null when there are none. */
  lastAt: string | null;
}

/** What `GET /api/admin/audit` answers: the rows, and whether to believe them. */
export interface AuditLog {
  events: AuditEventRow[];
  health: AuditHealth;
}

export interface AuditRepository {
  readonly enabled: boolean;
  record(e: RecordAudit): Promise<void>;
  list(f: AuditFilter): Promise<AuditEventRow[]>;
  /**
   * The `audit.gap` rows in the trail, counted rather than listed (#812). Its
   * own method rather than a `list` call because the answer is an aggregate over
   * the whole trail and not the newest page of it — a gap left in March is still
   * a hole today, and must not fall off the end of a 200-row window.
   *
   * Throws like any other store read. `AuditService` turns that into `null`,
   * which is why `AuditHealth.gaps` is nullable.
   */
  countGaps(): Promise<{ events: number; lastAt: Date | null }>;
}

/** Postgres-backed store (Prisma). */
export class PrismaAuditRepository implements AuditRepository {
  readonly enabled = true;
  constructor(private readonly prisma: PrismaClient) {}

  async record(e: RecordAudit): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorEmail: e.actorEmail,
        action: e.action,
        summary: e.summary,
        targetType: e.targetType ?? null,
        targetId: e.targetId ?? null,
      },
    });
  }

  list(f: AuditFilter): Promise<AuditEventRow[]> {
    return this.prisma.auditEvent.findMany({
      where: {
        actorEmail: f.actor ? { contains: f.actor, mode: 'insensitive' } : undefined,
        action: f.action || undefined,
      },
      orderBy: { at: 'desc' },
      take: Math.min(Math.max(f.limit ?? 200, 1), 500),
    });
  }

  async countGaps(): Promise<{ events: number; lastAt: Date | null }> {
    const where = { action: 'audit.gap' };
    const [events, latest] = await Promise.all([
      this.prisma.auditEvent.count({ where }),
      this.prisma.auditEvent.findFirst({ where, orderBy: { at: 'desc' }, select: { at: true } }),
    ]);
    return { events, lastAt: latest?.at ?? null };
  }
}

/** No-DB stand-in: recording is a silent no-op; the log is empty. */
export class DisabledAuditRepository implements AuditRepository {
  readonly enabled = false;
  private readonly logger = new Logger(DisabledAuditRepository.name);
  async record(e: RecordAudit): Promise<void> {
    this.logger.debug(`audit (not persisted — no DB): ${e.action} by ${e.actorEmail}`);
  }
  async list(): Promise<AuditEventRow[]> {
    return [];
  }

  /** Nothing is stored, so nothing is missing from what is stored. `0` and not
   *  `null`: this store was asked, and it answered. */
  async countGaps(): Promise<{ events: number; lastAt: Date | null }> {
    return { events: 0, lastAt: null };
  }
}

/** Thrown only if a caller tries to require persistence explicitly. */
export function auditUnavailable(): never {
  throw new ServiceUnavailableException('Audit log requires a database (IDENTITY_SOURCE=db).');
}
