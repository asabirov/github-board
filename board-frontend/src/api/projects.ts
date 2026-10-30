import { API, ApiError, networkFetch as apiFetch, joinRead, scopeQuery, retryAt, overviewNetworkFetch, serverCode, serverMessage } from './core';
import type { IssueLabel, PersonalIssueType } from './types';
import type { CloseReason } from '../close-reason';

export type { ProjectContribution } from './types';

// ─── Projects: read-only mirror of the org's GitHub Projects (v2) boards ─────
export type ProjectStatus = 'active' | 'in-progress' | 'just-started' | 'stalled';

/** The last issue closed on a board — the pick the rollup card's recency line
 *  drew (#488). #785 deleted that card and no surface draws this today; the API
 *  still picks it, on the rule README states. */
export interface LastClosed {
  repo: string;
  number: number;
  title: string;
  url: string;
  by: string | null;
  atISO: string;
}

/** A board in the `GET /api/projects` list: counts, completion, last-closed.
 *  Named for the rollup that consumed it, which #785 deleted — Your work's
 *  Contributions rings and the Projects block read it now. */
/** One run of the segmented completion ring (#454) — a slice of the board's
 *  closed count and whose it is. `person` carries a Github login; `others`
 *  folds everyone past the server's cap (`people` = how many); `unattributed`
 *  holds the closes with no member behind them (bots, deleted accounts, an
 *  unassigned issue). The `closed` values sum to the board's `closed`. */
export interface ProjectContributor {
  login: string;
  closed: number;
  kind: 'person' | 'others' | 'unattributed';
  people?: number;
}

