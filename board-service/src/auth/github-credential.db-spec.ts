import { createPrismaClient } from '../prisma';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { GithubUserService, REFRESH_LEASE_MS } from './github-user.service';
import { CredentialCipher } from './github-credential-cipher';

const db = createPrismaClient();
// The stable GitHub user id the row is keyed on (#1450).
const SUB = `github-cas-${process.pid}`;
const LOGIN = `synthetic-${process.pid}`;
const cipher = new CredentialCipher({ key: () => Buffer.alloc(32, 7) });
const config = new ConfigService({ GITHUB_USER_APP_CLIENT_ID: 'synthetic-client', GITHUB_USER_APP_CLIENT_SECRET: 'synthetic-secret', BOARD_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString('base64') });
const pair = { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, refresh_token_expires_in: 7200 };
beforeEach(async () => {
  vi.unstubAllGlobals();
  await db.githubCredential.deleteMany({ where: { githubUserId: SUB } });
  await db.githubCredential.create({ data: {
    ownerEmail: LOGIN, boardSub: SUB, githubUserId: SUB, githubLogin: LOGIN,
    accessCipher: cipher.encrypt('old-access', `${SUB}:access`), refreshCipher: cipher.encrypt('old-refresh', `${SUB}:refresh`),
    accessExpiresAt: new Date(0), refreshExpiresAt: new Date(Date.now() + 3600000), scopes: '', version: 'initial',
  } });
});
afterAll(async () => { vi.unstubAllGlobals(); await db.githubCredential.deleteMany({ where: { githubUserId: SUB } }); await db.$disconnect(); });

describe('encrypted credentials against Postgres', () => {
  it('allows only one service instance to spend a rotating refresh token', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const exchange = vi.fn(async () => { await gate; return pair; });
    const a = new GithubUserService(config, db); const b = new GithubUserService(config, db);
    a.exchange = exchange; b.exchange = exchange;
    const reads = Promise.allSettled([a.credential(SUB), b.credential(SUB)]);
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledTimes(1));
    release();
    const settled = await reads;
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(exchange).toHaveBeenCalledTimes(1);
    const stored = await db.githubCredential.findUniqueOrThrow({ where: { githubUserId: SUB } });
    expect(stored.accessCipher).not.toContain('new-access');
    expect(stored.refreshCipher).not.toContain('new-refresh');
    expect(cipher.decrypt(stored.accessCipher, `${SUB}:access`)).toBe('new-access');
    expect(stored.refreshLeaseUntil).toBeNull();
  });
  it('disconnect wins over a refresh already in flight and wipes both encrypted secrets', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new GithubUserService(config, db);
    const exchange = vi.fn(async () => { await gate; return pair; });
    service.exchange = exchange;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const refresh = service.credential(SUB);
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledTimes(1));
    await service.disconnect(SUB);
    release();
    expect(await refresh).toBeNull();
    const stored = await db.githubCredential.findUniqueOrThrow({ where: { githubUserId: SUB } });
    expect(stored.revokedAt).not.toBeNull(); expect(stored.accessCipher).toBe(''); expect(stored.refreshCipher).toBe('');
    expect(await service.credential(SUB)).toBeNull();
  });
  it('refuses an OAuth connection that raced a disconnect and enforces unique Github identity', async () => {
    const service = new GithubUserService(config, db);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: SUB, login: LOGIN }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await service.disconnect(SUB);
    await expect(service.connect(SUB, LOGIN, pair, 'initial')).rejects.toThrow('Connection changed');
    expect((await db.githubCredential.findUniqueOrThrow({ where: { githubUserId: SUB } })).revokedAt).not.toBeNull();
    // A first-ever connect that lands on an already-claimed GitHub user id is
    // refused by the unique index rather than opening a second row.
    await expect(service.connect(SUB, 'other-login', pair, null)).rejects.toThrow();
    expect(await db.githubCredential.findUnique({ where: { githubUserId: 'other-id' } })).toBeNull();
  });
  it('never retries a refresh whose prior process lost the provider response', async () => {
    // The rule that does not move: whatever a lease turns out to mean, the
    // refresh secret behind it is never spent a second time.
    await db.githubCredential.update({ where: { githubUserId: SUB }, data: { refreshLeaseUntil: new Date(Date.now() + REFRESH_LEASE_MS) } });
    const service = new GithubUserService(config, db);
    service.exchange = vi.fn();
    await expect(service.credential(SUB)).rejects.toThrow('being renewed');
    expect(service.exchange).not.toHaveBeenCalled();
  });
});

/**
 * A refresh lease is a deadline, not a tombstone (#892 review, F1).
 *
 * The lease was tested for PRESENCE and its deadline was never read, so a
 * process that died holding one stranded the row: `credential` threw for ever,
 * `GithubPrincipalGuard` calls it on every authenticated request, and the
 * person's whole board answered 503 — including `/api/auth/me`, which is the
 * read that would have offered them a reconnect.
 */
