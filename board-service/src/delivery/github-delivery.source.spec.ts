import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { GithubDeliverySource } from './github-delivery.source';

// Control the GraphQL client the source lazily builds.
const graphql = vi.fn();
vi.mock('../sources/github-client', () => ({ buildOctokitClient: () => ({ graphql }) }));

/** The org every case below reads. It is an ARGUMENT to `load` now, not a
 *  config key the source resolves for itself (#697): `DeliveryService` chooses
 *  which orgs to read and reads each through one call. */
const OWNER = 'acme';

const config = { get: (_k: string, d?: unknown) => d } as unknown as ConfigService;

function payload() {
  return {
    merges: {
      nodes: [
        { number: 2, title: 'later', url: 'u2', mergedAt: '2026-07-24T18:00:00Z', repository: { name: 'a' }, author: { login: 'ivan' } },
        { number: 1, title: 'earlier', url: 'u1', mergedAt: '2026-07-24T09:00:00Z', repository: { name: 'a' }, author: { login: 'octocat' } },
        {}, // a non-PR search node (e.g. an issue) — must be skipped
        { number: 3, title: 'no-merge', url: 'u3', mergedAt: null, repository: { name: 'b' }, author: null }, // unmerged — dropped
      ],
    },
    unassignedPrs: { issueCount: 30 },
    organization: {
      repositories: {
        nodes: [
          { name: 'board', releases: { nodes: [{ tagName: 'v1.48.0', name: null, createdAt: '2026-07-24T18:59:00Z', url: 'r1', isDraft: false }] } },
          { name: 'ui', releases: { nodes: [{ tagName: 'v0.12.0', name: 'ui', createdAt: '2026-07-23T00:00:00Z', url: 'r2', isDraft: false }, { tagName: 'draft', name: null, createdAt: '2026-07-25T00:00:00Z', url: 'r3', isDraft: true }] } },
          { name: 'no-releases', releases: { nodes: [] } },
        ],
      },
    },
  };
}

describe('GithubDeliverySource.load (#173 Phase 2)', () => {
  it('maps merges (PRs only, merged only) newest-first', async () => {
    graphql.mockResolvedValueOnce(payload());
    const out = await new GithubDeliverySource(config).load(OWNER);
    expect(out.merges.map((m) => m.number)).toEqual([2, 1]); // #3 (unmerged) & the non-PR node dropped
    expect(out.merges[0]).toMatchObject({ repo: 'a', author: 'ivan', htmlUrl: 'u2' });
  });

  it('flattens releases across repos, drops drafts, sorts newest-first', async () => {
    graphql.mockResolvedValueOnce(payload());
    const out = await new GithubDeliverySource(config).load(OWNER);
    expect(out.releases.map((r) => r.tag)).toEqual(['v1.48.0', 'v0.12.0']); // draft excluded
    expect(out.releases[0]).toMatchObject({ repo: 'board', htmlUrl: 'r1' });
  });

  it('passes the unassigned-PR count through', async () => {
    graphql.mockResolvedValueOnce(payload());
    const out = await new GithubDeliverySource(config).load(OWNER);
    expect(out.unassignedPrs).toBe(30);
  });

  it('queries the org with the right merged + unassigned search strings', async () => {
    graphql.mockResolvedValueOnce(payload());
    await new GithubDeliverySource(config).load(OWNER);
    const vars = graphql.mock.calls[0][1];
    expect(vars.owner).toBe('acme');
    expect(vars.merged).toContain('is:pr is:merged');
    expect(vars.unassigned).toContain('is:pr is:open no:assignee');
  });

  it('a fetch failure surfaces as an error (never a silent empty feed)', async () => {
    graphql.mockRejectedValueOnce(new Error('bad creds'));
    await expect(new GithubDeliverySource(config).load(OWNER)).rejects.toThrow(/fetch failed/);
  });
});

/**
 * The feed is the eight NEWEST releases in the org, however they fall across
 * repos. `releases(first:2)` became `first:100` so the day series could count
 * the whole span; on a balanced org that left the feed untouched, and on an org
 * one repo dominates it did not. Eight newest is what the feed claims to be —
 * two per repo was an artefact of the old fetch size, not a property worth
 * keeping.
 */
