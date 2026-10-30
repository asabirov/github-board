import {
  FeedbackScope,
  HIDDEN_FEEDBACK_TITLE,
  IssueOrigin,
  KnownLabels,
  Viewer,
  labelsOf,
  mayReadWords,
  originFromHtmlUrl,
} from '../auth/feedback-visibility';
import type { SubmissionIndex } from '../issues-metrics/issues-cache.service';
import { isBotActor } from './bot-actors';
import type { LastClosed, ProjectClose, ProjectItem, ProjectItemRaw } from './project.types';

/**
 * The Projects surface applying the #497 decision. Projects v2 is the third
 * place the board serves issue titles, and the only one that does not read the
 * shared issues cache: it runs its own GraphQL, so the redaction
 * `IssuesMetricsService` does on that cache never reached it. Triaging a
 * feedback submission onto a board is ordinary practice here (#404 shipped the
 * two-click picker for it), and a submission's title is the end user's first
 * line — so a board row carries somebody else's words as surely as the queue
 * does.
 *
 * Nothing here re-tests what a submission is. Both functions call
 * `mayReadWords`, the single decision in `auth/feedback-visibility.ts`; this
 * file is only the two shapes a board needs it in.
 */

/** Place a board row against the feedback repo. A board can span repos, so the
 *  owner/name comes off the row's own `repo` string; when a source could not
 *  resolve one, the Github URL is the fallback the decision already parses. */
function originOf(repo: string, url: string, labels: KnownLabels, submission: boolean | null): IssueOrigin {
  const [owner, name] = repo.split('/');
  return { owner, repo: name, htmlUrl: url, labels, submission };
}

/**
 * The footer marker for a CLOSE (#516), which is the one Projects shape that
 * carries no body: closes come from the rollup's list query, twenty boards of a
 * hundred items on every refresh, so no markdown rides that read. The shared
 * three-valued index answers instead, and all three answers matter — `null`
 * (no row, or no index at all) means the close is not named.
 *
 * The row's own `repo` places it when it has one; a source that could not
 * resolve one falls back to the Github URL, which is the same fallback the
 * decision itself uses.
 */
function submissionOf(index: SubmissionIndex | null, repo: string, url: string, number: number): boolean | null {
  if (!index) return null;
  const [owner, name] = repo.split('/');
  if (owner && name) return index.lookup(owner, name, number);
  const parsed = originFromHtmlUrl(url);
  return parsed ? index.lookup(parsed.owner, parsed.repo, number) : null;
}

/** The label Github's own dependency tooling stamps, and the one this org marks
 *  a version bump with by hand. Exactly one label, not a housekeeping family:
 *  the rule is meant to step over bumps, and every extra name in a set here is
 *  another way for a card to go quiet about work somebody actually did. */
const DEPENDENCY_LABEL = 'dependencies';

/**
 * A close the rollup card should step over because it is dependency
 * housekeeping (#488) — read off the label, not off who was involved.
 *
 * The label is what identifies the real case. Dependabot files no issues in this
 * org; it files pull requests, which the source's `isIssue` filter drops before
 * they can become candidates. The card the issue was filed about —
 * `compliance.example.com#149`, "Upgrade @acme/ui from 0.19.1 to 0.26.1" — was
 * opened by a person and closed by a person, and the only thing on it that says
 * "bump" is this label.
 *
 * ## An unknown label set means NAMED, and that is the opposite of #497
 *
 * `KnownLabels` is null when a source could not prove it read the issue's whole
 * label set. The words rule treats that as a possible submission and WITHHOLDS,
 * because it is protecting somebody else's first line and the cost of guessing
 * wrong is disclosure.
 *
 * This rule is not a security control — it is a preference about which close is
 * worth a sentence — so it fails the other way. `?? []` is that decision: no
 * provable label set means no reason to skip was found, so the close is named.
 * Inverted, a single truncated label page would take the recency line off every
 * genuine card on the board at once, which is a far worse card than an
 * occasional bump slipping through.
 *
 * Case is folded on the label, as it is everywhere else labels are compared
 * here: Github label names are case-insensitively unique and the API echoes back
 * each repo's own casing, so `Dependencies` on one repo and `dependencies` on
 * the next are the same label and must skip alike.
 */
function isDependencyClose(labels: KnownLabels): boolean {
  return (labels ?? []).some((l) => l.toLowerCase() === DEPENDENCY_LABEL);
}

