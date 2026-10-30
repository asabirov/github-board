import { STORE_CONNECTIONS } from './concurrency';
import { createPrismaClient } from '../prisma';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PrismaClient, type Prisma } from '../generated/prisma/client';
import { IssueStoreSignal, LIVE_WINDOW_MS, PrismaIssueStore, type StoreRepo, type WebhookDelivery } from './issue-store';
import { storedIssueOf, type GithubIssueFields } from '../issues-metrics/stored-issue';

/**
 * The webhook store against real Postgres (#1007, V5).
 *
 * Everything that makes the store safe to answer from is SQL: the upsert that
 * lets only a newer state land, the tombstone nothing lifts, the count of ties
 * that cannot be ordered, the insert that makes a delivery apply once, the
 * delete a baseline runs over what two reads in a row did not list, and the
 * locks that order a delivery, a baseline and an uninstall. None of it can be
 * proved over a fake, so it is proved here. Time is passed in rather than read,
 * so a delivery "arriving late" is one whose `updated_at` is older than a row
 * the store already holds.
 *
 * Each test takes repositories and owners no other test uses, so the tests
 * cannot see each other's rows in the run's shared schema. The lock tests hold
 * a lock from a second client, `other`, which is a second connection.
 */

const prisma = createPrismaClient();
const other = createPrismaClient();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const store = new PrismaIssueStore(prisma, HOUR);
const T0 = Date.parse('2026-09-11T10:00:00.000Z');
const at = (minutes: number) => T0 + minutes * 60_000;

let seq = 0;
interface Repo extends StoreRepo { owner: string }
function freshRepo(owner = `owner-${process.pid}-${++seq}`): Repo {
  return { id: 1_000_000 + ++seq, full: `${owner}/repo-${seq}`, owner };
}

function issue(number: number, title: string, updatedMinutes: number, over: Partial<GithubIssueFields> = {}): GithubIssueFields {
  return {
    number,
    title,
    html_url: `https://github.com/x/y/issues/${number}`,
    state: 'open',
    created_at: '2026-09-01T00:00:00Z',
    updated_at: new Date(at(updatedMinutes)).toISOString(),
    user: { login: 'someone' },
    assignees: [],
    labels: [{ name: 'bug' }],
    milestone: null,
    body: '',
    ...over,
  };
}

function delivery(repo: Repo, action: string, body: GithubIssueFields, installation = 42, id = `delivery-${process.pid}-${++seq}`): WebhookDelivery {
  return {
    id,
    event: 'issues',
    payload: {
      action,
      installation: { id: installation },
      repository: { id: repo.id, full_name: repo.full, owner: { login: repo.owner } },
      issue: body,
    },
  };
}

/** `number:title` for each issue the store answers for `repo` at `now`, or
 *  null when it would send the read to Github. */
async function answered(repo: StoreRepo, now: number): Promise<string[] | null> {
  const read = await store.read([repo], now);
  return read.served.get(repo.id)?.map((i) => `${i.number}:${i.title}`) ?? null;
}

async function row(repo: StoreRepo, number: number) {
  return prisma.githubStoredIssue.findUnique({ where: { repositoryId_number: { repositoryId: BigInt(repo.id), number } } });
}

/** An owner the webhook has reached, and a baseline of `issues` begun at `began`. */
async function liveWithBaseline(repo: Repo, issues: GithubIssueFields[], began: number): Promise<void> {
  expect(await store.receive(delivery(repo, 'labeled', issues[0] ?? issue(1, 'first', 0)), began - 60_000)).toBe('applied');
  await store.baseline(repo, issues.map(storedIssueOf), began, began);
}

function repositoryEvent(repo: Repo, action: string): WebhookDelivery {
  return {
    id: `repository-${process.pid}-${++seq}`,
    event: 'repository',
    payload: { action, installation: { id: 42 }, repository: { id: repo.id, full_name: repo.full, owner: { login: repo.owner } } },
  };
}

function uninstall(owner: string, installation: number): WebhookDelivery {
  return {
    id: `uninstall-${process.pid}-${++seq}`,
    event: 'installation',
    payload: { action: 'deleted', installation: { id: installation, account: { login: owner } } },
  };
}

/** The repository taken out of installation 42, named the way Github names it. */
function removal(repo: Repo): WebhookDelivery {
  return {
    id: `removed-${process.pid}-${++seq}`,
    event: 'installation_repositories',
    payload: { action: 'removed', installation: { id: 42 }, repositories_removed: [{ id: repo.id, full_name: repo.full }] },
  };
}

function transfer(from: Repo, to: Repo, number: number, movedTo: number, updatedMinutes: number, installation = 42): WebhookDelivery {
  const moved = delivery(from, 'transferred', issue(number, 'moving', updatedMinutes), installation);
  (moved.payload as Record<string, unknown>).changes = {
    new_issue: issue(movedTo, 'moving', updatedMinutes),
    new_repository: { id: to.id, full_name: to.full, owner: { login: to.owner } },
  };
  return moved;
}

const storedRepo = (repo: StoreRepo) => prisma.githubStoredRepo.findUnique({ where: { repositoryId: BigInt(repo.id) } });
const ownerRow = (owner: string) => prisma.githubWebhookOwner.findUnique({ where: { owner } });
const rowCount = (repo: StoreRepo) => prisma.githubStoredIssue.count({ where: { repositoryId: BigInt(repo.id) } });

/** Runs `take` in a transaction on the second connection and keeps that
 *  transaction open, with whatever it locked, until `release` commits it. A
 *  test that fails before releasing is released after it, so its lock cannot
 *  hold up the tests that follow. */
const holds = new Set<() => Promise<void>>();
async function holding(take: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<{ release: () => Promise<void> }> {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let taken!: () => void;
  let failed!: (err: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { taken = resolve; failed = reject; });
  const open = other.$transaction(async (tx) => {
    await take(tx);
    taken();
    await done;
  }, { timeout: 25_000 });
  open.catch(failed);
  await ready;
  const release = async () => {
    holds.delete(release);
    finish();
    await open;
  };
  holds.add(release);
  return { release };
}

afterEach(async () => {
  for (const release of [...holds]) await release();
});

/** The repository's advisory lock, taken the way the store takes it. */
const repoLock = (repo: StoreRepo) => (tx: Prisma.TransactionClient) =>
  tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(1007, (${BigInt(repo.id)}::bigint % 2147483647)::int)) AS l`;

/** The owner's advisory lock, taken exclusively the way an uninstall takes it. */
const ownerLock = (owner: string) => (tx: Prisma.TransactionClient) =>
  tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(1008, hashtext(${owner}))) AS l`;

