/**
 * The list behind every data picker on the board (#1021), and the shared modal
 * for callers that open a dialog (#1067).
 *
 * Guidelines/Controls/Add & search, "Behind the trigger, you search": a pick that
 * can grow large is a field you type into, never a list you scroll. The kit's
 * whole affordance for that is `AddPicker`, and #1021 used it for add-to-project
 * as it stands. The rest of the board's pickers could not, because `AddPicker`
 * only ADDS: it draws its own `+ Label` trigger where these hang off a property
 * row, a tile's owner or a filter pane; it has no notion of a value that is
 * already on, so it cannot show one or turn it off; it closes after every pick,
 * which makes three labels three opens; and it has no "None" row to clear a
 * single value with. So this is the part of `AddPicker` that fits, composed from
 * the same kit pieces it is composed from, rather than a copy of it: the field,
 * the filter that shortens without reordering (`shouldFilter={false}`, as
 * `AddPicker` does), the arrows, Enter and the empty lines all come from `cmdk`
 * through the kit.
 *
 * #1067/#1077 moved standalone data pickers into a centred `PickDialog`.
 * The reporter reversed that decision for issue labels, milestones and projects
 * in #1094–#1096. Those rows now use `PICK_POPOVER`; other modal callers keep
 * `PickDialog`. Queue filter panes keep their existing enclosing popover.
 *
 * Add-to-project uses `PickList` in the anchored surface as well. The kit's
 * `AddPicker` is no longer drawn here, avoiding its Tab loop (issue #1085 of the old UI kit).
 *
 * Search is on by default, and what decides it is what the set IS, not how long
 * it happens to be: a repo with three labels is one triage away from thirty, and
 * a picker that grew its field at some length would change shape under a reader
 * between two issues. So there are three cases, and only the first two were here
 * before #1199.
 *
 * A set of DATA — labels, people, milestones, boards — is a field you type into,
 * and that is this component's default.
 *
 * A fixed set of WORDS the board itself wrote — the open/closed pill, the map's
 * four orders, the group-by menu — has nothing to grow into and is not a
 * `PickList` at all: it stays a plain `MenuOption` menu in a popover.
 *
 * The third case is the board's WORKFLOW STATES, which is `searchable={false}`.
 * They are a fixed set of words like the second, chosen from a `PickList`
 * because they are a project's data and arrive over the wire like it. What the
 * caller must know is that the set is fixed, and it cannot learn that from the
 * field's name: `FieldEditor` reads the service's `builtInStatus` marker, which
 * is the Status GitHub seeded the project with, however that project has since
 * renamed it (#1199, `project-fields.ts`). Every other single-select field —
 * including one a project called "status" and gave thirty options — is the first
 * case and keeps its field.
 */
import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './kit';
import { CheckIcon, MENU_ROW, MENU_SURFACE, menuRowMark, menuTrigger } from './command-menu';

export interface PickItem {
  /** Unique within the list, and what `onPick` hands back. */
  id: string;
  /** What the field matches, and what the row prints unless `label` is given. */
  name: string;
  /** The value as the page draws it where the name alone is not it: a label's
   *  chip, a field option's tint. */
  label?: ReactNode;
  /** A leading mark, an avatar (Guidelines/Avatars). */
  mark?: ReactNode;
  /** A trailing count, read and never searched. */
  count?: number;
}

/** A row that answers the question without being one of the set: "None",
 *  "Unassigned", "No owner". Its id is never a value's. */
export const PICK_NONE = '__none__';

/**
 * The box a `PickList` sits in, with no inset of its own, so the field's rule
 * runs edge to edge the way it does in `AddPicker`.
 *
 * It was the floating menu surface until #1067 and is the same fill and hairline
 * without the positioning: a `PickDialog` places it, and the kit's dialog is
 * `bg-overlay`, so the hairline is what separates the two (#1019). This is
 * the string `AssignIssueDialog` already wrote for itself when #1021 put the
 * only dialog-borne picker there; it is one constant now.
 */
