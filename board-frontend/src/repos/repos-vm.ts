/**
 * The Repos page's derivation (#472, rebuilt #558). Pure — the page renders
 * straight off this, so every tile, filter and sentence on the surface is
 * unit-tested here rather than assembled inline in JSX.
 */
import { copyResponseDeadline } from '../auth/response-deadline';
import type { OwnerWritability, RepoHealth, RepoOwner, RepoRow, RepoSecurity, ReposHealthView, ReposView } from '../api/repos';
// The board's one voice for a scope it could only partly read (#650, #718).
// Both sentences this page draws are written there and nowhere else — rule 1 of
// `org-scope/narrowed-surfaces.spec.ts`, whose sweep is what enforces it.
import { missingOrgsNotice, partlyReadNotices, type OrgPartlyRead } from '../auth/org-scope-copy';

/**
 * One repo as the map draws it: the row, and the health joined onto it.
 *
 * A tile carried a standing beside those two once — four of them at first
 * (`behind`, `steady`, `clear`, `dormant`), then one, and now none. They went
 * for two different reasons, worth keeping apart.
 *
 * `dormant` was wrong. It meant "empty queue, no issue activity", which is 22
 * repos on this org, 21 of them pushed to inside the window (#572) — so it
 * called live repos dead. The sparkline cannot correct that one, because issue
 * flow is not liveness; `pushedAt` is what answers it, and the Last push order
 * is where that landed.
 *
 * `behind` was redundant. It was true when it fired, but it summarised in a
 * boolean what the tile's own sparkline already draws week by week, and it went
 * with the warning left edge that was its only reader (#607).
 *
 * A standing nothing draws is a standing nothing corrects.
 */
export interface RepoTile {
  row: RepoRow;
  metric?: RepoMetric;
  /** What the health read says about this repo, or `null` while that read has
   *  not landed (#571). `null` is the tile's placeholder bar, and it is the one
   *  thing a zero must never stand in for. */
  health: RepoHealth | null;
}

// ── the health, and the map that has not got it yet (#571) ──────────────────

/**
 * The map's health, keyed by `full`, or `null` while the read is in flight.
 *
 * Two reads, one page: `/api/repos` carries the rows and `/api/repos/health`
 * carries the alerts and the CI conclusion. This is the second of the two as
 * the page holds it, and the whole of what "not yet" means here — a `null` map
 * is a map nothing is known about, and every tile under it says so.
 *
 * A SETTLED map missing a repo is a different answer: the repo is at the
 * defaults. The server sends a row for every repo including the clean ones, so
 * the only way that happens in practice is a failed read, which hands the page
 * `NO_HEALTH` and settles the whole map at once.
 */
export type ReposHealth = ReadonlyMap<string, RepoHealth> | null;

/**
 * What the page holds after a health read that FAILED: settled, and carrying
 * nothing.
 *
 * "Nothing" is UNREAD, not zero (#718). It used to be four zeros on every tile,
 * and that made a refused read draw a clean bill of health for the whole map —
 * the same false statement the per-org unread states exist to stop, reached
 * through a second door. So losing this read no longer costs "the word and
 * nothing else": it costs the CI conclusion, and every tile says its alerts
 * were not read.
 *
 * It stays an empty map rather than a fabricated row per repo, because the
 * lookup below already answers for a repo it carries nothing for, and one
 * answer for both cases is the point — see `UNMEASURED_HEALTH`.
 */
export const NO_HEALTH: ReadonlyMap<string, RepoHealth> = new Map();

/**
 * What a settled read says about a repo it carries no row for.
 *
 * Two ways to get here and one honest answer for both: the whole read failed
 * (`NO_HEALTH`, above), or a settled payload skipped this repo — a skew between
 * two deploys, since the server sends a row for every repo including the clean
 * ones. Neither is a measurement, so neither may draw one. The counts stay zero
 * because the shape needs numbers; `state: 'unreadable'` is what says they were
 * never counted, and every reader of this page goes through `securityLevel` or
 * `alertsUnread` rather than reading the zeros directly.
 */
const UNMEASURED_HEALTH: RepoHealth = {
  security: { state: 'unreadable', depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 0, secretsUrl: null },
  ci: null,
  ciUrl: null,
};

/** The health read, keyed by the repo each row belongs to. `full` is the join —
 *  never the position, because the two reads have no reason to arrive in the
 *  same sequence and the map is re-sorted besides. */
export function healthByRepo(view: ReposHealthView): ReadonlyMap<string, RepoHealth> {
  return copyResponseDeadline(view, new Map(view.repos.map((r) => [r.full, { security: r.security, ci: r.ci, ciUrl: r.ciUrl }])));
}

/** Every repo in the chosen reading order, with whatever is known of its health
 *  joined on — the same order whichever facet or query narrows what's shown,
 *  because an order re-arranges the map and never decides which repos are on
 *  it. An unrecognised key reads as the default; see `orderByKey`.
 *
 *  The health defaults to `null` — the honest resting value, since the row read
 *  lands first and every caller that has the health says so. */
export function buildTiles(
  view: ReposView,
  orderKey: string = DEFAULT_ORDER,
  health: ReposHealth = null,
): RepoTile[] {
  return view.repos
    .map((row) => ({ row, health: health && (health.get(row.full) ?? UNMEASURED_HEALTH) }))
    .sort(orderByKey(orderKey).compare);
}

/** Health filters wait for observations; ordinary orders can draw the first read. */
export function tilesReady(filter: RepoHealthFilter, health: ReposHealth): boolean {
  return filter === 'all' || health !== null;
}

// ── what the two reads could not reach (#718) ───────────────────────────────

/** Lower-cased, for comparing an org named in a CONFIGURED list against the
 *  same org as Github spells it in `RepoRow.full`. The two differ by case on a
 *  routine deployment and are one org. */
const orgKey = (org: string) => org.toLowerCase();

/**
 * The lines this page draws about orgs it could not fully read — none, one, or
 * both, and each only when it has something to say.
 *
 * TWO sentences over two different org sets, because only one claim fits each:
 *
 *   · `ReposView.unreadableOrgs` — the enumeration failed, so the org has no
 *     rows here at all. "These numbers leave it out" is exactly true.
 *   · everything else that went unread — the org's rows ARE on the map, and
 *     saying the numbers leave it out would be false in front of a reader
 *     looking at three of its repos. That set is the health payload's own list
 *     (an org whose alert lists refused) plus the orgs of every row carrying
 *     `ownerState: 'unreadable'`.
 *
 * The second half of that second set has to come from the ROWS: a failed
 * ownership read is reported per row and named in no org-level list, so an org
 * whose `dri` read failed is otherwise never named at all.
 *
 * An org in the FIRST set is never in the second, whatever the health payload
 * says about it: with no rows on the map, "the repos are here for it" is the
 * one thing that cannot be true.
 */
export function scopeGapLines(view: ReposView, healthUnreadable: readonly string[] = []): string[] {
  const absent = view.unreadableOrgs ?? [];
  const gone = new Set(absent.map(orgKey));
  // Insertion order is the served order: the health list first, then the orgs
  // the rows name. Keyed case-insensitively, and the spelling kept is the first
  // one seen, which is the configured one wherever a list carried it.
  const partly = new Map<string, OrgPartlyRead>();
  for (const org of healthUnreadable) {
    if (gone.has(orgKey(org))) continue;
    partly.set(orgKey(org), { org, unread: 'alerts' });
  }
  for (const row of view.repos) {
    if (row.ownerState !== 'unreadable') continue;
    const org = repoRef(row).owner;
    const key = orgKey(org);
    if (gone.has(key)) continue;
    const seen = partly.get(key);
    // A second unread row for an org already named for its owners changes
    // nothing; an org already named for its alerts becomes both.
    partly.set(key, {
      org: seen?.org ?? org,
      unread: seen === undefined ? 'owners' : seen.unread === 'alerts' ? 'both' : seen.unread,
    });
  }
  const missing = missingOrgsNotice(absent);
  return [...(missing === null ? [] : [missing]), ...partlyReadNotices([...partly.values()])];
}

