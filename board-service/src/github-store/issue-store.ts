import { BASELINES_AT_ONCE, DELIVERY_CONNECTIONS, READS_AT_ONCE } from './concurrency';
import { Logger } from '@nestjs/common';
import { Prisma, type PrismaClient } from '../generated/prisma/client';
import { storedIssueOf, type GithubIssueFields, type StoredIssue } from '../issues-metrics/stored-issue';

export const ISSUE_STORE = 'ISSUE_STORE';

/** A repository as the ingest asks about it: Github's immutable id, and the
 *  `owner/name` it was listed under for this read. */
export interface StoreRepo { id: number; full: string }

export interface StoreRead {
  /** Issues per repository id, for exactly the requested repositories the store
   *  may answer for now. A repository absent here is read from Github. */
  served: Map<number, StoredIssue[]>;
  /** Lowercased owners whose installation has delivered an `issues` event in
   *  the last `LIVE_WINDOW_MS`. Only these get a baseline written after a
   *  Github read, because only these can ever be answered from one. */
  liveOwners: Set<string>;
}

export interface WebhookDelivery { id: string; event: string; payload: unknown }

/** `applied` changed what the store holds or may answer for, `ignored` was
 *  recorded and changed nothing, and `duplicate` had been received before. */
export type ReceiveOutcome = 'applied' | 'ignored' | 'duplicate';

/**
 * The webhook store's whole surface (#1007, V5). Github's App webhook writes
 * into it through `receive`, a full Github read of a repository writes a
 * baseline through `baseline`, and the issue ingest reads it through `read`.
 * Nothing else reads it, and `read` answers only for the repository ids it is
 * given, which the ingest takes from the person's own repository list.
 */
export interface IssueStore {
  readonly signal?: IssueStoreSignal | null;
  read(repos: StoreRepo[], now?: number, slotWaitMs?: number): Promise<StoreRead>;
  baseline(repo: StoreRepo, issues: StoredIssue[], startedAt: number, now?: number): Promise<void>;
  receive(delivery: WebhookDelivery, now?: number): Promise<ReceiveOutcome>;
}

/** Per-repository and owner generations, shared across this process only.
 * A snapshot captures the sequence before reading; changes after it stay pending. */
export class IssueStoreSignal {
  generation = 0;
  private readonly repos = new Map<number, number>();
  private readonly owners = new Map<string, number>();

  bump(repos: number[], owners: string[] = []): void {
    this.generation += 1;
    for (const id of repos) this.repos.set(id, this.generation);
    for (const owner of owners) this.owners.set(owner.toLowerCase(), this.generation);
  }

  generationFor(repo: { id?: number; full: string }): number {
    return Math.max(this.repos.get(repo.id ?? 0) ?? 0, this.owners.get(ownerOf(repo.full)) ?? 0);
  }

  changed(repos: { id?: number; full: string }[], since: number): string[] {
    return repos.filter((repo) => this.generationFor(repo) > since).map((repo) => repo.full);
  }
}

interface StoreChanges { repos: number[]; owners: string[] }

type Tx = Prisma.TransactionClient;

interface Account { login?: string | null }
interface Repository { id?: number; full_name?: string; owner?: Account | null }
interface Payload {
  action?: string;
  installation?: { id?: number; account?: Account | null } | null;
  repository?: Repository | null;
  issue?: GithubIssueFields | null;
  changes?: { new_issue?: GithubIssueFields | null; new_repository?: Repository | null } | null;
  repositories_removed?: ({ id?: number; full_name?: string } | null)[] | null;
}
interface Repo { id: bigint; full: string; owner: string }

/** Deliveries are kept a week, well past the window in which Github lets one
 *  be redelivered, then deleted. */
const DELIVERY_RETENTION_MS = 7 * 24 * 3_600_000;
const PRUNE_EVERY_MS = 3_600_000;
/** An owner is live only while its last `issues` delivery is less than a day
 *  old. A webhook that stops arriving, because the secret was rotated on one
 *  side or Active was unticked, then stops the store answering within a day
 *  instead of never. */
export const LIVE_WINDOW_MS = 24 * 3_600_000;
/** Github gives up on a delivery after 10 seconds and does not send it again,
 *  so a delivery waits for its slot inside the process, where it holds no
 *  connection, and its transaction is rolled back at 5, which leaves room
 *  under `WEBHOOK_DEADLINE_MS` for the answer. These two bound a store that is
 *  slow; a store that took the connection and then stopped answering is
 *  bounded only by the deadline above the controller and by `socket_timeout`
 *  on the store's URL, because Prisma checks its own `timeout` between
 *  statements and never during one. The `maxWait` is a guard the delivery slot
 *  keeps from ever being needed: the pool is sized so a delivery that has a
 *  slot always finds a free connection. */
