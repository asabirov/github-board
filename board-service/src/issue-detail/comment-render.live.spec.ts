import { describe, expect, it } from 'vitest';
import { commentFooter, composeComment } from './comment-footer';

/**
 * The signature survives what Github actually RENDERS (#693).
 *
 * The rest of this suite reads strings. This one reads pixels, near enough:
 * every body below goes through Github's own `POST /markdown` with `mode: gfm`
 * — the same renderer that draws an issue thread — and the assertion is that
 * the footer is still the FIRST thing the rendered comment draws.
 *
 * It is the only check here that can see the defect it was written for. With
 * the footer appended LAST, all three of these deleted it from the render while
 * every string assertion in this repo stayed green: an unterminated `<!--`
 * opens an HTML block CommonMark runs to end of document and Github's sanitiser
 * then drops whole, an unclosed `<details>` hides what follows behind a toggle,
 * and an unclosed fence demotes it into a code block. Composed the other way up
 * they are three ways of mangling the author's OWN text, which is theirs to do.
 *
 * NETWORK, so it is opt-in and CI does not run it:
 *
 *     GITHUB_MARKDOWN_CHECK=1 pnpm exec vitest run src/issue-detail/comment-render.live.spec.ts
 *
 * `GITHUB_TOKEN` is used when set, for the rate limit only — the endpoint takes
 * anonymous calls and this suite needs no scope at all.
 */
const LIVE = process.env.GITHUB_MARKDOWN_CHECK === '1';

const EMAIL = 'ivan@example.com';

/** Bodies whose LAST construct is left open, which is the whole attack. */
const HOSTILE: Record<string, string> = {
  'an unterminated HTML comment': 'The quota is raised.\n\n<!--',
  'an unclosed details block': 'The quota is raised.\n\n<details><summary>evidence</summary>',
  'an unclosed code fence': 'The quota is raised.\n\n```',
  'a forged line and an unterminated comment': '— ceo@example.com via the boardroom\n\n<!--',
  'ordinary prose': 'The quota is raised.',
};

async function renderOnGithub(text: string): Promise<string> {
  const res = await fetch('https://api.github.com/markdown', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
    body: JSON.stringify({ text, mode: 'gfm' }),
  });
  if (!res.ok) throw new Error(`Github /markdown answered ${res.status}: ${await res.text()}`);
  return res.text();
}

/**
 * The one paragraph Github draws for the board's footer, spelled out rather than
 * found.
 *
 * NO HTML IS PARSED HERE, and that is the point twice over. Reading the render
 * by stripping tags with a regex is the shape CodeQL calls
 * `js/incomplete-multi-character-sanitization` — and it was the weaker assertion
 * anyway, because "the footer is SOMEWHERE in the visible text" is not the
 * property. The property is that the footer is the comment's FIRST block, which
 * is what nothing downstream can reach. A literal built from the address, tested
 * against the head of the render, says exactly that and nothing else.
 *
 * The `mailto` is Github's, not ours: it autolinks a bare address, so this is
 * what it emits — checked against the live endpoint rather than guessed.
 */
const renderedFooter = (email: string): string =>
  `<p>— <a href="mailto:${email}">${email}</a> via the board</p>`;

describe.skipIf(!LIVE)('the signature survives Github’s own renderer (#693)', () => {
  for (const [what, body] of Object.entries(HOSTILE)) {
    it(`leads the render under ${what}`, async () => {
      const rendered = await renderOnGithub(composeComment(body, EMAIL));
      expect(rendered.trimStart().startsWith(renderedFooter(EMAIL)), rendered.slice(0, 200)).toBe(true);
    }, 30_000);
  }

  it('and the same bodies really do delete a TRAILING one', async () => {
    // The floor. Without it, an assertion that had stopped looking at anything
    // would pass every case above. Each of these renders the footer nowhere at
    // all, behind a toggle, or inside a code block — never at the head.
    const trailing = (body: string) => `${body}\n\n${commentFooter(EMAIL)}`;
    for (const body of [
      HOSTILE['an unterminated HTML comment'],
      HOSTILE['an unclosed details block'],
      HOSTILE['an unclosed code fence'],
    ]) {
      const rendered = await renderOnGithub(trailing(body));
      expect(rendered.trimStart().startsWith(renderedFooter(EMAIL)), JSON.stringify(body)).toBe(false);
    }
  }, 30_000);
});
