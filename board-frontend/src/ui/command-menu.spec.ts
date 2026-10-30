import { describe, expect, it } from 'vitest';
import { CheckIcon, MENU_PANEL, MENU_SURFACE, MenuOption, menuEntryIndex, menuKeyTarget, menuTrigger, returnsOnClose, startedInside } from './command-menu';

/**
 * The dismiss-containment regression for #418. The filter menu's sub-pane rows
 * (Assignee / Project / State / Type / Timeframe) navigate on `onMouseDown`,
 * which synchronously re-renders and UNMOUNTS the clicked row before the
 * document-level `mousedown` listener runs. The clicked node is then detached, so
 * the old `root.contains(e.target)` check reported "outside" and dismissed the
 * menu mid-navigation — every sub-pane filter was unreachable. `startedInside`
 * uses the event's `composedPath` (captured at dispatch, immune to the detach).
 *
 * The board's vitest env is `node` (no DOM), so we drive `startedInside` with
 * minimal Node-shaped fakes rather than a real event — enough to lock the
 * decision that the fix hinges on.
 */
function evt(target: unknown, path: unknown[]): Event {
  return { target, composedPath: () => path } as unknown as Event;
}

describe('startedInside — menu dismiss containment (#418)', () => {
  it('treats an in-menu click as INSIDE even after its node detaches (the bug)', () => {
    // The clicked row unmounted itself → root no longer contains it.
    const root = { contains: () => false } as unknown as Node;
    const detached = {} as Node;
    // composedPath, captured at dispatch, still holds the stable root above the target.
    const e = evt(detached, [detached, root, {} /* document */]);
    expect(startedInside(e, root)).toBe(true);
    // The pre-fix logic (contains-only) would have closed the menu here:
    expect((root as Node).contains(detached)).toBe(false);
  });

  it('reports a genuine outside click as OUTSIDE (root absent from the path)', () => {
    const root = { contains: () => false } as unknown as Node;
    const outside = {} as Node;
    const e = evt(outside, [outside, {} /* body */, {} /* document */]);
    expect(startedInside(e, root)).toBe(false);
  });

  it('falls back to contains() when composedPath is empty/unavailable', () => {
    const target = {} as Node;
    const root = { contains: (n: Node) => n === target } as unknown as Node;
    const e = { target, composedPath: () => [] } as unknown as Event;
    expect(startedInside(e, root)).toBe(true);
  });

  it('is inside-safe: null root never counts as inside', () => {
    expect(startedInside(evt({}, [{}]), null)).toBe(false);
  });
});

/**
 * Keyboard activation for a menu row (#726). `MenuOption` reports on
 * `onMouseDown` — deliberately, see #418 — and a native button pressed with Enter
 * or Space fires `click`, never `mousedown`. So a row that answered the keyboard
 * before it drew from this primitive stopped answering it. The env has no DOM, so
 * the row's own handler is called directly, which is the thing the browser would
 * call.
 */
type Handler = (e: { key: string; preventDefault: () => void }) => void;

function rowProps(onSelect: () => void, selected = false): Record<string, unknown> {
  return (MenuOption({ onSelect, selected, children: 'x' }) as { props: Record<string, unknown> }).props;
}

function press(props: Record<string, unknown>, key: string) {
  let prevented = 0;
  (props.onKeyDown as Handler)({ key, preventDefault: () => { prevented += 1; } });
  return prevented;
}

describe('MenuOption keyboard activation (#726)', () => {
  it('selects on Enter and on Space, and swallows the key so Space cannot scroll', () => {
    for (const key of ['Enter', ' ']) {
      let selected = 0;
      const prevented = press(rowProps(() => { selected += 1; }), key);
      expect(selected, `${JSON.stringify(key)} should select exactly once`).toBe(1);
      // Space scrolls the page under an open menu unless the row swallows it.
      expect(prevented, `${JSON.stringify(key)} should be prevented`).toBe(1);
    }
  });

  it('leaves every other key alone', () => {
    for (const key of ['a', 'Tab', 'Escape', 'ArrowDown']) {
      let selected = 0;
      const prevented = press(rowProps(() => { selected += 1; }), key);
      expect(selected, `${key} must not select`).toBe(0);
      // Escape dismisses and Tab moves on — swallowing either would break them.
      expect(prevented, `${key} must not be prevented`).toBe(0);
    }
  });

  it('carries no onClick, so the keydown cannot double-fire with one', () => {
    // Space fires `click` on KEYUP on a native button. An `onClick` added here
    // later would make every Space press select twice; this fails if one appears.
    const props = rowProps(() => {});
    expect(props.onClick).toBeUndefined();
    expect(typeof props.onMouseDown).toBe('function');
  });
});

