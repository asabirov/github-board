import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  GithubIssuesSource,
  ISSUES_NOT_NOW_CODE,
  shortRepoKey,
  mapLimit,
  reportRepoKeyCollisions,
  ReportedCollisions,
} from './github-issues.source';
import { githubContext, type GithubPrincipal } from '../auth/github-principal';

// The source lazily builds an Octokit; we hand it a fake whose `paginate`
// dispatches on the call's params — `{ org }` → repo enumeration, `{ owner,
// repo }` → that repo's issues. The method reference (first arg) is ignored.
// `vi.hoisted` so these are initialised before the hoisted `vi.mock` factory runs.
const { paginate, listForOrg, listForRepo } = vi.hoisted(() => ({
  paginate: vi.fn(),
  listForOrg: Symbol('repos.listForOrg'),
  listForRepo: Symbol('issues.listForRepo'),
}));
vi.mock('../sources/github-client', () => ({
  buildOctokitClient: () => ({
    paginate,
    repos: { listForOrg },
    issues: { listForRepo },
  }),
}));

/** Honours the declared default argument, the way the real ConfigService does,
 *  so every key a case leaves unset answers what the caller declared.
 *  `FEEDBACK_REPO` is not read through one any more: #1175 took its default off
 *  and the resolver refuses an env that names none, so the pin below names it. */
/** `GITHUB_ORGS` and `FEEDBACK_REPO` are pinned at the org this file's sample
 *  rows are written against. Since #1175 neither key has a default to be left
 *  to: #1166 put both behind one constant, the organisation was renamed out from
 *  under it, and the constant came off. A case that means another value passes
 *  its own. */
const cfg = (vars: Record<string, string>): ConfigService =>
  ({
    get: (k: string, d?: unknown) => ({ GITHUB_ORGS: 'acme', FEEDBACK_REPO: 'acme/board', ...vars })[k] ?? d,
  }) as unknown as ConfigService;

/** A minimal GitHub REST issue as `issues.listForRepo` returns it. */
const ghIssue = (
  n: number,
  assignee: string,
  state: 'open' | 'closed' = 'open',
  body?: string | null,
) => ({
  number: n,
  title: `Issue ${n}`,
  html_url: `https://github.com/x/${n}`,
  state,
  created_at: '2026-07-24T00:00:00Z',
  closed_at: state === 'closed' ? '2026-07-25T00:00:00Z' : null,
  user: { login: 'someone' },
  assignees: [{ login: assignee }],
  labels: [],
  milestone: null,
  body,
});

// The org's repos: two ingestable, plus one each that must be filtered out.
const ORG_REPOS = [
  { name: 'acme', archived: false, fork: false, has_issues: true },
  { name: 'design-system', archived: false, fork: false, has_issues: true },
  { name: 'old-thing', archived: true, fork: false, has_issues: true }, // archived → skip
  { name: 'a-fork', archived: false, fork: true, has_issues: true }, // fork → skip
  { name: 'wiki-only', archived: false, fork: false, has_issues: false }, // issues off → skip
];

function wireOrg() {
  paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
    const p = params ?? {};
    if (p.org) return ORG_REPOS;
    if (p.repo === 'acme') return [ghIssue(1, 'octocat')];
    // Anton's only tracked work is in a non-core repo (the #257 case).
    if (p.repo === 'design-system') return [ghIssue(2, 'anton-khovanskiy', 'closed')];
    return [];
  });
}

