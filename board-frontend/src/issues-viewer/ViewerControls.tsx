/**
 * The IssuesViewer's right-hand controls (#376), to the approved "Take 2" chrome:
 * a quiet tertiary "Grouped by <dim>" menu (NOT a boxed control) and an icon-only
 * list/board toggle. Zero brand accent — the calm resting state is the point.
 */
import type { ViewerSort } from './triage-sort';
import { ToggleGroup, ToggleGroupItem } from '../ui/kit';
import { useId, useRef, useState } from 'react';
import { MENU_LABEL, MENU_PANEL, MENU_TRIGGER, MenuOption, useDismiss } from '../ui/command-menu';
import type { FixedGroupDim, GroupDim } from './filter-group';
import { triagePropertyLabel, triagePropertyOf } from './triage-labels';

const FIXED_GROUP_LABEL: Record<FixedGroupDim, string> = {
  status: 'status', openclosed: 'open / closed', type: 'type', assignee: 'assignee', label: 'label', project: 'project',
  repo: 'repo',
};

/** What the menu and the trigger call a grouping. Lower case throughout, because
 *  both draw it with `capitalize` and the trigger reads as a sentence ("Grouped
 *  by size").
 *
 *  A `triage:` grouping is named by its own property (#1099) and nothing else:
 *  `triage:size` reads "size", so the reader sees Size and Priority rather than
 *  the label prefix the property was parsed out of. A family added on Github
 *  arrives named, which is the point — there is no table here to add it to. */
function groupLabel(dim: GroupDim): string {
  const property = triagePropertyOf(dim);
  return property ? triagePropertyLabel(property) : FIXED_GROUP_LABEL[dim as FixedGroupDim];
}

/**
 * What each dimension on offer is called, made unique by construction (#1108).
 *
 * A derived property can be named like a fixed one. The moment somebody labels
 * an issue `triage:type:bug`, `availableGroupDims` offers `type` AND
 * `triage:type`, `groupLabel` calls them both "type", and the menu draws two
 * identical rows — a reader picking one of them is guessing. Dropping the
 * derived row instead is the one answer this design must not give: a label that
 * exists on Github and appears nowhere is the failure #1099 was filed about.
 *
 * So the row that comes second is disambiguated, and the fixed rows are always
 * drawn first (`availableGroupDims` splices the derived ones in after `label`),
 * which makes the derived one the row that takes the suffix: Type and
 * Type (triage). The loop is what makes "no two rows alike" a property of this
 * function rather than a claim about today's data — a family could be named
 * `triage:type (triage)` and the counter carries on until the name is free.
 */
export function groupDimLabels(dims: readonly GroupDim[]): Map<GroupDim, string> {
  const taken = new Set<string>();
  const labels = new Map<GroupDim, string>();
  for (const dim of dims) {
    const base = groupLabel(dim);
    let label = base;
    for (let n = 1; taken.has(label); n += 1) {
      label = n === 1 ? `${base} (triage)` : `${base} (triage ${n})`;
    }
    taken.add(label);
    labels.set(dim, label);
  }
  return labels;
}

const CaretIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

/** Quiet inline group-by menu — reads as a sentence, opens a small list of the
 *  dimensions this data supports. */
function GroupMenu({ group, dims, onChange }: { group: GroupDim; dims: GroupDim[]; onChange: (g: GroupDim) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  // The shared dismiss (#384): outside pointer-down and Escape, testing containment
  // through `startedInside`, which survives a row unmounting the node that was
  // clicked (#418) — which selecting a grouping does, since it closes the menu.
  useDismiss(open, wrap, () => setOpen(false));
  // The trigger names the grouping the same way its row in the menu does, so a
  // disambiguated row and the sentence above it never disagree.
  const labels = groupDimLabels(dims);

  return (
    <div ref={wrap} className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        // Where Escape puts the reader back (#739).
        {...MENU_TRIGGER}
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-[5px] whitespace-nowrap px-0.5 py-1 text-[12.5px] text-muted transition-colors hover:text-dim"
      >
        Grouped by <b className="font-medium text-dim">{labels.get(group) ?? groupLabel(group)}</b>
        <CaretIcon />
      </button>
      {open && <GroupMenuPanel group={group} dims={dims} onChange={(d) => { onChange(d); setOpen(false); }} />}
    </div>
  );
}

/** The open menu's panel. Exported because it is the only seam the board's
 *  DOM-less suite can reach: the panel exists only while `open`, and there is no
 *  DOM to click the trigger in. Rendering this is rendering
 *  exactly what ships. */
export function GroupMenuPanel({ group, dims, onChange }: { group: GroupDim; dims: GroupDim[]; onChange: (g: GroupDim) => void }) {
  const captionId = useId();
  const labels = groupDimLabels(dims);
  return (
    // Drawn from the shared popover primitives (#384, #726), so this marks a
    // selection the same way the FilterBar beside it does rather than inventing a
    // third look; `z-30` arrives with MENU_PANEL. The brand tick is confined to the
    // open panel — command-menu's own header scopes "zero brand accent" to rest.
    // `menuitemradio` is the pairing for "one of these is on", not `aria-selected`
    // (listbox) and not `aria-pressed` (the toggle below).
    <div role="menu" aria-labelledby={captionId} className={`${MENU_PANEL} right-0 top-[calc(100%+6px)] w-[160px]`}>
      <div id={captionId} className={MENU_LABEL}>Group by</div>
      {dims.map((d) => {
        const on = d === group;
        return (
          <MenuOption key={d} role="menuitemradio" aria-checked={on} selected={on} onSelect={() => onChange(d)}>
            <span className="capitalize">{labels.get(d)}</span>
          </MenuOption>
        );
      })}
    </div>
  );
}

/** The glyph's weight step: the chosen view's glyph is drawn heavier (#1032). */
const glyphStroke = (on: boolean) => (on ? 2.25 : 1.75);

const ListIcon = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={glyphStroke(on)} className="size-[15px]" aria-hidden="true">
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </svg>
);
const BoardIcon = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={glyphStroke(on)} className="size-[15px]" aria-hidden="true">
    <rect x="3" y="4" width="6" height="16" rx="1" />
    <rect x="10" y="4" width="6" height="10" rx="1" />
    <rect x="17" y="4" width="4" height="13" rx="1" />
  </svg>
);

