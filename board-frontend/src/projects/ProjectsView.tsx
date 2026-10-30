import { useResponseDeadline } from '../auth/use-response-deadline';
import { Placeholder } from '../ui/LoadingStructure';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchProject, type ProjectDetail } from '../api/projects';
import { fetchFilterOptions, type FilterOptions } from '../api/issues';
import { useReportOutdated, useRenewalSignal, useAccessEpoch, useRefreshSignal } from '../sync/sync-status';
import { PageCrumb } from '../PageCrumb';
import { type Route } from '../route';
import { PageHeading, PAGE_RAIL, H1_NUMBER_LINK } from '../ui/PageHeading';
import { Ring, type RingSegment } from '../ui/ring';
import { usePeople } from '../people-ctx';
import { contributionSegments, contributorsOf, ringSegments } from './contributors';
import { readShort } from './pulse';
import { fromProjectItem } from '../issues-viewer/viewer-issue';
import { IssuesViewer } from '../issues-viewer/IssuesViewer';
import { projectViewerKeys } from './viewer-key';
// #824 — the board opens on the copy it was last served, and a refresh never
// puts it back to a skeleton.
import { useReadState } from '../cache/use-board-read';
import { readClient, readKey, readValue, type ReadEntry } from '../cache/read-cache';
import { scopeQuery } from '../api/core';
import { forgetPayload, projectKey } from '../cache/payload-cache';
// #879 — the board's header off the rollup on disk. #1249 says when that is
// reached now, which is not when it was written.
import { heldHeader, type HeldHeader } from './held-header';
import { loadFailureText, logLoadFailure, reasonOf } from '../auth/session-copy';
// #1065 — the one rule #1060 gave the rollup surfaces, asked here too; #1107 —
// on this read's own "not now" code, which board-api sends now. #1249 — and the
// saved copy that rule had nothing to fall back on, with the mark that says so.
import {
  boardMark, drawable, saveBoard, savedBoard, savedBoardRollup, servableBoardFailure,
  type BoardSource, type Recalled, type RecalledProjects,
} from './projects-last-good';

/**
 * A board's page: one GitHub Projects (v2) board, read-only, at
 * `/projects/:number`. A header carrying the board's completion ring and its
 * name, and the board's issues in the shared viewer. Every issue/PR reference
 * deep-links to GitHub (the source of truth). Nothing here writes. The v2
 * GraphQL fetch is slow, so the page shows a skeleton rather than a blank page.
 *
 * #785 deleted the rollup this file also held — a grid of one card per board at
 * `/projects`, which #750 had already taken out of the nav and left reachable
 * only by typing the URL. What it drew, Your work now draws: the Contributions
 * rings are the boards, and pressing one filters the queue to it. This page is
 * the thing the rollup could not do, and is why it stayed — the queue is the
 * caller's own work plus what is unassigned, and this is the WHOLE board.
 */

/**
 * The reader's name for what did not load, read aloud inside the sentence
 * `loadFailureText` builds. "this board" and not "project": the breadcrumb
 * above says Projects and everything under the header calls the thing a board,
 * so the failure sentence calls it one too.
 *
 * Before #979 this page ended its failure on `err` itself — "Couldn't load
 * project: projects 500" — which is the shape #1055 took off the other five
 * surfaces and the one docs/user-facing-copy.md quotes. A route name is not a
 * thing on the reader's screen and a status code is not something they can act
 * on; `logLoadFailure` keeps both for whoever is reading the console — from
 * each of the three reads that can set `err`, because a read that sets it
 * without logging now leaves the detail with nobody (#1103 review, S1).
 */
const BOARD_SUBJECT = 'this board';

// ─── Board header ────────────────────────────────────────────────────────────
// The header says the board once: its completion, its name, and its id — and the
// id is the link out to Github (#510). What it no longer carries is the trailing
// meta row #466 put there: a status chip reading "Active" on nearly every board
// we have, and an open and a closed count that the columns underneath already
// spell out as cards. Those were the page repeating itself, and they stranded the
// one fact worth keeping — the deep link — at the far end of the line from the
// title it belongs to.
//
// The issue page settled this shape first: a muted number inline in the H1, which
// is where the link lives (see H1_NUMBER_LINK). A board reads the same way now, so
// "the id beside the name, and that id takes you to the source" is one rule across
// the app rather than two different headers.

// The ring leads as the board's mark (#465) and the title sits beside it, so a
// board's completion is the first thing read. 38px, not the 46px this started at:
// at 46 the dial stood one and a half times the title's cap height, which is what
// made it read loud, and it set the row's height instead of the type. At 38 the
// title sets the line and the "50%" numeral is still legible.
const RING_SIZE = 38;

