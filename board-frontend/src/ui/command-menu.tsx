/**
 * The shared command-menu primitives (#384) — the calm list/checkbox popover the
 * IssuesViewer's FilterBar and the issue PropertiesPanel editors both draw from,
 * so the two never drift into two different popover looks. Pure presentation +
 * one dismiss hook; no data, no positioning opinion (callers place the panel).
 *
 * The panel lifts the way the kit lifts everything off its ground: the last fill
 * on the ladder and a hairline, and no shadow (#1019). The rows raise on hover
 * and mark the value that is on with a stepped hairline, a weight step and a
 * check, and never with a hue (#1020). Zero brand accent, open or at rest.
 *
 * A menu of DATA is not drawn from these rows any more: labels, people,
 * milestones, a board's options and boards are a `PickList` (`pick-list.tsx`),
 * a search field over the kit's `Command`, inside this same surface (#1021).
 * What stays here is the fixed menus and the hook every popover shares.
 *
 * A row reserves the check gutter only where a check can appear (#755) — see
 * `MenuOption`. The rows that navigate into a sub-pane draw none, so their text
 * starts on the same line as the heading above them.
 */
import { useEffect, useRef, type AriaRole, type ReactNode, type RefObject } from 'react';

/**
 * The floating surface, and how it lifts off the page (#1019): `bg-overlay`
 * and a `border-line` hairline, which is the kit's lift in Guidelines/Look/
 * Surface tone, and no shadow. Position and size are the caller's (append
 * `left-… top-… w-…`).
 *
 * It was `bg-elevated` on a black shadow at .5 and .35. In light that fill
 * is #edeef0, BELOW the page's #f6f7f7 (Surface tone: elevated is "above the
 * ground in dark, below it in light, never an element-and-ground pair"), so the
 * panel sank into the page and the shadow did all of the lifting, darkly.
 * `bg-overlay` is the one step above every ground in both themes, and where
 * it meets a ground already standing there, a card, the hairline carries the
 * step instead.
 */
export const MENU_SURFACE = 'absolute z-30 rounded-[11px] border border-line bg-overlay';

/** The surface with the inset a fixed menu's rows sit in. */
export const MENU_PANEL = `${MENU_SURFACE} p-1.5`;

/** A small tertiary section label inside a menu (e.g. "Filter by", "Label"). */
export const MENU_LABEL = 'px-2.5 py-1.5 text-[11px] font-medium text-muted';

/**
 * The two marks `useDismiss` finds an open menu by (#739), spread onto the
 * elements that wear them rather than typed out at each site.
 *
 * `MENU_ROW` is on every row the arrows should reach. `MenuOption` carries it,
 * so the five callers get it for nothing; a row a caller hand-rolls INTO the
 * same list — the FilterBar's Back row — has to be given it, or the arrows step
 * over it. `MENU_TRIGGER` is on the control that opens the menu, and is where
 * Escape puts the reader back.
 */
export const MENU_ROW = { 'data-menu-row': '' } as const;
export const MENU_TRIGGER = { 'data-menu-trigger': '' } as const;

/** The focus mark on a row, in two halves (#1020).
 *
 *  The PLATE is on `focus`, every time. The hook below moves real focus into the
 *  panel on every open, a mouse press included, and `MenuOption`'s own keydown
 *  reads Space as activation, so a focused row that drew nothing was a row the
 *  next Space committed unseen, and row 0 is a live write on some of these
 *  panels. A plate is what Guidelines/Look/Selection weight lets focus keep:
 *  "both keep a plate, neither takes the weight."
 *
 *  The OUTLINE is on `focus-visible` only, held 2px off the row in
 *  `--accent`, which is that page's rule for focus: "an outline held
 *  2px off the box. Flush, it reads as the hairline above." It lands on the
 *  neighbouring rows' padding, which is where the rule puts it. This is the line
 *  #1020 was about: it was a 2px BRAND ring inside the row on plain `focus`, so
 *  opening a menu with the mouse put focus on the value that is on, and that row
 *  drew as a grey plate in a thick blue ring. That was focus, reading as the
 *  selection, in a hue the selection may never spend.
 *
 *  The fill is `--cmdk-row-active` and not `bg-surface`, which is what it and
 *  the hover both said until #755 measured them on the running build. On the
 *  dark ramp the panel is `--bg-elevated` #252936 and `--surface` is #1f222d,
 *  so hovering a row or arrowing onto it RECESSED it below the panel it sits on
 *  — a step down where the reader is told to expect a step up. Light was fine
 *  (white lifting off #edeef0), which is why it survived two passes over this
 *  file. `--cmdk-row-active` is the answer the ⌘K palette already reached for
 *  the same mistake on the same surface (`app.css`, #347): a translucent delta
 *  that darkens in light and lightens in dark, so one value is right in both. */
