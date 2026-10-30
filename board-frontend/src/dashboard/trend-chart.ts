/**
 * Pure helpers for the Throughput trend chart's hover interaction (#421) — kept
 * out of the SVG component so the "which week, what does the chip say" logic is
 * testable without a DOM. `weeks` is oldest → newest; `ago` counts back from the
 * trailing (newest) week.
 */

/** "this week" for the trailing point, otherwise "N weeks ago".
 *
 *  SPELLED OUT since #708: this said "3w ago" while the repo tile's sparkline
 *  said "3 weeks ago" for the same bucket in the same idiom, which is one
 *  reading in two spellings and nothing else. The board's one chart grammar is
 *  in `docs/charts-answer-when-pointed-at.md`. */
export function weekAgoLabel(ago: number): string {
  if (ago === 0) return 'this week';
  return `${ago} week${ago === 1 ? '' : 's'} ago`;
}

/** What one week of the trend reads, in the board's one chart grammar: WHEN, a
 *  comma, then the hero series before the reference one
 *  (`docs/charts-answer-when-pointed-at.md`). The separator was a colon while
 *  three other charts used three other marks, then an em dash to settle them,
 *  and #818 made it a comma when a reader called the em dash machine-written.
 *
 *  THE PAIR TAKES "and", where the two single-count charts take a second comma.
 *  `this week, 5 closed, 2 opened` puts two commas in one sentence doing two
 *  different jobs — separating the when from the reading, and separating the
 *  two readings from each other — and a reader has to work out which is which.
 *  The conjunction says it instead. This is the one place the grammar splits,
 *  and it splits on whether the chart reports one count or two. */
export function weekTipText(ago: number, closed: number, opened: number): string {
  return `${weekAgoLabel(ago)}, ${closed} closed and ${opened} opened`;
}
