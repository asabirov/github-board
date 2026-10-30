import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { IssueBucketsService } from './issue-buckets.service';
import { IIssueBucketsSource, IssueBucketCounts, IssueBuckets } from './issue-buckets.types';

function config(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    GITHUB_ORGS: 'acme',
    ISSUE_BUCKETS_CACHE_TTL_MS: 60_000,
    ...overrides,
  };
  return { get: (k: string, d?: unknown) => values[k] ?? d } as unknown as ConfigService;
}

class StubSource implements IIssueBucketsSource {
  calls = 0;
  constructor(private readonly value: IssueBucketCounts) {}
  counts(): Promise<IssueBucketCounts> {
    this.calls += 1;
    return Promise.resolve(this.value);
  }
}

const COUNTS = { open: 223, bugs: 19, feedback: 3, unassigned: 62 };

describe('IssueBucketsService', () => {
  it('returns the four counts with a synced stamp and matching links', async () => {
    const svc = new IssueBucketsService(new StubSource(COUNTS), config());
    const b = await svc.getBuckets();

    expect(b).toMatchObject(COUNTS);
    expect(Date.parse(b.syncedAt)).not.toBeNaN();
    // Every count has a deep-link, and the link's query is scoped to the org.
    for (const key of ['open', 'bugs', 'feedback', 'unassigned'] as const) {
      expect(b.links[key]).toContain('github.com/search');
      expect(decodeURIComponent(b.links[key])).toContain('org:acme');
    }
    // The bug/unassigned links carry their distinguishing filter (count ↔ link agree).
    expect(decodeURIComponent(b.links.bugs)).toContain('label:bug');
    expect(decodeURIComponent(b.links.unassigned)).toContain('no:assignee');
  });

  it('serves a fresh cache without re-fetching (dedupe within TTL)', async () => {
    const source = new StubSource(COUNTS);
    const svc = new IssueBucketsService(source, config());

    await svc.getBuckets();
    await svc.getBuckets();

    expect(source.calls).toBe(1);
  });

  it('re-fetches once the cache is older than the TTL', async () => {
    const source = new StubSource(COUNTS);
    // TTL of 0 makes every read count as stale immediately.
    const svc = new IssueBucketsService(source, config({ ISSUE_BUCKETS_CACHE_TTL_MS: 0 }));

    const first = await svc.getBuckets(); // cold → fetch #1
    const second = await svc.getBuckets(); // stale → serves cache, kicks bg fetch #2
    await new Promise((r) => setImmediate(r)); // let the background refresh settle

    expect(second).toEqual(first); // stale-while-revalidate serves the cached value
    expect(source.calls).toBeGreaterThanOrEqual(2);
  });

  it('propagates a cold-fetch failure instead of serving zeros', async () => {
    const failing: IIssueBucketsSource = { counts: () => Promise.reject(new Error('bad creds')) };
    const svc = new IssueBucketsService(failing, config());

    await expect(svc.getBuckets()).rejects.toThrow('bad creds');
  });
});

/**
 * The counts are an answer ABOUT an org (#648), so every cache is keyed by the
 * org the fetch was made against. One instance is driven across two orgs by
 * changing what the mocked ConfigService returns between reads — which is what a
 * request-supplied org would do later.
 */
