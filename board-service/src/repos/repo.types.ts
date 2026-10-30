// The Repos map (#472): every repo board already ingests, with its queue trend
// and its owner. The counts are a rollup of the SAME org-wide issue ingest the
// throughput/aging metrics read (#257) — this surface adds no per-view GitHub
// call for them. The source below supplies only what the ingest cannot: which
// repos exist (including the ones with an empty queue) and who owns each one,
// read from `owner`, with `dri` as a migration fallback (#1287).
// Personal-account repos are owned by that account; legacy API names stay compatible.

/** One repo in scope: enough to name it, link it, and join it to the ingest. */
export interface RepoDescriptor {
  /** `owner/name` — the canonical GitHub key. */
  full: string;
  /** Repo name without the owner, e.g. 'board'. */
  name: string;
  /** Short key matching `RawIssue.repo`, e.g. 'board' (see `shortRepoKey`).
   *  Half of the join into the ingested issue list, never the whole of it: the
   *  key carries no owner and two orgs can each own a `design-system`, so the
   *  join runs through `repoJoinKeyOf` and takes `full`'s owner with it (#647). */
  key: string;
  htmlUrl: string;
  description: string | null;
  /** GitHub's primary language, free on the repo listing. */
  language: string | null;
  /** ISO-8601 moment of the repo's last push, free on the same listing. The
   *  ingest counts issues and knows nothing about pushes, so this is one more
   *  fact only the source can supply — and the one that says whether a repo is
   *  alive, which its issue flow does not (#572). `null` for a repo that has
   *  never been pushed to: GitHub declares `pushed_at` nullable on the org
   *  listing, and an empty repo has no push to report. */
  pushedAt: string | null;
  /** ISO-8601 moment the repo was created, free on the same listing (#962). It
   *  is what says whether the repo HAS a previous period to compare with: a repo
   *  younger than two windows would otherwise compare against weeks in which it
   *  did not exist, and draw them as zero. `null` when Github sent none, which
   *  the comparison reads as unknown rather than as old. */
  createdAt: string | null;
  /** The branch GitHub reports as this repo's default — `main` on most of the
   *  org, and not on all of it, which is why it is read per repo rather than
   *  assumed. Free on the same listing, so the CI read below can scope itself
   *  to the protected branch without a call of its own (#572). `null` when the
   *  listing names none: GitHub declares `default_branch` optional on the org
   *  listing schema, and a branch nobody named cannot be asked about. */
  defaultBranch: string | null;
}

export const REPOS_SOURCE = 'REPOS_SOURCE_IMPL';

