/**
 * The Projects surface: a read-only mirror of the org's **GitHub Projects (v2)**
 * boards (the source of truth). Two screens — a rollup of every board, and one
 * board's issue table. Nothing here is editable; every write happens on GitHub.
 *
 * (Superseded the earlier `infra-epic` tracking-issue model, which surfaced
 * nothing because no such label was ever created.)
 */
import type { KnownLabels } from '../auth/feedback-visibility';

import type { CloseReason } from '../issues-metrics/close-reason';
import type { PersonalIssueType } from '../issues-metrics/issues-metrics.types';

/** A board's health, derived from its progress + recency (see project-derive). */
export type ProjectStatus = 'active' | 'in-progress' | 'just-started' | 'stalled';

/** The last issue closed on a board — shown on the rollup ("last closed by whom"). */
export interface LastClosed {
  /** owner/name of the repo the issue lives in. */
  repo: string;
  number: number;
  title: string;
  url: string;
  /** GitHub login of whoever closed it, or null when unknown. */
  by: string | null;
  /** ISO timestamp it was closed. */
  atISO: string;
}

/**
 * One candidate for the rollup's recency line (#497): a close, plus the label
 * names the feedback-visibility decision needs to place it.
 *
 * A board carries more than one close, and which one a given caller may be told
 * about depends on who they are — a submission triaged onto a board is an
 * ordinary Github issue whose TITLE is the end user's first line. So a source
 * hands up the closes it read, newest first, and `ProjectsService` picks the
 * newest one the caller may read. `labels` exists to decide with and is dropped
 * before the pick is served; `LastClosed` is what goes on the wire.
 */
export interface ProjectClose extends LastClosed {
  /** Github label names, lower or upper case as the API returned them — or null
   *  when the source could not establish the whole set, which the decision
   *  treats as a close it cannot place (#497). */
  labels: KnownLabels;
  /**
   * Github login of whoever OPENED the issue, or null when the source could not
   * read one (a deleted account returns no author).
   *
   * The recency pick keys on this rather than on `by` (#488). What makes a close
   * a dependency bump is that automation wrote it; who eventually pressed Close
   * is a fact about the repo's merge habits, and on a live board that is a
   * person — the card the issue was filed about read "Upgrade @acme/ui …,
   * closed by Octocat". Keyed on `by` the skip would have caught nothing there.
   *
   * Decides with, like `labels` — it never goes on the wire.
   */
  author: string | null;
}

/** One run of the segmented completion ring (#454) — a slice of the board's
 *  closed count, and whose it is. `kind` says how to read `login`:
 *  - `person` — one member's closes; `login` is their Github login.
 *  - `others` — everyone past `CONTRIBUTOR_CAP`, folded into one run. `login`
 *    is empty; `people` says how many the run stands for.
 *  - `unattributed` — closes with no member behind them (bot actors, deleted
 *    accounts, an issue with no assignee). `login` is empty.
 *  The `closed` values always sum to the board's `closed`, so the ring can't
 *  disagree with the percentage in its middle. */
export interface ProjectContributor {
  /** Github login for a `person` run; '' for the two aggregate runs. */
  login: string;
  /** Closed issues this run accounts for. */
  closed: number;
  kind: 'person' | 'others' | 'unattributed';
  /** `others` only: how many people the run folds in, so it can name itself. */
  people?: number;
}

