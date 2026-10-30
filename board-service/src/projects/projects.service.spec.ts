import { githubContext, type GithubPrincipal } from '../auth/github-principal';
import { asRollupGithub } from './github-projects.test-double';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProjectsService, WARM_WALK_MAX_MS } from './projects.service';
import { GithubProjectsSource } from './github-projects.source';
import { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import {
  IProjectsSource,
  ProjectDetailRaw,
  ProjectRollup,
  ProjectSummary,
  SourceCatalogEntry,
  SourceMembership,
} from './project.types';

/**
 * The org this file's boards, memberships and ingest outcomes are written
 * against, pinned rather than defaulted (#1166).
 *
 * It was `GITHUB_ORGS`'s default too, so a stub config that set nothing matched
 * these fixtures by accident until the organisation was renamed to `acme`.
 * `pinned({ ... })` adds the keys a case actually steers.
 */
const SAMPLE_ORG = 'acme';
/** The repository the old feedback form filed into. No default since #1175, and
 *  every issue-reading service builds the submission-visibility scope in its
 *  constructor, so a config naming none refuses to construct. */
const SAMPLE_FEEDBACK_REPO = `${SAMPLE_ORG}/board`;

const pinned = (values: Record<string, unknown> = {}) => {
  const env: Record<string, unknown> = {
    GITHUB_ORGS: SAMPLE_ORG,
    FEEDBACK_REPO: SAMPLE_FEEDBACK_REPO,
    ...values,
  };
  return { get: (k: string, d?: unknown) => env[k] ?? d } as unknown as ConfigService;
};

/** The viewer these cache tests read as; who it is doesn't matter here (the
 *  visibility rule has its own specs), only that the SWR ladder is unchanged. */
const HUMAN = { agent: false, email: 'octocat@example.com' };

/** A stub source that counts calls, so we can assert the cache actually spares
 *  the backing GitHub round-trip (#304). getProject is a spy we can re-point. */
function makeSource() {
  const summary = (number: number): ProjectRollup => ({
    number,
    name: `Board ${number}`,
    url: `https://github.com/orgs/x/projects/${number}`,
    status: 'active',
    open: 1,
    closed: 1,
    pct: 50,
    excludedItems: 0, // issues only, like every board we run (#517)
    itemsComplete: true, // read whole, as every board a source hands up is unless it says otherwise (#690)
    recentCloses: [],
    weeklyClosed: [],
    closedThisWeek: 0,
    openedThisWeek: 0,
    contributors: [],
    contributorsByAssignee: [],
  });
  const detail = (number: number): ProjectDetailRaw => ({ ...summary(number), items: [] });
  const source: IProjectsSource = {
    listProjects: vi.fn(async () => [summary(1)]),
    getProject: vi.fn(async (_org: string, n: number) => detail(n)),
    projectMemberships: vi.fn(async (): Promise<SourceMembership[]> => []),
    listProjectCatalog: vi.fn(async (): Promise<SourceCatalogEntry[]> => []),
    disownInFlightReads: vi.fn(),
  };
  return { source, detail };
}

function svc(source: IProjectsSource, ttlMs = 300_000) {
  // The TTL is the only setting these tests steer. The other two are named
  // below rather than steered, and since #1175 neither has a default — but they
  // are read at different MOMENTS, so they fail differently: the feedback scope
  // is built in the constructor (#497), so a config naming no FEEDBACK_REPO
  // never constructs, while the org scope is resolved per call, so a config
  // naming no GITHUB_ORGS constructs and then refuses every read.
  const config = {
    get: (key: string, d?: unknown) =>
      key === 'GITHUB_ORGS' ? SAMPLE_ORG : key === 'FEEDBACK_REPO' ? SAMPLE_FEEDBACK_REPO : key === 'PROJECTS_CACHE_TTL_MS' ? ttlMs : d,
  } as unknown as ConfigService;
  // The rollup's weekly-close join (#391) reads the shared issues cache; these
  // SWR tests only exercise getProject, so an empty list suffices.
  const issuesCache = {
    getIssues: async () => ({ issues: [], at: Date.now() }),
    // The recency pick asks for the submission marker (#516); these tests are
    // about caching, so it answers "every body read, no footer found".
    submissionIndex: async () => ({ lookup: () => false }),
  } as unknown as IssuesCacheService;
  return new ProjectsService(source, config, issuesCache);
}

/**
 * What a cold Projects read costs Github (#518).
 *
 * The rollup and the membership index are two shapes of ONE list query, and the
 * service asks for them together — so the thing worth pinning is not which layer
 * shares the fetch, but that a cold read reaches Github once. These tests run the
 * REAL `GithubProjectsSource` under the service with a stubbed GraphQL client and
 * count the calls: a stub source could only prove the service called two methods,
 * which is exactly the arrangement that cost two round trips.
 */
describe('ProjectsService — one cold read, one list query (#518)', () => {
  const BOARD_URL = 'https://github.com/acme/board/issues';
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const CLOSED_AT = daysAgo(2);

  /** One surfaced board: an open issue and a close from two days ago. */
  const listPayload = () => ({
    organization: {
      projectsV2: {
        nodes: [
          {
            number: 7,
            title: 'Acme Go-To-Market',
            url: 'https://github.com/orgs/acme/projects/7',
            closed: false,
            items: {
              totalCount: 2,
              nodes: [
                {
                  content: {
                    __typename: 'Issue',
                    number: 100,
                    title: 'Open one',
                    url: `${BOARD_URL}/100`,
                    state: 'OPEN',
                    repository: { nameWithOwner: 'acme/board' },
                    author: { login: 'octocat' },
                    labels: { totalCount: 0, nodes: [] },
                    assignees: { nodes: [{ login: 'octocat' }] },
                    timelineItems: { nodes: [] },
                  },
                },
                {
                  content: {
                    __typename: 'Issue',
                    number: 101,
                    title: 'Closed one',
                    url: `${BOARD_URL}/101`,
                    state: 'CLOSED',
                    closedAt: CLOSED_AT,
                    repository: { nameWithOwner: 'acme/board' },
                    author: { login: 'octocat' },
                    labels: { totalCount: 0, nodes: [] },
                    assignees: { nodes: [{ login: 'IvanRoslov' }] },
                    timelineItems: { nodes: [{ __typename: 'ClosedEvent', actor: { login: 'IvanRoslov' } }] },
                  },
                },
              ],
            },
          },
        ],
      },
    },
  });

  /** The real live source with its GraphQL client stubbed, plus the call counter. */
  function liveSource() {
    const graphql = vi.fn().mockResolvedValue(listPayload());
    const source = new GithubProjectsSource(pinned());
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    source.graphql = asRollupGithub(graphql);
    return { source, graphql };
  }

  /** The service, wired to an issues cache that knows the board's one close — so
   *  the weekly-close join (#391) has something to find and the numbers below are
   *  derived, not defaulted. */
  function liveSvc(source: IProjectsSource) {
    const config = {
      get: (key: string, d?: unknown) =>
        key === 'GITHUB_ORGS' ? SAMPLE_ORG : key === 'FEEDBACK_REPO' ? SAMPLE_FEEDBACK_REPO : key === 'PROJECTS_CACHE_TTL_MS' ? 300_000 : d,
    } as unknown as ConfigService;
    const issuesCache = {
      getIssues: async () => ({
        issues: [
          { htmlUrl: `${BOARD_URL}/101`, closedAt: CLOSED_AT },
          { htmlUrl: `${BOARD_URL}/100`, closedAt: null },
        ],
        at: Date.now(),
      }),
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    return new ProjectsService(source, config, issuesCache);
  }

  it('reaches Github once for a cold rollup read', async () => {
    const { source, graphql } = liveSource();
    await liveSvc(source).listProjects(HUMAN);

    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('serves the rollup and the membership index off that one read', async () => {
    const { source, graphql } = liveSource();
    const service = liveSvc(source);

    const [board] = await service.listProjects(HUMAN);
    const memberships = await service.projectMemberships();

    expect(graphql).toHaveBeenCalledTimes(1);
    // The rollup's numbers, unchanged: one open, one closed, half done.
    expect(board).toMatchObject({ number: 7, name: 'Acme Go-To-Market', open: 1, closed: 1, pct: 50 });
    // The recency line still names the close, attributed to whoever closed it.
    expect(board.lastClosed).toMatchObject({ number: 101, by: 'IvanRoslov', atISO: CLOSED_AT });
    // The ring's runs still add up to the board's closed count.
    expect(board.contributors).toEqual([{ login: 'IvanRoslov', closed: 1, kind: 'person' }]);
    // The weekly join found the close through the membership index — the last
    // slot is the trailing week, so a two-day-old close lands there.
    expect(board.weeklyClosed[board.weeklyClosed.length - 1]).toBe(1);
    expect(board.closedThisWeek).toBe(1);
    // And the index issues-metrics reads is the board's whole issue-URL set,
    // now naming the org it came from (#697) — the field that tells two orgs'
    // board 7 apart once the index is a union.
    expect(memberships).toEqual([
      {
        org: 'acme',
        number: 7,
        name: 'Acme Go-To-Market',
        issueUrls: [`${BOARD_URL}/100`, `${BOARD_URL}/101`],
      },
    ]);
  });

  it('reaches Github once when the membership read is what warms the cache', async () => {
    const { source, graphql } = liveSource();
    const service = liveSvc(source);

    // issues-metrics asks first (the queue's project join), the rollup after.
    const [memberships, boards] = await Promise.all([service.projectMemberships(), service.listProjects(HUMAN)]);

    expect(graphql).toHaveBeenCalledTimes(1);
    expect(memberships[0].issueUrls).toHaveLength(2);
    expect(boards[0].number).toBe(7);
  });
});

describe('ProjectsService.getProject SWR cache (#304)', () => {
  it('fetches once on a cold board, then serves the fresh entry from cache', async () => {
    const { source } = makeSource();
    const service = svc(source);

    const a = await service.getProject(7, HUMAN);
    const b = await service.getProject(7, HUMAN);

    expect(a?.number).toBe(7);
    expect(b).toEqual(a);
    // Second open inside the TTL must not hit the source again.
    expect(source.getProject).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent cold opens of the same board into one fetch', async () => {
    const { source } = makeSource();
    const service = svc(source);

    const [a, b] = await Promise.all([service.getProject(3, HUMAN), service.getProject(3, HUMAN)]);

    expect(a?.number).toBe(3);
    expect(b?.number).toBe(3);
    expect(source.getProject).toHaveBeenCalledTimes(1);
  });

  it('caches each board separately', async () => {
    const { source } = makeSource();
    const service = svc(source);

    await service.getProject(1, HUMAN);
    await service.getProject(2, HUMAN);
    await service.getProject(1, HUMAN);

    expect(source.getProject).toHaveBeenCalledTimes(2); // 1 and 2, not a third for the re-open
  });

  it('serves a stale entry immediately and refreshes it in the background', async () => {
    const { source, detail } = makeSource();
    const service = svc(source, 0); // TTL 0 → every existing entry is already stale

    const first = await service.getProject(9, HUMAN);
    expect(first?.name).toBe('Board 9');
    expect(source.getProject).toHaveBeenCalledTimes(1);

    // Re-point the source so a genuine refetch is observable.
    (source.getProject as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...detail(9),
      name: 'Board 9 (fresh)',
    });

    // Stale read returns the OLD payload synchronously-ish (no await on the fetch)…
    const stale = await service.getProject(9, HUMAN);
    expect(stale?.name).toBe('Board 9'); // served stale, not the refreshed value
    expect(source.getProject).toHaveBeenCalledTimes(2); // …but kicked a background refresh

    // Let the background refresh settle; the cache now holds the fresh payload.
    await new Promise((r) => setTimeout(r, 0));
    const after = await service.getProject(9, HUMAN);
    expect(after?.name).toBe('Board 9 (fresh)');
  });
});

/**
 * Every Projects cache is an answer ABOUT an org (#648), so each is keyed by the
 * org the fetch was made against. One instance is driven across two orgs by
 * changing what the mocked ConfigService returns between reads — which is what a
 * request-supplied org would do later.
 *
 * Both orgs run board number 7 on purpose: that is the collision the old
 * number-only key could not survive, and the nested `Map<org, Map<number, …>>`
 * keeps it apart without a composite key.
 */
describe('ProjectsService — caches keyed by org (#648)', () => {
  const ALPHA = 'org-alpha';
  const BETA = 'org-beta';

  /** Two orgs' board 7. Names are the same LENGTH and the counts all differ, so
   *  serving one org's board for the other changes what a reader sees on every
   *  field — never just how much of it there is. */
  const rollupFor = (org: string): ProjectRollup => ({
    number: 7,
    name: org === ALPHA ? 'Alpha board' : 'Bravo board',
    url: `https://github.com/orgs/${org}/projects/7`,
    status: 'active',
    open: org === ALPHA ? 1 : 3,
    closed: org === ALPHA ? 1 : 5,
    pct: org === ALPHA ? 50 : 63,
    excludedItems: 0,
    itemsComplete: true, // read whole, as every board a source hands up is unless it says otherwise (#690)
    recentCloses: [],
    weeklyClosed: [],
    closedThisWeek: 0,
    openedThisWeek: 0,
    contributors: [],
    contributorsByAssignee: [],
  });

  /** A source that answers for whichever org it is ASKED about (#697). It used
   *  to read the configured org at call time, because the source took no org and
   *  the only way to steer it was the config the service read; now the org is an
   *  argument, so it answers the one it was given — which is also what makes a
   *  slow fetch still belong to the org that started it. */
  function orgSource(delayMs = 0) {
    const settle = <T>(v: T): Promise<T> =>
      delayMs ? new Promise((r) => setTimeout(() => r(v), delayMs)) : Promise.resolve(v);
    const source: IProjectsSource = {
      listProjects: vi.fn((org: string) => settle([rollupFor(org)])),
      getProject: vi.fn((org: string, n: number) => settle({ ...rollupFor(org), number: n, items: [] })),
      projectMemberships: vi.fn((org: string) =>
        settle<SourceMembership[]>([
          { number: 7, name: rollupFor(org).name, issueUrls: [`https://github.com/${org}/r/issues/1`] },
        ]),
      ),
      listProjectCatalog: vi.fn((org: string) =>
        settle<SourceCatalogEntry[]>([{ id: `PVT_${org}`, number: 7, title: rollupFor(org).name }]),
      ),
      disownInFlightReads: vi.fn(),
    };
    return source;
  }

  /** A service whose configured org can change between reads. */
  function make(source: IProjectsSource, initial: string, ttlMs = 300_000) {
    let org = initial;
    const config = {
      get: (key: string, d?: unknown) =>
        key === 'FEEDBACK_REPO'
          ? SAMPLE_FEEDBACK_REPO
          : key === 'GITHUB_ORGS'
            ? org
            : key === 'PROJECTS_CACHE_TTL_MS'
              ? ttlMs
              : d,
    } as unknown as ConfigService;
    const issuesCache = {
      getIssues: async () => ({ issues: [], at: Date.now() }),
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    return {
      service: new ProjectsService(source, config, issuesCache),
      current: () => org,
      use: (next: string) => {
        org = next;
      },
    };
  }

  /** The five org-keyed maps, read off the instance by their declared names. */
  const MAPS = [
    'rollupByOrg',
    'membershipsByOrg',
    'catalogByOrg',
    'detailByOrg',
    'detailInFlightByOrg',
  ] as const;
  const mapOf = (svc: ProjectsService, name: (typeof MAPS)[number]) =>
    (svc as unknown as Record<string, Map<string, unknown>>)[name];

  it('one configured org allocates exactly one slot', async () => {
    const source = orgSource();
    const { service } = make(source, 'acme');

    await service.listProjects(HUMAN);
    await service.projectMemberships();
    await service.listProjectCatalog();
    await service.getProject(7, HUMAN);
    await service.getProject(8, HUMAN);

    for (const name of MAPS) {
      expect(mapOf(service, name).size, name).toBe(1);
      expect([...mapOf(service, name).keys()], name).toEqual(['acme']);
    }
  });

  it("two orgs' answers do not overwrite each other", async () => {
    const source = orgSource();
    const { service, use: follow } = make(source, ALPHA);

    const [alphaBoard] = await service.listProjects(HUMAN);
    const alphaDetail = await service.getProject(7, HUMAN);
    const alphaCatalog = await service.listProjectCatalog();
    const alphaMemberships = await service.projectMemberships();

    follow(BETA);
    const [betaBoard] = await service.listProjects(HUMAN);
    const betaDetail = await service.getProject(7, HUMAN);
    const betaCatalog = await service.listProjectCatalog();
    const betaMemberships = await service.projectMemberships();

    // Every cache holds both orgs at once — neither read evicted the other.
    for (const name of MAPS) {
      expect(mapOf(service, name).size, name).toBe(2);
      expect([...mapOf(service, name).keys()].sort(), name).toEqual([ALPHA, BETA]);
    }
    // Same board number, two different boards — each read got its own org's.
    expect(alphaBoard).toMatchObject({ number: 7, name: 'Alpha board', open: 1, closed: 1, pct: 50 });
    expect(betaBoard).toMatchObject({ number: 7, name: 'Bravo board', open: 3, closed: 5, pct: 63 });
    expect(alphaDetail?.name).toBe('Alpha board');
    expect(betaDetail?.name).toBe('Bravo board');
    expect(alphaCatalog[0].id).toBe(`PVT_${ALPHA}`);
    expect(betaCatalog[0].id).toBe(`PVT_${BETA}`);
    expect(alphaMemberships[0].issueUrls[0]).toContain(ALPHA);
    expect(betaMemberships[0].issueUrls[0]).toContain(BETA);

    // Back on alpha: served from alpha's slot, still alpha's board, no refetch.
    follow(ALPHA);
    const callsBefore = (source.listProjects as ReturnType<typeof vi.fn>).mock.calls.length;
    const [alphaAgain] = await service.listProjects(HUMAN);
    expect(alphaAgain).toEqual(alphaBoard);
    expect((source.listProjects as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    expect((await service.getProject(7, HUMAN))?.name).toBe('Alpha board');
  });

  it('the detail dedupe is per-org: the same board open in two orgs is two fetches', async () => {
    const source = orgSource(5);
    const { service, use } = make(source, ALPHA);

    const alphaOpen = service.getProject(7, HUMAN); // alpha's board 7, still in flight…
    use(BETA);
    const betaOpen = service.getProject(7, HUMAN); // …beta's board 7 must not ride it
    const [alpha, beta] = await Promise.all([alphaOpen, betaOpen]);

    expect(source.getProject).toHaveBeenCalledTimes(2);
    expect(alpha?.name).toBe('Alpha board');
    expect(beta?.name).toBe('Bravo board');
  });

  it('resync drops this org only, leaving another org’s answers untouched', async () => {
    const source = orgSource();
    const { service, use: follow } = make(source, ALPHA);

    await service.listProjects(HUMAN);
    follow(BETA);
    await service.listProjects(HUMAN);

    // Sync now, standing in beta: beta refetches, alpha's slot survives.
    await service.resync();
    expect(mapOf(service, 'rollupByOrg').size).toBe(2);

    const callsBefore = (source.listProjects as ReturnType<typeof vi.fn>).mock.calls.length;
    follow(ALPHA);
    const [alphaAfter] = await service.listProjects(HUMAN);
    expect(alphaAfter).toMatchObject({ number: 7, name: 'Alpha board' });
    expect((source.listProjects as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });
});

/**
 * The week figure joins the gate the day series already stands behind (#715).
 *
 * `weeklyClosed` and `closedThisWeek` come from the same org-wide issues ↔
 * membership join the day series does, over the same read: a board whose items
 * came up short has a membership list short by exactly those items, and project
 * items arrive in board position order, so what a short read loses is the newest
 * end — most of a week bucket. Serving a 0 there claims a quiet board on what may
 * be the busiest one in the org, so the board serves an empty `weeklyClosed` and
 * no `closedThisWeek` at all, the way #690 already withholds the day series.
 *
 * Driven through `ProjectsService.listProjects`, where the gate sits.
 */
describe('ProjectsService withholds the week figure from a board read short (#715)', () => {
  const CLOSED_AT = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const issueUrl = (n: number) => `https://github.com/acme/board/issues/${n}`;

  /** A board carrying a source seed on both week fields, so the withholding can
   *  be told from a board that simply had nothing to seed. */
  const board = (number: number, itemsComplete: boolean): ProjectRollup => ({
    number,
    name: `Board ${number}`,
    url: `https://github.com/orgs/x/projects/${number}`,
    status: 'active',
    open: 1,
    closed: 1,
    pct: 50,
    excludedItems: 0,
    itemsComplete,
    recentCloses: [],
    weeklyClosed: [0, 0, 0, 0, 0, 0, 0, 0, 0, 5],
    closedThisWeek: 5,
    openedThisWeek: 0,
    contributors: [],
    contributorsByAssignee: [],
  });

  /** Boards 9 and 10 hold one closed issue each and the join can see both;
   *  board 11 is on no membership at all, so its figures can only come from the
   *  seed above — the other half of the fallback at the gate. */
  function service(boards: ProjectRollup[]): ProjectsService {
    const source: IProjectsSource = {
      listProjects: async () => boards,
      getProject: async () => null,
      projectMemberships: async (): Promise<SourceMembership[]> => [
        { number: 9, name: 'Board 9', issueUrls: [issueUrl(9)] },
        { number: 10, name: 'Board 10', issueUrls: [issueUrl(10)] },
      ],
      listProjectCatalog: async (): Promise<SourceCatalogEntry[]> => [],
      disownInFlightReads: vi.fn(),
    };
    const config = pinned();
    const issuesCache = {
      getIssues: async () => ({
        issues: [
          { htmlUrl: issueUrl(9), closedAt: CLOSED_AT, createdAt: CLOSED_AT },
          { htmlUrl: issueUrl(10), closedAt: CLOSED_AT, createdAt: CLOSED_AT },
        ],
        at: Date.now(),
      }),
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    return new ProjectsService(source, config, issuesCache);
  }

  it('withholds it from a short board the join DID find closes for', async () => {
    const [short, whole] = await service([board(9, false), board(10, true)]).listProjects(HUMAN);

    // The twin proves the join ran and found a close on both boards: same
    // memberships, same issues, same clock — the flag is the only difference.
    expect(whole.weeklyClosed[whole.weeklyClosed.length - 1]).toBe(1);
    expect(whole.closedThisWeek).toBe(1);

    expect(short.itemsComplete).toBe(false);
    expect(short.weeklyClosed).toEqual([]);
    // ABSENT, not 0: `closedThisWeek?: number` on the wire already, so an
    // undefined travels as no field at all rather than as a quiet board.
    expect(short.closedThisWeek).toBeUndefined();
    expect('closedThisWeek' in short).toBe(false);
  });

  it('withholds it from a short board whose figure came from the source seed', async () => {
    // Board 11 is on no membership, so the join produces nothing for it and the
    // fixture fallback would serve the seeded 5. The gate sits after that
    // fallback, so a truncated board is withheld either way.
    const [seeded] = await service([board(11, false)]).listProjects(HUMAN);

    expect(seeded.weeklyClosed).toEqual([]);
    expect('closedThisWeek' in seeded).toBe(false);
  });

  it('serves the SOURCE\u2019s seeded figure when the join and the seed series are both empty', async () => {
    // The other branch of `weeklyClosed.length ? … : seeded`, which every board
    // above takes the far side of. Board 11 is on no membership, so the join
    // produces nothing; its seed series is empty too, so there is no last slot
    // to read and the seeded count is the only figure there is — the fixture
    // source's whole reason for seeding one. Withheld nothing: this board was
    // read whole.
    const [board11] = await service([{ ...board(11, true), weeklyClosed: [] }]).listProjects(HUMAN);

    expect(board11.weeklyClosed).toEqual([]);
    expect(board11.closedThisWeek).toBe(5);
  });

  it('treats a board that made no claim as a board read whole, on both gates', async () => {
    // The frontend spells this gate `itemsComplete === false` and the service
    // spelled it `itemsComplete ? …`, so the two disagreed about an absent flag:
    // the service would have withheld where the row would have counted.
    // Unreachable from any source in the tree — `ProjectRollup.itemsComplete` is
    // a required boolean, which is what the cast below stands in for — so this
    // pins the two spellings to one answer rather than describing a live state.
    const noClaim = { ...board(9, true), itemsComplete: undefined as unknown as boolean };
    const [served] = await service([noClaim]).listProjects(HUMAN);

    expect(served.closedThisWeek).toBe(1);
    expect(served.weeklyClosed[served.weeklyClosed.length - 1]).toBe(1);
    // The day series stands behind the same gate and answers the same way.
    expect(served.dailyClosed.length).toBeGreaterThan(0);
  });
});

/**
 * A rollup whose org-wide join FAILED is told apart from an org that genuinely
 * closed nothing (#722).
 *
 * `rawIssues()` degrades to no join when the shared issues cache throws — which
 * must not blank the rollup, and does not. What it used to do as well was serve
 * the four figures derived from that join as if the join had run and found
 * nothing: an empty week series falls back to the source's seed, the week count
 * to the source's seeded 0, and both day series to fourteen zeros. Every board in
 * the org then claimed a quiet fortnight off an infrastructure failure, and the
 * rollup cache held that claim for the whole TTL.
 *
 * This is NOT `itemsComplete` and must never be folded into it: that flag says
 * one board was read short, this one says an org-wide join did not run. Both can
 * be true of one board at once, and they cost the reader different things.
 *
 * Driven through `ProjectsService.listProjects`, where the gate sits.
 */
describe('ProjectsService says when the org-wide pulse join did not run (#722)', () => {
  const CLOSED_AT = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const issueUrl = (n: number) => `https://github.com/acme/board/issues/${n}`;

  /** A board read WHOLE, carrying a source seed on both week fields — so a
   *  withheld figure can be told from a board that had nothing to seed, and so
   *  `itemsComplete` is never what is doing the withholding below. */
  const board = (number: number): ProjectRollup => ({
    number,
    name: `Board ${number}`,
    url: `https://github.com/orgs/x/projects/${number}`,
    status: 'active',
    open: 1,
    closed: 1,
    pct: 50,
    excludedItems: 0,
    itemsComplete: true,
    recentCloses: [
      {
        repo: 'acme/board',
        number,
        title: `Closed on board ${number}`,
        url: issueUrl(number),
        by: 'IvanRoslov',
        atISO: CLOSED_AT,
        labels: [],
        author: 'octocat',
      },
    ],
    weeklyClosed: [0, 0, 0, 0, 0, 0, 0, 0, 0, 5],
    closedThisWeek: 5,
    // Seeded NON-zero and different from the close seed (#851), so a test can
    // tell a seed served as a pair from a seed served beside the join's 0.
    openedThisWeek: 4,
    contributors: [{ login: 'IvanRoslov', closed: 1, kind: 'person' }],
    contributorsByAssignee: [{ login: 'IvanRoslov', closed: 1, kind: 'person' }],
  });

  /** The service, with the issues cache the pulse join reads handed in per test —
   *  the ONE thing that differs between a failed join and a quiet org. */
  function service(getIssues: () => Promise<{ issues: unknown[]; at: number }>) {
    const listProjects = vi.fn(async () => [board(9)]);
    const source: IProjectsSource = {
      listProjects,
      getProject: async () => null,
      projectMemberships: async (): Promise<SourceMembership[]> => [
        { number: 9, name: 'Board 9', issueUrls: [issueUrl(9)] },
      ],
      listProjectCatalog: async (): Promise<SourceCatalogEntry[]> => [],
      disownInFlightReads: vi.fn(),
    };
    const config = pinned();
    const issuesCache = {
      getIssues,
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    return { service: new ProjectsService(source, config, issuesCache), listProjects };
  }

  /** The issues cache refusing — an outage on the org-wide scan, not on the board. */
  const refuses = () => Promise.reject(new Error('issues cache unavailable'));
  /** The issues cache answering, with nothing closed anywhere — a quiet org. */
  const quiet = async () => ({ issues: [], at: Date.now() });
  /** The issues cache answering, with the board's one close in it. */
  const busy = async () => ({
    issues: [{ htmlUrl: issueUrl(9), closedAt: CLOSED_AT, createdAt: CLOSED_AT }],
    at: Date.now(),
  });

  it('withholds the five joined figures, and says so, when the join did not run', async () => {
    const [failed] = await service(refuses).service.listProjects(HUMAN);

    // Empty and ABSENT, the spelling #715 settled: fourteen zeros or a 0 week
    // count would claim a quiet fortnight on what may be the busiest board.
    expect(failed.weeklyClosed).toEqual([]);
    expect('closedThisWeek' in failed).toBe(false);
    // The fifth (#851). ABSENT for the reason its pair is: a card reading "0
    // opened" here would state a fact about a week nobody read.
    expect('openedThisWeek' in failed).toBe(false);
    expect(failed.dailyOpened).toEqual([]);
    expect(failed.dailyClosed).toEqual([]);
    // And the discriminator that says WHY they are missing.
    expect(failed.pulseJoined).toBe(false);
  });

  /**
   * The week line's two figures come from ONE place (#851).
   *
   * `readRollup` takes both from the org-wide join or both from the source's
   * seed. The card puts them in one sentence and asks the reader to compare
   * them, so a seeded close count beside a joined open count is a sentence that
   * lies — and it is the reading a straight `openedThisWeekOf(...)` would have
   * produced here, because the day series has no seed fallback of its own.
   *
   * The quiet org is where they part company: its join RAN and matched nothing,
   * so the week series falls back to the seed while the day series stays at the
   * join's fourteen honest zeros.
   */
  it('serves both week figures from the seed, or both from the join, never one of each', async () => {
    const [seeded] = await service(quiet).service.listProjects(HUMAN);
    const [joined] = await service(busy).service.listProjects(HUMAN);

    // Fell back: the week series is the source's, so the open count is too.
    expect(seeded.weeklyClosed).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
    expect(seeded.closedThisWeek).toBe(5);
    expect(seeded.openedThisWeek).toBe(4);
    // And NOT the day series' answer, which is what the pair must never be mixed
    // with — fourteen zeros from a join that matched nothing.
    expect(seeded.dailyOpened.every((v) => v === 0)).toBe(true);

    // Answered: both come off the join, and neither is the seed.
    expect(joined.closedThisWeek).toBe(1);
    expect(joined.openedThisWeek).toBe(1);
    expect(joined.openedThisWeek).not.toBe(4);
  });

  /**
   * The pair, on a board the join answered for (#851). `openedThisWeek` is the
   * trailing seven of `dailyOpened` and nothing else, so this asserts against
   * the series that shipped beside it rather than against a number retyped here
   * — a re-derivation in the spec would agree with a wrong service by
   * construction.
   */
  it('derives the week`s opens from the same day series it ships', async () => {
    const [board] = await service(busy).service.listProjects(HUMAN);

    expect(board.dailyOpened).toHaveLength(14);
    expect(board.openedThisWeek).toBe(board.dailyOpened.slice(-7).reduce((a, b) => a + b, 0));
    // The board's one issue was opened inside the week, so this is a figure and
    // not a coincidence of two zeros.
    expect(board.openedThisWeek).toBe(1);
  });

  it('leaves every figure that does not come from the join alone', async () => {
    const [failed] = await service(refuses).service.listProjects(HUMAN);

    expect(failed).toMatchObject({ number: 9, name: 'Board 9', open: 1, closed: 1, pct: 50 });
    expect(failed.lastClosed).toMatchObject({ number: 9, by: 'IvanRoslov', atISO: CLOSED_AT });
    expect(failed.contributors).toEqual([{ login: 'IvanRoslov', closed: 1, kind: 'person' }]);
    // NOT folded into the read-short gate: this board WAS read whole, and the
    // two claims must stay tellable apart.
    expect(failed.itemsComplete).toBe(true);
  });

  it('is distinguishable from an org that genuinely closed nothing', async () => {
    const [failed] = await service(refuses).service.listProjects(HUMAN);
    const [silent] = await service(quiet).service.listProjects(HUMAN);

    // The quiet org: the join RAN and found no close, so the week series falls
    // back to the source's seed and both day series are fourteen honest zeros.
    expect(silent.pulseJoined).not.toBe(false);
    expect(silent.weeklyClosed).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
    expect(silent.closedThisWeek).toBe(5);
    expect(silent.dailyClosed).toHaveLength(14);
    expect(silent.dailyClosed.every((v) => v === 0)).toBe(true);

    // Which is the whole point: the two payloads cannot be confused.
    expect(failed.weeklyClosed).not.toEqual(silent.weeklyClosed);
    expect(failed.dailyClosed).not.toEqual(silent.dailyClosed);
  });

  it('does not cache a rollup the join failed on', async () => {
    const getIssues = vi
      .fn<() => Promise<{ issues: unknown[]; at: number }>>()
      .mockImplementationOnce(refuses)
      .mockImplementation(busy);
    const { service: svc722, listProjects } = service(getIssues);

    const [first] = await svc722.listProjects(HUMAN);
    expect(first.pulseJoined).toBe(false);
    expect(first.weeklyClosed).toEqual([]);

    // A second read INSIDE the TTL. A cached failure would serve the withheld
    // board again for five minutes off one hiccup, so the source is asked again
    // and the recovered join is what the reader gets.
    const [second] = await svc722.listProjects(HUMAN);
    expect(listProjects).toHaveBeenCalledTimes(2);
    expect(second.pulseJoined).not.toBe(false);
    expect(second.weeklyClosed[second.weeklyClosed.length - 1]).toBe(1);
    expect(second.closedThisWeek).toBe(1);
    expect(second.dailyClosed).toHaveLength(14);

    // And THAT one is cached, so the recovery is not paid for on every read.
    const [third] = await svc722.listProjects(HUMAN);
    expect(listProjects).toHaveBeenCalledTimes(2);
    expect(third.closedThisWeek).toBe(1);
  });
});

/**
 * The join can fail for THIS org while the ingest itself succeeds (#722).
 *
 * `GithubIssuesSource.listIssues()` has three answers, not two: a per-repo
 * failure is logged and skipped, ONE org's enumeration failing is recorded as
 * `OrgReadOutcome.state = 'unreadable'` and the ingest runs on, and only losing
 * the scope entirely throws. `rawIssues()` read the throw and nothing else, so
 * the middle case — the likelier of the two — reported `joined: true` off an org
 * that contributed no issues at all. Every board in it then served a 0 week
 * count and fourteen zeros under `pulseJoined: true`, and the rollup was cached
 * for the TTL: verbatim the payload #722 exists to stop.
 *
 * `IssuesSnapshot` carries `orgs` beside `issues` and always has, which is what
 * makes this readable rather than derivable — the union of issues cannot say
 * which org it covers, and `OrgReadOutcome`'s own doc says an unreadable org is
 * "Never a counted zero".
 *
 * Driven through `ProjectsService.listProjects`, where the gate sits.
 */
describe('ProjectsService folds THIS org’s ingest outcome into the join (#722)', () => {
  const ORG = 'acme';
  const CLOSED_AT = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const issueUrl = (n: number) => `https://github.com/acme/board/issues/${n}`;

  /** A board read WHOLE by default, so `itemsComplete` is never what withholds
   *  below — and carrying a source seed on both week fields, so a withheld
   *  figure can be told from a board that had nothing to seed. */
  const board = (number: number, itemsComplete = true): ProjectRollup => ({
    number,
    name: `Board ${number}`,
    url: `https://github.com/orgs/${ORG}/projects/${number}`,
    status: 'active',
    open: 1,
    closed: 1,
    pct: 50,
    excludedItems: 0,
    itemsComplete,
    recentCloses: [],
    weeklyClosed: [0, 0, 0, 0, 0, 0, 0, 0, 0, 5],
    closedThisWeek: 5,
    openedThisWeek: 0,
    contributors: [],
    contributorsByAssignee: [],
  });

  /** One outcome as `GithubIssuesSource` records it, with the call it spent. */
  const outcome = (org: string, state: 'read' | 'unreadable') => ({
    org,
    state,
    reason: state === 'unreadable' ? 'HttpError: Bad credentials' : null,
    calls: 1,
  });

  /** The service under one snapshot. The ingest RESOLVES in every test here —
   *  that is the whole point: `rawIssues()` sees no throw, and the only thing
   *  that can say this org was not covered is the snapshot's `orgs`. */
  function service(orgs: ReturnType<typeof outcome>[], boards = [board(9)]) {
    const listProjects = vi.fn(async () => boards);
    const source: IProjectsSource = {
      listProjects,
      getProject: async () => null,
      projectMemberships: async (): Promise<SourceMembership[]> => [
        { number: 9, name: 'Board 9', issueUrls: [issueUrl(9)] },
      ],
      listProjectCatalog: async (): Promise<SourceCatalogEntry[]> => [],
      disownInFlightReads: vi.fn(),
    };
    const config = pinned();
    const issuesCache = {
      // Empty, exactly as an ingest whose only org failed to enumerate answers:
      // no repo was ever paged, so there is no issue in the union.
      getIssues: async () => ({ issues: [], at: Date.now(), orgs }),
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    return { service: new ProjectsService(source, config, issuesCache), listProjects };
  }

  it('withholds the four joined figures when THIS org’s enumeration failed', async () => {
    const [failed] = await service([outcome(ORG, 'unreadable')]).service.listProjects(HUMAN);

    // The payload #722 forbids, and the one this used to serve: a 0 week count
    // and fourteen zeros under a true flag.
    expect(failed.pulseJoined).toBe(false);
    expect(failed.weeklyClosed).toEqual([]);
    expect('closedThisWeek' in failed).toBe(false);
    expect(failed.dailyOpened).toEqual([]);
    expect(failed.dailyClosed).toEqual([]);
    // The board itself was read whole. The two gates stay apart.
    expect(failed.itemsComplete).toBe(true);
  });

  it('does not cache a rollup an unreadable org produced', async () => {
    // The other half of the cost: a cached "unreadable" serves the whole TTL off
    // one failed enumeration, and the read that would recover never happens.
    const { service: svc, listProjects } = service([outcome(ORG, 'unreadable')]);

    await svc.listProjects(HUMAN);
    await svc.listProjects(HUMAN);

    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it('matches the org case-insensitively, as Github resolves logins', async () => {
    // `scopeForRead` folds case for the same reason. An outcome recorded under a
    // differently-cased spelling of the SAME org is this org's outcome.
    const [failed] = await service([outcome('Acme', 'unreadable')]).service.listProjects(HUMAN);

    expect(failed.pulseJoined).toBe(false);
  });

  it('leaves the join alone when a DIFFERENT org is the unreadable one', async () => {
    // #647's whole point: the orgs that answered still carry real work. This
    // org's boards are joined against a union that covers them.
    const [served] = await service([outcome(ORG, 'read'), outcome('globex', 'unreadable')]).service.listProjects(
      HUMAN,
    );

    expect(served.pulseJoined).not.toBe(false);
    expect(served.dailyClosed).toHaveLength(14);
  });

  it('leaves the join alone on an EMPTY outcome list — a pin makes no claim', async () => {
    // An explicit `ISSUES_METRICS_REPOS` pin enumerates no org and records no
    // outcome, and the fixture source cannot answer at all. Neither is a
    // failure, and reading `[]` as one would withhold every figure on every
    // board of a deployment that works.
    const [served] = await service([]).service.listProjects(HUMAN);

    expect(served.pulseJoined).not.toBe(false);
    expect(served.weeklyClosed).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 5]);
    expect(served.dailyClosed).toHaveLength(14);
  });

  it('leaves the join alone when the ingest never mentioned this org', async () => {
    // `GITHUB_ORGS` feeds the projects scope and `ISSUES_METRICS_ORG` the
    // ingest, and they are allowed to disagree. An org the ingest never read is
    // an org it makes no claim about — not one it failed on.
    const [served] = await service([outcome('globex', 'read')]).service.listProjects(HUMAN);

    expect(served.pulseJoined).not.toBe(false);
  });
});

/**
 * `itemsComplete` and `pulseJoined` are TWO gates and neither derives the other
 * (#722).
 *
 * Six doc comments in this diff say so and nothing enforced it: replacing
 * `pulseJoined: joined` with `pulseJoined: readWhole && joined` — the exact fold
 * they forbid — left every board-service spec green, because the one case that
 * tells the two spellings apart was never constructed. The killer is a board
 * read SHORT while the join RAN: the fold reports a join that did not happen.
 * The both-false case below is the other missing corner, and it pins that each
 * gate withholds its own figures for its own reason.
 */
describe('ProjectsService keeps the read-short and join gates independent (#722)', () => {
  const CLOSED_AT = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const issueUrl = (n: number) => `https://github.com/acme/board/issues/${n}`;

  const board = (number: number, itemsComplete: boolean): ProjectRollup => ({
    number,
    name: `Board ${number}`,
    url: `https://github.com/orgs/x/projects/${number}`,
    status: 'active',
    open: 1,
    closed: 1,
    pct: 50,
    excludedItems: 0,
    itemsComplete,
    recentCloses: [],
    weeklyClosed: [0, 0, 0, 0, 0, 0, 0, 0, 0, 5],
    closedThisWeek: 5,
    openedThisWeek: 0,
    contributors: [],
    contributorsByAssignee: [],
  });

  function service(getIssues: () => Promise<unknown>, boards: ProjectRollup[]) {
    const source: IProjectsSource = {
      listProjects: async () => boards,
      getProject: async () => null,
      projectMemberships: async (): Promise<SourceMembership[]> => [
        { number: 9, name: 'Board 9', issueUrls: [issueUrl(9)] },
      ],
      listProjectCatalog: async (): Promise<SourceCatalogEntry[]> => [],
      disownInFlightReads: vi.fn(),
    };
    const config = pinned();
    const issuesCache = {
      getIssues,
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    return new ProjectsService(source, config, issuesCache);
  }

  const refuses = () => Promise.reject(new Error('issues cache unavailable'));
  const busy = async () => ({
    issues: [{ htmlUrl: issueUrl(9), closedAt: CLOSED_AT, createdAt: CLOSED_AT }],
    at: Date.now(),
    orgs: [],
  });

  it('says the join RAN on a board read short — the flag is not the read', async () => {
    // The case that kills the fold. `itemsComplete: false` withholds this
    // board's week and day figures (#715); the ORG's join still ran, and a
    // `pulseJoined: false` here would have the card say "this week's closes were
    // not read" about an org whose closes were read fine.
    const [short] = await service(busy, [board(9, false)]).listProjects(HUMAN);

    expect(short.itemsComplete).toBe(false);
    expect(short.pulseJoined).toBe(true);
    // The read-short gate still does its own job.
    expect(short.weeklyClosed).toEqual([]);
  });

  it('says both, separately, when the board was read short AND the join failed', async () => {
    // Never constructed before: the #722 fixture hardcodes `itemsComplete: true`
    // and the #715 fixture's issues cache always resolves. Both can be true of
    // one board at once, they cost the reader different things, and the payload
    // has to keep them tellable apart.
    const [both] = await service(refuses, [board(9, false)]).listProjects(HUMAN);

    expect(both.itemsComplete).toBe(false);
    expect(both.pulseJoined).toBe(false);
    expect(both.weeklyClosed).toEqual([]);
    expect(both.dailyClosed).toEqual([]);
  });

  it('says the board was read whole on a join that failed — the read is not the flag', async () => {
    const [whole] = await service(refuses, [board(9, true)]).listProjects(HUMAN);

    expect(whole.itemsComplete).toBe(true);
    expect(whole.pulseJoined).toBe(false);
  });
});

/**
 * The source's own in-flight board reads are disowned, and per org (#713).
 *
 * The service holds four maps it can clear itself and one latch it cannot — the
 * source's — so this call is the whole of the difference between a write that
 * re-reads Github and a write that is handed the flight from before it. Every
 * stub of `IProjectsSource` in this tree used to be a bare `() => {}`, so
 * nothing asserted the call happened at all: deleting both call sites left the
 * suite green.
 *
 * WHICH org it names is asserted here and its EFFECT in
 * `github-projects.source.spec.ts`, because the two layers can only say half of
 * it each: `refill` walks the whole scope, so a source that ignored the argument
 * and cleared everything would serve exactly the same boards through this one.
 */
describe('ProjectsService disowns the source board reads a write invalidated (#713)', () => {
  const ALPHA = 'org-alpha';
  const BETA = 'org-beta';

  function harness(orgs = `${ALPHA},${BETA}`) {
    const disownInFlightReads = vi.fn();
    const source: IProjectsSource = {
      listProjects: vi.fn(async (org: string): Promise<ProjectRollup[]> => [
        {
          number: 7,
          name: `Board of ${org}`,
          url: `https://github.com/orgs/${org}/projects/7`,
          status: 'active',
          open: 1,
          closed: 0,
          pct: 0,
          excludedItems: 0,
          itemsComplete: true,
          recentCloses: [],
          weeklyClosed: [],
          closedThisWeek: 0,
          openedThisWeek: 0,
          contributors: [],
          contributorsByAssignee: [],
        },
      ]),
      getProject: vi.fn(async () => null),
      projectMemberships: vi.fn(async (): Promise<SourceMembership[]> => []),
      listProjectCatalog: vi.fn(async (): Promise<SourceCatalogEntry[]> => []),
      disownInFlightReads,
    };
    const config = {
      get: (key: string, d?: unknown) =>
        key === 'GITHUB_ORGS' ? orgs : key === 'FEEDBACK_REPO' ? SAMPLE_FEEDBACK_REPO : key === 'PROJECTS_CACHE_TTL_MS' ? 300_000 : d,
    } as unknown as ConfigService;
    const issuesCache = {
      getIssues: async () => ({ issues: [], at: Date.now(), orgs: [] }),
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    return { service: new ProjectsService(source, config, issuesCache), disownInFlightReads };
  }

  it('names no org at a write, so every org the source holds is disowned', () => {
    const { service, disownInFlightReads } = harness();

    service.dropCaches();

    // A write is not told which org it landed in — see the argument in
    // `dropCaches`. Naming one here would leave the other org's reader holding
    // a flight that went out before the write.
    expect(disownInFlightReads.mock.calls).toEqual([[]]);
  });

  it('names each org in scope when it re-fills, and each of them once', async () => {
    const { service, disownInFlightReads } = harness();

    // `warmAfterWrite` and `resync` are one body (`refill`), so this covers the
    // button too — what differs between them is the catalog, not this.
    await service.warmAfterWrite();

    expect(disownInFlightReads.mock.calls).toEqual([[ALPHA], [BETA]]);
  });
});

/**
 * A write must not leave the pre-write boards in the cache (#713).
 *
 * `GithubProjectsSource` keeps a per-org latch over the board-list read
 * (`boardsInFlightByOrg`), and since #690 the fetch behind it is long — a board
 * list, then a sequential continuation for every board over a hundred items.
 * `ProjectsService.resync()` and `dropCaches()` clear their own maps and move
 * the epoch, and say nothing to the source, so the latch outlives the write.
 * The rollup the write itself triggers therefore joins the flight that went out
 * BEFORE it, snapshots the epoch after the write moved it, and passes the #692
 * guard with boards that predate the write — which is then served for the whole
 * five-minute TTL.
 *
 * Driven through the REAL source, because a stub `IProjectsSource` has no latch
 * and the defect lives in the seam between that latch and the service's epoch.
 * Asserted on what a reader is handed, not on which map holds what.
 */
describe('ProjectsService does not cache a rollup read from before a write (#713)', () => {
  const ISSUES = 'https://github.com/acme/board/issues';

  /** One surfaced board with one open issue — enough to tell two reads apart on
   *  every field a reader sees. */
  const listPayloadFor = (number: number, title: string) => ({
    organization: {
      projectsV2: {
        nodes: [
          {
            number,
            title,
            url: `https://github.com/orgs/acme/projects/${number}`,
            closed: false,
            items: {
              totalCount: 1,
              nodes: [
                {
                  content: {
                    __typename: 'Issue',
                    number: 100 + number,
                    title: `Issue on ${title}`,
                    url: `${ISSUES}/${100 + number}`,
                    state: 'OPEN',
                    repository: { nameWithOwner: 'acme/board' },
                    author: { login: 'octocat' },
                    labels: { totalCount: 0, nodes: [] },
                    assignees: { nodes: [] },
                    timelineItems: { nodes: [] },
                  },
                },
              ],
            },
          },
        ],
      },
    },
  });

  const BEFORE = listPayloadFor(1, 'Before the write');
  const AFTER = listPayloadFor(2, 'After the write');

  /** Lets the test hold the first board-list read open across the write. */
  function deferred<T>() {
    let settle!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
      settle = resolve;
    });
    return { promise, settle };
  }

  /** The real live source, its GraphQL client stubbed so the FIRST board-list
   *  read is held open by hand and every later one answers the post-write
   *  boards. Same shape as the #518 harness above. */
  function liveSource() {
    const first = deferred<unknown>();
    let calls = 0;
    const graphql = vi.fn(() => {
      calls += 1;
      return calls === 1 ? first.promise : Promise.resolve(AFTER);
    });
    const source = new GithubProjectsSource(pinned());
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    source.graphql = asRollupGithub(graphql);
    return { source, graphql, settleFirstRead: () => first.settle(BEFORE) };
  }

  function liveSvc(source: IProjectsSource) {
    const config = {
      get: (key: string, d?: unknown) =>
        key === 'GITHUB_ORGS' ? SAMPLE_ORG : key === 'FEEDBACK_REPO' ? SAMPLE_FEEDBACK_REPO : key === 'PROJECTS_CACHE_TTL_MS' ? 300_000 : d,
    } as unknown as ConfigService;
    const issuesCache = {
      // The join has to RUN, or the #722 guard would be what stops the cache
      // write and the race would never be reached.
      getIssues: async () => ({ issues: [], at: Date.now(), orgs: [] }),
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    return new ProjectsService(source, config, issuesCache);
  }

  /** Let every already-queued continuation run. */
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('serves the post-write boards when the write joined a read already in flight', async () => {
    const { source, graphql, settleFirstRead } = liveSource();
    const service = liveSvc(source);

    // Write A lands: its warm starts a board-list read that stays out.
    const warmA = service.warmAfterWrite();
    await tick();

    // Write B lands while A's read is still in flight — the interceptor's two
    // moves, in the order `WriteFreshnessInterceptor` makes them.
    service.dropCaches();
    const warmB = service.warmAfterWrite();
    await tick();

    // Only now does the read that went out before either write come back.
    settleFirstRead();
    await Promise.all([warmA, warmB]);

    // A reader inside the TTL must see the boards as they are AFTER the writes.
    const boards = await service.listProjects(HUMAN);
    expect(boards.map((b) => ({ number: b.number, name: b.name }))).toEqual([
      { number: 2, name: 'After the write' },
    ]);
    // TWO walks of Github for two writes, which is the bill `StaleOnWrite`
    // restates (#713): the write's warm can no longer join the flight that went
    // out before it, so each one pays a round trip. One trip per walk here —
    // this payload is a single board of a single item, under both of the caps
    // that would add pages.
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('makes "Sync now" read the source again rather than join a read already in flight', async () => {
    const { source, graphql, settleFirstRead } = liveSource();
    const service = liveSvc(source);

    // A page read goes out and is still walking Github when the button is
    // pressed — the same seam, reached through `resync` instead of a write.
    const early = service.listProjects(HUMAN);
    await tick();

    const synced = service.resync();
    await tick();
    settleFirstRead();
    await Promise.all([early, synced]);

    // "Sync now" answers for what it refreshed, so the read it warmed the cache
    // with cannot be the one that went out before the button.
    const boards = await service.listProjects(HUMAN);
    expect(boards.map((b) => ({ number: b.number, name: b.name }))).toEqual([
      { number: 2, name: 'After the write' },
    ]);
  });

  it('serves the next reader its own read, with no warm behind the write at all', async () => {
    const { source, graphql, settleFirstRead } = liveSource();
    const service = liveSvc(source);

    // The drop's OWN half of it, reached without a warm: `dropCaches` is called
    // on every write and the reader that arrives next is not always the warm.
    const early = service.listProjects(HUMAN);
    await tick();
    service.dropCaches();

    const after = service.listProjects(HUMAN);
    await tick();
    settleFirstRead();

    expect((await after).map((b) => ({ number: b.number, name: b.name }))).toEqual([
      { number: 2, name: 'After the write' },
    ]);
    // The reader after the drop pays for its own walk. Without the disown it
    // would join the first one and this would be 1 — with the pre-write boards.
    expect(graphql).toHaveBeenCalledTimes(2);
    await early;
  });

  it('leaves the flight it disowned resolving for the caller already awaiting it', async () => {
    const { source, graphql, settleFirstRead } = liveSource();
    const service = liveSvc(source);

    // Its own caller is owed this answer: forgetting the latch withdraws the
    // read from whoever comes NEXT, and cancels nothing.
    const early = service.listProjects(HUMAN);
    await tick();
    service.dropCaches();
    settleFirstRead();

    await expect(early).resolves.toMatchObject([{ number: 1, name: 'Before the write' }]);
    // And the disown started nothing: forgetting a latch costs no round trip.
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});

/**
 * A burst of writes costs one walk per org, not one each (#713).
 *
 * `FreshnessRegistry` fires `dropCaches()` + `warmAfterWrite()` on every
 * capability-declaring write, never awaits the warm, and debounces nothing. The
 * bill the plan comment on #713 measured is 63 GraphQL points per org per warm
 * against a 5,000/hour Projects-v2 budget — and the ceiling it names, ~24,000,
 * is reachable precisely because this lane took away the accidental cap: before
 * the disown, every warm in a burst joined the board-list latch already running
 * and the burst collapsed onto one walk. That collapsing was the bug.
 *
 * So the cap is deliberate now, and TRAILING rather than leading. A second write
 * marks the org and starts nothing; when the walk in flight lands, exactly one
 * more runs if anything marked it. Joining the running walk instead — the
 * obvious shape — would hand write B a read issued before B's own drop, which
 * the epoch guard then refuses to cache: every write after the first would pay a
 * walk that is thrown away. The two cases below are the two halves of that, and
 * the second is the one a leading join fails.
 *
 * Driven through the REAL source, because a walk is a Github round trip and a
 * stub `IProjectsSource` cannot say how many were made.
 */
describe('ProjectsService caps the warms a burst of writes starts (#713)', () => {
  /** One surfaced board, numbered for the READ that produced it — so which
   *  walk's answer ended up in the cache is a fact off the payload. */
  const boardFromRead = (read: number) => ({
    organization: {
      projectsV2: {
        nodes: [
          {
            number: read,
            title: `Boards as of walk ${read}`,
            url: `https://github.com/orgs/acme/projects/${read}`,
            closed: false,
            items: { totalCount: 0, nodes: [] },
          },
        ],
      },
    },
  });

  /** The real live source, every board-list walk held open until released. */
  function liveSource() {
    const held: { release: () => void; refuse: (why: string) => void }[] = [];
    const graphql = vi.fn(
      () =>
        new Promise((resolve, reject) => {
          const read = graphql.mock.calls.length;
          held.push({
            release: () => resolve(boardFromRead(read)),
            refuse: (why: string) => reject(new Error(why)),
          });
        }),
    );
    const source = new GithubProjectsSource(pinned());
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    source.graphql = asRollupGithub(graphql);
    return {
      source,
      graphql,
      releaseAll: () => held.splice(0).forEach(({ release }) => release()),
      /** The OLDEST walk still out, answering on its own — so a walk that hung
       *  past the bound and landed anyway can be told apart from a later one. */
      releaseOldest: () => held.shift()?.release(),
      /** Github, refusing the walks that are out. Named, because a case below
       *  turns on WHICH of two failures the caller is given. */
      failAll: (why = 'bad credentials') => held.splice(0).forEach(({ refuse }) => refuse(why)),
    };
  }

  function liveSvc(source: IProjectsSource) {
    const config = {
      get: (key: string, d?: unknown) =>
        key === 'GITHUB_ORGS' ? 'acme' : key === 'FEEDBACK_REPO' ? SAMPLE_FEEDBACK_REPO : key === 'PROJECTS_CACHE_TTL_MS' ? 300_000 : d,
    } as unknown as ConfigService;
    const issuesCache = {
      // The join has to RUN, or #722's guard is what stops the warm being
      // cached and the second case below would prove nothing.
      getIssues: async () => ({ issues: [], at: Date.now(), orgs: [] }),
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    return new ProjectsService(source, config, issuesCache);
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));
  /** The interceptor's two moves, in the order `FreshnessRegistry` makes them. */
  const write = (service: ProjectsService) => {
    service.dropCaches();
    return service.warmAfterWrite();
  };

  it('holds one walk in flight for a burst, and runs exactly one more after it', async () => {
    const { source, graphql, releaseAll } = liveSource();
    const service = liveSvc(source);

    const burst = [write(service), write(service), write(service)];
    await tick();

    // Three writes, one walk. Without the cap this is three, and each of them
    // is the full board-list walk of every board in the org.
    expect(graphql).toHaveBeenCalledTimes(1);

    releaseAll();
    await tick();
    // One more, for the two writes that landed while it was out — not two.
    expect(graphql).toHaveBeenCalledTimes(2);

    releaseAll();
    await Promise.all(burst);
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it('makes the walk that lands last one that went out after the last write', async () => {
    const { source, graphql, releaseAll } = liveSource();
    const service = liveSvc(source);

    const first = write(service);
    await tick();
    // The second write lands while the first walk is still out. Its drop moves
    // the epoch, so walk 1 is now disowned — it will be served to nobody.
    const second = write(service);
    await tick();
    expect(graphql).toHaveBeenCalledTimes(1);

    releaseAll();
    await tick();
    releaseAll();
    await Promise.all([first, second]);

    // What the burst cost, whatever it was — the reader below is compared
    // against it rather than against a constant, so a shape that made ONE walk
    // fails on the reader having to make its own rather than on a number.
    const walksForTheBurst = graphql.mock.calls.length;
    const reading = service.listProjects(HUMAN);
    await tick();
    // Settles anything that reader had to start. Under the cap there is
    // nothing, which is the assertion; this is here so a shape that does start
    // one fails on the count rather than hanging on a walk nobody released.
    releaseAll();
    const boards = await reading;

    // Walk 2 went out AFTER the second write's drop, so it is the one the cache
    // keeps — and a reader inside the TTL pays nothing. Join the running walk
    // instead of marking the org and this is where it shows: walk 1 is all
    // there is, its epoch is stale, the cache stays empty, and this reader walks
    // Github itself.
    expect(graphql).toHaveBeenCalledTimes(walksForTheBurst);
    expect(boards.map((b) => b.name)).toEqual(['Boards as of walk 2']);
  });

  it('runs the marked walk even when the walk it was marked during failed', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { source, graphql, releaseAll, failAll } = liveSource();
    const service = liveSvc(source);

    const first = write(service);
    await tick();
    const second = write(service);
    await tick();
    expect(graphql).toHaveBeenCalledTimes(1);

    // Github refuses the walk that is out. The org stays marked, so the walk the
    // second write asked for still runs — a refusal must not swallow every write
    // that landed during it, which would leave the cache cold until somebody
    // read the page.
    failAll();
    await tick();
    expect(graphql).toHaveBeenCalledTimes(2);

    releaseAll();
    await Promise.allSettled([first, second]);
    // And the failure is still the caller's: the registry logs it as a warning,
    // which it cannot do if the rejection is eaten here.
    await expect(first).rejects.toThrow('bad credentials');
    warn.mockRestore();
  });

  it('does not let "Sync now" join a warm that is already walking', async () => {
    const { source, graphql, releaseAll } = liveSource();
    const service = liveSvc(source);

    const warm = write(service);
    await tick();
    expect(graphql).toHaveBeenCalledTimes(1);

    // The button is NOT in the coalescing, and this is the decision: a person is
    // waiting on this answer, `SyncController` promises it describes a read this
    // call made, and a sync that resolves off a warm issued before the button
    // reports a clean `syncedAt` for a walk it did not make — the same laundering
    // the retiree is kept out of `refill` for. Human-rate, so it is not what the
    // cap exists to bound.
    const synced = service.resync();
    await tick();
    expect(graphql).toHaveBeenCalledTimes(2);

    releaseAll();
    await tick();
    releaseAll();
    await tick();
    releaseAll();
    await Promise.all([warm, synced]);
  });

  /**
   * The cap's own failure mode: a walk that never settles (#713).
   *
   * Nothing on this path has a timeout. `github-client.ts` builds its Octokit
   * with no `request.timeout` and no `AbortSignal`, and the board-list walk
   * awaits the GraphQL call bare — so a socket that hangs rather than fails
   * leaves the walk pending for ever. The slot is released by `afterWarm`, which
   * runs off that promise, so a single hung read used to disable warm-after-write
   * for the org for the life of the process: every later write took the marking
   * branch, set a bit nothing would consume, and got the same never-settling
   * promise back.
   *
   * "Slow rather than down" is what Projects-v2 does under a secondary rate
   * limit, so this is the ordinary shape of a bad hour rather than an exotic one.
   * Before the cap it cost exactly one write's warm, because `refill` called
   * `readRollup` directly — the cap is what turned it into every write's.
   *
   * The walk is not cancelled and cannot be: what the bound releases is the SLOT.
   * The epoch guard still decides whether the hung walk's answer may be cached if
   * it ever lands, which is why a slow walk that finishes is still allowed to.
   *
   * Fake timers, because the bound is minutes and the machine is not the subject.
   */
  describe('bounds the walk, so one hung read does not stop the org warming', () => {
    /** Let every queued continuation run, with the clock held still. */
    const settle = () => vi.advanceTimersByTimeAsync(0);

    afterEach(() => {
      vi.useRealTimers();
    });

    it('lets a later write walk again when the walk before it never lands', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();
      const { source, graphql } = liveSource();
      const service = liveSvc(source);

      // Write A's warm goes out and hangs — nothing ever releases it.
      void write(service);
      await settle();
      expect(graphql).toHaveBeenCalledTimes(1);

      // A burst behind it costs nothing, which is the cap working.
      for (let i = 0; i < 5; i++) void write(service);
      await settle();
      expect(graphql).toHaveBeenCalledTimes(1);

      // Past the bound the slot is released, so the next write starts its own
      // walk. Without it this org warms nothing again until the process dies.
      await vi.advanceTimersByTimeAsync(WARM_WALK_MAX_MS);
      void write(service);
      await settle();
      expect(graphql).toHaveBeenCalledTimes(2);

      // Named in the log, because nothing else says it: a walk this service has
      // given up on is still out there, and the org it belongs to is the fact
      // somebody reading the deploy log needs.
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said).toContain('acme');
      warn.mockRestore();
    });

    it('does not let the hung walk take a later walk’s slot when it lands', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      vi.useFakeTimers();
      const { source, graphql, releaseOldest } = liveSource();
      const service = liveSvc(source);

      void write(service);
      await settle();
      await vi.advanceTimersByTimeAsync(WARM_WALK_MAX_MS);
      // Walk 2 takes the released slot and is still out.
      void write(service);
      await settle();
      expect(graphql).toHaveBeenCalledTimes(2);

      // Walk 1 answers at last, long after it gave the slot up. Releasing its
      // own slot is fine; releasing walk 2's is not — the org would be back to
      // one walk per write for as long as walk 2 runs.
      releaseOldest();
      await settle();

      void write(service);
      await settle();
      expect(graphql).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });
  });

  it('keeps the first failure when the walk after it fails too', async () => {
    const { source, graphql, failAll } = liveSource();
    const service = liveSvc(source);

    const first = write(service);
    await tick();
    const second = write(service);
    await tick();
    expect(graphql).toHaveBeenCalledTimes(1);

    // The walk write A asked for fails, so the walk write B marked runs — and
    // fails too, which is what an outage looks like rather than a contrivance.
    failAll('the token was revoked');
    await tick();
    expect(graphql).toHaveBeenCalledTimes(2);
    failAll('and again');
    await Promise.allSettled([first, second]);

    // The FIRST failure is the one the caller is owed: it is the most diagnostic
    // of the pair and the one `FreshnessRegistry` logs. Rethrowing it from a
    // `.then` on the trailing walk drops it whenever that walk rejects too —
    // which, during an outage, is every time.
    await expect(first).rejects.toThrow('the token was revoked');
  });
});

/**
 * A drop must not turn a Github outage into a 500 (#692, #713).
 *
 * `dropCaches()` empties the rollup and the membership index, and the read that
 * follows it is COLD by construction — so a write landing a minute before Github
 * starts refusing used to leave the next reader with an error and a blank board
 * page, where a moment earlier they would have seen a slightly stale one. The
 * payload a drop clears is therefore moved aside rather than discarded, and
 * served when the read that should have replaced it fails.
 *
 * It is NOT a second cache, and the four cases below are what keeps it one: it
 * is unreachable while the source answers, it is never written back, and with
 * nothing ever served the read still fails rather than inventing an empty org.
 *
 * This closes none of the race in the block above: there the post-drop read
 * SUCCEEDS, and a fallback reached from a `catch` never runs.
 *
 * Driven through `listProjects` and `projectMemberships`, which is where a
 * reader meets it.
 */
describe('ProjectsService serves what a drop retired when the read after it fails (#713)', () => {
  const ALPHA = 'org-alpha';
  const BETA = 'org-beta';
  const OUTAGE = 'You have exceeded a secondary rate limit';

  /** One board, named for the org it came from and the read that produced it —
   *  so a retired answer and a fresh one are tellable apart on a field a reader
   *  sees, not on object identity. */
  const boardOf = (org: string, label: string): ProjectRollup => ({
    number: 7,
    name: `${label} (${org})`,
    url: `https://github.com/orgs/${org}/projects/7`,
    status: 'active',
    open: 1,
    closed: 1,
    pct: 50,
    excludedItems: 0,
    itemsComplete: true,
    recentCloses: [],
    weeklyClosed: [],
    closedThisWeek: 0,
    openedThisWeek: 0,
    // A run on the ring, so "the board's own figures still come through" is a
    // comparison against something rather than against two empty lists.
    contributors: [{ login: 'IvanRoslov', closed: 1, kind: 'person' }],
    contributorsByAssignee: [{ login: 'IvanRoslov', closed: 1, kind: 'person' }],
  });

  /** The one issue on each org's board, closed an hour ago — so the join has
   *  something to find and the four joined figures on a served board are a real
   *  reading rather than zeros. In the TRAILING 24h bucket deliberately: that is
   *  the figure the card leads with ("+1 in the last 24h"), and the one a copy
   *  from before a write cannot vouch for. */
  const CLOSED_AT = new Date(Date.now() - 3_600_000).toISOString();
  const issueOn = (org: string) => `https://github.com/${org}/r/issues/1`;
  const closes = (orgs: string) =>
    orgs.split(',').map((org) => ({ htmlUrl: issueOn(org), closedAt: CLOSED_AT, createdAt: CLOSED_AT }));

  /** Everything on a board that a retiree may still speak for — the whole
   *  payload bar the four figures the org-wide join produced, and the two flags
   *  that say they are gone and which payload this is. Compared as a whole, so a
   *  field quietly dropped from a retiree is still a red line.
   *
   *  `lastGoodCopy` is off the list from #770 and `joinedFiguresWithheld` from
   *  #792, both for the same reason: they are facts about the SERVING and about
   *  what this payload carries, so they are expected to differ between a read and
   *  the copy of it. The cases above assert both by name.
   *
   *  `pulseJoined` was off it on that same reasoning and is back on since #792,
   *  because the reasoning stopped being true of it. The join RAN for the copy a
   *  drop retires — a rollup is cached only when it did — so a retiree's flag
   *  equals the read's, at every call site below, and excluding it only cost
   *  these comparisons a field they could have been checking. Included, they are
   *  what catches the #770 fold coming back: put `pulseJoined: false` into
   *  `unjoined()` and they go red, where before they stayed green and three
   *  by-name assertions carried the whole guard on their own. */
  const spokenFor = ({
    lastGoodCopy: _copy,
    joinedFiguresWithheld: _withheld,
    weeklyClosed: _weekly,
    closedThisWeek: _week,
    openedThisWeek: _weekOpened,
    dailyOpened: _opened,
    dailyClosed: _closed,
    ...board
  }: ProjectSummary) => board;

  /** A service over a source that can be made to refuse — every org, or one of
   *  them — and whose answer can be moved on, so "fresh" is a value rather than
   *  a call count. */
  function harness(orgs = 'acme', ttlMs = 300_000) {
    let label = 'Before the write';
    const down = new Map<string, Error>();
    // The membership read alone, so the case where the boards come back and the
    // index does not can be reached — the one that decides whether a rollup
    // joined against a retired index gets cached (#713).
    const indexDown = new Map<string, Error>();
    const refuse = (org: string, only?: Map<string, Error>) => {
      const err = down.get(org) ?? only?.get(org);
      if (err) throw err;
    };
    const listProjects = vi.fn(async (org: string) => {
      refuse(org);
      return [boardOf(org, label)];
    });
    const projectMemberships = vi.fn(async (org: string): Promise<SourceMembership[]> => {
      refuse(org, indexDown);
      return [{ number: 7, name: boardOf(org, label).name, issueUrls: [issueOn(org)] }];
    });
    const disownInFlightReads = vi.fn();
    const source: IProjectsSource = {
      listProjects,
      getProject: vi.fn(async (org: string, n: number) => ({ ...boardOf(org, label), number: n, items: [] })),
      projectMemberships,
      listProjectCatalog: vi.fn(async (): Promise<SourceCatalogEntry[]> => []),
      disownInFlightReads,
    };
    const config = {
      get: (key: string, d?: unknown) =>
        key === 'GITHUB_ORGS' ? orgs : key === 'FEEDBACK_REPO' ? SAMPLE_FEEDBACK_REPO : key === 'PROJECTS_CACHE_TTL_MS' ? ttlMs : d,
    } as unknown as ConfigService;
    const issuesCache = {
      // The join has to RUN, or #722's guard is what stops the cache write and
      // there would be nothing to retire.
      getIssues: async () => ({ issues: closes(orgs), at: Date.now(), orgs: [] }),
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    return {
      service: new ProjectsService(source, config, issuesCache),
      /** Github, refusing — for every configured org, or only the ones named. */
      breakGithub: (...only: string[]) => {
        for (const org of only.length ? only : orgs.split(',')) down.set(org, new Error(OUTAGE));
      },
      /** Github answering the board list and refusing the membership index. */
      breakIndex: (...only: string[]) => {
        for (const org of only.length ? only : orgs.split(',')) indexDown.set(org, new Error(OUTAGE));
      },
      recover: () => {
        down.clear();
        indexDown.clear();
      },
      /** What the source answers from here on. */
      moveOn: (next: string) => {
        label = next;
      },
      reads: () => listProjects.mock.calls.length,
      membershipReads: () => projectMemberships.mock.calls.length,
      disownInFlightReads,
    };
  }

  /** The clock the SERVICE reads, moved rather than waited out — the house
   *  convention for a TTL of this shape (`repos.service.spec.ts` does the same
   *  to age out its own cache). A real sleep would be measuring the machine.
   *
   *  Started from the real now, so the close an hour back in `closes` above
   *  still lands in the join's window and the figures a retiree is stripped of
   *  are real ones. */
  const startClock = () => {
    const start = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(start);
    return (ms: number) => vi.setSystemTime(start + ms);
  };
  const MINUTE = 60_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands the reader the boards it last served when the post-drop read fails', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, breakGithub, reads } = harness();

    const before = await service.listProjects(HUMAN);
    service.dropCaches();
    breakGithub();

    const after = await service.listProjects(HUMAN);

    // The source was asked FIRST — the retired copy is a fallback, never a
    // shortcut past the read the drop exists to force.
    expect(reads()).toBe(2);
    // Every field the retiree may speak for, whole — the four the join produced
    // are withheld, and have their own case below.
    expect(after.map(spokenFor)).toEqual(before.map(spokenFor));
    // Said in the log because the payload cannot say how OLD the copy is — since
    // #770 it does say THAT it is one, and the case below is that field.
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('acme');
    expect(said).toContain(OUTAGE);
    warn.mockRestore();
  });

  it('withholds every figure the join produced on the copy it serves', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, breakGithub } = harness();

    const [before] = await service.listProjects(HUMAN);
    // The reading a retiree is made from: the join ran, and its newest bucket is
    // the close from an hour ago.
    expect(before.pulseJoined).toBe(true);
    expect(before.closedThisWeek).toBe(1);
    expect(before.dailyClosed?.at(-1)).toBe(1);

    service.dropCaches();
    breakGithub();
    const [after] = await service.listProjects(HUMAN);

    // The board's own answers — counts, completion, contributors, the ring —
    // still come through: they are what a retiree is for.
    expect(spokenFor(after)).toEqual(spokenFor(before));
    // The four the join produced do not. Every one of them is anchored to the
    // clock of the read that made it, and nothing on the wire says how old that
    // read is — `deltaNote` in board-frontend/src/projects/pulse.ts would render
    // the bucket above as "+1 in the last 24h" a week later. Withheld exactly as
    // `readRollup` withholds them on a join that did not run (#722) — the same
    // function, and since #792 the same flag saying so.
    expect(after.joinedFiguresWithheld).toBe(true);
    // The join itself RAN for this copy, and the payload no longer says
    // otherwise (#792). A rollup is cached only when the join ran, so there is
    // no retiree whose join failed; the `false` this used to assert was a claim
    // about an org-wide read that had succeeded.
    expect(after.pulseJoined).toBe(true);
    expect(after.weeklyClosed).toEqual([]);
    expect(after.closedThisWeek).toBeUndefined();
    expect(after.dailyOpened).toEqual([]);
    expect(after.dailyClosed).toEqual([]);
    warn.mockRestore();
  });

  /**
   * The half `pulseJoined` could not say (#770), and since #792 the half it no
   * longer tries to.
   *
   * `pulseJoined: false` was right about WHAT was withheld and wrong about WHY:
   * its documented meaning is "the org-wide join did not run", and on a retiree
   * the join ran fine — a rollup is only cached when it did, so every copy a
   * drop retires is one whose join ran. The frontend read that false and told
   * the reader this week's closes were not read, on a board whose actual problem
   * is that its counts, ring and contributor list predate the write they just
   * made. `joinedFiguresWithheld` carries the withholding now and this flag
   * carries which payload arrived, so neither has to borrow the other's word.
   */
  it('says on the wire that the copy is a copy, not just that figures are withheld', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, breakGithub } = harness();

    const [before] = await service.listProjects(HUMAN);
    // A board read from the source is not a copy, and says so rather than saying
    // nothing: absent is what a board-api predating the field sends.
    expect(before.lastGoodCopy).toBe(false);

    service.dropCaches();
    breakGithub();
    const [after] = await service.listProjects(HUMAN);

    expect(after.lastGoodCopy).toBe(true);
    // Three flags, three claims, and none of them borrowed. The four joined
    // figures are gone — anchored to a clock this service no longer has — and
    // `joinedFiguresWithheld` is what says so; `lastGoodCopy` says which payload
    // arrived; `pulseJoined` goes on saying the one thing it is named for, and
    // for this copy the join ran.
    expect(after.joinedFiguresWithheld).toBe(true);
    expect(after.pulseJoined).toBe(true);
    // The figures it speaks FOR are the ones with no marker of their own, and
    // they are still whole: this flag is the only thing on the wire that dates
    // them.
    expect(after.closed).toBe(before.closed);
    expect(after.pct).toBe(before.pct);
    expect(after.contributors).toEqual(before.contributors);
    warn.mockRestore();
  });

  it('drops the copy flag again as soon as a read succeeds', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, breakGithub, recover } = harness();

    await service.listProjects(HUMAN);
    service.dropCaches();
    breakGithub();
    expect((await service.listProjects(HUMAN))[0].lastGoodCopy).toBe(true);

    recover();
    service.dropCaches();

    // The sentence has to STOP. A flag that survived the recovering read would
    // tell every later reader their numbers are old, on numbers that are not.
    const [recovered] = await service.listProjects(HUMAN);
    expect(recovered.lastGoodCopy).toBe(false);
    // The withholding has to stop with it, and this is the assertion that says
    // so since #792. `pulseJoined` used to be it, and it no longer discriminates
    // — a retiree carries a `true` here too — so it would pass whether or not
    // the figures came back. The flag that flips is this one, and the week
    // figure behind it is what makes the flip mean something.
    expect(recovered.joinedFiguresWithheld).toBe(false);
    expect(recovered.pulseJoined).toBe(true);
    expect(recovered.closedThisWeek).toBe(1);
    warn.mockRestore();
  });

  it('says in the log how old the copy it served is', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, breakGithub } = harness();

    await service.listProjects(HUMAN);
    service.dropCaches();
    breakGithub();
    await service.listProjects(HUMAN);

    // The timestamp of the read that produced it, the way `IssuesCacheService`'s
    // own retiree logs one. A copy with no age on it is one nobody running the
    // service can size up — five minutes and five hours read identically.
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toMatch(/read of \d{4}-\d{2}-\d{2}T[\d:.]+Z/);
    warn.mockRestore();
  });

  it('refuses one older than the ceiling rather than serving it as current', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const clockAt = startClock();
    const { service, breakGithub } = harness();

    await service.listProjects(HUMAN);
    service.dropCaches();
    breakGithub();
    // Sixteen minutes on, past RETIREE_MAX_TTLS x the 300s default TTL.
    clockAt(16 * MINUTE);

    // Past the ceiling the honest answer is the failure: Github refusing for
    // longer than that is an outage or a revoked token, not the hiccup a
    // retiree exists for, and boards from before it presented as current is the
    // thing #713 is about.
    await expect(service.listProjects(HUMAN)).rejects.toThrow(OUTAGE);
    warn.mockRestore();
  });

  it('serves one sitting exactly on the ceiling', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const clockAt = startClock();
    const { service, breakGithub } = harness();

    const before = await service.listProjects(HUMAN);
    service.dropCaches();
    breakGithub();
    // Fifteen minutes to the millisecond — RETIREE_MAX_TTLS x the 300s default,
    // and the boundary itself rather than either side of it. The ceiling is a
    // "past this" and not an "at this": three TTLs old is the last moment the
    // argument for serving it still holds, and a `>=` here would spend a
    // reader's page on a boundary nobody chose.
    clockAt(3 * 5 * MINUTE);

    expect((await service.listProjects(HUMAN))[0].name).toBe(before[0].name);
    warn.mockRestore();
  });

  it('measures the ceiling against the CONFIGURED TTL, not the default one', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const clockAt = startClock();
    // A minute's TTL, so the ceiling is three minutes rather than fifteen. Every
    // other case here runs at the 300s default, where a ceiling hardcoded to
    // fifteen minutes and one derived from the TTL cannot be told apart.
    const { service, breakGithub } = harness('acme', 60_000);

    const before = await service.listProjects(HUMAN);
    service.dropCaches();
    breakGithub();

    // Inside three TTLs: served, as at any other TTL.
    clockAt(2.5 * MINUTE);
    expect((await service.listProjects(HUMAN))[0].name).toBe(before[0].name);

    // Past them: refused, even though a fifteen-minute ceiling would still be
    // serving it. An operator who shortens the TTL has said how long an
    // unrefreshed answer may be served, and this is the same statement.
    clockAt(4 * MINUTE);
    await expect(service.listProjects(HUMAN)).rejects.toThrow(OUTAGE);
    warn.mockRestore();
  });

  it('ages a retiree from the read that made it, not from the drop that retired it', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const clockAt = startClock();
    const { service, breakGithub } = harness();

    // Read at nought, dropped at fourteen minutes — the ordinary shape, since a
    // cache entry is dropped by whatever write happens to land, not by its age.
    await service.listProjects(HUMAN);
    clockAt(14 * MINUTE);
    service.dropCaches();
    breakGithub();

    // Two minutes after the drop, and sixteen after the read. The age that
    // decides is the SOURCE's: these boards describe Github as it was sixteen
    // minutes ago whatever moment this service moved them aside. Stamp `at` at
    // the drop and the ceiling restarts on every write, which on a busy hour is
    // never.
    clockAt(16 * MINUTE);
    await expect(service.listProjects(HUMAN)).rejects.toThrow(OUTAGE);
    warn.mockRestore();
  });

  it('still serves one that is older than the TTL but inside the ceiling', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const clockAt = startClock();
    const { service, breakGithub } = harness();

    const before = await service.listProjects(HUMAN);
    service.dropCaches();
    breakGithub();
    // Ten minutes on: twice the TTL, and two thirds of the way to the ceiling.
    clockAt(10 * MINUTE);

    // The TTL is not the ceiling: a retiree that has outlived the window it
    // would have been served in as a cache entry is exactly the case this
    // fallback is for.
    expect((await service.listProjects(HUMAN))[0].name).toBe(before[0].name);
    warn.mockRestore();
  });

  it('has nothing from two drops ago once a read has replaced it', async () => {
    const clockAt = startClock();
    const { service, breakGithub, moveOn } = harness();

    await service.listProjects(HUMAN);
    // A drop retires that first read...
    service.dropCaches();
    moveOn('After the write');
    // ...and the read after it succeeds, so the retiree has nothing left to
    // stand in for. No second drop follows, so only the delete on the success
    // path can be what clears it.
    await service.listProjects(HUMAN);
    // The TTL runs out, and the copy is still well inside the ceiling — so a
    // retiree that had survived would be served rather than refused.
    clockAt(6 * MINUTE);
    breakGithub();

    // Reachable without a write: the TTL simply ran out and Github went down.
    // Keep the retiree here and a payload from before the FIRST drop is served
    // as the current boards.
    await expect(service.listProjects(HUMAN)).rejects.toThrow(OUTAGE);
  });

  it('has no membership index from two drops ago once a read has replaced it', async () => {
    const clockAt = startClock();
    const { service, breakGithub, moveOn } = harness();

    await service.projectMemberships();
    service.dropCaches();
    moveOn('After the write');
    await service.projectMemberships();
    clockAt(6 * MINUTE);
    breakGithub();

    await expect(service.projectMemberships()).rejects.toThrow(OUTAGE);
  });

  it('leaves it unreachable while the source answers, even when it differs', async () => {
    const { service, moveOn } = harness();

    const before = await service.listProjects(HUMAN);
    service.dropCaches();
    moveOn('After the write');

    const after = await service.listProjects(HUMAN);

    expect(after[0].name).toBe('After the write (acme)');
    expect(after[0].name).not.toBe(before[0].name);
  });

  it('does not write the retired boards back into the cache', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, breakGithub, recover, moveOn, reads } = harness();

    const before = await service.listProjects(HUMAN);
    service.dropCaches();
    breakGithub();
    expect((await service.listProjects(HUMAN)).map(spokenFor)).toEqual(before.map(spokenFor));
    expect(reads()).toBe(2);

    // Github, a second later, answering again. Cache the retired copy and the
    // next reader is answered from it for the rest of the TTL instead.
    recover();
    moveOn('After the write');
    const after = await service.listProjects(HUMAN);

    expect(reads()).toBe(3);
    expect(after[0].name).toBe('After the write (acme)');
    warn.mockRestore();
  });

  it('still fails when it never served anything to retire', async () => {
    const { service, breakGithub } = harness();

    service.dropCaches();
    breakGithub();

    // An empty board list here would say "this org has no boards" about an
    // outage, which is the answer #722 refuses on the same page.
    await expect(service.listProjects(HUMAN)).rejects.toThrow(OUTAGE);
  });

  it('keeps an unreadable org IN the union, with the boards it last had', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, breakGithub, moveOn } = harness(`${ALPHA},${BETA}`);

    const before = await service.listProjects(HUMAN);
    expect(before.map((b) => b.org)).toEqual([ALPHA, BETA]);

    service.dropCaches();
    // One org of two goes dark. Without a retiree beta is simply absent from
    // the union, which reads as an org with no boards.
    breakGithub(BETA);
    moveOn('After the write');
    const after = await service.listProjects(HUMAN);

    expect(after.map((b) => `${b.org}: ${b.name}`)).toEqual([
      `${ALPHA}: After the write (${ALPHA})`,
      `${BETA}: Before the write (${BETA})`,
    ]);
    warn.mockRestore();
  });

  it('drops an org whose retiree is past the ceiling from the union, and says so only in the log', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const clockAt = startClock();
    const { service, breakGithub, moveOn } = harness(`${ALPHA},${BETA}`);

    await service.listProjects(HUMAN);
    service.dropCaches();
    breakGithub(BETA);
    moveOn('After the write');
    // Past the ceiling, with the other org still answering.
    clockAt(16 * MINUTE);

    const after = await service.listProjects(HUMAN);

    // What the ceiling buys on ONE org is a page that fails and gets the token
    // fixed. On a union it is this instead: beta's read throws, `perOrg` drops
    // it, and the reader gets a 200 carrying alpha alone — which `rollupBoards`
    // calls the wrong answer in its own comment, since an org absent from the
    // union reads as an org with no boards. Pinned rather than fixed: saying it
    // on the wire is a new bit on the payload, and the payload is shared with
    // `board-frontend`.
    expect(after.map((b) => b.org)).toEqual([ALPHA]);
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain(`${BETA} unreadable`);
    warn.mockRestore();
  });

  it('lets "Sync now" reject in an outage, retiree or no retiree', async () => {
    const { service, breakGithub } = harness();

    // Something to fall back to, then a Github that has stopped answering.
    await service.listProjects(HUMAN);
    breakGithub();

    // `SyncController` promises that a source which fails to refresh rejects the
    // request rather than reporting a clean `syncedAt`. Warm through the ladder
    // instead of the read under it and the retiree answers the warm, every org
    // "succeeds", and the button reports a sync that refreshed nothing.
    await expect(service.resync()).rejects.toThrow(OUTAGE);

    // And the retiree is still there for the readers it belongs to.
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    expect((await service.listProjects(HUMAN))[0].name).toBe('Before the write (acme)');
    warn.mockRestore();
  });

  it('does not cache a rollup the membership read failed on', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, breakIndex, recover, moveOn, reads } = harness();

    const before = await service.listProjects(HUMAN);
    service.dropCaches();
    // The boards come back; the index the pulse join needs does not.
    breakIndex();
    moveOn('During the outage');
    const after = await service.listProjects(HUMAN);

    // The retired BOARDS, not fresh boards joined against a retired index —
    // that answer is one this service cannot vouch for, and the #722 guard at
    // the end of the read would cache it for a full TTL.
    expect(after.map(spokenFor)).toEqual(before.map(spokenFor));
    // And named as retired: 'During the outage' would be the fresh board list.
    expect(after[0].name).toBe('Before the write (acme)');

    recover();
    moveOn('After the write');
    const next = await service.listProjects(HUMAN);

    expect(reads()).toBe(3);
    expect(next[0].name).toBe('After the write (acme)');
    warn.mockRestore();
  });

  it('serves the membership index a drop retired on the same terms', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, breakGithub, recover, moveOn, membershipReads } = harness();

    const before = await service.projectMemberships();
    service.dropCaches();
    breakGithub();
    expect(await service.projectMemberships()).toEqual(before);

    recover();
    moveOn('After the write');
    const after = await service.projectMemberships();

    expect(membershipReads()).toBe(3);
    expect(after[0].name).toBe('After the write (acme)');
    warn.mockRestore();
  });
});

