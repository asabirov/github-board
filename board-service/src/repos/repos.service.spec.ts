import { describe, expect, it, vi } from 'vitest';
import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ReposService } from './repos.service';
import { ReposController } from './repos.controller';
import { CapabilityRegistry } from '../capability/capability.registry';
import type { AuditService } from '../audit/audit.service';
import { REPO_WEEKS } from './repo-rollup';
import type {
  ActionsUsageDay,
  ActionsUsageRead,
  DriRead,
  DriSchema,
  IReposSource,
  RepoCiRead,
  RepoDescriptor,
  RepoOpenPr,
  RepoPrRead,
  RepoReadme,
  RepoSecurity,
  ReposRead,
  SecurityRead,
  UsageMonth,
} from './repo.types';
import { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import type { RawIssue } from '../issues-metrics/issues-metrics.types';
import type { IdentityRecord } from '../identity/identity.repository';
import { fakeIdentityStore, identityRecordFor } from '../identity/identity.test-double';
import { GithubLoginResolver } from '../identity/github-login.resolver';

const DAY_MS = 86_400_000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY_MS).toISOString();

const DESCRIPTORS: RepoDescriptor[] = [
  {
    full: 'acme/board',
    name: 'board',
    key: 'board',
    htmlUrl: 'https://github.com/acme/board',
    description: null,
    language: 'TypeScript',
    pushedAt: daysAgo(1),
    createdAt: daysAgo(730),
    defaultBranch: 'main',
  },
  {
    full: 'acme/status',
    name: 'status',
    key: 'status',
    htmlUrl: 'https://github.com/acme/status',
    description: null,
    language: null,
    pushedAt: daysAgo(130),
    createdAt: daysAgo(730),
    defaultBranch: 'main',
  },
];

function rawIssue(over: Partial<RawIssue> = {}): RawIssue {
  return {
    owner: 'acme',
    repo: 'board',
    number: 1,
    title: 't',
    htmlUrl: 'https://github.com/acme/board/issues/1',
    state: 'open',
    createdAt: daysAgo(2),
    closedAt: null,
    // A synthetic row is told no reason, which is the state that COUNTS —
    // so every assertion written before #1014 keeps meaning what it meant.
    stateReason: null,
    author: null,
    assignees: [],
    labels: [],
    labelsComplete: true,
    // These rows are about counting, not about words (#516).
    submission: false,
    milestone: null,
    ...over,
  };
}

/** One OPEN pull request as the PRs tab lists it (#828). */
const openPr = (
  number: number,
  createdAt: string,
  author: string | null,
  draft = false,
  authorIsBot = false,
): RepoOpenPr => ({
  number,
  title: `PR #${number}`,
  htmlUrl: `https://github.com/acme/board/pull/${number}`,
  createdAt,
  author,
  authorIsBot,
  draft,
});

/** One `listRepos()` answer with nothing lost — the shape the source returns
 *  (#718), for the cases that vary only which repos came back. */
const reposRead = (repos: RepoDescriptor[]): ReposRead => ({ repos, unreadableOrgs: [] });

/** One `driByRepo()` answer, as the source really shapes it (#718): the rows it
 *  read, and the orgs it could not read at all. */
const driRead = (rows: Record<string, string | null>, unreadableOrgs: readonly string[] = []): DriRead => ({
  byRepo: new Map(Object.entries(rows)),
  unreadableOrgs,
});

function make(opts: {
  descriptors?: RepoDescriptor[];
  /** Stands in for the repo listing itself — the read whose failure must fail
   *  the whole map. */
  listReposImpl?: () => Promise<ReposRead>;
  /** The orgs whose repo ENUMERATION failed (#718) — none of their repos are on
   *  the map at all, which is a different loss from `unreadableOrgs` below. */
  listUnreadableOrgs?: readonly string[];
  /** `full` -> dri login, as the org property read returns it. */
  dri?: Record<string, string | null>;
  /** The orgs whose ownership read FAILED (#718) — a repo of one of them is
   *  `ownerState: 'unreadable'`, which is not the same claim as `owner: null`. */
  unreadableOrgs?: readonly string[];
  driImpl?: () => Promise<DriRead>;
  /** `full` -> security posture, as the org-wide alert reads return it. */
  security?: Record<string, RepoSecurity>;
  securityImpl?: () => Promise<Map<string, RepoSecurity>>;
  /** The orgs whose ALERT lists failed (#718). Their repos are on the map and
   *  get zeros — the zeros have to say they were never read. */
  securityUnreadableOrgs?: readonly string[];
  /** `full` -> latest completed run conclusion. */
  ci?: Record<string, RepoCiRead>;
  ciImpl?: () => Promise<Map<string, RepoCiRead>>;
  driSchemaImpl?: (org: string) => Promise<DriSchema>;
  /** What the WRITE records — the login Github reports back, which need not be
   *  the one that was asked for. */
  setDriImpl?: (full: string, login: string | null) => Promise<string | null>;
  /** Every org the fake source's MAP covers (#718). A write pin outside the set
   *  is a fresh read, so a test that means "another org" says so by naming one. */
  servedOrgs?: readonly string[];
  issues?: RawIssue[];
  issuesAt?: number;
  issuesCache?: IssuesCacheService;
  /** How the ingest says each repo's OWN fetch went (#837). Defaults to every
   *  repo the map lists reading fine — which is what the real ingest reports on
   *  a good run, and the answer every test written before #837 assumed. */
  issueReads?: { full: string; ok: boolean }[];
  /** How the ingest says each org's ENUMERATION went (#837). Defaults to none,
   *  which is what a pinned scope reports and what every test written before
   *  #837 assumed — no org read to speak of, so no page may claim one failed. */
  issueOrgs?: { org: string; state: 'read' | 'unreadable'; reason: string | null; calls: number }[];
  /** 0 makes every read miss the rollup cache, so a test can watch what the
   *  refresh path re-fetches and what it reuses. */
  ttlMs?: number;
  /** Roster records the merged owner-name map is built over. */
  records?: IdentityRecord[];
  readmeImpl?: (full: string) => Promise<RepoReadme>;
  pullRequestsImpl?: (full: string, since: string) => Promise<RepoPrRead>;
  actionsUsageImpl?: (months: UsageMonth[]) => Promise<ActionsUsageRead | null>;
  /** Org-wide daily Actions usage the billing read answers with. */
  usage?: ActionsUsageDay[];
  /** Which orgs that billing read actually COVERS (#718). Defaults to every
   *  served org — the ordinary case. An org left out of it is one whose billing
   *  read failed, and its repos must draw an unreadable CI spend rather than a
   *  zeroed one. */
  usageOrgs?: readonly string[];
} = {}) {
  const servedOrgs = opts.servedOrgs ?? ['acme'];
  const listRepos = vi.fn<() => Promise<ReposRead>>(
    opts.listReposImpl ??
      (async () => ({
        repos: opts.descriptors ?? DESCRIPTORS,
        unreadableOrgs: opts.listUnreadableOrgs ?? [],
      })),
  );
  const driByRepo = vi.fn<() => Promise<DriRead>>(
    opts.driImpl ??
      (async () => ({
        byRepo: new Map(Object.entries(opts.dri ?? {})),
        unreadableOrgs: opts.unreadableOrgs ?? [],
      })),
  );
  // `securityImpl` answers with the ROWS alone, and the orgs come off their own
  // option — the two are independent facts and every existing case varies only
  // the rows.
  const rowsOf = opts.securityImpl ?? (async () => new Map(Object.entries(opts.security ?? {})));
  const securityByRepo = vi.fn<() => Promise<SecurityRead>>(async () => ({
    byRepo: await rowsOf(),
    unreadableOrgs: opts.securityUnreadableOrgs ?? [],
  }));
  // Typed with its real parameter so a test can assert WHICH descriptor list
  // the CI read was handed, by identity.
  const ciByRepo = vi.fn<(descriptors: RepoDescriptor[]) => Promise<Map<string, RepoCiRead>>>(
    opts.ciImpl ?? (async () => new Map(Object.entries(opts.ci ?? {}))),
  );
  const driSchema = vi.fn<(org: string) => Promise<DriSchema>>(
    opts.driSchemaImpl ?? (async () => ({ allowedValues: [], writability: 'writable' as const })),
  );
  // The repo page's three reads (#575). Defaults are the plainest success, so a
  // test that says nothing about them gets a page that draws.
  const readme = vi.fn<(full: string) => Promise<RepoReadme>>(
    opts.readmeImpl ?? (async () => ({ state: 'present', markdown: '# board' })),
  );
  const pullRequests = vi.fn<(full: string, since: string) => Promise<RepoPrRead>>(
    opts.pullRequestsImpl ??
      // One open PR, matching the `open: 1` beside it: a default whose total and
      // whose list disagreed would let the page publish either one.
      (async () => ({
        state: 'read',
        open: 1,
        closedMerged: 312,
        prs: [],
        coveredFrom: null,
        openPrs: [openPr(5, daysAgo(1), 'hubot')],
      })),
  );
  const actionsUsage = vi.fn<(months: UsageMonth[]) => Promise<ActionsUsageRead | null>>(
    opts.actionsUsageImpl ??
      (async () => ({ days: opts.usage ?? [], orgs: opts.usageOrgs ?? servedOrgs })),
  );
  // The write, which only `makeWritable` below re-points. Here so this fake can
  // be typed as the interface itself rather than cast to it.
  const setDri = vi.fn<(full: string, login: string | null) => Promise<string | null>>(
    opts.setDriImpl ?? (async (_full, login) => login),
  );
  // NOT `as unknown as IReposSource` (#718). Every consumer break this issue had
  // to fix was invisible to tsc precisely because the fakes were cast past the
  // contract: they returned bare Maps and bare arrays where the source returns
  // records, and the suite stayed green while the service would not compile. A
  // fake typed as the interface fails to build the moment the interface moves.
  const source: IReposSource = {
    servedOrgs,
    listRepos,
    driByRepo,
    securityByRepo,
    ciByRepo,
    driSchema,
    setDri,
    readme,
    pullRequests,
    actionsUsage,
  };
  const getIssues = vi.fn(async () => ({
    issues: opts.issues ?? [],
    at: opts.issuesAt ?? Date.parse('2026-08-05T00:00:00.000Z'),
    repos: opts.issueReads ?? (opts.descriptors ?? DESCRIPTORS).map((d) => ({ full: d.full, ok: true })),
    orgs: opts.issueOrgs ?? [],
  }));
  const issuesCache = { getIssues, resync: vi.fn(async () => {}) } as unknown as IssuesCacheService;
  // `FEEDBACK_REPO` has no default since #1175 and `ReposService` builds the
  // submission-visibility scope in its constructor, so a config naming none
  // refuses to construct.
  const config = new ConfigService({
    AUTH_DISABLED: true,
    FEEDBACK_REPO: 'acme/board',
    ...(opts.ttlMs == null ? {} : { REPOS_CACHE_TTL_MS: opts.ttlMs }),
  });
  const base = fakeIdentityStore(opts.records ?? []);
  const list = vi.fn(() => base.list());
  const githubLogins = new GithubLoginResolver({ ...base, list });
  return {
    service: new ReposService(source, config, opts.issuesCache ?? issuesCache, githubLogins),
    listRepos,
    driByRepo,
    securityByRepo,
    ciByRepo,
    driSchema,
    setDri,
    readme,
    pullRequests,
    actionsUsage,
    getIssues,
    issuesCache,
    list,
    githubLogins,
  };
}

