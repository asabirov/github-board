import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { GithubIssueBucketsSource } from './github-issue-buckets.source';
import { BUCKET_KEYS, BUCKET_QUERIES, BucketKey, bucketLinks } from './issue-buckets.types';

// The source builds its Octokit lazily; hand it a fake search that records every
// `q` it is asked. `vi.hoisted` so the spy exists before the mock factory runs.
const { search } = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('../sources/github-client', () => ({
  buildOctokitClient: () => ({ search: { issuesAndPullRequests: search } }),
}));

/** A ConfigService where ABSENT and PRESENT-BUT-EMPTY are different states —
 *  the distinction `orgsFor` turns on, so a stub that blurred it would test
 *  something else. */
function cfg(values: Record<string, unknown> = {}): ConfigService {
  // `GITHUB_ORGS` is pinned at the org this file's queries are written against.
  // Since #1175 there is no default to be left to: #1166 put the key behind one
  // constant, the organisation was renamed out from under it, and the constant
  // came off. A case that means a different list passes its own.
  const pinned: Record<string, unknown> = { GITHUB_ORGS: 'acme', ...values };
  return {
    get: (k: string, d?: unknown) => (k in pinned ? pinned[k] : d),
  } as unknown as ConfigService;
}

/** Distinct per bucket, so a count landing under the wrong key is visible. */
const TOTALS: Record<BucketKey, number> = { open: 223, bugs: 19, feedback: 3, unassigned: 62 };

/** Answer each search from its own fragment, never from call order. */
function answerByFragment() {
  search.mockImplementation(({ q }: { q: string }) =>
    Promise.resolve({
      data: {
        total_count: q.includes('label:bug')
          ? TOTALS.bugs
          : q.includes('label:feedback')
            ? TOTALS.feedback
            : q.includes('no:assignee')
              ? TOTALS.unassigned
              : TOTALS.open,
      },
    }),
  );
}

/** The `q` of every search made, in the order they went out. */
const sent = (): string[] => search.mock.calls.map((c) => (c[0] as { q: string }).q);

/** The `q` a deep-link opens — what the user sees after clicking the count. */
const linkQuery = (url: string): string =>
  decodeURIComponent(new URL(url).searchParams.get('q') ?? '');

describe('GithubIssueBucketsSource — the orgs a count covers (#697)', () => {
  beforeEach(() => {
    search.mockReset();
    answerByFragment();
  });

  it('counts EVERY org in GITHUB_ORGS', async () => {
    const source = new GithubIssueBucketsSource(cfg({ GITHUB_ORGS: 'org-alpha,org-beta' }));

    const counts = await source.counts();

    // One query per bucket still — Github ORs repeated `org:` qualifiers, so two
    // orgs cost the same four searches one org did.
    expect(sent()).toEqual(
      BUCKET_KEYS.map((key) => `org:org-alpha org:org-beta ${BUCKET_QUERIES[key]}`),
    );
    expect(counts).toEqual(TOTALS);
  });

  it('the query a count came from is the query its link opens', async () => {
    // The constraint: the number a user reads and the list they click cannot
    // drift apart. Both sides are compared as strings, over the same orgs.
    const orgs = ['org-alpha', 'org-beta'];
    const source = new GithubIssueBucketsSource(cfg({ GITHUB_ORGS: orgs.join(',') }));

    await source.counts();

    const links = bucketLinks(orgs);
    expect(BUCKET_KEYS.map((key) => linkQuery(links[key]))).toEqual(sent());
  });

  it('a single-org deployment sends exactly the query it sends today', async () => {
    // The whole of "one org behaves as before", asserted on the byte-for-byte
    // query strings.
    const source = new GithubIssueBucketsSource(cfg());

    await source.counts();

    expect(sent()).toEqual([
      'org:acme is:issue is:open',
      'org:acme is:issue is:open label:bug',
      'org:acme is:issue is:open label:feedback',
      'org:acme is:issue is:open no:assignee',
    ]);
  });

  it('refuses an empty scope rather than searching every org on Github', async () => {
    // A scope that resolved to no orgs. `ISSUE_BUCKETS_ORG` used to produce one
    // and is retired (#1209 part 4); what reaches here now is a PERSON whose
    // Github App grants cover no owner, and — as in this case — a
    // `ConfigService` a spec built from a plain object the schema never sees.
    // Dropping the qualifier would count all of Github — 55,413,720 open issues
    // on 2026-08-27 — so the scope is refused instead.
    const source = new GithubIssueBucketsSource(cfg({ GITHUB_ORGS: '   ' }));

    await expect(source.counts()).rejects.toThrow(/GITHUB_ORGS/);
    expect(search).not.toHaveBeenCalled();
  });

  it('refuses a scope past the 256-character search ceiling before any search goes out', async () => {
    // Sixteen ten-character logins put the org: qualifiers at 239 characters,
    // past the 224 `SCOPE_MAX` leaves. Unguarded, all four searches go out and
    // all four 422 together, `Promise.all` rejects on whichever lands first, and
    // the dashboard's Issues block 500s on Github's message rather than on one
    // that names the key an operator can change.
    const orgs = Array.from({ length: 16 }, (_, i) => String(i).padStart(10, 'o'));
    const source = new GithubIssueBucketsSource(cfg({ GITHUB_ORGS: orgs.join(',') }));

    await expect(source.counts()).rejects.toThrow(/too long to search/i);
    await expect(source.counts()).rejects.toThrow(/GITHUB_ORGS/);
    expect(search).not.toHaveBeenCalled();
  });
});
