// The attribution footer of the old feedback form's submissions (#213, #1450).
// The board used to file each submission as a Github issue in `FEEDBACK_REPO`.
// The form is removed. The issues it filed stay on Github, and the redaction
// rule in `feedback-visibility.ts` keeps them hidden from static agent tokens.
// This file keeps the footer's readers and the writer that fixtures use to
// build a submission body of the exact old shape. No I/O.

/** Coarse category of an old submission: a label and a title prefix. */
export type FeedbackCategory = 'bug' | 'idea' | 'other';

/** The fields the old form filed. Fixtures build submission bodies from them. */
export interface FeedbackInput {
  imageUrl?: string;
  category: FeedbackCategory;
  message: string;
  /** Lowercased email of the submitter, attributed in the issue body. */
  submitterEmail: string;
}

// The prefix stamped into the title, one label per chip in the old form's picker.
// `other` used to read "Feedback". #451 renamed it to "Other". Titles already on
// Github are never rewritten, so old submissions can carry either prefix.
const CATEGORY_LABEL: Record<FeedbackCategory, string> = { bug: 'Bug', idea: 'Idea', other: 'Other' };

/** A one-line title from the category + the first line of the message, trimmed
 *  to a readable length so the issues list stays scannable. */
function titleFor(input: FeedbackInput): string {
  const firstLine = input.message.trim().split('\n')[0].trim();
  const short = firstLine.length > 72 ? `${firstLine.slice(0, 71)}…` : firstLine;
  return `[${CATEGORY_LABEL[input.category]}] ${short}`;
}

export interface ComposedIssue {
  title: string;
  body: string;
  labels: string[];
}

/**
 * The attribution footer, read three ways (#516, #522).
 *
 * The old form wrote `Submitted by <address> via the board feedback form.` into
 * every submission it filed, and the line never had a second spelling. Only its
 * POSITION moved: #749 put it first, and older bodies on Github carry it last.
 * All three readers below are position-blind. That makes the footer a marker of
 * what an issue IS. It was written at submission time and survives every
 * relabelling afterwards. #516 needs that, because ordinary triage takes the
 * `feedback` label off.
 *
 * The three readers live here, beside the writer of the format, so a change to
 * one is visibly a change to the others. Two of them are regexes with opposite
 * errors on purpose: the parser's wants precision, and the gate's wants recall.
 * The third is a plain string for Github's search (#522).
 */

/**
 * The PARSER's matcher. Capture group 1 is the submitter's address.
 *
 * A parser that uses it decides where to CUT somebody's message, so it wants
 * precision and keeps its anchor: the footer has to end its line, and the
 * address has to be there. A loose hit here would eat a line of what they wrote.
 */
export const BOARD_FEEDBACK_FOOTER_RE = /Submitted by (\S+@\S+) via the board feedback form\.?\s*$/m;

/**
 * The GATE's matcher — the words rule in `auth/feedback-visibility.ts`.
 *
 * A footer this misses hands an end user's words and address to a static agent
 * token; a footer it hits wrongly costs one hidden title. Those are not
 * comparable, so this one is tuned for recall: no anchor, case folded, and keyed
 * on the distinctive phrase rather than on the address.
 *
 * Dropping the anchor is the substantive difference. `\s*$/m` means a triager
 * who appends a routing note to the footer's own line — `… via the board
 * feedback form. — routed to #520` — silently unmarks the submission, and that
 * is a far more ordinary act than deleting somebody's attribution. The address
 * is what the parser needs; requiring it here would only add a way to miss.
 *
 * Scope: the board form's own stream. The platform widget stamps a different
 * footer (`Submitted by <address> from <surface path>`) in a different repo, and
 * #514 is the issue that brings it in. Generalising is real work — the scope
 * becomes a list, the marker has to record WHICH stream a body came from, and
 * the widget's phrasing is loose in a way this one is not — so it is priced on
 * #514 rather than guessed at here.
 */
const GATE_FOOTER_RE = /via the board feedback form/i;

/** Does this body carry the board form's attribution footer (#516)? A body we
 *  never read is not a "no" — callers that cannot establish one say so with a
 *  `null` origin field instead of calling this with nothing. */
export function hasSubmissionFooter(body: string | null | undefined): boolean {
  return !!body && GATE_FOOTER_RE.test(body);
}

/**
 * The SEARCH's matcher (#522): a Github `in:body` search for old submissions.
 *
 * The third and coarsest reader of the same line, and the only one that never
 * decides anything. Github's `in:body` is an AND over tokens, not a phrase
 * match: measured against the live repo, a scrambled word order returns the same
 * rows. So this narrows the fetch and `hasSubmissionFooter` above rules on what
 * comes back.
 *
 * It is a phrase, not a query. The quoting and the `in:body` qualifier are the
 * search layer's business and belong where the queries are built.
 */
export const SUBMISSION_SEARCH_PHRASE = 'via the board feedback form';

/**
 * Compose an issue exactly as the old form filed it. Fixtures use this so that
 * their submission bodies cannot drift from the shape the old form wrote. The
 * body carries the attribution and then the full message. `extraLabels` are the
 * configured feedback labels. The category label is always added.
 *
 * THE ORDER WAS THE SECURITY PROPERTY (#749). Markdown parses forward, and
 * several of its blocks run to the end of the document when they are left
 * open: an unterminated `<!--`, an unclosed `<details>`, an unclosed fence.
 * With the attribution LAST, each of those deleted it from the rendered issue.
 * No BLOCK a submitter writes can reach backwards over one that precedes it, so
 * #749 put the attribution first. #693 found the same class on the comment
 * footer first. This is its sibling.
 *
 * "Blocks" is the exact word. CommonMark's link reference definitions and
 * footnote definitions are DOCUMENT-scoped, so one written at the foot resolves
 * a reference that appears above it. That binds nothing here, because the
 * attribution is a bare address with no bracket syntax for a definition to
 * bind to. The same caveat applies to `issue-detail/comment-footer.ts`, which
 * rests on the same reasoning with the same bare-address shape.
 *
 * The gate fails safe on a forged footer: a body that carries the phrase reads
 * AS a submission, which HIDES it from a static agent token rather than
 * exposing it.
 */
export function composeIssue(input: FeedbackInput, extraLabels: string[]): ComposedIssue {
  const body = [
    `Submitted by ${input.submitterEmail} via the board feedback form.`,
    // LOAD-BEARING BLANK LINE. `text\n---` is a setext H2 in CommonMark, so
    // without it the attribution renders as a heading rather than as a line of
    // prose. The rule below it is the divider the old form wrote.
    '',
    '---',
    '',
    ...(input.imageUrl ? [`[View screenshot](${input.imageUrl})`, ''] : []),
    input.message.trim(),
  ].join('\n');
  // De-dupe: the configured labels may already include the category label.
  const labels = [...new Set([...extraLabels, input.category])];
  return { title: titleFor(input), body, labels };
}