/** A board as shown in the rollup: counts, completion, and the last-closed read. */
export interface ProjectSummary {
  /**
   * The Github org this board was read from (#697).
   *
   * Required, and it is the field that makes `number` readable at all once a
   * deployment names two orgs: a project number is unique WITHIN an org, so the
   * union `/api/projects` serves can carry two different boards both numbered 3.
   * Without this, "board 3" names two things and a reader has no way to say
   * which. A single-org board answers its one org here, so nothing about that
   * deployment changes except that the field is now said out loud.
   *
   * Stamped by `ProjectsService` from the org it made the read UNDER — the same
   * string its per-org cache is keyed by — never by the source. A source is told
   * which org to read and is never asked which org it read, so the label and the
   * cache key cannot come apart.
   */
  org: string;
  /** The org project number (stable WITHIN `org`; also the deep-link segment). */
  number: number;
  name: string;
  /** Canonical GitHub URL, e.g. github.com/orgs/<owner>/projects/<number>. */
  url: string;
  status: ProjectStatus;
  open: number;
  closed: number;
  /** Completion = closed / (open + closed), 0–100 rounded. 0 when empty. */
  pct: number;
  /**
   * How many of the board's items every count above leaves out (#517).
   *
   * A Projects v2 board holds pull requests and draft items as well as issues,
   * and this surface counts issues only — so a board carrying a pull request
   * reports a completion percentage the same board on Github does not. The
   * counting is deliberate and stays; what this field adds is that the reader
   * can be TOLD, instead of being left to find the difference themselves.
   *
   * Counts the items the source read and dropped, not the ones its page never
   * reached. A board with more items than the query asked for is a separate
   * fact, carried separately by `itemsComplete` below; folding the two together
   * would tell a reader that a hundred pull requests sit on a board that has
   * none.
   *
   * 0 on every board we run today, which is the number that has to stay silent.
   */
  excludedItems: number;
  /**
   * True when the board's item read reached the END of its item list (#663).
   *
   * Answered by the SOURCE, against the `totalCount` Github reports beside the
   * items (#690): the read is whole when it holds at least as many items as the
   * board said it had, and a source with no total to check against says so
   * rather than claiming a shortfall it cannot see. It used to be derived one
   * layer up, by comparing the item counts to the page size both read paths
   * asked for, because a page that came back full proved nothing about what
   * came after it; since #690 both paths follow the cursor to the end, so there
   * is no page size to compare against and the only remaining evidence — the
   * total, and how far the paging actually got — lives in the source.
   *
   * False does not mean items are known to be missing — it means nobody can say
   * they are not. Three things still produce one: the source's 20-page cap, a
   * board that changed while its pages were being walked, and a continuation
   * page that failed on a read serving what it already had.
   *
   * What a false costs the reader is specific, and it costs three things. Every
   * count above is a floor rather than a total, so `pct` is computed over part of
   * a board. The two day series come back EMPTY, because project items arrive in
   * board order and the ones that fall off the end of a page are the newest —
   * exactly the items the trailing day bucket is made of; a truncated board's
   * pulse is not off by the size of the shortfall, it is off by all of it (#690).
   * And the week figures go with them (#715): `weeklyClosed` comes back empty and
   * `closedThisWeek` is not sent at all, both being derived from the same join
   * over the same short read.
   *
   * Required, not optional, so a new reader has to handle a board it was told
   * nothing certain about rather than inherit an opening `true`.
   */
  itemsComplete: boolean;
  /**
   * Whether the org-wide issues ↔ memberships join behind the five pulse figures
   * actually RAN for this rollup (#722). One thing, and since #792 only that one.
   *
   * False means it did not: `ProjectsService.rawIssues()` degrades to no join
   * when the shared issues cache throws, which is an infrastructure failure
   * covering every board in the org at once. `weeklyClosed`, `closedThisWeek`,
   * `openedThisWeek`, `dailyOpened` and `dailyClosed` are then withheld in the
   * spelling #715
   * settled — the two series empty, the count absent — because there is nothing
   * behind them but a fallback: an empty join makes the week series fall back to
   * whatever the source seeded and both day series to fourteen zeros, which is
   * exactly what a genuinely quiet org looks like. A rollup carrying a false is
   * also not cached, so the outage is not served for the whole TTL.
   *
   * It says WHY the five figures are gone and never THAT they are gone.
   * `joinedFiguresWithheld` below is what says they are gone, and it answers for
   * causes this field has no opinion about. So a `false` here always travels
   * beside a withheld flag, and a `true` travels beside either.
   *
   * Absent means no claim either way, and there are two ways to make none: a
   * board-api that predates this field, and the drill-in detail route, which
   * runs no org-wide join at all and never has (its two day series are `[]` for
   * that reason already). Read it the way `itemsComplete` is read — `=== false`,
   * never a truthiness test — so an absent flag counts as it always did.
   *
   * NOT `itemsComplete`, and it must never be folded into it. That flag says ONE
   * board's item read stopped short; this one says an org-wide join did not run.
   * The blast radius differs, the remedy differs, and both can be true of one
   * board at once — a board read short whose join also failed. A reader that
   * collapses them can only say one of the two sentences. Between #770 and #792
   * this field broke that rule itself: `unjoined()` set it false on a last-good
   * copy, whose join had run, because the false was the only withholding the
   * frontend of the day could read. #792 gave the withholding a flag of its own
   * and this one went back to saying one thing.
   */
  pulseJoined?: boolean;
  /**
   * Whether this board is the last-good COPY rather than a read (#713, #770).
   *
   * True means a write dropped `ProjectsService`'s rollup cache, the read that
   * should have replaced it failed, and `retired()` served the copy that drop
   * retired instead of failing the page. Everything on this board — `closed`,
   * `open`, `pct`, `contributors`, `lastClosed` — is from BEFORE that write. A
   * reader who just closed an issue will not find it here. What to do is wait
   * and reload: the figures come back on the first read that succeeds, and
   * `RETIREE_MAX_TTLS` caps how long a copy may stand in at all.
   *
   * A THIRD gate, and it is not either of the two above it. `itemsComplete` and
   * `pulseJoined` both say a READ went wrong — one board's items came up short,
   * an org-wide join did not run — and both withhold figures that join fed while
   * leaving the board's own counts alone. This one says nothing about a read: it
   * says WHICH PAYLOAD arrived, and it is the only one of the three that speaks
   * for the counts, the ring and the contributor list — ON A ROW. The Projects
   * card's headline share sums a retiree read whole like any other board and
   * carries no marker (`ProjectsCard` in board-frontend/src/dashboard/Pulse.tsx,
   * which filters on `readShort` alone); that predates this flag and is not
   * changed by it.
   *
   * It exists because `pulseJoined: false` was carrying both causes and the
   * frontend could only say one sentence (#770). A retiree still withholds the
   * five joined figures — they are anchored to the clock of the read that
   * produced them (see `unjoined`) — but since #792 the flag carrying that
   * withholding is `joinedFiguresWithheld`, not a false borrowed from the join.
   * This one answers the question it is named for and no other: which payload
   * arrived. A retiree's `pulseJoined` is `true`, which is the truth, because
   * the join ran for the copy being served.
   *
   * Absent, or false, is a payload that came from a read: a board-api that
   * predates the field, the drill-in detail route, and every board on a rollup
   * the source answered. Read it `=== true` — the OPPOSITE spelling from its two
   * neighbours, because the safe reading of "no claim" runs the other way. They
   * withhold on no claim; this one would have every board in the app announce
   * that its numbers are old.
   */
  lastGoodCopy?: boolean;
  /**
   * Whether the five joined figures — `weeklyClosed`, `closedThisWeek`,
   * `openedThisWeek`, `dailyOpened` and `dailyClosed` — are off this payload
   * (#792, #851).
   *
   * That is the whole of what it says. Not why they are gone, not what went
   * wrong, not whether anything else on this board is affected: only that the
   * five are not here to be read. `itemsComplete`, `pulseJoined` and
   * `lastGoodCopy` are the three things that cause it, and each of them says its
   * own sentence about its own cause.
   *
   * It exists because `pulseJoined: false` was doing this job as well as its own
   * (#770), so a retiree went out saying an org-wide join had not run when it
   * had — a rollup is cached only when the join ran, so every copy a drop retires
   * is one whose join succeeded. #792 split the two apart: the cause flags say
   * why, this one says that.
   *
   * True EXACTLY when the five are absent, and by construction rather than by
   * this comment. `withoutJoinedFigures` in projects.service.ts is the one
   * function that takes them off, it sets this flag in the same expression, and
   * all three withholding paths run through it. A fifth joined figure added there
   * is covered on the day it is added; one taken off anywhere else is what the
   * spec's flag-and-figures-together case fails on.
   *
   * Absent is no claim, and there are two ways to make none: a board-api that
   * predates this field, and the drill-in detail route, which runs no org-wide
   * join, serves the source's own week seed and `[]` for both day series — a
   * payload this flag has no true answer for. Read it `=== true`, the spelling
   * `lastGoodCopy` takes: a reader that was told nothing has to judge the figures
   * themselves, which is what every reader did before this field existed.
   */
  joinedFiguresWithheld?: boolean;
  lastClosed: LastClosed | null;
  /** Closes per ISO week for the board, oldest → newest, last slot = the current
   *  week — the rollup's faint 10-week mini-trend (#391). Sources emit a default
   *  ([] on the live source, a seed series on the fixture); `ProjectsService`
   *  fills it from the org-wide issues ↔ membership join.
   *
   *  EMPTY, not ten zeros, whenever `joinedFiguresWithheld` is true. That flag is
   *  stamped where the five joined figures come off, and it answers for the five
   *  TOGETHER rather than for this series on its own (#792). Three separate things
   *  set it, and each keeps its own reason. A board whose `itemsComplete` is false
   *  (#715), the rule `dailyOpened` states below: ten zeros claim a quiet quarter
   *  on a board nobody read the end of. A rollup whose `pulseJoined` is false
   *  (#722), which never ran the join this is filled from, and whose source seed
   *  is not evidence of anything. And a `lastGoodCopy` (#713), whose ten buckets
   *  belong to a clock the service no longer has.
   *
   *  The implication does not run the other way, and an empty array on its own is
   *  also what a quiet board sends. When the join derives nothing but zeros
   *  `readRollup` falls back to whatever the source seeded — the fallback at
   *  `projects.service.ts:598` — and the live source seeds this field `[]` at
   *  `github-projects.source.ts:817`. So a board read whole, joined and simply
   *  quiet ships an empty series beside `closedThisWeek: 0`,
   *  `joinedFiguresWithheld: false` and two fourteen-long day series: the
   *  emptiness is the seed showing through, not a withholding. Read the flag, not
   *  the length. That seed fallback predates #792 and #792 did not touch it —
   *  changing it is out of scope for that issue, and the reason it is safe to
   *  leave is that nothing gates on emptiness. */
  weeklyClosed: number[];
  /** Closes in the trailing 7 days — the pulse headline over the mini-trend
   *  (#391). The last entry of `weeklyClosed`.
   *
   *  OPTIONAL because it is WITHHELD from a board whose `itemsComplete` is false
   *  (#715) — the same read that withholds the two day series, withheld for the
   *  same reason. Both figures come from the org-wide issues ↔ membership join,
   *  and the membership index is built from the same source read the board's
   *  items came from, so a board read short is short by exactly those items;
   *  items arrive in board position order, so what it lost is the newest end,
   *  which is most of a week bucket. Absent rather than 0, next to a
   *  `weeklyClosed` that is empty rather than ten zeros: a 0 claims a quiet week
   *  on what may be the busiest board in the org.
   *
   *  Withheld by two further causes (#722, #713) — a rollup whose `pulseJoined`
   *  is false, and a board that is a `lastGoodCopy`. `joinedFiguresWithheld` is
   *  the one flag saying the figure is gone whichever of the three took it, and
   *  the three cause flags are what tell the absences apart; a reader needs them
   *  all, because a board can be under more than one at a time. */
  closedThisWeek?: number;
  /** Opens in the same trailing 7 days `closedThisWeek` counts closes over
   *  (#851) — the second half of the card's week line, "This week: 21 closed,
   *  3 opened".
   *
   *  Derived by `ProjectsService` from the trailing seven buckets of
   *  `dailyOpened`, not from a second walk over the issues, so the two windows
   *  are the same interval by construction rather than by agreement — see
   *  `openedThisWeekOf` in `project-pulse.ts`.
   *
   *  OPTIONAL for exactly the reasons `closedThisWeek` is, and withheld by the
   *  same three causes through the same function. It has NO source seed, which
   *  is `dailyOpened`'s rule rather than `weeklyClosed`'s: a board that opened
   *  nothing is a fact about the board. So on the fixture, where the week's
   *  CLOSES can fall back to a seeded series the join never produced, this
   *  figure still comes from the join and reads 0 beside it. That asymmetry is
   *  the seed showing through in local dev and not a claim about any live
   *  board — the live source seeds `weeklyClosed: []`, so both figures there
   *  come from the same join or from neither. */
  openedThisWeek?: number;
  /** Issues opened per day for the board, oldest → newest, last slot = the
   *  trailing 24 hours (#663). `PULSE_DAYS` long — 14, measured rather than
   *  picked: a 70-day series is non-zero on 7-15 days of 70 on the live boards,
   *  which is the flat chart #470 pulled.
   *
   *  Derived by `ProjectsService` from the same org-wide issues ↔ membership
   *  join `weeklyClosed` uses, read on `createdAt` instead of `closedAt`. Unlike
   *  `weeklyClosed` there is NO source seed behind it: a board that opened
   *  nothing serves fourteen zeros, because a quiet board is a fact about the
   *  board and not a gap to paper over.
   *
   *  EMPTY, not zeros, whenever `joinedFiguresWithheld` is true (#792) — a board
   *  whose `itemsComplete` is false, a rollup whose `pulseJoined` is false
   *  (#722), a board that is a `lastGoodCopy` (#713) — and on the detail route,
   *  which derives no series at all and sends no flag either. Fourteen zeros is a
   *  claim about a fortnight; `[]` is the absence of one. */
  dailyOpened: number[];
  /** Issues closed per day, over the same buckets as `dailyOpened` (#663).
   *
   *  Falling is the good direction here and the payload does nothing to say so
   *  — no sign is inverted, no series is pre-subtracted. Both are plain counts;
   *  which way is good news is the reader's to render. */
  dailyClosed: number[];
  /** The completion ring's per-member runs, attributed to whoever CLOSED each
   *  issue (#454) — the `ClosedEvent` actor the rollup query already reads for
   *  `lastClosed`. Biggest share first; sums to `closed`. */
  contributors: ProjectContributor[];
  /** The same runs attributed to whoever the issue was ASSIGNED to instead.
   *
   *  Both ship because the two answers disagree, and neither is wrong. "Who
   *  closed it" is a record of an act — but on a repo where one person merges,
   *  it credits the merger rather than the author. "Who was it assigned to" is
   *  a record of intent — truer to whose work it was, and blank on every issue
   *  nobody claimed. The frontend picks one behind a single named constant
   *  (`RING_ATTRIBUTION`); shipping both keeps that a display decision instead
   *  of an API migration. */
  contributorsByAssignee: ProjectContributor[];
}

