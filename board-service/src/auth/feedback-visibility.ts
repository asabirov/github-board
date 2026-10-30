import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedActor, isStaticAgent } from './static-agent';
import { feedbackRepo } from '../config/github-orgs';

/**
 * Whether a caller may read the WORDS of a feedback submission (#497) — the one
 * decision, in one place, for every route that carries an issue.
 *
 * #482 closed the two routes it named, and left the issues routes open on
 * purpose: reading team issues is the main legitimate thing a static
 * `BOARD_AGENT_TOKENS` token exists to do, so refusing them wholesale would cost
 * the token its job. But a submission from the old feedback form IS a Github
 * issue in `FEEDBACK_REPO` — and the form built its TITLE from the first line
 * of the message (`submission-footer.ts` keeps that shape), so the title is the end user's words as surely as the body is.
 * That put an end user's sentence on `/api/issues/search-index`, on the stale
 * tile of `/api/issues/metrics`, on the queues, and their address on the detail
 * route's body footer.
 *
 * So the rule is narrower than the route: a static token loses the WORDS of a
 * submission and keeps everything else. Its row still appears in every list,
 * with the same repo, labels, assignees, dates and URL, so counts, ages and
 * throughput read exactly as they do for a human — only the title is replaced.
 * The body route, where the words and the `Submitted by <address>` footer are
 * the whole payload, is refused instead: there is no useful redacted version.
 *
 * Every other caller is untouched. A signed-in human and a personal access token
 * (#210) both carry a real address and a person accountable for the read, and
 * both already see this content in the board; `isStaticAgent` is what tells them
 * apart from an `agent:<name>` that maps to nobody.
 *
 * ## What makes an issue a submission (#516)
 *
 * Two markers, either of which is enough, both inside `FEEDBACK_REPO`.
 *
 * The FOOTER is the durable one. The old form wrote
 * `Submitted by <address> via the board feedback form.` into every submission
 * from the day the feature shipped until #1450 removed it, and never spelled it
 * a second way (`submission-footer.ts` keeps the format) — so the
 * marker was already on every submission that exists, before anyone knew it
 * would be a marker, which is why this needed no backfill. Only its POSITION has
 * moved (#749 put it first, above the message, where an unclosed block in the
 * message cannot swallow it); the matcher this rule uses is position-blind, so
 * both shapes mark the same and that move needed no backfill either.
 *
 * The LABELS are the older one, and on their own they were the bug. `issue.labels`
 * is the set an issue carries NOW, re-read on every request, so the moment
 * ordinary triage swapped `feedback` for `bug` the rule said "not a submission"
 * and handed the end user's first line to the queues and their address to the
 * body route. Nothing marked the moment it happened. The labels stay because
 * they still catch what the footer cannot: a submission whose body somebody
 * rewrote, and any future stream that stamps no footer of ours.
 *
 * ## `null` and `false` are different answers, at every boundary
 *
 * Both `KnownLabels` and `IssueOrigin.submission` are three-valued, and the
 * third value is the one that matters. `false` is an authoritative "we
 * established this, and it is not one". `null` is "we could not establish it",
 * and the rule withholds on it, because the thing being guarded is somebody
 * else's words and address: the cost of guessing wrong in one direction is
 * disclosure and in the other a title an agent could have read, and those are
 * not comparable.
 *
 * A three-valued fact that becomes two-valued at an interface is the defect this
 * design exists to avoid — collapse it anywhere and a per-issue miss becomes an
 * authoritative "not a submission" that falls straight through to the label
 * test, which is #516 one level up. So `SubmissionIndex.lookup` answers
 * `boolean | null` per issue, and an index that could not be built at all is
 * `null` rather than an empty one that answers `false` to everything.
 *
 * The cost of withholding is bounded, and the bound is the repo gate: it is
 * settled BEFORE either marker, so an unestablished fact costs a static token
 * nothing outside `FEEDBACK_REPO` — every other repo it reads all day is
 * unaffected.
 */

