/**
 * The rules `payload-cache.ts` has to keep, driven against a fake store.
 *
 * A fake and not the real thing because the suite runs `environment: 'node'`
 * and there is no `localStorage` in it — which is also why
 * every rule worth having here is a pure function taking its storage through
 * `setPayloadStore` rather than a component or an effect.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { savedBoard } from '../projects/projects-last-good';
import type { OrgQueue } from '../api/issues';
import { nextCell, persistCell, seedCell } from './use-cached-state';
import * as cacheModule from './payload-cache';
import {
  PAYLOAD_CACHE_PREFIX,
  PAYLOAD_CLOCK_TOLERANCE_MS,
  PAYLOAD_MAX_AGE_MS,
  PAYLOAD_OWNER_KEY,
  PAYLOAD_SCHEMA_VERSION,
  claimFor,
  forgetPayload,
  forgetPayloads,
  forgetSavedCopies,
  forgetSensitivePayloads,
  keepSaved,
  readSaved,
  orgScopedKey,
  projectKey,
  projectsKey,
  cachedOwner,
  hasCachedPayloads,
  readPayload,
  reposKey,
  setPayloadStore,
  writePayload,
  type PayloadKey,
  type PayloadStore,
} from './payload-cache';
import { setResponseIdentity } from '../auth/response-deadline';

/** `localStorage` as the app meets it, plus the two ways it fails: a cap that
 *  makes `setItem` throw the way a full quota does, and a whole store that
 *  throws on every access the way a private window can. */
class FakeStore implements PayloadStore {
  readonly map = new Map<string, string>();
  cap = Infinity;
  /** A BYTE budget, which is the shape of the failure `writePayload` defends
   *  against: `localStorage` is a few megabytes shared with every other key on
   *  the origin, and what refuses a write is the size of the value and not the
   *  number of entries. `cap` above models the count and cannot express a value
   *  that will never fit however much is dropped for it. */
  byteCap = Infinity;
  hostile = false;

  private bytes(exceptKey: string): number {
    let n = 0;
    for (const [k, v] of this.map) if (k !== exceptKey) n += k.length + v.length;
    return n;
  }

  get length(): number {
    if (this.hostile) throw new Error('denied');
    return this.map.size;
  }

  key(i: number): string | null {
    if (this.hostile) throw new Error('denied');
    return [...this.map.keys()][i] ?? null;
  }

  getItem(k: string): string | null {
    if (this.hostile) throw new Error('denied');
    return this.map.get(k) ?? null;
  }

  setItem(k: string, v: string): void {
    if (this.hostile) throw new Error('denied');
    if (!this.map.has(k) && this.map.size >= this.cap) throw new Error('QuotaExceededError');
    if (this.bytes(k) + k.length + v.length > this.byteCap) throw new Error('QuotaExceededError');
    this.map.set(k, v);
  }

  removeItem(k: string): void {
    if (this.hostile) throw new Error('denied');
    this.map.delete(k);
  }
}

/** A store already claimed by somebody, which is the state every page runs in:
 *  `App` renders nothing until `/api/auth/me` answers, and that answer claims. */
function claimed(email = 'octocat@example.com'): FakeStore {
  const store = new FakeStore();
  setPayloadStore(store);
  claimFor(email);
  return store;
}

/** An entry written by hand, so a test can put a timestamp or an owner in it
 *  that `writePayload` would never produce. */
function plant(store: FakeStore, key: string, entry: unknown): void {
  store.map.set(
    PAYLOAD_CACHE_PREFIX + key,
    JSON.stringify({ s: PAYLOAD_SCHEMA_VERSION, ...(entry as Record<string, unknown>) }),
  );
}

/** How many stored payloads are left, the owner stamp not being one. */
function entryCount(store: FakeStore): number {
  return [...store.map.keys()].filter((k) => k.startsWith(PAYLOAD_CACHE_PREFIX)).length;
}

/** Pin `Date.now`, so the eviction order below is the order these were written
 *  and not whatever the millisecond clock happened to do inside one tick.
 *
 *  Always near the real clock. Both the owner stamp and every entry are read
 *  through the freshness window, in both directions since the clock floor went
 *  in, so a fake time of 1000 makes the owner record unreadable and nothing is
 *  stored at all — which the first draft of these two tests did, and read as a
 *  quota result. */
function setNow(offsetMs: number | null, base = Date.now()): void {
  if (offsetMs === null) vi.useRealTimers();
  else { vi.useFakeTimers(); vi.setSystemTime(base + offsetMs); }
}

afterEach(() => {
  vi.useRealTimers();
  setPayloadStore(undefined);
});

describe('reading back what was stored', () => {
  it('returns the payload it was given', () => {
    claimed();
    writePayload('issues/mine', { issues: [1, 2, 3] });
    expect(readPayload('issues/mine')).toEqual({ issues: [1, 2, 3] });
  });

  it('keeps every entry under one prefix', () => {
    const store = claimed();
    writePayload('issues/mine', { a: 1 });
    expect([...store.map.keys()]).toContain(`${PAYLOAD_CACHE_PREFIX}issues/mine`);
  });

  it('answers null for a key nothing was stored under', () => {
    claimed();
    expect(readPayload('issues/mine')).toBeNull();
  });
});

