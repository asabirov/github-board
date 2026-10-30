import { describe, expect, it } from 'vitest';
import { FeedbackScope, HIDDEN_FEEDBACK_TITLE } from '../auth/feedback-visibility';
import type { SubmissionIndex } from '../issues-metrics/issues-cache.service';
import type { IssueRelation, IssueRelations } from './issue-detail.types';
import { readableRelations } from './relation-visibility';

/**
 * #497 — the relations panel. An issue page names its neighbours by title, and
 * filing a submission under an umbrella is house practice here, so an ORDINARY
 * team issue's `subIssues` carried an end user's first line verbatim. The host
 * issue passes the gate, which is why refusing the whole route would be wrong:
 * the neighbour is legitimately readable, only its words are not.
 */

const SCOPE: FeedbackScope = { owner: 'acme', repo: 'board', labels: ['feedback'] };
const STATIC_AGENT = { agent: true, staticAgent: true, email: 'agent:ci-bot' };
const HUMAN = { agent: false, email: 'octocat@example.com' };
const PAT = { agent: true, email: 'octocat@example.com' };

const SUBMISSION_TITLE = '[Bug] my weekly report never arrives and the button just spins';

/** A submission filed under the umbrella — a Github issue in FEEDBACK_REPO
 *  under the label the old form stamped, whose title is the end user's first line. */
const submission: IssueRelation = {
  owner: 'acme',
  repo: 'board',
  number: 901,
  title: SUBMISSION_TITLE,
  state: 'open',
  url: 'https://github.com/acme/board/issues/901',
  labels: ['feedback', 'bug'],
};

const teamIssue: IssueRelation = {
  owner: 'acme',
  repo: 'board',
  number: 497,
  title: 'a static agent token still reads feedback content',
  state: 'open',
  url: 'https://github.com/acme/board/issues/497',
  labels: ['access'],
};

const empty: IssueRelations = {
  parent: null,
  subIssues: [],
  subIssuesTotal: 0,
  subIssuesClosed: 0,
  blockedBy: [],
  blocking: [],
};

const withSubIssues = (...subIssues: IssueRelation[]): IssueRelations => ({
  ...empty,
  subIssues,
  subIssuesTotal: subIssues.length,
  subIssuesClosed: 0,
});

/** A stand-in index: the rows it knows, and `null` — "no row for this issue" —
 *  for everything else (#516). */
const indexOf = (rows: Record<number, boolean>): SubmissionIndex => ({
  lookup: (_owner: string, _repo: string, number: number) => (number in rows ? rows[number] : null),
});

/** An index that read every body and found no footer anywhere. The #497 cases
 *  below are about the LABEL half of the rule, so this is what lets them go on
 *  saying exactly what they always said. */
const NO_FOOTERS: SubmissionIndex = { lookup: () => false };

