import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  DETAIL_ITEM_NODES,
  GithubProjectsSource,
  ITEMS_CONNECTION_HEAD,
  ROLLUP_ITEM_NODES,
  toCustomFields,
} from './github-projects.source';
import { asRollupGithub } from './github-projects.test-double';

/**
 * Live-source mapping regression: the fixture hardcodes tidy data, so the
 * GraphQL payload → typed-summary mapping (counts, completion, last-closed
 * attribution, hiding auto-named/closed boards) is only pinned here.
 */

const config = { get: (_k: string, d?: unknown) => d } as unknown as ConfigService;
/** The org every call here is made about (#697). The source takes it as an
 *  argument now rather than reading it once in its constructor, so a spec has
 *  to say which org it is asking about — and `$owner` in the assertions below
 *  is this string. */
const OWNER = 'acme';
const iso = (d: string) => `2026-07-${d}T00:00:00Z`;

// Unrelated mapping fixtures default to a fully read schema and unset status.
// Status-resolution tests use their own transport without these defaults.
function withStatusSchema(payload: unknown): unknown {
  const data = payload as { organization?: { projectV2?: {
    createdAt?: string;
    fields?: { nodes?: unknown[]; pageInfo?: unknown };
    items?: { nodes: { fieldValues?: { nodes?: unknown[]; pageInfo?: unknown } }[] };
  } } };
  const project = data?.organization?.projectV2;
  if (!project) return payload;
  project.createdAt ??= iso('01');
  project.fields = {
    nodes: [{ __typename: 'ProjectV2SingleSelectField', id: 'status-id', name: 'Status', createdAt: project.createdAt }],
    ...project.fields,
    pageInfo: { hasNextPage: false },
  };
  for (const node of project.items?.nodes ?? []) {
    node.fieldValues = { nodes: [], ...node.fieldValues, pageInfo: { hasNextPage: false } };
  }
  return payload;
}

/** A source whose GraphQL calls return `payload`, each board's first items page
 *  served out of it the way the rollup asks for one since #1007. */
function sourceReturning(payload: unknown) {
  const src = new GithubProjectsSource(config);
  // @ts-expect-error — preset the lazily-built GraphQL client with a stub
  src.graphql = asRollupGithub(vi.fn().mockResolvedValue(withStatusSchema(payload)));
  return src;
}

const issue = (over: Record<string, unknown>) => ({
  __typename: 'Issue',
  number: 1,
  title: 't',
  url: 'u',
  state: 'OPEN',
  repository: { nameWithOwner: 'acme/acme' },
  timelineItems: { nodes: [] },
  // An issue with no labels, said the way the live query says it: a page with a
  // totalCount that matches, i.e. an ESTABLISHED empty set. A connection without
  // one is a page we cannot show reached the end, and the #497 gate reads that
  // as an issue it could not place — so a fixture that omitted it would be
  // testing a payload the source never receives.
  labels: { totalCount: 0, nodes: [] },
  // Said the way the detail query says it too (#516): `Issue.body` is `String!`
  // on Github, so an issue with no description comes back as an empty string,
  // not as an absent field. `GhIssue.body` is required for the same reason — an
  // unfetched body is not "no footer" — so a fixture that omitted it would be
  // testing a payload `toItem` must never be handed.
  body: '',
  // The reason Github gives for a close, said the way both documents ask for it
  // (#1014). `null` is what the API returns for an issue closed before reasons
  // existed, and `GhIssue.stateReason` is required for the same reason `body`
  // is — so a fixture omitting it would be a payload neither query produces.
  // Note the SCREAMING_SNAKE: GraphQL spells the enum `NOT_PLANNED` where the
  // REST ingest sends `not_planned`, and the source folds the case once.
  stateReason: null,
  ...over,
});

describe('GithubProjectsSource.listProjects', () => {
  it('counts open/closed, derives completion, and attributes the last close', async () => {
    const src = sourceReturning({
      organization: {
        projectsV2: {
          nodes: [
            {
              number: 4,
              title: 'Board re-platform',
              url: 'p4',
              closed: false,
              items: {
                totalCount: 3,
                nodes: [
                  { content: issue({ number: 261, state: 'OPEN' }) },
                  {
                    content: issue({
                      number: 259,
                      state: 'CLOSED',
                      closedAt: iso('23'),
                      timelineItems: { nodes: [{ __typename: 'ClosedEvent', actor: { login: 'IvanRoslov' } }] },
                    }),
                  },
                  {
                    content: issue({
                      number: 222,
                      state: 'CLOSED',
                      closedAt: iso('10'),
                      assignees: { nodes: [{ login: 'IvanRoslov' }] },
                      timelineItems: { nodes: [{ __typename: 'ClosedEvent', actor: { login: 'octocat' } }] },
                    }),
                  },
                ],
              },
            },
          ],
        },
      },
    });
    const [p] = await src.listProjects(OWNER);
    expect(p).toMatchObject({ number: 4, name: 'Board re-platform', open: 1, closed: 2, pct: 67 });
    // Every close, newest first — the candidates the viewer-scoped recency pick
    // walks (#497). Most-recently closed (#259, the 23rd) leads, attributed to
    // its closer; the older one keeps its place behind it.
    expect(p.recentCloses.map((c) => c.number)).toEqual([259, 222]);
    expect(p.recentCloses[0]).toMatchObject({ number: 259, by: 'IvanRoslov' });
    // The ring's runs (#454), off the fields the same query already carries.
    // Ivan and Octocat closed one each; Ivan was assigned one and #259 nobody, so
    // the two attributions genuinely differ on the same two issues. Equal shares
    // order by login.
    expect(p.contributors).toEqual([
      { login: 'IvanRoslov', closed: 1, kind: 'person' },
      { login: 'octocat', closed: 1, kind: 'person' },
    ]);
    expect(p.contributorsByAssignee).toEqual([
      { login: 'IvanRoslov', closed: 1, kind: 'person' },
      { login: '', closed: 1, kind: 'unattributed' },
    ]);
  });

  /**
   * The whole of #1014 at the live source: a close Github was told was NOT
   * planned is not work this board delivered, so it leaves every count at once.
   * Four items, three of them closed on the same board, told apart by nothing
   * but the reason — and the abandoned one is the NEWEST close and belongs to a
   * login nobody else has, so a leak into any of the five figures below is
   * visible rather than absorbed into somebody's existing run.
   */
  it('drops a NOT_PLANNED close from the counts, the recency line and both rings (#1014)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const src = sourceReturning({
      organization: {
        projectsV2: {
          nodes: [
            {
              number: 4,
              title: 'Board re-platform',
              url: 'p4',
              closed: false,
              items: {
                totalCount: 4,
                nodes: [
                  { content: issue({ number: 261, state: 'OPEN' }) },
                  {
                    content: issue({
                      number: 259,
                      state: 'CLOSED',
                      closedAt: iso('23'),
                      stateReason: 'COMPLETED',
                      assignees: { nodes: [{ login: 'IvanRoslov' }] },
                      timelineItems: { nodes: [{ __typename: 'ClosedEvent', actor: { login: 'IvanRoslov' } }] },
                    }),
                  },
                  {
                    // No reason at all — the state that COUNTS, and the reason
                    // this test is not simply "closed issues with a reason".
                    content: issue({
                      number: 222,
                      state: 'CLOSED',
                      closedAt: iso('10'),
                      stateReason: null,
                      assignees: { nodes: [{ login: 'octocat' }] },
                      timelineItems: { nodes: [{ __typename: 'ClosedEvent', actor: { login: 'octocat' } }] },
                    }),
                  },
                  {
                    content: issue({
                      number: 300,
                      state: 'CLOSED',
                      closedAt: iso('28'),
                      stateReason: 'NOT_PLANNED',
                      assignees: { nodes: [{ login: 'ghost' }] },
                      timelineItems: { nodes: [{ __typename: 'ClosedEvent', actor: { login: 'ghost' } }] },
                    }),
                  },
                ],
              },
            },
          ],
        },
      },
    });

    const [p] = await src.listProjects(OWNER);
    // Two delivered closes out of three closed rows, so 2/3 and not 3/4: the
    // abandoned issue leaves the completion DENOMINATOR as well, which is the
    // decision #1014 made out loud rather than by accident.
    expect(p).toMatchObject({ open: 1, closed: 2, pct: 67 });
    // It is the newest close on the board and the card still does not name it.
    expect(p.recentCloses.map((c) => c.number)).toEqual([259, 222]);
    expect(p.contributors).toEqual([
      { login: 'IvanRoslov', closed: 1, kind: 'person' },
      { login: 'octocat', closed: 1, kind: 'person' },
    ]);
    expect(p.contributorsByAssignee).toEqual([
      { login: 'IvanRoslov', closed: 1, kind: 'person' },
      { login: 'octocat', closed: 1, kind: 'person' },
    ]);
    // The ring's invariant, stated rather than inferred from the two lists.
    for (const runs of [p.contributors, p.contributorsByAssignee]) {
      expect(runs.reduce((n, c) => n + c.closed, 0)).toBe(p.closed);
    }
    // And a number the board chose not to count is visible from the outside —
    // the same ground `excludedItems` is logged on.
    expect(warn.mock.calls.flat().join(' ')).toMatch(/1 of 3 closed issues were not delivered/);
    warn.mockRestore();
  });

  it('announces the abandoned-close count once per change, not once per refresh (#1450)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const abandoned = (count: number) => ({
      organization: {
        projectsV2: {
          nodes: [
            {
              number: 4,
              title: 'Board re-platform',
              url: 'p4',
              closed: false,
              items: {
                totalCount: count,
                nodes: Array.from({ length: count }, (_, i) => ({
                  content: issue({ number: 300 + i, state: 'CLOSED', closedAt: iso('28'), stateReason: 'NOT_PLANNED' }),
                })),
              },
            },
          ],
        },
      },
    });
    const graphql = vi.fn();
    const src = new GithubProjectsSource(config);
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    src.graphql = asRollupGithub(graphql);
    graphql
      .mockResolvedValueOnce(withStatusSchema(abandoned(1)))
      .mockResolvedValueOnce(withStatusSchema(abandoned(1)))
      .mockResolvedValue(withStatusSchema(abandoned(2)));

    await src.listProjects(OWNER);
    await src.listProjects(OWNER);
    await src.listProjects(OWNER);

    const delivered = warn.mock.calls.flat().filter((c) => String(c).includes('were not delivered'));
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatch(/1 of 1 closed issues were not delivered/);
    expect(delivered[1]).toMatch(/2 of 2 closed issues were not delivered/);
    // The unchanged count repeats at debug, not as a second warn.
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('1 of 1 closed issues were not delivered'));
    warn.mockRestore();
    debug.mockRestore();
  });

  it('announces the abandoned-close count per owner, so two owners with the same project number do not suppress each other (#1450)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const graphql = vi.fn();
    const src = new GithubProjectsSource(config);
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    src.graphql = asRollupGithub(graphql);
    graphql.mockResolvedValue(withStatusSchema({
      organization: {
        projectsV2: {
          nodes: [
            {
              number: 4,
              title: 'Board re-platform',
              url: 'p4',
              closed: false,
              items: {
                totalCount: 1,
                nodes: [
                  { content: issue({ number: 300, state: 'CLOSED', closedAt: iso('28'), stateReason: 'NOT_PLANNED' }) },
                ],
              },
            },
          ],
        },
      },
    }));

    await src.listProjects('first-org');
    await src.listProjects('second-org');

    const delivered = warn.mock.calls.flat().filter((c) => String(c).includes('were not delivered'));
    // Same project number and same count, but each owner is its own key, so
    // both owners' first read warns rather than the second being suppressed.
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatch(/1 of 1 closed issues were not delivered/);
    expect(delivered[1]).toMatch(/1 of 1 closed issues were not delivered/);
    warn.mockRestore();
  });

  it('carries each close’s label names, so a submission can be told from a team issue (#497)', async () => {
    const src = sourceReturning({
      organization: {
        projectsV2: {
          nodes: [
            {
              number: 7,
              title: 'Acme Go-To-Market',
              url: 'p7',
              closed: false,
              items: {
                totalCount: 2,
                nodes: [
                  {
                    content: issue({
                      number: 455,
                      state: 'CLOSED',
                      closedAt: iso('30'),
                      repository: { nameWithOwner: 'acme/board' },
                      labels: { totalCount: 1, nodes: [{ name: 'feedback' }] },
                    }),
                  },
                  { content: issue({ number: 176, state: 'CLOSED', closedAt: iso('05') }) },
                ],
              },
            },
          ],
        },
      },
    });
    const [p] = await src.listProjects(OWNER);
    expect(p.recentCloses.map((c) => c.labels)).toEqual([['feedback'], []]);
  });

  it('hides auto-named personal boards, closed boards, and the "Acme" umbrella (#202)', async () => {
    const empty = { totalCount: 0, nodes: [] };
    const src = sourceReturning({
      organization: {
        projectsV2: {
          nodes: [
            { number: 1, title: "@octocat's untitled project", url: 'p1', closed: false, items: empty },
            { number: 9, title: 'Archived thing', url: 'p9', closed: true, items: empty },
            { number: 4, title: 'Acme', url: 'p4', closed: false, items: empty }, // umbrella
            { number: 7, title: 'Acme Go-To-Market', url: 'p7', closed: false, items: empty }, // focused board survives
          ],
        },
      },
    });
    const list = await src.listProjects(OWNER);
    expect(list.map((p) => p.name)).toEqual(['Acme Go-To-Market']);
  });
});

