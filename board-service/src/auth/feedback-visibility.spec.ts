import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import {
  FeedbackScope,
  HIDDEN_FEEDBACK_TITLE,
  assertMayReadWords,
  feedbackScopeFrom,
  knownLabels,
  mayReadWords,
  redactFeedbackTitles,
  withheldFrom,
} from './feedback-visibility';

/**
 * The one decision (#497): a static `BOARD_AGENT_TOKENS` token may not read the
 * words of a feedback submission — and a submission's TITLE is its first line
 * (`submission-footer.ts`), so the title is words too. Everything else about the issue
 * stays readable, and every other actor is untouched.
 */

const SCOPE: FeedbackScope = { owner: 'acme', repo: 'board', labels: ['feedback'] };

/** A ConfigService double: the given keys, everything else its declared default. */
const unpinned = (values: Record<string, string>) =>
  ({ get: (k: string, d?: unknown) => values[k] ?? d }) as unknown as ConfigService;

/**
 * The same double with `FEEDBACK_REPO` pinned at the repo `SCOPE` above names.
 *
 * Every case in this file compares a submission against a scope, and the
 * submissions are sample data in `acme`. That used to be `FEEDBACK_REPO`'s
 * default as well, so a case leaving the key unset got the matching scope by
 * accident; #1166 moved the default to `acme` and the accident stopped
 * holding, and #1175 took the default away altogether. The sample data is left
 * where it is and the pin is written down — a spec that means one repo has to
 * say so, and now there is nothing else for an unset key to read.
 */
const configWith = (values: Record<string, string>) =>
  unpinned({ FEEDBACK_REPO: `${SCOPE.owner}/${SCOPE.repo}`, ...values });

const STATIC_AGENT = { agent: true, staticAgent: true, email: 'agent:ci-bot' };
const HUMAN = { agent: false, email: 'octocat@example.com' };
/** A personal access token (#210) carries its owner's real address. */
const PAT = { agent: true, email: 'octocat@example.com' };

/**
 * A submission recognised by its LABELS, with `submission: false` on purpose:
 * these fixtures exercise the label half of the rule in isolation. A real
 * submission also carries the footer, and that half is `relabelled` below.
 */
const submission = {
  htmlUrl: 'https://github.com/acme/board/issues/460',
  labels: ['feedback', 'bug'],
  labelsComplete: true,
  submission: false,
  title: '[Bug] my report never arrives and the button just spins',
};
/** The whole of #516 in one row: the same submission after ordinary triage swapped
 *  `feedback` for `bug`. The labels no longer say what it is; the footer still does. */
const relabelled = {
  htmlUrl: 'https://github.com/acme/board/issues/460',
  labels: ['bug'],
  labelsComplete: true,
  submission: true,
  title: '[Bug] my report never arrives and the button just spins',
};
const teamIssue = {
  htmlUrl: 'https://github.com/acme/board/issues/497',
  labels: ['access'],
  labelsComplete: true,
  submission: false,
  title: 'a static agent token still reads feedback content',
};
/** Labelled `feedback`, but written BY the team in another repo — not somebody
 *  else's words, so the label alone must not hide it. */
const otherRepoFeedbackLabel = {
  htmlUrl: 'https://github.com/acme/acme/issues/222',
  labels: ['feedback'],
  labelsComplete: true,
  submission: false,
  title: 'Customer: Selgeo weekly digest ask',
};

