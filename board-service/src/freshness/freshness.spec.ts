import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'http';
import type { AddressInfo } from 'net';
import { BadRequestException, Controller, Get, INestApplication, Logger, Post, Type } from '@nestjs/common';
import { APP_INTERCEPTOR, ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { ConfigService } from '@nestjs/config';
import { Writes } from '../capability/writes.decorator';
import { IssueBucketsService } from '../issue-buckets/issue-buckets.service';
import type { IIssueBucketsSource } from '../issue-buckets/issue-buckets.types';
import { IssueDetailService } from '../issue-detail/issue-detail.service';
import type { IIssueDetailSource, IssueDetail } from '../issue-detail/issue-detail.types';
import type { OrgReadOutcome } from '../issues-metrics/github-issues.source';
import type { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import { IssuesCacheService as IssuesCache } from '../issues-metrics/issues-cache.service';
import type { IIssuesSource, RawIssue } from '../issues-metrics/issues-metrics.types';
import type { IProjectsSource, ProjectRollup } from '../projects/project.types';
import { ProjectsService } from '../projects/projects.service';
import { FreshnessRegistry, HOLDERS } from './freshness.registry';
import type { StaleOnWrite } from './stale-on-write';
import { WriteFreshnessInterceptor } from './write-freshness.interceptor';

/**
 * #692 — a write done from the board leaves every cached answer that described
 * the thing written out of date.
 *
 * Modelled on `repos.service.spec.ts`'s "a write drops what it invalidated
 * (#571)", and it is the deliverable that outlives the close button.
 *
 * It drives `HOLDERS` — the registry's OWN list — rather than a copy of it. A
 * seventh cache added there with no driver beside it fails by name here, which
 * is the one thing a hand-written list of caches cannot do: forgetting to add a
 * cache to a test is invisible, and forgetting to add a driver is not.
 *
 * What every cache has to do, one case each, and each one goes red on its own
 * when the line that makes it true is taken out:
 *  - it forgets, and the next read answers what the source says NOW;
 *  - a caller arriving after the write starts its own read, rather than being
 *    handed the in-flight slot of the read that went out before it;
 *  - a read that went out before the write cannot land afterwards and put back
 *    what it read;
 *  - nor, when it lands, clear the slot a later reader is waiting on;
 *  - the drop does not turn a Github outage into a 500 — what it retired is
 *    served when the read that replaces it fails, and never when it succeeds.
 *
 * And what the registry has to do with them: drop all four, refill only the two
 * whose budget can take it, hand back nothing to await, and let a failure of
 * either half be a warning rather than the failure of a write that landed.
 */

const config = {
  // Neither `FEEDBACK_REPO` nor `GITHUB_ORGS` has a default since #1175, and the
  // services under test read both in their constructors — the
  // submission-visibility scope and the org read scope.
  get: (k: string, d?: unknown) =>
    k === 'FEEDBACK_REPO' ? 'acme/board' : k === 'GITHUB_ORGS' ? 'acme' : d,
} as unknown as ConfigService;

/** The shared issues cache as the two services that read it see it — neither
 *  reads it for anything this spec measures. */
const issuesCacheStub = {
  getIssues: async () => ({ at: Date.now(), issues: [], orgs: [] }),
  submissionIndex: async () => null,
} as unknown as IssuesCacheService;

/**
 * A source that counts its reads, can hold ONE open, and can be made to fail.
 *
 * Holding is how a read that went out before the write is made to land after it
 * — the third of the three moves `repos.service.ts:632` names, and the one a
 * bare `cache = null` does not make. Failing is how the outage after a drop is
 * reached, which is the case a drop must not turn into a 500.
 *
 * Every answer carries the number of the read that produced it, so "the answer
 * moved" is asserted on a value rather than on object identity — two of these
 * services rebuild their payload on the way out, and identity says nothing
 * there.
 */
function makeGate() {
  let calls = 0;
  let toHold = 0;
  /** How to let each held read go, in the order they went out. */
  const holds: (() => void)[] = [];
  let failure: Error | null = null;
  return {
    calls: () => calls,
    /** The next `n` reads do not resolve until released. More than one, because
     *  two of the cases below need a read that went out BEFORE the write and a
     *  read that went out after it to be in flight at the same moment. */
    holdNext(n = 1): void {
      toHold = n;
    },
    /** Let the `i`th held read (1-based, in the order they went out) land. */
    release(i: number): void {
      holds[i - 1]?.();
    },
    /** Let every held read land. */
    open(): void {
      for (const let_go of holds) let_go();
    },
    /** Every read from here on rejects — Github, refusing. */
    failWith(err: Error): void {
      failure = err;
    },
    /** ...and answering again a second later, which is the state every one of
     *  these recovers into and the one a cached failure hides. */
    recover(): void {
      failure = null;
    },
    async pass<T>(answer: (read: number) => T): Promise<T> {
      const read = (calls += 1);
      if (toHold > 0) {
        toHold -= 1;
        await new Promise<void>((r) => holds.push(r));
      }
      if (failure) throw failure;
      return answer(read);
    },
  };
}

type Gate = ReturnType<typeof makeGate>;

interface Subject {
  /** One cached read of this service, through its public API. */
  read: () => Promise<unknown>;
  /**
   * A read of this service that DEDUPES — the one whose in-flight slot the two
   * slot cases below are about. Defaults to `read`, and only `ProjectsService`
   * differs: its rollup has no in-flight slot at all, so its per-board detail is
   * the read that has one.
   */
  deduped?: () => Promise<unknown>;
  /** What a write does to it. */
  drop: () => void;
  /** Which read produced this answer, off the answer itself. */
  mark: (answer: unknown) => unknown;
}

interface Driver {
  build: (gate: Gate) => Subject;
  /**
   * Whether a drop RETIRES the answer it dropped, to be served if the read that
   * replaces it fails. All four do, since #713 gave `ProjectsService` the field
   * the paragraph in `StaleOnWrite` had been claiming for it: its rollup and its
   * membership index each keep, per org, what the drop cleared.
   *
   * `ProjectsService` retires those two and not its per-board detail, and that
   * is a known GAP rather than a different mechanism: `dropCaches` clears
   * `detailByOrg`, so the stale-while-revalidate branch has nothing left to
   * serve on the very path a retiree is for. So the flag and the case that reads it stay: a seventh cache
   * arriving without a retiree is a line in this file rather than a paragraph in
   * a review.
   */
  retires: boolean;
  /**
   * Whether slot IDENTITY — the `if (this.inFlight === read)` in a `finally` —
   * is what stops a read that went out before the write from clearing the slot a
   * later reader is waiting on. True for the four flat caches, and their check is
   * the only thing standing between a disowned read and a third fetch.
   *
   * FALSE for two, for two different reasons, and both are here so that neither
   * sits in a case that would pass for it whatever the code did:
   *  - `IssueDetailService` has no such check and cannot: its slot lives inside
   *    the map entry a drop clears whole, and the epoch check on the way in is
   *    what disowns a read there — pinned by the case above.
   *  - `ProjectsService` has one, and it is unreachable by construction: the slot
   *    map is nested per org, the read closes over the INNER map, and the drop
   *    clears the outer one — so a disowned read already deletes from a map
   *    nothing can reach. Named in the report rather than pinned by a case that
   *    would pass with the check taken out.
   */
  ownsSlot: boolean;
}

/** One board, as a source hands it up. Its NAME carries the read it came from. */
const rollup = (read: number): ProjectRollup => ({
  number: 7,
  name: `board as of read ${read}`,
  url: 'https://github.com/orgs/acme/projects/7',
  status: 'active',
  open: read,
  closed: 0,
  pct: 0,
  excludedItems: 0,
  itemsComplete: true, // read whole, as every board a source hands up is unless it says otherwise (#690)
  recentCloses: [],
  weeklyClosed: [],
  closedThisWeek: 0,
  openedThisWeek: 0,
  contributors: [],
  contributorsByAssignee: [],
});

const rawIssue = (read: number): RawIssue => ({
  owner: 'acme',
  repo: 'acme',
  number: 1,
  title: `issue as of read ${read}`,
  htmlUrl: 'https://github.com/acme/acme/issues/1',
  state: 'open',
  createdAt: '2026-08-01T00:00:00Z',
  closedAt: null,
  // A synthetic row is told no reason, which is the state that COUNTS —
  // so every assertion written before #1014 keeps meaning what it meant.
  stateReason: null,
  author: null,
  assignees: [],
  labels: [],
  labelsComplete: true,
  submission: false,
  milestone: null,
});

/** NOT in `FEEDBACK_REPO`, and carrying no footer: the words gate is a different
 *  question and this spec must not accidentally be asking it. */
const detail = (read: number): IssueDetail => ({
  owner: 'acme',
  repo: 'acme',
  number: 692,
  title: `issue as of read ${read}`,
  state: 'open',
  htmlUrl: 'https://github.com/acme/acme/issues/692',
  author: null,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  bodyMarkdown: '',
  labels: [],
  labelsComplete: true,
  assignees: [],
  milestone: null,
  issueType: null,
  relations: { parent: null, subIssues: [], subIssuesTotal: 0, subIssuesClosed: 0, blockedBy: [], blocking: [] },
  linkedPrs: [],
  comments: [],
  totalComments: 0,
  commentsTruncated: false,
  projects: [],
});

/**
 * How to drive each cache the registry names. Keyed by the SAME class token
 * `HOLDERS` holds, so the two lists are checked against each other below rather
 * than trusted to agree.
 */
const DRIVERS = new Map<Type<StaleOnWrite>, Driver>([
  [
    ProjectsService,
    {
      retires: true,
      // Its per-board slot is disowned by the nested map, not by the identity
      // check it also carries — see `Driver.ownsSlot`.
      ownsSlot: false,
      build: (gate) => {
        const source: IProjectsSource = {
          listProjects: () => gate.pass((n) => [rollup(n)]),
          // Through the same gate, because the per-board detail is this
          // service's deduping read — the rollup has no in-flight slot to be
          // about. What it answers does not matter here; that it was FETCHED
          // does, so a board nobody seeded answers null.
          getProject: () => gate.pass(() => null),
          projectMemberships: async () => [],
          listProjectCatalog: async () => [],
          disownInFlightReads: vi.fn(),
        };
        const service = new ProjectsService(source, config, issuesCacheStub);
        return {
          read: () => service.listProjects(undefined),
          deduped: () => service.getProject(7, undefined),
          drop: () => service.dropCaches(),
          mark: (a) => (a as { name: string }[])[0]?.name,
        };
      },
    },
  ],
  [
    IssuesCache,
    {
      retires: true,
      ownsSlot: true,
      build: (gate) => {
        const source: IIssuesSource = { listIssues: () => gate.pass((n) => [rawIssue(n)]) };
        const service = new IssuesCache(source, config);
        return {
          read: () => service.getIssues(),
          drop: () => service.dropCaches(),
          mark: (a) => (a as { issues: { title: string }[] }).issues[0]?.title,
        };
      },
    },
  ],
  [
    IssueBucketsService,
    {
      retires: true,
      ownsSlot: true,
      build: (gate) => {
        const source: IIssueBucketsSource = {
          counts: () => gate.pass((n) => ({ open: n, bugs: 0, feedback: 0, unassigned: 0 })),
        };
        const service = new IssueBucketsService(source, config);
        return {
          read: () => service.getBuckets(),
          drop: () => service.dropCaches(),
          mark: (a) => (a as { open: number }).open,
        };
      },
    },
  ],
  [
    IssueDetailService,
    {
      retires: true,
      // Its slot is the map entry, and the epoch is what disowns a read here.
      ownsSlot: false,
      build: (gate) => {
        const source = {
          fetch: () => gate.pass((n) => detail(n)),
          close: async () => {},
        } as unknown as IIssueDetailSource;
        const service = new IssueDetailService(source, config, issuesCacheStub);
        return {
          read: () => service.getIssue('acme', 'acme', 692),
          drop: () => service.dropCaches(),
          mark: (a) => (a as IssueDetail | null)?.title,
        };
      },
    },
  ],
]);

/** Every cache the registry drops, named as the registry names it. */
const CASES = HOLDERS.map((token) => ({ name: token.name, token }));
const RETIRING = CASES.filter(({ token }) => DRIVERS.get(token)?.retires);
const OWNS_SLOT = CASES.filter(({ token }) => DRIVERS.get(token)?.ownsSlot);
const NOT_RETIRING = CASES.filter(({ token }) => DRIVERS.get(token)?.retires === false);

function drive(token: Type<StaleOnWrite>, gate: Gate): Subject {
  const driver = DRIVERS.get(token);
  if (!driver) {
    throw new Error(
      `${token.name} is in HOLDERS (freshness.registry.ts) with no driver in DRIVERS here, so nothing ` +
        'checks that a write drops it. Add one — three lines: a stubbed source, a read, and what a read ' +
        'is marked by (#692).',
    );
  }
  return driver.build(gate);
}

describe('a write drops what it invalidated — the issue surfaces (#692)', () => {
  it('has a driver for every cache the registry drops, and none it does not', () => {
    // Both directions. A cache added to HOLDERS with no driver is untested; a
    // driver for something HOLDERS no longer names is testing a cache no write
    // touches, and reads as coverage it is not.
    expect(HOLDERS.filter((t) => !DRIVERS.has(t)).map((t) => t.name)).toEqual([]);
    expect([...DRIVERS.keys()].filter((t) => !HOLDERS.includes(t)).map((t) => t.name)).toEqual([]);
  });

  it.each(CASES)('$name answers what the source says now, not what it held', async ({ token }) => {
    const gate = makeGate();
    const { read, drop, mark } = drive(token, gate);

    const first = await read();
    expect(mark(await read())).toEqual(mark(first));
    // Nothing has expired — the second read is the TTL doing its job.
    expect(gate.calls()).toBe(1);

    drop();

    const second = await read();
    expect(gate.calls()).toBe(2);
    // The ANSWER moved, not just the call count: a drop that fetched and then
    // served what it had kept would pass on the count alone.
    expect(mark(second)).not.toEqual(mark(first));
  });

  it.each(CASES)(
    '$name does not let a read that went out before the write become the cache',
    async ({ token }) => {
      const gate = makeGate();
      const { read, drop, mark } = drive(token, gate);

      gate.holdNext();
      const inFlight = read();
      // The write lands while that read is still out.
      drop();
      gate.open();
      const disowned = await inFlight;

      // The disowned read is still answered to whoever asked for it...
      expect(mark(disowned)).toEqual(mark(disowned));
      // ...and cached for nobody: if it had become the cache, or if its slot
      // were still there to be handed out, this would be served from it.
      const after = await read();
      expect(gate.calls()).toBe(2);
      expect(mark(after)).not.toEqual(mark(disowned));
    },
  );

  it.each(CASES)('$name makes a caller arriving after the write start its own read', async ({ token }) => {
    // The second of the three moves, on its own. Nulling the cache is not
    // enough: while the pre-write read is still out, its IN-FLIGHT SLOT is a
    // second copy of the answer the write invalidated, and a caller arriving now
    // would be handed it — no fetch, no epoch, a pre-write answer served after
    // the write. Leave the slot in `dropCaches` and this is the line that goes
    // red; nothing else in this file notices.
    const gate = makeGate();
    const subject = drive(token, gate);
    const read = subject.deduped ?? subject.read;

    gate.holdNext();
    const early = read();
    subject.drop();
    const later = read();
    gate.open();
    await Promise.all([early, later]);

    expect(gate.calls()).toBe(2);
  });

  it.each(OWNS_SLOT)(
    '$name lets a disowned read land without clearing the slot a later reader waits on',
    async ({ token }) => {
      // The third move's other half, and the one a bare `inFlight = null` in a
      // `finally` gets wrong. Two reads are out: one from before the write, one
      // started after it. When the FIRST lands it must clear only its own slot —
      // it no longer owns the one in the field. Drop the `=== read` check and the
      // disowned read clears the live slot, so the next reader starts a third
      // fetch of the same answer while the second is still in the air.
      const gate = makeGate();
      const subject = drive(token, gate);
      const read = subject.deduped ?? subject.read;

      gate.holdNext(2);
      const early = read();
      subject.drop();
      const current = read();
      gate.release(1);
      await early;

      const later = read();
      gate.open();
      await Promise.all([current, later]);

      expect(gate.calls()).toBe(2);
    },
  );
});

describe('a drop must not turn a Github outage into a 500 (#692)', () => {
  it.each(RETIRING)('$name serves what the drop retired when the read replacing it fails', async ({ token }) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const gate = makeGate();
    const { read, drop, mark } = drive(token, gate);

    const before = await read();
    drop();
    // Github, a second later, refusing everything.
    gate.failWith(new Error('You have exceeded a secondary rate limit'));

    const after = await read();

    // It went to the source FIRST — the retired copy is a fallback, never a
    // shortcut past the read a drop exists to force.
    expect(gate.calls()).toBe(2);
    expect(mark(after)).toEqual(mark(before));
    warn.mockRestore();
  });

  it.each(RETIRING)(
    '$name lets the next reader try the source again after one read failed',
    async ({ token }) => {
      // A retired copy is served to the caller who asked and must not BECOME the
      // cached answer. Cache it and the failure stops being per-call: it is
      // stamped with the moment before the write, so every reader inside what is
      // left of the TTL is handed the pre-write payload and the source is not
      // asked again — up to a minute in which Github has recovered and nobody
      // finds out (#692 review).
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const gate = makeGate();
      const { read, drop, mark } = drive(token, gate);

      const before = await read();
      drop();
      gate.failWith(new Error('You have exceeded a secondary rate limit'));
      await read();
      expect(gate.calls()).toBe(2);

      // Github, a second later, answering again.
      gate.recover();
      const after = await read();

      expect(gate.calls()).toBe(3);
      expect(mark(after)).not.toEqual(mark(before));
      warn.mockRestore();
    },
  );

  it('has no cache left that fails on that path, and says so rather than skipping (#713)', () => {
    // `it.each([])` registers NOTHING, silently — and since #713 gave
    // `ProjectsService` its retiree, every driver is `retires: true` and the case
    // below is a case about nobody. This line is what makes that emptiness a
    // claim: a seventh cache arriving without a retiree goes red here rather
    // than turning a registered-test count from 0 to 1 where nobody is looking.
    expect(NOT_RETIRING.map(({ name }) => name)).toEqual([]);
    // The other half of it, so an empty NOT_RETIRING can only mean "all of them
    // retire" and never "the flag stopped being read": the two lists are
    // complements over the same CASES.
    expect(RETIRING.map(({ name }) => name)).toEqual(CASES.map(({ name }) => name));
  });

  it.each(NOT_RETIRING)('$name still fails on that path — named, not overlooked', async ({ token }) => {
    // Characterising what this one does, so the gap is a line in a test rather
    // than a paragraph in a review. See `Driver.retires` above for why it is
    // the way it is.
    const gate = makeGate();
    const { read, drop } = drive(token, gate);

    await read();
    drop();
    gate.failWith(new Error('You have exceeded a secondary rate limit'));

    await expect(read()).rejects.toThrow('secondary rate limit');
  });
});

describe('the registry drops everything and re-fills only what may be re-filled here (#692)', () => {
  /** A holder offering a refill under BOTH names the tree has used for one, so
   *  which of them the registry calls is a fact rather than a guess — and so a
   *  refill re-introduced under the other name is still visible here. */
  const stub = () => ({
    dropCaches: vi.fn(),
    resync: vi.fn(async () => {}),
    warmAfterWrite: vi.fn(async () => {}),
  });

  const registryOver = (holders: Map<unknown, StaleOnWrite>) =>
    new FreshnessRegistry({
      get: (token: unknown) => {
        const found = holders.get(token);
        if (!found) throw new Error(`no provider for ${String(token)}`);
        return found;
      },
    } as unknown as ModuleRef);

  const stubsForHolders = () => {
    const stubs = HOLDERS.map(() => stub());
    return { stubs, registry: registryOver(new Map(HOLDERS.map((t, i) => [t, stubs[i]]))) };
  };

  it('the caches that offer a refill get it, through `warmAfterWrite` and not `resync`', () => {
    const { stubs, registry } = stubsForHolders();

    registry.invalidateAll();

    for (const s of stubs) {
      expect(s.dropCaches).toHaveBeenCalledTimes(1);
      expect(s.warmAfterWrite).toHaveBeenCalledTimes(1);
      // `resync` is the awaited "Sync now" (#301) and means something else. The
      // registry must never be what calls it, or a write would start costing
      // what a button press costs.
      expect(s.resync).not.toHaveBeenCalled();
    }
  });

  it('a cache with no `warmAfterWrite` is dropped and not re-filled', () => {
    // The three Search-backed caches are this shape. Absence is the answer, and
    // the registry must read it as one rather than reaching for `resync`.
    const stubs = HOLDERS.map(() => stub());
    const dropOnly = { dropCaches: vi.fn(), resync: vi.fn(async () => {}) };
    const holders = new Map<unknown, StaleOnWrite>(HOLDERS.map((t, i) => [t, stubs[i]]));
    holders.set(HOLDERS[0], dropOnly);

    registryOver(holders).invalidateAll();

    expect(dropOnly.dropCaches).toHaveBeenCalledTimes(1);
    expect(dropOnly.resync).not.toHaveBeenCalled();
  });

  it('hands each cache what the write declared, so the catalog can tell a new project from a close (#982)', () => {
    const { stubs, registry } = stubsForHolders();

    registry.invalidateAll(['issue.project.create', 'issue.project.add']);

    for (const s of stubs) expect(s.dropCaches).toHaveBeenCalledWith(['issue.project.create', 'issue.project.add']);
  });

  it('hands back nothing to await, and answers while every refill is still running', () => {
    // The teeth for "the write does not wait for Github". Make `invalidateAll`
    // `async` and `await Promise.all(...)` the refills and this line fails on
    // the returned promise — which is exactly the change that would put a
    // multi-second scan in front of a confirm dialog.
    const stubs = HOLDERS.map(() => stub());
    for (const s of stubs) s.warmAfterWrite.mockImplementation(() => new Promise<void>(() => {}));
    const registry = registryOver(new Map(HOLDERS.map((t, i) => [t, stubs[i]])));

    const returned: unknown = registry.invalidateAll();

    expect(returned).toBeUndefined();
    // And it got all the way through the list with four refills outstanding.
    for (const s of stubs) {
      expect(s.dropCaches).toHaveBeenCalledTimes(1);
      expect(s.warmAfterWrite).toHaveBeenCalledTimes(1);
    }
  });

  it('a refill that fails is a warning, not the failure of a write that landed', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const stubs = HOLDERS.map(() => stub());
    stubs[0].warmAfterWrite.mockImplementation(async () => {
      throw new Error('You have exceeded a secondary rate limit');
    });
    const registry = registryOver(new Map(HOLDERS.map((t, i) => [t, stubs[i]])));

    expect(() => registry.invalidateAll()).not.toThrow();

    await vi.waitFor(() =>
      expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes('secondary rate limit'))).toBe(true),
    );
    // The drop still happened — that is what makes the next read right, refill
    // or no refill.
    expect(stubs[0].dropCaches).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a drop that throws is a warning, not the failure of a write that landed', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const stubs = HOLDERS.map(() => stub());
    stubs[0].dropCaches.mockImplementation(() => {
      throw new Error('cache is on fire');
    });
    const registry = registryOver(new Map(HOLDERS.map((t, i) => [t, stubs[i]])));

    expect(() => registry.invalidateAll()).not.toThrow();

    // And the loop did not stop at it: every cache after the one that threw was
    // still dropped, which is the whole reason the guard is per holder.
    for (const s of stubs.slice(1)) expect(s.dropCaches).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes('cache is on fire'))).toBe(true);
    warn.mockRestore();
  });

  it('offers a refill on exactly the two caches that do not read Github Search', () => {
    // The decision itself, pinned on the real classes rather than on stubs: a
    // `warmAfterWrite` added to a Search-backed cache spends ten searches per
    // write against a thirty-a-minute budget and re-caches the pre-write answer
    // (Search is eventually consistent), which is #692 made WORSE. Read off
    // HOLDERS, so a seventh cache has to say which side it is on.
    const warms = HOLDERS.filter((t) => typeof t.prototype.warmAfterWrite === 'function').map((t) => t.name);
    expect(warms.sort()).toEqual(['IssuesCacheService', 'ProjectsService']);
  });
});