/** Icon-only board/list toggle — the resting-state segmented control, no labels.
 *  Board comes first (#464): it is the default view on the Project page and on
 *  the Unit and Your work queues, so reading order matches what's already on.
 *
 *  The track, not the frame (#1032). The kit's `frame` marks the chosen slot
 *  with a `border-strong` ring, which the owner read as a dark border and
 *  rejected, and `Guidelines/Look/Selection weight` says a `single` set of
 *  glyphs "takes the track" anyway: a plate under the chosen slot and nothing
 *  drawn around the set. The kit's component still resolves a glyph set to
 *  `frame` against its own guideline, so the treatment is named here.
 *
 *  The plate is `--queue-toggle-on`, not the track's own `bg-sunken`, because
 *  `bg-sunken` is the canvas this toggle sits on for the Queue and Project
 *  pages, where it drew nothing at all; `app.css` picks a fill per ground. The
 *  track's other half is a weight step, and `font-semibold` has no weight to
 *  give a glyph, so the chosen glyph's stroke carries it instead: the plate, the
 *  heavier line and the brighter ink each say which view is on. */
// 2026-09-14: the owner's ruling on #1119 and #1097 is a filled band with no
// border for a chosen thing. The inset rim is the kit's default for icon-only
// track groups, still present in 8.2.0, not a board decision. Remove its width
// wherever this toggle is used; the kit's keyboard focus mark stays its own state.
const PLATE = 'data-[state=on]:bg-(--queue-toggle-on) data-[state=on]:ring-0';

function ViewToggle({ view, onChange }: { view: 'list' | 'board'; onChange: (v: 'list' | 'board') => void }) {
  return (
    <ToggleGroup type="single" value={view} treatment="track" size="sm" aria-label="View"
      onValueChange={(next) => { if (next === 'board' || next === 'list') onChange(next); }}>
      <ToggleGroupItem value="board" aria-label="Board" className={PLATE}><BoardIcon on={view === 'board'} /></ToggleGroupItem>
      <ToggleGroupItem value="list" aria-label="List" className={PLATE}><ListIcon on={view === 'list'} /></ToggleGroupItem>
    </ToggleGroup>
  );
}

export function ViewerControls({
  sort = 'default', onSort, group, dims, view, showGroup = true, showView = true, onGroup, onView,
}: {
  sort?: ViewerSort;
  onSort?: (sort: ViewerSort) => void;
  group: GroupDim;
  dims: GroupDim[];
  view: 'list' | 'board';
  /** Show the quiet "Grouped by …" menu (off when the host fixes the grouping). */
  showGroup?: boolean;
  /** Show the list/board toggle (off in list-only mode). */
  showView?: boolean;
  onGroup: (g: GroupDim) => void;
  onView: (v: 'list' | 'board') => void;
}) {
  return (
    <>
      {onSort && <SortMenu sort={sort} onChange={onSort} />}
      {showGroup && <GroupMenu group={group} dims={dims} onChange={onGroup} />}
      {showView && <ViewToggle view={view} onChange={onView} />}
    </>
  );
}

function SortMenu({ sort, onChange }: { sort: ViewerSort; onChange: (sort: ViewerSort) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const captionId = useId();
  useDismiss(open, wrap, () => setOpen(false));
  const labels: Record<ViewerSort, string> = { default: 'Default order', 'priority-size': 'Priority, then size' };
  return <div ref={wrap} className="relative inline-flex">
    <button type="button" aria-haspopup="menu" aria-expanded={open} {...MENU_TRIGGER}
      onClick={() => setOpen(value => !value)}
      className="flex cursor-pointer items-center gap-[5px] whitespace-nowrap px-0.5 py-1 text-[12.5px] text-muted transition-colors hover:text-dim">
      Sort: <b className="font-medium text-dim">{labels[sort]}</b><CaretIcon />
    </button>
    {open && <div role="menu" aria-labelledby={captionId} className={`${MENU_PANEL} right-0 top-[calc(100%+6px)] w-[200px]`}>
      <div id={captionId} className={MENU_LABEL}>Sort by</div>
      {(['default', 'priority-size'] as const).map(value => <MenuOption key={value} role="menuitemradio"
        aria-checked={sort === value} selected={sort === value}
        onSelect={() => { onChange(value); setOpen(false); }}>{labels[value]}</MenuOption>)}
    </div>}
  </div>;
}