/**
 * The authenticated caller, as the guards leave it on `req.user`.
 *
 * The same shape `isStaticAgent` takes, not a second spelling of it (#525): the
 * fields a visibility decision may read are declared once, next to the predicate
 * that reads them, so this cannot quietly grow a field of its own.
 */
export type Viewer = AuthenticatedActor;

/** What counts as a submission: the repo the old feedback form filed into, under
 *  the labels it stamped. Read from `FEEDBACK_REPO` + `FEEDBACK_LABELS` — the
 *  same two settings the form filed with (#1450 removed it), so the old
 *  submissions stay hidden.
 *
 *  Build it with `feedbackScopeFrom`, which normalises the labels to lower case
 *  and guarantees at least one of them. */
export interface FeedbackScope {
  owner: string;
  repo: string;
  /** Lower-cased, and never empty when built by `feedbackScopeFrom`. */
  labels: string[];
}

/**
 * The label names a decision may rely on: an issue's COMPLETE set, or `null`
 * when the caller could not establish it.
 *
 * The two are not the same answer, and the difference is the whole point.
 * `isFeedbackSubmission` keys on a label being PRESENT, so anything that loses
 * label data — a connection page that truncated, a query that stopped selecting
 * them, a source that returns none — reads as "no `feedback` label here" and
 * hands the words over. `null` says "we do not know", and the decision treats
 * not knowing as a possible submission.
 */
export type KnownLabels = string[] | null;

/** A Github GraphQL label connection, as little of it as the rule needs. */
export interface LabelConnection {
  totalCount?: number | null;
  nodes?: ({ name?: string | null } | null)[] | null;
}

/**
 * One place where a Github label connection becomes an answer the decision can
 * use, so every query feeding the gate loses its words the same way rather than
 * each source inventing its own rule.
 *
 * A page is the issue's label set only when we can see it reached the end, which
 * is why the queries select `totalCount`: without it there is no way to tell a
 * complete page from a first one, so a connection that omits it is unknown. A
 * node we cannot read a name off shortens the list, which would also read as a
 * missing label — so that is unknown too, not a shorter set.
 */
export function knownLabels(conn: LabelConnection | null | undefined): KnownLabels {
  const nodes = conn?.nodes;
  if (!nodes) return null;
  const names = nodes.map((n) => n?.name).filter((n): n is string => !!n);
  if (conn?.totalCount == null || conn.totalCount !== names.length) return null;
  return names;
}

/** Enough of an issue to place it: either side of the repo identity may be
 *  missing — a `RawIssue` carries only its Github URL, the detail route carries
 *  owner/repo from its own params. */
export interface IssueOrigin {
  owner?: string | null;
  repo?: string | null;
  htmlUrl?: string | null;
  /** Every label the issue carries, or `null` when that could not be
   *  established — see `KnownLabels`. A source that reads labels in full (the
   *  REST issue list) simply passes its array. */
  labels: KnownLabels;
  /**
   * Whether this issue's body carries the submission footer (#516) — the marker
   * the form itself wrote, which survives every relabelling afterwards.
   *
   * THREE values, and all three are different answers:
   *  - `true` — a body was read and it carries the footer.
   *  - `false` — a body was read and it does not.
   *  - `null` — no body was established for this issue, for any reason.
   *
   * `null` is not a falsy `false`. Collapsing the two is the defect this field
   * exists to fix: an authoritative "not a submission" for an issue nobody read
   * falls through to the label test, which is #516 one level up. Every interface
   * that carries this fact carries all three states, all the way down.
   *
   * Required, not optional, so a new surface has to answer rather than inherit
   * an opening default — the same reason `labelsComplete` is required.
   */
  submission: boolean | null;
}

/** What a static agent token reads instead of a submission's first line. Plain
 *  on purpose: it says what happened, and it is not somebody's sentence. */
