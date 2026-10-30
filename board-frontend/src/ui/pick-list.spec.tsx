// #1021 — every data picker on the board is a search field over its values.
// #1067 — and a standalone one opens that field in a centred modal.
//
// The suite has no DOM, so nothing here types, presses an
// arrow or picks: that is cmdk's, through the kit, and it was checked in a
// browser. Nor does anything here render a `PickDialog`, which draws into a
// portal static markup never enters — the same reason `CloseIssueAlert` splits
// `CloseReasonChoices` out and `NewProjectDialog` splits `NewProjectFields`.
// What is asserted is the filter every picker shares, what the field says, the
// markup a picker opens on — which row leads, which rows are on, and how "on"
// is drawn (#1020) — and the arithmetic behind the room a dialog holds open.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LINE,
  PICK_NONE,
  PICK_PANEL,
  PickList,
  ROW,
  pickMatches,
  pickSearchLabel,
  reservedListHeight,
  type PickItem,
} from './pick-list';

const LABELS: PickItem[] = [
  { id: 'bug', name: 'bug' },
  { id: 'deploy', name: 'deploy' },
  { id: 'ui', name: 'UI polish' },
];

/** Each row's opening tag, in DOM order. */
function items(html: string): string[] {
  return html.match(/<div[^>]*\bcmdk-item=""[^>]*>/g) ?? [];
}

describe('what a query leaves (#1021)', () => {
  it('matches anywhere in the name, whatever the case', () => {
    expect(pickMatches(LABELS, 'POL').map((i) => i.id)).toEqual(['ui']);
    expect(pickMatches(LABELS, 'u').map((i) => i.id)).toEqual(['bug', 'ui']);
  });

  it('shortens the list and never reorders it', () => {
    expect(pickMatches(LABELS, 'e').map((i) => i.id)).toEqual(['deploy']);
    expect(pickMatches(LABELS, '').map((i) => i.id)).toEqual(['bug', 'deploy', 'ui']);
  });

  it('ignores the spaces around a query', () => {
    expect(pickMatches(LABELS, '  bug ').map((i) => i.id)).toEqual(['bug']);
  });
});

describe('what the field says (#1021)', () => {
  it('names the size of the whole set', () => {
    expect(pickSearchLabel('labels', 14)).toBe('Search 14 labels');
  });

  it('says the noun alone below two, where a count is not a size', () => {
    expect(pickSearchLabel('owners', 1)).toBe('Search owners');
    expect(pickSearchLabel('owners', 0)).toBe('Search owners');
  });
});

describe('the list a picker opens on', () => {
  const html = renderToStaticMarkup(
    <PickList
      noun="labels"
      items={LABELS}
      lead={{ id: PICK_NONE, name: 'None' }}
      selected={['deploy']}
      onPick={() => {}}
    />,
  );

  it('opens on a search field, counting the set and not the None row', () => {
    expect(html).toContain('cmdk-input');
    expect(html).toContain('placeholder="Search 3 labels"');
  });

  it('puts the None row first', () => {
    expect(items(html)).toHaveLength(4);
    expect(items(html)[0]).toContain(`data-pick="${PICK_NONE}"`);
  });

  it('marks exactly the rows that are on, and says so to a screen reader', () => {
    const on = items(html).filter((tag) => tag.includes('data-current'));
    expect(on).toHaveLength(1);
    expect(on[0]).toContain('data-pick="deploy"');
    expect(on[0]).toContain('aria-checked="true"');
    expect(items(html).filter((tag) => tag.includes('aria-checked="false"'))).toHaveLength(3);
  });

  it('draws "on" as a plate and a weight step, never a hue (#1020, #1097)', () => {
    const [on] = items(html).filter((tag) => tag.includes('data-current'));
    // A data picker and a fixed menu agree because both go through
    // `menuRowMark`, so this moved with the fixed menu's assertion when #1097
    // chose `plate`: a filled band, and the edge spent on nothing.
    expect(on).toContain('pick-plate');
    expect(on).toContain('border-transparent');
    expect(on).not.toContain('border-line-strong');
    expect(on).toContain('font-semibold');
    expect(html).not.toContain('text-brand');
    // The colour is not asserted here and cannot be: see the same test in
    // `command-menu.spec.ts` for where it is read instead.
  });

  // Which row the highlight opens on is NOT asserted here. cmdk sets it after
  // mount, from `defaultValue`, and an effect never runs in this suite; the
  // markup says `data-selected="false"` on every row whatever the code does.
  // It was checked in a browser: Milestone opens on C4, Labels on `bug`.
  //
  // `check-pick-list.mjs` pins the initial active descendant in Chrome's
  // accessibility tree, including a non-first value and the None row.

});