export interface IReposSource {
  /** Every org this source's map covers, in the configured spelling and order —
   *  the orgs `listRepos`, `driByRepo`, `securityByRepo` and every other
   *  org-wide read below span, and the set a write is validated against (#718).
   *
   *  It lives on the SOURCE rather than being re-derived from config: a source
   *  is free not to follow config at all, and `FixtureReposSource` serves
   *  `acme` whatever a deployment names. */
  readonly servedOrgs: readonly string[];
  /** Every repo on the map: non-archived, issues enabled, in every configured
   *  org (or the pinned repo list). Archived repos and repos with issues turned
   *  off never appear.
   *
   *  ONE org failing does not fail the listing — the orgs that answered still
   *  carry real repos, and blanking them because a second org 404d would lose a
   *  read that succeeded. That org is named in `unreadableOrgs`, because a repo
   *  list cannot say it: an org that contributed nothing and an org with no
   *  repos are both simply absent from `repos`. EVERY org failing throws,
   *  carrying each org's own reason. */
  listRepos(): Promise<ReposRead>;
  /**
   * Every repo's `owner` organization custom property, keyed by `owner/name`.
   *
   * One org-wide call PER ORG, not one per repo: the endpoint returns a row for
   * every repository in an org, so the whole map's ownership costs one request
   * an org. A repo missing from `byRepo` — or carrying a null value — declares
   * no owner, which the surface reports as "no owner" rather than guessing one.
   *
   * Throws only when EVERY org failed, so a total outage is still never read as
   * "nobody owns anything". `unreadableOrgs` is what keeps that promise once one
   * org may fail alone: those orgs' repos are absent from `byRepo` for a reason
   * that is not "nobody owns them", and absence alone cannot say which.
   */
  driByRepo(): Promise<DriRead>;
  /**
   * Open security alerts for every repo, keyed by `owner/name`.
   *
   * Three org-wide calls PER ORG, not three per repo: Dependabot, code scanning
   * and secret scanning each expose an organization-level alert list, so the
   * whole map's posture costs three requests an org. A repo absent from the
   * result has no open alerts. NEVER throws — an EMPTY map when an org denies
   * one of the three, per org and in total, security being a decoration on a map
   * whose subject is the repo list. The orgs that refused are NAMED, because
   * absence from `byRepo` is what a clean repo looks like (#718).
   */
  securityByRepo(): Promise<SecurityRead>;
  /**
   * The latest completed Actions run ON EACH REPO'S DEFAULT BRANCH, keyed by
   * `owner/name`.
   *
   * The branch comes from the descriptor, one per repo — a run on a feature
   * branch, a fork's pull request or a Dependabot push is another branch's
   * business, and reporting it turns a tile red over something nobody at that
   * tile can act on (#572).
   *
   * One call per repo — the only per-repo read on this surface, which the view's
   * TTL absorbs. A repo whose read fails resolves to `null` rather than
   * rejecting: a CI signal is worth less than the map it sits on. So does a repo
   * whose default branch has never completed a run, and a repo whose default
   * branch the listing did not name.
   */
  ciByRepo(descriptors: RepoDescriptor[]): Promise<Map<string, RepoCiRead>>;
  /**
   * The `owner` property's own schema for ONE org — the values it allows, and
   * whether this board is allowed to set them at all. One read serves both,
   * because GitHub returns both in the same response.
   *
   * `org` is required and has no default (#649). The schema is per-org, and both
   * facts it carries gate a write; a caller that could omit the org would be
   * judging a write to one org against another org's settings, and nothing in
   * the answer would say so.
   *
   * What required buys, precisely: every CALL SITE has to name an org, because
   * a call with no argument is a compile error. That is where forgetting
   * actually happens — a caller holding two orgs and reaching for the read.
   *
   * What it does NOT buy, and this is not a technicality: it does not oblige an
   * IMPLEMENTER to accept the argument. Method parameter arity is bivariant in
   * TypeScript, so a class whose `driSchema()` takes nothing satisfies this
   * signature and compiles clean. An implementation that quietly ignored the org
   * would be a wrong answer with no error anywhere, and only reading it would
   * show that. So an implementation taking the parameter is a review obligation
   * — `GithubReposSource` and `FixtureReposSource` both owe it — and not
   * something this signature can check.
   */
  driSchema(org: string): Promise<DriSchema>;
  /**
   * Set (or clear, with `login: null`) one repo's `owner` organization custom
   * property. `full` is `owner/name`. Rejects with the mapped HTTP exception
   * when GitHub refuses — a refusal must never escape as an unhandled Octokit
   * error and become a 500 (#577).
   *
   * Resolves with the login GitHub RECORDS afterwards, which is what the
   * surface settles on. The write itself answers with no body, so a source
   * that returned the requested login would be dressing a request up as an
   * answer — and a write that quietly did not apply is the whole of #577.
   */
  setDri(full: string, login: string | null): Promise<string | null>;
  /**
   * One repo's README, raw (#575). `full` is `owner/name`.
   *
   * Resolves `absent` when the repo names none and `unreadable` when Github
   * would not answer — never throws. A page whose README could not be read
   * still draws everything else, so this read may only ever cost itself.
   */
  readme(full: string): Promise<RepoReadme>;
  /**
   * One repo's pull requests back to `since`, with its open and closed+merged
   * totals (#575). `full` is `owner/name`.
   *
   * Paginates under a hard cap and reports its own reach in `coveredFrom`, so
   * a window the read never got to reads as unknown rather than as zero. Never
   * throws: `unreadable` is the failure, and it costs this section alone.
   */
  pullRequests(full: string, since: string): Promise<RepoPrRead>;
  /**
   * Every repo's daily Actions usage for the named months, ORG-WIDE (#575).
   *
   * One call per month PER ORG, not one per repo: the billing report carries a
   * row per repo per day per SKU, so a page serves itself from its org's answer
   * and never triggers a read of its own. Rows are already filtered to Actions
   * minutes — storage and GHAS ride the same payload and are not CI spend.
   *
   * The per-month rule is unchanged and is asked PER ORG: if any requested month
   * fails for an org, that org contributes nothing and is absent from `orgs`. A
   * total missing a month is not a smaller total, it is a wrong one — and a
   * wrong one is indistinguishable from a quiet month.
   *
   * Resolves `null` only when NO org answered, which is the CI section going
   * quiet and nothing else.
   */
  actionsUsage(months: UsageMonth[]): Promise<ActionsUsageRead | null>;
}

/**
 * What one `listRepos()` enumerated, and what it could not (#718).
 *
 * `repos` holds only the orgs that answered. `unreadableOrgs` names the rest,
 * for the reason a repo list cannot: a repo list says which repos exist and
 * nothing about which orgs were asked, so an org that failed and an org with no
 * repos arrive as the same rows — none. A consumer that cannot tell them apart
 * serves an outage as an empty org, and a `?org=` narrowing turns that from
 * invisible into stated.
 */
export interface ReposRead {
  repos: RepoDescriptor[];
  /** The orgs whose enumeration failed, in configured order. Empty is the
   *  ordinary case. Never every org — that throws instead, because an empty
   *  list with nothing behind it is indistinguishable from a real one. */
  unreadableOrgs: readonly string[];
}

