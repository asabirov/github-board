/**
 * A repo's owner, on the tile (#558) — read for everyone, editable for a viewer
 * who may write.
 *
 * It writes the org's `owner` custom property, and its choices are that property's
 * own `allowed_values` as the server read them for THIS repo's org — the page
 * resolves them per repo through `driOptionsFor` (#728), because the union view
 * carries every served org's values and the write gate compares against one
 * org's. So the menu cannot offer a login Github would refuse. The commit runs through the
 * SAME optimistic engine every issue-page facet editor uses (`useFacetEdit`):
 * the pick shows at once, the server's returned owner is what the tile settles
 * on (Github coerces silently, so the response is the truth, not the request),
 * and a refused write rolls back to the owner that was there and offers a retry
 * in the same words as every other refused write on this board.
 *
 * When the owner cannot be changed there is no control at all — a plain span,
 * no button, no role, no hover raise. A control that cannot work must not look
 * like one. Two things withhold it, and `OwnerPicker` below is where both are
 * applied — read that, not this, for the rule:
 *
 *   · `canWrite` — a viewer who may not write, or an org whose `owner` property
 *     cannot take a value from this board: Github's own restriction (#577), or
 *     no such property on the org at all (#649). `ReposPage` folds the second
 *     in through `ownerControlOffered`, because the page is where the map's
 *     `ownerWritability` lives.
 *   · no logins to offer — the allowed values and the writability come out of
 *     ONE schema read, so a read that failed leaves nothing to pick, and the
 *     menu would hold a single row: "No owner".
 *
 * One of those two withholdings also changes the WORDS. An org with no `owner`
 * property has nothing to set, so the resting slot must not go on saying "Set
 * owner" — that is the same sentence as a repo somebody has simply not got
 * round to owning, and the two are not the same fact. `writability` comes down
 * here for that, and `repos-vm` owns the words as it owns every other word on
 * this page.
 *
 * A refused write says what it hit rather than that something happened, and
 * offers a retry only where a retry could change the answer.
 */
import { useRef, useState } from 'react';
import { setRepoDri, type OwnerWritability, type RepoOwner, type RepoRow } from '../api/repos';
import { Avatar } from '../ui/avatar';
import { Hint } from './repo-hint';
import { MENU_TRIGGER } from '../ui/command-menu';
import { PICK_NONE, PickDialog, PickList } from '../ui/pick-list';
import { Failed, type RowStatus } from '../issue/PropertyRow';
import { useFacetEdit, type EditFailure, type FacetEditOptions } from '../issue/use-facet-edit';
import { useRefreshBump } from '../sync/sync-status';
import { usePeople, resolvePerson } from '../people-ctx';
import {
  ownerAria,
  ownerHint,
  ownerName,
  ownerRestHint,
  ownerShortName,
  ownerOptions,
  repoRef,
  SET_OWNER,
  type OwnerOption,
} from './repos-vm';

/** The owner slot's pressable box, at tile scale: the padding gives it a hit
 *  area and the negative margin gives every pixel of it back, so whatever wears
 *  it occupies exactly the space the resting value occupies. */
// `truncate` sets overflow:hidden, which zeroes the name's automatic minimum —
// so every level between the tile's owner slot and that name has to GROW
// (`flex-1 min-w-0`), not merely size to content. Break the chain anywhere and
// the width resolves to zero and "Anton" renders as "A..".
const SLOT_BOX =
  'flex min-w-0 flex-1 items-center gap-[7px] -mx-1.5 -my-[3px] rounded-[7px] px-1.5 py-[3px] text-left';
/** PropertyRow's hover-raise, at tile scale: the value lifts to say it is
 *  editable. `cursor-pointer` because a <button> takes `cursor: default` from
 *  the UA sheet whatever the card around it says — leaving the only genuinely
 *  pressable thing on the tile as the one thing not drawn as pressable. */