// Optical alignment: `items-center` centres the dial on the title's LINE box, but
// the eye reads it against the caps, and the line box carries descender space the
// caps sit above. Measured at 33px/38.94px Inter, the cap centre lands 1.14px above
// the line-box centre, so the dial sat that far low; -1px closes it to 0.14px, a
// quarter of a device pixel at 2×. Deliberately a whole pixel and not the exact
// 1.14 — a fractional margin would be fitted to one font size and this one rides
// through the 560px step down to a 26px title.
const RING_NUDGE = '-mt-px';

const HEADER_ROW = 'mb-5 flex flex-wrap items-center gap-x-[18px] gap-y-2 max-[720px]:items-start';
// Below 720px the title takes two or three lines and the row switches to
// `items-start`, so the dial needs its own nudge to sit with the first one.
const HEADER_RING = `flex-none ${RING_NUDGE} max-[720px]:mt-[3px]`;

/**
 * The title and the mark, as ONE item in the row above (#1251 review, F1).
 *
 * The mark has to sit where the title ENDS, and the row could not put it
 * there. `flex-[1_1_260px]` used to be the TITLE's, so the title ate the row's
 * free space and the mark was pushed to the rail's right edge — measured 368px
 * from the painted end of the title at 1280 and 688px at 1600, growing with the
 * window. A fully drawn board with its "this is a copy" mark that far away
 * reads as current, which is #1216 on a bigger surface. The grow moves onto
 * this group instead, so the free space lands to the RIGHT of the pair rather
 * than between them, and what the reader looks at to ask what they are looking
 * at carries the answer.
 *
 * `flex-wrap`, not `nowrap`: a board name long enough to fill the row drops the
 * mark onto a second line directly UNDER the title, which is still beside the
 * thing it is about. One line instead would shrink a long title to three
 * wrapped lines and leave the mark floating against their middle.
 *
 * `min-w-0` on the group and on the title inside it — the title used to carry
 * it alone — so a long name still shrinks and wraps rather than widening the
 * row.
 */
const HEADER_TITLE_GROUP = 'flex min-w-0 flex-[1_1_260px] flex-wrap gap-x-[18px] gap-y-1 max-[720px]:flex-[1_1_180px]';

// Shimmer paint only — a skeleton composes these onto the layout classes of the
// thing it stands in for, so a placeholder can't drift from it. Both skeletons
// below use them: the rows spelled the same three classes out inline four times
// under these two declarations, which worked because the inline strings were
// supersets and would have stopped working the first time anybody edited one.
// The bars are `Placeholder`, like every other loading shape on the board, so
// they pulse and hold still under reduced motion without saying so here (#1033;
// `LoadingStructure` says why the board adds the stop at all). That is also why
// there is no `PROJECT_SKELETON` any more: it was this file's own copy of a
// decision that has one home.
const SKELETON_BAR = 'rounded bg-elevated';
const SKELETON_DIAL = 'rounded-full bg-elevated';

/** What `boardMark` answers, given a name here so the four components that pass
 *  it through do not each spell the shape out. */
export type BoardMarkText = ReturnType<typeof boardMark>;

// The mark's own type scale. 11.5px against the 33px title is the step the page
// already uses for anything that is not the board itself, and `text-tertiary`
// is the tone: this says what the screen is, and must not compete with what is
// on it.
// `empty:-ml-[18px]` and NOT `empty:hidden`. The slot has to stay RENDERED to
// be a live region a screen reader was already watching, and `display:none`
// takes it out of the accessibility tree, which makes the mark's arrival an
// insertion rather than a change. But `HEADER_TITLE_GROUP` is a flex row with
// an 18px gap, and a flex item takes its gap whether it has width or not, so a
// mounted empty slot would cost every live board 18px of title. The negative
// margin cancels exactly that gap, and nothing else in the row moves: measured
// against a build with no slot in the row at all, the `fresh` frames are
// pixel-identical above the first card, header row included, at 1280 in both
// themes.
const HEADER_MARK = 'flex-none text-[11.5px] leading-none text-muted empty:-ml-[18px]';

/**
 * The one slot that says what the board on screen IS (#1249).
 *
 * Nothing when the board is live; `Loading` while the read is out; `Saved copy
 * 12 minutes ago` when it is a copy a failed read left drawn; `Unavailable`
 * when the read failed and there is no copy. A mark beside the heading and not
 * a line of prose over the block, which is the vocabulary #1236 settled on the
 * Overview cards and the shape the owner's standing instruction for this board
 * leaves standing. The sentence the three rollup surfaces say is this mark's
 * ACCESSIBLE NAME, so a reader on a screen reader is told the same thing in the
 * same words.
 *
 * BESIDE THE HEADING IS LITERAL: the slot is the title's own flex sibling
 * inside `HEADER_TITLE_GROUP`, so it lands at the end of the painted title and
 * not at the end of the row. That is the half this docblock claimed and the
 * layout did not do until #1251's review measured it.
 *
 * ALWAYS MOUNTED AND ALWAYS RENDERED, for the reason #1107 gave the line it
 * replaces: a live region that only exists once it has something to say is one
 * a screen reader was not watching when it arrived. What it costs the layout is
 * nothing, and `HEADER_MARK` says how.
 */