describe('IssueBucketsService — caches keyed by org (#648)', () => {
  const ALPHA = 'org-alpha';
  const BETA = 'org-beta';

  /** Two orgs whose counts differ field by field, not in length: swapping the
   *  answers over would change every number, never just the size. */
  const BY_ORG: Record<string, IssueBucketCounts> = {
    [ALPHA]: { open: 223, bugs: 19, feedback: 3, unassigned: 62 },
    [BETA]: { open: 4, bugs: 91, feedback: 7, unassigned: 1 },
  };

  /** A ConfigService whose org answer can change between reads. */
  function switchable(initial: string) {
    let org = initial;
    const config = {
      get: (k: string, d?: unknown) =>
        k === 'GITHUB_ORGS' ? org : k === 'ISSUE_BUCKETS_CACHE_TTL_MS' ? 60_000 : d,
    } as unknown as ConfigService;
    return {
      config,
      current: () => org,
      use: (next: string) => {
        org = next;
      },
    };
  }

  /** Answers with the counts of whichever org is configured AT CALL TIME, so a
   *  slow fetch still belongs to the org that started it. */
  class OrgSource implements IIssueBucketsSource {
    calls = 0;
    constructor(
      private readonly current: () => string,
      private readonly delayMs = 0,
    ) {}
    counts(): Promise<IssueBucketCounts> {
      this.calls += 1;
      const answer = BY_ORG[this.current()];
      if (!this.delayMs) return Promise.resolve(answer);
      return new Promise((r) => setTimeout(() => r(answer), this.delayMs));
    }
  }

  const cacheOf = (svc: IssueBucketsService) =>
    (svc as unknown as { cacheByScope: Map<string, IssueBuckets> }).cacheByScope;

  it('one configured org allocates exactly one slot', async () => {
    const svc = new IssueBucketsService(new StubSource(COUNTS), config());

    await svc.getBuckets();
    await svc.getBuckets();
    await svc.resync();

    expect(cacheOf(svc).size).toBe(1);
    expect([...cacheOf(svc).keys()]).toEqual(['acme']);
  });

  it("two orgs' answers do not overwrite each other", async () => {
    const { config: cfg, current, use } = switchable(ALPHA);
    const source = new OrgSource(current);
    const svc = new IssueBucketsService(source, cfg);

    const alpha = await svc.getBuckets();
    use(BETA);
    const beta = await svc.getBuckets();
    use(ALPHA);
    const alphaAgain = await svc.getBuckets();

    // Both slots coexist — beta's read did not evict or overwrite alpha's.
    expect(cacheOf(svc).size).toBe(2);
    expect([...cacheOf(svc).keys()].sort()).toEqual([ALPHA, BETA]);
    // And each org's read is its OWN org's answer, counts and deep-links alike.
    expect(alpha).toMatchObject(BY_ORG[ALPHA]);
    expect(beta).toMatchObject(BY_ORG[BETA]);
    expect(decodeURIComponent(alpha.links.open)).toContain(`org:${ALPHA}`);
    expect(decodeURIComponent(beta.links.open)).toContain(`org:${BETA}`);
    // Alpha still serves alpha from cache: two orgs, two fetches, no third.
    expect(alphaAgain).toEqual(alpha);
    expect(source.calls).toBe(2);
  });

  it('the in-flight dedupe is per-org: two orgs in flight together are two fetches', async () => {
    const { config: cfg, current, use } = switchable(ALPHA);
    const source = new OrgSource(current, 5);
    const svc = new IssueBucketsService(source, cfg);

    const alphaRead = svc.getBuckets(); // starts alpha's fetch, still in flight…
    use(BETA);
    const betaRead = svc.getBuckets(); // …beta must not ride alpha's promise
    const [alpha, beta] = await Promise.all([alphaRead, betaRead]);

    expect(source.calls).toBe(2);
    expect(alpha).toMatchObject(BY_ORG[ALPHA]);
    expect(beta).toMatchObject(BY_ORG[BETA]);
  });

  it('one org in flight twice is still deduped into one fetch', async () => {
    const { config: cfg, current } = switchable(ALPHA);
    const source = new OrgSource(current, 5);
    const svc = new IssueBucketsService(source, cfg);

    const [a, b] = await Promise.all([svc.getBuckets(), svc.getBuckets()]);

    expect(source.calls).toBe(1);
    expect(b).toEqual(a);
  });
});

/**
 * The counts cover EVERY org the board serves (#697), so the scope of an answer
 * is a set of orgs rather than one org. Driven at the service, where the links a
 * user clicks are built and where the cache decides what a read may be served.
 */
