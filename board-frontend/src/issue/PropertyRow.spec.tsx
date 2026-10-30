import { describe, expect, it } from 'vitest';
import { PropertyRow, rowKeyPress } from './PropertyRow';

/**
 * The keyboard contract of an issue-page property row (#742).
 *
 * The env is `node` and there is no DOM, so the row is called
 * as a plain function and its returned element is read directly — the same way
 * `ReposPage.spec.tsx` already drives `PropertyRow` for the Retry guard. That is
 * enough for everything here: the row's role, its place in the tab order, the
 * attributes a screen reader reads off it, and what its key handler does with an
 * event it is handed.
 */

type Row = { props: Record<string, unknown> };

const row = (props: Record<string, unknown>): Row['props'] =>
  (PropertyRow({ label: 'Assignees', children: null, ...props } as never) as unknown as Row).props;

/** A key event as the row's handler sees one, with the press landing ON the row. */
function press(key: string, on: unknown = 'the-row') {
  let prevented = false;
  return {
    e: { key, target: on, currentTarget: 'the-row', preventDefault: () => { prevented = true; } },
    get prevented() { return prevented; },
  };
}

describe('an editable property row is a control (#742)', () => {
  it('announces itself as a button and takes a turn in the tab order', () => {
    const p = row({ editable: true, onEdit: () => {} });
    expect(p.role).toBe('button');
    expect(p.tabIndex).toBe(0);
  });

  // `aria-expanded` and NOT `aria-haspopup="menu"`, which this row wore for one
  // round and could not back up: `EditableRow`'s popover is a bare div with no
  // `role="menu"` on it, and for a text/number/date field it is a lone <input>.
  // `aria-expanded` is valid on a `role="button"` and says only what is true.
  it('says whether the thing it opens is open', () => {
    const shut = row({ editable: true, expanded: false, onEdit: () => {} });
    expect(shut['aria-expanded']).toBe(false);
    expect(shut['aria-haspopup'], 'the popover is not a menu').toBeUndefined();

    const open = row({ editable: true, expanded: true, onEdit: () => {} });
    expect(open['aria-expanded']).toBe(true);
  });

  it('carries the mark the menu hook finds its trigger by', () => {
    const p = row({ editable: true, 'data-menu-trigger': '', onEdit: () => {} });
    expect(p['data-menu-trigger']).toBe('');
  });

  it('opens on Enter and on Space, and swallows the browser default', () => {
    for (const key of ['Enter', ' ']) {
      const opened: string[] = [];
      const p = row({ editable: true, onEdit: () => opened.push(key) });
      const k = press(key);
      (p.onKeyDown as (e: unknown) => void)(k.e);
      expect(opened, `${key} did not open the editor`).toEqual([key]);
      expect(k.prevented, `${key} let the browser act as well`).toBe(true);
    }
  });

  // A native button activates Space on keyUP precisely so a held key does not
  // fire over and over. This row activates on keydown, so it needs the guard
  // spelled out: a held Enter must open the editor once.
  it('opens once on a held key, not once per repeat', () => {
    const opened: string[] = [];
    const p = row({ editable: true, onEdit: () => opened.push('x') });
    const first = press('Enter');
    (p.onKeyDown as (e: unknown) => void)(first.e);
    for (let i = 0; i < 4; i++) {
      const again = press('Enter');
      (p.onKeyDown as (e: unknown) => void)({ ...again.e, repeat: true });
    }
    expect(opened).toEqual(['x']);
  });

  it('ignores a key that is not Enter or Space', () => {
    const opened: string[] = [];
    const p = row({ editable: true, onEdit: () => opened.push('x') });
    for (const key of ['a', 'Tab', 'ArrowDown', 'Escape']) {
      const k = press(key);
      (p.onKeyDown as (e: unknown) => void)(k.e);
      expect(k.prevented, `${key} was swallowed`).toBe(false);
    }
    expect(opened).toEqual([]);
  });

  // An editable row contains other interactive things — the Retry <button> the
  // error state draws, and the GitHub profile <a> inside an Assignees value.
  // Enter on Retry activates the button and then bubbles a keydown to the row;
  // without this guard the editor opens on top of the retry, which is exactly
  // what `retryPress` already stops for the CLICK.
  it('leaves a press that landed on something inside it alone', () => {
    const opened: string[] = [];
    const p = row({ editable: true, status: 'error', onEdit: () => opened.push('x'), onRetry: () => {} });
    const k = press('Enter', 'the-retry-button');
    (p.onKeyDown as (e: unknown) => void)(k.e);
    expect(opened).toEqual([]);
    expect(k.prevented).toBe(false);
  });

  // The ring is INSET for the reason `MENU_ROW_FOCUS` already carries: property
  // rows stack with no gap and the row bleeds `-mx-[9px]` to the panel edge, so
  // 2px of outset ring lands on the neighbours. `focus-visible` and not `focus`:
  // the only programmatic focus this row gets is the Escape restore, which
  // follows a key press.
  it('shows an inset brand ring when the keys put focus on it', () => {
    const cls = row({ editable: true, onEdit: () => {} }).className as string;
    expect(cls).toContain('focus-visible:outline-2');
    expect(cls).toContain('focus-visible:-outline-offset-2');
    expect(cls).toContain('focus-visible:outline-[var(--accent)]');
    // The fill is not decoration. `MENU_ROW_FOCUS` carries the reason: the row
    // the keys are on should read as CURRENT, not merely outlined. Without it,
    // focus is the one state on this row that does not raise it — the mouse
    // gets the hover raise and the keyboard gets a line.
    expect(cls, 'focus does not raise the row the way hover does').toContain('focus-visible:bg-elevated');
    // Outset, i.e. an offset class not spelled with the leading `-`.
    expect(cls, 'an outset ring lands on the rows above and below').not.toMatch(/[\s:]outline-offset-/);
    expect(cls, 'a mouse press must not light the row').not.toMatch(/(^|\s)focus:/);
  });

  it('still opens on a click, exactly as it did', () => {
    const opened: string[] = [];
    const p = row({ editable: true, onEdit: () => opened.push('x') });
    (p.onClick as () => void)();
    expect(opened).toEqual(['x']);
  });
});