describe('what a drop must NOT take with it (#692)', () => {
  const ORGS: OrgReadOutcome[] = [{ org: 'acme', state: 'read', reason: null, calls: 3 }];

  it('IssuesCacheService keeps the org verdict, which no close can change', async () => {
    // `/api/auth/me` reads this. `null` hands the question back to the boot
    // probe, whose answer is a claim about process start — so a close that
    // nulled it would make the surface report an org's health as it was hours
    // ago (org-read-state.ts, "the probe is a BOOTSTRAP, not a second opinion").
    const gate = makeGate();
    const source = {
      listIssues: () => gate.pass((n) => [rawIssue(n)]),
      orgOutcomes: () => ORGS,
    } as unknown as IIssuesSource;
    const service = new IssuesCache(source, config);

    await service.getIssues();
    expect(service.lastIngestOrgs()).toEqual(ORGS);

    service.dropCaches();

    expect(service.lastIngestOrgs()).toEqual(ORGS);
    // And the issues themselves DID go — this is not a drop that failed to drop.
    await service.getIssues();
    expect(gate.calls()).toBe(2);
  });

  it('ProjectsService keeps the board catalog, and "Sync now" still drops it', async () => {
    // A catalog entry is a BOARD's identity — node id, number, title — with no
    // issue title, count or date on it. No close can change one, so dropping it
    // would charge a Projects-v2 GraphQL call on the next picker open for
    // nothing.
    let catalogReads = 0;
    const source: IProjectsSource = {
      listProjects: async () => [rollup(1)],
      getProject: async () => null,
      projectMemberships: async () => [],
      listProjectCatalog: async () => {
        catalogReads += 1;
        return [];
      },
      disownInFlightReads: vi.fn(),
    };
    const service = new ProjectsService(source, config, issuesCacheStub);

    await service.listProjectCatalog();
    expect(catalogReads).toBe(1);

    service.dropCaches();
    await service.listProjectCatalog();
    expect(catalogReads).toBe(1);

    // "Sync now" means "something moved that you cannot see", which covers a
    // board renamed on Github — so that one still drops it.
    await service.resync();
    await service.listProjectCatalog();
    expect(catalogReads).toBe(2);
  });

  it('ProjectsService drops the board catalog after a write that made a project (#982)', async () => {
    // Making a project is the one write that changes which boards exist, so the
    // next picker and the preview strip have to read the catalog again.
    let catalogReads = 0;
    const source: IProjectsSource = {
      listProjects: async () => [rollup(1)],
      getProject: async () => null,
      projectMemberships: async () => [],
      listProjectCatalog: async () => {
        catalogReads += 1;
        return [];
      },
      disownInFlightReads: vi.fn(),
    };
    const service = new ProjectsService(source, config, issuesCacheStub);

    await service.listProjectCatalog();
    service.dropCaches(['issue.project.add']);
    await service.listProjectCatalog();
    expect(catalogReads).toBe(1);

    service.dropCaches(['issue.project.create', 'issue.project.add']);
    await service.listProjectCatalog();
    expect(catalogReads).toBe(2);
  });
});

