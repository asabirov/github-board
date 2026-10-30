/**
 * Every hint on the Repos page, bounded so it wraps.
 *
 * `Tip` is the board's one styled tooltip and is shared by every surface, so it
 * takes no width: a hint is whatever its words are wide. That is fine for the
 * four-word hints elsewhere on the board and wrong here, where a hint is a
 * sentence. Measured at 1280 on a repo wearing the warning border, the open
 * count's hint rendered as ONE 631px line starting at x 166 — the content rail
 * begins at x 272, so the box ran back across the left navigation, and its right
 * edge sat flush against the viewport with no padding at all.
 *
 * The wording is not the problem and does not move: `repos-vm.ts` still owns
 * every word, and a sentence that names the warning border needs the length it
 * has. Only the box is presentational, so only the box is fixed here.
 *
 * This wraps `Tip` rather than being spelled at each call site, so a hint added
 * to this page later cannot be the one that forgets: whatever goes through
 * `Hint` is bounded, and a spec asserts no surface here reaches past it to `Tip`
 * directly.
 */
import type { ReactNode } from 'react';
import { Tip } from '../ui/Tip';

/** Wide enough for a sentence to keep its rhythm, narrow enough that the widest
 *  one cannot reach a page edge from any tile in the grid. `block` is what makes
 *  the bound bite — an inline span would size to its longest unbroken run. */
const HINT = 'block max-w-[260px]';

/**
 * The tighter bound, for a box that opens at a tile's own right edge (#660).
 *
 * Every other hint here hangs under something with a tile's width to either
 * side. The sparkline's figure has none — it is the last thing on its line, and
 * its box is centred under it. Measured live at 1280, dark, first column: the
 * figure's centre is x 478 and the NEXT tile's avatar starts at x 537, so a box
 * wider than 118px covers a different repo's owner, and the unbounded one did
 * (158px, x 399–557, over an avatar at x 537–555). Bounded it is 114px wide at
 * x 421–535, with the two counts on two lines — 2px short of that avatar, and
 * over 14px of the neighbouring card that carry none of its ink (`DELTA_SIDE`,
 * repo-spark.tsx, has that measurement and the reason it is stated in two
 * numbers rather than one).
 */
const NARROW = 'block max-w-[88px]';

export function Hint({
  label,
  side,
  narrow,
  children,
}: {
  label: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Bound the box to `NARROW` — for a trigger with no tile to its right. */
  narrow?: boolean;
  children: ReactNode;
}) {
  return (
    <Tip label={<span className={narrow ? NARROW : HINT}>{label}</span>} side={side}>
      {children}
    </Tip>
  );
}