const OWNER_BUTTON = `${SLOT_BOX} cursor-pointer hover:bg-elevated`;
/**
 * The failure note when it is the way out (a refusal with no Retry).
 *
 * It cannot lighten to say so. You cannot hover this without also hovering the
 * card, and the card's own hover — `text-primary 4%` over the surface — lands
 * ABOVE `--bg-elevated`, so the raise every other control uses reads here as
 * the note going darker than its own background. A hue does what a value
 * cannot: a wash of the note's own danger colour, which no other state on the
 * card produces. Same box as `SLOT_BOX`, so this costs no height.
 */
const NOTE_DISMISS =
  `${SLOT_BOX} cursor-pointer hover:[background:color-mix(in_srgb,var(--pink)_16%,transparent)]`;
/** The failure note when Retry is the way out: not itself pressable, so it says
 *  so with the cursor — and still swallows its own click, or the tile beneath
 *  would open the repo's queue under a message about a failed write. */
const NOTE_INERT = 'flex min-w-0 flex-1 cursor-default items-center gap-[7px]';
const OWNER_READONLY = 'flex min-w-0 flex-1 items-center gap-[7px]';
const OWNER_NAME = 'min-w-0 truncate text-[11.5px] text-fg';
const OWNER_UNSET = 'min-w-0 truncate text-[11.5px] text-muted';
/** The empty slot where a face would be — a hairline ring, so "nobody" still
 *  occupies the shape an owner occupies and the row never reflows on a write. */
const AVATAR_EMPTY =
  'size-[18px] flex-none rounded-full shadow-[inset_0_0_0_1.5px_color-mix(in_srgb,var(--muted)_40%,transparent)]';

/** The side effects the write has beyond the button itself. */
export interface OwnerEditDeps {
  /** Nudge other mounted surfaces to re-read after a successful write (#384). */
  onWritten: () => void;
}

/**
 * The write behind the picker, spelled out apart from React so the optimistic
 * path, the reconcile and the rollback are exercised by the same object the
 * component hands to `useFacetEdit`. The address comes off the row's canonical
 * key, so a write always lands on the org the map was built from.
 */
export function ownerEdit(row: RepoRow, deps: OwnerEditDeps): FacetEditOptions<RepoOwner | null> {
  const { owner, repo } = repoRef(row);
  return {
    initial: row.owner,
    commit: (next) => setRepoDri(owner, repo, next?.login ?? null),
    apply: () => deps.onWritten(),
  };
}

/** A press anywhere in the owner slot: do the slot's own thing, and never also
 *  open the repo's queue. The tile's click handler is upstream of this one, so
 *  stopping the click here is what keeps the two apart. Every state of the slot
 *  runs through it — opening the menu, dismissing a refusal, and a note that
 *  does nothing but must still not fall through.
 *
 *  The slot sits inside a tile that is itself clickable. It is a SIBLING of the
 *  tile's link, never nested inside it (a <button> inside an <a> is invalid HTML
 *  and browsers recover from it inconsistently), and stopping the click here is
 *  what keeps opening the menu from also opening the repo's queue.
 *
 *  EVERY state of the slot has to stop it, not just the resting one. A failure
 *  note that lets the click through opens the repo's queue instead of doing what
 *  the note is for — which is what pressing Retry did before #577's third pass. */
export function ownerPress(e: { stopPropagation: () => void }, open: () => void): void {
  e.stopPropagation();
  open();
}

/**
 * The face beside the owner's name, the empty ring where the org records
 * nobody — and NOTHING at all where the ownership read failed (#718).
 *
 * The ring is a person slot with nobody in it, which is a claim about the org,
 * and the board does not get to make it on a read that never landed. Dropping
 * it also pays for the words: on a tile carrying both unread states the slot
 * has 79px at 1280 and "Owner not read" asks 84, so it drew "Owner not r…" —
 * cutting the one word that carries the meaning. The ring and its gap are worth
 * about 25px, measured on the running page.
 */
