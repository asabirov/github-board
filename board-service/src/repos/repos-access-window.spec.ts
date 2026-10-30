import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, Observable } from 'rxjs';
import type { PrismaClient, GithubCredential } from '../generated/prisma/client';
import { ReposService } from './repos.service';
import type { IReposSource } from './repo.types';
import type { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import type { GithubLoginResolver } from '../identity/github-login.resolver';
import { CredentialCipher } from '../auth/github-credential-cipher';
import { GithubExpiryInterceptor } from '../auth/github-expiry.interceptor';
import { GithubPrincipalGuard } from '../auth/github-principal.guard';
import { githubContext, type PrincipalState } from '../auth/github-principal';
import { FINGERPRINT_TTL_MS, GithubUserService, MIN_READ_HEADROOM_MS } from '../auth/github-user.service';

/**
 * Whether the REAL Repos map can finish (#892 review, C3).
 *
 * `github-expiry.spec.ts` proves that a synthetic repository-only handler
 * running 35 s from 40 s into a window is released. That proves nothing about
 * this map, and the review was right about it twice over. `ReposService` holds
 * the repo rows on one `PrincipalState` and the security alert counts, the
 * Actions billing and every repo page on another, neither repository-only (the
 * map's is kept across an unchanged check since #1007, which changes nothing
 * about the marking), so a map read is permission-sensitive — the branch the synthetic test never takes,
 * and the branch that is REFUSED rather than released. And nothing decides that
 * from the outside: the marking happens where the state is read, inside the
 * service, so only the service can be asked.
 *
 * The classification is not the thing to change. The state is genuinely mixed,
 * and calling it repository-only would release an alert count on a fingerprint
 * that cannot see the grant behind it. What changes is WHEN the read is allowed
 * to start: `MIN_READ_HEADROOM_MS` of check, established by a fresh discovery if
 * the held one is nearly spent.
 */
/**
 * The real `ReposService` over the plainest possible source.
 *
 * Written here rather than borrowed from `repos.service.spec.ts`: importing that
 * file would run its whole suite a second time inside this one. What matters for
 * these claims is that the SERVICE is the real one — the `PrincipalState` under
 * test is its own — and the source behind it only has to answer.
 */
function reposService(calls: Record<string, number> = {}): ReposService {
  const empty = async () => ({ byRepo: new Map(), unreadableOrgs: [] as string[] });
  // How often the map's listing, the alert lists, the billing and a repo page's
  // reads went to the source (#1007).
  const counted = <T>(name: string, read: () => Promise<T>) => () => { calls[name] = (calls[name] ?? 0) + 1; return read(); };
  const source: IReposSource = {
    servedOrgs: ['acme'],
    listRepos: counted('listRepos', async () => ({ repos: [{ full: 'acme/r', owner: 'acme', name: 'r', defaultBranch: 'main' }], unreadableOrgs: [] })),
    driByRepo: empty,
    securityByRepo: counted('securityByRepo', empty),
    ciByRepo: async () => new Map(),
    driSchema: async () => ({ allowedValues: [], writability: 'writable' }) as never,
    setDri: async (_full: string, login: string | null) => login,
    readme: counted('readme', async () => ({ state: 'absent' }) as never),
    pullRequests: counted('pullRequests', async () => ({ state: 'read', open: 0, closedMerged: 0, prs: [], coveredFrom: null, openPrs: [] }) as never),
    actionsUsage: counted('actionsUsage', async () => ({ days: [], orgs: ['acme'] })),
  } as unknown as IReposSource;
  const issuesCache = {
    getIssues: async () => ({ issues: [], at: Date.now(), repos: [{ full: 'acme/r', ok: true }], orgs: [] }),
    resync: async () => {},
  } as unknown as IssuesCacheService;
  const githubLogins = {
    rosterGeneration: () => 0,
    invalidateRoster: () => {},
    teamRoster: async () => ({ names: new Map() }),
  } as unknown as GithubLoginResolver;
  return new ReposService(source, config, issuesCache, githubLogins);
}

const KEY = Buffer.alloc(32, 7);
const cipher = new CredentialCipher({ key: () => KEY });
const EMAIL = 'alice@example.test';
const SUB = '9001';

// ConfigService falls back to process.env for missing keys. Pin the settings
// these fixtures read so a contributor's fixture-mode .env cannot bypass auth
// or change the repository cache and feedback scope (#1109).
const config = new ConfigService({
  AUTH_DISABLED: false,
  REPOS_CACHE_TTL_MS: 600_000,
  FEEDBACK_REPO: 'acme/board',
  FEEDBACK_LABELS: 'feedback',
  GITHUB_USER_APP_CLIENT_ID: 'synthetic-client',
  GITHUB_USER_APP_CLIENT_SECRET: 'synthetic-secret',
  BOARD_CREDENTIAL_KEY: KEY.toString('base64'),
});

const row = (): GithubCredential =>
  ({
    ownerEmail: EMAIL, boardSub: SUB, githubUserId: SUB, githubLogin: 'alice',
    accessCipher: cipher.encrypt('ghu_alice', `${SUB}:access`),
    refreshCipher: cipher.encrypt('ghr_alice', `${SUB}:refresh`),
    accessExpiresAt: new Date(Date.now() + 3_600_000),
    refreshExpiresAt: new Date(Date.now() + 7_200_000),
    scopes: '', version: 'v1', refreshLeaseUntil: null, signInAdmittedAt: null, revokedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  }) as GithubCredential;

/** Github answers one installation and one repository. `owners` is what a lost
 *  org takes away, and `discoveryMs` is how long the check itself costs. */
function github(state: { owners: boolean; discoveryMs?: number }) {
  const db = { githubCredential: { findUnique: async () => row() } } as unknown as PrismaClient;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (state.discoveryMs) await new Promise((r) => setTimeout(r, state.discoveryMs));
    const body = String(url).includes('/repositories')
      ? { total_count: 1, repositories: [{ id: 1, name: 'r', full_name: 'acme/r', owner: { login: 'acme' }, permissions: { push: true } }] }
      : { total_count: state.owners ? 1 : 0, installations: state.owners ? [{ id: 10, account: { id: 10, login: 'acme', type: 'Organization' }, suspended_at: null }] : [] };
    const res = new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(res, 'url', { value: String(url) });
    return res;
  }));
  return new GithubUserService(config, db);
}