// ── security ──────────────────────────────────────────────────────────────

export type SecurityLevel = 'exposed' | 'high' | 'low' | 'unread' | 'clean';

/** A leaked secret outranks everything else on the repo: a repo that is
 *  otherwise spotless but leaked a credential is `'exposed'`, never `'clean'`.
 *  Absent a secret, five-or-more high or critical Dependabot alerts (`depHigh`
 *  is the two added together) — or five-or-more code-scanning alerts, which the
 *  server counts at ANY severity — reads `'high'`; any other non-zero count
 *  reads `'low'`; all-zero is `'clean'`.
 *
 *  A read that failed is a fifth answer (#718), and it is the LAST one asked
 *  for. `state: 'unreadable'` means any ONE of the org's three alert lists
 *  refused — the state is stamped onto a real row (`repos.service.ts`) — so a
 *  counted credential beside it is an ordinary payload: secret scanning
 *  answered, Dependabot did not. Every count here is a measurement or a zero,
 *  and a measurement outranks the state, or this surface draws a live leak in
 *  its quietest ink and files it fourth of five in the order made for looking.
 *  `unread` is the answer only where nothing at all was counted, which is the
 *  one case where the zeros might be nobody's measurement.
 *
 *  `clean` is the same zeros with every list having answered. The two must not
 *  collapse, or the order files an org nobody could read among the spotless.
 *
 *  An ABSENT state is `clean`, on the terms `RepoSecurity.state` states: a
 *  board-api too old to say draws exactly what it drew before the field. */
export function securityLevel(s: RepoSecurity): SecurityLevel {
  if (s.secrets > 0) return 'exposed';
  if (s.depHigh >= 5 || s.codeScanning >= 5) return 'high';
  if (s.depHigh > 0 || s.depModerate > 0 || s.codeScanning > 0) return 'low';
  if (s.state === 'unreadable' || s.state === 'not-applicable') return 'unread';
  return 'clean';
}

// ── the reading order ─────────────────────────────────────────────────────

/** The ordinary reading orders retained alongside health filters. */
export type RepoOrderKey = 'open' | 'recent' | 'name';

export interface RepoOrder {
  key: RepoOrderKey;
  /** The order's name, said once: the menu row prints it, and the control's
   *  resting label is this same wording turned into a phrase (`orderTrigger`).
   *  Two strings would be two things to keep in agreement, so there is one.
   *  Which is also why no label here carries a proper noun: lower-casing one
   *  would misspell it. */
  label: string;
  /** Tiles rather than rows, because one order sorts on the health joined onto
   *  them. The three that only read the row go through `onRow`. */
  compare: (a: RepoTile, b: RepoTile) => number;
}

/** An order that only ever looks at the row, said once. */
const onRow =
  (compare: (a: RepoRow, b: RepoRow) => number) =>
  (a: RepoTile, b: RepoTile): number =>
    compare(a.row, b.row);

const byName = (a: RepoRow, b: RepoRow) => a.name.localeCompare(b.name);

/**
 * The moment of a repo's last push, or nothing where there is no reading it.
 *
 * `null` is a repo Github has never taken a push for, and an unparseable value
 * is an API one deploy out of step shipping a row without the field — neither
 * is a moment, and neither may be turned into one. `pushAge` reads this too, so
 * the order and the sentence on the tile agree about which repos have an age
 * (#572).
 */
const pushedMs = (row: RepoRow): number | null => {
  const at = Date.parse(row.pushedAt ?? '');
  return Number.isFinite(at) ? at : null;
};

/**
 * Most recently pushed first, with the unmeasured last.
 *
 * A repo with no readable push is not an old repo — it is a repo with no age at
 * all, so it is never given a number to be sorted by. Falling back on `0` would
 * place it at 1970, which is a claim about when it was last touched; appending
 * it instead says only that there is nothing here to compare.
 */
const byRecent = (a: RepoRow, b: RepoRow) => {
  const x = pushedMs(a);
  const y = pushedMs(b);
  if (x === null || y === null) {
    if (x === y) return byName(a, b);
    return x === null ? 1 : -1;
  }
  return y - x || byName(a, b);
};

/**
 * Every order the map can be read in, and there is no fifth.
 *
 * A pull-request order is the one a reader asks for next and the one that is
 * not here: the counts it would need are #582, and nothing in board-service
 * serves them — an entry for it would be a control over data that does not
 * exist.
 *
 * Every comparator ends in the name, so no order leaves two repos in whatever
 * sequence the payload happened to arrive in.
 */
export const ORDERS: readonly RepoOrder[] = [
  { key: 'open', label: 'Open issues', compare: onRow((a, b) => b.open - a.open || byName(a, b)) },
  // Named for what it sorts on and nothing wider. It read `Recent activity`,
  // and only the chartless tiles print an age — so under it most of the grid
  // moved with no visible key, and "activity" is the exact word #572 exists to
  // disown, issue flow not being liveness. The URL still says `recent`: a value
  // is not a label, and links have been sent.
  { key: 'recent', label: 'Last push', compare: onRow(byRecent) },
  { key: 'name', label: 'Name', compare: onRow(byName) },
];

/** The map opens on the fullest queue, as it has since #558 — so a first visit
 *  writes nothing to the URL. Taken off the head of the list rather than named
 *  again, so the menu's first row and the resting order cannot disagree. */
export const DEFAULT_ORDER: RepoOrderKey = ORDERS[0].key;

/** The order a key names. An unknown key — a stale link, a typo, a fifth order
 *  that never shipped — reads as the default rather than emptying the map. */
export function orderByKey(key: string): RepoOrder {
  return ORDERS.find((o) => o.key === key) ?? ORDERS[0];
}

/** The menu's section label — the property's own name, as the owner menu does
 *  it. */
export const ORDER_LABEL = 'Order';

/** What the control rests on: the order the tiles are ACTUALLY in, as a phrase.
 *  It reads off the same key the grid is sorted by, so the page cannot name an
 *  order it is not in — which is what the meta line #574 removed did. */
export function orderTrigger(key: string): string {
  return `by ${orderByKey(key).label.toLowerCase()}`;
}

/**
 * The control's accessible name: what the phrase is the value OF, which the
 * visible `by recent activity` does not say on its own.
 *
 * It stops there rather than inviting a press, as the owner control's name does
 * ("Click to change"). That control has to say it — it is a plain button, and
 * nothing else about it announces that a menu is behind it. This one carries
 * `aria-haspopup="menu"`, which announces exactly that, so the sentence would be
 * saying twice what the role already says once. It is also the owner control's
 * own words, and this page asserts they appear nowhere the owner picker is
 * withheld.
 */
export function orderAria(key: string): string {
  return `Reading order: ${orderByKey(key).label.toLowerCase()}`;
}

// ── search ────────────────────────────────────────────────────────────────

/** The `/` key's hint (#573). The `kbd` in the field shows the key and not what
 *  it is for; a person who has not already guessed learns nothing from it. */