/** What happened last on an issue (#259) — the kind of the most recent
 *  meaningful timeline event. `opened` when nothing else has happened yet. */
export type ActivityType = 'opened' | 'commented' | 'closed' | 'reopened' | 'assigned';

/** One issue row in a board's overview table (the drill-in screen). */
export interface ProjectItem {
  /** owner/name of the issue's repo (a board can span repos). */
  repo: string;
  number: number;
  title: string;
  url: string;
  /** The board's Status field value (Todo / In Progress / Done / custom), or ''. */
  status: string;
  /** Lifecycle state, independent of the board's custom Status column. */
  state: 'open' | 'closed';
  /** ISO close timestamp, or null when open (#407) — lets the shared closed-week
   *  timeframe filter match real closed items on the Projects page (without it,
   *  closed-week would silently match nothing there). */
  closedAt: string | null;
  /**
   * WHY it closed (#1014) — null when it is open, and null too when Github told
   * us nothing we recognise.
   *
   * Carried beside `closedAt` rather than derived from it, because "closed" and
   * "delivered" stopped being the same fact: a row closed as `not_planned` or
   * `duplicate` is out of every close count on this board, and a reader looking
   * at the table needs the same reason the counts were made on. Required for
   * the reason `labelsComplete` above is required — a new source has to answer
   * rather than inherit the generous default, which here means counting an
   * abandoned issue as delivered work.
   */
  stateReason: CloseReason;
  /** GitHub logins of the assignees. */
  assignees: string[];
  /** Pull requests that (would) close the issue — "assigned PRs". */
  prs: { number: number; url: string }[];
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /** The most recent meaningful timeline event (#259). `href` deep-links to the
   *  event on Github (a comment permalink); absent for events that carry none, so
   *  the viewer links to the issue instead (#376).
   *
   *  The list column that showed its `type` and `atISO` is now Age (#822), off
   *  `createdAt` — a queue row carries no activity to show beside a project row's
   *  (#834). `href` is still read, so the age cell keeps its link to the event. */
  lastActivity: { type: ActivityType; atISO: string; href?: string };
  /** Parent issue number when this is a native Github sub-issue, else null — the
   *  List view nests sub-issues under their parent (#273). Null for top-level. */
  parent: number | null;
  /** Github labels on the issue (name + color) — the shared IssuesViewer filters
   *  and groups by label on the Project page (#376). Empty when the issue has none. */
  labels: { name: string; color: string }[];
  /** True when `labels` is the row's WHOLE set — false when Github held more
   *  than the query's page (#497). The words gate keys on a label being present,
   *  so a partial page would read as "no `feedback` label here" and serve an end
   *  user's first line; false makes the gate withhold instead. Required, not
   *  optional, so a new source has to answer rather than inherit an opening
   *  default. */
  labelsComplete: boolean;
  /** Coarse work type derived from `labels` (#376), same taxonomy as the queue —
   *  so the viewer can group project items by type. */
  type: PersonalIssueType;
  /** Enumerable Projects v2 custom-field values for this item (#401): fieldSlug →
   *  value display-name(s). Single-select option name / iteration title only. Absent
   *  when the board defines no enumerable custom fields. */
  customFields?: Record<string, string[]>;
}