export const PICK_PANEL = 'overflow-hidden rounded-[11px] border border-line bg-overlay';

/** Anchored picker surface; callers supply its position and width. */
export const PICK_POPOVER = `${MENU_SURFACE} overflow-hidden`;

/**
 * The line under a picker's title: its accessible description and its status
 * line at once, so the dialog draws one paragraph rather than two.
 *
 * Two lines of its own line-height at 1280 and three at a phone width, held
 * whatever the line says, and never empty. A refusal or an empty read then
 * REPLACES a sentence rather than appearing out of nothing and pushing a centred
 * dialog outwards from its middle, which is what #1054 measured on the two
 * dialogs it cut down. Reserving the room with blank space instead is the other
 * half of that trap (#944), so the room is held by a sentence that says something.
 *
 * It is `NewProjectDialog`'s reservation, to the character (#982). The two
 * dialogs are the same type at the same size in the same family, and the review
 * of #1077 found them disagreeing on the number, which is a thing to settle once
 * rather than twice.
 *
 * Two was not enough while this dialog was 384px wide: the single-assign
 * description took three lines against 36px of room, so the read that refuses it
 * a beat later collapsed the dialog 90px. The width is the kit's 512 now (see
 * `PickDialog`), which puts the note at its real 462px, and every sentence any
 * of the ten pickers says fits two lines there. At `max-sm` the dialog is a
 * sheet the width of the screen, the note is 342px, and the same sentence takes
 * three — measured in Chrome, both widths, at rest and in every state a picker
 * can reach.
 *
 * `lh` is the element's computed line-height, so the reservation follows the
 * type rather than a number somebody has to remember to change. It wants
 * Chrome 133, Safari 16.4 or Firefox 120; older engines drop the declaration
 * and the reservation with it.
 *
 * What this does not hold: the two assign notes quote the issue's title, and the
 * board bounds no title. Measured in Chrome against the real note widths, with
 * a title of ordinary words: the single-assign sentence takes two lines at 1280
 * up to a 71-character title and three at 390 up to 85; the several-assign
 * sentence, two at 1280 up to 117 and three at 390 up to 141. Past those it
 * takes one more line and grows the dialog as the sentence lands. Bounding what
 * a dialog quotes is #1054's to make, and #982 left its own on the same terms.
 */
const PICK_NOTE = 'min-h-[2lh] max-sm:min-h-[3lh] text-[12px] leading-[1.5]';

/**
 * What the field says, which is also the list's accessible name. The count is the
 * whole set, as `AddPicker` counts it: it tells the reader whether this is a list
 * they could have scanned or one they have to search. "Search 1 labels" is not a
 * sentence, so below two the noun carries it alone.
 */
export function pickSearchLabel(noun: string, size: number): string {
  return size > 1 ? `Search ${size} ${noun}` : `Search ${noun}`;
}

/** The rows a query leaves, in the order they came. Pure, so the one rule every
 *  picker filters by is asserted in a suite with no DOM. */
export function pickMatches(items: readonly PickItem[], query: string): PickItem[] {
  const needle = query.trim().toLowerCase();
  return needle ? items.filter((item) => item.name.toLowerCase().includes(needle)) : [...items];
}

/**
 * The lines in the list that are not rows: "Loading…", "No labels match.", "No
 * labels to choose from." They take a ROW's vertical metrics — `ROW`'s 18px line
 * box inside the same 5px of padding — so one of them can never be taller than
 * the rows the floor below was measured from.
 *
 * That is not a look, it is the floor's correctness (#1077 review, S2). The
 * measured floor only ever rises, which is what absorbs a SHRINK; a line taller
 * than a row is a GROW, and no floor can absorb one. With a catalog of one item
 * the rows held the list at 42px and this line drew at 47, so typing a letter
 * that matched nothing grew the list 5px and lifted the dialog 2.5px — under the
 * cursor, which is the exact move the reservation exists to prevent. A repo with
 * one label, one assignable person or one board left to add to is ordinary.
 */
