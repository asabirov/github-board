/** Shared project row data and weekly activity formatting. */
import type { ProjectContributor, ProjectSummary } from '../api/projects';
import { joinFailedCountNote, staleCopyCountNote, truncatedCountNote, withheldCountNote } from './pulse';

/** One project row's shape for the shared block — a subset of `ProjectSummary`
 *  (`api.ts`) plus nothing else: `pct`, `open` and the two week figures are always
 *  the PROJECT's own numbers (whole-board), never a per-caller subset, so the
 *  same project reads identically wherever this renders it. */
export interface ProjectBlockRow {
  /** The org the board belongs to (#697) — with `number`, its whole address.
   *  Optional because the board-api it comes from may predate the field; absent,
   *  the row links to the unqualified `/projects/:number` it always linked to. */
  org?: string;
  number: number;
  name: string;
  pct: number;
  /** Closes in the trailing 7 days. Optional twice over (#715): a board-api that
   *  predates the field sends none, and so does a board whose item read came up
   *  short — the service withholds it rather than serving a figure off a partial
   *  read. `itemsComplete` is what tells those two apart. */
  closedThisWeek?: number;
  /** Opens over that same trailing 7 days (#851) — the second half of the week
   *  line. Optional on exactly `closedThisWeek`'s terms and withheld by the same
   *  three causes through the same function in board-api, so the pair is present
   *  together or absent together and the line never states one half of it. */
  openedThisWeek?: number;
  /** Whether the source read every item on this board (#690/#715). `false` is a
   *  read known to be short, and the sub-line says so instead of counting;
   *  absent is a board-api that predates the flag and makes no claim. Since #722
   *  it also takes the ring's percentage off the row, for the reason `Ring`'s
   *  `withheld` carries. */
  itemsComplete?: boolean;
  /** Whether the ORG-WIDE issues-to-memberships join behind the week figure ran
   *  (#722). A SECOND, separate gate — never derived from `itemsComplete` and
   *  never folded into it: this board's own items were read whole, so its ring
   *  and its percentage stay, and only the week figure the join fed is gone.
   *  Absent is a board-api that predates the flag, or the drill-in detail route,
   *  which runs no org-wide join at all. */
  pulseJoined?: boolean;
  /** Whether this board is the last-good COPY rather than a read (#713, #770) —
   *  a write dropped the rollup cache, the re-read failed, and the service
   *  served the copy that drop retired. A THIRD, separate gate: it is not about
   *  a read going wrong, it is about which payload arrived, and it is the only
   *  one of the three that says the row's own counts and ring are out of date.
   *  Absent, or false, is a payload that came from a read — including a
   *  board-api that predates the field. */
  lastGoodCopy?: boolean;
  /** Whether the joined figures behind the week count are off the payload
   *  (#792), whatever took them off. The three flags above each name one cause;
   *  this one names none, and board-api sets it on all of them and on any cause
   *  added later. It is the sub-line's fallback and not its gate — a board-api
   *  predating the field sends the causes and not this, so the row goes on
   *  reading all four. Absent is no claim, and never invented here: a `false`
   *  the wire did not send is the row saying the figures ARE present. */
  joinedFiguresWithheld?: boolean;
  /** Still-open issues — the hover's "Still open N", which is what makes the
   *  ring's percentage checkable against its runs. */
  open: number;
  /** The ring's per-member runs, both attributions (#454). Absent → the row
   *  paints the plain single-arc ring. */
  contributors?: ProjectContributor[];
  contributorsByAssignee?: ProjectContributor[];
}

