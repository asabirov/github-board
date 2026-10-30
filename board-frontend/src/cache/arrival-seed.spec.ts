/**
 * What a page opens on when you WALK to it, against what it opens on when you
 * LOAD it (#1027), for every key and not just My work.
 *
 * The board has two ways to arrive at a page and they used to disagree about
 * the same stored answer. A LOAD runs `App`'s mount wipe first —
 * `forgetSensitivePayloads({ preserveLiveMine: true })` — so the page seeds
 * from a store already emptied of the sensitive keys unless the entry still
 * carries a running access lease. A click in the sidebar runs no wipe at all:
 * it only mounts the page, so the seed met yesterday's answer and painted it.
 *
 * The figures then disagreed for the whole of the new read, which is ~70s on a
 * cold production cache — long enough that the reader reads the tile, does not
 * believe it, and refreshes. That is the report.
 *
 * So the two are pinned together here rather than separately. Both paths are
 * driven through the real functions, and every test asserts they answer the
 * same thing: a test that only checked the loaded state is the test this issue
 * already had.
 *
 * Every key the four pages seed is driven, because the first fix covered
 * `issues/mine` alone and Overview and Repos went on painting figures their own
 * reads then contradicted — Overview on 56 issues against a true 26, Repos on 8
 * repositories against a true 5, both measured in a browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FILTER_OPTIONS_KEY, METRICS_KEY, MINE_KEY, ORG_QUEUE_KEY, PEOPLE_KEY,
  claimFor, forgetSensitivePayloads, orgScopedKey, projectsKey, reposKey,
  setPayloadStore, writePayload,
  type PayloadKey, type PayloadStore,
} from './payload-cache';
import { markSensitiveResponse, setResponseIdentity, tagResponse } from '../auth/response-deadline';
import { seedCell } from './use-cached-state';

class FakeStore implements PayloadStore {
  readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(i: number): string | null { return [...this.map.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

const ORG = 'acme';
const MINE = orgScopedKey(MINE_KEY, ORG);
const QUEUE = { issues: [{ number: 1 }] };

/** The keys the four pages of this issue seed, named by the page a reader would
 *  be looking at. `people` and `issues/metrics` are here too, and they are the
 *  two the wipe walks past — which is the point: agreement is not the same
 *  claim as "nothing is ever painted". */
const SEEDED: ReadonlyArray<{ page: string; key: PayloadKey; sensitiveKey: boolean }> = [
  { page: 'My work and Queue', key: MINE, sensitiveKey: true },
  { page: 'Overview, the org queue', key: orgScopedKey(ORG_QUEUE_KEY, ORG), sensitiveKey: true },
  { page: 'Overview, the metrics', key: orgScopedKey(METRICS_KEY, ORG), sensitiveKey: false },
  { page: 'Overview, the roster', key: PEOPLE_KEY, sensitiveKey: false },
  { page: 'Repos', key: reposKey(ORG), sensitiveKey: true },
  { page: 'the boards rollup', key: projectsKey(ORG), sensitiveKey: true },
  { page: "the queue's filter", key: FILTER_OPTIONS_KEY, sensitiveKey: true },
];

/** How an answer can be sitting on the disk when a new visit starts. */
type Served = 'no lease' | 'a running lease' | 'a lapsed lease' | 'marked sensitive, no lease';

/** A device that visited this page earlier today and stored what it was served. */
function visited(key: PayloadKey, served: Served, value: unknown = QUEUE): FakeStore {
  const store = new FakeStore();
  setPayloadStore(store);
  claimFor('octocat@example.com');
  // `supported` is what the service says about itself: a deployment whose
  // Github credential has no expiry sends `X-Board-Sensitive` and no lease
  // (`github-expiry.interceptor.ts:62` guards on `principal.expiresAt`), and
  // that is the deployment this issue was reported on.
  const leased = served === 'a running lease' || served === 'a lapsed lease';
  setResponseIdentity('octocat', leased, leased ? Date.now() + 60_000 : 0);
  if (leased) writePayload(key, tagResponse({ ...(value as object) }, { expiresAt: Date.now() + 60_000, visibilityKey: 'octocat' }));
  else if (served === 'marked sensitive, no lease') writePayload(key, markSensitiveResponse({ ...(value as object) }));
  else writePayload(key, { ...(value as object) });
  if (served === 'a lapsed lease') {
    vi.advanceTimersByTime(60_001);
    setResponseIdentity('octocat', true, Date.now() + 60_000);
  }
  return store;
}

/** Opening the page by loading the document: the mount wipe, then the seed. */
function byLoading(key: PayloadKey): unknown {
  forgetSensitivePayloads({ preserveLiveMine: true });
  return seedCell(key).value;
}

