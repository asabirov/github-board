import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import type { GithubCredential, PrismaClient } from '../generated/prisma/client';
import { CredentialCipher } from '../auth/github-credential-cipher';
import { githubContext } from '../auth/github-principal';
import { GithubPrincipalGuard } from '../auth/github-principal.guard';
import { FINGERPRINT_TTL_MS, GithubUserService } from '../auth/github-user.service';
import type { IssuesMetricsService } from '../issues-metrics/issues-metrics.service';
import type { IssueBucketsService } from '../issue-buckets/issue-buckets.service';
import type { ProjectsService } from '../projects/projects.service';
import type { ReposService } from '../repos/repos.service';
import type { DerivedLoginsService } from '../identity/derived-logins.service';
import { SyncController } from './sync.controller';

// #976. A run used to live only as long as the Github access check that was
// current when it was pressed, 40 to 60 s, so any sync slower than that ended as
// "Sync progress unavailable". Each request below goes through the real guard and
// the real access check, so the re-checks happen on their real 60 s clock.
const email = 'a@example.test';
const boardSub = 'sub-a';
const key = Buffer.alloc(32, 7);
const cipher = new CredentialCipher({ key: () => key });
const config = new ConfigService({
  AUTH_DISABLED: false, GITHUB_USER_APP_CLIENT_ID: 'test-id', GITHUB_USER_APP_CLIENT_SECRET: 'test-secret',
  BOARD_CREDENTIAL_KEY: key.toString('base64'),
});
const row: GithubCredential = {
  ownerEmail: email, boardSub, githubUserId: boardSub, githubLogin: 'a', accessCipher: cipher.encrypt('user-token', `${boardSub}:access`),
  refreshCipher: cipher.encrypt('refresh', `${boardSub}:refresh`), version: 'v1', accessExpiresAt: new Date(Date.now() + 36e5),
  refreshExpiresAt: new Date(Date.now() + 72e5), scopes: '', refreshLeaseUntil: null, signInAdmittedAt: null, revokedAt: null,
  createdAt: new Date(), updatedAt: new Date(),
};

function make() {
  const github = { discoveries: 0, repositories: [1, 2] };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const repositories = String(url).includes('/repositories');
    if (!repositories) github.discoveries += 1;
    const data = repositories
      ? { total_count: github.repositories.length, repositories: github.repositories.map((id) => ({ id, name: `r${id}`, full_name: `acme/r${id}`, owner: { login: 'acme' } })) }
      : { total_count: 1, installations: [{ id: 10, account: { id: 10, login: 'acme', type: 'Organization' }, suspended_at: null }] };
    const response = new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: String(url) });
    return response;
  }));
  const db = { githubCredential: { findUnique: vi.fn(async () => row) } } as unknown as PrismaClient;
  const guard = new GithubPrincipalGuard(new GithubUserService(config, db), config);
  let finish!: () => void;
  const slow = new Promise<void>((resolve) => { finish = resolve; });
  const refresh = vi.fn(async () => { await slow; });
  const outcome = vi.fn(async () => { await slow; return 'succeeded' as const; });
  const controller = new SyncController(
    { resyncWithOutcome: outcome } as unknown as IssuesMetricsService,
    { resync: refresh } as unknown as IssueBucketsService,
    { resyncWithOutcome: outcome } as unknown as ProjectsService,
    { resyncWithOutcome: outcome } as unknown as ReposService,
    { invalidate: vi.fn(), refresh: vi.fn(async () => {}) } as unknown as DerivedLoginsService,
  );
  /** One HTTP request: a fresh request context, the real guard, then the handler. */
  const request = <T>(method: 'GET' | 'POST', path: string, handle: () => T): Promise<T> =>
    githubContext.run({ principal: null }, async () => {
      const req = { method, path, user: { email, boardSub } };
      await guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext);
      return handle();
    });
  const press = () => request('POST', '/api/sync/operations', () => controller.startOperation());
  const poll = (id: string) => request('GET', `/api/sync/operations/${id}`, () => controller.operation(id));
  return { github, press, poll, finish, calls: { refresh, outcome } };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('a sync run and the Github access check (#976)', () => {
  it('outlives the check it was pressed under, through the re-checks its own progress reads take', async () => {
    vi.useFakeTimers();
    const h = make();
    const started = await h.press();
    expect(started.state).toBe('running');
    // The browser polls about once a second, here until 15 s past the pressed
    // check's whole window, so the run is read under three later checks.
    const seconds = FINGERPRINT_TTL_MS / 1000 + 15;
    for (let second = 1; second <= seconds; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      expect((await h.poll(started.operationId)).state).toBe('running');
    }
    expect(h.github.discoveries).toBeGreaterThanOrEqual(4);
    // A second press while it runs rejoins it rather than failing or starting
    // the four reads again.
    expect((await h.press()).operationId).toBe(started.operationId);
    expect(h.calls.refresh).toHaveBeenCalledTimes(1);
    expect(h.calls.outcome).toHaveBeenCalledTimes(3);
    h.finish();
    await vi.advanceTimersByTimeAsync(0);
    const done = await h.poll(started.operationId);
    expect(done.state).toBe('succeeded');
    expect(done.syncedAt).toBe(done.finishedAt);
  });

  it('is still refused to a read whose check found different access', async () => {
    vi.useFakeTimers();
    const h = make();
    const started = await h.press();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await h.poll(started.operationId)).state).toBe('running');
    // A repository leaves this person's reach. The next check that is due sees
    // it, and the run's progress belongs to the access that no longer holds.
    h.github.repositories = [1];
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(h.poll(started.operationId)).rejects.toThrow('Sync progress unavailable.');
    h.finish();
  });
});