describe('GithubIssuesSource — org-wide ingest (#257)', () => {
  beforeEach(() => paginate.mockReset());

  it('enumerates the org and ingests a member active only in a non-core repo', async () => {
    wireOrg();
    const out = await new GithubIssuesSource(
      cfg({}),
    ).listIssues();

    // design-system (Anton's) is ingested — the bug was that only acme + board
    // were, so his throughput read 0/0 despite real closes elsewhere.
    const anton = out.find((i) => i.assignees.includes('anton-khovanskiy'));
    expect(anton).toBeDefined();
    expect(anton).toMatchObject({ repo: 'design-system', number: 2, closedAt: '2026-07-25T00:00:00Z' });
  });

  // (Was: this asserted the paged set was exactly `['acme', 'design-system']`.
  // Since #516 the feedback repo joins any non-empty scope — the submission
  // marker's index is only as good as the ingest's coverage of it — so the
  // subject of the test, which is the archived/fork/issues-off filter, is now
  // asserted as "none of those three, plus the feedback repo".)
  it('skips archived, forked, and issues-disabled repos', async () => {
    wireOrg();
    const out = await new GithubIssuesSource(
      cfg({}),
    ).listIssues();

    const paged = paginate.mock.calls.map((c) => (c[1] as { repo?: string })?.repo).filter(Boolean);
    for (const skipped of ['old-thing', 'a-fork', 'wiki-only']) expect(paged).not.toContain(skipped);
    expect(paged.sort()).toEqual(['acme', 'board', 'design-system']);
    expect(out.map((i) => i.repo).sort()).toEqual(['acme', 'design-system']);
  });

  it('throws when every repo fetch fails (bad creds) rather than serving an empty board', async () => {
    // Org enumeration succeeds; every per-repo fetch 401s. (Only the repo call
    // throws — an org call or a stray teardown-hook call resolves harmlessly.)
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
      if (params?.repo) throw new Error('401');
      return params?.org ? [ORG_REPOS[0]] : [];
    });
    await expect(
      new GithubIssuesSource(cfg({})).listIssues(),
    ).rejects.toThrow(/every repo fetch failed/);
  });

  // #837. One repo losing its pagination to a secondary rate limit resolves
  // `{ ok: false, issues: [] }` so the run survives it — which is right, and
  // which used to leave that repo indistinguishable, inside the union, from a
  // repo with nothing open. The Repo page draws one repo's whole queue, so it is
  // the surface where "quiet" and "unread" must not read the same.
  it('records WHICH repo’s own fetch failed, beside the ones that answered', async () => {
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
      const p = params ?? {};
      if (p.org) return ORG_REPOS;
      if (p.repo === 'design-system') throw new Error('secondary rate limit');
      if (p.repo === 'acme') return [ghIssue(1, 'octocat')];
      return [];
    });
    const source = new GithubIssuesSource(
      cfg({}),
    );
    const out = await source.listIssues();

    // The run still carries the repo that answered.
    expect(out.map((i) => i.repo)).toEqual(['acme']);
    // …and says, in full owner/name, which one did not.
    const failed = source.repoOutcomes().filter((r) => !r.ok);
    expect(failed.map((r) => r.full)).toEqual(['acme/design-system']);
    // The rest are recorded as read, so a page can tell "we asked and it
    // answered" from "we never asked".
    expect(source.repoOutcomes().find((r) => r.full === 'acme/acme')?.ok).toBe(true);
  });

  // #837, one level up, and the reason `repoOutcomes()` alone cannot answer the
  // Repo page. An org whose ENUMERATION fails contributes no repos at all, so
  // nothing of that org reaches `results` and nothing of it can be reported here
  // — absent, which every reader has to take as "never asked". Only
  // `orgOutcomes()` says that org was lost, and the Repo page has to read both.
  it('reports NOTHING per repo for an org whose enumeration failed', async () => {
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
      const p = params ?? {};
      if (p.org === 'globex') throw new Error('404 — no access to this org');
      if (p.org) return [ORG_REPOS[0]];
      return p.repo === 'acme' ? [ghIssue(1, 'octocat')] : [];
    });
    const source = new GithubIssuesSource(
      cfg({ GITHUB_ORGS: 'acme,globex' }),
    );
    await source.listIssues();

    // Not one globex repo is spoken about — not as failed, and not at all.
    expect(source.repoOutcomes().some((r) => r.full.startsWith('globex/'))).toBe(false);
    // The org read is the only record of the loss, and it has it.
    expect(source.orgOutcomes().find((o) => o.org === 'globex')?.state).toBe('unreadable');
    expect(source.orgOutcomes().find((o) => o.org === 'acme')?.state).toBe('read');
  });

  it('reports no outcomes at all before a run has happened', async () => {
    // An invented `ok` is as wrong as an invented failure: a source that has not
    // run knows nothing, and every page then keeps the answer it has today.
    expect(new GithubIssuesSource(cfg({})).repoOutcomes()).toEqual([]);
  });
});

