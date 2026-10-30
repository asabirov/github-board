import { API, ApiError, networkFetch as apiFetch, refusalOf, scopeQuery, serverCode, serverMessage } from './core';

// ── repos map (#472, write + security/CI added #558) ────────────────────────
/** One rolling 7-day window of a repo's issue flow. */
export interface RepoWeek {
  opened: number;
  closed: number;
}

/** Ownership comes from `owner`, falling back to `dri` during migration (#1287).
 * Personal-account repos belong to that account. Legacy API names remain compatible.
 *  `login` is the handle as recorded; `name` is the board person that login
 *  resolves to, or null when it maps to nobody on the team. */
export interface RepoOwner {
  login: string;
  name: string | null;
}

/** The latest COMPLETED Actions run on a repo — every repo on the map sits
 *  under the same org ruleset, so "is main green" is the question worth
 *  asking. `null` means the repo has never completed a run, which is not a
 *  failure. */
export type RepoCi =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'action_required'
  | 'neutral'
  | 'skipped'
  | 'stale'
  | null;

/** Open security alerts against one repo, as the three org-level alert APIs
 *  report them. `critical` folds into `depHigh`: the map draws one "high"
 *  level and a critical advisory is not a lesser thing than a high one. */
export interface RepoSecurity {
  /** Whether these four counts were READ at all (#718). `'unreadable'` means at
   *  least one of the org's three alert lists refused, so the zeros beside it
   *  are a gap and not a measurement. A surface that cannot tell those apart
   *  draws a clean bill of health for an org nobody looked at, which on this
   *  surface is the worst answer available.
   *
   *  Optional for the deploy-window reason `ProjectSummary.org` states, and
   *  absent means `'read'` — the reading every surface here already takes of
   *  every payload, so a board-api that predates the field draws exactly what it
   *  draws today. That is a decision rather than a gap left to whatever
   *  `undefined` happens to do: it is the fail-OPEN answer, chosen because the
   *  alternative is a deploy window in which every org is drawn as unread. */
  state?: 'read' | 'unreadable' | 'not-applicable';
  /** Dependabot alerts at high or critical severity. */
  depHigh: number;
  /** Dependabot alerts at moderate or low severity. */
  depModerate: number;
  /** Open code-scanning alerts. */
  codeScanning: number;
  /** Open secret-scanning alerts — a leaked credential, the loudest state. */
  secrets: number;
  /** The first open secret-scanning alert's own page on Github (#605), or null
   *  where the server read none. Never composed from the repo name: a word that
   *  reached a 404 would be worse than the inert word it replaced, so `null`
   *  means the word behaves exactly as it did before addresses existed. */
  secretsUrl: string | null;
}

/** A repo on the map: its queue trend, its current open count and its owner.
 *
 *  Its security posture and its CI state are NOT here (#571). They come from
 *  Github's three alert APIs and its Actions API, which is the slowest part of
 *  the map by a distance, and while they rode on this row the whole page waited
 *  on them. They arrive on their own read now — `RepoHealthRow`, joined back
 *  onto this one by `full`. */
export interface RepoRow {
  /** Failed issue reads must not be drawn as zero activity. Optional for older payloads. */
  openIssuesState?: 'read' | 'unreadable';
  ownerWritability?: OwnerWritability;
  /** `owner/name` — the canonical Github key. */
  full: string;
  /** Repo name without the owner, e.g. 'board'. */
  name: string;
  /** Short key for this repo — also the `?repo=` value the board's issue list
   *  filters on, so a row can open the queue in place. */
  key: string;
  htmlUrl: string;
  description: string | null;
  /** Opened/closed per rolling 7-day window, oldest → newest; the last entry is
   *  the trailing 7 days. Always 10 long, all-zero for a repo with no queue. */
  weeks: RepoWeek[];
  /** Open issues in this repo right now. */
  open: number;
  /** The recorded owner, or null when the org records none for this repo. */
  owner: RepoOwner | null;
  /** Whether the owner above was READ at all (#718). `'unreadable'` means the
   *  ownership read for this repo's org failed — a different claim from `owner:
   *  null`, which is the org recording no owner for this repo. Both draw no
   *  name and only one of them is a fact about the repo, so a surface that
   *  cannot tell them apart says "no owner" over an outage.
   *
   *  Optional for the deploy-window reason `ProjectSummary.org` states, and
   *  absent means `'read'`, on the same terms as `RepoSecurity.state`: it is
   *  what every reader here assumes today, so an older board-api draws what it
   *  draws now rather than turning the whole map unread mid-deploy. */
  ownerState?: 'read' | 'unreadable';
  /** Github's primary language, or null for a repo with no code. */
  language: string | null;
  /** ISO-8601 moment of the repo's last push, or null for a repo never pushed
   *  to. What the counts above cannot say: a repo can carry an empty queue all
   *  quarter and still ship every day (#572). */
  pushedAt: string | null;
}