/**
 * A board's issue rows as this caller may read them: a submission keeps its
 * row — repo, labels, state, assignees, dates, URL — and loses only its title,
 * exactly as it does on the queues. Every count, percentage and ring segment is
 * computed from the rows, not their titles, so hiding one moves no number.
 *
 * Copies every row rather than editing it, so the cached board is never touched.
 *
 * The footer marker (#516) rides the row: `DETAIL_QUERY` reads each issue's body
 * and the source turns it into `ProjectItemRaw.submission` in its mapper, so no
 * body enters the Projects cache and this surface needs no shared index. The
 * marker itself comes OFF here — like `ProjectClose.labels` and `.author`, it
 * exists to decide with and never goes on the wire.
 */
export function readableItems(
  items: ProjectItemRaw[],
  viewer: Viewer | undefined,
  scope: FeedbackScope,
): ProjectItem[] {
  return items.map(({ submission, ...row }) => {
    // A page Github had more labels than is not this row's label set — see
    // `KnownLabels`. Passing the short list would read as "no feedback label".
    const origin = originOf(row.repo, row.url, labelsOf(row.labels.map((l) => l.name), row.labelsComplete), submission);
    return mayReadWords(origin, viewer, scope) ? row : { ...row, title: HIDDEN_FEEDBACK_TITLE };
  });
}

/**
 * Which close the rollup card names — the newest one that answers the question
 * the card's single human line asks: what kind of work is moving here.
 *
 * Three closes don't answer it, and the walk steps over all three:
 *  - a feedback submission this caller may not read (#497) — naming it would
 *    serve an end user's first line to somebody who isn't allowed it;
 *  - an issue automation WROTE (#488);
 *  - an issue carrying the `dependencies` label (#488), whoever wrote it.
 *
 * The last two are an OR over the same idea — a version bump is genuine work
 * moving, and counts everywhere a close counts, but it tells a reader nothing
 * about the objective while being, very often, the newest thing that happened.
 * They exist separately because they catch different things, and only one of
 * them catches anything today.
 *
 * The author rule is the one that would fire on a bot-filed issue, and it keys
 * on the author rather than the closer for a reason: what makes a close a bump
 * is that a bot opened it, while who pressed Close says only how the repo
 * merges. It fires on nothing on a live board — dependabot files pull requests
 * here, not issues, and `github-projects.source.ts`'s `isIssue` filter drops
 * those before they can become candidates — but it is what makes a real bot item
 * behave the day one lands.
 *
 * The label rule is the one that moves the card the issue was filed about:
 * `compliance.example.com#149`, opened by a person, closed by a person, and
 * labelled `dependencies`. See `isDependencyClose` for why an unprovable label
 * set NAMES the close here, which is the opposite of what the same unprovable
 * set does to the words rule above.
 *
 * The reverse of the author rule — a person's issue that a merge queue or
 * `github-actions` closed — IS named: the work behind it was somebody's, and
 * skipping it would blank the card on every repo that automates closing. `by` is
 * served as recorded either way; the card says "Closed by …" about whoever
 * pressed the button.
 *
 * Whichever reason applies, the card skips back to the newest close that does answer, shown
 * with its own real (older) time — not a withheld title, and not a blank card
 * that would make a working board look dead. When NO close in the window
 * qualifies, the card names nothing: that is this function returning null on
 * purpose, not a null falling through from somewhere. `closed` is still whatever
 * it was, so the caller must not read that null as "nothing has ever closed"
 * (`ProjectsView`'s Recency keys its "No issues closed yet" note on the count,
 * not on this).
 *
 * The window is the closes the source read — the first 100 items of a board on
 * the live source, which logs when it truncates. A board past that whose recent
 * closes are all bumps or all submissions names nothing rather than reaching
 * further back; the fix for that is a paginating source, not a longer walk here.
 *
 * The board's status chip is NOT derived from this pick — `deriveProjectStatus`
 * reads the raw newest close (see the sources), so the chip stays beside the
 * counts it agrees with: a board where only automation closed things this week
 * is still, factually, a board where something closed. The chip and this line
 * live on different screens (the chip on a board's own header, this line on the
 * rollup card), so neither contradicts the other in view.
 */
export function readableLastClosed(
  closes: ProjectClose[],
  viewer: Viewer | undefined,
  scope: FeedbackScope,
  index: SubmissionIndex | null,
): LastClosed | null {
  for (const c of closes) {
    if (c.author && isBotActor(c.author)) continue;
    if (isDependencyClose(c.labels)) continue;
    const submission = submissionOf(index, c.repo, c.url, c.number);
    if (!mayReadWords(originOf(c.repo, c.url, c.labels, submission), viewer, scope)) continue;
    // `labels` and `author` ride the candidate so the three decisions can be
    // made (`labels` answers two of them); neither is part of the payload, so
    // both come off here rather than at the controller.
    const { labels: _labels, author: _author, ...lastClosed } = c;
    return lastClosed;
  }
  return null;
}