function OwnerFace({ owner, unread = false }: { owner: RepoOwner | null; unread?: boolean }) {
  if (!owner) return unread ? null : <span className={AVATAR_EMPTY} aria-hidden="true" />;
  return <Avatar name={owner.name} login={owner.login} px={36} className="pj-av-sm" showTitle={false} />;
}

/**
 * The resting display, identical whether or not the viewer can write.
 *
 * The tile prints the first name only, so the FULL name has to be reachable some
 * other way — and which way depends on whether there is a control here at all.
 *
 * A viewer who CANNOT write gets no button and therefore no accessible name, so
 * without the plain `title` the whole surface would never say who "Artur" is.
 * That title stays: it reveals truncated text and nothing more, which is one of
 * the two cases `Tip.tsx` keeps the native attribute for.
 *
 * It stops at the owned case, and that is a measurement rather than an
 * oversight. The unset slot has no button under it either, so the same argument
 * appears to reach it — but the argument is about text the tile CUT, and "Set
 * owner" is not cut: 0 of the 49 unset tiles truncate it, at 420, 768, 1024,
 * 1280 or 1440. The label asks 55px and the slot leaves it 99–180px at 1280
 * (136–217 at 1440), which is the room the three pips gave back when #578 took
 * them off the footer — `ownerShortName` has the rest of that measurement. A
 * title here would hand a reader a grey box repeating a label they can already
 * read, on 49 of the 78 tiles, and this page spent #573 taking exactly that
 * off. If the footer ever tightens enough to cut the label, the argument
 * reaches it and the title comes back with it.
 *
 * A viewer who CAN write gets the board's own tooltip around the button instead
 * (#573) — the full name AND what pressing it does — so `showTitle` is false
 * there, or the tile would answer a hover twice, once in the OS grey box.
 */
function OwnerValue({
  owner,
  showTitle,
  writability,
  unread = false,
}: {
  owner: RepoOwner | null;
  showTitle: boolean;
  writability?: OwnerWritability;
  /** This repo's org's ownership read failed (#718), so the slot must not say
   *  "Set owner" — that names a fact (the org records no owner) and this is the
   *  absence of one. */
  unread?: boolean;
}) {
  return (
    <>
      <OwnerFace owner={owner} unread={unread} />
      <span className={owner ? OWNER_NAME : OWNER_UNSET} title={showTitle && owner ? ownerName(owner) : undefined}>
        {ownerShortName(owner, writability, unread)}
      </span>
    </>
  );
}

/**
 * The dialog's list. Exported so the rows it offers can be asserted as markup
 * without a DOM — the `Dialog` around it draws into a portal that static markup
 * never reaches — and so the list is defined once, in the same search every
 * other data picker on the board draws (#1021).
 *
 * The row that clears the owner leads the list rather than trailing it, where
 * every "None" on the board sits, and it is searched by its words but not
 * counted: the field says how many people the property allows.
 */
export function OwnerMenu({
  options,
  value,
  onPick,
}: {
  options: OwnerOption[];
  value: RepoOwner | null;
  onPick: (login: string | null) => void;
}) {
  const face = (option: OwnerOption) => (
    <OwnerFace owner={option.login ? { login: option.login, name: option.label } : null} />
  );
  const clear = options.find((option) => option.login === null);
  return (
    <PickList
      reserve
      noun="owners"
      items={options.flatMap((option) => (option.login ? [{ id: option.login, name: option.label, mark: face(option) }] : []))}
      lead={clear && { id: PICK_NONE, name: clear.label, mark: face(clear) }}
      selected={[value?.login ?? PICK_NONE]}
      onPick={(id) => onPick(id === PICK_NONE ? null : id)}
    />
  );
}

/**
 * The control itself, in whichever state the last write left it. Pure — the
 * editor below owns the state and passes it in, which is also how each state
 * is drawn on its own in the spec.
 *
 * A refused write replaces the value with the board's one failure affordance
 * rather than keeping a value that was never saved — carrying `failure`, so it
 * says what actually happened and only offers Retry where Retry could help.
 *
 * Where Retry is withheld the note itself becomes the control, because
 * withholding it would otherwise withhold the only thing on the tile that could
 * put the owner back: no avatar, no name, no picker, for the rest of the
 * session. It occupies the same box as the owner button — the padding and the
 * negative margin cancel — so a failure never moves the tile.
 */
