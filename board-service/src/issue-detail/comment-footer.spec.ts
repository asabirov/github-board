import { describe, expect, it } from 'vitest';
import {
  BOARD_FEEDBACK_FOOTER_RE,
  SUBMISSION_SEARCH_PHRASE,
  hasSubmissionFooter,
} from '../auth/submission-footer';
import { carriesForgedFooter, commentFooter, composeComment, maxAuthorBody } from './comment-footer';
import { COMMENT_BODY_MAX } from './issue-detail.types';

const EMAIL = 'ivan@example.com';

/**
 * Two footers now carry an address in this tree, and only one of them means
 * "these are an end user's words". This suite is the check that they stay
 * distinguishable.
 *
 * `hasSubmissionFooter` is what `assertMayReadWords` rules on, so a comment
 * footer that made it answer true would start withholding issues from the people
 * entitled to read them — silently, and on every issue anyone had answered from
 * the board. The three readers of the feedback line are run against the real
 * thing rather than reasoned about.
 */
describe('the comment footer does not collide with the feedback footer (#693/#516)', () => {
  const signed = composeComment('Answered.', EMAIL);

  it('trips none of the three matchers that read the feedback footer', () => {
    for (const body of [commentFooter(EMAIL), signed, `${signed}\n`]) {
      expect(hasSubmissionFooter(body), `gate on ${JSON.stringify(body)}`).toBe(false);
      expect(BOARD_FEEDBACK_FOOTER_RE.test(body), `parser on ${JSON.stringify(body)}`).toBe(false);
      expect(body.includes(SUBMISSION_SEARCH_PHRASE), `search on ${JSON.stringify(body)}`).toBe(false);
    }
  });

  it('…and the real feedback footer still trips all three', () => {
    // The floor. Every assertion above passes against matchers that had stopped
    // matching anything at all, which is the failure that would take the words
    // gate off the whole board without a word.
    const submission = `I cannot log in.\n\nSubmitted by ${EMAIL} via the board feedback form.`;
    expect(hasSubmissionFooter(submission)).toBe(true);
    expect(BOARD_FEEDBACK_FOOTER_RE.test(submission)).toBe(true);
    expect(submission.includes(SUBMISSION_SEARCH_PHRASE)).toBe(true);
  });

  it('a submission QUOTED into a comment is still a submission, footer or no footer', () => {
    // The other direction, and the worse one: signing a body that quotes a
    // submission must not talk the gate OUT of a "yes" it would otherwise give.
    const quoting = composeComment(
      `> Submitted by someone@example.com via the board feedback form.`,
      EMAIL,
    );
    expect(hasSubmissionFooter(quoting)).toBe(true);
  });
});