/**
 * A read that failed is not a page with nothing on it, when another read
 * succeeded meanwhile (#713).
 *
 * Neither `rollupBoards` nor `orgMemberships` dedupes what is in flight, so two
 * readers arriving together each make their own source read — and the ladder's
 * `catch` reaches straight past the cache for what a drop retired. `readRollup`'s
 * success path DELETES the retiree, so when one of the two succeeds and the other
 * meets a secondary rate limit, the loser finds nothing retired, rethrows, and
 * `perOrg` drops the org from the union: a 500 with the answer sitting in
 * `rollupByOrg`.
 *
 * The fix is one line of ordering — the cache is re-read in the `catch`, before
 * the retiree — and it is worth a case each because both ladders have the shape.
 * What arrives is the FRESH answer, not a retiree: the joined figures are on it,
 * which is how these two tell the rungs apart.
 */
describe('ProjectsService answers off the read that succeeded when a concurrent one fails (#713)', () => {
  const ORG = 'acme';
  const OUTAGE = 'You have exceeded a secondary rate limit';
  const CLOSED_AT = new Date(Date.now() - 3_600_000).toISOString();
  const ISSUE = `https://github.com/${ORG}/r/issues/1`;

  const boardOf = (): ProjectRollup => ({
    number: 7,
    name: 'The board both readers asked for',
    url: `https://github.com/orgs/${ORG}/projects/7`,
    status: 'active',
    open: 1,
    closed: 1,
    pct: 50,
    excludedItems: 0,
    itemsComplete: true,
    recentCloses: [],
    weeklyClosed: [],
    closedThisWeek: 0,
    openedThisWeek: 0,
    contributors: [],
    contributorsByAssignee: [],
  });

  /** A source whose SECOND call of one method hangs until it is refused — so the
   *  read that loses the race is the one that fails, with the winner's answer
   *  already cached. */
  function harness(slow: 'boards' | 'memberships') {
    let refuse: (() => void) | null = null;
    const held = <T,>(): Promise<T> =>
      new Promise<T>((_, reject) => {
        refuse = () => reject(new Error(OUTAGE));
      });
    const listProjects = vi.fn(
      async (): Promise<ProjectRollup[]> =>
        slow === 'boards' && listProjects.mock.calls.length === 2 ? held<ProjectRollup[]>() : [boardOf()],
    );
    const projectMemberships = vi.fn(
      async (): Promise<SourceMembership[]> =>
        slow === 'memberships' && projectMemberships.mock.calls.length === 2
          ? held<SourceMembership[]>()
          : [{ number: 7, name: boardOf().name, issueUrls: [ISSUE] }],
    );
    const source: IProjectsSource = {
      listProjects,
      getProject: vi.fn(async () => null),
      projectMemberships,
      listProjectCatalog: vi.fn(async (): Promise<SourceCatalogEntry[]> => []),
      disownInFlightReads: vi.fn(),
    };
    const config = {
      get: (key: string, d?: unknown) =>
        key === 'GITHUB_ORGS' ? ORG : key === 'FEEDBACK_REPO' ? SAMPLE_FEEDBACK_REPO : key === 'PROJECTS_CACHE_TTL_MS' ? 300_000 : d,
    } as unknown as ConfigService;
    const issuesCache = {
      // The join has to RUN, or the winner's read is never cached at all (#722).
      getIssues: async () => ({
        issues: [{ htmlUrl: ISSUE, closedAt: CLOSED_AT, createdAt: CLOSED_AT }],
        at: Date.now(),
        orgs: [],
      }),
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    return {
      service: new ProjectsService(source, config, issuesCache),
      /** Github refusing the read that is still out. */
      breakTheSlowOne: () => refuse?.(),
      reads: () => listProjects.mock.calls.length,
      membershipReads: () => projectMemberships.mock.calls.length,
    };
  }

  it('serves the boards the winning read cached rather than 500ing the page', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, breakTheSlowOne, reads } = harness('boards');

    const winner = service.listProjects(HUMAN);
    const loser = service.listProjects(HUMAN);
    const cached = await winner;
    // Both went to the source: this is a race, not a cache hit.
    expect(reads()).toBe(2);

    breakTheSlowOne();

    // The answer is in hand, in the map the loser is about to walk past. Nothing
    // retired is left for it — the winner's success deleted it — so the `catch`
    // used to rethrow and `perOrg` used to drop the only org there is.
    const served = await loser;
    expect(served).toEqual(cached);
    // The FRESH entry, not a retiree: a retiree arrives through `unjoined`.
    expect(served[0].pulseJoined).toBe(true);
    expect(served[0].closedThisWeek).toBe(1);
    warn.mockRestore();
  });

  it('serves the membership index the winning read cached on the same terms', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, breakTheSlowOne, membershipReads } = harness('memberships');

    const winner = service.projectMemberships();
    const loser = service.projectMemberships();
    const cached = await winner;
    expect(membershipReads()).toBe(2);

    breakTheSlowOne();

    expect(await loser).toEqual(cached);
    warn.mockRestore();
  });
});