/** GET /api/repos. `updatedAt` is the age of the issue ingest the counts came
 *  from, not the moment of the request. */
/**
 * Whether the board may set a repo's owner, as far as the server knows — see
 * `ReposView.ownerWritability`. Five states, because the four ways the answer
 * can be "not here" are four different sentences to a reader, and collapsing
 * any two of them draws the wrong thing on the map:
 *
 *   · `writable`   — the org allows this board to set the property. This state
 *                    withholds nothing; whether a control actually appears is
 *                    still the viewer's permission and whether there are
 *                    logins to offer.
 *   · `restricted` — Github's own no: the org keeps the property to its
 *                    owners. Permanent, so no control is drawn.
 *   · `absent`     — the org's schema list read fine and holds no `owner`
 *                    property at all. Permanent too, and nothing to write, so
 *                    no control — and an UNOWNED repo's slot names the missing
 *                    field rather than going on offering "Set owner" for one
 *                    that does not exist. An owned repo still draws its owner:
 *                    the property holds a value, whatever the schema says now.
 *   · `unreadable` — the schema list could not be read. This is a fact about
 *                    this board's TOKEN and says nothing about the org, and is
 *                    never rendered as one. It withholds nothing either, and
 *                    that is the point rather than an outcome: hiding a feature
 *                    on a blip is #577 inverted, and a read that recovers must
 *                    restore the control with no code change. In practice the
 *                    picker still goes, by the OTHER gate — the allowed values
 *                    come out of the same failed read, so `driOptions` is empty
 *                    (`github-repos.source.ts`), and `OwnerPicker` draws no
 *                    menu whose only row would be "No owner".
 *   · `unknown`    — the list read fine and `values_editable_by` held a value
 *                    the board does not recognise. This withholds nothing
 *                    either, and unlike `unreadable` the allowed values came
 *                    off a read that worked — so there is normally something to
 *                    pick, the control is there, and a write the org refuses is
 *                    refused out loud and retryably.
 *
 * `unknown` is narrower than it was: a read that failed is `unreadable` now.
 */
export type OwnerWritability = 'not-applicable' | 'writable' | 'restricted' | 'absent' | 'unreadable' | 'unknown';

export interface ReposView {
  updatedAt: string;
  repos: RepoRow[];
  /** The `owner` property's allowed values for the view. Empty when the schema
   *  cannot be read, and empty again for an org whose schema holds no `owner`
   *  property at all.
   *
   *  On a NARROWED view (`?org=X`) that is X's own list and is exact. On the
   *  UNION view it is every served org's values concatenated (#614, #697,
   *  #718), and it is NOT a list any one org accepts — while the write gate
   *  compares against ONE org's. A picker fed this on the union offers a login
   *  the target org refuses, and that press 400s. `driOptionsByOrg` is the
   *  exact answer for a picker that knows which repo it is setting, and
   *  `driOptionsFor` in `repos/repos-vm` is where this page takes it. */
  driOptions: string[];
  /** Each served org's OWN allowed values, keyed by the org in its CONFIGURED
   *  spelling (#718) — the exact list that org's write gate compares against.
   *  A narrowed view carries the one org it describes; the union view carries
   *  EVERY served org, including the ones nothing could be read for: the
   *  server's schema read never throws, so an org whose schema failed is
   *  present here carrying `[]`. An empty list is therefore two answers in one
   *  — the read failed, or the org has no such property — and what tells them
   *  apart is `ownerWritability` below.
   *
   *  Optional for the deploy-window reason `ProjectSummary.org` states. Absent
   *  means every tile falls back to `driOptions`, which is exactly what this
   *  page offered before the field existed; a decision rather than whatever
   *  `undefined` happens to do, and `repos-vm.ts` is the single place it is
   *  taken. An org the map simply does not mention falls back the same way — an
   *  org whose entry is present and EMPTY does not, because that org was
   *  described and has nothing to offer. */
  driOptionsByOrg?: Record<string, string[]>;
  /** What the server knows about setting an owner (#577, #649), from the `owner`
   *  schema's `values_editable_by`. The five meanings are on the type above,
   *  and `ownerControlOffered` in `repos/repos-vm` is the single place THIS
   *  field is turned into "may the control be offered" — not the only gate on
   *  the control, which `OwnerPicker` also withholds when there is nothing to
   *  pick.
   *
   *  Optional: it guards the deploy window where board-web ships before
   *  board-api adds it. `undefined` reaches that predicate's offered branch by
   *  comparison, under the same `!==` the named states go through, and there is
   *  deliberately no separate branch for it: a missing field must behave as it
   *  always did. That is a decision rather than a gap left to whatever
   *  `undefined` happens to do, and `repos-vm.spec.ts` pins it directly so
   *  nobody tidies the predicate into a truthiness test. */
  ownerWritability?: OwnerWritability;
  /** The orgs this answer is MISSING, in configured order (#718) — the ones
   *  whose repo enumeration failed, so none of their repos are in `repos` at
   *  all. Empty is the ordinary case.
   *
   *  It is here because `repos` cannot say it: a lost org and an org with no
   *  repos both contribute no rows. (A narrowed read for one of these orgs is a
   *  503 rather than an empty 200 — 200-with-nothing is a claim that the org is
   *  empty.)
   *
   *  Optional for the deploy-window reason `ProjectSummary.org` states, and
   *  absent is read as the empty list: a board-api that predates the field
   *  loses no org as far as this client can tell, which is what the page
   *  already assumes of every answer it draws. */
  unreadableOrgs?: readonly string[];
}

