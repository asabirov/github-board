import { copyResponseDeadline } from '../auth/response-deadline';
import { useResponseState } from '../auth/use-response-state';
/**
 * The native-facet editors for the issue PropertiesPanel (#384) —
 * Assignees, Labels, Milestone — plus the Projects v2 custom-field + project-
 * membership editors (Task 11) — FieldEditor, ProjectEditor. Each mounts into
 * its PropertyRow when the viewer can write: the row raises on hover, a click
 * opens the editor, and a pick drives the optimistic
 * `useFacetEdit` engine — the value applies at once, commits to GitHub, then
 * reconciles to the server's authoritative result (B2). `status` drives the
 * row's inline Saving spinner / "Couldn't save · Retry".
 *
 * Labels, milestones and project fields open inline (#1094–#1096).
 * Assignees still use a `PickDialog`. Text, number and date fields keep their
 * anchored input; searchable fields use `PickList` in the same row scaffold.
 *
 * State is the exception (#423): it left the panel for `StatePill`, which leads
 * the properties column instead of stacking above a board's Status field. It
 * commits through the same engine as every row here.
 *
 * The value renderers (`AssigneeValue`/`LabelValue`/`MilestoneValue`/
 * `FieldValueView`) are exported so the read-only panel and the editable rows
 * show the exact same value — one definition, no drift.
 *
 * ProjectEditor (remove) and AddProjectEditor (add, #404) are the two halves of
 * project membership: ProjectEditor drops the issue from a board it's already
 * on; AddProjectEditor puts it on one it isn't — its candidates come from the
 * `/api/projects/catalog` read, fetched when the add block mounts.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { setIssueState, setIssueAssignees, setIssueLabels, setIssueMilestone, setIssueField, removeIssueFromProject, addIssueToProject, createProjectForIssue, type Actor, type FieldDataType, type FieldValue, type IssueDetail, type IssueEditOptions, type IssueProjectMembership, type ProjectFieldDef } from '../api/issues';
import { fetchProjectCatalog, type ProjectCatalogEntry } from '../api/projects';
import type { IssueLabel, IssueState } from '../api/types';
import { Button, buttonVariants } from '../ui/kit';
import { Avatar } from '../ui/avatar';
import { MENU_PANEL, MENU_TRIGGER, MenuOption, useDismiss } from '../ui/command-menu';
import { PICK_NONE, PICK_POPOVER, PickDialog, PickList, type PickItem } from '../ui/pick-list';
import { STATE_WORD, stateTone } from '../ui/state-tag';
import { useRefreshBump, useRenewalSignal, useAccessEpoch } from '../sync/sync-status';
import { controlVerdict, REFUSED_REASON, type ControlVerdict } from '../refusal';
import { mayWrite, type Me } from '../use-me';
import { LabelChip, Person } from './atoms';
import { Failed, PropertyRow, type RowAlign, type RowStatus } from './PropertyRow';
import { useFacetEdit } from './use-facet-edit';
import { NewProjectForm, appMayWriteProjects, asEntry } from './new-project';

/** The resting "no value" marker, shared with the read-only panel. */
export const NONE = <span className="text-muted">None</span>;

/** The row that clears a single value, heading its picker's list. */
const NONE_ITEM: PickItem = { id: PICK_NONE, name: 'None', label: NONE };

/**
 * The line under a picker's title, which is the one thing about these dialogs a
 * reader cannot see for themselves: nothing here has a Save, because every row
 * commits the moment it is pressed, through the same optimistic engine the
 * panel has always used. The two sentences differ only where the dialog then
 * goes, which is the other thing the reader cannot see before they press.
 */
// "straight away", not "at once" (#979): over a list of tickboxes "at once"
// reads as "all together", which is the opposite of what this says.
const TICK_SAVES = 'Each tick saves straight away.';

// ── #635 — what the editor asks before it offers a control ────────────────

/**
 * The `@Writes(...)` name behind each of the issue editor's eight controls.
 *
 * It is NOT the controller's set. The rule, rather than a count that goes stale
 * the moment a tenth `@Writes` lands: every `issue.`-prefixed capability
 * `issue-detail.controller.ts` declares, EXCEPT `issue.close`.
 *
 * Close is deliberately absent because it is not an editor control and this
 * panel has nothing to withdraw for it. It is offered by `ui/IssueActions` on
 * the list and board surfaces — `ListView`, `BoardView`, `IssueListRow`. It is NOT offered on the issue page at all: the
 * overflow menu there carries Copy link and Open on GitHub and writes nothing,
 * because #423 made the state pill beside it the one way to close an issue, as
 * `issue.state`. So the eight here are the ones this file draws, and the ninth
 * belongs to a surface this file does not own.
 *
 * The strings still have to match the decorators exactly, and `mayWrite` reads
 * an unrecognised key as NOT refused, so a typo would arm that control
 * permanently — the defect #635 exists to remove, returning invisibly. Nothing
 * in this module can catch that, because every reader derives its keys from
 * this map; `PropertiesPanel.spec.tsx` pins the eight literals instead.
 */
export const ISSUE_CAP = {
  state: 'issue.state',
  assignees: 'issue.assignees',
  labels: 'issue.labels',
  milestone: 'issue.milestone',
  bodyTask: 'issue.body.task',
  projectAdd: 'issue.project.add',
  /** A new project, made from the add block's menu with the issue on it
   *  (#982). It draws no row of its own: it is one more entry in the menu the
   *  add already opens, so it is offered only where the add is. */
  projectCreate: 'issue.project.create',
  projectRemove: 'issue.project.remove',
  field: 'issue.field',
  /** Answering the issue from the board (#693). It is not a facet of the issue
   *  and draws no panel row — it is the composer at the foot of the thread — but
   *  it belongs in this map for the reason the map exists: a control asks
   *  `mayWrite(me, ISSUE_CAP.comment)` before it offers itself, and being here is
   *  what puts it in the issue editor's set. Never the other way round. */
  comment: 'issue.comment',
} as const;

