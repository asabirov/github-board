import { describe, expect, it } from 'vitest';
import {
  BUCKET_KEYS,
  BUCKET_QUERIES,
  SCOPE_MAX,
  SEARCH_QUERY_MAX,
  bucketQuery,
  bucketScope,
} from './issue-buckets.types';

/** `n` org logins of `len` characters each — the shape a real scope has, so the
 *  boundary below is a number of ORGS rather than a number of characters. */
const orgs = (n: number, len: number): string[] =>
  Array.from({ length: n }, (_, i) => String(i).padStart(len, 'o'));

/** The bucket whose fragment leaves the least room for the scope. */
const WIDEST = BUCKET_KEYS.reduce((a, b) =>
  BUCKET_QUERIES[a].length >= BUCKET_QUERIES[b].length ? a : b,
);

describe('bucketScope — the 256-character search ceiling (#697)', () => {
  it('spends the whole budget without overflowing any of the four queries', () => {
    // The derivation, not a copied number: a longer fragment added to
    // BUCKET_QUERIES has to shrink the scope budget, or the widest query runs
    // past the ceiling. 15 x `org:oooooooooo` + 14 spaces = 224 = SCOPE_MAX.
    const atBudget = orgs(15, 10);
    expect(bucketScope(atBudget)).toHaveLength(SCOPE_MAX);
    expect(bucketQuery(atBudget, WIDEST)).toHaveLength(SEARCH_QUERY_MAX);
    for (const key of BUCKET_KEYS) {
      expect(bucketQuery(atBudget, key).length, key).toBeLessThanOrEqual(SEARCH_QUERY_MAX);
    }
  });

  it('refuses the sixteenth ten-character org', () => {
    expect(() => bucketScope(orgs(16, 10))).toThrow(/GITHUB_ORGS/);
  });

  it('accepts five max-length org logins and refuses the sixth', () => {
    // A Github login is at most 39 characters, so five is the worst case a real
    // deployment can reach.
    expect(() => bucketScope(orgs(5, 39))).not.toThrow();
    expect(() => bucketScope(orgs(6, 39))).toThrow(/GITHUB_ORGS/);
  });

  it('refuses before the query is built, rather than sending a 422 per bucket', () => {
    // Every bucket would 422 at once, and `Promise.all` rejects on the first —
    // so the operator sees Github's message about a query they never wrote.
    for (const key of BUCKET_KEYS) {
      expect(() => bucketQuery(orgs(16, 10), key), key).toThrow(/too long to search/i);
    }
  });
});