/** The whole map. `org` narrows it to that org (#714); omitted, the union. */
export async function fetchRepos(org?: string): Promise<ReposView> {
  const res = await apiFetch(`${API}/api/repos${scopeQuery(org)}`);
  // The message is the sentinel every caller has always matched on, and the
  // STATUS is what #824's review found missing: a bare `Error('forbidden')`
  // names no number, so `scopeStatus` answered null, `scopeRefusal` answered
  // null with it, and the page below held a stale map over a refusal it could
  // not read. `ApiError` carries both, and the two other exits from this
  // function already do.
  if (res.status === 403) {
    throw new ApiError(403, 'forbidden', undefined, undefined, await serverMessage(res));
  }
  // `ApiError` and not a bare Error, message unchanged (#714): a narrowed read
  // is refused two ways — 404 for an org this board does not serve, 503 for one
  // it serves and could not read — and the page owes those two different
  // sentences. Reading them out of the prose was the alternative. The server's
  // own message rides along because the STATUS alone cannot tell either of
  // those from a proxy with no upstream answering the same number.
  if (!res.ok) {
    throw new ApiError(res.status, `repos ${res.status}`, undefined, undefined, await serverMessage(res), await serverCode(res));
  }
  return res.json();
}

/** One repo's health: what the alert APIs and Actions say about it. */
export interface RepoHealth {
  /** Open security alerts against this repo. All-zero when there are none. */
  security: RepoSecurity;
  /** The latest completed Actions run's conclusion, or null if none has run. */
  ci: RepoCi;
  /** That same run's own page on Github (#605), or null. The conclusion and the
   *  address come off one record on the server, so the word a tile draws and the
   *  place it points can never be two different runs. */
  ciUrl: string | null;
}

/** One repo's health, carrying the key it is joined back onto the map by. */
export interface RepoHealthRow extends RepoHealth {
  /** `owner/name` — the same canonical key `RepoRow.full` carries. */
  full: string;
}

/** GET /api/repos/health. Every repo the view holds gets a row here, INCLUDING
 *  the clean ones, so a reader of this payload can tell "nothing to report"
 *  from "not measured". */
export interface ReposHealthView {
  repos: RepoHealthRow[];
  /** The orgs this payload could not be built for, in configured order (#718):
   *  an org whose repo enumeration failed, which therefore has no rows here at
   *  all, or an org whose alert lists refused, whose rows carry
   *  `security.state: 'unreadable'`. Both are named here so the union payload
   *  states the loss rather than serving it as an org with nothing open.
   *
   *  Optional for the deploy-window reason `ProjectSummary.org` states, and
   *  absent is read as the empty list, on the same terms as
   *  `ReposView.unreadableOrgs`. */
  unreadableOrgs?: readonly string[];
}