/**
 * Which row an arrow key moves to (#739). #726 gave these panels `role="menu"`
 * and their rows `role="menuitemradio"`, which promises a screen reader arrow
 * keys; the keys were never wired. The move itself is DOM work the hook does,
 * but the DECISION — from this row, out of this many, with focus here — is a
 * pure function, and this env has no DOM to press a key in.
 *
 * `current` is the index of the focused row, or -1 when focus is anywhere else:
 * the trigger, the FilterBar's input, or `<body>` after a row unmounted itself
 * into a sub-pane. The WAI-ARIA menu pattern wraps at both ends.
 */
describe('menuKeyTarget — arrow-key destinations (#739)', () => {
  const ctx = (current: number, count = 4, inTextField = false, fieldAnchored = false) =>
    ({ current, count, inTextField, fieldAnchored });

  it('ArrowDown enters the menu at the first row when focus is outside it', () => {
    expect(menuKeyTarget('ArrowDown', ctx(-1))).toBe(0);
  });

  it('ArrowUp enters the menu at the last row when focus is outside it', () => {
    expect(menuKeyTarget('ArrowUp', ctx(-1))).toBe(3);
  });

  it('walks down the rows and wraps past the last', () => {
    expect(menuKeyTarget('ArrowDown', ctx(0))).toBe(1);
    expect(menuKeyTarget('ArrowDown', ctx(2))).toBe(3);
    expect(menuKeyTarget('ArrowDown', ctx(3))).toBe(0);
  });

  it('walks up the rows and wraps past the first', () => {
    expect(menuKeyTarget('ArrowUp', ctx(3))).toBe(2);
    expect(menuKeyTarget('ArrowUp', ctx(1))).toBe(0);
    expect(menuKeyTarget('ArrowUp', ctx(0))).toBe(3);
  });

  it('Home and End reach the ends from anywhere', () => {
    expect(menuKeyTarget('Home', ctx(2))).toBe(0);
    expect(menuKeyTarget('End', ctx(1))).toBe(3);
    expect(menuKeyTarget('Home', ctx(0))).toBe(0);
    expect(menuKeyTarget('End', ctx(3))).toBe(3);
  });

  it('leaves Home and End to the caret while the reader is typing in the field', () => {
    // The FilterBar's menu hangs off a text input (`onFocus` opens it), where
    // Home/End are the caret's own keys. The arrows still enter the menu, which
    // is the combobox pattern: only these two belong to the field.
    expect(menuKeyTarget('Home', ctx(-1, 4, true))).toBeNull();
    expect(menuKeyTarget('End', ctx(-1, 4, true))).toBeNull();
    expect(menuKeyTarget('ArrowDown', ctx(-1, 4, true))).toBe(0);
    expect(menuKeyTarget('ArrowUp', ctx(-1, 4, true))).toBe(3);
  });

  it('claims no other key — Enter, Space, Escape and Tab keep their own meanings', () => {
    for (const key of ['Enter', ' ', 'Escape', 'Tab', 'ArrowLeft', 'ArrowRight', 'a']) {
      expect(menuKeyTarget(key, ctx(1)), `${JSON.stringify(key)} is not a menu-walk key`).toBeNull();
    }
  });

  it('answers nothing for an empty menu, so a keypress cannot land on row -1', () => {
    // A sub-pane can render no rows at all (an empty Project list), and a
    // modulo by zero is NaN — which `.focus()` would take as an index.
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(menuKeyTarget(key, ctx(-1, 0)), key).toBeNull();
    }
  });

  it('gives a field-anchored menu its field back from the first row', () => {
    // The FilterBar's arrows were one-way: type `bu`, ArrowDown to a row, and
    // the `g` went nowhere — the only exits were Escape and Tab, which both
    // close the menu. ArrowUp off the top returns to the field with the menu
    // still up, which is the combobox half of the pattern. A button-anchored
    // menu has nothing to type into, so it wraps.
    expect(menuKeyTarget('ArrowUp', ctx(0, 4, false, true))).toBe('trigger');
    expect(menuKeyTarget('ArrowUp', ctx(0, 4, false, false))).toBe(3);
  });

  it('only the FIRST row hands the field back — the rest of the walk is unchanged', () => {
    expect(menuKeyTarget('ArrowUp', ctx(2, 4, false, true))).toBe(1);
    expect(menuKeyTarget('ArrowDown', ctx(3, 4, false, true))).toBe(0);
    // From the field itself ArrowUp still reaches the last row.
    expect(menuKeyTarget('ArrowUp', ctx(-1, 4, true, true))).toBe(3);
  });

  it('walks a single-row menu without moving off it', () => {
    expect(menuKeyTarget('ArrowDown', ctx(0, 1))).toBe(0);
    expect(menuKeyTarget('ArrowUp', ctx(0, 1))).toBe(0);
  });
});