/**
 * What one `securityByRepo()` covered, and what it could not (#718).
 *
 * `byRepo` holds a row for every repo with an open alert, in the orgs that
 * answered. `unreadableOrgs` names an org when ANY of its three lists refused,
 * not only when all three did.
 *
 * So an unreadable org still has ROWS here, and every row this read produces
 * carries `state: 'read'`. Settling that is the CALLER's: every repo of an org
 * named here, row or no row, owes `state: 'unreadable'` instead.
 */
export interface SecurityRead {
  byRepo: Map<string, RepoSecurity>;
  /** The orgs at least one alert list could not be read for, in configured
   *  order. This read never throws, so this is the only place a total failure
   *  differs from an org with nothing open. */
  unreadableOrgs: readonly string[];
}

/**
 * What one `driByRepo()` covered, and what it could not (#718).
 *
 * `byRepo` holds only the orgs that answered. `unreadableOrgs` names the rest,
 * because absence from `byRepo` otherwise carries two opposite meanings at once:
 * a repo whose org records no owner, and every repo of an org nothing could be
 * read from. The first is a fact about the org; the second is a fact about the
 * read, and a consumer that cannot tell them apart draws "no owner" over an
 * outage.
 */
export interface DriRead {
  /** `owner/name` → the recorded `owner` login, or null where the org records
   *  none. Only orgs that answered appear. */
  byRepo: Map<string, string | null>;
  /** The orgs whose properties read failed, in configured order. Empty is the
   *  ordinary case: every configured org answered. */
  unreadableOrgs: readonly string[];
}

/**
 * What one `actionsUsage()` covered, and for whom (#718).
 *
 * `days` is keyed `org/repo`, so an org that contributed nothing and an org
 * whose repos genuinely ran no minutes produce the same rows — none. `orgs` is
 * the only place that difference can be read, and it names the orgs whose
 * billing read fully succeeded: every requested month, for that org.
 */
export interface ActionsUsageRead {
  days: ActionsUsageDay[];
  /** The orgs this report covers, in configured order. Never empty — a read
   *  covering no org resolves `null` instead. */
  orgs: readonly string[];
}

/** One calendar month of the org's billing report. `month` is 1-12, as the
 *  endpoint takes it — not JavaScript's 0-11, which is the mistake this comment
 *  exists to stop. */
export interface UsageMonth {
  year: number;
  month: number;
}

/**
 * Whether this board may set a repo's `owner`, as far as it actually knows (#577).
 *
 * Five states, because "the schema says no", "there is no such property" and
 * "the read did not arrive" are three different things and the board must not
 * say one when it only has another (#649).
 *
 * - `writable`   — the schema records `values_editable_by: org_and_repo_actors`,
 *                  which is what the board's repo-level write needs.
 * - `restricted` — the schema records something else, so a repo actor may not
 *                  set it. Read, therefore permanent.
 * - `absent`     — the org's schema list was read and holds no `owner` row at all.
 *                  Read, therefore permanent: no retry creates a property.
 * - `unreadable` — the list could not be read (a rate limit, a dropped socket,
 *                  an expired token, an org this token cannot see). Nothing is
 *                  known about the org's settings. The write is still refused —
 *                  the board does not send what it cannot vouch for — but the
 *                  refusal claims nothing and may well succeed next time.
 * - `unknown`    — READ THIS BEFORE WIDENING IT BACK. It no longer means "the
 *                  read failed"; that is `unreadable` now. It means the list
 *                  read fine, the `owner` row was there, and its
 *                  `values_editable_by` held a value `EDITABLE_BY`
 *                  (`github-repos.source.ts`) does not recognise — an enum
 *                  Github added after this code was written. One org, one
 *                  property, one unrecognised string: the narrowest state here,
 *                  not the catch-all its name suggests.
 *
 * The three that come off a successful read (`writable`, `restricted`,
 * `absent`) are settled and cacheable; the two that do not (`unreadable`,
 * `unknown`) are not — see `ReposService.ownerWriteEnv`.
 */
export type OwnerWritability = 'not-applicable' | 'writable' | 'restricted' | 'absent' | 'unreadable' | 'unknown';

/**
 * The `owner` custom property as its schema describes it (#577).
 *
 * The board writes the property one repo at a time, through the repo-level
 * values endpoint, and that endpoint only accepts a repo actor's write while
 * the org keeps `org_and_repo_actors`.
 */
export interface DriSchema {
  /** The logins the property allows. Empty when the schema could not be read
   *  and when there is no such property — which is why `writability` has to be
   *  consulted first: an empty list means "nothing allowed", "nothing there"
   *  and "nothing known" alike. */
  allowedValues: string[];
  writability: OwnerWritability;
}

/** The conclusion of the latest COMPLETED Actions run on a repo's DEFAULT
 *  BRANCH — the only branch-protection-ish signal that actually varies across
 *  this org. Every repo sits under the same `protect-main` org ruleset, so the
 *  question worth asking is whether the protected branch is green — and that is
 *  the branch the read names, rather than whichever ref happened to run last
 *  (#572). `null` means no such run was found, or none could be read, which is
 *  not a failure. */
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

