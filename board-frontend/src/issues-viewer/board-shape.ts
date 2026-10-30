/**
 * The board's two surfaces, a column well and a card on it, as the class strings
 * the real board and its loading skeleton both draw (#944, #1008).
 *
 * The skeleton used to draw its own full-width bars 4px from the block's edge
 * while the board it stood in for drew cards inside wells, so the two never
 * shared an edge and the page jumped when the rows landed. Both now read these,
 * so they cannot come apart again without one of them stopping importing it.
 */
import { CARD_PADDING } from '../ui/block';

/** A column: a recessed well with a 12px pad around its header and its cards. */
export const BOARD_WELL = 'flex flex-col gap-2.5 rounded-2xl bg-[var(--board-well)] p-3';

/** A card on a column, carrying the one padding every card on the board carries. */
export const BOARD_CARD = `flex flex-col gap-2.5 rounded-[10px] ${CARD_PADDING}`;