/**
 * A write leaves the picker's candidate boards alone (#713).
 *
 * An entry in the catalog is a BOARD's identity — node id, number, board title —
 * which no close and no facet write can change, and `dropCaches` keeps it for
 * exactly that reason. But the refill behind a write delegated to `resync`,
 * which deletes it for every org in scope, and `FreshnessRegistry` calls the two
 * in that order on every write — so the drop's own argument was true of the
 * method and false of the path it sits on, and every write charged the next
 * picker open a Projects-v2 catalog walk.
 *
 * "Sync now" still drops it. That button means "I believe something moved that
 * you cannot see", which is exactly what a board renamed on Github is.
 *
 * Counted at the SOURCE and read back through `listProjectCatalog`, so what these
 * assert is what a picker opening after a write costs Github — not which map
 * holds what.
 */
describe('ProjectsService keeps the board-identity catalog across a write (#713)', () => {
  /** One candidate board, named for the read that produced it — so a kept entry
   *  and a re-read one are tellable apart on the field the picker draws. */
  const catalogOf = (org: string, label: string): SourceCatalogEntry => ({
    id: `PVT_kw${org}`,
    number: 7,
    title: `${label} (${org})`,
  });

  function harness(orgs = 'acme') {
    let label = 'Before the write';
    let hold = false;
    let fail = false;
    /** One per held read, so two orgs can be in flight at once (#911 review, R1). */
    const releases: (() => void)[] = [];
    const listProjectCatalog = vi.fn(async (org: string): Promise<SourceCatalogEntry[]> => {
      if (hold) {
        await new Promise<void>((r) => {
          releases.push(r);
        });
      }
      if (fail) throw new Error(`catalog walk failed for ${org}`);
      return [catalogOf(org, label)];
    });
    const source: IProjectsSource = {
      // The warm behind a write reads the rollup, so it has to answer; the
      // boards themselves are the other blocks' subject, not this one's.
      listProjects: vi.fn(async (org: string): Promise<ProjectRollup[]> => [
        {
          number: 7,
          name: catalogOf(org, label).title,
          url: `https://github.com/orgs/${org}/projects/7`,
          status: 'active',
          open: 1,
          closed: 1,
          pct: 50,
          excludedItems: 0,
          itemsComplete: true,
          recentCloses: [],
          weeklyClosed: [],
          closedThisWeek: 0,
          openedThisWeek: 0,
          contributors: [],
          contributorsByAssignee: [],
        },
      ]),
      getProject: vi.fn(async () => null),
      projectMemberships: vi.fn(async (): Promise<SourceMembership[]> => []),
      listProjectCatalog,
      disownInFlightReads: vi.fn(),
    };
    const config = {
      get: (key: string, d?: unknown) =>
        key === 'GITHUB_ORGS' ? orgs : key === 'FEEDBACK_REPO' ? SAMPLE_FEEDBACK_REPO : key === 'PROJECTS_CACHE_TTL_MS' ? 300_000 : d,
    } as unknown as ConfigService;
    const issuesCache = {
      // The join has to RUN, or #722's guard stops the warm's cache write and
      // the rollup half of these tests would prove nothing.
      getIssues: async () => ({ issues: [], at: Date.now(), orgs: [] }),
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    return {
      service: new ProjectsService(source, config, issuesCache),
      /** What the source answers from here on — a board renamed on Github. */
      moveOn: (next: string) => {
        label = next;
      },
      catalogReads: () => listProjectCatalog.mock.calls.length,
      /** Hold the NEXT catalog read open, so a write can land while it is out. */
      holdCatalogRead: () => {
        hold = true;
      },
      releaseCatalogRead: () => {
        hold = false;
        for (const r of releases.splice(0)) r();
      },
      /** The source refuses from here on, so a failed walk's slot can be shown
       *  to leave rather than to be handed to the reader who retries. */
      failCatalogRead: (on: boolean) => {
        fail = on;
      },
    };
  }

  /** Let every already-queued continuation run. */
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('serves the picker after a write without asking the source again', async () => {
    const { service, moveOn, catalogReads } = harness();

    const before = await service.listProjectCatalog();
    // The interceptor's two moves, in the order `FreshnessRegistry` makes them.
    service.dropCaches();
    await service.warmAfterWrite();
    // A rename the write cannot have caused: if the entry is re-read anyway,
    // the count says so and the title says which read answered.
    moveOn('After the write');

    expect(await service.listProjectCatalog()).toEqual(before);
    expect(catalogReads()).toBe(1);
  });

  it('caches a catalog read that a write landed on top of', async () => {
    const { service, holdCatalogRead, releaseCatalogRead, moveOn, catalogReads } = harness();

    holdCatalogRead();
    const open = service.listProjectCatalog();
    await tick();
    // The interceptor's two moves, while the picker's read is still walking
    // Github — the Projects-v2 catalog walk is seconds long, so a write landing
    // inside one is the ordinary case rather than a race to contrive.
    service.dropCaches();
    await service.warmAfterWrite();
    releaseCatalogRead();
    await open;
    moveOn('After the write');

    // A board's identity is the one thing no close and no facet write can
    // change, which is why `dropCaches` keeps this map at all. Sharing the
    // boards' epoch threw that saving away for exactly the reader it was for:
    // the read in flight was answered to its caller and cached for nobody, and
    // the next picker open paid the walk again.
    expect((await service.listProjectCatalog())[0].title).toBe('Before the write (acme)');
    expect(catalogReads()).toBe(1);
  });

  it('does not cache one that a new project landed on top of, and reads the catalog again (#982)', async () => {
    const { service, holdCatalogRead, releaseCatalogRead, moveOn, catalogReads } = harness();

    holdCatalogRead();
    const open = service.listProjectCatalog();
    await tick();
    // Making a project is the one write that changes which boards exist, so a
    // walk that went out before it cannot be the answer the next picker gets.
    service.dropCaches(['issue.project.create', 'issue.project.add']);
    releaseCatalogRead();
    await open;
    moveOn('After the new project');

    expect((await service.listProjectCatalog())[0].title).toBe('After the new project (acme)');
    expect(catalogReads()).toBe(2);
  });

  it('does not cache one that "Sync now" landed on top of', async () => {
    const { service, holdCatalogRead, releaseCatalogRead, moveOn, catalogReads } = harness();

    holdCatalogRead();
    const open = service.listProjectCatalog();
    await tick();
    // The other side of the same counter: the button means "something moved
    // that you cannot see", so a read that went out before it cannot be the
    // answer it caches — a board renamed on Github is precisely the case.
    await service.resync();
    releaseCatalogRead();
    await open;
    moveOn('Renamed on Github');

    expect((await service.listProjectCatalog())[0].title).toBe('Renamed on Github (acme)');
    expect(catalogReads()).toBe(2);
  });

  it('reads the catalog again after "Sync now", so a renamed board arrives', async () => {
    const { service, moveOn, catalogReads } = harness();

    await service.listProjectCatalog();
    await service.resync();
    moveOn('Renamed on Github');

    expect((await service.listProjectCatalog())[0].title).toBe('Renamed on Github (acme)');
    expect(catalogReads()).toBe(2);
  });

  /**
   * The pending half of the same saving (#911 review, R1). The TTL entry covers
   * readers who arrive after a walk finished and nothing covered the ones who
   * arrive during it — which mattered little for a picker one writer opens, and
   * matters now that Overview asks on every cold visit. Nothing is kept past its
   * own settlement, so this adds no second place a finished answer is served from.
   */
  it('walks Github once for the readers who arrive while the walk is out', async () => {
    const { service, holdCatalogRead, releaseCatalogRead, catalogReads } = harness();

    holdCatalogRead();
    const together = [service.listProjectCatalog(), service.listProjectCatalog(), service.listProjectCatalog(), service.listProjectCatalog()];
    await tick();
    expect(catalogReads()).toBe(1);

    releaseCatalogRead();
    const answers = await Promise.all(together);
    expect(answers[3]).toEqual(answers[0]);
    // And the warm read behind them adds none: the TTL entry answers it, which
    // is what tells a shared pending read from a second cache.
    await service.listProjectCatalog();
    expect(catalogReads()).toBe(1);
  });

  it('does not hand one org’s walk to a reader asking for another', async () => {
    const { service, holdCatalogRead, releaseCatalogRead, catalogReads } = harness('acme,globex');

    holdCatalogRead();
    const both = [service.listProjectCatalog('acme'), service.listProjectCatalog('globex')];
    await tick();
    expect(catalogReads()).toBe(2);

    releaseCatalogRead();
    const [acme, globex] = await Promise.all(both);
    expect(acme[0].org).toBe('acme');
    expect(globex[0].org).toBe('globex');
  });

  it('lets the next reader walk again after a failed one, rather than sharing the failure', async () => {
    const { service, holdCatalogRead, releaseCatalogRead, failCatalogRead, catalogReads } = harness();

    failCatalogRead(true);
    holdCatalogRead();
    const refused = [
      expect(service.listProjectCatalog()).rejects.toThrow(/catalog walk failed/),
      expect(service.listProjectCatalog()).rejects.toThrow(/catalog walk failed/),
    ];
    await tick();
    expect(catalogReads()).toBe(1);
    releaseCatalogRead();
    await Promise.all(refused);

    // The slot left on settlement, so the retry is a read rather than the same
    // rejection handed out again.
    failCatalogRead(false);
    expect((await service.listProjectCatalog())[0].title).toBe('Before the write (acme)');
    expect(catalogReads()).toBe(2);
  });
});

/**
 * One flag says the four joined figures are gone, and every path that takes
 * them off sets it (#792).
 *
 * `pulseJoined: false` was doing that job as well as its own (#770), so a copy
 * a drop retired went out claiming the org-wide join had not run — and a rollup
 * is cached only when the join RAN, so that claim was false of every copy there
 * can be. The issue counted two causes. There are three: a board the source
 * could not read whole loses the same four figures through the same function,
 * and a flag set by `readRollup` and `unjoined` instead of inside
 * `withoutJoinedFigures` would have been false on it while the figures were
 * missing. So the flag is stamped where the figures come off, and the cases
 * below are what holds it there.
 */
describe('ProjectsService says the four joined figures are withheld in one flag (#792)', () => {
  const ORG = 'acme';
  const ISSUE = 'https://github.com/acme/board/issues/9';
  const OUTAGE = 'You have exceeded a secondary rate limit';
  /** In the trailing 24h, so a board that keeps the four keeps real ones — the
   *  bucket the card leads with rather than a zero that proves nothing. */
  const CLOSED_AT = new Date(Date.now() - 3_600_000).toISOString();

  /** A board carrying a source seed on both week fields, so a withheld figure is
   *  tellable from a board that had nothing to seed in the first place. */
  const board = (itemsComplete: boolean): ProjectRollup => ({
    number: 9,
    name: 'Board 9',
    url: `https://github.com/orgs/${ORG}/projects/9`,
    status: 'active',
    open: 1,
    closed: 1,
    pct: 50,
    excludedItems: 0,
    itemsComplete,
    recentCloses: [],
    weeklyClosed: [0, 0, 0, 0, 0, 0, 0, 0, 0, 5],
    closedThisWeek: 5,
    openedThisWeek: 0,
    contributors: [{ login: 'IvanRoslov', closed: 1, kind: 'person' }],
    contributorsByAssignee: [{ login: 'IvanRoslov', closed: 1, kind: 'person' }],
  });

  /** One service that can produce all three causes: a board read short, a join
   *  that refuses, and a Github that breaks after a read has been cached. One
   *  fixture for the three deliberately — the claim is that the flag comes out
   *  the same whichever of them it was, and three fixtures could not say that. */
  function harness({ itemsComplete = true, joinRuns = true } = {}) {
    let down = false;
    const refuse = () => {
      if (down) throw new Error(OUTAGE);
    };
    const source: IProjectsSource = {
      listProjects: async () => {
        refuse();
        return [board(itemsComplete)];
      },
      getProject: async () => null,
      projectMemberships: async (): Promise<SourceMembership[]> => {
        refuse();
        return [{ number: 9, name: 'Board 9', issueUrls: [ISSUE] }];
      },
      listProjectCatalog: async (): Promise<SourceCatalogEntry[]> => [],
      disownInFlightReads: vi.fn(),
    };
    const config = pinned();
    const issuesCache = {
      getIssues: async () => {
        if (!joinRuns) throw new Error('issues cache unavailable');
        return {
          issues: [{ htmlUrl: ISSUE, closedAt: CLOSED_AT, createdAt: CLOSED_AT }],
          at: Date.now(),
          orgs: [],
        };
      },
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    return {
      service: new ProjectsService(source, config, issuesCache),
      breakGithub: () => {
        down = true;
      },
    };
  }

  /** The flag and the four figures read off one board as ONE value, so they are
   *  asserted together and neither can drift from the other. Either half alone
   *  is satisfied by a payload that lies: a path that strips the figures without
   *  saying so passes an assertion about the figures, and a path that says so
   *  while serving them passes an assertion about the flag. */
  const withholding = (b: ProjectSummary) => ({
    flag: b.joinedFiguresWithheld,
    weeklyClosed: b.weeklyClosed,
    hasClosedThisWeek: 'closedThisWeek' in b,
    dailyOpened: b.dailyOpened,
    dailyClosed: b.dailyClosed,
  });

  /** Empty and ABSENT, the spelling #715 settled, under a flag that says so. */
  const GONE = {
    flag: true,
    weeklyClosed: [],
    hasClosedThisWeek: false,
    dailyOpened: [],
    dailyClosed: [],
  };

  it('says they are gone on a board the source could not read whole', async () => {
    const [short] = await harness({ itemsComplete: false }).service.listProjects(HUMAN);

    expect(withholding(short)).toEqual(GONE);
    // The cause, said by its own field and by no other. This is the third cause
    // the issue did not count, and the one that decides where the flag is set:
    // `readRollup` and `unjoined` are the two callers, and neither of them is
    // what withholds here.
    expect(short.itemsComplete).toBe(false);
    expect(short.pulseJoined).toBe(true);
    expect(short.lastGoodCopy).toBe(false);
  });

  it('says they are gone when the org-wide join did not run', async () => {
    const [failed] = await harness({ joinRuns: false }).service.listProjects(HUMAN);

    expect(withholding(failed)).toEqual(GONE);
    expect(failed.pulseJoined).toBe(false);
    expect(failed.itemsComplete).toBe(true);
    expect(failed.lastGoodCopy).toBe(false);
  });

  it('says they are gone on the copy a drop retired', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, breakGithub } = harness();

    await service.listProjects(HUMAN);
    service.dropCaches();
    breakGithub();
    const [retiree] = await service.listProjects(HUMAN);

    expect(withholding(retiree)).toEqual(GONE);
    expect(retiree.lastGoodCopy).toBe(true);
    warn.mockRestore();
  });

  it('says nothing is withheld on a board read whole whose join ran', async () => {
    const [whole] = await harness().service.listProjects(HUMAN);

    // FALSE rather than absent, for the reason `lastGoodCopy` is stamped false
    // here: said on every board this path produces, so an absent flag on the
    // wire means only what the type says it means — a board-api that predates
    // the field, or the detail route.
    expect(whole.joinedFiguresWithheld).toBe(false);
    // And the four are really here, so the case above is a withholding rather
    // than a board that never had them.
    expect(whole.weeklyClosed.at(-1)).toBe(1);
    expect(whole.closedThisWeek).toBe(1);
    expect(whole.dailyOpened).toHaveLength(14);
    expect(whole.dailyClosed.at(-1)).toBe(1);
  });

  /**
   * The assertion the whole issue is about.
   *
   * A retiree's `pulseJoined: false` was a claim about an org-wide join that had
   * succeeded — the copy being served is only in the cache because it did — and
   * `joinFailedCountNote` in board-frontend/src/projects/pulse.ts rendered it as
   * "This week's closes were not read". The false is gone. What it was standing
   * in for is on the wire under its own name.
   */
  it('serves a retiree that withholds the figures without lying about the join', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const { service, breakGithub } = harness();

    const [read] = await service.listProjects(HUMAN);
    // The read the copy is made of: the join ran and found the close.
    expect(read.pulseJoined).toBe(true);
    expect(read.closedThisWeek).toBe(1);

    service.dropCaches();
    breakGithub();
    const [retiree] = await service.listProjects(HUMAN);

    // Both flags at once, which is the sentence that could not be said before:
    // the join ran, AND the figures it produced are not on this payload.
    expect(retiree.pulseJoined).toBe(true);
    expect(retiree.joinedFiguresWithheld).toBe(true);
    expect(retiree.lastGoodCopy).toBe(true);
    expect(withholding(retiree)).toEqual(GONE);
    // The board's own answers, which a copy can still speak for, come through.
    expect(retiree.closed).toBe(read.closed);
    expect(retiree.contributors).toEqual(read.contributors);
    warn.mockRestore();
  });
});