export const LINE = 'px-3 py-[5px] text-[12.5px]/[18px] text-muted';
// The board's menu row, on the kit's item: 30px tall like a `MenuOption` (#755),
// so a picker and the fixed menus beside it on one page read at one scale. The
// kit's item already paints where the arrows and the pointer stand as a plate,
// with no outline and no weight (Guidelines/Look/Selection weight).
export const ROW = 'gap-2.5 rounded-[7px] px-2.5 py-[5px] text-[12.5px]/[18px]';
const COUNT = 'ml-auto pl-4 text-[11.5px] tabular-nums text-muted';

/** One `ROW`: 18px of line box inside 5px of padding and the 1px mark border
 *  either side, the height `MenuOption` was measured to in #755. */
const ROW_PX = 30;
/** `CommandList`'s own `p-1`, top and bottom. */
const LIST_PAD = 8;
/** The tallest the list gets before it scrolls, unchanged from #1021. */
const LIST_MAX = 264;
/** What the reading line holds open. Three rows, so a dialog that opens on
 *  `Loading…` does not then jump a screenful when the read lands. It is not a
 *  floor under a list that HAS landed: a two-row set is two rows tall, and a
 *  third row of blank under it is room reserved for nothing. */
const LIST_MIN = 3 * ROW_PX + LIST_PAD;

/**
 * The height a reserved list opens at, from the size of the WHOLE set (#1067).
 *
 * A popover that shortens as you type pushes nothing about: it hangs off its
 * trigger and grows downwards. A centred dialog that shortens moves every row
 * under the reader's cursor, and the empty-result line is a shortening from a
 * full list to one sentence. So a picker in a dialog holds the room its own set
 * asks for, and filtering happens inside it.
 *
 * It is a floor and not a height: a list longer than `LIST_MAX` still scrolls,
 * and `null` (the set is still being read) takes `LIST_MIN`, which is the one
 * case with no rows to measure and nothing else to go on.
 *
 * `ROW_PX` is the plain row, and a row can be taller — a label's chip, the org
 * switcher's second line — so this is the first paint's answer and not the last
 * word. `PickList` measures the list it actually drew and raises the floor to
 * that, which is the half no suite without a DOM can see. Both are here because
 * only one of them is assertable: an arithmetic floor that is never asserted
 * would drift, and a measured one that is never written would leave the first
 * paint with nothing.
 */
export function reservedListHeight(size: number | null): number {
  if (size === null) return LIST_MIN;
  // One row is the floor under the floor. A set that came back empty draws no
  // rows and one `LINE`, which is a row tall, so the room a row asks for is the
  // room that line asks for; reserving 8px for it and measuring the line into
  // the floor afterwards is the same 5px grow S2 found, one state earlier.
  return Math.min(LIST_MAX, Math.max(size, 1) * ROW_PX + LIST_PAD);
}