const MENU_ROW_FOCUS =
  'focus:bg-[var(--cmdk-row-active)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]';

/**
 * How a row says it is the value that is on (#1020), shared by `MenuOption` and
 * `PickList` so a fixed menu and a data picker on one page agree.
 *
 * Guidelines/Look/Selection weight: "Selection is a surface step plus a weight
 * step, never a hue." The weight step is every variant's, and none of them spends
 * a hue. What #1097 reopened was the surface step — "dropdown selected border is
 * ugly" — and what it settled is that the step is a plate rather than a hairline.
 *
 * Every variant carries a 1px border box whichever way it goes, because `ROW_PX`
 * in `pick-list.tsx` is 30px = an 18px line box + 5px of padding + that border
 * either side. A variant that dropped the border would shorten every row by 2px
 * and move the floor the reserved list is measured against.
 */
export type SelectedRow = 'outline' | 'plate' | 'plate-edge' | 'tick';

/**
 * THE ONE LINE #1097 IS ABOUT, and it is settled: the reporter read the four
 * frames and chose `plate`, in their own words "a filled band, no border".
 *
 * It stays one line, and the other three stay in the map below, because what a
 * later reader needs first is what else was offered and why it was not taken —
 * rebuilding that to reopen the question costs a day, and keeping it costs four
 * strings. Changing this constant draws a different variant everywhere a list
 * marks its selected row, which is `MenuOption` (the Group by menu, the four
 * FilterBar panes) and `PickList` (the Labels picker and the nine other data
 * pickers). #1097 carries all four in both themes: `outline` before, `plate`
 * after, and `plate-edge` and `tick` as they were offered.
 */
export const SELECTED_ROW: SelectedRow = 'plate';

/**
 * The surface step each variant spends, and where the old UI kit already spent it.
 * `plate` is the one that ships; the other three are the offer #1097 made, kept
 * as the record of what was considered and turned down.
 *
 * `outline` is what shipped BEFORE #1097: the kit's `toggleVariants` `frame`
 * treatment, which marks its on state with `data-[state=on]:ring-line-strong`
 * and nothing else. The hairline stepped up from `border-subtle` to
 * `border-strong`. This is the mark the report called ugly.
 *
 * `plate` is the kit's other toggle treatment, `track`, whose on state is
 * `data-[state=on]:bg-surface-2 data-[state=on]:text-fg` over the same
 * `data-[state=on]:font-semibold`. Calendar paints a range band with the same
 * token. No edge at all.
 *
 * `plate-edge` is Calendar's single chosen day: the plate, the weight, the
 * primary ink and `border-selected` as the edge. Calendar spends that edge
 * because its plate cannot answer on an overlay panel, which is the ground these
 * menus stand on too — see `--pick-plate` in `app.css` for why the plate here is
 * not the kit's `--current-bg`.
 *
 * `tick` is the kit's own `DropdownMenuCheckboxItem` and `DropdownMenuRadioItem`:
 * a checked row takes no surface step and no edge, and the indicator in the
 * gutter is the whole of the mark. The weight step is kept, which those two do
 * not have to keep — they draw a 16px tick where this draws a 14px one.
 */
const SELECTED_ROW_STEP: Record<SelectedRow, string> = {
  outline: 'border-line-strong',
  plate: 'border-transparent pick-plate',
  'plate-edge': 'border-accent pick-plate',
  tick: 'border-transparent',
};

