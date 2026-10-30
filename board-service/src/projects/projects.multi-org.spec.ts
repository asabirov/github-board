import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asRollupGithub } from './github-projects.test-double';
import { ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { GithubProjectsSource } from './github-projects.source';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { PROJECTS_NOT_NOW_CODE } from './projects-last-good';
import { GithubQuotaCooldownError } from '../sources/github-quota';
import type { IssuesCacheService } from '../issues-metrics/issues-cache.service';

/**
 * The Projects surface over a deployment that names TWO orgs (#697).
 *
 * Driven from the controller down through the real service and the real Github
 * source, with only the GraphQL client mocked — the union, the narrowing, the
 * tolerance and the per-org caching are one behaviour, and a test of any one of
 * them alone would pass on a build where the other three are broken.
 *
 * Every check here is invisible on a deployment whose `GITHUB_ORGS` names ONE
 * org, which is what this board is run as: "the first org" and "every org" are
 * the same answer there, so a green suite against it proves nothing about
 * either.
 *
 * Board 3 exists in BOTH orgs on purpose. Two orgs may number their boards
 * however they like, so a board number is not a key across the union — which is
 * what `org` on every board is for, and what the `/projects/:number` rule is
 * about.
 */

const graphql = vi.fn();
vi.mock('../sources/github-client', () => ({ buildOctokitClient: () => ({ graphql: asRollupGithub(graphql) }) }));

const ALPHA = 'org-alpha';
const BETA = 'org-beta';

/** Which boards each org holds. Board 3 is in both, with different names. */
const BOARDS: Record<string, { number: number; title: string }[]> = {
  [ALPHA]: [
    { number: 1, title: 'alpha one' },
    { number: 3, title: 'alpha three' },
  ],
  [BETA]: [
    { number: 3, title: 'beta three' },
    { number: 5, title: 'beta five' },
  ],
};

/**
 * A config naming the owner scope and nothing else. `PROJECTS_OWNER` used to
 * narrow it and is retired (#1209 part 4), so `GITHUB_ORGS` is the whole answer
 * on the no-person path these tests run.
 */
function config(orgs: string, ttlMs = 10_000): ConfigService {
  return {
    get: (k: string, d?: unknown) => {
      if (k === 'GITHUB_ORGS') return orgs;
      // No default since #1175, and the service builds the feedback scope in
      // its constructor.
      if (k === 'FEEDBACK_REPO') return 'acme/board';
      if (k === 'PROJECTS_CACHE_TTL_MS') return ttlMs;
      return d;
    },
  } as unknown as ConfigService;
}

/** The shared issues cache as this service sees it. The pulse join reads it and
 *  nothing here measures the pulse, so it answers empty rather than being wired
 *  to a second fixture. */
const issuesCache = {
  getIssues: async () => ({ at: Date.now(), issues: [], orgs: [] }),
  submissionIndex: async () => null,
} as unknown as IssuesCacheService;

/** A signed-in teammate — the identity every read here is made under. */
const HUMAN = { agent: false, email: 'octocat@example.com' };

/** One open issue on a board, as the ROLLUP query selects it. */
const rollupItem = (org: string, board: number) => ({
  content: {
    __typename: 'Issue',
    number: board * 10,
    title: `${org} #${board * 10}`,
    url: `https://github.com/${org}/repo/issues/${board * 10}`,
    state: 'OPEN',
    repository: { nameWithOwner: `${org}/repo` },
    author: { login: 'octocat' },
    labels: { totalCount: 0, nodes: [] },
    assignees: { nodes: [] },
    timelineItems: { nodes: [] },
  },
});

/** The same issue as the DETAIL query selects it — `body` included (#516). */
const detailItem = (org: string, board: number) => ({
  status: { name: 'Todo' },
  fieldValues: { nodes: [] },
  content: {
    ...rollupItem(org, board).content,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
    closedAt: null,
    body: 'plain body',
    parent: null,
    closedByPullRequestsReferences: { nodes: [] },
    lastActivity: { nodes: [] },
  },
});

const ended = { hasNextPage: false, endCursor: null };

/** One org's answer to `LIST_QUERY`. */
const listPayload = (org: string) => ({
  organization: {
    projectsV2: {
      totalCount: BOARDS[org].length,
      pageInfo: ended,
      nodes: BOARDS[org].map((b) => ({
        number: b.number,
        title: b.title,
        url: `https://github.com/orgs/${org}/projects/${b.number}`,
        closed: false,
        items: { totalCount: 1, pageInfo: ended, nodes: [rollupItem(org, b.number)] },
      })),
    },
  },
});

/** One org's answer to `CATALOG_QUERY`. */
const catalogPayload = (org: string) => ({
  organization: {
    projectsV2: {
      totalCount: BOARDS[org].length,
      pageInfo: ended,
      nodes: BOARDS[org].map((b) => ({
        id: `PVT_${org}_${b.number}`,
        number: b.number,
        title: b.title,
        closed: false,
      })),
    },
  },
});

/** One org's answer to `DETAIL_QUERY`, or a null board when it has no such
 *  number — which is exactly what Github answers for a board that isn't there. */
const detailPayload = (org: string, number: number) => {
  const board = BOARDS[org].find((b) => b.number === number);
  if (!board) return { organization: { projectV2: null } };
  return {
    organization: {
      projectV2: {
        createdAt: '2026-07-01T00:00:00Z',
        fields: { pageInfo: ended, nodes: [{
          __typename: 'ProjectV2SingleSelectField', id: 'status-id', name: 'Status', createdAt: '2026-07-01T00:00:00Z',
        }] },
        number: board.number,
        title: board.title,
        url: `https://github.com/orgs/${org}/projects/${board.number}`,
        closed: false,
        items: { totalCount: 1, pageInfo: ended, nodes: [{ ...detailItem(org, board.number), fieldValues: { nodes: [], pageInfo: ended } }] },
      },
    },
  };
};

/** Which document a call carries. `LIST_QUERY` and `CATALOG_QUERY` take the same
 *  variables, so the query text is the only thing that tells them apart. */
function documentOf(q: string): 'detail' | 'list' | 'catalog' {
  if (q.includes('projectV2(number:$number)')) return 'detail';
  return q.includes('items(first:') ? 'list' : 'catalog';
}

/** Answer whichever org the query names; anything else is a fetch nobody asked
 *  for and fails loudly rather than returning a plausible empty org. */
function answerBoth(overrides: Partial<Record<string, () => unknown>> = {}) {
  graphql.mockImplementation(async (q: string, vars: { owner: string; number?: number }) => {
    const override = overrides[vars.owner];
    if (override) return override();
    if (!BOARDS[vars.owner]) throw new Error(`unexpected owner ${JSON.stringify(vars.owner)}`);
    const doc = documentOf(q);
    if (doc === 'detail') return detailPayload(vars.owner, vars.number as number);
    return doc === 'list' ? listPayload(vars.owner) : catalogPayload(vars.owner);
  });
}

/** The controller over the real service and the real Github source, plus the
 *  service itself — the membership index is read there, having no route. */
function board(orgs = `${ALPHA},${BETA}`, ttlMs?: number) {
  const cfg = config(orgs, ttlMs);
  const service = new ProjectsService(new GithubProjectsSource(cfg), cfg, issuesCache);
  return { api: new ProjectsController(service, cfg), service };
}

/** Every org a GraphQL call was made against, in call order. */
const owners = () => graphql.mock.calls.map((c) => (c[1] as { owner: string }).owner);

/** One org unreachable — an `answerBoth` override that fails every document. */
const down = (org: string) => ({
  [org]: () => {
    throw new Error(`${org} is down`);
  },
});

beforeEach(() => {
  graphql.mockReset();
});

describe('/api/projects over two orgs (#697)', () => {
  it('reads BOTH orgs when GITHUB_ORGS names two', async () => {
    answerBoth();
    const { projects } = await board().api.list({ user: HUMAN });
    expect(projects.map((p) => p.name).sort()).toEqual(['alpha one', 'alpha three', 'beta five', 'beta three']);
  });

  it('names the org every board came from, so two orgs boards can be told apart', async () => {
    answerBoth();
    const { projects } = await board().api.list({ user: HUMAN });
    const byName = Object.fromEntries(projects.map((p) => [p.name, p.org]));
    expect(byName).toEqual({
      'alpha one': ALPHA,
      'alpha three': ALPHA,
      'beta three': BETA,
      'beta five': BETA,
    });
  });

  it('carries both orgs boards in the catalog', async () => {
    answerBoth();
    const catalog = await board().api.catalog();
    expect(catalog.map((c) => `${c.org}#${c.number}`).sort()).toEqual([
      `${ALPHA}#1`,
      `${ALPHA}#3`,
      `${BETA}#3`,
      `${BETA}#5`,
    ]);
  });

  it('carries both orgs boards in the membership index', async () => {
    answerBoth();
    const memberships = await board().service.projectMemberships();
    expect(memberships.map((m) => `${m.org}#${m.number}`).sort()).toEqual([
      `${ALPHA}#1`,
      `${ALPHA}#3`,
      `${BETA}#3`,
      `${BETA}#5`,
    ]);
  });
});

describe('/api/projects?org= narrows instead of being dropped (#697)', () => {
  it('serves ONE named orgs boards alone, and never reads the other', async () => {
    answerBoth();
    const { projects } = await board().api.list({ user: HUMAN }, BETA);
    expect(projects.map((p) => p.name).sort()).toEqual(['beta five', 'beta three']);
    expect(owners()).toEqual([BETA]);
  });

  it('narrows the catalog the same way', async () => {
    answerBoth();
    const catalog = await board().api.catalog(ALPHA);
    expect(catalog.map((c) => c.number).sort()).toEqual([1, 3]);
    expect(owners()).toEqual([ALPHA]);
  });

  it('matches a case variant of a served org rather than refusing it', async () => {
    answerBoth();
    const { projects } = await board().api.list({ user: HUMAN }, 'ORG-BETA');
    expect(projects.map((p) => p.name).sort()).toEqual(['beta five', 'beta three']);
    // The CONFIGURED spelling reaches Github, not the caller's — a cache keyed
    // on what a caller typed would hold one entry per spelling.
    expect(owners()).toEqual([BETA]);
  });

  it('an absent org still means the whole scope', async () => {
    answerBoth();
    const { projects } = await board().api.list({ user: HUMAN }, undefined);
    expect(projects).toHaveLength(4);
  });

  it('a blank org still means the whole scope', async () => {
    answerBoth();
    const { projects } = await board().api.list({ user: HUMAN }, '   ');
    expect(projects).toHaveLength(4);
  });

  it('an org this board does not serve is a 404, decided before anything reads', async () => {
    answerBoth();
    const { api } = board();
    await expect(api.list({ user: HUMAN }, 'stranger-org')).rejects.toBeInstanceOf(NotFoundException);
    await expect(api.catalog('stranger-org')).rejects.toBeInstanceOf(NotFoundException);
    await expect(api.detail({ user: HUMAN }, '3', 'stranger-org')).rejects.toBeInstanceOf(NotFoundException);
    expect(owners()).toEqual([]);
  });
});

describe('/api/projects/:number across two orgs (#697)', () => {
  it('reads the NAMED orgs board when ?org= says which', async () => {
    answerBoth();
    const detail = await board().api.detail({ user: HUMAN }, '3', BETA);
    expect(detail.name).toBe('beta three');
    expect(detail.org).toBe(BETA);
    expect(owners()).toEqual([BETA]);
  });

  it('resolves a number both orgs hold to the FIRST configured org', async () => {
    answerBoth();
    const detail = await board().api.detail({ user: HUMAN }, '3');
    expect(detail.name).toBe('alpha three');
    expect(detail.org).toBe(ALPHA);
  });

  it('falls through to a later org for a number the first one does not hold', async () => {
    answerBoth();
    const detail = await board().api.detail({ user: HUMAN }, '5');
    expect(detail.name).toBe('beta five');
    expect(detail.org).toBe(BETA);
  });

  it('is a 404 when NO org in scope holds the number', async () => {
    answerBoth();
    await expect(board().api.detail({ user: HUMAN }, '9')).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * An org that could not be READ is not an org without the board.
 *
 * The two are the same answer to `detailInScope` the moment the source turns a
 * failed fetch into a null board, and that one conflation is worth four checks:
 * a 404 served for a total outage, a miss cached as a fact, and both directions
 * of the per-org tolerance the route claims to have.
 */
describe('/api/projects/:number — an unreadable org is not an org without the board (#697)', () => {
  it("serves a later org's board when the first org cannot be read", async () => {
    answerBoth(down(ALPHA));
    const detail = await board().api.detail({ user: HUMAN }, '3');
    expect(detail.name).toBe('beta three');
    expect(detail.org).toBe(BETA);
  });

  /** The half that outlives the outage. Board 3 is in both orgs, so a minute
   *  when the first one was unreachable must not decide what this URL means for
   *  the rest of the TTL — a failed read is not the fact "alpha has no board 3". */
  it('goes back to the first org for that number the moment it is readable again', async () => {
    const { api } = board();
    answerBoth(down(ALPHA));
    expect((await api.detail({ user: HUMAN }, '3')).org).toBe(BETA);
    answerBoth();
    const detail = await api.detail({ user: HUMAN }, '3');
    expect(detail.name).toBe('alpha three');
    expect(detail.org).toBe(ALPHA);
  });

  /** Nothing was read, so nothing can be said about the number — and "unknown
   *  project 3" says something. */
  it('throws rather than 404ing when every org in scope is unreadable', async () => {
    graphql.mockRejectedValue(new Error('bad creds'));
    const failed = await board()
      .api.detail({ user: HUMAN }, '3')
      .catch((err: unknown) => err);
    expect(failed).not.toBeInstanceOf(NotFoundException);
    expect(String(failed)).toMatch(/bad creds/);
  });

  /** The same case with one configured org, which is every deployment we run:
   *  "every org failed" and "the read failed" are the same sentence there. */
  it('throws rather than 404ing on a single-org deployment whose one org is unreadable', async () => {
    graphql.mockRejectedValue(new Error('bad creds'));
    const failed = await board(ALPHA)
      .api.detail({ user: HUMAN }, '3')
      .catch((err: unknown) => err);
    expect(failed).not.toBeInstanceOf(NotFoundException);
    expect(String(failed)).toMatch(/bad creds/);
  });

  /**
   * THE BOARD PAGE'S OWN "not now" (#1107). The rollup earned this code in
   * #1035 and this read did not, so a quota cooldown reached a board page as an
   * uncoded 500 — indistinguishable there from the FORBIDDEN a withdrawn grant
   * arrives as, and #1065's browser rule cleared the open board over it. #1003
   * had decided a cooldown leaves Projects drawn. Both reads throw through
   * `ProjectsService.totalFailure` now, so the same failure gets the same
   * verdict whichever of them met it.
   *
   * The pair below is the rollup's pair, run against `detail` instead of
   * `list`, deliberately: two reads answering one question differently is the
   * defect, so the assertion is the same assertion.
   */
  it.each([
    ['a Github outage', () => Object.assign(new Error('Bad Gateway'), { status: 502 })],
    ['a quota cooldown', () => new GithubQuotaCooldownError(Date.now() + 60_000)],
  ])('answers a board read with a 503 coded "not now" when every org failed with %s', async (_what, failure) => {
    graphql.mockRejectedValue(failure());
    const failed = await board().api.detail({ user: HUMAN }, '3').catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(ServiceUnavailableException);
    const refusal = failed as ServiceUnavailableException;
    expect(refusal.getStatus()).toBe(503);
    // What Nest writes to the wire: there is no exception filter in this app.
    expect(refusal.getResponse()).toEqual({ message: expect.any(String), code: PROJECTS_NOT_NOW_CODE });
  });

  /**
   * #1395. This answered a bare 500 until the browser stopped reading a 500 as a
   * withdrawal. A grant taken away arrives from GraphQL as `FORBIDDEN` on a 200
   * and carries no HTTP status, so a 500 was the only thing left to say, and the
   * browser would now keep the board on screen for the rest of the copy's day.
   * The status says it instead.
   */
  it('answers 403 when a failure says "not you", so the browser withdraws the board', async () => {
    graphql.mockRejectedValue(Object.assign(new Error('Resource not accessible'), { errors: [{ type: 'FORBIDDEN' }] }));
    const failed = await board().api.detail({ user: HUMAN }, '3').catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(ForbiddenException);
    expect((failed as ForbiddenException).getStatus()).toBe(403);
  });

  /** One org cooling down and one refusing is not a cooldown. `servableRefusal`
   *  reads every failure, and "not you" anywhere disqualifies the whole set —
   *  the same rule the rollup follows, checked here because this read collects
   *  its failures itself rather than through `perOrg`. */
  it('is a 403 when one org cooled down and another said "not you"', async () => {
    answerBoth({
      [ALPHA]: () => {
        throw new GithubQuotaCooldownError(Date.now() + 60_000);
      },
      [BETA]: () => {
        throw Object.assign(new Error('Resource not accessible'), { errors: [{ type: 'FORBIDDEN' }] });
      },
    });
    const failed = await board().api.detail({ user: HUMAN }, '3').catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(ForbiddenException);
  });

  /** The other direction of the same tolerance: an org that DID answer, and
   *  does not hold the number, is a real 404 however badly a second org fared. */
  it('is still a 404 when the org that answered simply does not hold the number', async () => {
    answerBoth(down(ALPHA));
    await expect(board().api.detail({ user: HUMAN }, '9')).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * The background half of the same outage. A stale board is served at once and
   * refreshed behind the caller (#304), and that refresh has nobody waiting on
   * it — so under Node's default an org that cannot be reached takes board-api
   * down rather than logging a line. `DeliveryService.orgRollup` and
   * `IssueBucketsService.getBuckets` both handle it on the identical branch.
   *
   * Reachable on every board open now rather than only on that org's own boards,
   * because the detail read walks the whole scope.
   */
  it('handles the background refresh of a stale board whose org went down', async () => {
    answerBoth();
    // A TTL of zero makes every hit a stale hit, so the SWR branch is reached
    // without a clock to move: the first read caches, the second one serves what
    // it cached and fires the refresh.
    const { api } = board(`${ALPHA},${BETA}`, 0);
    expect((await api.detail({ user: HUMAN }, '3')).org).toBe(ALPHA);
    answerBoth(down(ALPHA));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      // Still served without a wait, which is what SWR is for...
      expect((await api.detail({ user: HUMAN }, '3')).name).toBe('alpha three');
      // ...and the refresh it fired lands on a handler rather than on the process.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('"Sync now" warms every org in scope (#697)', () => {
  it('warms EVERY configured org, not just the first', async () => {
    answerBoth();
    const { api, service } = board();
    await service.resync();
    expect(new Set(owners())).toEqual(new Set([ALPHA, BETA]));
    // Warm means warm: the surface is served whole out of cache, with no
    // further fetch. Warming one org leaves the rest of the page as stale as it
    // was, which is the one outcome that button must not have.
    const fetched = graphql.mock.calls.length;
    const { projects } = await api.list({ user: HUMAN });
    expect(projects.map((p) => p.name).sort()).toEqual([
      'alpha one',
      'alpha three',
      'beta five',
      'beta three',
    ]);
    expect(graphql.mock.calls.length).toBe(fetched);
  });
});

describe('/api/projects — one org failing does not blank the others (#697)', () => {
  it("serves the LATER org's boards when the first one fails", async () => {
    // The first org failing is the direction that matters: a fan-out that
    // aborted on the first rejection would blank a surface the second org could
    // have filled.
    answerBoth({
      [ALPHA]: () => {
        throw new Error('bad creds');
      },
    });
    const { projects } = await board().api.list({ user: HUMAN });
    expect(projects.map((p) => p.name).sort()).toEqual(['beta five', 'beta three']);
  });

  it("serves the FIRST org's boards when a later one fails", async () => {
    answerBoth({
      [BETA]: () => {
        throw new Error('bad creds');
      },
    });
    const { projects } = await board().api.list({ user: HUMAN });
    expect(projects.map((p) => p.name).sort()).toEqual(['alpha one', 'alpha three']);
  });

  it('keeps the catalog and the membership index of the readable org too', async () => {
    answerBoth({
      [ALPHA]: () => {
        throw new Error('bad creds');
      },
    });
    const b = board();
    expect((await b.api.catalog()).map((c) => c.number).sort()).toEqual([3, 5]);
    expect((await b.service.projectMemberships()).map((m) => m.number).sort()).toEqual([3, 5]);
  });

  it('still fails the read when EVERY org fails, as a single-org board does today', async () => {
    graphql.mockRejectedValue(new Error('bad creds'));
    await expect(board().api.list({ user: HUMAN })).rejects.toThrow(/bad creds/);
  });

  // The CODE is what the browser reads to decide whether its saved copy may
  // stand in (#1035). Not the status (#1042 review): board-api also answers 503
  // for an access check it will not release, and the browser drew its copy
  // over that too while a 503 was all it looked at.
  it.each([
    ['a Github outage', () => Object.assign(new Error('Bad Gateway'), { status: 502 })],
    ['a quota cooldown', () => new GithubQuotaCooldownError(Date.now() + 60_000)],
  ])('answers a 503 coded "not now" when every org failed with %s', async (_what, failure) => {
    graphql.mockRejectedValue(failure());
    const failed = await board().api.list({ user: HUMAN }).catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(ServiceUnavailableException);
    const refusal = failed as ServiceUnavailableException;
    expect(refusal.getStatus()).toBe(503);
    // What Nest writes to the wire: there is no exception filter in this app.
    expect(refusal.getResponse()).toEqual({ message: expect.any(String), code: PROJECTS_NOT_NOW_CODE });
    expect(PROJECTS_NOT_NOW_CODE).toBe('projects_not_now');
  });

  // #1395: the rollup says it with a status too, for the reason the board read
  // above gives. A 500 is "not now" to the browser now, and a withdrawn grant is
  // not something a reader may go on seeing for the rest of the day.
  it('answers 403 when a failure says "not you", so the browser draws no copy over it', async () => {
    graphql.mockRejectedValue(Object.assign(new Error('Resource not accessible'), { errors: [{ type: 'FORBIDDEN' }] }));
    const failed = await board().api.list({ user: HUMAN }).catch((err: unknown) => err);
    expect(failed).toBeInstanceOf(ForbiddenException);
    expect((failed as ForbiddenException).getStatus()).toBe(403);
  });
});

describe('/api/projects — one org, and a pin, behave exactly as before (#697)', () => {
  it('a single-org deployment reads that org and no other', async () => {
    answerBoth();
    const { projects } = await board(ALPHA).api.list({ user: HUMAN });
    expect(projects.map((p) => p.name).sort()).toEqual(['alpha one', 'alpha three']);
    expect(new Set(owners())).toEqual(new Set([ALPHA]));
  });

  it('an org the scope does not name is a 404, before anything reads', async () => {
    answerBoth();
    await expect(
      board(BETA).api.list({ user: HUMAN }, ALPHA),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(owners()).toEqual([]);
  });

  it('an owner scope naming no org answers none, rather than every org', async () => {
    // `PROJECTS_OWNER=''` used to produce this and is retired (#1209 part 4).
    // What produces it now is a person whose Github App grants cover no owner,
    // and a `ConfigService` a spec built without a usable `GITHUB_ORGS`.
    answerBoth();
    await expect(board('   ').api.list({ user: HUMAN })).rejects.toThrow(/GITHUB_ORGS/);
    expect(owners()).toEqual([]);
  });
});