function BoardMark({ mark }: { mark: BoardMarkText }) {
  // `data-board-mark` is the browser guard's handle on this one element. The
  // page draws other live regions (the sync chip, the viewer's own), and a
  // guard that swept `[role=status]` would read whichever it found first —
  // `check-flow-card-states.mjs` takes `data-spark-card` for the same reason.
  return <span data-board-mark="" role="status" aria-label={mark?.label} className={HEADER_MARK}>{mark?.text}</span>;
}

/** The board's id, inline in the H1, as the link out to Github (#510). */
function BoardId({ number, url }: { number: number; url: string }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={H1_NUMBER_LINK}>
      #{number}
    </a>
  );
}

/**
 * A board's page header: completion, name, and the id that links to the board on
 * Github. Nothing else — see the note above for what came off and why.
 */
export function BoardHeader({
  name,
  number,
  url,
  pct,
  segments,
  itemsComplete,
  mark = null,
}: {
  name: string;
  number: number;
  url: string;
  /** What the board on screen is, when it is not simply live (#1249). */
  mark?: BoardMarkText;
  /** The SAME field the rollup card and the Unit block ring read, so one board
   *  can't report two numbers (#465). */
  pct: number;
  segments?: RingSegment[];
  /** The board's own read (#722), taken raw rather than as a ready-made "hide
   *  it" boolean, so this header withholds off the SAME field the card does. A
   *  header that went on asserting while the card declined is that one-number
   *  rule above stopped being true — the two surfaces would disagree about one
   *  board the moment either was fixed alone. The detail route serves the flag
   *  on the spread in `getProject`. */
  itemsComplete?: boolean;
}) {
  return (
    <div className={HEADER_ROW}>
      {/* Ring takes no className, so both nudges ride on this span. */}
      <span className={HEADER_RING}>
        <Ring pct={pct} size={RING_SIZE} segments={segments} withheld={readShort(itemsComplete)} />
      </span>
      {/* The mark rides the title's own baseline, which is the treatment #1236
          gave the Overview captions their marks sit beside. */}
      <div className={`${HEADER_TITLE_GROUP} items-baseline`}>
        <PageHeading className="min-w-0">
          {name} <BoardId number={number} url={url} />
        </PageHeading>
        <BoardMark mark={mark} />
      </div>
    </div>
  );
}

/**
 * The header's silhouette while the (slow) GraphQL fetch resolves (#204) — the
 * same two shapes, same order, same sizes as the header above it, so nothing
 * shifts when the real board lands.
 */
export function HeaderSkeleton({ mark = null }: { mark?: BoardMarkText }) {
  // Held still by the mark it already carries rather than by a second prop: a
  // caller cannot then pass a `still` that contradicts what the mark says.
  const still = mark?.pending === false;
  return (
    <div className={HEADER_ROW}>
      <Placeholder still={still} className={`${HEADER_RING} ${SKELETON_DIAL}`} style={{ height: RING_SIZE, width: RING_SIZE }} />
      {/* `items-center`, not the header's baseline: a bar has no baseline, and
          a synthesized one would drop the mark to the bar's bottom edge. The
          bar keeps the 320px cap the title's placeholder has always had and
          grows into the group the way the title does. */}
      <div className={`${HEADER_TITLE_GROUP} items-center`}>
        <Placeholder still={still} className={`h-[34px] max-w-[320px] flex-1 ${SKELETON_BAR}`} />
        <BoardMark mark={mark} />
      </div>
    </div>
  );
}

