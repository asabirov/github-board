/**
 * When a click on a repo tile opens that repo's queue (#558) — kept DOM-free so
 * the rule is assertable on its own.
 *
 * The tile is convenience, not semantics: the real link sits on the repo NAME,
 * and this decides whether a click that landed anywhere else on the card should
 * follow it. Two clicks never do — one a modifier claimed (the browser's own
 * new-tab / new-window / download gestures belong to the browser), and one a
 * control inside the tile already handled, which never reaches here at all
 * because that control stops the click propagating.
 */
export interface ClickLike {
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  button: number;
}

export function tileOpens(e: ClickLike): boolean {
  if (e.defaultPrevented) return false;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  return e.button === 0;
}
