/**
 * One repo on the map (#558): its name and open count, ten weeks of issue flow
 * as a sparkline, its owner, and — where there is something to say — one short
 * coloured word.
 *
 * The surface is BLOCK and nothing else — no border and no shadow, and no
 * border anywhere on the page. There was one until #607: a warning left edge on
 * a repo whose queue was gaining ground, an accent with no legend and no hover
 * of its own. The sparkline draws those same ten weeks on every tile, so the
 * edge was summarising a chart already under it.
 *
 * One shadow does exist on this tile, and it is not on the surface: the ⋮
 * handle carries `shadow-sm` with an opaque fill (`TILE_HANDLE`), because it is
 * a control that lifts off the tile on hover and has to read over whatever the
 * footer drew. The surface it lifts off stays flat.
 *
 * Everything on the tile that carries meaning a person cannot read off it hangs
 * a hint off the board's own tooltip, never the OS grey box: the bare open
 * count, the word, the description behind the name, the owner (in OwnerPicker),
 * and the chart beside it (in repo-spark). Every one of those
 * sentences comes from `repos-vm.ts`, none is assembled here, and every one
 * goes through `Hint`, which bounds the box so a sentence wraps instead of
 * running the width of the page.
 *
 * Two slots are the exception, and both are the same case: text the tile CUT,
 * which is one of the two things `Tip.tsx` keeps the native `title` for.
 *
 * The first is the owner slot where the owner CANNOT be changed: there is no
 * control there to carry a tooltip or an accessible name, and the first name it
 * prints is cut from a full one. It reveals that full name and nothing else — an
 * unset slot prints "Set owner" whole at every tile width, so it carries no
 * title at all (OwnerPicker has the measurement).
 *
 * The second is the name on a repo with NO description. The description is what
 * the name's tooltip carries, so a repo without one had no reveal of any kind
 * behind a truncated name — 2 tiles at 1280, 2 at 768, 0 at 1440, which counts
 * the names that are cut AND carry no description, not every cut name (there
 * are 8, 6 and 2 of those, and the ones with a description were never mute) —
 * and the full name survived only on the tile's aria-label, which a pointer
 * cannot reach. It is a `title` there and a `Hint` where there is a
 * description, never both: two boxes in two skins answering one hover is the
 * doubling #573 came to remove.
 *
 * A tooltip trigger is not a control, but it is not inert either: Radix's
 * `TooltipTrigger` composes an `onClick` and an `onPointerDown` onto the child,
 * both of which only close the tooltip, and `composeEventHandlers` runs the
 * child's own handler first. So nothing a TRIGGER added navigates or opens a
 * menu — the clickable things on this tile are the ones written here, and a
 * tooltip has never added one.
 */
import type { MouseEvent, ReactElement } from 'react';
import type { OwnerWritability } from '../api/repos';
import { gotoPath, repoPath } from '../route';
import { ActionMenu } from '../ui/ActionMenu';
import { BLOCK } from '../ui/block';
import { FOCUS_RING } from './controls';
import { copyToClipboard } from '../ui/clipboard';
import { Hint } from './repo-hint';
import { OwnerPicker } from './OwnerPicker';
import { RepoSpark } from './repo-spark';
import { RepoLensSpark } from './RepoLensSpark';
import { repoActionItems } from './repo-actions';
import { tileOpens } from './tile-nav';
import {
  ALERTS_UNREAD,
  ALERTS_UNREAD_HINT,
  alertsUnread,
  countTone,
  nameHint,
  ownerUnread,
  openHint,
  tileLabel,
  tileWord,
  type CountTone,
  type RepoTile as RepoTileModel,
  type WordSlot,
} from './repos-vm';

const TILE =
  `${BLOCK} flex min-h-[112px] w-full cursor-pointer flex-col gap-[9px] px-4 pb-3 pt-3.5 text-left ` +
  'hover:bg-[color-mix(in_srgb,var(--text)_4%,var(--surface))] hover:[box-shadow:inset_0_0_0_2px_var(--accent)]';

