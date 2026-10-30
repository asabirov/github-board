import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GroupMenuPanel } from '../issues-viewer/ViewerControls';
import { OrderMenu } from '../repos/OrderPicker';
import { OwnerMenu } from '../repos/OwnerPicker';
import { ownerOptions } from '../repos/repos-vm';

/**
 * Every surface that opens a command menu answers the keyboard the same way
 * (#739) — the point of the fix landing in ONE component with five callers.
 *
 * There are two kinds of menu on this board since #1067, and this file sweeps
 * both. A menu of FIXED WORDS, and the text/number/date field editors, still
 * hang off their trigger in a popover and still answer the keyboard through
 * `useDismiss`: that is the sweep below. A menu of DATA opens a `PickDialog`
 * instead, where Radix owns Escape, the scrim and the focus trap and the one
 * thing left to check is that the dialog is told where to put the reader back:
 * that is the second sweep, at the foot of this block.
 *
 * WHAT THIS FILE USED TO BE, and why it is not that. It listed the five callers
 * by hand and counted `{...MENU_TRIGGER}` against `useDismiss(` per file, and
 * four mutations walked through it: moving the state pill's mark onto a second
 * copy somewhere else (the count never moved), putting the mark on the wrapper
 * `<span>` where `.focus()` is a no-op, putting the literal inside a comment,
 * and adding a sixth caller in a file the hand-written list did not name. Its
 * `exempt: 1` was inverted as well — FIXING the unmarked menu failed the test.
 * The list is read off the tree now, comments are stripped, the rule is per
 * COMPONENT rather than per file, and the one unmarked menu is a named entry
 * that a fix is allowed to remove. `org-scope/narrowed-surfaces.spec.ts` made
 * this move first, for the same reason.
 */
const MODULES: Record<string, string> = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Block and line comments out, literals kept — a mark written inside a comment
 *  is a mark that is not on anything. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** A glob key as a path under `src`. Vite normalises against THIS file's own
 *  directory, so a sibling arrives as `./AssignIssueDialog.tsx` and not as
 *  `../ui/…`; naming it `ui/…` is what makes one sweep read the whole tree the
 *  same way. Stripping only the `../` left every file in this folder invisible
 *  to the rule, which is how the assign picker went unswept for one run. */