describe('nothing survives a sign-out', () => {
  it('forgets the entries and the owner together', () => {
    const store = claimed();
    writePayload('issues/mine', { a: 1 });
    writePayload('delivery', { b: 2 });
    forgetPayloads();
    expect(readPayload('issues/mine')).toBeNull();
    expect(store.map.get(PAYLOAD_OWNER_KEY)).toBeUndefined();
    expect(store.map.size).toBe(0);
  });

  it('leaves the keys this file does not own alone', () => {
    const store = claimed();
    writePayload('issues/mine', { a: 1 });
    store.map.set('board_theme', 'dark');
    store.map.set('board_timezone', 'Europe/Amsterdam');
    store.map.set('board_org', 'acme');
    store.map.set('board_viewer:dashboard', '{"group":"type"}');
    store.map.set('board.search.recent.v1', '[]');
    forgetPayloads();
    expect([...store.map.keys()].sort()).toEqual([
      'board.search.recent.v1',
      'board_org',
      'board_theme',
      'board_timezone',
      'board_viewer:dashboard',
    ]);
  });
});

describe('the old `lessly_payload:` keys are carried forward once (#1450)', () => {
  it('copies the owner and every entry to `board_payload:`, and removes the old keys', () => {
    const store = new FakeStore();
    const owner = JSON.stringify({ o: 'octocat@example.com', t: Date.now() });
    const people = JSON.stringify({ s: PAYLOAD_SCHEMA_VERSION, o: 'octocat@example.com', t: Date.now(), v: ['ann'] });
    store.map.set('lessly_payload_owner', owner);
    store.map.set('lessly_payload:people', people);
    setPayloadStore(store);
    // The first read through the store migrates, then reads the new key.
    expect(cachedOwner()?.email).toBe('octocat@example.com');
    expect(readPayload('people')).toEqual(['ann']);
    expect(store.map.get(PAYLOAD_OWNER_KEY)).toBe(owner);
    expect(store.map.get(PAYLOAD_CACHE_PREFIX + 'people')).toBe(people);
    expect(store.map.has('lessly_payload_owner')).toBe(false);
    expect(store.map.has('lessly_payload:people')).toBe(false);
  });

  it('keeps a value already written under the new key', () => {
    const store = new FakeStore();
    store.map.set('lessly_payload:people', JSON.stringify({ s: PAYLOAD_SCHEMA_VERSION, o: 'octocat@example.com', t: Date.now(), v: ['old'] }));
    store.map.set('board_payload:people', JSON.stringify({ s: PAYLOAD_SCHEMA_VERSION, o: 'octocat@example.com', t: Date.now(), v: ['new'] }));
    store.map.set('board_payload_owner', JSON.stringify({ o: 'octocat@example.com', t: Date.now() }));
    setPayloadStore(store);
    expect(readPayload('people')).toEqual(['new']);
    expect(store.map.has('lessly_payload:people')).toBe(false);
  });
});

describe('nothing is painted for the wrong person', () => {
  it('wipes what the last person left when somebody else signs in', () => {
    claimed('octocat@example.com');
    writePayload('issues/mine', { queue: 'octocat' });
    claimFor('someone-else@example.com');
    expect(readPayload('issues/mine')).toBeNull();
  });

  it('deletes what the last person left, rather than only refusing it', () => {
    const store = claimed('octocat@example.com');
    writePayload('issues/mine', { queue: 'octocat' });
    claimFor('someone-else@example.com');
    expect([...store.map.keys()]).toEqual([PAYLOAD_OWNER_KEY]);
  });

  it('keeps what is stored when the same person comes back', () => {
    claimed('octocat@example.com');
    writePayload('issues/mine', { queue: 'octocat' });
    claimFor('octocat@example.com');
    expect(readPayload('issues/mine')).toEqual({ queue: 'octocat' });
  });

  it('paints nothing before anybody has claimed the store', () => {
    const store = new FakeStore();
    setPayloadStore(store);
    plant(store, 'issues/mine', { o: 'octocat@example.com', t: Date.now(), v: { queue: 'octocat' } });
    expect(readPayload('issues/mine')).toBeNull();
  });

  it('stores nothing before anybody has claimed the store', () => {
    const store = new FakeStore();
    setPayloadStore(store);
    writePayload('issues/mine', { a: 1 });
    expect(store.map.size).toBe(0);
  });

  it('refuses an entry stamped for somebody else even under our own owner key', () => {
    const store = claimed('octocat@example.com');
    plant(store, 'issues/mine', { o: 'other@example.com', t: Date.now(), v: { queue: 'other' } });
    expect(readPayload('issues/mine')).toBeNull();
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}issues/mine`)).toBe(false);
  });

  it('claims nothing for an answer that names nobody', () => {
    const store = claimed('octocat@example.com');
    writePayload('issues/mine', { a: 1 });
    claimFor('   ');
    expect(store.map.size).toBe(0);
    expect(readPayload('issues/mine')).toBeNull();
  });
});

describe('nothing stale is painted', () => {
  it('drops an entry older than the ceiling, and deletes it', () => {
    const store = claimed();
    plant(store, 'issues/mine', {
      o: 'octocat@example.com',
      t: Date.now() - PAYLOAD_MAX_AGE_MS - 1_000,
      v: { queue: 'yesterday' },
    });
    expect(readPayload('issues/mine')).toBeNull();
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}issues/mine`)).toBe(false);
  });

  it('paints an entry inside the ceiling', () => {
    const store = claimed();
    plant(store, 'issues/mine', {
      o: 'octocat@example.com',
      t: Date.now() - (PAYLOAD_MAX_AGE_MS - 60_000),
      v: { queue: 'this morning' },
    });
    expect(readPayload('issues/mine')).toEqual({ queue: 'this morning' });
  });
});