export const HIDDEN_FEEDBACK_TITLE = 'Feedback submission (hidden)';

/**
 * Build the scope, or refuse to boot.
 *
 * A setting that parses to no labels would switch this whole control off while
 * the write path carried on filing submissions — a live feedback stream with
 * nothing guarding it, and no signal anywhere that it happened. Joi rejects the
 * empty string, but `'   '`, `','` and `',,'` all validate clean and parse to
 * nothing, so the check has to live here too. Both services build their scope in
 * their constructor, so a bad setting fails the boot rather than the audit.
 *
 * Labels are folded to lower case: Github label names are case-insensitively
 * unique and the API echoes back the repo's own casing, so `FEEDBACK_LABELS=Feedback`
 * against a repo label spelled `feedback` must still match.
 */
export function feedbackScopeFrom(config: ConfigService): FeedbackScope {
  const full = feedbackRepo(config);
  const [owner = '', repo = ''] = full.split('/').map((s) => s.trim());
  if (!owner || !repo) {
    throw new Error(`FEEDBACK_REPO must be "owner/name"; got ${JSON.stringify(full)}`);
  }
  const labels = config
    .get<string>('FEEDBACK_LABELS', 'feedback')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (labels.length === 0) {
    throw new Error(
      'FEEDBACK_LABELS names no label, so no issue could be recognised as a feedback submission ' +
        'filed by the old feedback form. Set it to the label(s) the form stamped (default `feedback`).',
    );
  }
  return {
    get owner() { return feedbackRepo(config).split('/')[0].trim(); },
    get repo() { return feedbackRepo(config).split('/')[1].trim(); },
    labels,
  };
}

/**
 * THE decision. Every route reaches this one function — the list rule and the
 * body rule below are the only two ways of applying it.
 */
export function mayReadWords(issue: IssueOrigin, viewer: Viewer | undefined, scope: FeedbackScope): boolean {
  if (!withheldFrom(viewer)) return true;
  return !isFeedbackSubmission(issue, scope);
}

/**
 * Who the words are withheld from: a static `BOARD_AGENT_TOKENS` token, and any
 * caller with no address at all. `isStaticAgent` answers false for an absent
 * user — correct where TeamAccessGuard uses it, since true there would bypass
 * the group check — but here false means "hand it over", so the absent case is
 * spelled out rather than inherited. On a guarded route it cannot happen
 * (JwtAuthGuard always sets `req.user`, a dev-stub address included); if it ever
 * does, this fails closed instead of quietly opening.
 *
 * Exported so a surface can SKIP work whose result the rule would never read —
 * `mayReadWords` returns true here, before `submission` or `labels` are
 * consulted at all, so for any other caller the facts a surface gathers are
 * dead. `IssueDetailService` uses it to avoid resolving the submission index on
 * a human read. Export rather than copy: a second spelling of who is withheld is
 * a second place for this control to drift.
 *
 * It is a PERFORMANCE gate only. Nothing may key a visibility decision on it —
 * the decision is `mayReadWords`, which calls this itself.
 *
 * ## What keeps a scoped caller out of here (#525)
 *
 * Since `isStaticAgent` reads a flag rather than the address, an actor with
 * `agent: true`, no flag, and an address carrying no `@` is NOT withheld from,
 * and would read submitters' words. No such caller can be built today, and it
 * takes FOUR separate controls to keep it that way — this is the one place that
 * depends on all of them at once, so they are written down here:
 *
 * 1. `HumanOnlyGuard` rejects any actor carrying `scopes`, and the static-agent
 *    branch always sets them — so a token can never mint a personal access
 *    token whose owner is `agent:<name>`.
 * 2. A personal token's `ownerEmail` comes from a human session's address.
 * 3. `google-auth.service` refuses to mint a session on an unverified or empty
 *    email, so an MCP scoped session always carries a real address.
 * 4. `TeamAccessGuard` is global and runs first; `isMember('agent:…')` fails
 *    closed in both membership implementations.
 *
 * Weaken any one of those — let a scoped actor mint a token, or admit an
 * address without an `@` to the team group — and this line opens.
 */