/** Where the ⋮ sits on a tile: the TOP-right corner (#939, which moved it off
 *  the bottom-right where #606 put it).
 *
 *  Absolute, so nothing reflows when it fades in. The corner is shared with the
 *  open count, the last flex child of the first row, and the row gives ground:
 *  `NAME_ROW` reserves the strip permanently, see there.
 *
 *  This line places the hit target and nothing more, as `CARD_HANDLE` in
 *  BoardView.tsx does: the chip, its opaque `bg-overlay` fill and its edge are
 *  `action-handle.ts`'s. On a coarse pointer only the transparent target grows
 *  to 44px (DESIGN.md, "Phone pointer target of 44 px"), and the 24px chip
 *  stays centred in it. */
const TILE_HANDLE = 'absolute top-2 right-2 [@media(pointer:coarse)]:size-11';

/**
 * The first row's clearance from the ⋮ footprint. The tile's `px-4` puts the
 * content edge 16px in, and the handle's `right-2` puts its footprint's left
 * edge 32px in (`size-6`) or 52px in (`size-11`, coarse pointer). `pr-4` and
 * `pr-9` move the count's right edge to those same lines, so the count and the
 * footprint touch and never overlap. At 390px with a touch screen the count
 * used to end where a 24px target began, with the 44px target it would have
 * covered 20px of the count.
 */
const NAME_ROW = 'flex items-baseline gap-2.5 pr-4 [@media(pointer:coarse)]:pr-9';

/**
 * The corner the ⋮ occupies, reserved on the footer PERMANENTLY rather than
 * cleared on hover.
 *
 * The arithmetic, which is why this is a constant and not a guess: the handle is
 * `size-6` inset `right-2`, so it covers the strip from 8px to 32px in from the
 * tile's right edge, while `px-4` puts the footer's content edge at 16px in. The
 * footer's last child is therefore overlapped by its rightmost 16px — at every
 * tile width, because both numbers are measured from the same edge and neither
 * depends on the width between them. `pr-4` moves that edge from 16 to 32 and
 * the overlap becomes zero.
 *
 * It sits on the ROW, so the drawn word and the owner beside it are inset by
 * one number that cannot drift between them.
 *
 * Permanent because `ActionMenu`'s header promises nothing changes on hover
 * except opacity. Reserving the space only while the handle is visible would
 * slide the word out from under the pointer reaching for it — and the word's
 * tail is its own `Hint` trigger, so the tail is exactly what a reader is
 * aiming at.
 *
 * The cost is 16px off the owner's growing box, which truncates a long name one
 * character or so earlier. That is the cheapest thing in the corner: the
 * alternative was covering a `Leaked secret` down to `Leaked secr` under an
 * opaque chip, and swallowing the hover that explains it.
 */
const FOOTER = 'flex items-center gap-2 pr-4';

const NAME =
  'min-w-0 flex-1 truncate text-[13px] font-[560] leading-[1.35] tracking-[-0.008em] text-fg text-link';