/**
 * The map's second read (#571).
 *
 * It is separate from `/api/repos` because it is the slow half: three org-level
 * alert APIs and an Actions lookup per repo, against a first read the page can
 * draw the whole grid from. A rejection here is survivable — the page settles
 * every tile at an UNREAD security state and loses the CI conclusion, so
 * nothing about this call may fail the view.
 *
 * Survivable is not silent (#718). Settling used to mean four zeros a tile drew
 * as a measurement, which made one refused request a clean bill of health for
 * the whole map; every tile says its alerts were not read instead.
 */
export async function fetchReposHealth(org?: string): Promise<ReposHealthView> {
  const res = await apiFetch(`${API}/api/repos/health${scopeQuery(org)}`);
  if (res.status === 403) throw new Error('forbidden');
  if (!res.ok) {
    throw new ApiError(res.status, `repos health ${res.status}`, undefined, undefined, await serverMessage(res));
  }
  return res.json();
}

/**
 * Set (or clear, with `login: null`) one repo's `owner` owner (#558). Human-only
 * server-side, gated on GITHUB_WRITE_ENABLED — the same fail-closed envelope
 * every native write on this board shares. Resolves with the response's
 * authoritative owner — the one the server read back off Github after writing,
 * so the tile settles on what Github records rather than on what was asked for.
 *
 * A refused write rejects with an `ApiError` carrying the status, because the
 * tile has to tell a 503 from a 500 to know whether Retry could help (#577) —
 * and, since #584, the refusal reason from the body too, because the status is
 * where three different refusals become one number. This is the control the
 * capability work started from, and the easiest to leave behind: it has thrown
 * `ApiError` since #577, so it renders a sentence either way — without the
 * reason, an SSO refusal here reads "The board isn’t allowed", the flattest
 * answer available and the one nobody can act on.
 */
export async function setRepoDri(owner: string, repo: string, login: string | null): Promise<RepoOwner | null> {
  const res = await apiFetch(`${API}/api/repos/${owner}/${repo}/dri`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login }),
  });
  if (!res.ok) {
    const r = await refusalOf(res);
    throw new ApiError(res.status, `set owner ${res.status}`, r.reason, r.authorizeUrl);
  }
  return (await res.json()).owner;
}

// ── One repo's page (#575) ───────────────────────────────────────────────────
//
// Every type below MIRRORS `board-service/src/repos/repo.types.ts`, which is
// the contract — the service owns these shapes and this file follows them.
//
// Each of the page's three extra reads travels as a discriminated union rather
// than as a nullable field, because on this surface "nothing to report", "we
// could not find out" and "measured at zero" are three different answers, and a
// client that cannot tell them apart draws one as another (#582). A union has to
// be narrowed before it can be read, so the page cannot forget to ask.

/**
 * A repo's README as the board found it. `absent` is a fact about the repo;
 * `unreadable` is a fact about the read, says nothing about whether the repo has
 * one, and is the only one of the two worth retrying.
 */
export type RepoReadme =
  | { state: 'present'; markdown: string }
  | { state: 'absent' }
  | { state: 'unreadable' };

/** Opened/merged in one rolling 7-day window — the same windows, in the same
 *  count and alignment, as `RepoRow.weeks`. */
export interface RepoPrWindow {
  opened: number;
  merged: number;
}

/**
 * A repo's pull-request flow. `weeks` is the same length as `RepoRow.weeks`,
 * oldest → newest, and an entry is `null` where the read did not reach that far
 * back — "not known", never "none". The two draw differently and only one is
 * worth retrying.
 */
export type RepoPrFlow =
  | { state: 'read'; open: number; closedMerged: number; weeks: (RepoPrWindow | null)[]; openPrs?: RepoOpenPr[] }
  | { state: 'unreadable' };

/**
 * One of this repo's open pull requests (#828), for the PRs tab.
 *
 * It hangs off the PR read above rather than off the view's top level on
 * purpose: when that read fails the whole variant is `unreadable`, so the tab
 * and the trend card cannot disagree about whether Github answered.
 *
 * `open` beside it is the true total and this list is capped at a hundred, so
 * `openPrs.length < open` is ordinary on a busy repo and the tab says the list
 * is capped rather than drawing the cap as the count.
 */
