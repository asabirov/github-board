import { afterEach, describe, expect, it, vi } from 'vitest';
import { DerivedLoginsService } from './derived-logins.service';
import type { DerivedLoginsResult, DerivedLoginsSource } from './derived-logins.source';

const complete = (pairs: Array<[string, string]>): DerivedLoginsResult => ({
  map: new Map(pairs),
  complete: true,
});

function sourceOf(...results: Array<DerivedLoginsResult | Error>) {
  let i = 0;
  const src = {
    calls: 0,
    async derive(): Promise<DerivedLoginsResult> {
      src.calls += 1;
      const next = results[Math.min(i++, results.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return src as DerivedLoginsSource & { calls: number };
}

const config = { get: (_k: string, d?: unknown) => d };
const svcOf = (source: DerivedLoginsSource) => new DerivedLoginsService(source, config as never);

afterEach(() => vi.useRealTimers());

describe('DerivedLoginsService', () => {
  it('answers null before any warm has happened, and asks nobody', async () => {
    // The property the whole design rests on: a read never triggers a fetch.
    const source = sourceOf(complete([['a@x.io', 'ay']]));
    const svc = svcOf(source);
    expect(svc.loginFor('a@x.io')).toBeNull();
    await Promise.resolve();
    expect(source.calls).toBe(0);
  });

  it('answers from memory once warmed', async () => {
    const svc = svcOf(sourceOf(complete([['a@x.io', 'ay']])));
    await svc.refresh();
    expect(svc.loginFor('a@x.io')).toBe('ay');
  });

  it('matches an address case-insensitively, because the roster does', async () => {
    const svc = svcOf(sourceOf(complete([['a@x.io', 'ay']])));
    await svc.refresh();
    expect(svc.loginFor('A@X.IO')).toBe('ay');
  });

  it('does not replace a good map with an incomplete run', async () => {
    const svc = svcOf(sourceOf(complete([['a@x.io', 'ay']]), { map: new Map(), complete: false }));
    await svc.refresh();
    await svc.refresh();
    expect(svc.loginFor('a@x.io')).toBe('ay');
  });

  it('keeps the last good map when a refresh throws', async () => {
    const svc = svcOf(sourceOf(complete([['a@x.io', 'ay']]), new Error('401')));
    await svc.refresh();
    await svc.refresh();
    expect(svc.loginFor('a@x.io')).toBe('ay');
  });

  it('never lets a rejected refresh escape to its caller', async () => {
    // Both callers are fire-and-forget; an escaping rejection would be unhandled.
    const svc = svcOf(sourceOf(new Error('cold')));
    await expect(svc.refresh()).resolves.toBeUndefined();
  });

  it('costs one derive when two refreshes overlap', async () => {
    const source = sourceOf(complete([['a@x.io', 'ay']]));
    const svc = svcOf(source);
    await Promise.all([svc.refresh(), svc.refresh()]);
    expect(source.calls).toBe(1);
  });

  it('does not let an in-flight run re-pin a map that was invalidated under it', async () => {
    // The hole `invalidateRoster` has a comment explaining: the in-flight run
    // writes on its way out with data that predates the invalidation.
    let release!: (r: DerivedLoginsResult) => void;
    const gated = new Promise<DerivedLoginsResult>((r) => (release = r));
    let call = 0;
    const source = {
      derive: () => (call++ === 0 ? gated : Promise.resolve(complete([['a@x.io', 'new']]))),
    } as DerivedLoginsSource;
    const svc = svcOf(source);

    const first = svc.refresh();
    svc.invalidate();
    release(complete([['a@x.io', 'stale']]));
    await first;

    expect(svc.loginFor('a@x.io')).not.toBe('stale');
  });

  it('re-warms when an invalidation lands during a refresh, instead of returning a doomed run', async () => {
    // The composition `POST /api/sync` depends on. If refresh hands back the
    // in-flight promise, the generation guard discards its result and NOTHING
    // re-warms for the whole interval.
    let release!: (r: DerivedLoginsResult) => void;
    const gated = new Promise<DerivedLoginsResult>((r) => (release = r));
    let call = 0;
    const source = {
      derive: () => (call++ === 0 ? gated : Promise.resolve(complete([['a@x.io', 'new']]))),
    } as DerivedLoginsSource;
    const svc = svcOf(source);

    void svc.refresh();
    svc.invalidate();
    const second = svc.refresh();
    release(complete([['a@x.io', 'stale']]));
    await second;

    expect(svc.loginFor('a@x.io')).toBe('new');
  });

  it('survives a sync that lands during a Github outage', async () => {
    // invalidate() must mark the map stale WITHOUT emptying it, or the
    // incomplete run below has nothing to keep and every derived attribution
    // vanishes for the whole interval.
    const svc = svcOf(sourceOf(complete([['a@x.io', 'ay']]), { map: new Map(), complete: false }));
    await svc.refresh();
    svc.invalidate();
    await svc.refresh();
    expect(svc.loginFor('a@x.io')).toBe('ay');
  });

  it('stops asking after shutdown', async () => {
    // Asserts the TIMER, not a field write. Deleting `clearInterval` while
    // keeping `this.timer = null` must fail this.
    vi.useFakeTimers();
    const source = sourceOf(complete([]));
    const svc = svcOf(source);
    svc.onModuleInit();
    await vi.advanceTimersByTimeAsync(0);
    const afterBoot = source.calls;

    svc.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(43_200_000 * 3);
    expect(source.calls).toBe(afterBoot);
  });
});