export function withheldFrom(viewer: Viewer | undefined): boolean {
  return !viewer?.email || isStaticAgent(viewer);
}

/**
 * A submission lives in the configured repo AND either carries the footer the
 * form wrote into its body or carries every configured feedback label.
 *
 * The footer term is #516. `issue.labels` is the set the issue carries NOW,
 * re-read on every request, so the moment a triager swapped `feedback` for `bug`
 * the label test said "not a submission" and the end user's first line went onto
 * the queues and the palette while their address became a 200 on the detail
 * route. Nothing marked the moment it happened. The footer was written at
 * submission time, before anyone knew it would be a marker, so it needs no
 * backfill and no triager has to remember anything.
 *
 * The repo half still matters both ways: the labels alone would hide the team's
 * own `feedback`-labelled issues in other repos, which are our words about a
 * customer, not the customer's; the repo alone would hide the whole issue
 * tracker of whichever repository `FEEDBACK_REPO` names, and a board that files
 * feedback into its own repository names that one. #1175 took the default off,
 * so which repository it is comes from the deployment and nothing here guesses.
 *
 * Case is folded on both sides of the label test, the same way it already is for
 * owner/repo. Github label names are case-insensitively unique and the API
 * echoes back the repo's canonical casing, so an exact-case test would let a
 * `FEEDBACK_LABELS` spelled differently from the repo's own label match nothing
 * at all while the form went on filing — the control off, silently.
 *
 * A repo we cannot resolve counts as a match, so an issue that carries every
 * feedback label is never handed over just because its URL didn't parse. A scope
 * with no labels — which `feedbackScopeFrom` refuses to build — makes every issue
 * in the feedback repo a submission: unreachable, and wrong in the safe direction.
 *
 * The repo is settled BEFORE either marker, because that ordering is what keeps
 * every fail-closed answer narrow. An issue whose label set we could not
 * establish (`KnownLabels` null), or whose body we never read (`submission`
 * null), counts as a submission — but only where one could live, which is the
 * feedback repo. Everywhere else the repo has already said no, so losing either
 * fact costs a static token nothing on the repos it reads all day.
 *
 * `submission !== false` folds `true` and `null` together on purpose: "it is
 * one" and "I could not tell" have the same consequence, and writing them as one
 * line is what stops a later reader from treating `null` as a falsy `false`.
 */
export function isFeedbackSubmission(issue: IssueOrigin, scope: FeedbackScope): boolean {
  const origin = originOf(issue);
  if (origin && !(eq(origin.owner, scope.owner) && eq(origin.repo, scope.repo))) return false;
  if (issue.submission !== false) return true; // carries the footer, or we could not tell
  if (issue.labels == null) return true;
  const labels = issue.labels.map((l) => l.toLowerCase());
  return scope.labels.every((label) => labels.includes(label.toLowerCase()));
}

/**
 * A cached list row the title rule can place: the words it would hide, where the
 * issue lives, and its labels.
 *
 * The labels arrive as a plain array plus a flag rather than as `KnownLabels`,
 * because a cache row RENDERS its labels as well as being placed by them — the
 * queues filter and group on them — so the names have to stay a list whatever
 * the fetch managed. `labelsComplete` is the second half of the answer, and it
 * is required so a new source has to say rather than inherit an opening default.
 */