/**
 * #528 — the repo list is fetched from Github too, so losing it is an outage in
 * exactly the way losing every repo's issues is, and has to read as one.
 *
 * It used to read as the opposite. The enumeration logged and returned [], the
 * empty list stayed empty through `withFeedbackRepo`, there was nothing to page,
 * and the "every repo fetch failed" guard never fired because its first term is
 * `repos.length > 0`. `listIssues` resolved with no issues, and every surface
 * downstream drew a board on which nobody has any work — confident zeros served
 * with a 200, which is #512's failure one layer down.
 *
 * The three ways the scope can come back empty mean three different things, and
 * only one of them is a fault. These tests hold all three apart.
 */
describe('GithubIssuesSource — losing the repo list (#528)', () => {
  beforeEach(() => paginate.mockReset());

  it('throws when the org enumeration fails, rather than serving a board with nobody on it', async () => {
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
      if (params?.org) throw new Error('502 Bad Gateway');
      return [];
    });
    await expect(
      new GithubIssuesSource(cfg({})).listIssues(),
    ).rejects.toThrow(/repo list/);
  });

  it('names the org and the underlying failure in what it throws', async () => {
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
      if (params?.org) throw new Error('Bad credentials');
      return [];
    });
    await expect(
      new GithubIssuesSource(cfg({})).listIssues(),
    ).rejects.toThrow(/acme.*Bad credentials/s);
  });

  it('fetches no repo at all once the scope is lost, so no partial dataset can be served', async () => {
    // The feedback repo is the one that would sneak through: it joins any
    // non-empty scope, and a board-repo-only dataset served as though it were
    // org-wide is worse than an error, because every count in it is wrong and
    // nothing says so.
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
      if (params?.org) throw new Error('502 Bad Gateway');
      return [];
    });
    await expect(
      new GithubIssuesSource(cfg({})).listIssues(),
    ).rejects.toThrow();
    expect(paginate.mock.calls.map((c) => (c[1] as { repo?: string })?.repo).filter(Boolean)).toEqual([]);
  });

  it('an org whose repos are all skippable is empty, not broken', async () => {
    // Enumeration SUCCEEDED and the filter left nothing. Genuinely no issues,
    // so the board reads empty — the state the guard exists to protect.
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) =>
      params?.org ? [{ name: 'old-thing', archived: true, fork: false, has_issues: true }] : [],
    );
    await expect(
      new GithubIssuesSource(cfg({})).listIssues(),
    ).resolves.toEqual([]);
  });

  it('an owner scope with no org in it is configuration, not an outage', async () => {
    // `ISSUES_METRICS_ORG=''` produced this scope and is retired (#1209 part 4).
    // A person whose Github App grants cover no owner produces it now, and the
    // honest answer is still an empty list rather than a thrown outage.
    paginate.mockImplementation(async () => []);
    const noGrants = {
      key: 'person', email: 'a@example.test', login: 'a', token: 'synthetic',
      owners: [], repositories: [], cache: new WeakMap(), permissionCache: new WeakMap(),
    } as unknown as GithubPrincipal;
    await githubContext.run({ principal: noGrants }, async () => {
      await expect(new GithubIssuesSource(cfg({})).listIssues()).resolves.toEqual([]);
    });
    expect(paginate).not.toHaveBeenCalled();
  });
});

/**
 * #516 — the ingest records the submission footer off the body the REST list
 * already carries. No extra request: `issues.listForRepo` embeds each issue's
 * body, and the mapper simply did not read it.
 *
 * Two-valued here rather than three, for the same reason `labelsComplete` is:
 * this source always has the body, there is no page to truncate, and nothing to
 * be unsure about. The third value belongs at the index boundary, where "no row
 * for this issue" is a real state.
 */