describe('GithubDeliverySource — the feed is the eight newest releases org-wide', () => {
  // The dominant-repo case below drives the mock off the query text, and an
  // implementation set there would otherwise answer for the tests after it.
  afterEach(() => { graphql.mockReset(); });

  /** Four repos, ten releases each, staggered so the global newest eight are
   *  exactly the newest TWO of each — the one arrangement where `first:2` and
   *  `first:100` are forced to agree, whatever the slice does. Plus one repo
   *  whose whole history predates the span. */
  const REPOS = ['a', 'b', 'c', 'd'];
  const rel = (repo: string, j: number, hour: number) => ({
    tagName: `${repo}-v${j}`,
    name: null,
    createdAt: `2026-08-${String(20 - j * 2).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`,
    url: `${repo}/${j}`,
    isDraft: false,
  });
  const wide = (perRepo: number) => ({
    ...payload(),
    organization: {
      repositories: {
        totalCount: 5,
        nodes: [
          ...REPOS.map((name, k) => ({
            name,
            releases: {
              nodes: Array.from({ length: 10 }, (_, j) => rel(name, j, 10 - k)).slice(0, perRepo),
              pageInfo: { hasNextPage: 10 > perRepo },
            },
          })),
          {
            name: 'ancient',
            releases: {
              nodes: Array.from({ length: 10 }, (_, j) => ({ ...rel('ancient', j, 1), createdAt: `2025-01-${String(j + 1).padStart(2, '0')}T00:00:00Z` })).slice(0, perRepo),
              pageInfo: { hasNextPage: 10 > perRepo },
            },
          },
        ],
      },
    },
  });

  it('a balanced org: the same eight rows at first:2 and at first:100', async () => {
    graphql.mockResolvedValueOnce(wide(2));
    const narrow = await new GithubDeliverySource(config).load(OWNER);
    graphql.mockResolvedValueOnce(wide(100));
    const widened = await new GithubDeliverySource(config).load(OWNER);

    expect(narrow.releases).toHaveLength(8); // MAX_RELEASES, unchanged
    expect(widened.releases).toEqual(narrow.releases);
    // …and the widening was not a no-op: the series behind the feed grew.
    expect(widened.releaseDates.length).toBeGreaterThan(narrow.releaseDates.length);
    expect(widened.releaseDates).toHaveLength(50);
  });

  /** A release history as GitHub holds it, newest-first. */
  type Rel = { tagName: string; name: string | null; createdAt: string; url: string; isDraft: boolean };
  type Repo = { name: string; nodes: Rel[] };
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const historyOf = (name: string, daysAgo: number[]): Repo => ({
    name,
    nodes: daysAgo.map((d, j) => ({ tagName: `${name}-v${j}`, name: null, createdAt: at(d), url: `${name}/${j}`, isDraft: false })),
  });

  /** Serves whatever slice of each history the source's OWN query asks for: the
   *  `first:` is read off the query text, and the cursor a page hands out is
   *  honoured by the backfill query. So narrowing `releases(first:100)` narrows
   *  what this fixture returns, the way it narrows what GitHub returns — the
   *  page size is under test here rather than being a parameter of the fixture. */
  const serve = (repos: Repo[]) => {
    const pageOf = (r: Repo, from: number, first: number) => ({
      nodes: r.nodes.slice(from, from + first),
      pageInfo: { hasNextPage: r.nodes.length > from + first, endCursor: `${r.name}@${from + first}` },
    });
    graphql.mockImplementation((q: string, vars: Record<string, unknown>) => {
      const first = Number(/releases\(first:(\d+)/.exec(q)![1]);
      if (vars.cursor == null) {
        return Promise.resolve({
          ...payload(),
          organization: {
            repositories: {
              totalCount: repos.length,
              nodes: repos.map((r) => ({ name: r.name, releases: pageOf(r, 0, first) })),
            },
          },
        });
      }
      const [name, from] = String(vars.cursor).split('@');
      return Promise.resolve({ repository: { releases: pageOf(repos.find((r) => r.name === name)!, Number(from), first) } });
    });
  };

  it('a dominant repo: eight newest org-wide, not two from each of four repos', async () => {
    // board cuts six releases across two days — under the 4.35/day its busiest
    // repo measured on 2026-08-25 — while two quieter repos hold two each. The
    // eight newest are then SIX from one repo and one from each of two others,
    // which is the shape `first:2` cannot serve and the live org's usual one.
    serve([
      historyOf('board', [2, 2.3, 2.6, 3, 3.3, 3.6]),
      historyOf('landing', [10, 20]),
      historyOf('acme', [11, 21]),
    ]);
    const out = await new GithubDeliverySource(config).load(OWNER);

    expect(out.releases.map((r) => r.tag)).toEqual([
      'board-v0', 'board-v1', 'board-v2', 'board-v3', 'board-v4', 'board-v5',
      'landing-v0', 'acme-v0',
    ]);
    // The two rows left out are a choice about the feed, not a gap in the fetch.
    expect(out.releaseDates).toHaveLength(10);
    expect(out.releasesPartial).toBe(false);
    // Measured 2026-08-25: reverting the first pass to `releases(first:2)` does
    // NOT move these rows — the bounded backfill pages `board` back in and the
    // feed comes out identical, so the fetch width is no longer what protects
    // it. What fails here is the OUTCOME changing: capping each repo at two
    // releases before the flatten — the shape `first:2` used to impose — gives
    // six rows, and the balanced case above stays green on its rows while it
    // does. Quote this test for "eight newest org-wide", never for a page size.
  });

  it('collects release dates before the display slice, newest-first', async () => {
    graphql.mockResolvedValueOnce(wide(100));
    const out = await new GithubDeliverySource(config).load(OWNER);
    expect(out.releaseDates.slice(0, 8)).toEqual(out.releases.map((r) => r.atISO));
    const ms = out.releaseDates.map((d) => Date.parse(d));
    expect(ms).toEqual([...ms].sort((x, y) => y - x));
  });

  it('names the org it counted', async () => {
    graphql.mockResolvedValueOnce(payload());
    const out = await new GithubDeliverySource(config).load(OWNER);
    expect(out.releaseScope).toBe('acme');
  });
});

/** A truncated repo looks exactly like a quiet one. It must never draw the same. */
describe('GithubDeliverySource — truncation is reported, not absorbed', () => {
  const org = (totalCount: number, nodes: unknown[]) => ({
    ...payload(),
    organization: { repositories: { totalCount, nodes } },
  });
  const repo = (name: string, oldestISO: string, hasNextPage: boolean) => ({
    name,
    releases: {
      nodes: [
        { tagName: 't1', name: null, createdAt: '2026-08-24T00:00:00Z', url: 'u1', isDraft: false },
        { tagName: 't0', name: null, createdAt: oldestISO, url: 'u0', isDraft: false },
      ],
      pageInfo: { hasNextPage },
    },
  });
  const load = async (p: unknown) => {
    graphql.mockResolvedValueOnce(p);
    return new GithubDeliverySource(config).load(OWNER);
  };
  const inSpan = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const beforeSpan = new Date(Date.now() - 400 * 86_400_000).toISOString();

  it('a whole history that fits is not partial', async () => {
    expect((await load(org(1, [repo('a', inSpan, false)]))).releasesPartial).toBe(false);
  });

  it('a repo with more pages whose oldest is still in the span is partial', async () => {
    expect((await load(org(1, [repo('a', inSpan, true)]))).releasesPartial).toBe(true);
  });

  it('a repo with more pages whose oldest predates the span hides nothing', async () => {
    expect((await load(org(1, [repo('a', beforeSpan, true)]))).releasesPartial).toBe(false);
  });

  it('more repos than the page holds is partial — the tail was never asked about', async () => {
    expect((await load(org(140, [repo('a', beforeSpan, false)]))).releasesPartial).toBe(true);
  });
});

/**
 * A repo whose first page of 100 ends INSIDE the window is not a labelled gap —
 * the missing history is all at the old end, so the series draws a sparse past
 * and a dense present and manufactures an upward trend that nothing did.
 * Measured on the real org (2026-08-25): 90 repos, 544 releases, one repo —
 * board — capped at 100 whose oldest was 23 days into a 98-day
 * window. So this path runs in production every time.
 */
describe('GithubDeliverySource — bounded backfill', () => {
  // Braced on purpose: a concise arrow RETURNS the mock, and Vitest treats a
  // function returned from beforeEach as a per-test cleanup — so it would call
  // graphql() with no arguments after afterEach, leaving one zero-arg entry in
  // mock.calls that the describes above read as calls[0][1].
  beforeEach(() => { graphql.mockReset(); });
  afterEach(() => { graphql.mockReset(); });

  const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  /** One page of 100 releases, `perDay` of them per calendar day, starting
   *  `fromDaysAgo` back and walking older. */
  const page = (repo: string, fromDaysAgo: number, perDay: number, hasNextPage: boolean, cursor: string) => ({
    nodes: Array.from({ length: 100 }, (_, i) => ({
      tagName: `${repo}-${fromDaysAgo}-${i}`,
      name: null,
      createdAt: day(fromDaysAgo + Math.floor(i / perDay)),
      url: `${repo}/${fromDaysAgo}/${i}`,
      isDraft: false,
    })),
    pageInfo: { hasNextPage, endCursor: cursor },
  });

  /** Drives the source over a first-pass payload plus a per-repo page sequence
   *  keyed by the cursor the previous page handed out. */
  function drive(repoName: string, pages: ReturnType<typeof page>[]) {
    graphql.mockImplementation((_q: string, vars: Record<string, unknown>) => {
      if (vars.cursor == null) {
        return Promise.resolve({
          ...payload(),
          organization: {
            repositories: { totalCount: 1, nodes: [{ name: repoName, releases: pages[0] }] },
          },
        });
      }
      const idx = Number(String(vars.cursor).split(':')[1]) + 1;
      return Promise.resolve({ repository: { releases: pages[idx] } });
    });
    return new GithubDeliverySource(config).load(OWNER);
  }

  const backfillCalls = () =>
    graphql.mock.calls.filter((c) => (c[1] as Record<string, unknown>).cursor != null);

  it('pages a repo whose first page ends inside the window, and stops when it leaves it', async () => {
    // 4 releases/day → each page covers 25 days. Page 3 reaches 99 days back,
    // past the 98-day window, so the WINDOW stops the walk after three extra
    // pages — one short of the cap, so this test cannot pass by hitting it.
    const pages = [0, 1, 2, 3].map((k) => page('busy', k * 25, 4, true, `c:${k}`));
    const out = await drive('busy', pages);

    expect(backfillCalls()).toHaveLength(3);
    expect(backfillCalls().every((c) => (c[1] as { name: string }).name === 'busy')).toBe(true);
    // Every page's releases are in the series, not just the first.
    expect(out.releaseDates.length).toBe(400);
    // The window closed before the cap did, so nothing in-span is missing.
    expect(out.releasesPartial).toBe(false);
    // …and the feed above it never moved: eight newest rows, all from page 0.
    expect(out.releases).toHaveLength(8);
    expect(out.releases.every((r) => r.tag.startsWith('busy-0-'))).toBe(true);
  });

  it('never pages a repo whose oldest release already predates the window', async () => {
    // hasNextPage is true, but page 0's oldest is 400 days back: everything
    // beyond it is older still and nothing draws it. Paying for those pages is
    // the whole cost of an unbounded backfill.
    const out = await drive('ancient', [page('ancient', 400, 5, true, 'c:0')]);
    expect(backfillCalls()).toHaveLength(0);
    expect(out.releasesPartial).toBe(false);
  });

  it('stops at the cap, and says so, when the repo is denser than the cap allows', async () => {
    // 20 releases/day → each page covers only 5 days. After 1 + 8 pages the walk
    // is 45 days back with 53 days of the window still unseen; the window would
    // not have closed until page 20. Eleven pages of daylight between the two
    // stops, so this cannot pass by the window closing on its own — which is the
    // property worth pinning here.
    const pages = Array.from({ length: 24 }, (_, k) => page('torrent', k * 5, 20, true, `c:${k}`));
    const out = await drive('torrent', pages);

    expect(backfillCalls()).toHaveLength(8); // the cap, not the window
    expect(out.releasesPartial).toBe(true); // the honest residual
  });

  it('a failed backfill page leaves the fetch standing and the gap declared', async () => {
    graphql.mockImplementation((_q: string, vars: Record<string, unknown>) =>
      vars.cursor == null
        ? Promise.resolve({
            ...payload(),
            organization: {
              repositories: { totalCount: 1, nodes: [{ name: 'busy', releases: page('busy', 0, 5, true, 'c:0') }] },
            },
          })
        : Promise.reject(new Error('secondary rate limit')),
    );
    const out = await new GithubDeliverySource(config).load(OWNER);
    expect(out.releases).toHaveLength(8); // the feed still ships
    expect(out.releasesPartial).toBe(true); // and does not claim the gap is quiet
  });
});