/**
 * Three tones for the count, over one floor (#695, revising #613).
 *
 * #613 set every count identically, including zero, and it was right about the
 * thing it fixed. A zero used to get the tertiary ink at 45% — the faintest
 * thing on the tile, 2.12:1 against `bg-surface` on the live org in dark,
 * where an ordinary count read 6.75:1 and the 11.5px figure UNDER it read
 * 5.15:1. On ten of the org's 87 tiles that figure also reads `0`, so one tile
 * drew the same digit twice with the secondary copy 2.4x more legible than the
 * primary. A headline set as if the board doubted it, over a derived figure set
 * as if it did not.
 *
 * What #613 gave up to fix that, in its own words: "a `0` now weighs exactly
 * what an `83` weighs, so the faintness that let quiet repos recede while the
 * eye swept the grid is gone." Half this map is a zero, and #695 is that
 * faintness asked for back.
 *
 * It comes back with a floor rather than without one. The zero is set at
 * `text-muted` — 5.15:1 dark, 6.87:1 light, which is the 11.5px
 * figure's OWN tone. The inversion cannot recur: the two are the same ink, and
 * what separates them is 19px semibold over 11.5px regular. #613's ratio of
 * headline to derived figure goes from 0.41x to 1.00x.
 *
 * The loud end is `text-fg` (13.77:1 / 19.03:1) and NOT
 * `text-danger`, and that is #613's second argument standing rather than
 * being overturned. Red was measured: it takes the headline to 5.26:1 in dark,
 * below an ordinary count beside it, so the biggest number on the map would
 * become the second-faintest ink on its own tile. And the footer word two dozen
 * lines down already owns `text-danger` for a leaked credential and
 * `text-warn` for a failing CI — "an empty queue is not a healthy repo"
 * was #613's way of saying standing is that word's to report, and the converse
 * holds: a full queue is not a broken repo. The ramp is neutral so a tile can
 * carry both statements without them being read as one.
 *
 * Which counts are which is not written here. `countTone` in `repos-vm.ts`
 * decides it against a share the map derives from itself, per this page's rule
 * that every word and count comes from the model.
 *
 * What this costs, and it is a real loss rather than a rounding of one: on the
 * ten tiles reading `0` open over a `0` change, the two zeroes now share a tone
 * as well as a digit, and only size and weight tell them apart. That is a
 * smaller loss than the whisper #613 removed, and it is the one being accepted.
 */
const COUNT = 'text-[19px] font-semibold leading-none tabular-nums';
const OPEN_COUNT: Record<CountTone, string> = {
  empty: `${COUNT} text-muted`,
  ordinary: `${COUNT} text-dim`,
  heavy: `${COUNT} text-fg`,
};

/**
 * The word, and what it replaced (#578).
 *
 * The bottom right used to carry three six-pixel pips — security, CI and
 * language — which nothing on the page labelled and which did not share a colour
 * language: the first two are ordered scales, the third is Github's category
 * palette, so the red that meant a failing build one slot along meant HTML. The
 * language is gone from the tile outright, and the two health slots are now one
 * word, worst first, drawn only when there is something to report. `high`
 * security is deliberately unmarked — it fires on half this org, which is its
 * normal state rather than news, and the Security chip still counts it.
 *
 * The word has a third state since #571: the health it is drawn from arrives on
 * its own read, after the rows, so the slot stays empty until it lands. An empty
 * slot is honest and avoids a grey bar whose wait has no useful answer.
 *
 * It sizes itself and takes the right of the footer line; the owner beside it
 * grows into whatever is left.
 */
const WORD = 'flex-none text-[11px] leading-none';
const WORD_DANGER = `${WORD} text-danger`;
const WORD_WARNING = `${WORD} text-warn`;
/** The unread slot's tone (#718): the tile's quietest ink. Not `danger` and not
 *  `warning` — those two are spent on a leaked credential and a failing build,
 *  and "we did not look" must never sit at the weight of "we looked and it is
 *  bad". */
const WORD_UNREAD = `${WORD} text-muted`;

/** An addressable status word uses the same hover and focus underline as the repo
 *  name. Words without an address retain their tone and no underline. */
const WORD_LINK = `text-link ${FOCUS_RING}`;