/**
 * The row's half of the keyboard contract (#739). A menu is ONE tab stop, not
 * one per row: leaving the nine-row Assignee pane cost nine Tabs, because every
 * row was a native button in the tab order. The rows take focus programmatically
 * from the hook instead, so they carry `tabIndex={-1}` and a mark the hook can
 * find them by.
 */
describe('MenuOption as a roving-focus row (#739)', () => {
  it('is not a tab stop, so one Tab leaves a menu of any length', () => {
    expect(rowProps(() => {}).tabIndex).toBe(-1);
  });

  it('carries the mark the hook walks the rows by', () => {
    // The hook queries the open panel for these, so a row that does not carry
    // one is a row the arrows skip.
    expect(rowProps(() => {})['data-menu-row']).toBe('');
  });

  it('shows a plate wherever the row has focus, and the outline only under the keyboard (#1020)', () => {
    // The PLATE stays on `focus`, for the reason this assertion was once
    // inverted: the entry effect moves REAL focus on every open, mouse included,
    // and `MenuOption`'s own keydown treats Space as activation, so a focused row
    // that drew nothing was a row the next Space committed unseen. The OUTLINE
    // moved to `focus-visible` (#1020): on plain `focus` it drew a brand ring on
    // the value that is on every time a menu opened under the mouse, which is the
    // grey plate in a thick blue ring the issue was filed about.
    const className = String(rowProps(() => {}).className);
    expect(className).toMatch(/(?<!-)\bfocus:bg-/);
    expect(className).not.toMatch(/(?<!-)\bfocus:outline/);
    // Held 2px off the row in `--accent` (Guidelines/Look/Selection
    // weight): flush, it reads as the selection's hairline, and it is never a hue.
    expect(className).toContain('focus-visible:outline-offset-2');
    expect(className).toContain('focus-visible:outline-[var(--accent)]');
    expect(className).not.toContain('--accent-strong');
  });

  it('marks the value that is on with a plate and a weight step, never a hue (#1020, #1097)', () => {
    const on = String(rowProps(() => {}, true).className);
    const off = String(rowProps(() => {}, false).className);
    // #1097: the reporter chose `plate` — "a filled band, no border" — over the
    // `border-line-strong` hairline this asserted until then. So the surface
    // step is a fill and the edge is spent on nothing.
    expect(on).toContain('pick-plate');
    expect(on).toContain('border-transparent');
    expect(on).not.toContain('border-line-strong');
    expect(on).toContain('font-semibold');
    // WHAT THIS DOES NOT SAY. `pick-plate` is a NAME, and a name that resolves
    // proves nothing about a colour (#1032): this suite has
    // no DOM, no cascade and no theme. What the plate is actually painted, and
    // what it is painted on, is read with `getComputedStyle` in a real browser
    // by `scripts/shoot-1097-variants.mjs` and written down on #1097.
    //
    // Every row carries the border, so the mark moves nothing when it comes on.
    expect(off).toContain('border-transparent');
    expect(off).not.toContain('font-semibold');
    // The tick is part of the mark, so it is in the text colour as well.
    const tick = (CheckIcon() as { props: { className: string } }).props.className;
    expect(tick).toContain('text-fg');
    expect(tick).not.toContain('brand');
  });

  it('marks the row that is on with something the entry rule can read', () => {
    // `menuEntryIndex` used to read `aria-checked`, which ONE caller in five
    // sets (#726 gave it to the Group by menu alone) — so the other four
    // entered on row 0 for want of a signal. `selected` is the mark all five
    // already pass, and it is the one that draws the check glyph.
    expect(rowProps(() => {}, true)['data-menu-selected']).toBe('');
    expect(rowProps(() => {}, false)['data-menu-selected']).toBeUndefined();
  });
});

