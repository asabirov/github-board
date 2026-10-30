import { describe, expect, it } from 'vitest';
import {
  BOARD_FEEDBACK_FOOTER_RE,
  SUBMISSION_SEARCH_PHRASE,
  composeIssue,
  hasSubmissionFooter,
  type FeedbackInput,
} from './submission-footer';

function input(p: Partial<FeedbackInput> = {}): FeedbackInput {
  return { category: 'bug', message: 'Deploy button does nothing', submitterEmail: 'a@x.io', ...p };
}

describe('composeIssue (#213)', () => {
  it('titles from category + the first line, and attributes the body', () => {
    const c = composeIssue(input({ message: 'It broke\nmore detail here' }), ['feedback']);
    expect(c.title).toBe('[Bug] It broke');
    expect(c.body).toContain('It broke\nmore detail here');
    expect(c.body).toContain('Submitted by a@x.io via the board feedback form.');
  });

  it('adds the category label and de-dupes against configured labels', () => {
    expect(composeIssue(input({ category: 'idea' }), ['feedback']).labels).toEqual(['feedback', 'idea']);
    expect(composeIssue(input({ category: 'bug' }), ['feedback', 'bug']).labels).toEqual(['feedback', 'bug']);
  });

  // #451: this used to compose "[Feedback]". The prefix now says what the chip
  // said, so a reader who pressed Other gets an issue titled [Other].
  it('titles "other" with the name of the chip that was pressed', () => {
    expect(composeIssue(input({ category: 'other', message: 'a note' }), []).title).toBe('[Other] a note');
  });

  it('truncates a long first line with an ellipsis', () => {
    const long = 'x'.repeat(100);
    expect(composeIssue(input({ message: long }), []).title.length).toBeLessThan(90);
    expect(composeIssue(input({ message: long }), []).title.endsWith('…')).toBe(true);
  });
});

/**
 * The attribution LEADS the body (#749), and the order is the security property.
 * Markdown parses forward, so a message ending in an unterminated `<!--`, an
 * unclosed `<details>` or an unclosed fence swallows everything after it — which,
 * with the line at the foot, deleted it from the rendered issue while a line the
 * submitter DID write went on showing above. These are the string facts that
 * hold the shape steady, so fixtures built from it match the old submissions.
 */
describe('composeIssue puts the attribution FIRST (#749)', () => {
  it('writes attribution, blank line, rule, blank line, message — exactly', () => {
    expect(composeIssue(input({ message: 'It broke\nmore detail here' }), ['feedback']).body).toBe(
      'Submitted by a@x.io via the board feedback form.\n\n---\n\nIt broke\nmore detail here',
    );
  });

  /**
   * THE BLANK LINE IS LOAD-BEARING. `text\n---` is a setext H2 in CommonMark, so
   * without it Github draws the attribution as a heading rather than as a line of
   * prose. Asserted on its own so the hazard cannot come back silently under an
   * edit that keeps the order and loses the gap.
   */
  it('keeps a blank line between the attribution and the rule', () => {
    const lines = composeIssue(input(), ['feedback']).body.split('\n');
    expect(lines[0]).toBe('Submitted by a@x.io via the board feedback form.');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('---');
  });

  /**
   * All three readers of the footer are position-blind, which is why #749 changed
   * none of them. Proven here rather than reasoned about: the gate reaches nine
   * call sites and narrowing it would hand an end user's words to a static agent
   * token.
   */
  it('still satisfies all three matchers that read the line', () => {
    const body = composeIssue(input({ message: 'It spins.' }), ['feedback']).body;
    expect(body.match(BOARD_FEEDBACK_FOOTER_RE)?.[1]).toBe('a@x.io');
    expect(hasSubmissionFooter(body)).toBe(true);
    expect(body.includes(SUBMISSION_SEARCH_PHRASE)).toBe(true);
  });

  /** The matchers still hit when the message ends in the block that used to eat
   *  the footer. */
  it('…and still satisfies them when the message ends in an unclosed block', () => {
    const body = composeIssue(input({ message: 'It spins.\n\n<details><summary>log</summary>' }), []).body;
    expect(body.match(BOARD_FEEDBACK_FOOTER_RE)?.[1]).toBe('a@x.io');
    expect(hasSubmissionFooter(body)).toBe(true);
    expect(body.includes(SUBMISSION_SEARCH_PHRASE)).toBe(true);
  });
});

