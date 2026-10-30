import { describe, expect, it } from 'vitest';
import { REFUSAL_CONTRACT } from './refusal-contract.contract';
import { classifyGithubError, refusalToHttp } from './github-refusal';
import type { RefusalBody } from './github-refusal';

/**
 * One row per reason, end to end: what Github answered, what the board called
 * it, what a client gets. Task 7 asserts the other half of the same rows —
 * `personText` and `canRetry` — in `board-frontend`, against its own copy of the
 * six reason names. The two halves join on those six strings and nothing else,
 * because the two packages do not import each other.
 */
describe('the refusal contract, end to end', () => {
  it.each(REFUSAL_CONTRACT)('$name: Github → reason → status → body', (row) => {
    const r = classifyGithubError(row.err, {
      capability: 'issue.state',
      target: 'acme/board',
    });
    expect(r.reason).toBe(row.reason);
    const http = refusalToHttp(r);
    expect(http.getStatus()).toBe(row.status);
    expect((http.getResponse() as RefusalBody).reason).toBe(row.reason);
  });

  it('the table covers every reason exactly once', () => {
    // Vacuity guard: a table with five rows would pass every row above.
    expect(REFUSAL_CONTRACT.map((r) => r.reason).sort()).toEqual([
      'not-found',
      'not-permitted',
      'not-permitted-yet',
      'try-again',
      'unauthenticated',
      'wrong-value',
    ]);
  });
});
