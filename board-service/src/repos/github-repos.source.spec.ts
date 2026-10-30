import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { HttpException, Logger, NotFoundException } from '@nestjs/common';
import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { GithubReposSource } from './github-repos.source';
import type { CapabilityRegistry } from '../capability/capability.registry';
import type { RepoDescriptor } from './repo.types';
import { OPEN_PRS_CAP } from './repo-page';

// The source lazily builds an Octokit; we hand it a fake. `paginate` serves both
// the org repo listing and the org-wide property-values read, `repos.get` a
// single pinned repo, `actions.listWorkflowRunsForRepo` the per-repo CI read.
// `vi.hoisted` so these exist before the mock factory runs.
const { paginate, get, listForOrg, listWorkflowRunsForRepo, request, graphql, writeSchema } = vi.hoisted(() => ({
  paginate: vi.fn(),
  get: vi.fn(),
  listForOrg: Symbol('repos.listForOrg'),
  listWorkflowRunsForRepo: vi.fn(),
  request: vi.fn(),
  writeSchema: vi.fn(),
  graphql: vi.fn(),
}));
vi.mock('../sources/github-client', () => ({
  buildOctokitClient: (_config: unknown, mode?: string) => ({
    paginate,
    request: (route: string, args: unknown) => mode === 'write' && route === 'GET /orgs/{org}/properties/schema'
      ? writeSchema(route, args) : request(route, args),
    graphql,
    repos: { listForOrg, get },
    actions: { listWorkflowRunsForRepo },
  }),
}));

// No fixture here is called `main`. A source that hardcoded the branch name
// would read the org's commonest default and pass every assertion below, which
// is the second way to get #572 wrong.
const descriptorFixture = (full: string, defaultBranch: string | null = 'trunk'): RepoDescriptor => {
  const [owner, name] = full.split('/');
  return {
    full,
    name,
    key: name,
    htmlUrl: `https://github.com/${owner}/${name}`,
    description: null,
    language: null,
    pushedAt: null,
    createdAt: null,
    defaultBranch,
  };
};

/** HONOURS the default argument, which the real `ConfigService` does and this
 *  fake did not. Dropping it made `githubOrgs` throw on an env that names no key
 *  at all, so the "an absent surface key follows the list" half of the rule was
 *  untestable here, and the next person to try it would have read the throw as a
 *  broken resolver. Production refuses that env outright since #1175: a
 *  deployment that names no organisation does not boot, which is why the pin
 *  below supplies `GITHUB_ORGS` and the cases vary a surface key instead. */
/** `GITHUB_ORGS` and `FEEDBACK_REPO` are pinned at the org this file's sample
 *  rows are written against. Since #1175 neither key has a default to be left
 *  to: #1166 put both behind one constant, the organisation was renamed out from
 *  under it, and the constant came off. A case that means another value passes
 *  its own. */
const cfg = (vars: Record<string, string>): ConfigService =>
  ({
    get: (k: string, d?: unknown) => ({ GITHUB_ORGS: 'acme', FEEDBACK_REPO: 'acme/board', ...vars })[k] ?? d,
  }) as unknown as ConfigService;

// The two in-scope rows carry DIFFERENT `pushed_at` and `default_branch` values,
// so a mapping that stamped one repo's push — or one repo's branch — onto every
// row could not pass (#572).
const ORG_REPOS = [
  { name: 'acme', archived: false, fork: false, has_issues: true, html_url: 'https://github.com/acme/acme', description: 'the product', pushed_at: '2026-08-11T09:15:00Z', default_branch: 'trunk' },
  { name: 'board', archived: false, fork: false, has_issues: true, html_url: 'https://github.com/acme/board', description: null, pushed_at: '2026-05-27T18:40:00Z', default_branch: 'develop' },
  { name: 'old-thing', archived: true, fork: false, has_issues: true, html_url: '', description: null },
  { name: 'wiki-only', archived: false, fork: false, has_issues: false, html_url: '', description: null },
  // A fork is outside the issue ingest, so the map would only ever draw it empty.
  { name: 'a-fork', archived: false, fork: true, has_issues: true, html_url: '', description: null },
];


/** One row of `GET /orgs/{org}/properties/values`, as the API returns it. */
const propRow = (name: string, dri: string | null) => ({
  repository_name: name,
  repository_full_name: `acme/${name}`,
  properties: [{ property_name: 'dri', value: dri }],
});

beforeEach(() => {
  writeSchema.mockReset().mockResolvedValue({ data: [{ property_name: 'dri' }] });
});

describe('GithubReposSource — repo ownership from the dri property (#548)', () => {
  beforeEach(() => {
    paginate.mockReset();
    get.mockReset();
  });

  it('reads every repo owner in one org-wide call, keyed by full name', async () => {
    paginate.mockResolvedValueOnce([
      propRow('acme', 'octocat'),
      propRow('acme-ui', 'anton-khovanskiy'),
    ]);

    const { byRepo } = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).driByRepo();

    expect(byRepo.get('acme/acme')).toBe('octocat');
    expect(byRepo.get('acme/acme-ui')).toBe('anton-khovanskiy');
    expect(paginate).toHaveBeenCalledTimes(1);
  });

  it('a repo carrying no dri value declares no owner', async () => {
    paginate.mockResolvedValueOnce([propRow('status', null)]);
    const { byRepo } = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).driByRepo();
    expect(byRepo.get('acme/status')).toBeNull();
  });

  it('keys ownership off the property name whatever case the org spelled it in', async () => {
    // The org-wide values read reports the name the org typed. Matching `'dri'`
    // exactly drew every repo in an org that typed `DRI` as ownerless, on a map
    // that is cached for its whole TTL — a false claim about the whole org, not
    // a missing decoration.
    paginate.mockResolvedValueOnce([
      { repository_full_name: 'acme/acme', properties: [{ property_name: 'DRI', value: 'octocat' }] },
    ]);

    const { byRepo } = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).driByRepo();

    expect(byRepo.get('acme/acme')).toBe('octocat');
  });

  it('throws on a real failure rather than reporting that nobody owns anything', async () => {
    paginate.mockRejectedValueOnce(Object.assign(new Error('Bad credentials'), { status: 401 }));
    await expect(
      new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).driByRepo(),
    ).rejects.toThrow('Bad credentials');
  });
});

describe('GithubReposSource — the map scope (#472)', () => {
  beforeEach(() => {
    paginate.mockReset();
    get.mockReset();
  });

  it('lists exactly the repos the issue ingest reads — non-archived, non-fork, issues on', async () => {
    paginate.mockResolvedValue(ORG_REPOS);
    const { repos } = await new GithubReposSource(
      cfg({ GITHUB_ORGS: 'acme' }),
    ).listRepos();

    expect(repos.map((r) => r.name)).toEqual(['acme', 'board']);
    expect(repos.map((r) => r.full)).toEqual(['acme/acme', 'acme/board']);
    // The join key into the ingested issues, not the repo name.
    expect(repos.map((r) => r.key)).toEqual(['acme', 'board']);
    expect(repos[0].description).toBe('the product');
  });

  it("carries each repo's last push off the listing it already makes (#572)", async () => {
    paginate.mockResolvedValue(ORG_REPOS);
    const { repos } = await new GithubReposSource(
      cfg({ GITHUB_ORGS: 'acme' }),
    ).listRepos();

    expect(repos.map((r) => r.pushedAt)).toEqual([
      '2026-08-11T09:15:00Z',
      '2026-05-27T18:40:00Z',
    ]);
    // One listing call, no per-repo read added for it.
    expect(paginate).toHaveBeenCalledTimes(1);
  });

  it("carries each repo's own default branch off that same listing (#572)", async () => {
    paginate.mockResolvedValue(ORG_REPOS);
    const { repos } = await new GithubReposSource(
      cfg({ GITHUB_ORGS: 'acme' }),
    ).listRepos();

    expect(repos.map((r) => [r.name, r.defaultBranch])).toEqual([
      ['acme', 'trunk'],
      ['board', 'develop'],
    ]);
    // Still one listing call: the branch rides on the response already read.
    expect(paginate).toHaveBeenCalledTimes(1);
  });

  it('a repo Github names no default branch for reads as null, not as undefined (#572)', async () => {
    paginate.mockResolvedValue([
      { name: 'status', archived: false, fork: false, has_issues: true, html_url: 'u', description: null },
    ]);
    const { repos } = await new GithubReposSource(
      cfg({ GITHUB_ORGS: 'acme' }),
    ).listRepos();
    expect(repos[0].defaultBranch).toBeNull();
  });

  it('a repo Github reports no push for reads as null, not as undefined (#572)', async () => {
    paginate.mockResolvedValue([
      { name: 'status', archived: false, fork: false, has_issues: true, html_url: 'u', description: null },
    ]);
    const { repos } = await new GithubReposSource(
      cfg({ GITHUB_ORGS: 'acme' }),
    ).listRepos();
    expect(repos[0].pushedAt).toBeNull();
  });

});

/** One alert row as any of the three org-level alert lists returns it — only
 *  the fields `securityByRepo()` reads. Dependabot rows carry a severity;
 *  code-scanning and secret-scanning rows don't need one. */
const depAlert = (full: string, severity: string) => ({
  repository: { full_name: full },
  security_advisory: { severity },
});
const scanAlert = (full: string) => ({ repository: { full_name: full } });