// A board overview's silhouette while the GraphQL fetch resolves (#204). The
// breadcrumb is rendered once by ProjectsView's root (route-derived), so the
// skeleton just shimmers the header + rows.
//
// `held` is the header the boards rollup on disk could already answer for this
// address (#879), and it replaces the header's shimmer with the real thing. The
// ROWS stay a silhouette, because the items are what this page does not have.
// Two shapes, same box, so nothing moves when the board lands.
//
// The ring draws its plain completion arc here and gains its contributor
// SEGMENTS when the read lands. That is the honest version: `pct` is the same
// number either way and the dial does not move, while the segments are read off
// the board's items, which is exactly what the page is waiting for.
//
// THE SAME SHAPE IS BOTH STATES THAT HAVE NO BOARD, and `mark` is the whole of
// what separates them (#1249). A SETTLED mark means the read is not coming: the
// bars hold still, `aria-busy` is false, and the mark names what is on screen.
// A PENDING one means a read is in flight, and they pulse while it says
// `Loading`. That pair is the vocabulary #1236 gave the Overview cards, for the
// reason #1216 is: a failed read that keeps pulsing says "wait" about something
// that is not coming, and a failed read drawn as content is a figure nobody has.
//
// THE WORD AND NOT THE PULSE IS WHAT CARRIES IT (#1251 review, F2).
// `motion-reduce:animate-none` takes the pulse off both states for a reader who
// asked for less motion, and before the pending mark existed that left the two
// screens identical: same seventeen still placeholders, one of them waiting for
// something that was never coming. The bars still pulse where motion is welcome
// — nothing was taken away — but the difference no longer depends on it.
export function OverviewSkeleton({ held, mark = null }: { held?: HeldHeader | null; mark?: BoardMarkText }) {
  const still = mark?.pending === false;
  return (
    // "Loading project", not "Loading board" (#979). This is what
    // `/projects/:number` draws while the detail lands, and its subject is a
    // GitHub project, not this app — which is the board, and says so on every
    // tab. A screen reader was the one place the old word survived the rename.
    // A page that is NOT loading says neither: `mark` is what it says instead.
    <section aria-busy={still ? undefined : true} aria-label={still ? undefined : 'Loading project'}>
      {held
        ? (
          <BoardHeader
            name={held.name}
            number={held.number}
            url={held.url}
            pct={held.pct}
            itemsComplete={held.itemsComplete}
            mark={mark}
          />
        )
        : <HeaderSkeleton mark={mark} />}
      <div className="overflow-hidden rounded-2xl bg-surface border border-line shadow-sm">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-4 border-t border-line p-[15px_18px] first:border-t-0">
            <Placeholder still={still} className={`h-[13px] flex-1 ${SKELETON_BAR}`} style={{ maxWidth: 260 - i * 28 }} />
            <Placeholder still={still} className={`h-[20px] w-[86px] ${SKELETON_DIAL}`} />
            <Placeholder still={still} className={`h-[13px] w-[64px] ${SKELETON_BAR}`} />
          </div>
        ))}
      </div>
    </section>
  );
}

const NO_OPTIONS: FilterOptions = { labels: [], assignees: [], projects: [] };

/** Which board a refresh mark is about, as one string. The number alone is not a
 *  board across a union of orgs (#697), the same reason `projectKey` carries the
 *  org. */
const boardAddress = (number: number, org?: string): string => `${org ?? ''}/${number}`;

/** What the refresh effect has already run for: a board, and the refresh nonce
 *  it last saw for that board. */
export interface RefreshMark {
  board: string;
  refresh: number;
}

/**
 * Whether the refresh effect should FETCH this time round (#824 review).
 *
 * Three runs it must not fetch on, and one it must. It must not fetch on a
 * mount, because the identity effect beside it has just fetched this board;
 * it must not fetch on `StrictMode`'s second mount pass, which is the same
 * mount; and it must not fetch when the board itself has just changed, which is
 * again the identity effect's job. It must fetch when the NONCE has moved under
 * the same board, which is a Sync now, the two-minute soft refresh or a focus
 * refetch.
 *
 * A `useRef(true)` first-run boolean answered the first three by accident and
 * only until `StrictMode` spent it: the first mount pass consumed the flag and
 * the second one fetched. `ReposPage` rejected that same shape in this branch
 * and holds an org instead. Pure, and exported, because no effect fires in this
 * suite and this is the whole of the decision.
 */
export function shouldRefetch(prev: RefreshMark | null, next: RefreshMark): boolean {
  if (prev === null) return false;
  if (prev.board !== next.board) return false;
  return prev.refresh !== next.refresh;
}