describe('relation visibility (#497)', () => {
  it('a static agent token reading an ordinary issue does not get a sub-issue submission’s title', () => {
    const out = readableRelations(withSubIssues(submission, teamIssue), STATIC_AGENT, SCOPE, NO_FOOTERS);
    expect(out.subIssues.map((r) => r.title)).toEqual([HIDDEN_FEEDBACK_TITLE, teamIssue.title]);
  });

  it('the hidden relation keeps its row — number, repo, state and URL all stand', () => {
    const [row] = readableRelations(withSubIssues(submission), STATIC_AGENT, SCOPE, NO_FOOTERS).subIssues;
    expect(row).toMatchObject({
      owner: 'acme',
      repo: 'board',
      number: 901,
      state: 'open',
      url: submission.url,
    });
  });

  it('every relation kind is gated, not just sub-issues', () => {
    const out = readableRelations(
      { ...empty, parent: submission, blockedBy: [submission], blocking: [submission] },
      STATIC_AGENT,
      SCOPE,
      NO_FOOTERS,
    );
    expect(out.parent?.title).toBe(HIDDEN_FEEDBACK_TITLE);
    expect(out.blockedBy[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
    expect(out.blocking[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
  });

  it('a human session and a personal access token read every relation title', () => {
    for (const viewer of [HUMAN, PAT]) {
      const out = readableRelations(withSubIssues(submission, teamIssue), viewer, SCOPE, NO_FOOTERS);
      expect(out.subIssues.map((r) => r.title)).toEqual([SUBMISSION_TITLE, teamIssue.title]);
    }
  });

  it('a relation whose label set could not be established is withheld too', () => {
    const unknown: IssueRelation = { ...submission, title: 'who knows', labels: null };
    expect(readableRelations(withSubIssues(unknown), STATIC_AGENT, SCOPE, NO_FOOTERS).subIssues[0].title).toBe(
      HIDDEN_FEEDBACK_TITLE,
    );
  });

  it('a relation that never carried labels at all is withheld — an omission is not an empty set', () => {
    const noLabels = { ...submission, title: 'who knows' } as IssueRelation;
    delete noLabels.labels;
    expect(readableRelations(withSubIssues(noLabels), STATIC_AGENT, SCOPE, NO_FOOTERS).subIssues[0].title).toBe(
      HIDDEN_FEEDBACK_TITLE,
    );
  });

  it('labels ride the relation to decide with and never reach the payload', () => {
    const out = readableRelations(
      { ...withSubIssues(submission, teamIssue), parent: teamIssue, blockedBy: [teamIssue] },
      HUMAN,
      SCOPE,
      NO_FOOTERS,
    );
    const every = [out.parent!, ...out.subIssues, ...out.blockedBy];
    for (const r of every) expect(r).not.toHaveProperty('labels');
  });

  it('the counts are untouched — hiding a title moves no number', () => {
    const relations = { ...withSubIssues(submission, teamIssue), subIssuesTotal: 19, subIssuesClosed: 8 };
    const out = readableRelations(relations, STATIC_AGENT, SCOPE, NO_FOOTERS);
    expect(out.subIssuesTotal).toBe(19);
    expect(out.subIssuesClosed).toBe(8);
  });

  it('the cached relations are never edited — the copy a teammate primed stays whole', () => {
    const relations = withSubIssues(submission);
    readableRelations(relations, STATIC_AGENT, SCOPE, NO_FOOTERS);
    expect(relations.subIssues[0].title).toBe(SUBMISSION_TITLE);
    expect(relations.subIssues[0].labels).toEqual(['feedback', 'bug']);
  });

  it('an issue with no relations comes back with none, not nulls', () => {
    expect(readableRelations(empty, STATIC_AGENT, SCOPE, NO_FOOTERS)).toEqual(empty);
  });
});

/**
 * #516 — a relation carries no body, so this surface gets the marker from the
 * shared index over the issues cache. Three values arrive here and all three
 * are acted on: indexed `true` hides, indexed `false` leaves the label rule to
 * decide, and a row the index has no answer for is WITHHELD.
 */
describe('relation visibility — the submission index (#516)', () => {
  const RELABELLED_TITLE = '[Bug] the digest email arrives empty every second week';
  /** The same submission after triage: `feedback` gone, `bug` in its place. The
   *  label rule alone reads this as an ordinary team issue. */
  const relabelled: IssueRelation = {
    owner: 'acme',
    repo: 'board',
    number: 902,
    title: RELABELLED_TITLE,
    state: 'open',
    url: 'https://github.com/acme/board/issues/902',
    labels: ['bug', 'in progress'],
  };

  it('hides a relabelled submission the index knows about', () => {
    const out = readableRelations(
      withSubIssues(relabelled, teamIssue),
      STATIC_AGENT,
      SCOPE,
      indexOf({ 902: true, 497: false }),
    );
    expect(out.subIssues.map((r) => r.title)).toEqual([HIDDEN_FEEDBACK_TITLE, teamIssue.title]);
  });

  it('leaves it alone for a human session and a personal access token', () => {
    for (const viewer of [HUMAN, PAT]) {
      const out = readableRelations(withSubIssues(relabelled), viewer, SCOPE, indexOf({ 902: true }));
      expect(out.subIssues[0].title).toBe(RELABELLED_TITLE);
    }
  });

  /** This is the row the first draft got wrong: an index that answers `false`
   *  for an issue it simply has no row for is an authoritative lie. */
  it('withholds a feedback-repo relation the index has no row for', () => {
    const out = readableRelations(withSubIssues(relabelled), STATIC_AGENT, SCOPE, indexOf({}));
    expect(out.subIssues[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
  });

  it('…and leaves the same absent row alone in another repo — fail-closed is bounded by the repo gate', () => {
    const elsewhere: IssueRelation = {
      ...relabelled,
      repo: 'acme',
      url: 'https://github.com/acme/acme/issues/902',
    };
    const out = readableRelations(withSubIssues(elsewhere), STATIC_AGENT, SCOPE, indexOf({}));
    expect(out.subIssues[0].title).toBe(RELABELLED_TITLE);
  });

  it('an index that could not be built at all hides every feedback-repo row and nothing else', () => {
    const elsewhere: IssueRelation = {
      ...relabelled,
      repo: 'acme',
      url: 'https://github.com/acme/acme/issues/902',
    };
    const out = readableRelations(withSubIssues(relabelled, elsewhere), STATIC_AGENT, SCOPE, null);
    expect(out.subIssues.map((r) => r.title)).toEqual([HIDDEN_FEEDBACK_TITLE, RELABELLED_TITLE]);
  });

  it('an indexed `false` leaves the label rule to decide, either way', () => {
    const index = indexOf({ 902: false, 901: false });
    // No footer and no feedback label → an ordinary issue, readable.
    expect(readableRelations(withSubIssues(relabelled), STATIC_AGENT, SCOPE, index).subIssues[0].title).toBe(
      RELABELLED_TITLE,
    );
    // No footer, but it carries the label → still a submission.
    expect(readableRelations(withSubIssues(submission), STATIC_AGENT, SCOPE, index).subIssues[0].title).toBe(
      HIDDEN_FEEDBACK_TITLE,
    );
  });

  it('every relation kind reads the index, not just sub-issues', () => {
    const out = readableRelations(
      { ...empty, parent: relabelled, blockedBy: [relabelled], blocking: [relabelled] },
      STATIC_AGENT,
      SCOPE,
      indexOf({ 902: true }),
    );
    expect(out.parent?.title).toBe(HIDDEN_FEEDBACK_TITLE);
    expect(out.blockedBy[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
    expect(out.blocking[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
  });
});
