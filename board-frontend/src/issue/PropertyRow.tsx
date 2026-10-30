/**
 * One row of the issue PropertiesPanel (#384, approved variant 2B): an aligned
 * tertiary label column and its value, borderless, calm at rest. Read-only by
 * default — pass `editable` (writer + writes enabled) to arm the Task-10 edit
 * affordance and make the row a real control (#742); `onEdit` opens the editor,
 * which Task 10 wires. `status` drives the inline
 * Saving / failure states, also Task-10-driven; at rest it's `idle` and the
 * value renders plainly. `failure` is optional and additive (#577): pass it and
 * the row says what went wrong and hides a Retry that could not help; leave it
 * out and the row keeps the wording it has always had.
 */
import type { ReactNode } from 'react';
import type { EditFailure } from './use-facet-edit';

export type RowStatus = 'idle' | 'saving' | 'error';

// Aligned label column (~74px, matching 2B) + value; the negative inset lets the
// hover raise bleed to the panel edge without shifting the text.
const ROW_BASE =
  'relative grid grid-cols-[74px_minmax(0,1fr)] gap-3 -mx-[9px] rounded-[9px] px-[9px] py-[9px]';
// Text-only rows share a baseline (label baseline meets the value's first line);
// a value carrying something taller than text — an avatar — aligns to the value's
// vertical CENTRE instead, so the label lines up with the avatar, not its baseline
// (#424). The baseline variant nudges the label 1px to sit true on the shared
// baseline; centred alignment doesn't want that nudge.
const ROW_ALIGN = {
  baseline: 'items-baseline',
  center: 'items-center',
} as const;
export type RowAlign = keyof typeof ROW_ALIGN;
const ROW_EDITABLE = 'cursor-pointer hover:bg-elevated';
// Both halves of `command-menu`'s `MENU_ROW_FOCUS` (#742): the raise, so the row
// the keys are on reads as CURRENT rather than merely outlined, and an INSET
// ring, because 2px of outset on rows that stack with no gap lands on the
// neighbours — `ROW_BASE` bleeds `-mx-[9px]` to the panel edge. `focus-visible`
// and not `focus`: nothing focuses this row on a mouse press.
const ROW_FOCUS = 'focus-visible:bg-elevated focus-visible:outline-2 '
  + 'focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]';
const LABEL_CLS = 'text-[12px] leading-[1.5] text-muted';
const LABEL_BASELINE_NUDGE = 'pt-px';
const VALUE_CLS = 'flex flex-wrap items-center gap-[7px] text-[13px] leading-[1.5] text-fg';
// A withdrawn control's value sits back, and NOTHING else does. Opacity clamps
// every descendant — a child cannot climb back out of it — so the row container
// is the one place this must never go: from there it takes the label and the
// note down with it, and the note measured 2.34:1 on --surface, below the
// kit's own --disabled-ink (2.86:1) at 12px. On the value alone it is the one
// signal V4 asks for and the reason beside it stays readable at 5.15:1.
const VALUE_DIM = 'opacity-50';
// The note is its own GRID cell in column 2, not another flex item in the value.
// Inside the value it grew that cell by a line, and a row aligned to its value's
// CENTRE (#424, an avatar row) re-centred its label between the avatars and the
// sentence — 12.5px below the avatar the alignment exists to meet. As a cell of
// its own it shares no row with the label, so the label keeps meeting the avatar.
const NOTE_CLS = 'col-start-2 text-[12px] leading-[1.5] text-muted';

/** Inline "Saving …" affordance — a small blue-tipped spinner + a muted label. */
function Saving({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-[7px] text-[12px] text-muted">
      <span
        className="size-3 flex-none animate-spin rounded-full border-2 border-line [border-top-color:var(--accent)]"
        aria-hidden="true"
      />
      {label ? `Saving ${label}` : 'Saving'}
    </span>
  );
}

/**
 * A press on Retry: retry, and NOTHING else.
 *
 * Every surface that draws this note sits inside something else that takes
 * clicks — a repo tile that opens the repo's queue, a PropertyRow whose own
 * container opens the editor. Without stopping the click, pressing Retry did
 * both: measured on the Repos map, it navigated to the repo's queue instead of
 * retrying (#577). Pure and exported so the press is asserted without a DOM,
 * the same way `ownerPress` is.
 */
export function retryPress(e: { stopPropagation: () => void }, onRetry?: () => void): void {
  e.stopPropagation();
  onRetry?.();
}

/**
 * A key press on an editable row: open the editor on Enter and on Space, and
 * NOTHING else (#742). Pure and exported so the press is asserted without a DOM,
 * the same way `retryPress` is.
 *
 * Three guards. `target !== currentTarget` drops a keydown that bubbled up from
 * Retry, which would otherwise retry AND open the editor on top of it. It does
 * not cover the profile link: Enter on an `<a href>` arrives as a synthesised
 * CLICK, so that one is stopped on the link (`atoms.tsx`). `repeat` keeps a held
 * key to one open, which a native button gets from activating on keyup. Space is
 * prevented, or the browser scrolls the page under the popover it just opened.
 */
export function rowKeyPress(
  e: {
    key: string; repeat?: boolean;
    target: unknown; currentTarget: unknown;
    preventDefault: () => void;
  },
  onEdit?: () => void,
): void {
  if (e.repeat || e.target !== e.currentTarget) return;
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  onEdit?.();
}

// Retry is a target people aim at on a surface that navigates if they miss, so
// it gets a real hit box: the padding grows it to the 24px minimum and the
// negative margin gives every pixel of that back, so no line and no card moves.
const RETRY_BTN =
  'relative -mx-1 -my-[3px] cursor-pointer px-1 py-[3px] font-medium text-accent hover:underline';