/**
 * The one place the issue editor decides about a control. `mayWrite` owns the
 * capability half and is not re-derived here; `controlVerdict` owns the
 * tiebreak between the two withdrawn cases (`refusal.ts`, shared with the
 * feedback form so two surfaces cannot answer it differently).
 *
 * That tiebreak is `writesEnabled` and never `canWrite` (#626). They differ by
 * exactly the issue refusals this function is reading one of: the moment the
 * board's credential is refused `issue.labels`, `canWrite` goes false, and a
 * tiebreak on it would have called that refusal `read-only` — drawing the
 * Labels row plain and silent beside seven rows that are still editable, with
 * nothing on screen saying the board had been told no. `writesEnabled` asks
 * only what the tiebreak means to ask: whether this session writes at all.
 */
export function issueControlVerdict(me: Me | null, capability: string): ControlVerdict {
  return controlVerdict(mayWrite(me, capability), me?.writesEnabled ?? false);
}

/** The issue page's verdict (#982): `issueControlVerdict`, except that a new
 *  project is also withheld where the board's Github App, as installed on the
 *  issue's owner, plainly cannot write that owner's projects. Every create there
 *  would be refused, and an entry that can only fail is worse than none. */
export function issuePageVerdict(me: Me | null, owner: string, capability: string): ControlVerdict {
  if (capability === ISSUE_CAP.projectCreate && !appMayWriteProjects(me, owner)) {
    return controlVerdict(false, me?.writesEnabled ?? false);
  }
  return issueControlVerdict(me, capability);
}

/** Whether the add block offers "New project" (#982), asked of the panel's own
 *  verdict so the key it asks about is pinned where a spec can reach it. The
 *  block itself is drawn only where the add is armed. */
export function newProjectOffered(verdict: (capability: string) => ControlVerdict): boolean {
  return verdict(ISSUE_CAP.projectCreate) === 'armed';
}

export type { ControlVerdict };

/**
 * A panel row whose editor is not mounted. `refused` keeps the row in place,
 * sits the VALUE back and writes the reason under it in its own grid cell;
 * anything else is the plain row every unarmed session has always seen.
 *
 * The dimming is on the value and not on the row, and the note is a cell rather
 * than another chip inside the value. Both were the row's, and both were wrong:
 * opacity clamps every descendant, so the reason rendered at 2.34:1 — below the
 * kit's own `--disabled-ink` — and a note inside the value grew that cell,
 * dragging a centred label 12.5px off the avatar it names (#424). `PropertyRow`
 * carries the measurements.
 *
 * `reasonId` is the id the sentence gets and the row's `aria-describedby` points
 * at. `sayReason` is false for a row governed by a capability that has ALREADY
 * said its piece on a sibling: `issue.field` is ONE capability covering every
 * custom field on a board, so a sentence per row is the same sentence copied
 * down a 250px column. Those rows still withdraw, still dim, and still point a
 * screen reader at the one sentence their block does carry.
 *
 * Only rows get a reason at all. The four controls that are not rows — the state
 * pill, the body's task checkboxes, the add-to-project block and a board's
 * remove affordance — withdraw silently, because `REFUSED_REASON` names no
 * subject and only a label column beside it supplies one (`PropertyRow` sets
 * out why the string stays subjectless). Putting it anywhere else on this page
 * would produce a sentence about nothing in particular.
 */
export function WithheldRow({
  verdict,
  label,
  align,
  reasonId,
  sayReason = true,
  children,
}: {
  verdict: ControlVerdict;
  label: string;
  align?: RowAlign;
  reasonId?: string;
  sayReason?: boolean;
  children: ReactNode;
}) {
  if (verdict !== 'refused') {
    return (
      <PropertyRow label={label} align={align}>
        {children}
      </PropertyRow>
    );
  }
  return (
    <PropertyRow
      label={label}
      align={align}
      dim
      noteId={reasonId}
      note={sayReason ? REFUSED_REASON : undefined}
    >
      {children}
    </PropertyRow>
  );
}

type NameOf = (a: Actor | null) => string;

// ── value renderers (shared by read-only rows + editors) ─────────────────────

export function AssigneeValue({ assignees, name }: { assignees: Actor[]; name: NameOf }) {
  if (assignees.length === 0) return NONE;
  return (
    <>
      {assignees.map((a) => (
        <Person
          key={a.login}
          login={a.login}
          name={name(a)}
          avatar={<Avatar name={name(a)} login={a.login} px={40} className="pj-av-xs" />}
        />
      ))}
    </>
  );
}

export function LabelValue({ labels }: { labels: IssueLabel[] }) {
  if (labels.length === 0) return NONE;
  return (
    <>
      {labels.map((l) => (
        <LabelChip key={l.name} label={l} />
      ))}
    </>
  );
}

export function MilestoneValue({ milestone }: { milestone: string | null }) {
  return milestone ? <>{milestone}</> : NONE;
}

/** Github's single-select option colour enum → a hex we can tint with, matching
 *  the label-chip treatment (a quiet 15% wash, hue pulled toward the text colour
 *  so it reads in both themes). Unknown/absent colours fall back to a neutral. */
const OPTION_HEX: Record<string, string> = {
  GRAY: '8b949e',
  BLUE: '1f6feb',
  GREEN: '1a7f37',
  YELLOW: 'bf8700',
  ORANGE: 'bc4c00',
  RED: 'd1242f',
  PINK: 'bf3989',
  PURPLE: '8250df',
};

export function optionTint(color: string | null): { background: string; color: string } {
  const hex = color && OPTION_HEX[color] ? `#${OPTION_HEX[color]}` : null;
  if (!hex) return { background: 'var(--bg-elevated)', color: 'var(--dim)' };
  return {
    background: `color-mix(in srgb, ${hex} 16%, transparent)`,
    color: `color-mix(in srgb, ${hex} 72%, var(--text))`,
  };
}

/** One custom field's value, rendered by its data type — shared by the read-only
 *  panel rows and the resting display of FieldEditor's editable ones. */