export function OwnerControl({
  row,
  owner,
  editable,
  writability,
  unread = false,
  status = 'idle',
  failure,
  expanded = false,
  onPress,
  onRetry,
  onDismiss,
}: {
  row: RepoRow;
  owner: RepoOwner | null;
  editable: boolean;
  /** This repo's org's ownership read failed (#718). */
  unread?: boolean;
  /** What the org's `owner` property will take (#649). Read for its words only —
   *  whether there is a control here at all was decided before this, by
   *  `ownerControlOffered` on the page. */
  writability?: OwnerWritability;
  status?: RowStatus;
  /** Why the last write failed. Absent keeps the generic wording. */
  failure?: EditFailure | null;
  expanded?: boolean;
  onPress?: (e: { stopPropagation: () => void }) => void;
  onRetry?: () => void;
  /** Put the failure behind you and show the owner again. Only ever reached
   *  from a failure that offers no Retry — see the note above. */
  onDismiss?: () => void;
}) {
  if (status === 'error') {
    // Retry is itself a <button>, and a button inside a button is invalid HTML
    // — the same rule this file already keeps for the tile's anchor. So exactly
    // one of the two is a control, never both.
    if (failure && !failure.canRetry) {
      return (
        <button
          type="button"
          aria-label={`${failure.text}. Click to dismiss.`}
          className={NOTE_DISMISS}
          onClick={(e) => ownerPress(e, () => onDismiss?.())}
        >
          <Failed failure={failure} />
        </button>
      );
    }
    return (
      <span className={NOTE_INERT} onClick={(e) => ownerPress(e, () => {})}>
        <Failed onRetry={onRetry} failure={failure} />
      </span>
    );
  }
  if (!editable) {
    // There is no control here to explain itself, so where the slot's words
    // name a limitation rather than an action, the hover says whose limitation
    // it is — three words cannot. `ownerRestHint` returns `null` everywhere
    // else, and a hover that repeats the label is a hover spent for nothing.
    // A viewer who may not write reaches this branch on an unread owner too, and
    // there is no control here to explain itself, so the hover is what says why
    // the slot has no name in it (#718).
    const rest = ownerRestHint(owner, writability, unread);
    const slot = (
      <span className={OWNER_READONLY}>
        <OwnerValue owner={owner} showTitle writability={writability} unread={unread} />
      </span>
    );
    return rest ? <Hint label={rest}>{slot}</Hint> : slot;
  }
  // The hint wraps the button rather than adding one: `Hint` (and `Tip` under
  // it) keeps the child as the real element, so this is still exactly one
  // control, with the same press and the same accessible name. Radix composes
  // its own onClick onto the button, which only closes the tooltip and runs
  // after this one. The two sentences differ on purpose — see `ownerHint`.
  // The control STAYS on an unread owner (#718): the read that failed was the
  // read, and a write can still land — so the hover says both halves, what is
  // missing and that pressing still writes.
  const hint = ownerHint(owner, unread);
  return (
    <Hint label={hint}>
      <button
        type="button"
        aria-label={ownerAria(row, owner)}
        aria-expanded={expanded}
        // Where Escape puts the reader back (#739).
        {...MENU_TRIGGER}
        className={OWNER_BUTTON}
        onClick={onPress}
        data-saving={status === 'saving' ? 'true' : undefined}
      >
        <OwnerValue owner={owner} showTitle={false} writability={writability} unread={unread} />
      </button>
    </Hint>
  );
}