/**
 * What one repo's CI read brought back (#605): the conclusion the tile turns
 * into a word, and the address of the very run that conclusion came from.
 *
 * They travel together because they are one fact. The run object the listing
 * returns already carries `html_url`; the read used to keep the conclusion and
 * drop the rest, which left the board naming a problem it could not point at.
 *
 * `url` is null wherever `conclusion` is — no run was read, so there is nothing
 * to point at — and may also be null on a run that reported no address. Null is
 * never a composed fallback: only an address Github handed over may be drawn.
 */
export interface RepoCiRead {
  conclusion: RepoCi;
  url: string | null;
}

/** Open security alerts against one repo, as the three org-level alert APIs
 *  report them. `critical` folds into `depHigh`: the map draws one "high"
 *  level and a critical advisory is not a lesser thing than a high one. */
export interface RepoSecurity {
  /** Whether these counts were READ at all (#718).
   *
   *  The same vocabulary `RepoCiSpend` and `RepoRow.ownerState` use, and here
   *  for the same reason: every field below is a number, and zero is what a
   *  clean repo and an unread org both look like. `'unreadable'` means this
   *  repo's org is in `SecurityRead.unreadableOrgs` — at least one of its three
   *  alert lists refused — so the zeros beside it are a gap and not a
   *  measurement. A surface that cannot tell them apart draws a clean bill of
   *  health for an org nobody looked at, which on this surface is the worst
   *  answer available. */
  state: 'read' | 'unreadable' | 'not-applicable';
  /** Dependabot alerts at high or critical severity. */
  depHigh: number;
  /** Dependabot alerts at moderate or low severity. */
  depModerate: number;
  /** Open code-scanning alerts. */
  codeScanning: number;
  /** Open secret-scanning alerts — a leaked credential, the loudest state. */
  secrets: number;
  /**
   * The first open secret-scanning alert's OWN page on Github (#605), or null.
   *
   * Read off the alert row, never composed from the repo name and a path this
   * board guessed: 'Leaked secret' is the word the tile draws from `secrets`,
   * and a word that reached a 404 would be worse than the inert word it
   * replaced. `null` therefore means exactly one thing — no address was read —
   * and the word stays exactly as it is today.
   *
   * Only secret scanning carries one. The other two counts draw no word, so an
   * address for them would have no reader.
   */
  secretsUrl: string | null;
}

/** One rolling 7-day window of a repo's issue flow. */
export interface RepoWeek {
  opened: number;
  closed: number;
}

/** The repo's owner, read off its `owner` organization custom property. `login` is
 *  the handle as recorded; `name` is the board person that login resolves to, or
 *  null when it maps to nobody on the team. */
export interface RepoOwner {
  login: string;
  name: string | null;
}

/** A repo as the map draws it. */
export interface RepoRow {
  /** Failed issue reads must not be drawn as zero activity. Optional for older payloads. */
  openIssuesState?: 'read' | 'unreadable';
  ownerWritability?: OwnerWritability;
  /** `owner/name` — the canonical GitHub key. */
  full: string;
  name: string;
  /** Short key for DISPLAY and for the `?repo=` filter value the board's issue
   *  list takes. Joining this row to the ingested issues needs the owner too —
   *  see `RepoDescriptor.key` and `repoJoinKeyOf` (#647). */
  key: string;
  htmlUrl: string;
  description: string | null;
  /** Opened/closed per rolling 7-day window, oldest → newest; the last entry is
   *  the trailing 7 days. Always REPO_WEEKS long, all-zero for an empty queue. */
  weeks: RepoWeek[];
  /** Open issues in this repo right now. */
  open: number;
  /** The recorded owner, or null when the org records none for this repo. */
  owner: RepoOwner | null;
  /** Whether the owner above was READ at all (#718). `'unreadable'` means this
   *  repo's org is in `DriRead.unreadableOrgs` — the ownership read for that org
   *  failed — which is a different claim from `owner: null`, the org recording
   *  no owner for this repo. Both draw no name, and only one of them is a fact
   *  about the repo; a surface that cannot tell them apart says "no owner" over
   *  an outage. `'read'` for everything the read covered. */
  ownerState: 'read' | 'unreadable';
  // Security and CI are deliberately NOT here (#571). They are the slowest two
  // reads on this surface and they are decorations on it, so they travel on
  // `ReposHealthView` instead — and as absent fields rather than optional ones,
  // because a field that is sometimes a measurement and sometimes an absence
  // cannot say which it is. The row states what the map knows; the health read
  // states the rest.
  /** GitHub's primary language, or null for a repo with no code. */
  language: string | null;
  /** ISO-8601 moment of the repo's last push, or null for a repo that has never
   *  been pushed to. Liveness the issue counts above cannot tell: a repo can
   *  have an empty queue all quarter and still be shipping every day (#572). */
  pushedAt: string | null;
  /** When the repo was created — `RepoDescriptor.createdAt`, carried through for
   *  the repo page's previous period (#962). */
  createdAt: string | null;
}

