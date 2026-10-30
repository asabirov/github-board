import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { AdminEmailCache } from './admin-email-cache';
import type { IAdminSource } from './admin-source';

const TTL = 300_000;

function config(): ConfigService {
  return { get: (key: string, def?: unknown) => (key === 'GROUP_CACHE_TTL_MS' ? TTL : def) } as unknown as ConfigService;
}

/** A scriptable admin source: each call shifts the next result (value or Error). */
function source(results: Array<string[] | Error>): { source: IAdminSource; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    source: {
      listAdminEmails: async () => {
        n += 1;
        const next = results.shift();
        if (next instanceof Error) throw next;
        return next ?? [];
      },
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('AdminEmailCache (#143, #332)', () => {
  it('warms on init, then serves the snapshot synchronously', async () => {
    const { source: s, calls } = source([['owner@example.com']]);
    const cache = new AdminEmailCache(s, config());
    await cache.onModuleInit();
    expect(cache.emails()).toEqual(['owner@example.com']);
    expect(calls()).toBe(1); // within TTL, no re-fetch
  });

  it('refreshes lazily once the TTL lapses (stale-while-revalidate)', async () => {
    const { source: s } = source([['a@x.com'], ['b@x.com']]);
    const cache = new AdminEmailCache(s, config());
    await cache.onModuleInit();
    vi.setSystemTime(Date.now() + TTL + 1);
    // The stale getter returns the OLD snapshot immediately and kicks a refresh.
    expect(cache.emails()).toEqual(['a@x.com']);
    await (cache as unknown as { refreshing: Promise<void> | null }).refreshing;
    expect(cache.emails()).toEqual(['b@x.com']);
  });

  it('a failed refresh keeps the last-good snapshot (never zero admins from a Google hiccup)', async () => {
    const { source: s } = source([['a@x.com'], new Error('google down')]);
    const cache = new AdminEmailCache(s, config());
    await cache.onModuleInit();
    vi.setSystemTime(Date.now() + TTL + 1);
    cache.emails();
    await (cache as unknown as { refreshing: Promise<void> | null }).refreshing;
    expect(cache.emails()).toEqual(['a@x.com']);
  });

  it('a cold warm-up failure yields NULL, not an empty list, without throwing (#588)', async () => {
    // Boot must not crash — and the caller must not be told "no admins" when
    // what happened is "no answer". AdminAuthority arms the BOARD_ADMIN_EMAILS
    // break-glass on an empty roster; handing it `[]` here armed it on a
    // Postgres outage, granting admin from an env var while the real admins sat
    // unread in the database.
    const { source: s } = source([new Error('invalid_grant')]);
    const cache = new AdminEmailCache(s, config());
    await expect(cache.onModuleInit()).resolves.toBeUndefined();
    expect(cache.emails()).toBeNull();
  });

  it('a read that SUCCEEDS with nobody is an empty list, not null (#588)', async () => {
    // The other half of the distinction: an empty admin table is a real answer,
    // and the break-glass is supposed to arm on it.
    const { source: s } = source([[]]);
    const cache = new AdminEmailCache(s, config());
    await cache.onModuleInit();
    expect(cache.emails()).toEqual([]);
  });

  it('once a read has succeeded, a later failure never reverts to null (#588)', async () => {
    // The last-good snapshot outlives the outage; "unknown" is only ever the
    // cold-boot state, never something the cache falls back into.
    const { source: s } = source([['a@x.com'], new Error('google down')]);
    const cache = new AdminEmailCache(s, config());
    await cache.onModuleInit();
    vi.setSystemTime(Date.now() + TTL + 1);
    cache.emails();
    await (cache as unknown as { refreshing: Promise<void> | null }).refreshing;
    expect(cache.emails()).toEqual(['a@x.com']);
  });

  it('single-flight: concurrent stale reads share ONE refresh', async () => {
    const { source: s, calls } = source([['a@x.com'], ['b@x.com'], ['c@x.com']]);
    const cache = new AdminEmailCache(s, config());
    await cache.onModuleInit(); // call 1
    vi.setSystemTime(Date.now() + TTL + 1);
    cache.emails();
    cache.emails();
    cache.emails();
    await (cache as unknown as { refreshing: Promise<void> | null }).refreshing;
    expect(calls()).toBe(2); // warm-up + exactly one shared refresh, not three
  });

  it('invalidate() refreshes immediately and picks up a newly-assigned admin (#332)', async () => {
    const { source: s, calls } = source([['a@x.com'], ['a@x.com', 'b@x.com']]);
    const cache = new AdminEmailCache(s, config());
    await cache.onModuleInit(); // call 1, within TTL
    cache.invalidate(); // kicks call 2 now, not on the TTL
    await (cache as unknown as { refreshing: Promise<void> | null }).refreshing;
    expect(cache.emails()).toEqual(['a@x.com', 'b@x.com']);
    expect(calls()).toBe(2);
  });

  it('an invalidate landing mid-refresh forces a second, post-write read (P2 race)', async () => {
    // Deferred source: we control exactly when each read resolves so an invalidate
    // can land while a pre-write read is still in flight.
    const resolvers: Array<(v: string[]) => void> = [];
    let calls = 0;
    const s: IAdminSource = {
      listAdminEmails: () => {
        calls += 1;
        return new Promise<string[]>((res) => resolvers.push(res));
      },
    };
    const flush = async () => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    };
    const cache = new AdminEmailCache(s, config());
    const warm = cache.onModuleInit(); // read 1
    resolvers[0](['a@x.com']); // pre-write set
    await warm;

    vi.setSystemTime(Date.now() + TTL + 1);
    cache.emails(); // triggers read 2 (in flight, still pre-write)
    expect(calls).toBe(2);

    cache.invalidate(); // lands mid-flight → marks dirty
    resolvers[1](['a@x.com']); // read 2 resolves STALE
    await flush(); // finally sees dirty → chains read 3
    expect(calls).toBe(3);

    resolvers[2](['a@x.com', 'b@x.com']); // read 3 sees the write
    await flush();
    expect(cache.emails()).toEqual(['a@x.com', 'b@x.com']);
  });
});
