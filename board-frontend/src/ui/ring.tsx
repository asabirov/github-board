/**
 * Circular progress ring — built as the Projects rollup's completion dial
 * (#174), reused smaller on Unit so the two surfaces read consistently (#277).
 * Size-driven: stroke, radius and the inner label scale off `size`, so one
 * component covers every dial on the board.
 *
 * The rollup went in #785 and its 66px dial went with it. Three rings are drawn
 * on the app today, all under 50px: `BoardHeader` at 38 (`projects/
 * ProjectsView.tsx`), `ProjectRow` at 34 (`projects/ProjectBlock.tsx`) and
 * `ContributionItem` at 30 (`dashboard/ProjectContributions.tsx`). The `size`
 * default below is still 66 and `gapFor` still widens the gap at 50 and up, but
 * the only things reaching either now are `ring.spec.tsx` and the frozen
 * `vouch-variants.tsx` preview — so a change to the big end of the scale is a
 * change nobody on the app will see.
 *
 * Pass `segments` and the closed arc is subdivided per person (#454) instead of
 * painted as one brand run — same arc, same meaning, cut up by whose work it
 * was. Without them (a board with nothing closed yet, or a board-api that
 * predates the field) it falls back to the single arc, unchanged.
 *
 * Butt caps, deliberately. A round cap is a half-disc of the stroke's own width
 * laid on the tangent past each END of the arc, so it both lies about the value
 * and breaks the shape: at 100% the closing cap falls flat across the curve and
 * squares off the top of the circle; at 97% the head cap has already run onto
 * the tail cap, so the last 3% reads as a nick cut into the ring rather than as
 * work left; and at every value the two caps add a stroke's width of arc, which
 * is why anything under ~3% used to render as an identical one-stroke pill.
 * With butt caps the painted arc equals the percentage.
 *
 * Segmentation makes that stricter, not looser: N runs with round caps would add
 * N stroke-widths of arc, and every run's caps would spill over its neighbours'
 * gaps. `butt` is the SVG default, so the rule is about what NOT to add — there
 * is no `strokeLinecap` anywhere below, and none should appear.
 *
 * `withheld` is how a caller says it has no share to state (#722), and it is a
 * separate prop rather than a `pct` of `null` on purpose: the surfaces that draw
 * a board read short still hold the number, and the reason they may not paint it
 * belongs to them, not to an unrepresentable value passed down. Default `false`,
 * so every existing call site renders the same bytes it always did.
 *
 * A withheld ring and a board genuinely at 0% are the same picture, and that is
 * a decision rather than an oversight. Both paint the bare track; the only ink
 * between them is the "0%" a real zero sets in its middle, and its absence reads
 * as a number that failed to render rather than as a board declining to state a
 * share. #763 reported that, #771 recorded it, and Artur accepted it on
 * 2026-09-01 — accepted, not fixed. #771 closes with the PR that added this
 * comment, so read the decision and its date here, not the issue's state.
 *
 * Three treatments were drawn against it and shown to Artur on 2026-08-31, each
 * at 66px and 34px, dark and light, on real cards and rows, cropped beside a
 * genuine 0% board at the same coordinates:
 *
 *   DASHED TRACK   twelve marks round the ring in `--border-strong`. At 34px it
 *                  is the shape a loading spinner uses.
 *   STRUCK RING    one horizontal rule in `--muted`, edge to edge. Reads
 *                  "cancelled" before it reads "no value", and it is the
 *                  heaviest ink in the block.
 *   QUESTION MARK  a "?" in the slot the percentage had. 9px on the row, and "?"
 *                  means "help" everywhere else on the web.
 *
 * Contrast is not why any of them went. Measured against `--surface`, the
 * card's fill and the block's, the dashed
 * track's `--border-strong` is 5.05:1 dark and 5.55:1 light, and the struck
 * rule reads 4.39:1 and 5.56:1 where it crosses the `--border` track —
 * all of them clear of 1.4.11's 3:1, so each was turned down for what it said
 * and not for whether it could be seen. The figures are `test/kit-contrast.ts`
 * arithmetic, the kit's tokens with `src/app.css`'s overrides laid on top; the
 * kit read alone understates every light one (5.00:1 for the dashed track).
 * Nothing re-reads them on a run — the `ring.spec.tsx` check that did went with
 * the mark it measured — and the preview page they were written on went with
 * the rollup in #785, which is why they are here.
 *
 * He turned down all three, and on 2026-09-01, offered both a fourth direction
 * and a designer to draw it, chose to close the issue instead. So a fourth
 * treatment is not wanted here. This was settled, not left.
 *
 * What separates the two states is the accessibility tree and nothing on screen.
 * The svg is `aria-hidden="true"`, so no mark inside it carries the meaning; the
 * sr-only sentence below carries it, and any caller that wraps the ring in an
 * `aria-label` of its own has to repeat that sentence there — today no caller
 * does. `BoardCard` was the one and it went with the rollup in #785. All three
 * that are left take their accessible name from their CONTENTS, so the sr-only
 * span is part of that name instead of being replaced by it: a plain span in
 * `BoardHeader`, an `<a href>` in `ProjectRow`, and a `<button>` carrying
 * `aria-pressed` and no label in `ContributionItem`. Put an `aria-label` on any
 * of those three and the sentence goes silent — which is what `SHARE_NOT_STATED`
 * below is exported for. The track is `--border`, measured at 1.17:1
 * against `--surface` in dark and 1.24:1 in light — that being the fill the
 * card had and the fill the block behind all three surviving rings still has —
 * both under WCAG 1.4.11's 3:1, so as the only painted element it could not
 * have carried the meaning anyway.
 * Known and accepted, then, and not unnoticed. `ring.spec.tsx` pins the two to
 * the same pixels, which is not the same bytes: a genuine 0% emits one extra
 * `<circle>` of zero arc length, and the spec strips it before comparing
 * because it puts no ink on the ring. If you are about to make them differ you
 * are reopening a settled call, and that is a conversation to have before the
 * commit.
 */