/**
 * One board row before the viewer-scoped pass (#516): a `ProjectItem` plus the
 * footer marker the decision needs to place it.
 *
 * `DETAIL_QUERY` selects the issue's `body`, so this surface is told outright
 * rather than depending on the shared submission index — it carries more titles
 * than any other gated surface, and the body rides a query already pulling
 * thirty field values, two timeline connections and five PR references, cached
 * five minutes per board.
 *
 * The BODY never gets this far. It is read into this boolean inside the source's
 * mapper and goes no further, so no submission's words or address ever enter the
 * Projects cache. The boolean itself is dropped by `readableItems` on the way
 * out, the same way `ProjectClose.labels` and `.author` are: it exists to decide
 * with, and a payload should carry what it is for.
 */
export interface ProjectItemRaw extends ProjectItem {
  /** True when the issue's body carries the board feedback form's footer. */
  submission: boolean;
}

/** A board plus its issue rows (the overview / drill-in screen). */
export interface ProjectDetail extends ProjectSummary {
  items: ProjectItem[];
}

/**
 * What a backing source produces for a board, BEFORE anyone's identity is
 * known (#497). Identical to `ProjectSummary` except that `lastClosed` — the
 * one field whose answer depends on the caller — is replaced by the ordered
 * candidates it is chosen from. `ProjectsService` caches this shape, picks a
 * `lastClosed` per caller, and drops `recentCloses`, which never goes on the
 * wire: it holds the titles the pick may have skipped past.
 *
 * `itemsComplete` is carried here, and it is the one field that MOVED (#690).
 * It used to be omitted, on the reasoning that `ProjectsService` derived it from
 * the item counts a source already reported and a source that could not supply
 * it could not disagree with the derivation. Paging inverted that: the read is
 * whole when it saw as many items as Github's `totalCount` said were there, and
 * `totalCount` exists in the source's payload and nowhere else. So the source is
 * now the only thing that CAN answer it, and a derivation upstairs could only be
 * a guess dressed as a fact — which is what the hardcoded `true` it replaces was.
 *
 * `org` is the field that moved the OTHER way (#697), and for the mirror-image
 * reason. A source is handed the org to read as an argument, so it could echo it
 * back — and an echo is the one thing that can disagree with the cache key the
 * answer is filed under. `ProjectsService` stamps it from that key instead, so
 * this shape omits it and a source cannot mislabel a board it read correctly.
 */
