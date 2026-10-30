/**
 * What the repo page says, derived away from the page that draws it (#575).
 *
 * Same split `repos-vm.ts` makes for the map, and for the same reason: the page
 * is a component the board's `node` test env cannot mount, so every sentence,
 * every figure and every "there is nothing here" verdict is decided by a pure
 * function that a spec can drive directly.
 *
 * The shape every card takes is the shape the service's payload already
 * takes — three answers, not two:
 *
 *   `read`       — there is something to draw.
 *   `nothing`    — there is genuinely none of this. A fact about the repo.
 *   `unreadable` — the board could not find out. A fact about the read, worth a
 *                  retry, and never to be drawn as a zero.
 *
 * A card must never pad. A repo with no readme, no pull requests and no issues
 * draws three short cards saying so and then the page ends.
 */
import type { RepoCiSpend, RepoCiWindow, RepoPrFlow, RepoPrior, RepoPrWindow, RepoReadme, RepoRow } from '../api/repos';
import { plural, pushAge } from './repos-vm';
export { plural } from './repos-vm';
import { weekAgoLabel } from '../dashboard/trend-chart';

/**
 * The window every chart on this page draws, named once.
 *
 * It is ten weeks — the same ten rolling 7-day windows `RepoRow.weeks` carries,
 * which the PR flow and the CI spend are aligned to. Nothing on this page may
 * name a different one: a card headed "last 14 days" above a ten-week chart is
 * two claims about one picture, and a reader believes whichever they read first.
 */
export const REPO_PAGE_WINDOW = 'the last 10 weeks';

/**
 * The window a flow chart's TOTALS actually cover, which is not always the
 * window the page draws.
 *
 * `prFlowCard` sums the windows the read reached and drops the ones it never
 * did, so on a short read the chart is four weeks long and its two totals are
 * four weeks' worth — under an accessible name that said "in the last 10
 * weeks". A sighted reader gets the correction from the count under the chart
 * ("6 earlier weeks were not read."); a screen-reader user was told a window
 * they were not getting, with nothing to tell them otherwise.
 *
 * "in 4 of the last 10 weeks" rather than "in the 4 weeks that were read": one
 * shape at every count, including nought, and it keeps `REPO_PAGE_WINDOW` as
 * the page's one spelling of its window rather than growing a second (#582).
 * A read that reached no window at all says "in 0 of the last 10 weeks", which
 * is exactly true of the empty chart beside it.
 */
export function coveredWindow(read: number, uncovered: number): string {
  return uncovered <= 0 ? REPO_PAGE_WINDOW : `${read} of ${REPO_PAGE_WINDOW}`;
}

/**
 * WHAT EACH LINE OF A FLOW CHART IS CALLED, hero first as the chart's own hint
 * reads it.
 *
 * Here rather than written twice in the JSX, because each word is now said in
 * three places — the key at the line's end, the chart's accessible name, and
 * the sentence a pointer draws — and three spellings of one series is how a
 * chart comes to call the same line "closed" and "merged". It is also the only
 * place the copy gate can read them: a bare literal passed as a prop in a
 * `.tsx` file is not JSX text and not a prose attribute, so the words the old
 * dot legend drew were never in the ledger at all.
 */
export const ISSUE_SERIES = { hero: 'closed', trace: 'opened' };
export const PR_SERIES = { hero: 'merged', trace: 'opened' };

/**
 * What one week of a flow chart reads, in the board's one chart grammar (#877).
 *
 * `<when>, <hero> and <reference>` — when first, a comma between, the hero
 * series before the one it is read against, the pair joined with "and" rather
 * than a second comma. That is `docs/charts-answer-when-pointed-at.md`'s rule
 * and `dashboard/trend-chart.ts`'s `weekTipText` is the same sentence for the
 * Throughput chart; `weekAgoLabel` is imported from there rather than copied,
 * so "3 weeks ago" cannot become "3w ago" on one page and not the other.
 *
 * The two words are arguments because this page draws the grammar TWICE with
 * different nouns — closed against opened, merged against opened — and a second
 * function would be a second place for the comma to move.
 *
 * Here and not in the component for this file's own rule: a component may choose
 * a class and may not compose a string, or the grammar ends up somewhere
 * `repo-page-vm.spec.ts` cannot reach.
 */
