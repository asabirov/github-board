import { COMMENT_BODY_MAX } from './issue-detail.types';

/**
 * Attribution for comments posted under the shared board credential (#693).
 * Personal credentials already identify the author on GitHub (#1376).
 *
 * DISTINCT FROM THE FEEDBACK FOOTER, and the difference is load-bearing.
 * The old feedback form stamped `Submitted by <address> via the board
 * feedback form.` (`auth/submission-footer.ts`), and three matchers read that line — the parser that cuts a
 * message, the GATE that decides whether a body holds an end user's words, and
 * the search phrase. This line ends at `via the board`, so it matches none of
 * them; `comment-footer.spec.ts` runs all three against it rather than trusting
 * the reading, because a comment footer that made `hasSubmissionFooter` answer
 * true would start hiding issues from the people entitled to read them.
 */
export const commentFooter = (email: string): string => `— ${email} via the board`;

/** A blank line between the board's footer and the author's text, so it reads
 *  as a footer rather than as the first line of their first paragraph. */
export const FOOTER_SEPARATOR = '\n\n';

/**
 * The author's text with the board's footer ABOVE it — what actually goes to
 * Github.
 *
 * THE ORDER IS THE SECURITY PROPERTY, and it is the only thing separating this
 * from a signature the author can delete. Markdown parses forward and several
 * of its blocks run to the end of the document when they are left open: a body
 * ending in an unterminated `<!--` opens an HTML block CommonMark runs to EOF
 * and Github's sanitiser then drops whole, an unclosed `<details>` swallows what
 * follows behind a toggle, and an unclosed fence demotes it into a code block.
 * With the footer LAST, each of those deletes the attribution from the rendered
 * comment while a forged line the author DID write goes on rendering above it —
 * verified against Github's own `POST /markdown`, and the reason this function
 * was inverted. Nothing an author writes can reach BACKWARDS over a block that
 * precedes it, so the footer goes first and nothing downstream can touch it.
 * `comment-render.live.spec.ts` is that proof, and it runs against the live
 * renderer rather than against a reading of the spec.
 */
export function composeComment(bodyMarkdown: string, email: string): string {
  return `${commentFooter(email)}${FOOTER_SEPARATOR}${bodyMarkdown}`;
}

/**
 * How much of `COMMENT_BODY_MAX` is left for the author once the footer is paid
 * for. The cap counts what is SENT — see the route — so this is the number the
 * request body is actually held to, and it is derived from the footer rather
 * than written down twice.
 */
export function maxAuthorBody(email: string): number {
  return COMMENT_BODY_MAX - FOOTER_SEPARATOR.length - commentFooter(email).length;
}

// --- Refusing a forged footer -------------------------------------------------

/**
 * The dashes that read as the board's em dash once drawn. U+2014 is the one the
 * footer uses; U+2012 to U+2015 and U+2212 are the same stroke at another width
 * or from another block, and at 14px in Github's font a reader tells them apart
 * only by looking for the difference.
 */
const FOOTER_DASH = '[\\u2012-\\u2015\\u2212]';

/**
 * Characters that carry no glyph of their own on the line the reader sees:
 * whitespace (`\s` includes the NBSP `&nbsp;` decodes to) and the emphasis,
 * strikethrough and code markers markdown consumes into styling. A footer set
 * in italics is still the footer.
 */
const INVISIBLE = '[\\s*_~`]*';

/**
 * ONE RENDERED LINE shaped like the board's footer.
 *
 * Tested against a line `carriesForgedFooter` has already scanned and decoded,
 * never against source bytes, so `&mdash;`, `&#8212;`, `&#x2014;` and
 * `<p>—…</p>` all reach it as the same line — which is what a reader sees, and
 * what the byte matcher this replaced let through.
 *
 * Case-folded and loose about what sits between the dash and the tail, because
 * this decides a REFUSAL rather than a cut: a shape it misses is a forged
 * attribution that ships, and a shape it catches wrongly is a 400 the author can
 * see and edit around. Tuned for recall, like `GATE_FOOTER_RE` and for the same
 * reason.
 *
 * A QUOTED footer survives it, and the anchor is the whole mechanism: `>` is not
 * one of the invisible characters, so a line Github draws as a quote — its own
 * quote button writes one — never reaches the dash. Replying to an answer by
 * quoting it has to keep working, and `comment-footer.spec.ts` holds that.
 */