describe('a read-only property row gains nothing (#742)', () => {
  it('is not a control, is not in the tab order, and hears no key', () => {
    const p = row({});
    expect(p.role).toBeUndefined();
    expect(p.tabIndex).toBeUndefined();
    expect(p.onKeyDown).toBeUndefined();
    expect(p.onClick).toBeUndefined();
    expect(p['aria-haspopup']).toBeUndefined();
    expect(p['aria-expanded']).toBeUndefined();
  });

  it('wears no focus ring and no focus fill, because nothing can focus it', () => {
    const cls = row({}).className as string;
    expect(cls).not.toContain('outline');
    expect(cls).not.toContain('focus-visible');
  });
});

// Pure and exported so the press is asserted without a DOM, the same way
// `retryPress` and `ownerPress` are.
describe('rowKeyPress', () => {
  it('acts only on Enter and Space, and only on the row itself', () => {
    const seen: string[] = [];
    const on = (k: string) => rowKeyPress(
      { key: k, target: 'row', currentTarget: 'row', preventDefault: () => {} },
      () => seen.push(k),
    );
    for (const k of ['Enter', ' ', 'a', 'Escape']) on(k);
    expect(seen).toEqual(['Enter', ' ']);
  });

  it('stands down on a repeat', () => {
    const seen: string[] = [];
    rowKeyPress(
      { key: 'Enter', repeat: true, target: 'row', currentTarget: 'row', preventDefault: () => {} },
      () => seen.push('x'),
    );
    expect(seen).toEqual([]);
  });

  it('does nothing at all with no handler to call', () => {
    expect(() =>
      rowKeyPress({ key: 'Enter', target: 'row', currentTarget: 'row', preventDefault: () => {} }),
    ).not.toThrow();
  });
});
