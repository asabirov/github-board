import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, of, Observable } from 'rxjs';
import type { PrismaClient, GithubCredential } from '../generated/prisma/client';
import { GithubExpiryInterceptor } from './github-expiry.interceptor';
import {
  GithubUserService,
  FINGERPRINT_TTL_MS,
  VISIBILITY_MAX,
  VISIBILITY_RETENTION_MS,
} from './github-user.service';
import { CredentialCipher } from './github-credential-cipher';
import { githubContext, PrincipalState, type GithubPrincipal } from './github-principal';

/**
 * What may be released after the check that authorized it has expired (#892).
 *
 * A cold repository read is tens of seconds against a sixty-second check, so
 * long reads must be able to finish. A permission-sensitive read must not be
 * released on a fingerprint that cannot observe the grant behind it.
 */
const KEY = Buffer.alloc(32, 7);
const cipher = new CredentialCipher({ key: () => KEY });
const EMAIL = 'alice@example.test';
const SUB = '9001';

const config = new ConfigService({
  GITHUB_USER_APP_CLIENT_ID: 'synthetic-client',
  GITHUB_USER_APP_CLIENT_SECRET: 'synthetic-secret',
  BOARD_CREDENTIAL_KEY: KEY.toString('base64'),
  BOARD_SESSION_SECRET: 'synthetic-server-key',
});

/** A connected row for whoever is asked about, keyed on the stable GitHub user
 *  id, so the fake can serve more than one person. */
const row = (id = SUB, version = 'v1'): GithubCredential =>
  ({
    ownerEmail: EMAIL, boardSub: id, githubUserId: id, githubLogin: 'alice',
    accessCipher: cipher.encrypt('ghu_alice', `${id}:access`),
    refreshCipher: cipher.encrypt('ghr_alice', `${id}:refresh`),
    accessExpiresAt: new Date(Date.now() + 3_600_000),
    refreshExpiresAt: new Date(Date.now() + 7_200_000),
    scopes: '', version, refreshLeaseUntil: null, revokedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  }) as GithubCredential;

/**
 * Github answers with ONE installation and ONE repository whose id never
 * changes. `permissions` is what moves — which is the case the fingerprint is
 * supposed to catch — and `teamGrant` is a permission the fingerprint cannot
 * see at all, standing in for a private Projects grant.
 */
function service(state: { push: boolean; version?: string }) {
  const db = {
    githubCredential: {
      findUnique: async ({ where }: { where: { githubUserId: string } }) => row(where.githubUserId, state.version ?? 'v1'),
    },
  } as unknown as PrismaClient;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = String(url).includes('/repositories')
      ? { total_count: 1, repositories: [{ id: 1, name: 'r', full_name: 'acme/r', owner: { login: 'acme' }, permissions: { push: state.push } }] }
      : { total_count: 1, installations: [{ id: 10, account: { id: 10, login: 'acme', type: 'Organization' }, suspended_at: null }] };
    const res = new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(res, 'url', { value: String(url) });
    return res;
  }));
  return new GithubUserService(config, db);
}

/** The execution context the interceptor reads: the request's method, and a
 *  response it can mark. `headers` records what it marked, which is what the
 *  browser reads (#892 review, C2). */
const ctx = (method = 'GET', headers: Record<string, string> = {}) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ method }),
      getResponse: () => ({ setHeader: (k: string, v: string) => { headers[k] = v; } }),
    }),
  }) as never;
/** A handler that takes `ms` of wall clock to produce its answer. */
const slowHandler = (ms: number, value: unknown) => ({
  handle: () => new Observable((sub) => { setTimeout(() => { sub.next(value); sub.complete(); }, ms); }),
});