/** A client on the run's database whose pool holds only `connections`. */
function poolOf(connections: number): PrismaClient {
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.searchParams.set('connection_limit', String(connections));
  return createPrismaClient(url.toString());
}

/** Resolve when the promise settles or the deadline expires, without holding test locks longer. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    const settled = () => { clearTimeout(timer); resolve(true); };
    promise.then(settled, settled);
  });
}

afterAll(async () => {
  await prisma.$disconnect();
  await other.$disconnect();
});

describe('a delivery applies once, and the newest state wins (#1007, V5)', () => {
  it('applies a delivery id once: a second copy, even with other content, changes nothing', async () => {
    const repo = freshRepo();
    expect(await store.receive(delivery(repo, 'opened', issue(1, 'first', 1), 42, `dup-${seq}`), at(1))).toBe('applied');
    expect(await store.receive(delivery(repo, 'edited', issue(1, 'second', 2), 42, `dup-${seq}`), at(2))).toBe('duplicate');
    expect((await row(repo, 1))?.issue).toMatchObject({ title: 'first' });
  });

  it('applies exactly one of two copies of a delivery that arrive together', async () => {
    const repo = freshRepo();
    const id = `together-${seq}`;
    const outcomes = await Promise.all([
      store.receive(delivery(repo, 'opened', issue(1, 'a', 1), 42, id), at(1)),
      store.receive(delivery(repo, 'opened', issue(1, 'a', 1), 42, id), at(1)),
    ]);
    expect(outcomes.sort()).toEqual(['applied', 'duplicate']);
  });

  it('keeps the newer state when an older one arrives after it', async () => {
    const repo = freshRepo();
    await store.receive(delivery(repo, 'edited', issue(1, 'newer', 5)), at(6));
    await store.receive(delivery(repo, 'edited', issue(1, 'older', 3)), at(7));
    expect((await row(repo, 1))?.issue).toMatchObject({ title: 'newer' });
  });

  it('marks the repository dirty when two different states carry one timestamp, and answers it again after a new baseline', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'base', 1)], at(2));
    expect(await answered(repo, at(3))).toEqual(['1:base']);
    await store.receive(delivery(repo, 'edited', issue(1, 'A', 4)), at(5));
    await store.receive(delivery(repo, 'labeled', issue(1, 'B', 4)), at(5.5));
    expect(await answered(repo, at(6))).toBeNull();
    await store.baseline(repo, [storedIssueOf(issue(1, 'B', 4))], at(7), at(7));
    expect(await answered(repo, at(8))).toEqual(['1:B']);
  });

  it('does not mark anything dirty when the same state arrives twice under two ids', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'base', 1)], at(2));
    await store.receive(delivery(repo, 'edited', issue(1, 'same', 4)), at(5));
    await store.receive(delivery(repo, 'edited', issue(1, 'same', 4)), at(5.5));
    expect(await answered(repo, at(6))).toEqual(['1:same']);
  });
});

describe('a deleted issue stays deleted (#1007, V5)', () => {
  it('leaves a tombstone that no late event and no read that began before the delete brings back', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'keep', 1), issue(2, 'doomed', 1)], at(2));
    await store.receive(delivery(repo, 'deleted', issue(2, 'doomed', 5)), at(5));
    await store.receive(delivery(repo, 'edited', issue(2, 'late edit', 4)), at(6));
    // Begun at at(4), before the delete: its list saw the issue alive because it
    // still was, and it says nothing about what happened at at(5).
    await store.baseline(repo, [issue(1, 'keep', 1), issue(2, 'listed before the delete', 4)].map(storedIssueOf), at(4), at(7));
    expect((await row(repo, 2))?.deleted).toBe(true);
    expect(await answered(repo, at(8))).toEqual(['1:keep']);
  });

  /**
   * The way back out of a tombstone board should never have written (#1070, S1).
   *
   * Before this, nothing repaired one: a later delivery could not, a full read
   * could not, and "Sync now" — which the doc calls the catch-up a person can
   * run — could not either. Any delivery board read as a delete or a transfer
   * and should not have, a payload shape that changed under it or a transfer
   * whose new repository the App cannot see, hid that issue from every person
   * who can see the repository, for that repository, permanently. Only dropping
   * the store's volume cleared it.
   *
   * A full read that BEGAN AFTER the tombstone was written is the one thing that
   * can say it was wrong: Github listed the issue as existing at a moment board
   * had already recorded it gone.
   */
  it('lets a full read that began after the tombstone bring the issue back, which is what Sync now runs', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'keep', 1), issue(2, 'wrongly deleted', 1)], at(2));
    expect(await store.receive(delivery(repo, 'deleted', issue(2, 'wrongly deleted', 5)), at(5))).toBe('applied');
    expect(await answered(repo, at(6))).toEqual(['1:keep']);
    await store.baseline(repo, [issue(1, 'keep', 1), issue(2, 'wrongly deleted', 6)].map(storedIssueOf), at(7), at(7));
    expect((await row(repo, 2))?.deleted).toBe(false);
    expect(await answered(repo, at(8))).toEqual(['2:wrongly deleted', '1:keep']);
  });

  it('tombstones a transferred issue where it was and writes it where it went', async () => {
    const from = freshRepo();
    const to = freshRepo(from.owner);
    await liveWithBaseline(from, [issue(1, 'moving', 1)], at(2));
    const moved = delivery(from, 'transferred', issue(1, 'moving', 3));
    (moved.payload as Record<string, unknown>).changes = {
      new_issue: issue(9, 'moving', 3),
      new_repository: { id: to.id, full_name: to.full, owner: { login: to.owner } },
    };
    expect(await store.receive(moved, at(3))).toBe('applied');
    expect((await row(from, 1))?.deleted).toBe(true);
    expect((await row(to, 9))?.issue).toMatchObject({ title: 'moving' });
  });
});

