// Pure helpers written for the Projects rollup card (#391, #470, #663): the
// recency reading under a board's name, and what the card said about movement.
//
// #785 DELETED THAT CARD. Every "the card" below names it, in the past tense —
// the sentences are kept as the record of what each state was decided to say,
// and the wording of the two that are still drawn was argued out on the card
// first. What the app still calls: `readShort` (both rings and the board
// header), and `truncatedCountNote`, `joinFailedCountNote`, `staleCopyCountNote`
// and `withheldCountNote` (the shared Projects block's sub-line,
// `ProjectBlock.tsx`). Eight more are held up only by
// `vouch-variants.tsx`, the frozen preview, and three — `floorCount`,
// `truncatedNote`, `joinFailedNote` — have no caller outside `pulse.spec.ts`
// at all. Deleting the dead ones is its own change: the two sentences that
// survive were paired with two of them on purpose, so the pairs' docblocks have
// to be unpicked rather than dropped.

/** First name from a display name or a bare login: "Closed by Artur". */
export function firstName(nameOrLogin: string): string {
  return nameOrLogin.trim().split(/\s+/)[0] || nameOrLogin;
}

/** The recency line as one sentence (#470), dropping a missing half rather than
 *  leaving a dangling word — and '' when neither half is known. */
export function recencyLine(who: string, when: string): string {
  const parts = ['Closed'];
  if (who) parts.push('by', who);
  if (when) parts.push(when);
  return parts.length === 1 ? '' : parts.join(' ');
}

/** What the card says when the API named no close (#488) — the board's lifetime
 *  total decides, not the missing pick. */
export function noCloseNote(closedTotal: number): string {
  return closedTotal === 0 ? 'No issues closed yet' : '';
}

/** What the card says when its figures count issues only (#517). */
export function excludedNote(excluded: number | undefined): string {
  if (!excluded || excluded <= 0) return '';
  return excluded === 1
    ? "1 item on this board isn’t an issue, so it isn’t counted"
    : `${excluded} items on this board aren’t issues, so they aren’t counted`;
}

// ─── The 14-day pulse (#663) ─────────────────────────────────────────────────
// `dailyOpened` / `dailyClosed`: 14 buckets each, oldest first, the last one the
// trailing 24h. The sign convention lives here, once.

/** The trailing 24h net movement of the OPEN count; negative means it fell.
 *  Named for the window and not for a calendar day: the bucket is `pulseSlot`'s
 *  rolling [now-24h, now), which at 07:15 spans two of them. */
export function netLastDay(opened: number[], closed: number[]): number {
  if (!opened.length || !closed.length) return 0;
  return (opened.at(-1) ?? 0) - (closed.at(-1) ?? 0);
}

/** The net as a signed number (#663). It sits under the open count in a column
 *  ~190px wide, so the unit is already said above it and a sentence spelling it
 *  out again is width the board name loses. The sign carries the direction, and
 *  a fall takes U+2212 rather than a hyphen: the minus is cut to the numerals'
 *  weight, where a hyphen reads as a dash between the label and the count.
 *
 *  "in the last 24h" and not "since yesterday": the bucket is `pulseSlot`'s
 *  rolling window [now-24h, now), which at 07:15 spans two calendar days. */
export function deltaNote(net: number): string {
  if (net === 0) return '';
  return `${net < 0 ? '\u2212' : '+'}${Math.abs(net)} in the last 24h`;
}

/** Whether the fortnight has anything to draw — one closed day is enough.
 *
 *  Closes and nothing else, because closes are what `Spark` draws: counting
 *  opens here passed a board that opened issues and closed none, which then drew
 *  a floor, no bars and no words. The opens are on the card as the count's
 *  signed difference. Taking one series rather than ignoring a second parameter
 *  is what keeps the gate and the chart from drifting apart again. */
export function hasPulse(closed: number[]): boolean {
  return closed.some((v) => v > 0);
}

/** `hasPulse`'s complement in words, over the window the source sent (#663). It
 *  speaks for the drawn series alone: a board can open issues all fortnight and
 *  close none, and "nothing opened or closed" would be a lie on that card. */
export function quietNote(closed: number[]): string {
  if (closed.length === 0 || hasPulse(closed)) return '';
  return `No issues closed in the last ${closed.length} days`;
}

/** The tallest CLOSED day across EVERY board on the page, so stacked cards
 *  compare. Over the drawn series only: one board's intake day of 29 against 3
 *  closes put every closed bar on the page on the 2px floor. */
export function pulseScale(boards: { dailyClosed?: number[] }[]): number {
  let max = 1;
  for (const b of boards) {
    for (const v of b.dailyClosed ?? []) if (v > max) max = v;
  }
  return max;
}