export function FieldValueView({ field, value }: { field: ProjectFieldDef; value: FieldValue | undefined }) {
  if (!value) return NONE;
  switch (value.kind) {
    case 'single_select': {
      const opt = field.options?.find((o) => o.id === value.optionId);
      if (!opt) return NONE;
      return (
        <span className="rounded-md px-[9px] py-0.5 text-[12px] font-medium" style={optionTint(opt.color)}>
          {opt.name}
        </span>
      );
    }
    case 'text':
      return value.text ? <>{value.text}</> : NONE;
    case 'number':
      return value.number == null ? NONE : <span className="tabular-nums">{value.number}</span>;
    case 'date':
      return value.date ? <span className="tabular-nums">{value.date}</span> : NONE;
    case 'iteration': {
      const it = field.iterations?.find((i) => i.id === value.iterationId);
      return it ? <>{it.title}</> : NONE;
    }
  }
}

// ── shared editor scaffold ───────────────────────────────────────────────────

/** The PropertyRow and what it opens. Owns open/close and calls `onOpen` once
 *  per open so the panel can lazily fetch edit-options. `menu` renders the body;
 *  it gets a `close` to dismiss after a single-select pick.
 *
 *  `note` selects a modal. Labels and milestones use an anchored picker
 *  (#1095, #1096); text, number and date fields use an anchored input.
 *  The shared dismiss hook handles both popover shapes.
 *
 *  The row is the trigger either way, and it wears both halves of that (#742):
 *  `MENU_TRIGGER` so Escape has something to put the reader back on — the row is
 *  the focusable element here, so the mark has to be on it or `.focus()` is a
 *  no-op — and `expanded`, because this is the only thing that knows whether the
 *  editor is open and the row is the thing a screen reader reads it off. */
function EditableRow({
  label,
  savingLabel,
  status,
  retry,
  value,
  align,
  onOpen,
  menu,
  note,
  inline = false,
}: {
  label: string;
  savingLabel: string;
  status: RowStatus;
  retry: () => void;
  value: ReactNode;
  /** Forwarded to PropertyRow — `center` for an avatar-bearing value (#424). */
  align?: RowAlign;
  onOpen?: () => void;
  menu: (close: () => void) => ReactNode;
  /** The line under the dialog's title, and what says this row opens a dialog at
   *  all. A row without it draws the anchored popover instead. */
  note?: string;
  /** A searchable picker needs no panel padding. */
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  // The popover's keys only. A `PickDialog` is modal, and Radix owns Escape, the
  // scrim, the focus trap and the way back to the row inside it.
  useDismiss(open && !note, wrap, () => setOpen(false));
  const openMenu = () => {
    onOpen?.();
    setOpen(true);
  };
  const close = () => setOpen(false);
  return (
    <div ref={wrap} className="relative">
      <PropertyRow
        {...MENU_TRIGGER}
        label={label}
        editable
        expanded={open}
        align={align}
        status={status}
        savingLabel={savingLabel}
        onEdit={openMenu}
        onRetry={retry}
      >
        {value}
      </PropertyRow>
      {note ? (
        <PickDialog open={open} onOpenChange={setOpen} trigger={wrap} title={label} note={note}>
          {menu(close)}
        </PickDialog>
      ) : (
        open && <div className={`${inline ? PICK_POPOVER : MENU_PANEL} left-0 top-[calc(100%+2px)] w-[236px]`}>{menu(close)}</div>
      )}
    </div>
  );
}

interface EditorProps {
  issue: IssueDetail;
  onPatch: (next: Partial<IssueDetail>) => void;
  name: NameOf;
  /** The repo's edit-options catalog, or null until lazily fetched on first open. */
  editOptions: IssueEditOptions | null;
  loadOptions: () => void;
}

// ── the state pill ───────────────────────────────────────────────────────────

/** In flight the pill already shows the optimistic new value, so dimming it is
 *  the whole "saving" signal — no spinner competing with a two-word pill. */
const STATE_PILL_SAVING = 'iss-state opacity-60';

/**
 * The issue's open/closed pill, leading the properties column (#423).
 *
 * It used to be the panel's first row, labelled "State" — directly above each
 * board block's "Status" field, which made one lifecycle and one board column
 * read as the same field written twice (a closed issue on two boards said
 * "Closed", then "Todo", then "Done"). Lifted out of the panel and rendered as a
 * pill, it stops competing: nothing left inside the panel is named for state.
 *
 * For a writer the pill IS the state editor — the same optimistic `useFacetEdit`
 * commit the rows use, reconciling to the state GitHub returns and reflecting it
 * through `onPatch`, in both directions (a closed issue reopens from here). A
 * reader sees the same pill with no affordance.
 *
 * `armed` is `issue.state`'s verdict alone (#635), never the session's one
 * boolean: a refusal on Labels must not take the pill away. It arrives as a
 * boolean rather than a `ControlVerdict` because both withdrawn cases draw the
 * same badge here — the pill is not a row, so there is no label column beside it
 * to say WHAT the board isn't allowed to do (see `WithheldRow`).
 */
export function StatePill({
  issue,
  armed,
  onPatch,
}: {
  issue: IssueDetail;
  armed: boolean;
  onPatch: (next: Partial<IssueDetail>) => void;
}) {
  const bump = useRefreshBump();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(open, wrap, () => setOpen(false));
  const { value, status, edit, retry } = useFacetEdit<IssueState>({
    source: issue,
    initial: issue.state,
    commit: (next) => setIssueState(issue.owner, issue.repo, issue.number, next).then((r) => r.state),
    apply: (state, source) => {
      onPatch(copyResponseDeadline(source, { state }));
      bump();
    },
  });

  // The whole pill hangs off one hue var, so `.iss-state` styles both states and
  // the writer's deepened hover without a per-state class.
  const tone = stateTone(value);
  const face = STATE_WORD[value];

  // Withdrawn controls retain the same text and tone without a click target.
  if (!armed) return <span className="iss-state" style={tone}>{face}</span>;
  // A failed write has already rolled the value back — say so where the pill was,
  // in the same words the rows that stayed use, so the revert isn't unexplained.
  if (status === 'error') return <Failed onRetry={retry} />;
  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="menu"
        aria-expanded={open}
        // Where Escape puts the reader back (#739).
        {...MENU_TRIGGER}
        className={status === 'saving' ? STATE_PILL_SAVING : 'iss-state'}
        style={tone}
      >
        {face}
      </button>
      {open && (
        <div className={`${MENU_PANEL} left-0 top-[calc(100%+4px)] w-[176px]`}>
          {(['open', 'closed'] as const).map((s) => (
            <MenuOption key={s} selected={value === s} onSelect={() => { edit(s); setOpen(false); }}>
              {STATE_WORD[s]}
            </MenuOption>
          ))}
        </div>
      )}
    </div>
  );
}