/** One repo's health, joined to its row by `full` — the same `owner/name` key
 *  `RepoRow.full` carries. */
export interface RepoHealth {
  /** `owner/name` — the join key back onto the map. */
  full: string;
  /** Open security alerts against this repo. All-zero when there are none. */
  security: RepoSecurity;
  /** The latest completed Actions run's conclusion, or null if none has run. */
  ci: RepoCi;
  /** That same run's own page on Github (#605), or null when no run was read.
   *  The tile's CI words point here; see `RepoCiRead`. */
  ciUrl: string | null;
}

/**
 * GET /api/repos/health (#571) — the two slow decorations the map no longer
 * waits for. Measured against the live org: security is 14-17 s of a cold read
 * and CI another 3.5 s, against 1.3 s for the repo listing itself.
 *
 * EVERY repo on the map this payload was built from gets a row, including the
 * ones with no alerts and no completed run. A repo missing from the payload
 * would be indistinguishable from a repo the client has not received yet, and
 * the client has to be able to tell "clean" from "not known yet". The service
 * holds the two together by binding this answer to the view it was built from,
 * so a rebuilt map takes a rebuilt payload with it rather than leaving a new
 * repo with no row.
 */
export interface ReposHealthView {
  repos: RepoHealth[];
  /** The orgs this payload could not be built for, in configured order (#718):
   *  an org whose repo enumeration failed, which therefore has no rows here at
   *  all, or an org whose alert lists refused, whose rows carry
   *  `security.state: 'unreadable'`. Both are named here so the union payload
   *  states the loss rather than serving it as an org with nothing open.
   *
   *  A narrowed read (`?org=X`) carries X's entry when X is one of them, and is
   *  a 503 when X's repos could not be listed at all. */
  unreadableOrgs: readonly string[];
}

// ── The repo page (#575/#582) ───────────────────────────────────────────────
//
// One repo's own page reads three things the map never asks for: the README,
// the pull-request flow and what CI cost. Each of the three is a state, not a
// number, because on this surface "nothing to report" and "we could not find
// out" and "measured at zero" are three different answers and a client that
// cannot tell them apart will draw one as another (#582).
//
// So each travels as a discriminated union rather than as a nullable field.
// `RepoRow`'s note above makes the same argument for security and CI: a field
// that is sometimes a measurement and sometimes an absence cannot say which it
// is. A union has to be narrowed before it can be read, so the client cannot
// forget to ask.

/**
 * A repo's README as this board found it.
 *
 * - `present`    — the file was read; `markdown` is its raw text and the client
 *                  renders it.
 * - `absent`     — the repo names no README. A fact about the repo, not a
 *                  failure of the read.
 * - `unreadable` — Github would not answer. Says nothing about whether the repo
 *                  has one, and is worth a retry, which `absent` is not.
 */
export type RepoReadme =
  | { state: 'present'; markdown: string }
  | { state: 'absent' }
  | { state: 'unreadable' };

/** One pull request, reduced to the two moments the flow is bucketed on and the
 *  person the members list counts it for. */
export interface RepoPrRecord {
  number: number;
  createdAt: string;
  /** ISO moment the PR was merged, or null when it is open or was closed
   *  unmerged. Closed-unmerged is deliberately not a third series: the page
   *  reports what got opened and what landed. */
  mergedAt: string | null;
  /** ISO moment the PR was closed, merged or not, or null while it is open
   *  (#962). Not drawn: it is what lets `openPrsAt` wind the open count back to
   *  the start of the window, which needs every close, not only the merges. */
  closedAt: string | null;
  /** GitHub login of whoever opened it, or null for a ghost/deleted account
   *  (#828). Read for `RepoMember.openedPrs` and for nothing else: the windows
   *  above count PRs, not people. */
  author: string | null;
  /** True when Github types that author as a `Bot` (#828) — dependabot and its
   *  kind. `false` for a ghost account, which is a person nobody can name any
   *  more rather than a machine.
   *
   *  It is here because the members list would otherwise rank a bot above a
   *  teammate: measured on acme/board on 2026-09-03, all 8
   *  open PRs are dependabot's and 8 of the last 100 are, against 1 from a
   *  second person. Off `author { __typename }`, which states it, rather than
   *  off a `[bot]` suffix, which guesses at it. */
  authorIsBot: boolean;
}

/**
 * One OPEN pull request, as the PRs tab lists it (#828).
 *
 * A different shape from `RepoPrRecord` and deliberately so: that one is a
 * bucketing input, reduced to two moments, and this one is a row somebody
 * reads. They come from two connections on one query — see `PR_QUERY` in
 * `github-repos.source.ts` — because the records are ordered by UPDATED_AT and
 * stop at the window, so an open PR nobody has touched for months is not among
 * them and a list built from them would omit exactly the stale ones a person
 * opens this tab to find.
 */