const request = (path = '/api/repos', method = 'GET') => ({ path, method, user: { email: EMAIL, boardSub: SUB } });
const ctx = (req: object, headers: Record<string, string> = {}) =>
  ({
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ setHeader: (k: string, v: string) => { headers[k] = v; } }),
    }),
  }) as never;

describe('the Repos map is permission-sensitive, and this is the service saying so', () => {
  it('marks the request when the REAL map is read', async () => {
    const service = reposService();
    const svc = github({ owners: true });
    const principal = await svc.principal(EMAIL, SUB);
    const seen = await githubContext.run({ principal, boardSub: SUB }, async () => {
      await service.listRepos();
      return githubContext.getStore()!.sensitive;
    });
    expect(seen, 'the map read reached a permission-sensitive PrincipalState').toBe(true);
  });

  it('marks it for the health read and the per-repo page too, on the state beside the map', async () => {
    for (const read of ['health', 'page'] as const) {
      const service = reposService();
      const svc = github({ owners: true });
      const principal = await svc.principal(EMAIL, SUB);
      const seen = await githubContext.run({ principal, boardSub: SUB }, async () => {
        if (read === 'health') await service.listHealth();
        else await service.repoPage('acme', 'board').catch(() => {});
        return githubContext.getStore()!.sensitive;
      });
      expect(seen, read).toBe(true);
    }
  });

  it('is therefore REFUSED, not released, when it lands past its check', async () => {
    vi.useFakeTimers();
    try {
      const service = reposService();
      const svc = github({ owners: true });
      const principal = await svc.principal(EMAIL, SUB);
      // 40s into a 60s window, with 35s of reading to do: the case the synthetic
      // repository-only test says is fine, taken through the real service.
      vi.advanceTimersByTime(40_000);
      const interceptor = new GithubExpiryInterceptor(svc);
      const answer = githubContext.run({ principal, boardSub: SUB }, () => {
        const store = githubContext.getStore()!;
        return firstValueFrom(interceptor.intercept(ctx(request()), {
          handle: () => new Observable((sub) => {
            setTimeout(() => {
              void githubContext.run(store, () => service.listRepos()).then((v) => { sub.next(v); sub.complete(); });
            }, 35_000);
          }),
        }));
      });
      const rejection = expect(answer).rejects.toThrow('needs rechecking');
      await vi.advanceTimersByTimeAsync(35_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the headroom a Github read is admitted with', () => {
  it('replaces a nearly-spent check with a fresh one, so the same read completes', async () => {
    vi.useFakeTimers();
    try {
      const service = reposService();
      const svc = github({ owners: true });
      const guard = new GithubPrincipalGuard(svc, config);
      await svc.principal(EMAIL, SUB); // the check this request will find held
      vi.advanceTimersByTime(40_000); // 20s left — under the floor

      const req = request();
      const value = await githubContext.run({ principal: null }, async () => {
        await guard.canActivate(ctx(req));
        const store = githubContext.getStore()!;
        expect(store.principal!.expiresAt! - Date.now(), 'admitted with the full floor').toBeGreaterThanOrEqual(MIN_READ_HEADROOM_MS);
        const interceptor = new GithubExpiryInterceptor(svc);
        const answer = firstValueFrom(interceptor.intercept(ctx(req), {
          handle: () => new Observable((sub) => {
            setTimeout(() => {
              void githubContext.run(store, () => service.listRepos()).then((v) => { sub.next(v); sub.complete(); });
            }, 35_000);
          }),
        }));
        await vi.advanceTimersByTimeAsync(35_000);
        return answer;
      });
      expect(Array.isArray((value as { repos: unknown[] }).repos), 'the map answered').toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a floor to START on, not a ceiling on how long a read may run', () => {
    // A read admitted on a check with the whole window left may legitimately run
    // the whole window. The floor is only about not STARTING against a stub.
    expect(MIN_READ_HEADROOM_MS).toBeLessThan(FINGERPRINT_TTL_MS);
  });

  it('refuses honestly rather than discovering again when the fresh check is itself nearly spent', async () => {
    vi.useFakeTimers();
    try {
      // Discovery costs 25s, so even a brand-new check leaves 35s — under the
      // 40s floor. One attempt, then a refusal.
      const svc = github({ owners: true, discoveryMs: 12_500 });
      const guard = new GithubPrincipalGuard(svc, config);
      const attempt = githubContext.run({ principal: null }, () => guard.canActivate(ctx(request())));
      const rejection = expect(attempt).rejects.toThrow('too little left to start this read');
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
      // Two calls: the installations list and its one repository page. A retry
      // loop would show as four, six, eight.
      expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks for no headroom on a write, or off the Github surfaces', async () => {
    const svc = github({ owners: true });
    const spy = vi.spyOn(svc, 'principal');
    const guard = new GithubPrincipalGuard(svc, config);
    for (const req of [request('/api/repos', 'POST'), request('/api/admin/audit')]) {
      await githubContext.run({ principal: null }, () => guard.canActivate(ctx(req)));
    }
    for (const call of spy.mock.calls) expect(call[3] ?? 0).toBe(0);
  });

  it('keeps the owner-loss bound at one fingerprint TTL: the fresh check is a real one', async () => {
    vi.useFakeTimers();
    try {
      const state = { owners: true };
      const svc = github(state);
      const guard = new GithubPrincipalGuard(svc, config);
      const first = await svc.principal(EMAIL, SUB);
      expect(first.owners).toHaveLength(1);
      // Access is withdrawn 40s in — inside the first check's own window, which
      // is exactly the case the bound is about.
      vi.advanceTimersByTime(40_000);
      state.owners = false;
      const seen = await githubContext.run({ principal: null }, async () => {
        await guard.canActivate(ctx(request()));
        return githubContext.getStore()!.principal!;
      });
      expect(seen.owners, 'the loss is seen within one TTL, not two').toEqual([]);
      expect(seen.key).not.toBe(first.key);
    } finally {
      vi.useRealTimers();
    }
  });
});

it('renews a nearly spent /auth/me check through genuine discovery before its deadline', async () => {
  vi.useFakeTimers();
  try {
    const state = { owners: true };
    const svc = github(state);
    const first = await svc.principal(EMAIL, SUB);
    vi.advanceTimersByTime(30_000);
    state.owners = false;
    const guard = new GithubPrincipalGuard(svc, config);
    const fresh = await githubContext.run({ principal: null }, async () => {
      await guard.canActivate(ctx(request('/api/auth/me')));
      return githubContext.getStore()!.principal!;
    });
    expect(fresh.owners).toEqual([]);
    expect(fresh.key).not.toBe(first.key);
    expect(fresh.expiresAt).toBe(Date.now() + FINGERPRINT_TTL_MS);
  } finally { vi.useRealTimers(); }
});

/**
 * The Repos half of #1007's one relaxation. The map is kept across a re-check
 * that found the same visibility, for no longer than its TTL. The health payload
 * beside it, whose security alerts turn on a grant nobody approved keeping,
 * still starts cold at every check.
 */
describe('the map across access re-checks (#1007)', () => {
  // The other half of the boundary, and the half a mistake would widen: moving
  // the billing or the repo pages onto the kept state by accident leaves every
  // spec that proves the keeping green. So: everything that is not the map
  // still starts cold at a check that found nothing changed.
  it('still reads the billing, a repo page and the alert lists at every check that found nothing changed', async () => {
    vi.useFakeTimers();
    try {
      const calls: Record<string, number> = {};
      const service = reposService(calls);
      const svc = github({ owners: true });
      for (let check = 0; check < 3; check += 1) {
        const principal = await svc.principal(EMAIL, SUB);
        await githubContext.run({ principal, boardSub: SUB }, async () => {
          await service.listHealth();
          await service.repoPage('acme', 'r');
        });
        vi.advanceTimersByTime(FINGERPRINT_TTL_MS);
      }
      expect(calls.listRepos, 'the map, which is kept').toBe(1);
      expect(calls.actionsUsage, 'the billing').toBe(3);
      expect([calls.readme, calls.pullRequests], 'the repo page').toEqual([3, 3]);
      expect(calls.securityByRepo, 'the alert lists').toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the map and nothing else', async () => {
    // Adding a key here widens what the maintainer approved in #1007. That is
    // their decision to make, not an edit to this list.
    const service = reposService();
    const principal = await github({ owners: true }).principal(EMAIL, SUB);
    const kept = (service as unknown as { mapState: PrincipalState<object> }).mapState;
    const keys = githubContext.run({ principal, boardSub: SUB }, () => Object.keys(kept.current).sort());
    expect(keys).toEqual(['builds', 'epoch', 'inFlight', 'view']);
  });

  it('reads the map once for three checks that found nothing changed, and the alert lists at each', async () => {
    vi.useFakeTimers();
    try {
      const calls: Record<string, number> = {};
      const service = reposService(calls);
      const svc = github({ owners: true });
      for (let check = 0; check < 3; check += 1) {
        const principal = await svc.principal(EMAIL, SUB);
        await githubContext.run({ principal, boardSub: SUB }, () => service.listHealth());
        vi.advanceTimersByTime(FINGERPRINT_TTL_MS);
      }
      expect(calls.listRepos, 'the map').toBe(1);
      expect(calls.securityByRepo, 'the alert lists').toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the map again once a re-check found the visibility changed', async () => {
    vi.useFakeTimers();
    try {
      const calls: Record<string, number> = {};
      const service = reposService(calls);
      const state = { owners: true };
      const svc = github(state);
      await githubContext.run({ principal: await svc.principal(EMAIL, SUB), boardSub: SUB }, () => service.listRepos());
      vi.advanceTimersByTime(FINGERPRINT_TTL_MS);
      state.owners = false;
      await githubContext.run({ principal: await svc.principal(EMAIL, SUB), boardSub: SUB }, () => service.listRepos());
      expect(calls.listRepos).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