export interface ProjectRollup
  extends Omit<
    ProjectSummary,
    | 'lastClosed'
    | 'dailyOpened'
    | 'dailyClosed'
    | 'org'
    | 'closedThisWeek'
    | 'openedThisWeek'
    | 'pulseJoined'
    | 'lastGoodCopy'
    | 'joinedFiguresWithheld'
  > {
  /** The trailing week's closes — REQUIRED here and optional on the wire, the
   *  mirror image of the two day series below (#715).
   *
   *  It is optional on `ProjectSummary` because `ProjectsService` WITHHOLDS it
   *  from a board the source could not read whole. That is a decision taken on
   *  the way out, and it says nothing about what a source owes: every source can
   *  seed this figure and both do — 0 on the live source, the last slot of its
   *  seed series on the fixture. So it is re-declared required rather than
   *  inherited, and a source that forgets it does not compile. */
  closedThisWeek: number;
  /** The trailing week's opens — REQUIRED here on exactly `closedThisWeek`'s
   *  terms (#851), and for one more reason of its own.
   *
   *  The two travel as a PAIR: `readRollup` takes both from the org-wide join or
   *  both from the seed, never one of each, because the card puts them in one
   *  sentence and invites the reader to compare them. A source that seeded a
   *  week count and no open count would leave the fallback half-built, and the
   *  fixture would draw a seeded 5 beside a joined 0. So this is required for
   *  the same reason its pair is: a source that forgets it does not compile. */
  openedThisWeek: number;
  /** Every close the source read for this board, newest first. */
  recentCloses: ProjectClose[];
  /** The two day series (#663) — OPTIONAL here and required on the wire.
   *
   *  No source produces them. They are not a fact about one board that a board
   *  query could answer; they come from the org-wide issues ↔ membership join,
   *  which only `ProjectsService` has both halves of. `weeklyClosed` is required
   *  on this shape because a source CAN seed a plausible one and the fixture
   *  does; there is deliberately no such seed here, so requiring them would only
   *  force every source to invent fourteen numbers it cannot know. */
  dailyOpened?: number[];
  dailyClosed?: number[];
  /* `pulseJoined` is OMITTED above rather than made optional here (#722), which
   * is stronger than either day series' treatment. It is not a fact about a
   * board at all: it says whether an ORG-WIDE read happened, and a source is
   * asked one board at a time and never runs that read. A source that could
   * answer it could only be guessing, and a guess here would be indistinguishable
   * from the layer that knows. `ProjectRollupPulsed` requires it instead.
   *
   * `lastGoodCopy` is OMITTED for a stronger version of the same reason (#770).
   * It is not a fact about a board OR about a read: it says which payload the
   * service reached for, which a source cannot know because a source that was
   * asked at all is the answer this flag says did not arrive.
   *
   * `joinedFiguresWithheld` is OMITTED for the reason both of them are, said of
   * the withholding rather than of the read (#792). A source is asked one board
   * at a time and hands up everything it read; what may be SERVED of that is
   * decided a layer up, against an org-wide join and a cache no source can see.
   * A source answering this could only be describing a withholding it did not
   * do, and the layer that does it would then have two answers to reconcile. */
}