/** The ring's quiet sub-line — pure so it's unit-testable without rendering
 *  (#419). "This week: 21 closed, 3 opened" since #851.
 *
 *  BOTH directions, because one of them cannot answer the question the card is
 *  being asked. Twenty-one closed is the same line whether the board took three
 *  new issues that week or thirty, and only one of those two boards is
 *  converging. The window stayed the week when the second figure went on: the
 *  ring beside this line is a lifetime percentage, so a one-day delta next to it
 *  is a scale jump, and a Monday reads Sunday and empties every card at once.
 *
 *  Zero still reads as a PHRASE and not as a bare count, which is #419's rule and
 *  the reason this function exists — but only where there is nothing at all to
 *  count. Inside the labelled frame a 0 is already a fact rather than an alarm:
 *  "This week: 0 closed, 3 opened" is a sentence about a week, and it is the one
 *  reading the old copy could not produce. Both at zero has no such frame to sit
 *  in, so it keeps a phrase.
 *
 *  Negatives floor at 0 defensively, as they did before: no count reaching here
 *  can be one, and a "-1 closed" on a card would be the row inventing a fact. */
export function formatWeeklyClosed(closed: number, opened: number): string {
  const c = Math.max(0, closed);
  const o = Math.max(0, opened);
  if (c === 0 && o === 0) return 'Nothing opened or closed this week';
  return `This week: ${c} closed, ${o} opened`;
}

/** What that sub-line actually says, for both surfaces that draw this row
 *  (#715, #722). A board read short has no week figure to show — the service
 *  withholds it on the same gate that withholds the day series — and counting
 *  the absence as zero said the week was empty, a claim about the board where
 *  the truth is that nobody can say. Since #722 there is a second way to have no
 *  figure: the org-wide join behind it did not run. Four cases, and the two
 *  flags are what separate them from the two boards that legitimately send no
 *  count — one read whole with a quiet week, and a board-api predating the
 *  fields. Both call sites go through here so the Projects card and Your work
 *  cannot answer this differently.
 *
 *  Since #770 there is a THIRD. `lastGoodCopy` says this board is the copy a
 *  drop retired, served because the read after the write failed (#713) — and
 *  that copy was served with `pulseJoined: false` until #792, so before #770 it
 *  borrowed the join's sentence and told the reader the closes were not read.
 *  They were: by the copy in front of them. What is out of date is the board's
 *  own counts, its ring and its contributor list, and this is the only one of
 *  the three sentences that says so.
 *
 *  It goes SECOND, not first, and the rule that puts it there is the one
 *  `MovementNote` stated: a board can be several of these at once, the line fits
 *  one sentence, and the larger claim takes it. "We could not read all of this
 *  board" is larger than "these counts are from before the last write" — and it
 *  is the only one of the two that accounts for what the same row draws beside
 *  it, because a read-short row withholds its ring and the retiree's sentence
 *  says nothing about a share. Ordered the other way, the row states an old
 *  count next to a track refusing to state any count at all. Past that the
 *  retiree's sentence outranks the join's, which is simply false of a retiree.
 *
 *  Since #792 there is a fourth sentence and it goes LAST.
 *  `joinedFiguresWithheld` says those figures are off the payload without saying
 *  what took them off, so a reader that can name the cause should: each of the
 *  three above says more than "withheld", and each accounts for something else
 *  the same row draws. This one is the fallback for a withholding whose cause
 *  this frontend cannot name — a cause board-api grows after this file was
 *  written, and nothing else.
 *
 *  It ADDS to the gate rather than taking it over, and that is the part to be
 *  careful with. A running bundle can be older than the board-api it is talking
 *  to, so a payload from one predating #792 carries the causes and not this flag.
 *  Gate the withholding on this flag alone and that payload falls through to
 *  `formatWeeklyClosed(0, 0)`, and a board read short says it opened and closed
 *  nothing —
 *  the exact bug #715 was filed on, reintroduced from the other direction. So all
 *  four reads stay, each on its own field, and the first with something to say
 *  takes the line.
 *
 *  How long that skew can last is the life of a TAB, not the length of a deploy,
 *  and that is why the four reads have no expiry to plan for. `/assets/*` is
 *  served `Cache-Control: public, max-age=31536000, immutable`
 *  (deploy/Caddyfile.platform:39) while `index.html` is `no-cache`, so a page
 *  LOAD always picks up the new bundle — but nothing here forces one: no service
 *  worker, no version poll, and the app's only `location.reload()` is in
 *  auth/AuthScreen.tsx. Meanwhile the dashboard refetches `/api/projects` on
 *  every "Sync now" (dashboard/Dashboard.tsx, the effect keyed on the refresh
 *  signal). A tab left open therefore keeps its bundle indefinitely while the
 *  payloads under it move on.
 *
 *  What that costs: on a retiree that was ALSO read short the reader is told the
 *  list was not read and is NOT told the copy is old — one line, one sentence,
 *  and nothing else on the row carries the second. The figures come back on the
 *  first read that succeeds and `RETIREE_MAX_TTLS` caps how long a copy may
 *  stand in at all (`unjoined`, board-service/src/projects/projects.service.ts),
 *  so the state is bounded rather than silent forever. A single sentence saying
 *  both is the open alternative; that is a copy decision, not this file's. */
