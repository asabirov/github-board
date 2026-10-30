/**
 * The IssuesViewer's board view (#376, powered up in #394) — the RenderGroups laid
 * out as columns in recessed kanban wells (columns follow the active group
 * dimension, so switching "Grouped by" re-stacks the board). This is where the
 * dispatch power the retired `IssueQueue` carried now lives:
 *   • per-column Copy-for-agent — a stack's issue links as agent-ready markdown;
 *   • per-card context menu (right-click) + a hover-⋮ handle in the card's
 *     top-right — open on Github, copy link, copy `repo#number`, change who it is
 *     assigned to (#1009), close the issue with a reason (confirmed, #1006).
 *     Since #446 that menu is the shared `ui/IssueActions`, mounted
 *     on every issue row app-wide.
 * Cards open the in-board issue page; a closed card reads by a dimmed title, no
 * state glyph. A card names its issue `repo#number` (#674), the same identifier
 * the shared list row prints, so Home carries one convention and not two.
 *
 * A repository name is longer than a 210px column in both places the board says
 * one — the card's meta row and the column header's chip when the board is
 * grouped by repo (#661) — and it gives way the same way in both: shortened from
 * the middle, measured, full value on hover. One rule, `useElidedText` below.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { FilterProject } from '../api/issues';
import { gotoPath, issuePathFromUrl } from '../route';
import { boardLinkProps } from '../repos/repo-page-parts';
import { StatusChip } from '../ui/StatusChip';
import { AssigneeCluster } from '../ui/AssigneeCluster';
import { IssueActions, useAssignedHere } from '../ui/IssueActions';
import { Tip } from '../ui/Tip';
import type { ViewerIssue } from './viewer-issue';
import { columnBoardPath } from './column-link';
import type { GroupDim } from './filter-group';
import type { RenderGroup } from './viewer-groups';
import { issueReference, issueReferenceParts, middleElide, stackMarkdown } from './board-card';
import { BOARD_CARD, BOARD_WELL } from './board-shape';
import { TriageValue } from './TriageValue';
import { workflowLabels } from './workflow-labels';

// No state glyph on a card either — a closed card (a non-lifecycle grouping under
// an `all` filter) reads by a dimmed title, not a colored ring.
//
// Reserve the original small hover handle without moving text on hover.
// Coarse pointers retain a larger visible target and matching title clearance.
const cardTitleClass = (closed: boolean) =>
  `break-words pr-6 [@media(pointer:coarse)]:pr-[52px] text-[13px] font-semibold leading-snug ${closed ? 'text-muted' : 'text-fg'}`;

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="size-[13px]">
    <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="size-[13px]">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

/** Per-column Copy-for-agent — the stack's links as markdown, with a transient
 *  confirmation (ported from IssueQueue's StackCopy). */
function ColumnCopy({ label, items }: { label: string; items: ViewerIssue[] }) {
  const [done, setDone] = useState(false);
  return (
    <Tip label="Copy this stack’s issue links for an agent">
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(stackMarkdown(label, items)).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          }, () => {});
        }}
        className={`ml-auto flex cursor-pointer ${done ? 'text-success' : 'text-muted hover:text-accent'}`}
      >
        {done ? <CheckIcon /> : <CopyIcon />}
      </button>
    </Tip>
  );
}

/** The card's ⋮ sits in the card's TOP-right corner (#662), over the surface
 *  rather than in the flow, so revealing it never reflows the card.
 *
 *  It moved off the bottom-right because that corner is the assignee's. Sharing
 *  it cost the reader a fact: the avatar had to fade out on hover so the two
 *  wouldn't overlap, so reaching for the menu erased who the issue belongs to.
 *  Up here the ⋮ shares with the title instead, and a title can give ground —
 *  `cardTitleClass` reserves the strip permanently, see there.
 *
 *  This line places the hit target and nothing more (#948): the chip, its fill
 *  and its edge are `action-handle.ts`'s. On a coarse pointer only the
 *  transparent target grows to 44px, and the 24px chip stays centred in it. */
const CARD_HANDLE = 'absolute right-2 top-2 [@media(pointer:coarse)]:size-11';

