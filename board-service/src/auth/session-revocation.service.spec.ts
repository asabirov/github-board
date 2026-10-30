import { describe, expect, it, vi } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { SessionRevocationService } from './session-revocation.service';
import {
  MemorySessionRevocationStore,
  PrismaSessionRevocationStore,
} from './session-revocation.repository';
import { SESSION_TTL_MS } from './cookies';

const NOW = 1_000_000;
const HOUR = 60 * 60 * 1000;
/** The hold the sign-out path clamps to — read from the constant, not retyped. */
const HOLD = SESSION_TTL_MS;

describe('SessionRevocationService', () => {
  it('reports a revoked jti as revoked until its expiry', () => {
    const s = new SessionRevocationService();
    s.revoke('jti-1', NOW + 10_000, NOW);
    expect(s.isRevoked('jti-1', NOW + 5_000)).toBe(true);
  });

  it('treats an unknown jti as not revoked', () => {
    const s = new SessionRevocationService();
    expect(s.isRevoked('never-seen', NOW)).toBe(false);
    expect(s.isRevoked(undefined, NOW)).toBe(false);
  });

  it('stops reporting revoked once past expiry and prunes the entry', () => {
    const s = new SessionRevocationService();
    s.revoke('jti-2', NOW + 1_000, NOW);
    expect(s.isRevoked('jti-2', NOW + 2_000)).toBe(false); // expired
    expect(s.size).toBe(0); // pruned on the expired read
  });

  it('ignores an empty jti', () => {
    const s = new SessionRevocationService();
    s.revoke(undefined, NOW + 1_000, NOW);
    s.revoke('', NOW + 1_000, NOW);
    expect(s.size).toBe(0);
  });

  it('prunes expired entries when revoking new ones', () => {
    const s = new SessionRevocationService();
    s.revoke('old', NOW + 1_000, NOW);
    s.revoke('new', NOW + 20_000, NOW + 5_000); // old is now expired → pruned
    expect(s.size).toBe(1);
    expect(s.isRevoked('new', NOW + 6_000)).toBe(true);
  });

  // The population cases. Seven-day holds are 21x the old eight-hour ones, so
  // what matters is no longer one entry but how many the map carries at once.
  it('holds a bounded set across a run of revocations far longer than the hold', () => {
    const s = new SessionRevocationService();
    expect(HOLD % HOUR).toBe(0); // the hourly grid below divides the hold exactly
    const window = HOLD / HOUR; // entries that can be live at once, 168 at seven days
    const rounds = 5 * (window + 1); // five windows of one sign-out an hour
    let peak = 0;
    for (let i = 0; i < rounds; i++) {
      const now = NOW + i * HOUR;
      s.revoke(`jti-${i}`, now + HOLD, now); // each entry held the full hold
      peak = Math.max(peak, s.size);
    }
    expect(peak).toBeLessThanOrEqual(window + 1);
    expect(s.size).toBeLessThanOrEqual(window + 1);
    // ...and bounded by expiry, not by dropping live entries early.
    expect(s.size).toBeGreaterThanOrEqual(window);
    const last = NOW + (rounds - 1) * HOUR;
    expect(s.isRevoked(`jti-${rounds - 1}`, last)).toBe(true); // newest still revoked
    expect(s.isRevoked('jti-0', last)).toBe(false); // oldest expired four windows earlier
  });

  it('holds an entry for its whole clamped expiry and not a millisecond past', () => {
    const s = new SessionRevocationService();
    const exp = NOW + HOLD;
    s.revoke('held', exp, NOW);
    expect(s.isRevoked('held', NOW + HOLD / 4)).toBe(true);
    expect(s.isRevoked('held', NOW + (3 * HOLD) / 4)).toBe(true);
    expect(s.isRevoked('held', exp - 1)).toBe(true); // last live millisecond
    expect(s.isRevoked('held', exp)).toBe(false); // expiry is exclusive
    expect(s.size).toBe(0); // and the entry is gone, not just reported gone
  });
});

/**
 * The two things #679 has to be able to prove about the store behind the service:
 * that the degradation is LOUD, and that a refused durable write is REPORTED.
 *
 * Both are asserted by watching Nest's logger rather than by reading the source.
 * "It logs an error" and "it returns false" are exactly the kind of claim this
 * repository has shipped as prose and then quietly broken.
 */