// ── the three panel facet editors ────────────────────────────────────────────

export function AssigneeEditor({ issue, onPatch, name, editOptions, loadOptions }: EditorProps) {
  const bump = useRefreshBump();
  const { value, status, edit, retry } = useFacetEdit<Actor[]>({
    source: issue,
    initial: issue.assignees,
    // Replace-semantics — the full desired set from a possibly-stale view. Two
    // concurrent editors are last-write-wins on GitHub; reconciling to the
    // returned set (B2, below) converges both views to GitHub's actual state, the
    // pragmatic lost-update fix for a small unit (no diff-based add/remove API).
    commit: (next) =>
      setIssueAssignees(issue.owner, issue.repo, issue.number, next.map((a) => a.login)).then((r) => r.assignees),
    apply: (assignees, source) => {
      onPatch(copyResponseDeadline(source, { assignees }));
      bump();
    },
  });
  const selected = new Set(value.map((a) => a.login));
  const toggle = (login: string) =>
    edit(selected.has(login) ? value.filter((a) => a.login !== login) : [...value, { login, name: null }]);
  return (
    <EditableRow
      label="Assignees"
      savingLabel="assignees"
      status={status}
      retry={retry}
      align="center"
      onOpen={loadOptions}
      value={<AssigneeValue assignees={value} name={name} />}
      note={TICK_SAVES}
      menu={() => (
        <PickList
          reserve
          noun="people"
          items={
            editOptions?.assignableLogins.map((login) => ({
              id: login,
              name: name({ login, name: null }),
              mark: <Avatar name={name({ login, name: null })} login={login} px={40} className="pj-av-xs" showTitle={false} />,
            })) ?? null
          }
          selected={[...selected]}
          onPick={toggle}
        />
      )}
    />
  );
}

export function LabelEditor({ issue, onPatch, editOptions, loadOptions }: EditorProps) {
  const bump = useRefreshBump();
  const { value, status, edit, retry } = useFacetEdit<IssueLabel[]>({
    source: issue,
    initial: issue.labels,
    // Replace-semantics, same last-write-wins note as AssigneeEditor.
    commit: (next) =>
      setIssueLabels(issue.owner, issue.repo, issue.number, next.map((l) => l.name)).then((r) => r.labels),
    apply: (labels, source) => {
      onPatch(copyResponseDeadline(source, { labels }));
      bump();
    },
  });
  const selected = new Set(value.map((l) => l.name));
  const toggle = (label: IssueLabel) =>
    edit(selected.has(label.name) ? value.filter((l) => l.name !== label.name) : [...value, label]);
  return (
    <EditableRow
      label="Labels"
      savingLabel="labels"
      status={status}
      retry={retry}
      onOpen={loadOptions}
      value={<LabelValue labels={value} />}
      inline
      menu={() => (
        <PickList
          noun="labels"
          items={editOptions?.labels.map((l) => ({ id: l.name, name: l.name, label: <LabelChip label={l} /> })) ?? null}
          selected={[...selected]}
          onPick={(id) => {
            const label = editOptions?.labels.find((l) => l.name === id);
            if (label) toggle(label);
          }}
        />
      )}
    />
  );
}

export function MilestoneEditor({ issue, onPatch, editOptions, loadOptions }: EditorProps) {
  const bump = useRefreshBump();
  const { value, status, edit, retry } = useFacetEdit<string | null>({
    source: issue,
    initial: issue.milestone,
    // The value is the milestone TITLE (what the issue carries + what the server
    // echoes); the number the API wants is resolved from the loaded options.
    commit: (title) => {
      const num = title == null ? null : editOptions?.milestones.find((m) => m.title === title)?.number ?? null;
      return setIssueMilestone(issue.owner, issue.repo, issue.number, num).then((r) => r.milestone);
    },
    apply: (milestone, source) => {
      onPatch(copyResponseDeadline(source, { milestone }));
      bump();
    },
  });
  return (
    <EditableRow
      label="Milestone"
      savingLabel="milestone"
      status={status}
      retry={retry}
      onOpen={loadOptions}
      value={<MilestoneValue milestone={value} />}
      inline
      menu={(close) => {
        const milestones = editOptions?.milestones ?? null;
        const current = milestones?.find((m) => m.title === value);
        return (
          <PickList
            noun="milestones"
            items={milestones?.map((m) => ({ id: String(m.number), name: m.title })) ?? null}
            lead={NONE_ITEM}
            selected={[value == null ? PICK_NONE : String(current?.number ?? '')]}
            onPick={(id) => {
              const picked = milestones?.find((m) => String(m.number) === id);
              if (id === PICK_NONE) edit(null);
              else if (picked) edit(picked.title);
              close();
            }}
          />
        );
      }}
    />
  );
}

// ── Task 11: Projects v2 custom fields + project membership ─────────────────

/** The resting "no value" shape per data type — what an unset field's `edit`
 *  starts from, so FieldEditor never has to special-case "no value yet" against
 *  a real committed one. */
function emptyFieldValue(dataType: FieldDataType): FieldValue {
  switch (dataType) {
    case 'single_select':
      return { kind: 'single_select', optionId: null };
    case 'text':
      return { kind: 'text', text: '' };
    case 'number':
      return { kind: 'number', number: null };
    case 'date':
      return { kind: 'date', date: null };
    case 'iteration':
      return { kind: 'iteration', iterationId: null };
  }
}