function Overview({ number, org }: { number: number; org?: string }) {
  // The board's whole address is the key (#697, #824), so `/projects/7` opens on
  // board 7's own copy and never on board 8's, and moving between two boards
  // re-seeds rather than blanking.
  const [detail, setDetail] = useReadState<ProjectDetail>(`/api/projects/${number}${scopeQuery(org)}`);
  const [heldOptions, setOptions] = useReadState<FilterOptions>('/api/issues/filter-options');
  const options = heldOptions ?? NO_OPTIONS;
  const [err, setErr] = useState<string | null>(null);
  /**
   * Whether the last read of this board said NOT NOW (#1107, #1249).
   *
   * The rollup surfaces have said so since #1060; this page said nothing at
   * all, so a deploy window, a credential refresh or — since #1107 gave this
   * read a code — a quota cooldown left the board standing with no sign that
   * the last read had failed. Until #1107 this page could not tell those from a
   * refusal, so there was no state to say it in.
   *
   * SEPARATE FROM `err`, and they are never both true of one read: `err` is the
   * read that was REFUSED, and this is the read that could not be run. What the
   * two leave on screen is different in kind, which is why they are different
   * states rather than one string.
   */
  const [notNow, setNotNow] = useState(false);
  /**
   * This board's own saved copy, recalled by a failed read (#1249).
   *
   * Recalled in the HANDLER and not in a render, because recalling is not a
   * pure read: `recallSaved` deletes every saved copy when the failure was a
   * refusal rather than a "not now", which is #1042's rule and must happen once
   * per failure rather than once per paint. What render then asks is
   * `drawable`, which is pure and is where the copy is refused for a moved org,
   * a wiped store or a re-checked access.
   */
  const [savedCopy, setSavedCopy] = useState<Recalled<ProjectDetail> | null>(null);
  /** The ROLLUP's saved copy, for a failed read this board has no copy of its
   *  own for. It is what `heldHeader` reads now (#1249 item 2), and it is
   *  recalled only when `savedCopy` came back empty, because a board's own copy
   *  is the better answer whenever there is one. */
  const [savedRollup, setSavedRollup] = useState<RecalledProjects | null>(null);

  /** A read is STARTING: whatever the last one left is about a read that is
   *  over. Both marks go, and so does the failure message, for the reason the
   *  identity effect already gave about `err` — keeping them would draw the
   *  previous read's verdict over this one. */
  const starting = (): void => {
    setErr(null);
    setNotNow(false);
    setSavedCopy(null);
    setSavedRollup(null);
  };

  /** A read LANDED. The board is live, nothing is a copy, and this answer
   *  becomes the copy the next read that cannot be run will fall back on. */
  const landed = (d: ProjectDetail): void => {
    starting();
    saveBoard(number, org ?? null, d);
  };

  /**
   * A read FAILED, on any of the three paths, with the one rule between them.
   *
   * `savedBoard` is called before the branch and not inside the "not now" arm,
   * because recalling is also the forgetting: it deletes every saved copy when
   * the failure was a REFUSAL rather than a "not now" (#1042's rule, in
   * `recallSaved`), and an arm that skipped the call would keep a copy the
   * refusal had already ruled out and draw it at the next cooldown.
   *
   * The refusal arm takes the board off the screen and its stored copy off the
   * disk, which is #1065 unchanged. The "not now" arm keeps what is there and
   * marks it, which is #1107 — with, since #1249, something to keep.
   */
  const failed = (e: unknown): void => {
    const copy = savedBoard(number, org ?? null, e);
    if (servableBoardFailure(e)) {
      setErr(null);
      setNotNow(true);
      setSavedCopy(copy);
      // Only when the board has no copy of ITS own: one is the whole board and
      // the other is a header, and a page holding both would draw the worse one.
      setSavedRollup(copy === null ? savedBoardRollup(org ?? null, e) : null);
      return;
    }
    forgetPayload(projectKey(number, org));
    setDetail(null);
    setNotNow(false);
    setSavedCopy(null);
    setSavedRollup(null);
    setErr(reasonOf(e));
  };

  // What render may draw off the two recalled copies, asked HERE and not in the
  // handler that recalled them (#1035's `drawable`): the page can change under a
  // copy before the next paint — the org moved, a check reported different
  // Github access, an expired check dropped the permission-sensitive answers, or
  // a sign-out wiped the store. Any of those and the copy waits for the next
  // failed read to recall it again, if it still may.
  const copy = drawable(savedCopy, org ?? null);
  const rollup = detail === null && copy === null ? drawable(savedRollup, org ?? null) : null;
  // The shared reader can restore detail before mount. Prefer that answer to
  // the legacy fallback, and date the mark from the same answer below.
  const board = detail ?? copy?.value ?? null;

  // The board's header, off the ROLLUP's saved copy, for the one state that has
  // nothing else to draw (#879, #1249). Read in render rather than in an effect,
  // because a value that arrives one frame later is a value that arrives after
  // the shape it was meant to replace.
  //
  // It used to read the stored rollup through `seedPayload` and could not
  // answer: `projects` is a sensitive key, so a page LOAD met an empty entry and
  // #1243 made the walk meet one too. The SAVED rollup is the entry that
  // survives both, and the rule it is read under — only after a live read failed
  // in a way that says "not now" — is exactly the state this arm is. Two entries
  // in turn and never merged, which `savedBoardRollup` argues.
  //
  // `err === null` because a board that was REFUSED must not have a header drawn
  // over its message, and `board === null` because a board that has its own
  // answer has a better one.
  let held = useMemo(
    () => (board === null && err === null && rollup !== null ? heldHeader(rollup.value, number, org) : null),
    // No sensitive generation here, unlike the read this replaces: `drawable`
    // above asks it on every render before `rollup` reaches this list, so an
    // expiry turns `rollup` null on the render it lands rather than one frame
    // after.
    [board, err, rollup, number, org],
  );
  if (useResponseDeadline(held)) held = null;
  const readSequence = useRef(0);
  const refresh = useRefreshSignal() + useRenewalSignal(); // refetch on manual "sync now" (#301)
  const accessEpoch = useAccessEpoch(); // reauthorize this board (#892 review, C2)

  // The IDENTITY load: a different board, so a different page. The board itself
  // is no longer blanked here (#824) — the key above carries the address, so the
  // state has already re-seeded on the board being opened, which is this
  // effect's old job done with the new board's own copy instead of a skeleton.
  useEffect(() => {
    // Cancelled on the way out, so a slower answer for the board you just left
    // cannot land on the board you are on. `/projects/7` → `/projects/8` is one
    // click on Your work's rings away, and since #785 this is the app's only
    // projects read — the rollup's `fetchProjects` was the one that carried this
    // flag, and it went with the rollup.
    let alive = true;
    const own = ++readSequence.current;
    // The error clears with the board: a board that failed and a board that is
    // still loading are two different states, and keeping the old message would
    // draw the previous board's failure over this one. That reasoning is about
    // the identity change and it stays here, on the identity effect. The mark
    // and both recalled copies go with it, for the same reason and about the
    // same board (#1107, #1249) — a copy of board 7 is not board 8's to wear.
    starting();
    // `org` (#697) narrows the read to the board the URL asked for. Without one
    // the API resolves the first configured org holding the number, which is
    // what every link shared before #697 means and what this always sent.
    fetchProject(number, org)
      .then((d) => { if (alive && own === readSequence.current) { setDetail(d); landed(d); } })
      .catch((e) => {
        if (!alive || own !== readSequence.current) return;
        failed(e);
        logLoadFailure(BOARD_SUBJECT, reasonOf(e));
      });
    return () => { alive = false; };
  }, [number, org]);

  // The REFRESH: the 2-minute soft refresh, the focus refetch and a manual
  // "Sync now" all arrive here, and none of them may take the board away. This
  // was the live bug in #824 — the refresh nonce sat in the identity effect's
  // deps above `setDetail(null)`, so a board somebody was reading wiped itself
  // to `OverviewSkeleton` every two minutes. Split the way `IssuePage` is split,
  // down to skipping the first run so a mount does not fetch twice.
  //
  // The BOARD is in the deps beside the nonce, and the guard is a mark rather
  // than a boolean (#824 review). Keyed on the nonce alone this effect ran no
  // cleanup when the board changed, so a slow answer for board 7 landed on
  // board 8 through `setDetail` and `setErr(null)` — the identity effect's
  // `alive` flag cannot cover it, being a different effect with a different
  // closure. With the board in the deps, React tears the old run down before
  // the new one starts and the stale answer has nowhere to land. What the mark
  // then has to do is stop the extra deps from causing a fetch: `shouldRefetch`
  // holds that decision, and holds it for `StrictMode`'s second mount pass too,
  // which is what a `useRef(true)` boolean was spending itself on.
  const ran = useRef<RefreshMark | null>(null);
  useEffect(() => {
    const mark: RefreshMark = { board: boardAddress(number, org), refresh };
    const fetching = shouldRefetch(ran.current, mark);
    ran.current = mark;
    if (!fetching) return;
    let alive = true;
    const own = ++readSequence.current;
    fetchProject(number, org).then(
      (d) => { if (alive && own === readSequence.current) { setDetail(d); landed(d); } },
      (e) => {
        if (!alive || own !== readSequence.current) return;
        // The board this document already has stays on screen when the failure
        // says "not now", and `failed` marks it as the copy it now is — dated
        // off the entry the last good read saved, which is the same answer.
        failed(e);
        // The console's half, on this path too (#1103 review, S1). The screen
        // stopped drawing `err` on all three of these reads, so a path that
        // sets it without logging leaves the route name and the status with
        // nobody at all — which is the one thing BOARD_SUBJECT's note above
        // promises does not happen.
        logLoadFailure(BOARD_SUBJECT, reasonOf(e));
      },
    );
    return () => { alive = false; };
  }, [refresh, number, org]);

  /**
   * The board's access check expired and a NEW one has answered (#892 review,
   * C2).
   *
   * A board is a project grant, and a check that finds the same repositories
   * observes no project grant at all — so this board is not reauthorized by one,
   * however unchanged the visibility key is. It goes before the new read is
   * issued. A refusal clears its saved copies too. A servable failure may
   * immediately draw a marked saved copy under the usual identity and age
   * checks, just as TeamView does; it must not wait for another refresh.
   *
   * `forgetSensitivePayloads` has already taken the stored copy and rejected any
   * read still in flight, so there is nothing left to repopulate it behind this.
   *
   * The mark is a ref for the same reason `ran` above is one: this must not fire
   * on a mount, nor on `StrictMode`'s second pass, and the epoch it opens on is
   * whatever the app has already reached.
   */
  const seenEpoch = useRef(accessEpoch);
  useEffect(() => {
    if (seenEpoch.current === accessEpoch) return;
    seenEpoch.current = accessEpoch;
    setDetail(null);
    starting(); // #1107 — nothing is drawn now, so nothing is being shown.
    let alive = true;
    const own = ++readSequence.current;
    fetchProject(number, org).then(
      (d) => { if (alive && own === readSequence.current) { setDetail(d); landed(d); } },
      (e) => {
        if (!alive || own !== readSequence.current) return;
        // Use the same refusal and saved-copy rule as TeamView (#1253).
        // Waiting for the next refresh only delayed the same eligible copy.
        failed(e);
        logLoadFailure(BOARD_SUBJECT, reasonOf(e)); // #1103 review, S1.
      },
    );
    return () => { alive = false; };
  }, [accessEpoch, number, org]);

  // The filter autocomplete sets — org-wide, board-independent. Degrades quietly
  // to the issue-derived set (the FilterBar unions this with on-board values), so
  // a hiccup never blocks the board (#376 error handling). Nothing on failure
  // now: the set it already has is a better degrade than an empty one.
  useEffect(() => {
    let alive = true;
    fetchFilterOptions().then(
      (o) => { if (alive) setOptions(o); },
      () => {},
    );
    return () => { alive = false; };
  }, [refresh, accessEpoch]);

  /**
   * Which of the four the board on screen is (#1249).
   *
   * `live` when a read landed. `loading` when none has yet — the skeleton, and
   * the one that has to say the word rather than only pulse (#1251 review, F2).
   * `saved` when a "not now" left something drawn — the whole board out of its
   * own copy, the board this document already had, or the header alone out of
   * the rollup's copy. `unreadable` when it left nothing, which is the state
   * that must never be drawn as data.
   *
   * A REFUSED read is none of them: `err` returns before the mark is reached,
   * and its arm draws a sentence over an empty page rather than a board with
   * something said about it.
   */
  const source: BoardSource = notNow
    ? (board !== null || held !== null) ? 'saved' : 'unreadable'
    : board === null && err === null ? 'loading' : 'live';
  // The age the mark says, off whichever copy dated what is on screen. Null
  // only where no saved record dates it: a refresh that failed over a board
  // this document read before the copy behind it passed the ceiling.
  useReportOutdated(source === 'saved' && err === null);
  const entry = readClient.getQueryData<ReadEntry>(readKey(`/api/projects/${number}${scopeQuery(org)}`));
  const detailAt = detail !== null && readValue(entry) === detail ? entry?.at : null;
  const mark = boardMark(source, detailAt ?? copy?.at ?? rollup?.at ?? null);
  return <BoardOverview number={number} org={org} detail={board} held={held} err={err} mark={mark} options={options} />;
}