export interface ProjectSummary {
  /**
   * The Github org this board was read from (#697) — with `number`, the board's
   * whole address. A Projects v2 number is unique only WITHIN an org, and
   * `/api/projects` is a union across every configured org, so two boards in the
   * list can both be `number: 3` and be two different boards.
   *
   * Optional for the reason `excludedItems` below is, and it is the same reason
   * here: board-web ships before board-api, so across a deploy window this
   * surface reads a board-api that predates the field. Absent means the board
   * did not say, and every reader falls back to what it did before #697 — the
   * unqualified `/projects/:number`, which resolves the first org holding the
   * number, exactly as the API does. That is today's behaviour, so a single-org
   * deployment cannot tell the two apart either way.
   */
  org?: string;
  number: number;
  name: string;
  url: string;
  status: ProjectStatus;
  open: number;
  closed: number;
  /** Completion = closed / (open + closed), 0–100. */
  pct: number;
  /** How many of the board's items every count above leaves out (#517) — a
   *  board holds pull requests and drafts as well as issues, and this surface
   *  counts issues only. 0 on every board we run today. Optional so board-web
   *  tolerates a board-api that predates the field. The rollup card was its one
   *  reader, and #785 deleted the card: nothing on the frontend reads this. */
  excludedItems?: number;
  lastClosed: LastClosed | null;
  /** Closes per week, oldest → newest, last = the current week. It drew the
   *  rollup's faint 10-week mini-trend (#391), which #785 deleted with the card;
   *  `closedThisWeek` below, its last entry, is the half still drawn. Optional so
   *  board-web tolerates a board-api that predates the field (→ treated as no
   *  trend), and served present-and-EMPTY by a current board-api that took the
   *  five joined figures off this payload: a board read short (#715), an org-wide
   *  join that did not run (#722), the last-good copy #713 serves, or a cause
   *  board-api grew after this file was written (#792). Ten zeros under any of
   *  those would draw a flat quarter on a board nobody read the end of, on an org
   *  whose issues nobody could read at all, or on a copy from before the last
   *  write.
   *
   *  An empty array is not by itself evidence of any of that, and a reader that
   *  gates on its length is wrong about the quietest boards in the list. When the
   *  org-wide join derives nothing but zeros the service falls back to whatever
   *  the source seeded (`readRollup`, board-service/src/projects/projects.service.ts:598),
   *  and the live source seeds this field empty (github-projects.source.ts:817) —
   *  so a board read whole, joined and simply quiet arrives here as `[]` beside a
   *  `closedThisWeek` of 0. `joinedFiguresWithheld` is what says the five figures
   *  were taken off; this array's length says nothing.
   *
   *  Four withheld cases, not three, and since #792 it takes four fields to tell
   *  them apart: `itemsComplete`, `pulseJoined` and `lastGoodCopy` each name a
   *  cause, and `joinedFiguresWithheld` covers the one this bundle has no name
   *  for. A retiree carries `itemsComplete: true` AND `pulseJoined: true` — both
   *  reads went fine for the copy being served — so neither of the two this line
   *  used to name discriminates it, and `lastGoodCopy` is the one that does. */
  weeklyClosed?: number[];
  /** Closes in the trailing 7 days — the pulse headline (#391). The last entry
   *  of `weeklyClosed`.
   *
   *  Absent means one of five things, and none of them is 0 (#715, #722, #713,
   *  #792). A board-api that predates the field never said. A current one
   *  WITHHOLDS the figure from a board whose item read came up short — the same
   *  gate that withholds the two day series, because the count is derived from
   *  the same partial read, and the items a short read loses are the newest,
   *  which is most of a week bucket. It withholds it again when the org-wide join
   *  behind the figure did not run at all, which takes every board in the org
   *  together. Again on the last-good copy #713 serves, whose buckets are anchored
   *  to the clock of a read the service no longer has. And again for any cause
   *  board-api grows after this file was written, which is the one this bundle
   *  cannot name.
   *
   *  It takes four fields to tell those apart, and since #792 no three of them
   *  will do. `itemsComplete`, `pulseJoined` and `lastGoodCopy` each NAME a cause;
   *  `joinedFiguresWithheld` says the figure is gone whichever cause took it,
   *  including the ones added after this file. A retiree carries
   *  `itemsComplete: true` and `pulseJoined: true` — it was read whole, and the
   *  join ran for the copy being served — so the two fields this line used to name
   *  are both true of it and neither tells it from a quiet week.
   *
   *  So a reader must not coalesce this: `?? 0` renders as "Nothing opened or
   *  closed this week", a claim about the board where the truth is that nobody
   *  can say.
   *  `weeklyClosedLine` in projects/ProjectBlock.tsx is where the cases are
   *  separated, and `blockRowOf` beside it is how a row gets built without
   *  re-introducing the coalesce. */
  closedThisWeek?: number;
  /** Opens over the same trailing 7 days `closedThisWeek` counts its closes
   *  over (#851) — the second half of the card's week line.
   *
   *  board-api derives it from the trailing seven buckets of `dailyOpened`, off
   *  the one join and the one clock reading `closedThisWeek` comes from, so the
   *  two figures cover one interval rather than two nearly-equal ones.
   *
   *  Optional on exactly the terms above and withheld by the same three causes
   *  through the same function, so the two arrive together or not at all — and
   *  `weeklyClosedLine` reads both through one gate rather than deciding
   *  separately about each. Absent is also a board-api predating the field,
   *  which reads as 0 opened beside whatever week count it did send. */
  openedThisWeek?: number;
  /** Issues opened per day on this board, 14 buckets, oldest → newest, the last
   *  one the trailing 24h — the rollup card's pulse (#663), deleted with the
   *  card in #785. Optional across the deploy window, exactly like the two
   *  above; no frontend surface reads it today. */
  dailyOpened?: number[];
  /** Issues closed per day, the same 14 buckets (#663). Optional on the same
   *  terms. */
  dailyClosed?: number[];
  /** Whether every item on this board was read, or Github's paging cut the read
   *  short (#663). False means the trailing day — the one the card's movement
   *  reading rests on — is wrong, so the card withholds the chart and the delta
   *  and says why.
   *
   *  It is also A discriminator for the week count (#715). `closedThisWeek` is
   *  absent from a board-api that predates it, from a board this one read short,
   *  and — since #722 — from a rollup whose org-wide join did not run: false →
   *  the row says `truncatedCountNote` (projects/pulse.ts) instead of a count;
   *  true or absent → it counts, as it always did. Named rather than quoted —
   *  quoting it here is what left this line describing wording #763 replaced.
   *  `pulseJoined` below is the other one, and it was added because this flag
   *  could not say the third thing.
   *
   *  Optional on the same terms as its neighbours: an API that predates the field
   *  makes no claim either way. */
  itemsComplete?: boolean;
  /** Whether the org-wide issues ↔ memberships join behind `weeklyClosed`,
   *  `closedThisWeek`, `openedThisWeek`, `dailyOpened` and `dailyClosed`
   *  actually RAN (#722).
   *
   *  False means it did not — board-api's shared issues read failed, which takes
   *  every board in the org out at once — so all four of those figures are
   *  withheld in the spelling #715 settled: the series empty, the count absent.
   *  Not zeros and not a 0, because an empty join is indistinguishable from a
   *  quiet org, and that is exactly the claim this flag exists to stop the row
   *  making.
   *
   *  Absent means no claim: a board-api that predates the field, or the drill-in
   *  detail route, which runs no org-wide join at all. Read it `=== false`, never
   *  as a truthiness test — the spelling `itemsComplete` already uses — so an
   *  absent flag counts as it always did.
   *
   *  NOT `itemsComplete`, and a row must not fold the two together. That one says
   *  ONE board's items were read short; this one says an org-wide join did not
   *  run. Both can be true of one board at once, and they are two different
   *  sentences: "we could not read all of this board" against "we could not read
   *  the org's issues at all".
   *
   *  Between #770 and #792 the false carried a second meaning as well: a
   *  last-good copy was served with it to withhold those four figures, on a
   *  payload whose join had in fact run. `joinedFiguresWithheld` below says the
   *  withholding now, so this field is only what its name says again. A reader
   *  asking whether the figures are on the payload reads that one; a reader
   *  asking WHY they are gone reads this one and `lastGoodCopy`. */
  pulseJoined?: boolean;
  /** Whether this board is the last-good COPY rather than a read (#713, #770).
   *
   *  True means a write dropped board-api's rollup cache, the read that should
   *  have replaced it failed, and the copy that drop retired was served instead
   *  of failing the page. Everything on this board — `closed`, `open`, `pct`,
   *  `contributors`, `lastClosed` — is from BEFORE that write. A reader who just
   *  closed an issue will not find it here; what to do is wait and reload, and
   *  the numbers come back as soon as one read succeeds.
   *
   *  It is a THIRD gate and it is not either of the two above. `itemsComplete`
   *  and `pulseJoined` are about a read going wrong; this is about which payload
   *  arrived, and it is the only one of the three that says anything about the
   *  board's OWN counts — the other two withhold figures the org-wide join fed
   *  and leave the counts alone.
   *
   *  A retiree carries `pulseJoined: true` (#792). The join really did run for
   *  the copy being served — a rollup is cached only when it did — so the false
   *  #770 served here was never a fact about the join; it was the only gate the
   *  deployed frontend had for withholding the five joined figures, borrowed
   *  because there was no field that said so. `joinedFiguresWithheld` below is
   *  that field, and it is what withholds them now. This flag goes on saying
   *  which cause it was, and `weeklyClosedLine` in projects/ProjectBlock.tsx
   *  puts its sentence ahead of the join's for that reason: the join's sentence
   *  is false of a retiree.
   *
   *  Absent, or false, is a payload that came from a read — including a
   *  board-api that predates the field. Read it `=== true`, the opposite
   *  spelling from its two neighbours: they withhold on no claim, and this one
   *  would have every board announce that its numbers are old.
   *
   *  There is no dating it. What a retiree is old BY is in board-api's log and
   *  nowhere on the wire; the sentence says "predate the last change" and not a
   *  duration for that reason. */
  lastGoodCopy?: boolean;
  /** Whether the five joined figures — `weeklyClosed`, `closedThisWeek`,
   *  `dailyOpened` and `dailyClosed` — are off this payload (#792).
   *
   *  True means they were taken off, and it says nothing about why. board-api
   *  sets it inside the single function that removes them, so it is true on all
   *  three of today's causes — this board was read short, the org-wide join did
   *  not run, this is the last-good copy #713 serves — and on any cause added
   *  later, without a fourth flag having to reach this file first. The three
   *  flags above are the ones that NAME a cause; this is the one that says the
   *  figures are gone.
   *
   *  Absent means no claim, and it is read `=== true` — `lastGoodCopy`'s
   *  spelling, and the opposite of `itemsComplete` and `pulseJoined`. A
   *  board-api that predates this field sends the causes and not this flag, so a
   *  reader taking absent for "withheld" would have every board in the app
   *  refuse to state a week. `withheldCountNote` in projects/pulse.ts is the one
   *  reader, and `weeklyClosedLine` beside it ADDS this flag to the three cause
   *  reads rather than putting it in front of them — that file argues why, and
   *  the reason is the same deploy window. */
  joinedFiguresWithheld?: boolean;
  /** The ring's per-member runs, attributed to whoever CLOSED each issue (#454).
   *  Optional so board-web tolerates a board-api that predates the field — the
   *  ring then falls back to its single brand arc. */
  contributors?: ProjectContributor[];
  /** The same runs attributed to whoever the issue was ASSIGNED to. Which of the
   *  two the ring paints is `RING_ATTRIBUTION` in projects/contributors.ts. */
  contributorsByAssignee?: ProjectContributor[];
}

