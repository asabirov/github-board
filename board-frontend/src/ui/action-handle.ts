/**
 * The `···` handle (#948, #964, #973, #1024): the button, the chip it draws and
 * the menu it opens, for every caller of `ActionMenu`.
 *
 * The row carries it. A handle on a card or a row draws nothing until that row
 * is hovered, then shows as a raised chip: `bg-overlay` over a 1px
 * `border-default` edge with the kit's small shadow. The repo page's handle has
 * no row around it, so it keeps its chip at rest. Chosen on 2026-09-11 from the
 * four families drawn for #948, #964, #973 and #1024.
 *
 * Hidden is not unreachable. The button stays laid out and focusable while it
 * is transparent, and it shows whenever something other than a mouse says the
 * reader is at the row: keyboard focus on the button or on anything else in the
 * row, an open menu, and a screen driven by a finger, where there is no hover
 * to wait for.
 *
 * What the choice carries from the round of variants:
 *
 * - The dots are drawn on the pixel grid (`DotsGlyph`): each dot's edges fall
 *   on whole pixels inside a 16px box, and the box is centred in an even chip
 *   inside an even footprint, so no offset along the way is a half pixel.
 * - The chip has an edge and a shadow, not only a fill. `bg-overlay` alone is
 *   1.00:1 on a light card and 1.09:1 on a dark one, which is the shipped
 *   `bg-elevated` mistake over again.
 * - One menu for every caller, with the kit's `zoom-in-95` taken off: a scale
 *   on open is a blur for as long as it runs.
 *
 * The footprints do not move. Callers reserve 24px for `quiet` and 44px for
 * `solid` and `standalone` (the card title's `pr-6`, the repo tile footer's
 * arithmetic, the summary row's 44px column), so the chip is drawn INSIDE that
 * box rather than resizing it. That is why a Feedback row is as tall as it was
 * (#1024): what shrank is the visible square, from 44px to the 32px chip.
 */

/** `quiet` is a handle on a dense surface (board card, list row, repo tile);
 *  `solid` is one on a roomier row (Feedback, the issue summary rows);
 *  `standalone` is one with no row around it to borrow a hover from (the repo
 *  page header). */
export type HandleAppearance = 'quiet' | 'solid' | 'standalone';

export interface HandleLook {
  /** The footprint: the hit target, and what the caller places. */
  button: string;
  /** The visible control, centred in the footprint. */
  chip: string;
  /** The glyph's dot size and spacing, in whole pixels. */
  dot: 2 | 3;
  pitch: number;
}

const BUTTON = 'group/handle flex shrink-0 cursor-pointer items-center justify-center text-fg outline-none';

// Every sign the reader is at the row besides a mouse over it. Both media
// queries, because `pointer: coarse` also catches the touch screens that answer
// `hover: hover`. Focus counts twice: the button's own, and anything else in
// the row, so tabbing onto a card or a Feedback row shows its handle one Tab
// before the handle itself is reached.
const REVEAL = 'opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 group-has-[:focus-visible]:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100';

const CHIP = 'flex items-center justify-center border border-line-strong bg-overlay shadow-sm transition-colors group-hover/handle:border-line-strong group-data-[state=open]/handle:border-line-strong group-focus-visible/handle:outline-2 group-focus-visible/handle:outline-offset-2 group-focus-visible/handle:outline-accent';

export const HANDLE: Record<HandleAppearance, HandleLook> = {
  quiet: { button: `${BUTTON} size-6 ${REVEAL}`, chip: `${CHIP} size-6 rounded-md`, dot: 2, pitch: 5 },
  solid: { button: `${BUTTON} size-11 ${REVEAL}`, chip: `${CHIP} size-8 rounded-lg`, dot: 2, pitch: 5 },
  standalone: { button: `${BUTTON} size-11`, chip: `${CHIP} size-9 rounded-lg`, dot: 3, pitch: 6 },
};

// Both the dropdown and the right-click menu, on every caller. It floats over
// the row it came from, so it keeps the kit's shadow, fade and slide and loses
// only the zoom.
//
// 230px, which the Feedback and repo menus already were. The board card's menu
// asked for `w-52` and was 128px wide, the kit's `min-w-[8rem]`, because the
// kit's spacing scale goes from 48 to 56 and this build generates nothing for
// `w-52`. Its comment said both of its menus were meant to be one width; now
// every menu is.
//
// The `!` on both scale overrides is load-bearing. The kit's menu carries
// `data-[state=open]:animate-in zoom-in-95` in its own stylesheet, and the kit's
// class merge does not know these variables belong to that animation, so a
// plain override sits beside it and loses the cascade: the first round of
// captures measured `enter 0.15s` at scale .95 on every menu.
export const HANDLE_MENU = 'w-[230px] max-w-[calc(100vw-24px)] rounded-lg border-line bg-overlay p-1 shadow-md outline-none data-[state=open]:[--tw-enter-scale:1]! data-[state=closed]:[--tw-exit-scale:1]!';
