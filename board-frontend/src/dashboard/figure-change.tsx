/**
 * How an Overview figure moved against the period before it, coloured by
 * whether that is good news (#1029).
 *
 * `ui/changed-figure.tsx` refuses to colour a move, and says why: the flow
 * strip is one component drawing three tiles and is handed no opinion about
 * any of them. This is the case it could not serve. The caller says which way
 * is better, so the colour can say better or worse rather than up or down —
 * more closed is better, a longer lag is worse. A figure with no better
 * direction is drawn in quiet ink.
 *
 * THE SIGN ALWAYS CARRIES THE DIRECTION, so colour is never the only thing a
 * reader who cannot tell the green from the red has to go on. Which direction
 * is good is a fact about the figure, not about this reading, so it needs no
 * second mark. The minus is U+2212, the one Org lag drew before this.
 *
 * THE DIRECTION IS NOT THE REFERENCE PERIOD, and until #1170's review the card
 * only ever said the second one in the caption it retired. A reader who hears
 * the page was left with "9 closed +6" and nothing to measure `+6` against.
 * #1329 also removes the visible period labels; the sign still says direction
 * but cannot name a reference period. So the delta SPEAKS that period and
 * draws none of it — `against` below, which every call site has to say.
 *
 * The decision is `figureChange`, a pure function, because the frontend suite
 * has no DOM and a function is what it can drive.
 */

/** Which way is good news for a figure, or `null` when neither is. */
export type Better = 'up' | 'down' | null;

export type Tone = 'better' | 'worse' | 'neutral';

export interface Change {
  text: string;
  tone: Tone;
}

/** The signed amount and its tone. `format` draws the magnitude, so Org lag can
 *  keep its own rounding; zero is `±0` and neutral whichever way is better. */
export function figureChange(delta: number, better: Better, format: (n: number) => string = String): Change {
  if (delta === 0) return { text: '±0', tone: 'neutral' };
  const text = `${delta > 0 ? '+' : '−'}${format(Math.abs(delta))}`;
  if (better === null) return { text, tone: 'neutral' };
  return { text, tone: (delta > 0) === (better === 'up') ? 'better' : 'worse' };
}

/** The kit's status inks. Each clears 4.5:1 on the card in both themes, which
 *  `figure-change.spec.ts` measures rather than this comment claiming it. */
export const TONE_CLASS: Record<Tone, string> = {
  better: 'text-success',
  worse: 'text-danger',
  neutral: 'text-dim',
};

/**
 * The whole of what the delta says out loud: the signed amount, and the period
 * it is measured against.
 *
 * One string and not two halves joined at the call site, so the sentence a
 * reader hears has one place it is written and one copy-gate row. `against` is
 * the reference period — "7 days", "90 days" — independent of the retired
 * visible labels.
 */
export function changeAgainst(text: string, against: string): string {
  return `${text} compared with the previous ${against}.`;
}

/**
 * The change, drawn small beside the figure it is about, and SPOKEN with the
 * period it is measured against.
 *
 * The drawn number is `aria-hidden` and the spoken sentence carries it again,
 * rather than the number being read and then qualified: a reader who hears
 * both meets "+6" twice for one delta.
 *
 * Said as text inside the span and NOT as an `aria-label` on it. A `<span>` is
 * `role="generic"`, which ARIA 1.2 prohibits from carrying a name at all, so an
 * `aria-label` here is a sentence whose delivery depends on the reader. This
 * repo settled the same question the other way round once already — `ui/ring.tsx`
 * keeps its sentence in an `sr-only` span for #763 and warns that an ancestor's
 * `aria-label` would REPLACE it. Contents are what is heard here.
 */
export function FigureChange({ change, against }: {
  change: Change;
  /** The period the delta is measured against. Written without a `?` so no
   *  call site can leave the reader
   *  with a bare number: the caption that used to name the period is the one
   *  #1170 retired. */
  against: string;
}) {
  return (
    // `data-figure-change` is how `scripts/check-heard-copy.mjs` finds
    // every delta on the page, so a fourth one added without a period to
    // measure against is a red run rather than a silent one. Nothing styles it.
    <span data-figure-change className={`ml-1 text-[12px] font-semibold tabular-nums ${TONE_CLASS[change.tone]}`}>
      <span aria-hidden="true">{change.text}</span>
      <span className="sr-only">{changeAgainst(change.text, against)}</span>
    </span>
  );
}
