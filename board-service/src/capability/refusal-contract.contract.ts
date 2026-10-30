import { gh } from './capability-testing.contract';
import type { RefusalReason } from './github-refusal';

/**
 * The refusal contract, one row per reason (#584).
 *
 * It lives in a `*.contract.ts` file rather than in a spec because both halves
 * read it: this package asserts the reason, the status and the body, and
 * `board-frontend` asserts what a person reads and whether Retry is offered.
 * `tsconfig.build.json:12` excludes the pattern, so it compiles under the
 * typecheck CI runs and never reaches `dist`.
 */
export interface ContractRow {
  name: string;
  /** What Github answered, in the shape Octokit really throws. */
  err: unknown;
  reason: RefusalReason;
  status: number;
  /** What the person reads. The frontend spec asserts the same six strings. */
  personText: string;
  canRetry: boolean;
}

export const REFUSAL_CONTRACT: ContractRow[] = [
  {
    name: 'bare 403',
    err: gh(403),
    reason: 'not-permitted',
    status: 403,
    personText: 'The board isn’t allowed',
    canRetry: false,
  },
  {
    name: 'SSO 403',
    err: gh(403, { 'x-github-sso': 'required; url=https://github.com/orgs/x/sso' }),
    reason: 'not-permitted-yet',
    status: 403,
    personText: 'Needs Github authorization',
    canRetry: false,
  },
  {
    name: '422',
    err: gh(422),
    reason: 'wrong-value',
    status: 400,
    personText: 'Github doesn’t allow that',
    canRetry: false,
  },
  {
    name: '502',
    err: gh(502),
    reason: 'try-again',
    status: 502,
    personText: 'Couldn’t reach Github',
    canRetry: true,
  },
  {
    name: '404, re-read agrees',
    err: gh(404),
    reason: 'not-found',
    status: 404,
    personText: 'The issue was not found',
    canRetry: false,
  },
  {
    name: '401',
    err: gh(401),
    reason: 'unauthenticated',
    status: 403,
    personText: 'Github rejected the board',
    canRetry: false,
  },
];