/**
 * How the popover lifts off the page (#1019). The kit spends a fill step and a
 * hairline on lift (Guidelines/Look/Surface tone) and never a shadow, and this
 * panel was a black shadow at .5 and .35 under a fill that, in light, sat BELOW
 * the page. Read off the constants every popover on the board is drawn from.
 */
describe('the menu surface lifts the way the kit lifts (#1019)', () => {
  it('is the overlay fill on a hairline, with no shadow', () => {
    expect(MENU_SURFACE).toContain('bg-overlay');
    expect(MENU_SURFACE).toContain('border-line');
    expect(MENU_PANEL).toContain(MENU_SURFACE);
    expect(`${MENU_SURFACE} ${MENU_PANEL}`).not.toMatch(/shadow/);
  });

  it('is not the elevated fill, which sits below the page in light', () => {
    expect(MENU_SURFACE).not.toContain('bg-elevated');
  });

  it('still floats, because what is left on it is the menus that hang off a trigger', () => {
    // A data picker took the same fill into a centred dialog in #1067 and left
    // the positioning behind (`PICK_PANEL`). What draws on this now is the fixed
    // menus and the field editors, which are still popovers and still need it.
    expect(MENU_SURFACE).toContain('absolute');
  });
});

/**
 * Where a menu puts the reader back, found by the ONE mark (#1067).
 *
 * `useDismiss` has always read it off the box a popover was drawn in, so the
 * mark sat on a control inside that box. A `PickDialog` is handed the same kind
 * of box by the property rows, the repo tile and the org switcher, and handed
 * the control ITSELF by the add block, whose trigger is the kit's Button and
 * wears no mark of ours. Both have to resolve, or the dialog hands focus back to
 * nothing and the reader lands on `<body>`.
 *
 * DOM-less fakes, as `startedInside` above is driven.
 */
function box(marked: boolean, inside: unknown = null): HTMLElement {
  return {
    matches: (sel: string) => marked && sel === '[data-menu-trigger]',
    querySelector: (sel: string) => (sel === '[data-menu-trigger]' ? inside : null),
  } as unknown as HTMLElement;
}

describe('menuTrigger — the control a menu hands the reader back to (#739, #1067)', () => {
  it('finds the marked control inside the box it was given', () => {
    const control = box(true);
    expect(menuTrigger(box(false, control))).toBe(control);
  });

  it('takes the element itself where that is what wears the mark', () => {
    const control = box(true);
    expect(menuTrigger(control)).toBe(control);
  });

  it('answers nothing for a box holding no marked control, rather than the box', () => {
    expect(menuTrigger(box(false))).toBeNull();
    expect(menuTrigger(null)).toBeNull();
  });
});

/**
 * The check gutter, and which rows pay for it (#755).
 *
 * `MenuOption` drew a 14px box on every row it has ever rendered, and `gap-2.5`
 * after it — so every row's text began 24px right of the row's own padding edge,
 * including the six in the FilterBar's root pane that select nothing and can
 * never fill that box. The heading above them sat at 10px and lined up with
 * neither kind.
 *
 * The rule is the prop's PRESENCE, not its value, and that distinction is the
 * whole fix: `selected={false}` is a row answering "no" to a question about
 * itself, and it keeps the space so its text stays level with the row above that
 * answered "yes". No `selected` at all is a row that was never asked — it
 * navigates — and it draws nothing.
 *
 * Read off the element's children rather than off its className: the gutter is a
 * node, and whether a node is there is a fact this DOM-less env can settle.
 */
function rowChildren(props: Record<string, unknown>): unknown[] {
  return (props.children as unknown[]).filter((c) => c !== false && c != null);
}

/** The gutter is the one child that is an element rather than the row's content. */
function hasGutter(props: Record<string, unknown>): boolean {
  return rowChildren(props).some(
    (c) => typeof c === 'object' && c !== null && 'props' in c
      && String((c as { props: { className?: string } }).props.className ?? '').includes('size-3.5'),
  );
}