export function weeklyClosedLine(
  p: Pick<
    ProjectBlockRow,
    | 'closedThisWeek'
    | 'openedThisWeek'
    | 'itemsComplete'
    | 'pulseJoined'
    | 'lastGoodCopy'
    | 'joinedFiguresWithheld'
  >,
): string {
  return (
    truncatedCountNote(p.itemsComplete)
    || staleCopyCountNote(p.lastGoodCopy)
    || joinFailedCountNote(p.pulseJoined)
    || withheldCountNote(p.joinedFiguresWithheld)
    || formatWeeklyClosed(p.closedThisWeek ?? 0, p.openedThisWeek ?? 0)
  );
}

/** A board's whole address (#697) — what a row is drawn AT, as opposed to what
 *  it is drawn from. Your work's strip reads it off the contribution rather than
 *  off the rollup, because a contribution the join never matched still draws. */
export type BoardAddress = Pick<ProjectBlockRow, 'org' | 'number' | 'name'>;

/** A rollup board → the row this block draws, in ONE place (#715).
 *
 *  Three surfaces wrote this map by hand — the Projects card, Your work's strip
 *  and the single-org parity spec — and when the week count stopped being
 *  coalesced to 0 the third copy went on coalescing, so the spec asserted parity
 *  over a shape the app no longer produces. The field list and the
 *  carry-don't-coalesce rule live here now.
 *
 *  Address and summary are two arguments because they are two different things
 *  on Your work: the row is drawn at the contribution's address and filled from
 *  whichever rollup board matched it, which may be none. A caller mapping the
 *  rollup itself passes the same board twice.
 *
 *  `pct` and `open` coalesce to a quiet ring because an unmatched board has no
 *  ring to draw; `closedThisWeek`, `itemsComplete`, `pulseJoined`,
 *  `lastGoodCopy` and `joinedFiguresWithheld` never do, because 0 there is the
 *  row saying the board closed nothing and a `false` invented here would be the
 *  row claiming a failure nobody reported. `lastGoodCopy` is carried for
 *  symmetry rather than for that reason: an invented `false` there says the row
 *  IS a read, which is what absent already means, so it would not lie — it would
 *  just be a second spelling of the same thing, on a field the wire may
 *  legitimately omit. `joinedFiguresWithheld` (#792) is back on the strict side
 *  of that split: an invented `false` says the four joined figures ARE on this
 *  payload, which is a claim and not a second spelling of silence. What the
 *  strict side buys is that this mapper never makes the claim — not that anything
 *  downstream can tell the claim from silence. Nothing can: `weeklyClosedLine`
 *  reaches this field through `withheldCountNote`, which reads `=== true`, so a
 *  `false` and an absence render alike here, exactly as `lastGoodCopy`'s two
 *  do. */
export function blockRowOf(at: BoardAddress, p: ProjectSummary | undefined): ProjectBlockRow {
  return {
    org: at.org,
    number: at.number,
    name: at.name,
    pct: p?.pct ?? 0,
    closedThisWeek: p?.closedThisWeek,
    openedThisWeek: p?.openedThisWeek,
    itemsComplete: p?.itemsComplete,
    pulseJoined: p?.pulseJoined,
    lastGoodCopy: p?.lastGoodCopy,
    joinedFiguresWithheld: p?.joinedFiguresWithheld,
    open: p?.open ?? 0,
    contributors: p?.contributors,
    contributorsByAssignee: p?.contributorsByAssignee,
  };
}