describe('GithubIssuesSource — the submission footer (#516)', () => {
  const FOOTER_BODY = [
    'my weekly report never arrives and the button just spins',
    '',
    '---',
    'Submitted by octocat@example.com via the board feedback form.',
  ].join('\n');

  beforeEach(() => paginate.mockReset());

  const mapOne = async (body: string | null | undefined) => {
    // Through the org walk, because `ISSUES_METRICS_REPOS` is retired (#1209
    // part 4) and there is no second scope path to pin one repo with. The org
    // yields that one repo instead.
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
      if (params?.org) return [{ name: 'board', archived: false, fork: false, has_issues: true }];
      return params?.repo === 'board' ? [ghIssue(9, 'octocat', 'open', body)] : [];
    });
    const out = await new GithubIssuesSource(cfg({})).listIssues();
    return out[0];
  };

  it('marks an issue whose body carries the footer', async () => {
    expect(await mapOne(FOOTER_BODY)).toMatchObject({ number: 9, submission: true });
  });

  it('leaves an ordinary issue unmarked', async () => {
    expect(await mapOne('The apply step logs nothing when the quota rejects it.')).toMatchObject({
      submission: false,
    });
  });

  it('a body Github returned as null is unmarked, not unknown — this source always has one', async () => {
    expect(await mapOne(null)).toMatchObject({ submission: false });
  });
});

/**
 * #516 — the index the two body-less surfaces read is only as good as the
 * ingest's coverage of FEEDBACK_REPO, so the resolved repo list is unioned with
 * it. The union folds case, because a plain append would fetch a repo the org
 * enumeration already yielded a SECOND time and emit every board issue twice
 * into the shared cache — doubling the open counts, the throughput windows, the
 * aging tile, both queues and the palette index.
 */
describe('GithubIssuesSource — FEEDBACK_REPO is always in scope, exactly once (#516)', () => {
  const ORG_WITH_BOARD = [
    { name: 'acme', archived: false, fork: false, has_issues: true },
    { name: 'board', archived: false, fork: false, has_issues: true },
  ];

  beforeEach(() => paginate.mockReset());

  function wire() {
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
      const p = params ?? {};
      if (p.org) return ORG_WITH_BOARD;
      if (p.repo === 'acme') return [ghIssue(1, 'octocat')];
      if (p.repo === 'board') return [ghIssue(9, 'octocat')];
      return [];
    });
  }

  const pagedRepos = (): string[] =>
    paginate.mock.calls
      .map((c) => (c[1] as { repo?: string })?.repo)
      .filter((r): r is string => !!r);

  it('fetches a repo the org enumeration already yielded exactly once', async () => {
    wire();
    const out = await new GithubIssuesSource(
      cfg({}),
    ).listIssues();
    expect(pagedRepos().filter((r) => r === 'board')).toHaveLength(1);
    expect(out.filter((i) => i.number === 9)).toHaveLength(1);
  });

  it('…and still once when FEEDBACK_REPO is spelled with different casing', async () => {
    wire();
    const out = await new GithubIssuesSource(
      cfg({
        GITHUB_ORGS: 'acme',
        FEEDBACK_REPO: 'Acme/board',
      }),
    ).listIssues();
    expect(pagedRepos().filter((r) => r.toLowerCase() === 'board')).toHaveLength(1);
    expect(out.filter((i) => i.number === 9)).toHaveLength(1);
  });

  it('adds it to a scope whose enumeration leaves it out', async () => {
    // `ISSUES_METRICS_REPOS` pinned a list without it and is retired (#1209 part
    // 4); an org whose listing does not carry it is the surviving way in, and a
    // repo with issues turned off is one.
    wire();
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
      if (params?.org) return [{ name: 'acme', archived: false, fork: false, has_issues: true }];
      if (params?.repo === 'acme') return [ghIssue(1, 'octocat')];
      return params?.repo === 'board' ? [ghIssue(9, 'octocat')] : [];
    });
    const out = await new GithubIssuesSource(cfg({})).listIssues();
    expect(pagedRepos().sort()).toEqual(['acme', 'board']);
    expect(out.map((i) => i.number).sort()).toEqual([1, 9]);
  });
});

describe('shortRepoKey', () => {
  it('strips the owner and the .example.com suffix', () => {
    expect(shortRepoKey('acme/board')).toBe('board');
    expect(shortRepoKey('acme/board.example.com')).toBe('board');
    expect(shortRepoKey('acme/acme')).toBe('acme');
    expect(shortRepoKey('acme/design-system')).toBe('design-system');
  });
});

