import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { GithubDeliverySource } from './github-delivery.source';
import { DeliveryService } from './delivery.service';
import { DeliveryController } from './delivery.controller';
import type { DeliveryView } from './delivery.types';

/**
 * `/api/delivery` over a deployment that names TWO orgs (#697).
 *
 * Driven from the controller down through the real service and the real Github
 * source, with only the GraphQL client mocked — the union, the tolerance and the
 * per-org caching are one behaviour and a test of any one of them alone would
 * pass on a build where the other two are broken.
 *
 * Every check here is invisible on a deployment whose `GITHUB_ORGS` names ONE
 * org, which is what this board is run as: "the first org" and "every org" are
 * the same answer there, so a green suite against it proves nothing about
 * either.
 */

const graphql = vi.fn();
vi.mock('../sources/github-client', () => ({ buildOctokitClient: () => ({ graphql }) }));

const ALPHA = 'org-alpha';
const BETA = 'org-beta';

/** `n` days back, inside `DAY_SPAN`, as GitHub would write it. */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * A config naming the owner scope and nothing else. `DELIVERY_OWNER` used to
 * narrow it and is retired (#1209 part 4), so `GITHUB_ORGS` is the whole answer
 * on the no-person path these tests run.
 */
function config(orgs: string): ConfigService {
  return {
    get: (k: string, d?: unknown) => {
      if (k === 'GITHUB_ORGS') return orgs;
      if (k === 'DELIVERY_CACHE_TTL_MS') return 10_000;
      return d;
    },
  } as unknown as ConfigService;
}

/** One org's GraphQL answer: two releases, one merge, its own unassigned count. */
function payload(
  org: string,
  { releaseAges, mergeAge, unassigned, truncated = false }:
    { releaseAges: number[]; mergeAge: number; unassigned: number; truncated?: boolean },
) {
  return {
    merges: {
      nodes: [
        {
          number: org === ALPHA ? 11 : 99,
          title: `${org} merge`,
          url: `https://x/${org}/pr`,
          mergedAt: daysAgo(mergeAge),
          repository: { name: `${org}-web` },
          author: { login: 'octocat' },
        },
      ],
    },
    unassignedPrs: { issueCount: unassigned },
    organization: {
      repositories: {
        totalCount: 1,
        nodes: [
          {
            name: `${org}-web`,
            releases: {
              nodes: releaseAges.map((age, i) => ({
                tagName: `${org}-v${i + 1}`,
                name: null,
                createdAt: daysAgo(age),
                url: `https://x/${org}/rel/${i + 1}`,
                isDraft: false,
              })),
              // `endCursor: null` leaves the repo reading truncated without
              // spending a backfill page — the walk needs a cursor to follow.
              pageInfo: { hasNextPage: truncated, endCursor: null },
            },
          },
        ],
      },
    },
  };
}

/** Alpha's releases at 1 and 5 days back, beta's at 3 and 7 — so a feed that
 *  merely concatenates the two orgs reads in a different order from one that
 *  interleaves them by time. */
const ALPHA_PAYLOAD = { releaseAges: [1, 5], mergeAge: 2, unassigned: 30 };
const BETA_PAYLOAD = { releaseAges: [3, 7], mergeAge: 6, unassigned: 7 };

/** Answer whichever org the query names; anything else is a fetch nobody asked
 *  for and fails loudly rather than returning a plausible empty org. */
function answerBoth(overrides: Partial<Record<string, () => unknown>> = {}) {
  graphql.mockImplementation(async (_q: string, vars: { owner: string }) => {
    const override = overrides[vars.owner];
    if (override) return override();
    if (vars.owner === ALPHA) return payload(ALPHA, ALPHA_PAYLOAD);
    if (vars.owner === BETA) return payload(BETA, BETA_PAYLOAD);
    throw new Error(`unexpected owner ${JSON.stringify(vars.owner)}`);
  });
}

/** The controller, over the real service and the real Github source. */
function board(orgs = `${ALPHA},${BETA}`): { get: () => Promise<DeliveryView> } {
  const cfg = config(orgs);
  const svc = new DeliveryService(new GithubDeliverySource(cfg), cfg);
  return new DeliveryController(svc);
}

const owners = () => graphql.mock.calls.map((c) => (c[1] as { owner: string }).owner);

beforeEach(() => {
  graphql.mockReset();
});

describe('/api/delivery over two orgs (#697)', () => {
  it('reads BOTH orgs when GITHUB_ORGS names two', async () => {
    answerBoth();
    await board().get();
    expect(owners().sort()).toEqual([ALPHA, BETA]);
  });

  it('interleaves both orgs releases and merges by time', async () => {
    answerBoth();
    const view = await board().get();
    expect(view.releases.map((r) => r.tag)).toEqual([
      `${ALPHA}-v1`, // 1 day ago
      `${BETA}-v1`, // 3
      `${ALPHA}-v2`, // 5
      `${BETA}-v2`, // 7
    ]);
    expect(view.merges.map((m) => m.number)).toEqual([11, 99]); // 2 days ago, then 6
  });

  it('counts the unassigned PRs of both orgs', async () => {
    answerBoth();
    const view = await board().get();
    expect(view.unassignedPrs).toBe(37); // 30 + 7
  });

  it('covers both orgs in releaseDays', async () => {
    answerBoth();
    const view = await board().get();
    expect(view.releaseDays.reduce((a, b) => a + b, 0)).toBe(4);
  });

  it('names every org the count covers in releaseScope', async () => {
    answerBoth();
    const view = await board().get();
    expect(view.releaseScope).toContain(ALPHA);
    expect(view.releaseScope).toContain(BETA);
  });

  it('is partial when ANY org read was partial', async () => {
    graphql.mockImplementation(async (_q: string, vars: { owner: string }) =>
      vars.owner === ALPHA
        ? payload(ALPHA, ALPHA_PAYLOAD)
        : payload(BETA, { ...BETA_PAYLOAD, truncated: true }),
    );
    const view = await board().get();
    expect(view.releasesPartial).toBe(true);
  });

  it('reads the orgs concurrently, not one after the other', async () => {
    let started = 0;
    let open: () => void = () => {};
    const bothStarted = new Promise<void>((res) => {
      open = res;
    });
    graphql.mockImplementation(async (_q: string, vars: { owner: string }) => {
      if (++started === 2) open();
      await bothStarted; // a sequential fan-out never reaches the second call
      return vars.owner === ALPHA ? payload(ALPHA, ALPHA_PAYLOAD) : payload(BETA, BETA_PAYLOAD);
    });
    const sequential = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('the orgs were read one after the other')), 500),
    );
    await expect(Promise.race([board().get(), sequential])).resolves.toBeTruthy();
  });
});