/**
 * The word is on the tile's BOTTOM line, so the box opens below it — past the
 * tile's last row of ink, where there is nothing of this tile left to cover, in
 * any column and at any width.
 *
 * The default top side put the box over the tile's own sparkline, and right —
 * tried first — is free only until the last column, where Radix flips the box
 * left and lands it back inside the tile it describes. Measured at 1280 on
 * `landing-ui`: the box ran x 964–1190 against its own tile at x 1019–1256,
 * covering 171×31px of the owner row and the sparkline; at 1440 on
 * `acme-brain-component-app`, 208×31px. Bounding the box (`Hint`) narrowed it
 * and could not move it off, because the box is wider than the gap between the
 * tile's left edge and the word at its right. Bottom has no such column: the
 * flip it can make is vertical, and above the word is the tile it just cleared.
 *
 * Re-measured on bottom at 1280 and 1440, in the first column and the last. The
 * side holds at `bottom` in all four — Radix keeps a box in view by sliding it
 * along the side it is on, so the last column shifts it left until its right
 * edge meets the viewport's and never flips it back over the tile. What it does
 * overlap is the tile's own bottom PADDING: 152–202px wide by 12px tall, which
 * is the `pb-3` band under the footer line. Against every piece of ink the tile
 * draws — name, count, sparkline, owner, the word itself — the overlap is
 * 0 in all four. It then falls 7px into the top padding of the tile in the row
 * below, which is that tile's `pt-3.5` and likewise carries nothing.
 */
const WORD_SIDE = 'bottom' as const;

/**
 * The drawn word as an element (#605).
 *
 * Two shapes, and the second is the one the constraint is about: where no
 * address was READ, this is the same `<span>` the tile has always drawn, with
 * the same class and no handler on it — not a disabled link, not a link to
 * nowhere. The board points only at addresses Github handed it, so a word with
 * none behaves exactly as it did before this existed.
 *
 * Built as an element rather than a component because `Hint` composes handlers
 * onto its child through Radix's `Slot`, which clones a real element; a function
 * component in that position would swallow the ref the tooltip positions by.
 *
 * `target="_blank" rel="noopener"` — the map is a place you sweep, and sending
 * a reader to Github in place would cost the sweep. The click also stops here:
 * the card around it carries a plain `onClick` that opens the repo's own page,
 * and reaching the failing run must not ALSO open a page nobody asked for. That
 * is the same guard `OwnerPicker` beside it has carried since #558.
 */
function drawnWord(word: Extract<WordSlot, { state: 'word' }>): ReactElement {
  const tone = word.tone === 'danger' ? WORD_DANGER : WORD_WARNING;
  if (!word.href) return <span className={tone}>{word.text}</span>;
  return (
    <a
      href={word.href}
      target="_blank"
      rel="noopener"
      className={`${tone} ${WORD_LINK}`}
      onClick={(e) => e.stopPropagation()}
    >
      {word.text}
    </a>
  );
}