/** What a withheld ring says where the percentage stood. Exported because an
 *  `aria-label` on an ancestor REPLACES every name inside it, so a ring inside
 *  one labelled element is inaudible and that caller has to speak this string
 *  itself (#763). One sentence, two speakers.
 *
 *  That grep now turns up no importer, which is the case the sentence standing
 *  here anticipated. `BoardCard` (`projects/ProjectsView.tsx`) was the only such
 *  caller — the Projects card being one labelled button — and it went with the
 *  rollup in #785. NO caller speaks this string today, and none needs to: the
 *  three rings left (`BoardHeader`, `ProjectRow`, `ContributionItem`) are named
 *  by their contents, so the `sr-only` span inside `Ring` is heard.
 *
 *  Kept exported rather than inlined, because the rule above did not go with the
 *  caller: the next surface that wraps a ring in an `aria-label` of its own has
 *  to say this sentence too, and it has to be the SAME sentence. Inlining it now
 *  would mean that caller writing its own. */
export const SHARE_NOT_STATED = 'Share done not stated';

/** One run of the closed arc. `value` is a share, not an angle — runs are
 *  normalised against their own sum, so callers pass raw closed counts. */
export interface RingSegment {
  key: string;
  value: number;
  /** Any CSS colour — the surfaces pass a `var(--seg-…)` token. */
  color: string;
}

/** Space between adjacent runs, so two people's shares read as two runs and not
 *  one long band. A touch wider on the big dial, where 2px on a 7px stroke looks
 *  like a hairline rather than a break. */
const gapFor = (size: number) => (size >= 50 ? 2.5 : 2);

/** The closed arc as painted runs — `{ start, len }` in arc-length along the
 *  circle, plus the colour. One brand run when there's nothing to segment by,
 *  otherwise one run per segment, in the order given. */