export function OwnerPicker({
  row,
  driOptions,
  canWrite,
  writability,
  ownerUnread = false,
}: {
  row: RepoRow;
  /** The org's ownership read failed for this repo (#718). Changes the words
   *  and the hover; never whether the control is there. */
  ownerUnread?: boolean;
  /** What THIS repo's org's `owner` property will take — `driOptionsFor` on the
   *  page, never the whole map's `driOptions` (#728). Empty is what withholds
   *  the control below, and it is now decided per repo. */
  driOptions: string[];
  /** May the owner be changed here at all — the viewer's permission AND the
   *  `owner` property's, folded together by `ReposPage` (see the note above). */
  canWrite: boolean;
  /** The same property's state, unfolded, for the one case where the resting
   *  words differ (#649). Never decides whether a control is drawn. */
  writability?: OwnerWritability;
}) {
  // No logins to offer means no picker, whatever the writability says. The
  // allowed values and the writability come out of ONE schema read, so a read
  // that failed leaves this empty — and the menu would then hold a single row,
  // "No owner". That is a control that cannot do the thing it is for, offering
  // only the destructive half; and because the server re-reads the schema on
  // every press, a read that recovers on that press makes the clear LAND and
  // wipe an owner that was correctly set (#577).
  //
  // It is deliberately keyed on there being something to pick rather than on
  // the writability. `unknown` is a schema that WAS read and returned a setting
  // we do not recognise; the allowed values are real there, so the picker is
  // drawn and the server refuses the write out loud and retryably.
  if (!canWrite || driOptions.length === 0) {
    return <OwnerControl row={row} owner={row.owner} editable={false} writability={writability} unread={ownerUnread} />;
  }
  return <OwnerEditor row={row} driOptions={driOptions} writability={writability} unread={ownerUnread} />;
}

function OwnerEditor({
  row,
  driOptions,
  writability,
  unread = false,
}: {
  row: RepoRow;
  driOptions: string[];
  writability?: OwnerWritability;
  /** This repo's org's ownership read failed (#718). */
  unread?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const people = usePeople();
  const bump = useRefreshBump();
  const { value, status, failure, edit, retry, dismiss } = useFacetEdit<RepoOwner | null>(
    ownerEdit(row, { onWritten: bump }),
  );

  const nameOf = (login: string) => resolvePerson(people, login, null)?.displayName ?? null;

  // The tile around this carries a plain `onClick` that opens the repo's page,
  // and the button that opens the picker stops its own press for that reason
  // (`ownerPress`). The picker's scrim and panel are the other half of it: they
  // are drawn into a portal, and React bubbles a portal's events up the tree it
  // was RENDERED in, so a press on either arrives here and opened the repo. This
  // box stopped that for a while; `PickDialog` stops it in the shell now, above
  // its own scrim, so every picker on the board is covered and not just this one.
  // `tabIndex={-1}` so the box can take focus when the control inside it cannot.
  // A refused write replaces `OwnerControl` with "Can't save right now · Retry",
  // which wears no `MENU_TRIGGER`, so the dialog's restore falls back to this
  // box — and a plain `<span>` answers `.focus()` with nothing, which leaves the
  // reader on `<body>`. It is the shape #1072 met in the add block and B3 met
  // here, and it is answered the same way: whatever is left standing catches the
  // focus the control dropped.
  return (
    <span ref={wrap} tabIndex={-1} className="relative flex min-w-0 flex-1">
      <OwnerControl
        row={row}
        owner={value}
        editable
        writability={writability}
        unread={unread}
        status={status}
        failure={failure}
        expanded={open}
        onPress={(e) => ownerPress(e, () => setOpen((was) => !was))}
        onRetry={() => void retry()}
        onDismiss={dismiss}
      />
      <PickDialog
        open={open}
        onOpenChange={setOpen}
        trigger={wrap}
        title="Owner"
        note="Picking one saves it and closes."
      >
        <OwnerMenu
          options={ownerOptions(driOptions, nameOf)}
          value={value}
          onPick={(login) => {
            setOpen(false);
            // The optimistic value is a placeholder only: the tile settles on
            // whatever the server returns.
            void edit(login === null ? null : { login, name: nameOf(login) });
          }}
        />
      </PickDialog>
    </span>
  );
}