export interface RepoOpenPr {
  number: number;
  title: string;
  htmlUrl: string;
  createdAt: string;
  /** GitHub login, or null for a ghost/deleted account. */
  author: string | null;
  /** True when Github types that author as a `Bot` — see `RepoPrRecord`.
   *
   *  A bot's pull request STAYS on this list: it is genuinely open and somebody
   *  has to merge or close it, and a tab that hid it would under-report the
   *  queue. The flag is here so the row can be MARKED, which is a different
   *  thing from the members list, where the same PR is not counted as work a
   *  person did. */
  authorIsBot: boolean;
  draft: boolean;
}

/**
 * What one PR read brought back, before it is bucketed into windows.
 *
 * `coveredFrom` is the read's own reach: the oldest moment it can speak for.
 * `null` means the whole history was fetched, so every window is covered. A
 * non-null value means pagination stopped at its cap, and any window that
 * starts before it is UNKNOWN rather than empty — a busy repo can exhaust the
 * cap inside a fortnight (measured: 100 PRs reaches two weeks back on
 * board), and reporting the rest as zero would invent a quiet
 * quarter for the org's busiest repo.
 */
export type RepoPrRead =
  | {
      state: 'read';
      open: number;
      closedMerged: number;
      prs: RepoPrRecord[];
      coveredFrom: string | null;
      /** The open pull requests themselves, newest-created first, capped at
       *  OPEN_PRS_CAP (#828). `open` above stays the true total, so a list
       *  shorter than it is the cap and not a disagreement. */
      openPrs: RepoOpenPr[];
    }
  | { state: 'unreadable' };

/** Opened/merged in one rolling 7-day window — the same windows, in the same
 *  count and alignment, as `RepoRow.weeks`. */
export interface RepoPrWindow {
  opened: number;
  merged: number;
}

/**
 * A repo's pull-request flow as the page draws it.
 *
 * `weeks` is REPO_WEEKS long, oldest → newest. An entry is `null` where the
 * read did not reach that far back — see `RepoPrRead.coveredFrom`. `null` is
 * "not known", never "none": the two draw differently and only one is worth
 * retrying.
 */
export type RepoPrFlow =
  | {
      state: 'read';
      open: number;
      closedMerged: number;
      weeks: (RepoPrWindow | null)[];
      /** The PRs tab's own list (#828), newest-created first and capped at
       *  OPEN_PRS_CAP. It hangs off the PR read rather than off the view's top
       *  level on purpose: when that read fails the whole variant is
       *  `unreadable`, so the tab and the trend card above it cannot disagree
       *  about whether Github answered.
       *
       *  `openPrs.length < open` is ordinary on a busy repo — `open` is the
       *  total and this is a page of it — and the tab says so rather than
       *  drawing the cap as the count. */
      openPrs: RepoOpenPr[];
    }
  | { state: 'unreadable' };

/**
 * One day of Actions usage for one repo, as the org's billing report records
 * it. Read org-wide, once, and served to every repo page from that one answer —
 * a repo page must never trigger a billing read of its own.
 */
export interface ActionsUsageDay {
  /** `owner/name`, composed from the report's own org and repo names. */
  full: string;
  /**
   * When the report dates this usage to (ISO-8601).
   *
   * NOT a midnight day-stamp, whatever the endpoint's day-granularity suggests:
   * measured over 1420 live Actions-minutes rows, none is midnight-shaped —
   * each carries the real moment of the usage. (The midnight-dated rows in the
   * same payload are the storage SKU, which this read excludes.) So the
   * bucketing needs no rule about which side of a window boundary a day-stamp
   * falls: `slotOf` places each row at the moment it actually happened, exactly
   * as it places an issue.
   */
  date: string;
  minutes: number;
  /** Net billed USD — gross less whatever the included allowance absorbed. */
  netUsd: number;
}

/**
 * What CI cost in one rolling 7-day window.
 *
 * `netUsd` is the measure; `minutes` rides beside it for one reason only, and
 * it is the reason this pair exists at all: net cost is zero both for a repo
 * that ran nothing and for a repo whose real work the included-minutes
 * allowance absorbed. Measured, acme/acme-docs ran 63, 293 and 94
 * minutes in three consecutive weeks and was billed $0.00 for all three. Minutes
 * are what tells those two apart:
 *
 *   minutes === 0            → nothing ran
 *   minutes > 0, netUsd === 0 → it ran, and cost nothing
 *   netUsd > 0                → it ran, and cost money
 *
 * Minutes are NOT a second trend and must not be drawn as one.
 */
export interface RepoCiWindow {
  minutes: number;
  netUsd: number;
}

/** A repo's CI spend per window, or the read that did not answer. `weeks` is
 *  REPO_WEEKS long, oldest → newest, aligned to `RepoRow.weeks`. */
export type RepoCiSpend =
  | { state: 'read'; weeks: RepoCiWindow[] }
  | { state: 'unreadable' };