/**
 * A stamp no clock produced (#1070, S2).
 *
 * Every write is refused unless it is at least as new as the row it meets, by
 * Github's own `updated_at`. One row stamped far enough ahead therefore beats
 * every later write forever: the repository went on being answered from the
 * store, with that row's content, and no delivery, no full read and no board
 * action changed it. Two things close it — the stamp is clamped on the way in,
 * and a full read may replace a row already stamped past what any clock can
 * justify.
 */
describe('a stamp Github could not have meant (#1070, S2)', () => {
  it('clamps a stamp far in the future on the way in, so the next real delivery still lands', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'base', 1)], at(2));
    const fromTheFuture = issue(1, 'from the year 3000', 1, { updated_at: '3000-01-01T00:00:00.000Z' });
    expect(await store.receive(delivery(repo, 'edited', fromTheFuture), at(5))).toBe('applied');
    expect((await row(repo, 1))?.issue).toMatchObject({ title: 'from the year 3000' });
    // Stored under a stamp a few minutes ahead of when it arrived, not in 3000.
    expect((await row(repo, 1))?.updatedAt.getTime()).toBe(at(10));
    // So an ordinary delivery after the skew window replaces it, as it should.
    expect(await store.receive(delivery(repo, 'edited', issue(1, 'the truth', 12)), at(12))).toBe('applied');
    expect((await row(repo, 1))?.issue).toMatchObject({ title: 'the truth' });
    expect(await answered(repo, at(13))).toEqual(['1:the truth']);
  });

  it('lets a full read replace a row already stamped past every clock, which nothing else could', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'base', 1)], at(2));
    // The row as a delivery taken before the clamp left it.
    await prisma.githubStoredIssue.update({
      where: { repositoryId_number: { repositoryId: BigInt(repo.id), number: 1 } },
      data: { updatedAt: new Date('3000-01-01T00:00:00.000Z') },
    });
    // A delivery cannot: it is older than what is stored, and always will be.
    expect(await store.receive(delivery(repo, 'edited', issue(1, 'the truth', 6)), at(6))).toBe('applied');
    expect((await row(repo, 1))?.issue).toMatchObject({ title: 'base' });
    // A full read begun after the row was written can.
    await store.baseline(repo, [issue(1, 'the truth', 6)].map(storedIssueOf), at(7), at(7));
    expect((await row(repo, 1))?.issue).toMatchObject({ title: 'the truth' });
    expect((await row(repo, 1))?.updatedAt.getTime()).toBe(at(6));
    expect(await answered(repo, at(8))).toEqual(['1:the truth']);
  });
});

describe('when the store may answer at all (#1007, V5)', () => {
  it('answers nothing for an owner no issues delivery has reached, nor from a baseline begun before one did', async () => {
    const repo = freshRepo();
    await store.baseline(repo, [storedIssueOf(issue(1, 'a', 0))], at(1), at(1));
    expect(await answered(repo, at(2))).toBeNull();
    await store.receive(delivery(repo, 'labeled', issue(1, 'a', 0)), at(3));
    expect(await answered(repo, at(4))).toBeNull();
    await store.baseline(repo, [storedIssueOf(issue(1, 'a', 0))], at(5), at(5));
    expect(await answered(repo, at(6))).toEqual(['1:a']);
  });

  it('stops answering once the baseline is older than the max age', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'a', 0)], at(1));
    expect(await answered(repo, at(1) + HOUR - 1)).toEqual(['1:a']);
    expect(await answered(repo, at(1) + HOUR)).toBeNull();
  });

  it('answers only for the repository ids it is asked about', async () => {
    const mine = freshRepo();
    const theirs = freshRepo(mine.owner);
    await liveWithBaseline(mine, [issue(1, 'mine', 0)], at(1));
    await store.baseline(theirs, [storedIssueOf(issue(1, 'theirs', 0))], at(1), at(1));
    expect(await answered(theirs, at(2))).toEqual(['1:theirs']);
    const read = await store.read([mine], at(2));
    expect([...read.served.keys()]).toEqual([mine.id]);
  });

  it('does not answer an id asked for under another name, and a delivery under a new name forgets the baseline', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'a', 0)], at(1));
    expect(await answered({ id: repo.id, full: `${repo.owner}/renamed` }, at(2))).toBeNull();
    await store.receive(delivery({ ...repo, full: `${repo.owner}/renamed` }, 'edited', issue(1, 'a', 3)), at(3));
    expect((await storedRepo(repo))?.forgottenAt?.getTime()).toBe(at(3));
    expect(await answered(repo, at(4))).toBeNull();
    // A second delivery under the new name leaves the forget where it was, so
    // it cannot refuse a baseline begun between the two.
    await store.receive(delivery({ ...repo, full: `${repo.owner}/renamed` }, 'labeled', issue(1, 'a', 3)), at(5));
    expect((await storedRepo(repo))?.forgottenAt?.getTime()).toBe(at(3));
  });

  it('restarts the clock when the owner delivers from a new installation', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'a', 0)], at(1));
    expect(await answered(repo, at(2))).toEqual(['1:a']);
    await store.receive(delivery(repo, 'labeled', issue(1, 'a', 0), 43), at(3));
    expect(await answered(repo, at(4))).toBeNull();
  });

  it('stops counting an owner as live a day after its last delivery, and a delivery after that restarts the clock', async () => {
    const repo = freshRepo();
    const last = at(0);
    await store.receive(delivery(repo, 'opened', issue(1, 'a', 0)), last);
    // A baseline young enough for the one-hour max age at the moment liveness runs out.
    const began = last + LIVE_WINDOW_MS - 30 * 60_000;
    await store.baseline(repo, [storedIssueOf(issue(1, 'a', 0))], began, began);
    const before = await store.read([repo], last + LIVE_WINDOW_MS - 1);
    expect(before.served.has(repo.id)).toBe(true);
    expect(before.liveOwners.has(repo.owner)).toBe(true);
    const after = await store.read([repo], last + LIVE_WINDOW_MS);
    expect(after.served.has(repo.id)).toBe(false);
    expect(after.liveOwners.has(repo.owner)).toBe(false);
    await store.receive(delivery(repo, 'labeled', issue(1, 'a', 0)), last + LIVE_WINDOW_MS + 1);
    expect((await ownerRow(repo.owner))?.issuesLiveSince.getTime()).toBe(last + LIVE_WINDOW_MS + 1);
    expect(await answered(repo, last + LIVE_WINDOW_MS + 2)).toBeNull();
  });

  it('keeps the clock when the next delivery arrives inside the day', async () => {
    const repo = freshRepo();
    await store.receive(delivery(repo, 'opened', issue(1, 'a', 0)), at(0));
    await store.receive(delivery(repo, 'labeled', issue(1, 'a', 0)), at(0) + LIVE_WINDOW_MS - 1);
    const owner = await ownerRow(repo.owner);
    expect(owner?.issuesLiveSince.getTime()).toBe(at(0));
    expect(owner?.lastDeliveryAt.getTime()).toBe(at(0) + LIVE_WINDOW_MS - 1);
  });

  it('answers from one snapshot, so a forget that commits between its queries does not empty a covered repository', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'a', 0)], at(1));
    // Commits a forget of the repository on the second connection straight
    // after `read`'s first query, the coverage one, has answered.
    let forget: (() => Promise<unknown>) | null = () => other.$transaction([
      other.githubStoredIssue.deleteMany({ where: { repositoryId: BigInt(repo.id) } }),
      other.githubStoredRepo.deleteMany({ where: { repositoryId: BigInt(repo.id) } }),
    ]);
    const racing = prisma.$extends({
      query: {
        githubStoredRepo: {
          async findMany({ args, query }) {
            const rows = await query(args);
            const pending = forget;
            forget = null;
            if (pending) await pending();
            return rows;
          },
        },
      },
    });
    const racy = new PrismaIssueStore(racing as unknown as PrismaClient, HOUR);
    const read = await racy.read([repo], at(2));
    expect(forget).toBeNull();
    expect(await rowCount(repo)).toBe(0);
    expect(read.served.get(repo.id)?.map((i) => i.title)).toEqual(['a']);
  });
});