/** Opening the page by walking to it from another tab: the seed alone. */
function byWalking(key: PayloadKey): unknown {
  return seedCell(key).value;
}

afterEach(() => { setPayloadStore(undefined); setResponseIdentity(null, false); vi.useRealTimers(); });

describe('arriving at a page, by loading it and by walking to it', () => {
  for (const { page, key } of SEEDED) {
    for (const served of ['no lease', 'a running lease', 'a lapsed lease', 'marked sensitive, no lease'] as const) {
      it(`opens on the same thing either way — ${page}, stored with ${served}`, () => {
        vi.useFakeTimers();
        visited(key, served);
        const walked = byWalking(key);
        visited(key, served);
        const loaded = byLoading(key);
        expect(walked, `${key} walked to`).toEqual(loaded);
      });
    }
  }

  it('paints nothing on the keys a load has always emptied, however they were stored', () => {
    vi.useFakeTimers();
    for (const { key, sensitiveKey } of SEEDED) {
      if (!sensitiveKey) continue;
      visited(key, 'no lease');
      expect(byWalking(key), `${key} must not open on a stored answer`).toBeNull();
      visited(key, 'a running lease');
      // The one carve-out the wipe makes is My work's own running lease
      // (#1098), and the seed makes exactly the same one.
      expect(byWalking(key), `${key} with a running lease`).toEqual(key === MINE ? QUEUE : null);
    }
  });

  it('still opens the roster on the copy on disk, because a load does too', () => {
    visited(PEOPLE_KEY, 'no lease', { people: ['octocat'] });
    expect(byWalking(PEOPLE_KEY)).toEqual({ people: ['octocat'] });
    visited(PEOPLE_KEY, 'no lease', { people: ['octocat'] });
    expect(byLoading(PEOPLE_KEY)).toEqual({ people: ['octocat'] });
  });

  it('leaves nothing behind for the next arrival to paint either', () => {
    for (const { key, sensitiveKey } of SEEDED) {
      if (!sensitiveKey) continue;
      visited(key, 'no lease');
      byWalking(key);
      expect(byWalking(key), `${key} on the second arrival`).toBeNull();
    }
  });
});

/**
 * #824's rule, re-proved for the widened seed.
 *
 * The whole justification for keeping answers on a disk this app cannot
 * promise to be alone with is that nothing is ever painted for a person other
 * than the one it was stored for. The narrow fix was reviewed against that
 * rule; this widens which keys the seed touches and touches the store on a path
 * that used to be a pure read, so it is proved again rather than assumed.
 */
describe("a different person's stored answer", () => {
  it('is never what a page opens on, whichever key and whichever way you arrive', () => {
    for (const { key } of SEEDED) {
      const store = new FakeStore();
      setPayloadStore(store);
      // Somebody else was signed in here, and their answer was stored.
      claimFor('ivan@example.com');
      setResponseIdentity('ivan', false, 0);
      writePayload(key, { issues: [{ number: 999, title: "Ivan's private board" }] });
      // Now this person arrives. `claimFor` is what `App` runs once `fetchMe`
      // names the owner, and it takes the last person's entries with it.
      claimFor('octocat@example.com');
      setResponseIdentity('octocat', false, 0);
      expect(byWalking(key), `${key} walked to as another person`).toBeNull();
      expect(byLoading(key), `${key} loaded as another person`).toBeNull();
      expect(
        JSON.stringify([...store.map.values()]),
        `${key}: nothing of the previous person may remain on the disk`,
      ).not.toContain('Ivan');
    }
  });

  it('is refused on the Github access it was served under, not only on the email', () => {
    // The second half of #824's rule, and the one the owner stamp does not
    // cover: the same signed-in person, a DIFFERENT Github visibility. An
    // answer served under `ivan`'s access carries that visibility key in its
    // lease, and `validResponseDeadline` refuses a lease whose key is not the
    // one the current check reported. The seed must not have opened a way
    // round that on its new path through the store.
    for (const { key } of SEEDED) {
      const store = new FakeStore();
      setPayloadStore(store);
      claimFor('octocat@example.com');
      setResponseIdentity('ivan', true, Date.now() + 60_000);
      writePayload(key, tagResponse(
        { issues: [{ number: 999, title: "Ivan's private board" }] },
        { expiresAt: Date.now() + 60_000, visibilityKey: 'ivan' },
      ));
      setResponseIdentity('octocat', true, Date.now() + 60_000);
      expect(byWalking(key), `${key} walked to under another Github access`).toBeNull();
      expect(byLoading(key), `${key} loaded under another Github access`).toBeNull();
      expect(
        JSON.stringify([...store.map.values()]),
        `${key}: the refused entry must not be left on the disk either`,
      ).not.toContain('Ivan');
    }
  });
});