describe('manual project refresh outcome (#976)', () => {
  it('distinguishes no authorized scope from a refreshed source', async () => {
    const { source } = makeSource();
    const principal = { key: 'test', owners: [], repositories: [], cache: new WeakMap() } as unknown as GithubPrincipal;
    await githubContext.run({ principal }, async () => {
      await expect(svc(source).resyncWithOutcome()).resolves.toBe('skipped');
      expect(source.listProjects).not.toHaveBeenCalled();
    });
  });
  it('reports partial owner reads and incomplete items while retaining the owners that answered', async () => {
    const { source } = makeSource();
    const original = source.listProjects;
    let fail = true; let incomplete = false;
    source.listProjects = async (org) => {
      if (fail && org === 'b') throw new Error('unreadable');
      return (await original(org)).map((p) => ({ ...p, itemsComplete: !incomplete }));
    };
    const config = new ConfigService({ GITHUB_ORGS: 'a,b', FEEDBACK_REPO: SAMPLE_FEEDBACK_REPO });
    const issues = { getIssues: async () => ({ issues: [], orgs: [], at: Date.now() }) } as unknown as IssuesCacheService;
    const service = new ProjectsService(source, config, issues);
    await expect(service.resyncWithOutcome()).resolves.toBe('degraded');
    fail = false; incomplete = true;
    await expect(service.resyncWithOutcome()).resolves.toBe('degraded');
    incomplete = false;
    await expect(service.resyncWithOutcome()).resolves.toBe('succeeded');
  });
});

