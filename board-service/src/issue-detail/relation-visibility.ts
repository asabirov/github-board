import {
  FeedbackScope,
  HIDDEN_FEEDBACK_TITLE,
  Viewer,
  mayReadWords,
} from '../auth/feedback-visibility';
import type { SubmissionIndex } from '../issues-metrics/issues-cache.service';
import type { IssueRelation, IssueRelations } from './issue-detail.types';

/**
 * The issue page's neighbours, as this caller may read them (#497).
 *
 * The gate on the issue page places the issue you asked for and nothing else, so
 * an ORDINARY team issue passed it and then handed over its `subIssues` — and we
 * file submissions under umbrella issues as a matter of course, which makes a
 * neighbour's title an end user's first line. `blockedBy` and `blocking` widen
 * the same door.
 *
 * Refusing the whole route would be the wrong shape: the issue asked for is
 * legitimately readable, and so is the fact that a submission hangs off it. Only
 * the words are not. So a relation the caller may not read keeps its row —
 * number, repo, state, URL, and its place in the counts — and loses its title,
 * exactly as a queue row does.
 *
 * Nothing here re-tests what a submission is: it calls `mayReadWords`, the one
 * decision in `auth/feedback-visibility.ts`.
 *
 * Labels come off every relation on the way out, for every caller. They are
 * fetched so the decision above can be made, not because the page renders them,
 * and a payload should carry what it is for.
 *
 * A relation carries no BODY — the relations query reads a neighbour's number,
 * title, state and labels, not its markdown — so the footer marker (#516)
 * arrives from `index`, the shared three-valued index over the issues cache. All
 * three of its answers are acted on: `true` withholds, `false` hands the
 * decision back to the label rule, and `null` — no row for this issue, or no
 * index at all — withholds, because not knowing is not a no.
 */
export function readableRelations(
  relations: IssueRelations,
  viewer: Viewer | undefined,
  scope: FeedbackScope,
  index: SubmissionIndex | null,
): IssueRelations {
  const one = (r: IssueRelation): IssueRelation => {
    // `labels` is optional on the type, and an absent one is not an empty set:
    // it is a fetch that never established what this issue carries, which the
    // decision treats as a possible submission.
    const readable = mayReadWords(
      {
        owner: r.owner,
        repo: r.repo,
        htmlUrl: r.url,
        labels: r.labels ?? null,
        submission: index ? index.lookup(r.owner, r.repo, r.number) : null,
      },
      viewer,
      scope,
    );
    const { labels: _labels, ...row } = r;
    return readable ? row : { ...row, title: HIDDEN_FEEDBACK_TITLE };
  };
  return {
    ...relations,
    parent: relations.parent ? one(relations.parent) : null,
    subIssues: relations.subIssues.map(one),
    blockedBy: relations.blockedBy.map(one),
    blocking: relations.blocking.map(one),
  };
}
