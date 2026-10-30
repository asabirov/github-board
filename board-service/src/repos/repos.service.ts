import { githubPrincipal, personalOwner, PrincipalState } from '../auth/github-principal';
import { Inject, Injectable, Logger, NotFoundException, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { feedbackScopeFrom, type FeedbackScope } from '../auth/feedback-visibility';
import { IssuesCacheService } from '../issues-metrics/issues-cache.service';
import type { RawIssue } from '../issues-metrics/issues-metrics.types';
import { GithubLoginResolver } from '../identity/github-login.resolver';
import { REPO_WEEKS, rollUpRepos } from './repo-rollup';
import {
  COMPARED_WEEKS,
  ciSpendWindows,
  completedDayChange,
  completedDayEnd,
  membersFor,
  monthsSpanning,
  openIssuesFor,
  previousPeriod,
  pullRequestWindows,
  windowStart,
} from './repo-page';
import { mapLimit } from '../issues-metrics/github-issues.source';
import {
  ActionsUsageRead,
  DriSchema,
  IReposSource,
  OwnerWritability,
  REPOS_SOURCE,
  RepoDescriptor,
  RepoCiSpend,
  ReposCiSpendView,
  ReposPrFlowView,
  RepoPrRead,
  RepoOwner,
  RepoPageView,
  RepoRow,
  RepoReadme,
  RepoSecurity,
  ReposHealthView,
  ReposView,
  UsageMonth,
} from './repo.types';

/** Every row starts at zero, so a repo absent from the security map reads as
 *  "no alerts" rather than undefined. A factory, not a shared constant — two
 *  rows must never be able to alias (and so mutate) the same record. */
const NO_ALERTS = (state: RepoSecurity['state']): RepoSecurity => ({
  depHigh: 0,
  depModerate: 0,
  codeScanning: 0,
  secrets: 0,
  secretsUrl: null,
  state,
});

/**
 * One repo's alert row, and whether ITS org went unread (#718).
 *
 * The state is decided by the ORG, never by whether a row came back. An org
 * whose code-scanning list refused while its Dependabot list answered has BOTH
 * real rows in `SecurityRead.byRepo` and its name in `unreadableOrgs`, so a row
 * taken as it stands carries `state: 'read'` over a `codeScanning: 0` nobody
 * read — the partly-clean answer that one `state` per row exists to prevent.
 * Patching only the ABSENCES caught the repos with nothing open and missed
 * exactly the repos that did have something, which is the wrong half.
 *
 * A fresh record whenever the state is rewritten, so no two rows can alias (and
 * so mutate) one — the same rule `NO_ALERTS` follows.
 */
const securityFor = (read: RepoSecurity | undefined, orgUnread: boolean): RepoSecurity => {
  if (read === undefined) return NO_ALERTS(orgUnread ? 'unreadable' : 'read');
  return orgUnread ? { ...read, state: 'unreadable' } : read;
};

/** One month of the billing report, as a key the usage cache can compare its
 *  coverage on. */
const monthKey = (m: UsageMonth): string => `${m.year}-${m.month}`;

/** The org half of a repo's `owner/name`, folded. Every org comparison on this
 *  surface runs through it: Github org names are case-insensitive, and the two
 *  sides always come from different reads — a configured org against the owner
 *  Github spells into a repo's full name. */
const orgOf = (full: string): string => full.split('/')[0].toLowerCase();

/** A join key for a map Github filled in and a `full` this board composed. The
 *  two sides come from different reads — `full` carries the org as the
 *  DEPLOYMENT spelled it, while `driByRepo` and `securityByRepo` key off the
 *  owner as GITHUB spells it — and Github org names are case-insensitive, so
 *  `GITHUB_ORGS=Acme` joined exactly blanks every owner and every alert
 *  count on the board with nothing anywhere saying so. `full` itself is never
 *  folded: it is the canonical key the client joins the map and the health
 *  payload on, and rewriting it would move the defect rather than close it. */
const joinKey = (full: string): string => full.toLowerCase();

/** The same map, rekeyed for `joinKey`. One pass at build time rather than a
 *  fold at every lookup, so the two joins below cannot drift apart. */
function byJoinKey<T>(m: Map<string, T>): Map<string, T> {
  return new Map([...m].map(([k, v]) => [joinKey(k), v]));
}

/** How many per-org reads the service may have out at once. The same bound
 *  `GithubReposSource` puts on every one of its own fan-outs; named here rather
 *  than imported because that one is private to the source, and a service-side
 *  pool sized by a source-side constant would be two files agreeing by
 *  coincidence. */
const ORG_CONCURRENCY = 8;

/** Two lists of orgs as one, deduplicated case-insensitively and keeping the
 *  first spelling seen — both come from the source's own configured list, so
 *  they agree on spelling in practice and the fold is what makes that a fact
 *  rather than an assumption. */
function mergeOrgs(a: readonly string[], b: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const org of [...a, ...b]) {
    const folded = org.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(org);
  }
  return out;
}

/** Refuse a narrowed read for an org this build has nothing for (#718).
 *
 * `?org=X` on an org whose enumeration failed would otherwise answer `200
 * {"repos":[]}` — indistinguishable from an org that genuinely has no repos,
 * and a 200 saying so is a claim rather than a gap. The union view states the
 * loss in `unreadableOrgs`; a narrowed one has no room to, because every row it
 * could carry belongs to the org that is missing.
 *
 * 503 and not 404: the org IS served, and asking again later is the right
 * thing to do. A 404 would say this board does not cover it, which is the
 * gate's answer to a different question.
 */
function assertServable(unreadableOrgs: readonly string[], org: string): void {
  const folded = org.toLowerCase();
  if (unreadableOrgs.some((o) => o.toLowerCase() === folded)) {
    throw new ServiceUnavailableException(`the repo listing for ${org} could not be read`);
  }
}

/**
 * The `dri` values the UNION view offers: every served org's, in servedOrgs
 * order, with EXACT duplicates dropped (#718).
 *
 * Exact and not case-insensitive: the write gate compares a login against ONE
 * org's allowed values with `a === login` (`capability/write-envelope.ts`), so
 * folding `OCTOCAT` away because `octocat` was seen first would leave the
 * union carrying only a spelling the other org's guard refuses. The union is not
 * a list any org accepts; `driOptionsByOrg` is the exact answer. See
 * `ReposView`.
 */