export function RepoTile({
  tile,
  driOptions,
  canWrite,
  writability,
  share,
  alertsReportedAbove = false,
}: {
  tile: RepoTileModel;
  /** A page notice already covers this repository’s unread alerts. */
  alertsReportedAbove?: boolean;
  /** What one repo's share of this map's queue is, or `null` where the map
   *  derived none — read off the WHOLE map by `ReposPage`, never off what a
   *  search left, so typing cannot move the line a tile is judged against. */
  share: number | null;
  /** The logins this repo's owner may be set to — its OWN org's list, resolved
   *  by `driOptionsFor` on the page (#728). */
  driOptions: string[];
  canWrite: boolean;
  /** What the org's `dri` property will take, straight from the view (#649).
   *  Passed through untouched rather than folded into `canWrite`, because one
   *  of its states changes the WORDS in the owner slot and not only whether a
   *  control is there. Optional: a board-api too old to say leaves it absent. */
  writability?: OwnerWritability;
}) {
  const { row } = tile;
  const path = repoPath(row.full);
  const word = tileWord(tile.health);
  // The two unread states this tile can be in (#718), and they are independent:
  // one is the org's `dri` ownership read, the other its three alert lists. A
  // tile can be in either, both, or neither.
  const noOwnerRead = ownerUnread(row);
  const noAlertsRead = alertsUnread(tile.health);
  const description = nameHint(row);
  // The queue stays on the TILE menu, where #575 put it: the tile itself opens
  // the repo's page, so this is the map's only way to the filtered list.
  const items = repoActionItems(
    row,
    {
      openExternal: (url) => {
        window.open(url, '_blank', 'noopener');
      },
      goto: gotoPath,
      copy: copyToClipboard,
    },
    { queue: true },
  );

  /** A plain left click opens the repo's page in place; every modified click
   *  (cmd or ctrl for a new tab, shift for a window, middle-click) is left to
   *  the browser, which is why the name is a real anchor rather than a handler. */
  const open = (e: MouseEvent<HTMLElement>) => {
    if (!tileOpens(e)) return;
    e.preventDefault();
    gotoPath(path);
  };

  /**
   * The name truncates at every width the grid makes —
   * `acme-deployment-extension-gateway` renders as
   * `acme-deployment-extensi…` at 1280 — and where the repo carries a
   * description, the board's tooltip holds it while the rest of the name stays
   * one click away on the repo itself. Where it carries none there was nothing:
   * `nameHint` returns null, so a cut name had no reveal a pointer could reach,
   * on the page whose job is finding a repo. That is the second of the two cases
   * `Tip.tsx` keeps the native attribute for — "a plain `title`/`aria-label` …
   * where the hint … reveals truncated text" — so it is a `title` and not a
   * `Hint`.
   *
   * What it costs: on the tiles whose name is NOT cut, the hover repeats a label
   * already on screen. That is accepted here because names genuinely truncate at
   * every width, and the alternative — measuring truncation to decide — cannot be
   * done from the model this component is handed.
   */
  const name: ReactElement = (
    <a href={path} onClick={open} className={NAME} title={description ? undefined : row.name}>
      {row.name}
    </a>
  );

  /**
   * Three or four clickable things, and why they are siblings.
   *
   * Four where the health read brought back an address (#605): the word in the
   * footer is then a real anchor to the run or the alert it names, and it is the
   * only one of the four that is not always there. The other three always are.
   *
   * The tile opens the repo's own page (#575), and the owner inside it opens a
   * menu. Until #575 the tile opened the repo's filtered issue queue; that queue
   * is now the first item on the tile's action menu, which is the one step away
   * the issue asks for. Nothing else about the arrangement changed — only where
   * the anchor and the card handler point.
   *
   * A <button> inside an <a> is invalid HTML and browsers recover from it
   * inconsistently, so the tile is NOT an anchor: the real link covers the repo
   * NAME — the thing a person aims at, and the thing they expect cmd-click,
   * middle-click and "copy link address" to work on — and the card around it
   * carries a plain click handler as a convenience for the rest of its area. The
   * owner control is a sibling button whose press stops the click propagating, so
   * changing an owner never also navigates. The ⋮ handle #606 added is a sibling
   * of the card rather than a child of it — `ActionMenu` renders it beside the
   * children it wraps — so its press never reaches the card handler at all, and
   * the `stopPropagation` on it is belt as well as braces.
   *
   * Keyboard reaches everything through those real controls: tab lands on the
   * name (Enter follows it), then the owner (Enter opens the picker), then — on a
   * tile whose word carries an address — the word itself, then the ⋮ (Enter opens
   * the menu). The word is a stop only where there is somewhere to go, which is
   * the same rule the pointer gets, said in the one place a keyboard can hear it.
   * The ⋮ is invisible at rest and draws itself on `focus-visible`, so tabbing to
   * it does not land on nothing. The card itself is deliberately not focusable —
   * a focusable card wrapping the controls inside it is a stop that does nothing
   * new, and marking it role="button" would hide them from a screen reader.
   */
  return (
    <ActionMenu items={items} handleLabel="Repo actions" handleClassName={TILE_HANDLE} className="h-full">
      <div
        data-repo={row.key}
        aria-label={tile.metric ? `${row.name}: ${tile.metric.hint}` : tileLabel(row, share)}
        className={TILE}
        onClick={open}
      >
        {/* Both of these keep the tooltip's default TOP side, measured rather
            than assumed: the box lands above the tile and clears the tile's own
            name and count (at 1280 its bottom edge is y 201, the count starts
            at 205 and the name at 208), overlapping only the top padding. Right
            was tried and is worse — the name is `flex-1`, so its right edge (x
            458) sits a dozen pixels from the count (x 468–493), and a
            right-side hint on the name covered the count outright. */}
        <span className={NAME_ROW}>
          {/* No board tooltip where there is no description — the only sentence
              one could carry is the name already on screen. The name still
              answers a hover there, through the native `title` set above, which
              is the only way a cut name can be finished. */}
          {description ? <Hint label={description}>{name}</Hint> : name}
          <Hint label={tile.metric?.hint ?? openHint(row, share)}>
            {/* An empty count still needs a text baseline to keep names aligned. */}
            <span data-repo-metric={tile.metric?.lens ?? 'issues'} className={`repo-metric ${tile.metric?.value === null
              ? 'text-[11px] text-dim'
              : OPEN_COUNT[tile.metric && tile.metric.lens !== 'issues' ? 'ordinary' : countTone(row.open, share)]}`}>
              {(tile.metric?.lens ?? 'issues') === 'issues' && (tile.metric ? tile.metric.value : row.open) === 0
                ? null
                : tile.metric?.label ?? row.open}
            </span>
          </Hint>
        </span>

        <span className="mt-auto block">
          {tile.metric && tile.metric.lens !== 'issues' ? <RepoLensSpark metric={tile.metric} /> : <RepoSpark row={row} />}
        </span>

        <span className={FOOTER}>
          {/* The owner takes the free space and the word keeps its own — sized
              here rather than inside the picker, so the read-only and editable
              branches are laid out identically. */}
          <span className="flex min-w-0 flex-1">
            {/* The picker STAYS on an unread owner (#718). The read that failed
                was the read; the write goes through a different call and can
                still land, so withholding it would take away the one control
                that could put the missing owner back. */}
            <OwnerPicker
              row={row}
              driOptions={driOptions}
              canWrite={canWrite}
              writability={writability}
              ownerUnread={noOwnerRead}
            />
          </span>
          {/* No `ml-auto` here, deliberately. An auto margin absorbs ALL free
              space BEFORE flex-grow is applied, so it left the flex-1 owner
              beside it with nothing to grow into and collapsed the name to
              "A..". The owner grows instead, which puts this on the right
              anyway. `flex-none` on the word keeps it its own size. */}
          {/* The unread word fills the QUIET slot only, and never one already
              holding a word (#718). KEEP THIS BRANCH IN THIS ORDER. A word is
              something the board MEASURED — a red build comes off the Actions
              API, which did not refuse — and replacing it with "Alerts not
              read" would hide a fact in order to report an absence. A tile with
              both says the fact; the page's line above the grid is what states
              the loss, and it states it for the whole org rather than one tile.

              It cannot collide with `unsettled`: that state is the health read
              still in flight, and there is no health to be unreadable until it
              lands. */}
          {tile.health?.security.state === 'not-applicable' && word.state !== 'word' ? <span className={WORD_UNREAD}>Alerts not applicable</span> : noAlertsRead && !alertsReportedAbove && word.state !== 'word' ? (
            <Hint label={ALERTS_UNREAD_HINT} side={WORD_SIDE}>
              <span className={WORD_UNREAD}>{ALERTS_UNREAD}</span>
            </Hint>
          ) : (
            <>
              {word.state === 'word' && (
                <Hint label={word.hint} side={WORD_SIDE}>
                  {drawnWord(word)}
                </Hint>
              )}
            </>
          )}
        </span>
      </div>
    </ActionMenu>
  );
}