describe('when a baseline writes nothing (#1007, V5)', () => {
  it('writes nothing for an owner no delivery has reached, nor for one whose last delivery is a day old', async () => {
    const never = freshRepo();
    await store.baseline(never, [storedIssueOf(issue(1, 'a', 0))], at(1), at(1));
    expect(await rowCount(never)).toBe(0);
    expect(await storedRepo(never)).toBeNull();

    const quiet = freshRepo();
    await store.receive(delivery(quiet, 'opened', issue(1, 'a', 0)), at(0));
    await store.baseline(quiet, [storedIssueOf(issue(2, 'b', 0))], at(0) + LIVE_WINDOW_MS, at(0) + LIVE_WINDOW_MS);
    expect(await row(quiet, 2)).toBeNull();
    expect(await storedRepo(quiet)).toBeNull();
  });

  it('writes nothing when a newer baseline committed first, so read serves the newer set', async () => {
    const repo = freshRepo();
    await store.receive(delivery(repo, 'opened', issue(1, 'a', 0)), at(0));
    await store.baseline(repo, [storedIssueOf(issue(1, 'newer title', 4))], at(5), at(6));
    await store.baseline(repo, [issue(1, 'older title', 2), issue(2, 'deleted since', 2)].map(storedIssueOf), at(3), at(7));
    expect(await row(repo, 2)).toBeNull();
    expect((await storedRepo(repo))?.baselineStartedAt.getTime()).toBe(at(5));
    expect(await answered(repo, at(8))).toEqual(['1:newer title']);
  });

  it('writes nothing after an uninstall, from a read that began before it', async () => {
    const repo = freshRepo();
    const installation = 700 + ++seq;
    await store.receive(delivery(repo, 'opened', issue(1, 'a', 0), installation), at(0));
    const began = at(1);
    expect(await store.receive(uninstall(repo.owner, installation), at(2))).toBe('applied');
    await store.baseline(repo, [storedIssueOf(issue(2, 'b', 0))], began, at(3));
    expect(await rowCount(repo)).toBe(0);
    expect(await storedRepo(repo)).toBeNull();
  });

  it('waits for an uninstall in flight, then writes nothing', async () => {
    const repo = freshRepo();
    await store.receive(delivery(repo, 'opened', issue(1, 'a', 0)), at(0));
    // The uninstall's owner lock and its first delete, left uncommitted.
    const uninstalling = await holding(async (tx) => {
      await ownerLock(repo.owner)(tx);
      await tx.$executeRaw`DELETE FROM "GithubWebhookOwner" WHERE "owner" = ${repo.owner}`;
    });
    const written = store.baseline(repo, [storedIssueOf(issue(2, 'b', 0))], at(1), at(1));
    expect(await settlesWithin(written, 300)).toBe(false);
    await uninstalling.release();
    await written;
    expect(await row(repo, 2)).toBeNull();
    expect(await storedRepo(repo)).toBeNull();
  });
});