export function PickList({
  noun,
  listName = noun,
  items,
  lead,
  selected,
  onPick,
  onEmptyBackspace,
  empty,
  reserve = false,
  searchable = true,
}: {
  /** The set, plural and lower case: "labels", "people". */
  noun: string;
  /** Accessible name for an unsearchable list; defaults to `noun`.
   *  Field editors pass the field name. Empty-state copy still uses `noun`. */
  listName?: string;
  /** Off for a fixed set such as workflow states. Focus lands on the list,
   *  which announces `listName`; data pickers leave search on. */
  searchable?: boolean;
  /** `null` while the set is still being read. */
  items: readonly PickItem[] | null;
  /** A `PICK_NONE` row above the set. Searched by its name, never counted. */
  lead?: PickItem;
  /** The ids that are on. Passing it, even empty, is what reserves the check
   *  gutter, for the reason `MenuOption` gives (#755); a picker whose pick
   *  replaces nothing it shows (Assign to) leaves it out. */
  selected?: readonly string[];
  onPick: (id: string) => void;
  /** Backspace in an empty field: the FilterBar pane's way back out. */
  onEmptyBackspace?: () => void;
  /** What the list says where the set came back empty. Defaults to the noun.
   *  A caller says it better where it knows WHY the set is empty. */
  empty?: string;
  /** Hold the room the whole set asks for, so filtering moves nothing —
   *  `reservedListHeight`. On inside a `PickDialog`, off in the FilterBar's
   *  panes, which hang off their own surface and push nothing about. */
  reserve?: boolean;
}) {
  const [query, setQuery] = useState('');
  /** The tallest this list has actually drawn, capped where it starts scrolling.
   *  Written before the paint that would show a shorter one, so filtering to a
   *  single row, or to the no-match line, never shortens the box. It only ever
   *  rises, and a picker is mounted fresh on every open (Radix unmounts a closed
   *  dialog's content), so it cannot carry one set's height onto another's. */
  const [drawn, setDrawn] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // The list's CONTENT, which is its one child, and never the list's own
    // `scrollHeight`: that reports at least the box's height, so it would read
    // back whatever floor is already on it and the floor could only climb.
    const content = reserve ? list.current?.firstElementChild : null;
    if (!content) return;
    const read = () => {
      const box = list.current;
      if (!box || !(content instanceof HTMLElement)) return;
      // `offsetHeight` and not `getBoundingClientRect`, which is transform-aware:
      // the dialog opens through `zoom-in-95`, so a rect read during that frame
      // is the list at 96% and the floor settles a few pixels under the list it
      // is meant to hold open. Layout pixels have no opinion about the scale.
      const pad = getComputedStyle(box);
      const full = Math.min(
        LIST_MAX,
        content.offsetHeight + parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom),
      );
      setDrawn((was) => (full > was ? full : was));
    };
    read();
    // And again whenever the rows really change size, which is not always a
    // render: the first paint lays them out in the fallback face, and the web
    // font landing a frame later grows every row. Only ever upwards, so
    // filtering, which is the shrink this exists to absorb, moves nothing.
    const watch = new ResizeObserver(read);
    watch.observe(content);
    return () => watch.disconnect();
  }, [reserve, items === null]);
  // Say which row is current from the moment the list opens, not from the
  // first arrow key.
  //
  // cmdk fills the listbox's `aria-activedescendant` from its store, and the
  // store only learns which row that is the first time the value CHANGES:
  // `defaultValue` is written straight into the store's initial state and
  // never goes through that path (cmdk@1.1.1). A searchable list is saved by
  // its field, which takes focus and moves the value on mount. This one has no
  // field, so the reader used to land on a listbox that named no current row —
  // "options, list box", and nothing about the value the issue is actually on —
  // until they pressed a key and heard the row they had just moved OFF it.
  //
  // So name that row here, and let cmdk take it from there. It is SET rather
  // than passed because cmdk writes `aria-activedescendant` after the props it
  // is handed, so a prop of that name never reaches the element; and the guard
  // is whether the attribute still names a row of this list, which is true of
  // every id cmdk writes and false of one left behind by a row that has gone.
  // So the first arrow key hands the announcement back to the store and this
  // stops writing, and a pointer can never be left dangling at nothing.
  //
  /** Which ids are on, built once: the initial announcement below and the rows
   *  themselves must not disagree about that. */
  const on = new Set(selected ?? []);
  // `data-pick` is our own row identity, present at DOM commit. `aria-selected`
  // arrives after a cmdk store update, too late for this initial announcement.
  useLayoutEffect(() => {
    const box = list.current;
    if (searchable || !box || !items) return;
    const rows = [...box.querySelectorAll('[data-pick]')];
    const held = box.getAttribute('aria-activedescendant');
    if (held && rows.some((row) => row.id === held)) return;
    // Nothing on is cmdk's own case: with no `defaultValue` it moves the value
    // to the first row on mount, which is the path that does set the attribute.
    const current = (lead ? [lead, ...items] : items).find((item) => on.has(item.id));
    const row = current && rows.find((r) => r.getAttribute('data-pick') === current.id);
    if (row?.id) box.setAttribute('aria-activedescendant', row.id);
  });
  const held = (size: number | null) =>
    reserve ? { minHeight: Math.max(reservedListHeight(size), drawn) } : undefined;
  // The reading line takes the same floor, so the dialog that opens on it is
  // already about the height the list will be.
  if (items === null) return <div className={LINE} style={held(null)}>Loading…</div>;
  const all = lead ? [lead, ...items] : items;
  const floor = held(all.length);
  const shown = pickMatches(all, query);
  const search = pickSearchLabel(noun, items.length);
  return (
    <Command
      shouldFilter={false}
      loop
      // cmdk's `label` names the FIELD: it draws a screen-reader-only
      // `<label for>` pointed at the input's id. With no field there is nothing
      // for it to name — an unsearchable list said its noun into a `for` that
      // resolved to nothing, so the name below is on the list instead.
      label={searchable ? search : undefined}
      // The list opens on the value that is on (#739), not at the top with the
      // reader left to walk back to where they already are.
      defaultValue={all.find((item) => on.has(item.id))?.id}
      className="rounded-none bg-transparent"
    >
      {searchable && <CommandInput
        autoFocus
        value={query}
        onValueChange={setQuery}
        placeholder={search}
        onKeyDown={(e) => {
          if (e.key === 'Backspace' && query === '' && onEmptyBackspace) {
            e.preventDefault();
            onEmptyBackspace();
          }
        }}
      />}
      <CommandList
        ref={list}
        // Where a picker has a field, the field is what the reader enters and
        // what `useDismiss` puts them on. Where it has none, that is this list:
        // it is cmdk's `role="listbox"`, it is where `aria-activedescendant`
        // names the current row (cmdk writes it once the value moves; the
        // effect above writes the first one), and cmdk gives it `tabIndex={-1}`
        // of its own, so it is the one node here that can be focused AND
        // announces both what the reader has landed in and where they are in
        // it. Marking the cmdk root instead put focus on a
        // node with no role and no name, and cmdk moved focus off it on the
        // first arrow key anyway — which left the marked element and the
        // focused element as two different nodes (#1199 review, F2/F3).
        //
        // `label` is cmdk's name for the listbox, whose default is its own
        // "Suggestions"; the searchable path keeps that, because there the name
        // the reader is given is the field's.
        label={searchable ? undefined : listName}
        {...(!searchable ? MENU_ROW : {})}
        className="max-h-[264px] p-1"
        style={floor}
      >
        {/* The board's own line, not the kit's `CommandEmpty` (#1067). Two
            reasons, and the first is the one that matters. `CommandEmpty` is
            drawn off cmdk's filtered count, which is zero on the first paint
            because cmdk has not filtered yet — so every list rendered its rows
            AND this line together for one frame, and the height a dialog
            reserves off that frame reserves room for a line that is about to
            go. The second is that the line is 67.5px of the kit's padding
            where a row is 30, which in a box the rows are holding open reads
            as the list having lost its footing. This list filters itself
            (`shouldFilter={false}`, `pickMatches`), so it already knows. */}
        {shown.length === 0 && (
          <div className={LINE}>{items.length === 0 ? empty ?? `No ${noun} to choose from.` : `No ${noun} match.`}</div>
        )}
        {shown.map((item) => {
          const current = on.has(item.id);
          return (
            <CommandItem
              key={item.id}
              value={item.id}
              // Where a pick leaves the list open, the reader's next keystroke
              // belongs in the field: a press on a row must not take focus out
              // of it, the job `MenuOption`'s mousedown does for its own rows.
              onMouseDown={(e) => e.preventDefault()}
              onSelect={() => onPick(item.id)}
              aria-checked={selected ? current : undefined}
              data-current={current ? '' : undefined}
              // cmdk keeps the value to itself and prints none of it, so the row
              // says which value it is, for a reader of the markup.
              data-pick={item.id}
              className={`${ROW} ${menuRowMark(current)}`}
            >
              {selected && (
                <span className="flex size-3.5 flex-none items-center justify-center">{current && <CheckIcon />}</span>
              )}
              {item.mark}
              {item.label ?? <span className="min-w-0 truncate">{item.name}</span>}
              {item.count !== undefined && <span className={COUNT}>{item.count}</span>}
            </CommandItem>
          );
        })}
      </CommandList>
    </Command>
  );
}