// The meta row: `repo#number` on the left, the assignee on the right.
//
// The reference is one string but two spans, and the split is load-bearing twice
// over. The repo half is the only half that may give way — a cut that ate the
// number would take the identifier with it — and the number half being its own
// element is what reserves the space the repo half must fit inside.
//
// `flex-1` on the meta span, not `justify-between` on the row: the span then
// measures the same width whatever it contains, so the ResizeObserver below
// can't chase its own output. The row's `gap-3` is the minimum the digits keep
// from the avatar, and it holds at every name length for the same reason.
//
// No `truncate` here. CSS ellipsis cuts at a character boundary and leaves the
// slack inside the box, which put a visible space between the cut mark and the
// `#` — `repo… #124` read as two tokens exactly on the cards that needed to read
// as one. The name is shortened in JS instead, so both spans are content-width
// and the two halves are always touching.
const CARD_META_ROW = 'flex items-center gap-3';
const CARD_META = 'flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap text-[12px] text-muted';
const CARD_META_REPO = 'min-w-0 overflow-hidden';
const CARD_META_NUMBER = 'shrink-0 tabular-nums';
const CARD_ASSIGNEE = 'flex shrink-0 items-center gap-1.5';

/** Glyph widths for the text `el` renders, from one canvas shared by every card.
 *  Null where there's no 2D context (jsdom) — the caller then leaves the name
 *  whole and the meta row clips, rather than measuring against nothing. */
let measureCtx: CanvasRenderingContext2D | null | undefined;
function textWidthIn(el: HTMLElement): ((text: string) => number) | null {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
  const ctx = measureCtx;
  if (!ctx) return null;
  const css = getComputedStyle(el);
  // Composed rather than read from the `font` shorthand, which not every engine
  // returns computed.
  ctx.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
  return (text) => ctx.measureText(text).width;
}

/** What shortening a name needs: how wide a candidate paints, and how much width
 *  the name may take. Null when the box can't be measured (no 2D context in
 *  jsdom, a sibling not mounted yet) — the name is then left whole. */
type Fit = { widthOf: (candidate: string) => number; budget: number };

/**
 * `text` as its box can show it: middle-elided against the width the box
 * actually has, and re-measured whenever that width changes. A column is
 * `minmax(210px, 1fr)`, so its width follows the viewport — a single measurement
 * at mount would be right only at the width it mounted in.
 *
 * Both places a repo name has to give way run through here — the card's meta row
 * and the column header's chip — so the board has ONE rule for how a repository
 * name shortens rather than two that can drift apart.
 *
 * `fitIn` is the caller's, because only the caller knows which element paints
 * the text and what sits beside it that may not give way. It is handed the label
 * currently ON SCREEN as well as the box, so a caller whose chrome wraps the
 * text (the chip's padding and dot) can subtract that chrome at its real
 * rendered width instead of copying numbers out of a shared component.
 */
function useElidedText<T extends HTMLElement>(text: string, fitIn: (box: T, showing: string) => Fit | null) {
  const boxRef = useRef<T>(null);
  const [shown, setShown] = useState(text);
  // What is painted right now, readable from a ResizeObserver callback created
  // before it: the effect re-runs on `text`, not on every render, so the state
  // in its closure would be the value at mount.
  const showingRef = useRef(text);
  const fitRef = useRef(fitIn);
  fitRef.current = fitIn;

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const refit = () => {
      const fit = fitRef.current(box, showingRef.current);
      if (!fit) return;
      const next = middleElide(text, (candidate) => fit.widthOf(candidate) <= fit.budget);
      showingRef.current = next;
      setShown(next);
    };
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [text]);

  return { boxRef, shown };
}

// The column header: the group's chip, its row count, and Copy-for-agent.
//
// The chip and the count travel together in a box that takes the row's slack, so
// the copy button keeps its right edge and the label is the only thing that can
// give way. `flex-1` on that box rather than `justify-between` on the row, for
// the same reason the card's meta span is: the box then measures the same width
// whatever the chip contains, so the ResizeObserver can't chase its own output.
//
// `overflow-hidden` is the floor, not the mechanism — the name is shortened in
// JS above, and this only holds the line in the frame before that runs, or where
// nothing can be measured at all (jsdom). `shrink-0` on the count says the same
// thing as `flex-1` on the box, from the other side: the count is not what gives
// way. Neither changes where a short label's chip and count sit.
const HEADER_ROW = 'flex items-center gap-2.5 px-1 pb-1.5 pt-0.5';
const HEADER_LABEL_BOX = 'flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden';
const HEADER_COUNT = 'shrink-0 text-[12px] tabular-nums text-muted';