describe('a picker over a set the caller knows is fixed (#1199)', () => {
  // The board's workflow states. `FieldEditor` turns search off from the
  // service's marker, never from the field's name — `PropertiesPanel.spec`
  // holds that end; this end is what the list then draws.
  const STATES: PickItem[] = [
    { id: 'todo', name: 'Todo' },
    { id: 'doing', name: 'In Progress' },
  ];
  const html = renderToStaticMarkup(
    <PickList noun="options" searchable={false} items={STATES} selected={['todo']} onPick={() => {}} />,
  );

  it('opens on the rows, with no field to type into', () => {
    expect(html).not.toContain('cmdk-input');
    expect(items(html)).toHaveLength(2);
  });

  it('is the list the arrows walk and the reader is put on, not the box around it', () => {
    // `useDismiss` focuses the `MENU_ROW` on entry and walks the rows from it.
    // On the cmdk ROOT that was a node with no role and no name, which cmdk
    // then moved focus off at the first arrow key; on the list it is the node
    // that holds the highlight and keeps holding focus (#1199 review, F2/F3).
    const list = html.match(/<div[^>]*\bcmdk-list=""[^>]*>/)?.[0] ?? '';
    expect(list).toContain('data-menu-row');
    expect(list).toContain('role="listbox"');
    expect(list).toContain('tabindex="-1"');
    const root = html.match(/<div[^>]*\bcmdk-root=""[^>]*>/)?.[0] ?? '';
    expect(root).not.toContain('data-menu-row');
  });

  it('says what the reader has landed in, rather than cmdk\u2019s "Suggestions"', () => {
    expect(html).toContain('aria-label="options"');
    expect(html).not.toContain('aria-label="Suggestions"');
    // And says nothing through cmdk's `<label for>`, which names the field:
    // with no field it points at an id that is not in the document.
    expect(html).toMatch(/<label[^>]*cmdk-label[^>]*><\/label>/);
  });

  it('names a field list separately from its empty-state noun', () => {
    const html = renderToStaticMarkup(
      <PickList noun="options" listName="Status" searchable={false} items={[]} onPick={() => {}} />,
    );
    expect(html).toContain('aria-label="Status"');
    expect(html).toContain('No options to choose from.');
    expect(html).not.toContain('No Status');
  });

  it('leaves a data picker as it was: the field is named, the list is not the row', () => {
    const data = renderToStaticMarkup(<PickList noun="labels" items={LABELS} onPick={() => {}} />);
    expect(data).toContain('cmdk-input');
    expect(data).toContain('>Search 3 labels</label>');
    const list = data.match(/<div[^>]*\bcmdk-list=""[^>]*>/)?.[0] ?? '';
    expect(list).not.toContain('data-menu-row');
  });
});

describe('a picker whose pick replaces nothing it shows', () => {
  it('reserves no check gutter and claims no row is on', () => {
    const html = renderToStaticMarkup(<PickList noun="people" items={LABELS} onPick={() => {}} />);
    expect(html).not.toContain('aria-checked');
    expect(html).not.toContain('data-current');
  });
});