describe('"Sync now" gets the same three moves a drop makes (#692)', () => {
  it('cannot be overtaken by a rollup read issued before it', async () => {
    // `rollupBoards` has no in-flight dedupe, so a read that went out a moment
    // before the button lands after the warm it triggered. Without the epoch it
    // overwrites the warm — a sync that ends by putting back the boards it was
    // pressed to replace.
    const gate = makeGate();
    const source: IProjectsSource = {
      listProjects: () => gate.pass((n) => [rollup(n)]),
      getProject: async () => null,
      projectMemberships: async () => [],
      listProjectCatalog: async () => [],
      disownInFlightReads: vi.fn(),
    };
    const service = new ProjectsService(source, config, issuesCacheStub);
    const nameOf = async () => (await service.listProjects(undefined))[0]?.name;

    gate.holdNext();
    const early = service.listProjects(undefined);
    await service.resync();
    gate.open();
    await early;

    expect(await nameOf()).toBe('board as of read 2');
    expect(gate.calls()).toBe(2);
  });
});

/** The two shapes a route declares, and one that declares nothing. */
@Controller('t')
class WritesTestController {
  @Writes('issue.close')
  @Post('close')
  close(): { state: 'closed' } {
    return { state: 'closed' };
  }

  @Writes()
  @Post('no-github')
  noGithub(): { ok: true } {
    return { ok: true };
  }