/** Whether the SOURCE's own item read on this board came up short (#690).
 *
 *  `itemsComplete` is settled against the `totalCount` Github reports beside the
 *  items: false means the walk read fewer items than that total, or stopped
 *  while Github was still saying there was more. `undefined` is a board-api that
 *  predates the field and makes no claim either way — hence `=== false` and
 *  never a truthiness test, which would read "no claim" as the failure.
 *
 *  Every surface that draws a board asks this ONE function rather than each
 *  spelling the comparison, or — as `BoardCard` did — deriving the state from
 *  whether a sentence came back non-empty. The card, the two rings, the count's
 *  floor mark and the rollup headline are then one gate, and a sentence can be
 *  reworded without silently moving what is withheld. */
export function readShort(itemsComplete: boolean | undefined): boolean {
  return itemsComplete === false;
}

/** Whether the ORG-WIDE issues-to-memberships join behind the pulse figures did
 *  not run (#722). Read on the same terms as `readShort`, and kept apart from it
 *  at every layer: that one says one board's items were read short, this one
 *  says an org-wide read failed and took every board with it. Both can be true
 *  of one board at once, and they are two different sentences. */
export function joinFailed(pulseJoined: boolean | undefined): boolean {
  return pulseJoined === false;
}

/** A count off a board read short, marked as the FLOOR it is (#722).
 *
 *  This is the whole of treatment A, and the asymmetry is the argument for it: a
 *  count from a partial read is wrong in ONE direction — there are at least this
 *  many — so it survives with a "+" on it. `pct` is a ratio of two such counts
 *  and can be wrong high or low, so it is withheld instead (see `Ring`'s
 *  `withheld`). Withholding the counts as well was treatment B, and leaving them
 *  bare under a wider sentence was C; both were rendered and turned down.
 *
 *  The number itself never changes — the "+" is the entire mark. */
export function floorCount(n: number, itemsComplete: boolean | undefined): string {
  return readShort(itemsComplete) ? `${n}+` : `${n}`;
}

/** What the card says under the name when the item read came up short (#663,
 *  #722, #763). It names the cause, and the two marks a reader can see — the
 *  "+" on the counts and a ring with no percentage in it — follow from it.
 *
 *  #763 rewrote it twice. At 103 characters it wrapped to three lines at 390px;
 *  the cut that fixed the wrap read "Counts are floors; the share is left out."
 *  and was turned down for explaining a mark with this repo's word for it.
 *
 *  No actor and no modal, unlike `auth/org-scope-copy.ts`'s sentence for a
 *  partly-read scope: "The board cannot vouch" is the phrasing that wrapped, and
 *  every candidate keeping it measured 240px or more in a 234.0px column.
 *  `check-phone-overflow.mjs` re-measures the wrap at five widths, so a longer
 *  sentence fails there and not here. */
export function truncatedNote(itemsComplete: boolean | undefined): string {
  return readShort(itemsComplete) ? 'Part of this list was not read.' : '';
}

/** The same state as `truncatedNote`, at the size a ROW has (#715): the shared
 *  Projects block gives the week figure one tertiary sub-line, and this is what
 *  it says there.
 *
 *  The card's sentence, minus the full stop. Mid-#763 the two said different
 *  things for one state — the card's shortened to fit 390px while this one kept
 *  "The board cannot vouch for these counts" — and a design review called that
 *  drift. One state at two sizes now means one sentence at two sizes; the STATE
 *  could never differ, both reading `readShort`.
 *
 *  No closing period: the two other things that sub-line ever says — "This week:
 *  2 closed, 3 opened", "Nothing opened or closed this week" — carry none. */
export function truncatedCountNote(itemsComplete: boolean | undefined): string {
  return readShort(itemsComplete) ? 'Part of this list was not read' : '';
}

/** What the card says when the org-wide join did not run (#722) — the third
 *  state, and a smaller claim than `truncatedNote`'s. The board itself was read
 *  whole, so its ring, its percentage and its open count are sound and stay; it
 *  is the week and day figures, which are derived from the join, that are gone.
 *
 *  The card says this OR the read-short sentence, never both: two sentences on
 *  one card is the shape treatment A was chosen against, and the item list is
 *  the larger claim. */
export function joinFailedNote(pulseJoined: boolean | undefined): string {
  return joinFailed(pulseJoined) ? "This week’s closes were not read, so movement is left out." : '';
}

/** `joinFailedNote` at the row's size, paired with it as `truncatedCountNote` is
 *  paired with `truncatedNote` (#722) — one state at two sizes, in one file, so
 *  the state cannot drift. Unlike that pair these two are still the same
 *  sentence long and short, no width having forced them apart.
 *
 *  No closing period, for the reason `truncatedCountNote` carries. */
export function joinFailedCountNote(pulseJoined: boolean | undefined): string {
  return joinFailed(pulseJoined) ? "This week’s closes were not read" : '';
}

/** Whether this board is the LAST-GOOD COPY rather than a read (#713, #770).
 *
 *  True means a write dropped the rollup cache, the read that should have
 *  replaced it failed, and `ProjectsService` served the copy that drop retired
 *  instead of failing the page. The board's own counts, its completion ring and
 *  its contributor list are all from before that write — a close made just now
 *  is not in any of them.
 *
 *  `=== true`, and that is the OPPOSITE spelling from `readShort` and
 *  `joinFailed`, which read `=== false`. Absent is a board-api that predates the
 *  field and makes no claim, and the safe reading of "no claim" runs the other
 *  way here: those two withhold on no claim, and this one would have every board
 *  in the app announce that its numbers are old. */