describe('a long read that outlives its authorization check', () => {
  it('completes a 35s repository-only read started late in a window', async () => {
    vi.useFakeTimers();
    try {
      const svc = service({ push: true });
      const principal = await svc.principal(EMAIL, SUB);
      // Start 40s in: the check expires 20s from now and the read needs 35s.
      vi.advanceTimersByTime(40_000);
      const interceptor = new GithubExpiryInterceptor(svc);
      const answer = githubContext.run({ principal, boardSub: SUB }, () =>
        firstValueFrom(interceptor.intercept(ctx(), slowHandler(35_000, { rows: 7 }))),
      );
      await vi.advanceTimersByTimeAsync(35_000);
      expect(await answer, 'the answer the handler produced').toEqual({ rows: 7 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses the same read when access actually changed under it', async () => {
    vi.useFakeTimers();
    try {
      const state = { push: true };
      const svc = service(state);
      const principal = await svc.principal(EMAIL, SUB);
      vi.advanceTimersByTime(40_000);
      const interceptor = new GithubExpiryInterceptor(svc);
      const answer = githubContext.run({ principal, boardSub: SUB }, () =>
        firstValueFrom(interceptor.intercept(ctx(), slowHandler(35_000, { rows: 7 }))),
      );
      // The matcher is attached BEFORE the clock moves: the rejection lands
      // during the advance, and an unattached one is an unhandled rejection.
      const rejection = expect(answer).rejects.toThrow('GitHub access changed during this read');
      // Permission narrows while the read is out. Same repository id.
      state.push = false;
      await vi.advanceTimersByTimeAsync(35_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves a read that finished inside its own window without re-checking', async () => {
    const svc = service({ push: true });
    const principal = await svc.principal(EMAIL, SUB);
    const spy = vi.spyOn(svc, 'principal');
    const interceptor = new GithubExpiryInterceptor(svc);
    const value = await githubContext.run({ principal, boardSub: SUB }, () =>
      firstValueFrom(interceptor.intercept(ctx(), { handle: () => of({ rows: 1 }) })),
    );
    expect(value).toEqual({ rows: 1 });
    expect(spy, 'no second discovery for a read that beat its deadline').not.toHaveBeenCalled();
  });
});

describe('a permission-sensitive read is never released on an unchanged fingerprint', () => {
  it('refuses even when owners, repository ids and permissions are all identical', async () => {
    vi.useFakeTimers();
    try {
      const svc = service({ push: true });
      const principal = await svc.principal(EMAIL, SUB);
      vi.advanceTimersByTime(40_000);
      const interceptor = new GithubExpiryInterceptor(svc);
      // A surface that reads permission-sensitive state — the default for
      // `PrincipalState`, which is what Projects, security and billing use.
      const projects = new PrincipalState(() => ({ boards: ['a private board'] }));
      const answer = githubContext.run({ principal, boardSub: SUB }, () => {
        const store = githubContext.getStore();
        return firstValueFrom(
          interceptor.intercept(ctx(), {
            handle: () =>
              new Observable((sub) => {
                setTimeout(() => {
                  // Reading it inside the handler is what marks the request.
                  githubContext.run({ ...store!, principal }, () => projects.current);
                  store!.sensitive = true;
                  sub.next({ boards: projects.current.boards });
                  sub.complete();
                }, 35_000);
              }),
          }),
        );
      });
      const rejection = expect(answer).rejects.toThrow('needs rechecking');
      await vi.advanceTimersByTimeAsync(35_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the request as soon as permission-sensitive state is read', async () => {
    const svc = service({ push: true });
    const principal = await svc.principal(EMAIL, SUB);
    const sensitive = new PrincipalState(() => ({ n: 0 }));
    const repoOnly = new PrincipalState(() => ({ n: 0 }), true);

    githubContext.run({ principal, boardSub: SUB }, () => {
      const store = githubContext.getStore()!;
      repoOnly.current.n = 1;
      expect(store.sensitive, 'a repository-only read leaves the request releasable').toBeUndefined();
      sensitive.current.n = 1;
      expect(store.sensitive, 'a permission-sensitive read marks it').toBe(true);
    });
  });

  it('restarts permission-sensitive state at every check, and keeps repository state', async () => {
    // A fake clock: `expiresAt` is measured from when a check started, and on a
    // real clock both checks can start in the same millisecond.
    vi.useFakeTimers();
    try {
      const svc = service({ push: true });
      const firstCheck = Date.now();
      const first = await svc.principal(EMAIL, SUB);
      expect(first.expiresAt!, 'the first deadline is one window from its own start').toBe(
        firstCheck + FINGERPRINT_TTL_MS,
      );
      // Spend the whole window so the second call is a real second check rather
      // than the first one handed back, with Github's answers unchanged across it.
      vi.advanceTimersByTime(FINGERPRINT_TTL_MS);
      const secondCheck = Date.now();
      const second = await svc.principal(EMAIL, SUB);
      expect(second.key, 'the visibility generation did not move').toBe(first.key);
      expect(second.cache, 'repository-bound state survives').toBe(first.cache);
      expect(second.permissionCache, 'permission-sensitive state restarts').not.toBe(first.permissionCache);
      expect(second.expiresAt!, 'and the second deadline is measured from the second check, not extended from the first').toBe(
        secondCheck + FINGERPRINT_TTL_MS,
      );
      expect(second.expiresAt!, 'so it really did move forward').toBeGreaterThan(first.expiresAt!);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the visibility generation', () => {
  it('is unchanged when nothing about the person`s access changed', async () => {
    const svc = service({ push: true });
    const first = await svc.principal(EMAIL, SUB);
    (svc as unknown as { visibility: Map<string, { until: number }> }).visibility.forEach((v) => { v.until = Date.now() - 1; });
    expect((await svc.principal(EMAIL, SUB)).key).toBe(first.key);
  });

  it('moves when a repository permission changes under an unchanged repository id', async () => {
    const state = { push: true };
    const svc = service(state);
    const first = await svc.principal(EMAIL, SUB);
    (svc as unknown as { visibility: Map<string, { until: number }> }).visibility.forEach((v) => { v.until = Date.now() - 1; });
    state.push = false;
    expect((await svc.principal(EMAIL, SUB)).key).not.toBe(first.key);
  });

  it('is unchanged by a credential refresh, which grants nothing new (#1395)', async () => {
    // THE BUG BEHIND "the board tab always shows loading". `version` is a fresh
    // UUID on every refresh and the board requires expiring user tokens, so this
    // happened at least once a day. The browser read the moved key as somebody
    // else, emptied its cache and remounted, and the next open started cold.
    //
    // A refresh re-reads the row, so the check below is a REAL second discovery
    // with the same Github answers — `previous.version === row.version` fails,
    // which is what put the new version in the key in the first place.
    const state = { push: true, version: 'v1' };
    const svc = service(state);
    const first = await svc.principal(EMAIL, SUB);
    state.version = 'v2';
    expect((await svc.principal(EMAIL, SUB)).key, 'a refreshed token is the same person seeing the same things').toBe(first.key);
  });

  it('carries no timestamp, so it cannot move on its own', async () => {
    const svc = service({ push: true });
    const p = await svc.principal(EMAIL, SUB);
    expect(p.key).not.toMatch(new RegExp(`:${Math.floor(Date.now() / 100_000)}`));
    expect(p.expiresAt, 'freshness is carried separately').toBeGreaterThan(Date.now());
    expect(p.expiresAt! - Date.now()).toBeLessThanOrEqual(FINGERPRINT_TTL_MS);
  });
});

describe('what the board retains, and who can read it', () => {
  it('drops a person`s snapshot once it is idle past the repository caches` own life', async () => {
    vi.useFakeTimers();
    try {
      const svc = service({ push: true });
      const held = svc as unknown as { visibility: Map<string, unknown> };
      await svc.principal(EMAIL, SUB);
      expect(held.visibility.size).toBe(1);
      // Somebody else arrives long after the first person went home.
      vi.advanceTimersByTime(VISIBILITY_RETENTION_MS + FINGERPRINT_TTL_MS + 1);
      await svc.principal('bob@example.test', '9002').catch(() => {});
      // The first person's whole snapshot is no longer held.
      expect([...held.visibility.keys()].some((k) => String(k).startsWith(EMAIL))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a hard ceiling for the case where nobody is idle', () => {
    expect(VISIBILITY_MAX).toBe(128);
  });

  /**
   * F4 — who still reads the deployment caches the boot warms fill.
   *
   * This covers in-memory isolation, not the shared webhook-store baselines
   * that the retained issues warm refreshes for signed-in readers. Deployment state is
   * reachable only with NO request context, which after #892 means the
   * `AUTH_DISABLED` fixture lane and the no-person jobs. An authenticated
   * request always carries a principal — connected or not — and reads its own.
   */
  it('serves the deployment cache to no-person work and to no authenticated request', async () => {
    const svc = service({ push: true });
    const warm = new PrincipalState(() => ({ rows: [] as string[] }));
    // The boot warm: no context at all.
    warm.current.rows.push('warmed at boot');

    const connected = await svc.principal(EMAIL, SUB);
    githubContext.run({ principal: connected, boardSub: SUB }, () => {
      expect(warm.current.rows, 'a connected person reads their own, not the warm').toEqual([]);
    });
    const unconnected = await svc.principal('nobody@example.test', '9003');
    githubContext.run({ principal: unconnected, boardSub: '9003' }, () => {
      expect(warm.current.rows, 'and so does an unconnected one').toEqual([]);
    });
    // The fixture lane skips the context entirely (`app.module.ts`), which is
    // the reader of this deployment state. The issues warm also refreshes
    // shared webhook-store baselines, outside PrincipalState.
    expect(warm.current.rows).toEqual(['warmed at boot']);
  });
});

it('marks a sensitive response with its own absolute check deadline and visibility', async () => {
  const svc = service({ push: true });
  const principal = await svc.principal(EMAIL, SUB);
  const headers: Record<string, string> = {};
  const result = await githubContext.run({ principal, boardSub: SUB, sensitive: true }, () =>
    firstValueFrom(new GithubExpiryInterceptor(svc).intercept(ctx('GET', headers), { handle: () => of({ private: true }) })),
  );
  expect(result).toEqual({ private: true });
  expect(headers['X-Board-Sensitive']).toBe('1');
  expect(headers['X-Board-Access-Expires-At']).toBe(String(principal.expiresAt));
  expect(headers['X-Board-Visibility']).toBe(svc.clientVisibilityKey(principal.key));
});

/**
 * The one relaxation #1007 made to what an access re-check empties, and its
 * whole boundary. `ProjectsService` and the repository map hold their state
 * under `KeptWhileUnchanged`: carried into a re-check that found the same
 * visibility, and never across a change of it, never to another person, never
 * past the holder's TTL, and still marking every request that reads it.
 */
describe('a state kept while access is unchanged (#1007)', () => {
  const kept = (maxAgeMs = 300_000) => new PrincipalState(() => ({ reads: 0 }), { maxAgeMs: () => maxAgeMs });
  const within = <T>(principal: GithubPrincipal, read: () => T): T => githubContext.run({ principal, boardSub: SUB }, read);
  const nextCheck = () => vi.advanceTimersByTime(FINGERPRINT_TTL_MS);

  it('is carried into a re-check that found the same visibility, and still marks the request', async () => {
    vi.useFakeTimers();
    try {
      const svc = service({ push: true });
      const projects = kept();
      const first = await svc.principal(EMAIL, SUB);
      within(first, () => { projects.current.reads += 1; });
      nextCheck();
      const second = await svc.principal(EMAIL, SUB);
      expect(second.permissionCache, 'a genuine second check').not.toBe(first.permissionCache);
      expect(within(second, () => projects.current.reads), 'the state the first check left').toBe(1);
      const marked = within(second, () => { void projects.current; return githubContext.getStore()!.sensitive; });
      expect(marked, 'still permission-sensitive, so a late answer is still refused').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts cold when the re-check found the visibility changed', async () => {
    vi.useFakeTimers();
    try {
      const state = { push: true };
      const svc = service(state);
      const projects = kept();
      within(await svc.principal(EMAIL, SUB), () => { projects.current.reads += 1; });
      nextCheck();
      state.push = false;
      expect(within(await svc.principal(EMAIL, SUB), () => projects.current.reads)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts cold after the person asks for a re-check', async () => {
    const svc = service({ push: true });
    const projects = kept();
    within(await svc.principal(EMAIL, SUB), () => { projects.current.reads += 1; });
    await svc.refreshAccess(SUB);
    expect(within(await svc.principal(EMAIL, SUB), () => projects.current.reads)).toBe(0);
  });

  it('is gone the moment the credential stops resolving: revoked, disconnected or rotated away', async () => {
    const svc = service({ push: true });
    const projects = kept();
    within(await svc.principal(EMAIL, SUB), () => { projects.current.reads += 1; });
    vi.spyOn(svc, 'credential').mockResolvedValue(null);
    const unconnected = await svc.principal(EMAIL, SUB);
    expect(unconnected.token).toBeNull();
    expect(within(unconnected, () => projects.current.reads)).toBe(0);
  });

  it('is never carried to another person, even one whose access looks identical', async () => {
    const svc = service({ push: true });
    const projects = kept();
    within(await svc.principal(EMAIL, SUB), () => { projects.current.reads += 1; });
    // Same installation, same repository, same permissions: only the person differs.
    const bob = await svc.principal('bob@example.test', '9002');
    expect(within(bob, () => projects.current.reads)).toBe(0);
    expect(within(await svc.principal(EMAIL, SUB), () => projects.current.reads)).toBe(1);
  });

  it('is let go at the first check that would serve it past its TTL', async () => {
    vi.useFakeTimers();
    try {
      const svc = service({ push: true });
      const projects = kept(300_000);
      within(await svc.principal(EMAIL, SUB), () => { projects.current.reads += 1; });
      // The checks at 60, 120, 180 and 240 s all end by 300 s, inside the TTL of
      // a state made at 0 s.
      for (let at = 60; at <= 240; at += 60) {
        nextCheck();
        expect(within(await svc.principal(EMAIL, SUB), () => projects.current.reads), `the check at ${at}s`).toBe(1);
      }
      // The check at 300 s would serve until 360 s.
      nextCheck();
      expect(within(await svc.principal(EMAIL, SUB), () => projects.current.reads)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

it('withholds lease headers when no private fingerprint key is configured', async () => {
  const svc = service({ push: true });
  const principal = await svc.principal(EMAIL, SUB);
  const unconfigured = new GithubUserService(new ConfigService({ BOARD_CREDENTIAL_KEY: KEY.toString('base64') }), {} as PrismaClient);
  const headers: Record<string, string> = {};
  await githubContext.run({ principal, boardSub: SUB, sensitive: true }, () =>
    firstValueFrom(new GithubExpiryInterceptor(unconfigured).intercept(ctx('GET', headers), { handle: () => of({ private: true }) })),
  );
  expect(headers['X-Board-Sensitive']).toBe('1');
  expect(headers['X-Board-Access-Expires-At']).toBeUndefined();
  expect(headers['X-Board-Visibility']).toBeUndefined();
});