export const SEARCH_KEY_HINT = 'Press / to jump to this field from anywhere on the page';

/** An empty (or blank) query matches every repo; otherwise a case-insensitive
 *  substring match against the name or the description. */
export function matchesQuery(row: RepoRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (row.name.toLowerCase().includes(q)) return true;
  return row.description !== null && row.description.toLowerCase().includes(q);
}

// ── what the grid draws ───────────────────────────────────────────────────

/** What the grid draws: the map narrowed by the chosen owner and by what has
 *  been typed, still in `buildTiles`'s reading order. Both narrowings apply
 *  together — neither replaces the other — so a name typed under a chosen face
 *  leaves the repos that satisfy both. */
export function visibleTiles(tiles: RepoTile[], owner: OwnerSlot | null, query: string): RepoTile[] {
  return tiles.filter((t) => ownedBy(t.row, owner) && matchesQuery(t.row, query));
}

/**
 * Does this row belong behind the pressed face — no face, a person's, or the
 * one standing for the repos nobody owns.
 *
 * A repo whose ownership read FAILED belongs behind none of them (#718). It is
 * not the person's, and it is not "nobody recorded as owner" either: nobody
 * asked the org. It stays on the map under `All`, where it has always been, and
 * the nobody face narrows to exactly what its own count says.
 */
const ownedBy = (row: RepoRow, owner: OwnerSlot | null): boolean => {
  if (owner === null) return true;
  if (owner.login === null) return !row.owner && !ownerUnread(row);
  return (row.owner?.login ?? null) === owner.login;
};

// ── what one tile says ──────────────────────────────────────────────────────

/** The one coloured word a tile draws. */
export interface TileWord {
  text: string;
  /** `danger` is reserved for a leaked credential; a CI conclusion is a
   *  warning. */
  tone: 'danger' | 'warning';
  /** What the word means, for the hover hint. */
  hint: string;
}

/**
 * What a tile's word slot holds — three answers, not two (#571).
 *
 * `quiet` and `unsettled` both draw no word, and conflating them is the whole
 * defect this page had: while the health read is in flight, a tile that simply
 * omitted the word would be saying "nothing to report" about a repo nothing is
 * known about, and would then grow a red word under a reader who had already
 * read it as clean. `unsettled` is the placeholder bar; `quiet` is the settled
 * silence, and most of the map is quiet.
 */
export type WordSlot =
  | { state: 'unsettled' }
  | { state: 'quiet' }
  | ({ state: 'word'; href: string | null } & TileWord);

const UNSETTLED: WordSlot = { state: 'unsettled' };
const QUIET: WordSlot = { state: 'quiet' };

/** The subject a CI hint adds to the conclusion, which the word alone leaves
 *  out: WHICH run it is the conclusion of. */
const LATEST_RUN = 'Latest completed Actions run';

/**
 * Every condition a tile draws a word for, worst first — and there is no other.
 *
 * This is one table rather than a vocabulary of lookups because the lookups were
 * where the false strings lived. Three rounds of fixes went into words for
 * security levels and CI conclusions the tile never prints; the tables read as a
 * complete vocabulary, their specs read as coverage of shipped behaviour, and
 * both were describing rows nothing on the page could reach. A condition that
 * cannot be drawn now has nowhere to be written down.
 *
 * Order is the "worst first" rule and the reason there is ever only one word: a
 * repo with a credential in its history AND a red build has one thing worth
 * saying. Within CI the order is moot — `row.ci` is a single conclusion — so the
 * three sit in the order Github's own vocabulary reads.
 *
 * Each hint is the thing the word does not say. A tile printing "Leaked secret"
 * spends its hover on where that came from, not on saying it again; a tile
 * printing "CI failing" spends it on Github's own term (`Failing`), which is
 * what you would go looking for in Actions, and on which run.
 *
 * Two conditions are deliberately absent. `high` security fires on half this
 * org, which is its normal state rather than news, and the security order still
 * puts those repos at the top. A conclusion that is a choice rather than a fault
 * (`cancelled`, `skipped`) or a repo that never completed a run is nothing to
 * report at all — a spec walks the whole `RepoCi` union asserting this table
 * draws for those three conclusions and no others.
 */
const SECRET_HINT = 'GitHub secret scanning found a credential in this repo';

/**
 * The hint does NOT say where the word goes, and that is a decision rather than
 * an omission (#605).
 *
 * It said so briefly. The clause read "— opens the run on Github", and it cost
 * more than it was worth: it took all three CI hints from one line to two, and
 * the box from 31px to 47px. `WORD_SIDE` in `RepoTile.tsx` had been measured
 * against a 31px box — at 47px it stopped clearing the tile in the row below
 * and bit 7px of that tile's repo name and 10px of its open count, at 1280 and
 * at 1440 alike. A word that reaches its run at the cost of covering its
 * neighbour's name has moved the problem rather than solved it.
 *
 * What says it instead costs no pixels: the underline on hover, the target URL
 * the browser puts in its own status bar, and the fact that an anchor announces
 * as a link. So EVERY word carries the sentence it has always carried, whether
 * it is reachable or not — which also means the "behaves exactly as today" rule
 * needs no separate wording to enforce, because there is only one wording.
 */

/** Each entry says where its own address lives on the health. `null` is a read
 *  that brought none back, and it is the only thing that can make a word inert
 *  — nothing here composes an address out of a repo name. */
type DrawnWord = TileWord & {
  when: (health: RepoHealth) => boolean;
  href: (health: RepoHealth) => string | null;
};

const DRAWN: readonly DrawnWord[] = [
  {
    when: (health) => securityLevel(health.security) === 'exposed',
    href: (health) => health.security.secretsUrl,
    text: 'Leaked secret',
    tone: 'danger',
    hint: SECRET_HINT,
  },
  {
    when: (health) => health.ci === 'failure',
    href: (health) => health.ciUrl,
    text: 'CI failing',
    tone: 'warning',
    hint: `${LATEST_RUN}: Failing`,
  },
  {
    when: (health) => health.ci === 'timed_out',
    href: (health) => health.ciUrl,
    text: 'CI timed out',
    tone: 'warning',
    hint: `${LATEST_RUN}: Timed out`,
  },
  {
    when: (health) => health.ci === 'action_required',
    href: (health) => health.ciUrl,
    text: 'CI needs action',
    tone: 'warning',
    hint: `${LATEST_RUN}: Action required`,
  },
];

/**
 * The first condition the repo meets, nothing, or — before the health lands —
 * that nothing is known yet.
 *
 * The word names what failed rather than quoting Github: `acme-landing
 * Failing` beside a repo name does not say that the CI is the thing that
 * failed, and 24 of this org's 78 tiles read that way before #578. It also
 * reports the conclusion that actually happened rather than a blanket phrase,
 * so a repo whose run wants a human reads "CI needs action".
 *
 * It takes the HEALTH and not the row, because since #571 the row does not
 * carry one. `null` there is the read still being in flight, and it is the only
 * way this slot can be unsettled.
 */
export function tileWord(health: RepoHealth | null): WordSlot {
  if (health === null) return UNSETTLED;
  const drawn = DRAWN.find((d) => d.when(health));
  if (!drawn) return QUIET;
  // Only an address the server READ (#605). Where there is none the word keeps
  // the hint it has always had, so a tile a reader cannot click reads exactly
  // as it did before any of this.
  const href = drawn.href(health);
  return {
    state: 'word',
    text: drawn.text,
    tone: drawn.tone,
    hint: drawn.hint,
    href,
  };
}