  @Writes('issue.close')
  @Post('refused')
  refused(): never {
    throw new BadRequestException('nope');
  }

  @Post('undeclared')
  undeclared(): { ok: true } {
    return { ok: true };
  }

  @Writes('issue.close')
  @Get('read')
  read(): { ok: true } {
    return { ok: true };
  }
}

describe('the hook is generic over @Writes, not wired per action (#692)', () => {
  const invalidateAll = vi.fn();
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WritesTestController],
      providers: [
        { provide: FreshnessRegistry, useValue: { invalidateAll } },
        { provide: APP_INTERCEPTOR, useClass: WriteFreshnessInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as AddressInfo | string | null;
    if (!address || typeof address === 'string') throw new Error('test server did not bind a port');
    port = address.port;
  });

  afterAll(async () => {
    await app?.close();
  });

  /** One request through the real pipeline; answers the status code. */
  const hit = (method: 'POST' | 'GET', path: string): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });

  it('drops every cache after a route that declares a Github capability', async () => {
    invalidateAll.mockClear();
    expect(await hit('POST', '/t/close')).toBe(201);
    expect(invalidateAll).toHaveBeenCalledTimes(1);
    // What the route declared goes with it, so the projects catalog can tell a
    // write that made a project from one that did not (#982).
    expect(invalidateAll).toHaveBeenCalledWith(['issue.close']);
  });

  it('drops nothing for @Writes() — the nine routes that write no Github', async () => {
    invalidateAll.mockClear();
    expect(await hit('POST', '/t/no-github')).toBe(201);
    expect(invalidateAll).not.toHaveBeenCalled();
  });

  it('drops nothing when the write failed', async () => {
    invalidateAll.mockClear();
    expect(await hit('POST', '/t/refused')).toBe(400);
    expect(invalidateAll).not.toHaveBeenCalled();
  });

  it('drops nothing for a route that declares no @Writes at all', async () => {
    // Absent metadata is not an answer — `CapabilityGuard` denies such a route
    // before it runs, and this must not be the thing that gives it meaning.
    invalidateAll.mockClear();
    expect(await hit('POST', '/t/undeclared')).toBe(201);
    expect(invalidateAll).not.toHaveBeenCalled();
  });

  it('drops nothing for a read, whatever it declares', async () => {
    invalidateAll.mockClear();
    expect(await hit('GET', '/t/read')).toBe(200);
    expect(invalidateAll).not.toHaveBeenCalled();
  });

  it('answers the write without waiting for the invalidation to finish', async () => {
    // The refills are started inside `invalidateAll` and never awaited. This is
    // the same property one rung out: the INTERCEPTOR must not wait for it
    // either. Make it await — `concatMap(() => registry.invalidateAll())` in
    // place of the `tap` — and this request never gets an answer, which is a
    // confirm dialog spinning until the socket times out.
    invalidateAll.mockClear();
    invalidateAll.mockImplementation(() => new Promise(() => {}));

    expect(await hit('POST', '/t/close')).toBe(201);

    expect(invalidateAll).toHaveBeenCalledTimes(1);
    invalidateAll.mockReset();
  });
});