/** The Projects row keeps the oldest recorded moment and reports how much of
 *  the board's organisation scope it covers (#1185). */
describe('ProjectsService.lastSyncedAt (#1169)', () => {
  afterEach(() => vi.useRealTimers());
  it('has no record before anything has read the boards', () => {
    const service = svc(makeSource().source);
    expect(service.lastSyncedAt()).toBeNull();
    expect(service.freshness()).toEqual({ syncedAt: null, organisations: { recorded: 0, total: 1 } });
  });

  it('records the rollup once the boards have been read', async () => {
    const service = svc(makeSource().source);
    await service.listProjects(HUMAN);
    const recorded = service.lastSyncedAt();
    expect(recorded).not.toBeNull();
    expect(Number.isNaN(Date.parse(recorded as string))).toBe(false);
  });

  it('asks the source nothing — a panel must not pay for a Projects-v2 walk', async () => {
    const { source } = makeSource();
    const service = svc(source);
    await service.listProjects(HUMAN);
    const before = (source.listProjects as ReturnType<typeof vi.fn>).mock.calls.length;
    service.lastSyncedAt();
    service.lastSyncedAt();
    expect((source.listProjects as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  /**
   * It reads the rollup's MOMENT without marking the request
   * permission-sensitive (#1169 review, B1).
   *
   * `principalState`'s scope is `KeptWhileUnchanged`, and `current` marks the
   * request the instant it is touched — before it has even looked to see whether
   * there is anything in it. The Board sync panel polls this every two minutes
   * in every open tab, on every page. Marked, `GithubExpiryInterceptor` refuses
   * that poll outright once the check behind it has expired, and the answer that
   * does go out carries the withdrawal headers `apiFetch` turns into a
   * whole-board invalidation. When the boards were built is not the boards, so
   * this reads through `PrincipalState.peek`.
   */
  it('reports when the boards were built without marking the request sensitive', async () => {
    const service = svc(makeSource().source);
    const principal = {
      key: 'visibility', owners: [{ login: SAMPLE_ORG, type: 'Organization' }], repositories: [],
      cache: new WeakMap(), permissionCache: new WeakMap(), expiresAt: Date.now() + 60_000,
    } as unknown as GithubPrincipal;
    const read: { principal: GithubPrincipal; sensitive?: boolean } = { principal };
    await githubContext.run(read, async () => {
      // With nothing cached, and with something cached: `current` would have
      // marked the request on both.
      expect(service.lastSyncedAt()).toBeNull();
      expect(read.sensitive, 'a freshness read must not mark the request').toBeUndefined();
      await service.listProjects(HUMAN);
      // The contrast, so this is not a test that would pass against a service
      // that marks nothing at all: reading the BOARDS does mark it.
      expect(read.sensitive).toBe(true);
      read.sensitive = undefined;
      expect(service.lastSyncedAt()).not.toBeNull();
      expect(read.sensitive).toBeUndefined();
    });
  });

  it('forgets its record when a write drops the rollup', async () => {
    const service = svc(makeSource().source);
    await service.listProjects(HUMAN);
    service.dropCaches();
    expect(service.lastSyncedAt()).toBeNull();
  });

  it('reports one of two organisations until both are in', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
    const { source } = makeSource();
    const config = {
      get: (key: string, d?: unknown) =>
        key === 'GITHUB_ORGS' ? `${SAMPLE_ORG},second-org`
          : key === 'FEEDBACK_REPO' ? SAMPLE_FEEDBACK_REPO : d,
    } as unknown as ConfigService;
    const issuesCache = {
      getIssues: async () => ({ issues: [], at: Date.now() }),
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    const service = new ProjectsService(source, config, issuesCache);
    // One org only, so the other has no entry in the rollup cache.
    await service.listProjects(HUMAN, SAMPLE_ORG);
    const first = service.lastSyncedAt();
    expect(first).toBe('2026-09-19T12:00:00.000Z');
    expect(service.freshness()).toEqual({ syncedAt: first, organisations: { recorded: 1, total: 2 } });
    vi.setSystemTime(new Date('2026-09-19T12:01:00Z'));
    await service.listProjects(HUMAN);
    expect(service.freshness()).toEqual({ syncedAt: first, organisations: { recorded: 2, total: 2 } });
  });

  it('serves the last good boards through repeated source failures without counting that org as recorded', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
    const { source } = makeSource();
    const read = source.listProjects;
    let failing = false;
    let failures = 0;
    source.listProjects = async (org) => {
      if (org === 'second-org' && failing) {
        failures++;
        throw Object.assign(new Error('temporarily unavailable'), { status: 503 });
      }
      return (await read(org)).map((board) => ({ ...board, name: org }));
    };
    const issues = {
      getIssues: async () => ({ issues: [], at: Date.now() }),
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    const service = new ProjectsService(source, pinned({ GITHUB_ORGS: `${SAMPLE_ORG},second-org` }), issues);
    const principal = () => ({
      key: 'same-visibility',
      owners: [SAMPLE_ORG, 'second-org'].map((login) => ({ login, type: 'Organization' })),
      repositories: [], cache: new WeakMap(), permissionCache: new WeakMap(),
      expiresAt: Date.now() + 60_000,
    } as unknown as GithubPrincipal);
    await githubContext.run({ principal: principal() }, () => service.listProjects(HUMAN));
    failing = true;
    vi.setSystemTime(new Date('2026-09-19T12:08:00Z'));
    await githubContext.run({ principal: principal() }, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const boards = await service.listProjects(HUMAN);
        expect(boards.map((board) => board.name).sort()).toEqual([SAMPLE_ORG, 'second-org'].sort());
        expect(boards.find((board) => board.org === 'second-org')?.lastGoodCopy).toBe(true);
        expect(service.lastSyncedAt()).toBe('2026-09-19T12:08:00.000Z');
        expect(service.freshness()).toEqual({
          syncedAt: '2026-09-19T12:08:00.000Z', organisations: { recorded: 1, total: 2 }, incomplete: true,
        });
      }
    });
    expect(failures).toBe(2);
  });
});


describe('observed Projects outages (#1208)', () => {
  afterEach(() => vi.useRealTimers());
  it.each([3, 1])('reports an outage while serving last-good boards for all %i organisations and retries', async (total) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));
    const orgs = Array.from({ length: total }, (_, i) => `org-${i}`);
    const { source } = makeSource();
    const read = source.listProjects;
    let failing = false;
    let failures = 0;
    source.listProjects = async (org) => {
      if (failing) {
        failures++;
        throw Object.assign(new Error('temporarily unavailable'), { status: 503 });
      }
      return (await read(org)).map((board) => ({ ...board, name: org }));
    };
    const issues = {
      getIssues: async () => ({ issues: [], at: Date.now() }),
      submissionIndex: async () => ({ lookup: () => false }),
    } as unknown as IssuesCacheService;
    const service = new ProjectsService(source, pinned({ GITHUB_ORGS: orgs.join(',') }), issues);
    const principal = () => ({
      key: 'outage-visibility', owners: orgs.map((login) => ({ login, type: 'Organization' })),
      repositories: [], cache: new WeakMap(), permissionCache: new WeakMap(),
      expiresAt: Date.now() + 60_000,
    } as unknown as GithubPrincipal);
    await githubContext.run({ principal: principal() }, () => service.listProjects(HUMAN));
    failing = true;
    vi.setSystemTime(new Date('2026-09-19T12:08:00Z'));
    await githubContext.run({ principal: principal() }, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const boards = await service.listProjects(HUMAN);
        expect([...new Set(boards.map((board) => board.org))].sort()).toEqual(orgs);
        expect(boards.every((board) => board.lastGoodCopy)).toBe(true);
        expect(service.freshness()).toEqual({
          syncedAt: null, organisations: { recorded: 0, total }, incomplete: true,
        });
      }
      expect(failures).toBe(total * 2);
      failing = false;
      await service.listProjects(HUMAN);
      expect(service.freshness()).toEqual({
        syncedAt: '2026-09-19T12:08:00.000Z', organisations: { recorded: total, total },
      });
    });
  });
});