/** One of this repo's open issues, off the shared org-wide ingest — no per-repo
 *  issue fetch for the page (#257).
 *
 *  There is no `state` and no `closedAt` here (#826): every row is open, so both
 *  could only ever hold one value, and a field with one possible value is a
 *  thing every reader has to check is still true. */
export interface RepoOpenIssue {
  number: number;
  title: string;
  htmlUrl: string;
  createdAt: string;
  author: string | null;
  labels: string[];
}

/** Who works on this repo, derived from the issues and pull requests this page
 *  already read (#828). NOT GitHub collaborators: measured 2026-09-03, that
 *  list is the same three logins on all 8 acme repos sampled (octocat,
 *  IvanRoslov, anton-khovanskiy), so an access list would draw one identical
 *  answer on every repo page on the board. */
export interface RepoMember {
  login: string;
  /** Through the same team roster `ownerOf` names a DRI with, or null for a
   *  login the roster does not carry. Never invented. */
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

/** The list, plus what could not be counted into it (#828). */
export interface RepoMembers {
  people: RepoMember[];
  /** True when the PR read came back `unreadable`, so `openedPrs` is 0 for
   *  everybody and somebody active only in pull requests is missing entirely.
   *  The tab says this in words; it never draws a short list as a complete one.
   *
   *  It is a field rather than an empty list for the reason every union on this
   *  surface exists: absent, zero and unreadable are three answers, and a list
   *  that cannot tell the second from the third reports an outage as a repo
   *  nobody works on. */
  prsUnreadable: boolean;
}

/** A comparison value: an earlier total or a change, as its field specifies.
 * `none` means the repo is too young for that comparison; `unknown` means the
 * read cannot establish it. Neither may be drawn as zero. */
export type RepoPrior =
  | { state: 'read'; value: number }
  | { state: 'none' }
  | { state: 'unknown' };

/** Each Overview figure one period back, so the page can say how it moved
 *  (#962). The two open counts are the counts at the moment the window opened,
 *  which is where the previous period ends; the spend is the total over the
 *  REPO_WEEKS before the window, the same length as the one the page draws. */
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

/**
 * GET /api/repos/:owner/:name/page (#575) — everything one repo's page draws.
 *
 * `repo` is the map's own row, not a second derivation of it: identity, the
 * issue weeks, the open count and the owner all come from `rollUpRepos`, so the
 * page and the tile can never disagree about the same repo.
 *
 * The three reads the page adds each degrade on their own: losing the README
 * costs the README. None of them can blank the page, and none of them touches
 * the map's own path (#571).
 */
export interface RepoPageView {
  /** Latest completed day versus the preceding day, independent of previous. */
  completedDayChange: RepoCompletedDayChange;
  /** The ingest's freshness, exactly as `ReposView.updatedAt` reports it — the
   *  age of the counts, not the moment of the request. */
  updatedAt: string;
  repo: RepoRow;
  readme: RepoReadme;
  pullRequests: RepoPrFlow;
  ciSpend: RepoCiSpend;
  /** Every open issue in this repo, newest-created first, capped at
   *  OPEN_ISSUES_CAP. Was five until #828, when the Issues tab took over from
   *  the five-row Overview block: the cap is the payload's limit, not a claim
   *  about how many matter. A repo whose issues are all closed is empty here,
   *  and that is the right answer: nothing is left to do on it.
   *
   *  Empty is a fact about the repo only when `openIssuesState` says `read`.
   *  Under `unreadable` this is empty because nobody could look, and the two
   *  must never draw the same (#837). */
  openIssues: RepoOpenIssue[];
  /** The same array as `openIssues`, under the name it carried before #826.
   *
   *  #838 asks for this name to go, and its own Done-when is "the payload
   *  carries one name for the list, and no reader of the old name is left
   *  running". #826 shipped the rename on 2026-09-03, so the second clause has
   *  had about a day — and it is not a clause about a deploy. Every bundle is
   *  content-hashed and served `max-age=31536000, immutable` with no service
   *  worker and no version poll, so a tab opened before the rename keeps that
   *  bundle until somebody hard-reloads it. The pre-#826 body reads
   *  `view.recentIssues.length` unguarded, and the page's error boundary has no
   *  fallback: such a reader gets an empty body with no message and nothing to
   *  press. So the field stays and #838 stays open, until enough time has passed
   *  that no reader of the old name is left running.
   *
   *  Only the container name does that. The rows losing `state` and `closedAt`
   *  degrades cleanly in an old bundle — `undefined === 'closed'` is false, and
   *  the age falls back to the opening — so neither field comes back, and this
   *  is the whole of the compatibility.
   *
   *  It is a duplicate on purpose, and it carries OPEN issues despite its name.
   *  `buildPage` assigns both from one `openIssuesFor` call, so the two are one
   *  array by construction and cannot drift. */
  recentIssues: RepoOpenIssue[];
  /**
   * Whether the ingest actually READ this repo's issues (#837) — the third
   * answer the issue block was missing, and the one the three cards beside it
   * have had since #575.
   *
   * `GithubIssuesSource.fetchRepo` swallows a per-repo failure as
   * `{ ok: false, issues: [] }`, and `listIssues` throws only when EVERY repo
   * failed, so one repo losing its pagination to a secondary rate limit resolves
   * the org's ingest with that repo contributing no rows. `repo.open` is rolled
   * up from the same ingest and reads zero too, so the two agree and neither can
   * tell that read apart from a repo with nothing left to do: the page drew
   * "No open issues." as a positive fact about a queue it never read. Before
   * #826 that line was about issue history, a smaller claim; the rename made it
   * a claim about what is still to be done.
   *
   * It is a SIBLING field rather than a union around the list, and that is a
   * deploy decision rather than a taste one. board-web and board-api ship from
   * `main` independently, and `deploy/Caddyfile.platform` serves the bundles
   * `immutable`, so a tab already open holds its bundle until somebody hard
   * reloads. A bundle that maps over `openIssues` would meet an object and throw
   * inside the render, and the page's boundary draws nothing at all — which is
   * #838's whole story, one release earlier. An unknown extra field costs an old
   * bundle nothing.
   *
   * `unreadable` is stated positively and only from an `ok: false` the ingest
   * actually recorded. A source that cannot report per-repo outcomes reports
   * none, and every page then reads `read` exactly as it does today: an invented
   * failure would put "could not be read" over a queue that was read perfectly
   * well, which is the same defect pointing the other way.
   */
  openIssuesState: 'read' | 'unreadable';
  /** Who works on this repo, and whether the PR half of that could be read
   *  (#828). Derived from the issues and the pull requests already on this
   *  payload — no read of its own. */
  members: RepoMembers;
  /** The three Overview figures one period back (#962). The issue count comes
   *  off the ingest and the PR count off this page's own PR read, so neither
   *  costs a request; the spend is the one that needed the billing read to cover
   *  twice the window. */
  previous: RepoPreviousPeriod;
}

/** GET /api/repos. `updatedAt` is the age of the ingest the counts came from,
 *  not the moment of the request — the same freshness truth the metrics tell. */
export interface ReposView {
  updatedAt: string;
  repos: RepoRow[];
  /**
   * The `owner` property's allowed values for the org this view describes. Empty
   * when the schema cannot be read, and when the org has no such property.
   *
   * On a NARROWED view (`?org=X`) that is X's own list and is exact: every
   * value in it is a value X's `owner` property accepts, spelled as X spells it.
   *
   * On the UNION view it is every served org's values, concatenated in
   * `servedOrgs` order with EXACT duplicates dropped (#614, #697, #718) — and it
   * is NOT a list any one org accepts, so a picker offering it may offer a login
   * the target org's write gate refuses, and that press 400s. `driOptionsByOrg`
   * is the exact answer, and is what a picker should read once it knows which
   * repo it is setting.
   */
  driOptions: string[];
  /** Each served org's own allowed values, keyed by the org in its CONFIGURED
   *  spelling (#718) — the exact list the write gate for that org compares
   *  against, so a client that knows which repo it is setting can offer values
   *  that cannot 400. A narrowed view carries the one org it describes; the
   *  union view carries EVERY served org, including the ones nothing could be
   *  read for: `driSchema` never throws, so an org whose schema read failed is
   *  present here carrying `[]`.
   *
   *  So an empty list is two answers in one — the schema could not be read, or
   *  the org has no such property — and what tells them apart is
   *  `ownerWritability` below. */
  driOptionsByOrg: Record<string, string[]>;
  /** What the board knows about setting a repo's owner (#577), from the same
   *  schema call `driOptions` comes out of. A surface draws no control it KNOWS
   *  cannot work (`restricted`, `absent`) — but `unreadable` is not knowing,
   *  and hiding a feature on a failed read would hide it on a blip.
   *
   *  On the union view this is a fail-closed fold over every served org: the
   *  first state that is not `writable` wins. A narrowed view carries that
   *  org's own state, and so does the write gate — neither is judged by the
   *  fold. */
  ownerWritability: OwnerWritability;
  /** The orgs this answer is MISSING, in configured order (#718) — the ones
   *  whose repo enumeration failed, so none of their repos are in `repos` at
   *  all. Empty is the ordinary case.
   *
   *  It is here because `repos` cannot say it: a lost org and an org with no
   *  repos both contribute no rows. A narrowed read for one of these orgs is a
   *  503 rather than an empty 200 — there is genuinely nothing to serve for it,
   *  and 200-with-nothing is a claim that the org is empty. */
  unreadableOrgs: readonly string[];
}

/** Demand-loaded grid spend; shares the repo page's billing cache. */
export interface ReposCiSpendView {
  repos: { full: string; ciSpend: RepoCiSpend }[];
}

/** Demand-loaded grid PR flow; no background polling. */
export interface ReposPrFlowView {
  repos: { full: string; pullRequests: RepoPrFlow }[];
}
