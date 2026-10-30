/**
 * `use-cached-state.ts`, taken apart into the three pure pieces the hook is
 * assembled from, plus a text pin on the assembly.
 *
 * The pin is here because the hook itself cannot be exercised: the suite runs
 * `environment: 'node'`, so no effect fires and nothing re-renders. So the
 * rules live in
 * `seedCell`, `nextCell` and `persistCell`, which are ordinary functions, and
 * the claim that the hook still calls them the way it says it does is asserted
 * against its own source.
 */
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error node:fs is untyped here; it exists in vitest's node env.
import { readFileSync } from 'node:fs';
import {
  PAYLOAD_CACHE_PREFIX,
  claimFor,
  setPayloadStore,
  writePayload,
  type PayloadStore,
  type PayloadKey,
  currentSensitiveGeneration,
  forgetSensitivePayloads,
  readPayload,
} from './payload-cache';
import { markSensitiveResponse, setResponseIdentity, tagResponse } from '../auth/response-deadline';
import { nextCell, persistCell, seedCell, staleSensitive, type CachedCell } from './use-cached-state';

class FakeStore implements PayloadStore {
  readonly map = new Map<string, string>();
  get length(): number { return this.map.size; }
  key(i: number): string | null { return [...this.map.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

function claimed(): FakeStore {
  const store = new FakeStore();
  setPayloadStore(store);
  claimFor('octocat@example.com');
  return store;
}

const SOURCE: string = readFileSync(new URL('./use-cached-state.ts', import.meta.url), 'utf8');

afterEach(() => setPayloadStore(undefined));

// On `people`, which is the roster and carries no access lease. These are about
// the MECHANICS of a seed — what the cell holds and how it is marked — and My
// work now answers a second question on the way in, which `arrival-seed.spec.ts`
// owns: whether a fresh document would have opened on this entry at all (#1027).
describe('what a key opens on', () => {
  it('seeds from the cache when there is something under the key', () => {
    claimed();
    writePayload('people', { queue: 'octocat' });
    expect(seedCell('people')).toEqual({
      key: 'people',
      value: { queue: 'octocat' },
      stored: false,
      sensitiveAt: currentSensitiveGeneration(),
    });
  });

  it('seeds null when there is not, which is what the page used to start on', () => {
    claimed();
    expect(seedCell('people').value).toBeNull();
  });

  it('marks a seed as coming from disk, so nothing re-stamps it on the way in', () => {
    claimed();
    writePayload('people', { queue: 'octocat' });
    expect(seedCell('people').stored).toBe(false);
  });
});

describe('the setter takes what `useState` takes', () => {
  it('replaces on a plain value', () => {
    const prev: CachedCell<{ a: number }> = { key: 'delivery', value: { a: 1 }, stored: true, sensitiveAt: currentSensitiveGeneration() };
    expect(nextCell(prev, 'delivery', { a: 2 })).toEqual({
      key: 'delivery',
      value: { a: 2 },
      stored: true,
      sensitiveAt: currentSensitiveGeneration(),
    });
  });

  it('hands an updater what the page last saw', () => {
    const prev: CachedCell<number> = { key: 'delivery', value: 1, stored: true, sensitiveAt: currentSensitiveGeneration() };
    expect(nextCell<number>(prev, 'delivery', (n) => (n ?? 0) + 1).value).toBe(2);
  });

  it('takes a null, which is a page saying it has no answer', () => {
    const prev: CachedCell<{ a: number }> = { key: 'delivery', value: { a: 1 }, stored: true, sensitiveAt: currentSensitiveGeneration() };
    expect(nextCell(prev, 'delivery', null).value).toBeNull();
  });

  it('shows an updater null when the key has changed under it', () => {
    const prev: CachedCell<string[]> = { key: 'projects:acme', value: ['a board'], stored: true, sensitiveAt: currentSensitiveGeneration() };
    expect(nextCell(prev, 'projects:globex', (v) => v).value).toBeNull();
  });
});

describe('what gets written through', () => {
  it('stores a value the page set', () => {
    const store = claimed();
    persistCell({ key: 'delivery', value: { a: 1 }, stored: true, sensitiveAt: currentSensitiveGeneration() });
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}delivery`)).toBe(true);
  });

  it('does not re-store a seed, so reading cannot keep an entry alive', () => {
    const store = claimed();
    persistCell({ key: 'delivery', value: { a: 1 }, stored: false, sensitiveAt: currentSensitiveGeneration() });
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}delivery`)).toBe(false);
  });

  it('stores nothing for a null, since an absent entry says the same thing', () => {
    const store = claimed();
    persistCell({ key: 'delivery', value: null, stored: true, sensitiveAt: currentSensitiveGeneration() });
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}delivery`)).toBe(false);
  });

  it('writes under the key the cell carries, not under whatever the render was on', () => {
    const store = claimed();
    persistCell({ key: 'issues/metrics:globex', value: ['a board'], stored: true, sensitiveAt: currentSensitiveGeneration() });
    expect([...store.map.keys()]).toContain(`${PAYLOAD_CACHE_PREFIX}issues/metrics:globex`);
  });
});

describe('how the hook is wired, pinned as text', () => {
  it('writes through from an effect and not from the setter', () => {
    expect(SOURCE).toMatch(/useEffect\(\s*\(\)\s*=>\s*\{\s*persistCell\(live, generation\.current\);/);
    expect(SOURCE).not.toMatch(/setCell\([^)]*persistCell/);
  });

  it('re-seeds when the key changes rather than painting the previous value', () => {
    // `seedCell<T>(key` and not `seedCell<T>(key)`: the seed carries the
    // caller's shape test as a second argument since #824's follow-up, and the
    // claim here is about the RE-SEED, not about the arity.
    expect(SOURCE).toMatch(/if \(cell\.key !== key \|\| staleSensitive\(cell\)\) \{\s*live = seedCell<T>\(key[,)]/);
  });

  it('carries the caller’s shape test into the seed, on the first key and on a change', () => {
    // A payload was handed to a render on faith: the envelope was checked and
    // the value was not. Both seeds take the predicate, or one of the two
    // re-opens the hole on the next org.
    expect(SOURCE).toMatch(/useState<CachedCell<T>>\(\(\) => seedCell<T>\(key, accept\)\)/);
    expect(SOURCE).toMatch(/live = seedCell<T>\(key, accept\);/);
  });

  it('rebuilds the setter when the key changes, so a write cannot go to the old key', () => {
    expect(SOURCE).toMatch(/nextCell\(prev, key, update\)[\s\S]*?\[key\],/);
  });
});

/**
 * The frame between a check landing and the clearing effect (#892 review, C2
 * follow-up).
 *
 * `ProjectsView` clears its board in a `useEffect`, and an effect runs after the
 * browser has drawn. So the render that unhid the figures painted the OLD board
 * once before the clear reached it, and a mount seeded a board off the disk that
 * no check had authorized at all. Both are decided here instead, synchronously,
 * by the cell's own generation.
 */
describe('a sensitive cell from before the current access check', () => {
  afterEach(() => { setPayloadStore(null); });

  it('is stale for a sensitive key and not for any other', () => {
    const before = seedCell<string[]>('projects/7:acme');
    const queue = seedCell<string[]>('issues/mine');
    expect(staleSensitive(before), 'nothing has expired yet').toBe(false);
    forgetSensitivePayloads();
    expect(staleSensitive(before), 'the board is not this check`s to paint').toBe(true);
    expect(staleSensitive(queue), 'the queue joins private Project memberships').toBe(true);
  });

  it('is refused by persistCell, so it cannot be written back to the disk it left', () => {
    const map = new Map<string, string>();
    const store: PayloadStore = { get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
    setPayloadStore(store);
    claimFor('octocat@example.com');
    const held: CachedCell<string[]> = { key: 'projects/7:acme', value: ['a private board'], stored: true, sensitiveAt: currentSensitiveGeneration() };
    forgetSensitivePayloads();
    persistCell(held);
    expect(readPayload('projects/7:acme')).toBeNull();
  });

  it('is what the hook re-seeds on, in RENDER and not in an effect', () => {
    // The suite runs no effect, so the wiring is pinned as
    // text — and the claim is precisely about where the test sits.
    const source = readFileSync(new URL('./use-cached-state.ts', import.meta.url), 'utf8');
    expect(source).toContain('if (cell.key !== key || staleSensitive(cell)) {');
    const effect = source.slice(source.indexOf('useEffect(() => {'));
    expect(effect, 'the decision must not have moved into the effect').not.toContain('staleSensitive');
  });
});

// Enumerated from the twelve useCachedState calls in src, excluding specs and
// the hook definition. Repeated keys represent separate page call sites.
const CALL_SITES: Array<[string, PayloadKey, boolean]> = [
  ['ProjectsView detail', 'projects/7:acme', false],
  ['ProjectsView options', 'issues/filter-options', false],
  ['TeamView queue', 'issues/all:acme', false],
  ['TeamView options', 'issues/filter-options', false],
  ['TeamView metrics', 'issues/metrics:acme', true],
  ['Dashboard mine', 'issues/mine:acme', false],
  ['Dashboard options', 'issues/filter-options', false],
  ['Dashboard projects', 'projects:acme', false],
  ['Pulse projects', 'projects:acme', false],
  ['PersonPage queue', 'issues/all:acme', false],
  ['PersonPage metrics', 'issues/metrics:acme', true],
  ['PersonPage repos', 'repos:acme', false],
];

describe('persistence agrees with arrival', () => {
  afterEach(() => setResponseIdentity(null, false));

  for (const [page, key, plainReadable] of CALL_SITES) {
    for (const metadata of ['plain', 'sensitive', 'leased'] as const) {
      it(`${page}, ${metadata}: keeps live state and writes only an answer arrival can read`, () => {
        const store = claimed();
        setResponseIdentity('reader', metadata === 'leased', Date.now() + 60_000);
        const plain = { issues: [1] };
        const value = metadata === 'leased'
          ? tagResponse(plain, { expiresAt: Date.now() + 60_000, visibilityKey: 'reader' })
          : metadata === 'sensitive' ? markSensitiveResponse(plain) : plain;
        const cell = nextCell(seedCell(key), key, value);
        expect(cell.value).toBe(value);
        persistCell(cell);
        const readable = metadata === 'plain' ? plainReadable : metadata === 'leased' && key === 'issues/mine:acme';
        expect(store.map.has(PAYLOAD_CACHE_PREFIX + key)).toBe(readable);
        expect(seedCell(key).value).toEqual(readable ? plain : null);
      });
    }
  }
});