export interface TitleRow {
  title: string;
  /**
   * The issue's own Github URL — the ONLY thing a row is placed by, and the
   * reason there is no `owner`/`repo` pair here (#647).
   *
   * There was one until a `RawIssue` gained an `owner`. The rows this rule runs
   * over are cache rows, and a cache row's `repo` is the SHORT key from
   * `shortRepoKey()` — `board`, not a full `owner/name`. While `owner` was
   * absent the pair was incomplete and `originOf` fell through to the URL; the
   * moment `owner` arrived the pair completed itself, `originOf` believed it,
   * and `acme/board` matched no real repo — so the feedback repo stopped
   * being recognised and a submission's title was served to a token it is
   * closed to.
   *
   * The fields are gone rather than documented, so a row cannot offer a short
   * key to a rule that needs a real repo name. Callers that genuinely hold
   * owner/repo — the detail route, the relations list — build an `IssueOrigin`
   * themselves and are unaffected.
   */
  htmlUrl?: string | null;
  labels: string[];
  labelsComplete: boolean;
  /** Whether this row's body carries the submission footer (#516) — three-valued,
   *  see `IssueOrigin.submission`. It rides the row unchanged into the origin the
   *  rule is applied to; nothing here re-derives it. */
  submission: boolean | null;
}

/** The two halves of a cache row's label answer, joined into the one the
 *  decision takes. The only way to build a `KnownLabels` from a rendered row. */
export const labelsOf = (names: string[], complete: boolean): KnownLabels => (complete ? names : null);

/**
 * The list rule: replace a submission's title, keep its row. Every caller the
 * words are not withheld from — which is every human session and every personal
 * access token — leaves on the first line with the array it passed in, so the
 * ordinary read costs one predicate and no allocation at all.
 */
export function redactFeedbackTitles<T extends TitleRow>(
  issues: T[],
  viewer: Viewer | undefined,
  scope: FeedbackScope,
): T[] {
  if (!withheldFrom(viewer)) return issues;
  let hid = false;
  const out = issues.map((issue) => {
    // Built field by field, NOT spread from the row. A spread carries whatever
    // the concrete row happens to have — and a `RawIssue` has an `owner` and a
    // short `repo` key, which together form a repo that does not exist. See
    // `TitleRow.htmlUrl`.
    const origin: IssueOrigin = {
      htmlUrl: issue.htmlUrl,
      labels: labelsOf(issue.labels, issue.labelsComplete),
      submission: issue.submission,
    };
    if (mayReadWords(origin, viewer, scope)) return issue;
    hid = true;
    return { ...issue, title: HIDDEN_FEEDBACK_TITLE };
  });
  return hid ? out : issues;
}

/**
 * The body rule: refuse. Used where the words and the `Submitted by <address>`
 * footer ARE the payload, so a redacted version would be worth nothing.
 */
export function assertMayReadWords(
  issue: IssueOrigin,
  viewer: Viewer | undefined,
  scope: FeedbackScope,
): void {
  if (mayReadWords(issue, viewer, scope)) return;
  throw new ForbiddenException(
    'This issue is a feedback submission — somebody else\'s words and address — and is closed to ' +
      'static agent tokens. Use a personal access token, which carries the identity of the person ' +
      'accountable for the read.',
  );
}

/**
 * owner/repo off a Github issue URL, or null when there is none to read.
 *
 * The one parser, exported because the submission index keys on it too (#516).
 * A key must never be composed from `RawIssue.repo`: that field is the SHORT key
 * from `shortRepoKey()`, it carries no owner, and #484's documented collision
 * folds `board` and `board.example.com` onto the same key — so a key built from
 * it can place an issue in the wrong repo, which for a visibility marker means
 * answering about the wrong issue.
 */
export function originFromHtmlUrl(htmlUrl: string | null | undefined): { owner: string; repo: string } | null {
  const m = htmlUrl?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\//);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** owner/repo from whichever the caller had: explicit params, else the Github URL. */
function originOf(issue: IssueOrigin): { owner: string; repo: string } | null {
  if (issue.owner && issue.repo) return { owner: issue.owner, repo: issue.repo };
  return originFromHtmlUrl(issue.htmlUrl);
}

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