describe('locks and connections (#1007, V5)', () => {
  it('makes a delivery wait for the repository advisory lock', async () => {
    const repo = freshRepo();
    const lock = await holding(repoLock(repo));
    const received = store.receive(delivery(repo, 'opened', issue(1, 'a', 1)), at(1));
    expect(await settlesWithin(received, 300)).toBe(false);
    await lock.release();
    expect(await received).toBe('applied');
  });

  it('makes a baseline wait for the repository advisory lock', async () => {
    const repo = freshRepo();
    await store.receive(delivery(repo, 'opened', issue(1, 'a', 0)), at(0));
    const lock = await holding(repoLock(repo));
    const written = store.baseline(repo, [storedIssueOf(issue(2, 'b', 0))], at(1), at(1));
    expect(await settlesWithin(written, 300)).toBe(false);
    await lock.release();
    await written;
    expect((await row(repo, 2))?.issue).toMatchObject({ title: 'b' });
  });

  it('lets a delivery for another repository of the owner through while a baseline holds the owner lock', async () => {
    const repo = freshRepo();
    const sibling = freshRepo(repo.owner);
    await store.receive(delivery(repo, 'opened', issue(1, 'a', 0)), at(0));
    // Holding issue 1 stops the baseline at its upsert, after it has taken the owner lock.
    const issueLock = await holding((tx) => tx.$queryRaw`
      SELECT 1 AS held FROM "GithubStoredIssue" WHERE "repositoryId" = ${BigInt(repo.id)}::bigint AND "number" = 1 FOR UPDATE`);
    const written = store.baseline(repo, [storedIssueOf(issue(1, 'changed', 1))], at(1), at(1));
    expect(await settlesWithin(written, 300)).toBe(false);
    const received = store.receive(delivery(sibling, 'opened', issue(1, 'b', 0)), at(1));
    expect(await settlesWithin(received, 2_000)).toBe(true);
    expect(await settlesWithin(written, 0)).toBe(false);
    await issueLock.release();
    await written;
    expect(await received).toBe('applied');
  });

  it('runs at most two baselines at once, and a third waits holding no connection', async () => {
    const blocked = freshRepo();
    const third = freshRepo(blocked.owner);
    const beside = freshRepo(blocked.owner);
    await store.receive(delivery(blocked, 'opened', issue(1, 'a', 0)), at(0));
    const lock = await holding(repoLock(blocked));
    const two = [1, 2].map(() => store.baseline(blocked, [storedIssueOf(issue(1, 'a', 0))], at(1), at(1)));
    const next = store.baseline(third, [storedIssueOf(issue(1, 't', 0))], at(1), at(1));
    expect(await settlesWithin(next, 300)).toBe(false);
    expect(await settlesWithin(store.receive(delivery(beside, 'opened', issue(1, 'b', 0)), at(1)), 2_000)).toBe(true);
    await lock.release();
    await Promise.all([...two, next]);
    expect(await answered(third, at(2))).toEqual(['1:t']);
  });

  it('lets a delivery through at the minimum pool size while two baselines hold connections and a third waits for its slot', async () => {
    const pool = poolOf(STORE_CONNECTIONS);
    const small = new PrismaIssueStore(pool, HOUR);
    // Three used to be the entire pool. Reserve the extra capacity so this still
    // proves a queued baseline cannot take the connection a delivery needs.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    let ready!: () => void;
    const reserved = new Promise<void>((resolve) => { ready = resolve; });
    const holders = Array.from({ length: STORE_CONNECTIONS - 3 }, () => pool.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      if (++entered === STORE_CONNECTIONS - 3) ready();
      await gate;
    }));
    try {
      await reserved;
      const blocked = freshRepo();
      const third = freshRepo(blocked.owner);
      const beside = freshRepo(blocked.owner);
      await small.receive(delivery(blocked, 'opened', issue(1, 'a', 0)), at(0));
      const lock = await holding(repoLock(blocked));
      const two = [1, 2].map(() => small.baseline(blocked, [storedIssueOf(issue(1, 'a', 0))], at(1), at(1)));
      // Both inside their transactions, each holding a connection, before the third asks.
      expect(await settlesWithin(Promise.race(two), 300)).toBe(false);
      const next = small.baseline(third, [storedIssueOf(issue(1, 't', 0))], at(1), at(1));
      expect(await settlesWithin(next, 300)).toBe(false);
      // A slot waited for inside the transaction would hold the last free
      // connection, and this would give up after its two seconds' wait.
      expect(await small.receive(delivery(beside, 'opened', issue(1, 'b', 0)), at(1))).toBe('applied');
      await lock.release();
      await Promise.all([...two, next]);
    } finally {
      release();
      await Promise.all(holders);
      await pool.$disconnect();
    }
  });

  it('runs at most two deliveries at once, and a third waits for a slot instead of failing', async () => {
    const pool = poolOf(STORE_CONNECTIONS);
    // Count `$transaction` calls: a delivery inside a slot starts one, and a
    // delivery waiting for a slot does not. The two below start theirs
    // synchronously when `receive` runs, so this count is deterministic rather
    // than a wall-clock probe.
    let transactionStarts = 0;
    const wrapped = new Proxy(pool, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === '$transaction') {
          return (...args: unknown[]) => {
            transactionStarts += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const small = new PrismaIssueStore(wrapped as unknown as PrismaClient, HOUR);
    try {
      const repo = freshRepo();
      const lock = await holding(repoLock(repo));
      const two = [1, 2].map(() => small.receive(delivery(repo, 'opened', issue(1, 'a', 1)), at(1)));
      // Both started a transaction and are blocked on the repository lock,
      // holding the two delivery slots and their connections.
      expect(transactionStarts).toBe(2);
      const third = small.receive(delivery(repo, 'opened', issue(3, 'c', 2)), at(2));
      // The third waits for a slot without starting a transaction, so it holds
      // no connection. Without the gate it would start a third transaction
      // here and `transactionStarts` would read 3.
      expect(transactionStarts).toBe(2);
      await lock.release();
      expect(await Promise.all([...two, third])).toEqual(['applied', 'applied', 'applied']);
      expect((await row(repo, 3))?.issue).toMatchObject({ title: 'c' });
    } finally {
      await pool.$disconnect();
    }
  });

  it('runs at most two reads at once, and a third waits holding no connection', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'a', 0)], at(1));
    let entered = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const pool = poolOf(STORE_CONNECTIONS);
    // Each read stops at its first query, inside its transaction, until the gate opens.
    const gated = pool.$extends({
      query: {
        githubStoredRepo: {
          async findMany({ args, query }) {
            entered += 1;
            await gate;
            return query(args);
          },
        },
      },
    });
    const small = new PrismaIssueStore(gated as unknown as PrismaClient, HOUR);
    try {
      const reads = [1, 2, 3].map(() => small.read([repo], at(2)));
      expect(await settlesWithin(Promise.all(reads), 300)).toBe(false);
      expect(entered).toBe(2);
      expect(await small.receive(delivery(freshRepo(repo.owner), 'opened', issue(1, 'b', 0)), at(2))).toBe('applied');
      open();
      for (const read of await Promise.all(reads)) expect(read.served.get(repo.id)?.map((i) => i.title)).toEqual(['a']);
      expect(entered).toBe(3);
    } finally {
      open();
      await pool.$disconnect();
    }
  });

  /**
   * The queue of reads was the one unbounded thing left (#1070, S5). Baselines
   * were capped before they queued; reads were not, and a read that never
   * settles frees no slot — so every issues read after it added a closure that
   * nothing would ever remove. The ingest's own 3-second wait rejects the
   * caller and leaves the entry in the queue, so it does not bound this.
   *
   * Past the cap a read refuses at once, which `readStore` catches and turns
   * into a Github read, the same thing it does for every other unreadable store.
   */
  it('refuses a read once the queue is full, rather than growing it without a bound', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'a', 0)], at(1));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const pool = poolOf(STORE_CONNECTIONS);
    const gated = pool.$extends({
      query: {
        githubStoredRepo: {
          async findMany({ args, query }) {
            await gate;
            return query(args);
          },
        },
      },
    });
    const small = new PrismaIssueStore(gated as unknown as PrismaClient, HOUR);
    try {
      // Two running and holding connections, then 64 queued holding none.
      const held = Array.from({ length: 66 }, () => small.read([repo], at(2)));
      expect(await settlesWithin(Promise.all(held), 300)).toBe(false);
      await expect(small.read([repo], at(2))).rejects.toThrow(/64 reads are already waiting/);
      open();
      for (const read of await Promise.all(held)) expect(read.served.get(repo.id)?.map((i) => i.title)).toEqual(['a']);
    } finally {
      open();
      await pool.$disconnect();
    }
  });

  it('skips a baseline, with a warning, once 256 are waiting', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const bounded = new PrismaIssueStore(prisma, HOUR);
    try {
      const blocked = freshRepo();
      const skipped = freshRepo(blocked.owner);
      const quiet = freshRepo();
      await store.receive(delivery(blocked, 'opened', issue(1, 'a', 0)), at(0));
      const lock = await holding(repoLock(blocked));
      const running = [1, 2].map(() => bounded.baseline(blocked, [storedIssueOf(issue(1, 'a', 0))], at(1), at(1)));
      // No delivery has reached `quiet`'s owner, so each of these writes nothing once it runs.
      const waiting = Array.from({ length: 256 }, () => bounded.baseline(quiet, [], at(1), at(1)));
      const extra = bounded.baseline(skipped, [storedIssueOf(issue(1, 's', 0))], at(1), at(1));
      expect(await settlesWithin(extra, 300)).toBe(true);
      expect(await settlesWithin(Promise.race(waiting), 0)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${skipped.full}'s is skipped`));
      await lock.release();
      await Promise.all([...running, ...waiting]);
      expect(await storedRepo(skipped)).toBeNull();
      expect(await row(skipped, 1)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('makes a baseline that asks after an uninstall began wait for it, though an earlier baseline holds the owner lock', async () => {
    const installation = 700 + ++seq;
    const first = freshRepo();
    const later = freshRepo(first.owner);
    await store.receive(delivery(first, 'opened', issue(1, 'a', 0), installation), at(0));
    // Holding issue 1 stops baseline A at its upsert, after it has taken the owner lock.
    const issueLock = await holding((tx) => tx.$queryRaw`
      SELECT 1 AS held FROM "GithubStoredIssue" WHERE "repositoryId" = ${BigInt(first.id)}::bigint AND "number" = 1 FOR UPDATE`);
    const a = store.baseline(first, [storedIssueOf(issue(1, 'changed', 1))], at(1), at(1));
    expect(await settlesWithin(a, 300)).toBe(false);
    const settled: string[] = [];
    const uninstalled = store.receive(uninstall(first.owner, installation), at(2));
    void uninstalled.then(() => settled.push('uninstall'), () => undefined);
    expect(await settlesWithin(uninstalled, 300)).toBe(false);
    const c = store.baseline(later, [storedIssueOf(issue(1, 'c', 0))], at(1.5), at(2));
    void c.then(() => settled.push('C'), () => undefined);
    expect(await settlesWithin(c, 500)).toBe(false);
    await issueLock.release();
    await a;
    expect(await uninstalled).toBe('applied');
    await c;
    expect(settled).toEqual(['uninstall', 'C']);
    expect(await rowCount(first)).toBe(0);
    expect(await rowCount(later)).toBe(0);
    expect(await storedRepo(later)).toBeNull();
    expect(await ownerRow(first.owner)).toBeNull();
  });

  it('deletes deliveries older than a week', async () => {
    const pruner = new PrismaIssueStore(prisma, HOUR);
    const repo = freshRepo();
    const old = delivery(repo, 'opened', issue(1, 'a', 0));
    const recent = delivery(repo, 'edited', issue(1, 'b', 1));
    await pruner.receive(old, at(0));
    await pruner.receive(recent, at(0) + DAY);
    await pruner.receive(delivery(repo, 'edited', issue(1, 'c', 2)), at(0) + WEEK + 1);
    expect(await prisma.githubWebhookDelivery.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.githubWebhookDelivery.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });
});

describe('a forget outlasts a baseline that began before it (#1007, V5)', () => {
  const forgets: [string, (repo: Repo, now: number) => Promise<unknown>][] = [
    ['a repository event', (repo, now) => store.receive(repositoryEvent(repo, 'archived'), now)],
    ['its removal from the installation', (repo, now) => store.receive(removal(repo), now)],
    ['a delivery under a new name', (repo, now) =>
      store.receive(delivery({ ...repo, full: `${repo.owner}/renamed` }, 'labeled', issue(1, 'a', 0)), now)],
  ];

  it.each(forgets)('writes nothing from a read begun before %s forgot the repository, and serves one begun after', async (_, forget) => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'a', 0)], at(1));
    await forget(repo, at(3));
    // Github was read at 2, before the forget, and the baseline lands after it.
    await store.baseline(repo, [issue(1, 'a', 0), issue(7, 'listed before the forget', 0)].map(storedIssueOf), at(2), at(4));
    expect(await row(repo, 7)).toBeNull();
    expect(await answered(repo, at(5))).toBeNull();
    await store.baseline(repo, [storedIssueOf(issue(1, 'a', 0))], at(6), at(6));
    expect(await answered(repo, at(7))).toEqual(['1:a']);
    expect((await storedRepo(repo))?.forgottenAt).toBeNull();
  });

  it('records the forget of a repository no baseline has reached, under its owner', async () => {
    const repo = freshRepo();
    await store.receive(delivery(repo, 'opened', issue(1, 'a', 0)), at(0));
    expect(await store.receive(removal(repo), at(3))).toBe('applied');
    await store.baseline(repo, [issue(1, 'a', 0), issue(7, 'listed before the forget', 0)].map(storedIssueOf), at(2), at(4));
    expect(await rowCount(repo)).toBe(0);
    expect(await answered(repo, at(5))).toBeNull();
    expect(await storedRepo(repo)).toMatchObject({ owner: repo.owner, fullName: repo.full });
  });
});