export interface RepoOpenPr {
  number: number;
  title: string;
  htmlUrl: string;
  createdAt: string;
  /** Github login, or null for a ghost/deleted account. */
  author: string | null;
  /**
   * True when Github types that author as a `Bot` — dependabot and its kind.
   * `false` for a ghost account, which is a person nobody can name any more
   * rather than a machine.
   *
   * The row is MARKED with it and never hidden by it: a bot's pull request is
   * genuinely open and somebody still has to merge or close it. Measured
   * against live Github on 2026-09-03, all 8 open pull requests on
   * acme/board are dependabot's, so a tab that does not say
   * so reads as eight people waiting on you.
   *
   * Required where `openPrs` and `members` above are optional, and the
   * difference is real rather than an oversight: this field ships INSIDE
   * `openPrs`, added by the same change, so any server sending the list sends
   * the flag. There is no deploy window in which one arrives without the other.
   */
  authorIsBot: boolean;
  draft: boolean;
}

/** One person who works on this repo (#828), derived from the issues and pull
 *  requests this page already read. NOT Github collaborators: that list is the
 *  same three logins on every repo in this org, so an access list would draw one
 *  identical answer on every repo page on the board. */
export interface RepoMember {
  login: string;
  /** Through the same team roster `RepoOwner` resolves a name with, or null for
   *  a login the roster does not carry. Never invented. */
  name: string | null;
  /** Open issues assigned to them in this repo right now. */
  assigned: number;
  /** Issues they opened inside the page's window. */
  openedIssues: number;
  /** Pull requests they opened inside the page's window. */
  openedPrs: number;
  /** True when the org's `owner` property names them for this repo. */
  dri: boolean;
}

/** The people, plus what could not be counted into them. */
export interface RepoMembers {
  people: RepoMember[];
  /** True when the PR read came back `unreadable`, so `openedPrs` is 0 for
   *  everybody and somebody active only in pull requests is missing entirely.
   *  The tab says this in words; it never draws a short list as a complete one. */
  prsUnreadable: boolean;
}

/**
 * What CI cost in one rolling 7-day window.
 *
 * `netUsd` is the measure. `minutes` rides beside it for one reason, and it is
 * the reason this pair exists: net cost is zero both for a week that ran nothing
 * and for a week whose real work the org's included-minutes allowance absorbed.
 * Minutes are what tells those apart, and they are NOT a second trend.
 */
export interface RepoCiWindow {
  minutes: number;
  netUsd: number;
}

/** A repo's CI spend per window, aligned to `RepoRow.weeks`, or the read that
 *  did not answer. */
export type RepoCiSpend =
  | { state: 'read'; weeks: RepoCiWindow[] }
  | { state: 'unreadable' };

/** A comparison value: an earlier total or a change, as its field specifies.
 * `none` means the repo is too young for that comparison; `unknown` means the
 * read cannot establish it. Neither may be drawn as zero. */
export type RepoPrior =
  | { state: 'read'; value: number }
  | { state: 'none' }
  | { state: 'unknown' };

/** Each Overview figure one period back (#962). The open counts are the counts
 *  when the page's window opened; the spend is the total over the ten weeks
 *  before it. */
export interface RepoPreviousPeriod {
  openIssues: RepoPrior;
  openPrs: RepoPrior;
  ciNetUsd: RepoPrior;
}

/** Change over the latest completed UTC day; both dates are YYYY-MM-DD.
 * Counts compare the instants immediately before the days end. Spend compares
 * the two whole days. Missing data is unknown; a repo too young to compare is
 * none. Only read carries a number, including a measured zero. */
export interface RepoCompletedDayChange {
  day: string;
  previousDay: string;
  openIssues: RepoPrior;
  openPrs: RepoPrior;
  ciNetUsd: RepoPrior;
}

/** One of this repo's open issues, off the shared org-wide ingest. Carries no
 *  state and no closing moment: every row here is open, so each of those could
 *  only ever hold one value (#826). */
export interface RepoOpenIssue {
  number: number;
  title: string;
  htmlUrl: string;
  createdAt: string;
  author: string | null;
  labels: string[];
}

/** GET /api/repos/:owner/:name/page — everything one repo's page draws. `repo`
 *  is the map's own row, so the page and the tile can never disagree about the
 *  same repo. */