function ColumnHeader({ group, dim, boards }: {
  group: RenderGroup;
  /** What the board is grouped by, and the only dimension whose columns name
   *  something this board can open (#1191). */
  dim: GroupDim;
  /** The board catalog the name is resolved against — see `columnBoardPath`. */
  boards?: readonly FilterProject[];
}) {
  const countRef = useRef<HTMLSpanElement>(null);
  const { boxRef, shown } = useElidedText<HTMLDivElement>(group.label, (box, showing) => {
    // `StatusChip` is shared with the Projects rollup and takes no ref, so the
    // chip is reached as the box's first element. It's the element that PAINTS
    // the label, so it's also the only font worth measuring against — the box
    // around it inherits the page's, which is a different size. A linked chip
    // is an anchor rather than a span (#1191) and is still that one element,
    // which is why the link is the chip and not a wrapper around it.
    const chip = box.firstElementChild as HTMLElement | null;
    const count = countRef.current;
    const widthOf = chip && textWidthIn(chip);
    if (!chip || !count || !widthOf) return null;
    // What the chip adds around whatever label it is given — its padding, its
    // tone dot and the gap after it — measured off the rendered chip rather
    // than copied out of StatusChip, so it can't go stale when that changes.
    const chrome = chip.getBoundingClientRect().width - widthOf(showing);
    const gap = parseFloat(getComputedStyle(box).columnGap) || 0;
    const budget = box.clientWidth - count.getBoundingClientRect().width - gap - chrome;
    return { widthOf, budget };
  });

  // The NAME is the link and the row is not (#1191). The row also holds the
  // count and Copy-for-agent, and #1113 is this file's own record of what
  // happens when something spans a strip a control sits under: the control
  // stops being clickable. A link over the whole row would also take the count
  // into its accessible name, so it would announce "Acme Compliance 3, link".
  const path = columnBoardPath(group, dim, boards);
  const elided = shown !== group.label;
  return (
    <div className={HEADER_ROW}>
      <div ref={boxRef} className={HEADER_LABEL_BOX} title={elided ? group.label : undefined}>
        <StatusChip
          tone={group.tone}
          label={shown}
          /* `boardLinkProps` and not a bare `onClick`: it is the board's rule
             for which press is ours, so a ⌘-click opens the board in a tab and
             Copy link addresses the page rather than a history position. */
          link={path ? { ...boardLinkProps(path), ariaLabel: elided ? group.label : undefined } : undefined}
        />
        <span ref={countRef} className={HEADER_COUNT}>{group.rows.length}</span>
      </div>
      {/* The markdown is handed the FULL label, never `shown`: a copy that named
          a shortened repo would name a repo that doesn't exist. */}
      {group.rows.length > 0 && <ColumnCopy label={group.label} items={group.rows.map((r) => r.item)} />}
    </div>
  );
}

function Card({ showTriage, item, sourceProject, sourceProjectOrg, mayClose, mayAssign }: {
  showTriage?: boolean;
  item: ViewerIssue;
  /** #422, see BoardView. */ sourceProject?: number;
  /** #697, see IssuesViewer. */ sourceProjectOrg?: string;
  /** The session's close verdict, resolved once by the viewer (#653). */ mayClose: boolean;
  /** The session's assign verdict, resolved beside it (#1009). */ mayAssign: boolean;
}) {
  const path = issuePathFromUrl(item.htmlUrl, sourceProject, sourceProjectOrg);
  const [closed, setClosed] = useState(false);
  const isClosed = closed || item.state === 'closed';
  // Github's answer to the last assignment made from this card (#1009), so the
  // card redraws on the write, until the viewer hands it a read that differs.
  const [assignees, setAssigned] = useAssignedHere(item.assignees);
  const ref = issueReferenceParts(item);
  const statuses = workflowLabels(item.labels);
  const rawLabels = item.labels.map(({ name }) => name).join(', ');
  // The budget is the meta span's own width less the `#number` beside it, both
  // read from the DOM, so the number is subtracted at its real rendered width
  // rather than at a guess. The meta span paints the name itself, so its own
  // font is the one to measure against.
  const numberRef = useRef<HTMLSpanElement>(null);
  const { boxRef: metaRef, shown } = useElidedText<HTMLSpanElement>(ref.repo, (meta) => {
    const widthOf = textWidthIn(meta);
    const number = numberRef.current;
    return widthOf && number
      ? { widthOf, budget: meta.clientWidth - number.getBoundingClientRect().width }
      : null;
  });

  return (
    // Both verdicts come down from `IssuesViewer` (#653, #1009). `Assign to…`
    // edits the whole set, since the card knows who holds the issue and redraws
    // from Github's answer. `Assign to me` stays off here: it needs the repo's
    // assignable list up front, which on a board of many repos is a read per repo.
    <IssueActions issue={item} closed={isClosed} mayClose={mayClose} mayAssign={mayAssign} assignSeveral onAssigned={setAssigned} onClosed={() => setClosed(true)} handleClassName={CARD_HANDLE}>
      <a
        href={path}
        aria-label={`${item.title}; ${issueReference(item)}; ${assignees.length ? assignees.join(', ') : 'Unassigned'}${rawLabels ? `; Labels: ${rawLabels}` : ''}`}
        title={rawLabels ? `Labels: ${rawLabels}` : undefined}
        onClick={(e) => { e.preventDefault(); gotoPath(path); }}
        className={`${BOARD_CARD} no-underline ${isClosed ? 'bg-surface/60' : 'bg-surface transition-shadow hover:ring-2 hover:ring-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]'}`}
      >
        <div className={cardTitleClass(isClosed)}>{showTriage && <><TriageValue item={item} property="priority" />{' '}</>}{item.title}</div>
        <div className={CARD_META_ROW}>
          <span ref={metaRef} className={CARD_META} title={issueReference(item)}>
            <span className={CARD_META_REPO}>{shown}</span>
            <span ref={numberRef} className={CARD_META_NUMBER}>{ref.number}</span>
          </span>
          <div className={CARD_ASSIGNEE}>
            {showTriage && <TriageValue item={item} property="size" />}
            <AssigneeCluster logins={assignees} />
          </div>
        </div>
        {statuses.length > 0 && (
          <div className="flex min-w-0 flex-wrap gap-[5px] text-[11px] leading-[1.5]" aria-hidden="true">
            {statuses.map((status) => (
              <span key={status.key} className={`inline-flex items-center gap-[5px] rounded-md px-[7px] py-[3px] [overflow-wrap:anywhere] ${status.className}`}>
                {status.name}
              </span>
            ))}
          </div>
        )}
      </a>
    </IssueActions>
  );
}