export function menuRowMark(current: boolean): string {
  return current
    ? `border ${SELECTED_ROW_STEP[SELECTED_ROW]} font-semibold text-fg`
    : 'border border-transparent text-dim';
}

/** The tick beside a value that is on. In the text colour and not the brand's:
 *  it is part of the selection mark, and the selection is never a hue (#1020). */
export const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="size-3.5 text-fg" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

/** One row: the content, behind a leading check gutter on the rows that can be
 *  selected. Uses `onMouseDown` + preventDefault so a click inside the menu never
 *  blurs the field that owns the popover before the select fires; Enter and Space
 *  come in through `onKeyDown`, which mousedown alone cannot hear (#726).
 *
 *  THE GUTTER IS DRAWN FROM THE PROP'S PRESENCE, not from its value (#755). A
 *  caller that passes `selected` is answering a question about this row, so the
 *  row reserves the 14px the answer needs whichever way it goes. A caller that
 *  passes nothing is not selecting anything — it navigates — and a gutter there
 *  is 24px of indent reserved for a mark that can never appear. The FilterBar's
 *  root pane was six such rows under a heading none of them lined up with.
 *
 *  `selected={false}` and no `selected` at all therefore differ, and that is the
 *  point: a list where one row is on and the rest are off has to keep its text
 *  on one line, so every row in it passes the prop. */
export function MenuOption({
  children,
  onSelect,
  selected,
  role,
  'aria-checked': ariaChecked,
}: {
  children: ReactNode;
  onSelect: () => void;
  selected?: boolean;
  /** ARIA for a menu that announces ONE choice — the Group by menu passes
   *  `menuitemradio` + `aria-checked` (#726). Both default to undefined, so the
   *  multi-select callers go on rendering the plain button they render today. */
  role?: AriaRole;
  'aria-checked'?: boolean;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={ariaChecked}
      // A menu is ONE tab stop, not one per row (#739): leaving the nine-row
      // Assignee pane cost nine Tabs while every row was in the tab order. The
      // hook below moves focus here with the arrows instead, which `-1` still
      // allows — it only takes the row out of the sequential order.
      tabIndex={-1}
      {...MENU_ROW}
      // The mark an opening menu enters on (#739). It comes off `selected` —
      // the one all five callers already set, and the one that draws the check
      // beside it — because `aria-checked` is set by exactly one of them (#726
      // gave it to the Group by menu), so an entry rule reading that found
      // nothing to enter on anywhere else and left every menu on row 0.
      data-menu-selected={selected ? '' : undefined}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      // The keyboard's own path (#726): a button activated by Enter or Space fires
      // `click`, never `mousedown`, so the pointer handler above left these rows
      // unreachable without a mouse. That handler is untouched — its preventDefault
      // is load-bearing (#418) — and there is no `onClick` here, so one press can
      // only fire one of the two. Space is swallowed or it scrolls the page.
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onSelect();
      }}
      // 30px tall: 18px of line box inside 5px of padding and the 1px mark
      // border either side (#755, #1020). It was 34.75px, and none of that was
      // chosen — `text-[12.5px]` sets a size and no line-height, so the row
      // inherited 18.75px from the page and added 8px twice. The sub-panes are
      // the ones that pay: a 220px scroller holds 7 rows at 30 where it held 6.
      // `cursor-default` is written: a row in a menu keeps the arrow
      // (Guidelines/Controls/What the cursor says).
      className={`flex w-full cursor-default items-center gap-2.5 rounded-[7px] px-2.5 py-[5px] text-left text-[12.5px]/[18px] transition-colors hover:bg-[var(--cmdk-row-active)] ${MENU_ROW_FOCUS} ${menuRowMark(
        !!selected,
      )}`}
    >
      {selected !== undefined && (
        <span className="flex size-3.5 flex-none items-center justify-center">{selected && <CheckIcon />}</span>
      )}
      {children}
    </button>
  );
}