describe('GithubReposSource — security posture (#558)', () => {
  beforeEach(() => {
    paginate.mockReset();
    get.mockReset();
  });

  it('counts dependabot alerts by severity per repo', async () => {
    paginate.mockImplementation((path: string) => {
      if (path === 'GET /orgs/{org}/dependabot/alerts') {
        return Promise.resolve([
          depAlert('acme/a', 'critical'),
          depAlert('acme/a', 'moderate'),
          depAlert('acme/b', 'high'),
        ]);
      }
      return Promise.resolve([]);
    });

    const { byRepo: sec } = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).securityByRepo();

    expect(sec.get('acme/a')).toEqual({ depHigh: 1, depModerate: 1, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' });
    expect(sec.get('acme/b')).toEqual({ depHigh: 1, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' });
  });

  it('counts code-scanning and secret-scanning alerts per repo', async () => {
    paginate.mockImplementation((path: string) => {
      if (path === 'GET /orgs/{org}/code-scanning/alerts') {
        return Promise.resolve([scanAlert('acme/a'), scanAlert('acme/a')]);
      }
      if (path === 'GET /orgs/{org}/secret-scanning/alerts') {
        return Promise.resolve([scanAlert('acme/b')]);
      }
      return Promise.resolve([]);
    });

    const { byRepo: sec } = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).securityByRepo();

    expect(sec.get('acme/a')).toEqual({ depHigh: 0, depModerate: 0, codeScanning: 2, secrets: 0, secretsUrl: null, state: 'read' });
    expect(sec.get('acme/b')).toEqual({ depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 1, secretsUrl: null, state: 'read' });
  });

  it("keeps the first open secret-scanning alert's OWN address, and only that read's (#605)", async () => {
    // 'Leaked secret' is the only word drawn off these three counts, so it is
    // the only read that carries an address. Two alerts on one repo, so "first"
    // is a claim the fixture can fail; a code-scanning alert carrying a URL of
    // its own beside it, so a read that took any alert's address would show.
    paginate.mockImplementation((path: string) => {
      if (path === 'GET /orgs/{org}/secret-scanning/alerts') {
        return Promise.resolve([
          { ...scanAlert('acme/a'), html_url: 'https://github.com/acme/a/security/secret-scanning/1' },
          { ...scanAlert('acme/a'), html_url: 'https://github.com/acme/a/security/secret-scanning/2' },
        ]);
      }
      if (path === 'GET /orgs/{org}/code-scanning/alerts') {
        return Promise.resolve([
          { ...scanAlert('acme/b'), html_url: 'https://github.com/acme/b/security/code-scanning/9' },
        ]);
      }
      return Promise.resolve([]);
    });

    const { byRepo: sec } = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).securityByRepo();

    expect(sec.get('acme/a')?.secretsUrl).toBe('https://github.com/acme/a/security/secret-scanning/1');
    // The code-scanning read carried an address and it went nowhere: nothing
    // draws a word from that count, so an address for it would have no reader.
    expect(sec.get('acme/b')?.codeScanning).toBe(1);
    expect(sec.get('acme/b')?.secretsUrl).toBeNull();
  });

  it('a secret-scanning alert with no address of its own leaves the count alone (#605)', async () => {
    paginate.mockImplementation((path: string) =>
      Promise.resolve(path === 'GET /orgs/{org}/secret-scanning/alerts' ? [scanAlert('acme/a')] : []),
    );

    const { byRepo: sec } = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).securityByRepo();

    expect(sec.get('acme/a')?.secrets).toBe(1);
    expect(sec.get('acme/a')?.secretsUrl).toBeNull();
  });

  it('reports zero for a repo with no alerts, never undefined', async () => {
    paginate.mockImplementation((path: string) => {
      if (path === 'GET /orgs/{org}/dependabot/alerts') {
        return Promise.resolve([depAlert('acme/a', 'high')]);
      }
      return Promise.resolve([]);
    });

    const { byRepo: sec } = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).securityByRepo();

    // The repo that showed up gets explicit zeros for every category it has
    // no alerts in — never `undefined`.
    expect(sec.get('acme/a')).toEqual({ depHigh: 1, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null, state: 'read' });
    // A repo absent from all three lists is simply absent from the map — per
    // the interface contract, absence IS "no open alerts" (the caller, not
    // this source, is responsible for defaulting a missing entry to zero).
    expect(sec.has('acme/b')).toBe(false);
  });
});

describe('GithubReposSource — CI state (#558)', () => {
  beforeEach(() => {
    listWorkflowRunsForRepo.mockReset();
  });

  it("reports the latest completed run's conclusion per repo", async () => {
    listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: [{ conclusion: 'failure' }] } });

    const ci = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).ciByRepo([
      descriptorFixture('acme/acme'),
    ]);

    expect(ci.get('acme/acme')?.conclusion).toBe('failure');
  });

  it('reports null when a repo has never completed a run on its default branch', async () => {
    listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: [] } });

    const ci = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).ciByRepo([
      descriptorFixture('acme/acme'),
    ]);

    expect(ci.get('acme/acme')).toEqual({ conclusion: null, url: null });
  });

  it("reads the run on the repo's OWN default branch, not the last run on any ref (#572)", async () => {
    // The live shape that mislabels a tile: the protected branch is green while
    // some side branch of the same repo is not. A read that dropped `branch`,
    // or reused one repo's branch for the other, lands on the red row — and the
    // two repos disagree about what their default branch is called, so no one
    // branch name satisfies both.
    const GREEN_ON: Record<string, string> = { docs: 'trunk', cli: 'develop' };
    listWorkflowRunsForRepo.mockImplementation(({ repo, branch }: { repo: string; branch?: string }) =>
      Promise.resolve({
        data: { workflow_runs: [{ conclusion: branch === GREEN_ON[repo] ? 'success' : 'action_required' }] },
      }),
    );

    const ci = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).ciByRepo([
      descriptorFixture('acme/docs', 'trunk'),
      descriptorFixture('acme/cli', 'develop'),
    ]);

    expect(ci.get('acme/docs')?.conclusion).toBe('success');
    expect(ci.get('acme/cli')?.conclusion).toBe('success');
    // And the argument that produced it, named: a conclusion alone would still
    // read 'success' if some other repo's branch happened to be green.
    const asked = listWorkflowRunsForRepo.mock.calls
      .map((call) => call[0] as { repo: string; branch?: string })
      .map((a) => [a.repo, a.branch])
      .sort();
    expect(asked).toEqual([
      ['cli', 'develop'],
      ['docs', 'trunk'],
    ]);
  });

  it("excludes pull-request runs, so a fork's PR on a branch of the same name cannot speak (#572)", async () => {
    // `branch` filters on the run's HEAD branch — Github's own wording is "the
    // name of the branch of the `push`". A `pull_request` run opened from a
    // fork whose head branch is also called `trunk` carries `head_branch:
    // "trunk"` and passes that filter, so scoping to the default branch alone
    // still lets someone else's PR draw this repo's word. Only
    // `exclude_pull_requests` keeps the read to runs on the branch itself.
    listWorkflowRunsForRepo.mockImplementation(({ exclude_pull_requests }: { exclude_pull_requests?: boolean }) =>
      Promise.resolve({
        data: {
          workflow_runs: exclude_pull_requests
            ? [{ conclusion: 'success' }]
            : [{ conclusion: 'failure', event: 'pull_request', head_branch: 'trunk' }],
        },
      }),
    );

    const ci = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).ciByRepo([
      descriptorFixture('acme/docs', 'trunk'),
    ]);

    expect(ci.get('acme/docs')?.conclusion).toBe('success');
    // And the argument that produced it, named: a conclusion alone would not
    // say which parameter the source actually sent.
    expect(listWorkflowRunsForRepo.mock.calls[0][0]).toMatchObject({ exclude_pull_requests: true });
  });

  it('a repo whose default branch Github did not name gets no word, and no run read (#572)', async () => {
    // Nothing to scope the read to. Asking unscoped would put back the very
    // conclusion #572 is about, so the tile says nothing instead.
    const ci = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).ciByRepo([
      descriptorFixture('acme/status', null),
    ]);

    expect(ci.get('acme/status')).toEqual({ conclusion: null, url: null });
    expect(listWorkflowRunsForRepo).not.toHaveBeenCalled();
  });

  it('a failing CI read costs that repo its signal, not the whole map', async () => {
    listWorkflowRunsForRepo.mockImplementation(({ repo }: { repo: string }) => {
      if (repo === 'b') return Promise.reject(new Error('boom'));
      return Promise.resolve({ data: { workflow_runs: [{ conclusion: 'success' }] } });
    });

    const ci = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).ciByRepo([
      descriptorFixture('acme/a'),
      descriptorFixture('acme/b'),
    ]);

    expect(ci.get('acme/a')?.conclusion).toBe('success');
    expect(ci.get('acme/b')).toEqual({ conclusion: null, url: null });
  });

  it("keeps the run's OWN address beside the conclusion it belongs to (#605)", async () => {
    // The run object always carried `html_url`; the read used to keep the
    // conclusion and drop the rest, which is why the tile could name a problem
    // and not reach it. Two repos with different addresses, so a read that
    // stamped one run's URL onto every entry would not pass.
    listWorkflowRunsForRepo.mockImplementation(({ repo }: { repo: string }) =>
      Promise.resolve({
        data: {
          workflow_runs: [
            { conclusion: 'failure', html_url: `https://github.com/acme/${repo}/actions/runs/1` },
          ],
        },
      }),
    );

    const ci = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).ciByRepo([
      descriptorFixture('acme/a'),
      descriptorFixture('acme/b'),
    ]);

    expect(ci.get('acme/a')).toEqual({
      conclusion: 'failure',
      url: 'https://github.com/acme/a/actions/runs/1',
    });
    expect(ci.get('acme/b')?.url).toBe('https://github.com/acme/b/actions/runs/1');
  });

  it('a run Github handed back with no address leaves the conclusion alone (#605)', async () => {
    // Nothing is composed from the repo name here. A word with no address
    // behind it is the state this surface already had, and it stays that.
    listWorkflowRunsForRepo.mockResolvedValue({ data: { workflow_runs: [{ conclusion: 'timed_out' }] } });

    const ci = await new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' })).ciByRepo([
      descriptorFixture('acme/acme'),
    ]);

    expect(ci.get('acme/acme')).toEqual({ conclusion: 'timed_out', url: null });
  });
});
/** Octokit's own failure shape: a plain Error carrying the HTTP status, and the
 *  response headers a rate limit is told apart by. */
const githubError = (status: number, message: string, headers?: Record<string, string>) =>
  Object.assign(new Error(message), { status, response: headers ? { headers } : undefined });

const source = () => new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' }));

/** A source serving the orgs named, in that order — the shape the pin became at
 *  #649, and the only shape since #1209 part 4 retired the pins. `GITHUB_ORGS`
 *  is what makes the set several orgs wide. */
const sourceFor = (orgs: string[]) => new GithubReposSource(cfg({ GITHUB_ORGS: orgs.join(',') }));

/** The write is a 204 with no body, so the source reads the value back. This
 *  fake answers both halves of that round trip. */
const roundTrip = (recorded: string | null) =>
  request.mockImplementation((route: string) =>
    route.startsWith('PATCH')
      ? Promise.resolve({ status: 204 })
      : Promise.resolve({ data: [{ property_name: 'dri', value: recorded }] }),
  );