describe('what a baseline keeps and removes (#1007, V5)', () => {
  it('removes a row two reads in a row did not list, and keeps a delivery that landed mid-read', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'one', 0), issue(2, 'two', 0)], at(1));
    await store.receive(delivery(repo, 'opened', issue(3, 'three', 3)), at(3));
    await store.baseline(repo, [storedIssueOf(issue(1, 'one', 0))], at(2), at(4));
    expect(await answered(repo, at(5))).toEqual(['3:three', '2:two', '1:one']);
    await store.baseline(repo, [storedIssueOf(issue(1, 'one', 0))], at(6), at(7));
    expect(await answered(repo, at(8))).toEqual(['3:three', '1:one']);
  });

  it('keeps an issue one read did not list, and removes it at the next read that also misses it', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'one', 0), issue(2, 'skipped', 0)], at(1));
    await store.baseline(repo, [storedIssueOf(issue(1, 'one', 0))], at(2), at(3));
    expect((await row(repo, 2))?.missedAt?.getTime()).toBe(at(3));
    expect(await answered(repo, at(3.5))).toEqual(['2:skipped', '1:one']);
    await store.baseline(repo, [storedIssueOf(issue(1, 'one', 0))], at(4), at(5));
    expect(await row(repo, 2)).toBeNull();
    expect(await answered(repo, at(6))).toEqual(['1:one']);
  });

  it('clears the miss when a later read lists the row again, so it takes two more misses to go', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'one', 0), issue(2, 'skipped', 0)], at(1));
    await store.baseline(repo, [storedIssueOf(issue(1, 'one', 0))], at(2), at(3));
    await store.baseline(repo, [issue(1, 'one', 0), issue(2, 'skipped', 0)].map(storedIssueOf), at(4), at(5));
    expect((await row(repo, 2))?.missedAt).toBeNull();
    await store.baseline(repo, [storedIssueOf(issue(1, 'one', 0))], at(6), at(7));
    expect(await answered(repo, at(8))).toEqual(['2:skipped', '1:one']);
  });

  it('leaves an unchanged row as it was, writtenAt included, and rewrites a changed one', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'same', 0), issue(2, 'before', 0)], at(1));
    const kept = (await row(repo, 1))?.writtenAt.getTime();
    await store.baseline(repo, [issue(1, 'same', 0), issue(2, 'after', 2)].map(storedIssueOf), at(2), at(3));
    expect((await row(repo, 1))?.writtenAt.getTime()).toBe(kept);
    expect((await row(repo, 2))?.writtenAt.getTime()).toBe(at(3));
  });

  it('takes one row per number when a page repeats an issue, the newest', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'old', 1), issue(1, 'new', 2)], at(3));
    expect(await answered(repo, at(4))).toEqual(['1:new']);
  });
});

