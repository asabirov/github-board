import { Logger } from '@nestjs/common';
import { HealthController } from '../health/health.controller';
import { IssueStoreHealth } from '../github-store/issue-store-health';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client';
import type { ConfigService } from '@nestjs/config';
import { githubContext, type GithubPrincipal, type GithubRepository } from '../auth/github-principal';
import { PrismaIssueStore, type IssueStore, type StoreRead, type StoreRepo } from '../github-store/issue-store';
import { GithubIssuesSource } from './github-issues.source';
import type { RawIssue } from './issues-metrics.types';
import { storedIssueOf, type GithubIssueFields, type StoredIssue } from './stored-issue';

/**
 * The issue ingest in front of the webhook store (#1007, V5), with Github and
 * the store both faked. `issue-store.db-spec.ts` proves what the store answers;
 * this proves what the ingest does with it: which repos it asks about, which
 * it pages from Github anyway, and that a store that fails or misbehaves never
 * changes the answer, only what it costs.
 *
 * The fake store here answers for EVERY repo it holds, whatever it is asked,
 * on purpose. The ingest must take only the repos it asked about, so a store
 * with a bug in its filter still cannot hand a person another repository's
 * issues.
 */

const { paginate, listForOrg, listForRepo } = vi.hoisted(() => ({
  paginate: vi.fn(),
  listForOrg: Symbol('repos.listForOrg'),
  listForRepo: Symbol('issues.listForRepo'),
}));
vi.mock('../sources/github-client', () => ({
  buildOctokitClient: () => ({ paginate, repos: { listForOrg }, issues: { listForRepo } }),
}));

/** `GITHUB_ORGS` and `FEEDBACK_REPO` are pinned at the org this file's sample
 *  rows are written against. Since #1175 neither key has a default to be left
 *  to: #1166 put both behind one constant, the organisation was renamed out from
 *  under it, and the constant came off. A case that means another value passes
 *  its own. */
const cfg = (vars: Record<string, string>): ConfigService =>
  ({
    get: (k: string, d?: unknown) => ({ GITHUB_ORGS: 'acme', FEEDBACK_REPO: 'acme/board', ...vars })[k] ?? d,
  }) as unknown as ConfigService;
const ORG_CONFIG = {};

const gh = (n: number, title: string): GithubIssueFields => ({
  number: n,
  title,
  html_url: `https://github.com/acme/x/issues/${n}`,
  state: 'open',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-10T00:00:00Z',
  closed_at: null,
  user: { login: 'someone' },
  assignees: [{ login: 'octocat' }],
  labels: [{ name: 'bug' }],
  milestone: { title: 'M1' },
  body: '',
});

const ORG_REPOS = [
  { id: 101, name: 'acme', archived: false, fork: false, has_issues: true },
  { id: 102, name: 'design-system', archived: false, fork: false, has_issues: true },
  { id: 103, name: 'board', archived: false, fork: false, has_issues: true },
];
const LISTS: Record<string, GithubIssueFields[]> = {
  acme: [gh(1, 'from github: acme')],
  'design-system': [gh(2, 'from github: design-system')],
  'board': [gh(3, 'from github: board')],
};

function wireGithub(): void {
  paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
    if (params?.org) return ORG_REPOS;
    return LISTS[params?.repo ?? ''] ?? [];
  });
}
const paged = () => paginate.mock.calls.map((c) => (c[1] as { repo?: string }).repo).filter(Boolean).sort();

function fakeStore(held: Record<number, StoredIssue[]>, liveOwners = ['acme']) {
  const read = vi.fn(async (_repos: StoreRepo[]): Promise<StoreRead> => ({
    served: new Map(Object.entries(held).map(([id, rows]) => [Number(id), rows])),
    liveOwners: new Set(liveOwners),
  }));
  const baseline = vi.fn<IssueStore['baseline']>(async () => {});
  const store: IssueStore = { read, baseline, receive: vi.fn() };
  return { store, read, baseline };
}