/** A repo's issue flow across the whole window — what the sparkline draws and
 *  what the number beside it reports. `active` is false for a repo where
 *  nothing opened and nothing closed, which gets a line of words instead. */
export interface RepoFlow {
  opened: number;
  closed: number;
  /** Opened minus closed: positive means the queue gained ground. */
  net: number;
  active: boolean;
}

/** The window's two counts and their difference. `net` is a FLOOR on how much
 *  the queue grew: the payload carries `state`, `createdAt` and `closedAt` and
 *  no `reopenedAt` exists anywhere in board-service, so an issue opened, closed
 *  and reopened inside the window nets zero where the queue really did keep it.
 *  The error runs one way — the queue is never doing better than this says.
 *
 *  The window is the whole ten weeks, where #660 asked for a day. The day was
 *  measured before it was rejected: across the live org it reads `0` on 45 of
 *  the 58 tiles that draw a figure on the busiest day of the fortnight to
 *  2026-08-25, and on 53 of them on a median day, against 14 for the ten-week
 *  net — a column of zeroes, which is the failure #663 records happening once
 *  already. Those counts are readings taken that day and move with the org. */
export function repoFlow(row: RepoRow): RepoFlow {
  const opened = row.weeks.reduce((sum, w) => sum + w.opened, 0);
  const closed = row.weeks.reduce((sum, w) => sum + w.closed, 0);
  return { opened, closed, net: opened - closed, active: opened + closed > 0 };
}

/**
 * What one repo's fair share of the map's open queue is (#695).
 *
 * Derived rather than typed, because a number picked to make today's map look
 * right stops being true as the map changes: it is the open queue split evenly
 * across the repos that HAVE one. Live org, read 2026-08-26: 302 open over the
 * 44 repos with a queue, so a share of 7 and ten of 87 tiles above it.
 *
 * The denominator is deliberately not all 87. Over the whole map the share is
 * 3.5 and eighteen tiles carry more than it — a fifth of the grid, which is a
 * texture rather than a signal. A repo with an empty queue is not carrying a
 * share of the work and is not part of the split.
 *
 * ROUNDED here rather than at the point of display, so the line a tile is
 * judged against and the number its hover states are the same number. Unrounded
 * they differ: at 6.86 a tile reading 7 goes heavy while its hint says its share
 * is 7, and the board contradicts itself on one hover.
 *
 * `null` where no repo on the map has a queue — there is no share to state and
 * nothing can be over it.
 */
export function queueShare(rows: RepoRow[]): number | null {
  const withQueue = rows.filter((r) => r.open > 0);
  if (withQueue.length === 0) return null;
  return Math.round(withQueue.reduce((sum, r) => sum + r.open, 0) / withQueue.length);
}

/** What a count IS, for the one thing that reads it: the tone the tile draws it
 *  in. Three readings and no fourth — a queue is empty, ordinary, or over the
 *  share the map derived. */
export type CountTone = 'empty' | 'ordinary' | 'heavy';

export function countTone(open: number, share: number | null): CountTone {
  if (open === 0) return 'empty';
  if (share !== null && open > share) return 'heavy';
  return 'ordinary';
}

/** A signed number and nothing more: `+4`, `−3`, `0`. It takes no view on which
 *  direction is the good one — the cockpit signs a count of issues CLOSED with
 *  it as well as a queue depth. The tile's claim about a queue is `queueMove`.
 *
 *  A true minus sign, not a hyphen: these figures are set in tabular numerals,
 *  where Inter widens the hyphen-minus into something that reads as a dash (the
 *  same trap the repo-name columns avoid by staying proportional). */
export function deltaLabel(net: number): string {
  if (net > 0) return `+${net}`;
  if (net < 0) return `−${Math.abs(net)}`;
  return '0';
}

/** Which way a repo's queue moved across the window, and by how much (#660).
 *  An arrow and not a sign: `+55` reads as good news to anybody not told which
 *  way the convention ran. Zero keeps no arrow — the window had no direction.
 *  U+2191 and U+2193, which Inter draws at cap height beside a tabular digit. */
export function queueMove(net: number): string {
  if (net > 0) return `↑${net}`;
  if (net < 0) return `↓${Math.abs(net)}`;
  return '0';
}

/** The same reading in words, for a reader who is not looking at it (#660).
 *  U+2191 and U+2193 are absent from NVDA's default English symbol dictionary,
 *  so `↑25` and `↓25` are both announced as "25" — the direction inverted for
 *  half the readings. This is what the tile hands a screen reader in the arrow's
 *  place (`DELTA`, repo-spark.tsx). */
export function queueMoveSpoken(net: number): string {
  if (net > 0) return `up ${net}`;
  if (net < 0) return `down ${Math.abs(net)}`;
  return 'no change';
}

/** `week` or `weeks`, for the two sentences that name the window. `flowTitle`
 *  used to pin the plural and read "over one weeks" on a one-bucket window:
 *  unreachable while `rollUpRepos` pads to ten, which `RepoRow['weeks']` — a
 *  plain array — does not promise. */
function weeksWord(n: number): string {
  return n === 1 ? 'week' : 'weeks';
}

const CHANGE = '↑↓ change in open issues';

/**
 * What the figure beside a chart IS — said ONCE for the whole grid (#660).
 *
 * Three facts: the quantity, the window, and that it is a CHANGE. `acme`
 * opened 404 issues across this window and closed 350 (read 2026-08-25), so a
 * reader taking `↑54` for "54 opened in ten weeks" is wrong by 350 — "change
 * in" forecloses that.
 *
 * `null` only where no row given has issue activity to draw a figure for;
 * quiet rows still draw a zero spark. Rows
 * that DO draw one but disagree about the window cost the window and nothing
 * else — `RepoRow['weeks']` is a plain array, so `rollUpRepos` padding every
 * row to ten is checked here rather than assumed, and a disagreement must not
 * take the net-change words off a screen still drawing figures.
 *
 * Digits here and spelled in `flowTitle`, this being a label in the register the
 * page's own quiet meta uses — `12 of 85`, one line up.
 */
export function flowLegend(rows: RepoRow[]): string | null {
  const drawn = rows.filter((row) => repoFlow(row).active);
  if (drawn.length === 0) return null;
  const n = drawn[0].weeks.length;
  return drawn.some((row) => row.weeks.length !== n) ? CHANGE : `${CHANGE} over ${n} ${weeksWord(n)}`;
}

/** The two counts the figure is the difference of, which is what its own hover
 *  adds (#660). Short on purpose: carrying `flowLegend`'s sentence as well took
 *  the box to two lines, and two lines under a figure at the tile's right edge
 *  reach onto the next tile (`DELTA_SIDE` in repo-spark.tsx measures it). */
export function deltaHint(row: RepoRow): string {
  const flow = repoFlow(row);
  return `${flow.opened} opened, ${flow.closed} closed`;
}

/** The sparkline's own accessible name — the hint on the figure beside it, plus
 *  the window, which a screen reader has no legend to read. */
export function flowTitle(row: RepoRow): string {
  const n = row.weeks.length;
  return `${deltaHint(row)} over ${spell(n)} ${weeksWord(n)}`;
}