/** One issue row in a board's overview table. */
export type ActivityType = 'opened' | 'commented' | 'closed' | 'reopened' | 'assigned';

export interface ProjectItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  /** The board's Status field value (Todo / In Progress / Done / custom), or ''. */
  status: string;
  state: 'open' | 'closed';
  /** ISO close timestamp when closed, else null/absent (#407) — the shared closed-week
   *  timeframe filter matches against it. Optional across the deploy window. */
  closedAt?: string | null;
  /** WHY it closed (#1014), when the board payload says — read only through
   *  `deliveredCloseAt`, like the queue row's copy of this field.
   *
   *  Present today: the Projects source selects `stateReason` in both of its
   *  shared item selections and `ProjectItem` carries it required, so the Project
   *  page's closed-week drill-in agrees with the queue's. Optional HERE anyway,
   *  because a board-api predating the field is a real state across a deploy and
   *  a second pass through this file. */
  stateReason?: CloseReason;
  assignees: string[];
  prs: { number: number; url: string }[];
  createdAt: string;
  updatedAt: string;
  /** Most recent meaningful timeline event (#259). Optional so board-web tolerates
   *  an older board-api during the deploy window. `href` deep-links to the event on
   *  Github (comment permalink); absent → the viewer links to the issue instead
   *  (#376).
   *
   *  The list column this fed is now Age (#822), which is read off `createdAt`
   *  because a queue row carries no activity at all (#834). Only `href` is still
   *  read: the age cell keeps linking to the event where there is one. */
  lastActivity?: { type: ActivityType; atISO: string; href?: string };
  /** Parent issue number for a native Github sub-issue (#273) — the List view nests
   *  it under its parent. Null/absent = top-level (also tolerates old board-api). */
  parent?: number | null;
  /** Github labels on the issue (name + color) — the shared IssuesViewer filters
   *  and groups by label on the Project page (#376). Optional so board-web
   *  tolerates a board-api that predates the enrichment (→ treated as no labels). */
  labels?: IssueLabel[];
  /** Coarse work type derived from labels (#376), same taxonomy as the queue.
   *  Optional across the deploy window; the viewer falls back to 'chore'. */
  type?: PersonalIssueType;
  /** Enumerable custom-field values (#401): fieldSlug → value name(s). Optional so
   *  board-web tolerates a board-api that predates the enrichment. */
  customFields?: Record<string, string[]>;
}

