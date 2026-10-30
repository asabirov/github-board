/**
 * The words a surface may not say about something the board has not read, plus
 * the two glyphs that say the same thing without words (#613, #650).
 *
 * Not a style list. Each entry is a claim about standing: a repo tile calling an
 * empty queue "clear" and an org notice calling a partly-read scope "fine" are
 * the same mistake, so the sweeps that guard them read one list instead of two
 * copies that drift apart.
 *
 * Swept as a lowercased SUBSTRING, which is deliberately blunt — "unclear" trips
 * on "clear". A sentence that needs one of these words needs different words.
 *
 * Test-only: nothing in the app imports it.
 */
export const REASSURING_WORDS = [
  'clear',
  'healthy',
  'fine',
  'all good',
  'good',
  'clean',
  'safe',
  'nothing wrong',
  '✓',
  '✔',
  '☑',
];

/** The first banned word this sentence contains, or undefined. The one place the
 *  match is defined, so both sweeps agree on what "contains" means. */
export function reassuringWordIn(sentence: string): string | undefined {
  const lower = sentence.toLowerCase();
  return REASSURING_WORDS.find((word) => lower.includes(word));
}