/**
 * The words gate's own matcher (#516). It reads the footer `composeIssue` writes
 * above, and it is deliberately looser than `BOARD_FEEDBACK_FOOTER_RE`, which
 * the parser uses to strip the footer back off.
 *
 * The two want opposite errors. A footer this misses hands an end user's words
 * and address to a static agent token; a footer it hits wrongly costs one hidden
 * title. So it drops the anchor, folds case, and keys on the distinctive phrase
 * rather than on the address — the address is what the parser needs, not what
 * the gate needs, and requiring it only adds a way to miss.
 */
describe('hasSubmissionFooter — the gate’s matcher (#516)', () => {
  const composed = (over: Partial<FeedbackInput> = {}) => composeIssue(input(over), ['feedback']).body;

  it('recognises the body the form actually writes — the writer round-tripped against the reader', () => {
    expect(hasSubmissionFooter(composed())).toBe(true);
  });

  it('recognises it with Windows line endings', () => {
    expect(hasSubmissionFooter(composed().replace(/\n/g, '\r\n'))).toBe(true);
  });

  it('recognises it when a teammate has written a paragraph under the footer', () => {
    expect(hasSubmissionFooter(`${composed()}\n\nTriaged onto the C4 board — talking to them by email.`)).toBe(true);
  });

  /**
   * The case the anchored regex fails, and the reason there are two matchers.
   * `\s*$/m` requires the footer to END its line, so a triager who appends a
   * routing note to that same line silently unmarks the submission — a far more
   * ordinary act than deleting somebody's attribution.
   */
  it('recognises it when text has been appended to the footer’s OWN line', () => {
    expect(hasSubmissionFooter('Submitted by a@b.com via the board feedback form. — routed to #520')).toBe(true);
  });

  it('recognises it with the address redacted — the phrase is the marker, not the address', () => {
    expect(hasSubmissionFooter('Submitted by [redacted] via the board feedback form.')).toBe(true);
  });

  it('is case-insensitive, so a body somebody reflowed still reads as a submission', () => {
    expect(hasSubmissionFooter('SUBMITTED BY a@b.com VIA THE BOARD FEEDBACK FORM.')).toBe(true);
  });

  /** `acme/board#514`, the nearest real near-miss in the repo:
   *  an ordinary team issue whose body talks ABOUT the footer parser. */
  it('leaves an ordinary issue that merely mentions the parser alone', () => {
    const body = '- Related: #313 — built the `Submitted by … from …` parser this stream';
    expect(hasSubmissionFooter(body)).toBe(false);
  });

  it('answers false for a body that was never established', () => {
    expect(hasSubmissionFooter(null)).toBe(false);
    expect(hasSubmissionFooter(undefined)).toBe(false);
    expect(hasSubmissionFooter('')).toBe(false);
  });

  /**
   * A SCOPE BOUNDARY, not an invariant. The platform widget stamps its own
   * footer, `Submitted by <address> from <surface path>`, and this gate does not
   * cover it — the widget's stream lives in another repo, outside `FEEDBACK_REPO`.
   * #514 is the issue that brings that stream in, and whoever plans it is
   * expected to MOVE this line, not preserve it. See the note in `submission-footer.ts`
   * for what generalising costs.
   */
  it('does not recognise the platform widget’s footer — today’s scope, and #514’s to widen', () => {
    expect(hasSubmissionFooter('Submitted by a@x.io from /acme/~/mail/broadcasts')).toBe(false);
  });
});

/**
 * The parser's matcher, which stays anchored on purpose: it decides where to CUT
 * somebody's message, so a loose hit would eat a line of what they wrote.
 */
describe('BOARD_FEEDBACK_FOOTER_RE — the parser’s matcher (#516)', () => {
  it('captures the submitter’s address off the body the form writes', () => {
    expect(composeIssue(input(), ['feedback']).body.match(BOARD_FEEDBACK_FOOTER_RE)?.[1]).toBe('a@x.io');
  });

  it('stays anchored to the end of its line — the tolerance the gate deliberately drops', () => {
    expect(BOARD_FEEDBACK_FOOTER_RE.test('Submitted by a@b.com via the board feedback form. — routed to #520')).toBe(
      false,
    );
  });
});