function arcRuns(
  segments: RingSegment[] | undefined,
  circ: number,
  clamped: number,
  size: number,
): { key: string; start: number; len: number; color: string }[] {
  const closedArc = circ * (clamped / 100);
  const total = (segments ?? []).reduce((sum, s) => sum + Math.max(0, s.value), 0);
  if (!segments?.length || total <= 0) {
    return [{ key: 'all', start: 0, len: closedArc, color: 'var(--accent)' }];
  }
  const gap = gapFor(size);
  const many = segments.length > 1;
  let at = 0;
  return segments.map((s) => {
    const raw = closedArc * (Math.max(0, s.value) / total);
    const start = at;
    at += raw;
    // A run narrower than the gap would vanish once the gap is cut out of it.
    // Floor it at 2px and accept that a tiny share then reads slightly wide —
    // someone who closed one issue on a busy board should still be on the dial.
    // The floor does NOT apply to a run with no arc to draw: a board whose
    // completion rounds to 0% must paint an empty ring, not a hairline that
    // contradicts the 0% in its middle.
    const len = raw <= 0 ? 0 : Math.max(2, many ? raw - gap : raw);
    return { key: s.key, start, len, color: s.color };
  });
}

export function Ring({
  pct,
  size = 66,
  segments,
  withheld = false,
}: {
  pct: number;
  size?: number;
  segments?: RingSegment[];
  /** Draw the track and NOTHING else — no arc, no label (#722). For a board
   *  whose item read came up short: `pct` is `closed / (open + closed)` over two
   *  undercounts, so unlike either count on its own it can be wrong high OR low
   *  and is not a floor in either direction. A count from such a read survives
   *  with a "+" on it; this one has no honest mark, so it is not drawn.
   *
   *  The empty track and not an absent ring: the row keeps its shape, so a board
   *  that cannot state a share sits in line with the boards that can rather than
   *  reflowing the list around itself.
   *
   *  Nothing is painted differently from a board genuinely at 0%, and that is
   *  the settled answer rather than a gap left open: three treatments were drawn
   *  for #763, all three were turned down, and Artur accepted the ring as it
   *  stands on 2026-09-01 — #771 closes with the PR that added this comment.
   *  What tells the two apart is the sr-only sentence below and nothing on
   *  screen. The file docblock above names the three and why the bare track is
   *  what stands; read it before you change what this prop paints. */
  withheld?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const stroke = Math.max(4, Math.round(size / 9)); // 66→7, 38→4 — arc stays legible when small
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const font = Math.round(size * 0.26); // 66→17, 34→9
  const runs = withheld ? [] : arcRuns(segments, circ, clamped, size);
  return (
    <div className="relative flex-none" style={{ height: size, width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={c} cy={c} r={r} fill="none" strokeWidth={stroke} stroke="var(--border)" />
        {runs.map((run) => (
          <circle
            key={run.key}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            strokeWidth={stroke}
            stroke={run.color}
            strokeDasharray={`${run.len.toFixed(2)} ${(circ - run.len).toFixed(2)}`}
            strokeDashoffset={(-run.start).toFixed(2)}
          />
        ))}
      </svg>
      {/* No label at all when the share is withheld — an empty track under a
          "0%" would be the ring stating the one thing it declined to state, and
          "—" would be a mark a reader has to be taught. The words that stand
          where the percentage stood are spoken and not drawn, the svg above
          being `aria-hidden` (#763); the sentence beside the ring is what says
          why. */}
      {withheld ? (
        <span className="sr-only">{SHARE_NOT_STATED}</span>
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          {/* The clamped value, not the raw prop — the arc has always been drawn
              from `clamped`, so a caller passing 120 painted a full circle under
              the label "120%". */}
          <span
            className="font-bold leading-none tracking-[-0.03em] tabular-nums"
            style={{ fontSize: font }}
          >
            {clamped}%
          </span>
        </div>
      )}
    </div>
  );
}