describe('reportRepoKeyCollisions (#484)', () => {
  /** A logger that keeps what it was told, so the report can be read back. */
  const collector = () => {
    const warnings: string[] = [];
    return { warnings, reported: new Set<string>(), logger: { warn: (m: string) => void warnings.push(m) } };
  };

  it('says nothing when every repo in scope has its own short key', () => {
    const { warnings, reported, logger } = collector();
    reportRepoKeyCollisions(
      ['acme/board', 'acme/acme', 'acme/design-system'],
      logger,
      reported,
    );
    expect(warnings).toEqual([]);
  });

  it('names the key and both repos when two of them fold into one', () => {
    const { warnings, reported, logger } = collector();
    reportRepoKeyCollisions(['acme/board', 'acme/board.example.com'], logger, reported);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'board'");
    expect(warnings[0]).toContain('acme/board.example.com');
    expect(warnings[0]).toContain('acme/board');
  });

  it('reports one message per colliding key, ordered by key', () => {
    const { warnings, reported, logger } = collector();
    reportRepoKeyCollisions(
      [
        'acme/status.example.com',
        'acme/status',
        'acme/board.example.com',
        'acme/board',
        'acme/acme',
      ],
      logger,
      reported,
    );

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("'board'");
    expect(warnings[1]).toContain("'status'");
  });

  it('catches a pair that differs only in case, which the frontend folds together', () => {
    // The backend key keeps its case, the viewer's `repoKey` lowercases it, so
    // `Board.example.com` + `board` collide on the `?repo=` filter even though
    // the ingest keys stay distinct. Same trap, so the same report.
    const { warnings, reported, logger } = collector();
    reportRepoKeyCollisions(['acme/Board.example.com', 'acme/board'], logger, reported);
    expect(warnings).toHaveLength(1);
  });

  it('does not read a repeated repo as a collision with itself', () => {
    const { warnings, reported, logger } = collector();
    reportRepoKeyCollisions(['acme/acme', 'acme/acme'], logger, reported);
    expect(warnings).toEqual([]);
  });

  it('announces each colliding key once per process, however often the scope repeats', () => {
    const { warnings, reported, logger } = collector();
    const scope = ['acme/board.example.com', 'acme/board'];
    reportRepoKeyCollisions(scope, logger, reported);
    reportRepoKeyCollisions(scope, logger, reported);
    expect(warnings).toHaveLength(1);
  });

  it('drops the oldest announced key once the bound is reached, and announces it again when it reappears', () => {
    const { warnings, logger } = collector();
    const reported = new ReportedCollisions(2);
    const colliding = (name: string) => [`a/${name}.example.com`, `a/${name}`];
    reportRepoKeyCollisions(colliding('board'), logger, reported);
    reportRepoKeyCollisions(colliding('status'), logger, reported);
    // The third distinct key evicts the first one, which is the oldest.
    reportRepoKeyCollisions(colliding('design'), logger, reported);
    expect(reported.has('board')).toBe(false);
    expect(warnings).toHaveLength(3);
    // The evicted key is announced once more when its collision reappears.
    reportRepoKeyCollisions(colliding('board'), logger, reported);
    expect(warnings).toHaveLength(4);
  });
});