/**
 * A raw board with its day series attached (#663) — what `ProjectsService`
 * produces from the org-wide join and caches for the rollup route.
 *
 * The two series are optional on `ProjectRollup` and required here, which is the
 * whole point: the rollup path is the one place they can be derived, so the
 * compiler makes it derive them rather than a comment promising it does. The
 * detail route, which runs no join, keeps the optional shape and says so.
 *
 * `itemsComplete` is NOT part of that requirement any more (#690): it arrives on
 * `ProjectRollup` from the source, which is the only layer holding the
 * `totalCount` that settles it, and this shape passes it through untouched. It
 * still sits beside the series because it is what decides whether they may be
 * served at all — the deciding just happens against a fact now, not a page size.
 *
 * Each half of the intersection names a layer, and `closedThisWeek` is why the
 * left one is an `Omit` (#715). The left half is what the source produced, minus
 * the one field this layer may take away; the right half is what this layer
 * decided — the two day series it derived, and a week figure that is optional
 * AGAIN because the same `itemsComplete` gate withholds it from a board read
 * short. This is the exact point the optionality begins: required of a source,
 * absent from a truncated board, optional to everything downstream.
 *
 * `pulseJoined` is REQUIRED here and optional on the wire (#722) — the same way
 * round as the two day series, for the same reason. This is the one layer that
 * runs the org-wide join, so it is the one layer that can say whether the join
 * ran; requiring it makes a rollup path that forgets to answer a compile error
 * rather than a board that quietly makes no claim.
 *
 * `lastGoodCopy` is required on the same terms (#770), and this is the shape the
 * retiree is KEPT in as well as the one it is served in — so the requirement
 * lands on both ends of that path. `readRollup` answers `false` on every board
 * it reads and `unjoined` answers `true` on every board it retires; a third path
 * that produced this shape without deciding would not compile, which is the one
 * thing standing between a future rollup source and a board that is a copy from
 * before a write while saying it is a read.
 *
 * `joinedFiguresWithheld` is required here for the sharpest version of that same
 * argument (#792). This is the layer that TAKES the five figures off — every
 * withholding path in the service runs through `withoutJoinedFigures` — so it is
 * the layer the compiler makes answer for them. A board reaching this shape
 * without saying whether they are on it does not compile, which is what keeps
 * "the flag is true exactly when the figures are absent" a property of the code
 * rather than a sentence in a docblock.
 */