/**
 * What one week of the sparkline says when it is pointed at (#576, reworded
 * #694, put in the board's one chart grammar in #708).
 *
 * A sentence, not three fields joined by a middot.
 *
 * THE WEEK LEADS, and it did not until #708. #694 put the counts first, on the
 * argument that which week it is only means something once you know what
 * happened in it. Two things overturned that. The other three charts that
 * answer a pointer all lead with WHEN, so a reader crossing from one to another
 * met the same reading in four shapes — which is the drift #708 exists to end.
 * And this sentence is a BUTTON'S ACCESSIBLE NAME: a reader arrowing along ten
 * columns hears every one of them start with a number, and has to hear the
 * whole sentence out to learn which column they are on. The differentiating
 * token belongs at the front. The grammar is written down once, in
 * `docs/charts-answer-when-pointed-at.md`.
 *
 * CLOSED BEFORE OPENED for the same reason it is that way on the other three:
 * closed is the hero series on every one of these charts — the brand line, the
 * one the mark's dot sits on — so it is the number the reading leads with.
 *
 * The buckets are anonymous — the payload carries ten rolling weeks and no
 * timestamps — so the week is named by counting back from the last bucket
 * rather than by a date, which there is nothing here to derive. A quiet week
 * still reports its zeroes: the pointer is on it, and "nothing that week" is
 * the answer to the question being asked.
 *
 * An index outside the window reads as the nearest week rather than throwing:
 * the caller maps a pointer position onto a column, and a rounding error at
 * either edge must not blank a hint mid-hover.
 */
export function weekHint(row: RepoRow, index: number): string {
  const last = row.weeks.length - 1;
  const i = Math.min(Math.max(index, 0), last);
  const week = row.weeks[i];
  const back = last - i;
  // "and", not a second comma: this chart reports a PAIR, and `this week, 5
  // closed, 2 opened` would use one mark for two jobs. `trend-chart.ts`'s
  // `weekTipText` carries the argument and reads identically — the two are the
  // same sentence on two charts, which is the whole point of the grammar.
  const flow = `${week.closed} closed and ${week.opened} opened`;
  const when = back === 0 ? 'this week' : `${back} week${back === 1 ? '' : 's'} ago`;
  return `${when}, ${flow}`;
}

/** A repo Github has never taken a push for. It has no age, and it must not be
 *  given one: zero days would read "pushed today" on a repo with nothing in it.
 *
 *  Only for `pushedAt: null`, which is Github answering. A field that is absent
 *  or unreadable is the payload NOT answering, and it takes no sentence at all
 *  — see `pushAge`. */
const NEVER_PUSHED = 'never pushed to';

const DAY_MS = 86_400_000;

/** Where the count changes unit, in days. Both turns are chosen so the two
 *  readings on either side are the same age said two ways — six days and one
 *  week, eight weeks and two months — rather than a jump a reader has to
 *  reconcile. */
const WEEKS_FROM = 7;
const MONTHS_FROM = 60;

/** `4 days`, `1 week` — the unit agreeing at one, which is the whole of what
 *  these three tiers differ in. */