describe('an installation that goes away takes its data with it (#1007, V5)', () => {
  it('forgets the owner and its repositories when the App is uninstalled', async () => {
    const repo = freshRepo();
    const installation = 700 + ++seq;
    await store.receive(delivery(repo, 'labeled', issue(1, 'a', 0), installation), at(0));
    await store.baseline(repo, [storedIssueOf(issue(1, 'a', 0))], at(1), at(1));
    expect(await store.receive(uninstall(repo.owner, installation), at(2))).toBe('applied');
    expect(await answered(repo, at(3))).toBeNull();
    expect(await row(repo, 1)).toBeNull();
    expect(await ownerRow(repo.owner)).toBeNull();
  });

  it('forgets rows of a repository only deliveries reached, of a transfer target, and of an archived repository', async () => {
    const owner = `owner-${process.pid}-${++seq}`;
    const installation = 700 + seq;
    const deliveredOnly = freshRepo(owner);
    const elsewhere = freshRepo();
    const target = freshRepo(owner);
    const archived = freshRepo(owner);
    await store.receive(delivery(deliveredOnly, 'opened', issue(1, 'only delivered', 1), installation), at(1));
    expect(await store.receive(transfer(elsewhere, target, 5, 7, 2), at(2))).toBe('applied');
    expect((await row(target, 7))?.owner).toBe(owner);
    await store.baseline(archived, [storedIssueOf(issue(1, 'archived', 0))], at(3), at(3));
    await store.receive(repositoryEvent(archived, 'archived'), at(4));
    expect(await store.receive(uninstall(owner, installation), at(5))).toBe('applied');
    for (const gone of [deliveredOnly, target, archived]) expect(await rowCount(gone)).toBe(0);
    expect(await prisma.githubStoredIssue.count({ where: { owner } })).toBe(0);
    // The other account's tombstone of the issue that moved stays.
    expect((await row(elsewhere, 5))?.deleted).toBe(true);
  });

  it('forgets repositories taken out of the installation', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'a', 0)], at(1));
    const removed: WebhookDelivery = {
      id: `removed-${seq}`,
      event: 'installation_repositories',
      payload: { action: 'removed', installation: { id: 42 }, repositories_removed: [{ id: repo.id }] },
    };
    expect(await store.receive(removed, at(2))).toBe('applied');
    expect(await answered(repo, at(3))).toBeNull();
    expect(await row(repo, 1)).toBeNull();
  });

  // `applied` here bumped the store's signal, which made every person's cache
  // spend a refill on a delivery that changed no row (#1070).
  it('reports an uninstall of an account the store never held as ignored, not applied', async () => {
    const stranger = `owner-${process.pid}-${++seq}`;
    expect(await store.receive(uninstall(stranger, 900 + seq), at(2))).toBe('ignored');
  });

  it('records and ignores an event it does not read', async () => {
    expect(await store.receive({ id: `ping-${seq++}`, event: 'ping', payload: { zen: 'Keep it logically awesome.' } }, at(1))).toBe('ignored');
  });
});