describe('ReposService (#472)', () => {
  it('rolls the ingested issues up per repo, with no second Github fetch for the counts', async () => {
    const { service, getIssues } = make({
      issues: [rawIssue(), rawIssue({ number: 2 }), rawIssue({ number: 3, state: 'closed', closedAt: daysAgo(1) })],
    });
    const view = await service.listRepos();
    const board = view.repos.find((r) => r.key === 'board');
    expect(board?.open).toBe(2);
    expect(board?.weeks).toHaveLength(REPO_WEEKS);
    expect(board?.weeks[REPO_WEEKS - 1]).toEqual({ opened: 3, closed: 1 });
    // The whole rollup reads the shared ingest — one cached list, no per-repo call.
    expect(getIssues).toHaveBeenCalledTimes(1);
  });

  it('keeps a repo whose queue is empty on the map', async () => {
    const { service } = make({ issues: [rawIssue()] });
    const view = await service.listRepos();
    expect(view.repos.map((r) => r.key)).toContain('status');
    expect(view.repos.find((r) => r.key === 'status')?.open).toBe(0);
  });

  it("carries every repo's last push out to the view (#572)", async () => {
    const { service } = make();
    const view = await service.listRepos();
    // The two descriptors carry different pushes, so a view that stamped one
    // repo's push onto every row could not pass.
    expect(view.repos.find((r) => r.key === 'board')?.pushedAt).toBe(DESCRIPTORS[0].pushedAt);
    expect(view.repos.find((r) => r.key === 'status')?.pushedAt).toBe(DESCRIPTORS[1].pushedAt);
  });

  it('reports the ingest freshness, not the moment of the request', async () => {
    const { service } = make();
    const view = await service.listRepos();
    expect(view.updatedAt).toBe('2026-08-05T00:00:00.000Z');
  });

  it('a dri login the roster alone knows gets the person’s name (#541)', async () => {
    const { service } = make({
      dri: { 'acme/status': 'mlopez' },
      records: [
        identityRecordFor({
          emails: ['maria.lopez@example.com'],
          displayName: 'Maria Lopez',
          githubLogin: 'mlopez',
        }),
      ],
    });
    const view = await service.listRepos();
    expect(view.repos.find((r) => r.key === 'status')?.owner).toEqual({
      login: 'mlopez',
      name: 'Maria Lopez',
    });
  });

  // `names` is a plain union on purpose. Under the person-level rule `logins`
  // uses, clearing a handle would strip the name off a repo Github still says
  // that account owns — nothing in #540 asks us to forget a name.
  it('a cleared handle does not cost the Repos map a name it already had (#541)', async () => {
    const { service } = make({
      dri: { 'acme/board': 'octocat' },
      records: [
        identityRecordFor({
          emails: ['octocat@example.com'],
          displayName: 'Octocat',
          githubLogin: null,
        }),
      ],
    });
    const view = await service.listRepos();
    expect(view.repos.find((r) => r.key === 'board')?.owner).toEqual({
      login: 'octocat',
      name: 'Octocat',
    });
  });

  it('keeps an unmapped login without inventing a name for it', async () => {
    const { service } = make({ dri: { 'acme/status': 'unknown-user' } });
    const view = await service.listRepos();
    expect(view.repos.find((r) => r.key === 'status')?.owner).toEqual({ login: 'unknown-user', name: null });
  });

  it('says a repo has no owner rather than guessing one', async () => {
    const { service } = make();
    const view = await service.listRepos();
    expect(view.repos.every((r) => r.owner === null)).toBe(true);
  });

  it('re-reads ownership behind the reader, so a reassigned dri lands on the view after the boundary (#611)', async () => {
    const driImpl = vi
      .fn<() => Promise<DriRead>>()
      .mockResolvedValueOnce(driRead({ 'acme/status': 'octocat' }))
      .mockResolvedValue(driRead({ 'acme/status': 'hubot' }));
    const { service, driByRepo } = make({ ttlMs: 0, driImpl });
    const owner = async () =>
      (await service.listRepos()).repos.find((r) => r.key === 'status')?.owner?.login;

    expect(await owner()).toBe('octocat');
    // Expired by the clock — and answered off the held view all the same, with
    // the re-read running behind this visitor rather than under them (#611).
    expect(await owner()).toBe('octocat');
    // Gated on the re-read having LANDED, not merely started: the source is
    // invoked synchronously, so a call count is already true while the view
    // still holds the old owner.
    await vi.waitFor(async () => expect(await owner()).toBe('hubot'));
    expect(driByRepo.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('serves a second read from cache — the repo list is fetched once per TTL', async () => {
    const { service, listRepos } = make();
    await service.listRepos();
    await service.listRepos();
    expect(listRepos).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent cold reads — two visitors cost one org sweep', async () => {
    const { service, listRepos, driByRepo } = make();
    await Promise.all([service.listRepos(), service.listRepos(), service.listRepos()]);
    expect(listRepos).toHaveBeenCalledTimes(1);
    expect(driByRepo).toHaveBeenCalledTimes(1);
  });

  it('resync forces the whole map fresh (#301, sync now)', async () => {
    const { service, listRepos, issuesCache } = make();
    await service.listRepos();
    await service.resync();
    expect(issuesCache.resync).toHaveBeenCalledTimes(1);
    // Once for the first read, once for the warm resync re-read.
    expect(listRepos).toHaveBeenCalledTimes(2);
  });

  // The owner names come off a memo with its own TTL, so a resync that only
  // dropped the view would contradict this service's own contract — that a
  // sync lands an edit "on the next view rather than a TTL later" (#541).
  it('resync re-reads the roster, so owner names are not stale straight after a sync', async () => {
    const { service, list } = make();
    await service.listRepos();
    expect(list).toHaveBeenCalledTimes(1);
    await service.resync();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

/**
 * The owner NAME became admin-editable with #541, and this map caches two things
 * on top of it: the whole view on a ten-minute TTL, and each repo's resolved
 * owner on a 24-hour one. Neither knew about the roster, so a name an admin
 * corrected could sit wrong for a day — on the surface where #541's fix is
 * actually visible. `identity.controller.ts` promises in writing that an admin
 * "must not wait out a TTL", so these three pin that promise here.
 */
describe('ReposService — an edited owner name reaches the map (#541)', () => {
  /** The roster the store serves, mutated in place so an "admin edit" is real. */
  const rosterOf = (displayName: string): IdentityRecord[] => [
    identityRecordFor({
      emails: ['hubot@example.com'],
      displayName,
      githubLogin: 'hubot',
    }),
  ];

  const OWNED = { 'acme/status': 'hubot' };
  const ownerOfStatus = (v: { repos: { key: string; owner: unknown }[] }) =>
    v.repos.find((r) => r.key === 'status')?.owner;

  it('an admin edit reaches the owner name with no Sync now and no TTL wait', async () => {
    const records = rosterOf('Hubot');
    const { service, githubLogins } = make({ records, dri: OWNED });
    expect(ownerOfStatus(await service.listRepos())).toEqual({
      login: 'hubot',
      name: 'Hubot',
    });

    records[0] = { ...records[0], displayName: 'Ivan R' };
    githubLogins.invalidateRoster(); // exactly what IdentityController.upsert does

    expect(ownerOfStatus(await service.listRepos())).toEqual({
      login: 'hubot',
      name: 'Ivan R',
    });
  });

  // The 24-hour per-repo CODEOWNERS cache these two tests used to guard is gone
  // with the per-repo read (#548). Ownership is one org-wide call on the view's
  // own TTL, so a stale name can no longer hide behind an expensive cached read
  // — but a roster edit does now cost that one call, where it used to cost none.
  it('an admin edit costs at most one ownership read, not one per repo', async () => {
    const records = rosterOf('Hubot');
    const { service, githubLogins, driByRepo } = make({ records, dri: OWNED });
    await service.listRepos();
    const before = driByRepo.mock.calls.length;

    records[0] = { ...records[0], displayName: 'Ivan R' };
    githubLogins.invalidateRoster();
    await service.listRepos();

    expect(ownerOfStatus(await service.listRepos())).toEqual({ login: 'hubot', name: 'Ivan R' });
    expect(driByRepo.mock.calls.length).toBe(before + 1);
  });
});

describe('ReposService — ownership from the dri property (#548)', () => {
  it('names a repo owner from its dri value through the identity map', async () => {
    const { service } = make({
      dri: { 'acme/board': 'octocat' },
      records: [
        identityRecordFor({
          emails: ['octocat@example.com'],
          displayName: 'Octocat',
          githubLogin: 'octocat',
        }),
      ],
    });
    const view = await service.listRepos();
    expect(view.repos.find((r) => r.key === 'board')?.owner).toEqual({
      login: 'octocat',
      name: 'Octocat',
    });
  });

  it('costs one ownership read for the whole map, not one per repo', async () => {
    const { service, driByRepo } = make({ dri: { 'acme/board': 'octocat' } });
    await service.listRepos();
    expect(driByRepo).toHaveBeenCalledTimes(1);
  });

  it('says a repo carrying no dri has no owner rather than guessing one', async () => {
    const { service } = make({ dri: { 'acme/board': null } });
    const view = await service.listRepos();
    expect(view.repos.every((r) => r.owner === null)).toBe(true);
  });

  it('leaves the last good map standing when the ownership read fails behind the reader (#611)', async () => {
    const driImpl = vi
      .fn<() => Promise<DriRead>>()
      .mockResolvedValueOnce(driRead({ 'acme/board': 'octocat' }))
      .mockRejectedValue(new Error('Bad credentials'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, driByRepo } = make({ ttlMs: 0, driImpl });
    const board = (v: { repos: { key: string; owner: { login: string } | null }[] }) =>
      v.repos.find((r) => r.key === 'board')?.owner?.login;

    const first = await service.listRepos();
    expect(board(first)).toBe('octocat');

    // The refresh behind the reader fails. It may not reject a caller that has
    // already been answered, and it may not cost the map either: the last good
    // answer stands rather than the board emptying over one blip.
    expect(board(await service.listRepos())).toBe('octocat');
    await vi.waitFor(() => expect(driByRepo).toHaveBeenCalledTimes(2));
    const after = await service.listRepos();
    expect(after.repos).toHaveLength(DESCRIPTORS.length);
    expect(board(after)).toBe('octocat');
    // ...and it said so, rather than failing silently behind a page that draws.
    await vi.waitFor(() =>
      expect(
        warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes('background repos map refresh failed')),
      ).toBe(true),
    );
    warn.mockRestore();
  });
});

describe('ReposService — security & CI, read apart from the map (#558, split in #571)', () => {
  it('a security read that comes back empty still produces a full health payload', async () => {
    const { service } = make({ securityImpl: async () => new Map() });
    const health = await service.listHealth();
    expect(health.repos).toHaveLength(DESCRIPTORS.length);
    for (const r of health.repos) {
      // `state: 'read'` and not merely zeroes: the alert lists answered and
      // this repo has nothing open, which is a measurement (#718).
      expect(r.security).toEqual({
        depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read',
      });
    }
  });

  it('carries each repo’s own security posture and CI conclusion, not its neighbour’s', async () => {
    // Distinct values per repo on purpose, on BOTH facts: one shared record
    // would pass even if the payload stamped the first repo's alerts onto
    // every row.
    const { service } = make({
      security: {
        'acme/status': {
          depHigh: 2, depModerate: 1, codeScanning: 0, secrets: 1, state: 'read',
          secretsUrl: 'https://github.com/acme/status/security/secret-scanning/4',
        },
        'acme/board': {
          depHigh: 0, depModerate: 3, codeScanning: 4, secrets: 0, secretsUrl: null, state: 'read',
        },
      },
      ci: {
        'acme/status': { conclusion: 'failure', url: 'https://github.com/acme/status/actions/runs/77' },
        'acme/board': { conclusion: 'success', url: null },
      },
    });
    const health = await service.listHealth();
    const status = health.repos.find((r) => r.full === 'acme/status');
    const board = health.repos.find((r) => r.full === 'acme/board');
    expect(status?.security).toEqual({
      depHigh: 2, depModerate: 1, codeScanning: 0, secrets: 1, state: 'read',
      secretsUrl: 'https://github.com/acme/status/security/secret-scanning/4',
    });
    expect(status?.ci).toBe('failure');
    expect(board?.security).toEqual({
      depHigh: 0, depModerate: 3, codeScanning: 4, secrets: 0, secretsUrl: null, state: 'read',
    });
    expect(board?.ci).toBe('success');
    // The address travels with the conclusion it belongs to (#605): the row
    // that says "failure" carries that run's own URL, and the row beside it —
    // read without one — carries null rather than the neighbour's. Asserted on
    // both rows, because a payload that stamped one address onto every row
    // would satisfy the first line alone.
    expect(status?.ciUrl).toBe('https://github.com/acme/status/actions/runs/77');
    expect(board?.ciUrl).toBeNull();
  });

  it('gives every repo on the map a row, so "clean" is never mistaken for "not here yet"', async () => {
    // A repo with no alerts and no completed run is the whole point: absent from
    // the payload it would be indistinguishable from a repo the client has not
    // received, and the tile could not tell clean from unknown.
    const { service } = make({ securityImpl: async () => new Map(), ciImpl: async () => new Map() });
    const view = await service.listRepos();
    const health = await service.listHealth();
    expect(health.repos.map((r) => r.full).sort()).toEqual(view.repos.map((r) => r.full).sort());
    for (const r of health.repos) {
      expect(r.ci).toBeNull();
      expect(r.ciUrl).toBeNull();
      // `state: 'read'` and not merely zeroes: the alert lists answered and
      // this repo has nothing open, which is a measurement (#718).
      expect(r.security).toEqual({
        depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read',
      });
    }
  });

  it('never lets two repos share one security record', async () => {
    const { service } = make({ securityImpl: async () => new Map() });
    const health = await service.listHealth();
    expect(health.repos.length).toBeGreaterThan(1);
    expect(health.repos[0].security).not.toBe(health.repos[1].security);
  });

  it('serves a second health read from cache — one org sweep per TTL', async () => {
    const { service, securityByRepo, ciByRepo } = make();
    await service.listHealth();
    await service.listHealth();
    expect(securityByRepo).toHaveBeenCalledTimes(1);
    expect(ciByRepo).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent cold health reads', async () => {
    const { service, securityByRepo } = make();
    await Promise.all([service.listHealth(), service.listHealth(), service.listHealth()]);
    expect(securityByRepo).toHaveBeenCalledTimes(1);
  });

  it('asks CI about the descriptors the map was built from', async () => {
    // ciByRepo is per-repo and needs each repo's default branch, so it has to be
    // handed the SAME descriptor list the core view rolled up — not a second,
    // possibly divergent, repo listing.
    const { service, ciByRepo, listRepos } = make();
    await service.listRepos();
    await service.listHealth();
    // Identity, not deep equality: the point is that this is the very array the
    // map was rolled up from, which an equal-looking second listing would not be.
    expect(ciByRepo.mock.calls[0][0]).toBe(DESCRIPTORS);
    // And the descriptors came off the core read, not a repeat of it.
    expect(listRepos).toHaveBeenCalledTimes(1);
  });
});

describe('ReposService — the map does not wait on security or CI (#571)', () => {
  /** A promise that never settles — the honest stand-in for a read that is still
   *  out at Github when the visitor is already looking at the page. */
  const pending = <T>() => new Promise<T>(() => {});

  it('resolves the core view while the health reads are still out', async () => {
    const { service, securityByRepo, ciByRepo } = make({
      securityImpl: () => pending<Map<string, RepoSecurity>>(),
      ciImpl: () => pending<Map<string, RepoCiRead>>(),
    });

    const view = await service.listRepos();

    expect(view.repos).toHaveLength(DESCRIPTORS.length);
    // The split is only real if the core never even asked.
    expect(securityByRepo).not.toHaveBeenCalled();
    expect(ciByRepo).not.toHaveBeenCalled();
  });

  it('leaves security and CI off the row entirely, so no field is sometimes a measurement and sometimes an absence', async () => {
    const { service } = make({ security: { 'acme/status': { depHigh: 1, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' as const } } });
    const view = await service.listRepos();
    for (const row of view.repos) {
      expect(Object.keys(row)).not.toContain('security');
      expect(Object.keys(row)).not.toContain('ci');
    }
  });

  it('a health read that fails outright leaves the map standing', async () => {
    const { service, listRepos } = make({
      securityImpl: async () => {
        throw new Error('alerts unavailable');
      },
    });

    await service.listRepos();
    await expect(service.listHealth()).rejects.toThrow('alerts unavailable');

    // The core cache is untouched: the map still serves, and off the same read.
    const view = await service.listRepos();
    expect(view.repos).toHaveLength(DESCRIPTORS.length);
    expect(listRepos).toHaveBeenCalledTimes(1);
  });

  it('a failed health read is not cached as an answer', async () => {
    let fail = true;
    const { service } = make({
      securityImpl: async () => {
        if (fail) throw new Error('alerts unavailable');
        return new Map([['acme/status', { depHigh: 1, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' as const }]]);
      },
    });

    await expect(service.listHealth()).rejects.toThrow('alerts unavailable');
    fail = false;

    const health = await service.listHealth();
    expect(health.repos.find((r) => r.full === 'acme/status')?.security.depHigh).toBe(1);
  });

  it('a core read that fails still fails — losing the repo list makes the map wrong, not plainer', async () => {
    const { service, listRepos } = make({
      listReposImpl: async () => {
        throw new Error('repo list unavailable');
      },
    });
    await expect(service.listRepos()).rejects.toThrow('repo list unavailable');
    expect(listRepos).toHaveBeenCalledTimes(1);
  });

  it('constructing the service reads nothing — the warm belongs to Nest, not to new', () => {
    const { listRepos, securityByRepo, ciByRepo, getIssues } = make();
    expect(listRepos).not.toHaveBeenCalled();
    expect(securityByRepo).not.toHaveBeenCalled();
    expect(ciByRepo).not.toHaveBeenCalled();
    expect(getIssues).not.toHaveBeenCalled();
  });

  it('warms the core and then the health at boot, so the first visitor pays for neither', async () => {
    const { service, listRepos, securityByRepo } = make();

    service.onModuleInit();
    // Un-awaited by contract, so let the microtask chain drain.
    await vi.waitFor(() => {
      expect(listRepos).toHaveBeenCalledTimes(1);
      expect(securityByRepo).toHaveBeenCalledTimes(1);
    });
  });

  it('a Github outage at boot cannot stop board-api starting', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const { service, listRepos } = make({
      listReposImpl: async () => {
        throw new Error('boot outage');
      },
    });

    expect(() => service.onModuleInit()).not.toThrow();
    await vi.waitFor(() => expect(listRepos).toHaveBeenCalledTimes(1));
    // An unhandled rejection would take the process down at boot; the warm has
    // to swallow it into a warning instead.
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

/**
 * A read whose settling this test controls, so a refresh can be held open
 * across a sync or a write — the window every defect in here lives in.
 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ReposService — what a sync does to a read that is already out (#571)', () => {
  it('does not serve a health read that went out before Sync now', async () => {
    const first = deferred<Map<string, RepoSecurity>>();
    let call = 0;
    const { service, securityByRepo } = make({
      securityImpl: () => {
        call += 1;
        return call === 1
          ? first.promise
          : Promise.resolve(
              new Map([['acme/status', { depHigh: 9, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' as const }]]),
            );
      },
    });

    // A health read is out — the boot warm, or a visitor 3 s ago. Waiting for
    // the alert read to have actually STARTED is what makes this the in-flight
    // one rather than a race with whatever resync kicks off.
    const inFlight = service.listHealth();
    await vi.waitFor(() => expect(securityByRepo).toHaveBeenCalledTimes(1));
    await service.resync();
    // A visitor arriving the moment the sync returns must not be handed the
    // read that went out before it.
    const afterSync = service.listHealth();
    // ...and only now does the pre-sync read come back, with pre-sync alerts.
    first.resolve(new Map([['acme/status', { depHigh: 1, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' as const }]]));
    await inFlight;

    expect((await afterSync).repos.find((r) => r.full === 'acme/status')?.security.depHigh).toBe(9);
    expect(securityByRepo).toHaveBeenCalledTimes(2);
  });

  it('does not hand a caller a health read that is being built for an older map', async () => {
    // The same hole as the page path's, in code that predates it (#571): the
    // in-flight slot was shared on existence alone, so a map rebuilt through
    // the roster generation — which does NOT go through dropCaches — could be
    // answered with a payload built against the map before it.
    const first = deferred<Map<string, RepoSecurity>>();
    let call = 0;
    const { service, securityByRepo, githubLogins } = make({
      securityImpl: () =>
        ++call === 1
          ? first.promise
          : Promise.resolve(
              new Map([['acme/status', { depHigh: 9, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' as const }]]),
            ),
    });

    const inFlight = service.listHealth();
    await vi.waitFor(() => expect(securityByRepo).toHaveBeenCalledTimes(1));
    githubLogins.invalidateRoster();
    const afterEdit = service.listHealth();
    // Still pending on purpose — see the page twin below.
    await vi.waitFor(() => expect(securityByRepo).toHaveBeenCalledTimes(2));
    first.resolve(new Map([['acme/status', { depHigh: 1, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' as const }]]));
    await inFlight;

    expect((await afterEdit).repos.find((r) => r.full === 'acme/status')?.security.depHigh).toBe(9);
  });

  it('does not let that read cache itself over the answer that replaced it', async () => {
    // The half nulling the in-flight slot cannot fix: the disowned read holds
    // no reference to the slot, so it lands later and overwrites the cache.
    const first = deferred<Map<string, RepoSecurity>>();
    let call = 0;
    const { service, securityByRepo } = make({
      securityImpl: () => {
        call += 1;
        return call === 1
          ? first.promise
          : Promise.resolve(
              new Map([['acme/status', { depHigh: 9, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' as const }]]),
            );
      },
    });

    const inFlight = service.listHealth();
    await vi.waitFor(() => expect(securityByRepo).toHaveBeenCalledTimes(1));
    await service.resync();
    await service.listHealth(); // the post-sync answer is now cached
    first.resolve(new Map([['acme/status', { depHigh: 1, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' as const }]]));
    await inFlight;

    const after = await service.listHealth();
    expect(after.repos.find((r) => r.full === 'acme/status')?.security.depHigh).toBe(9);
    // And it did not cost the fresh answer either: a clobbered cache would have
    // sent this last read back to Github for a third ~18 s sweep.
    expect(securityByRepo).toHaveBeenCalledTimes(2);
  });

  it('does not let a map read that went out before a dri write cache pre-write ownership', async () => {
    // The twin on the view side, and the hole setDri's docstring used to admit
    // to. One mechanism closes both.
    const first = deferred<DriRead>();
    let call = 0;
    const { service, driByRepo } = make({
      ttlMs: 600_000,
      setDriImpl: async () => 'hubot',
      driImpl: () => {
        call += 1;
        return call === 1 ? first.promise : Promise.resolve(driRead({ 'acme/status': 'hubot' }));
      },
    });

    const inFlight = service.listRepos();
    await vi.waitFor(() => expect(driByRepo).toHaveBeenCalledTimes(1));
    await service.setDri('acme/status', 'hubot');
    first.resolve(driRead({ 'acme/status': 'octocat' }));
    await inFlight;

    const view = await service.listRepos();
    expect(view.repos.find((r) => r.key === 'status')?.owner?.login).toBe('hubot');
  });
});

describe('ReposService — the health payload always describes the map being served (#571)', () => {
  it('is rebuilt when the map is rebuilt, even while its own TTL still holds', async () => {
    // The drift two independent TTLs cannot prevent: the map expires first,
    // picks up a new repo, and the still-fresh health payload has no row for it
    // — which the client would read as "not received yet" forever.
    const second = [
      ...DESCRIPTORS,
      {
        full: 'acme/acme-ui',
        name: 'acme-ui',
        key: 'acme-ui',
        htmlUrl: 'https://github.com/acme/acme-ui',
        description: null,
        language: 'TypeScript',
        pushedAt: daysAgo(3),
        createdAt: null,
        defaultBranch: 'main',
      },
    ];
    let call = 0;
    const { service, githubLogins } = make({
      ttlMs: 600_000,
      listReposImpl: async () => reposRead(++call === 1 ? DESCRIPTORS : second),
    });

    await service.listHealth();
    // Any rebuild will do; a roster edit is the one that needs no clock.
    githubLogins.invalidateRoster();
    const view = await service.listRepos();
    expect(view.repos).toHaveLength(second.length);

    const health = await service.listHealth();
    expect(health.repos.map((r) => r.full).sort()).toEqual(view.repos.map((r) => r.full).sort());
  });

  it('is served across a rebuild that changed no repo, and refreshed behind the reader (#611)', async () => {
    // The twin of the test above, and the other half of one rule: what binds
    // this payload to the map is SET COVERAGE. Above, the rebuild gained a repo
    // and the reader waits. Here it gained nothing — so there is nothing the
    // client could draw differently, and making a visitor pay the ~18 s read for
    // it was the whole of #611.
    let call = 0;
    const { service, securityByRepo, githubLogins } = make({
      ttlMs: 600_000,
      securityImpl: async () =>
        new Map([
          ['acme/status', { depHigh: ++call === 1 ? 1 : 9, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' as const }],
        ]),
    });
    const status = (h: { repos: { full: string; security: RepoSecurity }[] }) =>
      h.repos.find((r) => r.full === 'acme/status')?.security.depHigh;
    const first = await service.listHealth();

    // Any rebuild will do; a roster edit is the one that needs no clock.
    githubLogins.invalidateRoster();
    expect((await service.listRepos()).repos).toHaveLength(DESCRIPTORS.length);

    // The very same payload, not a rebuilt equal one — nobody waited.
    expect(await service.listHealth()).toBe(first);
    expect(status(first)).toBe(1);
    // ...and it is being replaced behind that reader rather than left to sit:
    // once the refresh lands, reads are on the new alerts.
    await vi.waitFor(async () => expect(status(await service.listHealth())).toBe(9));
    // One refresh behind that reader, not one per read that came after it.
    expect(securityByRepo).toHaveBeenCalledTimes(2);
  });

  it('costs one alert sweep however many readers arrive on the same covered payload', async () => {
    // The test above cannot prove this and its comment used to claim it: by the
    // time it looks, the refresh behind the reader has already landed, so the
    // covered path is never re-entered and the dedupe is never exercised. Here
    // the sweep is held open, so all three readers are genuinely on it at once.
    const second = deferred<Map<string, RepoSecurity>>();
    let call = 0;
    const { service, securityByRepo, githubLogins } = make({
      ttlMs: 600_000,
      securityImpl: () => (++call === 1 ? Promise.resolve(new Map()) : second.promise),
    });
    const first = await service.listHealth();

    // A rebuild that gained no repo: the held payload still covers it.
    githubLogins.invalidateRoster();
    expect((await service.listRepos()).repos).toHaveLength(DESCRIPTORS.length);

    const all = await Promise.all([service.listHealth(), service.listHealth(), service.listHealth()]);

    // Every one of them answered off the very payload already held...
    for (const held of all) expect(held).toBe(first);
    // ...and the ~18 s sweep behind them ran once, not once each.
    expect(securityByRepo).toHaveBeenCalledTimes(2);
    second.resolve(new Map());
  });
});


/**
 * At a cache boundary, one visitor used to pay for the refresh (#611): the
 * first reader past the TTL waited ~1.2 s for a map, and ~18 s for the health
 * words, that this service was already holding an answer for. Both are now
 * served stale-while-revalidate — and the cases that must NOT be are the point
 * of half of these.
 */
describe('ReposService — nobody waits for a refresh of an answer already held (#611)', () => {
  it('resolves on the held map while the refresh behind it is still out at Github', async () => {
    const second = deferred<ReposRead>();
    let call = 0;
    const { service, listRepos } = make({
      ttlMs: 0,
      listReposImpl: () => (++call === 1 ? Promise.resolve(reposRead(DESCRIPTORS)) : second.promise),
    });
    await service.listRepos();

    // Nothing settles this read but the cache: the second listing is still out
    // when it resolves, and a reader that had to wait for it would hang here.
    const view = await service.listRepos();

    expect(view.repos).toHaveLength(DESCRIPTORS.length);
    expect(listRepos).toHaveBeenCalledTimes(2);
    second.resolve(reposRead(DESCRIPTORS));
  });

  it('costs one org sweep however many visitors arrive on the same stale view', async () => {
    const second = deferred<ReposRead>();
    let call = 0;
    const { service, listRepos } = make({
      ttlMs: 0,
      listReposImpl: () => (++call === 1 ? Promise.resolve(reposRead(DESCRIPTORS)) : second.promise),
    });
    await service.listRepos();

    await Promise.all([service.listRepos(), service.listRepos(), service.listRepos()]);

    // One refresh behind the three of them, not one each.
    expect(listRepos).toHaveBeenCalledTimes(2);
    second.resolve(reposRead(DESCRIPTORS));
  });

  it('waits for the rebuild when an admin corrected a name, where the clock alone would have served the held map', async () => {
    // The case that does not get this shape. A generation mismatch is not a
    // clock expiry: it is an admin fixing a person's name, and
    // `identity.controller.ts` promises in writing that the correction does not
    // wait out a TTL — so this reader waits for the map instead.
    const records = [
      identityRecordFor({
        emails: ['hubot@example.com'],
        displayName: 'Hubot',
        githubLogin: 'hubot',
      }),
    ];
    const { service, githubLogins } = make({
      ttlMs: 0,
      records,
      dri: { 'acme/status': 'hubot' },
    });
    const name = async () =>
      (await service.listRepos()).repos.find((r) => r.key === 'status')?.owner?.name;
    expect(await name()).toBe('Hubot');

    records[0] = { ...records[0], displayName: 'Ivan R' };
    githubLogins.invalidateRoster();

    expect(await name()).toBe('Ivan R');
  });

  it('serves nothing held after Sync now — the payload from before the click is dropped, not merely unbound', async () => {
    // Coverage would happily have served the pre-sync health payload: the sync
    // rebuilds the map from the same repo set. Dropping it is what keeps the
    // button meaning what it says.
    let call = 0;
    const { service } = make({
      ttlMs: 600_000,
      securityImpl: async () =>
        new Map([
          ['acme/status', { depHigh: ++call === 1 ? 1 : 9, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' as const }],
        ]),
    });
    const depHigh = async () =>
      (await service.listHealth()).repos.find((r) => r.full === 'acme/status')?.security.depHigh;
    expect(await depHigh()).toBe(1);

    await service.resync();

    expect(await depHigh()).toBe(9);
  });

  it('serves nothing held after a dri write either, map or health', async () => {
    let alerts = 0;
    let owners = 0;
    const { service } = make({
      // Stale by the clock as well, so neither cache has freshness to hide
      // behind: what stops a pre-write answer here is that the write dropped it.
      ttlMs: 0,
      setDriImpl: async () => 'hubot',
      driImpl: async () => driRead({ 'acme/status': ++owners === 1 ? 'octocat' : 'hubot' }),
      securityImpl: async () =>
        new Map([
          ['acme/status', { depHigh: ++alerts === 1 ? 1 : 9, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' as const }],
        ]),
    });
    await service.listHealth();

    await service.setDri('acme/status', 'hubot');

    expect((await service.listRepos()).repos.find((r) => r.key === 'status')?.owner?.login).toBe(
      'hubot',
    );
    expect(
      (await service.listHealth()).repos.find((r) => r.full === 'acme/status')?.security.depHigh,
    ).toBe(9);
  });

  it('says the same about a health payload it keeps serving while the reads behind it fail', async () => {
    // Coverage is a binding, not a clock, so a payload can go on covering the
    // map for as long as the alert reads keep failing — with the CI conclusion
    // on every tile quietly describing last week.
    const started = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    let failing = false;
    const { service, githubLogins } = make({
      ttlMs: 1_000,
      securityImpl: async () => {
        if (failing) throw new Error('alerts unavailable');
        return new Map<string, RepoSecurity>();
      },
    });
    const drifted = () =>
      warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('past 3 refresh intervals'));
    await service.listHealth();

    failing = true;
    clock.mockReturnValue(started + 4_000);
    githubLogins.invalidateRoster();
    await service.listRepos();
    await service.listHealth();

    expect(drifted()).toHaveLength(1);
    expect(drifted()[0]).toContain('health');
    expect(drifted()[0]).toContain('4s old');

    clock.mockRestore();
    warn.mockRestore();
  });

  it('says once when what it serves has drifted past three refresh intervals, and again after it recovers and drifts a second time', async () => {
    // Stale-while-revalidate serves an old answer for as long as the refreshes
    // behind it keep failing, and a `dri` edit that never appears looks exactly
    // like nothing having happened. The bound is announced, not enforced.
    const started = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(started);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    let failing = false;
    const { service, githubLogins } = make({
      ttlMs: 1_000,
      listReposImpl: async () => {
        if (failing) throw new Error('Bad credentials');
        return reposRead(DESCRIPTORS);
      },
    });
    const drifted = () =>
      warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('past 3 refresh intervals'));

    await service.listRepos();
    failing = true;
    clock.mockReturnValue(started + 4_000);
    await service.listRepos();
    expect(drifted()).toHaveLength(1);
    expect(drifted()[0]).toContain('map');
    expect(drifted()[0]).toContain('4s old');

    // A state change, not a line per request.
    await service.listRepos();
    expect(drifted()).toHaveLength(1);

    // It recovers — a roster edit rebuilds the map on the waiting path, so the
    // view is current again at this same clock reading...
    failing = false;
    await new Promise((r) => setTimeout(r, 10));
    githubLogins.invalidateRoster();
    await service.listRepos();
    await service.listRepos();
    expect(drifted()).toHaveLength(1);

    // ...and a second drift is announced rather than swallowed by the latch.
    clock.mockReturnValue(started + 8_000);
    await service.listRepos();
    expect(drifted()).toHaveLength(2);

    clock.mockRestore();
    warn.mockRestore();
  });
});


describe('ReposService — a write drops what it invalidated (#571)', () => {
  it('rebuilds the map after a dri write, rather than leaving the tile on the old owner', async () => {
    let call = 0;
    const { service, driByRepo } = make({
      ttlMs: 600_000,
      setDriImpl: async () => 'hubot',
      driImpl: async () => driRead({ 'acme/status': ++call === 1 ? 'octocat' : 'hubot' }),
    });

    expect((await service.listRepos()).repos.find((r) => r.key === 'status')?.owner?.login).toBe(
      'octocat',
    );
    await service.setDri('acme/status', 'hubot');

    // Nothing has expired — only the write happened — so a map still serving
    // the cached view would hand back the owner the write replaced.
    expect((await service.listRepos()).repos.find((r) => r.key === 'status')?.owner?.login).toBe(
      'hubot',
    );
    expect(driByRepo).toHaveBeenCalledTimes(2);
  });
});

describe('ReposService — the boot warm (#571)', () => {
  it('warms the health even when the map warm lost a transient blip', async () => {
    // Chained on success, one dropped socket at boot would cost the first
    // visitor the whole ~18 s read this split exists to remove.
    let call = 0;
    const { service, listRepos, securityByRepo } = make({
      listReposImpl: async () => {
        if (++call === 1) throw new Error('transient blip');
        return reposRead(DESCRIPTORS);
      },
    });

    service.onModuleInit();

    await vi.waitFor(() => {
      expect(listRepos).toHaveBeenCalledTimes(2);
      expect(securityByRepo).toHaveBeenCalledTimes(1);
    });
  });

  it('names the read that failed, not the one that succeeded', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service } = make({
      securityImpl: async () => {
        throw new Error('alerts unavailable');
      },
    });

    service.onModuleInit();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn.mock.calls[0][0]).toContain('health');
    expect(warn.mock.calls[0][0]).not.toContain('map');
    warn.mockRestore();
  });

  it('says in the log what warmed and how long it took', async () => {
    // Otherwise "the cache was warm at boot" is only ever inferred from a
    // stopwatch, or from forcing it to fail.
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const { service } = make();

    service.onModuleInit();

    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(2));
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => /map warm ready in \d+ ms/.test(l))).toBe(true);
    expect(lines.some((l) => /health warm ready in \d+ ms/.test(l))).toBe(true);
    log.mockRestore();
  });
});

describe('ReposService lifecycle under Nest — the hook fires on a factory-provided instance (#571)', () => {
  // ReposService is provided through a `useFactory` in repos.module.ts, not by
  // Nest constructing the class. A boot warm hung on `onModuleInit` would be
  // worth nothing if Nest skipped the hook on factory-built instances, so this
  // builds the provider the same way the module does and watches the warm run.
  it('warms the map at boot when Nest builds the service through a factory', async () => {
    const { service, listRepos, securityByRepo } = make();
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: ReposService, inject: [], useFactory: () => service }],
    }).compile();

    expect(listRepos).not.toHaveBeenCalled();

    await moduleRef.init();

    await vi.waitFor(() => {
      expect(listRepos).toHaveBeenCalledTimes(1);
      expect(securityByRepo).toHaveBeenCalledTimes(1);
    });
    await moduleRef.close();
  });
});

describe('ReposService — what the map says about writing an owner (#577)', () => {
  it('carries the property’s allowed values and its writability onto the view', async () => {
    const { service, driSchema } = make({
      driSchemaImpl: async () => ({ allowedValues: ['octocat', 'hubot'], writability: 'writable' }),
    });

    const view = await service.listRepos();

    expect(view.driOptions).toEqual(['octocat', 'hubot']);
    expect(view.ownerWritability).toBe('writable');
    // Both facts come out of ONE schema read, not two.
    expect(driSchema).toHaveBeenCalledTimes(1);
  });

  it('says restricted when the org restricts the property', async () => {
    const { service } = make({
      driSchemaImpl: async () => ({ allowedValues: ['octocat'], writability: 'restricted' }),
    });

    const view = await service.listRepos();

    // The values are still known — the map can still SAY who owns what — but
    // nothing on the page should offer a change it knows Github will refuse.
    expect(view.driOptions).toEqual(['octocat']);
    expect(view.ownerWritability).toBe('restricted');
  });

  it('says unreadable — not restricted, not absent — when the schema read failed', async () => {
    const { service } = make({
      driSchemaImpl: async () => ({ allowedValues: [], writability: 'unreadable' }),
    });

    const view = await service.listRepos();

    // The distinction has to reach the client: it answers all of them
    // differently, and this is the one that says nothing about the org.
    expect(view.ownerWritability).toBe('unreadable');
  });

  it('carries every state through to the view unchanged, absent included', async () => {
    // What the SERVICE owes the client: every state reaches the view intact and
    // distinguishable from every other. A service that collapsed any pair here
    // would undo the split before anything downstream could act on it (#649),
    // and no amount of care in the client could get it back.
    //
    // What each state DRAWS does not follow from this list and is not asserted
    // by it: two states that arrive distinguishable here may still draw the
    // same control, because the client decides on `driOptions` as well as on
    // this field. That belongs to the frontend and to `repos-vm.spec.ts`, which
    // tests it against a picker this file cannot see.
    for (const writability of ['writable', 'restricted', 'absent', 'unreadable', 'unknown'] as const) {
      const { service } = make({ driSchemaImpl: async () => ({ allowedValues: [], writability }) });
      expect((await service.listRepos()).ownerWritability).toBe(writability);
    }
  });
});

describe('ReposService.setDri — what the tile settles on (#577)', () => {
  function makeWritable(recorded: string | null) {
    return make({
      setDriImpl: async () => recorded,
      records: [
        identityRecordFor({
          emails: ['hubot@example.com'],
          displayName: 'Hubot',
          githubLogin: 'hubot',
        }),
      ],
    });
  }

  it('names the owner Github recorded, not the one that was requested', async () => {
    const { service } = makeWritable('hubot');

    // Whatever was asked for, the map draws what Github came back with.
    expect(await service.setDri('acme/status', 'octocat')).toEqual({
      login: 'hubot',
      name: 'Hubot',
    });
  });

  it('reports nobody when Github records nobody', async () => {
    const { service } = makeWritable(null);
    expect(await service.setDri('acme/status', 'hubot')).toBeNull();
  });
});

describe('ReposService.ownerWriteEnv — a state we admit we do not know is not cached (#577 round 2)', () => {
  it('serves a SETTLED answer off the cached view without asking Github again', async () => {
    // Both of these came off a schema Github answered, so both are facts about
    // the org and neither changes until the org's settings do.
    for (const writability of ['writable', 'restricted'] as const) {
      const { service, driSchema } = make({
        driSchemaImpl: async () => ({ allowedValues: ['octocat'], writability }),
      });

      expect(await service.ownerWriteEnv('acme')).toEqual({ allowed: ['octocat'], writability });
      expect(await service.ownerWriteEnv('acme')).toEqual({ allowed: ['octocat'], writability });

      // One read for the map; the second press costs nothing.
      expect(driSchema, `${writability} was re-read`).toHaveBeenCalledTimes(1);
    }
  });

  it('re-reads the schema on every press while the cached answer is UNSETTLED', async () => {
    // Otherwise one dropped socket freezes a non-answer into the view for the
    // whole REPOS_CACHE_TTL_MS, and every press for ten minutes gets a 502
    // that the tile invites you to retry — without anything ever asking
    // Github again. That is this issue's own defect, with our cache as cause.
    //
    // Both unsettled states behave this way, and they are the only two: neither
    // came off a schema Github answered, so re-reading is the only road out.
    for (const writability of ['unreadable', 'unknown'] as const) {
      const { service, driSchema } = make({ driSchemaImpl: async () => ({ allowedValues: [], writability }) });

      await service.ownerWriteEnv('acme');
      await service.ownerWriteEnv('acme');

      // Once for the map, then once per press.
      expect(driSchema, `${writability} was cached`).toHaveBeenCalledTimes(3);
    }
  });

  it('does NOT re-read while the cached answer is absent — absent is settled', async () => {
    // The counterpart, and the reason `absent` is its own state at all (#649).
    // An org with no `dri` property answered `unknown` before, which never
    // converges: every press paid for another schema read whose answer could
    // not change, and arrived at the same refusal. `absent` came off a list
    // Github ANSWERED, so it is a fact, so it caches.
    const { service, driSchema } = make({ driSchemaImpl: async () => ({ allowedValues: [], writability: 'absent' }) });

    await service.ownerWriteEnv('acme');
    await service.ownerWriteEnv('acme');

    // The one read that built the map, and nothing more.
    expect(driSchema).toHaveBeenCalledTimes(1);
  });

  it('a retry after an unreadable picks up the answer as soon as Github gives one', async () => {
    let answer: DriSchema = { allowedValues: [], writability: 'unreadable' };
    const { service } = make({ driSchemaImpl: async () => answer });

    expect((await service.ownerWriteEnv('acme')).writability).toBe('unreadable');

    answer = { allowedValues: ['octocat'], writability: 'writable' };

    expect(await service.ownerWriteEnv('acme')).toEqual({ allowed: ['octocat'], writability: 'writable' });
  });

  it('a retry after an unreadable settles on absent, and then converges', async () => {
    // The recovery that only exists since #649: the read arrives, and what it
    // says is "no such property". That is an answer, so it drops the caches —
    // which costs ONE map rebuild on the next press, and nothing at all after
    // that. Converging is the whole difference from `unknown`, where every
    // press for the cache's whole life paid for a read that could not change.
    let answer: DriSchema = { allowedValues: [], writability: 'unreadable' };
    const { service, driSchema } = make({ driSchemaImpl: async () => answer });

    await service.ownerWriteEnv('acme');
    answer = { allowedValues: [], writability: 'absent' };
    expect((await service.ownerWriteEnv('acme')).writability).toBe('absent');
    const afterRecovery = driSchema.mock.calls.length;

    await service.ownerWriteEnv('acme');
    await service.ownerWriteEnv('acme');

    // One rebuild between them, not one read per press: an `absent` still
    // treated as unsettled would add two more here, and go on adding.
    expect(driSchema).toHaveBeenCalledTimes(afterRecovery + 1);
    expect((await service.listRepos()).ownerWritability).toBe('absent');
  });

  it('lets the recovered answer reach the map too, not just the write', async () => {
    let answer: DriSchema = { allowedValues: [], writability: 'unreadable' };
    const { service } = make({ driSchemaImpl: async () => answer });

    await service.ownerWriteEnv('acme');
    answer = { allowedValues: ['octocat'], writability: 'writable' };
    await service.ownerWriteEnv('acme');

    // A view still holding a non-answer would keep offering an empty picker on
    // a property the board can now read perfectly well.
    const view = await service.listRepos();
    expect(view.ownerWritability).toBe('writable');
    expect(view.driOptions).toEqual(['octocat']);
  });
});

describe('ReposService.ownerWriteEnv — the schema is read for the org the write is aimed at (#649)', () => {
  it('builds the map against the org the map serves', async () => {
    const { service, driSchema } = make({ servedOrgs: ['acme'] });

    await service.listRepos();

    expect(driSchema).toHaveBeenCalledWith('acme');
  });

  it('reads another org fresh, rather than answering it off this org\'s view', async () => {
    // `driOptions` and `ownerWritability` on the view describe ONE org — the one
    // the map enumerates. Serving them for a second org would judge a write to
    // it against the first org's allowed values and the first org's
    // `values_editable_by`: a read about the wrong org deciding a write to this
    // one.
    const perOrg: Record<string, DriSchema> = {
      'acme': { allowedValues: ['octocat'], writability: 'writable' },
      globex: { allowedValues: ['hubot'], writability: 'restricted' },
    };
    const { service } = make({ servedOrgs: ['acme'], driSchemaImpl: async (org) => perOrg[org] });

    expect(await service.ownerWriteEnv('globex')).toEqual({
      allowed: ['hubot'],
      writability: 'restricted',
    });
    // And the served org still answers for itself, so the two are told apart
    // rather than one of them simply winning.
    expect(await service.ownerWriteEnv('acme')).toEqual({
      allowed: ['octocat'],
      writability: 'writable',
    });
  });

  it('re-reads the other org on every press, settled answer or not', async () => {
    // The view has nowhere to put a second org's answer, so there is nothing to
    // serve it from. One call, on one press — the map stays single-org this leg,
    // so the fresh path is the SECOND org only.
    const { service, driSchema } = make({
      servedOrgs: ['acme'],
      driSchemaImpl: async () => ({ allowedValues: ['octocat'], writability: 'writable' }),
    });

    await service.ownerWriteEnv('globex');
    await service.ownerWriteEnv('globex');

    expect(driSchema.mock.calls.filter(([org]) => org === 'globex')).toHaveLength(2);
  });

  it('does not re-read the served org over a difference of case', async () => {
    // The org reaches here as the caller spelled it. Comparing it exactly would
    // make `Acme` a "different org" and pay for a schema read the view
    // already holds — on every press, forever.
    const { service, driSchema } = make({
      servedOrgs: ['acme'],
      driSchemaImpl: async () => ({ allowedValues: ['octocat'], writability: 'writable' }),
    });

    await service.ownerWriteEnv('Acme');

    // The ARGUMENT, not the count: an exact comparison takes the fresh path and
    // still reads the schema exactly once, so a count alone cannot see it. What
    // separates them is WHICH org was asked about — the map's read, and nothing
    // for `Acme`.
    expect(driSchema.mock.calls.map(([asked]) => asked)).toEqual(['acme']);
  });
});

describe('ReposService — one repo\'s page (#575)', () => {
  const usageDay = (full: string, daysAgoN: number, minutes: number, netUsd: number): ActionsUsageDay => ({
    full,
    date: daysAgo(daysAgoN),
    minutes,
    netUsd,
  });

  it('answers everything the page draws off ONE map read', async () => {
    const { service, listRepos, getIssues } = make({
      // Distinct creation moments: two issues sharing one `createdAt` make the
      // "newest first" assertion below a coin toss on sort stability, which is
      // how it read [1, 2] one day and [2, 1] the next.
      issues: [
        rawIssue({ number: 1, createdAt: daysAgo(3) }),
        rawIssue({ number: 2, state: 'closed', createdAt: daysAgo(2), closedAt: daysAgo(1) }),
      ],
      dri: { 'acme/board': 'octocat' },
      usage: [usageDay('acme/board', 1, 1383, 7.48)],
    });
    const page = await service.repoPage('acme', 'board');

    expect(page.repo.full).toBe('acme/board');
    expect(page.repo.language).toBe('TypeScript');
    expect(page.repo.owner?.login).toBe('octocat');
    expect(page.repo.weeks).toHaveLength(REPO_WEEKS);
    expect(page.repo.open).toBe(1);
    expect(page.readme).toEqual({ state: 'present', markdown: '# board' });
    expect(page.pullRequests).toMatchObject({ state: 'read', open: 1, closedMerged: 312 });
    expect(page.ciSpend).toMatchObject({ state: 'read' });
    // Issue 2 is the newer of the two and is closed, so the block is issue 1
    // alone (#826) — the block says what is left to do, not what happened last.
    expect(page.openIssues.map((i) => i.number)).toEqual([1]);
    expect(page.updatedAt).toBe('2026-08-05T00:00:00.000Z');
    // The map itself is read once and the issue ingest once — the page adds no
    // repo listing and no issue fetch of its own.
    expect(listRepos).toHaveBeenCalledTimes(1);
    expect(getIssues).toHaveBeenCalledTimes(1);
  });

  it('publishes the open list under both names, as ONE array (#826 compatibility)', async () => {
    const { service } = make({
      issues: [rawIssue({ number: 1, createdAt: daysAgo(3) }), rawIssue({ number: 2, createdAt: daysAgo(2) })],
    });
    const page = await service.repoPage('acme', 'board');

    // `recentIssues` is the name the field had before #826, kept while board-web
    // bundles built against it are still being served — a bundle reading it off
    // a payload that stopped sending it throws in the render and blanks the page.
    expect(Object.keys(page)).toEqual(expect.arrayContaining(['openIssues', 'recentIssues']));
    expect(page.openIssues.map((i) => i.number)).toEqual([2, 1]);
    // The SAME array, not an equal one. `toEqual` would stay green for a second
    // `openIssuesFor` call assigned to the compatibility name, and two
    // derivations of one list are two things that can drift apart later.
    expect(page.recentIssues).toBe(page.openIssues);
  });

  it('names who works on the repo off the reads it already has (#828)', async () => {
    const { service, getIssues, listRepos } = make({
      issues: [
        rawIssue({ number: 1, author: 'hubot', assignees: ['octocat'], createdAt: daysAgo(3) }),
        rawIssue({ number: 2, author: 'octocat', assignees: [], createdAt: daysAgo(2) }),
        // Another org's repo of the same short key: its people are not this
        // repo's people (#647).
        rawIssue({ number: 3, owner: 'globex', author: 'outsider', assignees: ['outsider'] }),
      ],
      dri: { 'acme/board': 'octocat' },
      pullRequestsImpl: async () => ({
        state: 'read',
        open: 1,
        closedMerged: 0,
        coveredFrom: null,
        prs: [{ number: 7, createdAt: daysAgo(1), mergedAt: null, closedAt: null, author: 'hubot', authorIsBot: false }],
        openPrs: [openPr(7, daysAgo(1), 'hubot')],
      }),
      records: [
        identityRecordFor({
          emails: ['octocat@example.com'],
          displayName: 'Octocat',
          githubLogin: 'octocat',
        }),
      ],
    });
    const page = await service.repoPage('acme', 'board');

    expect(page.members.prsUnreadable).toBe(false);
    expect(page.members.people).toEqual([
      // The DRI first, whatever the counts.
      { login: 'octocat', name: 'Octocat', assigned: 1, openedIssues: 1, openedPrs: 0, dri: true },
      // Named through the same merged roster the map's owner names come from —
      // this one off the checked-in table rather than an identity record.
      { login: 'hubot', name: 'Hubot', assigned: 0, openedIssues: 1, openedPrs: 1, dri: false },
    ]);
    // Off the ingest and this page's own PR read — no second issue fetch and no
    // repo listing of its own.
    expect(getIssues).toHaveBeenCalledTimes(1);
    expect(listRepos).toHaveBeenCalledTimes(1);
  });

  it('says the members list is missing its PR half rather than serving it short (#828)', async () => {
    const { service } = make({
      issues: [rawIssue({ number: 1, author: 'octocat', createdAt: daysAgo(2) })],
      pullRequestsImpl: async () => ({ state: 'unreadable' }),
    });
    const page = await service.repoPage('acme', 'board');
    // Somebody active only in pull requests is missing from this list entirely,
    // and every `openedPrs` reads 0. Both look exactly like a repo nobody sends
    // PRs to unless the payload says otherwise.
    expect(page.members.prsUnreadable).toBe(true);
    expect(page.members.people.map((p) => p.login)).toEqual(['octocat']);
    expect(page.pullRequests).toEqual({ state: 'unreadable' });
  });

  it('publishes the open pull requests on the PR read, where the trend card is (#828)', async () => {
    const { service } = make({
      pullRequestsImpl: async () => ({
        state: 'read',
        open: 312,
        closedMerged: 0,
        coveredFrom: null,
        prs: [],
        openPrs: [openPr(9, daysAgo(1), 'octocat', true), openPr(8, daysAgo(200), null)],
      }),
    });
    const page = await service.repoPage('acme', 'board');
    if (page.pullRequests.state !== 'read') throw new Error('expected a read');
    expect(page.pullRequests.openPrs.map((p) => p.number)).toEqual([9, 8]);
    expect(page.pullRequests.openPrs[0].draft).toBe(true);
    // The list is a page of the total, not the total: 2 rows against 312 open.
    expect(page.pullRequests.open).toBe(312);
  });

  it('lists a bot’s open PR on the page and counts it for nobody (#828)', async () => {
    const { service } = make({
      issues: [rawIssue({ number: 1, author: 'monalisa', createdAt: daysAgo(2) })],
      pullRequestsImpl: async () => ({
        state: 'read',
        open: 2,
        closedMerged: 0,
        coveredFrom: null,
        prs: [
          { number: 9, createdAt: daysAgo(1), mergedAt: null, closedAt: null, author: 'dependabot', authorIsBot: true },
          { number: 8, createdAt: daysAgo(2), mergedAt: null, closedAt: null, author: 'monalisa', authorIsBot: false },
        ],
        openPrs: [openPr(9, daysAgo(1), 'dependabot', false, true), openPr(8, daysAgo(2), 'monalisa')],
      }),
    });
    const page = await service.repoPage('acme', 'board');
    if (page.pullRequests.state !== 'read') throw new Error('expected a read');
    // On the tab, marked: it is an open pull request somebody has to close.
    expect(page.pullRequests.openPrs.map((p) => [p.author, p.authorIsBot])).toEqual([
      ['dependabot', true],
      ['monalisa', false],
    ]);
    // Not on the members list at all. Live, this is the difference between
    // dependabot ranking second on board's own page and not being there.
    expect(page.members.people.map((p) => [p.login, p.openedPrs])).toEqual([['monalisa', 1]]);
  });

  it('draws the PR flow and the CI spend on the SAME windows as the issue weeks', async () => {
    const { service } = make({
      pullRequestsImpl: async () => ({
        state: 'read',
        open: 0,
        closedMerged: 1,
        coveredFrom: null,
        prs: [{ number: 7, createdAt: daysAgo(2), mergedAt: daysAgo(1), closedAt: daysAgo(1), author: 'octocat', authorIsBot: false }],
        openPrs: [],
      }),
      usage: [usageDay('acme/board', 2, 190, 1.14)],
    });
    const page = await service.repoPage('acme', 'board');
    if (page.pullRequests.state !== 'read' || page.ciSpend.state !== 'read') throw new Error('expected reads');
    expect(page.pullRequests.weeks).toHaveLength(page.repo.weeks.length);
    expect(page.ciSpend.weeks).toHaveLength(page.repo.weeks.length);
    // Same alignment, not just the same count: this week's PR and this week's
    // spend land in the last slot, beside this week's issues.
    expect(page.pullRequests.weeks[REPO_WEEKS - 1]).toEqual({ opened: 1, merged: 1 });
    expect(page.ciSpend.weeks[REPO_WEEKS - 1]).toEqual({ minutes: 190, netUsd: 1.14 });
  });

  it('reads the org-wide billing report ONCE, however many repo pages are served', async () => {
    const { service, actionsUsage } = make({ usage: [] });
    await service.repoPage('acme', 'board');
    await service.repoPage('acme', 'status');
    // One repo's page must never trigger a billing read of its own — the report
    // covers the whole org, so the second page is served from the first's answer.
    expect(actionsUsage).toHaveBeenCalledTimes(1);
    expect(actionsUsage.mock.calls[0][0].length).toBeGreaterThanOrEqual(5);
  });

  it('sends each Overview figure one period back, off the reads it already made (#962)', async () => {
    const { service, pullRequests, actionsUsage, getIssues } = make();
    const page = await service.repoPage('acme', 'board');
    // One open PR and no records since the window opened: it was open then too.
    expect(page.previous).toEqual({
      openIssues: { state: 'read', value: 0 },
      openPrs: { state: 'read', value: 1 },
      ciNetUsd: { state: 'read', value: 0 },
    });
    // No read of its own for any of the three.
    expect(pullRequests).toHaveBeenCalledTimes(1);
    expect(actionsUsage).toHaveBeenCalledTimes(1);
    expect(getIssues).toHaveBeenCalledTimes(1);
    // The billing read covers twenty weeks; the chart is still the page's ten.
    expect(page.ciSpend.state === 'read' && page.ciSpend.weeks.length).toBe(REPO_WEEKS);
  });

  it('adds nothing to the map\'s own path (#571)', async () => {
    const { service, readme, pullRequests, actionsUsage } = make();
    await service.listRepos();
    await service.listHealth();
    expect(readme).not.toHaveBeenCalled();
    expect(pullRequests).not.toHaveBeenCalled();
    expect(actionsUsage).not.toHaveBeenCalled();
  });

  it('404s a repo that is not on the map', async () => {
    const { service } = make();
    await expect(service.repoPage('acme', 'not-a-repo')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('degrades each of the three reads on its own', async () => {
    const { service } = make({
      readmeImpl: async () => {
        throw new Error('Github said no');
      },
      pullRequestsImpl: async () => ({ state: 'unreadable' }),
      usage: [usageDay('acme/board', 1, 100, 0.6)],
    });
    const page = await service.repoPage('acme', 'board');
    // A README read that THREW still costs the README alone: the page draws,
    // and the two reads beside it are untouched.
    expect(page.readme).toEqual({ state: 'unreadable' });
    expect(page.pullRequests).toEqual({ state: 'unreadable' });
    expect(page.ciSpend).toMatchObject({ state: 'read' });
    expect(page.repo.full).toBe('acme/board');
  });

  it('says the CI spend is unreadable rather than reporting a repo as free', async () => {
    const { service } = make({ actionsUsageImpl: async () => null });
    const page = await service.repoPage('acme', 'board');
    expect(page.ciSpend).toEqual({ state: 'unreadable' });
  });

  it('keeps a week of real minutes billed at $0 apart from a week that ran nothing (#582)', async () => {
    const { service } = make({
      descriptors: [{ ...DESCRIPTORS[0], full: 'acme/acme-docs', name: 'acme-docs', key: 'acme-docs' }],
      usage: [usageDay('acme/acme-docs', 2, 293, 0)],
    });
    const page = await service.repoPage('acme', 'acme-docs');
    if (page.ciSpend.state !== 'read') throw new Error('expected a read');
    expect(page.ciSpend.weeks[REPO_WEEKS - 1]).toEqual({ minutes: 293, netUsd: 0 });
    expect(page.ciSpend.weeks[REPO_WEEKS - 2]).toEqual({ minutes: 0, netUsd: 0 });
  });

  it('serves a second view of the same page off the cache, and rebuilds it after a sync', async () => {
    const { service, readme, actionsUsage, issuesCache } = make();
    await service.repoPage('acme', 'board');
    await service.repoPage('acme', 'board');
    expect(readme).toHaveBeenCalledTimes(1);

    await service.resync();
    await service.repoPage('acme', 'board');
    // The page is bound to the map build it was made from, so a sync rebuilds
    // it rather than serving pre-sync facts under a fresh map.
    expect(readme).toHaveBeenCalledTimes(2);
    expect(actionsUsage).toHaveBeenCalledTimes(2);
    expect(issuesCache.resync).toHaveBeenCalled();
  });

  it('does not cache a billing read that failed', async () => {
    let answer: ActionsUsageRead | null = null;
    const { service, actionsUsage } = make({ actionsUsageImpl: async () => answer });
    expect((await service.repoPage('acme', 'board')).ciSpend).toEqual({ state: 'unreadable' });
    answer = { days: [], orgs: ['acme'] };
    // THE SAME repo, deliberately. Asking for a different one proves nothing:
    // the page cache is keyed per repo, so a second repo never consults the
    // entry this test is about and the assertion cannot fail.
    expect((await service.repoPage('acme', 'board')).ciSpend).toMatchObject({ state: 'read' });
    expect(actionsUsage).toHaveBeenCalledTimes(2);
  });

  it('does not cache a page whose section could not be read', async () => {
    let fail = true;
    const { service, readme } = make({
      readmeImpl: async () => {
        if (fail) throw new Error('Github said no');
        return { state: 'present', markdown: '# board' };
      },
    });
    expect((await service.repoPage('acme', 'board')).readme).toEqual({ state: 'unreadable' });
    fail = false;
    // `unreadable` MEANS "ask again". Caching it makes the retry impossible for
    // the life of the map build — a reload would never reach the source, and
    // the README would be off the page for the whole TTL over one blip.
    expect((await service.repoPage('acme', 'board')).readme).toEqual({
      state: 'present',
      markdown: '# board',
    });
    expect(readme).toHaveBeenCalledTimes(2);
  });

  // #837. The issue block had two answers where the three cards beside it have
  // three. `GithubIssuesSource.fetchRepo` swallows a per-repo failure as
  // `{ ok: false, issues: [] }` so one repo cannot blank an org, which left the
  // repo whose fetch failed contributing no rows — and `repo.open`, rolled up
  // from the same ingest, agreeing at zero. The page then said "No open issues."
  // about a queue it never read.
  it('carries failed and genuinely quiet issue reads separately on grid rows', async () => {
    const { service } = make({
      issues: [],
      issueReads: [
        { full: 'Acme/board', ok: false },
        { full: 'acme/status', ok: true },
      ],
    });
    const view = await service.listRepos();
    expect(view.repos.map((row) => row.openIssuesState)).toEqual(['unreadable', 'read']);
    for (const row of view.repos) {
      expect(row.weeks).toEqual(Array.from({ length: REPO_WEEKS }, () => ({ opened: 0, closed: 0 })));
      const page = await service.repoPage('acme', row.name);
      expect(page.openIssuesState).toBe(row.openIssuesState);
    }
  });

  it('carries failed issue enumeration onto grid rows, including narrowed views', async () => {
    const { service } = make({
      issueReads: [],
      issueOrgs: [{ org: 'Acme', state: 'unreadable', reason: '404', calls: 1 }],
    });
    const view = await service.listRepos('acme');
    expect(view.repos).toHaveLength(2);
    expect(view.repos.every((row) => row.openIssuesState === 'unreadable')).toBe(true);
  });

  it('says the issue read FAILED rather than drawing an empty queue as a fact', async () => {
    const { service } = make({
      issues: [rawIssue({ number: 1 })],
      issueReads: [{ full: 'acme/board', ok: false }],
    });
    const page = await service.repoPage('acme', 'board');
    expect(page.openIssuesState).toBe('unreadable');
  });

  it('does not cache a page whose issue read failed', async () => {
    // The options object is what the ingest double reads on every build, so
    // flipping this field between the two calls IS the ingest recovering.
    const opts = { issueReads: [{ full: 'acme/board', ok: false }] };
    const { service, readme } = make(opts);
    expect((await service.repoPage('acme', 'board')).openIssuesState).toBe('unreadable');

    // THE SAME repo, deliberately: the page cache is keyed per repo, so asking
    // for a second one never consults the entry this test is about.
    await service.repoPage('acme', 'board');
    expect(readme, 'the page was rebuilt rather than served from cache').toHaveBeenCalledTimes(2);

    // What the rebuild does NOT do is re-fetch this repo's issues: the ingest is
    // a cache of its own on its own TTL, and the page reads whatever it holds.
    // So the state moves when the INGEST recovers, which is the map's rebuild —
    // and what not caching buys is that no reader is served a stale `unreadable`
    // under a map that has already moved past it.
    opts.issueReads = [{ full: 'acme/board', ok: true }];
    await service.resync();
    expect((await service.repoPage('acme', 'board')).openIssuesState).toBe('read');
  });

  it('caches a page whose issue read succeeded, so a quiet repo pays one set of reads', async () => {
    const { service, readme } = make({ issues: [] });
    await service.repoPage('acme', 'board');
    await service.repoPage('acme', 'board');
    // A genuinely empty queue is a fact about the repo, and there is nothing to
    // retry — the same argument as the ABSENT README below.
    expect(readme).toHaveBeenCalledTimes(1);
  });

  it('reads as `read` for a repo the ingest never asked about', async () => {
    // Absent from the outcomes is NOT a failure: a repo on the map whose owner
    // the ingest never asked about is never fetched and never reported, and a
    // page that drew "could not be read" over it would invent an outage.
    const { service } = make({ issueReads: [{ full: 'acme/status', ok: true }] });
    expect((await service.repoPage('acme', 'board')).openIssuesState).toBe('read');
  });

  it('reads as `read` when the ingest reports no per-repo outcomes at all', async () => {
    // What the fixture source does, and what any source that cannot say does.
    // An invented failure would put "could not be read" over every page on the
    // board, which is the same defect this issue fixes, pointing the other way.
    const { service } = make({ issueReads: [] });
    expect((await service.repoPage('acme', 'board')).openIssuesState).toBe('read');
  });

  // #837, one level up. An org whose ENUMERATION failed contributes no repos to
  // the ingest, so none of them can appear in `repoOutcomes()` at all — and
  // absent there means "the ingest never asked", which every page reads as
  // `read`. The repo LISTING is a separate read from a separate source, so those
  // repos are still on the map and still openable: a whole org's worth of pages
  // saying "No open issues." about queues nobody read.
  it('says the read failed for a repo whose ORG never enumerated', async () => {
    const { service } = make({
      // Empty on purpose: this is what the ingest reports for an org it could
      // not list — no repo of that org was ever asked about.
      issueReads: [],
      issueOrgs: [{ org: 'acme', state: 'unreadable', reason: '404', calls: 1 }],
    });
    const page = await service.repoPage('acme', 'board');
    expect(page.openIssuesState).toBe('unreadable');
  });

  it('leaves the orgs that DID enumerate reading exactly as they do today', async () => {
    // One org failing must not qualify another org's pages: `resolveScope`
    // records per org for precisely this reason.
    const { service } = make({
      issueOrgs: [
        { org: 'globex', state: 'unreadable', reason: '404', calls: 1 },
        { org: 'acme', state: 'read', reason: null, calls: 1 },
      ],
    });
    expect((await service.repoPage('acme', 'board')).openIssuesState).toBe('read');
  });

  it('matches an unreadable org however the config cased it', async () => {
    // `OrgReadOutcome.org` is the CONFIG's spelling and `RepoRow.full` the
    // deployment's, and Github folds org case — an exact-case compare would read
    // a lost org as one that read fine, which is the control off, silently.
    const { service } = make({
      issueOrgs: [{ org: 'Acme', state: 'unreadable', reason: '404', calls: 1 }],
    });
    expect((await service.repoPage('acme', 'board')).openIssuesState).toBe('unreadable');
  });

  it('matches the ingest’s repo name however Github cased it', async () => {
    // Github echoes a repo's own casing and `RepoRow.full` carries the
    // deployment's spelling; an exact-case test would read a failed repo as one
    // that read fine, which is the control off, silently.
    const { service } = make({
      issueReads: [{ full: 'Acme/board', ok: false }],
    });
    expect((await service.repoPage('acme', 'board')).openIssuesState).toBe('unreadable');
  });

  it('caches a page whose README is ABSENT, which is a fact rather than a failure', async () => {
    const { service, readme } = make({ readmeImpl: async () => ({ state: 'absent' }) });
    await service.repoPage('acme', 'board');
    await service.repoPage('acme', 'board');
    // Nothing failed, so there is nothing to retry — a repo with no README must
    // not pay three Github reads on every view.
    expect(readme).toHaveBeenCalledTimes(1);
  });

  it('does not serve a page read that went out before Sync now', async () => {
    // The twin of the health test above, for the page path (#575).
    const first = deferred<RepoReadme>();
    let call = 0;
    const { service, readme } = make({
      readmeImpl: () =>
        ++call === 1 ? first.promise : Promise.resolve({ state: 'present', markdown: '# after' } as RepoReadme),
    });

    const inFlight = service.repoPage('acme', 'board');
    await vi.waitFor(() => expect(readme).toHaveBeenCalledTimes(1));
    await service.resync();
    const afterSync = service.repoPage('acme', 'board');
    first.resolve({ state: 'present', markdown: '# before' });
    await inFlight;

    expect((await afterSync).readme).toEqual({ state: 'present', markdown: '# after' });
    expect(readme).toHaveBeenCalledTimes(2);
    // ...and the disowned read did not cache itself over the answer that
    // replaced it either.
    expect((await service.repoPage('acme', 'board')).readme).toEqual({
      state: 'present',
      markdown: '# after',
    });
    expect(readme).toHaveBeenCalledTimes(2);
  });

  it('does not hand a caller a page read that is being built for an older map', async () => {
    const first = deferred<RepoReadme>();
    let call = 0;
    const { service, readme, githubLogins } = make({
      readmeImpl: () =>
        ++call === 1 ? first.promise : Promise.resolve({ state: 'present', markdown: '# after' } as RepoReadme),
    });

    const inFlight = service.repoPage('acme', 'board');
    await vi.waitFor(() => expect(readme).toHaveBeenCalledTimes(1));
    // A roster edit rebuilds the map WITHOUT dropCaches, so the in-flight slot
    // survives the rebuild. Sharing it now would answer a question about the
    // current map with a page built against the previous one — a pre-edit owner
    // beside a map already drawing the new one.
    githubLogins.invalidateRoster();
    const afterEdit = service.repoPage('acme', 'board');
    // The first read is STILL PENDING here, on purpose: waiting for a second
    // read to start is what proves the in-flight one was not handed over.
    // Resolving `first` before this point lets the slot empty itself, and the
    // assertion below then passes whether or not the build is checked.
    await vi.waitFor(() => expect(readme).toHaveBeenCalledTimes(2));
    first.resolve({ state: 'present', markdown: '# before' });
    await inFlight;

    expect((await afterEdit).readme).toEqual({ state: 'present', markdown: '# after' });
    expect(readme).toHaveBeenCalledTimes(2);
  });

  it('keeps no page entry for a repo that has left the map', async () => {
    const { service } = make();
    await service.repoPage('acme', 'board');
    await service.resync();
    // The build binding already makes a stale page unservable; this is the
    // other half — the map is keyed per repo and grows, so a repo that leaves
    // the org must not keep its page here for the life of the process.
    expect((service as unknown as { pages: Map<string, unknown> }).pages.size).toBe(0);
  });

  it('re-reads the billing report when the cached one does not cover the window (#582)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'));
    // A TTL long enough that age can never be what forces the re-read: the only
    // thing left to force it is the month coverage.
    const { service, actionsUsage, githubLogins } = make({ ttlMs: 10 * 365 * 86_400_000 });
    await service.repoPage('acme', 'board');
    // Twenty weeks back from 2026-08-14 is 2026-03-27: the page's window and
    // the one its CI card compares with (#962), six months where ten weeks
    // alone was three.
    expect(actionsUsage.mock.calls[0][0]).toEqual([
      { year: 2026, month: 3 },
      { year: 2026, month: 4 },
      { year: 2026, month: 5 },
      { year: 2026, month: 6 },
      { year: 2026, month: 7 },
      { year: 2026, month: 8 },
    ]);

    // A roster edit rebuilds the map through the generation guard, NOT through
    // dropCaches — so the usage cache outlives the build it was read for, and
    // age alone would hand the new build a month set chosen for the old one.
    githubLogins.invalidateRoster();
    vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'));
    const page = await service.repoPage('acme', 'board');

    expect(actionsUsage).toHaveBeenCalledTimes(2);
    expect(actionsUsage.mock.calls[1][0]).toContainEqual({ year: 2026, month: 9 });
    // And the windows it drew are not a month of silence.
    expect(page.ciSpend.state).toBe('read');
    vi.useRealTimers();
  });

  it('finds a repo whose name the URL cased differently', async () => {
    const { service } = make();
    const page = await service.repoPage('Acme', 'board');
    expect(page.repo.full).toBe('acme/board');
  });
});

/**
 * The map spans every configured org (#718).
 *
 * Every case here is built on a source serving TWO orgs, because that is the
 * deployment the whole issue is about and a one-org fixture cannot fail any of
 * them. The single-org shape is not left untested by that — the whole file
 * above is single-org — and the last case here pins that it did not move.
 */
describe('ReposService — two orgs on one map (#718)', () => {
  const ORGS = ['acme', 'globex'];
  const GLOBEX: RepoDescriptor = {
    full: 'globex/keitaro',
    name: 'keitaro',
    key: 'keitaro',
    htmlUrl: 'https://github.com/globex/keitaro',
    description: null,
    language: 'PHP',
    pushedAt: daysAgo(3),
    createdAt: null,
    defaultBranch: 'main',
  };
  const BOTH = [DESCRIPTORS[0], GLOBEX];
  const twoOrg = (over: Parameters<typeof make>[0] = {}) =>
    make({ servedOrgs: ORGS, descriptors: BOTH, ...over });
  const usageDay = (full: string, daysAgoN: number, minutes: number, netUsd: number): ActionsUsageDay => ({
    full,
    date: daysAgo(daysAgoN),
    minutes,
    netUsd,
  });

  it('carries both orgs’ repos, each saying which org it is in', async () => {
    const { service } = twoOrg();
    const view = await service.listRepos();
    // `full` is `owner/name` and is the only place a row records its org, so
    // this is both halves of the claim: both orgs present, and told apart.
    expect(view.repos.map((r) => r.full)).toEqual(['acme/board', 'globex/keitaro']);
  });

  it('narrows the map to the org that was asked for', async () => {
    const { service } = twoOrg();
    expect((await service.listRepos('globex')).repos.map((r) => r.full)).toEqual(['globex/keitaro']);
    // Both directions, so a filter that always kept the first org would fail.
    expect((await service.listRepos('acme')).repos.map((r) => r.full)).toEqual([
      'acme/board',
    ]);
  });

  it('narrows the health payload on the same key the client joins on', async () => {
    const { service } = twoOrg({
      security: {
        'globex/keitaro': { depHigh: 3, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' as const },
      },
    });
    const health = await service.listHealth('globex');
    expect(health.repos.map((r) => r.full)).toEqual(['globex/keitaro']);
    // The counts are per-repo secret-scanning and dependabot numbers, so a row
    // narrowed away must not be answered as a clean one.
    expect(health.repos[0].security.depHigh).toBe(3);
    expect((await service.listHealth()).repos.map((r) => r.full)).toEqual([
      'acme/board',
      'globex/keitaro',
    ]);
  });

  it('says an owner could not be READ apart from an org that records none', async () => {
    // The distinction the row exists to carry. Both repos draw no owner name;
    // only one of them is a fact about the repo.
    const { service } = twoOrg({ dri: {}, unreadableOrgs: ['globex'] });
    const rows = (await service.listRepos()).repos;
    const globex = rows.find((r) => r.full === 'globex/keitaro');
    const acme = rows.find((r) => r.full === 'acme/board');

    expect(globex).toMatchObject({ owner: null, ownerState: 'unreadable' });
    expect(acme).toMatchObject({ owner: null, ownerState: 'read' });
  });

  it('a repo in a read org keeps its owner and says the read happened', async () => {
    const { service } = twoOrg({
      dri: { 'globex/keitaro': 'octocat' },
      unreadableOrgs: ['acme'],
    });
    const rows = (await service.listRepos()).repos;
    expect(rows.find((r) => r.full === 'globex/keitaro')).toMatchObject({
      // The name comes off the roster, which is another read's business — the
      // login is what the ownership read carried.
      owner: { login: 'octocat' },
      ownerState: 'read',
    });
    // And the OTHER org is the unreadable one this time, so a fixed answer
    // cannot pass both this case and the one above it.
    expect(rows.find((r) => r.full === 'acme/board')?.ownerState).toBe('unreadable');
  });

  it('draws an unreadable CI spend for an org the billing read did not cover', async () => {
    // THE discriminating case for #718's billing half. `ciSpendWindows` matches
    // rows on `full` and pre-fills every window, so an org missing from the
    // report renders as $0.00 across ten weeks — a quiet month that never
    // happened — unless the org's absence is passed through as `null`.
    const { service } = twoOrg({
      usage: [usageDay('acme/board', 1, 100, 0.6)],
      usageOrgs: ['acme'],
    });

    expect((await service.repoPage('globex', 'keitaro')).ciSpend).toEqual({ state: 'unreadable' });
    // The org that DID answer is untouched: one org's billing failure costs
    // that org's signal alone.
    const covered = await service.repoPage('acme', 'board');
    if (covered.ciSpend.state !== 'read') throw new Error('expected a read');
    expect(covered.ciSpend.weeks[REPO_WEEKS - 1]).toEqual({ minutes: 100, netUsd: 0.6 });
  });

  it('caches a partial billing read, and the TTL is what re-asks for the org that failed', async () => {
    // This asserted the opposite until the #718 review — "does not cache a
    // billing read that covered only some of the orgs" — on the reasoning that
    // `unreadable` means "ask again". What that cost was measured and is worse:
    // the billing report needs org-owner scope, so a second org denying it is a
    // steady state, and every repo page re-issued the whole fan-out. 70 repos
    // over 2 orgs and a 3-month window is 420 billing requests per TTL where it
    // had been 6.
    //
    // So the partial read is kept — it is a real answer for the orgs it covered
    // — and the TTL is the bound on how long the failing org says "could not
    // read", the same bound every other cached answer here carries.
    let answer: ActionsUsageRead = { days: [], orgs: ['acme'] };
    const held = twoOrg({ actionsUsageImpl: async () => answer });
    expect((await held.service.repoPage('globex', 'keitaro')).ciSpend).toEqual({ state: 'unreadable' });

    // Github recovers, and the held answer is served anyway: one read, not one
    // per page.
    answer = { days: [], orgs: ORGS };
    expect((await held.service.repoPage('globex', 'keitaro')).ciSpend).toEqual({ state: 'unreadable' });
    expect(held.actionsUsage).toHaveBeenCalledTimes(1);

    // Past the TTL it asks again, and the org that recovered draws. Without
    // this the fix would be a cache with no way out of `unreadable`.
    answer = { days: [], orgs: ['acme'] };
    const expiring = twoOrg({ ttlMs: 0, actionsUsageImpl: async () => answer });
    expect((await expiring.service.repoPage('globex', 'keitaro')).ciSpend).toEqual({ state: 'unreadable' });
    answer = { days: [], orgs: ORGS };
    expect((await expiring.service.repoPage('globex', 'keitaro')).ciSpend).toMatchObject({ state: 'read' });
  });

  it('reads the dri schema once per served org, not once for the first of them', async () => {
    const { service, driSchema } = twoOrg();
    await service.listRepos();
    expect(driSchema.mock.calls.map(([org]) => org)).toEqual(ORGS);
  });

  it('offers the union of every org’s allowed values, EXACT duplicates dropped', async () => {
    const perOrg: Record<string, DriSchema> = {
      'acme': { allowedValues: ['octocat', 'hubot'], writability: 'writable' },
      globex: { allowedValues: ['OCTOCAT', 'mlopez', 'hubot'], writability: 'writable' },
    };
    const { service } = twoOrg({ driSchemaImpl: async (org) => perOrg[org] });
    const view = await service.listRepos();
    // This asserted a case-INSENSITIVE dedupe until the #718 review. Folding
    // `OCTOCAT` away because `octocat` came first left the union carrying
    // only a spelling globex's write gate refuses — that gate compares
    // `a === login` against one org's list — so the picker offered a login that
    // 400s on the press. Two spellings of one person is cosmetic; a spelling
    // nothing accepts is a broken control. `hubot` is spelled identically
    // by both orgs and still appears once, so this is a dedupe and not a
    // concatenation.
    expect(view.driOptions).toEqual(['octocat', 'hubot', 'OCTOCAT', 'mlopez']);
  });

  it('the union view is not writable when one org bars the write', async () => {
    const perOrg: Record<string, DriSchema> = {
      'acme': { allowedValues: ['octocat'], writability: 'writable' },
      globex: { allowedValues: [], writability: 'restricted' },
    };
    const { service } = twoOrg({ driSchemaImpl: async (org) => perOrg[org] });

    // Fail-closed, and NAMED rather than summarised: the client already knows
    // how to draw `restricted`, and a union that said `writable` would offer a
    // control that is barred for half the map.
    expect((await service.listRepos()).ownerWritability).toBe('restricted');
    // Narrowed, each org answers for itself — which is what makes the fold
    // above safe to be pessimistic.
    expect((await service.listRepos('acme')).ownerWritability).toBe('writable');
    expect((await service.listRepos('acme')).driOptions).toEqual(['octocat']);
    expect((await service.listRepos('globex')).ownerWritability).toBe('restricted');
  });

  it('gates a write on the org it is aimed at, not on the union’s fold', async () => {
    // Otherwise a second org restricting the property refuses every write to
    // the first — a 403 on a press Github would have taken.
    const perOrg: Record<string, DriSchema> = {
      'acme': { allowedValues: ['octocat'], writability: 'writable' },
      globex: { allowedValues: [], writability: 'restricted' },
    };
    const { service } = twoOrg({ driSchemaImpl: async (org) => perOrg[org] });

    expect(await service.ownerWriteEnv('acme')).toEqual({
      allowed: ['octocat'],
      writability: 'writable',
    });
    expect(await service.ownerWriteEnv('globex')).toEqual({ allowed: [], writability: 'restricted' });
  });

  it('serves a second served org off the map rather than re-reading its schema', async () => {
    // `globex` was the fresh-every-press path while the map was one org wide,
    // because the view had nowhere to put a second org's answer. It is on the
    // map now, and a settled answer costs nothing.
    const { service, driSchema } = twoOrg();
    await service.ownerWriteEnv('globex');
    await service.ownerWriteEnv('globex');
    // One per org for the map build, and nothing for either press.
    expect(driSchema).toHaveBeenCalledTimes(2);
  });

  it('names an org whose repo listing failed rather than serving it as empty', async () => {
    // The union view is the only place this can be said: an org that lost its
    // listing contributes no rows, and so does an org with no repos.
    const { service } = twoOrg({
      descriptors: [DESCRIPTORS[0]],
      listUnreadableOrgs: ['globex'],
    });

    const view = await service.listRepos();

    expect(view.repos.map((r) => r.full)).toEqual(['acme/board']);
    expect(view.unreadableOrgs).toEqual(['globex']);
  });

  it('refuses a narrowed read for an org whose listing failed, rather than answering it empty', async () => {
    // `200 {"repos":[]}` is indistinguishable from an org that genuinely has no
    // repos, and the whole of the `?org=` narrowing is that the reader asked
    // about ONE org. There is nothing to serve for it, so say so.
    const { service } = twoOrg({
      descriptors: [DESCRIPTORS[0]],
      listUnreadableOrgs: ['globex'],
    });

    await expect(service.listRepos('globex')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(service.listHealth('globex')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('still serves the org that answered while the other one is refused', async () => {
    // The other half of the rule: one org failing may not cost another org's
    // answer, on the narrowed path as much as on the union one.
    const { service } = twoOrg({
      descriptors: [DESCRIPTORS[0]],
      listUnreadableOrgs: ['globex'],
    });

    const view = await service.listRepos('acme');

    expect(view.repos.map((r) => r.full)).toEqual(['acme/board']);
    expect(view.unreadableOrgs).toEqual([]);
  });

  it('draws an unreadable security posture for an org whose alert lists failed', async () => {
    // The most dangerous absence on this surface. A repo with no row is filled
    // with zeros, and zeros over an unread org are a clean bill of health for
    // repos nobody looked at.
    const { service } = twoOrg({ securityUnreadableOrgs: ['globex'] });

    const health = await service.listHealth();
    const keitaro = health.repos.find((r) => r.full === 'globex/keitaro');
    const board = health.repos.find((r) => r.full === 'acme/board');

    expect(keitaro?.security).toEqual({
      depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'unreadable',
    });
    // The org that DID answer keeps its measured zeros — a fixed answer cannot
    // pass both halves.
    expect(board?.security.state).toBe('read');
    expect(health.unreadableOrgs).toEqual(['globex']);
  });

  it('says unreadable on the rows it DID read from an org only partly read', async () => {
    // The half the absence-filling misses. When one of an org's three alert
    // lists answers and another refuses, the org is named unreadable AND the
    // list that answered leaves real rows behind — so `globex/keitaro` comes
    // back with a measured `depHigh: 1` sitting beside a `codeScanning: 0`
    // nobody read. Patching only the repos with NO row leaves exactly the
    // repos that DO have something claiming a clean bill on the list that
    // refused, and its alert-free neighbour in the same org saying the
    // opposite. One org cannot answer two ways about the same read.
    const { service } = twoOrg({
      descriptors: [DESCRIPTORS[0], DESCRIPTORS[1], GLOBEX],
      security: {
        'globex/keitaro': { depHigh: 1, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' as const },
      },
      securityUnreadableOrgs: ['globex'],
    });

    const health = await service.listHealth();
    const keitaro = health.repos.find((r) => r.full === 'globex/keitaro');

    expect(keitaro?.security.state).toBe('unreadable');
    // The counts that DID come back are kept — rounding the state must not
    // throw away a read that succeeded.
    expect(keitaro?.security.depHigh).toBe(1);
    // Its neighbours in the same org, and in the org that answered, still say
    // what they always said — so a fixed answer cannot pass this.
    expect(health.repos.find((r) => r.full === 'acme/status')?.security.state).toBe('read');
  });

  it('serves an org with no repos rather than refusing it as unreadable', async () => {
    // The 503 is keyed on the LOSS LIST, never on emptiness. An org this build
    // enumerated fine and that simply has nothing in it answers `200` with no
    // rows, because that is a fact about the org; the 503 is reserved for the
    // org whose listing could not be read, where the same empty body would be
    // a claim instead. An implementation that refused every empty narrowed
    // answer would look identical on every other test in this file.
    const { service } = twoOrg({ descriptors: [DESCRIPTORS[0]] });

    const view = await service.listRepos('globex');
    expect(view.repos).toEqual([]);
    expect(view.unreadableOrgs).toEqual([]);
    // ...and so does the health payload, which owes the same distinction.
    expect((await service.listHealth('globex')).repos).toEqual([]);
  });

  it('keeps naming a newly-lost org on a health payload served off coverage (#611)', async () => {
    // The health payload is served on SET COVERAGE, and coverage is a SUBSET
    // test — so a rebuild that LOST an org still passes it: the surviving
    // org's repos are all in the held payload. The rows are then fine and the
    // loss list is not, because it describes the build rather than the repos.
    // Left alone, `GET /api/repos/health` answers `unreadableOrgs: []` while
    // `GET /api/repos` on the very same build names the org — and the one that
    // goes quiet is the one the security banner reads.
    let call = 0;
    const { service, githubLogins } = twoOrg({
      listReposImpl: async () =>
        ++call === 1
          ? { repos: BOTH, unreadableOrgs: [] }
          : { repos: [DESCRIPTORS[0]], unreadableOrgs: ['globex'] },
    });

    expect((await service.listHealth()).unreadableOrgs).toEqual([]);
    // Any rebuild will do; a roster edit is the one that needs no clock.
    githubLogins.invalidateRoster();
    expect((await service.listRepos()).unreadableOrgs).toEqual(['globex']);

    expect((await service.listHealth()).unreadableOrgs).toEqual(['globex']);
  });

  it('names an org whose alerts failed on the narrowed health payload too', async () => {
    // Narrowing is where the loss would otherwise vanish: one org's rows, all
    // zeroes, nothing anywhere saying they were never read.
    const { service } = twoOrg({ securityUnreadableOrgs: ['globex'] });
    const health = await service.listHealth('globex');
    expect(health.unreadableOrgs).toEqual(['globex']);
    expect(health.repos.every((r) => r.security.state === 'unreadable')).toBe(true);
    // ...and the org that answered says nothing was lost.
    expect((await service.listHealth('acme')).unreadableOrgs).toEqual([]);
  });

  it('serves a covered org from the cache after a billing read lost the other org', async () => {
    // The steady state this fix is about: the enhanced billing report needs
    // org-owner scope, so a second org denying it is routine rather than a
    // blip. Refusing to cache the partial read re-issued the whole fan-out on
    // every repo page — 70 repos of it per TTL, where it used to be one read.
    const { service, actionsUsage } = twoOrg({
      descriptors: [DESCRIPTORS[0], DESCRIPTORS[1], GLOBEX],
      usage: [usageDay('acme/board', 1, 100, 0.6)],
      usageOrgs: ['acme'],
    });

    const first = await service.repoPage('acme', 'board');
    const second = await service.repoPage('acme', 'status');

    expect(first.ciSpend).toMatchObject({ state: 'read' });
    expect(second.ciSpend).toMatchObject({ state: 'read' });
    expect(actionsUsage).toHaveBeenCalledTimes(1);
  });

  it('goes on drawing the uncovered org unreadable off that same cached read', async () => {
    // Caching the partial read must not turn the gap into a zero: the org that
    // did not answer still has no figures, and $0.00 across ten weeks is the
    // one answer worse than a gap here.
    const { service, actionsUsage } = twoOrg({
      usage: [usageDay('acme/board', 1, 100, 0.6)],
      usageOrgs: ['acme'],
    });

    await service.repoPage('acme', 'board');
    const keitaro = await service.repoPage('globex', 'keitaro');

    expect(keitaro.ciSpend).toEqual({ state: 'unreadable' });
    expect(actionsUsage).toHaveBeenCalledTimes(1);
  });

  it('carries each org’s own allowed values beside the union', async () => {
    const perOrg: Record<string, DriSchema> = {
      'acme': { allowedValues: ['octocat', 'hubot'], writability: 'writable' },
      globex: { allowedValues: ['mlopez'], writability: 'writable' },
    };
    const { service } = twoOrg({ driSchemaImpl: async (org) => perOrg[org] });

    const view = await service.listRepos();

    // Keyed by the CONFIGURED spelling, which is what the write gate resolves
    // its target to — a map keyed on anything else could not be looked up.
    expect(view.driOptionsByOrg).toEqual({
      'acme': ['octocat', 'hubot'],
      globex: ['mlopez'],
    });
  });

  it('a narrowed view carries only the org it describes', async () => {
    const perOrg: Record<string, DriSchema> = {
      'acme': { allowedValues: ['octocat'], writability: 'writable' },
      globex: { allowedValues: ['mlopez'], writability: 'writable' },
    };
    const { service } = twoOrg({ driSchemaImpl: async (org) => perOrg[org] });

    const view = await service.listRepos('globex');

    expect(view.driOptionsByOrg).toEqual({ globex: ['mlopez'] });
    expect(view.driOptions).toEqual(['mlopez']);
  });

  it('keeps a spelling one org would accept even when another org spells it differently', async () => {
    // The write gate compares `a === login` against ONE org's list, so folding
    // `OCTOCAT` away because `octocat` was seen first leaves the union
    // carrying only a spelling globex's guard refuses — a picker offering a
    // login that 400s on the press.
    const perOrg: Record<string, DriSchema> = {
      'acme': { allowedValues: ['octocat'], writability: 'writable' },
      globex: { allowedValues: ['OCTOCAT'], writability: 'writable' },
    };
    const { service } = twoOrg({ driSchemaImpl: async (org) => perOrg[org] });

    const view = await service.listRepos();

    expect(view.driOptions).toEqual(['octocat', 'OCTOCAT']);
    // Exact duplicates still go: one org repeating another's exact spelling is
    // one option, not two.
    expect(view.driOptionsByOrg).toEqual({ 'acme': ['octocat'], globex: ['OCTOCAT'] });
  });

  it('bounds the per-org schema fan-out with the same pool every other read uses', async () => {
    // The one new fan-out that was `Promise.all`. A deployment naming many orgs
    // must not open one request per org at once.
    const orgs = Array.from({ length: 20 }, (_, i) => `org-${i}`);
    let live = 0;
    let peak = 0;
    const { service } = make({
      servedOrgs: orgs,
      driSchemaImpl: async () => {
        peak = Math.max(peak, ++live);
        await new Promise((r) => setTimeout(r, 0));
        live--;
        return { allowedValues: [], writability: 'writable' as const };
      },
    });

    await service.listRepos();

    expect(peak).toBeLessThanOrEqual(8);
    // ...and it is a pool, not a serial loop: with 20 orgs it really does run
    // several at once.
    expect(peak).toBeGreaterThan(1);
  });

  it('still answers a write for an org whose repo listing failed', async () => {
    // A narrowed READ for that org is a 503 — there is nothing to serve. A
    // WRITE is a different question: it does not read this map at all, it
    // resolves its target through the allow-list and needs that org's schema.
    // Refusing it because the enumeration failed would refuse a press Github
    // would have taken.
    const perOrg: Record<string, DriSchema> = {
      'acme': { allowedValues: ['octocat'], writability: 'writable' },
      globex: { allowedValues: ['mlopez'], writability: 'writable' },
    };
    const { service } = twoOrg({
      descriptors: [DESCRIPTORS[0]],
      listUnreadableOrgs: ['globex'],
      driSchemaImpl: async (org) => perOrg[org],
    });

    await expect(service.listRepos('globex')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await service.ownerWriteEnv('globex')).toEqual({
      allowed: ['mlopez'],
      writability: 'writable',
    });
  });

  it('joins owners and alert counts however the deployment spelled its org', async () => {
    // `full` is built from the CONFIGURED org spelling; the ownership and alert
    // maps are keyed off the spelling GITHUB puts in a full name. Joining the
    // two with exact equality means `GITHUB_ORGS=Acme` blanks every owner
    // and every alert count on the board, silently, for the life of the map.
    const CASED: RepoDescriptor = { ...DESCRIPTORS[0], full: 'Acme/board' };
    const { service } = make({
      servedOrgs: ['Acme'],
      descriptors: [CASED],
      dri: { 'acme/board': 'octocat' },
      security: {
        'acme/board': {
          depHigh: 4, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read',
        },
      },
    });

    const row = (await service.listRepos()).repos[0];
    const health = (await service.listHealth()).repos[0];

    expect(row.owner).toEqual({ login: 'octocat', name: 'Octocat' });
    expect(health.security.depHigh).toBe(4);
    // `full` itself is NOT folded — it is the canonical key every other join
    // and every client-side join uses, and rewriting it would move the bug
    // rather than fix it.
    expect(row.full).toBe('Acme/board');
    expect(health.full).toBe('Acme/board');
  });

  it('leaves a single-org deployment exactly as it was', async () => {
    const { service, driSchema } = make();
    const union = await service.listRepos();
    const narrowed = await service.listRepos('acme');

    expect(narrowed.repos.map((r) => r.full)).toEqual(union.repos.map((r) => r.full));
    expect(narrowed.driOptions).toEqual(union.driOptions);
    expect(narrowed.ownerWritability).toBe(union.ownerWritability);
    expect(union.repos.every((r) => r.ownerState === 'read')).toBe(true);
    expect(driSchema).toHaveBeenCalledTimes(1);
  });
});

/**
 * A map whose repos are listed while both org-wide reads came back empty (#718).
 *
 * The source serves repos it could list and names the OWNERS whose org-wide
 * ownership and alert reads it could not make. These are what the payloads owe
 * the reader when that happens: nothing read is not nothing to read.
 *
 * `ISSUES_METRICS_ORG=''` plus `ISSUES_METRICS_REPOS` was how a deployment
 * reached it on purpose, and both keys are retired (#1209 part 4). It is now
 * reached by an org read that failed, which is the case this service has always
 * owed an answer for — these tests drive the SERVICE off a stubbed source, so
 * what they pin is the rendering rule rather than the configuration.
 */
describe('ReposService — repos listed while both org-wide reads came back empty (#718)', () => {
  const GLOBEX: RepoDescriptor = {
    full: 'GLOBEX/keitaro',
    name: 'keitaro',
    key: 'keitaro',
    htmlUrl: 'https://github.com/GLOBEX/keitaro',
    description: null,
    language: null,
    pushedAt: daysAgo(3),
    createdAt: null,
    defaultBranch: 'main',
  };
  /** The shape the source produces there: the repos are listed, and both
   *  org-wide reads report every owner lost. */
  const unread = () =>
    make({
      servedOrgs: [],
      descriptors: [DESCRIPTORS[0], GLOBEX],
      unreadableOrgs: ['acme', 'GLOBEX'],
      securityUnreadableOrgs: ['acme', 'GLOBEX'],
    }).service;

  it('draws no repo as unowned when nothing was read about who owns it', async () => {
    const view = await unread().listRepos();

    expect(view.repos.map((r) => r.ownerState)).toEqual(['unreadable', 'unreadable']);
    expect(view.repos.every((r) => r.owner === null)).toBe(true);
  });

  it('draws no repo as clean when no alert list was read for it', async () => {
    const health = await unread().listHealth();

    // Zeros that say so. Without the org names these rows are indistinguishable
    // from two repos with nothing open — a clean bill of health for repos
    // nobody looked at.
    expect(health.repos.map((r) => r.security.state)).toEqual(['unreadable', 'unreadable']);
    expect(health.unreadableOrgs).toEqual(['acme', 'GLOBEX']);
  });

  it('says it may write nowhere, rather than that the owner control is fine', async () => {
    // No served org is no schema, and `foldWritability` answers `unreadable`
    // for that — the state that means the board did not find out. `writable`
    // here would draw an owner picker over a write the source refuses.
    const view = await unread().listRepos();

    expect(view.ownerWritability).toBe('unreadable');
    expect(view.driOptionsByOrg).toEqual({});
  });
});

/**
 * The in-flight billing read is joined only by a caller it COVERS (#718).
 *
 * The cache is served on age AND month coverage, and the in-flight slot beside
 * it used to be served on neither: a caller arriving while a read was out got
 * that read whatever months it had asked for. A month the read never requested
 * then renders as `minutes: 0`, which the page defines as "nothing ran", and
 * `readEverything` caches that page because every section reports `read`.
 *
 * Two builds straddling a month boundary is the ordinary shape here, not a
 * contrived one: stale-while-revalidate keeps a build alive past its TTL, and a
 * roster edit rebuilds the map without dropping this cache.
 */
describe('ReposService — one caller’s billing read is not another caller’s answer (#718)', () => {
  /** One day of the billing report, dated off the CURRENT clock — which under
   *  the fake timers below is the month the caller's own window ends in. */
  const usageDay = (full: string, daysAgoN: number, minutes: number, netUsd: number): ActionsUsageDay => ({
    full,
    date: daysAgo(daysAgoN),
    minutes,
    netUsd,
  });

  it('does not hand an in-flight read to a caller whose window it never asked for', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'));
    const pending: { months: UsageMonth[]; settle: (r: ActionsUsageRead) => void }[] = [];
    // A TTL long enough that age can never be what forces the second read.
    const { service, actionsUsage, githubLogins } = make({
      ttlMs: 10 * 365 * 86_400_000,
      actionsUsageImpl: (months) =>
        new Promise<ActionsUsageRead>((settle) => pending.push({ months, settle })),
    });

    const august = service.repoPage('acme', 'board');
    await vi.waitFor(() => expect(actionsUsage).toHaveBeenCalledTimes(1));
    // The window and the one before it (#962): twenty weeks back from here.
    expect(pending[0].months).toEqual([
      { year: 2026, month: 3 },
      { year: 2026, month: 4 },
      { year: 2026, month: 5 },
      { year: 2026, month: 6 },
      { year: 2026, month: 7 },
      { year: 2026, month: 8 },
    ]);

    // A roster edit rebuilds the map through the generation guard, and the new
    // build's window has rolled into September. The first read is STILL out —
    // resolving it here would let the cache's own coverage check answer, and
    // the assertion would pass whether or not the in-flight slot is checked.
    githubLogins.invalidateRoster();
    vi.setSystemTime(new Date('2026-09-20T12:00:00.000Z'));
    const september = service.repoPage('acme', 'board');
    await vi.waitFor(() => expect(actionsUsage).toHaveBeenCalledTimes(2));
    expect(pending[1].months).toContainEqual({ year: 2026, month: 9 });

    pending[0].settle({ days: [], orgs: ['acme'] });
    pending[1].settle({
      days: [usageDay('acme/board', 1, 100, 0.6)],
      orgs: ['acme'],
    });
    await august;
    const page = await september;

    // The September caller drew September's minutes, not the zeros an August
    // report would have given it.
    if (page.ciSpend.state !== 'read') throw new Error('expected a read');
    expect(page.ciSpend.weeks[REPO_WEEKS - 1]).toEqual({ minutes: 100, netUsd: 0.6 });
    vi.useRealTimers();
  });

  it('still joins an in-flight read that DOES cover the caller’s window', async () => {
    // The dedupe this slot exists for. Two pages of one build ask for the same
    // months, and that must stay one billing read — the fix may not turn a
    // dedupe into a fan-out per page.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T12:00:00.000Z'));
    const pending: ((r: ActionsUsageRead) => void)[] = [];
    const { service, actionsUsage } = make({
      actionsUsageImpl: () => new Promise<ActionsUsageRead>((settle) => pending.push(settle)),
    });

    const first = service.repoPage('acme', 'board');
    await vi.waitFor(() => expect(actionsUsage).toHaveBeenCalledTimes(1));
    const second = service.repoPage('acme', 'status');
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    pending[0]({ days: [], orgs: ['acme'] });
    await Promise.all([first, second]);

    expect(actionsUsage).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

/**
 * What `driOptionsByOrg` says about an org whose schema did not read (#718).
 *
 * The type's docstring claimed such an org is ABSENT from the map, the way an
 * unreadable org is absent from `repos`. It never was: `driSchema` does not
 * throw — every failure comes back as `unreadable` with an empty list — so the
 * org is present carrying `[]`. There is no consumer yet, so the code is what
 * stands and the docstring is what moved; this is that behaviour pinned, so the
 * two cannot drift apart again in prose.
 */
describe('ReposService — an org whose dri schema failed still has an entry (#718)', () => {
  const TWO = ['acme', 'globex'];
  const withSchemas = (perOrg: Record<string, DriSchema>) =>
    make({ servedOrgs: TWO, driSchemaImpl: async (org) => perOrg[org] }).service;

  it('carries an EMPTY list for the org, not an absence', async () => {
    const service = withSchemas({
      'acme': { allowedValues: ['octocat'], writability: 'writable' },
      globex: { allowedValues: [], writability: 'unreadable' },
    });

    const view = await service.listRepos();

    expect(view.driOptionsByOrg).toEqual({ 'acme': ['octocat'], globex: [] });
    expect(Object.keys(view.driOptionsByOrg)).toEqual(TWO);
  });

  it('leaves the option list unable to say WHY it is empty, which is what writability answers', async () => {
    // Three orgs' worth of empty, one meaning each, and one empty list for all
    // three: the list is not the field that tells them apart. A narrowed view
    // is where a reader gets the org's own answer.
    for (const writability of ['unreadable', 'absent', 'writable'] as const) {
      const service = withSchemas({
        'acme': { allowedValues: ['octocat'], writability: 'writable' },
        globex: { allowedValues: [], writability },
      });

      expect((await service.listRepos()).driOptionsByOrg.globex, writability).toEqual([]);
      expect((await service.listRepos('globex')).ownerWritability, writability).toBe(writability);
    }
  });
});

/**
 * What the Board sync panel's Repos row reads (#1169).
 *
 * The VIEW's own moment, not `ReposView.updatedAt`. Those are two different
 * facts and this service is careful about the difference everywhere else: the
 * payload advertises the ingest's age, because the rows are joined against a
 * cached issue list that may be up to its own TTL old, while what the panel's
 * row is about is when this map was built.
 */
describe('ReposService.lastSyncedAt (#1169)', () => {
  it('has no record before the map has been built', () => {
    expect(make().service.lastSyncedAt()).toBeNull();
  });

  it('records the map’s own build, not the ingest age the payload advertises', async () => {
    const { service } = make({ issues: [rawIssue()] });
    const view = await service.listRepos();
    const recorded = service.lastSyncedAt();
    expect(recorded).not.toBeNull();
    // The ingest is stamped at a fixed 2026-08-05 by this file's `getIssues`,
    // so a record that merely echoed the payload would answer that date.
    expect(view.updatedAt).toBe('2026-08-05T00:00:00.000Z');
    expect(recorded).not.toBe(view.updatedAt);
    expect(Date.parse(recorded as string)).toBeGreaterThan(Date.parse(view.updatedAt));
  });

  /**
   * It reports the map's MOMENT without marking the request permission-sensitive
   * (#1169 review, B1).
   *
   * `mapState`'s scope is `KeptWhileUnchanged`, and `current` marks the request
   * the instant it is touched, empty or not. The Board sync panel polls this
   * every two minutes in every open tab, on every page — and a marked poll is
   * refused outright once its check expires, and carries the withdrawal headers
   * that invalidate the whole board. `PrincipalState.peek` is how this stays a
   * moment rather than a read.
   */
  it('reports when the map was built without marking the request sensitive', async () => {
    const { service } = make();
    const principal = {
      key: 'visibility', owners: [], repositories: [],
      cache: new WeakMap(), permissionCache: new WeakMap(), expiresAt: Date.now() + 60_000,
    } as unknown as GithubPrincipal;
    const read: { principal: GithubPrincipal; sensitive?: boolean } = { principal };
    await githubContext.run(read, async () => {
      expect(service.lastSyncedAt()).toBeNull();
      expect(read.sensitive, 'a freshness read must not mark the request').toBeUndefined();
      // The contrast: reading the MAP marks it, as it has since #1007.
      await service.listRepos();
      expect(read.sensitive).toBe(true);
      read.sensitive = undefined;
      expect(service.lastSyncedAt()).not.toBeNull();
      expect(read.sensitive).toBeUndefined();
    });
  });

  it('asks Github nothing — the map is ~18s of it and a panel must not pay', async () => {
    const { service, listRepos } = make();
    await service.listRepos();
    const before = listRepos.mock.calls.length;
    service.lastSyncedAt();
    service.lastSyncedAt();
    expect(listRepos.mock.calls.length).toBe(before);
  });

  // The record follows the map rather than being stamped once: a "Sync now"
  // drops the view and rebuilds it, and what the panel's row then reports is
  // the new build's moment, not the one the old map carried.
  it('moves to the rebuilt map’s moment after a sync', async () => {
    const { service } = make();
    await service.listRepos();
    const before = service.lastSyncedAt();
    await new Promise((r) => setTimeout(r, 2));
    await service.resync();
    const after = service.lastSyncedAt();
    expect(after).not.toBe(before);
    expect(Date.parse(after as string)).toBeGreaterThan(Date.parse(before as string));
  });
});

describe('ReposService completed day change (#1239)', () => {
  async function payload(service: ReposService) {
    const config = new ConfigService({});
    const controller = new ReposController(service, config, {} as AuditService,
      new CapabilityRegistry(config), { servedOrgs: ['acme'] } as unknown as IReposSource);
    return JSON.parse(JSON.stringify(await controller.page('acme', 'board')));
  }

  it('does not reuse pre-midnight billing when a new map compares that completed day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T23:59:00Z'));
    try {
      const full = DESCRIPTORS[0].full;
      const { service, githubLogins, actionsUsage } = make({ usage: [
        { full, date: '2026-08-12T08:00:00Z', minutes: 10, netUsd: 0 },
        { full, date: '2026-08-13T08:00:00Z', minutes: 10, netUsd: 0 },
      ] });
      await payload(service);
      vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
      githubLogins.invalidateRoster();
      actionsUsage.mockRejectedValue(new Error('billing offline'));
      expect((await payload(service)).completedDayChange).toMatchObject({
        day: '2026-08-13', previousDay: '2026-08-12', ciNetUsd: { state: 'unknown' },
      });
    } finally { vi.useRealTimers(); }
  });

  it('does not join a pre-midnight billing read for a post-midnight map', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T23:59:00Z'));
    try {
      const full = DESCRIPTORS[0].full;
      let resolveOld!: (value: ActionsUsageRead) => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => { started = resolve; });
      const { service, githubLogins, actionsUsage } = make();
      actionsUsage.mockImplementationOnce(() => {
        started();
        return new Promise<ActionsUsageRead>((resolve) => { resolveOld = resolve; });
      });
      const oldPage = payload(service);
      await ready;
      vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
      githubLogins.invalidateRoster();
      actionsUsage.mockRejectedValue(new Error('billing offline'));
      const newPage = payload(service);
      // Let the new page reach the shared billing slot before the old read lands.
      await vi.waitFor(() => expect(actionsUsage).toHaveBeenCalledTimes(2));
      resolveOld({ orgs: ['acme'], days: [
        { full, date: '2026-08-12T08:00:00Z', minutes: 10, netUsd: 0 },
        { full, date: '2026-08-13T08:00:00Z', minutes: 10, netUsd: 0 },
      ] });
      await oldPage;
      expect((await newPage).completedDayChange.ciNetUsd).toEqual({ state: 'unknown' });
    } finally { vi.useRealTimers(); }
  });

  it.each(['2026-08-05T00:00:00Z', '2026-08-13T23:59:59.999Z'])(
    'does not measure issues from a successful snapshot ending at %s', async (at) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
      try {
        const { service } = make({ issues: [], issuesAt: Date.parse(at) });
        await service.listRepos();
        expect((await payload(service)).completedDayChange).toMatchObject({
          day: '2026-08-13', previousDay: '2026-08-12', openIssues: { state: 'unknown' },
        });
      } finally { vi.useRealTimers(); }
    });

  it('keeps stale-while-revalidate issue successes unknown after the refresh rejects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-05T00:00:00Z'));
    try {
      const source = {
        listIssues: vi.fn().mockResolvedValueOnce([]).mockRejectedValue(new Error('offline')),
        repoOutcomes: () => [{ full: DESCRIPTORS[0].full, ok: true }],
      };
      const issuesCache = new IssuesCacheService(source, new ConfigService({ FEEDBACK_REPO: DESCRIPTORS[0].full }));
      await issuesCache.getIssues();
      vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
      const { service } = make({ issuesCache });
      await service.listRepos();
      const page = await payload(service);
      expect(page.updatedAt).toBe('2026-08-05T00:00:00.000Z');
      expect(page.completedDayChange).toMatchObject({
        day: '2026-08-13', previousDay: '2026-08-12', openIssues: { state: 'unknown' },
      });
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { label: 'unknown without a repo read outcome', issueReads: [], expected: { state: 'unknown' } },
    {
      label: 'a measured zero with a successful repo read outcome',
      issueReads: [{ full: 'Acme/board', ok: true }],
      expected: { state: 'read', value: 0 },
    },
  ])('publishes $label for an empty issue history', async ({ issueReads, expected }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
    try {
      const { service } = make({ issues: [], issueReads, issuesAt: Date.now() });
      // Build the map first so the page must retain evidence through its cache.
      await service.listRepos();
      const page = await payload(service);
      expect(page.completedDayChange.openIssues).toEqual(expected);
      expect(page.openIssuesState).toBe('read');
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves daily changes separately from the ten-week comparison', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
    try {
      const full = DESCRIPTORS[0].full;
      const { service } = make({
        issues: [rawIssue({ createdAt: '2026-08-13T08:00:00Z' })],
        issuesAt: Date.now(),
        pullRequestsImpl: async () => ({
          state: 'read', open: 2, closedMerged: 0, coveredFrom: null, openPrs: [],
          prs: [
            { number: 1, createdAt: '2026-08-13T08:00:00Z', mergedAt: null, closedAt: null, author: null, authorIsBot: false },
            { number: 2, createdAt: '2026-08-14T08:00:00Z', mergedAt: null, closedAt: null, author: null, authorIsBot: false },
          ],
        }),
        usage: [
          { full, date: '2026-08-12T08:00:00Z', minutes: 10, netUsd: 3 },
          { full, date: '2026-08-13T08:00:00Z', minutes: 10, netUsd: 1 },
          { full, date: '2026-08-14T08:00:00Z', minutes: 10, netUsd: 99 },
        ],
      });
      const page = await service.repoPage('acme', 'board');
      expect(page.completedDayChange).toEqual({
        day: '2026-08-13', previousDay: '2026-08-12',
        openIssues: { state: 'read', value: 1 },
        openPrs: { state: 'read', value: 1 },
        ciNetUsd: { state: 'read', value: -2 },
      });
      expect(page.previous.ciNetUsd).toEqual({ state: 'read', value: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes missing yesterday separately from an observed zero change', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
    try {
      const full = DESCRIPTORS[0].full;
      const older = { full, date: '2026-08-12T08:00:00Z', minutes: 10, netUsd: 0 };
      const yesterday = { ...older, date: '2026-08-13T08:00:00Z' };
      const missing = await make({ usage: [older] }).service.repoPage('acme', 'board');
      const zero = await make({ usage: [older, yesterday] }).service.repoPage('acme', 'board');
      expect(missing.completedDayChange.ciNetUsd).toEqual({ state: 'unknown' });
      expect(zero.completedDayChange.ciNetUsd).toEqual({ state: 'read', value: 0 });
      expect(missing.completedDayChange.ciNetUsd).not.toEqual(zero.completedDayChange.ciNetUsd);
      const failed = await make({ issueReads: [{ full, ok: false }], usageOrgs: [], usage: [older, yesterday],
        pullRequestsImpl: async () => ({ state: 'unreadable' }) }).service.repoPage('acme', 'board');
      expect(failed.completedDayChange.openIssues).toEqual({ state: 'unknown' });
      expect(failed.completedDayChange.openPrs).toEqual({ state: 'unknown' });
      expect(failed.completedDayChange.ciNetUsd).toEqual({ state: 'unknown' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Repos grid CI spend lens (#1276)', () => {
  it('shares the existing billing cache without reading repo pages or PRs', async () => {
    const h = make({ usage: [{ full: DESCRIPTORS[0].full, date: daysAgo(1).slice(0, 10), netUsd: 12.5, minutes: 100 }] });
    const first = await h.service.listCiSpend();
    expect(first.repos).toHaveLength(2);
    expect(first.repos[0].ciSpend).toMatchObject({ state: 'read' });
    if (first.repos[0].ciSpend.state === 'read') {
      expect(first.repos[0].ciSpend.weeks).toHaveLength(REPO_WEEKS);
      expect(first.repos[0].ciSpend.weeks.at(-1)).toEqual({ netUsd: 12.5, minutes: 100 });
    }
    await h.service.listCiSpend();
    expect(h.actionsUsage).toHaveBeenCalledTimes(1);
    expect(h.pullRequests).not.toHaveBeenCalled();
    expect(h.readme).not.toHaveBeenCalled();
  });

  it('keeps uncovered billing unreadable and narrows before serving', async () => {
    const other = { ...DESCRIPTORS[1], full: 'other/status' };
    const h = make({ descriptors: [DESCRIPTORS[0], other], servedOrgs: ['acme', 'other'], usageOrgs: ['acme'] });
    const result = await h.service.listCiSpend('other');
    expect(result.repos).toEqual([{ full: 'other/status', ciSpend: { state: 'unreadable' } }]);
    const failed = make({ listUnreadableOrgs: ['other'] });
    await expect(failed.service.listCiSpend('other')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(failed.actionsUsage).not.toHaveBeenCalled();
  });
});


describe('Repos grid on-demand PR lens (#1276)', () => {
  it('does not load PRs with the grid or health, then shares reads with repo pages', async () => {
    const h = make();
    await h.service.listRepos();
    await h.service.listHealth();
    expect(h.pullRequests).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([h.service.listPrFlow(), h.service.listPrFlow()]);
    expect(first).toEqual(second);
    expect(first.repos).toHaveLength(2);
    expect(first.repos[0].pullRequests).toMatchObject({ state: 'read', open: 1 });
    expect(h.pullRequests).toHaveBeenCalledTimes(2);
    expect(h.readme).not.toHaveBeenCalled();
    expect(h.actionsUsage).not.toHaveBeenCalled();
    const [owner, name] = DESCRIPTORS[0].full.split('/');
    await h.service.repoPage(owner, name);
    expect(h.pullRequests).toHaveBeenCalledTimes(2);
  });

  it('narrows before reads and preserves failed PR reads as unavailable', async () => {
    const other = { ...DESCRIPTORS[1], full: 'other/status' };
    const h = make({ descriptors: [DESCRIPTORS[0], other], servedOrgs: ['acme', 'other'],
      pullRequestsImpl: async () => { throw new Error('unavailable'); } });
    expect(await h.service.listPrFlow('other')).toEqual({ repos: [{ full: 'other/status', pullRequests: { state: 'unreadable' } }] });
    expect(h.pullRequests).toHaveBeenCalledTimes(1);
    expect(h.pullRequests.mock.calls[0][0]).toBe('other/status');
    const failed = make({ listUnreadableOrgs: ['other'] });
    await expect(failed.service.listPrFlow('other')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(failed.pullRequests).not.toHaveBeenCalled();
  });
});