export interface ProjectDetail extends ProjectSummary {
  items: ProjectItem[];
}

/** Every board the reader can see. `org` narrows the read to that org (#714) —
 *  passed by the page from what the address said, and omitted for the union,
 *  which sends the request it sent before the org was addressable. */
export function fetchProjects(org?: string, read = apiFetch): Promise<{ projects: ProjectSummary[] }> {
  return joinRead(`${read === apiFetch ? 'projects' : 'overview-projects'}${scopeQuery(org)}`, () => readProjects(org, read));
}

async function readProjects(org?: string, read = apiFetch): Promise<{ projects: ProjectSummary[] }> {
  const res = await read(`${API}/api/projects${scopeQuery(org)}`);
  // The message is the sentinel every caller has always matched on, and the
  // STATUS is what this fetcher was missing while `fetchRepos` had it. A bare
  // `Error('forbidden')` names no number, so `scopeStatus` answered null,
  // `scopeRefusal` answered null with it, and `Pulse`'s refusal handler asked
  // "was this a refusal?" and was told no — over a card seeded from
  // `board_payload:projects:<org>`, which then went on stating yesterday's
  // boards and percentages to a reader the board had just refused.
  if (res.status === 403) {
    throw new ApiError(403, 'forbidden', undefined, undefined, await serverMessage(res));
  }
  // Carries the status, and the server's own message, for the same reason
  // `fetchRepos` does (#714). And its code, which is the only thing that tells
  // the 503 a saved copy may answer from every other 503 (#1035).
  if (!res.ok) {
    throw new ApiError(res.status, `projects ${res.status}`, undefined, undefined, await serverMessage(res), await serverCode(res), retryAt(res));
  }
  return res.json();
}