describe('feedback visibility — the decision (#497)', () => {
  it('a static agent token may not read a submission’s words', () => {
    expect(mayReadWords(submission, STATIC_AGENT, SCOPE)).toBe(false);
  });

  it('a static agent token may read an ordinary issue in the same repo', () => {
    expect(mayReadWords(teamIssue, STATIC_AGENT, SCOPE)).toBe(true);
  });

  it('the `feedback` label alone does not hide an issue outside the feedback repo', () => {
    expect(mayReadWords(otherRepoFeedbackLabel, STATIC_AGENT, SCOPE)).toBe(true);
  });

  it('a human session and a personal access token both read submissions', () => {
    expect(mayReadWords(submission, HUMAN, SCOPE)).toBe(true);
    expect(mayReadWords(submission, PAT, SCOPE)).toBe(true);
  });

  it('an issue read by owner/repo (the detail route’s params) resolves the same way', () => {
    const byParams = { owner: 'acme', repo: 'board', labels: ['feedback'], submission: false };
    expect(mayReadWords(byParams, STATIC_AGENT, SCOPE)).toBe(false);
    expect(mayReadWords({ ...byParams, repo: 'acme' }, STATIC_AGENT, SCOPE)).toBe(true);
  });

  it('an issue whose repo cannot be resolved but carries every feedback label is treated as one', () => {
    expect(mayReadWords({ labels: ['feedback'], submission: false }, STATIC_AGENT, SCOPE)).toBe(false);
  });

  it('a submission missing one of several configured labels is not one', () => {
    const twoLabels: FeedbackScope = { ...SCOPE, labels: ['feedback', 'from-form'] };
    expect(mayReadWords(submission, STATIC_AGENT, twoLabels)).toBe(true);
    expect(mayReadWords({ ...submission, labels: ['feedback', 'from-form'] }, STATIC_AGENT, twoLabels)).toBe(false);
  });

  /** The sibling of the case above, and the new half of the rule (#516): the
   *  same issue under the same short label set, but with a body carrying the
   *  footer. The labels no longer get to decide. */
  it('…but that same issue is one anyway when its body carries the footer', () => {
    const twoLabels: FeedbackScope = { ...SCOPE, labels: ['feedback', 'from-form'] };
    expect(mayReadWords({ ...submission, submission: true }, STATIC_AGENT, twoLabels)).toBe(false);
  });

  it('a caller with no address at all is refused too — an absent guard chain fails closed', () => {
    expect(mayReadWords(submission, undefined, SCOPE)).toBe(false);
    expect(mayReadWords(submission, {}, SCOPE)).toBe(false);
    // …and still only for submissions: an ordinary issue stays readable.
    expect(mayReadWords(teamIssue, undefined, SCOPE)).toBe(true);
  });

  /**
   * Github label names are case-insensitively unique, and the API echoes back
   * the repo's canonical casing. So `FEEDBACK_LABELS=Feedback` against a repo
   * label spelled `feedback` files submissions perfectly — Github matches the
   * write case-insensitively — and a case-sensitive read predicate then matches
   * NOTHING, ever. The feedback stream keeps flowing and the protection is off,
   * with no signal anywhere that it happened. Both sides fold case.
   */
  it('the configured label matches the issue’s whatever the casing on either side', () => {
    const configured = feedbackScopeFrom(configWith({ FEEDBACK_LABELS: 'Feedback' }));
    expect(mayReadWords(submission, STATIC_AGENT, configured)).toBe(false);
    expect(mayReadWords({ ...submission, labels: ['FEEDBACK'] }, STATIC_AGENT, SCOPE)).toBe(false);
    // …and it is still the label, not a substring of one.
    expect(mayReadWords({ ...submission, labels: ['feedback-wanted'] }, STATIC_AGENT, SCOPE)).toBe(true);
  });

  it('a hand-built scope with no labels hides everything in the repo rather than nothing', () => {
    // Unreachable through `feedbackScopeFrom`, which refuses to build one (below).
    // If it is ever reached anyway, the wrong answer must be the safe one.
    expect(mayReadWords(submission, STATIC_AGENT, { ...SCOPE, labels: [] })).toBe(false);
    expect(mayReadWords(otherRepoFeedbackLabel, STATIC_AGENT, { ...SCOPE, labels: [] })).toBe(true);
  });
});

/**
 * The decision keys on a label being PRESENT, so every way of losing label data
 * — a page that truncated, a query that stopped selecting them, a source that
 * returned none — would otherwise read as "no `feedback` label here" and hand
 * the words over. `null` labels say "we could not establish this issue's set",
 * and that is a different answer from "we established it and it has none".
 */