/**
 * The rollup and the membership index are two mappings of the SAME list query
 * (#518) — asking for them separately made every cold Projects read pay for
 * every board's first hundred items twice. They share the fetch now, and each
 * still returns exactly what it returned before: the rollup sorted by size, the
 * memberships in Github's own board order.
 */
describe('GithubProjectsSource — the rollup and the memberships share one list read (#518)', () => {
  const board = (number: number, title: string, issueNumbers: number[]) => ({
    number,
    title,
    url: `p${number}`,
    closed: false,
    items: {
      totalCount: issueNumbers.length,
      nodes: issueNumbers.map((n) => ({ content: issue({ number: n, url: `https://github.com/o/r/issues/${n}` }) })),
    },
  });
  // Deliberately smallest-first, so "Github's order" and "sorted by size" differ.
  const payload = {
    organization: {
      projectsV2: {
        nodes: [board(7, 'Acme Go-To-Market', [1]), board(4, 'Board hardening', [2, 3])],
      },
    },
  };

  it('fires the list query once when both reads are in flight together', async () => {
    const src = new GithubProjectsSource(config);
    const graphql = vi.fn().mockResolvedValue(payload);
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    src.graphql = asRollupGithub(graphql);

    const [rollups, memberships] = await Promise.all([src.listProjects(OWNER), src.projectMemberships(OWNER)]);

    expect(graphql).toHaveBeenCalledTimes(1);
    // Each mapping is untouched: the rollup orders by board size…
    expect(rollups.map((p) => p.number)).toEqual([4, 7]);
    // …and the memberships keep Github's order and every board's issue URLs.
    expect(memberships).toEqual([
      { number: 7, name: 'Acme Go-To-Market', issueUrls: ['https://github.com/o/r/issues/1'] },
      {
        number: 4,
        name: 'Board hardening',
        issueUrls: ['https://github.com/o/r/issues/2', 'https://github.com/o/r/issues/3'],
      },
    ]);
  });

  it('does not hold the shared read past the fetch — a later read sees fresh data', async () => {
    const src = new GithubProjectsSource(config);
    const graphql = vi.fn().mockResolvedValue(payload);
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    src.graphql = asRollupGithub(graphql);

    await Promise.all([src.listProjects(OWNER), src.projectMemberships(OWNER)]);
    graphql.mockResolvedValue({
      organization: { projectsV2: { nodes: [board(7, 'Acme Go-To-Market renamed', [1])] } },
    });
    const later = await src.listProjects(OWNER);

    // Sharing a fetch is a latch on the round trip, not a cache: the TTL lives in
    // ProjectsService, and a read after the flight lands must go to Github again.
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(later.map((p) => p.name)).toEqual(['Acme Go-To-Market renamed']);
  });

  it('still logs and rethrows for each read when the shared fetch fails', async () => {
    const src = new GithubProjectsSource(config);
    const graphql = vi.fn().mockRejectedValue(new Error('bad credentials'));
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    src.graphql = asRollupGithub(graphql);

    const results = await Promise.allSettled([src.listProjects(OWNER), src.projectMemberships(OWNER)]);

    // Both callers see the failure — a shared fetch must not swallow it for one
    // of them, or the rollup would quietly serve a board list it never read.
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(graphql).toHaveBeenCalledTimes(1);
    // And the latch is released, so the next read retries rather than replaying
    // the failure forever.
    graphql.mockResolvedValue(payload);
    expect((await src.listProjects(OWNER)).map((p) => p.number)).toEqual([4, 7]);
  });
});

/**
 * The latch a write clears, held for TWO orgs at once (#713).
 *
 * `disownInFlightReads(org)` is the one read-state move `ProjectsService` cannot
 * make for itself, and the only place its per-org half is observable is here:
 * the service's own `refill` walks the whole scope, so at that layer "disown
 * each org" and "disown everything" produce the same board lists. Replace the
 * body below with a bare `boardsInFlightByOrg.clear()` and nothing else in this
 * tree notices.
 */