export type ProjectRollupPulsed = Omit<ProjectRollup, 'closedThisWeek' | 'openedThisWeek'> &
  Pick<ProjectSummary, 'dailyOpened' | 'dailyClosed' | 'closedThisWeek' | 'openedThisWeek'> &
  Required<Pick<ProjectSummary, 'pulseJoined' | 'lastGoodCopy' | 'joinedFiguresWithheld'>>;

/** A raw board plus its raw issue rows — `ProjectDetail` before the viewer-scoped
 *  pass. Cached; never served. */
export interface ProjectDetailRaw extends ProjectRollup {
  items: ProjectItemRaw[];
}

/** A board and the issue URLs on it — the reverse index for stacking a user's
 *  issues by project (#206 follow-up). Built from the same list query, so it
 *  rides the rollup cache and costs no extra GitHub call. Join on issue URL.
 *
 *  `org` for the same reason it is on `ProjectSummary` (#697): unioned over two
 *  orgs, `number` alone names two boards. The JOIN itself is on issue URL, which
 *  is org-unique already, so nothing downstream had to change — this is here so
 *  a reader of the index can say which board a row is. */
export interface ProjectMembership {
  org: string;
  number: number;
  name: string;
  issueUrls: string[];
}

/** A board a writer could add an issue to (#404) — the minimal identity the
 *  add picker needs. `id` is the ProjectV2 node id the add route consumes.
 *
 *  `org` names which org's picker entry this is (#697). `id` was already unique
 *  across orgs — it is a Github node id — but `number` and `title` are what a
 *  person reads, and two orgs can spell both the same. */