/**
 * The board's sideways scroll, and the scrollbar a reader can reach (#1113).
 *
 * The board has always scrolled. `overflow-x: auto` on the scroller makes a real
 * scroll container, and a horizontal gesture over the columns moves it: measured
 * in Chrome on the Queue at 1280 grouped by repo, a compositor scroll gesture
 * over the columns takes `scrollLeft` from 0 to 135 of an available 585. What
 * the board has never had is a scrollbar anywhere anyone could see one. A scroll
 * container paints its horizontal scrollbar at the bottom of its OWN box, and
 * that box is as tall as the tallest column: 1,032px on that same fixture queue,
 * in an 800px window, and taller on a real one. The bar is parked below the
 * fold, so a mouse has nothing to grab and nothing to wheel over, and the board
 * never says there is more of it to the right. That is the reported fault, and
 * it is not a missing overflow.
 *
 * So the bar is drawn on a second scroller, a rail with no content of its own,
 * sitting ABOVE the columns in the ordinary flow, under the board's own header.
 * The two boxes are the same width, so giving the rail's span the board's
 * `scrollWidth` gives them the same scroll range, and each follows the other.
 *
 * ABOVE, and in the flow, are both answers to the review of #1116. The rail was
 * `position: sticky` to the foot of the window for exactly as long as it took
 * somebody to hit-test it: a pinned band spans the whole board, and a control
 * under it is not clickable. Walked through all 1,515 scroll offsets of the
 * fixture queue at 1280, a card's 24x24 "Issue actions" button had its own
 * centre answered by the rail at 334 of them. No window-pinned overlay escapes
 * that, because lifting a box over the content it would have sat under is the
 * only thing sticky does. In the flow the rail reserves its own line and covers
 * nothing at any offset, which `scripts/measure-board-rail.mjs` re-walks.
 *
 * Above the columns rather than below them, because below them is where the
 * bar already was and could not be seen. A reader arrives at the board's top
 * edge; that is where a board has to say it is wider than its box.
 *
 * The span is measured, not derived from the column count: a column is
 * `minmax(210px, 1fr)`, so what the board is worth in pixels depends on the box
 * it was handed rather than on how many groups it holds. Zero means it fits, and
 * the rail is not drawn at all.
 */