const FORGED_FOOTER_RE = new RegExp(
  `^${INVISIBLE}${FOOTER_DASH}.*via the board${INVISIBLE}$`,
  'i',
);

/** HTML character references markdown decodes by name. Only the ones that can
 *  build — or hide — the footer's own characters; anything else is left as
 *  written, because an entity that does not decode is not a forgery. */
const NAMED_REFS: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  horbar: '―',
  minus: '−',
};

/**
 * A reference must end in a semicolon — checked against Github's own renderer,
 * which leaves `&mdash` (no semicolon) as those six characters and decodes
 * `&mdash;`, `&#8212;`, `&#08212;`, `&#x2014;` and `&#X2014;` to one em dash.
 * Requiring it is what keeps `&amp;mdash;`, which RENDERS as the literal text
 * `&mdash;`, out of the refusal: one left-to-right pass turns it into that text
 * and never looks at the result again.
 */
const CHAR_REF_RE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g;

/** Whether a character can open a tag name — `<p`, `</p`. Compared rather than
 *  matched, so nothing in this file is a pattern over HTML. */
const opensTagName = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));

/**
 * The source with its markup skipped, read the way a browser reads it: ONE scan,
 * left to right, over the input, never over its own output.
 *
 * WHY A SCAN AND NOT A REGEX. Stripping tags with `replace` is the shape CodeQL
 * calls `js/incomplete-multi-character-sanitization`, and the shape is the
 * finding: a sweep rewrites the text and the next sweep reads what the last one
 * wrote, so `<<p>p>` gives up its inner tag and hands back the outer one. A scan
 * has no such seam. It never rewrites anything — it copies the characters a
 * reader would see and steps over the ones they would not — so there is no
 * second reading for a nested construct to survive into, at one pass and no
 * bound to get wrong.
 *
 * It agrees with Github on the cases that matter and disagrees with the sweep on
 * the ones that do not. `<p>— …</p>` and `via the b<span></span>oard` come out
 * as the line a reader sees, and are refused. `<<p>p>— …` comes out `<p>— …`,
 * which is not the board's line — and Github draws it as `p>— …`, not as the
 * line either. The sweep refused that one; refusing it was a 400 on prose.
 *
 * An unterminated comment swallows the rest, which is what Github does with it:
 * `<!--` opens an HTML block that runs to the end of the document, so nothing
 * after it is drawn and nothing after it can be a forgery. An unterminated tag
 * is left as the text it renders as.
 */
function withoutMarkup(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '<') {
      out += text[i];
      i += 1;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      i = close === -1 ? text.length : close + 3;
      continue;
    }
    const nameAt = text[i + 1] === '/' ? i + 2 : i + 1;
    const close = opensTagName(text[nameAt]) ? text.indexOf('>', nameAt) : -1;
    if (close === -1) {
      // Not a tag, or one Github never closes: a `<` the reader sees.
      out += '<';
      i += 1;
      continue;
    }
    i = close + 1;
  }
  return out;
}

/**
 * Character references decoded, in ONE left-to-right pass and deliberately not
 * repeatedly: `&amp;mdash;` renders as the literal text `&mdash;`, so
 * decoding the result again would refuse a body Github draws as prose.
 */
function decodeCharRefs(text: string): string {
  return text.replace(CHAR_REF_RE, (whole, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_REFS[name.toLowerCase()] ?? whole;
    const code = Number.parseInt(dec ?? hex!, dec !== undefined ? 10 : 16);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Whether the author's own text carries a line that RENDERS as the board's
 * footer.
 *
 * Measured on the render rather than on the bytes, because that is the standard
 * the refusal is held to: `&mdash; ceo@… via the board` and `<p>— ceo@… via the
 * board</p>` are bytes Github draws as a line pixel-identical to the board's
 * own, and a matcher reading the source accepts both.
 *
 * Line by line, because a rendered line is what a reader compares against the
 * board's own: Github turns a source newline into a `<br>`, so the lines survive
 * the render and a footer on the fourth of them is as convincing as one on the
 * last.
 */
export function carriesForgedFooter(text: string): boolean {
  // Markup is skipped BEFORE anything is decoded, and the order is deliberate:
  // `&lt;p&gt;` renders as the three visible characters `<p>` rather than as a
  // tag, so decoding first would step over text Github draws. Scanning first
  // cannot manufacture a tag that was not written.
  return decodeCharRefs(withoutMarkup(text))
    .split('\n')
    .some((line) => FORGED_FOOTER_RE.test(line));
}