describe('what the board signs, and what it refuses to sign (#693)', () => {
  it('puts the footer FIRST, a blank line above the author’s text', () => {
    // The order is the security property. Markdown parses forward, so a block
    // the author leaves open runs to the end of the document and takes whatever
    // FOLLOWS it — which used to be this line. Nothing can reach backwards.
    expect(composeComment('One paragraph.', EMAIL)).toBe(
      `— ${EMAIL} via the board\n\nOne paragraph.`,
    );
  });

  it('catches a hand-typed footer at the start of a line, under any address', () => {
    for (const forged of [
      `— ceo@example.com via the board`,
      `nasty\n\n— ceo@example.com via the board`,
      `  — ceo@example.com via the board  `,
      `— CEO@example.com VIA THE BOARD`,
      `— ${EMAIL} via the board`, // their own address is the board's line too
    ]) {
      expect(carriesForgedFooter(forged), JSON.stringify(forged)).toBe(true);
    }
  });

  it('catches one written as an entity, or wrapped in a tag, because that is what RENDERS', () => {
    // Each of these was sent through Github's own `POST /markdown` with
    // `mode: gfm` and came back a line pixel-identical to the board's footer;
    // react-markdown decodes the same references in the board's own thread. A
    // matcher reading source bytes accepts every one of them.
    for (const forged of [
      `&mdash; ceo@example.com via the board`,
      `&#8212; ceo@example.com via the board`,
      `&#08212; ceo@example.com via the board`,
      `&#x2014; ceo@example.com via the board`,
      `&#X2014; ceo@example.com via the board`,
      `<p>— ceo@example.com via the board</p>`,
      `<div>— ceo@example.com via the board</div>`,
      `— ceo@example.com via the b<span></span>oard`, // a tag splitting the tail
      `— ceo@example.com via the b<!--x-->oard`, // a comment splitting the tail
      `— ceo@example.com via the b&#111;ard`, // a reference inside the tail
      `&#x2014;&nbsp;ceo@example.com via the board`, // and the space is one too
      `*— ceo@example.com via the board*`, // italic, and still the line
      `― ceo@example.com via the board`, // U+2015: the same stroke to the eye
      `– ceo@example.com via the board`, // U+2013
      `− ceo@example.com via the board`, // U+2212
      `hi\n\n&mdash; ceo@example.com via the board\n\nbye`, // any line, not just the last
    ]) {
      expect(carriesForgedFooter(forged), JSON.stringify(forged)).toBe(true);
    }
  });

  it('skips markup the way a browser reads it — once, left to right, never re-reading', () => {
    // The tail is where this earns its keep: `via the b<span></span>oard` holds
    // no `via the board` at all until the tags are out of the way. Skipping is a
    // single scan over the SOURCE, so there is no output to re-read and no
    // nesting to reassemble — the defect a regex sweep has and a scan cannot.
    for (const wrapped of [
      `<p>— ceo@example.com via the board</p>`,
      `<div>— ceo@example.com via the board</div>`,
      `— ceo@example.com via the b<span></span>oard`,
      `— ceo@example.com via the b<!--x-->oard`,
      `<em><strong>— ceo@example.com via the board</strong></em>`,
    ]) {
      expect(carriesForgedFooter(wrapped), JSON.stringify(wrapped)).toBe(true);
    }
  });

  it('leaves nested markup alone, because Github does not draw it as the line either', () => {
    // Each of these was sent through Github's own `POST /markdown`, and each
    // comes back with the leftover VISIBLE — `p>— ceo@…`, `-- x -->— ceo@…`,
    // `via the b<` and a `span>oard` in the next block. A reader sees prefixed
    // junk, not the board's signature, so refusing them would be a 400 on
    // something that is not a forgery. The renderer decided this, not a reading.
    for (const nested of [
      `<<p>p>— ceo@example.com via the board`, // renders `p>— ceo@… via the board`
      `<!<p>-- x -->— ceo@example.com via the board`, // renders `-- x -->— ceo@…`
      `— ceo@example.com via the b<<p>span>oard`, // renders as two blocks, tail broken
      `<<div>!-- --> — ceo@example.com via the board`, // renders `!-- --> — ceo@…`
    ]) {
      expect(carriesForgedFooter(nested), JSON.stringify(nested)).toBe(false);
    }
  });

  it('leaves a quoted footer, and ordinary prose, alone', () => {
    // The floor under the widening above: a matcher that answered true to
    // everything would pass every assertion in the two tests before this one.
    for (const innocent of [
      `> — ceo@example.com via the board`, // a reply quoting an answer
      `— Ivan`, // an ordinary sign-off
      `Filed via the board earlier today.`, // the phrase mid-sentence
      `The board via the dashboard`,
      // The product is called "board", so people write the phrase. What keeps
      // ordinary prose out of the 400 is that the line has to END there: a
      // sentence carries on past it, and a signature does not. Loosening this to
      // "contains" would refuse all three.
      `— we agreed this goes via the board and then to Github`,
      `— sent via the board, not by email.`,
      `Ivan answered via the board while I was out`,
      // `&amp;mdash;` RENDERS as those seven characters, so it is text about an
      // entity rather than an em dash. One left-to-right decoding pass is what
      // keeps it out — a second pass would turn it into a refusal.
      `&amp;mdash; ceo@example.com via the board`,
      // Github leaves a reference with no semicolon as written, so this renders
      // as `&mdash ceo@… via the board` and is not the board's line.
      `&mdash ceo@example.com via the board`,
      // Entity-escaped angle brackets are visible text, not a tag: this renders
      // as `<p>— …</p>` with the brackets showing.
      `&lt;p&gt;— ceo@example.com via the board&lt;/p&gt;`,
    ]) {
      expect(carriesForgedFooter(innocent), JSON.stringify(innocent)).toBe(false);
    }
  });

  it('leaves the author’s own budget under Github’s cap, exactly', () => {
    // Derived from the footer rather than written down a second time, so the two
    // cannot drift: what the route admits, signed, is precisely the cap.
    expect(composeComment('x'.repeat(maxAuthorBody(EMAIL)), EMAIL)).toHaveLength(COMMENT_BODY_MAX);
  });
});