describe('/api/delivery — one org failing does not blank the others (#697)', () => {
  it("serves the readable org's releases, merges and count", async () => {
    answerBoth({
      [BETA]: () => {
        throw new Error('bad creds');
      },
    });
    const view = await board().get();
    expect(view.releases.map((r) => r.tag)).toEqual([`${ALPHA}-v1`, `${ALPHA}-v2`]);
    expect(view.merges.map((m) => m.number)).toEqual([11]);
    expect(view.unassignedPrs).toBe(30);
  });

  it('names only the org the count actually covers', async () => {
    answerBoth({
      [BETA]: () => {
        throw new Error('bad creds');
      },
    });
    const view = await board().get();
    expect(view.releaseScope).toBe(ALPHA);
  });

  it("serves the readable org when the FIRST org fails, not only the last", async () => {
    // The direction the other two cases here never take. An implementation that
    // treats the head of the list as the org the answer is anchored on — the
    // shape `Promise.all` had, and the shape a `const [first, ...rest]` refactor
    // would bring back — passes every last-org-fails test in this file.
    answerBoth({
      [ALPHA]: () => {
        throw new Error('bad creds');
      },
    });
    const view = await board().get();
    expect(view.releases.map((r) => r.tag)).toEqual([`${BETA}-v1`, `${BETA}-v2`]);
    expect(view.merges.map((m) => m.number)).toEqual([99]);
    expect(view.unassignedPrs).toBe(7);
    expect(view.releaseScope).toBe(BETA);
  });

  it('still fails the read when EVERY org fails, as it does today', async () => {
    graphql.mockRejectedValue(new Error('bad creds'));
    await expect(board().get()).rejects.toThrow(/fetch failed/);
  });
});

/**
 * What `updatedAt` claims about a union (#697). Each org refreshes on its own
 * clock, so the payload is only as fresh as its stalest part — stamping the
 * newest would let one org's refresh vouch for another org's stale entry, and
 * the "Synced" line on the dashboard would say so.
 */
describe('/api/delivery — the union is as fresh as its OLDEST org (#697)', () => {
  const T0 = Date.parse('2026-08-27T09:00:00Z');
  let clock = T0;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clock = T0;
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => nowSpy.mockRestore());

  it("stamps the older entry's fetch time, not the org that refreshed last", async () => {
    // Alpha is fetched at T0 while beta is unreadable; twenty seconds later —
    // past the 10s TTL — alpha is served stale from T0 and beta is fetched
    // fresh. The union carries both, so it can only claim T0.
    const beta = { fails: true };
    answerBoth({
      [BETA]: () => {
        if (beta.fails) throw new Error('bad creds');
        return payload(BETA, BETA_PAYLOAD);
      },
    });
    const api = board();

    const first = await api.get();
    expect(first.updatedAt).toBe(new Date(T0).toISOString());

    clock = T0 + 20_000;
    beta.fails = false;
    const second = await api.get();

    // Beta really is in this answer — otherwise T0 would be the only time there
    // was and the assertion below could not fail.
    expect(second.releaseScope).toBe(`${ALPHA} and ${BETA}`);
    expect(second.updatedAt).toBe(new Date(T0).toISOString());
  });
});

describe('/api/delivery — one org, and a pin, behave exactly as before (#697)', () => {
  it('a single-org deployment issues one query, against that org', async () => {
    graphql.mockResolvedValue(payload(ALPHA, ALPHA_PAYLOAD));
    const view = await board(ALPHA).get();
    expect(owners()).toEqual([ALPHA]);
    expect(view.releaseScope).toBe(ALPHA);
    expect(view.unassignedPrs).toBe(30);
  });

  it('an owner scope naming no org answers none, rather than every org', async () => {
    // `DELIVERY_OWNER=''` used to produce this and is retired (#1209 part 4).
    // What reaches it now is a person whose Github App grants cover no owner,
    // and a `ConfigService` a spec built without a usable `GITHUB_ORGS`.
    answerBoth();
    await expect(board('   ').get()).rejects.toThrow(/GITHUB_ORGS/);
    expect(owners()).toEqual([]);
  });
});