/**
 * The shared modal for assignees and the other dialog callers (#1067).
 *
 * #1067/#1077 moved standalone data pickers into a kit `Dialog` at the reporter's
 * request. Labels and milestones returned to inline pickers by the reporter's
 * decision in #1095/#1096; the remaining modal callers keep the centred dialog
 * with the search field and list inside it, built the way
 * `CloseIssueAlert` and `AssignIssueDialog` were left by #1054: a title, one
 * short line under it, the control, and a footer only where there is something
 * to press.
 *
 * A `Dialog` and not the kit's `CommandDialog`, which was the other candidate
 * and is a centred command palette with a field and a list already in it. Three
 * things decided it. `CommandDialog` has no title, no description and no footer
 * slot, so a multi-select picker with a Save could not be built in it at all.
 * Its accessible name is its placeholder, which is the field's name and not the
 * dialog's. And `AssignIssueDialog` has been a `Dialog` holding a `PickList`
 * since #1021 and the human accepted its shape in #1054, so this is the shape
 * the other modal callers share rather than a second one beside it.
 *
 * A `Dialog` and not an `AlertDialog`, for the line `AssignIssueDialog` draws
 * between the two: every pick here is reversible by picking again, so Escape and
 * the scrim may dismiss this.
 *
 * Radix puts focus on the first thing Tab can reach inside the content,
 * which is the search field, and traps Tab in the dialog, which is what a modal
 * is. Coming out is the half Radix does not do here: a modal `DialogContent`
 * restores focus by handing it to `DialogTrigger`'s element, and every picker on
 * this board is held open from outside and has no trigger, so Escape left focus
 * on `body`. `NewProjectDialog` met the same thing in #982. `trigger` is the box
 * the control sits in, found by the `MENU_TRIGGER` mark the popovers already
 * wore, and `onCloseAutoFocus` puts the reader back on it.
 */