describe('the store behind the service (#679)', () => {
  /** Collect every level the logger is called at while `fn` runs. */
  function levelsDuring(fn: () => void): { log: string[]; error: string[] } {
    const out = { log: [] as string[], error: [] as string[] };
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
      out.log.push(String(m));
    });
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => {
      out.error.push(String(m));
    });
    try {
      fn();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    return out;
  }

  /**
   * On CONSTRUCTION, not on a lifecycle hook: the announcement has to follow the
   * object, because a memory store also reaches the running service as the
   * default argument of `SessionRevocationService`, where Nest is not wiring
   * anything and no hook would ever fire. Building one and asserting nothing was
   * called would have passed against exactly the silent instance this asserts
   * against.
   */
  it('announces the memory store at ERROR level on construction, naming the consequence and the fix', () => {
    const seen = levelsDuring(() => {
      new MemorySessionRevocationStore();
    });
    expect(seen.log).toEqual([]);
    expect(seen.error).toHaveLength(1);
    expect(seen.error[0]).toContain('IN-MEMORY ONLY');
    expect(seen.error[0]).toContain('restart');
    expect(seen.error[0]).toContain('IDENTITY_SOURCE=db');
  });

  /**
   * The seam: `SessionRevocationService`'s default argument builds a store no
   * module registered, so no `onModuleInit` of Nest's would ever reach it. That
   * instance reports `durable === false`, which makes a failed revoke answer
   * `true` and the logout controller answer `ok: true` — a store that is not
   * there reading as a store that is. It is at least LOUD now.
   */
  it('announces even when the store arrived as the service default, which Nest never wires', () => {
    const seen = levelsDuring(() => {
      new SessionRevocationService();
    });
    expect(seen.error).toHaveLength(1);
    expect(seen.error[0]).toContain('IN-MEMORY ONLY');
  });

  it('announces the Prisma store at plain log level, and never at error', () => {
    const store = new PrismaSessionRevocationStore({} as never);
    const seen = levelsDuring(() => store.onModuleInit());
    expect(seen.error).toEqual([]);
    expect(seen.log).toHaveLength(1);
    expect(seen.log[0]).toContain('durable');
  });

  /**
   * Housekeeping must not fail the write it rode in on. The prune shared the
   * upsert's error path, so a committed revocation followed by a failed delete
   * answered `false` to the controller — which then told the person their cookie
   * might still work, about a session that is demonstrably revoked. Both writes,
   * because they prune different tables through the same helper.
   */
  it('reports a revocation as landed when only its opportunistic prune failed', async () => {
    const deleteMany = async () => {
      throw new Error('deadlock detected');
    };
    const prisma = {
      revokedSession: { upsert: async () => ({}), deleteMany },
      sessionEpoch: { deleteMany },
      $executeRaw: async () => 1,
    } as never;
    const store = new PrismaSessionRevocationStore(prisma);
    const warned: string[] = [];
    const spy = vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => {
      warned.push(String(m));
    });
    try {
      await expect(store.revoke('jti-p', new Date(NOW + HOUR), new Date(NOW))).resolves.toBeUndefined();
      await expect(store.bumpEpoch('u1', new Date(NOW), new Date(NOW))).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    // Reported, not swallowed silently: a prune that keeps failing is a real
    // problem, just not this caller's.
    expect(warned).toHaveLength(2);
    expect(warned.every((m) => m.includes('could not prune'))).toBe(true);
  });

  it('reports the two stores as durable and not, which is what the caller branches on', () => {
    expect(new PrismaSessionRevocationStore({} as never).durable).toBe(true);
    expect(new MemorySessionRevocationStore().durable).toBe(false);
    expect(new SessionRevocationService(new MemorySessionRevocationStore()).durable).toBe(false);
  });

  it('returns false when a DURABLE store refuses the write, and never rejects', async () => {
    const refusing = {
      durable: true,
      revoke: async () => {
        throw new Error('connection refused');
      },
      bumpEpoch: async () => {
        throw new Error('connection refused');
      },
      isRevoked: async () => false,
      epochOf: async () => null,
    };
    const s = new SessionRevocationService(refusing);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    await expect(s.revoke('jti-x', NOW + 10_000, NOW)).resolves.toBe(false);
    await expect(s.bumpEpoch('u1', NOW, NOW)).resolves.toBe(false);
    vi.restoreAllMocks();
    // The in-memory view still holds it: the browser that pressed the button is
    // signed out of THIS process regardless of what Postgres did.
    expect(s.isRevoked('jti-x', NOW + 1)).toBe(true);
  });

  it('does not report a failure the caller cannot act on when the store was never durable', async () => {
    const broken = {
      durable: false,
      revoke: async () => {
        throw new Error('nope');
      },
      bumpEpoch: async () => {
        throw new Error('nope');
      },
      isRevoked: async () => false,
      epochOf: async () => null,
    };
    const s = new SessionRevocationService(broken);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    await expect(s.revoke('jti-y', NOW + 10_000, NOW)).resolves.toBe(true);
    vi.restoreAllMocks();
  });

  it('writes the in-memory view BEFORE its first await, for the unawaited callers', () => {
    const s = new SessionRevocationService(new MemorySessionRevocationStore());
    // Deliberately not awaited — mcp-oauth.provider.ts and
    // connected-clients.controller.ts call it exactly like this and then assert.
    void s.revoke('unawaited', NOW + 10_000, NOW);
    expect(s.isRevoked('unawaited', NOW + 1)).toBe(true);
  });

  it('prunes an expired row on the next revoke rather than on a timer', async () => {
    const store = new MemorySessionRevocationStore();
    const s = new SessionRevocationService(store);
    await s.revoke('short', NOW + 1_000, NOW);
    expect(await store.isRevoked('short', new Date(NOW + 500))).toBe(true);
    await s.revoke('later', NOW + 10_000, NOW + 2_000);
    expect(await store.isRevoked('short', new Date(NOW + 500))).toBe(false); // deleted, not merely expired
  });

  it('answers `check` on the epoch for a session no jti ever named', async () => {
    const store = new MemorySessionRevocationStore();
    const s = new SessionRevocationService(store);
    await s.bumpEpoch('u1', NOW, NOW);
    expect(await s.check('unknown-jti', 'u1', Math.floor(NOW / 1000) - 1, NOW)).toBe(true);
    expect(await s.check('unknown-jti', 'u1', Math.ceil(NOW / 1000) + 1, NOW)).toBe(false);
    expect(await s.check('unknown-jti', 'u2', 0, NOW)).toBe(false); // another person's epoch
  });

  /**
   * Forward only, in the memory twin of the store's `GREATEST`. A clock that
   * stepped backwards — NTP, a replica with skew, a retry carrying an older
   * instant — would otherwise lower the cut-off and revive every session the
   * earlier sign-out killed. `session-revocation.db-spec.ts` asserts the same
   * against the SQL, because a fixture agreeing with itself proves nothing about
   * the store that ships.
   */
  it('never lowers an epoch, so a backwards clock cannot revive a dead session', async () => {
    const store = new MemorySessionRevocationStore();
    const s = new SessionRevocationService(store);
    await s.bumpEpoch('u1', NOW, NOW);
    await s.bumpEpoch('u1', NOW - HOUR, NOW);
    expect((await store.epochOf('u1'))!.getTime()).toBe(NOW);
    // The session between the two instants stays dead — the property the guard
    // reads, rather than the field it reads it from.
    expect(await s.check('never-named', 'u1', Math.floor((NOW - 60_000) / 1000), NOW)).toBe(true);
  });

  /**
   * `check` REFUSES rather than guesses (CSO). Unlike `revoke` and `bumpEpoch`,
   * which report a store failure as `false` because they run after the cookie has
   * cleared, this one decides whether a request is admitted — and a store that
   * cannot answer "is this session dead?" has not answered "no". It is a 503
   * rather than the bare 500 an uncaught Prisma error becomes.
   */
  it('throws 503 when the store cannot be read, instead of answering not-revoked', async () => {
    const unreadable = {
      durable: true,
      revoke: async () => {},
      bumpEpoch: async () => {},
      isRevoked: async () => {
        throw new Error('connection refused');
      },
      epochOf: async () => {
        throw new Error('connection refused');
      },
    };
    const s = new SessionRevocationService(unreadable);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    await expect(s.check('jti-z', 'u1', Math.floor(NOW / 1000), NOW)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    vi.restoreAllMocks();
  });
});
