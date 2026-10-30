import { hasSubmissionFooter } from '../auth/submission-footer';
import { closeReasonOf } from './close-reason';
import type { RawIssue } from './issues-metrics.types';

/**
 * The part of a Github issue the ingest reads, in the one shape both of its
 * sources hand over (#1007, V5): a page of `GET /repos/{o}/{r}/issues`, and the
 * `issue` of an `issues` webhook delivery. Both carry the same REST issue
 * representation, so one mapper serves both, and an issue answered from the
 * webhook store becomes exactly the `RawIssue` a Github read of it would have.
 *
 * No body is kept. The one thing the ingest reads from a body is whether it
 * carries the feedback form's footer (#516), so that is decided here and kept as
 * a boolean, and the store never holds what somebody wrote in an issue.
 * `stateReason` stays Github's own word and is classified on the way out, so a
 * change to `close-reason.ts` reaches stored issues without rewriting them.
 */
export interface StoredIssue {
  number: number;
  title: string;
  htmlUrl: string;
  state: 'open' | 'closed';
  stateReason: string | null;
  createdAt: string;
  closedAt: string | null;
  /** Github's `updated_at`, which the store orders writes on. Null only from a
   *  caller that sent none, which Github does not. */
  updatedAt: string | null;
  author: string | null;
  assignees: string[];
  /** Null when Github sent no label array at all, which is what
   *  `labelsComplete` reports on the way out. */
  labels: string[] | null;
  submission: boolean;
  milestone: string | null;
}

/** What the mapper reads off a Github REST issue, from either source. */
export interface GithubIssueFields {
  number: number;
  title: string;
  html_url: string;
  state: string;
  state_reason?: string | null;
  created_at: string;
  closed_at?: string | null;
  updated_at?: string | null;
  user?: { login?: string | null } | null;
  assignees?: ({ login?: string | null } | null)[] | null;
  labels?: (string | { name?: string | null })[] | null;
  milestone?: { title?: string | null } | null;
  body?: string | null;
  pull_request?: unknown;
}

export function storedIssueOf(i: GithubIssueFields): StoredIssue {
  return {
    number: i.number,
    title: i.title,
    htmlUrl: i.html_url,
    state: i.state === 'closed' ? 'closed' : 'open',
    stateReason: i.state_reason ?? null,
    createdAt: i.created_at,
    closedAt: i.closed_at ?? null,
    updatedAt: i.updated_at ?? null,
    author: i.user?.login ?? null,
    assignees: (i.assignees ?? []).map((a) => a?.login).filter((l): l is string => !!l),
    // REST embeds an issue's whole label array in the issue object — there is
    // no page to truncate here, unlike the two GraphQL reads — so this path
    // establishes the set whenever Github sent one at all.
    labels: i.labels == null
      ? null
      : i.labels.map((l) => (typeof l === 'string' ? l : l.name)).filter((n): n is string => !!n),
    // It costs no extra request: the REST payload already carries the body
    // (#516), and this boolean is all of it the ingest ever reads.
    submission: hasSubmissionFooter(i.body),
    milestone: i.milestone?.title ?? null,
  };
}

/**
 * The `RawIssue` every surface reads. `owner` and `repoKey` come from the
 * `owner/name` the ingest asked about, never from the stored row, so the two
 * halves of the join key cannot disagree (#647) whichever source answered.
 */
export function rawIssueOf(owner: string, repoKey: string, s: StoredIssue): RawIssue {
  return {
    owner,
    repo: repoKey,
    number: s.number,
    title: s.title,
    htmlUrl: s.htmlUrl,
    state: s.state,
    createdAt: s.createdAt,
    closedAt: s.closedAt,
    // WHY it closed (#1014). An unrecognised value is logged by the ingest
    // rather than folded into either answer.
    stateReason: closeReasonOf(s.stateReason),
    author: s.author,
    assignees: s.assignees,
    labels: s.labels ?? [],
    labelsComplete: s.labels !== null,
    submission: s.submission,
    milestone: s.milestone,
  };
}