const rel = (path: string) => path.replace(/^\.\.\//, '').replace(/^\.\//, 'ui/');

/** Every app file that opens a command menu, found by what it does rather than
 *  by being remembered: it draws on the shared primitive AND owns a menu's open
 *  state through the shared hook. */
const CALLERS = Object.entries(MODULES)
  .filter(([path]) => !path.includes('.spec.'))
  .map(([path, source]) => [rel(path), code(source)] as const)
  .filter(([, body]) => /from '[^']*ui\/command-menu'/.test(body) && body.includes('useDismiss('));

/** One top-level component at a time. A rule checked against a whole file is a
 *  rule a second copy of the mark anywhere in that file satisfies. */
function components(body: string): { name: string; body: string }[] {
  const heads = [...body.matchAll(/^(?:export )?function (\w+)/gm)];
  return heads.map((h, i) => ({
    name: h[1],
    body: body.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : undefined),
  }));
}

/** The tag a mark is written on, as source: `<button …{...MENU_TRIGGER}` gives
 *  `button`. A mark on a `<span>` is a mark on something `.focus()` cannot move
 *  focus to, which is the whole of what the mark is for. A CAPITALISED tag is a
 *  component, and what it draws is settled one hop away — see `importedSource`. */
function tagsBearing(body: string, mark: string): string[] {
  return [...body.matchAll(new RegExp(`\\{\\.\\.\\.${mark}\\}`, 'g'))].map((m) => {
    const open = body.lastIndexOf('<', m.index);
    return /^<(\w+)/.exec(body.slice(open))?.[1] ?? '(none)';
  });
}

/**
 * The source of the component a mark sits on, resolved ONE hop through the
 * caller's own import statement — `import { PropertyRow } from './PropertyRow'`
 * in `issue/facet-editors.tsx` gives `issue/PropertyRow.tsx`. One hop and no
 * further: a component that hands the mark on again is a chain this rule does
 * not follow, and it fails here rather than passing quietly.
 */
function importedSource(path: string, name: string): string | null {
  const body = CALLERS.find(([p]) => p === path)?.[1] ?? '';
  const dir = path.slice(0, path.lastIndexOf('/'));
  for (const imp of body.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)) {
    const names = imp[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop()?.trim());
    if (!names.includes(name) || !imp[2].startsWith('.')) continue;
    const resolved = new URL(imp[2], `file:///${dir}/`).pathname.replace(/^\//, '');
    for (const ext of ['.tsx', '.ts']) {
      const hit = MODULES[`../${resolved}${ext}`];
      if (hit !== undefined) return code(hit);
    }
    return null;
  }
  return null;
}

/** What makes a component's own element reachable by focus: a `tabIndex` whose
 *  braces hold a plain `0`. A `<button>` has one implicitly; anything else — the
 *  `role="button"` rows this board writes, which cannot be real buttons because
 *  they contain buttons and links — has to say it.
 *
 *  Reading INSIDE the braces, rather than just after them, is the whole point.
 *  `tabIndex={-1}` is how the sibling test below spells "out of the tab order",
 *  and a rule that only looked at the first character let
 *  `tabIndex={editable ? -1 : undefined}` through — a mark on something Tab can
 *  never reach. Anything this cannot read as 0 fails, and the message says so:
 *  a component that computes its tabIndex has to be checked by a human. */
const FOCUSABLE = /\btabIndex=\{[^}]*\b0\b/;

/**
 * A menu whose trigger is not marked, and why.
 *
 * Read as "at most these": removing an entry by MARKING the menu passes, which
 * is the direction a fix goes in. Adding one costs a line of reasoning here.
 *
 * It is empty, and the one entry it held is why this comment says so out loud:
 * `issue/facet-editors.tsx#EditableRow` opened its menu off a PropertyRow `<div>`
 * that was not a control, not focusable and not openable from the keyboard, so
 * there was nothing to hand focus back to. #742 made that row a real control and
 * marked it. An empty map is the strict reading — every menu in the tree now
 * hands Escape a trigger.
 */
const UNMARKED: Record<string, string> = {};

describe('command-menu callers answer the keyboard alike (#739)', () => {
  it('swept the tree and found every menu — an empty sweep would pass anything', () => {
    const names = CALLERS.map(([p]) => p);
    for (const f of [
      'issues-viewer/ViewerControls.tsx', 'issues-viewer/FilterBar.tsx',
      'repos/OrderPicker.tsx', 'issue/facet-editors.tsx',
    ]) {
      expect(names, `${f} opens a command menu and must be swept`).toContain(f);
    }
    // `repos/OwnerPicker.tsx` was the fifth until #1067 and is deliberately not
    // here: its only menu was the owner picker, which is a `PickDialog` now, so
    // it holds no `useDismiss` at all. The sweep below is what covers it.
    expect(names, 'the owner picker is a dialog now and owns no popover').not.toContain('repos/OwnerPicker.tsx');
    expect(Object.keys(MODULES).length).toBeGreaterThan(50);
  });

  it('every menu hands Escape a trigger to put the reader back on', () => {
    const unmarked: string[] = [];
    for (const [path, body] of CALLERS) {
      const marked = new Set(
        components(body).filter((c) => c.body.includes('{...MENU_TRIGGER}')).map((c) => c.name),
      );
      for (const c of components(body).filter((c) => c.body.includes('useDismiss('))) {
        // The trigger may be drawn by a component this one renders — OwnerEditor
        // holds the menu, OwnerControl draws the button — so one hop counts.
        const rendered = [...c.body.matchAll(/<([A-Z]\w+)/g)].map((m) => m[1]);
        const ok = c.body.includes('{...MENU_TRIGGER}') || rendered.some((r) => marked.has(r));
        if (!ok) unmarked.push(`${path}#${c.name}`);
      }
    }
    for (const menu of unmarked) {
      expect(UNMARKED[menu], `${menu} opens a menu with no marked trigger and no reason on record`)
        .toBeTruthy();
      expect(UNMARKED[menu].length).toBeGreaterThan(40);
    }
  });

  it('puts both marks on something focus can actually move to', () => {
    for (const [path, body] of CALLERS) {
      for (const mark of ['MENU_TRIGGER', 'MENU_ROW']) {
        for (const tag of tagsBearing(body, mark)) {
          if (/^[a-z]/.test(tag)) {
            expect(['button', 'input'], `${path}: ${mark} sits on <${tag}>`).toContain(tag);
            continue;
          }
          const src = importedSource(path, tag);
          expect(src, `${path}: ${mark} sits on <${tag}>, which this file does not import`)
            .toBeTruthy();
          expect(FOCUSABLE.test(src ?? ''), `${path}: ${mark} sits on <${tag}>, which makes nothing focusable`)
            .toBe(true);
        }
      }
    }
  });
});

/**
 * Every opening tag of `<Name …>` in a file, as source.
 *
 * It counts braces rather than looking for the next `>`, because a prop holds
 * arrow functions — `onPick={(id) => …}` is three `>` before the tag ends — and
 * a rule that stopped at the first one would read one prop and call it the tag.
 * Per OCCURRENCE, so a second picker added beside one that passes has to pass
 * on its own.
 */
export function openingTags(body: string, name: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(new RegExp(`<${name}\\b`, 'g'))) {
    let depth = 0;
    for (let i = m.index; i < body.length; i += 1) {
      const c = body[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) {
        out.push(body.slice(m.index, i + 1));
        break;
      }
    }
  }
  return out;
}

