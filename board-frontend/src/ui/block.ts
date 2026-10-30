/**
 * The one canonical dashboard block surface (#349).
 *
 * A quiet filled panel — no border, no shadow — set apart from the page canvas by
 * its fill alone. Borders and shadows are reserved for meaning (warning banners,
 * recessed kanban wells), per the board's less-borders house rule. Before this,
 * three copies of a `border + shadow-sm` CARD (Cockpit, Pulse, IssueQueue) drifted
 * from the Oldest-open block's flat wrapper, so some blocks sat raised and others
 * flat on the same page. Everything now shares this constant so they can't
 * diverge again. That block itself came off the board in #815, which changes
 * nothing here: the drift it was the reference for is what this ended, and the
 * flow strip's tiles are built from this same constant.
 *
 * Because the fill is the only thing separating a block from the page, the theme
 * ramp owes it a real step between `--surface` and `--surface-2` (app.css). In
 * light those two once sat at 1.07:1 and a block's edge disappeared (#491); the
 * canvas was deepened rather than giving the block a shadow, so this constant
 * stays one surface in both themes instead of one that lifts in light only.
 */
export const BLOCK = 'rounded-xl bg-surface';

/**
 * The one inner padding a card on the board carries, loaded or loading: 16px on
 * every side (#944, #1008).
 *
 * It was already the board card's padding (#997) and the flow strip tiles'. The
 * rest each had a value of their own: Feedback 24px, Throughput 20px, the queue
 * block 4px at the sides and 14px at the top (its columns came within 6px of its
 * edge), the Projects strip 20px by 14px, the oldest-issue tile 13px top and
 * bottom, the Crew cards 12px, and the skeletons 20px. Blocks stacked on one page
 * started their contents on different lines. They all carry this now.
 *
 * A list whose rows light up on hover (Feedback, the housed queue's list view)
 * keeps its TEXT on this line and lets the row's hover fill bleed back out over
 * the padding, so what a reader sees at rest lines up with every other block.
 */
export const CARD_PADDING = 'p-4';
