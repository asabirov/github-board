/**
 * The queue region (#447) — what makes a queue's label, its search field, its
 * controls and the list (or board) under them read as ONE component.
 *
 * Before this, Your work and Unit rendered a queue as a bare `BlockHeader`
 * followed by a surface-less `IssuesViewer`. Every other section on those pages
 * is a filled `BLOCK`, so the page taught the eye that a component is a panel and
 * then handed it a floating label, two chrome islands and a grid of rows. The
 * queue now sits in the canonical `BLOCK` like everything around it.
 *
 * Housing it costs two things, and both live here so they can't drift:
 *
 *  • One left origin. The region carries `CARD_PADDING`, the 16px every card on
 *    the board carries: the label, the field, the view controls, the board's
 *    columns and the list view's text all start 16px in, the same line the flow
 *    strip's tiles start their contents on. The list's rows bleed back out over
 *    the padding so their hover fills run wider than their text (`ListView`'s
 *    `HOUSED_BLEED`); the field's own text sits on the field's 14px.
 *
 *    Until #1008 the region was 4px at the sides and 14px at the top, with every
 *    part carrying a 14px inset of its own so the text lined up at 18px. The text
 *    did line up, but the fills ran out to 4px, and the board's columns sat 6px
 *    from the block's edge. That was the reported fault.
 *  • A tone ramp. The field, the view toggle and the row hover were all
 *    `bg-surface` — the BLOCK's own fill — so inside the block the three would
 *    collapse into one colour and the field would stop reading as a field. The
 *    region carries `queue-housed`, and app.css hangs a three-step interior ramp
 *    on that class. A viewer that is itself the whole page (the Project page)
 *    passes no heading, gets no region, and keeps the old tones untouched.
 */
import { BLOCK, CARD_PADDING } from './block';

/** The region: the canonical block surface, the hook app.css tones against, and
 *  the one card padding. */
export const QUEUE_REGION = `${BLOCK} queue-housed ${CARD_PADDING}`;

/** Intra-queue vertical rhythm. Under the 12px (`mb-3`) that separates two whole
 *  blocks, so proximity reads the parts as one component rather than as neighbours. */
export const QUEUE_GAP = 'mt-2';

/** The Unit page's queue, as a scroll target (#478). The Oldest-open block shows
 *  three of the aging set and hands the rest to this queue, which means it has to
 *  be able to bring it into view. Named here so the anchor and the block that
 *  jumps to it can't drift apart. */
export const UNIT_QUEUE_ID = 'unit-queue';
