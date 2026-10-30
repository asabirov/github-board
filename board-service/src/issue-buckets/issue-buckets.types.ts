import { ownerQualifier } from '../auth/github-principal';
/**
 * Dashboard "Issues" block (#185). Four live-ish counts over every org this
 * board serves (#697) + the GitHub search deep-link that produces each — so the
 * number a user reads and the list they click can never drift apart. Distinct
 * from issues-metrics (#120), which pages the *tracked* repos for flow
 * analysis; these are cheap search totals meant to be trustworthy the moment
 * you glance at them.
 */
export const ISSUE_BUCKETS_SOURCE = Symbol('ISSUE_BUCKETS_SOURCE');

/** The four buckets shown on the dashboard, each an open-issue count. */
export interface IssueBucketCounts {
  /** All open issues, across every org in scope. */
  open: number;
  /** Open issues labelled `bug`. */
  bugs: number;
  /** Open issues labelled `feedback`. */
  feedback: number;
  /** Open issues with no assignee. */
  unassigned: number;
}

export type BucketKey = keyof IssueBucketCounts;

export interface IssueBuckets extends IssueBucketCounts {
  /** ISO time the counts were fetched from GitHub — drives the "Synced" stamp. */
  syncedAt: string;
  /** GitHub search URL matching each bucket's exact query (count ↔ link agree). */
  links: Record<BucketKey, string>;
}

/** A source of live bucket counts (GitHub search, or a local fixture). */
export interface IIssueBucketsSource {
  counts(): Promise<IssueBucketCounts>;
}

/** The open-issue search fragment per bucket (org: scope added by `bucketQuery`). */
export const BUCKET_QUERIES: Record<BucketKey, string> = {
  open: 'is:issue is:open',
  bugs: 'is:issue is:open label:bug',
  feedback: 'is:issue is:open label:feedback',
  unassigned: 'is:issue is:open no:assignee',
};

export const BUCKET_KEYS = Object.keys(BUCKET_QUERIES) as BucketKey[];

/**
 * Github's documented ceiling on a search query: 256 characters. Over it the
 * Search API answers 422 "Validation Failed", which here would be all four
 * buckets failing at once.
 *
 * It is a ceiling and not a prediction. Github's own counter does not agree
 * with `String.length` — a 208-character query has been rejected as too long
 * (community discussion 186957) — so a query UNDER this may still 422. Which is
 * why the refusal below fires only above it: refusing a scope Github would have
 * accepted would break a deployment that works today, and that is the one
 * direction a guard added late must not move in.
 */
export const SEARCH_QUERY_MAX = 256;

/**
 * How many characters the `org:` scope may spend, so the widest bucket fragment
 * still fits under `SEARCH_QUERY_MAX` with its separating space.
 *
 * DERIVED from `BUCKET_QUERIES` rather than written down: a fifth bucket with a
 * longer fragment shrinks this automatically, and `issue-buckets.types.spec.ts`
 * checks the arithmetic rather than trusting the comment. Today that is
 * 256 − 31 (`is:issue is:open label:feedback`) − 1 = 224, which is fifteen
 * ten-character org logins or five of Github's 39-character maximum.
 */
export const SCOPE_MAX =
  SEARCH_QUERY_MAX - Math.max(...Object.values(BUCKET_QUERIES).map((q) => q.length)) - 1;

/**
 * The `org:` qualifiers scoping a bucket search — one per org, space-separated.
 *
 * Github ORs repeated `org:` qualifiers, so a board serving several orgs still
 * costs four searches rather than four per org (#697). Measured against the live
 * Search API on 2026-08-27: `org:rails` 1392, `org:django` 660, the two together
 * 2052. That matters here because search is limited to thirty requests a minute.
 *
 * An empty scope is REFUSED, not dropped: the same query without its qualifier
 * counts every open issue on Github — 55,413,720 on 2026-08-27 — which is the
 * widening direction and would render as a plausible dashboard number. Before
 * #697 that configuration sent a bare `org:` and Github answered 422, so the
 * block failed then too; it now fails naming the key instead.
 *
 * Refusing here is a floor, not an operator control. No setting narrows this
 * block any more — `ISSUE_BUCKETS_ORG` did and is retired (#1209 part 4) — and
 * nothing offers to switch it off. What reaches here is a PERSON whose Github
 * App grants cover no owner, and what Joi never sees: a `ConfigService` built
 * straight from an object, which is every spec in this tree.
 *
 * An OVER-LONG scope is refused the same way, and for the same reason: one
 * query per bucket means every bucket 422s together, `Promise.all` rejects on
 * the first, and `IssueBucketsService` has nothing retired to fall back on, so
 * the dashboard's whole Issues block 500s on a message about a query the
 * operator never wrote. Refusing here names the key and the count instead.
 * Truncating the list is not an option: it would under-report every bucket by a
 * whole org's issues, which is the failure `bucketQuery`'s one-derivation rule
 * exists to prevent.
 */
export function bucketScope(orgs: string[]): string {
  if (orgs.length === 0) {
    throw new Error(
      'issue buckets: no org to count — the owner scope resolved to no org at all. Connect ' +
        'Github, or set GITHUB_ORGS to the org login(s) this board serves.',
    );
  }
  const scope = orgs.map(ownerQualifier).join(' ');
  if (scope.length > SCOPE_MAX) {
    throw new Error(
      `issue buckets: ${orgs.length} orgs are too long to search in one query — their org: ` +
        `qualifiers run to ${scope.length} characters and Github allows ${SCOPE_MAX} here, ` +
        `so all four bucket searches would fail validation together. Shorten GITHUB_ORGS, or ` +
        'narrow which organisations this board is installed in.',
    );
  }
  return scope;
}

/**
 * The whole search query behind one bucket, over `orgs`.
 *
 * THE one derivation: the source counts with it and `bucketLinks` links to it,
 * so the number a user reads and the list they click cannot drift apart by
 * construction rather than by two expressions that happen to agree.
 */
export function bucketQuery(orgs: string[], key: BucketKey): string {
  return `${bucketScope(orgs)} ${BUCKET_QUERIES[key]}`;
}

/** GitHub search deep-links for every bucket, scoped to `orgs`. */
export function bucketLinks(orgs: string[]): Record<BucketKey, string> {
  const url = (key: BucketKey) =>
    `https://github.com/search?q=${encodeURIComponent(bucketQuery(orgs, key))}&type=issues`;
  return {
    open: url('open'),
    bugs: url('bugs'),
    feedback: url('feedback'),
    unassigned: url('unassigned'),
  };
}
