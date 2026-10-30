import { ownerQuery, ownerQualifier, PrincipalState } from '../auth/github-principal';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { buildOctokitClient } from '../sources/github-client';
import { logGithubFailure } from '../sources/github-quota';
import {
  MAX_MERGES,
  MAX_RELEASES,
  type DeliveryData,
  type IDeliverySource,
  type MergeItem,
  type ReleaseItem,
} from './delivery.types';
import { dayIndex } from '../time/day-span';

/**
 * Extra release pages fetched per repo, on top of the first pass.
 *
 * **The pages are spent only when the window demands them.** The walk stops the
 * moment a page's oldest release falls outside the span, so this is a ceiling on
 * the pathological case, not a budget the ordinary case draws down. Measured:
 * with the cap set to 20, the live org's shape still fetched 4 — the window
 * stopped it, and the other 16 cost nothing. That is what makes a large number
 * here cheap rather than wasteful, and it is the non-obvious part.
 *
 * The org on 2026-08-25: 90 repos, 544 releases, one repo — board —
 * capped at `first:100` whose oldest returned release was only 23 days into the
 * 98-day span, so ~4.35 releases a day. The span holds ~425 of them: five pages
 * including the first. At four extra that left ONE page of headroom, and an ~18%
 * rise in that repo's rate would have made the cap bind permanently — a tile
 * reading "incomplete" forever, which is a poor thing to ship when the fix is a
 * larger number. Eight extra makes it nine pages, ~900 releases, ~207 days at
 * today's rate: a bit over twice the span.
 *
 * Cost is ~1 point per page, so the worst case is 8 points against an hourly
 * budget of 5000 — and the first pass itself measured 1 point. Not close to a
 * constraint. When the cap DOES bind, the walk stops with `releasesPartial`
 * true, which says the gap is there rather than drawing a confident lie.
 */
const MAX_RELEASE_BACKFILL_PAGES = 8;

/** Minimal shape of the GraphQL payload we read (GitHub returns much more). */
interface GhRelease {
  tagName: string;
  name: string | null;
  createdAt: string;
  url: string;
  isDraft: boolean;
}
interface GhReleasePage {
  nodes: GhRelease[];
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
}
interface GhRepo {
  name: string;
  releases: GhReleasePage;
}
/** The one-repo response the backfill query returns. */
interface GhBackfill {
  repository?: { releases?: GhReleasePage } | null;
}

/** One repo's release nodes as they stand after the first pass and any backfill. */
interface RepoReleases {
  name: string;
  nodes: GhRelease[];
  hasNextPage: boolean;
  endCursor: string | null;
}
interface GhPull {
  number: number;
  title: string;
  url: string;
  mergedAt: string | null;
  repository: { name: string };
  author: { login: string } | null;
}
interface GhData {
  merges?: { nodes: (GhPull | Record<string, never>)[] } | null;
  unassignedPrs?: { issueCount: number } | null;
  organization?: { repositories?: { totalCount?: number; nodes?: GhRepo[] } } | null;
}

// One round-trip: recent merged PRs (org-wide), the unassigned-PR count, and the
// latest releases per repo. `repositories` is capped at 100 (well above the org's
// active count) and ordered by push recency so a truncation drops only the coldest
// repos. `sort:` inside the search string does the ordering server-side.
//
// `releases(first:100)` because the day series below the tiles needs every
// release in the span, not the two the feed shows. 100 is the ceiling, not a
// dial: GitHub's schema caps `first` at 100 on every connection and `first:101`
// is a validation error. There is no date-bounded alternative — `Repository.
// releases` takes only after/before/first/last/orderBy — and the REST route
// would be one call per repo, 100 calls in place of this one. So: over-fetch,
// and REPORT the truncation (`pageInfo`, `totalCount`) rather than absorb it.
const QUERY = `
query($owner:String!,$merged:String!,$unassigned:String!){
  merges: search(query:$merged, type:ISSUE, first:20){
    nodes{ ... on PullRequest {
      number title url mergedAt
      repository{ name }
      author{ login }
    } }
  }
  unassignedPrs: search(query:$unassigned, type:ISSUE, first:0){ issueCount }
  organization(login:$owner){
    repositories(first:100, isFork:false, orderBy:{field:PUSHED_AT, direction:DESC}){
      totalCount
      nodes{
        name
        releases(first:100, orderBy:{field:CREATED_AT, direction:DESC}){
          nodes{ tagName name createdAt url isDraft }
          pageInfo{ hasNextPage endCursor }
        }
      }
    }
  }
}`;

