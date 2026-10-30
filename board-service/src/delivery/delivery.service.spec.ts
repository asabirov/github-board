import { describe, it, expect, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { DeliveryService } from './delivery.service';
import type { DeliveryData, IDeliverySource } from './delivery.types';

const data: DeliveryData = { releases: [], merges: [], unassignedPrs: 30, releaseDates: [], releasesPartial: false, releaseScope: 'acme' };

function make(ttlMs: number, load: IDeliverySource['load']) {
  const source = { load: vi.fn(load) } as unknown as IDeliverySource & {
    load: ReturnType<typeof vi.fn>;
  };
  // `GITHUB_ORGS` is pinned at the org this file's expectations name (#1166):
  // it was the default too until the organisation was renamed to `acme`.
  const config = {
    get: (k: string, d?: unknown) =>
      k === 'AUTH_DISABLED' ? true : k === 'DELIVERY_CACHE_TTL_MS' ? ttlMs : k === 'GITHUB_ORGS' ? 'acme' : d,
  } as unknown as ConfigService;
  return { svc: new DeliveryService(source, config), source };
}
const flush = () => new Promise((r) => setImmediate(r));

describe('DeliveryService cache (#173 — stale-while-revalidate)', () => {
  it('serves a fresh cache without re-fetching', async () => {
    const { svc, source } = make(10_000, async () => data);
    await svc.getDelivery();
    const second = await svc.getDelivery();
    expect(source.load).toHaveBeenCalledTimes(1);
    expect(second.unassignedPrs).toBe(30);
    expect(typeof second.updatedAt).toBe('string');
  });

  it('serves stale immediately and refreshes in the background', async () => {
    const { svc, source } = make(0, async () => data); // ttl 0 → always stale after first
    await svc.getDelivery(); // cold: fetch #1
    expect(source.load).toHaveBeenCalledTimes(1);
    await svc.getDelivery(); // stale: returns at once + triggers background refresh
    await flush();
    expect(source.load).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent cold loads into one fetch', async () => {
    const { svc, source } = make(10_000, () => new Promise((res) => setTimeout(() => res(data), 20)));
    await Promise.all([svc.getDelivery(), svc.getDelivery()]);
    expect(source.load).toHaveBeenCalledTimes(1);
  });

  it('a cold-load failure propagates (no cache to fall back on)', async () => {
    const { svc } = make(10_000, async () => {
      throw new Error('creds');
    });
    await expect(svc.getDelivery()).rejects.toThrow('creds');
  });

  it('onModuleInit warms the cache so the first request is already fresh', async () => {
    const { svc, source } = make(10_000, async () => data);
    svc.onModuleInit();
    await flush();
    expect(source.load).toHaveBeenCalledTimes(1); // warmed at boot
    await svc.getDelivery(); // served from the warm cache — no new fetch
    expect(source.load).toHaveBeenCalledTimes(1);
  });
});

/**
 * The rollup is an answer ABOUT an org (#648), so both caches are keyed by the
 * org the fetch was made against. One instance is driven across two orgs by
 * changing what the mocked ConfigService returns between reads — which is what a
 * request-supplied org would do later.
 */
describe('DeliveryService — caches keyed by org (#648)', () => {
  const ALPHA = 'org-alpha';
  const BETA = 'org-beta';

  /** Two orgs' streams, same SHAPE and same lengths, different content — so
   *  serving one for the other changes every field a reader can see, and a
   *  length check could never catch the swap. */
  const BY_ORG: Record<string, DeliveryData> = {
    [ALPHA]: {
      releases: [
        { repo: 'alpha-web', tag: 'v1.0.0', name: 'Alpha one', htmlUrl: 'https://x/a/1', atISO: '2026-08-01T00:00:00.000Z' },
      ],
      merges: [
        { repo: 'alpha-web', number: 11, title: 'Alpha merge', htmlUrl: 'https://x/a/11', author: 'octocat', atISO: '2026-08-02T00:00:00.000Z' },
      ],
      unassignedPrs: 30,
      releaseDates: ['2026-08-01T00:00:00.000Z'],
      releasesPartial: false,
      releaseScope: ALPHA,
    },
    [BETA]: {
      releases: [
        { repo: 'beta-web', tag: 'v9.9.9', name: 'Beta nine', htmlUrl: 'https://x/b/9', atISO: '2026-08-03T00:00:00.000Z' },
      ],
      merges: [
        { repo: 'beta-web', number: 99, title: 'Beta merge', htmlUrl: 'https://x/b/99', author: 'IvanRoslov', atISO: '2026-08-04T00:00:00.000Z' },
      ],
      unassignedPrs: 7,
      releaseDates: ['2026-08-03T00:00:00.000Z'],
      releasesPartial: false,
      releaseScope: BETA,
    },
  };

  /** A service whose configured org can change between reads, over a source that
   *  answers for whichever org was configured AT CALL TIME (so a slow fetch still
   *  belongs to the org that started it). */
  function make2(delayMs = 0) {
    let org = ALPHA;
    const load = vi.fn(() => {
      const answer = BY_ORG[org];
      return delayMs
        ? new Promise<DeliveryData>((r) => setTimeout(() => r(answer), delayMs))
        : Promise.resolve(answer);
    });
    const source = { load } as unknown as IDeliverySource;
    const config = {
      get: (k: string, d?: unknown) =>
        k === 'GITHUB_ORGS' ? org : k === 'DELIVERY_CACHE_TTL_MS' ? 10_000 : d,
    } as unknown as ConfigService;
    return {
      svc: new DeliveryService(source, config),
      load,
      use: (next: string) => {
        org = next;
      },
    };
  }

  const cacheOf = (svc: DeliveryService) =>
    (svc as unknown as { cacheByOrg: Map<string, unknown> }).cacheByOrg;

  it('one configured org allocates exactly one slot', async () => {
    const { svc, source } = make(10_000, async () => data);

    await svc.getDelivery();
    await svc.getDelivery();
    svc.onModuleInit(); // the boot warm refetches unconditionally, as it always has
    await flush();

    expect(source.load).toHaveBeenCalledTimes(2); // one cold read + the warm
    expect(cacheOf(svc).size).toBe(1); // …into the same single slot
    expect([...cacheOf(svc).keys()]).toEqual(['acme']);
  });

  it("two orgs' answers do not overwrite each other", async () => {
    const { svc, load, use } = make2();

    const alpha = await svc.getDelivery();
    use(BETA);
    const beta = await svc.getDelivery();
    use(ALPHA);
    const alphaAgain = await svc.getDelivery();

    // Both slots coexist — beta's read did not evict or overwrite alpha's.
    expect(cacheOf(svc).size).toBe(2);
    expect([...cacheOf(svc).keys()].sort()).toEqual([ALPHA, BETA]);
    // Each org's read is its OWN org's stream, item for item.
    expect(alpha.unassignedPrs).toBe(30);
    expect(beta.unassignedPrs).toBe(7);
    expect(alpha.merges[0]).toMatchObject({ number: 11, repo: 'alpha-web' });
    expect(beta.merges[0]).toMatchObject({ number: 99, repo: 'beta-web' });
    expect(alpha.releases[0].tag).toBe('v1.0.0');
    expect(beta.releases[0].tag).toBe('v9.9.9');
    // Alpha still serves alpha from cache: two orgs, two fetches, no third.
    expect(alphaAgain).toEqual(alpha);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('the in-flight dedupe is per-org: two orgs in flight together are two fetches', async () => {
    const { svc, load, use } = make2(5);

    const alphaRead = svc.getDelivery(); // starts alpha's fetch, still in flight…
    use(BETA);
    const betaRead = svc.getDelivery(); // …beta must not ride alpha's promise
    const [alpha, beta] = await Promise.all([alphaRead, betaRead]);

    expect(load).toHaveBeenCalledTimes(2);
    expect(alpha.unassignedPrs).toBe(30);
    expect(beta.unassignedPrs).toBe(7);
  });

  it('one org in flight twice is still deduped into one fetch', async () => {
    const { svc, load } = make2(5);

    const [a, b] = await Promise.all([svc.getDelivery(), svc.getDelivery()]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });
});

/**
 * The in-flight slot belongs to the fetch that put it there.
 *
 * No production path reaches this today: `DeliveryService` is the one cache of
 * the six with no `dropCaches()`, so nothing clears `inFlightByOrg` mid-fetch
 * and a landing read can only ever find its own promise there. The check is the
 * shape `ProjectsService` and `IssueBucketsService` already carry (#692), and
 * this drives it directly because the entry point cannot: the day delivery grows
 * a drop, an unconditional delete would have a read deleting a newer read's slot
 * and two fetches going out where the dedupe promises one.
 */
describe('DeliveryService in-flight slot (#692 shape)', () => {
  type Inner = { inFlightByOrg: Map<string, Promise<unknown>> };

  it("a landing fetch clears only its OWN slot, never a newer read's", async () => {
    // Both fetches are held open, because a second read that has already landed
    // has legitimately cleared its own slot and the check would prove nothing.
    const gates: (() => void)[] = [];
    const { svc, source } = make(10_000, async () => {
      await new Promise<void>((r) => gates.push(r));
      return data;
    });
    const inFlight = (svc as unknown as Inner).inFlightByOrg;

    const stalled = svc.getDelivery(); // cold: takes the slot, then blocks
    await flush();
    expect(inFlight.size).toBe(1);

    // What a `dropCaches()` would do — the only way to reach this state.
    inFlight.clear();
    const second = svc.getDelivery(); // a NEW fetch, and a new slot
    await flush();
    expect(source.load).toHaveBeenCalledTimes(2);
    const newer = inFlight.get('acme');
    expect(newer).toBeDefined();

    gates[0]();
    await stalled;

    // The older read landed. The newer one is still running, and still owns the
    // slot every later caller would be deduped onto.
    expect(inFlight.get('acme')).toBe(newer);

    gates[1]();
    await second;
    expect(inFlight.has('acme')).toBe(false);
  });
});