const RECEIVE_TX_OPTIONS = { maxWait: 2_000, timeout: 5_000 };
/** A baseline is nobody's HTTP request, so it keeps the longer budget: one
 *  statement of about a thousand rows for the largest repository. */
const BASELINE_TX_OPTIONS = { maxWait: 2_000, timeout: 7_000 };
/** Query time excludes the in-process slot queue. Prisma also bounds the
 * transaction; the caller deadline covers a driver that stops answering. */
const READ_QUERY_WAIT_MS = 3_000;
const READ_SLOT_WAIT_MS = 10_000;
const READ_TX_OPTIONS = {
  maxWait: 1_000,
  timeout: READ_QUERY_WAIT_MS,
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
};
/** A waiting baseline holds its repository's whole issue list, and while the
 *  store is slow every refresh queues more. Past this many waiting a new one is
 *  skipped: a baseline only ever saves a Github read, and the next read of the
 *  repository offers another. */
const BASELINES_WAITING_MAX = 256;
/** And the same cap on reads waiting for a slot (#1070, S5). A read that never
 *  settles — a connection black-holed by something between here and the store,
 *  which no timeout on either end tears down — frees no slot, and every issues
 *  read after it would otherwise queue a closure that is never removed. Past
 *  this many waiting, a read refuses at once and its caller pages Github, which
 *  is what it does for every other unreadable store. */
const READS_WAITING_MAX = 64;

const iso = (ms: number): string => new Date(ms).toISOString();
const ownerOf = (full: string): string => (full.split('/')[0] ?? '').toLowerCase();
/** A row is only ever replaced by one at least as new by this stamp, so a
 *  stamp far in the future would pin the row against every later delivery. It
 *  is clamped to a little past now: Github's own clock is the source, board's
 *  is the one it is compared against, and the difference between two healthy
 *  ones is minutes at most. Nothing rejects the delivery — the state it carries
 *  is still stored, under a stamp that cannot outlive the truth. */
const FUTURE_SKEW_MS = 5 * 60_000;
const stampOf = (issue: StoredIssue): number => Date.parse(issue.updatedAt ?? '') || 0;
const stampAt = (issue: StoredIssue, now: number): number => Math.min(stampOf(issue), now + FUTURE_SKEW_MS);
const isLive = (lastDeliveryAt: Date, now: number): boolean => now - lastDeliveryAt.getTime() < LIVE_WINDOW_MS;
const isObject = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value);

function idOf(value: unknown): bigint | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null;
}

function repoOf(r: Repository | null | undefined): Repo | null {
  const id = idOf(r?.id);
  const full = r?.full_name;
  if (id === null || typeof full !== 'string' || !full.includes('/')) return null;
  return { id, full, owner: ownerOf(full) };
}

/**
 * Whether the payload has the shape of the event its header names. The HMAC
 * covers the body and not the `X-GitHub-Event` or `X-GitHub-Delivery` header,
 * so without this a captured `issues` delivery sent again under a new id as
 * `installation` or `repository` would uninstall its owner or forget its
 * repository.
 */
function fitsEvent(event: string, p: Payload): boolean {
  switch (event) {
    case 'issues': return isObject(p.issue);
    case 'installation':
    case 'installation_repositories': return p.issue == null && p.repository == null;
    case 'repository': return isObject(p.repository) && p.issue == null;
    default: return true;
  }
}

/** Runs work at most `size` at a time, in process. A caller waiting for a slot
 *  holds no connection, and a slot freed while others wait is handed straight
 *  to the first of them, so the running count does not move. */
class Slots {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly size: number) {}

  get waiting(): number {
    return this.queue.length;
  }

  async run<T>(work: () => Promise<T>, waitMs?: number): Promise<T> {
    if (this.running < this.size) this.running += 1;
    else await new Promise<void>((resolve, reject) => {
      const ready = () => { clearTimeout(timer); resolve(); };
      const timer = waitMs === undefined ? undefined : setTimeout(() => {
        const index = this.queue.indexOf(ready);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error(`the webhook store slot wait exceeded ${waitMs} ms`));
      }, waitMs);
      timer?.unref();
      this.queue.push(ready);
    });
    try {
      return await work();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}