function useSidewaysScroll() {
  const board = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const [span, setSpan] = useState(0);

  // Every render, because the thing that changes the span most often is the
  // group set, and that changes the scroller's CONTENT without changing the box
  // a ResizeObserver watches — the grid is always exactly as wide as the
  // scroller. Re-measuring costs a `setSpan` React drops when the number has not
  // moved.
  useLayoutEffect(() => {
    const el = board.current;
    if (el) setSpan(el.scrollWidth > el.clientWidth ? el.scrollWidth : 0);
  });

  // And once more whenever the box itself changes width, which no render
  // accompanies: the sidebar sliding, the window resizing, a font landing.
  useLayoutEffect(() => {
    const el = board.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setSpan(el.scrollWidth > el.clientWidth ? el.scrollWidth : 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A wheel over the rail means sideways, because the rail IS a horizontal
  // scrollbar and a mouse has no sideways wheel. Chrome does not make that
  // translation itself: measured over the rail at 1280, a wheel of 300 down left
  // `scrollLeft` where it was and took the PAGE from 400 to 100, because a
  // scroller that cannot take the wheel's axis passes it up. So the rail takes
  // it here, over the eleven pixels it occupies and nowhere else.
  //
  // It takes the gesture only while it has somewhere to go in that direction.
  // The rail is a band across the page now that it sits in the flow, and a band
  // that swallows the wheel at either end of its range is a band the page will
  // not scroll under: at `scrollLeft` 0 an upward wheel would have done nothing
  // at all and stopped the page doing anything either.
  //
  // Registered by hand rather than as `onWheel`, because React's root listener
  // for wheel is passive and a passive listener may not call `preventDefault`,
  // which is what stops the page scrolling underneath the same gesture.
  useLayoutEffect(() => {
    const el = rail.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const by = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const room = by < 0 ? el.scrollLeft : el.scrollWidth - el.clientWidth - el.scrollLeft;
      if (by === 0 || room <= 0) return;
      e.preventDefault();
      el.scrollLeft += by;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Assigning a `scrollLeft` that is already the value fires no scroll event, so
  // the pair settles after one hop instead of driving each other round.
  const onBoardScroll = () => {
    const a = board.current;
    const b = rail.current;
    if (a && b && b.scrollLeft !== a.scrollLeft) b.scrollLeft = a.scrollLeft;
  };
  const onRailScroll = () => {
    const a = board.current;
    const b = rail.current;
    if (a && b && a.scrollLeft !== b.scrollLeft) a.scrollLeft = b.scrollLeft;
  };

  return { board, rail, span, onBoardScroll, onRailScroll };
}

export function BoardView({ showTriage, groups, dim, boards, sourceProject, sourceProjectOrg, mayClose, mayAssign }: {
  showTriage?: boolean;
  groups: RenderGroup[];
  /** The dimension the columns stack by — the header needs it to tell a column
   *  that names a board from one that names a label (#1191). */
  dim: GroupDim;
  /** Every board this session may filter to, from `/api/issues/filter-options`
   *  — the only place a page hosting the viewer holds a board NAME beside its
   *  org and number. `columnBoardPath` is what reads it. */
  boards?: readonly FilterProject[];
  /** The project board this board renders inside (#422) — when set, each card's
   *  issue link carries `?srcProject=` so the issue's breadcrumb reflects the board
   *  it was opened from. Only the Project page passes this. */
  sourceProject?: number;
  /** #697, see IssuesViewer. */ sourceProjectOrg?: string;
  /** Whether this session may close an issue (#653) — `IssuesViewer` resolves it
   *  from `/api/auth/me` once and hands it down, rather than a hook per card. */
  mayClose: boolean;
  /** Whether this session may change an issue's assignees (#1009), resolved the same way. */
  mayAssign: boolean;
}) {
  const { board, rail, span, onBoardScroll, onRailScroll } = useSidewaysScroll();
  return (
    // The gap above belongs to the region, not to the board (#447) — the viewer
    // owns the step from the chrome to whichever view is showing.
    //
    // The scroller is where a board wider than the block goes (#849): the block
    // is on the page rail like every other block, so a group set too wide for it
    // scrolls sideways inside the panel rather than widening the panel.
    //
    // The rail above it is the scrollbar that scroller cannot draw where anyone
    // can reach it (#1113), and `useSidewaysScroll` above says why it is above
    // the columns and in the flow rather than pinned over them.
    <div>
      <div ref={rail} onScroll={onRailScroll} className="board-rail" hidden={span === 0}>
        <div className="board-rail-span" style={{ width: `${span}px` }} />
      </div>
      <div ref={board} onScroll={onBoardScroll} className="board-scroll pb-1.5">
        <div
          className="grid gap-3.5"
          style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(210px, 1fr))` }}
        >
          {groups.map((g) => (
            <div key={g.key} className={BOARD_WELL}>
              <ColumnHeader group={g} dim={dim} boards={boards} />
              {g.rows.length === 0 ? (
                <div className="px-1.5 py-4 text-center text-[12px] text-muted">Nothing here</div>
              ) : (
                g.rows.map(({ item }) => (
                  <Card showTriage={showTriage} key={item.htmlUrl} item={item} sourceProject={sourceProject} sourceProjectOrg={sourceProjectOrg} mayClose={mayClose} mayAssign={mayAssign} />
                ))
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