describe('a repository event forgets the repository (#1007, V5)', () => {
  it.each(['deleted', 'renamed', 'transferred', 'archived'])('forgets a repository %s, with every issue row it had', async (action) => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'a', 0)], at(1));
    await store.receive(delivery(repo, 'opened', issue(2, 'b', 2)), at(2));
    expect(await store.receive(repositoryEvent(repo, action), at(3))).toBe('applied');
    expect(await answered(repo, at(4))).toBeNull();
    expect((await storedRepo(repo))?.forgottenAt?.getTime()).toBe(at(3));
    expect(await rowCount(repo)).toBe(0);
  });

  it('takes the repository advisory lock', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'a', 0)], at(1));
    const lock = await holding(repoLock(repo));
    const forgotten = store.receive(repositoryEvent(repo, 'archived'), at(2));
    expect(await settlesWithin(forgotten, 300)).toBe(false);
    await lock.release();
    expect(await forgotten).toBe('applied');
  });

  it('ignores any other repository action', async () => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'a', 0)], at(1));
    expect(await store.receive(repositoryEvent(repo, 'publicized'), at(2))).toBe('ignored');
    expect(await answered(repo, at(3))).toEqual(['1:a']);
  });
});

describe('the event header has to fit the signed body (#1007, V5)', () => {
  it.each(['installation', 'repository'])('records and ignores an issues body sent again as %s, and changes nothing', async (event) => {
    const repo = freshRepo();
    await liveWithBaseline(repo, [issue(1, 'a', 0)], at(1));
    const captured = delivery(repo, 'deleted', issue(1, 'a', 0));
    const resent: WebhookDelivery = { ...captured, id: `resent-${process.pid}-${++seq}`, event };
    expect(await store.receive(resent, at(2))).toBe('ignored');
    expect(await prisma.githubWebhookDelivery.findUnique({ where: { id: resent.id } })).not.toBeNull();
    expect(await ownerRow(repo.owner)).not.toBeNull();
    expect(await storedRepo(repo)).not.toBeNull();
    expect(await answered(repo, at(3))).toEqual(['1:a']);
  });
});

describe('delivery generations', () => {
  it('invalidates only the changed repo while live, and the owner when liveness restarts or ends', async () => {
    const signal = new IssueStoreSignal();
    const a = freshRepo();
    const b = freshRepo(a.owner);
    const otherOwner = freshRepo();
    const signalled = new PrismaIssueStore(prisma, HOUR, signal);
    const scope = [a, b, otherOwner];
    await signalled.receive(delivery(a, 'opened', issue(1, 'first', 1)), at(1));
    expect(signal.changed(scope, 0)).toEqual([a.full, b.full]);
    const beforeEdit = signal.generation;
    await signalled.receive(delivery(a, 'edited', issue(1, 'second', 2)), at(2));
    expect(signal.changed(scope, beforeEdit)).toEqual([a.full]);
    const beforeWake = signal.generation;
    await signalled.receive(delivery(a, 'edited', issue(1, 'wake', 2)), at(2) + LIVE_WINDOW_MS);
    expect(signal.changed(scope, beforeWake)).toEqual([a.full, b.full]);
    const beforeUninstall = signal.generation;
    await signalled.receive(uninstall(a.owner, 42), at(3) + LIVE_WINDOW_MS);
    expect(signal.changed(scope, beforeUninstall)).toEqual([a.full, b.full]);
  });

  it('invalidates both sides of an issue transfer and removed repositories by id', async () => {
    const signal = new IssueStoreSignal();
    const a = freshRepo();
    const b = freshRepo();
    const unrelated = freshRepo();
    const signalled = new PrismaIssueStore(prisma, HOUR, signal);
    await signalled.receive(delivery(a, 'opened', issue(1, 'before', 1)), at(1));
    const moved = delivery(a, 'transferred', issue(1, 'before', 2));
    Object.assign(moved.payload as object, { changes: {
      new_issue: issue(2, 'after', 2), new_repository: { id: b.id, full_name: b.full },
    } });
    const beforeMove = signal.generation;
    await signalled.receive(moved, at(2));
    expect(signal.changed([a, b, unrelated], beforeMove)).toEqual([a.full, b.full]);
    const beforeRemoval = signal.generation;
    await signalled.receive({ id: `remove-${++seq}`, event: 'installation_repositories', payload: {
      action: 'removed', repositories_removed: [{ id: b.id }],
    } }, at(3));
    expect(signal.changed([a, b, unrelated], beforeRemoval)).toEqual([b.full]);
    const beforeDuplicate = signal.generation;
    await signalled.receive(moved, at(4));
    expect(signal.generation).toBe(beforeDuplicate);
  });

  it('signals a committed delivery before pruning can hold up its acknowledgement', async () => {
    const signal = new IssueStoreSignal();
    const repo = freshRepo();
    let release!: () => void;
    const pruning = new Promise<void>((resolve) => { release = resolve; });
    const wrapped = new Proxy(prisma, { get(target, key) {
      if (key === 'githubWebhookDelivery') return { deleteMany: () => pruning };
      return Reflect.get(target, key);
    } });
    const signalled = new PrismaIssueStore(wrapped, HOUR, signal);
    const receiving = signalled.receive(delivery(repo, 'opened', issue(1, 'arrived', 1)), at(1));
    try {
      await vi.waitFor(() => expect(signal.generation).toBeGreaterThan(0));
    } finally {
      release();
      await receiving;
    }
  });
});