/**
 * The Postgres store, over its own `PrismaClient` on GITHUB_STORE_DATABASE_URL.
 *
 * Every write to one repository takes that repository's advisory lock for the
 * length of its transaction, so a delivery and a baseline of the same
 * repository apply one after the other and the order checks below see each
 * other's rows. An uninstall writes across a whole owner and takes no
 * repository lock; it is ordered against baselines by an owner advisory lock
 * instead, as `baseline` says. Timestamps go to Postgres as UTC ISO strings
 * cast to `timestamp(3)`, the type Prisma gives a `DateTime` and reads back as
 * UTC.
 */
export class PrismaIssueStore implements IssueStore {
  private readonly logger = new Logger(PrismaIssueStore.name);
  private lastPrune = 0;
  private readonly baselines = new Slots(BASELINES_AT_ONCE);
  private readonly reads = new Slots(READS_AT_ONCE);
  private readonly deliveries = new Slots(DELIVERY_CONNECTIONS);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly maxAgeMs: number,
    readonly signal: IssueStoreSignal | null = new IssueStoreSignal(),
  ) {}

  /** Nest calls this on shutdown: the client is this store's own. */
  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }

  /** One snapshot for every query, so a repository forgotten while this runs is
   *  answered with the rows it had or not at all, never as an empty list. At
   *  most `READS_AT_ONCE` run at a time. */
  async read(repos: StoreRepo[], now?: number, slotWaitMs = READ_SLOT_WAIT_MS): Promise<StoreRead> {
    const served = new Map<number, StoredIssue[]>();
    const owners = [...new Set(repos.map((r) => ownerOf(r.full)))];
    if (repos.length === 0) return { served, liveOwners: new Set() };
    if (this.reads.waiting >= READS_WAITING_MAX) {
      throw new Error(`${READS_WAITING_MAX} reads are already waiting for the webhook store`);
    }
    const queuedAt = Date.now();
    let queryAt: number | undefined;
    let timer: NodeJS.Timeout | undefined;
    let expire!: (err: Error) => void;
    const deadline = new Promise<never>((_, reject) => { expire = reject; });
    const work = this.reads.run(() => {
      queryAt = Date.now();
      const readAt = now ?? queryAt;
      timer = setTimeout(() => expire(new Error(`the webhook store's query took longer than ${READ_QUERY_WAIT_MS} ms`)), READ_QUERY_WAIT_MS);
      timer.unref();
      // Keep the slot until the transaction settles, even if the caller times out.
      return this.prisma.$transaction(async (tx) => {
        const coverage = await tx.githubStoredRepo.findMany({ where: { repositoryId: { in: repos.map((r) => BigInt(r.id)) } } });
        const live = (await tx.githubWebhookOwner.findMany({ where: { owner: { in: owners } } }))
          .filter((o) => isLive(o.lastDeliveryAt, readAt));
        const liveSince = new Map(live.map((o) => [o.owner, o.issuesLiveSince.getTime()]));
        const byId = new Map(coverage.map((c) => [Number(c.repositoryId), c]));
        const servable = repos.filter((r) => {
          const c = byId.get(r.id);
          const since = liveSince.get(ownerOf(r.full));
          if (!c || since === undefined) return false;
          const began = c.baselineStartedAt.getTime();
          return since <= began
            && readAt - began < this.maxAgeMs
            && (c.dirtyAt === null || c.dirtyAt.getTime() < began)
            && (c.forgottenAt === null || c.forgottenAt.getTime() < began)
            && c.fullName.toLowerCase() === r.full.toLowerCase();
        });
        for (const r of servable) served.set(r.id, []);
        if (servable.length > 0) {
          const rows = await tx.githubStoredIssue.findMany({
            where: { repositoryId: { in: servable.map((r) => BigInt(r.id)) }, deleted: false },
            select: { repositoryId: true, issue: true },
          });
          for (const row of rows) {
            if (row.issue !== null) served.get(Number(row.repositoryId))?.push(row.issue as unknown as StoredIssue);
          }
          // Newest first, the order Github's list answers in, so a surface cannot
          // tell which source it was handed.
          for (const issues of served.values()) issues.sort((a, b) => b.number - a.number);
        }
        return { served, liveOwners: new Set(liveSince.keys()) };
      }, READ_TX_OPTIONS);
    }, slotWaitMs);
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
      const finishedAt = Date.now();
      const queryMs = queryAt === undefined ? 0 : finishedAt - queryAt;
      const message = `webhook store read: queue wait ${(queryAt ?? finishedAt) - queuedAt} ms, query ${queryMs} ms, ${repos.length} repos requested`;
      if (queryMs >= 2_000) this.logger.warn(message);
      else this.logger.debug(message);
    }
  }

  async baseline(repo: StoreRepo, issues: StoredIssue[], startedAt: number, now = Date.now()): Promise<void> {
    const rid = BigInt(repo.id);
    const owner = ownerOf(repo.full);
    const numbers = issues.map((i) => i.number);
    const began = iso(startedAt);
    if (this.baselines.waiting >= BASELINES_WAITING_MAX) {
      this.logger.warn(
        `${BASELINES_WAITING_MAX} baselines are already waiting for the webhook store, so ${repo.full}'s is skipped ` +
          'and its next read goes to Github too',
      );
      return;
    }
    await this.baselines.run(() => this.prisma.$transaction(async (tx) => {
      await lockRepos(tx, [rid]);
      // An uninstall takes this lock exclusively before it deletes anything,
      // so a baseline that waited reads the owner row gone and writes nothing,
      // and an uninstall that waited deletes what the baseline wrote. Postgres
      // queues advisory lock requests in the order they arrive, so baselines
      // that keep coming cannot hold off an uninstall already waiting, as they
      // could when this was a FOR KEY SHARE on the owner row. Deliveries take
      // no owner lock, so a delivery never waits on a baseline.
      await lockOwnerShared(tx, owner);
      const [held] = await tx.$queryRaw<{ lastDeliveryAt: Date }[]>`
        SELECT "lastDeliveryAt" FROM "GithubWebhookOwner" WHERE "owner" = ${owner}`;
      if (!held || !isLive(held.lastDeliveryAt, now)) return;
      // A read that began before the stored baseline's saw an older list, and
      // would put back an issue the newer one removed. One that began before
      // the repository was forgotten would put back what the forget removed,
      // tombstones included.
      const [stored] = await tx.$queryRaw<{ baselineStartedAt: Date; forgottenAt: Date | null }[]>`
        SELECT "baselineStartedAt", "forgottenAt" FROM "GithubStoredRepo" WHERE "repositoryId" = ${rid}::bigint`;
      if (stored && stored.baselineStartedAt.getTime() > startedAt) return;
      if (stored?.forgottenAt && stored.forgottenAt.getTime() >= startedAt) return;
      const ties = await writeRows(tx, rid, owner, issues, now, startedAt);
      // A row this read did not list goes only when the next read misses it
      // too, because Github's paged list can skip a live issue when another is
      // deleted between two pages. A row written after the read began came
      // from a delivery the read could not see, and is left alone. The listed
      // numbers are matched with NOT EXISTS over unnest: under a generic plan
      // the array is a parameter, and `NOT ("number" = ANY(...))` would
      // compare every row with every listed number.
      await tx.$executeRaw`
        DELETE FROM "GithubStoredIssue" s
        WHERE s."repositoryId" = ${rid}::bigint AND NOT s."deleted"
          AND s."writtenAt" < ${began}::timestamp(3) AND s."missedAt" < ${began}::timestamp(3)
          AND NOT EXISTS (SELECT 1 FROM unnest(${numbers}::int[]) AS listed(n) WHERE listed.n = s."number")`;
      await tx.$executeRaw`
        UPDATE "GithubStoredIssue" s SET "missedAt" = ${iso(now)}::timestamp(3)
        WHERE s."repositoryId" = ${rid}::bigint AND NOT s."deleted"
          AND s."writtenAt" < ${began}::timestamp(3) AND s."missedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM unnest(${numbers}::int[]) AS listed(n) WHERE listed.n = s."number")`;
      await tx.$executeRaw`
        INSERT INTO "GithubStoredRepo" ("repositoryId", "fullName", "owner", "baselineStartedAt", "dirtyAt")
        VALUES (${rid}::bigint, ${repo.full}, ${owner}, ${began}::timestamp(3),
                ${ties > 0 ? iso(now) : null}::timestamp(3))
        ON CONFLICT ("repositoryId") DO UPDATE SET
          "fullName" = EXCLUDED."fullName",
          "owner" = EXCLUDED."owner",
          "baselineStartedAt" = GREATEST("GithubStoredRepo"."baselineStartedAt", EXCLUDED."baselineStartedAt"),
          "dirtyAt" = COALESCE(EXCLUDED."dirtyAt", "GithubStoredRepo"."dirtyAt"),
          "forgottenAt" = NULL`;
    }, BASELINE_TX_OPTIONS));
  }

  /** A delivery writes one issue, and Github sends many of them together, so
   *  they run at most `DELIVERY_CONNECTIONS` at a time like the baselines and
   *  reads do. Without the gate, every concurrent delivery started a
   *  transaction straight away and grabbed a pool connection, so a burst of
   *  more than the two reserved delivery connections exhausted the pool and a
   *  delivery or read that then needed a connection was aborted at its
   *  `maxWait` with "Unable to start a transaction in the given time". With
   *  it, a delivery past the two waits for its slot, holding no connection, and
   *  is answered 503 by the controller's deadline if that wait runs too long. */
  async receive(delivery: WebhookDelivery, now = Date.now()): Promise<ReceiveOutcome> {
    const p = (delivery.payload ?? {}) as Payload;
    const action = typeof p.action === 'string' ? p.action : null;
    const installationId = idOf(p.installation?.id);
    const fits = fitsEvent(delivery.event, p);
    const changes: StoreChanges = { repos: [], owners: [] };
    const outcome = await this.deliveries.run(() => this.prisma.$transaction(async (tx): Promise<ReceiveOutcome> => {
      const recorded = await tx.$executeRaw`
        INSERT INTO "GithubWebhookDelivery" ("id", "event", "action", "installationId", "repositoryId", "receivedAt")
        VALUES (${delivery.id}, ${delivery.event}, ${action}, ${installationId}::bigint,
                ${idOf(p.repository?.id)}::bigint, ${iso(now)}::timestamp(3))
        ON CONFLICT ("id") DO NOTHING`;
      if (recorded === 0) return 'duplicate';
      if (!fits) return 'ignored';
      switch (delivery.event) {
        case 'issues': return this.applyIssues(tx, p, installationId, now, changes);
        case 'installation': return this.applyInstallation(tx, p, installationId, changes);
        case 'installation_repositories': return this.applyRemoved(tx, p, now, changes);
        case 'repository': return this.applyRepository(tx, p, now, changes);
        default: return 'ignored';
      }
    }, RECEIVE_TX_OPTIONS));
    if (outcome === 'applied') this.signal?.bump(changes.repos, changes.owners);
    await this.prune(now);
    return outcome;
  }

  /**
   * An issue changed. The owner is marked live first, because an `issues`
   * delivery from its installation is exactly the proof `read` waits for. A
   * delete or a transfer away leaves a tombstone, and a transfer also writes
   * the issue into the repository it moved to, under that repository's owner.
   */
  private async applyIssues(tx: Tx, p: Payload, installationId: bigint | null, now: number, changes: StoreChanges): Promise<ReceiveOutcome> {
    const repo = repoOf(p.repository);
    const issue = p.issue;
    if (!repo || !issue || typeof issue.number !== 'number' || issue.pull_request) return 'ignored';
    const moved = p.action === 'transferred' ? p.changes?.new_issue : null;
    const target = moved && typeof moved.number === 'number' ? repoOf(p.changes?.new_repository) : null;
    await lockRepos(tx, target ? [repo.id, target.id] : [repo.id]);
    changes.repos.push(Number(repo.id));
    if (target) changes.repos.push(Number(target.id));
    if (installationId !== null && await markLive(tx, repo.owner, installationId, now)) changes.owners.push(repo.owner);
    await forgetIfRenamed(tx, repo, now);
    if (p.action === 'deleted' || p.action === 'transferred') {
      await tombstone(tx, repo, issue.number, Math.min(Date.parse(issue.updated_at ?? '') || now, now + FUTURE_SKEW_MS), now);
      if (target && moved) {
        await forgetIfRenamed(tx, target, now);
        await writeAndMark(tx, target, [storedIssueOf(moved)], now);
      }
    } else {
      await writeAndMark(tx, repo, [storedIssueOf(issue)], now);
    }
    return 'applied';
  }

  /**
   * The App was uninstalled or suspended on an account: nothing more will
   * arrive for it, so it stops being live and what the store held for it goes.
   * Every owner it deletes is locked first, which is what orders this against a
   * baseline (see `baseline`). Its repository rows are deleted outright rather
   * than marked forgotten: the owner lock and the baseline's liveness check
   * already stop a baseline that began before. Issue rows go by owner and not
   * through GithubStoredRepo, because deliveries write rows for repositories no
   * baseline has reached.
   */
  private async applyInstallation(tx: Tx, p: Payload, installationId: bigint | null, changes: StoreChanges): Promise<ReceiveOutcome> {
    if (p.action !== 'deleted' && p.action !== 'suspend') return 'ignored';
    const account = p.installation?.account?.login?.toLowerCase() || null;
    const known = await tx.$queryRaw<{ owner: string }[]>`
      SELECT "owner" FROM "GithubWebhookOwner" WHERE "owner" = ${account} OR "installationId" = ${installationId}::bigint`;
    const owners = [...new Set([...known.map((o) => o.owner), ...(account ? [account] : [])])];
    if (owners.length === 0) return 'ignored';
    changes.owners.push(...owners);
    await lockOwners(tx, owners);
    const removed = (await tx.$executeRaw`DELETE FROM "GithubWebhookOwner" WHERE "owner" = ANY(${owners}::text[])`)
      + (await tx.$executeRaw`DELETE FROM "GithubStoredIssue" WHERE "owner" = ANY(${owners}::text[])`)
      + (await tx.$executeRaw`DELETE FROM "GithubStoredRepo" WHERE "owner" = ANY(${owners}::text[])`);
    // An uninstall of an account the store held nothing of changed nothing, and
    // is reported as what it was. `applied` moved the store's signal, which cost
    // every person's cache a refill for a delivery that touched no row (#1070).
    return removed === 0 ? 'ignored' : 'applied';
  }

  /** Repositories taken out of the installation: no event will describe them
   *  again, so they are forgotten rather than left to go stale. Github names
   *  each one; a payload that does not is filed under the installation's
   *  account, so an uninstall of it still finds the mark. */
  private async applyRemoved(tx: Tx, p: Payload, now: number, changes: StoreChanges): Promise<ReceiveOutcome> {
    if (p.action !== 'removed') return 'ignored';
    const account = p.installation?.account?.login?.toLowerCase() ?? '';
    const repos = (p.repositories_removed ?? []).flatMap((r): Repo[] => {
      const id = idOf(r?.id);
      if (id === null) return [];
      return [repoOf(r) ?? { id, full: '', owner: account }];
    });
    if (repos.length === 0) return 'ignored';
    await lockRepos(tx, repos.map((r) => r.id));
    await forgetRepos(tx, repos, now);
    changes.repos.push(...repos.map((repo) => Number(repo.id)));
    return 'applied';
  }

  /** A repository deleted, renamed, transferred or archived: its baseline is
   *  forgotten and its issue rows go, and the next read of it goes to Github
   *  under whatever name it has now. An archived or transferred one may never
   *  be read under this installation again, and nothing else would remove its
   *  rows. */
  private async applyRepository(tx: Tx, p: Payload, now: number, changes: StoreChanges): Promise<ReceiveOutcome> {
    const repo = repoOf(p.repository);
    if (!repo || !['deleted', 'renamed', 'transferred', 'archived'].includes(p.action ?? '')) return 'ignored';
    await lockRepos(tx, [repo.id]);
    await forgetRepos(tx, [repo], now);
    changes.repos.push(Number(repo.id));
    return 'applied';
  }

  private async prune(now: number): Promise<void> {
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    try {
      await this.prisma.githubWebhookDelivery.deleteMany({ where: { receivedAt: { lt: new Date(now - DELIVERY_RETENTION_MS) } } });
    } catch (err) {
      this.logger.warn(`old webhook deliveries could not be pruned: ${(err as Error).message}`);
    }
  }
}