describe('an abandoned refresh lease', () => {
  const lease = (refreshLeaseUntil: Date | null) =>
    db.githubCredential.update({ where: { githubUserId: SUB }, data: { refreshLeaseUntil } });
  const stored = () => db.githubCredential.findUniqueOrThrow({ where: { githubUserId: SUB } });

  it('is retired into the ordinary unconnected state instead of refusing for ever', async () => {
    const before = await stored();
    await lease(new Date(Date.now() - REFRESH_LEASE_MS));
    const service = new GithubUserService(config, db);
    service.exchange = vi.fn();
    // Not a throw. The caller draws "sign in again", which is the state a
    // person can act on.
    expect(await service.credential(SUB)).toBeNull();
    expect(service.exchange, 'the uncertain refresh secret is never spent').not.toHaveBeenCalled();
    const after = await stored();
    expect(after.revokedAt).not.toBeNull();
    expect(after.accessCipher).toBe('');
    expect(after.refreshCipher).toBe('');
    expect(after.refreshLeaseUntil).toBeNull();
    expect(after.version, 'the version moved, which is what fences the late reply').not.toBe(before.version);
  });

  it('fences the refresh completion that arrives after the deadline', async () => {
    // The prior process is not dead, only very late: it took the lease, and its
    // provider reply lands after this instance has already given up on it.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = new GithubUserService(config, db);
    slow.exchange = vi.fn(async () => { await gate; return pair; });
    const late = slow.credential(SUB);
    await vi.waitFor(async () => expect((await stored()).refreshLeaseUntil).not.toBeNull());

    // Its deadline passes while it is still out, and another instance retires it.
    await lease(new Date(Date.now() - 1));
    const other = new GithubUserService(config, db);
    other.exchange = vi.fn();
    expect(await other.credential(SUB)).toBeNull();
    const retired = await stored();

    release();
    expect(await late, 'the late completion is refused its own write').toBeNull();
    const after = await stored();
    expect(after.version, 'and changed nothing').toBe(retired.version);
    expect(after.revokedAt).not.toBeNull();
    expect(after.accessCipher, 'no access was resurrected').toBe('');
    expect(after.refreshCipher).toBe('');
  });

  it('defers to a refresh that won, rather than overwriting it', async () => {
    // The swap is on the version AND the lease this read saw, so a refresh that
    // landed in time — or a reconnect — is not clobbered by a reader that had
    // already decided the lease was abandoned.
    await lease(new Date(Date.now() - 1));
    const service = new GithubUserService(config, db);
    const stale = await stored();
    // The winner lands between the read and the swap: modelled by moving the row
    // exactly as a completed refresh does.
    service.exchange = vi.fn(async () => pair);
    const winner = new GithubUserService(config, db);
    winner.exchange = vi.fn(async () => ({ ...pair, access_token: 'winner-access' }));
    await lease(null);
    expect((await winner.credential(SUB))?.token).toBe('winner-access');
    const won = await stored();

    // Now the loser acts on the row it read a moment ago, lease and all.
    const held = await (service as unknown as {
      leaseHeld(s: string, r: typeof stale, l: Date): Promise<{ token: string } | null>;
    }).leaseHeld(SUB, stale, stale.refreshLeaseUntil!);
    expect(held?.token, 'it serves the winner it found').toBe('winner-access');
    const after = await stored();
    expect(after.version, 'and wrote nothing over it').toBe(won.version);
    expect(after.revokedAt).toBeNull();
  });

  it('leaves a reconnect after abandonment fully usable', async () => {
    await lease(new Date(Date.now() - 1));
    const service = new GithubUserService(config, db);
    expect(await service.credential(SUB)).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: SUB, login: LOGIN }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await service.connect(SUB, LOGIN, { ...pair, access_token: 'after-reconnect' }, (await stored()).version);
    expect((await service.credential(SUB))?.token).toBe('after-reconnect');
    expect((await stored()).revokedAt).toBeNull();
  });
});