describe('the ingest reads the webhook store first (#1007, V5)', () => {
  beforeEach(() => {
    paginate.mockReset();
    wireGithub();
  });

  it('reads only changed repositories on a delivery catch-up, keeping other live repositories', async () => {
    const { store, read } = fakeStore({ 101: [storedIssueOf(gh(1, 'old'))], 102: [], 103: [] });
    const source = new GithubIssuesSource(cfg(ORG_CONFIG), store);
    const last = await source.listIssues();
    read.mockClear();
    paginate.mockClear();
    read.mockResolvedValue({ served: new Map([[101, [storedIssueOf(gh(1, 'new'))]]]), liveOwners: new Set(['acme']) });
    const out = await source.listIssues({ reuse: {
      issues: last, repos: source.repoOutcomes(), changedRepos: ['acme/acme'],
    } });
    expect(read).toHaveBeenCalledWith([{ id: 101, full: 'acme/acme' }], undefined, undefined);
    expect(paged()).toEqual([]);
    expect(out.map((i) => i.title)).toEqual(['new']);
  });

  it('keeps a queued store answer that arrives after three seconds instead of paging GitHub', async () => {
    vi.useFakeTimers();
    try {
      const { store, read } = fakeStore({ 101: [], 102: [], 103: [] });
      const answer = read.getMockImplementation()!;
      read.mockImplementation(async (repos) => {
        await new Promise((resolve) => setTimeout(resolve, 4_500));
        return answer(repos);
      });
      const pending = new GithubIssuesSource(cfg(ORG_CONFIG), store).listIssues({ reuse: { issues: [], repos: [] } });
      await vi.advanceTimersByTimeAsync(4_500);
      expect(await pending).toEqual([]);
      expect(paged()).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('waits through brief slot contention without paging Github or marking the store unavailable', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    try {
      const answer: StoreRead = { served: new Map([[101, []], [102, []], [103, []]]), liveOwners: new Set(['acme']) };
      const transaction = vi.fn(() => new Promise<StoreRead>((resolve) => setTimeout(() => resolve(answer), 50)));
      const store = new PrismaIssueStore({ $transaction: transaction } as unknown as PrismaClient, 3_600_000);
      const targets = [{ id: 101, full: 'acme/acme' }];
      const occupied = [store.read(targets), store.read(targets)];
      const health = new IssueStoreHealth();
      const source = new GithubIssuesSource(cfg(ORG_CONFIG), store, health);
      const pending = source.listIssues();
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toEqual([]);
      await Promise.all(occupied);
      expect(transaction).toHaveBeenCalledTimes(3);
      expect(paged()).toEqual([]);
      expect(new HealthController(health, store).health().webhookStore).toEqual({ state: 'serving' });
      expect(warn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('issue ingest: 3 of 3 repos answered from the webhook store'));
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it.each([false, true])('pages Github within three seconds when the store hangs (reconcile=%s)', async (reconcile) => {
    vi.useFakeTimers();
    try {
      const { store, read, baseline } = fakeStore({});
      read.mockImplementation(() => new Promise(() => {}));
      let finished = false;
      const pending = new GithubIssuesSource(cfg(ORG_CONFIG), store).listIssues({ reconcile })
        .then((rows) => { finished = true; return rows; });
      await vi.advanceTimersByTimeAsync(3_001);
      expect(paged()).toEqual(['acme', 'board', 'design-system']);
      expect(finished).toBe(true);
      expect(await pending).toHaveLength(3);
      expect(baseline).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('public health reports state without repository counts or the last read time', async () => {
    const { store, read } = fakeStore({ 101: [], 102: [], 103: [] });
    const health = new IssueStoreHealth();
    const controller = new HealthController(health, store);
    const source = new GithubIssuesSource(cfg(ORG_CONFIG), store, health);
    expect(controller.health().webhookStore).toEqual({ state: 'unread' });
    const last = await source.listIssues();
    expect(controller.health().webhookStore).toEqual({ state: 'serving' });
    read.mockResolvedValue({ served: new Map([[101, []]]), liveOwners: new Set(['acme']) });
    await source.listIssues({ reuse: { issues: last, repos: source.repoOutcomes(), changedRepos: ['acme/acme'] } });
    expect(controller.health().webhookStore).toEqual({ state: 'serving' });
    read.mockRejectedValue(new Error('unreachable'));
    await source.listIssues();
    expect(controller.health().webhookStore).toEqual({ state: 'unavailable' });
  });

  it('refetches a changed repository when its owner stopped being live', async () => {
    const { store, read } = fakeStore({ 101: [], 102: [], 103: [] });
    const source = new GithubIssuesSource(cfg(ORG_CONFIG), store);
    const last = await source.listIssues();
    read.mockResolvedValue({ served: new Map(), liveOwners: new Set() });
    paginate.mockClear();
    const out = await source.listIssues({ reuse: { issues: last, repos: source.repoOutcomes(), changedRepos: ['acme/acme'] } });
    expect(paged()).toEqual(['acme']);
    expect(out.map((i) => i.title)).toEqual(['from github: acme']);
  });

  it('answers a repo the store holds without paging it, and pages the others', async () => {
    const { store } = fakeStore({ 101: [storedIssueOf(gh(1, 'from the store'))] });
    const out = await new GithubIssuesSource(cfg(ORG_CONFIG), store).listIssues();
    expect(paged()).toEqual(['board', 'design-system']);
    expect(out.map((i) => i.title).sort()).toEqual(['from github: board', 'from github: design-system', 'from the store']);
  });

  it('makes the same RawIssue of an issue whether it came from the store or from Github', async () => {
    const expected: RawIssue = {
      owner: 'acme', repo: 'acme', number: 1, title: 'from github: acme',
      htmlUrl: 'https://github.com/acme/x/issues/1', state: 'open', createdAt: '2026-09-01T00:00:00Z',
      closedAt: null, stateReason: null, author: 'someone', assignees: ['octocat'], labels: ['bug'],
      labelsComplete: true, submission: false, milestone: 'M1',
    };
    const viaGithub = (await new GithubIssuesSource(cfg(ORG_CONFIG)).listIssues()).find((i) => i.repo === 'acme');
    const { store } = fakeStore({ 101: [storedIssueOf(gh(1, 'from github: acme'))] });
    const viaStore = (await new GithubIssuesSource(cfg(ORG_CONFIG), store).listIssues()).find((i) => i.repo === 'acme');
    expect(viaGithub).toEqual(expected);
    expect(viaStore).toEqual(expected);
  });

  it('counts only the repos it paged as calls against the org', async () => {
    const { store } = fakeStore({ 101: [storedIssueOf(gh(1, 'from the store'))] });
    const source = new GithubIssuesSource(cfg(ORG_CONFIG), store);
    await source.listIssues();
    // The org listing, and the two repos the store could not answer.
    expect(source.orgOutcomes().find((o) => o.org === 'acme')?.calls).toBe(3);
  });

  it('writes what it paged as the baseline of each repo whose owner the webhook reaches, begun before the read', async () => {
    const { store, baseline } = fakeStore({ 101: [] });
    const before = Date.now();
    await new GithubIssuesSource(cfg(ORG_CONFIG), store).listIssues();
    expect(baseline).toHaveBeenCalledTimes(2);
    const [repo, issues, startedAt] = baseline.mock.calls.find((c) => (c[0] as StoreRepo).id === 102)! as unknown as [StoreRepo, StoredIssue[], number];
    expect(repo).toEqual({ id: 102, full: 'acme/design-system' });
    expect(issues.map((i) => i.title)).toEqual(['from github: design-system']);
    expect(startedAt).toBeGreaterThanOrEqual(before);
  });

  it('writes no baseline for an owner no delivery has reached', async () => {
    const { store, baseline } = fakeStore({}, []);
    await new GithubIssuesSource(cfg(ORG_CONFIG), store).listIssues();
    expect(baseline).not.toHaveBeenCalled();
  });

  it('pages every repo on a reconcile, and still writes the baselines', async () => {
    const { store, baseline } = fakeStore({ 101: [storedIssueOf(gh(1, 'from the store'))] });
    const out = await new GithubIssuesSource(cfg(ORG_CONFIG), store).listIssues({ reconcile: true });
    expect(paged()).toEqual(['acme', 'board', 'design-system']);
    expect(out.map((i) => i.title)).toContain('from github: acme');
    expect(baseline).toHaveBeenCalledTimes(3);
  });

  it('pages everything and writes nothing when the store cannot be read', async () => {
    const { store, read, baseline } = fakeStore({});
    read.mockRejectedValue(new Error('connection refused'));
    const out = await new GithubIssuesSource(cfg(ORG_CONFIG), store).listIssues();
    expect(paged()).toEqual(['acme', 'board', 'design-system']);
    expect(out).toHaveLength(3);
    expect(baseline).not.toHaveBeenCalled();
  });

  it('still answers when the store refuses a baseline', async () => {
    const { store, baseline } = fakeStore({});
    baseline.mockRejectedValue(new Error('disk full'));
    const out = await new GithubIssuesSource(cfg(ORG_CONFIG), store).listIssues();
    expect(out).toHaveLength(3);
  });

  it('reads Github for everything when the store takes the connection and never answers', async () => {
    vi.useFakeTimers();
    try {
      const { store, read, baseline } = fakeStore({});
      const blocked = new PrismaIssueStore({ $transaction: () => new Promise(() => {}) } as unknown as PrismaClient, 3_600_000);
      read.mockImplementation((repos) => blocked.read(repos));
      const pending = new GithubIssuesSource(cfg(ORG_CONFIG), store).listIssues();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toHaveLength(3);
      expect(baseline).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers without waiting out a baseline the store never finishes', async () => {
    vi.useFakeTimers();
    try {
      const { store, baseline } = fakeStore({});
      baseline.mockImplementation(() => new Promise<void>(() => {}));
      const pending = new GithubIssuesSource(cfg(ORG_CONFIG), store).listIssues();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toHaveLength(3);
      expect(baseline).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  // In the catch-up cases below, the fake store answers repo 101 whatever it
  // is told about owners. `liveOwners` empty is an owner the store was never
  // going to answer, whose repos a catch-up may keep.
  it('on a catch-up, takes the store\'s answer and keeps the rest of the last read, paging nothing', async () => {
    const { store, read } = fakeStore({ 101: [storedIssueOf(gh(1, 'from the store'))] }, []);
    const source = new GithubIssuesSource(cfg(ORG_CONFIG), store);
    const last = await source.listIssues();
    read.mockResolvedValue({ served: new Map([[101, [storedIssueOf(gh(1, 'changed in the store'))]]]), liveOwners: new Set() });
    paginate.mockClear();
    const out = await source.listIssues({ reuse: { issues: last, repos: source.repoOutcomes() } });
    expect(paged()).toEqual([]);
    expect(out.map((i) => i.title).sort()).toEqual(['changed in the store', 'from github: board', 'from github: design-system']);
  });

  it('on a catch-up, pages a repo the last read does not describe', async () => {
    const { store } = fakeStore({ 101: [storedIssueOf(gh(1, 'from the store'))] }, []);
    const source = new GithubIssuesSource(cfg(ORG_CONFIG), store);
    await source.listIssues({ reuse: { issues: [], repos: [{ full: 'acme/design-system', ok: true }] } });
    expect(paged()).toEqual(['board']);
  });

  it('on a catch-up, pages a repo of a live owner that the store did not answer, rather than keep it', async () => {
    const { store } = fakeStore({ 101: [storedIssueOf(gh(1, 'from the store'))] });
    const source = new GithubIssuesSource(cfg(ORG_CONFIG), store);
    const last = await source.listIssues();
    paginate.mockClear();
    await source.listIssues({ reuse: { issues: last, repos: source.repoOutcomes() } });
    expect(paged()).toEqual(['board', 'design-system']);
  });

  it('on a catch-up, fails rather than keep every row when the store cannot be read', async () => {
    const { store, read } = fakeStore({}, []);
    const source = new GithubIssuesSource(cfg(ORG_CONFIG), store);
    const last = await source.listIssues();
    read.mockRejectedValue(new Error('connection refused'));
    await expect(source.listIssues({ reuse: { issues: last, repos: source.repoOutcomes() } })).rejects.toThrow(/refill after a delivery/);
  });

  it('on a catch-up, pages again a repo the last read failed on', async () => {
    const { store } = fakeStore({ 101: [storedIssueOf(gh(1, 'from the store'))] }, []);
    const source = new GithubIssuesSource(cfg(ORG_CONFIG), store);
    await source.listIssues({ reuse: { issues: [], repos: [
      { full: 'acme/design-system', ok: false }, { full: 'acme/board', ok: true },
    ] } });
    expect(paged()).toEqual(['design-system']);
  });

  it('on a catch-up, pages two repos whose rows cannot be told apart', async () => {
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) =>
      params?.org ? [...ORG_REPOS, { id: 104, name: 'board.example.com', archived: false, fork: false, has_issues: true }] : LISTS[params?.repo ?? ''] ?? []);
    const { store } = fakeStore({ 101: [storedIssueOf(gh(1, 'from the store'))] }, []);
    const source = new GithubIssuesSource(cfg(ORG_CONFIG), store);
    const last = await source.listIssues();
    paginate.mockClear();
    await source.listIssues({ reuse: { issues: last, repos: source.repoOutcomes() } });
    // `board` and `board.example.com` share the short key `board`.
    expect(paged()).toEqual(['board', 'board.example.com']);
  });

  it('on a catch-up, pages a repo whose short key a repo in the last read shared, though that repo has left', async () => {
    const { store } = fakeStore({ 101: [storedIssueOf(gh(1, 'from the store'))] }, []);
    const source = new GithubIssuesSource(cfg(ORG_CONFIG), store);
    await source.listIssues({ reuse: { issues: [], repos: [
      { full: 'acme/design-system', ok: true },
      { full: 'acme/board', ok: true },
      { full: 'acme/board.example.com', ok: true },
    ] } });
    expect(paged()).toEqual(['board']);
  });


});

describe('a person is answered from the store only for their own repositories (#1007, V5)', () => {
  const repo = (id: number, name: string): GithubRepository => ({
    id, name, full_name: `acme/${name}`, owner: { login: 'acme' }, archived: false, fork: false, has_issues: true,
  });
  const person = (repositories: GithubRepository[]): GithubPrincipal => ({
    key: 'person', email: 'a@example.test', login: 'a', token: 'synthetic', owners: [{ login: 'acme', type: 'Organization' }],
    repositories, cache: new WeakMap(), permissionCache: new WeakMap(),
  });

  beforeEach(() => {
    paginate.mockReset();
    wireGithub();
  });

  it('asks the store about their repository ids and nothing else, and ignores anything else it hands back', async () => {
    const { store, read } = fakeStore({
      201: [storedIssueOf(gh(1, 'mine, from the store'))],
      999: [storedIssueOf(gh(2, 'somebody else’s private issue'))],
    });
    const source = new GithubIssuesSource(cfg(ORG_CONFIG), store);
    const out = await githubContext.run({ principal: person([repo(201, 'acme')]) }, () => source.listIssues());
    expect(read).toHaveBeenCalledWith([{ id: 201, full: 'acme/acme' }], undefined, 2_000);
    expect(out.map((i) => i.title)).toEqual(['mine, from the store']);
    expect(paged()).toEqual([]);
  });

  it('pages from Github, under the person’s own token, a repository the store cannot answer for', async () => {
    const { store } = fakeStore({});
    const source = new GithubIssuesSource(cfg(ORG_CONFIG), store);
    const out = await githubContext.run({ principal: person([repo(201, 'acme')]) }, () => source.listIssues());
    expect(paged()).toEqual(['acme']);
    expect(out.map((i) => i.title)).toEqual(['from github: acme']);
  });
});