/** Whether two `FieldValue`s carry the same primitive — used by FieldEditor's
 *  text/number/date commit paths to skip a no-op write. `parse()` always
 *  returns a fresh object even when the raw input didn't change, so object
 *  identity (or `Object.is`) is never useful here; compare the relevant
 *  primitive per kind instead, narrowing `b` off the already-matched `a.kind`
 *  rather than casting. */
export function fieldValuesEqual(a: FieldValue, b: FieldValue): boolean {
  switch (a.kind) {
    case 'single_select':
      return b.kind === 'single_select' && a.optionId === b.optionId;
    case 'text':
      return b.kind === 'text' && a.text === b.text;
    case 'number':
      return b.kind === 'number' && a.number === b.number;
    case 'date':
      return b.kind === 'date' && a.date === b.date;
    case 'iteration':
      return b.kind === 'iteration' && a.iterationId === b.iterationId;
  }
}

/** Immutably patch one custom-field value into `issue.projects` — the exact
 *  shape FieldEditor's `apply` writes back (B2: the server-RETURNED value, never
 *  the optimistic guess) and what the spec exercises directly (the board's test
 *  env has no DOM, so a click can't be simulated — see PropertiesPanel.spec). */
export function patchIssueField(
  issue: IssueDetail,
  projectId: string,
  fieldId: string,
  value: FieldValue,
): IssueDetail {
  const source = copyResponseDeadline(value, copyResponseDeadline(issue, {}));
  return copyResponseDeadline(source, {
    ...issue,
    projects: issue.projects.map((p) =>
      p.projectId === projectId ? { ...p, values: { ...p.values, [fieldId]: value } } : p,
    ),
  });
}

/** Immutably drop a Projects v2 membership — and with it its whole custom-field
 *  group — from the issue. What ProjectEditor's `apply` writes back on a
 *  successful remove. */
export function removeProjectFromIssue(issue: IssueDetail, projectId: string): IssueDetail {
  return copyResponseDeadline(issue, { ...issue, projects: issue.projects.filter((p) => p.projectId !== projectId) });
}

/** The exact positional args FieldEditor's `commit` passes to `setIssueField`
 *  (owner, repo, number, projectId, itemId, fieldId, value) — pulled out as a
 *  pure function, called by BOTH the component and the spec, so an
 *  itemId/fieldId swap (or any other arg-order slip) fails a unit test instead
 *  of only being catchable by eyeballing the diff. */
export function setIssueFieldArgs(
  issue: IssueDetail,
  membership: IssueProjectMembership,
  fieldId: string,
  value: FieldValue,
): Parameters<typeof setIssueField> {
  return [issue.owner, issue.repo, issue.number, membership.projectId, membership.itemId, fieldId, value];
}

/** The exact positional args ProjectEditor's `commit` passes to
 *  `removeIssueFromProject` (owner, repo, number, projectId, itemId) — same
 *  drift-proofing as `setIssueFieldArgs` above. */
export function removeIssueFromProjectArgs(
  issue: IssueDetail,
  membership: IssueProjectMembership,
): Parameters<typeof removeIssueFromProject> {
  return [issue.owner, issue.repo, issue.number, membership.projectId, membership.itemId];
}

/** Immutably append a freshly-added Projects v2 membership (#404) — the twin of
 *  removeProjectFromIssue. The add mutation returns only the new itemId, not the
 *  board's field schema, so fields/values start empty and the block renders with
 *  just its name at first; they populate on the next full issue load, which the
 *  issue page's refresh-nonce refetch now triggers right after bump() (#404). */
export function addProjectToIssue(issue: IssueDetail, entry: ProjectCatalogEntry, itemId: string): IssueDetail {
  const source = copyResponseDeadline(entry, copyResponseDeadline(issue, {}));
  return copyResponseDeadline(source, { ...issue, projects: [...issue.projects, {
    projectId: entry.id, itemId, number: entry.number, title: entry.title, fields: [], values: {},
  }] });
}

/** Positional args for addIssueToProject (owner, repo, number, projectId) — drift-proof twin
 *  of removeIssueFromProjectArgs, called by both AddProjectEditor and the spec. */
export function addIssueToProjectArgs(issue: IssueDetail, entry: ProjectCatalogEntry): Parameters<typeof addIssueToProject> {
  return [issue.owner, issue.repo, issue.number, entry.id];
}

/**
 * What a key does inside the field-edit input: Enter commits the draft, Escape
 * throws it away, everything else belongs to the input (#742 follow-up). Pure
 * and exported so both are asserted in a suite with no DOM, the way
 * `PropertyRow`'s `retryPress` and `rowKeyPress` are.
 */
export function fieldEditPress(key: string, on: { commit: () => void; cancel: () => void }): void {
  if (key === 'Enter') on.commit();
  else if (key === 'Escape') on.cancel();
}

/** A borderless-consistent input hosted inside the field-edit popover (text /
 *  number / date all share this shell). Commits once — on Enter, on blur, or
 *  (`commitOnChange`, for the native date picker) on change — whichever fires
 *  first; a `done` guard stops a second commit from a stray blur after Enter or
 *  after the popover closes and unmounts the input.
 *
 *  Escape sets that same guard, and it has to (#742). It used to cancel only by
 *  accident: the popover unmounted with the input still focused, and React fires
 *  no blur on unmount, so the draft went nowhere. Once the ROW carried
 *  `MENU_TRIGGER`, `useDismiss` had something to hand focus back to — and it
 *  focuses the trigger BEFORE it closes, which blurs this input, which commits.
 *  Escape started saving the value the reader was backing out of. Latching
 *  `done` makes the cancel something the code says. */