/**
 * Whether a pointer event began inside `root`. Prefer the event's `composedPath`
 * (captured at dispatch, before any handler runs) over `root.contains(e.target)`.
 *
 * A `MenuOption`'s `onMouseDown` can synchronously re-render and unmount the very
 * node that was clicked — navigating into a sub-pane (Assignee / Project / State /
 * Type / Timeframe) swaps the root rows for the sub-pane's. React 19 flushes that
 * discrete update synchronously, so by the time this document-level `mousedown`
 * listener runs the clicked node is already DETACHED. `root.contains(detached)`
 * returns false, which read as an outside click and dismissed the menu mid-
 * navigation — leaving every sub-pane filter unreachable (#418). The composed
 * path still holds the stable `root`, so an inside interaction is recognised even
 * after its target detaches. Falls back to `contains` where `composedPath` is
 * unavailable.
 */
export function startedInside(e: Event, root: Node | null): boolean {
  if (!root) return false;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  if (path.length) return path.includes(root);
  return root.contains(e.target as Node);
}

/**
 * Which row a key moves the reader to — the whole arrow-key decision, kept apart
 * from the DOM so it can be pressed in a suite that has none (#739).
 *
 * `current` is the focused row's index, or -1 when focus is anywhere else: the
 * trigger, the FilterBar's input, or `<body>` after a row unmounted itself into a
 * sub-pane. Both ends wrap, which is the WAI-ARIA menu pattern, except that the
 * top of a field-anchored menu gives the field back. `null` means the key is not
 * this menu's, and the caller must leave it alone.
 */
export function menuKeyTarget(
  key: string,
  { current, count, inTextField, fieldAnchored }: {
    current: number;
    count: number;
    inTextField: boolean;
    /** This menu hangs off a text field, so the field is a destination the
     *  arrows can reach — `'trigger'` below. Read off the trigger, never off
     *  whatever holds focus. */
    fieldAnchored: boolean;
  },
): number | 'trigger' | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      // Off the top of a field-anchored menu the reader goes back to the field
      // rather than to the bottom of the list: the FilterBar's arrows were
      // one-way, and typing after them went nowhere.
      if (current === 0 && fieldAnchored) return 'trigger';
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    // Home/End are the caret's keys while the reader is typing — the FilterBar's
    // menu hangs off a text input, and taking them there would strand the caret.
    case 'Home':
      return inTextField ? null : 0;
    case 'End':
      return inTextField ? null : count - 1;
    default:
      return null;
  }
}

/**
 * Which row an opening menu puts the reader on, or `null` for "leave focus where
 * it is" (#739). `checked` is each row's `aria-checked`, in DOM order.
 *
 * `triggerIsTextField` is read off the TRIGGER and never off the focused
 * element. The FilterBar's field is a box around an input: click its search icon
 * or its padding and focus lands on `<body>`, which a rule reading the focused
 * element calls "nobody is typing here" — it would then take the rows and
 * swallow everything the reader typed next.
 *
 * A menu opens ON the row that is on, rather than at the top with the reader
 * left to walk to where they already are. `checked` comes from `MenuOption`'s
 * `selected`, which all five callers set; a menu with nothing on enters at 0.
 */
export function menuEntryIndex(checked: readonly boolean[], triggerIsTextField: boolean): number | null {
  if (triggerIsTextField || checked.length === 0) return null;
  const on = checked.indexOf(true);
  return on < 0 ? 0 : on;
}

/**
 * Whether a menu that has just closed puts the reader back on its trigger.
 *
 * `onRow` is the keyboard's case (#739): the row they stood on, or the field
 * they pressed Enter in, went with the panel. `pressedInside` is the mouse's
 * (#1021): a pick that closes a `PickList` unmounts the search field focus was
 * in, and a row press never takes focus from it. The mouse case asks that focus
 * really was dropped, so a press that put the reader somewhere real stays there.
 * An outside click clears both, because that reader has chosen where to go.
 */
export function returnsOnClose({ onRow, pressedInside, focusLost }: {
  onRow: boolean;
  pressedInside: boolean;
  focusLost: boolean;
}): boolean {
  return onRow || (pressedInside && focusLost);
}