describe('GithubProjectsSource — disowning one org leaves another org in flight (#713)', () => {
  const ORGS = ['org-alpha', 'org-beta'];
  const boardIn = (org: string) => ({
    organization: {
      projectsV2: {
        nodes: [
          {
            number: 7,
            title: `Board of ${org}`,
            url: `https://github.com/orgs/${org}/projects/7`,
            closed: false,
            items: { totalCount: 1, nodes: [{ content: issue({ url: `https://github.com/${org}/r/issues/1` }) }] },
          },
        ],
      },
    },
  });

  /** A source whose board-list reads are all held open until the test releases
   *  them — every flight, not the newest per org, so a disowned one and the read
   *  that replaced it can both be resolved. */
  function heldSource() {
    const held: (() => void)[] = [];
    const graphql = vi.fn(
      (_q: unknown, vars: { owner: string }) =>
        new Promise((resolve) => {
          held.push(() => resolve(boardIn(vars.owner)));
        }),
    );
    const src = new GithubProjectsSource(config);
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    src.graphql = asRollupGithub(graphql);
    return { src, graphql, releaseAll: () => held.splice(0).forEach((release) => release()) };
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('starts a fresh read for the org it was given, and keeps the other flight', async () => {
    const { src, graphql, releaseAll } = heldSource();

    const [alpha, beta] = ORGS.map((org) => src.listProjects(org));
    await tick();
    expect(graphql).toHaveBeenCalledTimes(2);

    src.disownInFlightReads('org-alpha');

    // Alpha's next reader starts its own walk — that is what the write bought.
    const alphaAgain = src.listProjects('org-alpha');
    // Beta's joins the flight that is still latched: a write in alpha must not
    // charge beta's readers a second walk of Github.
    const betaAgain = src.listProjects('org-beta');
    await tick();
    expect(graphql).toHaveBeenCalledTimes(3);

    releaseAll();
    const read = await Promise.all([alpha, beta, alphaAgain, betaAgain]);
    // And every caller still gets its OWN org's boards: disowning is forgetting
    // a latch, not handing one org's answer to another.
    expect(read.map((boards) => boards[0].name)).toEqual([
      'Board of org-alpha',
      'Board of org-beta',
      'Board of org-alpha',
      'Board of org-beta',
    ]);
  });

  it('starts a fresh read for every org when it is given none', async () => {
    const { src, graphql, releaseAll } = heldSource();

    const held = ORGS.map((org) => src.listProjects(org));
    await tick();

    // What `dropCaches` calls: a write is not told which org it landed in.
    src.disownInFlightReads();

    const after = ORGS.map((org) => src.listProjects(org));
    await tick();
    expect(graphql).toHaveBeenCalledTimes(4);

    releaseAll();
    await Promise.all([...held, ...after]);
  });
});

describe('GithubProjectsSource.getProject', () => {
  it('maps items with status field, assignees and linked PRs; null for unknown', async () => {
    const src = sourceReturning({
      organization: {
        projectV2: {
          number: 4,
          title: 'Board re-platform',
          url: 'p4',
          closed: false,
          createdAt: iso('01'),
          fields: { nodes: [{
            __typename: 'ProjectV2SingleSelectField', id: 'status-id', name: 'Status', createdAt: iso('01'),
          }] },
          items: {
            totalCount: 1,
            nodes: [
              {
                fieldValues: { nodes: [{ __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Done', field: { id: 'status-id', name: 'Status' } }] },
                content: issue({
                  number: 259,
                  state: 'CLOSED',
                  createdAt: iso('01'),
                  updatedAt: iso('23'),
                  closedAt: iso('23'),
                  assignees: { nodes: [{ login: 'IvanRoslov' }] },
                  closedByPullRequestsReferences: { nodes: [{ number: 260, url: 'pr260' }] },
                }),
              },
            ],
          },
        },
      },
    });
    const detail = await src.getProject(OWNER, 4);
    expect(detail?.items[0]).toMatchObject({
      number: 259,
      status: 'Done',
      state: 'closed',
      closedAt: iso('23'),
      assignees: ['IvanRoslov'],
      prs: [{ number: 260, url: 'pr260' }],
      parent: null, // top-level issue → no parent (#273)
    });

    // @ts-expect-error — restub to an absent project
    src.graphql = vi.fn().mockResolvedValue({ organization: { projectV2: null } });
    expect(await src.getProject(OWNER, 999)).toBeNull();
  });

  it('maps the parent issue number for native sub-issues (#273)', async () => {
    const src = sourceReturning({
      organization: {
        projectV2: {
          number: 7, title: 'Acme Go-To-Market', url: 'p7', closed: false,
          items: {
            totalCount: 2,
            nodes: [
              { content: issue({ number: 180, updatedAt: iso('04') }) },
              { content: issue({ number: 182, updatedAt: iso('03'), parent: { number: 180 } }) },
            ],
          },
        },
      },
    });
    const byNum = Object.fromEntries((await src.getProject(OWNER, 7))!.items.map((i) => [i.number, i.parent]));
    expect(byNum[182]).toBe(180); // child points at its parent
    expect(byNum[180]).toBeNull(); // parent is top-level
  });

  it('maps issue labels (name+color) and derives a coarse type (#376)', async () => {
    const src = sourceReturning({
      organization: {
        projectV2: {
          number: 7, title: 'Acme Go-To-Market', url: 'p7', closed: false,
          items: {
            totalCount: 2,
            nodes: [
              {
                content: issue({
                  number: 180, updatedAt: iso('04'),
                  labels: { nodes: [{ name: 'bug', color: 'd73a4a' }, { name: 'blocked', color: 'b60205' }] },
                }),
              },
              {
                content: issue({ number: 181, updatedAt: iso('03') }), // no labels → chore
              },
            ],
          },
        },
      },
    });
    const byNum = Object.fromEntries((await src.getProject(OWNER, 7))!.items.map((i) => [i.number, i]));
    expect(byNum[180].labels).toEqual([{ name: 'bug', color: 'd73a4a' }, { name: 'blocked', color: 'b60205' }]);
    expect(byNum[180].type).toBe('bug');
    expect(byNum[181].labels).toEqual([]);
    expect(byNum[181].type).toBe('chore');
  });

  it('derives lastActivity from the timeline, falling back to opened (#259)', async () => {
    const src = sourceReturning({
      organization: {
        projectV2: {
          number: 7,
          title: 'Acme Go-To-Market',
          url: 'p7',
          closed: false,
          items: {
            totalCount: 2,
            nodes: [
              {
                content: issue({
                  number: 183,
                  state: 'OPEN',
                  createdAt: iso('01'),
                  updatedAt: iso('27'),
                  lastActivity: { nodes: [{ __typename: 'ReopenedEvent', createdAt: iso('27') }] },
                }),
              },
              {
                content: issue({
                  number: 185,
                  state: 'OPEN',
                  createdAt: iso('20'),
                  updatedAt: iso('20'),
                  lastActivity: { nodes: [] }, // nothing meaningful yet
                }),
              },
            ],
          },
        },
      },
    });
    const byNum = Object.fromEntries(
      (await src.getProject(OWNER, 7))!.items.map((i) => [i.number, i.lastActivity]),
    );
    expect(byNum[183]).toEqual({ type: 'reopened', atISO: iso('27') });
    expect(byNum[185]).toEqual({ type: 'opened', atISO: iso('20') });
  });

  it('carries the comment permalink as lastActivity.href, none for other events (#376)', async () => {
    const src = sourceReturning({
      organization: {
        projectV2: {
          number: 7, title: 'Acme Go-To-Market', url: 'p7', closed: false,
          items: {
            totalCount: 2,
            nodes: [
              {
                content: issue({
                  number: 190, updatedAt: iso('27'),
                  lastActivity: { nodes: [{ __typename: 'IssueComment', createdAt: iso('27'), url: 'https://github.com/o/r/issues/190#issuecomment-42' }] },
                }),
              },
              {
                content: issue({
                  number: 191, updatedAt: iso('26'),
                  lastActivity: { nodes: [{ __typename: 'ClosedEvent', createdAt: iso('26') }] }, // no url
                }),
              },
            ],
          },
        },
      },
    });
    const byNum = Object.fromEntries((await src.getProject(OWNER, 7))!.items.map((i) => [i.number, i.lastActivity]));
    expect(byNum[190]).toEqual({ type: 'commented', atISO: iso('27'), href: 'https://github.com/o/r/issues/190#issuecomment-42' });
    expect(byNum[191].href).toBeUndefined();
  });

  it('returns null when drilling into the "Acme" umbrella (#202) — off the surface entirely', async () => {
    const src = sourceReturning({
      organization: {
        projectV2: { number: 4, title: 'Acme', url: 'p4', closed: false, items: { totalCount: 0, nodes: [] } },
      },
    });
    expect(await src.getProject(OWNER, 4)).toBeNull();
  });

  it('folds a single-select fieldValues node into customFields on the item (#401)', async () => {
    const src = sourceReturning({
      organization: {
        projectV2: {
          number: 4, title: 'Board re-platform', url: 'p4', closed: false,
          items: {
            totalCount: 1,
            nodes: [
              {
                fieldValues: {
                  nodes: [
                    { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'High', field: { name: 'Priority' } },
                  ],
                },
                content: issue({ number: 259 }),
              },
            ],
          },
        },
      },
    });
    const detail = await src.getProject(OWNER, 4);
    expect(detail?.items[0].customFields).toEqual({ priority: ['High'] });
  });
});

describe('GithubProjectsSource.listProjectCatalog (#404)', () => {
  it('maps id/number/title and excludes a closed board', async () => {
    const src = sourceReturning({
      organization: {
        projectsV2: {
          nodes: [
            { id: 'PVT_1', number: 4, title: 'Board re-platform', closed: false },
            { id: 'PVT_2', number: 9, title: 'Archived thing', closed: true },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    const catalog = await src.listProjectCatalog(OWNER);
    expect(catalog).toEqual([{ id: 'PVT_1', number: 4, title: 'Board re-platform' }]);
  });

  it('excludes the "Acme" umbrella and auto-titled personal boards, same as every other read (#202)', async () => {
    const src = sourceReturning({
      organization: {
        projectsV2: {
          nodes: [
            { id: 'PVT_1', number: 4, title: 'Acme', closed: false }, // umbrella
            { id: 'PVT_2', number: 1, title: "@octocat's untitled project", closed: false }, // auto-titled
            { id: 'PVT_3', number: 7, title: 'Acme Go-To-Market', closed: false }, // focused board survives
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    const catalog = await src.listProjectCatalog(OWNER);
    expect(catalog).toEqual([{ id: 'PVT_3', number: 7, title: 'Acme Go-To-Market' }]);
  });

  it('pages through every board when hasNextPage is true', async () => {
    const src = new GithubProjectsSource(config);
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        organization: {
          projectsV2: {
            nodes: [{ id: 'PVT_1', number: 1, title: 'Page 1', closed: false }],
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
          },
        },
      })
      .mockResolvedValueOnce({
        organization: {
          projectsV2: {
            nodes: [{ id: 'PVT_2', number: 2, title: 'Page 2', closed: false }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    src.graphql = asRollupGithub(graphql);

    const catalog = await src.listProjectCatalog(OWNER);
    expect(catalog).toEqual([
      { id: 'PVT_1', number: 1, title: 'Page 1' },
      { id: 'PVT_2', number: 2, title: 'Page 2' },
    ]);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[1][1]).toMatchObject({ after: 'cursor-1' });
  });

  /**
   * The third cursor loop in this file, and the one that never got the two
   * guards the other two carry (#690). The doc above `MAX_PAGES` says the cap is
   * what stops a cursor Github keeps handing back; this walk had neither the cap
   * nor the stall check, so either payload spins it forever — a hung request on
   * the add-to-project picker rather than a board served short.
   */
  it('stops the catalog walk at the page cap when the connection never ends', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const src = new GithubProjectsSource(config);
      let n = 0;
      const graphql = vi.fn(() => {
        n += 1;
        return Promise.resolve({
          organization: {
            projectsV2: {
              totalCount: 9999,
              nodes: [{ id: `PVT_${n}`, number: n, title: `Board ${n}`, closed: false }],
              pageInfo: { hasNextPage: true, endCursor: `cursor-${n}` },
            },
          },
        });
      });
      // @ts-expect-error — preset the lazily-built GraphQL client with a stub
      src.graphql = asRollupGithub(graphql);
      const catalog = await src.listProjectCatalog(OWNER);
      expect(graphql).toHaveBeenCalledTimes(20);
      expect(catalog).toHaveLength(20);
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/page cap/);
    } finally {
      warn.mockRestore();
    }
  });

  it('stops the catalog walk the moment its cursor stops moving', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const src = new GithubProjectsSource(config);
      const graphql = vi.fn(() =>
        Promise.resolve({
          organization: {
            projectsV2: {
              totalCount: 9999,
              nodes: [{ id: 'PVT_1', number: 1, title: 'Board 1', closed: false }],
              pageInfo: { hasNextPage: true, endCursor: 'stuck' },
            },
          },
        }),
      );
      // @ts-expect-error — preset the lazily-built GraphQL client with a stub
      src.graphql = asRollupGithub(graphql);
      await src.listProjectCatalog(OWNER);
      expect(graphql).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/repeated the cursor/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('toCustomFields (#401)', () => {
  it('maps a single-select value to fieldSlug -> [displayName]', () => {
    expect(
      toCustomFields([
        { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'High', field: { name: 'Priority' } },
      ]),
    ).toEqual({ priority: ['High'] });
  });

  it('maps an iteration value using its title', () => {
    expect(
      toCustomFields([
        { __typename: 'ProjectV2ItemFieldIterationValue', title: 'Sprint 3', field: { name: 'Sprint' } },
      ]),
    ).toEqual({ sprint: ['Sprint 3'] });
  });

  it('ignores unsupported node kinds (text/number/date) and empty values', () => {
    expect(
      toCustomFields([
        { __typename: 'ProjectV2ItemFieldTextValue', field: { name: 'Notes' } },
        { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: undefined, field: { name: 'Priority' } },
      ]),
    ).toBeUndefined();
  });

  it('returns undefined for no enumerable fields', () => {
    expect(toCustomFields([])).toBeUndefined();
  });
});

/**
 * What the two Projects queries ASK FOR, and what the mapping makes of a page
 * that did not reach the end (#497).
 *
 * The stub above answers any query at all, so deleting the `labels` selection —
 * a plausible cleanup, since the rollup renders no label — would leave every
 * test in this file green while a static token started reading end users'
 * sentences off the boards. These two pin the selection itself.
 */
describe('GithubProjectsSource — the label data the words gate depends on (#497)', () => {
  /** The query text a given call sends. */
  async function querySent(call: (src: GithubProjectsSource) => Promise<unknown>): Promise<string> {
    // One surfaced board, so the rollup sends the items document as well as the
    // board list (#1007). Every document is returned, joined: the selection
    // being asked about lives in the items read, and a `not` has to hold for
    // all of them.
    const github = asRollupGithub(async () => ({
      organization: {
        projectsV2: { nodes: [{ number: 1, title: 'C4. Objective 1', url: 'p1', closed: false, items: { totalCount: 0, nodes: [] } }] },
        projectV2: null,
      },
    }));
    const sent: string[] = [];
    const src = new GithubProjectsSource(config);
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    src.graphql = (query: string, vars: Record<string, unknown>) => { sent.push(query); return github(query, vars); };
    await call(src);
    return sent.join('\n');
  }

  it('the rollup query reads label names with a totalCount to check the page against', async () => {
    const query = await querySent((src) => src.listProjects(OWNER));
    expect(query).toMatch(/labels\(first:\s*\d+\)\s*\{\s*totalCount\s+nodes\{\s*name/);
  });

  it('the detail query does too', async () => {
    const query = await querySent((src) => src.getProject(OWNER, 4));
    expect(query).toMatch(/labels\(first:\s*\d+\)\s*\{\s*totalCount\s+nodes\{\s*name/);
  });

  /**
   * #516 — a board row is placed by the footer in its body, so the DETAIL query
   * has to ask for one. It is one board of a hundred items, cached per board for
   * `PROJECTS_CACHE_TTL_MS`, on a query already pulling thirty field values, two
   * timeline connections and five PR references.
   */
  it('the detail query selects the issue body, which is what places a relabelled submission', async () => {
    const query = await querySent((src) => src.getProject(OWNER, 4));
    expect(query).toMatch(/\bbody\b/);
  });

  /**
   * …and the ROLLUP query must not. That one is twenty boards times a hundred
   * items on every refresh, and it is the read #518 put a single-flight latch on;
   * closes get their marker from the shared submission index instead. This is a
   * guard, not a preference — adding `body` here would put a hundred markdown
   * documents per board on every rollup refresh.
   */
  it('the rollup query does NOT select the body — closes read the shared index', async () => {
    const query = await querySent((src) => src.listProjects(OWNER));
    expect(query).not.toMatch(/\bbody\b/);
  });

  it('marks a board row whose body carries the submission footer, and leaves an ordinary one', async () => {
    const src = sourceReturning({
      organization: {
        projectV2: {
          number: 4,
          title: 'Board hardening',
          url: 'p4',
          closed: false,
          items: {
            totalCount: 2,
            nodes: [
              {
                content: issue({
                  number: 902,
                  updatedAt: iso('02'),
                  labels: { totalCount: 1, nodes: [{ name: 'bug' }] },
                  body: 'It just spins.\n\n---\nSubmitted by a@b.com via the board feedback form.',
                }),
              },
              {
                content: issue({
                  number: 497,
                  updatedAt: iso('01'),
                  body: 'The apply step logs nothing when the quota rejects it.',
                }),
              },
            ],
          },
        },
      },
    });
    const detail = await src.getProject(OWNER, 4);
    expect(detail?.items.map((i) => [i.number, i.submission])).toEqual([
      [902, true],
      [497, false],
    ]);
  });

  /**
   * An issue with an EMPTY body is a real Github state — `Issue.body` is
   * `String!`, and an issue opened with no description comes back as `''`. It is
   * an established body with no footer in it, so `false` is the right answer and
   * says so.
   *
   * (Was: "an issue Github returned no body for is unmarked, not unknown",
   * asserting `false` for `body: null`. That name stated the inverse of this
   * control's own invariant — an unestablished fact must withhold, never answer
   * "not a submission" — and it codified a payload the source must never be
   * handed. `GhIssue.body` is now required, so a bodyless node cannot be typed
   * into `toItem` at all; what remains to test is the empty body, which is a
   * state Github genuinely produces.)
   */
  it('an issue whose body is empty is an established "no footer", so it is unmarked', async () => {
    const src = sourceReturning({
      organization: {
        projectV2: {
          number: 4,
          title: 'Board hardening',
          url: 'p4',
          closed: false,
          items: { totalCount: 1, nodes: [{ content: issue({ number: 497, body: '' }) }] },
        },
      },
    });
    expect((await src.getProject(OWNER, 4))?.items[0].submission).toBe(false);
  });

  it('a row whose label page Github had more of is marked incomplete, and still renders what it has', async () => {
    const src = sourceReturning({
      organization: {
        projectV2: {
          number: 4,
          title: 'Board hardening',
          url: 'p4',
          closed: false,
          items: {
            totalCount: 1,
            nodes: [{ content: issue({ number: 462, labels: { totalCount: 40, nodes: [{ name: 'bug' }] } }) }],
          },
        },
      },
    });
    const detail = await src.getProject(OWNER, 4);
    expect(detail?.items[0].labelsComplete).toBe(false);
    expect(detail?.items[0].labels).toEqual([{ name: 'bug', color: '' }]);
  });

  it('a complete label page is marked complete', async () => {
    const src = sourceReturning({
      organization: {
        projectV2: {
          number: 4,
          title: 'Board hardening',
          url: 'p4',
          closed: false,
          items: {
            totalCount: 1,
            nodes: [{ content: issue({ number: 461, labels: { totalCount: 1, nodes: [{ name: 'feedback' }] } }) }],
          },
        },
      },
    });
    const detail = await src.getProject(OWNER, 4);
    expect(detail?.items[0].labelsComplete).toBe(true);
  });

  it('a close whose label page truncated hands the pick a null label set, not an empty one', async () => {
    const src = sourceReturning({
      organization: {
        projectsV2: {
          nodes: [{
            number: 4,
            title: 'Board hardening',
            url: 'p4',
            closed: false,
            items: {
              totalCount: 1,
              nodes: [{ content: issue({
                number: 455,
                state: 'CLOSED',
                closedAt: iso('23'),
                labels: { totalCount: 40, nodes: [{ name: 'bug' }] },
              }) }],
            },
          }],
        },
      },
    });
    const [board] = await src.listProjects(OWNER);
    expect(board.recentCloses[0].labels).toBeNull();
  });
});

/**
 * A board can hold pull requests and draft items as well as issues, and this
 * source counts issues only (#517). That stays true — the fix is that the count
 * of what was left out now rides with the board, so the surface can say why its
 * figures don't match the same board on Github instead of quietly disagreeing
 * with it.
 */
describe('GithubProjectsSource — a board carrying pull requests (#517)', () => {
  const mixedBoard = {
    number: 4,
    title: 'Board hardening',
    url: 'p4',
    closed: false,
    items: {
      totalCount: 5,
      nodes: [
        { content: issue({ number: 261, state: 'OPEN' }) },
        { content: issue({ number: 259, state: 'CLOSED', closedAt: iso('23') }) },
        // What the source drops: a pull request opened on the board, a merged
        // one, and a draft item that never became an issue at all.
        { content: { __typename: 'PullRequest', number: 260, title: 'fix: the thing', state: 'OPEN' } },
        { content: { __typename: 'PullRequest', number: 258, title: 'fix: the other thing', state: 'MERGED' } },
        { content: { __typename: 'DraftIssue', title: 'think about the rest' } },
      ],
    },
  };

  it('counts the issues only, and reports how many items it left out', async () => {
    const src = sourceReturning({ organization: { projectsV2: { nodes: [mixedBoard] } } });
    const [p] = await src.listProjects(OWNER);
    // Unchanged behaviour: two issues, one open one closed, so 50%. The two pull
    // requests and the draft are not work this board reports on.
    expect(p).toMatchObject({ open: 1, closed: 1, pct: 50 });
    expect(p.recentCloses.map((c) => c.number)).toEqual([259]);
    // The new fact: three of the board's items are not counted above.
    expect(p.excludedItems).toBe(3);
  });

  it('reports nothing excluded for a board holding only issues', async () => {
    const src = sourceReturning({
      organization: {
        projectsV2: {
          nodes: [{ ...mixedBoard, items: { totalCount: 1, nodes: [{ content: issue({ number: 261 }) }] } }],
        },
      },
    });
    const [p] = await src.listProjects(OWNER);
    expect(p.excludedItems).toBe(0);
  });

  /** Same board, read the other way. The drill-in builds its summary from the
   *  same nodes, so it must not report a different number of left-out items than
   *  the card that opened it. */
  it('says the same thing on the board’s own page as on its card', async () => {
    const src = sourceReturning({ organization: { projectV2: mixedBoard } });
    const detail = await src.getProject(OWNER, 4);
    expect(detail?.excludedItems).toBe(3);
    expect(detail?.items.map((i) => i.number)).toEqual([261, 259]);
  });

  /** Items Github held past the query's page are a different fact, already
   *  warned about on its own — counting them here would tell a reader a hundred
   *  pull requests sit on a board that has none. */
  it('counts only what it read and dropped, not what the page never reached', async () => {
    const src = sourceReturning({
      organization: {
        projectsV2: { nodes: [{ ...mixedBoard, items: { ...mixedBoard.items, totalCount: 140 } }] },
      },
    });
    const [p] = await src.listProjects(OWNER);
    expect(p.excludedItems).toBe(3);
  });
});

/**
 * The author the recency pick keys on (#488). This is the field a fixture cannot
 * prove: the fixture decides for itself what a close looks like, while on the
 * live board the shape is a dependency bump dependabot OPENED and a person
 * merged — so a pick keyed on the closer skips nothing there. These pin the
 * selection and the mapping, so the one field the skip depends on can't quietly
 * stop coming back.
 */
describe('GithubProjectsSource — who WROTE the closed issue (#488)', () => {
  async function querySent(call: (src: GithubProjectsSource) => Promise<unknown>): Promise<string> {
    // One surfaced board, so the rollup sends the items document as well as the
    // board list (#1007). Every document is returned, joined: the selection
    // being asked about lives in the items read, and a `not` has to hold for
    // all of them.
    const github = asRollupGithub(async () => ({
      organization: {
        projectsV2: { nodes: [{ number: 1, title: 'C4. Objective 1', url: 'p1', closed: false, items: { totalCount: 0, nodes: [] } }] },
        projectV2: null,
      },
    }));
    const sent: string[] = [];
    const src = new GithubProjectsSource(config);
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    src.graphql = (query: string, vars: Record<string, unknown>) => { sent.push(query); return github(query, vars); };
    await call(src);
    return sent.join('\n');
  }

  it('the rollup query asks for the issue’s author login', async () => {
    expect(await querySent((src) => src.listProjects(OWNER))).toMatch(/author\{\s*login\s*\}/);
  });

  it('the detail query does too — it builds the same rollup', async () => {
    expect(await querySent((src) => src.getProject(OWNER, 4))).toMatch(/author\{\s*login\s*\}/);
  });

  /** The live shape, mapped: author and closer are different people, and both
   *  ride the candidate — the pick reads one, the card prints the other. */
  it('maps author and closer separately on a bump a person merged', async () => {
    const src = sourceReturning({
      organization: {
        projectsV2: {
          nodes: [{
            number: 4,
            title: 'Board hardening',
            url: 'p4',
            closed: false,
            items: {
              totalCount: 2,
              nodes: [
                { content: issue({
                  number: 487,
                  title: 'chore(deps): bump @acme/ui from 0.19.1 to 0.26.1',
                  state: 'CLOSED',
                  closedAt: iso('23'),
                  author: { login: 'dependabot[bot]' },
                  timelineItems: { nodes: [{ __typename: 'ClosedEvent', actor: { login: 'octocat' } }] },
                }) },
                { content: issue({
                  number: 176,
                  state: 'CLOSED',
                  closedAt: iso('10'),
                  author: { login: 'octocat' },
                  timelineItems: { nodes: [{ __typename: 'ClosedEvent', actor: { login: 'octocat' } }] },
                }) },
              ],
            },
          }],
        },
      },
    });
    const [board] = await src.listProjects(OWNER);
    expect(board.recentCloses[0]).toMatchObject({ number: 487, author: 'dependabot[bot]', by: 'octocat' });
    expect(board.recentCloses[1]).toMatchObject({ number: 176, author: 'octocat', by: 'octocat' });
  });

  it('a close whose author Github no longer returns (deleted account) maps to null, not a bot', async () => {
    const src = sourceReturning({
      organization: {
        projectsV2: {
          nodes: [{
            number: 4,
            title: 'Board hardening',
            url: 'p4',
            closed: false,
            items: {
              totalCount: 1,
              nodes: [{ content: issue({ number: 300, state: 'CLOSED', closedAt: iso('23'), author: null }) }],
            },
          }],
        },
      },
    });
    const [board] = await src.listProjects(OWNER);
    expect(board.recentCloses[0].author).toBeNull();
  });
});

/**
 * A board holding more than one page of items (#690). Every read here used to
 * stop at Github's first hundred and say so only in a log line: board 9 on
 * acme held 119 items and served 100, and because items come back in
 * board position order the nineteen that fell off were the most recent ones.
 *
 * The stub answers per call, so a fixture can hand back a first page that says
 * `hasNextPage` and a continuation page that finishes the connection — which is
 * what the shared `sourceReturning` above (one payload for every call) cannot do.
 */
describe('GithubProjectsSource — a board with more than one page of items (#690)', () => {
  /** A source whose GraphQL stub answers from the query text and variables. */
  function sourcePaging(answer: (query: string, vars: Record<string, unknown>) => unknown) {
    const src = new GithubProjectsSource(config);
    const graphql = vi.fn((query: string, vars: Record<string, unknown>) => Promise.resolve(withStatusSchema(answer(query, vars))));
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    src.graphql = asRollupGithub(graphql);
    return { src, graphql };
  }

  const isBoardList = (q: string) => /projectsV2\(/.test(q);
  const isContinuation = (q: string) => /items\(first:\s*\d+,\s*after:/.test(q);

  /** An items connection: the nodes it holds, the total the board really has,
   *  and the cursor of the next page (null = this page is the last). */
  const itemsPage = (numbers: number[], totalCount: number, nextCursor: string | null) => ({
    totalCount,
    pageInfo: { hasNextPage: nextCursor !== null, endCursor: nextCursor },
    nodes: numbers.map((n) => ({ content: issue({ number: n, url: `https://github.com/o/r/issues/${n}` }) })),
  });

  const board = (items: ReturnType<typeof itemsPage>) => ({
    number: 9,
    title: 'C4. Objective 1',
    url: 'p9',
    closed: false,
    items,
  });

  /** Board 9's shape, shrunk: two items on the first page, a third behind a
   *  cursor, and a totalCount that only adds up once both pages are in. */
  const twoPageBoard = (query: string) =>
    isContinuation(query)
      ? { organization: { projectV2: { items: itemsPage([3], 3, null) } } }
      : isBoardList(query)
        ? { organization: { projectsV2: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [board(itemsPage([1, 2], 3, 'c1'))] } } }
        : { organization: { projectV2: board(itemsPage([1, 2], 3, 'c1')) } };

  it('the rollup counts every item, not just the first page', async () => {
    const { src, graphql } = sourcePaging(twoPageBoard);
    const [p] = await src.listProjects(OWNER);
    expect(p.open).toBe(3);
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  /** The #518 latch, on a board that PAGES. The tests at the top of this file
   *  prove the sharing on a single-page board, where the whole read is one call
   *  and one call is all sharing could ever cost. This is the shape that breaks
   *  silently once a read is more than one call: lift the paging out of the
   *  latched promise and each caller walks the board for itself, doubling the
   *  cost #518 exists to halve — with every other test in this file still green.
   *  Taken from a review agent's unmerged work on this lane; it was the one
   *  case that branch held and this file did not. */
  it('the rollup and the memberships still share ONE read when the board pages (#518)', async () => {
    const { src, graphql } = sourcePaging(twoPageBoard);
    const [rollups, memberships] = await Promise.all([src.listProjects(OWNER), src.projectMemberships(OWNER)]);
    // One list query plus one continuation. Not two of each.
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(rollups[0].open).toBe(3);
    expect(memberships[0].issueUrls).toHaveLength(3);
  });

  it('the memberships index carries every issue URL, not just the first page', async () => {
    const { src } = sourcePaging(twoPageBoard);
    const [m] = await src.projectMemberships(OWNER);
    expect(m.issueUrls).toEqual([
      'https://github.com/o/r/issues/1',
      'https://github.com/o/r/issues/2',
      'https://github.com/o/r/issues/3',
    ]);
  });

  it('the board page serves every item, not just the first page', async () => {
    const { src } = sourcePaging(twoPageBoard);
    const detail = await src.getProject(OWNER, 9);
    expect(detail?.items.map((i) => i.number).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('pages the board LIST too — a second page of boards is served', async () => {
    const second = (n: number) => ({ ...board(itemsPage([n], 1, null)), number: n, title: `Board ${n}` });
    const { src, graphql } = sourcePaging((query, vars) => {
      if (!isBoardList(query)) throw new Error(`unexpected query: ${query}`);
      return vars.after === 'boards-1'
        ? { organization: { projectsV2: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [second(5)] } } }
        : { organization: { projectsV2: { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: 'boards-1' }, nodes: [second(9)] } } };
    });
    const rollups = await src.listProjects(OWNER);
    // Board 5 came off the second page. Both hold one item, so the size sort
    // ties and Github's own order stands — the point is that 5 is here at all.
    expect(rollups.map((p) => p.number)).toEqual([9, 5]);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[1][1]).toMatchObject({ after: 'boards-1' });
  });

  it('serves what it got and warns with both numbers when the pages end short of totalCount', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      // Two items across two pages that BOTH say they are done, on a board
      // Github says holds 119 — what a board that changed under the read looks
      // like. The pages have to be walked to the end before the shortfall is a
      // fact rather than a page size.
      const { src } = sourcePaging((query) =>
        isContinuation(query)
          ? { organization: { projectV2: { items: itemsPage([2], 119, null) } } }
          : { organization: { projectsV2: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [board(itemsPage([1], 119, 'c1'))] } } },
      );
      const [p] = await src.listProjects(OWNER);
      expect(p.open).toBe(2);
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said).toMatch(/119/);
      expect(said).toMatch(/\b2\b/);
    } finally {
      warn.mockRestore();
    }
  });

  /** The field the day-series gate reads (#690). `totalCount` is the only thing
   *  that can settle it and it exists in the payload alone, so the source is the
   *  only place the answer can be made — `ProjectsService` used to derive it
   *  from a page size and now carries what the paging observed. */
  it('says the rollup board was read whole when the pages add up to totalCount', async () => {
    const { src } = sourcePaging(twoPageBoard);
    const [p] = await src.listProjects(OWNER);
    expect(p.itemsComplete).toBe(true);
  });

  it('says the rollup board was NOT read whole when the pages end short of totalCount', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      // Two items across two pages that both say they are done, on a board
      // Github says holds 119 — a board that changed under the read.
      const { src } = sourcePaging((query) =>
        isContinuation(query)
          ? { organization: { projectV2: { items: itemsPage([2], 119, null) } } }
          : { organization: { projectsV2: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [board(itemsPage([1], 119, 'c1'))] } } },
      );
      const [p] = await src.listProjects(OWNER);
      expect(p.itemsComplete).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('carries the same answer on the board page, off the same paging', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { src } = sourcePaging(twoPageBoard);
      expect((await src.getProject(OWNER, 9))?.itemsComplete).toBe(true);

      const { src: shortSrc } = sourcePaging((query) =>
        isContinuation(query)
          ? { organization: { projectV2: { items: itemsPage([2], 119, null) } } }
          : { organization: { projectV2: board(itemsPage([1], 119, 'c1')) } },
      );
      expect((await shortSrc.getProject(OWNER, 9))?.itemsComplete).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('stops after 20 pages of items when Github never says hasNextPage:false', async () => {
    let cursor = 0;
    const { src, graphql } = sourcePaging((query) => {
      cursor += 1;
      const page = itemsPage([cursor], 9999, `c${cursor}`);
      return isBoardList(query)
        ? { organization: { projectsV2: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [board(page)] } } }
        : { organization: { projectV2: { items: page } } };
    });
    const [p] = await src.listProjects(OWNER);
    // One base page plus nineteen continuations — the loop stops itself rather
    // than following a cursor Github keeps handing back.
    expect(graphql).toHaveBeenCalledTimes(20);
    expect(p.open).toBe(20);
  });

  /** A cursor Github hands back unchanged, on a connection that never says it
   *  ended. The page after `stuck` IS the page before it, so nineteen more
   *  round trips would each learn the same nothing — the page cap is the wrong
   *  instrument for a walk that has stopped moving. */
  it('stops the moment the item cursor stops moving, without walking to the cap', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const stuck = () => itemsPage([1], 119, 'stuck');
      const { src, graphql } = sourcePaging((query) =>
        isContinuation(query)
          ? { organization: { projectV2: { items: stuck() } } }
          : { organization: { projectsV2: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [board(stuck())] } } },
      );
      const [p] = await src.listProjects(OWNER);
      // The list read and ONE continuation, not the twenty the cap allows.
      expect(graphql).toHaveBeenCalledTimes(2);
      expect(p.itemsComplete).toBe(false);
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      // Four endings, four faults, four different things for whoever reads the
      // log to do: a repeated cursor is Github contradicting itself, and saying
      // "the page cap" here would send them to look for a board of 2000 items.
      expect(said).toMatch(/repeated the cursor/);
      expect(said).not.toMatch(/page cap/);
    } finally {
      warn.mockRestore();
    }
  });

  it('says the page cap, not a stalled cursor, when the cursor was moving all along', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      let cursor = 0;
      const { src } = sourcePaging((query) => {
        cursor += 1;
        const page = itemsPage([cursor], 9999, `c${cursor}`);
        return isBoardList(query)
          ? { organization: { projectsV2: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [board(page)] } } }
          : { organization: { projectV2: { items: page } } };
      });
      await src.listProjects(OWNER);
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said).toMatch(/page cap/);
      expect(said).not.toMatch(/repeated the cursor/);
    } finally {
      warn.mockRestore();
    }
  });

  /** Before #690 a page-two failure could not happen, because page two was
   *  never asked for. Now it can, and the rollup asks about every board at
   *  once — so a 502 on board 9's second page must cost board 9 its tail and
   *  nothing else, not the whole surface. */
  it('serves the rollup short on the board whose later page failed, and keeps the others', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { src } = sourcePaging((query) => {
        if (isContinuation(query)) throw new Error('502 Bad Gateway');
        return {
          organization: {
            projectsV2: {
              totalCount: 2,
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [board(itemsPage([1, 2], 3, 'c1')), { ...board(itemsPage([4], 1, null)), number: 5, title: 'C4. Objective 2' }],
            },
          },
        };
      });
      const rollups = await src.listProjects(OWNER);
      expect(rollups.map((p) => p.number)).toEqual([9, 5]);
      expect(rollups[0].open).toBe(2);
      // The pages in hand are served, and the read says it came up short — so
      // the day series are withheld from this board rather than drawn off a
      // tail that never arrived (#663).
      expect(rollups[0].itemsComplete).toBe(false);
      expect(rollups[1].itemsComplete).toBe(true);
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said).toMatch(/502 Bad Gateway/);
      expect(said).toMatch(/read 2 of 3 items/);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The board page asks about ONE board, and serving it short would be the wrong
   * trade there: half a board rendered as a whole one. So no board comes back —
   * and since #697 that is a THROW rather than a null.
   *
   * The null it used to answer said "this org has no board 9", which a 502 on
   * page two is not: the board is there and the read of it failed. `getProject`
   * is walked across every configured org now, so the difference decides whether
   * a second org's board 9 is served under this URL and whether the miss is
   * cached as a fact — see `projects.multi-org.spec.ts`. What #690 asked for is
   * unchanged and, if anything, stronger: a throw serves no items at all.
   */
  it('answers no board at all when the BOARD PAGE hits a failing later page', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { src } = sourcePaging((query) => {
        if (isContinuation(query)) throw new Error('502 Bad Gateway');
        return { organization: { projectV2: board(itemsPage([1, 2], 3, 'c1')) } };
      });
      await expect(src.getProject(OWNER, 9)).rejects.toThrow(/502 Bad Gateway/);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * A board deleted, archived or made private between page one and page two.
   * Octokit does not throw for it: the payload is a well-formed
   * `{organization:{projectV2:null}}` with no `errors` array, so the read ends
   * with no items connection and no exception. No board comes back — the route
   * renders `detail.items` without consulting `itemsComplete`, so half a board
   * would be served as a whole one and nothing downstream would notice.
   *
   * NULL here, unlike the thrown page above, and that is the whole distinction
   * #697 drew: a board that went away really is a board this org does not hold,
   * so the answer is settled and every other org may still be asked. A 502 is
   * not an answer at all.
   */
  it('answers no board at all when a later page comes back with no items connection', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { src } = sourcePaging((query) =>
        isContinuation(query)
          ? { organization: { projectV2: null } }
          : { organization: { projectV2: board(itemsPage([1, 2], 3, 'c1')) } },
      );
      expect(await src.getProject(OWNER, 9)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('serves the ROLLUP short for the same payload, keeping the pages it has', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { src } = sourcePaging((query) =>
        isContinuation(query)
          ? { organization: { projectV2: null } }
          : { organization: { projectsV2: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [board(itemsPage([1, 2], 3, 'c1'))] } } },
      );
      const [p] = await src.listProjects(OWNER);
      expect(p.open).toBe(2);
      expect(p.itemsComplete).toBe(false);
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said).toMatch(/no items connection/);
    } finally {
      warn.mockRestore();
    }
  });

  /** `surfaced()` throws these away moments later — the "Acme" umbrella and
   *  auto-titled personal boards (#202) — so every continuation spent on one is
   *  a point of a 5000/hour budget spent on a board no read will ever show.
   *  `getProject` has surfaced before it paged all along. */
  /**
   * The count agreeing is not the walk finishing. A board reports 2 items, 2
   * more are added while the pages are walked, and the page after that fails:
   * `read >= totalCount` is true and the read is still missing whatever was
   * added after it. Blessing that serves a day series off a board nobody
   * followed to the end — the shape #690 exists to stop, wearing a total that
   * happens to add up.
   */
  it('does not call a walk whole just because the count caught up with it', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { src } = sourcePaging((query) => {
        if (isContinuation(query)) throw new Error('502 Bad Gateway');
        return { organization: { projectsV2: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [board(itemsPage([1, 2], 2, 'c1'))] } } };
      });
      const [p] = await src.listProjects(OWNER);
      // Two items read, two reported — and a page Github said was there that
      // never arrived.
      expect(p.open).toBe(2);
      expect(p.itemsComplete).toBe(false);
      // A false with no line is the silent shortfall this issue is about, so
      // every false says what happened out loud.
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said).toMatch(/502 Bad Gateway/);
    } finally {
      warn.mockRestore();
    }
  });

  /** Github saying `hasNextPage: true` and handing back no cursor is a
   *  contradiction, not an end — and it used to be read as one, so the board
   *  came back complete or, at best, blamed for changing under the read. */
  it('names a next page with no cursor for what it is, and does not call the board whole', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const cursorless = { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: null }, nodes: [{ content: issue({ number: 1 }) }] };
      const { src, graphql } = sourcePaging(() => ({
        organization: { projectsV2: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ ...board(itemsPage([1], 2, null)), items: cursorless }] } },
      }));
      const [p] = await src.listProjects(OWNER);
      // Nothing to ask with, so nothing is asked: the list read and no more.
      expect(graphql).toHaveBeenCalledTimes(1);
      expect(p.itemsComplete).toBe(false);
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said).toMatch(/no cursor/);
      expect(said).not.toMatch(/changed while we read it/);
    } finally {
      warn.mockRestore();
    }
  });

  it('spends no round trip paging a board no read surfaces (#202)', async () => {
    const hidden = { ...board(itemsPage([1], 119, 'c1')), number: 1, title: 'Acme' };
    const shown = { ...board(itemsPage([2], 1, null)), number: 9 };
    const { src, graphql } = sourcePaging((query) => {
      if (isContinuation(query)) throw new Error('paged a board no read surfaces');
      return { organization: { projectsV2: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [hidden, shown] } } };
    });
    const rollups = await src.listProjects(OWNER);
    expect(rollups.map((p) => p.number)).toEqual([9]);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  /** `GhProject.items` is required by declaration over a cast payload, so a
   *  board node without one is a TypeError thrown OUTSIDE `pageItems`' try —
   *  rejecting the rollup and every other board on it, which is the isolation
   *  `serve-short` promises being defeated by the shape of a payload. */
  it('serves the other boards when one arrives with no items connection at all', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const headless = { number: 3, title: 'C4. Objective 3', url: 'p3', closed: false };
      const { src } = sourcePaging(() => ({
        organization: {
          projectsV2: {
            totalCount: 2,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [headless, { ...board(itemsPage([1, 2], 2, null)), number: 9 }],
          },
        },
      }));
      const rollups = await src.listProjects(OWNER);
      expect(rollups.map((p) => p.number)).toEqual([9, 3]);
      expect(rollups.find((p) => p.number === 3)?.open).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('stops the moment the BOARD cursor stops moving', async () => {
    const { src, graphql } = sourcePaging((_query, vars) => ({
      organization: {
        projectsV2: {
          totalCount: 9999,
          pageInfo: { hasNextPage: true, endCursor: 'stuck' },
          nodes: [
            vars.after == null
              ? board(itemsPage([1], 1, null))
              : { ...board(itemsPage([2], 1, null)), number: 5, title: 'C4. Objective 2' },
          ],
        },
      },
    }));
    const rollups = await src.listProjects(OWNER);
    // Two list reads: the first, and the one that asked for `stuck` and was
    // handed `stuck` back. Not the twenty the cap allows.
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(rollups.map((p) => p.number)).toEqual([9, 5]);
  });

  it('stops after 20 pages of boards too', async () => {
    let n = 0;
    const { src, graphql } = sourcePaging(() => {
      n += 1;
      return {
        organization: {
          projectsV2: {
            totalCount: 9999,
            pageInfo: { hasNextPage: true, endCursor: `boards-${n}` },
            nodes: [{ ...board(itemsPage([n], 1, null)), number: n, title: `Board ${n}` }],
          },
        },
      };
    });
    const rollups = await src.listProjects(OWNER);
    expect(graphql).toHaveBeenCalledTimes(20);
    expect(rollups).toHaveLength(20);
  });
});

/**
 * What the CONTINUATION queries ask for (#690). The `querySent` helpers above
 * read `graphql.mock.calls[0][0]` — the first call — so none of them can see a
 * continuation. These pin the two divergences that would be silent: a rollup
 * continuation that grew a `body` puts a hundred markdown documents per board on
 * every refresh, and a detail continuation that lost one puts every feedback row
 * on that page back in the clear (#516).
 */
describe('GithubProjectsSource — what the continuation queries ask for (#690)', () => {
  /** The text of every query a call sent, in order. */
  async function queriesSent(call: (src: GithubProjectsSource) => Promise<unknown>): Promise<string[]> {
    const src = new GithubProjectsSource(config);
    const first = {
      totalCount: 2,
      pageInfo: { hasNextPage: true, endCursor: 'c1' },
      nodes: [{ content: issue({ number: 1 }) }],
    };
    const rest = { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ content: issue({ number: 2 }) }] };
    const graphql = vi.fn((query: string, _vars: Record<string, unknown>) =>
      Promise.resolve(
        /items\(first:\s*\d+,\s*after:/.test(query)
          ? { organization: { projectV2: { items: rest } } }
          : /projectsV2\(/.test(query)
            ? { organization: { projectsV2: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 9, title: 'C4. Objective 1', url: 'p9', closed: false, items: first }] } } }
            : { organization: { projectV2: { number: 9, title: 'C4. Objective 1', url: 'p9', closed: false, items: first } } },
      ),
    );
    const github = asRollupGithub(async (query, vars) => withStatusSchema(await graphql(query, vars)));
    const sent: string[] = [];
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    src.graphql = (query: string, vars: Record<string, unknown>) => { sent.push(query); return github(query, vars); };
    await call(src);
    return sent;
  }

  it('the rollup continuation asks for the WHOLE selection the query it continues asks for', async () => {
    const [list, base, continuation] = await queriesSent((src) => src.listProjects(OWNER));
    expect(continuation).toBeDefined();
    // The board list asks for no items at all since #1007. A board's first
    // page is asked for by number, like every page after it.
    expect(list).not.toMatch(/items\(/);
    // The entire shared constant, on both documents — not the three fields
    // somebody thought to name. A continuation that quietly dropped
    // `author{login}` or `assignees` passes every spot check and still changes
    // what the rollup card says about who closed what.
    expect(base).toContain(ROLLUP_ITEM_NODES);
    expect(continuation).toContain(ROLLUP_ITEM_NODES);
  });

  /**
   * Whether a close was DELIVERY is decided off `stateReason` (#1014), and the
   * generous half of that decision is that a reason we were not given COUNTS.
   * So a document that stopped selecting the field would not fail, break or log
   * — it would quietly put every abandoned issue back into the throughput this
   * issue took it out of. Asserted on both constants rather than only on the
   * pair matching, because both of them LOSING the field matches just as well.
   */
  it('both shared selections ask WHY an issue closed, so no query can count an abandoned one (#1014)', () => {
    expect(ROLLUP_ITEM_NODES).toMatch(/\bstateReason\b/);
    expect(DETAIL_ITEM_NODES).toMatch(/\bstateReason\b/);
  });

  it('the detail continuation asks for the WHOLE selection too, body included (#516)', async () => {
    const [base, continuation] = await queriesSent((src) => src.getProject(OWNER, 9));
    expect(continuation).toBeDefined();
    expect(base).toContain(DETAIL_ITEM_NODES);
    expect(continuation).toContain(DETAIL_ITEM_NODES);
    // `toItem` reads the body to place a feedback submission by its footer, and
    // an unfetched body would answer an authoritative "not a submission" — so a
    // detail continuation without one puts every feedback row on that page back
    // in the clear, which is #516 itself.
    expect(DETAIL_ITEM_NODES).toMatch(/\bbody\b/);
  });

  /**
   * `totalCount` and `pageInfo` are the two fields the whole mechanism runs on —
   * one settles `itemsComplete`, the other is the cursor — and until #690's fix
   * round they sat hand-copied in four documents with nothing asserting either.
   * Deleting `totalCount` from one of them left the suite green and `tsc` clean
   * (`GhItemsConnection.totalCount` is a declaration over a cast payload, not a
   * checked fact) while every board over a hundred items quietly went back to
   * drawing a day series off its oldest hundred. One constant, four documents,
   * asserted here.
   */
  it('every items connection asks for the totalCount and the cursor, on all four documents', async () => {
    const [, rollupBase, rollupContinuation] = await queriesSent((src) => src.listProjects(OWNER));
    const [detailBase, detailContinuation] = await queriesSent((src) => src.getProject(OWNER, 9));
    for (const q of [rollupBase, rollupContinuation, detailBase, detailContinuation]) {
      expect(q).toBeDefined();
      expect(q).toContain(ITEMS_CONNECTION_HEAD);
    }
    // And the constant is the two fields, not an empty string every document
    // trivially contains.
    expect(ITEMS_CONNECTION_HEAD).toMatch(/\btotalCount\b/);
    expect(ITEMS_CONNECTION_HEAD).toMatch(/pageInfo\{\s*hasNextPage\s+endCursor\s*\}/);
  });

  it('the shared selections carry the labels totalCount the words gate reads, and the rollup no body (#497, #516)', () => {
    // #497: the recency line names a closed issue by title, and a submission's
    // title is an end user's first line — the decision keys on the `feedback`
    // label being PRESENT, so a page that stopped short of the issue's labels
    // would read as "no feedback label here". `knownLabels` answers null without
    // the totalCount, and the decision withholds on null.
    expect(ROLLUP_ITEM_NODES).toMatch(/labels\(first:\s*\d+\)\s*\{\s*totalCount\s+nodes\{\s*name/);
    expect(DETAIL_ITEM_NODES).toMatch(/labels\(first:\s*\d+\)\s*\{\s*totalCount\s+nodes\{\s*name/);
    // Kept beside "the two documents match", because both documents GROWING a
    // body would satisfy that just as well — and the rollup is twenty boards
    // times a hundred markdown documents on every refresh.
    expect(ROLLUP_ITEM_NODES).not.toMatch(/\bbody\b/);
  });
});

/**
 * What one Projects refill costs Github, in its own units (#1007).
 *
 * Github meters GraphQL in points it computes from the connections a document
 * could walk: every `first`/`last` connection costs the product of the page
 * sizes above it, the sum is divided by one hundred and rounded, and the least
 * a document costs is 1. It prices what a document asks for, not what comes
 * back. The rollup used to be one document asking for twenty boards with a
 * hundred items each, 60 points per org whether the org had twenty boards or
 * none. It is now the board list, 1 point, and 3 points for each board's first
 * page, so an org pays for the boards it has.
 */
describe('GithubProjectsSource — a refill pays for the boards an org has (#1007)', () => {
  /** Github's published GraphQL cost of a document. */
  function points(query: string): number {
    let total = 0;
    const multipliers = [1];
    const selection = /(?:\.\.\.\s*on\s+)?[A-Za-z_]\w*\s*(?::\s*[A-Za-z_]\w*\s*)?(?:\(([^()]*)\))?\s*\{|\}/g;
    for (let m = selection.exec(query); m; m = selection.exec(query)) {
      if (m[0] === '}') { multipliers.pop(); continue; }
      const above = multipliers[multipliers.length - 1];
      const page = m[1] && /\b(?:first|last)\s*:\s*(\d+)/.exec(m[1]);
      if (page) total += above;
      multipliers.push(page ? above * Number(page[1]) : above);
    }
    return Math.max(1, Math.round(total / 100));
  }

  const ended = { hasNextPage: false, endCursor: null };
  const board = (n: number) => ({
    number: n,
    title: `C4. Objective ${n}`,
    url: `p${n}`,
    closed: false,
    items: { totalCount: 1, pageInfo: ended, nodes: [{ content: issue({ number: n, url: `https://github.com/o/r/issues/${n}` }) }] },
  });
  const boards = (count: number) => ({
    organization: { projectsV2: { totalCount: count, pageInfo: ended, nodes: Array.from({ length: count }, (_, i) => board(i + 1)) } },
  });

  /** Every document one rollup read sends. */
  async function documentsFor(payload: unknown): Promise<string[]> {
    const github = asRollupGithub(async () => payload);
    const sent: string[] = [];
    const src = new GithubProjectsSource(config);
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    src.graphql = (query: string, vars: Record<string, unknown>) => { sent.push(query); return github(query, vars); };
    await src.listProjects(OWNER);
    return sent;
  }

  it('prices the document it replaced at the sixty points Github charged for it', () => {
    // The calculator checked against the figure the old document was known to
    // cost, so a calculator that answered 1 for everything cannot pass below.
    const replaced = `query($owner:String!,$after:String){ organization(login:$owner){ projectsV2(first:20, after:$after, query:"is:open"){
      totalCount pageInfo{ hasNextPage endCursor } nodes{ number title url closed items(first:100){ ${ITEMS_CONNECTION_HEAD} ${ROLLUP_ITEM_NODES} } } } } }`;
    expect(points(replaced)).toBe(60);
  });

  it('costs an org with no boards 1 point', async () => {
    expect((await documentsFor(boards(0))).map(points)).toEqual([1]);
  });

  it('costs 1 point for the list and 3 for each board, and no document more than that', async () => {
    const each = (await documentsFor(boards(6))).map(points);
    expect(each).toEqual([1, 3, 3, 3, 3, 3, 3]);
  });

  it('asks for every board`s items at once rather than one board after another', async () => {
    const held: (() => void)[] = [];
    const asked: Record<string, unknown>[] = [];
    const src = new GithubProjectsSource(config);
    // @ts-expect-error — preset the lazily-built GraphQL client with a stub
    src.graphql = (query: string, vars: Record<string, unknown>) => {
      asked.push(vars);
      if (/projectsV2\(/.test(query)) return Promise.resolve(boards(3));
      return new Promise<unknown>((resolve) => {
        held.push(() => resolve({ organization: { projectV2: { items: board(Number(vars.number)).items } } }));
      });
    };
    const reading = src.listProjects(OWNER);
    await new Promise((r) => setTimeout(r, 0));
    // The list, and all three boards' reads out before any of them answered.
    expect(asked.map((v) => v.number ?? 'list')).toEqual(['list', 1, 2, 3]);
    held.forEach((release) => release());
    expect((await reading).map((p) => p.number).sort()).toEqual([1, 2, 3]);
  });

  it('leaves off a board that went away between the list and its items read, and serves the rest', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const src = new GithubProjectsSource(config);
      // @ts-expect-error — preset the lazily-built GraphQL client with a stub
      src.graphql = async (query: string, vars: Record<string, unknown>) =>
        /projectsV2\(/.test(query) ? boards(2) : { organization: { projectV2: vars.number === 1 ? null : { items: board(2).items } } };
      expect((await src.listProjects(OWNER)).map((p) => p.number)).toEqual([2]);
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/#1 .* went away between the board list and its items read/);
    } finally {
      warn.mockRestore();
    }
  });

  it('fails the org`s read when a board`s first page fails, as a failed list read always did', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const src = new GithubProjectsSource(config);
      // @ts-expect-error — preset the lazily-built GraphQL client with a stub
      src.graphql = async (query: string, vars: Record<string, unknown>) => {
        if (/projectsV2\(/.test(query)) return boards(2);
        if (vars.number === 1) throw new Error('502 Bad Gateway');
        return { organization: { projectV2: { items: board(2).items } } };
      };
      await expect(src.listProjects(OWNER)).rejects.toThrow(/502 Bad Gateway/);
    } finally {
      error.mockRestore();
    }
  });
});