function FieldTextInput({
  type,
  inputMode,
  initial,
  placeholder,
  commitOnChange,
  parse,
  onCommit,
}: {
  type: 'text' | 'date';
  inputMode?: 'numeric';
  initial: string;
  placeholder?: string;
  /** Commit as soon as the value changes (the date picker's only real signal),
   *  rather than waiting for Enter/blur. */
  commitOnChange?: boolean;
  parse: (raw: string) => FieldValue;
  onCommit: (value: FieldValue) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);
  const commit = (raw: string) => {
    if (done.current) return;
    done.current = true;
    onCommit(parse(raw));
  };
  return (
    <input
      autoFocus
      type={type}
      inputMode={inputMode}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => {
        setDraft(e.target.value);
        if (commitOnChange) commit(e.target.value);
      }}
      onKeyDown={(e) => fieldEditPress(e.key, {
        commit: () => commit(draft),
        // Not prevented and not stopped: `useDismiss` still hears this Escape on
        // `document` and still closes the popover, exactly as it does today.
        cancel: () => { done.current = true; },
      })}
      onBlur={() => commit(draft)}
      className="w-full rounded-[7px] border border-line bg-surface px-2.5 py-2 text-[12.5px] text-fg placeholder:text-muted focus:border-line-strong focus:outline-none"
    />
  );
}

const parseNumber = (raw: string): FieldValue => {
  const t = raw.trim();
  const n = t === '' ? null : Number(t);
  return { kind: 'number', number: n == null || Number.isNaN(n) ? null : n };
};
const parseDate = (raw: string): FieldValue => ({ kind: 'date', date: raw === '' ? null : raw });
const parseText = (raw: string): FieldValue => ({ kind: 'text', text: raw });

interface FieldEditorProps {
  issue: IssueDetail;
  onPatch: (next: Partial<IssueDetail>) => void;
  membership: IssueProjectMembership;
  field: ProjectFieldDef;
}

/** One Projects v2 custom-field row, editable by `field.dataType` (Task 11):
 *  `single_select`/`iteration` are a clearable MenuOption list (mirrors
 *  LabelEditor/MilestoneEditor); `text`/`number`/`date` host a small input in
 *  the same popover shell. Every branch commits through the same optimistic
 *  `useFacetEdit` path as the native facets above. */
export function FieldEditor({ issue, onPatch, membership, field }: FieldEditorProps) {
  const bump = useRefreshBump();
  // Stable identity for the resting value: an UNSET field falls back to
  // `emptyFieldValue`, which builds a fresh object every render — feeding that
  // straight into `useFacetEdit` made its reset-on-`initial`-change effect fire
  // every render (the new object is never `Object.is`-equal to the stored one),
  // an infinite render loop. Memoising on the actual stored value (or its
  // absence + the data type) keeps `initial` referentially stable until the value
  // truly changes, so an editable field with no value yet (a freshly added
  // board's columns, #404) renders calmly.
  const stored = membership.values[field.fieldId];
  const initial = useMemo(() => stored ?? emptyFieldValue(field.dataType), [stored, field.dataType]);
  const { value, status, edit, retry } = useFacetEdit<FieldValue>({
    source: issue,
    initial,
    commit: (next) => setIssueField(...setIssueFieldArgs(issue, membership, field.fieldId, next)).then((r) => r.value),
    apply: (actual, source) => {
      onPatch(copyResponseDeadline(source, { projects: patchIssueField(issue, membership.projectId, field.fieldId, actual).projects }));
      bump();
    },
  });
  const display = <FieldValueView field={field} value={value} />;

  // Runtime switch (not compile-time-exhaustive) — `dataType` is the wire union,
  // which can widen ahead of this file's known 5 kinds; an unknown kind falls
  // through to the read-only `display` rather than masquerading as a date
  // editor, which the old if-chain's implicit final "date" branch did.
  switch (field.dataType) {
    case 'single_select': {
      const selected = value.kind === 'single_select' ? value.optionId : null;
      return (
        <EditableRow label={field.name} savingLabel={field.name} status={status} retry={retry} value={display} inline
          menu={(close) => (
            <PickList
              noun="options"
              listName={field.name}
              // The board's workflow states are a fixed set of words, and a set
              // of words is read, not searched (#1199). Which field that is
              // comes from the service's marker and never from the name: a
              // project can rename Status, and a project can add a field of its
              // own called "status" with thirty options in it.
              searchable={!field.builtInStatus}
              items={(field.options ?? []).map((o) => ({
                id: o.id,
                name: o.name,
                label: <span className="rounded-md px-[9px] py-0.5 text-[12px] font-medium" style={optionTint(o.color)}>{o.name}</span>,
              }))}
              lead={NONE_ITEM}
              selected={[selected ?? PICK_NONE]}
              onPick={(id) => { edit({ kind: 'single_select', optionId: id === PICK_NONE ? null : id }); close(); }}
            />
          )}
        />
      );
    }

    case 'iteration': {
      const selected = value.kind === 'iteration' ? value.iterationId : null;
      return (
        <EditableRow label={field.name} savingLabel={field.name} status={status} retry={retry} value={display} inline
          menu={(close) => (
            <PickList
              noun="iterations"
              items={(field.iterations ?? []).map((it) => ({ id: it.id, name: it.title }))}
              lead={NONE_ITEM}
              selected={[selected ?? PICK_NONE]}
              onPick={(id) => { edit({ kind: 'iteration', iterationId: id === PICK_NONE ? null : id }); close(); }}
            />
          )}
        />
      );
    }

    case 'text': {
      const text = value.kind === 'text' ? value.text : '';
      return (
        <EditableRow label={field.name} savingLabel={field.name} status={status} retry={retry} value={display}
          menu={(close) => (
            <FieldTextInput
              type="text"
              initial={text}
              placeholder="Add text…"
              parse={parseText}
              onCommit={(v) => { if (!fieldValuesEqual(v, value)) edit(v); close(); }}
            />
          )}
        />
      );
    }

    case 'number': {
      const n = value.kind === 'number' ? value.number : null;
      return (
        <EditableRow label={field.name} savingLabel={field.name} status={status} retry={retry} value={display}
          menu={(close) => (
            <FieldTextInput
              type="text"
              inputMode="numeric"
              initial={n == null ? '' : String(n)}
              placeholder="Add number…"
              parse={parseNumber}
              onCommit={(v) => { if (!fieldValuesEqual(v, value)) edit(v); close(); }}
            />
          )}
        />
      );
    }

    case 'date': {
      const d = value.kind === 'date' ? value.date : null;
      return (
        <EditableRow label={field.name} savingLabel={field.name} status={status} retry={retry} value={display}
          menu={(close) => (
            <FieldTextInput
              type="date"
              initial={d ?? ''}
              commitOnChange
              parse={parseDate}
              onCommit={(v) => { if (!fieldValuesEqual(v, value)) edit(v); close(); }}
            />
          )}
        />
      );
    }

    default:
      return display;
  }
}

