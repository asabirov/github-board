/**
 * The order the map is read in (#587), on the right of the controls row.
 *
 * The map drew all 78 repos in one sequence — fullest queue first — and nothing
 * on the page could change it, so a reader who wanted the repos that shipped
 * this week, or the ones carrying alerts, had a page that could not be asked.
 * This is the asking: four orders, and the one in force is what the control
 * rests on.
 *
 * The label is not decoration. It reads off the SAME key the grid is sorted by,
 * so the page cannot name an order the tiles are not in — the fault in the meta
 * line #574 removed, which stated the sort as a fact nobody had chosen and
 * nobody could change.
 *
 * It is quiet on purpose: the tone of `SHOWING` next to it, tertiary text at
 * 11.5px, no border, lifting only under the pointer. The chips answer "which
 * repos"; this answers "in what sequence", which is the smaller question of the
 * two and is drawn as the smaller thing.
 *
 * The chrome is the board's shared command menu — the same panel and rows the
 * owner picker and the IssuesViewer's FilterBar draw — including `useDismiss`,
 * which recognises an inside click through `composedPath` rather than
 * `contains`: React 19 unmounts the pressed row before a document listener
 * runs, and `contains` on a detached node reads as an outside click (#418).
 */
import { useRef, useState } from 'react';
import { MENU_LABEL, MENU_PANEL, MENU_TRIGGER, MenuOption, useDismiss } from '../ui/command-menu';
import { FOCUS_RING } from './controls';
import { REPO_LENSES, type RepoLens, ORDER_LABEL, ORDERS, orderAria, orderTrigger, type RepoOrderKey } from './repos-vm';

/** The resting control: the order in words, and a chevron saying there is more
 *  than one. Same height as a chip so the row's baseline holds, and the same
 *  quiet tone as the count beside it. */
const TRIGGER =
  `inline-flex h-[26px] flex-none cursor-pointer items-center gap-1 rounded-[7px] px-2 text-[11.5px] text-muted hover:bg-elevated hover:text-fg ${FOCUS_RING}`;

/** Right-anchored: the control sits at the end of the row, and a panel opening
 *  leftwards from it stays inside the rail at every width. */
const PANEL = `${MENU_PANEL} right-0 top-[calc(100%+6px)] min-w-[176px]`;

const ChevronIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="size-2.5 flex-none" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

/**
 * The popover's contents, and the whole of what a press on a row does.
 *
 * It took an `onPick` and the picker above wired that to `onOrder` in a closure
 * — which meant the one line joining a row to the grid's order lived inside a
 * component holding hooks, and this board has no DOM to mount one in. Deleting
 * that line left the control inert and the suite green. So the wiring lives
 * here instead, where it is a plain function the spec can call and press, the
 * way `OwnerRow`'s faces are pressed. Nothing about the control changed; what
 * changed is that it is now reachable.
 */
export function OrderMenu({
  orderKey,
  onOrder,
  onClose,
}: {
  orderKey: RepoOrderKey;
  onOrder: (key: RepoOrderKey) => void;
  onClose: () => void;
}) {
  return (
    <div className={PANEL}>
      <div className={MENU_LABEL}>{ORDER_LABEL}</div>
      {ORDERS.map((order) => (
        <MenuOption
          key={order.key}
          selected={order.key === orderKey}
          onSelect={() => {
            onClose();
            onOrder(order.key);
          }}
        >
          <span className="truncate">{order.label}</span>
        </MenuOption>
      ))}
    </div>
  );
}

export function OrderPicker({ orderKey, onOrder, lens, onLens }: {
  orderKey: RepoOrderKey; onOrder: (key: RepoOrderKey) => void;
  lens?: RepoLens; onLens?: (lens: RepoLens) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);

  useDismiss(open, wrap, () => setOpen(false));

  return (
    <span ref={wrap} className="relative flex flex-none">
      <button
        type="button"
        aria-label={lens ? `Repository metric: ${REPO_LENSES.find(item => item.key === lens)!.label}` : orderAria(orderKey)}
        aria-haspopup="menu"
        aria-expanded={open}
        // Where Escape puts the reader back (#739).
        {...MENU_TRIGGER}
        className={TRIGGER}
        onClick={() => setOpen((was) => !was)}
      >
        {lens ? REPO_LENSES.find(item => item.key === lens)!.label : orderTrigger(orderKey)}
        <ChevronIcon />
      </button>
      {open && (lens ? <div className={PANEL} role="menu" aria-label="Repository metric">
        <div className={MENU_LABEL}>Measure</div>
        {REPO_LENSES.map(item => <MenuOption key={item.key} selected={item.key === lens} role="menuitemradio" aria-checked={item.key === lens}
          onSelect={() => { setOpen(false); onLens?.(item.key); }}>{item.label}</MenuOption>)}
      </div> : <OrderMenu orderKey={orderKey} onOrder={onOrder} onClose={() => setOpen(false)} />)}
    </span>
  );
}