export function fromLastGoodCopy(lastGoodCopy: boolean | undefined): boolean {
  return lastGoodCopy === true;
}

/** What the row's sub-line says on a board served from the last-good copy
 *  (#770), at the size `truncatedCountNote` and `joinFailedCountNote` have.
 *
 *  It replaces `joinFailedCountNote`'s sentence there, which a retiree inherited
 *  by being served with `pulseJoined: false` — the wire shape #792 ended — and
 *  which is false of it: the closes WERE read, by the copy being served. What
 *  is out of date is the board's own numbers, which is what this says instead.
 *
 *  "the last change" and not "your change": the write that dropped the cache
 *  need not be the reader's, and a sentence that guesses wrong is the thing this
 *  issue exists to stop.
 *
 *  IT IS THE WIDEST THING THIS SUB-LINE EVER SAYS, AND NOTHING GUARDS THAT.
 *  36 characters against the 32 of the sentence it displaces and the 30 of
 *  `truncatedCountNote` — four LONGER than the live one, not inside it, and the
 *  first draft of this comment had that backwards in the flattering direction.
 *  `pulse.spec.ts` pins the ordering so the claim cannot rot again; the WIDTH is
 *  asserted and not measured.
 *
 *  Why not measured, having tried: `check-phone-overflow.mjs` reads
 *  `scripts/fixtures/team-api.json`, which has no board that is a last-good
 *  copy, so this sentence is never on the page it drives. Putting one there is
 *  cheap — flipping the fixture's board 7 to a retiree moved exactly one measured
 *  box, the strip's ring for it, from 217.31px to 292.39px against a 358.00px
 *  content edge — but it buys nothing, because that guard checks CONTAINMENT and
 *  this sub-line wraps rather than overhangs. Grown to 66 characters the item
 *  landed at 358.00px and the run still reported OK, the sentence having taken a
 *  second line inside the ring instead of leaving the block. What would catch it
 *  is the box-height-against-line-height check #763 ran over `truncatedNote` at
 *  five widths and #785 removed with the /projects page. Restoring that shape for
 *  this column is what #787 is about; the fixture was left alone rather than
 *  changed for a measurement with no teeth.
 *
 *  No closing period, for the reason `truncatedCountNote` carries. */
export function staleCopyCountNote(lastGoodCopy: boolean | undefined): string {
  return fromLastGoodCopy(lastGoodCopy) ? 'These counts predate the last change' : '';
}

/** Whether the four joined figures — `weeklyClosed`, `closedThisWeek`,
 *  `dailyOpened` and `dailyClosed` — are off this payload, whatever took them
 *  off (#792). board-api sets it inside the one function that removes them, so
 *  it is true on all three causes the predicates above name — the board read
 *  short, the org-wide join that did not run, the last-good copy — and on any
 *  cause added after them, without a fourth predicate having to be written here
 *  first. Those three answer WHY, and each can only answer for itself.
 *
 *  `=== true`, the same way round as `fromLastGoodCopy` and the opposite of
 *  `readShort` and `joinFailed`. Those two withhold on no claim because
 *  withholding is the safe reading of "nobody said" for them. It is not the safe
 *  reading here: this flag is the one that says the figures are gone, so taking
 *  an absent one for gone would have every board served by a board-api predating
 *  the field — every board in the app, for the length of a deploy window —
 *  refuse to state a week it can state perfectly well. */
export function figuresWithheld(joinedFiguresWithheld: boolean | undefined): boolean {
  return joinedFiguresWithheld === true;
}

/** What the row's sub-line says when the joined figures are gone and nothing on
 *  the payload names a cause (#792), at the size its three siblings have.
 *
 *  It is the only one of the four that cannot name a cause, and that is by
 *  definition: a reader reaching it has been told the figures are gone and
 *  nothing else. So it says the one thing true of every cause there is. Nothing
 *  narrower is safe to say here, and the sentences that read better than this
 *  one all read better by naming something — which is the mistake #770 fixed in
 *  the other direction, a retiree wearing the join's sentence.
 *
 *  "Withheld" and not "missing": a service took them off rather than serve a
 *  number off a read it does not trust, and "missing" reads as a fault in the
 *  board the reader is looking at.
 *
 *  32 characters, the same as `joinFailedCountNote`'s sentence and four shorter
 *  than `staleCopyCountNote`'s 36, so it does not move the ceiling that
 *  comment argues about. `pulse.spec.ts` pins the ordering the same way it pins
 *  that one's, and the width is asserted rather than measured for the reason
 *  recorded there.
 *
 *  No closing period, for the reason `truncatedCountNote` carries. */
export function withheldCountNote(joinedFiguresWithheld: boolean | undefined): string {
  return figuresWithheld(joinedFiguresWithheld) ? "This week’s closes were withheld" : '';
}