export function weekPairHint(
  ago: number,
  hero: number,
  heroWord: string,
  reference: number,
  referenceWord: string,
): string {
  return `${weekAgoLabel(ago)}, ${hero} ${heroWord} and ${reference} ${referenceWord}`;
}

/**
 * What one week of the CI chart reads — the three-way distinction the chart's
 * free tick draws, said in words (#877).
 *
 * The line is net billed USD and $0.00 answers two different weeks, which is the
 * whole argument on `ciWeekKind` above: one where nothing ran, and one whose
 * work the allowance absorbed. On the chart those two are a marked and an
 * unmarked point on the same baseline — a 2x6 tick apart. A reader pointing at
 * one now gets the difference in a sentence instead of having to know what the
 * tick means.
 *
 * ONE reading, so it takes the comma and not "and": the grammar splits on
 * whether a chart reports one count or two, and this reports dollars. The free
 * week's minutes are a second CLAUSE about the same reading, not a second
 * series — which is the same reason they are not drawn as one.
 */
export function ciWeekHint(week: RepoCiWindow, ago: number): string {
  const when = weekAgoLabel(ago);
  switch (ciWeekKind(week)) {
    case 'billed':
      return `${when}, ${usd(week.netUsd)} net billed`;
    case 'free':
      return `${when}, ${usd(0)} net billed, ${plural(week.minutes, 'minute')} inside the allowance`;
    default:
      return `${when}, no CI ran`;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Coarse relative age, in the board's own register — the same ladder the rest
 *  of the app climbs (hours, days, weeks) and no finer. */
function agoWords(ms: number): string {
  if (ms < HOUR) return 'just now';
  if (ms < DAY) {
    const h = Math.round(ms / HOUR);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const days = Math.round(ms / DAY);
  if (days === 1) return 'yesterday';
  if (ms < 2 * WEEK) return `${days} days ago`;
  const w = Math.round(ms / WEEK);
  return `${w} week${w === 1 ? '' : 's'} ago`;
}

/** Net billed cost, to the cent. Rounding to the dollar would erase the whole
 *  distinction this page is built on: $0.00 and $0.49 are different answers. */
export function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** How one Overview figure moved against the previous period (#962). `measured`
 *  tells an answer from the words for there being none, so the card can draw
 *  the two differently. */
export interface Change {
  text: string;
  measured: boolean;
}

/**
 * The change line under a figure: a signed amount, "No change", or why there is
 * no comparison. Never "0%" and never an empty line.
 *
 * An absolute amount and not a percentage, as Org lag's is: a queue that went
 * from 1 to 3 open "grew 200%", which is true and tells a reader nothing. The
 * minus is U+2212, the one Org lag draws. Absent `prior` is a board-api older
 * than #962, which sent no comparison, and reads the same as one nobody could
 * make rather than as no change.
 */
export function change(now: number, prior: RepoPrior | undefined, money = false): Change {
  if (!prior || prior.state === 'unknown') return { text: 'Couldn’t compare', measured: false };
  if (prior.state === 'none') return { text: 'Too new to compare', measured: false };
  const delta = money ? Math.round((now - prior.value) * 100) / 100 : now - prior.value;
  if (delta === 0) return { text: 'No change', measured: true };
  const size = money ? usd(Math.abs(delta)) : String(Math.abs(delta));
  return { text: `${delta > 0 ? '+' : '−'}${size}`, measured: true };
}

// ── Issue flow ───────────────────────────────────────────────────────────────

/** What a failed issue read says, in one place (#837). The Overview's flow card
 *  and the Issues tab are two drawings of the SAME ingest read — the same
 *  argument `PR_UNREADABLE` carries one section down — so they may not word its
 *  failure differently, and neither may say "No open issues.": one is a fact
 *  about the repo and the other is a fact about the read. */
export const ISSUES_UNREADABLE = 'Open issues couldn’t be read just now.';

/** The issue-flow card: the open count and how it moved, the window's two
 *  series, and their totals for the chart's accessible name — or the words
 *  that say the queue never moved. It is still the flow the card draws; the
 *  header over it is "Issues", which names the figure it leads with (#1240). */
export type IssueFlowCard =
  | { kind: 'read'; figure: string; change: Change; opened: number; closed: number; weeks: RepoRow['weeks'] }
  | { kind: 'nothing'; line: string }
  | { kind: 'unreadable'; line: string };

/** `state` is `RepoPageView.openIssuesState` (#837), and it decides this card
 *  before any figure is looked at. The card's counts and the Issues tab's list
 *  are two drawings of ONE ingest read: an unread repo contributes no rows, so
 *  every week reads zero for exactly the reason the list is empty, and the card
 *  would otherwise say "Nothing opened or closed" one click away from the tab
 *  saying it could not be read. Optional because the payload's field is —
 *  absent is a board-api older than #837, which says nothing about the read. */
export function issueFlowCard(
  repo: RepoRow,
  now: number,
  state?: 'read' | 'unreadable',
  prior?: RepoPrior,
): IssueFlowCard {
  // Before the zeros, not after: the figures are zero BECAUSE nobody read them,
  // so there is no reading here that could outrank the failure.
  if (state === 'unreadable') return { kind: 'unreadable', line: ISSUES_UNREADABLE };
  const opened = repo.weeks.reduce((n, w) => n + w.opened, 0);
  const closed = repo.weeks.reduce((n, w) => n + w.closed, 0);
  if (opened === 0 && closed === 0) {
    // A flat line through zero looks like a measurement, and there was nothing
    // to measure. The push age says the repo is alive where the queue cannot —
    // 21 of the 22 issue-silent repos in this org were pushed to inside the
    // window (#572) — and is omitted rather than guessed when the payload
    // carries no `pushedAt`.
    //
    // No window in the sentence, and since #1197's rework no line above the
    // cards names one either (#1234's caption is gone). The window lives where
    // it qualifies something a reader is already reading: each chart's
    // accessible name, and each measured delta's own baseline.
    const age = pushAge(repo, now);
    const line = age ? `Nothing opened or closed. ${age[0].toUpperCase()}${age.slice(1)}.` : 'Nothing opened or closed.';
    return { kind: 'nothing', line };
  }
  return {
    kind: 'read', figure: String(repo.open), change: change(repo.open, prior),
    opened, closed, weeks: repo.weeks,
  };
}

// ── Pull requests ────────────────────────────────────────────────────────────

/** The pull-request card. `covered` drops the windows the read never reached
 *  and `uncovered` counts them, so the chart draws only what is known and the
 *  card can say how much of the window that was. */
export type PrFlowCard =
  | {
      kind: 'read';
      figure: string;
      change: Change;
      opened: number;
      merged: number;
      covered: RepoPrWindow[];
      uncovered: number;
    }
  | { kind: 'nothing'; line: string }
  | { kind: 'unreadable'; line: string };

/** What a failed pull-request read says, in one place: the trend card and the
 *  PRs tab are two drawings of the SAME read (#828), so they may not word its
 *  failure differently. */
export const PR_UNREADABLE = 'Pull requests couldn’t be read just now.';

export function prFlowCard(pr: RepoPrFlow, prior?: RepoPrior): PrFlowCard {
  if (pr.state === 'unreadable') {
    return { kind: 'unreadable', line: PR_UNREADABLE };
  }
  if (pr.open === 0 && pr.closedMerged === 0) {
    return { kind: 'nothing', line: 'No pull requests in this repo.' };
  }
  // A `null` window is one the read's cap did not reach — unknown, never empty.
  // Dropping it leaves a shorter chart; filling it with zero would invent a
  // quiet fortnight for the org's busiest repo.
  const covered = pr.weeks.filter((w): w is RepoPrWindow => w !== null);
  // One window on this card, and one only. The header says ten weeks and the
  // totals below are ten weeks; `closedMerged` is Github's ALL-TIME count, and
  // under a ten-week header it read as a third ten-week number. Three figures in
  // ~90px, two windows, nothing saying which: `1 open, 313 closed` above
  // `314 opened, 306 merged` invites the reading that 7 PRs were closed
  // unmerged, which neither number claims. It hid on `board`, seven
  // weeks old, where lifetime and ten weeks nearly coincide. The open count
  // stays — it is a right-now fact, not a window — and the lifetime one goes.
  return {
    kind: 'read',
    figure: String(pr.open),
    change: change(pr.open, prior),
    opened: covered.reduce((n, w) => n + w.opened, 0),
    merged: covered.reduce((n, w) => n + w.merged, 0),
    covered,
    uncovered: pr.weeks.length - covered.length,
  };
}

/** A window the read's cap never reached is stated, not dropped silently — the
 *  chart is then short by that many weeks, and shorter than the window its own
 *  accessible name claims.
 *
 *  A COUNT, not a caption. This page carries no sentence that describes what a
 *  reader can already see, and this one is not that: the weeks it counts are
 *  the ones NOT on the chart, so nothing else on the card reports them. It has
 *  ridden under the PR chart since #961; #1197's totals briefly pulled it up
 *  beside them (#1240 R1), and with those totals off the card it goes back to
 *  the one thing left that the missing weeks actually shorten.
 *
 *  Here rather than in the JSX that prints it, which is where the singular came
 *  in: this page's rule is that a component may choose a class and may not
 *  compose a string, and a grammar rule written into a component is one
 *  `repo-page-vm.spec.ts` cannot reach. `null` and not `''` for the sentence
 *  that is absent, so the caller can leave its line out. */
export function uncoveredNote(uncovered: number): string | null {
  if (uncovered <= 0) return null;
  return `${uncovered} earlier week${uncovered === 1 ? ' was' : 's were'} not read.`;
}

// ── CI spend ─────────────────────────────────────────────────────────────────

/**
 * What one week of CI actually was — the hardest distinction on this page.
 *
 * The measure is net billed USD, and net cost is $0.00 for two entirely
 * different weeks: one where nothing ran, and one whose real work the org's
 * included-minutes allowance absorbed. Measured, `acme-docs` ran 53, 303 and
 * 94 minutes in three consecutive weeks and was billed $0.00 for all three. On
 * a dollars-only chart those three weeks sit on the baseline, pixel-identical
 * to three silent ones, and the page says a repo did no CI all month when it in
 * fact ran nearly eight hours of it.
 *
 * Minutes are what tells them apart, and this is the only thing minutes are for
 * here. They are NOT a second trend and must not be drawn as one.
 */
export type CiWeekKind = 'idle' | 'free' | 'billed';

export function ciWeekKind(w: RepoCiWindow): CiWeekKind {
  if (w.netUsd > 0) return 'billed';
  return w.minutes > 0 ? 'free' : 'idle';
}

/**
 * The CI card. `weeks` is the dollars — the trend, and the only line drawn.
 * `free` is the INDEX of every week that ran inside the allowance, so the page
 * can mark those weeks on the baseline the dollars line is already sitting on:
 * a marked baseline week reads as "it ran, and cost nothing", an unmarked one
 * as "nothing ran", and the two are no longer the same picture.
 */
export type CiSpendCard =
  | { kind: 'read'; figure: string; change: Change; weeks: RepoCiWindow[]; free: number[]; note: string | null }
  | { kind: 'nothing'; line: string }
  | { kind: 'unreadable'; line: string };

export function ciSpendCard(spend: RepoCiSpend, prior?: RepoPrior): CiSpendCard {
  if (spend.state === 'unreadable') {
    return { kind: 'unreadable', line: 'CI spend couldn’t be read just now.' };
  }
  const minutes = spend.weeks.reduce((n, w) => n + w.minutes, 0);
  const netUsd = spend.weeks.reduce((n, w) => n + w.netUsd, 0);
  // Nothing ran, in any week, at any price — the one case that is genuinely
  // silence, and the only one allowed to read as it.
  if (minutes === 0 && netUsd === 0) {
    return { kind: 'nothing', line: 'No CI ran.' };
  }
  const free = spend.weeks.flatMap((w, i) => (ciWeekKind(w) === 'free' ? [i] : []));
  return {
    kind: 'read',
    figure: usd(netUsd),
    change: change(netUsd, prior, true),
    weeks: spend.weeks,
    free,
    // Said in words as well as drawn, because the mark is small and the claim
    // is not: a $0.00 window that ran for hours has to be legible without one.
    note: free.length ? `${plural(free.length, 'week')} used the included allowance; $0 was billed for that work` : null,
  };
}

// ── Open issues ──────────────────────────────────────────────────────────────

/** How long this issue has been waiting, said as the row prints it. One
 *  moment and one wording, because every row in this block is open (#826):
 *  the closing this used to choose between is not a fact any row here has. */
export function issueAge(createdAt: string, now: number): string {
  return `opened ${agoWords(now - Date.parse(createdAt))}`;
}

// ── Readme ───────────────────────────────────────────────────────────────────

/** The readme, and the two ways there can be none of it. */
export type ReadmeCard =
  | { kind: 'read'; markdown: string }
  | { kind: 'nothing'; line: string }
  | { kind: 'unreadable'; line: string };

export function readmeCard(readme: RepoReadme): ReadmeCard {
  if (readme.state === 'unreadable') {
    return { kind: 'unreadable', line: 'The readme couldn’t be read just now.' };
  }
  // A file of whitespace is nothing to render — drawing it leaves a headed
  // block with a blank body, which reads as a page that failed halfway.
  if (readme.state === 'absent' || !readme.markdown.trim()) {
    return { kind: 'nothing', line: 'No readme.' };
  }
  return { kind: 'read', markdown: readme.markdown };
}

// ── A repo this board does not carry ─────────────────────────────────────────

/** What the page says when it has no view, and the way back said as a way back.
 *  Not an error page — a repo that is not here — so it stays quiet: a heading,
 *  one sentence, one link. */
export interface MissingRepo {
  heading: string;
  line: string;
  back: string;
}

const BACK_TO_REPOS = 'Back to Repos';

export function missingRepo(status: 'not-found' | 'error', owner: string, name: string): MissingRepo {
  const full = `${owner}/${name}`;
  // One of these is permanent and one is worth another go, so they share no
  // words: "isn't here" must never be what a dropped socket says.
  if (status === 'not-found') {
    return { heading: 'Not on this board', line: `${full} isn’t a repo this board carries.`, back: BACK_TO_REPOS };
  }
  return { heading: 'Couldn’t read this repo', line: `${full} couldn’t be read just now.`, back: BACK_TO_REPOS };
}

/**
 * What the open-issues block offers beside its rows: the count in the header,
 * and the way to the rest of them underneath (#575 definition of done, #826).
 *
 * Two gates, and they answer two different questions. The count goes on
 * `open > 0`, because a zero is not a count. The row goes on the block's cap
 * having actually hidden something, which is `open > shown` — `shown` being the
 * number of rows this render is drawing, not a second spelling here of the cap
 * the server applies. A repo with three open issues draws all three and is
 * offered nothing, because there is nothing more to show and an absent part of
 * this page reads as nothing.
 *
 * Gating the row on `open` alone is what #826 shipped, and it promised rows that
 * were already on screen: every repo with one to five open issues drew all of
 * them and then offered to show them, a repo with one open issue reading
 * "Show all 1 open issue →" directly under that issue.
 *
 * The count is still the repo's whole open count and not the block's, so six
 * rows of seven open reads "Show all 7 open issues" — the link goes to all of
 * them. `showAll` is a sentence rather than a flag because that noun is plural
 * for seven and singular for one, and this page's rule is that a component may
 * choose a class and may not compose a string — a grammar rule written into the
 * JSX is one this file's spec cannot reach.
 */
export function openIssuesHead(open: number, shown: number): { meta: string | null; showAll: string | null } {
  const meta = open > 0 ? `${open} open` : null;
  if (open <= shown) return { meta, showAll: null };
  return { meta, showAll: `Show all ${plural(open, 'open issue')}` };
}