// One repo, one page older than `cursor`. Same ordering as the first pass, so
// the two concatenate into a single newest-first walk backwards through time.
const BACKFILL_QUERY = `
query($owner:String!,$name:String!,$cursor:String!){
  repository(owner:$owner, name:$name){
    releases(first:100, after:$cursor, orderBy:{field:CREATED_AT, direction:DESC}){
      nodes{ tagName name createdAt url isDraft }
      pageInfo{ hasNextPage endCursor }
    }
  }
}`;

const asMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const isPull = (n: GhPull | Record<string, never>): n is GhPull =>
  typeof (n as GhPull).number === 'number';

/**
 * Live delivery source (#173 Phase 2) — one GraphQL query yields one org's
 * recent merged PRs, its count of open PRs with no assignee, and every repo's
 * latest release tags. Releases auto-discover: any repo that cuts tags shows up,
 * no maintained list. Drafts are dropped. A failure surfaces as an error (the
 * section renders nothing AND the cause is logged) rather than a silent empty feed.
 *
 * The org arrives per call, not per instance (#697). It used to be read once in
 * the constructor through `orgFor`, which answered the FIRST org of
 * `GITHUB_ORGS` on every deployment we ran — `DELIVERY_OWNER` carried no default
 * and nobody set it — so a two-org deployment silently served one org's feed as
 * the whole board's. Both that key and `orgFor` are gone (#1209 part 4). This class still knows exactly one org at a time; what
 * changed is who chooses it, and how often.
 */
export class GithubDeliverySource implements IDeliverySource {
  private readonly principalState = new PrincipalState(() => ({
    graphql: null as ReturnType<typeof buildOctokitClient>['graphql'] | null
  }));
  private readonly logger = new Logger(GithubDeliverySource.name);
  private get graphql(): ReturnType<typeof buildOctokitClient>['graphql'] | null { return this.principalState.current.graphql; }
  private set graphql(value: ReturnType<typeof buildOctokitClient>['graphql'] | null) { this.principalState.current.graphql = value; }

  constructor(private readonly config: ConfigService) {}

  private gql() {
    if (!this.graphql) this.graphql = buildOctokitClient(this.config).graphql;
    return this.graphql;
  }

  /**
   * Is this repo hiding releases we would DRAW? True only when GitHub says there
   * is another page AND the oldest release we hold is still inside the span —
   * older pages may then hold in-span releases too. A repo whose oldest returned
   * release already predates the span hides nothing: everything beyond it is
   * older still, and paying for those pages is the whole cost of an unbounded
   * backfill.
   *
   * `now` is fetch time, not read time: unlike the day series, this is a fact
   * about the fetch. A boundary release can flip it a day late.
   */
  private truncatedInWindow(r: RepoReleases, now: number): boolean {
    return r.hasNextPage && dayIndex(r.nodes.at(-1)?.createdAt, now) != null;
  }

  /**
   * Walk each truncated repo backwards until it leaves the span or hits the cap.
   *
   * Without this the gap is not a labelled hole, it is a LIE with a direction:
   * the missing history is all at the old end, so a capped repo draws a sparse
   * June and a dense August and manufactures an upward trend that nothing did.
   * A `partial` flag on a chart that is confidently wrong one way is not enough.
   *
   * Sequential on purpose. The cursor chain within a repo forces it, and across
   * repos it keeps the burst small — one repo needs this today, and a fan-out
   * would trade a handful of points for a secondary-rate-limit risk that buys
   * nothing.
   *
   * A page that fails is logged and abandoned, leaving `hasNextPage` true so the
   * repo still reads as truncated. The feed ships either way.
   */
  private async backfill(repos: RepoReleases[], now: number, owner: string): Promise<void> {
    for (const r of repos) {
      for (let p = 0; p < MAX_RELEASE_BACKFILL_PAGES; p++) {
        if (!this.truncatedInWindow(r, now) || !r.endCursor) break;
        try {
          const next = await this.gql()<GhBackfill>(BACKFILL_QUERY, {
            owner,
            name: r.name,
            cursor: r.endCursor,
          });
          const rel = next.repository?.releases;
          if (!rel) break; // malformed — stays truncated rather than reads complete
          r.nodes = r.nodes.concat(rel.nodes ?? []);
          r.hasNextPage = rel.pageInfo?.hasNextPage ?? false;
          r.endCursor = rel.pageInfo?.endCursor ?? null;
        } catch (err) {
          this.logger.warn(
            `delivery: release backfill for ${owner}/${r.name} stopped at page ${p + 1}: ${asMsg(err)}`,
          );
          break;
        }
      }
    }
  }

