/**
 * The issue page's properties-column block chrome (#404), shared by every block
 * in that column — Issue properties, Relations (#469), each Projects v2 board.
 * Extracted so a new block can't drift into its own fill, padding or header
 * treatment: there is one surface and one header here, and the column's blocks
 * all wear them.
 */
import type { ReactNode } from 'react';
import { BLOCK } from '../ui/block';

/** Every panel block shares this fill + padding. `group` is added per board
 *  block so its header remove affordance can reveal on hover. */
export const PANEL_BLOCK = `${BLOCK} px-3.5 py-3`;

/** A block's quiet header — names the block (Issue properties, Relations, or a
 *  board's name) so every block reads as one of a consistent set (#404).
 *  `action` hosts an optional right-aligned control (a board block's remove ×);
 *  its `min-h` keeps a header without one the same height as one with it. */
export function BlockTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-1.5 flex min-h-[20px] items-center justify-between gap-2 text-[13px] font-medium leading-[1.4] text-fg">
      <span className="flex min-w-0 items-center gap-2">{children}</span>
      {action}
    </div>
  );
}