describe('GithubIssuesSource — colliding short keys (#484)', () => {
  beforeEach(() => paginate.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('reports the collision rather than merging the two queues in silence', async () => {
    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => {
      warnings.push(String(m));
    });
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
      const p = params ?? {};
      if (p.org)
        return [
          { name: 'board.example.com', archived: false, fork: false, has_issues: true },
          { name: 'board', archived: false, fork: false, has_issues: true },
        ];
      if (p.repo === 'board.example.com') return [ghIssue(1, 'octocat')];
      if (p.repo === 'board') return [ghIssue(2, 'octocat')];
      return [];
    });

    const out = await new GithubIssuesSource(
      cfg({}),
    ).listIssues();

    const hit = warnings.find((e) => e.includes("'board'"));
    expect(hit).toBeDefined();
    expect(hit).toContain('acme/board.example.com');
    expect(hit).toContain('acme/board');

    // The merge itself stands, deliberately: the short key is the shareable
    // `?repo=board` value, so changing it would break every link that carries
    // it. #484 is about the merge announcing itself, not about it stopping.
    expect(out.map((i) => i.repo)).toEqual(['board', 'board']);
  });

  it('announces a colliding key once across refreshes of one source, at warn', async () => {
    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => {
      warnings.push(String(m));
    });
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
      const p = params ?? {};
      if (p.org)
        return [
          { name: 'board.example.com', archived: false, fork: false, has_issues: true },
          { name: 'board', archived: false, fork: false, has_issues: true },
        ];
      if (p.repo === 'board.example.com') return [ghIssue(1, 'octocat')];
      if (p.repo === 'board') return [ghIssue(2, 'octocat')];
      return [];
    });

    const src = new GithubIssuesSource(cfg({}));
    await src.listIssues();
    await src.listIssues();

    expect(warnings.filter((w) => w.includes("'board'"))).toHaveLength(1);
  });

  it('stays silent on the org as it actually is today — no repo pair collides', async () => {
    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => {
      warnings.push(String(m));
    });
    wireOrg();
    await new GithubIssuesSource(
      cfg({}),
    ).listIssues();
    expect(warnings).toEqual([]);
  });
});

describe('mapLimit', () => {
  it('preserves input order and never exceeds the concurrency limit', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit(items, 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual(items.map((n) => n * 2));
    expect(peak).toBeLessThanOrEqual(4);
  });
});

/**
 * #647 — every configured org, and a per-org record of how each read went.
 *
 * The union is still one list, because every person-shaped surface wants one:
 * a member's throughput is their throughput wherever they did it. What the
 * union cannot say is WHICH org it covers, and that is what `orgOutcomes()`
 * carries — the only thing that lets a surface tell "globex has no work this
 * week" from "globex could not be read". Those must never draw the same.
 */
describe('GithubIssuesSource — every configured org (#647)', () => {
  beforeEach(() => paginate.mockReset());

  /** Honours BOTH halves of the key. A fake that dispatches on the short repo
   *  name alone lets a source that reads one org pass every test here, because
   *  `acme/design-system` and `globex/design-system` fold together. */
  function wireTwoOrgs(unreadable?: string) {
    paginate.mockImplementation(
      async (_fn: unknown, params?: { org?: string; owner?: string; repo?: string }) => {
        const p = params ?? {};
        if (p.org) {
          if (p.org === unreadable) throw new Error('404 Not Found');
          return p.org === 'acme'
            ? [{ name: 'acme', archived: false, fork: false, has_issues: true }]
            : [{ name: 'design-system', archived: false, fork: false, has_issues: true }];
        }
        if (p.owner === 'acme' && p.repo === 'acme') return [ghIssue(1, 'octocat')];
        if (p.owner === 'globex' && p.repo === 'design-system') return [ghIssue(2, 'ivan')];
        return [];
      },
    );
  }

  const twoOrgs = () =>
    new GithubIssuesSource(cfg({ GITHUB_ORGS: 'acme,globex' }));

  it('reads every org in GITHUB_ORGS, not just the first', async () => {
    wireTwoOrgs();
    const out = await twoOrgs().listIssues();
    expect(out.map((i) => `${i.owner}/${i.repo}#${i.number}`).sort()).toEqual([
      'acme/acme#1',
      'globex/design-system#2',
    ]);
  });

  it("an unreadable org leaves the other org's issues intact", async () => {
    wireTwoOrgs('globex');
    const out = await twoOrgs().listIssues();
    expect(out.map((i) => `${i.owner}/${i.repo}#${i.number}`)).toEqual(['acme/acme#1']);
  });

  it('an unreadable org is recorded as unreadable, not as zero issues', async () => {
    wireTwoOrgs('globex');
    const source = twoOrgs();
    await source.listIssues();
    expect(source.orgOutcomes().map((o) => [o.org, o.state])).toEqual([
      ['acme', 'read'],
      ['globex', 'unreadable'],
    ]);
  });

  it('counts one list call for the enumeration and one for each repo paged', async () => {
    wireTwoOrgs('globex');
    const source = twoOrgs();
    await source.listIssues();
    const calls = Object.fromEntries(source.orgOutcomes().map((o) => [o.org, o.calls]));
    // acme: the enumeration, `acme`, and FEEDBACK_REPO which joins any
    // non-empty scope. globex: the enumeration that failed, and nothing after.
    expect(calls).toEqual({ 'acme': 3, globex: 1 });
  });

  it('one configured org behaves exactly as the single-org ingest does today', async () => {
    wireOrg();
    const one = new GithubIssuesSource(
      cfg({ GITHUB_ORGS: 'acme' }),
    );
    const pinned = new GithubIssuesSource(
      cfg({}),
    );
    expect(await one.listIssues()).toEqual(await pinned.listIssues());
    expect(one.orgOutcomes().map((o) => o.org)).toEqual(['acme']);
  });

  it('throws when EVERY configured org is unreadable — the whole scope is lost (#528)', async () => {
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string }) => {
      if (params?.org) throw new Error('Bad credentials');
      return [];
    });
    await expect(twoOrgs().listIssues()).rejects.toThrow(/acme.*globex/s);
  });

});