function units(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/**
 * How recently the repo was pushed to, for the tile that has no chart to draw
 * (#572).
 *
 * This line replaced `no issue activity`, and the replacement is the point. The
 * 22 repos with an all-zero window got that sentence, and 21 of them had been
 * pushed to inside the window — so the map said "nothing here" on a repo that
 * shipped this morning. Issue flow is not liveness, and the push is.
 *
 * `now` is the caller's, not the clock's: a derivation that read `Date.now()`
 * itself could be tested only against the day the test ran.
 *
 * A push in the future — a repo whose host clock ran ahead of ours — reads as
 * today rather than as a negative count.
 *
 * Two silences, and they are not the same silence. `pushedAt: null` is Github
 * saying there has never been a push, which is a fact and gets a sentence. A
 * field that is ABSENT, or holds something no clock can read, is the payload
 * failing to answer — board-web routinely ships ahead of board-api, and while
 * it does every row arrives without the field. Given one sentence for both,
 * all 22 quiet tiles asserted "never pushed to" about repos pushed to this
 * week, which is a louder falsehood than the `no issue activity` this line
 * replaced. So an unanswered payload returns nothing and the tile draws
 * nothing: silence is the only honest thing a page can say about a fact it was
 * not sent.
 */
export function pushAge(row: RepoRow, now: number): string | null {
  if (row.pushedAt === null) return NEVER_PUSHED;
  const at = pushedMs(row);
  if (at === null) return null;
  const days = Math.max(0, Math.floor((now - at) / DAY_MS));
  if (days === 0) return 'pushed today';
  if (days < WEEKS_FROM) return `pushed ${units(days, 'day')}`;
  if (days < MONTHS_FROM) return `pushed ${units(Math.floor(days / 7), 'week')}`;
  return `pushed ${units(Math.floor(days / 30), 'month')}`;
}

/** The open count with its unit, agreeing at one. */
function openIssues(open: number): string {
  return `${open} open ${open === 1 ? 'issue' : 'issues'}`;
}

/**
 * The tile's accessible name — and, since #695, the only place the map's third
 * reading exists for someone who cannot see it.
 *
 * #695 gave the count three tones. A tone reaches a sighted reader sweeping the
 * grid and reaches nobody else: the tile's own hover carries the derivation,
 * but its trigger is a bare non-focusable span, so it opens on a pointer and a
 * keyboard never gets there. Without the clause here, a repo the map set loud
 * and one it left ordinary have identical accessible names, and the reading the
 * issue asked for is available only to a viewer who can see colour.
 *
 * Kept to the same rule the hint follows — the clause belongs to the heavy
 * tiles alone. Said on all 87 it would stop being a mark of difference, which
 * is the whole of what it is for. Shorter than the hint's, because a hover is
 * read once on purpose and a name is read on every arrow key: the number the
 * share IS lives in the hint, and this says only that the tile is over it.
 */
export function tileLabel(row: RepoRow, share: number | null): string {
  const label = `${row.name}, ${openIssues(row.open)}`;
  if (share === null || countTone(row.open, share) !== 'heavy') return label;
  return `${label}, more than its share`;
}

/**
 * The hint on the tile's 19px number (#573, widened #695), which is otherwise a
 * bare figure with no unit.
 *
 * The count, and — on the tiles the map set louder than the rest — the line it
 * is louder than. #695 required "more than its share" to be findable rather
 * than felt, and this is where a reader finds it: the number the tile was
 * judged against, stated on the tile that was judged.
 *
 * It carried a second sentence until #607 — a gloss on the warning left edge,
 * hung here because the edge itself answered no hover — and that went with the
 * edge. Whether a queue is losing ground is still the sparkline's to say, on
 * every tile, drawn rather than described.
 *
 * A label and not a sentence, so no full stop: a bare "72 open issues", and the
 * heavy case extends the label with a clause rather than starting a second one.
 */
export function openHint(row: RepoRow, share: number | null): string {
  const label = openIssues(row.open);
  if (share === null || countTone(row.open, share) !== 'heavy') return label;
  return `${label} — more than its share, which on this map is ${share}`;
}

/** The repo name's hint: its description, and nothing where there is none — a
 *  tooltip repeating the name already on screen is a hover spent for nothing. */
export function nameHint(row: RepoRow): string | null {
  const description = row.description?.trim();
  return description ? description : null;
}

// ── the owner control ───────────────────────────────────────────────────────

/** The resting affordance on a repo the org records no owner for. */
export const SET_OWNER = 'Set owner';
/** The resting words on a repo whose ORG has no `dri` property at all (#649).
 *  "Set owner" would name an action nothing can perform here, and would read
 *  exactly like a repo somebody simply has not got round to owning yet — two
 *  different sentences that must not print the same. Three words, because the
 *  slot they land in is the one "Set owner" already fits (`ownerShortName` has
 *  that budget) and this is the longest thing that stays inside it. */
export const NO_OWNER_FIELD = 'No owner field';
/** Why that label is there, on hover. The slot has room for the short form
 *  only, and three words on their own do not say whose limitation this is —
 *  the org's, not this repo's and not the reader's. */
export const NO_OWNER_FIELD_HINT = 'This org has no owner field on GitHub';
/** Its twin on a repo owned by a person rather than an org (#979). It said
 *  "Repository dri is not applicable to personal owners", which names the
 *  org property GitHub stores this in — a field name is not a thing on the
 *  reader's screen. Same shape as the sentence above it, because it is the
 *  same fact about a different owner. */
export const PERSONAL_OWNER_HINT = 'A personal account has no owner field on GitHub';
/** The resting words on a repo whose org's OWNERSHIP read failed (#718).
 *
 *  Not "Set owner", which says the org records no owner for this repo — a fact,
 *  and a different one. Both draw no name, and a slot that prints the same
 *  three words for each of them tells a reader "nobody owns this" over an
 *  outage. Same budget as `NO_OWNER_FIELD`, which shares this slot. */
export const OWNER_UNREAD = 'Owner not read';
/** Why those words are there, on hover — and the register is deliberate: this
 *  is the sentence `repo-page-vm.ts` already writes for a read that failed on
 *  this surface ("Pull requests couldn’t be read just now."). `just now` is the
 *  load-bearing half: this is a moment, not a property of the repo. */
export const OWNER_UNREAD_HINT = 'The owner couldn’t be read just now.';
/** The tile's word where the org's three ALERT lists refused (#718). The four
 *  counts beside it are zeros that were never measured, and a tile that draws
 *  them as one is a clean bill of health for a repo nobody looked at. */
export const ALERTS_UNREAD = 'Alerts not read';
/** Its hover, in the same register as `OWNER_UNREAD_HINT`. */
export const ALERTS_UNREAD_HINT = 'Security alerts couldn’t be read just now.';

/** Was this repo's OWNER read at all (#718)? Taken only where there is no owner
 *  to draw: a name the board holds is a name it holds, whatever the last read
 *  did with it. */
export function ownerUnread(row: RepoRow, owner: RepoOwner | null = row.owner): boolean {
  return !owner && row.ownerState === 'unreadable';
}

/** Were this repo's ALERTS read at all (#718)? `null` is the health read still
 *  in flight, which is a third answer and not this one. */
export function alertsUnread(health: RepoHealth | null): boolean {
  return health !== null && health.security.state === 'unreadable';
}

/** The menu row that clears the property. */
export const NO_OWNER = 'No owner';
/** The menu's section label — the property's own name, sentence case, so it is
 *  plain what is being written. */
export const OWNER_LABEL = 'Owner';

/** An owner's full name: the person the login resolves to, falling back to the
 *  login itself when it maps to nobody on the team. Used where there is room for
 *  it — the picker's rows, the control's accessible name. */
export function ownerName(owner: RepoOwner | null): string {
  if (!owner) return SET_OWNER;
  return owner.name ?? owner.login;
}

/**
 * How an owner reads ON A TILE: the first name alone.
 *
 * The footer is one line on a tile the grid makes 237px wide at 1280 (274 at
 * 1440), shared with the drawn word wherever the repo has one — and that word
 * takes up to 89px of it, on 33 of the 78 live tiles. What is left for the name
 * is 91–180px at 1280, 128–217 at 1440.
 *
 * That is more room than this note used to describe, and #578 is why: the three
 * pips it removed sat in this same footer, and what they held came here.
 * Re-measured on the 78 live tiles since, a FULL name would now fit on all 29
 * owned ones — "Anton Khovanskiy", the longest at 98px, against a tightest
 * 127px at 1280 among the tiles he owns. The first name stays anyway, because
 * that fit is a coincidence of who owns which tile: the tightest footer on the
 * map leaves 91px, under those 98, and any tile is one failing run away from
 * drawing a word
 * and losing up to 89px. A first name asks 23–32px and is cut at no width; a
 * full name would be, the first time the two lined up. Around here first names
 * identify a person unambiguously (the org has three members), and the full name
 * is still one hover away on the control's accessible name.
 *
 * "Set owner" asks 55px and fits everywhere: 0 of the 49 unset tiles cut it at
 * 420, 768, 1024, 1280 or 1440, which is why that slot carries no `title` (see
 * `OwnerValue`). The figure this note carried before — cut on 25 — was measured
 * with the pips still in the footer, and reproduces at no width now they are
 * gone.
 *
 * `NO_OWNER_FIELD` takes that same slot on an org with no `dri` property, and
 * it is NOT measured: the fleet has no such org to measure on. It is five
 * characters longer than "Set owner", so at the 11.5px this line is set in it
 * asks roughly 80px against a floor of 91 — inside the budget, but by less than
 * the measured label is. If an org like that ever appears, measure it there
 * before trusting this paragraph.
 *
 * A login with no resolved person keeps its whole handle: half a Github login
 * identifies nobody.
 */
export function ownerShortName(
  owner: RepoOwner | null,
  writability?: OwnerWritability,
  unread = false,
): string {
  // The unread state goes first: an org with no `dri` property and an org whose
  // `dri` read failed are both reachable at once, and only one of them is
  // something the board KNOWS. Claiming the field is absent on a read that
  // never landed is #577 inverted (#718).
  if (writability === 'not-applicable') return 'Not applicable';
  if (!owner && unread) return OWNER_UNREAD;
  if (!owner) return writability === 'absent' ? NO_OWNER_FIELD : SET_OWNER;
  if (!owner.name) return owner.login;
  return owner.name.split(' ')[0];
}

/** The hover behind the resting slot where there is no control to explain
 *  itself. Only the org-has-no-field case earns one: every other unowned repo
 *  either offers a picker (which carries `ownerHint`) or is unowned in the
 *  ordinary way, and a tooltip restating "Set owner" is a hover spent for
 *  nothing. `null` means draw no hint. */
export function ownerRestHint(
  owner: RepoOwner | null,
  writability?: OwnerWritability,
  unread = false,
): string | null {
  // Said in the page's own word for the field (#979), out of the constant
  // declared beside `NO_OWNER_FIELD_HINT` — the other hint about a field that
  // is not there.
  if (writability === 'not-applicable') return PERSONAL_OWNER_HINT;
  if (!owner && unread) return OWNER_UNREAD_HINT;
  return !owner && writability === 'absent' ? NO_OWNER_FIELD_HINT : null;
}

/**
 * Is the owner control offered at all, given what the server said about the
 * org's `dri` property (#649)? The one place that question is answered, so the
 * page, the tile and the picker cannot drift apart on it.
 *
 * Two writabilities take the control away, and both are permanent: `restricted`
 * is Github's own refusal, and `absent` is an org whose schema holds no `dri`
 * property to write. Drawing a control for either means drawing something whose
 * only possible ending is a refusal — and a refusal with a good message is
 * still a control that was offered and pressed.
 *
 * `unreadable` and `unknown` KEEP it. Neither has learned that the write is
 * impossible: `unreadable` is a fact about this board's token, not about the
 * org, and may be one bad minute; `unknown` is a setting we do not recognise on
 * a schema that read fine, so the allowed values are real. Withholding a
 * control on either is #577 inverted — a map that goes quietly uneditable and
 * says nothing.
 *
 * `undefined` keeps it too. It gets there by the same two comparisons the named
 * states go through — there is no branch for it, and deliberately so — and what
 * is decided here is that this is the right answer to leave it with, not merely
 * what `undefined` happens to do. board-web ships ahead of board-api, and across
 * that deploy window the field is simply not on the response; the behaviour to
 * fall back to is the one the page had before the field existed — offer the
 * control, and let a refused write say so out loud. The spec asserts it
 * directly, so the decision survives anyone tidying this into a truthiness
 * test.
 */
export function ownerControlOffered(writability: OwnerWritability | undefined): boolean {
  return writability !== 'not-applicable' && writability !== 'restricted' && writability !== 'absent';
}

/** The owner control's accessible name — which repo it writes, and its value. */
export function ownerAria(row: RepoRow, owner: RepoOwner | null): string {
  // Three states, not two (#718). `unset` is the org recording no owner; a
  // read that failed knows nothing about that, and a screen reader must get the
  // same distinction the eye gets off `OWNER_UNREAD`.
  const state = owner ? `: ${ownerName(owner)}` : ownerUnread(row, owner) ? ', not read' : ', unset';
  return `Owner of ${row.name}${state}. Click to change.`;
}

/** What pressing the owner control does. The page used to say this in a
 *  footnote under the grid, which explained the surface's implementation to
 *  somebody who came here to find a repo (#574); it belongs on the control. */
const OWNER_WRITES = 'Picking a name here writes it on GitHub';

/**
 * The owner control's hover hint (#573): the FULL name — the tile has room for
 * a first name only — and what pressing it does.
 *
 * Not the same sentence as `ownerAria`, and deliberately so. The accessible name
 * addresses somebody who cannot see which tile they are on, so it repeats the
 * repo; a hover already has the tile under the pointer and spends its words on
 * the two things the tile does not print.
 *
 * It says what the name IS, not only who: the tile's footer prints a first name
 * and, beside it, the drawn word where there is one — nothing there calls that
 * name ownership, so a hint opening on a bare person announces somebody with no
 * role.
 */
export function ownerHint(owner: RepoOwner | null, unread = false): string {
  if (owner) return `${ownerName(owner)} owns this repo. ${OWNER_WRITES}`;
  // An unread owner KEEPS the control (#718): the read that failed was the
  // read, and a write can still land — so the hover says both halves rather
  // than leaving a reader to guess which of the two it is looking at.
  return unread ? `${OWNER_UNREAD_HINT} ${OWNER_WRITES}` : OWNER_WRITES;
}

/** One row of the picker. `login: null` is the row that clears the property. */
export interface OwnerOption {
  login: string | null;
  label: string;
}

/** The picker's rows: the `dri` property's own allowed values, resolved to
 *  names, plus the row that clears it. Nothing else can appear here — a login
 *  outside the schema is one Github would refuse. */
export function ownerOptions(driOptions: string[], nameOf: (login: string) => string | null): OwnerOption[] {
  return [
    ...driOptions.map((login) => ({ login, label: nameOf(login) ?? login })),
    { login: null, label: NO_OWNER },
  ];
}

/**
 * The logins ONE repo's picker may offer: its own org's allowed values (#728).
 *
 * `view.driOptions` is not that list on the union view. It is every served
 * org's values concatenated (#614, #697, #718), while the write gate compares
 * against ONE org's — so on two orgs with different rosters the menu offers a
 * login the write then refuses and the press 400s. That is a control offered
 * and then refused, which is what #635 and #653 exist to stop. Nothing here
 * widens what may be WRITTEN: the gate stays per-org and is still what decides;
 * this makes the offer match it.
 *
 * The lookup is case-insensitive on purpose. `driOptionsByOrg` is keyed by the
 * org as it is CONFIGURED and `RepoRow.full` carries Github's own spelling of
 * it, and the two differ by case on a routine deployment — a difference that
 * must not silently empty a picker.
 *
 * Two absences fall back to `driOptions`, which is what this page offered
 * before the field existed:
 *
 *   · no map at all — a board-api that predates it, across the window board-web
 *     ships ahead in;
 *   · a map with no entry for this org — the org was not described here, so
 *     there is no exact list to prefer.
 *
 * An org that IS described and carries `[]` keeps its empty list, and
 * `OwnerPicker`'s own gate then withholds the control for that repo alone.
 * Falling back there would offer the neighbour's roster to an org that has just
 * said it has none.
 */
export function driOptionsFor(view: ReposView, row: RepoRow): string[] {
  const byOrg = view.driOptionsByOrg;
  if (!byOrg) return view.driOptions;
  const org = repoRef(row).owner.toLowerCase();
  const found = Object.entries(byOrg).find(([configured]) => configured.toLowerCase() === org);
  return found ? found[1] : view.driOptions;
}

// ── the owner row ───────────────────────────────────────────────────────────

/** One face on the controls row: an owner the map records, or — where `login`
 *  is null — the repos the org records no owner for. */
export interface OwnerSlot {
  login: string | null;
  /** The person's full name, their bare handle where it resolves to nobody, or
   *  `NO_OWNER` for the slot that stands for nobody. */
  name: string;
  /** Repos behind this face, over the whole map. */
  count: number;
}

/**
 * Every owner the map actually records, and the repos nobody owns.
 *
 * Derived from the ROWS rather than from `driOptions`, which is a different
 * question: the schema says who a repo MAY be given to, and a face standing for
 * a person who owns nothing today is a control that narrows to an empty map.
 * Reading the rows is also what keeps the row right when the org changes — three
 * people and 10 unowned repos today, and nothing here is written down.
 *
 * Ordered by weight, ties by name. Weight because the row reads the way the
 * grid does, loudest first; the name because a tie left to the payload's own
 * sequence would shuffle the faces between loads, and a control that moves is a
 * control you have to find again.
 *
 * The nobody slot goes last and only where there is one. It is not a person, so
 * it does not compete for a place among them; and a slot standing for no repos
 * would be filler invented to make the row look complete.
 */
export function ownerSlots(tiles: RepoTile[]): OwnerSlot[] {
  const people = new Map<string, OwnerSlot>();
  let unowned = 0;
  for (const { row } of tiles) {
    // A repo whose ownership read failed is behind no face at all (#718). This
    // slot stands for the repos the org RECORDS no owner for, which is a fact
    // about the org; counting an unread repo into it makes that claim about a
    // repo nobody asked about, and `ownedBy` above keeps the grid in step.
    if (ownerUnread(row)) continue;
    if (!row.owner) {
      unowned += 1;
      continue;
    }
    const seen = people.get(row.owner.login);
    if (seen) seen.count += 1;
    else people.set(row.owner.login, { login: row.owner.login, name: ownerName(row.owner), count: 1 });
  }
  const slots = [...people.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  if (unowned > 0) slots.push({ login: null, name: NO_OWNER, count: unowned });
  return slots;
}

/** The slot a chosen owner names, or nothing at all. `undefined` is nobody
 *  chosen; a login the map has no repos for — a link written when that person
 *  still owned one, or a typo — narrows nothing rather than emptying the grid,
 *  the same rule `orderByKey` keeps for an order that never shipped. */
export function ownerSlotFor(slots: OwnerSlot[], chosen: string | null | undefined): OwnerSlot | null {
  if (chosen === undefined) return null;
  return slots.find((s) => s.login === chosen) ?? null;
}

/** The count with its unit, agreeing at one. */
function repoCount(n: number): string {
  return `${n} repo${n === 1 ? '' : 's'}`;
}

/**
 * What one face narrows to — the slot's whole accessible name, and its hint.
 *
 * The same sentence in both places, which is unusual on this page and is the
 * point: a face says neither whose it is nor how many repos are behind it, so a
 * reader who cannot see it and a reader who can are asking the identical
 * question. The tile's owner control splits the two because the tile already
 * prints a name.
 *
 * The nobody slot keeps the struck-out chip's own words for itself, so the one
 * narrowing #583 replaced rather than removed still reads the way it read.
 */
export function ownerSlotHint(slot: OwnerSlot): string {
  if (slot.login === null) return `${repoCount(slot.count)} with nobody recorded as owner`;
  return `${slot.name} owns ${repoCount(slot.count)}`;
}

/** The org and repo a write addresses, off the canonical key — so the write
 *  always lands on the org the map was built from. */
export function repoRef(row: RepoRow): { owner: string; repo: string } {
  const [owner, ...rest] = row.full.split('/');
  return { owner, repo: rest.join('/') };
}

// ── nothing matched ─────────────────────────────────────────────────────────

/** The empty state names the query, so it is obvious what found nothing — and
 *  says so plainly when it was the chosen owner, not a word, that emptied the
 *  map. */
export function noMatchTitle(query: string): string {
  const q = query.trim();
  return q ? `No repo matches “${q}”` : 'No repo matches this filter';
}

export const NO_MATCH_BODY =
  'Search covers the repo name and its description. Try a shorter word, or clear the filter above.';

// ── numbers in words ─────────────────────────────────────────────────────────
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** Small counts read better spelled out in prose; past ten, digits. */
export function spell(n: number): string {
  return n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
}

/** Health filters only match observed problems; unavailable observations stay explicit. */
export type RepoHealthFilter = 'all' | 'ci' | 'security' | 'secrets' | 'dependencies' | 'code-scanning';
export function healthMatch(tile: RepoTile, filter: RepoHealthFilter): 'match' | 'clear' | 'unknown' {
  if (filter === 'all') return 'match';
  if (!tile.health) return 'unknown';
  if (filter === 'ci') {
    const ci = tile.health.ci;
    if (ci === null) return 'unknown';
    return ['failure', 'timed_out', 'action_required'].includes(ci) ? 'match' : 'clear';
  }
  const security = tile.health.security;
  if (filter !== 'security') {
    const count = filter === 'secrets' ? security.secrets : filter === 'dependencies'
      ? security.depHigh + security.depModerate : security.codeScanning;
    return count > 0 ? 'match' : security.state === 'unreadable' || security.state === 'not-applicable' ? 'unknown' : 'clear';
  }
  const level = securityLevel(security);
  return level === 'unread' ? 'unknown' : level === 'clean' ? 'clear' : 'match';
}

export function healthFilterNotice(tiles: RepoTile[], filter: RepoHealthFilter): string | null {
  if (filter === 'all') return null;
  const unknown = tiles.filter(t => healthMatch(t, filter) === 'unknown'
    && !(filter !== 'ci' && t.health?.security.state === 'not-applicable')).length;
  return unknown ? `${filter === 'ci' ? 'CI results' : 'Security results'} couldn’t be read for ${unknown} ${unknown === 1 ? 'repository' : 'repositories'}, so this filter leaves ${unknown === 1 ? 'it' : 'them'} out.` : null;
}

/** Count regular nouns consistently across repository cards and charts. */
export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export const CLEAR_HEALTH_FILTER = 'Clear health filter';

export function problemBadges(tiles: RepoTile[]): { key: RepoHealthFilter; label: string; hint: string }[] {
  let secrets = 0;
  let dependencies = 0;
  let codeScanning = 0;
  let ci = 0;
  for (const tile of tiles) {
    if (healthMatch(tile, 'ci') === 'match') ci++;
    if (!tile.health) continue;
    secrets += tile.health.security.secrets;
    dependencies += tile.health.security.depHigh + tile.health.security.depModerate;
    codeScanning += tile.health.security.codeScanning;
  }
  const alertsHint = 'Open alerts in repositories matching your search and owner. Select to show affected repositories.';
  return [
    { key: 'secrets' as const, count: secrets, label: plural(secrets, 'leaked secret'), hint: alertsHint },
    { key: 'dependencies' as const, count: dependencies, label: `${dependencies} vulnerable ${dependencies === 1 ? 'dependency' : 'dependencies'}`, hint: alertsHint },
    { key: 'code-scanning' as const, count: codeScanning, label: plural(codeScanning, 'code scanning alert'), hint: alertsHint },
    { key: 'ci' as const, count: ci, label: `${ci} failing CI`, hint: 'Repositories with failing CI matching your search and owner. Select to show them.' },
  ].filter(problem => problem.count > 0);
}

export const REPO_LENSES = [
  { key: 'issues', label: 'Issues' },
  { key: 'prs', label: 'PRs' },
  { key: 'ci-cost', label: 'CI cost' },
  { key: 'security', label: 'Security issues' },
] as const;
export type RepoLens = typeof REPO_LENSES[number]['key'];
export interface RepoMetric {
  lens: RepoLens;
  value: number | null;
  label: string;
  hint: string;
  series: (number | null)[];
  missing?: string;
}
export interface RepoLensData {
  ciSpend?: import('../api/repos').RepoCiSpend;
  pullRequests?: import('../api/repos').RepoPrFlow;
}
export const usd = (value: number): string => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(value);

export function repoMetric(tile: RepoTile, lens: RepoLens, data?: RepoLensData): RepoMetric {
  const missing = (reason = 'Unavailable'): RepoMetric => ({ lens, value: null, label: reason,
    hint: `${REPO_LENSES.find(item => item.key === lens)!.label}: ${reason.toLowerCase()}`,
    series: [], missing: reason });
  if (lens === 'issues') {
    if (tile.row.openIssuesState === 'unreadable') return missing();
    return { lens, value: tile.row.open, label: String(tile.row.open), hint: plural(tile.row.open, 'open issue'), series: [] };
  }
  if (lens === 'ci-cost') {
    const spend = data?.ciSpend;
    if (spend?.state !== 'read' || !spend.weeks.length) return missing();
    const last = spend.weeks[spend.weeks.length - 1];
    return { lens, value: last.netUsd, label: usd(last.netUsd),
      hint: `${usd(last.netUsd)} net billed USD in the trailing 7 days${last.minutes === 0 ? '; nothing ran' : ''}`,
      series: spend.weeks.map(week => week.netUsd) };
  }
  if (lens === 'prs') {
    const prs = data?.pullRequests;
    if (prs?.state !== 'read') return missing();
    return { lens, value: prs.open, label: String(prs.open), hint: plural(prs.open, 'open PR'),
      series: prs.weeks.map(week => week?.opened ?? null) };
  }
  const security = tile.health?.security;
  if (security?.state === 'not-applicable') return missing('Not applicable');
  if (!security || security.state === 'unreadable') return missing();
  const value = security.depHigh + security.depModerate + security.codeScanning + security.secrets;
  return { lens, value, label: String(value), hint: plural(value, 'open security alert'), series: [] };
}

/** Unknown figures follow measured values, including measured zero. */
export function applyRepoLens(tiles: RepoTile[], lens: RepoLens, data?: ReadonlyMap<string, RepoLensData>): RepoTile[] {
  return tiles.map(tile => ({ ...tile, metric: repoMetric(tile, lens, data?.get(tile.row.full)) }))
    .sort((a, b) => {
      const x = a.metric.value, y = b.metric.value;
      return (x === null ? (y === null ? 0 : 1) : y === null ? -1 : y - x)
        || a.row.name.localeCompare(b.row.name);
    });
}