export interface RepoPageView {
  /** Absent on older services; never interpret absence as a zero change. */
  completedDayChange?: RepoCompletedDayChange;
  /** The ingest's freshness, exactly as `ReposView.updatedAt` reports it. */
  updatedAt: string;
  repo: RepoRow;
  readme: RepoReadme;
  pullRequests: RepoPrFlow;
  ciSpend: RepoCiSpend;
  /** Every open issue in this repo, newest-created first, capped at a hundred by
   *  the service (#828 — it was five until the Issues tab took over from the
   *  five-row Overview block, and the cap is the payload's limit rather than a
   *  claim about how many matter). Empty for a repo whose queue is closed or was
   *  never used — `repo.open` is the whole count. Optional because a server
   *  older than #826 does not send it; read it through `openIssuesOf`, never off
   *  the field. */
  openIssues?: RepoOpenIssue[];
  /** The compatibility name for the same array, and nothing else. It carries
   *  OPEN issues despite what it is called: #826 renamed the field, and the two
   *  services deploy from `main` independently, so for one window a board-web
   *  reading `openIssues` can meet a board-api still writing `recentIssues` —
   *  and an `immutable`-cached tab can hold the older bundle for as long as
   *  nobody hard-reloads. Publishing the list under both names is what stops
   *  either skew blanking the page. It goes when #838 drops the older one, and
   *  #838 is held until no bundle reading this name is still being served. */
  recentIssues?: RepoOpenIssue[];
  /** Whether the ingest actually READ this repo's issues (#837) — the third
   *  answer the block was missing, and the one `pullRequests` and `ciSpend` have
   *  had since #575. Under `unreadable` the list above is empty because nobody
   *  could look, not because the queue is clear.
   *
   *  A sibling field rather than a union around the list, and optional here, for
   *  the same deploy reason every optional on this payload carries: both services
   *  ship from `main` independently and the bundles are served `immutable`, so a
   *  tab already open holds its bundle until a hard reload. Absent means a
   *  board-api that predates #837, which is a fact about the PAYLOAD and not
   *  about the read — `issuesTab` keeps today's answer for it rather than
   *  inventing an outage. */
  openIssuesState?: 'read' | 'unreadable';
  /**
   * Who works on this repo (#828), for the Members tab.
   *
   * OPTIONAL HERE AND REQUIRED IN THE CONTRACT, and the difference is the deploy
   * window rather than a disagreement about the shape. Both services deploy from
   * `main` independently into one production environment, so a board-web that
   * ships first meets a board-api that has never heard of this field — and an
   * `immutable`-cached tab can hold that bundle for as long as nobody hard-reloads.
   * Required, `view.members.people` is a TypeError inside the ErrorBoundary; the
   * same window is what `openIssues` / `recentIssues` above and `RepoRow.ownerState`
   * were both written for.
   *
   * Absent is NOT an empty list. An empty list says nobody works here, which is a
   * fact about the repo; absent says this board has not been told, which is a
   * fact about the read. `membersTab` in `repos/repo-tabs.ts` draws them apart,
   * and the tab carries no count for either.
   */
  members?: RepoMembers;
  /** The three Overview figures one period back (#962). Optional for the same
   *  deploy window as `members` above: absent is a comparison this board was
   *  not sent, and draws as one it could not make, never as "No change". */
  previous?: RepoPreviousPeriod;
}

/** The one place that knows there are two names for this list. Everything that
 *  draws the block asks here, so the follow-up that drops the compatibility
 *  name has one line to delete rather than a search to run.
 *
 *  The `?? []` is a third window again: a board-api older than #826 sends
 *  neither name, and a board-web reading `.length` off `undefined` throws inside
 *  the render, which the page's boundary draws as nothing at all. */
export function openIssuesOf(view: RepoPageView): RepoOpenIssue[] {
  return view.openIssues ?? view.recentIssues ?? [];
}

/**
 * The repo page's one read (#575).
 *
 * Both segments are encoded: a repo name is not URL-safe by construction. A 404
 * rejects as `not-found` — the same word `fetchIssue` uses — so a mistyped repo
 * can say which repo is missing instead of showing a generic failure.
 */
export async function fetchRepoPage(owner: string, name: string): Promise<RepoPageView> {
  const path = `${API}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/page`;
  const res = await apiFetch(path);
  if (res.status === 404) throw new ApiError(404, 'not-found');
  if (res.status === 403) throw new ApiError(403, 'forbidden');
  if (!res.ok) throw new ApiError(res.status, `repo page ${res.status}`);
  return res.json();
}

export interface ReposCiSpendView {
  repos: { full: string; ciSpend: RepoCiSpend }[];
}

export interface ReposPrFlowView {
  repos: { full: string; pullRequests: RepoPrFlow }[];
}