/**
 * #647 P1 — an empty scope is only honest when NOTHING failed.
 *
 * The all-orgs throw is not enough. One org can enumerate cleanly and hold no
 * ingestable repo while the next org is unreadable: then `failures.length` is
 * one of two, the scope is `[]`, `withFeedbackRepo` leaves an empty list alone,
 * and the "every repo fetch failed" guard cannot fire on a list with nothing in
 * it. `listIssues()` resolves `[]` — #528's board with nobody on it, arriving
 * through a second door.
 */
describe('GithubIssuesSource — an empty scope that had a failure in it (#647)', () => {
  beforeEach(() => paginate.mockReset());

  const twoOrgs = () =>
    new GithubIssuesSource(cfg({ GITHUB_ORGS: 'acme,globex' }));

  it('throws when the scope resolves empty and an org was unreadable', async () => {
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string }) => {
      if (params?.org === 'globex') throw new Error('403 Forbidden');
      if (params?.org) return [{ name: 'old-thing', archived: true, fork: false, has_issues: true }];
      return [];
    });
    await expect(twoOrgs().listIssues()).rejects.toThrow(/globex.*403 Forbidden/s);
  });

  it('fetches nothing at all in that case, so no partial dataset is served', async () => {
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string }) => {
      if (params?.org === 'globex') throw new Error('403 Forbidden');
      if (params?.org) return [];
      return [];
    });
    await expect(twoOrgs().listIssues()).rejects.toThrow();
    // What this asserts is the ORDER: the throw lands before any repo is paged,
    // so no half-read dataset exists to be served. It is not what keeps
    // FEEDBACK_REPO out of an empty scope — `withFeedbackRepo` returns an empty
    // list unchanged, and did so before this guard existed.
    expect(paginate.mock.calls.map((c) => (c[1] as { repo?: string })?.repo).filter(Boolean)).toEqual([]);
  });

  it('still resolves quietly when the scope is empty and nothing failed', async () => {
    // Both orgs answered; neither holds a repo that survives the filter. That is
    // a genuinely empty board and it is not a fault.
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string }) =>
      params?.org ? [{ name: 'old-thing', archived: true, fork: false, has_issues: true }] : [],
    );
    await expect(twoOrgs().listIssues()).resolves.toEqual([]);
  });

  it('records WHY an org was unreadable, not merely that it was', async () => {
    // The outcome record replaced a throw, so it has to carry what the throw
    // carried. Without the reason the only place the cause exists is a log line,
    // and no surface can read a log line.
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
      if (params?.org === 'globex') throw new Error('403 Forbidden');
      if (params?.org) return [{ name: 'acme', archived: false, fork: false, has_issues: true }];
      return [];
    });
    const src = twoOrgs();
    await src.listIssues();
    const globex = src.orgOutcomes().find((o) => o.org === 'globex');
    expect(globex?.reason).toMatch(/403 Forbidden/);
    // …and a readable org claims no reason at all.
    expect(src.orgOutcomes().find((o) => o.org === 'acme')?.reason).toBeNull();
  });
});