/** Every app file that opens a data picker as a modal (#1067), found the same
 *  way: by what it draws, never by being remembered. */
const PICKERS = Object.entries(MODULES)
  .filter(([path]) => !path.includes('.spec.'))
  .map(([path, source]) => [rel(path), code(source)] as const)
  .filter(([, body]) => /<PickDialog\b/.test(body));

/**
 * A picker that hands `PickDialog` no `trigger`, and why.
 *
 * Read as "at most these", the way `UNMARKED` above is: adding an entry costs a
 * line of reasoning, and removing one by naming a trigger passes.
 *
 * It is empty, and it earned that. `AssignIssueDialog` was the one entry, on the
 * record that "Radix hands focus back to that handle as it closes" — and the
 * review of #1077 measured Escape, the scrim and Cancel all leaving focus on
 * `<body>` instead. Radix's focus scope captures `document.activeElement` when
 * the content MOUNTS, and that dialog is raised a frame after the menu has
 * already unmounted, so what it captures is the body. `IssueActions` hands it
 * the ⋯ handle now. A reason is a claim about behaviour, and this is what a
 * ledger of them costs when the claim goes unmeasured.
 */
const NO_TRIGGER: Record<string, string> = {};

describe('every data picker that opens as a modal says where the reader goes back to (#1067)', () => {
  it('swept the tree and found the pickers — an empty sweep would pass anything', () => {
    const names = PICKERS.map(([p]) => p);
    for (const f of [
      'issue/facet-editors.tsx', 'repos/OwnerPicker.tsx',
      'ui/AssignIssueDialog.tsx',
    ]) {
      expect(names, `${f} opens a data picker as a modal and must be swept`).toContain(f);
    }
  });

  it('hands the dialog a trigger, or has a reason on record for not', () => {
    for (const [path, body] of PICKERS) {
      // Every `<PickDialog` in the file, and whether that one was given a
      // trigger before its tag closes. Per OCCURRENCE and not per file: a
      // second picker added beside one that passes must pass on its own.
      for (const open of openingTags(body, 'PickDialog')) {
        if (/\btrigger=\{/.test(open)) continue;
        expect(NO_TRIGGER[path], `${path} opens a PickDialog with no trigger and no reason on record`).toBeTruthy();
        expect(NO_TRIGGER[path].length).toBeGreaterThan(40);
      }
    }
  });

  it('every row of NO_TRIGGER still names a file that opens one', () => {
    const live = new Set(PICKERS.map(([p]) => p));
    expect(Object.keys(NO_TRIGGER).filter((k) => !live.has(k))).toEqual([]);
  });

  it('reads the whole tag, so a picker with no trigger cannot hide behind an arrow', () => {
    const one = `<PickDialog open={open} onOpenChange={(next) => setOpen(next)} trigger={box} title="x">`;
    expect(openingTags(one, 'PickDialog')).toEqual([one]);
    // The naive read stops at the `>` of `=>` and never reaches `trigger`.
    expect(openingTags(one, 'PickDialog').every((t) => /\btrigger=\{/.test(t))).toBe(true);
    const bare = `<PickDialog open={open} onOpenChange={(next) => setOpen(next)} title="x">`;
    expect(openingTags(bare, 'PickDialog').some((t) => /\btrigger=\{/.test(t))).toBe(false);
    expect(openingTags(`${one}\n${bare}`, 'PickDialog')).toHaveLength(2);
  });
});

/**
 * The rows themselves, read off the markup two callers actually ship rather
 * than off an import statement — an `import { MenuOption }` proves nothing about
 * the buttons a panel renders, and hand-rolling them back carries none of this.
 * The other fixed menus are unreachable here: they live inside components this
 * DOM-less env cannot mount.
 *
 * `OwnerMenu` was the third, and left this list when it became a data picker
 * (#1021): its rows are cmdk's options now, walked from its search field by the
 * kit's `Command` rather than by this hook. The describe below it checks what
 * that panel still owes the reader.
 */
const PANELS: { name: string; html: string; on: string }[] = [
  {
    name: 'GroupMenuPanel',
    html: renderToStaticMarkup(
      <GroupMenuPanel group="label" dims={['status', 'assignee', 'label']} onChange={() => {}} />,
    ),
    on: 'label',
  },
  {
    name: 'OrderMenu',
    html: renderToStaticMarkup(<OrderMenu orderKey="name" onOrder={() => {}} onClose={() => {}} />),
    on: 'Name',
  },
];

/** The panel's buttons, one markup slice each, in DOM order. */
function rows(html: string) {
  return html.split('<button').slice(1).map((s) => `<button${s}`);
}

describe('what a shipped panel puts under the keys (#739)', () => {
  for (const { name, html, on } of PANELS) {
    it(`${name} draws rows the arrows can reach and the tab order cannot`, () => {
      const all = rows(html);
      expect(all.length).toBeGreaterThan(1);
      for (const row of all) {
        expect(row, `${name} has a row the hook cannot find`).toContain('data-menu-row');
        expect(row, `${name} has a row still in the tab order`).toContain('tabindex="-1"');
      }
    });

    it(`${name} marks the value that is on, so the menu opens there`, () => {
      // The entry rule reads this mark. Exactly one row wears it, and it is the
      // row naming the current value — a panel that marks none of its rows opens
      // on row 0, which on two of these panels is a write.
      const marked = rows(html).filter((r) => r.includes('data-menu-selected'));
      expect(marked, `${name} marks no row as on, or marks several`).toHaveLength(1);
      expect(marked[0]).toContain(on);
    });
  }
});

describe('the owner picker searches rather than lists (#1021)', () => {
  const html = renderToStaticMarkup(
    <OwnerMenu options={ownerOptions(['ann', 'bo'], () => null)} value={{ login: 'bo', name: 'bo' }} onPick={() => {}} />,
  );
  /** Each row's opening tag: cmdk's item, one per value and one for "No owner". */
  const items = html.match(/<div[^>]*\bcmdk-item=""[^>]*>/g) ?? [];

  it('opens on a search field that says how big the set is', () => {
    expect(html).toContain('cmdk-input');
    expect(html).toContain('placeholder="Search 2 owners"');
  });

  it('offers every allowed value and the row that clears it', () => {
    expect(items).toHaveLength(3);
    expect(items[0], 'the clearing row leads, where every None on the board sits').toContain('data-pick="__none__"');
  });

  it('marks exactly the value that is on, so the list opens there', () => {
    const current = items.filter((tag) => tag.includes('data-current'));
    expect(current, 'marks no row as on, or marks several').toHaveLength(1);
    expect(current[0]).toContain('data-pick="bo"');
    expect(current[0]).toContain('aria-checked="true"');
  });
});

/**
 * The bug the portal stop exists for, and the only rule that can catch the next
 * one (#1077 review, S7).
 *
 * React bubbles a portal's events up the tree the portal was RENDERED in, not
 * the DOM tree it landed in, so a `PickDialog` mounted inside anything clickable
 * hands that thing every press on its rows AND on its scrim. The owner picker's
 * repo tile is where it was found: picking an owner opened the repo's page.
 *
 * A sweep of the callers cannot see this — "is there a clickable ancestor" is a
 * question about the whole render tree, and half of it is in another file. So
 * the stop is in the shell instead, above the scrim and the panel both, and this
 * is the rule that keeps it there. It goes red if the stop is deleted, and it
 * goes red if it is moved back onto `DialogContent`, which is the scrim's
 * SIBLING and cannot cover it — the shape that shipped, and the reason
 * `OwnerPicker` had to stop its own clicks a second time.
 */
describe("a picker's portal cannot press what it was rendered inside (#1067)", () => {
  const SHELL = code(MODULES['../ui/pick-list.tsx'] ?? MODULES['./pick-list.tsx'] ?? '');

  it('swept the shell — an empty read would pass anything', () => {
    expect(SHELL).toContain('export function PickDialog(');
  });

  it('stops the click above <Dialog>, where the scrim can be reached', () => {
    const stop = SHELL.search(/<span[^>]*onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
    expect(stop, 'no element stops a click above <Dialog>').toBeGreaterThan(-1);
    const opens = SHELL.indexOf('<Dialog ');
    const shuts = SHELL.indexOf('</Dialog>');
    const after = SHELL.indexOf('</span>', shuts);
    expect(stop).toBeLessThan(opens);
    expect(after, 'the stop closes before <Dialog> does, so the scrim is outside it')
      .toBeGreaterThan(shuts);
  });

  // The CLICK stop in particular. `onEscapeKeyDown` stops a press too, and it
  // belongs on the content: that one is Radix's own handler on the layer, not a
  // bubble through the render tree.
  it('does not put the click stop on the content, which is the scrim\u2019s sibling', () => {
    const content = SHELL.indexOf('<DialogContent');
    const shuts = SHELL.indexOf('</DialogContent>');
    expect(SHELL.slice(content, shuts)).not.toMatch(/onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
  });
});
