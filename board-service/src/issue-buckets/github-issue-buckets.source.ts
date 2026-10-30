import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildOctokitClient } from '../sources/github-client';
import {
  BUCKET_KEYS,
  bucketQuery,
  IIssueBucketsSource,
  IssueBucketCounts,
} from './issue-buckets.types';
import { githubOrgs } from '../config/github-orgs';

/**
 * Live bucket counts (#185) via the GitHub Search API. Each query asks for
 * `per_page: 1` and reads only `total_count`, so this is four cheap round-trips
 * (no pagination) — the whole point of using search rather than paging every
 * repo's issue list. All four run concurrently; a failure propagates so a
 * credentials problem surfaces as an error instead of a plausible all-zero block.
 *
 * Still four round-trips on a board serving several orgs (#697): the orgs go
 * into one query as repeated `org:` qualifiers, which Github ORs, so nothing
 * fans out per org. See `bucketScope` for the measurement, and for the ceiling
 * a scope of that shape runs into.
 *
 * One query per bucket makes ERRORS all-or-nothing: there is one answer, so no
 * org can fail while another succeeds. It makes COVERAGE the opposite, and that
 * is the direction that costs something. Search returns only what the token can
 * see, so an `org:` qualifier for an org the token cannot read contributes zero
 * matches — no exception, no 404, no log line — while `bucketLinks` names every
 * configured org in the link beside the number. All four counts then
 * under-report by that org's entire open-issue count, silently, and the list a
 * user clicks through to is short in exactly the same way, so the two agree
 * about something neither of them saw.
 *
 * Nothing here can tell that from a genuinely quiet org. This surface has no
 * equivalent of `OrgReadOutcome` (`issues-metrics/github-issues.source.ts`),
 * which is how the issue ingest keeps "read, and empty" apart from "could not be
 * read": one search total over several `org:` qualifiers carries no per-org
 * breakdown to hang an outcome on, and getting one back means four searches per
 * org — the cost `bucketScope` explains why this surface does not pay.
 */
@Injectable()
export class GithubIssueBucketsSource implements IIssueBucketsSource {
  /** The orgs these counts are ABOUT, in configured order. */
  private get orgs(): string[] { return githubOrgs(this.config); }

  constructor(private readonly config: ConfigService) {
    // A SET, not one org: this surface counts across every owner the caller can
    // read rather than the first of them (#697) — the person's own Github App
    // grants, or GITHUB_ORGS where no person is acting. ISSUE_BUCKETS_ORG used
    // to narrow it and is retired (#1209 part 4). An owner set holding nothing
    // answers no orgs, which `bucketScope` refuses: that is a floor, and it is
    // now reached by a person whose grants cover nothing rather than by a key.
  }

  async counts(): Promise<IssueBucketCounts> {
    // The queries before the client: a scope that has to be refused is refused
    // before a credential is built for searches that must not go out.
    const queries = BUCKET_KEYS.map((key) => bucketQuery(this.orgs, key));
    const octokit = buildOctokitClient(this.config);
    const totals = await Promise.all(
      queries.map((q) =>
        octokit.search
          .issuesAndPullRequests({ q, per_page: 1 })
          .then((r) => r.data.total_count),
      ),
    );
    const out = {} as IssueBucketCounts;
    BUCKET_KEYS.forEach((key, i) => {
      out[key] = totals[i];
    });
    return out;
  }
}