describe('GithubReposSource — writing a repo owner (#577)', () => {
  beforeEach(() => {
    request.mockReset();
    // #584 task 5 — a refused dri write now RE-READS the repo before it decides
    // what the refusal meant, so `repos.get` is part of this describe's world.
    // Default it to "the repo is not there", which is what makes a 404 in the
    // table below read as the absence its name claims; the two tests that mean
    // the opposite say so themselves. Without the reset a
    // `mockResolvedValueOnce` left by a neighbour is how a test here passes for
    // the wrong reason.
    get.mockReset();
    get.mockRejectedValue(githubError(404, 'Not Found'));
  });

  it('writes through the repo-level values endpoint, which the token’s repo scope covers', async () => {
    roundTrip('anton-khovanskiy');

    await source().setDri('acme/acme-ui', 'anton-khovanskiy');

    expect(request).toHaveBeenCalledWith('PATCH /repos/{owner}/{repo}/properties/values', {
      owner: 'acme',
      repo: 'acme-ui',
      properties: [{ property_name: 'dri', value: 'anton-khovanskiy' }],
    });
    // And NOT the org-wide endpoint, which accepts admin:org alone and answers
    // this token's write with a 404 (#577). Asserting the new call alone would
    // stay green if a change sent both.
    for (const [route] of request.mock.calls) expect(route).not.toContain('/orgs/');
  });

  it('clears an owner by sending a null value to the same endpoint', async () => {
    roundTrip(null);

    await source().setDri('acme/toolkit-guide', null);

    expect(request).toHaveBeenCalledWith('PATCH /repos/{owner}/{repo}/properties/values', {
      owner: 'acme',
      repo: 'toolkit-guide',
      properties: [{ property_name: 'dri', value: null }],
    });
  });

  it('resolves with the owner Github RECORDS, not the one that was asked for', async () => {
    // The write answers 204 with no body, so the requested login is only ever a
    // request. What the tile settles on has to come from a read (#577).
    roundTrip('IvanRoslov');

    const recorded = await source().setDri('acme/acme-memory', 'octocat');

    expect(recorded).toBe('IvanRoslov');
    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/properties/values', {
      owner: 'acme',
      repo: 'acme-memory',
    });
  });

  it('reads a cleared owner back as nobody', async () => {
    // A cleared property drops out of the list entirely — no row for `dri`.
    request.mockImplementation((route: string) =>
      route.startsWith('PATCH') ? Promise.resolve({ status: 204 }) : Promise.resolve({ data: [] }),
    );

    expect(await source().setDri('acme/toolkit-guide', null)).toBeNull();
  });

  it('falls back to the login it wrote when the read-back fails — the write still landed', async () => {
    request.mockImplementation((route: string) =>
      route.startsWith('PATCH')
        ? Promise.resolve({ status: 204 })
        : Promise.reject(githubError(500, 'Internal Server Error')),
    );

    // Rejecting here would roll the tile back to an owner Github no longer has.
    expect(await source().setDri('acme/acme-ui', 'octocat')).toBe('octocat');
  });

  it('refuses to write outside the org it is configured for, whatever it is handed', async () => {
    // The guard in the controller pins the owner, but the source used to discard
    // the owner half of `full` structurally — no request-supplied string could
    // steer the write anywhere. A future caller reaching this without the guard
    // must not be the thing that discovers the pin is gone.
    roundTrip('octocat');

    await expect(source().setDri('someone-else/their-repo', 'octocat')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('sends the write to the org that was asked for, not the first configured one', async () => {
    // Discriminating ONLY because the source is configured for two orgs and the
    // request names the SECOND. Every other write test in this file configures
    // one org and asserts that same org back, which passes whether the write
    // binds the caller's owner half or the source's own — so none of them can
    // see a write that lands in the wrong org.
    roundTrip('octocat');

    await sourceFor(['acme', 'globex']).setDri('globex/design-system', 'octocat');

    expect(request).toHaveBeenCalledWith('PATCH /repos/{owner}/{repo}/properties/values', {
      owner: 'globex',
      repo: 'design-system',
      properties: [{ property_name: 'dri', value: 'octocat' }],
    });
  });

  it('reads the write back from the same repo it wrote to', async () => {
    // `design-system` exists under both orgs on real Github — measured with one
    // token on 2026-08-21 — so a read-back addressed at the first configured org
    // would answer 200 with a stranger's owner and the tile would settle on it.
    // Confirming the write means confirming it where it was aimed.
    roundTrip('IvanRoslov');

    await sourceFor(['acme', 'globex']).setDri('globex/design-system', 'octocat');

    expect(request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/properties/values', {
      owner: 'globex',
      repo: 'design-system',
    });
  });

  it('sends the owner spelling the operator configured, not the caller\'s casing', async () => {
    // The match is case-insensitive so a caller may not be refused over case;
    // what goes to Github is still the configured spelling, so one org is never
    // addressed under two names.
    roundTrip('octocat');

    await sourceFor(['acme', 'globex']).setDri('GLOBEX/design-system', 'octocat');

    expect(request).toHaveBeenCalledWith(
      'PATCH /repos/{owner}/{repo}/properties/values',
      expect.objectContaining({ owner: 'globex' }),
    );
  });

  it('refuses an org outside the configured set, even with several to choose from', async () => {
    roundTrip('octocat');

    await expect(
      sourceFor(['acme', 'globex']).setDri('selgeo/their-repo', 'octocat'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(request).not.toHaveBeenCalled();
  });

  it('a source serving NO org refuses every write', async () => {
    // An empty owner set has to refuse everything rather than admit everything —
    // the second reading is a write into a stranger's repo. `ISSUES_METRICS_ORG=''`
    // produced this set and is retired (#1209 part 4); a person whose Github App
    // grants cover no owner produces it now, and so does a spec's own config.
    roundTrip('octocat');
    const none = new GithubReposSource(cfg({ GITHUB_ORGS: '   ' }));

    for (const full of ['acme/board', 'globex/design-system']) {
      await expect(none.setDri(full, 'octocat')).rejects.toThrow(/GITHUB_ORGS/);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('reads a dri property back whatever case the org spelled it in', async () => {
    // Github stores the name the org typed. A read that matched `'dri'` exactly
    // reported an org that typed `DRI` as having no owner recorded — and the
    // read-back is what the tile settles on, so the press would look like it
    // cleared the owner it had just set.
    request.mockImplementation((route: string) =>
      route.startsWith('PATCH')
        ? Promise.resolve({ status: 204 })
        : Promise.resolve({ data: [{ property_name: 'DRI', value: 'IvanRoslov' }] }),
    );

    expect(await source().setDri('acme/acme-ui', 'octocat')).toBe('IvanRoslov');
  });

  /**
   * Every status the dri write can answer with, in one table (#584).
   *
   * The classifier replaced a hand-rolled `writeRefusal`, and this is what makes
   * that a comparison rather than a hope: the table was written against the OLD
   * body, watched to pass, and only then was the body replaced. Two entries
   * moved, and each is marked where it sits.
   */
  const driStatuses: { name: string; err: Error; status: number }[] = [
    { name: 'a bare 403 is a refusal', err: githubError(403, 'Resource not accessible'), status: 403 },
    // MOVED (#584 task 1). The old body folded 404 into 403 unconditionally, so a
    // repo that genuinely is not there was answered as a refusal. The classifier
    // has earned nothing about this 404 yet, so it answers 404. Task 5's re-read
    // is what earns the 403 back for the missing-permission half of that fold.
    { name: 'a 404 is not-found, until a re-read earns otherwise', err: githubError(404, 'Not Found'), status: 404 },
    { name: 'a 401 answers 403, never 401', err: githubError(401, 'Bad credentials'), status: 403 },
    { name: 'a 422 is the value, not the permission', err: githubError(422, 'Unprocessable Entity'), status: 400 },
    {
      name: 'a retry-after 403 is retryable',
      err: githubError(403, 'rate limited', { 'retry-after': '60' }),
      status: 502,
    },
    {
      name: 'an exhausted-quota 403 is retryable',
      err: githubError(403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0' }),
      status: 502,
    },
    {
      name: 'a retry-after 429 is retryable',
      err: githubError(429, 'rate limited', { 'retry-after': '60' }),
      status: 502,
    },
    {
      name: 'an exhausted-quota 429 is retryable',
      err: githubError(429, 'Too Many Requests', { 'x-ratelimit-remaining': '0' }),
      status: 502,
    },
    // MOVED (#584 task 1). A secondary rate limit carries no throttle header at
    // all — only the body says so — so the old `isThrottled` read it as a
    // permanent refusal and withdrew the Retry that would have worked. It is
    // retryable now, which is what the throttle fix said and could not see.
    {
      name: 'a secondary rate limit is retryable, and it has no throttle headers',
      err: githubError(403, 'You have exceeded a secondary rate limit', { 'x-ratelimit-remaining': '4988' }),
      status: 502,
    },
    {
      name: 'a 403 with quota left is still a real refusal',
      err: githubError(403, 'Resource not accessible', { 'x-ratelimit-remaining': '4823' }),
      status: 403,
    },
    { name: 'a 500 is retryable', err: githubError(500, 'Internal Server Error'), status: 502 },
    { name: 'a 502 is retryable', err: githubError(502, 'Bad gateway'), status: 502 },
    { name: 'no status at all is retryable', err: new Error('socket hang up'), status: 502 },
  ];

  it.each(driStatuses)('$name', async ({ err, status }) => {
    request.mockRejectedValue(err);
    const answered = await source()
      .setDri('acme/acme-memory', 'IvanRoslov')
      .then(
        () => -1,
        (e: unknown) => (e as HttpException).getStatus(),
      );
    expect(answered).toBe(status);
  });

  // The per-status refusal tests that used to sit here are the rows of
  // `driStatuses` above (#584). They asserted the exception CLASS; the classifier
  // answers with an `HttpException` carrying a structured body, so the status is
  // what a client actually sees and what the table reads.

  it('logs the permission Github named, and never answers with it', async () => {
    // The one operator-facing value the classifier exists to extract. #577 spent
    // its life in a response header nothing read; a refusal that does not reach
    // a log has not been extracted, it has been discarded one layer later. It
    // must reach the log and it must NOT reach the client — it describes the
    // board's credential, which is no caller's business.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    request.mockRejectedValue(
      githubError(403, 'Resource not accessible by personal access token', {
        'x-accepted-github-permissions': 'organization_custom_properties=write',
      }),
    );

    const body = await source()
      .setDri('acme/acme-memory', 'IvanRoslov')
      .then(() => null, (e: unknown) => (e as HttpException).getResponse());

    expect(warn.mock.calls.map(String).join('\n')).toContain(
      'organization_custom_properties=write',
    );
    expect(JSON.stringify(body)).not.toContain('organization_custom_properties');
    warn.mockRestore();
  });

  it('says “no permission named” by staying quiet when Github named none', async () => {
    // The vacuity guard on the test above: a log line that always carried the
    // phrase would pass it whatever the classifier did.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    request.mockRejectedValue(githubError(403, 'Resource not accessible'));

    await source().setDri('acme/acme-memory', 'IvanRoslov').catch(() => undefined);

    expect(warn.mock.calls.map(String).join('\n')).not.toContain('wanted');
    warn.mockRestore();
  });

  /**
   * What the write TEACHES, as against what it answers (#584 task 5).
   *
   * The middle pair is the point: same status, same capability, one re-read
   * apart, opposite dispositions. An implementation that always learns from a
   * 404 fails the first; one that never does fails the second.
   */
  describe('and teaching the registry what Github refused', () => {
    /** Records what the source taught, so each test asserts a call list rather
     *  than a spy's internals. */
    const recorder = () => {
      const calls: { cap: string; target?: string; reason: string }[] = [];
      return {
        calls,
        registry: {
          recordRefusal: (cap: string, r: { reason: string }, target?: string) =>
            calls.push({ cap, target, reason: r.reason }),
          recordSuccess: vi.fn(),
        } as unknown as CapabilityRegistry,
      };
    };

    /** The existing `source()` with a registry, so the sites that do not care
     *  keep calling the one-argument helper unchanged. */
    const sourceWith = (registry: CapabilityRegistry) =>
      new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' }), registry);

    it('a refused dri write teaches the registry, keyed on the repo', async () => {
      const { calls, registry } = recorder();
      request.mockRejectedValueOnce(githubError(403, 'Forbidden'));

      await expect(sourceWith(registry).setDri('acme/board', 'octocat')).rejects.toThrow();

      expect(calls).toEqual([
        { cap: 'repo.dri', target: 'acme/board', reason: 'not-permitted' },
      ]);
    });

    it('a 404 dri write re-reads the repo before it teaches anything', async () => {
      const { calls, registry } = recorder();
      // The write 404s AND the repo is not there → the target is genuinely
      // absent, and a caller naming a repo that does not exist must not darken
      // the capability for everyone.
      request.mockRejectedValueOnce(githubError(404, 'Not Found'));
      get.mockRejectedValueOnce(githubError(404, 'Not Found'));

      await expect(sourceWith(registry).setDri('acme/nope', 'octocat')).rejects.toThrow();

      expect(calls).toEqual([]);
    });

    it('…and teaches when the re-read succeeds — the #577 shape', async () => {
      const { calls, registry } = recorder();
      request.mockRejectedValueOnce(githubError(404, 'Not Found'));
      get.mockResolvedValueOnce({ data: { name: 'board' } }); // the repo IS there

      const answered = await sourceWith(registry)
        .setDri('acme/board', 'octocat')
        .then(() => -1, (e: unknown) => (e as HttpException).getStatus());

      expect(calls).toEqual([
        { cap: 'repo.dri', target: 'acme/board', reason: 'not-permitted' },
      ]);
      // The behaviour change this task lands: a write that 404s on a repo the
      // board can still read answers 403, where it answered 404 a task ago.
      expect(answered).toBe(403);
    });

    it('re-reads the repo it wrote to, in the org it wrote to', async () => {
      // The re-read is what decides whether a 404 meant "no such repo" or "no
      // permission". Asked about the first configured org's repo of the same
      // name it would answer about a different repository — and `design-system`
      // exists under both orgs on real Github, so it would answer 200 and turn
      // an absence into a refusal.
      const { registry } = recorder();
      request.mockRejectedValueOnce(githubError(404, 'Not Found'));
      get.mockRejectedValueOnce(githubError(404, 'Not Found'));

      await expect(
        new GithubReposSource(cfg({ GITHUB_ORGS: 'acme,globex' }), registry).setDri(
          'globex/design-system',
          'octocat',
        ),
      ).rejects.toThrow();

      expect(get).toHaveBeenCalledWith({ owner: 'globex', repo: 'design-system' });
    });

    it('a landed dri write tells the registry the capability is available', async () => {
      const { registry } = recorder();
      roundTrip('octocat');

      await sourceWith(registry).setDri('acme/board', 'octocat');

      expect(registry.recordSuccess).toHaveBeenCalledWith('repo.dri', 'acme/board');
    });
  });
});

/**
 * One row of `GET /orgs/{org}/properties/schema`, the LIST, as Github returns
 * it. The default row is the one acme actually has.
 */
const schemaRow = (over: Record<string, unknown> = {}) => ({
  property_name: 'dri',
  value_type: 'single_select',
  allowed_values: ['octocat', 'IvanRoslov', 'anton-khovanskiy'],
  values_editable_by: 'org_and_repo_actors',
  ...over,
});

describe('GithubReposSource — the dri schema the write is gated on (#577, #649)', () => {
  beforeEach(() => {
    request.mockReset();
  });

  // The whole table this describe block encodes, measured against real Github
  // on 2026-08-20 with one token, so it can be re-run:
  //
  //   org          LIST /orgs/{org}/properties/schema   single …/schema/dri
  //   acme   200, 1 property                      200
  //   globex     200, 1 property                      200
  //   selgeo       200, ZERO properties                 404
  //   github       404                                  404
  //
  // The single-property read answers 404 for both selgeo and github and cannot
  // tell them apart. The list can: selgeo is `absent`, github is `unreadable`.
  it('reads the LIST, and never the single-property address', async () => {
    request.mockResolvedValue({ data: [schemaRow()] });

    await source().driSchema('acme');

    expect(request).toHaveBeenCalledWith('GET /orgs/{org}/properties/schema', { org: 'acme' });
    // The address is the point, not an implementation detail: `…/schema/dri`
    // 404s for selgeo and for github alike, so a source still calling it cannot
    // report `absent` from `unreadable` however carefully it reads the answer.
    const routes = request.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(routes.some((r: string) => r.includes('{property_name}') || r.includes('/schema/dri'))).toBe(false);
  });

  it('reads the schema of the org it was given, not the one its map is built from', async () => {
    // The schema carries `allowed_values` and `values_editable_by` — the two
    // facts a write is judged on. Read from the first configured org while the
    // write is aimed at the second, and the judgement is about the wrong org.
    request.mockResolvedValue({ data: [schemaRow()] });

    await sourceFor(['acme', 'globex']).driSchema('globex');

    expect(request).toHaveBeenCalledWith('GET /orgs/{org}/properties/schema', { org: 'globex' });
  });

  it('finds the dri row whatever case the org spelled the property name in', async () => {
    // An org that named it `DRI` read as having no such property at all —
    // `absent`, which is SETTLED, so the board would never look again and every
    // owner control on that org would stay hidden for good.
    request.mockResolvedValue({ data: [schemaRow({ property_name: 'DRI', allowed_values: ['octocat'] })] });

    expect(await source().driSchema('acme')).toEqual({
      allowedValues: ['octocat'],
      writability: 'writable',
    });
  });

  it('reads the allowed values and who may edit them from one schema call', async () => {
    request.mockResolvedValue({ data: [schemaRow()] });

    const schema = await source().driSchema('acme');

    expect(schema).toEqual({
      allowedValues: ['octocat', 'IvanRoslov', 'anton-khovanskiy'],
      writability: 'writable',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('picks the dri row out of a list that carries other properties too', async () => {
    // An org whose schema list has grown. The row is found by `property_name`,
    // never by position — `rows[0]` would read the wrong property's values and
    // its writability, which is a wrong ANSWER, not a missing one.
    request.mockResolvedValue({
      data: [
        schemaRow({ property_name: 'tier', allowed_values: ['gold'], values_editable_by: 'org_actors' }),
        schemaRow({ allowed_values: ['octocat'] }),
      ],
    });

    expect(await source().driSchema('acme')).toEqual({ allowedValues: ['octocat'], writability: 'writable' });
  });

  it('reports the property RESTRICTED when the org keeps it to its owners', async () => {
    request.mockResolvedValue({
      data: [schemaRow({ allowed_values: ['octocat'], values_editable_by: 'org_actors' })],
    });

    const schema = await source().driSchema('acme');

    expect(schema).toEqual({ allowedValues: ['octocat'], writability: 'restricted' });
  });

  it('reports ABSENT — not unknown, not restricted — for a list with no dri row', async () => {
    // selgeo's shape: `GET /orgs/selgeo/properties/schema` answers 200 with an
    // empty array. The org is readable and simply has no such property. That is
    // a fact about the org, so it is settled: no retry creates a property, and
    // `restricted` would be a different fact — one about the org's permissions,
    // which this answer says nothing about.
    for (const data of [[], [schemaRow({ property_name: 'tier' })]]) {
      request.mockResolvedValue({ data });
      expect(await source().driSchema('acme')).toEqual({ allowedValues: [], writability: 'absent' });
    }
  });

  it('reports UNREADABLE — never absent — when the list read throws', async () => {
    // THE test of this split. github's shape: the list 404s because the token
    // may not see the org at all. Filing that as `absent` would have the board
    // state the org has no `dri` property when all it knows is that its own
    // token cannot look — #577's error inverted, and permanent, because
    // `absent` is settled and never re-read.
    //
    // 401 and 403 go the same way, and so do a rate limit and a dropped socket:
    // nothing about a read that did not arrive is a fact about the org.
    const failures = [
      githubError(401, 'Bad credentials'),
      githubError(403, 'Resource not accessible'),
      githubError(404, 'Not Found'),
      githubError(429, 'rate limited'),
      githubError(500, 'Server Error'),
      new Error('socket hang up'),
    ];
    for (const err of failures) {
      request.mockRejectedValue(err);
      expect(await source().driSchema('acme')).toEqual({ allowedValues: [], writability: 'unreadable' });
    }
  });

  it('needs no throttle check on the read, because every failed read is the same', async () => {
    // The write path still has to tell a throttle from a refusal — it answers
    // them with different statuses. The read does not: both are `unreadable`,
    // so a rate limit needs no special case here to come out right.
    const throttles = [
      githubError(403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0' }),
      githubError(429, 'secondary rate limit', { 'retry-after': '60' }),
      githubError(403, 'Resource not accessible', { 'x-ratelimit-remaining': '4823' }),
    ];
    for (const err of throttles) {
      request.mockRejectedValue(err);
      expect(await source().driSchema('acme')).toEqual({ allowedValues: [], writability: 'unreadable' });
    }
  });

  it('reports RESTRICTED when values_editable_by is absent or null', async () => {
    // Verified against this repo's own @octokit/openapi-types: the field is
    // `?: "org_actors" | "org_and_repo_actors" | null`, and Github documents the
    // default when unspecified as `org_actors`. So absent IS a successful read
    // of a real setting — not a gap, and not a missing property either: the row
    // is right there.
    for (const value of [undefined, null]) {
      request.mockResolvedValue({ data: [schemaRow({ allowed_values: ['octocat'], values_editable_by: value })] });
      expect(await source().driSchema('acme')).toEqual({ allowedValues: ['octocat'], writability: 'restricted' });
    }
  });

  it('reports UNKNOWN for a value that names something on Object.prototype', async () => {
    // The lookup is keyed by a string that arrives in Github's JSON. Against a
    // plain object literal, "constructor" and friends resolve to inherited
    // members — truthy, so the `?? 'unknown'` fallback never fires, the
    // unrecognised-value warning never logs, and a non-OwnerWritability value
    // reaches `ReposView.ownerWritability` and the guard.
    //
    // That let the write through until #649's switch made the guard's default
    // refuse. It now costs the answer instead: a state nobody defined on the
    // view, and a 502 claiming the schema could not be read when it was read
    // fine. `unknown` is the state that describes what actually happened.
    for (const value of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      request.mockResolvedValue({ data: [schemaRow({ allowed_values: ['octocat'], values_editable_by: value })] });
      expect(await source().driSchema('acme')).toEqual({ allowedValues: ['octocat'], writability: 'unknown' });
    }
  });

  it('reports UNKNOWN for a values_editable_by it does not recognise', async () => {
    // An enum Github adds later, or the empty string, which Github documents
    // nowhere. This is now ALL that `unknown` means: the list read, the row was
    // there, and its one field held a string this code has no mapping for. A
    // read that failed is `unreadable`, and a property that is not there is
    // `absent` — neither of them arrives here any more.
    for (const value of ['', 'org_and_repo_actors_v2']) {
      request.mockResolvedValue({ data: [schemaRow({ allowed_values: ['octocat'], values_editable_by: value })] });
      expect(await source().driSchema('acme')).toEqual({ allowedValues: ['octocat'], writability: 'unknown' });
    }
  });

  it('warns about the unrecognised value, and says nothing about a failed read', async () => {
    // `unknown` used to be where a failed read landed, so its log line is the
    // one place the old meaning would survive the split unnoticed. What it says
    // has to match what happened: the read arrived.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    request.mockResolvedValue({ data: [schemaRow({ values_editable_by: 'org_and_repo_actors_v2' })] });

    await source().driSchema('acme');

    const logged = warn.mock.calls.map(String).join('\n');
    expect(logged).toContain('unrecognised values_editable_by');
    expect(logged).toContain('org_and_repo_actors_v2');
    expect(logged).not.toContain('failed');
    warn.mockRestore();
  });

  it('warns that the READ failed when it did, and names no property state', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    request.mockRejectedValue(githubError(404, 'Not Found'));

    await source().driSchema('acme');

    const logged = warn.mock.calls.map(String).join('\n');
    expect(logged).toContain('read failed');
    expect(logged).toContain('404');
    // The 404 that started #649: it must not be logged as the org lacking the
    // property, because that is exactly what the board cannot tell from here.
    expect(logged).not.toContain('unrecognised');
    warn.mockRestore();
  });

  it('a body that is not a list is UNREADABLE, and never escapes as a throw', async () => {
    // Two things at once, both new with the list read.
    //
    // `driSchema` could not throw before #649: every failure came back as a
    // state. It is awaited inside `ReposService.refresh`'s `Promise.all`, which
    // has no catch and treats a rejection as a failed refresh — so a body that
    // is not an array would take the WHOLE repo map down, not just the owner
    // control on it.
    //
    // And the state it settles on has to be `unreadable`. `absent` is a claim
    // about the org, and a body this code cannot parse is not a fact about the
    // org — it is the board failing to read, which is the whole distinction
    // this issue turns on.
    for (const data of [null, undefined, {}, { properties: [] }, 'nope', 42]) {
      request.mockResolvedValue({ data });
      expect(await source().driSchema('acme'), `body ${JSON.stringify(data)}`).toEqual({
        allowedValues: [],
        writability: 'unreadable',
      });
    }
  });

  it('a row that is not the dri row never supplies its values', async () => {
    // The `absent` return carries an EMPTY allowed list. Handing back some other
    // property's `allowed_values` would have the owner picker offer logins the
    // dri property never allowed — and `absent` is settled, so the wrong list
    // would sit on the view for its whole TTL.
    request.mockResolvedValue({
      data: [schemaRow({ property_name: 'tier', allowed_values: ['gold', 'silver'] })],
    });

    expect(await source().driSchema('acme')).toEqual({ allowedValues: [], writability: 'absent' });
  });
});

describe('GithubReposSource — the repo page reads (#575)', () => {
  const source = () =>
    new GithubReposSource(cfg({ GITHUB_ORGS: 'acme' }) as unknown as ConfigService);

  beforeEach(() => {
    request.mockReset();
    graphql.mockReset();
  });

  describe('readme', () => {
    it('decodes the README the repo actually names, whatever it is called', async () => {
      request.mockResolvedValue({
        data: { name: 'readme.markdown', content: Buffer.from('# Board\n').toString('base64'), encoding: 'base64' },
      });
      expect(await source().readme('acme/board')).toEqual({
        state: 'present',
        markdown: '# Board\n',
      });
      // The endpoint that resolves the name — never a hardcoded README.md path,
      // which misses a repo whose file is called something else.
      const [route, params] = request.mock.calls[0];
      expect(route).toBe('GET /repos/{owner}/{repo}/readme');
      expect(params).toMatchObject({ owner: 'acme', repo: 'board' });
    });

    it('reports a repo with no README as ABSENT, which is not a failure', async () => {
      request.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
      expect(await source().readme('acme/status')).toEqual({ state: 'absent' });
    });

    it('reports a refused read as UNREADABLE, never as absent', async () => {
      request.mockRejectedValue(Object.assign(new Error('Bad credentials'), { status: 401 }));
      expect(await source().readme('acme/status')).toEqual({ state: 'unreadable' });
    });

    it('reports a body Github would not encode as UNREADABLE, not as an empty README', async () => {
      // Over 1 MB, Github answers `encoding: "none"` with an empty content
      // string. Taking that at face value draws a repo's README as blank.
      request.mockResolvedValue({ data: { name: 'README.md', content: '', encoding: 'none' } });
      expect(await source().readme('acme/acme')).toEqual({ state: 'unreadable' });
    });
  });

  describe('pullRequests', () => {
    const page = (nodes: unknown[], hasNextPage: boolean, open = 1, closed = 312, openNodes: unknown[] = []) => ({
      repository: {
        openPRs: { totalCount: open, nodes: openNodes },
        closedPRs: { totalCount: closed },
        recent: { pageInfo: { hasNextPage, endCursor: 'cursor' }, nodes },
      },
    });
    const node = (
      number: number,
      createdAt: string,
      updatedAt: string,
      mergedAt: string | null = null,
      author: { login: string; __typename: string } | null = null,
    ) => ({
      number,
      createdAt,
      updatedAt,
      mergedAt,
      // Github closes a PR when it merges it, so a merged node carries both.
      closedAt: mergedAt,
      author,
    });
    /** An author as GraphQL answers it. `__typename` is what tells a person from
     *  a machine, and it is asked for rather than guessed at from the login. */
    const user = (login: string) => ({ login, __typename: 'User' });
    const bot = (login: string) => ({ login, __typename: 'Bot' });
    const openNode = (
      number: number,
      createdAt: string,
      author: { login: string; __typename: string } | null,
      isDraft = false,
    ) => ({
      number,
      title: `PR #${number}`,
      url: `https://github.com/acme/board/pull/${number}`,
      createdAt,
      isDraft,
      author,
    });
    /** The arguments one aliased connection is asked for, so an assertion about
     *  ONE connection's ordering cannot be answered by another connection's.
     *  The whole document contains both orderings now (#828). */
    const argsOf = (query: string, alias: string): string =>
      new RegExp(`${alias}: pullRequests\\(([^)]*)\\)`).exec(query)?.[1] ?? '';
    /** Everything one aliased connection asks for, up to where the next one
     *  starts — arguments and selection together. Same reason as `argsOf`: both
     *  connections select an author now, so an assertion naming one of them must
     *  not be answerable by the other. */
    const blockOf = (query: string, alias: string): string => {
      const start = query.indexOf(`${alias}: pullRequests`);
      if (start < 0) return '';
      const rest = query.slice(start + alias.length);
      const ends = ['openPRs:', 'closedPRs:', 'recent:'].map((a) => rest.indexOf(a)).filter((i) => i >= 0);
      return rest.slice(0, ends.length ? Math.min(...ends) : rest.length);
    };

    it('carries both totals and the records, in ONE call when the page reaches back far enough', async () => {
      graphql.mockResolvedValueOnce(
        page([node(9, '2026-08-10T00:00:00Z', '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z'),
              node(8, '2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z')], true),
      );
      const read = await source().pullRequests('acme/board', '2026-06-05T00:00:00Z');
      expect(read).toEqual({
        state: 'read',
        open: 1,
        closedMerged: 312,
        coveredFrom: '2026-05-02T00:00:00Z',
        prs: [
          { number: 9, createdAt: '2026-08-10T00:00:00Z', mergedAt: '2026-08-12T00:00:00Z', closedAt: '2026-08-12T00:00:00Z', author: null, authorIsBot: false },
          { number: 8, createdAt: '2026-05-01T00:00:00Z', mergedAt: null, closedAt: null, author: null, authorIsBot: false },
        ],
        openPrs: [],
      });
      expect(graphql).toHaveBeenCalledTimes(1);
    });

    it('orders by UPDATED_AT so a PR opened long ago and merged this week is not missed', async () => {
      graphql.mockResolvedValueOnce(page([node(1, '2026-01-01T00:00:00Z', '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z')], false));
      await source().pullRequests('acme/board', '2026-06-05T00:00:00Z');
      const [query] = graphql.mock.calls[0];
      // CREATED_AT ordering stops paginating at the window's edge, and a PR
      // created before it that merged inside it never appears at all. Asserted
      // against the `recent` connection's OWN arguments: since #828 the
      // document also carries an `openPRs` list that is ordered by CREATED_AT
      // on purpose, and a test reading the whole query would be answered by
      // that one and stay green over a `recent` that had been reordered.
      const recent = argsOf(query as string, 'recent');
      expect(recent).toContain('UPDATED_AT');
      expect(recent).not.toContain('CREATED_AT');
      // The list, the other way round and for the opposite reason: what is open
      // NOW, newest first, whether or not anybody has touched it since.
      const openArgs = argsOf(query as string, 'openPRs');
      expect(openArgs).toContain('CREATED_AT');
      expect(openArgs).toContain('states:OPEN');
    });

    it('reads the open list off its own connection, in ONE request (#828)', async () => {
      graphql.mockResolvedValueOnce(
        page([node(1, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z')], false, 2, 312, [
          openNode(9, '2026-08-10T00:00:00Z', user('octocat'), true),
          // A ghost account: Github answers a deleted user's PR with no author.
          openNode(4, '2026-01-04T00:00:00Z', null),
        ]),
      );
      const read = await source().pullRequests('acme/board', '2026-06-05T00:00:00Z');
      if (read.state !== 'read') throw new Error('expected a read');
      expect(read.openPrs).toEqual([
        {
          number: 9,
          title: 'PR #9',
          htmlUrl: 'https://github.com/acme/board/pull/9',
          createdAt: '2026-08-10T00:00:00Z',
          author: 'octocat',
          authorIsBot: false,
          draft: true,
        },
        {
          number: 4,
          title: 'PR #4',
          htmlUrl: 'https://github.com/acme/board/pull/4',
          // Older than the window the records cover, and on the list anyway:
          // the stale open PRs are what somebody opens this tab to find.
          createdAt: '2026-01-04T00:00:00Z',
          author: null,
          // A ghost account is a person nobody can name any more, never a bot.
          authorIsBot: false,
          draft: false,
        },
      ]);
      // The list rides the query the totals already came on. A second request
      // here would be a repo page costing another round trip per page walked.
      expect(graphql).toHaveBeenCalledTimes(1);
    });

    it('asks for the payload’s own cap, so the two cannot drift (#828)', async () => {
      graphql.mockResolvedValueOnce(page([], false));
      await source().pullRequests('acme/board', '2026-06-05T00:00:00Z');
      const [query, variables] = graphql.mock.calls[0];
      // A variable, not a number in the document: interpolating one would widen
      // `PR_QUERY` from a string literal to `string`, which the write census
      // reads as a document assembled at run time.
      expect(argsOf(query as string, 'openPRs')).toContain('first:$openFirst');
      expect((variables as { openFirst: number }).openFirst).toBe(OPEN_PRS_CAP);
    });

    it('carries each record’s author, which the members list counts (#828)', async () => {
      graphql.mockResolvedValueOnce(
        page(
          [
            node(3, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', null, user('IvanRoslov')),
            node(2, '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', null, null),
          ],
          false,
        ),
      );
      const read = await source().pullRequests('acme/board', '2026-06-05T00:00:00Z');
      if (read.state !== 'read') throw new Error('expected a read');
      expect(read.prs.map((p) => p.author)).toEqual(['IvanRoslov', null]);
    });

    it('says it covers the whole history when Github reports no further page', async () => {
      graphql.mockResolvedValueOnce(page([node(1, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z')], false));
      const read = await source().pullRequests('acme/status', '2026-06-05T00:00:00Z');
      expect(read).toMatchObject({ state: 'read', coveredFrom: null });
    });

    it('pages until the window is covered, and reports its reach when the cap stops it first', async () => {
      // Every page is newer than the window's start, so the read can only stop
      // at the cap — and must then say how far back it actually got.
      graphql.mockImplementation(async () =>
        page([node(1, '2026-08-11T00:00:00Z', '2026-08-12T00:00:00Z')], true),
      );
      const read = await source().pullRequests('acme/board', '2026-06-05T00:00:00Z');
      // Exactly the cap, not "more than one and not too many": a range would
      // pass a regression that stopped after two pages, and stopping early is
      // indistinguishable from a quiet repo except through `coveredFrom`.
      expect(graphql).toHaveBeenCalledTimes(6);
      expect(read).toMatchObject({ state: 'read', coveredFrom: '2026-08-12T00:00:00Z' });
    });

    it('reads the author’s TYPE off Github rather than guessing it from the login (#828)', async () => {
      // Live on acme/board, 2026-09-03: all 8 open PRs are
      // dependabot's. Counting them as somebody's work ranked a machine second
      // on that repo's members tab, above a teammate. `__typename` states it;
      // a `[bot]` suffix would only guess, and the login here deliberately has
      // no suffix to guess from.
      graphql.mockResolvedValueOnce(
        page(
          [
            node(3, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', null, bot('dependabot')),
            node(2, '2026-07-20T00:00:00Z', '2026-07-21T00:00:00Z', null, user('octocat')),
          ],
          false,
          2,
          423,
          [openNode(9, '2026-08-10T00:00:00Z', bot('dependabot')), openNode(8, '2026-08-09T00:00:00Z', user('octocat'))],
        ),
      );
      const read = await source().pullRequests('acme/board', '2026-06-05T00:00:00Z');
      if (read.state !== 'read') throw new Error('expected a read');
      expect(read.prs.map((p) => [p.author, p.authorIsBot])).toEqual([
        ['dependabot', true],
        ['octocat', false],
      ]);
      // The bot's PR is still ON the open list — it is open and somebody has to
      // close it. The flag marks it; it never removes it.
      expect(read.openPrs.map((p) => [p.author, p.authorIsBot])).toEqual([
        ['dependabot', true],
        ['octocat', false],
      ]);
    });

    it('asks for the author type on BOTH selections', async () => {
      graphql.mockResolvedValueOnce(page([], false));
      await source().pullRequests('acme/board', '2026-06-05T00:00:00Z');
      const [query] = graphql.mock.calls[0];
      // Both, because the records feed the members counts and the open list
      // feeds the tab's mark. A document asking on one would leave the other
      // reading `undefined`, which is `false`, which is "a person".
      expect(blockOf(query as string, 'openPRs')).toContain('author{ login __typename }');
      expect(blockOf(query as string, 'recent')).toContain('author{ login __typename }');
      // And the two blocks really are apart: `mergedAt` is `recent`'s alone, so
      // a `blockOf` that ran on past its connection would carry it here.
      expect(blockOf(query as string, 'openPRs')).not.toContain('mergedAt');
      // Every close, not only the merges (#962): `openPrsAt` winds the open
      // count back with it, and without it every closed-unmerged PR would read
      // as never closed, which drops it from the count it was open in.
      expect(blockOf(query as string, 'recent')).toContain('closedAt');
    });

    it('is UNREADABLE when Github refuses, and costs nothing else', async () => {
      graphql.mockRejectedValue(new Error('Bad credentials'));
      expect(await source().pullRequests('acme/status', '2026-06-05T00:00:00Z')).toEqual({
        state: 'unreadable',
      });
    });
  });

  describe('actionsUsage', () => {
    const usageRow = (over: Record<string, unknown> = {}) => ({
      date: '2026-08-01T00:00:00Z',
      product: 'actions',
      sku: 'Actions Linux',
      quantity: 1383,
      unitType: 'Minutes',
      pricePerUnit: 0.006,
      grossAmount: 8.3,
      netAmount: 7.48,
      organizationName: 'acme',
      repositoryName: 'board',
      ...over,
    });

    it('reads the whole org once per month and keeps only Actions MINUTES', async () => {
      request.mockResolvedValue({
        data: {
          usageItems: [
            usageRow(),
            usageRow({ repositoryName: 'acme-docs', quantity: 293, netAmount: 0 }),
            // Same product, not CI spend: storage is charged in GigabyteHours.
            usageRow({ sku: 'Actions storage', unitType: 'GigabyteHours', quantity: 0.045, netAmount: 0.1 }),
            // Another product entirely, riding the same payload.
            usageRow({ product: 'ghas', unitType: 'UserMonths', quantity: 3, netAmount: 57 }),
          ],
        },
      });
      const read = await source().actionsUsage([{ year: 2026, month: 8 }]);
      expect(read?.days).toEqual([
        { full: 'acme/board', date: '2026-08-01T00:00:00Z', minutes: 1383, netUsd: 7.48 },
        { full: 'acme/acme-docs', date: '2026-08-01T00:00:00Z', minutes: 293, netUsd: 0 },
      ]);
      expect(read?.orgs).toEqual(['acme']);
      const [route, params] = request.mock.calls[0];
      expect(route).toBe('GET /organizations/{org}/settings/billing/usage');
      expect(params).toMatchObject({ org: 'acme', year: 2026, month: 8 });
    });

    it('asks once per month named, and no more', async () => {
      request.mockResolvedValue({ data: { usageItems: [] } });
      await source().actionsUsage([
        { year: 2026, month: 6 },
        { year: 2026, month: 7 },
        { year: 2026, month: 8 },
      ]);
      expect(request).toHaveBeenCalledTimes(3);
      expect(request.mock.calls.map((c) => (c[1] as { month: number }).month)).toEqual([6, 7, 8]);
    });

    it('answers NULL for a 200 with no usageItems array, never an empty month', async () => {
      // `[]` would cache as a GOOD read and draw every repo in the org as
      // having run nothing for a whole TTL. An absent key is the shape moving
      // under us, which is not a fact about anybody's CI.
      for (const body of [{}, { usageItems: null }, { usageItems: 'nope' }]) {
        request.mockReset();
        request.mockResolvedValue({ data: body });
        expect(await source().actionsUsage([{ year: 2026, month: 8 }])).toBeNull();
      }
    });

    it('answers NULL when Github starts paginating this endpoint', async () => {
      // Verified live that it does not paginate today, which is exactly why
      // nothing here pages. If that changes, this read holds page one, and a
      // shortfall would surface as minutes nobody ran.
      request.mockResolvedValue({
        data: { usageItems: [usageRow()] },
        headers: { link: '<https://api.github.com/...&page=2>; rel="next"' },
      });
      expect(await source().actionsUsage([{ year: 2026, month: 8 }])).toBeNull();
    });

    it('answers NULL for a row whose numbers are not numbers', async () => {
      // Never seen live (0 of 1420 rows), which is why coalescing it to 0 would
      // never be noticed — and 0 minutes is what the page draws as "nothing
      // ran".
      request.mockResolvedValue({ data: { usageItems: [usageRow({ quantity: null })] } });
      expect(await source().actionsUsage([{ year: 2026, month: 8 }])).toBeNull();
      request.mockResolvedValue({ data: { usageItems: [usageRow({ netAmount: undefined })] } });
      expect(await source().actionsUsage([{ year: 2026, month: 8 }])).toBeNull();
    });

    it('answers NULL when a month cannot be read, rather than a total missing that month', async () => {
      request
        .mockResolvedValueOnce({ data: { usageItems: [usageRow()] } })
        .mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
      expect(await source().actionsUsage([{ year: 2026, month: 7 }, { year: 2026, month: 8 }])).toBeNull();
    });
  });
});

/**
 * #647 — the org comes from the one resolver, so an unset key follows
 * `GITHUB_ORGS` instead of enumerating nothing.
 *
 * `ISSUES_METRICS_ORG` lost its `.default('acme')` when the four org keys
 * were collapsed onto one list, and the key itself is retired (#1209 part 4).
 * Read raw, an unset key would have handed this source `''`, and an empty org
 * enumerates NO repo — a Repos map with nothing on it, served with a 200.
 */
describe('GithubReposSource — the org is resolved, never read raw (#647)', () => {
  // Every describe above resets the fake it drives. This one did not, so its
  // calls piled up on whatever ran before it — invisible while each test only
  // asked whether a call it wanted was in the list, and a false failure the
  // moment one asks which calls were made.
  beforeEach(() => {
    paginate.mockReset();
    get.mockReset();
  });

  it('follows GITHUB_ORGS, which is the whole answer', async () => {
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string }) =>
      params?.org === 'globex' ? ORG_REPOS : [],
    );
    const { repos } = await new GithubReposSource(cfg({ GITHUB_ORGS: 'globex' })).listRepos();
    expect(repos.length).toBeGreaterThan(0);
    expect(paginate.mock.calls.map((c) => (c[1] as { org?: string })?.org).filter(Boolean)).toContain(
      'globex',
    );
  });

  it('enumerates nothing when the owner scope names no org', async () => {
    // `ISSUES_METRICS_ORG=''` turned enumeration off and is retired (#1209 part
    // 4). A person whose Github App grants cover no owner reaches the same
    // state, and an empty map is still the honest answer.
    paginate.mockImplementation(async () => ORG_REPOS);
    const noGrants = {
      key: 'person', email: 'a@example.test', login: 'a', token: 'synthetic',
      owners: [], repositories: [], cache: new WeakMap(), permissionCache: new WeakMap(),
    } as unknown as GithubPrincipal;
    const { repos } = await githubContext.run({ principal: noGrants }, () =>
      new GithubReposSource(cfg({ GITHUB_ORGS: 'globex' })).listRepos());
    expect(repos).toEqual([]);
  });

  it('enumerates the same org set it says it serves — one set, not two (#718)', async () => {
    // This test asserted the opposite until #718: "enumerates the FIRST org
    // only, however many the deployment serves (#649)". That was the defect
    // written down as a design — #649 made the WRITE check plural and left the
    // map on `orgs[0]`, so a repo this source would happily write to could be
    // missing from the map it drew, with nothing anywhere saying so.
    //
    // What replaces it pins the two together rather than restating the union
    // (the #718 block below covers that): whatever `servedOrgs` names is
    // exactly what gets enumerated, so reads and writes cannot drift apart a
    // second time by one of them quietly narrowing.
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string }) =>
      params?.org === 'acme' ? ORG_REPOS : [],
    );

    const source = sourceFor(['acme', 'globex']);
    const { repos } = await source.listRepos();

    expect(repos.map((r) => r.full)).toEqual(['acme/acme', 'acme/board']);
    expect(paginate.mock.calls.map((c) => (c[1] as { org?: string })?.org)).toEqual([
      ...source.servedOrgs,
    ]);
  });
});

describe('GithubReposSource — an absent org key follows GITHUB_ORGS (#647)', () => {
  it('enumerates the org GITHUB_ORGS names, with no per-surface key anywhere', async () => {
    // The half of the rule this file had no test for. ABSENT is not EMPTY: an
    // absent key is a deployment that never mentioned the setting, and it covers
    // every org `GITHUB_ORGS` names — which `cfg` above pins to this file's org.
    // Nothing stands behind that key: since #1175 a deployment naming no
    // organisation is refused at boot rather than handed one.
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string }) =>
      params?.org === 'acme' ? ORG_REPOS : [],
    );
    const { repos } = await new GithubReposSource(cfg({})).listRepos();
    expect(repos.length).toBeGreaterThan(0);
  });
});

/**
 * #718 — every READ fans out over every configured org.
 *
 * `this.org = this.orgs[0]` scoped every read here to the first org a
 * deployment names, so a board serving two orgs drew one org's map and called
 * it the board. The write check was already the whole set, which is what kept
 * the gap out of sight: a repo this source would happily write to was missing
 * from the map it drew.
 *
 * One org failing may not cost the other org's answer — that is the shape #697
 * merged for the issue ingest and Delivery, and these are the same rules asked
 * of the Repos reads. Nothing read at all is still a throw, carrying every
 * org's own reason.
 */
describe('GithubReposSource — every configured org is read (#718)', () => {
  beforeEach(() => {
    paginate.mockReset();
    get.mockReset();
    request.mockReset();
  });

  const TWO = ['acme', 'globex'];

  /** One in-scope listing row, minus the fields the scope filter does not read. */
  const orgRepo = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    archived: false,
    fork: false,
    has_issues: true,
    html_url: `https://github.com/x/${name}`,
    description: null,
    pushed_at: '2026-08-11T09:15:00Z',
    default_branch: 'main',
    ...over,
  });

  const boom = (msg: string) => Object.assign(new Error(msg), { status: 403 });

  describe('the org set it says it serves', () => {
    it('names every configured org, in the configured order', () => {
      expect(sourceFor(TWO).servedOrgs).toEqual(['acme', 'globex']);
    });

    it('names the one org of a single-org deployment', () => {
      expect(sourceFor(['acme']).servedOrgs).toEqual(['acme']);
    });
  });

  describe('listRepos', () => {
    it('enumerates EVERY org, and each row carries the org it came from', async () => {
      // Different repos per org on purpose: a source that enumerated one org
      // twice, or that stamped the first org onto every row, would draw the
      // same count and the wrong keys.
      paginate.mockImplementation(async (_fn: unknown, params?: { org?: string }) =>
        params?.org === 'acme' ? [orgRepo('acme')] : [orgRepo('design-system')],
      );

      const { repos } = await sourceFor(TWO).listRepos();

      expect(repos.map((r) => r.full)).toEqual(['acme/acme', 'globex/design-system']);
      expect(paginate.mock.calls.map((c) => (c[1] as { org?: string })?.org)).toEqual(TWO);
    });

    it("keeps the org that answered when the other org's listing fails, and NAMES the one that did not", async () => {
      // The list alone cannot say which org went missing — an unreadable org
      // and a quiet one are both simply absent from it — so the answer carries
      // the org beside the rows, and the log names it too.
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      paginate.mockImplementation(async (_fn: unknown, params?: { org?: string }) => {
        if (params?.org === 'acme') throw boom('acme listing refused');
        return [orgRepo('design-system')];
      });

      const read = await sourceFor(TWO).listRepos();

      expect(read.repos.map((r) => r.full)).toEqual(['globex/design-system']);
      expect(read.unreadableOrgs).toEqual(['acme']);
      expect(warn.mock.calls.map(String).join('\n')).toContain('acme');
      warn.mockRestore();
    });

    it('says nothing was lost when every org answered', async () => {
      paginate.mockImplementation(async (_fn: unknown, params?: { org?: string }) =>
        params?.org === 'acme' ? [orgRepo('acme')] : [orgRepo('design-system')],
      );
      expect((await sourceFor(TWO).listRepos()).unreadableOrgs).toEqual([]);
    });

    it('throws carrying EVERY reason when no org could be listed', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      paginate.mockImplementation(async (_fn: unknown, params?: { org?: string }) => {
        throw boom(`${params?.org} listing refused`);
      });

      const err = await sourceFor(TWO)
        .listRepos()
        .then(() => null, (e: unknown) => e as Error);

      expect(err?.message).toContain('acme listing refused');
      expect(err?.message).toContain('globex listing refused');
      expect((err?.cause as Error)?.message).toBe('acme listing refused');
      vi.restoreAllMocks();
    });

    it('keeps an org that answered with NOTHING IN SCOPE, rather than throwing over the org that failed', async () => {
      // The throw is "no org answered", not "no repo came back", and with a
      // second org those part company. A new org, or one whose every repo is
      // archived, answers perfectly well and contributes no rows — testing the
      // ROWS lets it stand in for the org that failed and throws the whole map
      // away over a read that succeeded, so `GET /api/repos` 500s where it owed
      // `{"repos":[],"unreadableOrgs":["globex"]}`.
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      paginate.mockImplementation(async (_fn: unknown, params?: { org?: string }) => {
        if (params?.org === 'globex') throw boom('globex listing refused');
        return [orgRepo('old', { archived: true })];
      });

      const read = await sourceFor(TWO).listRepos();

      expect(read.repos).toEqual([]);
      expect(read.unreadableOrgs).toEqual(['globex']);
      warn.mockRestore();
    });

    it('a single-org deployment still throws when its one listing fails', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      paginate.mockRejectedValue(boom('Bad credentials'));
      await expect(sourceFor(['acme']).listRepos()).rejects.toThrow('Bad credentials');
      vi.restoreAllMocks();
    });
  });

  describe('driByRepo', () => {
    const propsOf = (org: string, rows: [string, string | null][]) =>
      rows.map(([name, dri]) => ({
        repository_full_name: `${org}/${name}`,
        properties: [{ property_name: 'dri', value: dri }],
      }));

    it("reads both orgs' owners into one map", async () => {
      paginate.mockImplementation(async (_path: unknown, params?: { org?: string }) =>
        params?.org === 'acme'
          ? propsOf('acme', [['acme', 'octocat']])
          : propsOf('globex', [['design-system', 'IvanRoslov']]),
      );

      const read = await sourceFor(TWO).driByRepo();

      expect(read.byRepo.get('acme/acme')).toBe('octocat');
      expect(read.byRepo.get('globex/design-system')).toBe('IvanRoslov');
      expect(read.unreadableOrgs).toEqual([]);
    });

    it('keeps the org that answered and NAMES the one that did not', async () => {
      // `owner: null` means the org records nobody. An org whose properties
      // read failed records nothing at all, and the two must not arrive as one
      // value — a transient outage read as "nobody owns anything" is the whole
      // reason this read used to throw on any failure.
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      paginate.mockImplementation(async (_path: unknown, params?: { org?: string }) => {
        if (params?.org === 'globex') throw boom('globex properties refused');
        return propsOf('acme', [['acme', 'octocat']]);
      });

      const read = await sourceFor(TWO).driByRepo();

      expect(read.byRepo.get('acme/acme')).toBe('octocat');
      expect(read.unreadableOrgs).toEqual(['globex']);
      expect(warn.mock.calls.map(String).join('\n')).toContain('globex');
      warn.mockRestore();
    });

    it('throws carrying EVERY reason when no org answered', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      paginate.mockImplementation(async (_path: unknown, params?: { org?: string }) => {
        throw boom(`${params?.org} properties refused`);
      });

      const err = await sourceFor(TWO)
        .driByRepo()
        .then(() => null, (e: unknown) => e as Error);

      expect(err?.message).toContain('acme properties refused');
      expect(err?.message).toContain('globex properties refused');
      expect((err?.cause as Error)?.message).toBe('acme properties refused');
      vi.restoreAllMocks();
    });

    it('a single-org deployment reads exactly as before: one call, nothing unreadable', async () => {
      paginate.mockResolvedValue(propsOf('acme', [['acme', 'octocat']]));

      const read = await sourceFor(['acme']).driByRepo();

      expect(read.byRepo.get('acme/acme')).toBe('octocat');
      expect(read.unreadableOrgs).toEqual([]);
      expect(paginate).toHaveBeenCalledTimes(1);
    });
  });

  describe('securityByRepo', () => {
    it("counts both orgs' alerts", async () => {
      paginate.mockImplementation(async (path: string, params?: { org?: string }) =>
        path === 'GET /orgs/{org}/dependabot/alerts'
          ? [depAlert(`${params?.org}/a`, 'critical')]
          : [],
      );

      const { byRepo, unreadableOrgs } = await sourceFor(TWO).securityByRepo();

      expect(byRepo.get('acme/a')?.depHigh).toBe(1);
      expect(byRepo.get('globex/a')?.depHigh).toBe(1);
      expect(unreadableOrgs).toEqual([]);
    });

    it("one org's alert list failing costs that org's signal and NAMES that org", async () => {
      // Absence from the map is what a clean repo looks like, so an org whose
      // alert list failed would otherwise be served as an org with no alerts —
      // a clean bill of health for repos nobody read. The org list is the only
      // place that difference can be read.
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      paginate.mockImplementation(async (path: string, params?: { org?: string }) => {
        if (params?.org === 'globex') throw boom('globex alerts refused');
        return path === 'GET /orgs/{org}/secret-scanning/alerts' ? [scanAlert('acme/a')] : [];
      });

      const { byRepo, unreadableOrgs } = await sourceFor(TWO).securityByRepo();

      expect(byRepo.get('acme/a')?.secrets).toBe(1);
      expect(byRepo.has('globex/a')).toBe(false);
      expect(unreadableOrgs).toEqual(['globex']);
      expect(warn.mock.calls.map(String).join('\n')).toContain('globex');
      warn.mockRestore();
    });

    it('one of the three lists failing makes that org unreadable, not partly clean', async () => {
      // One `RepoSecurity` carries one `state`, so a row cannot say "dependabot
      // read, code scanning not". Zeroes standing for an unread list are the
      // failure this issue is about, so the whole org's posture is declared
      // unread when any of its three lists refuses.
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      paginate.mockImplementation(async (path: string, params?: { org?: string }) => {
        if (path === 'GET /orgs/{org}/code-scanning/alerts' && params?.org === 'globex') {
          throw boom('code scanning not enabled');
        }
        return path === 'GET /orgs/{org}/dependabot/alerts' ? [depAlert(`${params?.org}/a`, 'critical')] : [];
      });

      const { byRepo, unreadableOrgs } = await sourceFor(TWO).securityByRepo();

      // The rows it DID read are kept — losing a list may not lose the counts
      // that came back — and the org is still named as one nobody fully read.
      expect(byRepo.get('globex/a')?.depHigh).toBe(1);
      expect(unreadableOrgs).toEqual(['globex']);
      // The row itself still says `read`, because it came out of a list that
      // answered — this source knows which list it lost and one `RepoSecurity`
      // cannot carry that. Rounding the whole org's rows to `unreadable` is the
      // CONSUMER's job, and `repos.service.spec.ts` holds the other half. Pinned
      // here so the two halves cannot drift into both assuming the other did it.
      expect(byRepo.get('globex/a')?.state).toBe('read');
      warn.mockRestore();
    });

    it('every row it read says so, so a zero is a measurement rather than a gap', async () => {
      paginate.mockImplementation(async (path: string, params?: { org?: string }) =>
        path === 'GET /orgs/{org}/dependabot/alerts' ? [depAlert(`${params?.org}/a`, 'critical')] : [],
      );
      const { byRepo } = await sourceFor(TWO).securityByRepo();
      expect(byRepo.get('acme/a')?.state).toBe('read');
    });

    it('still resolves an EMPTY map rather than throwing when every org refuses', async () => {
      // Security is a decoration on the map. Losing it may never blank a page
      // whose subject is the repo list — the contract this read keeps whatever
      // it is scoped to.
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      paginate.mockRejectedValue(boom('refused'));

      const read = await sourceFor(TWO).securityByRepo();

      expect(read.byRepo).toEqual(new Map());
      expect(read.unreadableOrgs).toEqual(TWO);
      warn.mockRestore();
    });
  });

  describe('actionsUsage', () => {
    const usageRow = (org: string, over: Record<string, unknown> = {}) => ({
      date: '2026-08-01T00:00:00Z',
      product: 'actions',
      quantity: 100,
      unitType: 'Minutes',
      netAmount: 1,
      organizationName: org,
      repositoryName: 'a',
      ...over,
    });

    it("reads both orgs' billing and says which orgs it covered", async () => {
      request.mockImplementation(async (_route: string, params?: { org?: string }) => ({
        data: { usageItems: [usageRow(params?.org as string)] },
      }));

      const read = await sourceFor(TWO).actionsUsage([{ year: 2026, month: 8 }]);

      expect(read?.days.map((d) => d.full)).toEqual(['acme/a', 'globex/a']);
      expect(read?.orgs).toEqual(TWO);
    });

    it("keeps the org that answered and drops the one that did not from `orgs`", async () => {
      // Rows are keyed `org/repo`, so an org that contributed nothing and an
      // org whose repos simply ran no minutes look identical in `days`. `orgs`
      // is the only place the difference can be read.
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      request.mockImplementation(async (_route: string, params?: { org?: string }) => {
        if (params?.org === 'globex') throw boom('globex billing refused');
        return { data: { usageItems: [usageRow('acme')] } };
      });

      const read = await sourceFor(TWO).actionsUsage([{ year: 2026, month: 8 }]);

      expect(read?.days.map((d) => d.full)).toEqual(['acme/a']);
      expect(read?.orgs).toEqual(['acme']);
      expect(warn.mock.calls.map(String).join('\n')).toContain('globex');
      warn.mockRestore();
    });

    it('applies the per-month rule PER ORG: a month missing drops that org alone', async () => {
      // "A total missing a month is not a smaller total, it is a wrong one."
      // That rule is unchanged, and it is now asked of each org's own answer —
      // one org's July failing may not take another org's whole report.
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      request.mockImplementation(async (_route: string, params?: { org?: string; month?: number }) => {
        if (params?.org === 'globex' && params?.month === 7) throw boom('globex July refused');
        return { data: { usageItems: [usageRow(params?.org as string, { date: `2026-0${params?.month}-01T00:00:00Z` })] } };
      });

      const read = await sourceFor(TWO).actionsUsage([
        { year: 2026, month: 7 },
        { year: 2026, month: 8 },
      ]);

      expect(read?.orgs).toEqual(['acme']);
      expect(read?.days.every((d) => d.full.startsWith('acme/'))).toBe(true);
      // Both of acme's months are there — the surviving org keeps a whole
      // report, not the half that happened to come back first.
      expect(read?.days.map((d) => d.date)).toEqual(['2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z']);
      warn.mockRestore();
    });

    it('answers NULL only when no org answered at all', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      request.mockRejectedValue(boom('billing refused'));
      expect(await sourceFor(TWO).actionsUsage([{ year: 2026, month: 8 }])).toBeNull();
      warn.mockRestore();
    });
  });
});


describe('owner property migration (#1287)', () => {
  beforeEach(() => { request.mockReset(); paginate.mockReset(); });
  const row = (property_name: string, value: string | null) => ({ property_name, value });
  it.each([
    { names: ['dri'], expected: 'legacy' },
    { names: ['dri', 'OwNeR'], expected: 'current' },
    { names: ['OWNER'], expected: 'current' },
  ])('reads, selects schema and writes with $names', async ({ names, expected }) => {
    const values = names.map((name) => row(name, name === 'dri' ? 'legacy' : 'current'));
    const schemas = names.map((name) => ({ property_name: name,
      allowed_values: [name === 'dri' ? 'legacy' : 'current'], values_editable_by: 'org_and_repo_actors' }));
    paginate.mockResolvedValue([{ repository_full_name: 'acme/app', properties: values }]);
    request.mockImplementation(async (route: string) => ({ data: route.endsWith('/schema') ? schemas : values }));
    writeSchema.mockResolvedValue({ data: schemas });
    const src = source();
    expect((await src.driByRepo()).byRepo.get('acme/app')).toBe(expected);
    expect(await src.driSchema('acme')).toEqual({ allowedValues: [expected], writability: 'writable' });
    expect(await src.setDri('acme/app', 'requested')).toBe(expected);
    expect(writeSchema).toHaveBeenCalledWith('GET /orgs/{org}/properties/schema', { org: 'acme' });
    expect(request).toHaveBeenCalledWith('PATCH /repos/{owner}/{repo}/properties/values', {
      owner: 'acme', repo: 'app', properties: [{ property_name: names.at(-1), value: 'requested' }],
    });
  });

  it('keeps a cleared owner empty even while a legacy value remains', async () => {
    paginate.mockResolvedValue([{ repository_full_name: 'acme/app', properties: [row('dri', 'legacy'), row('owner', null)] }]);
    expect((await source().driByRepo()).byRepo.get('acme/app')).toBeNull();
    writeSchema.mockResolvedValue({ data: [{ property_name: 'owner' }, { property_name: 'dri' }] });
    request.mockResolvedValue({ data: [row('dri', 'legacy')] });
    expect(await source().setDri('acme/app', null)).toBeNull();
  });

  it.each([[], null])('refuses writes when schema has no ownership property or is malformed: %j', async (data) => {
    writeSchema.mockResolvedValue({ data });
    await expect(source().setDri('acme/app', 'someone')).rejects.toBeInstanceOf(HttpException);
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a failed schema read without sending a PATCH', async () => {
    writeSchema.mockRejectedValue(githubError(500, 'Internal Server Error'));
    await expect(source().setDri('acme/app', 'someone')).rejects.toBeInstanceOf(HttpException);
    expect(request).not.toHaveBeenCalled();
  });

  it('uses the personal account as owner without any property API calls', async () => {
    const principal = { owners: [{ login: 'octocat', type: 'User' }], repositories: [
      { full_name: 'octocat/app', owner: { login: 'octocat' } },
      { full_name: 'octocat/second', owner: { login: 'octocat' } },
    ], cache: new Map() } as unknown as GithubPrincipal;
    await githubContext.run({ principal }, async () => {
      const src = new GithubReposSource(cfg({ GITHUB_ORGS: 'octocat' }));
      expect([...(await src.driByRepo()).byRepo]).toEqual([
        ['octocat/app', 'octocat'], ['octocat/second', 'octocat'],
      ]);
      expect(await src.driSchema('OCTOCAT')).toEqual({ allowedValues: [], writability: 'not-applicable' });
      await expect(src.setDri('octocat/app', 'other')).rejects.toBeInstanceOf(NotFoundException);
      expect(paginate).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(writeSchema).not.toHaveBeenCalled();
    });
  });
});