export function PickDialog({
  open,
  onOpenChange,
  showClose = true,
  trigger,
  title,
  note,
  danger = false,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the corner ✕ is drawn. Off while a picker's own write is in
   *  flight, beside the guard that takes Escape and the scrim away: a mark that
   *  looks pressable and answers a press with nothing reads as the dialog being
   *  stuck. `NewProjectDialog` rules the same way on the same two lines (#982).
   *  The kit gives no way to grey it, so this is what there is. */
  showClose?: boolean;
  /** The control this opened from, or the box holding it: whichever wears
   *  `MENU_TRIGGER`. Focus goes back to it on every way out.
   *
   *  Left out where the reader was already standing somewhere real when this
   *  opened: `AssignIssueDialog` is raised a frame after its ⋯ menu has closed
   *  and handed focus back to the handle, and Radix's own restore returns them
   *  there. Naming a trigger there would be naming a second one. */
  trigger?: RefObject<HTMLElement | null>;
  /** What is being picked, in a word or two. The dialog's accessible name. */
  title: string;
  /** The one line under the title: what a pick does, or why the list is not
   *  there. Always says something, and holds two lines whatever it says
   *  (`PICK_NOTE`). */
  note: ReactNode;
  /** The line is a refusal rather than a description. */
  danger?: boolean;
  /** The list, inside the picker's own box. `null` draws no box at all, for the
   *  picker whose read failed: an empty bordered rectangle under a sentence
   *  saying the read did not land is a frame around nothing. */
  children: ReactNode;
  /** A `DialogFooter`, on the pickers that have something to press. */
  footer?: ReactNode;
}) {
  const id = useId();
  return (
    // A modal's clicks are the modal's, and this is where they stop.
    //
    // Radix draws the scrim and the panel into a portal, and React bubbles a
    // portal's events up the tree it was RENDERED in, not the DOM tree it landed
    // in. So without this, a pick inside a picker mounted on a clickable tile
    // also opens the tile, and a press on the SCRIM does the same. The stop sat
    // on `DialogContent` for a while, and it cannot cover the scrim: the scrim is
    // that element's sibling, not its child, so the owner picker had to stop its
    // own clicks a second time on the box around its control.
    //
    // Here it is above both, on the one element every picker's portal is a
    // descendant of, so the next `PickDialog` mounted inside something clickable
    // is covered by construction rather than by somebody remembering (#1077
    // review, S7). `contents` so it draws no box: `Dialog` renders nothing in
    // place, and a wrapper that took a line of the layout would move every
    // caller.
    //
    // `onClick` only. Radix dismisses the scrim on `pointerdown` through its own
    // listener, which this never sees.
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          // The kit's own width, 512, and no narrowing of it. This shipped at
          // `sm:max-w-sm`, 384, on the argument that a list of short rows leaves a
          // wider dialog mostly empty — and the review of #1077 measured what that
          // costs. "+ Add to project" and "+ New project" are two buttons in one
          // row on the issue page and opened a 384 dialog and a 512 one; "Assign
          // to…" and "Close issue…" are two items in one ⋯ menu and did the same;
          // and `AssignIssueDialog` had been 512 since #1021, so narrowing it here
          // was a change to a shipped dialog that nobody asked for. It also put
          // the note at 334px, where the single-assign description takes three
          // lines against the two `PICK_NOTE` reserves. At 512 the note is 462px,
          // which is the width `NewProjectDialog` reserved its two lines against.
          // One width, and the pair reads as one product.
          //
          // `max-sm` is unaffected either way: the kit draws this as a sheet the
          // width of the screen there, and it was 390 wide at both settings.
          showClose={showClose}
          aria-describedby={`${id}-note`}
          // The top layer owns Escape. Radix closes this dialog on its own
          // `document` listener and lets the press carry on, and a surface a
          // picker was raised from may be listening for the same key further
          // up: the phone sheet holding the organization switcher closes on
          // Escape through a `window` listener of its own (`App.tsx`, #608).
          // One press shut both, and the dialog then handed focus back to a
          // trigger the sheet had just carried off-screen and made
          // `visibility: hidden` — which the browser answers by dropping focus
          // to `<body>`. Measured at 390 before this: `#github-organization` at
          // 238ms, `BODY` at 252ms (#1077 review, S4). The second press closes
          // the sheet, from the handle the reader is standing on.
          onEscapeKeyDown={(e) => e.stopPropagation()}
          onCloseAutoFocus={(e) => {
            if (!trigger) return;
            // The mark where the box holds more than the trigger, and the element
            // itself where the caller handed us the control (the add block's
            // button, which is the kit's and wears no mark of ours).
            //
            // Resolved BEFORE the `preventDefault`, so a trigger that is not on
            // the page any more leaves Radix's own restore to run. Taking Radix's
            // half away and then focusing nothing is how focus reaches `<body>`,
            // which is the failure this handler exists to prevent.
            const back = menuTrigger(trigger.current) ?? trigger.current;
            if (!back) return;
            e.preventDefault();
            back.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {/* `aria-live` rather than `role="alert"`: the same element is the
                dialog's description, and a description that claims to be an alert
                is two things at once. `NewProjectDialog` says it that way too. */}
            <p
              id={`${id}-note`}
              aria-live="polite"
              className={`${PICK_NOTE} ${danger ? 'text-danger' : 'text-dim'}`}
            >
              {note}
            </p>
          </DialogHeader>
          {children && <div className={PICK_PANEL}>{children}</div>}
          {footer}
        </DialogContent>
      </Dialog>
    </span>
  );
}