/** One board. `org` narrows the read to that org (#697) — pass it whenever the
 *  URL or the card that opened this page named one, so the number resolves
 *  against THAT org and not against whichever org holds it first. Omitted, the
 *  request is byte-identical to the one this made before #697 and the API
 *  resolves it the way it always has. An org the board does not serve is a 404,
 *  which surfaces as the page's ordinary load failure. */
export function fetchProject(number: number, org?: string): Promise<ProjectDetail> {
  return joinRead(`projects/${number}${scopeQuery(org)}`, () => readProject(number, org));
}

async function readProject(number: number, org?: string): Promise<ProjectDetail> {
  const q = org ? `?${new URLSearchParams({ org })}` : '';
  const res = await apiFetch(`${API}/api/projects/${number}${q}`);
  if (res.status === 403) throw new ApiError(403, 'forbidden', undefined, undefined, await serverMessage(res));
  // The server's own message and its CODE, the two things this fetcher was
  // throwing away while `readProjects` beside it carried both (#1065). The board
  // page decides whether a failed read may leave its board drawn, and since
  // #1060 that decision is `servableFailure`'s — which reads exactly these two
  // fields. Without them a 503 coded `access_not_now` was indistinguishable from
  // a withdrawal here, so the credential refresh #1066 exists to ride out took
  // an open board off the screen; and Caddy's empty 502 was indistinguishable
  // from a 502 carrying board-api's own verdict, which is the one thing that
  // branch tests for.
  if (!res.ok) {
    throw new ApiError(res.status, `project ${res.status}`, undefined, undefined, await serverMessage(res), await serverCode(res));
  }
  return res.json();
}

// ── Projects v2 catalog for adding issues (#404) ─────────────────────────────
/** A lean Projects v2 board entry in the issue's add-to-project catalog (#404)
 *  — the id, number, and title of a board the signed-in user could add this
 *  issue to. */
export interface ProjectCatalogEntry {
  id: string;
  /** Which org's board this is (#697). `id` was already unique across orgs — it
   *  is a Github node id — but `number` and `title` are what the writer READS,
   *  and two orgs can spell both the same, which is two identical rows over two
   *  different boards. Optional for the deploy-window reason `ProjectSummary.org`
   *  states; absent, the picker reads exactly as it did before #697. */
  org?: string;
  number: number;
  title: string;
}

/** Candidate boards retain the server's mutation owner ceiling. */
export function fetchProjectCatalog(org?: string): Promise<ProjectCatalogEntry[]> {
  return readProjectCatalog('catalog', org);
}

/** Read-only project names follow the same owner scope as Overview's rollup. */
export function fetchProjectPreview(org?: string): Promise<ProjectCatalogEntry[]> {
  return readProjectCatalog('preview', org);
}

function readProjectCatalog(kind: 'catalog' | 'preview', org?: string): Promise<ProjectCatalogEntry[]> {
  const path = `projects/${kind}${scopeQuery(org)}`;
  return joinRead(path, async () => {
    const res = await apiFetch(`${API}/api/${path}`);
    if (res.status === 403) throw new Error('forbidden');
    if (!res.ok) throw new Error(`project-${kind} ${res.status}`);
    return res.json();
  });
}

export const fetchOverviewProjects = (org?: string) => fetchProjects(org, overviewNetworkFetch);
