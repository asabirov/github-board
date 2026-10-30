/**
 * What a keyboard sees on the Repos controls row.
 *
 * Every control the row grew — the search field, its clear button, `All`, the
 * faces and the order control — took Chrome's default focus ring, which is a
 * 1px navy hairline. On this page's `rgb(14,16,21)` that is very nearly
 * invisible: tabbing through the row lost the cursor entirely, on the one
 * surface whose whole job is being asked a question.
 *
 * The sidebar already decided what focus looks like on this board
 * (`app.css`, `.side-item:focus-visible`) — 2px of brand, offset 2. This is
 * that, said in the utilities these components are written in, in one place so
 * five controls cannot drift into five rings.
 *
 * `focus-visible` and not `focus`: a pointer press must not leave a ring behind
 * it, which is the reason the pseudo-class exists.
 */
export const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]';

/** The same ring for a control whose focusable part is a child — the search
 *  field is a borderless input inside the box that draws the field, so the box
 *  wears the ring and the input keeps none of its own. */
export const FOCUS_RING_WITHIN =
  'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--accent)]';

/**
 * The same ring drawn just INSIDE the control rather than around it, for a
 * control that sits in a box which clips.
 *
 * The Queue's column heading is one (#1191): the name is a link now, and the
 * box holding it is `overflow-hidden` on purpose — that is the floor the
 * middle-elide lands on in the frame before it has measured anything, and in
 * jsdom, where it can measure nothing at all. A ring at offset 2 is drawn
 * outside the chip and so outside that box, and measured in Chrome at 1280 the
 * clip left exactly the two corner arcs on screen: a focused name read as a
 * pair of parentheses rather than as a ring.
 *
 * Same 2px, same brand, same `focus-visible` — the offset is negative and
 * nothing else moves, so the ring lands on the chip's own fill and is whole at
 * every column width. Where a control has room around it, `FOCUS_RING` is
 * still the one to use.
 */
export const FOCUS_RING_INSIDE =
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]';
