import { IIssueBucketsSource, IssueBucketCounts } from './issue-buckets.types';

/**
 * Local bucket counts (#185) — plausible, stable numbers so the dashboard's
 * Issues block renders without touching GitHub (dev/test, ISSUES_SOURCE=fixture).
 */
export class FixtureIssueBucketsSource implements IIssueBucketsSource {
  counts(): Promise<IssueBucketCounts> {
    return Promise.resolve({ open: 12, bugs: 2, feedback: 1, unassigned: 5 });
  }
}
