import type { DeliveryData, IDeliverySource } from './delivery.types';

/**
 * Local delivery fixture (#173 Phase 2) — a small, representative feed so the
 * dashboard renders fully offline (DELIVERY_SOURCE=fixture) without a GitHub
 * token. Times are fixed ISO strings; the client renders them relative.
 *
 * Fixed dates mean the releases-per-day series drifts out of the 98-day span as
 * real time passes — the fixture shows a shrinking tail, then nothing. That is
 * the same trade every other fixed-date field here already makes.
 */
/** The org the fixture pretends to have read from — the org its repo names and
 *  every `htmlUrl` in it already belong to. One constant rather than a literal
 *  per row, so the owner and the links cannot drift apart. */
const FIXTURE_OWNER = 'acme';

/** Nothing read, for an org the fixture has no data for. Not an error: the org
 *  IS readable here, it simply holds nothing — which is the one case a fixture
 *  can honestly represent for a second org. */
const NOTHING = (org: string): DeliveryData => ({
  releases: [],
  merges: [],
  unassignedPrs: 0,
  releaseDates: [],
  releasesPartial: false,
  releaseScope: org,
});

export class FixtureDeliverySource implements IDeliverySource {
  load(org: string): Promise<DeliveryData> {
    // A multi-org fixture deployment sees this feed under `acme` and an
    // empty one under the rest, rather than the same four releases once per org
    // — duplicated rows would read as a bug in the union, which is the thing
    // running on fixtures is meant to let you see.
    if (org !== FIXTURE_OWNER) return Promise.resolve(NOTHING(org));
    return Promise.resolve({
      releases: [
        { repo: 'board', tag: 'v1.48.0', name: null, htmlUrl: 'https://github.com/acme/board/releases/tag/v1.48.0', atISO: '2026-07-24T18:59:05Z' },
        { repo: 'acme-ui', tag: 'v0.12.0', name: null, htmlUrl: 'https://github.com/acme/acme-ui/releases/tag/v0.12.0', atISO: '2026-07-23T18:11:11Z' },
        { repo: 'create-acme-app', tag: 'create-acme-app@0.2.1', name: null, htmlUrl: 'https://github.com/acme/create-acme-app/releases', atISO: '2026-07-21T16:41:39Z' },
        { repo: 'acme-landing', tag: '0.3.0', name: 'Pricing page live + legal, blog, waitlist', htmlUrl: 'https://github.com/acme/acme-landing/releases/tag/0.3.0', atISO: '2026-07-13T13:40:02Z' },
      ],
      merges: [
        { repo: 'market-radar', number: 117, title: 'Step 2 — categories in data', htmlUrl: 'https://github.com/acme/market-radar/pull/117', author: 'octocat', atISO: '2026-07-24T18:59:00Z' },
        { repo: 'market-radar', number: 116, title: 'Dashboard reviews: split positives vs negatives', htmlUrl: 'https://github.com/acme/market-radar/pull/116', author: 'octocat', atISO: '2026-07-24T18:45:00Z' },
        { repo: 'acme-dev-console', number: 259, title: 'feat(portal): standalone-NEG exposure toggle', htmlUrl: 'https://github.com/acme/acme-dev-console/pull/259', author: 'hubot', atISO: '2026-07-24T18:09:00Z' },
        { repo: 'acme-platform-billing', number: 29, title: 'feat(billing-console): v1 read-only console dashboard', htmlUrl: 'https://github.com/acme/acme-platform-billing/pull/29', author: 'hubot', atISO: '2026-07-24T16:23:00Z' },
        { repo: 'acme-landing', number: 231, title: 'Landing follow-ups: gradient bleed, cover priority', htmlUrl: 'https://github.com/acme/acme-landing/pull/231', author: 'monalisa', atISO: '2026-07-24T15:00:00Z' },
      ],
      unassignedPrs: 30,
      // The whole fetched set, not the four rows above — the day series counts
      // every release in the span while the feed shows a slice. The four feed
      // times are in here too, so the two never disagree.
      releaseDates: [
        '2026-07-24T18:59:05Z',
        '2026-07-23T18:11:11Z',
        '2026-07-23T09:02:00Z',
        '2026-07-21T16:41:39Z',
        '2026-07-13T13:40:02Z',
        '2026-07-13T08:15:00Z',
        '2026-07-02T11:20:00Z',
        '2026-06-28T15:05:00Z',
        '2026-06-28T10:00:00Z',
        '2026-06-28T09:30:00Z',
        '2026-06-11T12:00:00Z',
        '2026-05-29T17:45:00Z',
      ],
      releasesPartial: false,
      releaseScope: FIXTURE_OWNER,
    });
  }
}