describe('the states around the list', () => {
  it('says it is still reading while the set is not in', () => {
    const html = renderToStaticMarkup(<PickList noun="labels" items={null} onPick={() => {}} />);
    expect(html).toContain('Loading…');
    expect(html).not.toContain('cmdk-input');
  });

  it('says the noun where the set came back empty, or the caller\u2019s own sentence', () => {
    const plain = renderToStaticMarkup(<PickList noun="labels" items={[]} onPick={() => {}} />);
    expect(plain).toContain('No labels to choose from.');
    const said = renderToStaticMarkup(
      <PickList noun="people" items={[]} empty="Nobody on this repo can be assigned." onPick={() => {}} />,
    );
    expect(said).toContain('Nobody on this repo can be assigned.');
    expect(said).not.toContain('No people to choose from.');
  });

  it('sits on a box that lifts with a hairline and no shadow (#1019), and floats nowhere itself', () => {
    expect(PICK_PANEL).toContain('bg-overlay');
    expect(PICK_PANEL).toContain('border-line');
    expect(PICK_PANEL).not.toMatch(/shadow/);
    // It was `absolute z-30` while a picker hung off its trigger. A `PickDialog`
    // places it now, so a positioned box here would be a popover inside a modal.
    expect(PICK_PANEL).not.toMatch(/absolute|\bz-\d/);
  });
});

describe('the room a picker in a dialog holds open (#1067)', () => {
  // A centred dialog that shortens as the reader types moves every row under
  // their cursor, and the empty-result line is the biggest shortening there is.
  it('holds the height the whole set asks for', () => {
    expect(reservedListHeight(8)).toBe(8 * 30 + 8);
  });

  it('holds three rows for a set still being read, which has no rows to measure', () => {
    expect(reservedListHeight(null)).toBe(98);
  });

  it('holds a short set to its own size, and never a row of blank under it', () => {
    expect(reservedListHeight(2)).toBe(68);
    expect(reservedListHeight(1)).toBe(38);
  });

  // A set that came back empty draws no rows and one line, and that line is a
  // row tall (`LINE`), so the room a row asks for is the room it asks for. It
  // reserved 8px and let the measured floor climb to whatever the line drew,
  // which is the 5px grow the review of #1077 found one state later (S2).
  it('holds a row for a set that came back empty, because its one line is a row', () => {
    expect(reservedListHeight(0)).toBe(38);
  });

  it('stops at the height the list scrolls inside, rather than growing without end', () => {
    expect(reservedListHeight(9)).toBe(264);
    expect(reservedListHeight(400)).toBe(264);
  });

  it('is written onto the list, and onto the reading line in its place', () => {
    const list = renderToStaticMarkup(<PickList reserve noun="labels" items={LABELS} onPick={() => {}} />);
    expect(list).toContain('min-height:98px');
    // The markup's floor is the arithmetic one. `PickList` raises it to the
    // list it really drew, and that half needs a layout the suite has not got.
    const loading = renderToStaticMarkup(<PickList reserve noun="labels" items={null} onPick={() => {}} />);
    expect(loading).toContain('min-height:98px');
  });

  // The floor only ever RISES, which is what absorbs a shrink. A line taller
  // than a row is a grow, and no floor absorbs one: with a catalog of one, the
  // rows held the list at 42px and the no-match line drew at 47, so typing a
  // letter that matched nothing grew the dialog 5px under the cursor. The two
  // lines carry the row's own line box and the row's own vertical padding, so
  // that cannot happen again by construction (#1077 review, S2).
  it('draws the lines that are not rows at a row\u2019s height', () => {
    for (const cls of [ROW, LINE]) {
      expect(cls, 'the row and the lines beside it must share a line box').toContain('text-[12.5px]/[18px]');
      expect(cls, 'and the same vertical padding').toContain('py-[5px]');
    }
  });

  it('holds nothing open where the caller did not ask, which is the filter panes', () => {
    const html = renderToStaticMarkup(<PickList noun="labels" items={LABELS} onPick={() => {}} />);
    expect(html).not.toContain('min-height');
  });
});