export interface ProjectCatalogEntry {
  org: string;
  id: string;
  number: number;
  title: string;
}

/**
 * The two board shapes as a SOURCE answers them — everything but the org (#697).
 *
 * Same rule as `ProjectRollup`'s omission, in the two places the wire shape and
 * the source shape were otherwise the same type: a source is TOLD which org to
 * read and is never asked which org it read, so `ProjectsService` stamps `org`
 * from the cache key it filed the answer under. An echoed org is the one field
 * that could disagree with where the answer is actually cached.
 */
export type SourceMembership = Omit<ProjectMembership, 'org'>;
export type SourceCatalogEntry = Omit<ProjectCatalogEntry, 'org'>;

/** DI token for the pluggable backing source (fixture in dev/test, GitHub live). */
export const PROJECTS_SOURCE = 'PROJECTS_SOURCE_IMPL';

/** What every backing source must provide. All reads; the board never writes.
 *
 *  Sources know nothing about who is asking — they produce the raw shapes
 *  (`ProjectRollup` / `ProjectDetailRaw`) and `ProjectsService` applies the one
 *  feedback-visibility decision on the way out (#497). Keeping identity out of
 *  the source is what lets the cache stay shared: a static agent token's read
 *  can never poison the next human's.
 *
 *  ONE org per call, and the org is an ARGUMENT rather than a property of the
 *  source (#697) — the same shape `IDeliverySource.load(org)` took, for the same
 *  reason. A deployment naming two orgs reads both through one source instance,
 *  concurrently and tolerantly, so one org's failure is one org's failure.
 *  Deciding WHICH orgs to ask and how to union the answers is `ProjectsService`'s
 *  job, which is where the per-org caches already live (#648).
 *
 *  It used to be a `readonly owner` settled in the constructor, which is what
 *  made a two-org deployment silently serve `GITHUB_ORGS[0]` and nothing else:
 *  one instance, one org, for the process's whole life. */
export interface IProjectsSource {
  /** Every surfaced board in `org`, with rollup counts, completion and closes. */
  listProjects(org: string): Promise<ProjectRollup[]>;
  /** One board in `org`, or null if the number is unknown/hidden THERE — which
   *  is not the same as unknown everywhere, since another org may hold it.
   *
   *  Null is that answer and no other: an org that could not be READ must throw
   *  rather than answer null, because `ProjectsService` walks every configured
   *  org for a number and the two decide different things there — whether a
   *  later org's board is served under this URL, whether the miss is cached as a
   *  fact, and whether a total outage is a 404. */
  getProject(org: string, number: number): Promise<ProjectDetailRaw | null>;
  /** Per-board issue-URL lists for `org` — the reverse index for stacking. */
  projectMemberships(org: string): Promise<SourceMembership[]>;
  /** Every open (non-closed) board in `org` — id/number/title only — the
   *  candidate list the issue add-to-project picker draws from (#404). */
  listProjectCatalog(org: string): Promise<SourceCatalogEntry[]>;
  /** Forget the board reads this source is holding IN FLIGHT for `org` — or for
   *  every org, when none is named (#713).
   *
   *  A source may hand every caller that arrives during one read the SAME
   *  promise, and `ProjectsService` cannot see that latch: a write clears its own
   *  maps and moves its epoch, and the read the write itself triggers was still
   *  handed the flight that went out BEFORE it — pre-write boards, cached for a
   *  whole TTL because the epoch it snapshotted had already moved. So a write
   *  says this too, before its warm read goes out.
   *
   *  Forget, not cancel: the flight already running is still owed to whoever is
   *  awaiting it and keeps resolving. It is simply offered to nobody new.
   *
   *  REQUIRED, not optional, and that is the whole point of it being here: a
   *  source that grows a read-sharing latch and quietly does not implement this
   *  brings #713 back with nothing to show it. A source holding nothing in flight
   *  answers with an empty body, and that is an answer rather than an omission. */
  disownInFlightReads(org?: string): void;
}