describe('the check gutter is reserved only where a check can appear (#755)', () => {
  it('draws no gutter on a row that never passes selected — the row navigates', () => {
    const props = (MenuOption({ onSelect: () => {}, children: 'Assignee' }) as { props: Record<string, unknown> }).props;
    expect(hasGutter(props), 'a navigating row reserves 24px for a mark it can never draw').toBe(false);
  });

  it('draws an empty gutter on a row that passes selected={false}', () => {
    // Not the same as passing nothing. This row is one of a list where another
    // row is on, and dropping its gutter would step its text 24px left of that
    // one's.
    expect(hasGutter(rowProps(() => {}, false))).toBe(true);
  });

  it('draws a filled gutter on the row that is on', () => {
    expect(hasGutter(rowProps(() => {}, true))).toBe(true);
  });

  it('leaves everything the keyboard reads alone whichever way the gutter goes', () => {
    // The gutter is presentation; #726's mark and #739's two are not. A row that
    // lost `data-menu-row` with its gutter is a row the arrows step over.
    const navigating = (MenuOption({ onSelect: () => {}, children: 'x' }) as { props: Record<string, unknown> }).props;
    expect(navigating['data-menu-row']).toBe('');
    expect(navigating.tabIndex).toBe(-1);
    expect(navigating['data-menu-selected']).toBeUndefined();
    expect(typeof navigating.onKeyDown).toBe('function');
    expect(typeof navigating.onMouseDown).toBe('function');
  });
});

/**
 * Which row an opening menu puts the reader on (#739).
 *
 * Two things decide it. A menu anchored on a TEXT FIELD keeps focus in the
 * field, because the field is there to be typed in — and the anchor is read off
 * the trigger, not off whatever happens to hold focus: clicking the FilterBar's
 * search icon or its padding leaves focus on `<body>`, and a rule reading the
 * focused element would call that "nobody is typing here", take the rows, and
 * swallow every keystroke that followed. Everywhere else the reader lands on the
 * row that is ON — the WAI-ARIA radio-menu pattern, so nobody has to walk the
 * list to find where they already are — and on the first row when nothing is.
 */
describe('menuEntryIndex — where an opening menu puts the reader (#739)', () => {
  it('keeps focus in a field-anchored menu, whatever currently holds it', () => {
    expect(menuEntryIndex([false, false, false], true)).toBeNull();
    expect(menuEntryIndex([false, true, false], true)).toBeNull();
  });

  it('enters at the first row when no row announces itself as on', () => {
    expect(menuEntryIndex([false, false, false], false)).toBe(0);
  });

  it('enters at the checked row of a radio menu', () => {
    // The Group by menu is the one caller setting `aria-checked` (#726). Grouped
    // by the fifth dimension, the reader opens ON the fifth row.
    expect(menuEntryIndex([false, false, false, false, true, false], false)).toBe(4);
  });

  it('takes the first of several marked rows rather than guessing between them', () => {
    expect(menuEntryIndex([false, true, true], false)).toBe(1);
  });

  it('has nowhere to put anyone in an empty menu', () => {
    expect(menuEntryIndex([], false)).toBeNull();
    expect(menuEntryIndex([], true)).toBeNull();
  });
});

/**
 * Where a menu that has closed leaves the reader. A mouse pick in Milestone,
 * a board's Status or Priority, or an iteration closes the list and unmounts
 * its field, and focus fell to `<body>` where the base had put it back on the
 * row (#1021 review).
 */
describe('returnsOnClose — where a closing menu leaves the reader (#739, #1021)', () => {
  it('puts a reader who picked with the keys back on the trigger', () => {
    expect(returnsOnClose({ onRow: true, pressedInside: false, focusLost: true })).toBe(true);
  });

  it('puts a mouse pick back on the trigger when focus went with the panel', () => {
    expect(returnsOnClose({ onRow: false, pressedInside: true, focusLost: true })).toBe(true);
  });

  it('leaves a mouse reader wherever their press put focus', () => {
    expect(returnsOnClose({ onRow: false, pressedInside: true, focusLost: false })).toBe(false);
  });

  it('leaves a reader who clicked away from the menu', () => {
    expect(returnsOnClose({ onRow: false, pressedInside: false, focusLost: true })).toBe(false);
  });
});