describe('one Github flow writes one credential, whatever the browser replays', () => {
  it('refuses a second callback under the same seal, even with a second valid code', async () => {
    // The state is a cookie, so clearing it cannot stop a replay. What stops one
    // is this: both callbacks captured the SAME credential version when the flow
    // started, and only the first write matches it.
    const service = new GithubUserService(config, db);
    const identity = (login: string) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(JSON.stringify({ id: SUB, login }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );

    identity('first-code');
    await service.connect(SUB, LOGIN, { ...pair, access_token: 'from-first-code' }, 'initial');
    const afterFirst = await db.githubCredential.findUniqueOrThrow({ where: { githubUserId: SUB } });
    expect(afterFirst.version).not.toBe('initial');

    identity('second-code');
    await expect(
      service.connect(SUB, LOGIN, { ...pair, access_token: 'from-second-code' }, 'initial'),
    ).rejects.toThrow('Connection changed');

    const stored = await db.githubCredential.findUniqueOrThrow({ where: { githubUserId: SUB } });
    expect(stored.version, 'the replay wrote nothing').toBe(afterFirst.version);
    expect(cipher.decrypt(stored.accessCipher, `${SUB}:access`)).toBe('from-first-code');
  });

  it('lets exactly one of two concurrent callbacks win', async () => {
    const service = new GithubUserService(config, db);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ id: SUB, login: LOGIN }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const settled = await Promise.allSettled([
      service.connect(SUB, LOGIN, { ...pair, access_token: 'race-a' }, 'initial'),
      service.connect(SUB, LOGIN, { ...pair, access_token: 'race-b' }, 'initial'),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const stored = await db.githubCredential.findUniqueOrThrow({ where: { githubUserId: SUB } });
    expect(['race-a', 'race-b']).toContain(cipher.decrypt(stored.accessCipher, `${SUB}:access`));
  });

  it('refuses a replayed first-ever connect on the row`s own key', async () => {
    // No row yet means no version to swap on, so the unique user id is what
    // refuses the second write.
    const fresh = `first-${process.pid}`;
    const service = new GithubUserService(config, db);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ id: fresh, login: 'synthetic' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    try {
      await service.connect(fresh, 'synthetic', pair, null);
      await expect(service.connect(fresh, 'synthetic', pair, null)).rejects.toThrow();
      expect(await db.githubCredential.count({ where: { githubUserId: fresh } })).toBe(1);
    } finally {
      await db.githubCredential.deleteMany({ where: { githubUserId: fresh } });
    }
  });
});

/**
 * The rotated-key path, through the PUBLIC entry point, on a lost swap
 * (#892 review, F1 follow-up).
 *
 * `credential`'s outer catch is what turns an unreadable ciphertext into the
 * unconnected state rather than a 500, and a bare `return` of the lease branch's
 * promise inside that `try` settles the function before the catch can see a
 * rejection. Only one path reaches a decrypt inside that branch: the retiring
 * swap LOSES, and the winner it then re-reads is encrypted under a key this
 * process no longer holds.
 *
 * So the race is made to happen rather than asserted around. The row is moved
 * out from under the swap by the very call that performs it, which is the one
 * place a test can stand between `credential`'s read and its write without
 * reaching inside the method. Driving `leaseHeld` directly would not do: it
 * proves the rejection exists, not that `credential` catches it, and it passes
 * with the bug in place.
 */
describe('a lost retirement swap that re-reads a winner it cannot decrypt', () => {
  it('degrades to unconnected through the public entry point, rather than throwing', async () => {
    const rotated = new ConfigService({
      GITHUB_USER_APP_CLIENT_ID: 'synthetic-client', GITHUB_USER_APP_CLIENT_SECRET: 'synthetic-secret',
      BOARD_CREDENTIAL_KEY: Buffer.alloc(32, 9).toString('base64'),
    });
    const service = new GithubUserService(rotated, db);
    service.exchange = vi.fn();
    // An overdue lease, and an access token due for refresh, so `credential`
    // enters the lease branch at all.
    await db.githubCredential.update({ where: { githubUserId: SUB }, data: {
      refreshLeaseUntil: new Date(Date.now() - 1), accessExpiresAt: new Date(0),
    } });

    // Prisma's delegate is generic over its argument, so the seam is typed
    // through `unknown`; the spy's shape is checked by the call it stands in for.
    const real = db.githubCredential.updateMany.bind(db.githubCredential) as (args: unknown) => Promise<{ count: number }>;
    const restore = db.githubCredential.updateMany;
    let moved = false;
    db.githubCredential.updateMany = (async (args: unknown) => {
      if (!moved) {
        moved = true;
        // The winner lands between the read and the swap: a completed refresh,
        // whose ciphertext is under the ORIGINAL key.
        await db.githubCredential.update({ where: { githubUserId: SUB }, data: {
          version: 'written-by-the-winner', refreshLeaseUntil: null,
          accessExpiresAt: new Date(Date.now() + 3_600_000),
        } });
      }
      return real(args);
    }) as unknown as typeof restore;

    try {
      expect(await service.credential(SUB), 'the caller draws unconnected').toBeNull();
    } finally {
      db.githubCredential.updateMany = restore;
    }

    const after = await db.githubCredential.findUniqueOrThrow({ where: { githubUserId: SUB } });
    expect(after.version, 'and the winner was not overwritten').toBe('written-by-the-winner');
    expect(after.revokedAt, 'nor revoked by the swap that lost').toBeNull();
    expect(service.exchange, 'and no refresh was attempted').not.toHaveBeenCalled();
  });
});