describe('nothing unreadable is painted', () => {
  it('drops a corrupt entry rather than throwing', () => {
    const store = claimed();
    store.map.set(`${PAYLOAD_CACHE_PREFIX}issues/mine`, '{not json');
    expect(readPayload('issues/mine')).toBeNull();
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}issues/mine`)).toBe(false);
  });

  it.each([
    ['a bare string', '"just a string"'],
    ['an array', '[1,2,3]'],
    ['no owner', JSON.stringify({ t: Date.now(), v: 1 })],
    ['no timestamp', JSON.stringify({ o: 'octocat@example.com', v: 1 })],
    ['a timestamp that is not a number', JSON.stringify({ o: 'octocat@example.com', t: 'now', v: 1 })],
    ['no value at all', JSON.stringify({ o: 'octocat@example.com', t: Date.now() })],
  ])('drops %s', (_name, raw) => {
    const store = claimed();
    store.map.set(`${PAYLOAD_CACHE_PREFIX}issues/mine`, raw);
    expect(readPayload('issues/mine')).toBeNull();
  });

  it('never hands back a value that is not an object, and deletes it', () => {
    // This read `stores a null answer and reads it straight back` until the
    // shape guard existed, and the value it asserted has not moved: null then,
    // null now. What is new is that the entry goes with it, because an entry a
    // page cannot use must not be offered again on the next reload.
    const store = claimed();
    writePayload('delivery', null);
    expect(readPayload('delivery')).toBeNull();
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}delivery`)).toBe(false);
  });
});

