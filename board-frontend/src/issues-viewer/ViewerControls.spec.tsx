import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToggleGroup, ToggleGroupItem } from '../ui/kit';
import { GroupMenuPanel, ViewerControls } from './ViewerControls';
import SOURCE from './ViewerControls.tsx?raw';
import { MENU_LABEL, MENU_PANEL, MenuOption } from '../ui/command-menu';
import type { GroupDim } from './filter-group';

// The board's test env is `node` (no DOM), so — same rationale as
// ProjectBlock.spec.tsx — render to a static HTML string and assert against the
// markup. Markup order is DOM order, which is also tab order and the order a
// screen reader walks the group.

const DIMS: GroupDim[] = ['status', 'assignee'];

function toggleMarkup(view: 'list' | 'board') {
  return renderToStaticMarkup(
    <ViewerControls
      group="status"
      dims={DIMS}
      view={view}
      showGroup={false}
      onGroup={() => {}}
      onView={() => {}}
    />,
  );
}

/** Index of a toggle button by its aria-label, or -1 when it is absent. */
function at(html: string, label: 'Board' | 'List') {
  return html.indexOf(`aria-label="${label}"`);
}

describe('ViewerControls group menu (#661)', () => {
  it('names repo as a grouping the menu can carry', () => {
    // The dropdown itself only exists once the trigger is clicked, and this env
    // has no DOM to click in — so the assertion is on the trigger, which reads
    // the same GROUP_LABEL entry the list items do. A missing entry renders an
    // empty <b> and fails here.
    const html = renderToStaticMarkup(
      <ViewerControls
        group="repo"
        dims={['project', 'repo']}
        view="list"
        showView={false}
        onGroup={() => {}}
        onView={() => {}}
      />,
    );
    expect(html).toContain('Grouped by');
    expect(html).toContain('>repo</b>');
  });
});

describe('ViewerControls view toggle (#464)', () => {
  it('renders board before list, matching the app default', () => {
    const html = toggleMarkup('board');
    expect(at(html, 'Board')).toBeGreaterThan(-1);
    expect(at(html, 'List')).toBeGreaterThan(-1);
    expect(at(html, 'Board')).toBeLessThan(at(html, 'List'));
  });

  it('keeps board first regardless of which view is active', () => {
    const html = toggleMarkup('list');
    expect(at(html, 'Board')).toBeLessThan(at(html, 'List'));
  });

  it('announces exactly one selected view through the native radio semantics', () => {
    for (const active of ['board', 'list'] as const) {
      const html = toggleMarkup(active);
      for (const label of ['Board', 'List']) {
        const button = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
        expect(button).toBeDefined();
        expect(button).toContain('role="radio"');
        expect(button).toContain(`aria-checked="${label.toLowerCase() === active}"`);
      }
    }
  });

  it('drops the toggle entirely when the host runs list-only', () => {
    const html = renderToStaticMarkup(
      <ViewerControls
        group="status"
        dims={DIMS}
        view="list"
        showView={false}
        onGroup={() => {}}
        onView={() => {}}
      />,
    );
    expect(at(html, 'Board')).toBe(-1);
    expect(at(html, 'List')).toBe(-1);
    expect(html).toContain('Grouped by'); // the group menu still shows
  });
});