/**
 * The three states a reader of a board page can be in — loading, failed, and a
 * board — with nothing in it that fetches (#788).
 *
 * Split out of `Overview` above so a test can reach them at all. Everything that
 * decides WHICH state this is lives in effects, and no effect fires in this
 * suite: a render of `Overview` is the skeleton, always, for
 * every board and every failure. So the page had no coverage of any kind — no
 * test mounted it, and `check-phone-overflow.mjs` did not load a board either —
 * and since #785 this is the whole projects tab.
 *
 * The same split `expired-panel-verdict.mjs` makes on the guard side, for the
 * same reason: the judgement is separated from the machinery that reaches it,
 * and the page above is left holding exactly the fetching it was written with.
 */
export function BoardOverview({
  number,
  org,
  detail,
  held,
  err,
  mark = null,
  options,
}: {
  number: number;
  org?: string;
  /** The board, or null while the read that would fill it has not landed. */
  detail: ProjectDetail | null;
  /** The header the boards rollup on disk could answer for this address (#879),
   *  for the one state that has nothing else to draw. Null everywhere else. */
  held?: HeldHeader | null;
  /** The read's own message, when it was REFUSED. */
  err: string | null;
  /** What the board on screen is, when it is not simply live (#1249): the mark
   *  at the end of the heading, and the whole of what tells a stale board from
   *  a failed read and from one still loading, on all three of the states below
   *  that have no live answer. Never reached beside `err`, which returns
   *  first. */
  mark?: BoardMarkText;
  options: FilterOptions;
}) {
  const people = usePeople();
  // Memoised so the viewer's stored-arrangement reads and its `commit` callback
  // are not remade on every render by a fresh array — `useViewerState` says so.
  // Hooks run before the early returns below, which is why it sits up here.
  const boardOrg = detail?.org ?? org;
  const persistKeys = useMemo(() => projectViewerKeys(number, boardOrg), [number, boardOrg]);

  // A REFUSED read is the one state that is about the reader rather than about
  // the board, and it keeps the sentence every refused surface says, with the
  // action in it (#979, #1055). It is not a mark, because there is nothing on
  // the screen for a mark to be about.
  if (err) return <div className="px-0.5 py-6 text-[13px] text-muted">{loadFailureText(BOARD_SUBJECT, err)}</div>;
  // No board: either a read is in flight, or one is not coming. The SAME shape
  // draws both and `mark` separates them (#1249) — pulsing and `Loading` while
  // a read runs, still and `Saved copy` or `Unavailable` when none is. Both
  // halves of that pair are WORDS, so the separation survives a reader who
  // turned the pulse off (#1251 review, F2). Nothing number-shaped is drawn on
  // either, so a failed read states no figure, counts nothing, and never says
  // "No issues on this board" (#714, #1216).
  if (!detail) return <OverviewSkeleton held={held} mark={mark} />;

  // Same runs as the rollup card's dial, so the two rings of one board agree.
  const headerSegments = contributionSegments(contributorsOf(detail), people);

  return (
    <section>
      {/* The board name is this page's big H1 (#391); the breadcrumb above reads
          "Projects", so the name is said once. The mark rides at the END OF THE
          TITLE beside it (#1249, and #1251's review for the flex declaration
          that makes it true), which is where the reader is already looking when
          they ask what they are looking at. */}
      <BoardHeader
        name={detail.name}
        number={detail.number}
        url={detail.url}
        pct={detail.pct}
        segments={ringSegments(headerSegments)}
        itemsComplete={detail.itemsComplete}
        mark={mark}
      />

      {detail.items.length === 0 ? (
        <div className="px-0.5 py-6 text-[13px] text-muted">No issues on this board.</div>
      ) : (
        // The shared viewer (#376) in its normal, general form — full grouping,
        // filters, and the list/board toggle. Board mode leads here (#429): the
        // Status grouping (`viewerGroups`' special-cased column set + workflow
        // order) already exists for exactly this shape, matching the retired
        // BoardBody. `defaultView` only steers the FIRST render when the URL
        // doesn't name a view — list stays one click away, and stays reachable
        // on reload/back once chosen (see `encodeViewer`'s per-page threshold).
        //
        // `persistKey` (#463) is per BOARD, keyed on the board's whole address —
        // org and number since #697, because a number alone is not per-board
        // across a union of orgs — so each board keeps the grouping and view you
        // left it in and neither inherits the other's. A board never visited has
        // nothing stored and lands on the defaults above.
        //
        // The org comes off the ANSWER (`detail.org`) in preference to the URL:
        // the board says which org it came from, and a `/projects/3` link that
        // named none still gets a key naming the org that answered it, so the
        // same board keys the same however it was reached.
        //
        // It is a LIST, not a key: the pre-#697 key sits behind the current one
        // and is still read, so nobody's stored grouping went missing the day
        // the org went into it. `projectViewerKeys` argues that; `viewer-prefs`
        // reads the list in order and writes only its head.
        <IssuesViewer
          issues={detail.items.map(fromProjectItem)}
          options={options}
          defaultView="board"
          persistKey={persistKeys}
          hideRowLabels
          sourceProject={number}
          sourceProjectOrg={detail.org ?? org}
        />
      )}
    </section>
  );
}

// ─── Root ────────────────────────────────────────────────────────────────────
// One page now: a board. `route.project` is guaranteed by `route.ts`, which
// resolves a `projects` path with no usable number to Your work, and by
// `App.tsx`, which renders this only when the route carries one — the same pair
// of guards `repo` and `issue` have always had. The board name is its own big
// H1 inside `Overview`, so nothing is said here.
//
// `PageCrumb` draws no TRAIL here — the rollup was the board's only ancestor and
// `trail` returns [] for it (#785). What it draws is `← Back`, on a page the
// reader walked to, and #823 got that without editing this file: the slot is the
// page's rather than the crumb's, so what the crumb learns to offer a deep page
// with no ancestors, this page gets. A board opened on a pasted link still draws
// nothing, having neither an ancestor to name nor a walk to undo.
export default function ProjectsView({ route }: { route: Route }) {
  return (
    <div className={`${PAGE_RAIL} pb-20 pt-[26px]`}>
      <PageCrumb />
      <Overview number={route.project as number} org={route.org} />
    </div>
  );
}