const REMOVE_BTN_BASE =
  'inline-flex size-5 flex-none cursor-pointer items-center justify-center rounded-md text-[13px] leading-none text-muted transition-opacity hover:bg-elevated hover:text-danger';
/** Hidden at rest (design-review B2 fix) — the Project row must read as plain
 *  data, same as every other calm value row, with no persistent control glyph.
 *  `group-hover:opacity-100` reveals it while hovering the Project row (its
 *  `group` ancestor, wired in PropertiesPanel.tsx); `focus-visible:opacity-100`
 *  reveals it on the button's own keyboard focus, so a Tab user can still reach
 *  it without ever hovering — opacity (not `hidden`/`visibility:hidden`) keeps
 *  it in the tab order the whole time. Same reveal vocabulary as the row-hover
 *  affordances elsewhere in the board (BoardView's card menu, AccessSection's
 *  row actions). */
const REMOVE_BTN_HIDDEN = 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100';

/**
 * The Project row's remove affordance (Task 11) — REMOVE only. Its ADD twin is
 * `AddProjectEditor` below, which renders its own Project row instead of
 * nesting into an existing one (there's no membership yet to attach to).
 */
export function ProjectEditor({
  issue,
  onPatch,
  membership,
}: {
  issue: IssueDetail;
  onPatch: (next: Partial<IssueDetail>) => void;
  membership: IssueProjectMembership;
}) {
  const bump = useRefreshBump();
  const { status, edit, retry } = useFacetEdit<null>({
    source: issue,
    initial: null,
    commit: () => removeIssueFromProject(...removeIssueFromProjectArgs(issue, membership)).then(() => null),
    apply: (_actual, source) => {
      onPatch(copyResponseDeadline(source, { projects: removeProjectFromIssue(issue, membership.projectId).projects }));
      bump();
    },
  });
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useDismiss(open, wrap, () => setOpen(false));

  if (status === 'saving') return <span className="text-[11.5px] text-muted">Removing…</span>;
  if (status === 'error') {
    return (
      <span className="text-[11.5px] text-danger">
        Couldn’t remove
        <span className="mx-[5px] text-muted">·</span>
        <button type="button" onClick={retry} className="cursor-pointer font-medium text-accent hover:underline">
          Retry
        </button>
      </span>
    );
  }
  return (
    <div ref={wrap} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(true)}
        // Where Escape puts the reader back (#739).
        {...MENU_TRIGGER}
        // Stay revealed while its own popover is open (never fade out from
        // under a menu it's still driving), otherwise hidden until the row's
        // hovered or the button itself has keyboard focus.
        className={`${REMOVE_BTN_BASE} ${open ? 'opacity-100' : REMOVE_BTN_HIDDEN}`}
        aria-label={`Remove from ${membership.title}`}
      >
        ×
      </button>
      {open && (
        <div className={`${MENU_PANEL} left-0 top-[calc(100%+2px)] w-[188px]`}>
          <MenuOption onSelect={() => { edit(null); setOpen(false); }}>
            <span className="text-danger">Remove from project</span>
          </MenuOption>
        </div>
      )}
    </div>
  );
}

/** A picked catalog board, carrying the item id `addIssueToProject` returns
 *  once committed (#404). `itemId` is absent on the pre-commit value handed to
 *  `commit`, and present on the post-commit value `apply` reads — one local
 *  shape for both sides of `useFacetEdit`'s round trip, kept out of api.ts so
 *  the wire types don't grow a field only this component needs. */
type CatalogPick = (ProjectCatalogEntry & { itemId?: string }) | null;

/** The add's two passing states, drawn where its `+` trigger rests and will
 *  rest again: the add in flight, and an add that failed. */
const ADD_LINE = 'flex min-h-7 items-center gap-2 px-2 text-[13px]';

/** The add affordance's leading "+" — an SVG (not the glyph) so it sits optically
 *  centred on the label via `flex items-center`, never floating high or low. */