describe('a failed write never breaks a page', () => {
  it('drops the oldest entries and stores on the retry', () => {
    const store = claimed();
    plant(store, 'old', { o: 'octocat@example.com', t: 1_000, v: 'oldest' });
    plant(store, 'newer', { o: 'octocat@example.com', t: 2_000, v: 'newer' });
    store.cap = store.map.size; // the next new key is refused, as a full quota does
    writePayload('issues/mine', { queue: 'fresh' });
    expect(readPayload('issues/mine')).toEqual({ queue: 'fresh' });
    // Read off the store rather than through `readPayload`, which since the
    // review takes `PayloadKey` and would not compile for a planted key that is
    // not one. The eviction walk is over whatever the prefix holds, so a key no
    // page could write is the honest thing to plant here.
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}old`)).toBe(false);
  });

  it('does not shred the cache for a value that will never fit', () => {
    // Measured, not reasoned about: with eight entries and one value larger
    // than the whole budget, four refreshes gave 8 → 4 → 2 → 1 → 1 and the
    // value never landed. `writePayload` discarded the second `put`'s result,
    // so every refresh looked like a first failure and evicted half again.
    // `/api/issues/all` answers 149151 bytes, which is the size of thing this
    // is about.
    const store = claimed();
    const base = Date.now();
    const others: PayloadKey[] = [
      'issues/all', 'issues/metrics', 'issues/all:acme', 'issues/filter-options',
      'people', 'delivery', projectsKey('acme'), reposKey('acme'),
    ];
    others.forEach((k, i) => {
      setNow(i, base);
      writePayload(k, { row: i });
    });
    setNow(null);
    expect(entryCount(store)).toBe(8);
    // Nothing more fits, and the value below is larger than the whole budget,
    // so no amount of eviction can make room for it.
    store.byteCap = [...store.map].reduce((n, [k, v]) => n + k.length + v.length, 0);
    const huge = { body: 'x'.repeat(store.byteCap * 2) };
    const counts = [1, 2, 3, 4].map(() => {
      writePayload('issues/mine', huge);
      return entryCount(store);
    });
    // The first attempt still costs half, because nothing can know a value does
    // not fit until it has been tried against an emptier store. The refreshes
    // after it cost nothing, which is the whole change.
    expect(counts).toEqual([4, 4, 4, 4]);
    expect(readPayload('issues/mine')).toBeNull();
  });

  it('evicts again once the value that did not fit has got smaller', () => {
    // The refusal is remembered against the SIZE that failed, not against the
    // key, so a page whose answer shrinks back under the budget is stored
    // rather than being refused for the rest of the session.
    const store = claimed();
    writePayload('issues/all', { row: 'old' });
    store.byteCap = [...store.map].reduce((n, [k, v]) => n + k.length + v.length, 0) * 2;
    writePayload('issues/mine', { body: 'x'.repeat(store.byteCap * 4) });
    expect(readPayload('issues/mine')).toBeNull();
    writePayload('issues/mine', { row: 'small' });
    expect(readPayload('issues/mine')).toEqual({ row: 'small' });
  });

  it('gives up quietly when the retry fails too', () => {
    const store = claimed();
    store.cap = store.map.size; // nothing new fits, and there is nothing to evict
    expect(() => writePayload('issues/mine', { queue: 'fresh' })).not.toThrow();
    expect(readPayload('issues/mine')).toBeNull();
  });

  it('survives a store that throws on every call', () => {
    const store = claimed();
    store.hostile = true;
    expect(() => writePayload('issues/mine', { a: 1 })).not.toThrow();
    expect(() => forgetPayloads()).not.toThrow();
    expect(() => claimFor('octocat@example.com')).not.toThrow();
    expect(readPayload('issues/mine')).toBeNull();
  });

  it('survives a device with no storage at all', () => {
    setPayloadStore(null);
    expect(() => writePayload('issues/mine', { a: 1 })).not.toThrow();
    expect(() => forgetPayloads()).not.toThrow();
    expect(() => claimFor('octocat@example.com')).not.toThrow();
    expect(readPayload('issues/mine')).toBeNull();
  });

  it('survives a value that cannot be serialised', () => {
    claimed();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => writePayload('issues/mine', cyclic)).not.toThrow();
    expect(readPayload('issues/mine')).toBeNull();
  });
});

/**
 * The value was never checked at all: the envelope was, and `return entry.v as
 * T` handed whatever was inside it to a render (#824 follow-up).
 *
 * This is not a tampering story. `Entry` carried no schema stamp, and this repo
 * deploys the frontend on every merge to `main`, so the NEXT change to any
 * cached field does this to every returning reader: `TeamView` accepts any
 * truthy value as a roster and hands it to `.map`, and the three
 * `readPayload<FilterOptions>(…) ?? EMPTY_FILTER_OPTIONS` sites are defeated by
 * any truthy non-object. The throw lands in an `ErrorBoundary`, nothing deletes
 * the entry, and every reload repeats it for the length of the freshness
 * ceiling.
 */
describe('nothing of the wrong shape is painted', () => {
  it('refuses an entry stamped with a schema this build does not speak', () => {
    const store = claimed();
    store.map.set(
      `${PAYLOAD_CACHE_PREFIX}issues/mine`,
      JSON.stringify({ s: PAYLOAD_SCHEMA_VERSION + 1, o: 'octocat@example.com', t: Date.now(), v: { queue: 'next' } }),
    );
    expect(readPayload('issues/mine')).toBeNull();
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}issues/mine`)).toBe(false);
  });

  it('refuses an entry carrying no schema stamp at all', () => {
    // Every entry written before the stamp existed, which is every entry on
    // every returning reader's disk the day this ships.
    const store = claimed();
    store.map.set(
      `${PAYLOAD_CACHE_PREFIX}issues/mine`,
      JSON.stringify({ o: 'octocat@example.com', t: Date.now(), v: { queue: 'yesterday’s build' } }),
    );
    expect(readPayload('issues/mine')).toBeNull();
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}issues/mine`)).toBe(false);
  });

  it('writes the stamp, so a round trip on one build still works', () => {
    const store = claimed();
    writePayload('issues/mine', { queue: 'octocat' });
    const raw = JSON.parse(store.map.get(`${PAYLOAD_CACHE_PREFIX}issues/mine`)!) as { s: number };
    expect(raw.s).toBe(PAYLOAD_SCHEMA_VERSION);
    expect(readPayload('issues/mine')).toEqual({ queue: 'octocat' });
  });

  it.each([
    ['a string', '"octocat"'],
    ['a number', '7'],
    ['a boolean', 'true'],
    ['null', 'null'],
  ])('refuses a payload that is %s, which a `??` fallback cannot catch', (_name, raw) => {
    const store = claimed();
    store.map.set(
      `${PAYLOAD_CACHE_PREFIX}issues/filter-options`,
      `{"s":${PAYLOAD_SCHEMA_VERSION},"o":"octocat@example.com","t":${Date.now()},"v":${raw}}`,
    );
    expect(readPayload('issues/filter-options')).toBeNull();
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}issues/filter-options`)).toBe(false);
  });

  it('counts nothing paintable behind a value that is not an object', () => {
    // The check that `readPayload`'s default `accept` does NOT cover, and the
    // reason the shape test is in `parse` as well: `hasCachedPayloads` decides
    // whether the board opens optimistically at all, and it must count what
    // `readPayload` would hand back. Counting an entry it then refuses is a
    // page of skeletons over an unverified session.
    const store = claimed();
    store.map.set(
      `${PAYLOAD_CACHE_PREFIX}issues/mine`,
      `{"s":${PAYLOAD_SCHEMA_VERSION},"o":"octocat@example.com","t":${Date.now()},"v":"a string"}`,
    );
    expect(hasCachedPayloads()).toBe(false);
  });

  it('takes a shape the caller names, for a value handed straight to `.map`', () => {
    // The roster and the boards rollup are arrays, and an object is not one:
    // `TeamView` used to accept any truthy value and call `.map` on it.
    const store = claimed();
    writePayload('people', { not: 'an array' } as unknown as unknown[]);
    expect(readPayload('people', Array.isArray)).toBeNull();
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}people`)).toBe(false);
  });

  it('hands back the value when the caller’s shape holds', () => {
    claimed();
    writePayload('people', [{ id: 'octocat@example.com' }]);
    expect(readPayload('people', Array.isArray)).toEqual([{ id: 'octocat@example.com' }]);
  });

  it('counts nothing paintable behind a stamp this build cannot read', () => {
    // Or the board opens optimistically on entries it then refuses one by one,
    // which is a page of skeletons over an unverified session.
    const store = claimed();
    writePayload('issues/mine', { queue: 'octocat' });
    expect(hasCachedPayloads()).toBe(true);
    const raw = JSON.parse(store.map.get(`${PAYLOAD_CACHE_PREFIX}issues/mine`)!) as Record<string, unknown>;
    store.map.set(
      `${PAYLOAD_CACHE_PREFIX}issues/mine`,
      JSON.stringify({ ...raw, s: PAYLOAD_SCHEMA_VERSION + 1 }),
    );
    expect(hasCachedPayloads()).toBe(false);
  });
});

/**
 * The freshness ceiling had no floor (#824 follow-up).
 *
 * All three readings asked `Date.now() - t > PAYLOAD_MAX_AGE_MS`, which refuses
 * only the past. A `t` in the future makes that negative and passes forever, so
 * a laptop with a dead CMOS battery, a VM resumed from a snapshot or a clock set
 * forward and then corrected paints the last person's board on every visit for
 * good. The whole privacy argument at the top of `payload-cache.ts` rests on
 * that ceiling holding.
 */
describe('a clock in the future is refused too', () => {
  const AHEAD = 30 * 24 * 60 * 60 * 1000;

  it('refuses an entry stamped in the future, and deletes it', () => {
    const store = claimed();
    plant(store, 'issues/mine', { o: 'octocat@example.com', t: Date.now() + AHEAD, v: { queue: 'next month' } });
    expect(readPayload('issues/mine')).toBeNull();
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}issues/mine`)).toBe(false);
  });

  it('counts nothing paintable behind a stamp in the future', () => {
    const store = claimed();
    plant(store, 'issues/mine', { o: 'octocat@example.com', t: Date.now() + AHEAD, v: { queue: 'next month' } });
    expect(hasCachedPayloads()).toBe(false);
  });

  it('refuses a CLAIM stamped in the future, so the board does not open on one', () => {
    const store = claimed();
    writePayload('issues/mine', { queue: 'octocat' });
    store.map.set(PAYLOAD_OWNER_KEY, JSON.stringify({ o: 'octocat@example.com', t: Date.now() + AHEAD }));
    expect(cachedOwner()).toBeNull();
    expect(readPayload('issues/mine')).toBeNull();
  });

  it('tolerates ordinary drift, so a correction of a second costs nobody a paint', () => {
    // A clock stepped by NTP between the write and the read is the everyday
    // case, and refusing a seed for it would cost a round trip for nothing.
    //
    // A FIXED two seconds, not `PAYLOAD_CLOCK_TOLERANCE_MS - 1_000`, which is
    // what this said first and which reads its own subject: with the constant
    // mutated to zero the plant moved back with it and the test stayed green.
    const store = claimed();
    plant(store, 'issues/mine', { o: 'octocat@example.com', t: Date.now() + 2_000, v: { queue: 'a moment ago' } });
    expect(readPayload('issues/mine')).toEqual({ queue: 'a moment ago' });
  });

  it('keeps the tolerance to drift, never to a clock that is wrong', () => {
    // Both ends. Zero refuses a seed for an NTP step; a generous one is the
    // ceiling gone, which is what this whole describe is about.
    expect(PAYLOAD_CLOCK_TOLERANCE_MS).toBeGreaterThanOrEqual(2_000);
    expect(PAYLOAD_CLOCK_TOLERANCE_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('a read that varies by org varies in its key', () => {
  it('separates the orgs and leaves the union bare', () => {
    expect(projectsKey('acme')).toBe('projects:acme');
    expect(projectsKey('globex')).toBe('projects:globex');
    expect(projectsKey(undefined)).toBe('projects');
    expect(projectsKey(null)).toBe('projects');
  });

  it('keys a board on its whole address, not on its number', () => {
    expect(projectKey(7, 'acme')).toBe('projects/7:acme');
    expect(projectKey(7, 'globex')).toBe('projects/7:globex');
    expect(projectKey(7)).toBe('projects/7');
  });

  it('separates the repo map per org', () => {
    expect(reposKey('acme')).toBe('repos:acme');
    expect(reposKey()).toBe('repos');
  });

  it('treats the empty string as the union, the way `scopeQuery` does', () => {
    expect(orgScopedKey('projects', '')).toBe('projects');
  });

  it("does not let one org read another org's copy", () => {
    claimed();
    writePayload(projectsKey('acme'), [{ name: 'Go-To-Market' }]);
    expect(readPayload(projectsKey('globex'))).toBeNull();
  });
});

describe('the claim the opening session reads', () => {
  it('names who signed in and when', () => {
    const before = Date.now();
    claimed('octocat@example.com');
    const held = cachedOwner();
    expect(held?.email).toBe('octocat@example.com');
    expect(held?.at).toBeGreaterThanOrEqual(before);
  });

  it('is re-stamped every time the same person answers', () => {
    const store = claimed('octocat@example.com');
    store.map.set(PAYLOAD_OWNER_KEY, JSON.stringify({ o: 'octocat@example.com', t: 1_000 }));
    claimFor('octocat@example.com');
    expect(cachedOwner()?.at).toBeGreaterThan(1_000);
  });

  it('is gone once nobody has signed in for longer than the ceiling', () => {
    const store = claimed('octocat@example.com');
    writePayload('issues/mine', { queue: 'octocat' });
    store.map.set(
      PAYLOAD_OWNER_KEY,
      JSON.stringify({ o: 'octocat@example.com', t: Date.now() - PAYLOAD_MAX_AGE_MS - 1_000 }),
    );
    expect(cachedOwner()).toBeNull();
    expect(readPayload('issues/mine')).toBeNull();
  });

  it('is nothing on a device that has never been signed in on', () => {
    setPayloadStore(new FakeStore());
    expect(cachedOwner()).toBeNull();
  });

  it('is unreadable rather than trusted when the record is junk', () => {
    const store = claimed('octocat@example.com');
    store.map.set(PAYLOAD_OWNER_KEY, 'octocat@example.com');
    expect(cachedOwner()).toBeNull();
  });

  it('counts nothing paintable when the entries belong to somebody else', () => {
    // Only reachable by hand: `claimFor` wipes on a change of owner. Counted
    // this way so the board never opens optimistically on entries it will then
    // refuse one by one, which is a page of skeletons over an unverified
    // session rather than an arrival that came any sooner.
    const store = claimed('octocat@example.com');
    writePayload('issues/mine', { queue: 'octocat' });
    store.map.set(PAYLOAD_OWNER_KEY, JSON.stringify({ o: 'other@example.com', t: Date.now() }));
    expect(hasCachedPayloads()).toBe(false);
  });

  it('counts nothing paintable when every entry is past the ceiling', () => {
    const store = claimed('octocat@example.com');
    plant(store, 'issues/mine', {
      o: 'octocat@example.com',
      t: Date.now() - PAYLOAD_MAX_AGE_MS - 1_000,
      v: { queue: 'yesterday' },
    });
    expect(hasCachedPayloads()).toBe(false);
  });

  it('reports whether there is anything stored to paint', () => {
    claimed('octocat@example.com');
    expect(hasCachedPayloads()).toBe(false);
    writePayload('issues/mine', { queue: 'octocat' });
    expect(hasCachedPayloads()).toBe(true);
    forgetPayloads();
    expect(hasCachedPayloads()).toBe(false);
  });
});

describe('one entry can be forgotten without ending the session', () => {
  it('removes the key it was given and leaves the others', () => {
    const store = claimed();
    writePayload(reposKey('gtm'), { repos: ['gtm/one'] });
    writePayload(reposKey('acme'), { repos: ['acme/one'] });
    forgetPayload(reposKey('gtm'));
    expect(readPayload(reposKey('gtm'))).toBeNull();
    expect(readPayload(reposKey('acme'))).toEqual({ repos: ['acme/one'] });
    expect(store.map.has(PAYLOAD_OWNER_KEY)).toBe(true);
  });

  it('leaves the owner alone, so the board still opens on what is left', () => {
    // A disowned org is not a session ending. Wiping the claim here would put
    // the next visit back on the sign-in screen for the length of a round trip,
    // which is the whole thing #824 bought.
    claimed();
    writePayload(projectsKey('gtm'), [{ name: 'gone' }]);
    forgetPayload(projectsKey('gtm'));
    expect(cachedOwner()?.email).toBe('octocat@example.com');
  });

  it('is quiet about a key nothing was stored under', () => {
    claimed();
    expect(() => forgetPayload(reposKey('never-seen'))).not.toThrow();
  });
});

describe('what may be stored is a type, not a rule somebody has to have read', () => {
  it('refuses an off-list key at BUILD time, which is where this guard lives', () => {
    // `pnpm build` is the guard, not this assertion: `tsc -b` covers `src`,
    // spec files included, so the directive below fails the build with TS2578
    // ("unused '@ts-expect-error'") the day `PayloadKey` stops rejecting an
    // off-list key. Checked both ways before it was written: with the type in
    // place the build is clean, and with the directive removed it reports
    // `TS2345: Argument of type '"admin/audit"' is not assignable to parameter
    // of type 'PayloadKey'`.
    //
    // At RUN time nothing refuses it, and this test says so out loud rather
    // than leaving a reader to assume otherwise. That is the honest shape of a
    // compiler-enforced allowlist: the wrong call cannot be written, so nothing
    // has to catch it happening.
    const store = claimed();
    // @ts-expect-error 'admin/audit' is not a PayloadKey, which is the point.
    writePayload('admin/audit', { entries: ['who read what'] });
    expect(store.map.has(`${PAYLOAD_CACHE_PREFIX}admin/audit`)).toBe(true);
  });

  it('has no key for the customer stream at all', () => {
    // Taken off the allowlist on 2026-09-04: the payload carries a customer's
    // address and their own words, including the report text `api.ts` records
    // the block never renders. There is no key to write it under now, so the
    // removal is not a decision a later change can quietly undo.
    const keys = Object.keys(cacheModule);
    expect(keys.filter((k) => k.toLowerCase().includes('feedback'))).toEqual([]);
  });
});

/**
 * The saved Projects copy (#1035): the one entry the permission wipe leaves,
 * and every other wipe takes. Pure storage rules against the fake store; which
 * failures may draw it is `projects/projects-last-good.spec.ts`.
 */
describe('a saved copy outlives the permission wipe and nothing else (#1035)', () => {
  afterEach(() => setResponseIdentity(null, false));
  const HOUR = 60 * 60 * 1000;

  it('is still there after the wipe every page load runs, where the seeded copy is not', () => {
    claimed();
    writePayload(projectsKey('acme'), [{ number: 7 }]);
    keepSaved(projectsKey('acme'), [{ number: 7 }]);
    forgetSensitivePayloads();
    expect(readPayload(projectsKey('acme'), Array.isArray)).toBeNull();
    expect(readSaved(projectsKey('acme'), HOUR, Array.isArray)?.value).toEqual([{ number: 7 }]);
  });

  it('goes with a sign-out, a 401 or another person', () => {
    claimed();
    keepSaved(projectsKey(null), [{ number: 7 }]);
    claimFor('somebody@else.com');
    expect(readSaved(projectsKey(null), HOUR)).toBeNull();
    keepSaved(projectsKey(null), [{ number: 7 }]);
    forgetPayloads();
    expect(readSaved(projectsKey(null), HOUR)).toBeNull();
  });

  it('is refused, and deleted, once the Github access it was saved under has changed', () => {
    const store = claimed();
    setResponseIdentity('who:1:1:aaaa', true);
    keepSaved(projectsKey(null), [{ number: 7 }]);
    setResponseIdentity('who:1:1:bbbb', true);
    expect(readSaved(projectsKey(null), HOUR)).toBeNull();
    expect(entryCount(store)).toBe(0);
  });

  it('is refused past the caller’s ceiling, and one saved under the same access is served', () => {
    claimed();
    setResponseIdentity('who:1:1:aaaa', true);
    const base = Date.now();
    setNow(0, base);
    keepSaved(projectsKey(null), [{ number: 7 }]);
    setNow(HOUR - 1000, base);
    expect(readSaved(projectsKey(null), HOUR)).toMatchObject({ at: base, seen: 'who:1:1:aaaa' });
    setNow(HOUR + 1000, base);
    expect(readSaved(projectsKey(null), HOUR)).toBeNull();
  });

  it('is refused when it is dated further ahead than the clock tolerance', () => {
    claimed();
    const base = Date.now();
    setNow(24 * HOUR, base);
    keepSaved(projectsKey(null), [{ number: 7 }]);
    setNow(0, base);
    expect(readSaved(projectsKey(null), HOUR)).toBeNull();
  });

  it('never counts as something to paint early, and goes with every other saved copy', () => {
    const store = claimed();
    writePayload(projectsKey(null), [{ number: 7 }]);
    keepSaved(projectsKey(null), [{ number: 7 }]);
    keepSaved(projectsKey('acme'), [{ number: 7 }]);
    forgetPayload(projectsKey(null));
    expect(hasCachedPayloads()).toBe(false);
    writePayload(projectsKey(null), [{ number: 7 }]);
    forgetSavedCopies();
    expect(readSaved(projectsKey(null), HOUR)).toBeNull();
    expect(readSaved(projectsKey('acme'), HOUR)).toBeNull();
    // The seeded copy is not a saved one, and stays.
    expect(entryCount(store)).toBe(1);
  });
});


describe('quota eviction preserves saved copies', () => {
  for (const writer of ['payload', 'saved'] as const) {
    it(`keeps the board and rollup when a ${writer} write fills the cache`, () => {
      const store = claimed();
      keepSaved(projectKey(7, 'acme'), { number: 7, items: [1] });
      keepSaved(projectsKey('acme'), [{ number: 7 }]);
      const saved = [...store.map].filter(([key]) => key.startsWith(PAYLOAD_CACHE_PREFIX + 'saved/'));
      writePayload('delivery', { releases: [] });
      writePayload('people', { people: [] });
      store.cap = store.map.size;
      if (writer === 'payload') writePayload('issues/metrics', { total: 5 });
      else keepSaved('issues/all:acme', { issues: [1] });
      for (const [key, body] of saved) expect(store.getItem(key)).toBe(body);
      expect(readSaved(projectKey(7, 'acme'), 60_000)?.value).toEqual({ number: 7, items: [1] });
      expect(readSaved(projectsKey('acme'), 60_000)?.value).toEqual([{ number: 7 }]);
    });
  }
});


/** The #1252 escalation records /api/issues/all at about 149 kB in production.
 *  Generate full OrgQueue rows at that scale without storing customer data or
 *  padding fields. */
function productionSizeQueue(): OrgQueue {
  return {
    updatedAt: '2026-09-21T12:00:00.000Z',
    issues: Array.from({ length: 350 }, (_, index) => ({
      owner: 'example-org', repo: 'task-board', number: index + 1,
      title: `Keep the saved board available when request ${index + 1} fails`,
      htmlUrl: `https://github.com/example-org/task-board/issues/${index + 1}`,
      createdAt: '2026-08-01T12:00:00.000Z', ageDays: 51,
      labels: ['bug', 'priority:high'], type: 'bug', blocked: false,
      aging: true, assignedToMe: false, assignees: ['reader'], author: 'reporter',
      projects: ['Engineering work'], state: 'open', closedAt: null, stateReason: null,
    })),
  };
}

describe('production-size queue under a full cache', () => {
  it('does not write the dead queue and preserves saved boards through quota retries', () => {
    const queue = productionSizeQueue();
    expect(new TextEncoder().encode(JSON.stringify(queue)).byteLength).toBeGreaterThanOrEqual(149_151);
    const store = claimed();
    const board = { number: 7, name: 'Engineering', url: 'https://github.com/orgs/acme/projects/7', pct: 0, items: [] };
    keepSaved(projectKey(7, 'acme'), board);
    keepSaved(projectsKey('acme'), [{ number: 7 }]);
    const saved = [...store.map].filter(([key]) => key.startsWith(PAYLOAD_CACHE_PREFIX + 'saved/'));
    writePayload('people', { people: ['reader'] });
    writePayload('delivery', { releases: [] });
    store.byteCap = 5 * 1024 * 1024;
    const used = [...store.map].reduce((sum, [key, body]) => sum + key.length + body.length, 0);
    // Other origin storage occupies the rest of the quota and is not ours to evict.
    store.setItem('other-app', 'x'.repeat(store.byteCap - used - 'other-app'.length));
    const full = [...store.map];
    const cell = nextCell(seedCell<OrgQueue>('issues/all:acme'), 'issues/all:acme', queue);
    persistCell(cell);
    expect(cell.value).toBe(queue);
    expect([...store.map]).toEqual(full);

    // Exercise both entry writers too: legacy cache callers and a new saved
    // queue must not evict a saved board, even when retrying a smaller answer.
    for (const issues of [queue.issues, queue.issues.slice(0, -1)]) {
      writePayload('issues/all:acme', { ...queue, issues });
      keepSaved('issues/all:acme', { ...queue, issues });
      for (const [key, body] of saved) expect(store.getItem(key)).toBe(body);
      expect(savedBoard(7, 'acme', new TypeError('Failed to fetch'))?.value).toEqual(board);
      expect(readSaved(projectsKey('acme'), 60_000)?.value).toEqual([{ number: 7 }]);
    }
    expect(readPayload('people')).toBeNull();
    expect(readPayload('delivery')).toBeNull();
    expect(readPayload('issues/all:acme')).toBeNull();
    expect(readSaved('issues/all:acme', 60_000)).toBeNull();

    // Replacing a saved board may itself exceed quota; the old copy survives.
    keepSaved(projectKey(7, 'acme'), { number: 7, items: queue.issues });
    for (const [key, body] of saved) expect(store.getItem(key)).toBe(body);
  });
});

describe('session hint preview', () => {
  it('paints an expired saved response without extending its lease, then wipes a different owner', async () => {
    const { beginHintPreview, finishHintPreview } = await import('../auth/session-hint');
    const id = 'a'.repeat(64);
    const s = claimed('first@example.test');
    claimFor('first@example.test', id, 'visible');
    const expired = Date.now() - 1000;
    plant(s, 'repos', { o: 'first@example.test', t: Date.now(), v: { repos: ['old-person'] }, access: { visibilityKey: 'visible', expiresAt: expired } });
    const raw = s.getItem(PAYLOAD_CACHE_PREFIX + 'repos');
    expect(beginHintPreview(cachedOwner(), `board_session_hint=${encodeURIComponent(JSON.stringify({ id, visibilityKey: 'visible' }))}`)).toBe(true);
    expect(cacheModule.seedPayload('repos')).toEqual({ repos: ['old-person'] });
    writePayload('repos', { repos: ['must not persist'] });
    expect(s.getItem(PAYLOAD_CACHE_PREFIX + 'repos')).toBe(raw);
    claimFor('second@example.test', 'b'.repeat(64), 'other');
    finishHintPreview(true);
    expect(cacheModule.seedPayload('repos')).toBeNull();
    expect(s.getItem(PAYLOAD_CACHE_PREFIX + 'repos')).toBeNull();
  });
});

describe('saved shell shares the owner lifetime', () => {
  const shell = { email: 'person@example.test', github: { connected: true, configured: true, owners: [{ login: 'acme', type: 'Organization' as const }] } };
  it('keeps only display fields and remembers the verified account label', () => {
    claimed();
    claimFor('person@example.test', 'a'.repeat(64), 'visible', { ...shell, isAdmin: true, writesEnabled: true } as typeof shell);
    cacheModule.rememberShellAccount(shell.email, 'Person', 'person');
    expect(cachedOwner()?.shell).toEqual({ ...shell, account: { name: 'Person', githubLogin: 'person' } });
    claimFor('person@example.test', 'a'.repeat(64), 'visible', shell);
    expect(cachedOwner()?.shell?.account?.name).toBe('Person');
  });
  it('does not retain account labels across an identity change', () => {
    claimed();
    claimFor('person@example.test', 'a'.repeat(64), 'visible', shell);
    cacheModule.rememberShellAccount(shell.email, 'Person', 'person');
    // A different session for the same address is a wipe, and the label the
    // last one verified goes with it.
    claimFor('person@example.test', 'b'.repeat(64), 'visible', shell);
    expect(cachedOwner()?.shell?.account).toBeUndefined();
    forgetPayloads();
    expect(cachedOwner()).toBeNull();
  });

  /**
   * And it DOES retain it across a moved visibility key (#1395), because that is
   * the same person. Their name and Github handle are not what changed; the
   * repositories Github reports are. The label was being dropped because a moved
   * key wiped everything, which it no longer does — Octocat's decision.
   */
  /**
   * #1395. `rememberShellAccount` rewrites the whole owner record, so a field it
   * forgets is a field deleted. It dropped `was` when the account label landed,
   * which retired the superseded key and lost the kept copies on the next open.
   * That is the reported symptom, one open later, and it is why this asserts the
   * whole record rather than the label.
   */
  it('keeps every field of the record when it writes the account label', () => {
    claimed();
    claimFor('person@example.test', 'a'.repeat(64), 'now', shell);
    claimFor('person@example.test', 'a'.repeat(64), 'moved', shell);
    expect(cachedOwner()?.was, 'the moved key must be recorded').toBe('now');
    cacheModule.rememberShellAccount(shell.email, 'Person', 'person');
    expect(cachedOwner()?.was, 'the account label must not drop it').toBe('now');
    expect(cachedOwner()?.vis).toBe('moved');
    expect(cachedOwner()?.hintId).toBe('a'.repeat(64));
  });

  it('retains the account label when only the access check moved', () => {
    claimed();
    claimFor('person@example.test', 'a'.repeat(64), 'visible', shell);
    cacheModule.rememberShellAccount(shell.email, 'Person', 'person');
    claimFor('person@example.test', 'a'.repeat(64), 'other', shell);
    expect(cachedOwner()?.shell?.account).toEqual({ name: 'Person', githubLogin: 'person' });
    expect(cachedOwner()?.vis).toBe('other');
  });
  it('rejects foreign and expired stored shell data', () => {
    const store = claimed();
    claimFor('person@example.test', 'a'.repeat(64), 'visible', { email: 'someone-else@example.test' });
    expect(cachedOwner()?.shell).toBeUndefined();
    store.map.set(PAYLOAD_OWNER_KEY, JSON.stringify({ o: 'person@example.test', vis: 'visible', t: Date.now() - PAYLOAD_MAX_AGE_MS - 1, shell }));
    expect(cachedOwner()).toBeNull();
  });
  it('does not store a late account update after sign-out or extend its lifetime', () => {
    claimed();
    claimFor('person@example.test', 'a'.repeat(64), 'visible', shell);
    const at = cachedOwner()?.at;
    cacheModule.rememberShellAccount(shell.email, 'Person', null);
    expect(cachedOwner()?.at).toBe(at);
    forgetPayloads();
    cacheModule.rememberShellAccount(shell.email, 'Person', null);
    expect(cachedOwner()).toBeNull();
  });
});