function unionDriOptions(schemas: readonly DriSchema[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const schema of schemas) {
    for (const value of schema.allowedValues) {
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * What the UNION view says about writing an owner, over several orgs (#718).
 *
 * `writable` only when EVERY served org is writable, and otherwise the state of
 * the FIRST org that is not — fail-closed, and named rather than summarised, so
 * the client draws the reason it already knows how to draw. A union view that
 * said `writable` because one org of two allows the write would offer a control
 * that is barred for half the map, and the refusal would arrive as a 403 on the
 * press.
 *
 * No served org at all answers `unreadable`: nothing was asked, so nothing is
 * known, and that is the state that means exactly that. It must not be
 * `writable` — an operator who turned enumeration off is not an operator
 * granting a write.
 */
function foldWritability(schemas: readonly DriSchema[]): OwnerWritability {
  if (schemas.length === 0) return 'unreadable';
  return schemas.find((s) => s.writability !== 'writable')?.writability ?? 'writable';
}

/**
 * One org's slice of the union map (#718).
 *
 * The rows are filtered on the org half of each `full`, which is the only place
 * a row records which org it came from — and it is enough, because the map is
 * built from `owner/name` descriptors and nothing downstream drops the owner.
 *
 * `driOptions` and `ownerWritability` come from THAT org's own schema rather
 * than from the union's fold, so a narrowed answer is exact: a reader who asked
 * for one org is not shown a restriction that belongs to another. An org with
 * no schema in hand reads `unreadable` — the state that says the board did not
 * find out — never `writable`.
 */
function narrowView(view: ReposView, schemas: Map<string, DriSchema>, org: string): ReposView {
  assertServable(view.unreadableOrgs, org);
  const folded = org.toLowerCase();
  const schema = schemas.get(folded);
  return {
    updatedAt: view.updatedAt,
    // Nothing: the only org that could appear here is the one asked for, and
    // `assertServable` has already refused that case above.
    unreadableOrgs: [],
    // The one org this answer describes, in the spelling the caller resolved it
    // to — which is the configured spelling, because the gate and
    // `ownerWriteEnv` both resolve against `servedOrgs`.
    driOptionsByOrg: schema ? { [org]: schema.allowedValues } : {},
    driOptions: schema ? schema.allowedValues : [],
    ownerWritability: schema ? schema.writability : 'unreadable',
    repos: view.repos.filter((r) => orgOf(r.full) === folded),
  };
}

/** One org's slice of the union health payload — the same filter on the same
 *  `full`, so a client joining the two on that key gets one org's rows on both
 *  sides or neither. */
function narrowHealth(view: ReposHealthView, org: string): ReposHealthView {
  const folded = org.toLowerCase();
  return {
    // Filtered rather than emptied: an org whose ALERT lists failed still has
    // rows here, all of them zeroed, and the narrowed reader is the one who
    // most needs to be told those zeros were never read. The org whose LISTING
    // failed never reaches this — `listHealth` refuses it.
    unreadableOrgs: view.unreadableOrgs.filter((o) => o.toLowerCase() === folded),
    repos: view.repos.filter((r) => orgOf(r.full) === folded),
  };
}

/** The `dri` writability states that came out of a schema Github ACTUALLY
 *  answered, and so will not change until the org's settings do. Everything
 *  else is the board admitting it did not find out, and re-reading is the only
 *  way out of it (#649).
 *
 *  Named ONCE, here, rather than tested state-by-state at each site: the union
 *  gained two members at #649, and the branch that would have been forgotten is
 *  whichever caller kept comparing against `'unknown'` alone.
 *
 *  A `Record` KEYED by the union, so adding a sixth state to `OwnerWritability`
 *  without deciding which side it falls on fails to compile: `TS2741`, the
 *  property missing from the record type. This was a `Set` until the #649
 *  security review, and the same sentence was false of it — `new
 *  Set<OwnerWritability>([…])` takes any subset of the union and compiles
 *  clean, so the one place a reader was told to look for the guarantee was the
 *  place that did not have it. */
const SETTLED_WRITABILITY: Record<OwnerWritability, boolean> = {
  'not-applicable': true,
  writable: true,
  restricted: true,
  absent: true,
  unreadable: false,
  unknown: false,
};
const isSettled = (w: OwnerWritability): boolean => SETTLED_WRITABILITY[w];

/** How far past its TTL a SERVED answer may drift before it says so (#611).
 *
 *  Stale-while-revalidate hides a failing refresh behind a cache that still
 *  answers. The window in which the board draws facts from before the last
 *  successful read is bounded by one TTL only while refreshes SUCCEED — past
 *  that it is unbounded, and, without this, silent. The same constant and the
 *  same warn-once shape as `IssuesCacheService.STALE_INDEX_TTLS`. */
const STALE_SERVE_TTLS = 3;

/** One resolved core read: the map, the descriptors it was built from, and the
 *  id of this particular build — the health payload records that id so it can
 *  tell whether it still describes the map being served. */
interface CoreRead {
  /** Which build of the map this is. A counter, NOT a timestamp: two rebuilds
   *  can land in the same millisecond — a sync straight after a write does it
   *  routinely — and a clock reading would then say two different maps were the
   *  same one. */
  build: number;
  data: ReposView;
  descriptors: RepoDescriptor[];
  /** The moment this build bucketed its weeks against. The repo page draws its
   *  PR flow and its CI spend on the map's windows, so it has to bucket against
   *  the same `now` the rows did — a page that used its own clock would put
   *  three series on one screen that disagree about where a week starts (#575).
   *  NOT `data.updatedAt`, which is the ingest's age, a different fact. */
  at: number;
  /** The issue snapshot this build was rolled up from, so the page's open
   *  issues, the row's weekly counts and `updatedAt` all describe one moment.
   *  The same array the shared cache holds — no copy, and no second fetch. */
  issues: RawIssue[];
  /** Every repo whose OWN issue fetch failed on the ingest this build read,
   *  as a lower-cased `owner/name` (#837).
   *
   *  A set of the failures rather than a per-repo state, because that is the
   *  only positive fact the ingest states: `repoOutcomes` is empty for a source
   *  that cannot say, and a repo missing from it is one the ingest never asked
   *  about, not one Github refused. Membership here is therefore the ONLY thing
   *  that makes a page say "could not read", and every other repo keeps the
   *  answer it has today.
   *
   *  It is folded into a set here, once per build, rather than scanned per page:
   *  the ingest lists ~70 repos and every repo page would otherwise walk it. */
  unreadRepos: ReadonlySet<string>;
  /** Successful repo reads mapped to the ingest snapshot’s coverage time. */
  readIssueRepos: ReadonlyMap<string, number>;
  /** Every org whose issue ENUMERATION failed on the ingest this build read,
   *  lower-cased (#837).
   *
   *  The same defect as `unreadRepos` one level up, and it cannot be expressed
   *  by that set: an org that never enumerated contributes NO repos to the
   *  ingest, so none of its repos appears in `repoOutcomes()` at all — and
   *  absent there means "never asked", which every page reads as `read`. The
   *  repo LISTING is a different read from a different source, so those repos
   *  are still on the map and still openable, and a whole org's worth of pages
   *  would say "No open issues." about queues nobody read.
   *
   *  It takes two configured orgs to reach: `resolveScope` throws when the scope
   *  comes to nothing, so a single-org deployment loses the ingest outright
   *  rather than serving it half-read. `ReposView.unreadableOrgs` is a different
   *  set with a different meaning — it is the LISTING's losses, and it makes a
   *  page 503 rather than qualifying its issue block. */
  unreadIssueOrgs: ReadonlySet<string>;
  /** Each served org's own `dri` schema, keyed by the FOLDED org name (#718).
   *
   *  Service state, deliberately not payload: `ReposView` carries ONE
   *  `driOptions` and ONE `ownerWritability`, the union of these, and gains no
   *  per-org map — nothing downstream reads one. What this is for is the two
   *  answers the union cannot give: a `?org=X` read, whose options and
   *  writability must be X's alone and not a fold over orgs the reader did not
   *  ask about, and `ownerWriteEnv(X)`, which gates a write to X and would
   *  otherwise refuse it because a DIFFERENT org restricts the property. */
  schemas: Map<string, DriSchema>;
}

/**
 * The Repos map (#472), served in two pieces since #571.
 *
 * The CORE — what `GET /api/repos` awaits — is the map itself: the repo list,
 * the shared issue ingest, ownership and the roster. Only one of those touches
 * Github per view:
 *
 * - the counts come from the shared raw-issues cache — the SAME org-wide ingest
 *   the throughput/aging metrics and the Projects pulse read (#257/#391), rolled
 *   up per repo here. No second fetch, and no per-repo call.
 * - the repo list and every repo's owner come from the pluggable source, both on
 *   the view's TTL. Ownership is the `dri` org custom property, which the source
 *   reads for the whole org in ONE call (#548) — so unlike the per-repo
 *   CODEOWNERS sweep it replaced, it needs no cache of its own to be affordable.
 *
 * The HEALTH read — `GET /api/repos/health` — is the other piece: open security
 * alerts and the default branch's latest CI conclusion. Measured cold against
 * the live org (78 repos): security 14-17 s and CI 3.5 s, against 1.3 s for the
 * repo listing. Awaiting them inside the map's own refresh is what made a cold
 * page take ~29 s, and both are decorations on a page whose subject is the repo
 * list — so they are cached apart, off the core's own descriptors, and the map
 * no longer waits on either.
 *
 * With authentication disabled both caches are warmed at boot (`onModuleInit`).
 * Signed-in readers fill their own caches on demand. Both are served stale-while-revalidate
 * (#611): past the TTL the held answer goes back at once and the refresh runs
 * behind the reader, so the visitor who happens to arrive first after a
 * boundary no longer pays the ~1.2 s map read or the ~18 s health one for
 * everybody else. What that shape must never cover is a change the board
 * itself made — a write, a Sync now, an admin edit to a roster name — and each
 * of those takes the waiting path instead; see `core()` and `listHealth()`.
 *
 * Sync now (#301) calls `resync()`, which drops the view and re-warms, so a
 * reassigned `dri` or a new repo lands on the next view rather than a TTL later.
 */
@Injectable()
export class ReposService implements OnModuleInit {
  /** The map itself, kept across an access re-check that found nothing changed,
   *  for no longer than the map's TTL (#1007); any change of the person's
   *  visibility empties it. See `PrincipalState`. Only the map: the health
   *  payload, the repo pages and the org's billing are on `principalState` below
   *  and still start cold at every re-check, because alerts and billing turn on
   *  grants nobody approved keeping. `epoch` and `builds` sit with the map
   *  because both describe its builds. */
  private readonly mapState = new PrincipalState(() => ({
    view: null as {
    at: number;
    build: number;
    generation: number;
    data: ReposView;
    descriptors: RepoDescriptor[];
    issues: RawIssue[];
    unreadRepos: ReadonlySet<string>;
    readIssueRepos: ReadonlyMap<string, number>;
    unreadIssueOrgs: ReadonlySet<string>;
    schemas: Map<string, DriSchema>;
  } | null,
    inFlight: null as Promise<CoreRead> | null,
    epoch: 0 as number,
    builds: 0 as number
  }), { maxAgeMs: () => this.ttlMs });
  private readonly principalState = new PrincipalState(() => ({
    health: null as {
    coreBuild: number;
    at: number;
    fulls: Set<string>;
    data: ReposHealthView;
  } | null,
    healthInFlight: null as { build: number; read: Promise<ReposHealthView> } | null,
    pages: new Map<string, { coreBuild: number; data: RepoPageView }>() as Map<string, { coreBuild: number; data: RepoPageView }>,
    pagesInFlight: new Map<string, { build: number; read: Promise<RepoPageView> }>() as Map<string, { build: number; read: Promise<RepoPageView> }>,
    prReads: new Map<string, { build: number; read: Promise<RepoPrRead> }>(),
    usage: null as { at: number; months: Set<string>; data: ActionsUsageRead } | null,
    usageInFlight: null as { at: number; months: Set<string>; read: Promise<ActionsUsageRead | null> } | null,
    warnedStale: { map: false, health: false } as { map: boolean; health: boolean }
  }));
  private readonly logger = new Logger(ReposService.name);
  private readonly ttlMs: number;
  /** `generation` is the roster generation the owner NAMES in `data` were built
   *  at. The view is derived from the roster, so an admin edit has to age it out
   *  the same way the clock does — otherwise a corrected name waits out this
   *  TTL, and `identity.controller.ts` promises in writing that it will not.
   *  `descriptors` is kept beside the data because the health read needs the
   *  exact repo list this view was built from — including each repo's default
   *  branch, which `RepoRow` does not carry — and must not fetch a second,
   *  possibly divergent, listing to get it. */
  private get view(): {
    at: number;
    build: number;
    generation: number;
    data: ReposView;
    descriptors: RepoDescriptor[];
    issues: RawIssue[];
    unreadRepos: ReadonlySet<string>;
    readIssueRepos: ReadonlyMap<string, number>;
    unreadIssueOrgs: ReadonlySet<string>;
    schemas: Map<string, DriSchema>;
  } | null { return this.mapState.current.view; }
  private set view(value: {
    at: number;
    build: number;
    generation: number;
    data: ReposView;
    descriptors: RepoDescriptor[];
    issues: RawIssue[];
    unreadRepos: ReadonlySet<string>;
    readIssueRepos: ReadonlyMap<string, number>;
    unreadIssueOrgs: ReadonlySet<string>;
    schemas: Map<string, DriSchema>;
  } | null) { this.mapState.current.view = value; }
  /** Dedupes concurrent refreshes — a cold map is a repo listing plus an
   *  ownership read, which must not run twice because two people opened the
   *  page at once. */
  private get inFlight(): Promise<CoreRead> | null { return this.mapState.current.inFlight; }
  private set inFlight(value: Promise<CoreRead> | null) { this.mapState.current.inFlight = value; }
  /**
   * The health cache. Its FAILURE is separate from the view's — losing these
   * two facts costs these two facts — but its BUILD is not: it is made from the
   * core's descriptors, so a core that cannot be read takes the health read
   * down with it.
   *
   * What binds it to the map is SET COVERAGE, not build identity (#611).
   * `coreBuild` still names the build it was made from, and a match serves it
   * outright; when the map has moved on, `fulls` — one key per row, the same
   * `full` the client joins on — is checked against the descriptors of the build
   * being served, and the payload is served only if it has a row for every one
   * of them, while a refresh for the new build runs behind the reader.
   *
   * That keeps the guarantee this cache exists for — "every repo on the current
   * map has a row here" — while dropping the part of it that cost a visitor
   * ~18 s: a map rebuilt for a repo the health payload ALREADY describes changes
   * nothing the client can see, because a row missing from a settled payload is
   * drawn as CLEAN (`repos-vm.ts` maps an absent row to the default), never as
   * "not known yet". A repo that newly appeared fails coverage, and that reader
   * waits — which is exactly the case that must not be served stale.
   *
   * There is still deliberately no second TTL. `at` is the moment of the build
   * this was made from, and it is used for one thing only: saying so, once, when
   * what is being served has drifted past `STALE_SERVE_TTLS` because the
   * refreshes behind it keep failing.
   */
  private get health(): {
    coreBuild: number;
    at: number;
    fulls: Set<string>;
    data: ReposHealthView;
  } | null { return this.principalState.current.health; }
  private set health(value: {
    coreBuild: number;
    at: number;
    fulls: Set<string>;
    data: ReposHealthView;
  } | null) { this.principalState.current.health = value; }
  /** The in-flight health read, and the map build it is being made FOR. The
   *  build is not decoration: an answer built against an older map must not be
   *  handed to a caller asking about the current one, or a page and the map it
   *  sits beside disagree about the same repo for the length of one read. */
  private get healthInFlight(): { build: number; read: Promise<ReposHealthView> } | null { return this.principalState.current.healthInFlight; }
  private set healthInFlight(value: { build: number; read: Promise<ReposHealthView> } | null) { this.principalState.current.healthInFlight = value; }
  /**
   * One entry per repo page that has been asked for, keyed by the lowercased
   * `owner/name`, and bound to the map build it was made from exactly as the
   * health payload is. Same reasoning, and the same single freshness rule: a
   * page describes a map, so when that map is replaced the page is rebuilt
   * rather than served on beside a newer one.
   *
   * A page is built only when someone asks for one. Nothing here is warmed at
   * boot: the map is what a visitor lands on, and warming 78 repo pages would
   * spend a per-repo README and PR read on each of them to save one visitor a
   * second on a page most of them will never open.
   */
  private get pages(): Map<string, { coreBuild: number; data: RepoPageView }> { return this.principalState.current.pages; }
  private set pages(value: Map<string, { coreBuild: number; data: RepoPageView }>) { this.principalState.current.pages = value; }
  /** Keyed the same way as `pages`, and carrying the build each read is being
   *  made FOR — see `healthInFlight`. A dedupe that ignored the build would
   *  answer a request about the current map with a page built against the
   *  previous one, showing a pre-edit owner beside a map already showing the
   *  new one. */
  private get pagesInFlight(): Map<string, { build: number; read: Promise<RepoPageView> }> { return this.principalState.current.pagesInFlight; }
  private set pagesInFlight(value: Map<string, { build: number; read: Promise<RepoPageView> }>) { this.principalState.current.pagesInFlight = value; }
  /**
   * The org's Actions usage, read ONCE for every repo page (#575).
   *
   * The billing report answers for the whole organization — a row per repo per
   * day — so this is org-wide state, not per-page state, and a repo page must
   * never trigger a read of its own. It is not bound to a map build: it
   * describes the org's spend, which has nothing to do with which repos are on
   * the map, and rebuilding the map is not a reason to pay the billing calls
   * again. Its `at` IS a map build's moment, though — the caller passes the
   * build's clock so every window on the page shares one — so this is a stamp
   * taken from a build, not a stamp independent of one.
   *
   * `months` is what makes age alone insufficient. A cached array covers the
   * months it was FETCHED for, and `ciSpendWindows` pre-fills every window and
   * only adds to it — so serving a young array that is missing a month draws
   * that month's windows as `minutes: 0`, which the page defines as "nothing
   * ran". There is no `coveredFrom` here to catch it, so the coverage is
   * checked before the cache is served instead.
   *
   * A FAILED read is never cached — see `actionsUsage`.
   */
  private get usage(): { at: number; months: Set<string>; data: ActionsUsageRead } | null { return this.principalState.current.usage; }
  private set usage(value: { at: number; months: Set<string>; data: ActionsUsageRead } | null) { this.principalState.current.usage = value; }
  /**
   * The billing read that is out, and the months it ASKED FOR (#718).
   *
   * The months are not decoration, for exactly the reason `usage` records them:
   * this cache is served on coverage as well as age, and a slot handed over
   * without that test gives a caller a report missing a month it needs. That
   * month draws as `minutes: 0` — the page's own spelling of "nothing ran" —
   * and `buildPage` then caches the page, because every section of it reports
   * `read`. Two builds straddling a month boundary is the ordinary shape here:
   * stale-while-revalidate keeps a build alive past its TTL, and a roster edit
   * rebuilds the map without dropping this cache.
   *
   * The same shape, and the same reason, as `healthInFlight`: an in-flight
   * answer may only be shared with a caller it actually covers.
   */
  private get usageInFlight(): { at: number; months: Set<string>; read: Promise<ActionsUsageRead | null> } | null { return this.principalState.current.usageInFlight; }
  private set usageInFlight(value: { at: number; months: Set<string>; read: Promise<ActionsUsageRead | null> } | null) { this.principalState.current.usageInFlight = value; }
  /**
   * Bumped whenever a cached answer is declared out of date. Every refresh
   * captures it before it reads and writes its cache only if it has not moved.
   *
   * Nulling a cache is not enough on its own: a refresh that was already out
   * holds no reference to the slot it was going to fill, so it would land
   * afterwards and overwrite the fresher answer with what it read BEFORE the
   * sync or the write — with a timestamp that says it is current. That is a
   * whole TTL of a page confidently showing pre-sync facts.
   */
  private get epoch(): number { return this.mapState.current.epoch; }
  private set epoch(value: number) { this.mapState.current.epoch = value; }
  /** Monotonic id of the last map build — see `CoreRead.build`. */
  private get builds(): number { return this.mapState.current.builds; }
  private set builds(value: number) { this.mapState.current.builds = value; }
  /** One latch per stale-while-revalidate cache, so the warning below announces
   *  a state change rather than repeating on every request — and announces it
   *  again if the cache recovers and drifts a second time. */
  private get warnedStale(): { map: boolean; health: boolean } { return this.principalState.current.warnedStale; }
  private set warnedStale(value: { map: boolean; health: boolean }) { this.principalState.current.warnedStale = value; }
  /** The repo the old feedback form filed into, and the labels it stamped (#836) —
   *  built through the one parser, so this cannot drift from what the words rule
   *  reads. The repo page is a shared, viewer-less payload, so
   *  it is the scope alone that decides which titles it may carry. */
  private readonly feedback: FeedbackScope;

  constructor(
    // Explicit token via the module factory — tsx/esbuild emit no param metadata,
    // so an inferred param would crash the compiled boot (see the DI note).
    @Inject(REPOS_SOURCE) private readonly source: IReposSource,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(IssuesCacheService) private readonly issuesCache: IssuesCacheService,
    @Inject(GithubLoginResolver) private readonly githubLogins: GithubLoginResolver,
  ) {
    this.ttlMs = config.get<number>('REPOS_CACHE_TTL_MS', 600_000);
    this.feedback = feedbackScopeFrom(config);
  }

  /**
   * Warm both caches at boot so the first visitor never eats the cold reads —
   * the same pattern, and the same reasoning, as `IssuesCacheService`.
   *
   * Un-awaited and swallowed into a warning on purpose: a Github outage at boot
   * must never stop board-api starting.
   *
   * The map goes first and the health second, sequenced on the map warm having
   * SETTLED rather than on it having succeeded. Chaining the second off the
   * first's success would drop the health warm entirely whenever a blip lost the
   * map warm, and the first visitor would then pay the ~18 s read this split
   * exists to remove. `listHealth()` resolves the map itself, so the second warm
   * is a genuine retry of the first.
   */
  onModuleInit(): void {
    // Signed-in reads use person-scoped state; only auth-disabled readers use this warm.
    if (!this.config.get<boolean>('AUTH_DISABLED', false)) return;
    void this.warm('map', () => this.listRepos()).then(() =>
      this.warm('health', () => this.listHealth()),
    );
  }

  /**
   * Run one boot warm and say so in the log either way — including how long it
   * took. A warm that announced only its failures left "the cache was warm at
   * boot" a thing you infer from a stopwatch rather than a thing the log states.
   *
   * Never rejects: the caller sequences on settlement, and an unhandled
   * rejection at boot is exactly what must not happen here.
   */
  private async warm(what: 'map' | 'health', run: () => Promise<unknown>): Promise<void> {
    const started = Date.now();
    try {
      await run();
      this.logger.log(`repos ${what} warm ready in ${Date.now() - started} ms`);
    } catch (err) {
      this.logger.warn(`initial repos ${what} warm failed: ${(err as Error).message}`);
    }
  }

  /**
   * The map: every in-scope repo with its trailing-window flow, open count,
   * growth verdict and owner. Cached for the TTL; the counts underneath are as
   * fresh as the shared issue ingest.
   *
   * `org` NARROWS the answer to that org (#718), absent means the whole union.
   * It must already be a served org in the source's own spelling — the
   * controller's gate resolves it and 404s anything else. Narrowing filters the
   * union already in hand: no Github read, no per-org cache. An org whose
   * enumeration failed on this build is a 503 rather than an empty list; see
   * `assertServable`.
   */
  async listRepos(org?: string): Promise<ReposView> {
    const core = await this.core();
    return org === undefined ? core.data : narrowView(core.data, core.schemas, org);
  }

  /**
   * The core read, with the descriptors it was built from and the `at` that
   * identifies this build — the health read needs all three.
   *
   * Four cases, and the split between them is the decision (#611):
   *
   * - FRESH — inside the TTL, and the roster generation the owner names were
   *   built at is still current: served, and nothing is read.
   * - STALE BY THE CLOCK ALONE — the held view is handed back at once and a
   *   refresh runs behind the reader. Nobody waits ~1.2 s for a map this
   *   service is already holding an answer for, which is the whole of #611.
   * - A GENERATION MISMATCH is not a clock expiry and does NOT get that: it is
   *   an admin correcting a person's name, and `identity.controller.ts`
   *   promises in writing that the correction does not wait out a TTL. This
   *   reader waits for the rebuilt map.
   * - NO VIEW — cold, or dropped by `dropCaches()` — waits too. That is what
   *   makes "a write and Sync now are never served stale" structural rather
   *   than argued: those paths null the view, so there is nothing stale left
   *   here to serve.
   */
  private async core(): Promise<CoreRead> {
    const now = Date.now();
    const generation = this.githubLogins.rosterGeneration();
    const held = this.view;
    if (held && held.generation === generation) {
      if (now - held.at >= this.ttlMs) this.revalidate(now);
      this.reportStaleness('map', now, held.at);
      return {
        build: held.build,
        data: held.data,
        descriptors: held.descriptors,
        at: held.at,
        issues: held.issues,
        unreadRepos: held.unreadRepos,
        readIssueRepos: held.readIssueRepos,
        unreadIssueOrgs: held.unreadIssueOrgs,
        schemas: held.schemas,
      };
    }
    if (this.inFlight) return this.inFlight;
    return this.beginRefresh(now);
  }

  /** Rebuild the map behind a reader that has already been answered. Deduped on
   *  the same in-flight slot every other refresh uses, so a burst of requests
   *  arriving on a stale view costs one org sweep, not one each — and a failure
   *  is a warning, never the caller's problem: the caller has its answer. */
  private revalidate(now: number): void {
    if (this.inFlight) return;
    void this.beginRefresh(now).catch((err) =>
      this.logger.warn(`background repos map refresh failed: ${(err as Error).message}`),
    );
  }

  /** Start a map refresh and own the in-flight slot for it. */
  private beginRefresh(now: number): Promise<CoreRead> {
    const read = this.refresh(now).catch((err) => { if (githubPrincipal()) this.dropCaches(); throw err; }).finally(() => {
      // Only if it is still ours: a refresh disowned by `dropCaches()` must not
      // clear the slot a later refresh has since taken.
      if (this.inFlight === read) this.inFlight = null;
    });
    this.inFlight = read;
    return read;
  }

  /** Say once that what is being served has drifted far past its TTL (#611).
   *
   *  Stale-while-revalidate serves an old answer indefinitely while refreshes
   *  keep failing, and the two things that go wrong then — a `dri` edit that
   *  never appears, a repo that never joins the map — look exactly like nothing
   *  happening. The latch clears when the cache recovers, so this announces a
   *  state change rather than repeating per request. */
  private reportStaleness(what: 'map' | 'health', now: number, at: number): void {
    // A TTL of zero has no drift to report: every held answer is instantly
    // "past three intervals" of nothing, and the warning would fire on a
    // healthy service. Caching turned off is a configuration, not a fault.
    const stale = this.ttlMs > 0 && now - at > STALE_SERVE_TTLS * this.ttlMs;
    if (stale && !this.warnedStale[what]) {
      this.warnedStale[what] = true;
      this.logger.warn(
        `the repos ${what} being served is ${Math.round((now - at) / 1000)}s old, past ${STALE_SERVE_TTLS} ` +
          'refresh intervals — refreshes are failing behind stale-while-revalidate, so the board is drawing ' +
          'facts from before them (#611).',
      );
    }
    if (!stale) this.warnedStale[what] = false;
  }

  /**
   * Every repo's security posture and CI conclusion, on its own cache and its
   * own in-flight dedupe (#571) — never on a TTL of its own; see `health`.
   *
   * The map is resolved FIRST, and this answer is served only while it COVERS
   * that map — a row for every repo on it, see `health` above. That is what
   * makes "every repo the map draws has a row here" a guarantee rather than a
   * hope: a repo absent from this payload would be indistinguishable from one
   * the client has not received yet, and the client must be able to tell
   * "clean" from "not known yet". A build the payload already covers is served
   * at once and refreshed behind the reader; a build that gained a repo is
   * waited for (#611).
   *
   * A failure propagates to the caller and is NOT cached, and nothing on this
   * path writes the view — so losing these two facts costs these two facts. The
   * commonest rejection here is not the alert reads at all but the core read
   * underneath them: `securityByRepo()` resolves empty when the org denies the
   * alert lists and `ciByRepo()` resolves `null` per repo whose read fails, so
   * those two degrade quietly and the repo list is what is left to fail.
   */
  async listHealth(org?: string): Promise<ReposHealthView> {
    const core = await this.core();
    // Refused BEFORE the health read, not after: an org whose repos could not
    // be listed has no rows here either, so narrowing to it would answer `200
    // {"repos":[]}` — a clean bill of health for an org nobody could even
    // enumerate — and there is no reason to spend ~18 s of alert reads first.
    if (org !== undefined) assertServable(core.data.unreadableOrgs, org);
    const data = await this.healthView(core);
    return org === undefined ? data : narrowHealth(data, org);
  }

  /** The whole union's health payload — the cache, the coverage check and the
   *  in-flight dedupe above, with no org narrowing on top. `listHealth` is what
   *  narrows; keeping the two apart means the cache holds ONE payload for the
   *  map rather than one per org asked for, and every freshness rule below goes
   *  on being written once. */
  private async healthView(core: CoreRead): Promise<ReposHealthView> {
    const { build, descriptors } = core;
    if (this.health?.coreBuild === build) return this.health.data;
    const held = this.health;
    // Covered: every repo of the build being served has a row here, so what the
    // client draws from it is right for that map. Served now, rebuilt behind
    // the reader — the same reasoning the org's Actions usage already uses when
    // it checks its month coverage instead of its age alone.
    if (held && descriptors.every((d) => held.fulls.has(d.full))) {
      if (this.healthInFlight?.build !== build) {
        void this.beginHealth(build, descriptors, core.data.unreadableOrgs).catch((err) =>
          this.logger.warn(`background repos health refresh failed: ${(err as Error).message}`),
        );
      }
      this.reportStaleness('health', Date.now(), held.at);
      // The rows are covered; the LOSS LIST is not, and it is the one thing on
      // this payload that describes the build rather than the repos (#718).
      // Coverage is a subset test, so a build that LOST an org still passes it
      // while the held payload names no unreadable org. Merged rather than
      // replaced: the held list also holds the orgs whose ALERT lists refused,
      // which this build's own list says nothing about. The held payload itself
      // is handed back whenever the merge adds nothing — `mergeOrgs` keeps every
      // entry it was given, so an equal length is an equal set.
      const lost = mergeOrgs(core.data.unreadableOrgs, held.data.unreadableOrgs);
      return lost.length === held.data.unreadableOrgs.length ? held.data : { ...held.data, unreadableOrgs: lost };
    }
    // Only a read being made for THIS build may be shared. Dropping the build
    // from this condition hands a caller an answer about a map that has since
    // been replaced.
    if (this.healthInFlight?.build === build) return this.healthInFlight.read;
    return this.beginHealth(build, descriptors, core.data.unreadableOrgs);
  }

  /** Start a health read and own the in-flight slot for it. */
  private beginHealth(
    build: number,
    descriptors: RepoDescriptor[],
    unlistedOrgs: readonly string[],
  ): Promise<ReposHealthView> {
    const read = this.refreshHealth(build, descriptors, unlistedOrgs).finally(() => {
      if (this.healthInFlight?.read === read) this.healthInFlight = null;
    });
    this.healthInFlight = { build, read };
    return read;
  }

  async listCiSpend(org?: string): Promise<ReposCiSpendView> {
    const core = await this.core();
    if (org !== undefined) assertServable(core.data.unreadableOrgs, org);
    const nowIso = new Date(core.at).toISOString();
    const usage = await this.degrade('Actions usage', this.actionsUsage(core.at, nowIso), null);
    const rows = core.data.repos.filter(row => org === undefined || orgOf(row.full) === org.toLowerCase());
    return { repos: rows.map(row => {
      const covered = usage?.orgs.some(owner => owner.toLowerCase() === orgOf(row.full));
      return { full: row.full, ciSpend: ciSpendWindows(covered ? usage!.days : null, row.full, nowIso) };
    }) };
  }

  async listPrFlow(org?: string): Promise<ReposPrFlowView> {
    const core = await this.core();
    if (org !== undefined) assertServable(core.data.unreadableOrgs, org);
    const nowIso = new Date(core.at).toISOString();
    const rows = core.data.repos.filter(row => org === undefined || orgOf(row.full) === org.toLowerCase());
    const repos = await mapLimit(rows, ORG_CONCURRENCY, async row => ({
      full: row.full,
      pullRequests: pullRequestWindows(await this.pullRequests(row.full, core), nowIso),
    }));
    return { repos };
  }

  /** Share one PR read per map build between the selected grid lens and repo pages. */
  private pullRequests(full: string, core: CoreRead): Promise<RepoPrRead> {
    const cache = this.principalState.current.prReads;
    const key = full.toLowerCase();
    const cached = cache.get(key);
    if (cached?.build === core.build) return cached.read;
    const since = new Date(windowStart(new Date(core.at).toISOString())).toISOString();
    const read = this.degrade(`pull requests ${full}`, this.source.pullRequests(full, since), {
      state: 'unreadable' as const,
    });
    cache.set(key, { build: core.build, read });
    return read;
  }

  /**
   * One repo's page (#575): its row off the map, its README, its pull-request
   * flow, what its CI cost, and its open issues.
   *
   * The map is resolved FIRST and everything the tile already knows is taken
   * from it — identity, the issue weeks, the open count, the owner. The page
   * does not derive any of those a second time, so it cannot disagree with the
   * tile about the same repo, and it adds no repo listing and no issue fetch of
   * its own.
   *
   * The answer is bound to that map build, exactly as the health payload is:
   * one freshness rule, in one place, that a sync or a write moves. And nothing
   * on this path touches the map's own refresh — the three reads below happen
   * because somebody opened a page, never because somebody opened the map
   * (#571).
   *
   * A repo that is not on the map is a 404, not an empty page: the map is what
   * "in scope" means here, and inventing a page for a repo outside it would
   * report an archived or unknown repo as one with nothing going on.
   */
  async repoPage(owner: string, name: string): Promise<RepoPageView> {
    const core = await this.core();
    const asked = `${owner}/${name}`.toLowerCase();
    // Case-insensitively, because Github's own URLs are: a link that cased the
    // owner differently must not 404 on a repo that is plainly on the map.
    const row = core.data.repos.find((r) => r.full.toLowerCase() === asked);
    if (!row) throw new NotFoundException(`repo ${owner}/${name} not found`);
    const cached = this.pages.get(asked);
    if (cached?.coreBuild === core.build) return cached.data;
    const running = this.pagesInFlight.get(asked);
    if (running?.build === core.build) return running.read;
    const read = this.buildPage(asked, core, row).finally(() => {
      if (this.pagesInFlight.get(asked)?.read === read) this.pagesInFlight.delete(asked);
    });
    this.pagesInFlight.set(asked, { build: core.build, read });
    return read;
  }

  /**
   * Build one repo's page and cache it against the map build it describes.
   *
   * The three reads run together and each one degrades ALONE: `degrade` turns a
   * rejection into that section's own "could not read" rather than into a page
   * that will not draw. The sources already promise not to throw here; this is
   * the guarantee stated where the page is assembled, so it holds whatever a
   * source does later.
   */
  private async buildPage(key: string, core: CoreRead, row: RepoRow): Promise<RepoPageView> {
    const full = row.full;
    // The map's own bucketing moment, never a fresh clock: the PR flow and the
    // CI spend are drawn beside the issue weeks and have to share their windows.
    const nowIso = new Date(core.at).toISOString();
    const [readme, prs, usage, roster] = await Promise.all([
      this.degrade(`README ${full}`, this.source.readme(full), { state: 'unreadable' } as RepoReadme),
      this.pullRequests(full, core),
      this.degrade(`Actions usage`, this.actionsUsage(core.at, nowIso), null),
      // The roster the members list names people through — the same memoised
      // read the map's own owner names come from, so this costs a memo lookup
      // and no Github call (#828). It is not one of the three reads that can
      // fail: `teamRoster` never rejects, and answers with the checked-in table
      // when its store is unreachable.
      this.githubLogins.teamRoster(),
    ]);
    // An org the billing read did NOT cover gets `null`, which draws the CI
    // section as unreadable (#718). `ciSpendWindows` matches its rows on `full`
    // and pre-fills every window, so handing it another org's rows for a repo
    // whose own org failed reports $0.00 across the window — a wrong figure that
    // reads as a quiet month, and the one answer worse than a gap here.
    const spend = usage != null && usage.orgs.some((o) => o.toLowerCase() === orgOf(full)) ? usage.days : null;
    // Titles pass the words rule on the way out (#836). Every other surface
    // carrying an issue title runs `redactFeedbackTitles` against the caller;
    // this route takes no viewer and its answer is held in a process-wide cache
    // keyed on the map build, so one reader's page IS the next reader's page —
    // there is nobody to key it on. It is built for the least-privileged reader
    // instead, which is what `undefined` means to `withheldFrom`.
    const openIssues = openIssuesFor(core.issues, row, this.feedback);
    // The issue block's third answer (#837). Membership is the ingest's own
    // `ok: false` for THIS repo — see `CoreRead.unreadRepos` — so a repo the
    // ingest never asked about, and every repo under a source that cannot report
    // outcomes at all, keeps the answer it has today.
    // ...or its org's enumeration failed, which is the same fact one level up:
    // that org contributed no repos to the ingest, so none of them can be in
    // `unreadRepos` and absent there means "never asked". See
    // `CoreRead.unreadIssueOrgs`.
    const openIssuesState = issueReadState(full, core.unreadRepos, core.unreadIssueOrgs);
    // Both periods off ONE bucketing (#962). The billing read covers twice the
    // window; the later half is the card's own chart and the earlier half is the
    // previous period's total. `slotOf` places a moment by its age, so the last
    // REPO_WEEKS windows of the longer series are exactly the page's windows.
    const spent = ciSpendWindows(spend, full, nowIso, COMPARED_WEEKS);
    const ciSpend: RepoCiSpend =
      spent.state === 'read' ? { state: 'read', weeks: spent.weeks.slice(-REPO_WEEKS) } : spent;
    const data: RepoPageView = {
      updatedAt: core.data.updatedAt,
      // The row the caller already found, not a second scan of the map for the
      // same repo — and so no non-null assertion standing in for a lookup that
      // has already succeeded once.
      repo: row,
      readme,
      pullRequests: pullRequestWindows(prs, nowIso),
      ciSpend,
      openIssues,
      // The pre-#826 name, one array published twice. #838 wants it gone; its own
      // Done-when says no reader of the old name may be left running, and the
      // rename is a day old against `immutable` bundles nobody has to reload —
      // `RepoPageView.recentIssues` carries the whole argument.
      recentIssues: openIssues,
      openIssuesState,
      // Off the two reads already in hand — the org-wide ingest and this page's
      // own PR read (#828). The PR READ rather than the flow above it: the flow
      // keeps the open list and drops the records, and a person who opened a
      // pull request that has since merged is still somebody who works here.
      members: membersFor(core.issues, prs, row, roster.names, nowIso),
      // Both comparisons use the ingest, PR read and billing read already in hand.
      completedDayChange: completedDayChange(
        core.issues, row, prs, spend, nowIso,
        (core.readIssueRepos.get(full.toLowerCase()) ?? -Infinity) >= completedDayEnd(nowIso)
          && openIssuesState === 'read',
      ),
      previous: previousPeriod(core.issues, row, prs, spent, nowIso, openIssuesState === 'read'),
    };
    // Cached only when every section actually READ.
    //
    // A page carrying `unreadable` is this board saying "ask again" — that is
    // what the state means, and it is the whole reason it is a state rather
    // than a zero. Caching it makes the retry impossible for the life of the
    // map build: a reload is served the cached page and never reaches the
    // source again, so a single blip on the README read takes the README off
    // the page for up to REPOS_CACHE_TTL_MS. An absent README is a different
    // matter and does cache: nothing failed, the repo simply has none.
    //
    // Rebuilding costs the three reads again, which is what a retry IS.
    //
    // The issue block is in the fold now (#837). It used to be the one section
    // that could be wrong without saying so: a repo whose own fetch failed
    // arrived here with no rows and cached an empty "No open issues." for the
    // life of the map build, so the retry a reload IS could not reach the ingest
    // again. It costs the same rebuild as the other three, and for the same
    // reason — `unreadable` is this board saying "ask again", and caching it
    // makes asking again impossible.
    //
    // Rebuilding does NOT re-fetch this repo's issues: the ingest is a separate
    // cache on its own TTL, so the page re-reads whatever the ingest holds. What
    // this buys is that the moment the ingest recovers, the next reader sees it
    // — rather than the next reader after REPOS_CACHE_TTL_MS.
    const readEverything =
      readme.state !== 'unreadable' &&
      data.pullRequests.state !== 'unreadable' &&
      data.ciSpend.state !== 'unreadable' &&
      data.openIssuesState !== 'unreadable';
    // ...and only while the map this page describes is still the map being
    // served — the same binding, and the same reason, as `refreshHealth`.
    if (readEverything && this.view?.build === core.build) {
      this.pages.set(key, { coreBuild: core.build, data });
    }
    return data;
  }

  /** Run one of the page's reads, and answer with `fallback` if it rejects.
   *  Losing one section may only ever cost that section. */
  private async degrade<T>(what: string, read: Promise<T>, fallback: T): Promise<T> {
    try {
      return await read;
    } catch (err) {
      this.logger.warn(`repo page read failed (${what}): ${(err as Error).message}`);
      return fallback;
    }
  }

  /**
   * The org's Actions usage, read once and shared by every repo page.
   *
   * Served off the cache only when the cache is BOTH young enough AND covers
   * every month this caller's window touches. Age alone is not enough: a map
   * rebuilt by a roster-generation bump does not go through `dropCaches()`, so
   * this cache outlives builds, and a build whose window has rolled into a new
   * month — or an older build being served a newer build's month set — would
   * otherwise be handed an array with a month missing from it. A missing month
   * is not a smaller number here; `ciSpendWindows` pre-fills its windows and
   * only adds, so it renders as `minutes: 0` and the page reads it as "nothing
   * ran" (#582). The re-read that a coverage miss costs is one request per
   * month per org, five or six of them.
   *
   * A failed read is deliberately NOT cached: holding `null` for a TTL would
   * take the CI section off every repo page on the board over one blip, and
   * there is nothing to gain by remembering that a read did not work.
   *
   * The months come from the window the page draws AND the one before it
   * (#962), because the CI card compares its spend with the previous period
   * of the same length. That is five calls per org on 145 days of 2026 and six
   * on the other 220, where the window alone was three or four — two or three
   * more per read, bought for the comparison and on the REST budget, not the
   * GraphQL one.
   *
   * A PARTIAL read IS cached (#718). `orgs` travels on the cached answer, so
   * `buildPage` decides per repo whether the report covers that repo's OWN org:
   * a repo in an org the read missed is served "could not read" for that TTL,
   * never another org's rows.
   */
  private async actionsUsage(now: number, nowIso: string): Promise<ActionsUsageRead | null> {
    const months = monthsSpanning(windowStart(nowIso, COMPARED_WEEKS), now);
    const wanted = months.map(monthKey);
    const age = now - (this.usage?.at ?? 0);
    // `age >= 0` as well as under the TTL: a caller carrying an older build's
    // clock must not be served a cache stamped after it, whose month set was
    // chosen for a window this caller does not have.
    // A TTL-fresh report can still predate the completed day after midnight.
    const fresh = this.usage && age >= 0 && age < this.ttlMs
      && this.usage.at >= completedDayEnd(nowIso);
    if (this.usage && fresh && wanted.every((m) => this.usage!.months.has(m))) return this.usage.data;
    // The read that is still out is joined on the SAME coverage test, never on
    // its mere existence: a slot that never asked for this caller's month would
    // otherwise answer with that month missing, and a missing month here is a
    // wrong figure that reads as a quiet one.
    const out = this.usageInFlight;
    if (out && out.at >= completedDayEnd(nowIso) && wanted.every((m) => out.months.has(m))) return out.read;
    const epoch = this.epoch;
    const read = this.source
      .actionsUsage(months)
      .then((data) => {
        // Not a failure, and not this refresh's answer to write, if the caches
        // were declared out of date while it was in flight — the same rule
        // `refresh` follows. A read that covered SOME orgs is cached; one that
        // covered none resolves `null` and is not, because there is nothing in
        // it to remember.
        if (data && epoch === this.epoch) this.usage = { at: now, months: new Set(wanted), data };
        return data;
      })
      .finally(() => {
        // Identity-guarded, unchanged: a caller this read did not cover has
        // since taken the slot for its own, and clearing that one here would
        // undo a dedupe that is live.
        if (this.usageInFlight?.read === read) this.usageInFlight = null;
      });
    this.usageInFlight = { at: now, months: new Set(wanted), read };
    return read;
  }

  /** When the map this is serving was built (#1169) — the view's own moment,
   *  not `ReposView.updatedAt`, which is the ingest's age and is a different
   *  fact this service is careful to keep separate everywhere else. Null while
   *  the boot warm is still in flight and after a drop. */
  lastSyncedAt(): string | null {
    // `peek`, never `this.view`: `mapState`'s scope is `KeptWhileUnchanged`, so
    // reading it through `current` marks the request permission-sensitive
    // (#1007, #1169). The map's build MOMENT is not the map. See
    // `PrincipalState.peek`.
    const held = this.mapState.peek()?.view ?? null;
    return held ? new Date(held.at).toISOString() : null;
  }

  /** Force the whole map fresh (#301, "sync now"): re-pull the issue ingest, drop
   *  the cached view, then warm the map so it is current on return. The ingest refresh is deduped inside IssuesCacheService,
   *  so running alongside the metrics resync costs one fetch, not two. */
  async resync(): Promise<void> {
    await this.issuesCache.resync();
    this.dropCaches();
    // The owner names come off the resolver's own memo. Leaving it would make a
    // name stale straight after an explicit sync — the contradiction of the
    // paragraph above, which promises an edit lands on the next view.
    this.githubLogins.invalidateRoster();
    await this.listRepos();
    // The health pair is ~18 s of Github, and this call is what the sync button
    // waits on, so it is re-warmed rather than awaited — the same trade the map
    // itself now makes everywhere else (#571).
    void this.warm('health', () => this.listHealth());
  }

  /** Same manual refresh, with known ingest/map coverage retained for progress. */
  async resyncWithOutcome(): Promise<'succeeded' | 'degraded'> {
    const ingest = await this.issuesCache.resyncWithOutcome();
    this.dropCaches();
    this.githubLogins.invalidateRoster();
    const map = await this.listRepos();
    void this.warm('health', () => this.listHealth());
    return ingest === 'degraded' || map.unreadableOrgs.length > 0 ? 'degraded' : 'succeeded';
  }

  /**
   * Declare every cached answer out of date (#571).
   *
   * Three moves, and none of the three is optional:
   *
   * - the view goes, and the health payload goes with it.
   * - the in-flight slots go, so a caller arriving after this point starts its
   *   own read instead of being handed the one that went out before the change.
   * - the epoch moves, so those disowned reads cannot write what they read
   *   BEFORE the change into the cache when they eventually land. Nulling the
   *   slots does not do this on its own: the disowned read holds no reference
   *   to the slot, and would happily overwrite a fresher answer.
   *
   * The `health` payload is nulled here too, and that line is not optional
   * either since #611. It used to be reachable only through the build it was
   * bound to, so dropping the view was enough to retire it; now it is served on
   * SET COVERAGE, and the map rebuilt by this very drop is one it usually
   * covers — so leaving it would hand a `dri` write or a Sync now a payload
   * read before the click, which is the one thing those two paths promise not
   * to do. The cost is bounded and is not a regression: `resync()` re-warms
   * the health in the background, and after a `dri` write the next health
   * reader already waits today.
   */
  private dropCaches(): void {
    this.view = null;
    this.health = null;
    this.inFlight = null;
    this.healthInFlight = null;
    // The pages are bound to a map build and so are already unreachable, the
    // same way the health payload is. They are cleared anyway because this map
    // is keyed per repo and grows: a repo that leaves the org would otherwise
    // keep its page here for the life of the process. The in-flight slots go for
    // the reason every other in-flight slot goes — a caller arriving now must
    // start its own read rather than be handed one that went out before the
    // change.
    this.pages.clear();
    this.pagesInFlight.clear();
    this.principalState.current.prReads.clear();
    // The org's spend goes too. Every caller of this method is saying the
    // board's cached answers are out of date, and "sync now" that left the CI
    // trend up to a TTL old would be a button that says it refreshed the page
    // and did not. It costs nothing to drop: the billing read is lazy, so it is
    // paid on the next repo page rather than here.
    this.usage = null;
    this.usageInFlight = null;
    this.epoch++;
  }

  /** Build the health payload and replace its cache (#571). `coreBuild` and
   *  `descriptors` come from the core read the caller already resolved: the same
   *  list the map was built from, and the only place each repo's default branch
   *  — which `ciByRepo` scopes itself to — survives. */
  private async refreshHealth(
    coreBuild: number,
    descriptors: RepoDescriptor[],
    unlistedOrgs: readonly string[],
  ): Promise<ReposHealthView> {
    const [security, ci] = await Promise.all([
      this.source.securityByRepo(),
      this.source.ciByRepo(descriptors),
    ]);
    const alerts = byJoinKey(security.byRepo);
    // The orgs whose ALERT lists refused. Absence from `alerts` is what a clean
    // repo looks like, so without this every repo of such an org would be
    // filled with zeros and drawn as having nothing open — the clean bill of
    // health for an org nobody looked at that `repos.controller.ts` says the
    // org gate exists to prevent, arriving through the back door (#718).
    const unread = new Set(security.unreadableOrgs.map((o) => o.toLowerCase()));
    const data: ReposHealthView = {
      // Both losses, in one list: an org with no rows at all because its
      // enumeration failed, and an org whose rows are zeros nobody read.
      unreadableOrgs: mergeOrgs(unlistedOrgs, security.unreadableOrgs),
      repos: descriptors
        .map((d) => ({
          full: d.full,
          // Absent means "no open alerts", the same default the row used to
          // carry — and a fresh record per repo, so two rows can never alias
          // (and so mutate) one. In an org whose lists refused it means the
          // opposite: zeros nothing measured, which say so. So does a row that
          // DID come back from such an org — one of its three lists answered
          // and another did not, and the counts behind the one that did not are
          // zeros nobody read. See `securityFor`.
          security: personalOwner(orgOf(d.full)) ? NO_ALERTS('not-applicable') : securityFor(alerts.get(joinKey(d.full)), unread.has(orgOf(d.full))),
          // Absent means "no completed run on the default branch, or none could
          // be read" — which the source itself declares is not a failure. The
          // conclusion and the run's own address come out of the same record
          // (#605), so a tile can never draw a word from one read and point at
          // another.
          ci: ci.get(d.full)?.conclusion ?? null,
          ciUrl: ci.get(d.full)?.url ?? null,
        }))
        .sort((a, b) => a.full.localeCompare(b.full)),
    };
    // Only while the map this describes is still the map being served. A read
    // that went out before a sync or a write comes back describing a build
    // nobody is looking at any more, and caching it would cost the fresh answer
    // that replaced it — the next reader would then pay the whole ~18 s again.
    // No `epoch` check is needed on this path: every drop rebuilds the map, so
    // a disowned health read is by definition bound to a build that has moved.
    const view = this.view;
    if (view?.build === coreBuild) {
      this.health = {
        coreBuild,
        // The build's own moment, not this read's: what ages is the map this
        // payload describes, and that is what the staleness warning measures.
        at: view.at,
        fulls: new Set(data.repos.map((r) => r.full)),
        data,
      };
    }
    return data;
  }

  /** Build the map and replace the cache. */
  private async refresh(now: number): Promise<CoreRead> {
    const epoch = this.epoch;
    const build = ++this.builds;
    // Every read here rejects the refresh: losing the repo list or ownership
    // means the map would be WRONG rather than merely plainer. The two reads
    // that may only cost themselves — security and CI — are not in this group
    // at all any more; they are `refreshHealth` above (#571).
    // One schema read PER SERVED ORG (#718), concurrently and inside the same
    // gather as the rest: the property is defined per organization, so a single
    // read judged every org by the first one's `allowedValues` and its
    // `values_editable_by`.
    const servedOrgs = this.source.servedOrgs;
    const [listing, { issues, at, repos: issueReads, orgs: issueOrgs }, dri, driSchemas] = await Promise.all([
      this.source.listRepos(),
      this.issuesCache.getIssues(now),
      this.source.driByRepo(),
      // Through the same bounded pool every other fan-out on this surface uses,
      // not `Promise.all` (#718): a deployment naming many orgs would otherwise
      // open one schema request per org at once, and this is the one read here
      // whose cost scales with the org count alone.
      mapLimit<string, readonly [string, DriSchema]>([...servedOrgs], ORG_CONCURRENCY, async (org) => [
        org,
        await this.source.driSchema(org),
      ]),
    ]);
    const descriptors = listing.repos;
    // Folded once, here, rather than at every lookup: `full` carries the org as
    // the deployment spelled it and this map is keyed off the owner as Github
    // spells it. See `joinKey`.
    const owners = byJoinKey(dri.byRepo);
    const schemas = new Map(driSchemas.map(([org, schema]) => [org.toLowerCase(), schema]));
    // Read the generation BEFORE the roster, never after: an invalidation that
    // lands between the two would otherwise be stamped onto a view built from
    // records that predate it, and this cache would then believe it is current.
    const generation = this.githubLogins.rosterGeneration();
    // One roster read per rebuild, not per request.
    const { names } = await this.githubLogins.teamRoster();
    // Folded once per build — see `CoreRead.unreadRepos`. Lower-cased on the way
    // in, because Github echoes a repo's own casing and `RepoRow.full` carries
    // the deployment's spelling, and a case difference here would silently mean
    // "this repo read fine".
    const unreadRepos: ReadonlySet<string> = new Set(
      issueReads.filter((r) => !r.ok).map((r) => r.full.toLowerCase()),
    );
    // Keep the ingest’s coverage time: a stale successful scan cannot cover a newer day.
    const readIssueRepos: ReadonlyMap<string, number> = new Map(
      issueReads.filter((r) => r.ok).map((r) => [r.full.toLowerCase(), at]),
    );
    // And the orgs whose enumeration failed, which no per-repo outcome can
    // reach: an org that never enumerated contributed no repos to ask about.
    // Lower-cased for the same reason — `OrgReadOutcome.org` is the CONFIG's
    // spelling and `RepoRow.full` the deployment's, and Github folds case.
    const unreadIssueOrgs: ReadonlySet<string> = new Set(
      issueOrgs
        .filter((o) => o.state === 'unreadable')
        .map((o) => o.org.toLowerCase()),
    );
    const data: ReposView = {
      // The freshness the map advertises is the ingest's, not the request's —
      // the cached issue list may be up to its own TTL old.
      updatedAt: new Date(at).toISOString(),
      // The orgs with no repos on this map at all, because their enumeration
      // failed. Said rather than hidden: the rows cannot carry it, and a
      // consumer that cannot read it serves an outage as an empty org (#718).
      unreadableOrgs: listing.unreadableOrgs,
      // Each org's exact list beside the union, keyed by the CONFIGURED
      // spelling — the key `ownerWriteEnv` and the controller's gate both
      // resolve a request's org to, so a client can look one up.
      driOptionsByOrg: Object.fromEntries(driSchemas.map(([org, schema]) => [org, schema.allowedValues])),
      driOptions: unionDriOptions(driSchemas.map(([, schema]) => schema)),
      // Carried to the client so the owner control is never drawn where the
      // write is KNOWN to be barred (#577, #649) — the same fact the guard
      // refuses on, from the same read. Every state travels, not just the
      // barring ones: the client's answer to a state the board could not settle
      // (`unreadable`, `unknown`) differs from its answer to one it read and
      // settled (`restricted`, `absent`), and only the view carries which it
      // has.
      //
      // The UNION's answer over every served org, and fail-closed: see
      // `foldWritability`. A `?org=` read is narrowed to that org's own schema
      // instead, and so is the write gate — neither is judged by this fold.
      ownerWritability: foldWritability(driSchemas.map(([, schema]) => schema)),
      repos: rollUpRepos(
        descriptors,
        issues,
        new Date(now).toISOString(),
        (full) => this.ownerOf(owners.get(joinKey(full)) ?? null, names),
        // Whose ownership could not be READ, so a repo of that org says so
        // rather than drawing the "no owner" that an org recording none draws.
        dri.unreadableOrgs,
      ).map((row) => ({
        ...row,
        openIssuesState: issueReadState(row.full, unreadRepos, unreadIssueOrgs),
        ownerWritability: schemas.get(orgOf(row.full))?.writability,
      })),
    };
    // Not if this refresh was disowned while it was out: see `epoch`. This is
    // the hole `setDri`'s docstring used to have to admit to — a refresh already
    // in flight when a write landed would cache what it read BEFORE the write,
    // wearing a fresh timestamp.
    if (epoch === this.epoch) {
      this.view = {
        at: now, build, generation, data, descriptors, issues, unreadRepos, readIssueRepos, unreadIssueOrgs, schemas,
      };
    }
    return { build, data, descriptors, at: now, issues, unreadRepos, readIssueRepos, unreadIssueOrgs, schemas };
  }

  /**
   * The two facts a `dri` write is gated on: the values the property allows,
   * and whether this board may set them (#577).
   *
   * Served off the cached view when the view holds a SETTLED answer. An
   * unsettled one is re-read from source, because unsettled is the board
   * admitting it did not find out, and caching that for the view's TTL would
   * make every press for ten minutes fail on a stale non-answer that nothing
   * ever revisits — a retry that cannot possibly work, which is the very thing
   * this issue exists to remove. A recovered answer also drops the caches, so
   * the map's own picker stops offering the empty option list that came with it
   * — and the health payload, which is bound to that view, is rebuilt against
   * the map that replaces it rather than left describing the old one.
   *
   * `absent` is settled, and that is the whole point of it being its own state
   * (#649): an org with no `dri` property used to answer `unknown`, which never
   * converges, so every press re-read a schema whose answer could not change.
   *
   * All of that is about the orgs the MAP covers, and `org` need not be one of
   * them. An org outside `servedOrgs` has no schema in the map's build, so
   * there is nothing here to serve it from and it is read fresh, on every
   * press. That costs one schema call on one press.
   *
   * A SERVED org is answered from the map's build, narrowed to that org (#718)
   * — never from the union's `ownerWritability`, which is a fold and would
   * refuse a write to a writable org because a different org restricts the
   * property. Membership is decided against `servedOrgs` for the same reason
   * the map is built over all of them: the second org's repos are on this map
   * now, and a write to one of them is a write to an org this board enumerates.
   *
   * The comparison is case-insensitive: `org` arrives as the caller spelled it,
   * and an org that differs only in case is the same org, not a second one to
   * pay for. The CONFIGURED spelling is what goes outward.
   */
  async ownerWriteEnv(org: string): Promise<{ allowed: string[]; writability: OwnerWritability }> {
    const folded = org.toLowerCase();
    const served = this.source.servedOrgs.find((o) => o.toLowerCase() === folded);
    if (!served) {
      const other = await this.source.driSchema(org);
      return { allowed: other.allowedValues, writability: other.writability };
    }
    // The org's OWN schema off the build, not `listRepos(served)`. The narrowed
    // view reads exactly this and adds two things a write must not inherit: a
    // filtered row list nothing here looks at, and the 503 a narrowed READ owes
    // an org whose repos could not be enumerated. A write does not read this
    // map — it resolves its target through the allow-list and needs the schema
    // alone — so refusing it because the listing failed would refuse a press
    // Github would have taken.
    const schema = (await this.core()).schemas.get(folded);
    if (schema && isSettled(schema.writability)) {
      return { allowed: schema.allowedValues, writability: schema.writability };
    }
    const fresh = await this.source.driSchema(served);
    if (isSettled(fresh.writability)) this.dropCaches();
    return { allowed: fresh.allowedValues, writability: fresh.writability };
  }

  /**
   * Record a repo's DRI and return the owner the map will now draw.
   *
   * The owner returned is the one the SOURCE reports afterwards, never the one
   * that was asked for (#577). Github's write answers with no body, so the
   * source reads the property back; naming the requested login here instead
   * would hand the tile a request wearing the clothes of an answer.
   *
   * The view is dropped rather than patched: ownership is one field of a cached
   * rollup, and rebuilding it is cheap next to the risk of a hand-patched cache
   * disagreeing with Github. It is dropped through `dropCaches()`, which also
   * disowns any refresh that was already out — so a read that started before
   * this write can no longer land afterwards and cache pre-write ownership with
   * a fresh timestamp. That hole predated this method and is closed now (#571);
   * what is still NOT promised is that the next read is post-write, only that
   * nothing stale is cached as if it were.
   */
  async setDri(full: string, login: string | null): Promise<RepoOwner | null> {
    const recorded = await this.source.setDri(full, login);
    this.dropCaches();
    const { names } = await this.githubLogins.teamRoster();
    return this.ownerOf(recorded, names);
  }

  /** A `dri` login, named through the merged roster. An unmapped login keeps its
   *  handle with no name — the surface shows what the org records and never
   *  invents a person for it. Applied on every rebuild rather than stored, so
   *  the name is only ever as old as the roster behind it (#541). */
  private ownerOf(login: string | null, names: Map<string, string>): RepoOwner | null {
    if (!login) return null;
    return { login, name: names.get(login.toLowerCase()) ?? null };
  }
}

function issueReadState(
  full: string,
  unreadRepos: ReadonlySet<string>,
  unreadIssueOrgs: ReadonlySet<string>,
): 'read' | 'unreadable' {
  return unreadRepos.has(full.toLowerCase()) || unreadIssueOrgs.has(orgOf(full))
    ? 'unreadable'
    : 'read';
}