/** In id order, so two transactions that each lock two repositories cannot
 *  wait on each other. Repository locks are keyed under 1007 and owner locks
 *  under 1008, so a repository id and an owner's hash never meet. */
async function lockRepos(tx: Tx, ids: bigint[]): Promise<void> {
  for (const id of [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(1007, (${id}::bigint % 2147483647)::int)) AS l`;
  }
}

/** A baseline's hold on its owner, which any number of baselines share. */
async function lockOwnerShared(tx: Tx, owner: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock_shared(1008, hashtext(${owner}))) AS l`;
}

/** An uninstall's hold on every owner it deletes, in sorted order, so two
 *  uninstalls that share owners cannot wait on each other. */
async function lockOwners(tx: Tx, owners: string[]): Promise<void> {
  for (const owner of [...new Set(owners)].sort()) {
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(1008, hashtext(${owner}))) AS l`;
  }
}

/** The clock `read` compares baselines with restarts on a new installation id,
 *  and on the first delivery after the owner stopped being live. */
async function markLive(tx: Tx, owner: string, installationId: bigint, now: number): Promise<boolean> {
  const [live] = await tx.$queryRaw<{ issuesLiveSince: Date }[]>`
    INSERT INTO "GithubWebhookOwner" ("owner", "installationId", "issuesLiveSince", "lastDeliveryAt")
    VALUES (${owner}, ${installationId}::bigint, ${iso(now)}::timestamp(3), ${iso(now)}::timestamp(3))
    ON CONFLICT ("owner") DO UPDATE SET
      "lastDeliveryAt" = EXCLUDED."lastDeliveryAt",
      "issuesLiveSince" = CASE WHEN "GithubWebhookOwner"."installationId" = EXCLUDED."installationId"
                                 AND "GithubWebhookOwner"."lastDeliveryAt" > ${iso(now - LIVE_WINDOW_MS)}::timestamp(3)
                               THEN "GithubWebhookOwner"."issuesLiveSince" ELSE EXCLUDED."issuesLiveSince" END,
      "installationId" = EXCLUDED."installationId"
    RETURNING "issuesLiveSince"`;
  return live.issuesLiveSince.getTime() === now;
}

/** A delivery naming the repository differently from its baseline means it was
 *  renamed or moved: the baseline is forgotten, and the next read starts a new
 *  one. A baseline already forgotten keeps the time it was first forgotten, so
 *  the deliveries that go on arriving under the new name do not refuse, one
 *  after another, every baseline begun since. */
async function forgetIfRenamed(tx: Tx, repo: Repo, now: number): Promise<void> {
  await tx.$executeRaw`
    UPDATE "GithubStoredRepo" SET "forgottenAt" = ${iso(now)}::timestamp(3)
    WHERE "repositoryId" = ${repo.id}::bigint AND lower("fullName") <> lower(${repo.full})
      AND ("forgottenAt" IS NULL OR "forgottenAt" < "baselineStartedAt")`;
}

/** Marks each repository forgotten, writing the mark for one no baseline has
 *  reached, and deletes its issue rows. The mark rather than a delete is what
 *  stops a baseline that began before this from writing them back. */
async function forgetRepos(tx: Tx, repos: Repo[], now: number): Promise<void> {
  const unique = [...new Map(repos.map((r) => [r.id, r])).values()];
  const ids = unique.map((r) => String(r.id));
  // Issue rows before the repository row, the order an uninstall deletes them
  // in, so the two cannot each hold a row the other is waiting for.
  await tx.$executeRaw`DELETE FROM "GithubStoredIssue" WHERE "repositoryId" = ANY(${ids}::text[]::bigint[])`;
  await tx.$executeRaw`
    INSERT INTO "GithubStoredRepo" ("repositoryId", "fullName", "owner", "baselineStartedAt", "forgottenAt")
    SELECT f."repositoryId", f."fullName", f."owner", ${iso(now)}::timestamp(3), ${iso(now)}::timestamp(3)
    FROM unnest(${ids}::text[]::bigint[], ${unique.map((r) => r.full)}::text[], ${unique.map((r) => r.owner)}::text[])
      AS f("repositoryId", "fullName", "owner")
    ON CONFLICT ("repositoryId") DO UPDATE SET
      "forgottenAt" = GREATEST("GithubStoredRepo"."forgottenAt", EXCLUDED."forgottenAt")`;
}

async function tombstone(tx: Tx, repo: Repo, number: number, updatedAt: number, now: number): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "GithubStoredIssue" ("repositoryId", "number", "owner", "updatedAt", "deleted", "issue", "writtenAt")
    VALUES (${repo.id}::bigint, ${number}::int, ${repo.owner}, ${iso(updatedAt)}::timestamp(3), true, NULL,
            ${iso(now)}::timestamp(3))
    ON CONFLICT ("repositoryId", "number") DO UPDATE SET
      "deleted" = true,
      "issue" = NULL,
      "owner" = EXCLUDED."owner",
      "updatedAt" = GREATEST("GithubStoredIssue"."updatedAt", EXCLUDED."updatedAt"),
      "writtenAt" = EXCLUDED."writtenAt",
      "missedAt" = NULL`;
}

async function writeAndMark(tx: Tx, repo: Repo, rows: StoredIssue[], now: number): Promise<void> {
  const ties = await writeRows(tx, repo.id, repo.owner, rows, now);
  if (ties > 0) {
    await tx.$executeRaw`UPDATE "GithubStoredRepo" SET "dirtyAt" = ${iso(now)}::timestamp(3) WHERE "repositoryId" = ${repo.id}::bigint`;
  }
}

/**
 * Upsert issues, newest wins, and count the ties that cannot be ordered.
 *
 * A row is replaced only by one at least as new by Github's `updated_at`, so
 * arrival order decides nothing. `updated_at` has one-second resolution, though,
 * and two changes in the same second carry the same stamp. When a write meets a
 * row with the same stamp and different content, nothing says which came last.
 * The write still lands, and the count it returns makes the caller mark the
 * repository dirty, which sends its next read to Github instead of trusting
 * either. The count and the upsert read one snapshot, so the count sees the row
 * as it was before this write.
 *
 * `readBegan` is a full Github read's start, and only a baseline passes one; a
 * delivery passes null, and nothing below changes for it. It buys a baseline
 * exactly two powers over a row written before its read began, and both are
 * ways back from a state no delivery and no other read can repair (#1070, S1
 * and S2):
 *
 * - it lifts a tombstone. Github's list at `readBegan` said the issue exists,
 *   which a delete or transfer board read out of a payload it should not have
 *   would otherwise hide from everybody, for that repository, forever.
 * - it replaces a row whose stored stamp is past `now + FUTURE_SKEW_MS`, which
 *   no healthy Github clock can produce and which every later write compares
 *   itself against and loses to.
 *
 * A row that is neither keeps the ordinary rule, so a list that lags a delivery
 * board already took cannot put the older state back. A delivery that landed
 * after the read began wrote `writtenAt >= readBegan` and is left alone either
 * way.
 *
 * A row the write would leave as it was is not rewritten, so its `writtenAt`
 * keeps saying when it last changed. It is rewritten anyway when a baseline had
 * marked it missed, to clear that mark, or when it is filed under another owner.
 *
 * Rows are first reduced to one per number, the newest, because a page of a
 * paginated list can repeat an issue when a new one shifts the pages mid-read,
 * and Postgres refuses an upsert that touches one row twice.
 */
async function writeRows(
  tx: Tx,
  rid: bigint,
  owner: string,
  rows: StoredIssue[],
  now: number,
  readBegan: number | null = null,
): Promise<number> {
  const latest = new Map<number, StoredIssue>();
  for (const row of rows) {
    const held = latest.get(row.number);
    if (!held || stampOf(row) >= stampOf(held)) latest.set(row.number, row);
  }
  if (latest.size === 0) return 0;
  const records = JSON.stringify([...latest.values()].map((issue) => ({ number: issue.number, updatedAt: iso(stampAt(issue, now)), issue })));
  const began = readBegan === null ? null : iso(readBegan);
  const future = iso(now + FUTURE_SKEW_MS);
  const [result] = await tx.$queryRaw<{ ties: bigint }[]>`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${records}::jsonb) AS x("number" int, "updatedAt" timestamp(3), "issue" jsonb)
    ), ties AS (
      SELECT count(*) AS n FROM "GithubStoredIssue" s JOIN incoming i ON s."number" = i."number"
      WHERE s."repositoryId" = ${rid}::bigint AND NOT s."deleted"
        AND s."updatedAt" = i."updatedAt" AND s."issue" IS DISTINCT FROM i."issue"
    ), written AS (
      INSERT INTO "GithubStoredIssue" ("repositoryId", "number", "owner", "updatedAt", "deleted", "issue", "writtenAt")
      SELECT ${rid}::bigint, "number", ${owner}::text, "updatedAt", false, "issue", ${iso(now)}::timestamp(3) FROM incoming
      ON CONFLICT ("repositoryId", "number") DO UPDATE SET
        "owner" = EXCLUDED."owner", "updatedAt" = EXCLUDED."updatedAt", "issue" = EXCLUDED."issue",
        "deleted" = false, "writtenAt" = EXCLUDED."writtenAt", "missedAt" = NULL
      WHERE (("GithubStoredIssue"."writtenAt" < ${began}::timestamp(3)
               AND ("GithubStoredIssue"."deleted" OR "GithubStoredIssue"."updatedAt" > ${future}::timestamp(3)))
             OR (NOT "GithubStoredIssue"."deleted" AND "GithubStoredIssue"."updatedAt" <= EXCLUDED."updatedAt"))
        AND ("GithubStoredIssue"."deleted"
             OR "GithubStoredIssue"."updatedAt" IS DISTINCT FROM EXCLUDED."updatedAt"
             OR "GithubStoredIssue"."issue" IS DISTINCT FROM EXCLUDED."issue"
             OR "GithubStoredIssue"."missedAt" IS NOT NULL
             OR "GithubStoredIssue"."owner" <> EXCLUDED."owner")
    )
    SELECT n AS ties FROM ties`;
  return Number(result?.ties ?? 0);
}