/**
 * Inline failure affordance — a quiet red note, with a brand Retry action when
 * retrying could actually change the answer. Exported so the state pill (#423),
 * which is no longer a row, fails in the exact same words as every row that
 * stayed.
 *
 * `failure` is what the write actually hit (#577). Given one, the note says
 * that instead of the generic wording, and Retry appears only where pressing it
 * could help — a permanent refusal offers no button at all, because a button
 * that cannot work is the thing that sent people round the loop. Left out, the
 * note is exactly what it has always been: "Couldn't save · Retry".
 *
 * These strings name no subject, and that is deliberate. "The board isn't
 * allowed" says nothing about WHAT was not allowed, and a failure stands until a
 * person dismisses or retries it — a refetch no longer clears one, so it can be
 * read long after the press that caused it.
 *
 * It stays that way because the surface supplies the subject and the string
 * cannot. On a row, the label column names the facet right beside the note. On
 * a repo tile, the note takes the owner slot on a card whose heading is the
 * repo, so position and heading say which repo and which field. And the string
 * is shared by nine editors, so any subject it named would be wrong on eight of
 * them — a Labels row cannot say "owner".
 *
 * What to revisit, then, is not the length: it is a surface that shows one of
 * these where neither a label nor a fixed slot says what failed.
 */
export function Failed({ onRetry, failure }: { onRetry?: () => void; failure?: EditFailure | null }) {
  return (
    <span className="text-[12px] text-danger">
      {failure ? failure.text : <>Couldn’t save</>}
      {(failure?.canRetry ?? true) && (
        <>
          <span className="mx-[5px] text-muted">·</span>
          <button type="button" onClick={(e) => retryPress(e, onRetry)} className={RETRY_BTN}>
            Retry
          </button>
        </>
      )}
    </span>
  );
}

export function PropertyRow({
  label,
  editable = false,
  expanded,
  align = 'baseline',
  dim = false,
  note,
  noteId,
  status = 'idle',
  savingLabel,
  failure,
  onEdit,
  onRetry,
  className,
  children,
  'data-menu-trigger': menuTrigger,
}: {
  label: string;
  editable?: boolean;
  /** Whether the editor this row opens is open (#742) — `aria-expanded`, valid
   *  on a `role="button"`. No `aria-haspopup` goes with it: the popover carries
   *  no `role="menu"`, and for a text/number/date field it is one `<input>`.
   *  Left out, the row says nothing either way. */
  expanded?: boolean;
  /** How the label aligns to the value. Default `baseline` (text meets text);
   *  pass `center` for a value taller than text — an avatar — so the label
   *  lines up with the avatar's centre, not the text baseline (#424). */
  align?: RowAlign;
  /** Sit the VALUE back, because its control has been withdrawn (#635). Never
   *  the row: see `VALUE_DIM`. */
  dim?: boolean;
  /** A note under the value, in its own grid cell (#635) — the reason a control
   *  is withheld. `noteId` is what the row's `aria-describedby` points at, so a
   *  screen reader on the row reaches the sentence; a row governed by a
   *  capability whose reason is written once, on a sibling, passes `noteId`
   *  alone and renders no note of its own. */
  note?: ReactNode;
  noteId?: string;
  status?: RowStatus;
  savingLabel?: string;
  /** Why the last write failed, when the caller tracks it (#577). Absent keeps
   *  the generic "Couldn't save · Retry". */
  failure?: EditFailure | null;
  onEdit?: () => void;
  onRetry?: () => void;
  /** Extra classes on the row container — e.g. `group`, so a child control can
   *  reveal itself on `group-hover`/`group-focus-within` (the Project row's
   *  remove affordance, #384 design-review B2). */
  className?: string;
  children: ReactNode;
  /** `command-menu`'s `MENU_TRIGGER`, spread on by a caller whose row opens a
   *  popover (#739/#742). It has to land on the element focus can reach — this
   *  row — because that is what Escape hands the reader back to. A plain
   *  attribute, so the row owes `ui/command-menu` no import. */
  'data-menu-trigger'?: string;
}) {
  const cls = [ROW_BASE, ROW_ALIGN[align], editable && `${ROW_EDITABLE} ${ROW_FOCUS}`, className]
    .filter(Boolean)
    .join(' ');
  const labelCls = align === 'baseline' ? `${LABEL_CLS} ${LABEL_BASELINE_NUDGE}` : LABEL_CLS;
  return (
    <div
      // `className` stays FIRST: four spec regexes find a row by
      // `<div class="…grid…"` and read the rest of the tag off what follows.
      className={cls}
      // NOT a `<button>` (#742): an editable row can contain one — Retry — and
      // can contain an `<a>`, the profile link in an Assignees value, and
      // neither is valid inside a button. `AccessSection`'s PersonRow already
      // writes this shape. It was cited here beside `ProjectsView`'s BoardCard
      // until #785 deleted the rollup, and is the one example left.
      role={editable ? 'button' : undefined}
      tabIndex={editable ? 0 : undefined}
      aria-expanded={expanded}
      data-editable={editable ? 'true' : undefined}
      data-menu-trigger={menuTrigger}
      aria-describedby={noteId}
      onClick={editable ? onEdit : undefined}
      onKeyDown={editable ? (e) => rowKeyPress(e, onEdit) : undefined}
    >
      <div className={labelCls}>{label}</div>
      <div className={dim ? `${VALUE_CLS} ${VALUE_DIM}` : VALUE_CLS}>
        {status === 'saving' ? (
          <Saving label={savingLabel} />
        ) : status === 'error' ? (
          <Failed onRetry={onRetry} failure={failure} />
        ) : (
          children
        )}
      </div>
      {note !== undefined && (
        <div id={noteId} className={NOTE_CLS}>
          {note}
        </div>
      )}
    </div>
  );
}