function PlusGlyph({ size = 'size-3.5' }: { size?: string } = {}) {
  return (
    <svg viewBox="0 0 16 16" className={`${size} flex-none`} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M8 3.75v8.5M3.75 8h8.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The Project row's ADD affordance (#404) — the twin of ProjectEditor's remove.
 * Putting the issue on a board that already exists is exactly the pick
 * Guidelines/Controls/Add & search gives a search field for, so the trigger is a
 * quiet `+ Add to project` and behind it is a search over the org's catalog,
 * minus the boards this issue is already on. A pick commits through the same
 * optimistic `useFacetEdit` engine every other facet uses.
 *
 * The catalog is read on mount so the trigger only appears when its options
 * are ready. A failed read leaves no trigger; the next renewal reads again.
 */
/**
 * What one row of the add-to-project picker says (#697).
 *
 * The title alone, until the catalog holds another board spelled the same — the
 * catalog is a union across every configured org, and two orgs can title a board
 * identically, which was two indistinguishable rows over two different boards.
 * Then the org goes in front, in Github's own `owner/name` shape, which is how
 * every other qualified name on this board is written.
 *
 * Qualifying ONLY on a collision is what keeps a single-org deployment reading
 * exactly as it does today: nothing there ever collides, so nothing there ever
 * gains a prefix. A board that named no org gets none either — there is nothing
 * to qualify it with, and a prefix invented for it would be a claim.
 */
export function projectPickerLabel(entry: ProjectCatalogEntry, catalog: ProjectCatalogEntry[]): string {
  const shared = catalog.some((c) => c.id !== entry.id && c.title === entry.title);
  return shared && entry.org ? `${entry.org}/${entry.title}` : entry.title;
}

export function AddProjectEditor({
  issue,
  onPatch,
  canCreate = false,
}: {
  issue: IssueDetail;
  onPatch: (next: Partial<IssueDetail>) => void;
  /** Whether "New project" is offered (#982): `newProjectOffered`, on top of
   *  the add this block already needs. */
  canCreate?: boolean;
}) {
  const bump = useRefreshBump();
  const [naming, setNaming] = useState(false);
  const newProject = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const addWrap = useRef<HTMLDivElement>(null);
  useDismiss(adding, addWrap, () => setAdding(false));
  // Adding and retry replace the block. Its replacement catches dropped focus.
  const held = useRef<HTMLDivElement>(null);
  // Which issue the page shows now. `IssuePage` stays mounted from one issue to
  // the next, so a create answered after the reader moved on must not land on
  // the issue they moved to; comments and task toggles guard the same way.
  const issueKey = `${issue.owner}/${issue.repo}#${issue.number}`;
  const shown = useRef(issueKey);
  useEffect(() => {
    shown.current = issueKey;
  }, [issueKey]);
  const [catalog, setCatalog] = useResponseState<ProjectCatalogEntry[] | null>(null, null);
  const renewal = useRenewalSignal();
  const accessEpoch = useAccessEpoch();

  const { status, edit, retry } = useFacetEdit<CatalogPick>({
    source: issue,
    initial: null,
    commit: (entry) =>
      entry
        ? addIssueToProject(...addIssueToProjectArgs(issue, entry)).then((r) => copyResponseDeadline(entry, { ...entry, itemId: r.itemId }))
        : Promise.resolve(null),
    apply: (added, source) => {
      if (added) onPatch(copyResponseDeadline(source, { projects: addProjectToIssue(issue, added, added.itemId ?? '').projects }));
      bump();
    },
  });

  // `status` and not a mount: saving to error swaps one line for the other, and
  // that second unmount drops focus again. Only where the unmount dropped it, so
  // a reader who moved on is never pulled back — and only after this block has
  // taken something away, so a cold load, where `document.activeElement` is the
  // body already, is left alone.
  const replaced = useRef(false);
  useEffect(() => {
    if (status === 'saving' || status === 'error') replaced.current = true;
    else if (!replaced.current) return;
    if (!document.activeElement || document.activeElement === document.body) held.current?.focus();
  }, [status]);

  // A `let alive` and no once-ref: either guard alone is safe, the pair
  // deadlocks under StrictMode, and this read has to run again
  // on every renewal, which a ref saying "already asked" would stop.
  useEffect(() => {
    let alive = true;
    fetchProjectCatalog().then((r) => { if (alive) setCatalog(r); }, () => {});
    return () => { alive = false; };
  }, [renewal, accessEpoch]);

  // Not optimistic, unlike a pick: there is no project to draw until Github has
  // made one. What comes back goes on the page the way a pick's does, into the
  // held catalog so this block knows the board, and out to every other mounted
  // view through the bump. The service drops its own catalog on this write.
  const makeProject = async (title: string) => {
    const sentFor = issueKey;
    const { project, itemId } = await createProjectForIssue(issue.owner, issue.repo, issue.number, title);
    const entry = asEntry(project);
    setCatalog((held) => (held ? [...held, entry] : held));
    bump();
    // Moved on: the bump re-reads what the page shows now, and the project
    // went onto the issue it was made for, which is not this one.
    if (shown.current !== sentFor) return;
    setNaming(false);
    onPatch(copyResponseDeadline(issue, { projects: addProjectToIssue(issue, entry, itemId).projects }));
  };

  if (status === 'saving') {
    return (
      <div ref={held} tabIndex={-1} className={`${ADD_LINE} text-muted`}>
        <PlusGlyph /> Adding…
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div ref={held} tabIndex={-1} className={`${ADD_LINE} text-danger`}>
        <PlusGlyph /> Couldn’t add
        <span className="text-muted">·</span>
        <button type="button" onClick={retry} className="cursor-pointer font-medium text-accent hover:underline">
          Retry
        </button>
      </div>
    );
  }
  // `data-add-project` is on both boxes so the panel's armed add can be told
  // from a withheld one in markup, where the read never lands. Hidden until it
  // does: an empty box in the column would still take the column's gap.
  if (!catalog) return <div hidden data-add-project="" />;
  // The boards this issue is not already on, which is what the picker offers and
  // what its field counts. `AddPicker` counted the whole catalog and hid the
  // excluded rows; count only the projects available to pick.
  const onIssue = issue.projects.map((p) => p.projectId);
  const offerable = catalog.filter((c) => !onIssue.includes(c.id));
  return (
    <div ref={held} tabIndex={-1} className="flex flex-wrap items-center gap-1" data-add-project="">
      <div ref={addWrap} className="relative">
        <button type="button" {...MENU_TRIGGER} aria-expanded={adding}
          className={buttonVariants({ variant: 'ghost', size: 'xs', className: 'shrink-0 cursor-pointer' })}
          onClick={() => setAdding(!adding)}>
          <PlusGlyph size="size-4" /> Add to project
        </button>
        {adding && (
          <div className={`${PICK_POPOVER} left-0 top-[calc(100%+2px)] w-[236px]`}>
            <PickList noun="projects"
              items={offerable.map((c) => ({ id: c.id, name: projectPickerLabel(c, catalog) }))}
              onPick={(id) => {
                const entry = catalog.find((c) => c.id === id);
                setAdding(false);
                if (entry) edit(entry);
              }}
            />
          </div>
        )}
      </div>
      {naming && canCreate && (
        <NewProjectForm key={issueKey} owner={issue.owner} trigger={newProject}
          onCancel={() => setNaming(false)} catalog={catalog} onIssue={onIssue}
          create={makeProject} onAdd={(entry) => { setNaming(false); edit(entry); }}
        />
      )}
      {canCreate && (
          <Button ref={newProject} variant="ghost" size="xs" className="shrink-0" onClick={() => { setAdding(false); setNaming(true); }}>
            <PlusGlyph size="size-4" /> New project
          </Button>
      )}
    </div>
  );
}