describe('IssueBucketsService — counts cover every org the board serves (#697)', () => {
  const BOTH = 'org-alpha,org-beta';

  /** Counts per SCOPE. The union is its own answer — no field of it equals the
   *  single org's, so serving one as the other can never look right. */
  const BY_SCOPE: Record<string, IssueBucketCounts> = {
    [BOTH]: { open: 227, bugs: 110, feedback: 10, unassigned: 63 },
    'org-alpha': { open: 223, bugs: 19, feedback: 3, unassigned: 62 },
  };

  /** A ConfigService whose owner scope can be narrowed between reads. It was
   *  `ISSUE_BUCKETS_ORG` that narrowed it; that key is retired (#1209 part 4),
   *  so the scope changes the only way it still can — `GITHUB_ORGS` itself, on
   *  the no-person path these tests run. What is under test here is the CACHE
   *  keying, which must not serve one scope's counts to another, and that rule
   *  did not move with the key. */
  function pinnable(orgs: string) {
    const values: Record<string, unknown> = {
      GITHUB_ORGS: orgs,
      ISSUE_BUCKETS_CACHE_TTL_MS: 60_000,
    };
    return {
      config: {
        get: (k: string, d?: unknown) => (k in values ? values[k] : d),
      } as unknown as ConfigService,
      scope: () => String(values.GITHUB_ORGS),
      pin: (org: string) => {
        values.GITHUB_ORGS = org;
      },
      unpin: () => {
        values.GITHUB_ORGS = orgs;
      },
    };
  }

  /** Answers with the counts of whichever SCOPE is configured at call time, and
   *  can be switched to failing — which is the only way a read reaches back for
   *  what a drop retired. */
  class ScopeSource implements IIssueBucketsSource {
    calls = 0;
    failing = false;
    constructor(private readonly scope: () => string) {}
    counts(): Promise<IssueBucketCounts> {
      this.calls += 1;
      if (this.failing) return Promise.reject(new Error('bad creds'));
      return Promise.resolve(BY_SCOPE[this.scope()]);
    }
  }

  it('links every bucket at both orgs when no key pins one', async () => {
    const { config: cfg, scope } = pinnable(BOTH);
    const svc = new IssueBucketsService(new ScopeSource(scope), cfg);

    const b = await svc.getBuckets();

    expect(b).toMatchObject(BY_SCOPE[BOTH]);
    for (const key of ['open', 'bugs', 'feedback', 'unassigned'] as const) {
      // Both qualifiers, in one query: the list behind the count is the union.
      expect(decodeURIComponent(b.links[key]), key).toContain('org:org-alpha org:org-beta');
    }
  });

  it('a narrowed scope is a different answer, not the cached union', async () => {
    // The cache is keyed by the SCOPE of the answer. Pinning one org after a
    // two-org read must re-read; serving the union's numbers under one org's
    // name is the failure this guards.
    const { config: cfg, scope, pin } = pinnable(BOTH);
    const source = new ScopeSource(scope);
    const svc = new IssueBucketsService(source, cfg);

    const union = await svc.getBuckets();
    pin('org-alpha');
    const alone = await svc.getBuckets();

    expect(union).toMatchObject(BY_SCOPE[BOTH]);
    expect(alone).toMatchObject(BY_SCOPE['org-alpha']);
    expect(decodeURIComponent(alone.links.open)).not.toContain('org:org-beta');
    expect(source.calls).toBe(2);
  });

  it('the counts a drop retired are served back to their OWN scope, never another', async () => {
    // What a drop retires is keyed by scope for the same reason the cache is:
    // the union's numbers served under one org's name read as that org's, and
    // its links would open a list covering an org the count was never about.
    // The narrow scope is read FIRST so the union is what a single shared slot
    // would end up holding — the wrong answer has to be the one still there.
    const { config: cfg, scope, pin, unpin } = pinnable(BOTH);
    const source = new ScopeSource(scope);
    const svc = new IssueBucketsService(source, cfg);

    pin('org-alpha');
    await svc.getBuckets();
    unpin();
    await svc.getBuckets();

    svc.dropCaches();
    source.failing = true;
    pin('org-alpha');
    const served = await svc.getBuckets();

    expect(served).toMatchObject(BY_SCOPE['org-alpha']);
    expect(served.open).not.toBe(BY_SCOPE[BOTH].open);
    expect(decodeURIComponent(served.links.open)).not.toContain('org:org-beta');
  });
});

/**
 * What the Board sync panel's Issue buckets row reads (#1169).
 *
 * The row used to read a manual run held in one tab and said "Not recorded"
 * about counts that had just been fetched. It reads this instead, and this is
 * the stamp on the counts being served — not a second record beside them, which
 * is the thing that could disagree.
 */
describe('IssueBucketsService.lastSyncedAt (#1169)', () => {
  it('has no record before anything has read the counts', () => {
    expect(new IssueBucketsService(new StubSource(COUNTS), config()).lastSyncedAt()).toBeNull();
  });

  it('reports the stamp on the counts it is serving, not a time of its own', async () => {
    const svc = new IssueBucketsService(new StubSource(COUNTS), config());
    const served = await svc.getBuckets();
    expect(svc.lastSyncedAt()).toBe(served.syncedAt);
  });

  it('asks the source nothing — opening a panel is not four Github searches', () => {
    const source = new StubSource(COUNTS);
    const svc = new IssueBucketsService(source, config());
    svc.lastSyncedAt();
    svc.lastSyncedAt();
    expect(source.calls).toBe(0);
  });

  it('moves with the counts when they are re-fetched', async () => {
    const svc = new IssueBucketsService(new StubSource(COUNTS), config());
    const first = await svc.getBuckets();
    await new Promise((r) => setTimeout(r, 2));
    await svc.resync();
    const after = svc.lastSyncedAt();
    expect(after).not.toBe(first.syncedAt);
    expect(Date.parse(after as string)).toBeGreaterThanOrEqual(Date.parse(first.syncedAt));
  });

  it('reports the retained copy after repeated invalidations (#1275)', async () => {
    const svc = new IssueBucketsService(new StubSource(COUNTS), config());
    const cached = await svc.getBuckets();
    svc.dropCaches();
    svc.dropCaches();
    expect(svc.lastSyncedAt()).toBe(cached.syncedAt);
  });
});