describe('feedback visibility — labels we could not establish (#497)', () => {
  it('an unestablished label set in the feedback repo is withheld, not handed over', () => {
    const unknown = { owner: 'acme', repo: 'board', labels: null, submission: false };
    expect(mayReadWords(unknown, STATIC_AGENT, SCOPE)).toBe(false);
  });

  it('…and outside the feedback repo it changes nothing: no submission can live there', () => {
    const unknown = { owner: 'acme', repo: 'acme', labels: null, submission: false };
    expect(mayReadWords(unknown, STATIC_AGENT, SCOPE)).toBe(true);
  });

  it('an unresolvable repo AND an unestablished label set is withheld', () => {
    expect(mayReadWords({ labels: null, submission: false }, STATIC_AGENT, SCOPE)).toBe(false);
  });

  it('a human session still reads it — this narrows the token, not the board', () => {
    const unknown = { owner: 'acme', repo: 'board', labels: null, submission: false };
    expect(mayReadWords(unknown, HUMAN, SCOPE)).toBe(true);
    expect(mayReadWords(unknown, PAT, SCOPE)).toBe(true);
  });

  // A cache row renders its labels as well as being placed by them, so it says
  // "these names, and they are not the whole set" rather than carrying a null.
  it('the list rule hides a row whose labels are not the whole set', () => {
    const row = {
      htmlUrl: 'https://github.com/acme/board/issues/1',
      labels: ['bug'], labelsComplete: false, submission: false, title: 'who knows',
    };
    expect(redactFeedbackTitles([row], STATIC_AGENT, SCOPE)[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
  });

  it('…and leaves the same row alone outside the feedback repo', () => {
    const row = {
      htmlUrl: 'https://github.com/acme/acme/issues/1',
      labels: ['bug'], labelsComplete: false, submission: false, title: 'who knows',
    };
    expect(redactFeedbackTitles([row], STATIC_AGENT, SCOPE)[0].title).toBe('who knows');
  });

  /**
   * #647. A cache row's `repo` is the SHORT key and it now travels beside an
   * `owner`, so the pair reads as a complete repo identity and names a repo
   * that does not exist — `acme/board`, never `acme/board`.
   * A rule that believed the pair would stop recognising the feedback repo and
   * serve a submission's words to a token they are closed to.
   *
   * The two rows below differ ONLY in the repo their URL names, so this pins
   * the placement and not the shape of the fixture.
   */
  it('places a row by its URL, never by the short repo key riding beside its owner', () => {
    const inFeedbackRepo = {
      owner: 'acme', repo: 'board',
      htmlUrl: 'https://github.com/acme/board/issues/1',
      labels: [], labelsComplete: true, submission: true, title: 'a submitter’s words',
    };
    const elsewhere = { ...inFeedbackRepo, htmlUrl: 'https://github.com/acme/acme/issues/1' };
    expect(redactFeedbackTitles([inFeedbackRepo], STATIC_AGENT, SCOPE)[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
    expect(redactFeedbackTitles([elsewhere], STATIC_AGENT, SCOPE)[0].title).toBe('a submitter’s words');
  });

  it('the body rule refuses it too', () => {
    const row = { owner: 'acme', repo: 'board', labels: null, submission: false };
    expect(() => assertMayReadWords(row, STATIC_AGENT, SCOPE)).toThrow(ForbiddenException);
  });
});

/**
 * #516 — a submission stays a submission after it is relabelled.
 *
 * `issue.labels` is what the issue carries NOW, re-read on every request, so
 * swapping `feedback` for `bug` used to hand an end user's first line to a static
 * agent token, and their address with it on the body route. The footer the form
 * writes into the body says what the issue IS, whatever its labels say later.
 *
 * `submission` is three-valued, and the third value is the point: `null` is "no
 * body was established for this issue", which is a different answer from "a body
 * was read and it has no footer". Not knowing withholds.
 */
describe('feedback visibility — the submission marker (#516)', () => {
  it('a relabelled submission is still one — the labels no longer say so, the footer does', () => {
    expect(mayReadWords(relabelled, STATIC_AGENT, SCOPE)).toBe(false);
  });

  it('a human session and a personal access token read it whole', () => {
    expect(mayReadWords(relabelled, HUMAN, SCOPE)).toBe(true);
    expect(mayReadWords(relabelled, PAT, SCOPE)).toBe(true);
  });

  it('the list rule replaces its title, and the body rule refuses it', () => {
    expect(redactFeedbackTitles([relabelled], STATIC_AGENT, SCOPE)[0].title).toBe(HIDDEN_FEEDBACK_TITLE);
    expect(() => assertMayReadWords(relabelled, STATIC_AGENT, SCOPE)).toThrow(ForbiddenException);
  });

  /** The guard against the new term over-reaching: a marker that widened the
   *  rule would hide the board's own tracker from the tokens that exist to read it. */
  it('an ordinary board-repo issue whose body has no footer stays readable', () => {
    const ordinary = { owner: 'acme', repo: 'board', labels: ['bug'], submission: false };
    expect(mayReadWords(ordinary, STATIC_AGENT, SCOPE)).toBe(true);
  });

  it('an issue we could not read a body for is withheld — not knowing is not a no', () => {
    const unread = { owner: 'acme', repo: 'board', labels: ['bug'], submission: null };
    expect(mayReadWords(unread, STATIC_AGENT, SCOPE)).toBe(false);
  });

  /** …and the fail-closed answer is bounded by the repo gate, which runs first.
   *  Every other repo a static token reads all day is untouched. */
  it('…and the same unread issue in another repo is readable', () => {
    const unread = { owner: 'acme', repo: 'acme', labels: ['bug'], submission: null };
    expect(mayReadWords(unread, STATIC_AGENT, SCOPE)).toBe(true);
  });

  it('a human reads an unread-body issue either way', () => {
    const unread = { owner: 'acme', repo: 'board', labels: ['bug'], submission: null };
    expect(mayReadWords(unread, HUMAN, SCOPE)).toBe(true);
  });

  /** A body carrying the footer OUTSIDE the feedback repo proves the repo gate
   *  still settles first: the blast radius of the marker is one repo. */
  it('a footer in another repo hides nothing — the repo is settled first', () => {
    const elsewhere = { owner: 'acme', repo: 'acme', labels: ['bug'], submission: true };
    expect(mayReadWords(elsewhere, STATIC_AGENT, SCOPE)).toBe(true);
  });

  it('the list rule carries the marker through to the origin it builds', () => {
    const rows = [relabelled, teamIssue];
    expect(redactFeedbackTitles(rows, STATIC_AGENT, SCOPE).map((r) => r.title)).toEqual([
      HIDDEN_FEEDBACK_TITLE,
      teamIssue.title,
    ]);
  });
});

/**
 * `knownLabels` is the one place a Github GraphQL label connection becomes an
 * answer the decision can use, so every query that feeds the gate loses its
 * words the same way rather than each source inventing its own rule.
 */
describe('knownLabels — a Github label connection the decision can trust (#497)', () => {
  it('a complete page is the issue’s label set', () => {
    expect(knownLabels({ totalCount: 2, nodes: [{ name: 'feedback' }, { name: 'bug' }] })).toEqual([
      'feedback',
      'bug',
    ]);
  });

  it('an issue with no labels at all is an established EMPTY set, not an unknown one', () => {
    expect(knownLabels({ totalCount: 0, nodes: [] })).toEqual([]);
  });

  it('a page Github had more rows than is not the issue’s label set', () => {
    expect(knownLabels({ totalCount: 11, nodes: [{ name: 'a' }] })).toBeNull();
  });

  it('a connection the query never selected is unknown', () => {
    expect(knownLabels(undefined)).toBeNull();
    expect(knownLabels(null)).toBeNull();
    expect(knownLabels({})).toBeNull();
  });

  it('a connection without totalCount cannot be shown complete, so it is unknown', () => {
    expect(knownLabels({ nodes: [{ name: 'feedback' }] })).toBeNull();
  });

  it('a node we could not read a name off makes the set unknown rather than shorter', () => {
    expect(knownLabels({ totalCount: 2, nodes: [{ name: 'feedback' }, null] })).toBeNull();
  });
});

describe('feedback visibility — the list rule (#497)', () => {
  it('a static agent token gets the submission’s row with its title replaced, ordinary titles intact', () => {
    const out = redactFeedbackTitles([submission, teamIssue, otherRepoFeedbackLabel], STATIC_AGENT, SCOPE);
    expect(out.map((i) => i.title)).toEqual([
      HIDDEN_FEEDBACK_TITLE,
      teamIssue.title,
      otherRepoFeedbackLabel.title,
    ]);
  });

  it('the redacted row keeps everything that is not words, so counts and ages do not move', () => {
    const [row] = redactFeedbackTitles([submission], STATIC_AGENT, SCOPE);
    expect(row.htmlUrl).toBe(submission.htmlUrl);
    expect(row.labels).toEqual(submission.labels);
  });

  it('does not mutate the list it was given', () => {
    const input = [{ ...submission }];
    redactFeedbackTitles(input, STATIC_AGENT, SCOPE);
    expect(input[0].title).toBe(submission.title);
  });

  it('a human session and a personal access token get the list untouched', () => {
    for (const viewer of [HUMAN, PAT]) {
      const out = redactFeedbackTitles([submission, teamIssue], viewer, SCOPE);
      expect(out.map((i) => i.title)).toEqual([submission.title, teamIssue.title]);
    }
  });
});

describe('feedback visibility — the body rule (#497)', () => {
  it('a static agent token is refused a submission outright', () => {
    expect(() => assertMayReadWords(submission, STATIC_AGENT, SCOPE)).toThrow(ForbiddenException);
  });

  it('a static agent token still reads an ordinary issue', () => {
    expect(() => assertMayReadWords(teamIssue, STATIC_AGENT, SCOPE)).not.toThrow();
  });

  it('a human session and a personal access token read the submission', () => {
    expect(() => assertMayReadWords(submission, HUMAN, SCOPE)).not.toThrow();
    expect(() => assertMayReadWords(submission, PAT, SCOPE)).not.toThrow();
  });
});

describe('feedback visibility — the scope comes from the write path’s settings (#497)', () => {
  it('reads FEEDBACK_REPO + FEEDBACK_LABELS, the same two the old form filed with', () => {
    expect(
      feedbackScopeFrom(configWith({ FEEDBACK_REPO: 'acme/support', FEEDBACK_LABELS: 'feedback, from-form' })),
    ).toEqual({ owner: 'acme', repo: 'support', labels: ['feedback', 'from-form'] });
  });

  it('refuses a board that named no repository, rather than falling back to one (#1175)', () => {
    // This case used to assert the constant the schema applied. There is no
    // constant: the organisation was renamed on 2026-09-16 and this board's own
    // repository on 2026-09-17, and a default is a promise that being silent is
    // safe. Silence is now a refusal that names the setting. `FEEDBACK_LABELS`
    // still defaults, because `feedback` names no organisation.
    expect(() => feedbackScopeFrom(unpinned({}))).toThrow(/FEEDBACK_REPO is not set/);
    expect(feedbackScopeFrom(unpinned({ FEEDBACK_REPO: 'acme/support' }))).toEqual({
      owner: 'acme',
      repo: 'support',
      labels: ['feedback'],
    });
  });

  it('folds the configured labels to lower case, so the read matches Github’s casing', () => {
    expect(feedbackScopeFrom(configWith({ FEEDBACK_LABELS: 'Feedback, From-Form' })).labels).toEqual([
      'feedback',
      'from-form',
    ]);
  });

  /**
   * A setting that parses to no labels would switch the whole control off while
   * the write path carries on filing submissions — a live feedback stream with
   * nothing guarding it, and no signal. Joi rejects the empty string, but
   * `'   '`, `','`, `' , '` and `',,'` all boot clean and parse to nothing. Fail
   * the boot instead of failing the audit.
   */
  for (const blank of ['   ', ',', ' , ', ',,', '']) {
    it(`refuses to build a scope from FEEDBACK_LABELS=${JSON.stringify(blank)}`, () => {
      expect(() => feedbackScopeFrom(configWith({ FEEDBACK_LABELS: blank }))).toThrow(/FEEDBACK_LABELS/);
    });
  }

  it('refuses a FEEDBACK_REPO that is not owner/name', () => {
    expect(() => feedbackScopeFrom(configWith({ FEEDBACK_REPO: 'board' }))).toThrow(
      /FEEDBACK_REPO/,
    );
  });
});

/**
 * #525. The withholding used to be decided by the SHAPE of the caller's address
 * — agent flag set, and no `@` in the email. The address is built as
 * `agent:<name>` from a name in `BOARD_AGENT_TOKENS`, so a token named
 * `claude@ci` produced `agent:claude@ci`, passed the `@` test, and read as an
 * ordinary person: the submission's first line and the `Submitted by <address>`
 * footer both went out.
 *
 * Two changes close it, and both are pinned here. `parseAgentTokens` refuses
 * such a name (`config.schema.ts` already did), and `isStaticAgent` no longer
 * reads the address at all — it keys on the flag `JwtAuthGuard` sets where it
 * builds the actor, so a future bug in name handling cannot re-open this.
 */
describe('feedback visibility — the caller’s address is not what decides (#525)', () => {
  const PERSON_SHAPED_NAME = { agent: true, staticAgent: true, email: 'agent:claude@ci' };

  it('withholds from a static agent whose address reads as a person', () => {
    expect(withheldFrom(PERSON_SHAPED_NAME)).toBe(true);
  });

  it('gives it neither the words nor the title of a submission', () => {
    expect(mayReadWords(submission, PERSON_SHAPED_NAME, SCOPE)).toBe(false);
    expect(redactFeedbackTitles([submission], PERSON_SHAPED_NAME, SCOPE)[0].title).toBe(
      HIDDEN_FEEDBACK_TITLE,
    );
    expect(() => assertMayReadWords(submission, PERSON_SHAPED_NAME, SCOPE)).toThrow(ForbiddenException);
  });

  it('leaves it every ordinary issue, exactly as a well-named token has', () => {
    expect(mayReadWords(teamIssue, PERSON_SHAPED_NAME, SCOPE)).toBe(true);
  });

  it('does not withhold from a caller whose address merely looks synthetic', () => {
    expect(withheldFrom({ agent: true, email: 'agent:impostor' })).toBe(false);
  });

  /** The performance gate still opens for a caller with no address at all —
   *  `mayReadWords` fails closed on it, and that has not changed. */
  it('still withholds from a caller with no address at all', () => {
    expect(withheldFrom({})).toBe(true);
    expect(withheldFrom(undefined)).toBe(true);
  });
});
