/**
 * Who owns what, on the controls row (#583).
 *
 * Five chips stood here and four are struck out. The one they could not answer
 * is the one this replaces: the map could say how many repos had NO owner and
 * could not say who owned the rest, so "show me Ivan's repos" was a question the
 * page had no way to be asked.
 *
 * It is faces rather than names because the row has three people on it and a
 * face is the smallest thing that identifies one. Names would be three more
 * chips in the row #583 emptied, and the map would have swapped four narrowings
 * it did not want for three of the same shape.
 *
 * Single-select, and a second press on the chosen face clears it. A multi-select
 * would need a token pane to say which combination is in force, and this row is
 * being made shorter, not taller.
 *
 * What is NOT reused is the IssuesViewer's `FilterBar`: it is one fused text
 * field with token panes behind it, and an avatar row is not that shape —
 * wearing it would have meant pulling a new abstraction out of a component this
 * page must not touch. Nothing in `issues-viewer/` changes.
 *
 * Every word and count comes from `repos-vm.ts`, per this page's own rule.
 */
import { Avatar } from '../ui/avatar';
import { FOCUS_RING } from './controls';
import { Hint } from './repo-hint';
import { ownerSlotHint, type OwnerSlot } from './repos-vm';

/** The chip row's own height, so the faces sit on the same baseline as the
 *  search field and the order control. Wider pitch on a phone: at 420px these
 *  were 26px targets 4px apart, which is under every thumb guideline going. */
const ROW = 'flex flex-none items-center gap-1 max-[560px]:gap-1.5';

/** The pressable slot: one circle at chip height, so the row keeps one
 *  baseline — and the same width in every state, which is what stops a press
 *  moving the slots beside it. Wider on a phone, per the pitch above. */
const SLOT_SHAPE =
  'flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full max-[560px]:h-7 max-[560px]:w-7';

/** A face at rest: quiet, and lifting to full under the pointer, which is the
 *  hover the controls beside it use. No ring — the row is a row of faces, and a
 *  ring on every one of them would be four rings meaning nothing. */
const SLOT = `${SLOT_SHAPE} ${FOCUS_RING} cursor-pointer opacity-[0.62] hover:opacity-100`;

/** The chosen face: the same circle, wearing the ring and changing nothing
 *  else. It carried a first name beside the portrait, which made the pressed
 *  slot roughly 34px wider than a resting one — and a slot that grows on press
 *  shoves every slot after it along the row, every time somebody presses it. A
 *  control that answers "which of us is it" cannot be the control that makes
 *  the row move under the pointer, so the word is gone and the ring is the
 *  whole of the pressed state. The ring stays: it is the only thing marking
 *  which slot is doing the narrowing, and it is the one case the board's
 *  less-borders rule keeps a border for. */
const SLOT_ON = `${SLOT_SHAPE} ${FOCUS_RING} cursor-pointer shadow-[0_0_0_1.5px_var(--accent)]`;

/** The repos nobody owns: an empty circle where a face would be. Dashed, so it
 *  is a mark of its own rather than a smaller copy of the pressed state's ring
 *  — solid inside solid read as a radio button, which is not what this is. */
const NOBODY =
  'size-5 rounded-full border border-dashed border-[color-mix(in_srgb,var(--muted)_60%,transparent)]';

/** One slot's face. It is `src/ui/avatar`, the same Avatar every roster,
 *  assignee cluster and tile owner on the board draws, so a person looks the
 *  same here as they do everywhere else. */
function SlotFace({ slot }: { slot: OwnerSlot }) {
  if (slot.login === null) return <span className={NOBODY} aria-hidden="true" />;
  // `showTitle` off: the styled hint below already names the person, and the
  // native grey box under it would answer the same hover twice (#334).
  return <Avatar name={slot.name} login={slot.login} px={64} className="pj-av-xs" showTitle={false} />;
}

/**
 * The faces themselves. Pure, so the spec draws each state without a DOM.
 *
 * One sentence does for the hint and for the accessible name, which is unusual
 * on this page and deliberate: a face says neither whose it is nor how many
 * repos are behind it, so both readers are asking the same question.
 */
export function OwnerRow({
  slots,
  chosen,
  onOwner,
}: {
  slots: OwnerSlot[];
  /** The login narrowing the map, `null` for the repos nobody owns, `undefined`
   *  for the whole map. */
  chosen: string | null | undefined;
  onOwner: (owner: string | null | undefined) => void;
}) {
  if (slots.filter((slot) => slot.login !== null).length <= 1) return null;
  return (
    <span className={ROW}>
      {slots.map((slot) => {
        const on = chosen !== undefined && slot.login === chosen;
        return (
          <Hint key={slot.login ?? 'nobody'} label={ownerSlotHint(slot)}>
            <button
              type="button"
              aria-pressed={on}
              aria-label={ownerSlotHint(slot)}
              className={on ? SLOT_ON : SLOT}
              // A second press on the chosen face clears it, so the way back is
              // the face itself and not a control somewhere else in the row.
              onClick={() => onOwner(on ? undefined : slot.login)}
            >
              <SlotFace slot={slot} />
            </button>
          </Hint>
        );
      })}
    </span>
  );
}
