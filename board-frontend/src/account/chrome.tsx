/**
 * The chrome the Account page's two credential lists share (#456).
 *
 * Personal tokens and connected clients are two lists of the same kind of thing
 * — something holding access to your account — and they sit one above the other,
 * so a reader sees any difference between them as meaning. These three pieces
 * used to live inside `AccountView.tsx`; they moved here when the second list
 * arrived, rather than being copied into it, because a copied surface drifts and
 * the drift shows up as two cards that not-quite-match.
 */

import { relTime } from '../ui/rel-time';

/** The Account page's card surface. (Kept elevated here, unlike the flat
 *  dashboard blocks in #349; flattening AccountView wholesale is a follow-up.) */
export const CARD = 'rounded-2xl border border-line bg-surface shadow-sm';

/** One row inside a card — the separator is a top border, so the first has none. */
export const CARD_ROW = 'flex items-center gap-4 border-t border-line p-[13px_18px] first:border-t-0';

/** A relative stamp from an ISO string, or '' when the string is not a date. */
export function rel(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : relTime(t);
}

export function ScopeChip({ scope }: { scope: string }) {
  return (
    <span className="inline-flex rounded-md bg-elevated px-[7px] py-[2px] font-mono text-[11px] font-semibold text-dim">
      {scope}
    </span>
  );
}