// Which classes the chosen slot carries, and nothing about how it reads: that is
// judged from the crops on #1032, because this env draws no pixel.
//
// The two negative assertions below name no kit class of their own. A spec that
// writes `ring-line-strong` or `bg-surface-2` out by hand is the #937 shape:
// the kit renames the class, the string in here matches nothing, the assertion
// goes on passing and the mark it was guarding is quietly back. So both are read
// off the INSTALLED kit, by rendering its own `ToggleGroup` under each treatment
// and taking the class the chosen slot carries.
describe('ViewerControls view toggle selection (#1032)', () => {
  /** The whole `<button>…</button>` for one slot. */
  function slot(html: string, label: 'Board' | 'List') {
    return html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>.*?</button>`))?.[0] ?? '';
  }

  /** The chosen slot's class list, as the installed kit paints it under `treatment`. */
  function kitChosen(treatment: 'frame' | 'track'): string[] {
    const html = renderToStaticMarkup(
      <ToggleGroup type="single" value="a" treatment={treatment} size="sm" aria-label="Kit">
        <ToggleGroupItem value="a" aria-label="A" />
      </ToggleGroup>,
    );
    return (html.match(/<button[^>]*class="([^"]*)"/)?.[1] ?? '').split(/\s+/);
  }

  /** What `frame` rings the chosen slot with, and what `track` plates it with. */
  const KIT_FRAME_RING = kitChosen('frame').find((c) => /^data-\[state=on\]:ring-/.test(c));
  const KIT_TRACK_PLATE = kitChosen('track').find((c) => /^data-\[state=on\]:bg-/.test(c));
  /** Just the utility, for the merged-away check: twMerge drops the variant too. */
  const bare = (cls: string | undefined) => cls?.replace(/^data-\[state=on\]:/, '');

  it('reads both marks off the installed kit rather than naming them here', () => {
    // A `find` that answered `undefined` would make both negatives vacuous.
    expect(KIT_FRAME_RING, 'the kit\'s `frame` treatment no longer rings the chosen slot').toBeTruthy();
    expect(KIT_TRACK_PLATE, 'the kit\'s `track` treatment no longer plates the chosen slot').toBeTruthy();
    expect(KIT_FRAME_RING).not.toBe(KIT_TRACK_PLATE);
  });

  it('marks the chosen view with the per-ground plate, never the frame ring', () => {
    for (const active of ['board', 'list'] as const) {
      const html = toggleMarkup(active);
      expect(html).not.toContain(bare(KIT_FRAME_RING));
      const chosen = html.match(/<button[^>]*aria-checked="true"[^>]*>/)?.[0];
      expect(chosen).toContain('data-[state=on]:bg-(--queue-toggle-on)');
      // The kit's own plate is the canvas's fill, so it must be merged away
      // rather than left to win or lose on CSS order.
      expect(chosen).not.toContain(bare(KIT_TRACK_PLATE));
    }
  });

  it('draws the chosen glyph heavier than the other one', () => {
    for (const [active, on, off] of [['board', 'Board', 'List'], ['list', 'List', 'Board']] as const) {
      const html = toggleMarkup(active);
      expect(slot(html, on)).toContain('stroke-width="2.25"');
      expect(slot(html, off)).toContain('stroke-width="1.75"');
    }
  });
});

// The panel only exists once the trigger is clicked, and this env cannot click —
// so `GroupMenuPanel` is the seam: the same markup the open menu ships, rendered
// directly. Asserting on the trigger (above) cannot see any of this.
const PANEL_DIMS: GroupDim[] = ['status', 'assignee', 'label'];

function panelMarkup(group: GroupDim) {
  return renderToStaticMarkup(<GroupMenuPanel group={group} dims={PANEL_DIMS} onChange={() => {}} />);
}

/** The panel's option rows, one markup slice each, in DOM order. */
function rows(html: string) {
  return html.split('<button').slice(1).map((s) => `<button${s}`);
}

/** The first `class` attribute in a markup slice. */
function cls(html: string) {
  return /class="([^"]*)"/.exec(html)?.[1] ?? '';
}

/** The class run `MenuOption` renders for itself — rendered, never transcribed,
 *  so this cannot agree with a hand-rolled copy that merely looks the same. */
function optionClass(selected: boolean) {
  return cls(renderToStaticMarkup(<MenuOption selected={selected} onSelect={() => {}}>x</MenuOption>));
}

describe('ViewerControls group menu selection (#726)', () => {
  it('announces exactly one grouping as checked, and it is the current one', () => {
    const html = panelMarkup('assignee');
    const all = rows(html);
    // `?? []` rather than a bare `.match()`: a null actual fails `toHaveLength`
    // with "Target cannot be null or undefined", which says nothing about aria.
    expect(html.match(/aria-checked="true"/g) ?? []).toHaveLength(1);
    expect(html.match(/aria-checked="false"/g) ?? []).toHaveLength(all.length - 1);

    const checked = all.filter((r) => r.includes('aria-checked="true"'));
    expect(checked).toHaveLength(1);
    expect(checked[0]).toContain('>assignee<');
  });

  it('gives the panel a menu role and every row a menuitemradio role', () => {
    const html = panelMarkup('status');
    expect(html).toContain('role="menu"');
    expect(rows(html)).toHaveLength(PANEL_DIMS.length);
    for (const row of rows(html)) expect(row).toContain('role="menuitemradio"');
    // A menu with no accessible name is an unnamed landmark to a screen reader.
    expect(html).toMatch(/role="menu"[^>]*aria-labelledby="/);
  });

  it('marks the selection with a glyph, not only a text colour', () => {
    // #726: `text-fg` alone was the whole mark, so the hovered row was
    // the only thing on screen wearing a fill and read as the chosen one. The tick
    // is either there or not, so a tint cannot out-argue it.
    const [checked, ...unchecked] = rows(panelMarkup('status'));
    expect(checked).toContain('aria-checked="true"');
    expect(checked).toContain('<svg');
    for (const row of unchecked) expect(row).not.toContain('<svg');
  });

  it('is built from the shared popover primitive, not a third copy of it', () => {
    // The point of the change (#726/#384). `command-menu` exists "so the two never
    // drift into two different popover looks", and the FilterBar — which draws from
    // it — sits on this same toolbar row. Both class runs are READ OFF the primitive
    // rather than copied here, so re-forking the panel fails this.
    const html = panelMarkup('status');
    expect(html).toContain(MENU_PANEL);
    expect(html).toContain(MENU_LABEL);
    const [checked, ...unchecked] = rows(html);
    expect(cls(checked)).toBe(optionClass(true));
    for (const row of unchecked) expect(cls(row)).toBe(optionClass(false));
  });
});

describe('ViewerControls group menu trigger (#726)', () => {
  function triggerMarkup() {
    return renderToStaticMarkup(
      <ViewerControls
        group="status"
        dims={PANEL_DIMS}
        view="list"
        showView={false}
        onGroup={() => {}}
        onView={() => {}}
      />,
    );
  }

  it('tells a screen reader it opens a menu, and that the menu is shut', () => {
    // Without these the panel announces itself as a menu once open while the
    // control that opens it announces nothing at all.
    const html = triggerMarkup();
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
  });

  it('binds aria-expanded to the open state rather than to the word false', () => {
    // The trigger only ever renders closed here: `open` is internal state and this
    // env has no DOM to click it with. A markup assertion alone would pass just as
    // happily on a hardcoded `aria-expanded="false"`, so the binding is pinned as
    // source text — the technique for wiring what the suite
    // cannot reach. The open state itself stays unasserted.
    expect(SOURCE).toContain('aria-expanded={open}');
    expect(SOURCE).toContain('aria-haspopup="menu"');
  });
});

describe('ViewerControls group menu dismiss (#726)', () => {
  it('dismisses through the shared hook, not a hand-rolled document listener', () => {
    // The fourth primitive in `command-menu`, and the one this menu kept its own
    // copy of. It matters beyond duplication: `startedInside` prefers composedPath
    // over `contains` because a row can synchronously unmount the node that was
    // clicked (#418) — which is exactly what picking a grouping does here, since
    // the select closes the menu. `contains` on a detached node answers false, so
    // the hand-rolled version ran its outside-click branch on every pick, harmless
    // only because both branches closed the menu.
    //
    // No DOM here to dispatch a click or an Escape in, so the wiring is pinned as
    // source — the technique for wiring the suite. The dismiss BEHAVIOUR is
    // covered where it can be: `ui/command-menu.spec.ts` drives `startedInside`.
    expect(SOURCE).toContain('useDismiss(open, wrap, () => setOpen(false))');
    expect(SOURCE).not.toContain('document.addEventListener');
    expect(SOURCE).not.toContain('document.removeEventListener');
  });
});


describe('the triage groupings in the menu (#1099)', () => {
  const TRIAGE_DIMS: GroupDim[] = ['label', 'triage:priority', 'triage:size'];

  it('names each one by its property, without the label prefix', () => {
    const html = renderToStaticMarkup(<GroupMenuPanel group="triage:size" dims={TRIAGE_DIMS} onChange={() => {}} />);
    // `capitalize` on the row is what draws these as Size and Priority; the
    // text itself is the property word, so a family added on Github arrives
    // named with no entry anywhere in here.
    expect(html).toContain('>size</span>');
    expect(html).toContain('>priority</span>');
    expect(html).not.toContain('triage:size<');
  });

  it('marks the chosen one, so the panel says which grouping is on', () => {
    const html = renderToStaticMarkup(<GroupMenuPanel group="triage:size" dims={TRIAGE_DIMS} onChange={() => {}} />);
    const chosen = html.split('<button').slice(1).find((row) => row.includes('aria-checked="true"')) ?? '';
    // The row's first span is the tick slot; the named one carries `capitalize`.
    expect(/<span class="capitalize">([^<]*)</.exec(chosen)?.[1]).toBe('size');
  });

  it('reads as a sentence on the trigger', () => {
    const html = renderToStaticMarkup(
      <ViewerControls group="triage:size" dims={TRIAGE_DIMS} view="list" showView={false} onGroup={() => {}} onView={() => {}} />,
    );
    expect(html).toContain('Grouped by');
    expect(html).toContain('>size</b>');
  });
});

describe('a derived property named like a fixed one (#1108)', () => {
  // The rendered menu, because that is where the reviewer found it: a
  // `triage:type:*` family drew two rows both reading "type".
  const COLLIDING: GroupDim[] = ['type', 'label', 'triage:type', 'triage:size'];
  const named = (html: string) => [...html.matchAll(/<span class="capitalize">([^<]*)</g)].map((m) => m[1]);

  it('draws no two rows under one name', () => {
    const rows = named(renderToStaticMarkup(<GroupMenuPanel group="type" dims={COLLIDING} onChange={() => {}} />));
    expect(rows).toEqual(['type', 'label', 'type (triage)', 'size']);
    expect(new Set(rows).size).toBe(rows.length);
  });

  it('draws the derived row rather than dropping it', () => {
    const html = renderToStaticMarkup(<GroupMenuPanel group="triage:type" dims={COLLIDING} onChange={() => {}} />);
    expect(named(html)).toHaveLength(COLLIDING.length);
    // And it is the derived row that is marked, not the fixed one it was named after.
    const chosen = html.split('<button').slice(1).find((row) => row.includes('aria-checked="true"')) ?? '';
    expect(/<span class="capitalize">([^<]*)</.exec(chosen)?.[1]).toBe('type (triage)');
  });

  it('says the same thing on the trigger as in the row', () => {
    const html = renderToStaticMarkup(
      <ViewerControls group="triage:type" dims={COLLIDING} view="list" showView={false} onGroup={() => {}} onView={() => {}} />,
    );
    expect(html).toContain('>type (triage)</b>');
  });
});
