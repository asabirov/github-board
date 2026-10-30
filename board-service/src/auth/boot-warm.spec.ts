import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { githubContext, type GithubPrincipal } from './github-principal';
import { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import { FixtureIssuesSource } from '../issues-metrics/fixture-issues.source';
import { DeliveryService } from '../delivery/delivery.service';
import { FixtureDeliverySource } from '../delivery/fixture-delivery.source';
import { ReposService } from '../repos/repos.service';
import { FixtureReposSource } from '../repos/fixture-repos.source';
import { GithubLoginResolver } from '../identity/github-login.resolver';
import { fakeIdentityStore } from '../identity/identity.test-double';
import { IssueStoreSignal } from '../github-store/issue-store';

function make(authDisabled?: boolean, storeOn = false) {
  const config = new ConfigService({
    GITHUB_ORGS: 'acme', FEEDBACK_REPO: 'acme/board',
    ...(authDisabled === undefined ? {} : { AUTH_DISABLED: authDisabled }),
  });
  const issuesSource = new FixtureIssuesSource();
  const reposSource = new FixtureReposSource();
  const deliverySource = new FixtureDeliverySource();
  const reads = [
    vi.spyOn(issuesSource, 'listIssues'), vi.spyOn(deliverySource, 'load'),
    vi.spyOn(reposSource, 'listRepos'), vi.spyOn(reposSource, 'driByRepo'),
    vi.spyOn(reposSource, 'securityByRepo'), vi.spyOn(reposSource, 'ciByRepo'),
  ];
  const issues = new IssuesCacheService(issuesSource, config, storeOn ? new IssueStoreSignal() : undefined);
  const delivery = new DeliveryService(deliverySource, config);
  const repos = new ReposService(reposSource, config, issues, new GithubLoginResolver(fakeIdentityStore([])));
  return { issues, delivery, repos, reads };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const counts = (s: ReturnType<typeof make>) => s.reads.map((read) => read.mock.calls.length);
const readPages = async (s: ReturnType<typeof make>) => ({
  issues: await s.issues.getIssues(), delivery: await s.delivery.getDelivery(),
  repos: await s.repos.listRepos(), health: await s.repos.listHealth(),
});
const principal = (): GithubPrincipal => ({
  key: 'viewer', email: 'viewer@example.test', login: 'viewer', token: 'fake',
  owners: [{ login: 'acme', type: 'Organization' }], repositories: [], cache: new WeakMap(),
});

async function boot(s: ReturnType<typeof make>) {
  const module = await Test.createTestingModule({
    providers: [s.issues, s.delivery, s.repos].map((service) => ({
      provide: service.constructor, useFactory: () => service,
    })),
  }).compile();
  await module.init();
  await settle();
  await module.close();
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('boot warms with and without signed-in readers', () => {
  it.each([false, undefined])('does not read deployment page caches when AUTH_DISABLED=%s', async (disabled) => {
    const s = make(disabled);
    await boot(s);
    expect(counts(s)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it.each([false, undefined])('warms issues for shared store readers when AUTH_DISABLED=%s', async (disabled) => {
    const s = make(disabled, true);
    await boot(s);
    expect(counts(s)).toEqual([1, 0, 0, 0, 0, 0]);
    expect(s.issues.lastSyncedAt()).not.toBeNull();
  });

  it('keeps the warms consumed by auth-disabled page requests', async () => {
    const s = make(true);
    await boot(s);
    expect(counts(s)).toEqual([1, 1, 1, 1, 1, 1]);
    const before = counts(s);
    const pages = await readPages(s);
    expect(pages.issues.issues.length).toBeGreaterThan(0);
    expect(pages.repos.repos.length).toBeGreaterThan(0);
    expect(pages.delivery.releases.length).toBeGreaterThan(0);
    expect(counts(s)).toEqual(before);
  });

  it('signed-in cold and repeat reads have identical data and source work with or without deployment warms', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
    const warmed = make(true);
    const skipped = make(false);
    await boot(warmed);
    await boot(skipped);
    for (const s of [warmed, skipped]) for (const read of s.reads) read.mockClear();
    const a = principal();
    const b = principal();
    const before = await githubContext.run({ principal: a }, () => readPages(warmed));
    const after = await githubContext.run({ principal: b }, () => readPages(skipped));
    expect(after).toEqual(before);
    expect(after.issues.issues.length).toBeGreaterThan(0);
    expect(after.health.repos.length).toBeGreaterThan(0);
    expect(counts(skipped)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(counts(skipped)).toEqual(counts(warmed));
    expect(await githubContext.run({ principal: b }, () => readPages(skipped))).toEqual(after);
    expect(counts(skipped)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});