it('reports an observed failed Projects join without caching it, then recovers', async () => {
  const { source } = makeSource();
  let failing = true;
  const getIssues = vi.fn(async () => {
    if (failing) throw new Error('ingest unavailable');
    return { issues: [], at: Date.now() };
  });
  const issues = { getIssues, submissionIndex: async () => ({ lookup: () => false }) } as unknown as IssuesCacheService;
  const service = new ProjectsService(source, pinned(), issues);
  for (let i = 0; i < 2; i++) {
    expect((await service.listProjects(HUMAN)).length).toBeGreaterThan(0);
    expect(service.freshness()).toEqual({
      syncedAt: null, organisations: { recorded: 0, total: 1 }, incomplete: true,
    });
  }
  expect(getIssues).toHaveBeenCalledTimes(2);
  failing = false;
  await service.listProjects(HUMAN);
  expect(service.freshness().syncedAt).not.toBeNull();
  expect(service.freshness()).not.toHaveProperty('incomplete');
});


it('keeps a concurrent fresh success when an older Projects join fails', async () => {
  const { source } = makeSource();
  let rejectFirst!: (error: Error) => void;
  const firstIssues = new Promise<never>((_resolve, reject) => { rejectFirst = reject; });
  const getIssues = vi.fn()
    .mockReturnValueOnce(firstIssues)
    .mockResolvedValue({ issues: [], at: Date.now() });
  const issues = { getIssues, submissionIndex: async () => ({ lookup: () => false }) } as unknown as IssuesCacheService;
  const service = new ProjectsService(source, pinned(), issues);
  const older = service.listProjects(HUMAN);
  await service.listProjects(HUMAN);
  const fresh = service.freshness();
  expect(fresh.organisations).toEqual({ recorded: 1, total: 1 });
  expect(fresh).not.toHaveProperty('incomplete');
  rejectFirst(new Error('ingest unavailable'));
  expect((await older).every((board) => board.pulseJoined === false)).toBe(true);
  expect(service.freshness()).toEqual(fresh);
  await service.listProjects(HUMAN);
  expect(service.freshness()).toEqual(fresh);
  expect(getIssues).toHaveBeenCalledTimes(2);
});

it('marks a joined but truncated Projects read even though it caches a fresh entry', async () => {
  const { source } = makeSource();
  const read = source.listProjects;
  source.listProjects = async (org) => (await read(org)).map((board) => ({ ...board, itemsComplete: false }));
  const getIssues = vi.fn(async () => ({ issues: [], at: Date.now() }));
  const issues = { getIssues, submissionIndex: async () => ({ lookup: () => false }) } as unknown as IssuesCacheService;
  const service = new ProjectsService(source, pinned(), issues);
  const boards = await service.listProjects(HUMAN);
  expect(boards.length).toBeGreaterThan(0);
  expect(boards.every((board) => board.pulseJoined && board.itemsComplete === false)).toBe(true);
  expect(service.freshness()).toEqual({
    syncedAt: expect.any(String), organisations: { recorded: 1, total: 1 }, incomplete: true,
  });
  await service.listProjects(HUMAN);
  expect(getIssues).toHaveBeenCalledTimes(1);
  expect(service.freshness().incomplete).toBe(true);
});