  async load(owner: string): Promise<DeliveryData> {
    let data: GhData;
    try {
      data = await this.gql()<GhData>(ownerQuery(QUERY, owner), {
        owner,
        merged: `${ownerQualifier(owner)} is:pr is:merged sort:updated-desc`,
        unassigned: `${ownerQualifier(owner)} is:pr is:open no:assignee`,
      });
    } catch (err) {
      // A quota refusal is a warning that says when, not a boot alert (#986).
      const retryAt = logGithubFailure(this.logger, err, `delivery fetch failed for ${owner}: ${asMsg(err)}`, `delivery fetch for ${owner} deferred`);
      if (retryAt !== undefined) {
        throw new Error(`delivery: Github quota for ${owner} is cooling down until ${new Date(retryAt).toISOString()}`, { cause: err });
      }
      throw new Error(`delivery: fetch failed for ${owner} — check GitHub credentials / access`);
    }

    const merges: MergeItem[] = (data.merges?.nodes ?? [])
      .filter(isPull)
      .filter((p) => p.mergedAt)
      .map((p) => ({
        repo: p.repository.name,
        number: p.number,
        title: p.title,
        htmlUrl: p.url,
        author: p.author?.login ?? null,
        atISO: p.mergedAt as string,
      }))
      .sort((a, b) => Date.parse(b.atISO) - Date.parse(a.atISO))
      .slice(0, MAX_MERGES);

    const now = Date.now();
    const repoPage = data.organization?.repositories;
    const repos: RepoReleases[] = (repoPage?.nodes ?? []).map((r) => ({
      name: r.name,
      nodes: r.releases?.nodes ?? [],
      hasNextPage: r.releases?.pageInfo?.hasNextPage ?? false,
      endCursor: r.releases?.pageInfo?.endCursor ?? null,
    }));
    await this.backfill(repos, now, owner);

    const all: ReleaseItem[] = repos
      .flatMap((r) =>
        r.nodes
          .filter((rel) => !rel.isDraft)
          .map((rel) => ({
            repo: r.name,
            tag: rel.tagName,
            name: rel.name || null,
            htmlUrl: rel.url,
            atISO: rel.createdAt,
          })),
      )
      .sort((a, b) => Date.parse(b.atISO) - Date.parse(a.atISO));

    // The whole fetched set, taken BEFORE the display slice: the day series
    // counts every release in the span, the feed shows eight rows. Bucketing
    // happens per request in `toDeliveryView`, so what travels is raw ISO.
    const releaseDates = all.map((r) => r.atISO);
    const releases = all.slice(0, MAX_RELEASES);

    const unassignedPrs = data.unassignedPrs?.issueCount ?? 0;
    // Two ways to still be blind after the backfill: an org with more repos than
    // one page holds, whose tail was never asked about, and a repo the cap
    // stopped before the window did.
    const releasesPartial =
      (repoPage?.totalCount ?? 0) > repos.length ||
      repos.some((r) => this.truncatedInWindow(r, now));
    this.logger.log(
      `Delivery ${owner}: ${releases.length} releases, ${merges.length} merges, ${unassignedPrs} unassigned PRs` +
        `, ${releaseDates.length} release dates${releasesPartial ? ' (PARTIAL)' : ''}`,
    );
    // One org's read names one org. The union names every org that answered,
    // and that join is `mergeDelivery`'s — a source that failed produces no
    // scope at all, which is exactly how a failed org drops out of the name.
    return { releases, merges, unassignedPrs, releaseDates, releasesPartial, releaseScope: owner };
  }
}