/** The open menu's rows, in DOM order — which is the order the arrows walk. */
function menuRows(root: HTMLElement | null): HTMLElement[] {
  return root ? [...root.querySelectorAll<HTMLElement>('[data-menu-row]')] : [];
}

/** The control this menu hangs off — where Escape and Tab put the reader back,
 *  and what says whether the menu is anchored on a field.
 *
 *  `root` is the box the trigger sits in, or the trigger itself: a `PickDialog`
 *  is handed the wrapper its caller already holds a ref to, and the org
 *  switcher's trigger IS that element. Both spell the mark the same way. */
export function menuTrigger(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  if (root.matches?.('[data-menu-trigger]')) return root;
  return root.querySelector<HTMLElement>('[data-menu-trigger]') ?? null;
}

function isTextField(el: Element | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/** A `PickList`'s search field (#1021). A text field, but not one Tab steps
 *  inside the way it does in a date: it is where a picker's keyboard lives, so
 *  Tab out of it is the leave the Tab branch below exists for, as off a row. */
function isPickField(el: Element | null): boolean {
  return el instanceof HTMLInputElement && el.hasAttribute('cmdk-input');
}

/**
 * The open menu's whole keyboard and pointer contract. Kept under the name five
 * callers and `ViewerControls.spec.tsx` already spell, so the seam that had the
 * `wrap` ref is the seam that grew the keys.
 *
 * Dismissal, unchanged: an outside pointer-down or Escape closes, and the ref
 * wraps trigger+panel so a click on the trigger doesn't self-close.
 *
 * Keys (#739). #726 gave these panels `role="menu"` and their rows
 * `menuitemradio`, which promises a screen reader arrow keys, and nothing was
 * listening for one. ArrowDown/ArrowUp walk the rows and wrap; Home/End reach
 * the ends; Escape closes AND returns the reader to `MENU_TRIGGER`, which it
 * would otherwise leave on `<body>` once the panel unmounted under them.
 *
 * Two things decide where this listens. It is on `document`, not on the panel,
 * because a row that opens a sub-pane unmounts ITSELF and drops focus on
 * `<body>` (#418) — a listener needing focus inside the panel goes dead exactly
 * there, so orphaned focus counts as this menu's while it is the open one. And
 * Escape keeps its old document-wide reach: only the focus RESTORE is
 * conditional, or an Escape pressed elsewhere on the page would yank the reader
 * back here.
 */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void) {
  /** Has this open menu put the reader on a row? Written by the keydown handler
   *  and by the entry effect, read by the repair below — see both. */
  const onRow = useRef(false);
  const entered = useRef(false);
  /** Did the mouse last press inside this open menu? Read by the close, see
   *  `returnsOnClose`. */
  const pressedIn = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!startedInside(e, ref.current)) {
        // Cleared BEFORE the close, or the restore below would yank focus back
        // to the trigger of a menu the reader dismissed by clicking away from it.
        onRow.current = false;
        pressedIn.current = false;
        onClose();
        return;
      }
      // A press inside hands the menu back to the mouse, so what the arrows
      // recorded about where the reader was standing is stale — and acting on it
      // a render later is how focus gets pulled out of a field somebody has just
      // clicked into.
      onRow.current = false;
      pressedIn.current = true;
    };
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const ours = startedInside(e, ref.current) || active === null || active === document.body;
      if (e.key === 'Escape') {
        // Focus BEFORE close, and it is not cosmetic ordering: the FilterBar's
        // input reopens its menu `onFocus`, so the restore has to be the earlier
        // of the two updates for the close to be the one that lands.
        if (ours) menuTrigger(ref.current)?.focus();
        onRow.current = false; // this branch has already done the restore
        pressedIn.current = false;
        onClose();
        return;
      }
      if (!ours) return;
      if (e.key === 'Tab') {
        // The rows are out of the tab order, so ONE Tab already leaves a menu of
        // any length — this is the other half of the pattern: the menu closes
        // behind the reader rather than hanging open over a page they have moved
        // on from. Not prevented, so the browser still does the move; it resumes
        // from the trigger, which outlives the close the focused row does not.
        // Without a trigger to land on there is nothing to resume from, and
        // closing would strand focus on `<body>` — so that menu stays as it was.
        const trigger = menuTrigger(ref.current);
        // Either way the reader has left the rows, so the repair below must
        // disarm — left armed in a menu Tab cannot close, every later render
        // pulls focus back to row 0.
        onRow.current = false;
        pressedIn.current = false;
        // Tab is the caret's key too, the way Home/End are in `menuKeyTarget`:
        // inside `<input type="date">` it steps between day/month/year and fires
        // no blur, so closing here takes the editor away mid-entry (#742). A
        // field-ANCHORED menu is the other case — there the field IS the
        // trigger, and Tab out of it is the leave this branch exists for.
        if (isTextField(active) && active !== trigger && !isPickField(active)) return;
        if (!trigger) return;
        trigger.focus();
        onClose();
        return;
      }
      // A `PickList` walks its own rows (#1021): cmdk moves the highlight on the
      // arrows, Home, End and Enter, and prevents each key it took. Walking the
      // `MENU_ROW`s as well would pull focus out of its field onto a Back row.
      // It still counts as the reader being on the keys, for the close below: a
      // single value picked with Enter unmounts the field it was typed into,
      // and without this the reader was left on `<body>`, not back on the row.
      if (e.defaultPrevented) {
        if (isPickField(active)) onRow.current = true;
        return;
      }
      const rows = menuRows(ref.current);
      const trigger = menuTrigger(ref.current);
      const to = menuKeyTarget(e.key, {
        current: rows.indexOf(active as HTMLElement),
        count: rows.length,
        inTextField: isTextField(active),
        fieldAnchored: isTextField(trigger),
      });
      if (to === null) return;
      e.preventDefault(); // or ArrowDown scrolls the page out from under the menu
      if (to === 'trigger') {
        // Back to the field with the menu still up, so what the reader types
        // next lands in it. `onRow` goes with them: they are no longer on a row.
        trigger?.focus();
        onRow.current = false;
        return;
      }
      rows[to].focus();
      // The effect below cannot see this: moving focus with an arrow key
      // re-renders nothing, so the only record that the reader is walking the
      // rows is the one made here.
      onRow.current = true;
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, ref, onClose]);

  // Where the keyboard lands. Opening a menu from its trigger has to leave the
  // reader INSIDE the panel, or the arrows above have nothing to walk from —
  // except where the trigger is the field you type into, and `menuEntryIndex`
  // holds that decision along with which row a radio menu opens on.
  //
  // No dependency array on purpose: the second branch is a repair, and the thing
  // it repairs (a row unmounting itself into a sub-pane, leaving focus on
  // `<body>`) happens on a re-render while `open` never changes.
  useEffect(() => {
    if (!open) {
      // The exit most readers take is CHOOSING something, and it left them on
      // `<body>` — the panel unmounts, and the row they were standing on goes
      // with it. Escape and Tab restore in their own branches and clear the flag
      // as they go; an outside click clears it too, because a reader who clicked
      // away is not asking to be sent back here.
      const active = document.activeElement;
      const focusLost = !active || active === document.body;
      if (returnsOnClose({ onRow: onRow.current, pressedInside: pressedIn.current, focusLost })) {
        menuTrigger(ref.current)?.focus();
      }
      entered.current = false;
      onRow.current = false;
      pressedIn.current = false;
      return;
    }
    const rows = menuRows(ref.current);
    if (rows.length === 0) return; // a pane still loading — the next render has them
    if (!entered.current) {
      entered.current = true;
      const to = menuEntryIndex(
        rows.map((r) => r.hasAttribute('data-menu-selected')),
        isTextField(menuTrigger(ref.current)),
      );
      if (to === null) return;
      rows[to].focus();
      onRow.current = true;
      return;
    }
    // The repair, and it asks about the READER rather than about focus: focus
    // sitting on `<body>` under a field-anchored menu is just somebody who
    // clicked the field's padding, and pulling them into the rows there is how
    // the search field stops accepting what they type.
    if (onRow.current && (!document.activeElement || document.activeElement === document.body)) {
      rows[0].focus();
    }
  });
}