/**
 * #1046 — a scope lost to Github's quota answers a coded 503, and nothing else
 * does.
 *
 * The browser draws its saved Overview copy on that code and on no other 503
 * (`team/overview-saved.ts`), so the code is only as good as the test that sets
 * it. `quotaRetryAt` is that test, and each failure here is a shape Github
 * really sends, as `sources/github-quota.spec.ts` records them.
 */
describe('GithubIssuesSource — a scope lost to quota is "not now" (#1046)', () => {
  beforeEach(() => paginate.mockReset());

  const twoOrgs = () =>
    new GithubIssuesSource(cfg({ GITHUB_ORGS: 'acme,globex' }));
  const oneOrg = () =>
    new GithubIssuesSource(cfg({}));
  /** A REST primary rate limit: a 403 whose headers say the budget is spent. */
  const rateLimited = () => Object.assign(new Error('API rate limit already exceeded for installation ID 1.'), {
    status: 403,
    response: {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) },
      data: { message: 'API rate limit already exceeded for installation ID 1.' },
    },
  });
  /** A permission 403 with budget left, which is "not you" whatever it shares. */
  const forbidden = () => Object.assign(new Error('Resource not accessible by integration'), {
    status: 403,
    response: { status: 403, headers: { 'x-ratelimit-remaining': '4999' }, data: { message: 'Resource not accessible by integration' } },
  });
  const failure = (source: GithubIssuesSource) => source.listIssues().catch((err: unknown) => err);

  it('answers a 503 coded issues_not_now when Github refused every org on quota', async () => {
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string }) => {
      if (params?.org) throw rateLimited();
      return [];
    });
    const failed = await failure(twoOrgs());
    expect(failed).toBeInstanceOf(ServiceUnavailableException);
    const coded = failed as ServiceUnavailableException;
    expect(coded.getStatus()).toBe(503);
    // What Nest writes to the wire: there is no exception filter in this app.
    expect(coded.getResponse()).toEqual({
      message: expect.stringMatching(/^issue metrics: GitHub quota is cooling down until \d{4}-/),
      code: ISSUES_NOT_NOW_CODE,
    });
    expect(ISSUES_NOT_NOW_CODE).toBe('issues_not_now');
    // No org, and nothing Github said: the refusal is about the token's budget.
    expect((coded.getResponse() as { message: string }).message).not.toMatch(/acme|globex|installation|credentials/i);
  });

  it('answers the same when every repo fetch was refused on quota', async () => {
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
      if (params?.repo) throw rateLimited();
      return params?.org ? [ORG_REPOS[0]] : [];
    });
    const failed = await failure(oneOrg());
    expect(failed).toBeInstanceOf(ServiceUnavailableException);
    expect((failed as ServiceUnavailableException).getResponse()).toMatchObject({ code: ISSUES_NOT_NOW_CODE });
  });

  it.each([
    ['one org refused on quota and the other not found', (org: string) => (org === 'acme' ? rateLimited() : new Error('404 Not Found'))],
    ['a permission 403 with budget left', (_org: string) => forbidden()],
    ['bad credentials', (_org: string) => new Error('Bad credentials')],
  ])('stays the plain error, a 500 at the browser, when the orgs failed with %s', async (_what, refuse) => {
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string }) => {
      if (params?.org) throw refuse(params.org);
      return [];
    });
    const failed = await failure(twoOrgs());
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(ServiceUnavailableException);
  });

  it('stays the plain error when a repo fetch failed on something other than quota', async () => {
    let calls = 0;
    paginate.mockImplementation(async (_fn: unknown, params?: { org?: string; repo?: string }) => {
      if (params?.repo) throw (calls++ === 0 ? rateLimited() : new Error('401'));
      return params?.org ? [ORG_REPOS[0]] : [];
    });
    const failed = await failure(oneOrg());
    expect(failed).not.toBeInstanceOf(ServiceUnavailableException);
    expect((failed as Error).message).toMatch(/every repo fetch failed/);
  });
});
