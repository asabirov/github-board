import type { SourceFreshness } from '../sync/source-freshness';
import { githubPrincipal, PrincipalState } from '../auth/github-principal';
import { ForbiddenException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeedbackScope, Viewer, feedbackScopeFrom } from '../auth/feedback-visibility';
import { IssuesCacheService, type OrgReadOutcome } from '../issues-metrics/issues-cache.service';
import type { CloseReason } from '../issues-metrics/close-reason';
import { PULSE_DAYS, dailyByProject, openedThisWeekOf, weeklyClosedByProject } from './project-pulse';
import { readableItems, readableLastClosed } from './project-visibility';
import {
  IProjectsSource,
  PROJECTS_SOURCE,
  ProjectCatalogEntry,
  ProjectDetail,
  ProjectDetailRaw,
  ProjectMembership,
  ProjectRollupPulsed,
  ProjectSummary,
  SourceCatalogEntry,
  SourceMembership,
} from './project.types';
import { githubOrgs } from '../config/github-orgs';
import { notYouRefusal, PROJECTS_NOT_NOW_CODE, ProjectsLastGood, servableRefusal, type LastGoodKind } from './projects-last-good';
import type { StaleOnWrite } from '../freshness/stale-on-write';
import type { Capability } from '../capability/capability';

/** A day series with nothing in it — what a board the join never matched gets. */
const zeroDays = (): number[] => new Array<number>(PULSE_DAYS).fill(0);

/**
 * How many TTLs a retiree may be served past the read that produced it (#713).
 *
 * A retiree has no expiry of its own — it is reached only from a `catch`, so
 * nothing about it is refreshed by time passing — and without a ceiling one
 * failing read at the wrong moment serves the boards from before it for the life
 * of the process. A revoked token, a scope change and an org that was renamed
 * all fail every read for as long as nobody fixes them.
 *
 * THREE, and the TTL is the unit because it is what this service already treats
 * as the longest an unrefreshed answer may be served: fifteen minutes at the
 * 300s default. A secondary rate limit clears in under a minute and a deploy in
 * a few, so three windows cover the failures the retiree was added for, with
 * every reader inside them paying a fresh attempt at the source first. Past that
 * the honest answer is the failure — a board an hour old presented as current is
 * the thing this issue is about.
 *
 * WHAT THE READER ACTUALLY GETS past the ceiling depends on how many orgs are
 * configured, and only one of the two answers is loud. On ONE org, `retired`
 * rethrows and the read fails, so the page says so and somebody fixes the token.
 * On a UNION with another org still answering, that throw is one org's failure:
 * `perOrg` logs it and drops the org, and the reader gets a 200 carrying the
 * healthy org's boards alone — which is the answer `rollupBoards` calls wrong in
 * its own comment, "an org absent from the union reads as an org with no
 * boards". The log line is the only place a dark org appears at that point.
 * Saying it on the wire means a new bit on the payload, which is
 * `board-frontend`'s half as much as this one's, so it is filed rather than
 * built here.
 */
const RETIREE_MAX_TTLS = 3;

/**
 * How long one warm may hold its org's slot before a later write is allowed to
 * start a fresh walk (#713).
 *
 * Nothing on this path times out. `github-client.ts` builds its Octokit with no
 * `request.timeout` and no `AbortSignal`, and `GithubProjectsSource.fetchBoards`
 * awaits the GraphQL call bare — so a socket that hangs rather than fails leaves
 * the walk pending for ever, and the slot `warmOrg` takes is released only when
 * that promise settles. One hung read therefore disabled warm-after-write for
 * the org for the life of the process, and "slow rather than down" is exactly
 * what Projects-v2 does under a secondary rate limit.
 *
 * TWO MINUTES, and it is chosen from the asymmetry rather than from a stopwatch.
 * The walk `stale-on-write.ts` prices is a board-list walk of `projectsV2`
 * pages, then each surfaced board's `items` connection followed to its end,
 * sequentially, with `MAX_PAGES` stopping either at twenty pages — a shape whose
 * worst case is far longer than any bound worth setting, and whose real case on
 * acme is one list page and a page or two of items. So the two failures
 * are not symmetric: expiring EARLY costs at most one extra walk in flight (63
 * Projects-v2 points against a 5,000/hour budget, and at most one more every two
 * minutes while writes keep arriving), while expiring LATE means an org whose
 * writes warm nothing at all. Two minutes is well under the 300s TTL, so an org
 * can never be blacked out for longer than the window its last rollup would have
 * been served in anyway.
 *
 * It is a SLOT bound and not a request one: nothing here can cancel the walk, so
 * a hung read goes on running and a slow one that finishes still caches — the
 * epoch guard in `readRollup`, not this, is what decides whether its answer may
 * be kept.
 */
export const WARM_WALK_MAX_MS = 120_000;

/**
 * A board with the five figures the ORG-WIDE join produced taken off it — the
 * ONE place that says which five they are (#713, #851).
 *
 * Both paths that withhold them come through here — two call sites and three
 * causes: `readRollup` when the join did not run or the board's items came up
 * short (#715, #722), and `unjoined` below, for a copy a drop retired. They
 * hand-copied the same list, and this service's own spec makes a third in
 * `spokenFor`, which inverts it — so a fifth joined figure added to the read
 * would have landed live on a retiree with nothing going red. #851 added that
 * fifth, `openedThisWeek`, and it went in here — which is what the sentence
 * above was written to make happen.
 *
 * Empty and ABSENT, not zeros and not a 0: `closedThisWeek` and `openedThisWeek`
 * are both optional on the wire, so an omitted field travels, and fourteen zeros
 * or a 0 week count would claim a quiet board on what may be the busiest in the
 * org.
 *
 * Everything else survives — counts, completion, contributors, the ring,
 * `lastClosed`. Those are the board's own answers rather than the join's.
 *
 * `pulseJoined` is NOT here, and the boundary it draws is still real (#792): it
 * says whether the join RAN, which is a different question from whether these
 * figures may be served, and `readRollup` withholds them on a board read short
 * whose join ran fine (#722). What changed is that `unjoined` no longer sets it
 * either — a retiree's join ran too, so there is nothing left for a caller to
 * say about the join here.
 *
 * `joinedFiguresWithheld` is the flag this function DOES set, in the same
 * expression that takes the figures off (#792). One place decides which five
 * they are and one place announces that they are gone, so "the flag is true
 * exactly when the figures are absent" is a property of this return statement
 * rather than of this paragraph, and it covers the third cause — a board read
 * short — that a flag set by the two callers would have got wrong.
 */
function withoutJoinedFigures({
  closedThisWeek: _week,
  openedThisWeek: _opened,
  ...board
}: ProjectRollupPulsed): ProjectRollupPulsed {
  return {
    ...board,
    weeklyClosed: [],
    dailyOpened: [],
    dailyClosed: [],
    joinedFiguresWithheld: true,
  };
}

/**
 * A retired board, saying only what a copy from before a write can speak for
 * (#713).
 *
 * The five figures `withoutJoinedFigures` takes off are anchored to the `nowIso`
 * the read took: the fourteenth day bucket is a rolling [now-24h, now) window,
 * and the frontend renders it as "+1 in the last 24h" (`deltaNote` in
 * projects/pulse.ts). Served on a retiree they claim a clock this service no
 * longer has — under the TTL that drift was capped at five minutes, and a
 * retiree has only the ceiling above.
 *
 * Withheld EXACTLY as `readRollup` withholds them when `derivable` is false —
 * one function, so "exactly" is a fact rather than a promise. That function also
 * stamps `joinedFiguresWithheld`, the one thing on the wire saying all four are
 * gone whatever took them off (#792), so a reader gating on it withholds here
 * for the same reason and by the same field as it does there.
 *
 * `pulseJoined` is left ALONE, and the `true` a retiree keeps is the truth
 * rather than an oversight (#792). A rollup is cached only when the join ran —
 * the guard at the end of `readRollup` — so every copy a drop retires is one
 * whose join succeeded, and the flag is a fact about the read that produced this
 * payload. Between #770 and #792 this function overwrote it with `false` to get
 * the five figures withheld, which told the reader an org-wide join had failed
 * on a board where it had run fine.
 *
 * `lastGoodCopy: true` is the flag that says what actually went wrong here
 * (#770): not a read at all, but WHICH PAYLOAD arrived. The frontend renders it
 * ahead of the join's sentence — though behind the read-short one, which is a
 * wider claim and stays true on a retiree read short (`weeklyClosedLine` in
 * projects/ProjectBlock.tsx argues the order).
 *
 * It is the ONLY thing on the wire that speaks for the board's own counts, ring
 * and contributor list, which `withoutJoinedFigures` deliberately leaves whole
 * and which are the figures actually out of date on a retiree. It speaks for
 * them on a ROW: the Projects card's headline share sums a retiree like any
 * other board and always did.
 */
function unjoined(board: ProjectRollupPulsed): ProjectRollupPulsed {
  return { ...withoutJoinedFigures(board), lastGoodCopy: true };
}

/**
 * Whether the issues ingest that resolved can speak for THIS org (#722).
 *
 * The ingest has three failures and only the widest of them throws
 * (`GithubIssuesSource.listIssues`): a per-repo failure is logged and skipped,
 * ONE org's enumeration failing is recorded as `state: 'unreadable'` and the
 * ingest runs on with the orgs that answered (#647), and losing the scope
 * entirely is thrown. So a resolved read is not evidence that this org is in it:
 * an unreadable org contributes no row at all, which joins to a 0 week count and
 * fourteen zeros — the exact payload of a quiet org, and the one #722 exists to
 * tell apart. `OrgReadOutcome`'s own doc says it is "Never a counted zero".
 *
 * ABSENT is not `unreadable`, and the difference is the whole of the two `true`s
 * below. An empty list is an ingest that CANNOT say — a scope with no owner in
 * it enumerates nothing, and the fixture source implements no `orgOutcomes` at
 * all — and an org missing from a filled list is one the ingest never read,
 * which `GITHUB_ORGS` and a person's own Github App grants are deliberately
 * allowed to produce. Reading either as a failure would withhold every derived
 * figure on every board of a deployment that works.
 *
 * Case-insensitive for the reason `scopeForRead` is: Github resolves org logins
 * that way, and the two spellings arrive from two different sources.
 */
function coversOrg(org: string, orgs: OrgReadOutcome[]): boolean {
  const folded = org.trim().toLowerCase();
  const outcome = orgs.find((o) => o.org.trim().toLowerCase() === folded);
  return outcome === undefined || outcome.state !== 'unreadable';
}

/** Anything cached on the TTL: the payload + when it was fetched. */
type Cached<T> = { at: number; data: T };

/** One board's cached detail: the raw payload + when it was fetched. */
type DetailEntry = Cached<ProjectDetailRaw | null>;

/**
 * Read-facing service for the Projects surface. Thin over the pluggable source,
 * with a short TTL cache on the rollup (the most-hit call) and a per-board
 * stale-while-revalidate cache on the drill-in detail (#304 — opening a board
 * paid a fresh, heavy Projects-v2 GraphQL round-trip every single time, so the
 * skeleton wait was the full cold latency on every open).
 *
 * Both caches hold the RAW board (`ProjectRollupPulsed` / `ProjectDetailRaw`),
 * and the feedback-visibility decision (#497) is applied on the way out, per
 * caller.
 * Redacting on write would mean one static agent token's read poisoning the
 * cache for the next human — which is why `viewer` is a required argument on
 * every public read here: a surface that forgets it is a compile error, not a
 * leak.
 *
 * Every cache below is keyed by the org the fetch was made against (#648) — the
 * boards, the memberships and the catalog are all answers ABOUT an org, so one
 * org's answer can never be served for another.
 *
 * Since #697 the READS use that keying. Each public read resolves a SCOPE —
 * every authorized read owner, or the single owner a caller
 * named with `?org=` — fans out across it, and unions the answers. One org's
 * failure is one org's failure: the orgs that answered still carry real boards,
 * and blanking them because a second org 404d would lose work that was read
 * successfully. Every org failing still throws, which with one configured org is
 * the same case as before, and is what makes a single-org deployment behave
 * exactly as it always did.
 */
@Injectable()
export class ProjectsService implements StaleOnWrite {
  // Kept across an access re-check that found nothing changed, for no longer
  // than the TTL (#1007); any change of the person's visibility empties it. See
  // `PrincipalState` for the bound and for what that trade costs.
  private readonly principalState = new PrincipalState(() => ({
    rollupByOrg: new Map<string, Cached<ProjectRollupPulsed[]>>() as Map<string, Cached<ProjectRollupPulsed[]>>,
    membershipsByOrg: new Map<string, Cached<SourceMembership[]>>() as Map<string, Cached<SourceMembership[]>>,
    catalogByOrg: new Map<string, Cached<SourceCatalogEntry[]>>() as Map<string, Cached<SourceCatalogEntry[]>>,
    detailByOrg: new Map<string, Map<number, DetailEntry>>() as Map<string, Map<number, DetailEntry>>,
    detailInFlightByOrg: new Map<string, Map<number, Promise<DetailEntry>>>() as Map<string, Map<number, Promise<DetailEntry>>>,
    catalogInFlightByOrg: new Map<string, Promise<SourceCatalogEntry[]>>() as Map<string, Promise<SourceCatalogEntry[]>>,
    retiredRollupByOrg: new Map<string, Cached<ProjectRollupPulsed[]>>() as Map<string, Cached<ProjectRollupPulsed[]>>,
    retiredMembershipsByOrg: new Map<string, Cached<SourceMembership[]>>() as Map<string, Cached<SourceMembership[]>>,
    incompleteRollupOrgs: new Set<string>(),
    epoch: 0 as number,
    catalogEpoch: 0 as number,
    warmInFlightByOrg: new Map<string, Promise<void>>() as Map<string, Promise<void>>,
    warmAgainByOrg: new Set<string>() as Set<string>
  }), { maxAgeMs: () => this.ttlMs });
  private readonly logger = new Logger(ProjectsService.name);
  private readonly ttlMs: number;
  /** The last answer Github gave, per person and org, for the reads below to
   *  fall back on when it refuses (#1003). Held OUTSIDE `principalState`
   *  deliberately: that state is replaced whenever the person's visibility
   *  changes and at least once a TTL (#1007), so a fallback kept in it would be
   *  empty exactly when it is needed. See
   *  `projects-last-good.ts` for what the key is and why serving it back is
   *  confined to a failed read. */
  private readonly lastGood: ProjectsLastGood;
  /** Which issues are somebody else's words, for the one visibility decision. */
  private readonly feedback: FeedbackScope;
  private get rollupByOrg(): Map<string, Cached<ProjectRollupPulsed[]>> { return this.principalState.current.rollupByOrg; }
  private set rollupByOrg(value: Map<string, Cached<ProjectRollupPulsed[]>>) { this.principalState.current.rollupByOrg = value; }
  /** The SOURCE shape, without `org` — the key of the map is the org, and
   *  storing it a second time inside the value is the one way the two could
   *  disagree (#697). Stamped on the way out, in `projectMemberships`. */
  private get membershipsByOrg(): Map<string, Cached<SourceMembership[]>> { return this.principalState.current.membershipsByOrg; }
  private set membershipsByOrg(value: Map<string, Cached<SourceMembership[]>>) { this.principalState.current.membershipsByOrg = value; }
  /** The add-to-project picker's candidate-boards list (#404) — same TTL cache
   *  shape as `membershipsByOrg`, and org-free for the same reason. */
  private get catalogByOrg(): Map<string, Cached<SourceCatalogEntry[]>> { return this.principalState.current.catalogByOrg; }
  private set catalogByOrg(value: Map<string, Cached<SourceCatalogEntry[]>>) { this.principalState.current.catalogByOrg = value; }
  /** Per-board detail cache + in-flight dedupe, keyed by project number inside
   *  each org's own map — never a composite key, so a board number means the
   *  same thing in both. */
  private get detailByOrg(): Map<string, Map<number, DetailEntry>> { return this.principalState.current.detailByOrg; }
  private set detailByOrg(value: Map<string, Map<number, DetailEntry>>) { this.principalState.current.detailByOrg = value; }
  private get detailInFlightByOrg(): Map<string, Map<number, Promise<DetailEntry>>> { return this.principalState.current.detailInFlightByOrg; }
  private set detailInFlightByOrg(value: Map<string, Map<number, Promise<DetailEntry>>>) { this.principalState.current.detailInFlightByOrg = value; }
  /** The catalog's in-flight dedupe (#911 review, R1). PENDING ONLY: the TTL
   *  entry above stays the one place a settled walk is kept, and this map empties
   *  itself whichever way the read ends. One reader's walk may answer another's
   *  because `mustHaveScope` has authorized the org before anything reaches here
   *  and an entry carries no viewer — the reason `listProjectCatalog` takes none. */
  private get catalogInFlightByOrg(): Map<string, Promise<SourceCatalogEntry[]>> { return this.principalState.current.catalogInFlightByOrg; }
  private set catalogInFlightByOrg(value: Map<string, Promise<SourceCatalogEntry[]>>) { this.principalState.current.catalogInFlightByOrg = value; }
  /** What a drop RETIRED rather than deleted, per org — the last payload
   *  `rollupByOrg` and `membershipsByOrg` served, kept beside the entry that was cleared and served only
   *  when the read that should replace it fails (#713). The WHOLE cache entry,
   *  `at` and all: a copy nobody can date is one nobody can size up, and the
   *  ceiling in `retired` below is the same `at` read a second way. Not a TTL —
   *  a retiree inside the ceiling is served however stale it is, because the
   *  alternative on that path is a blank page. `detailByOrg` has none — see
   *  `dropCaches`. */
  private get retiredRollupByOrg(): Map<string, Cached<ProjectRollupPulsed[]>> { return this.principalState.current.retiredRollupByOrg; }
  private set retiredRollupByOrg(value: Map<string, Cached<ProjectRollupPulsed[]>>) { this.principalState.current.retiredRollupByOrg = value; }
  private get retiredMembershipsByOrg(): Map<string, Cached<SourceMembership[]>> { return this.principalState.current.retiredMembershipsByOrg; }
  private set retiredMembershipsByOrg(value: Map<string, Cached<SourceMembership[]>>) { this.principalState.current.retiredMembershipsByOrg = value; }
  /** Moves on every drop, so a board read that went out before one cannot write
   *  what it read into the cache when it lands (#692). */
  private get epoch(): number { return this.principalState.current.epoch; }
  private set epoch(value: number) { this.principalState.current.epoch = value; }
  /**
   * The catalog's OWN epoch, moved by the button alone (#713).
   *
   * The two counters answer different questions, and `catalogByOrg` is the map
   * the difference is about. `epoch` asks "can the write that just landed have
   * changed this", and for a board's identity — node id, number, title — the
   * answer is no, which is the whole reason `dropCaches` keeps this map. Sharing
   * one counter answered it as yes anyway: a catalog read in flight when a write
   * landed was served to its caller and cached for nobody, so the next picker
   * open paid the Projects-v2 walk the drop had just declined to charge it —
   * the saving forfeited for exactly the reader it was made for.
   *
   * "Sync now" moves it, for the reason it drops the map: that button means "I
   * believe something moved that you cannot see", and a board renamed on Github
   * is what it is pressed about. So a catalog read that went out before the
   * button cannot become the answer it caches.
   */
  private get catalogEpoch(): number { return this.principalState.current.catalogEpoch; }
  private set catalogEpoch(value: number) { this.principalState.current.catalogEpoch = value; }
  /** The warm walking Github for this org right now, if there is one (#713) —
   *  see `warmOrg`. Writes only; the button keeps out of it. */
  private get warmInFlightByOrg(): Map<string, Promise<void>> { return this.principalState.current.warmInFlightByOrg; }
  private set warmInFlightByOrg(value: Map<string, Promise<void>>) { this.principalState.current.warmInFlightByOrg = value; }
  /** Orgs a write marked while a warm was already out. At most one bit per org:
   *  ten writes during one walk buy the same single walk after it. */
  private get warmAgainByOrg(): Set<string> { return this.principalState.current.warmAgainByOrg; }
  private set warmAgainByOrg(value: Set<string>) { this.principalState.current.warmAgainByOrg = value; }

  constructor(
    // Explicit token — tsx/vitest (esbuild) emit no design:paramtypes metadata.
    @Inject(PROJECTS_SOURCE) private readonly source: IProjectsSource,
    @Inject(ConfigService) private readonly config: ConfigService,
    // The shared raw-issues cache the metrics side reads — reused here (joined to
    // memberships) to derive each board's weekly close-rate (#391). One org-wide
    // scan for the whole app: no per-board GitHub call, and no duplicate scan.
    @Inject(IssuesCacheService) private readonly issuesCache: IssuesCacheService,
  ) {
    this.ttlMs = config.get<number>('PROJECTS_CACHE_TTL_MS', 300000);
    // Two hours by default, chosen off the failure it exists for: a Github
    // GraphQL point budget resets hourly, so a ceiling under an hour would
    // expire in the middle of the outage it is meant to cover.
    this.lastGood = new ProjectsLastGood(config.get<number>('PROJECTS_LAST_GOOD_MAX_MS', 7200000));
    this.feedback = feedbackScopeFrom(config);
  }

  /** Personal reads follow the person's own Github App grants; detached jobs
   * follow `GITHUB_ORGS`. A caller can narrow the owner set, never widen it.
   * Mutation candidates asked for a narrower pinned set until `PROJECTS_OWNER`
   * was retired (#1209 part 4); they now read the same owners. */
  private scopeForRead(asked?: string, scope = githubOrgs(this.config)): string[] {
    const wanted = asked?.trim();
    if (!wanted) return scope;
    const folded = wanted.toLowerCase();
    return scope.filter((o) => o.trim().toLowerCase() === folded);
  }

  /**
   * The scope, refusing to be empty.
   *
   * NOT an operator control. No setting narrows this surface any more —
   * `PROJECTS_OWNER` did and is retired (#1209 part 4) — and `GITHUB_ORGS`
   * refuses to parse to nothing, so a deployment cannot switch this surface off
   * from the environment. What reaches here is a PERSON whose Github App grants
   * cover no owner, and the floor under the states Joi does not catch: a
   * `ConfigService` built straight from an object, which is every spec in this
   * tree.
   *
   * There is no honest payload for an empty scope: an empty board list would
   * read as an org with no boards rather than as no org at all, and the picker
   * would draw an empty candidate list on a deployment whose Github token is
   * fine. So it throws, the way `DeliveryService.rollups` does on the same scope.
   *
   * A `?org=` that matched nothing cannot reach here — the controller 404s it
   * before any read — so an empty answer at this point is always an owner set
   * that was empty to begin with.
   */
  private mustHaveScope(asked?: string, owners = githubOrgs(this.config)): string[] {
    const scope = this.scopeForRead(asked, owners);
    if (scope.length === 0) {
      if (githubPrincipal()) throw new Error('projects: no authorized owners in the requested scope');
      throw new Error(
        'projects: the owner scope names no org, so there is nothing to read — set GITHUB_ORGS ' +
          'to the org login(s) this board serves.',
      );
    }
    return scope;
  }

  /**
   * Read one thing per org, concurrently, and tolerate each org separately — the
   * shape `issues-metrics`' `resolveScope` already has (#647), for the same
   * reason (#697).
   *
   * `allSettled` rather than `all`, because `all` rejects on the first failure
   * and abandons the answers already in hand — including, when the FIRST org is
   * the one that failed, every answer that came after it. Order is the
   * configured order, so the union reads org by org in the order the operator
   * wrote them.
   *
   * Throws only when NOTHING was read, carrying every org's own reason and the
   * first as `cause`, because with several orgs there may be several. With one
   * configured org "every org failed" and "the read failed" are the same case,
   * which is what keeps a single-org deployment's behaviour unchanged.
   */
  private async perOrg<T>(orgs: string[], read: (org: string) => Promise<T>): Promise<{ org: string; data: T }[]> {
    const settled = await Promise.allSettled(orgs.map((org) => read(org)));
    const out: { org: string; data: T }[] = [];
    const failures: Error[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        out.push({ org: orgs[i], data: r.value });
        return;
      }
      const err = r.reason as Error;
      failures.push(err);
      // Named in the log, because the payload cannot say it: an org that
      // contributed nothing is simply absent from the union, and absent is where
      // "has no boards" and "could not be read" would otherwise look the same.
      this.logger.warn(`projects: ${orgs[i]} unreadable: ${err.message}`);
    });
    if (out.length === 0) throw this.totalFailure(failures);
    return out;
  }

  /**
   * What every org in scope failing throws, for every Projects read that walks a
   * scope (#1035, widened by #1107).
   *
   * The CODE carries the verdict to the browser. When every failure says "not
   * now", this is a 503 carrying PROJECTS_NOT_NOW_CODE, which the browser may
   * answer with its own held or saved copy. Anything else stays a 500, which it
   * may not. The status alone cannot say it, because board-api answers 503 for
   * things that are not an outage at all (see PROJECTS_NOT_NOW_CODE). The 503
   * carries the same reasons the 500 did, and they reach the wire; each one said
   * "not now" about this reader's own access, which is what a quota cooldown
   * already says when it is thrown bare.
   *
   * ONE METHOD, TWO READS, and that is the point of it being a method (#1107).
   * `perOrg` above earned this code for the rollup in #1035, and `detailInScope`
   * below threw a bare `Error` for the same total failure — so a quota cooldown
   * reached a board page as an uncoded 500, indistinguishable there from the
   * FORBIDDEN a withdrawn grant arrives as, and #1065's browser rule cleared the
   * board over it. #1003 had decided that a cooldown leaves Projects drawn. Two
   * copies of this decision is how the two reads came to disagree, so there is
   * one, and `projects-not-now-code.spec.ts` pins the code to this body and both
   * callers to this method.
   *
   * A failure list that is EMPTY gets the plain error. `every` is vacuously true
   * over nothing, so an empty list would send the code with no reason behind it,
   * which is the shape `servableRefusal`'s own note refuses: a gate that opens on
   * what it cannot read is not a gate. Both callers reach this only with at least
   * one failure, `mustHaveScope` refusing an empty scope above, so this is a
   * floor rather than a live branch.
   */
  private totalFailure(failures: Error[]): Error {
    const reasons = failures.map((e) => e.message).join('; ');
    if (failures.length > 0 && failures.every((e) => servableRefusal(e))) {
      return new ServiceUnavailableException({ message: reasons, code: PROJECTS_NOT_NOW_CODE }, { cause: failures[0] });
    }
    // A WITHDRAWN GRANT SAYS SO, with a status the browser can act on (#1395).
    // A Projects grant taken away arrives from GraphQL as `FORBIDDEN` on a 200,
    // carrying no HTTP status at all, so this method used to hand it on as a
    // bare `Error` and the browser met it as an uncoded 500. That was tolerable
    // while the browser withdrew a saved copy on any 500. It is not tolerable
    // now: since #1395 only a 401, a 403 and a 404 withdraw, so a board this
    // reader may no longer see would have stayed on their screen until the
    // copy aged out, up to a day later.
    //
    // ANY failure being "not you" decides it, where the "not now" arm above
    // needs EVERY failure to agree. The asymmetry is the one `servableRefusal`
    // argues for: withholding a board somebody could have seen costs them a
    // reload, and serving one they may no longer see is the thing this file is
    // not allowed to do.
    if (failures.some((e) => notYouRefusal(e))) {
      return new ForbiddenException({ message: reasons }, { cause: failures[0] });
    }
    return new Error(reasons, { cause: failures[0] });
  }

  /** This org's entry, if it is still inside the TTL. The one place a TTL cache
   *  here decides "fresh". */
  private freshFor<T>(byOrg: Map<string, Cached<T>>, org: string): T | undefined {
    const hit = byOrg.get(org);
    return hit && Date.now() - hit.at < this.ttlMs ? hit.data : undefined;
  }

  /**
   * Clear an org's entry — or every org's, when none is named — keeping what was
   * cleared as the copy a failed read falls back to (#713).
   *
   * The move is made AT THE DROP, which is the whole mechanism: the read after a
   * drop is cold by construction, so by the time it fails there is nothing left
   * to keep. An org with nothing cached keeps whatever it retired last, the way
   * `IssuesCacheService` does — a second drop before
   * the read recovers must not throw away the answer the first one saved.
   */
  private retire<T>(byOrg: Map<string, Cached<T>>, retired: Map<string, Cached<T>>, org?: string): void {
    for (const key of org === undefined ? [...byOrg.keys()] : [org]) {
      const hit = byOrg.get(key);
      // The ENTRY, not its `data`: `at` is when the source answered, and it is
      // the only thing that can say how old a served retiree is or refuse one
      // that has stopped being an answer at all.
      if (hit) retired.set(key, hit);
      byOrg.delete(key);
    }
  }

  /**
   * What a drop retired for this org, when the read that should have replaced it
   * failed (#713). Unreachable on the success path by construction: every caller
   * is a `catch`, so a source that answered never reaches here.
   *
   * Served, not cached — the answer goes to the caller who asked and the slot
   * stays empty, so the next reader tries the source rather than being handed a
   * pre-write payload for the rest of a five-minute TTL.
   *
   * Nothing retired re-throws. A deployment that has never served this org has
   * no last-good boards, and an empty list would say "this org has no boards"
   * about an outage — the answer #722 refuses on the same page.
   *
   * So does one past `RETIREE_MAX_TTLS` — see the constant for the multiple and
   * the argument. It is DROPPED at that point rather than left to be re-refused
   * on every read: past the ceiling it is not an answer, and a drop that came
   * later would otherwise pick it back up (`retire` keeps whatever is there when
   * the cache slot is empty).
   */
  private retired<T>(retired: Map<string, Cached<T>>, org: string, what: string, err: unknown): T {
    if (githubPrincipal()) throw err;
    const stale = retired.get(org);
    if (stale === undefined) throw err;
    const ageMs = Date.now() - stale.at;
    if (ageMs > RETIREE_MAX_TTLS * this.ttlMs) {
      retired.delete(org);
      throw err;
    }
    // Named in the log, because the payload cannot say it: this is the copy from
    // before the write, and nothing on the wire dates it. Generic over both
    // callers — the BOARDS path additionally withholds the five joined figures
    // on the way out (`rollupBoards`, `unjoined`), and the membership index
    // withholds nothing, so the log is the only age either of them has.
    this.logger.warn(
      `projects: ${org}'s ${what} could not be re-read after a write dropped it ` +
        `(${err instanceof Error ? err.message : String(err)}), so the copy that drop retired — the ` +
        `read of ${new Date(stale.at).toISOString()}, ${Math.round(ageMs / 1000)}s old — is served ` +
        'rather than failing the page (#713).',
    );
    return stale.data;
  }

  /**
   * The last answer this person was given for this org, when the live read has
   * just failed (#1003).
   *
   * Reached only from a `catch`, and only after the fresh cache has been asked
   * again — so nothing here changes what a working read serves. What it changes
   * is the failure: `perOrg` drops an org that throws, and an org absent from
   * the union reads as an org with no boards, so on a person's credential (where
   * `retired` refuses by design) one refused read took the whole surface off the
   * page. See `projects-last-good.ts` for the key, which is the person's own
   * visibility, and for why the copy can never cross to anybody else.
   *
   * `undefined` when there is nothing inside the ceiling, and the caller then
   * carries on to `retired` and its own rethrow — a board with no last-good copy
   * fails exactly as it did.
   */
  private recall<T>(kind: LastGoodKind, org: string, err: unknown): { at: number; data: T } | undefined {
    // The refusal decides this before the store is asked (#1003 review). A 403
    // is Github answering the question this store must not overrule, and a
    // held copy standing in for one would be strictly worse than the blank
    // surface it replaces.
    if (!servableRefusal(err)) return undefined;
    const held = this.lastGood.recall<T>(kind, org);
    if (!held) return undefined;
    // Named in the log for the reason `retired`'s line is: nothing on the wire
    // dates this payload except, for the rollup, `lastGoodCopy`. ONCE per
    // outage per slot, not once per read — see `announce`.
    if (held.announce) this.logger.warn(
      `projects: ${org}'s ${kind} could not be read ` +
        `(${err instanceof Error ? err.message : String(err)}), so the last answer this reader was ` +
        `served — the read of ${new Date(held.at).toISOString()}, ` +
        `${Math.round((Date.now() - held.at) / 1000)}s old — is served rather than dropping the org ` +
        'from the answer (#1003). Said once until a real answer lands.',
    );
    return held;
  }

  /** This org's per-board slots, created on first touch. */
  private boardsOf<T>(byOrg: Map<string, Map<number, T>>, org: string): Map<number, T> {
    const existing = byOrg.get(org);
    if (existing) return existing;
    const fresh = new Map<number, T>();
    byOrg.set(org, fresh);
    return fresh;
  }

  /**
   * The board rollup as this caller may read it (#497). Every board keeps its
   * counts, completion, ring and weekly trend exactly as the source produced
   * them; the one field that depends on who is asking is `lastClosed`, which is
   * picked here from the candidates the source handed up.
   */
  async listProjects(viewer: Viewer | undefined, org?: string): Promise<ProjectSummary[]> {
    // The rollup's closes come from the list query, which reads no body, so the
    // footer marker arrives from the shared index (#516). Resolved once per
    // read, beside the rollup it already awaits.
    const [boards, submissions] = await Promise.all([
      this.rollupScope(org),
      this.issuesCache.submissionIndex(),
    ]);
    return boards.map(({ recentCloses, ...board }) => ({
      ...board,
      lastClosed: readableLastClosed(recentCloses, viewer, this.feedback, submissions),
    }));
  }

  /**
   * Every board in scope, each carrying the org it was read from (#697).
   *
   * Grouped by org in the configured order, and inside each org in the order
   * that org's source produced — biggest board first. Not re-sorted across the
   * union: `org` is on every board now, so a reader can tell them apart without
   * the list being interleaved, and the per-org order is the one the source
   * actually chose.
   */
  private async rollupScope(asked?: string): Promise<(ProjectRollupPulsed & { org: string })[]> {
    const read = await this.perOrg(this.mustHaveScope(asked), (org) => this.rollupBoards(org));
    // Stamped from the org the read was MADE under — the same string the cache
    // entry is filed by — so the label and the cache key cannot disagree.
    return read.flatMap(({ org, data }) => data.map((board) => ({ ...board, org })));
  }

  /** The raw, viewer-independent rollup — cached, and never served as-is:
   *  `recentCloses` holds the titles a pick may have skipped past.
   *
   *  Fresh, then the source, then what a drop retired (#713) — in that order,
   *  and the fallback is reached only from the `catch`. Here rather than around
   *  `rollupScope`, because this is where ONE org's read fails: `perOrg` above
   *  drops a failed org from the union, and an org absent from the union reads
   *  as an org with no boards. Falling back per org gives it back its last-good
   *  boards instead, and the whole-page 500 — every org failing at once — stops
   *  being reachable while there is anything to fall back to.
   *
   *  Through `unjoined` on the way out, and never on the way in: what is retired
   *  is the payload as it was read, and what is SERVED is that payload minus the
   *  five figures a copy from before the write cannot speak for (#713).
   *  Withholding at retirement instead would put the decision in `retire`, which
   *  is generic over the two maps and holds the membership index as well — and
   *  it is being served, not being kept, that is the thing this is about. */
  private async rollupBoards(org: string): Promise<ProjectRollupPulsed[]> {
    const cached = this.freshFor(this.rollupByOrg, org);
    if (cached) return cached;
    try {
      return await this.readRollup(org);
    } catch (err) {
      // The cache AGAIN, and it is a different question the second time (#713).
      // Nothing here dedupes what is in flight, so two readers arriving together
      // each make their own read — and when one succeeds while the other meets a
      // rate limit, the winner has both filled this map and deleted the retiree
      // the loser would have fallen back to. Without this line that loser
      // rethrows, `perOrg` drops the org, and the page 500s with the answer
      // sitting in front of it.
      const fresh = this.freshFor(this.rollupByOrg, org);
      if (fresh) return fresh;
      const held = this.recall<ProjectRollupPulsed[]>('boards', org, err);
      if (held) return held.data.map(unjoined);
      return this.retired(this.retiredRollupByOrg, org, 'boards', err).map(unjoined);
    }
  }

  /** One org's rollup, read and joined. Uncached callers only — `rollupBoards`
   *  above is the ladder.
   *
   *  The three reads below stay CONCURRENT on purpose (#518). The first two are
   *  two shapes of one Github list query, and the source shares a round trip
   *  between callers that are in flight together — so a cold read costs one
   *  fetch. Await them in sequence and it quietly costs two again. */
  private async readRollup(org: string, report?: (complete: boolean) => void): Promise<ProjectRollupPulsed[]> {
    const state = this.principalState.current;
    const epoch = state.epoch;
    let complete = false;
    let joined = false;
    try {
      const data = await this.buildRollup(org, (readComplete, readJoined) => {
        complete = readComplete;
        joined = readJoined;
        report?.(readComplete);
      });
      if (epoch === state.epoch) {
        if (complete) state.incompleteRollupOrgs.delete(org);
        // An unjoined read caches nothing; a concurrent fresh answer wins.
        // A joined, truncated read cached its own incomplete answer.
        else if (joined || !this.freshFor(state.rollupByOrg, org)) state.incompleteRollupOrgs.add(org);
      }
      return data;
    } catch (err) {
      // A concurrent success still supplies a current answer. This marker never
      // supplies data or prevents the next read from retrying (#722, #1208).
      if (epoch === state.epoch && !this.freshFor(state.rollupByOrg, org)) {
        state.incompleteRollupOrgs.add(org);
      }
      throw err;
    }
  }

  private async buildRollup(org: string, report?: (complete: boolean, joined: boolean) => void): Promise<ProjectRollupPulsed[]> {
    const epoch = this.epoch;
    // `ingested` says whether the third read RESOLVED; `joined` narrows that to
    // whether it can speak for THIS org (#722). Both are needed, because the
    // ingest has three answers and only one of them is a throw — see
    // `coversOrg`. Together they are what the five derived figures are withheld
    // on, and what stops an infrastructure failure being cached for the TTL at
    // the end of this method.
    const [base, memberships, { issues, joined: ingested, orgs }] = await Promise.all([
      this.source.listProjects(org),
      // The RAW index, not `orgMemberships`' ladder: a join computed against
      // what a drop retired must not be cached as a rollup (#713).
      // ONE org's memberships, not the union's (#697). The pulse join keys on
      // board NUMBER, which is unique only within an org — so joining the whole
      // union here would give org B's board 3 whatever org A's board 3 did.
      // Joining per org keeps the key honest and leaves `project-pulse.ts`
      // untouched.
      this.readMemberships(org),
      this.rawIssues(),
    ]);
    const joined = ingested && coversOrg(org, orgs);
    report?.(joined && base.every((board) => board.itemsComplete !== false), joined);
    // ONE clock reading for both series, so the week and the day buckets can
    // never be a boundary apart on the same rollup.
    const nowIso = new Date().toISOString();
    const weekly = weeklyClosedByProject(issues, memberships, nowIso);
    // The same already-awaited `issues` and `memberships` at a day divisor
    // (#663) — no second fetch, no second await, the three reads above stay
    // concurrent.
    const daily = dailyByProject(issues, memberships, nowIso);
    // `closedThisWeek` is taken off the source's board here rather than read
    // through it, so the spread at the end of this block cannot put the seeded
    // one back on a board the gate below withholds it from (#715).
    const data = base.map(({ closedThisWeek: seeded, openedThisWeek: seededOpened, ...p }) => {
      const derived = weekly[p.number];
      // NO fixture fallback on the day SERIES, deliberately, unlike the week
      // above: the join's answer is served whatever it says, zeros included. A
      // board with nothing in the last fortnight is a board with nothing in the
      // last fortnight, and a seeded series would draw movement that never
      // happened. A board the memberships never mentioned gets its zeros here.
      // The week's opened COUNT below is the one thing derived from it that does
      // fall back, because it is half of a pair and its other half already did.
      const pulse = daily[p.number] ?? { opened: zeroDays(), closed: zeroDays() };
      // Prefer the org-wide join; fall back to whatever the source seeded when it
      // produced nothing (e.g. the fixture, whose issue URLs live in a different
      // set than the metrics fixture, so its own seed series keeps local dev live).
      const joinAnswered = Boolean(derived && derived.some((v) => v > 0));
      const weeklyClosed = joinAnswered ? derived! : p.weeklyClosed;
      const closedThisWeek = weeklyClosed.length ? weeklyClosed[weeklyClosed.length - 1] : seeded;
      // The pair comes from ONE place or the card's sentence lies (#851). Both
      // from the join, or both from the seed — never a seeded close count beside
      // a joined open count, which is what a straight `openedThisWeekOf(...)`
      // here would produce on the fixture: "This week: 5 closed, 0 opened",
      // where the 5 is a seed and the 0 is the join saying it matched nothing.
      // Two figures the reader is invited to compare have to be answers to the
      // same question, and `joinAnswered` is the one bit that says they are.
      const openedThisWeek = joinAnswered ? openedThisWeekOf(pulse.opened) : seededOpened;
      // A board the source could not read whole serves NO day series (#690).
      // Project items come back in board order, so the ones a short read cut off
      // are the newest — the trailing 24-hour bucket the card leads with is the
      // first thing wrong, and wrong by all of it rather than by the shortfall.
      // Empty, not zeros: fourteen zeros would claim a quiet fortnight on what
      // may be the busiest board in the org.
      //
      // The source's own answer, not a derivation here: it is settled against
      // the `totalCount` Github reports beside the items, which exists in the
      // payload and nowhere else. This layer holds no page size and no total, so
      // anything it computed would be a guess.
      // `!== false`, not a truthiness test: the frontend's half of this gate is
      // spelled that way (`truncatedNote` in projects/pulse.ts), and an absent
      // flag would otherwise be withheld here while the row went on counting.
      // Nothing in the tree can produce one — `ProjectRollup.itemsComplete` is a
      // required boolean — so this changes no answer today; it keeps the claim
      // that these are ONE gate true of the code rather than of the comment.
      const itemsComplete = p.itemsComplete;
      const readWhole = itemsComplete !== false;
      // TWO gates, deliberately not one (#722). `readWhole` is about THIS board's
      // item read; `joined` is about the org-wide join every board's figures come
      // from. They have different blast radii and different remedies, both can be
      // false at once, and the payload keeps them apart so a reader can say which
      // sentence is true. Folding them together would make one of the two
      // unsayable.
      const derivable = readWhole && joined;
      // The week figures stand behind that SAME gate (#715), and for the same
      // reason. Both come from the join above, and `listProjects()` shares one
      // source read with `projectMemberships()` — so a board whose items came up
      // short has a membership list short by exactly those items, and the ones it
      // lost are the newest: most of a week bucket. Withheld after the fixture
      // fallback rather than before it, so a truncated board is withheld whether
      // its figure came from the join or from the source's seed.
      //
      // The `joined` half of the gate (#722) withholds the same two figures for a
      // different reason: with no join the fallback IS the answer, and a source
      // seed is not evidence about the week — it is what the fixture uses to keep
      // local dev live.
      const board = {
        ...p,
        itemsComplete,
        // Said on every board of the rollup, true or false, so absent on the wire
        // means only what the type says it means: an api that predates the field,
        // or the detail route, which runs no join at all.
        pulseJoined: joined,
        // Said on every board this path reads, and always `false` (#770): a read
        // that answered is not a copy from before a write, whatever else went
        // wrong with it. `unjoined` is the one place a `true` comes from, and it
        // is reached only from `rollupBoards`' catch. Stamped here rather than
        // defaulted downstream so the retiree's own copy carries a `false` while
        // it sits in the cache, and the flip is made where the decision is.
        lastGoodCopy: false,
        // Said on every board this path produces, for the reason `lastGoodCopy`
        // above is (#792). `false` here and flipped to `true` by
        // `withoutJoinedFigures` on the way out, so absent on the wire means
        // only what the type says it means: a board-api predating the field, or
        // the detail route.
        joinedFiguresWithheld: false,
        weeklyClosed,
        closedThisWeek,
        openedThisWeek,
        dailyOpened: pulse.opened,
        dailyClosed: pulse.closed,
      };
      // Built whole and then taken apart, through the SAME function the retiree
      // goes through (#713): which figures the join owns is stated once, so a
      // fifth of them cannot be added here and left live on a copy from before a
      // write. The `joinedFiguresWithheld` saying they are gone is stamped in
      // that same place (#792), so it answers for this call as well as for the
      // retiree's, including the read-short case neither caller decides.
      // `pulseJoined` is deliberately not part of it — this board may have a
      // join that ran and items that came up short, which is the pair of gates
      // above and the one thing a retiree cannot be.
      return derivable ? board : withoutJoinedFigures(board);
    });
    // Only while this read still describes what is being served: a rollup read
    // that went out before a write is answered to its own caller and never
    // cached, or it would put the pre-write boards back (#692).
    //
    // And only when the join RAN (#722). A rollup with five figures withheld is
    // an answer about an outage rather than about the org, and caching it would
    // serve that outage to every reader for the whole TTL — five minutes of
    // withheld pulse bought with one failed read. The caller that hit the failure
    // is still answered; the next one pays a fresh attempt instead, which is the
    // read that recovers.
    if (joined && epoch === this.epoch) {
      this.rollupByOrg.set(org, { at: Date.now(), data });
      // There is a current answer again, so the copy the drop retired has
      // nothing left to stand in for (#713). The next drop retires this one.
      this.retiredRollupByOrg.delete(org);
      // And the same answer again for the person who asked for it (#1003), in
      // the one store that outlives their next permission check. Behind the
      // same `joined` gate the cache is: a rollup with the five joined figures
      // withheld describes an outage rather than the org, and is no better a
      // thing to fall back on later than it is to cache now.
      this.lastGood.keep('boards', org, data);
    }
    return data;
  }

  /** The bulk issues list for the pulse joins — the weekly close-rate (#391) and
   *  the two 14-day series (#663). `createdAt` rides along for the opened
   *  direction; `RawIssue` has carried one all along, so nothing is invented
   *  here. Best-effort — a hiccup pulling issues must not blank the whole
   *  rollup, so it still degrades to no join and every other figure on every
   *  board is served exactly as it was.
   *
   *  It reports whether the join RAN, which is the whole of #722. Returning bare
   *  `[]` on a failure made the outage indistinguishable from a real empty read:
   *  an empty issues list joins to zeros, zeros fail the `some(v => v > 0)` test
   *  in `rollupBoards`, so the week series falls back to whatever the source
   *  seeded and the week count to the seeded 0, while both day series come out
   *  fourteen zeros —
   *  which is precisely the payload a genuinely quiet org produces. `joined` is
   *  the one bit that separates them, and `rollupBoards` withholds the five
   *  joined figures on a false rather than serving a fallback as a reading.
   *
   *  `joined` here is only HALF the answer, and `orgs` is the other half. A
   *  throw is the rarest of the ingest's three failures — see `coversOrg` — so
   *  the snapshot's per-org outcomes ride out beside the issues and the caller
   *  folds in the one that is about its own org. */
  private async rawIssues(): Promise<{
    // `stateReason` rides along because the pulse join reads it (#1014): whether
    // a close was DELIVERY is decided inside `weeklyClosedByProject` and
    // `dailyByProject`, off this field, so nothing here re-filters and the two
    // series cannot end up applying the rule a different number of times.
    issues: { htmlUrl: string; closedAt: string | null; createdAt: string; stateReason: CloseReason }[];
    joined: boolean;
    orgs: OrgReadOutcome[];
  }> {
    try {
      const { issues, orgs } = await this.issuesCache.getIssues();
      // `?? []` for the tests that stub the cache without one: an absent list is
      // "said nothing", which `coversOrg` already treats as no claim.
      return { issues, joined: true, orgs: orgs ?? [] };
    } catch (err) {
      this.logger.warn(`pulse issues join skipped: ${(err as Error).message}`);
      return { issues: [], joined: false, orgs: [] };
    }
  }

  /**
   * One board's drill-in detail as this caller may read it (#497): a submission
   * row keeps everything but its title, and the recency line names the newest
   * close they may read. The cached board underneath is untouched, so the pass
   * runs on every read — fresh, stale or cold alike.
   */
  async getProject(number: number, viewer: Viewer | undefined, org?: string): Promise<ProjectDetail | null> {
    // The ROWS need no index — the detail query reads each issue's body and the
    // source recorded the footer off it (#516). The CLOSES still do: they are
    // summarised from the same nodes but shaped by the rollup path, which the
    // list query also feeds.
    const [found, submissions] = await Promise.all([
      this.detailInScope(number, org),
      this.issuesCache.submissionIndex(),
    ]);
    if (!found) return null;
    const { recentCloses, items, ...board } = found.raw;
    return {
      org: found.org,
      // `itemsComplete` rides in on this spread (#690): the source answered it
      // off its own paging, and the detail query follows its board's cursor to
      // the end exactly as the rollup does, so this route neither derives it nor
      // overrides it.
      ...board,
      // Empty, not zeros, and not the rollup's answer: the detail cache is a
      // per-board fetch that never runs the org-wide join, so this route has no
      // day series to tell the truth with. `[]` says "not derived here" the way
      // the live source's `weeklyClosed: []` does; fourteen zeros would claim a
      // fortnight of silence on a board that may have been busy. The board card
      // that draws the series reads the rollup (#663).
      dailyOpened: board.dailyOpened ?? [],
      dailyClosed: board.dailyClosed ?? [],
      lastClosed: readableLastClosed(recentCloses, viewer, this.feedback, submissions),
      items: readableItems(items, viewer, this.feedback),
    };
  }

  /**
   * The first board in scope with this number, and the org it was found in
   * (#697).
   *
   * WITH a `?org=`, the scope is that one org and this is just that org's board.
   *
   * WITHOUT one, the scope is every configured org — and two orgs may both have
   * a board numbered 3, because a project number is unique only within an org.
   * The FIRST org in configured order that holds it wins, and the second org's
   * board 3 is unreachable on this route until the caller names its org. That is
   * a deliberate, documented narrowing rather than an accident: `board-frontend`
   * sends no `?org=` yet, so the alternative — refusing an ambiguous number —
   * would 404 every board on a deployment that named a second org. The route a
   * reader wants for the other board is `/api/projects/3?org=<the other org>`,
   * which works today.
   *
   * SEQUENTIAL, not concurrent, unlike the fan-outs above, and for a reason the
   * union does not have: "the first org that has it" means a later org's read is
   * only needed when an earlier one came back empty. A board in the first org
   * therefore costs ONE Github round trip here where a parallel fan-out would
   * always cost as many as there are orgs.
   *
   * A per-org failure is skipped rather than thrown, the same rule the union
   * follows: an org whose read failed cannot say whether it holds this number,
   * and refusing the board another org DID answer for would blank a page over
   * somebody else's outage. Nothing found and every org failed still throws, so
   * a total outage is not served as a 404.
   */
  private async detailInScope(
    number: number,
    asked?: string,
  ): Promise<{ org: string; raw: ProjectDetailRaw } | null> {
    const scope = this.mustHaveScope(asked);
    const failures: Error[] = [];
    for (const org of scope) {
      try {
        const raw = await this.rawDetail(org, number);
        if (raw) return { org, raw };
      } catch (err) {
        failures.push(err as Error);
        this.logger.warn(`projects: ${org} unreadable for board ${number}: ${(err as Error).message}`);
      }
    }
    if (failures.length === scope.length && failures.length > 0) {
      // `totalFailure`, not a bare `Error` of its own (#1107). Every org in
      // scope failed, which is the same verdict `perOrg` reaches for the rollup
      // — and until this call the two reads answered it differently, so a quota
      // cooldown that left the Projects rollup drawn took an open board off the
      // screen. See `totalFailure` for why one method rather than two throws.
      throw this.totalFailure(failures);
    }
    return null;
  }

  /**
   * The raw board, served stale-while-revalidate per board (#304): a fresh entry
   * returns directly; a stale entry returns immediately while a single background
   * refresh runs; a cold board awaits the source once. So only the very first
   * open of a given board eats the multi-second GraphQL fetch; every revisit
   * within the TTL is instant, and a stale board never blocks. Never served
   * as-is — `getProject` above is the only reader.
   */
  private rawDetail(org: string, number: number): Promise<ProjectDetailRaw | null> {
    const now = Date.now();
    const hit = this.boardsOf(this.detailByOrg, org).get(number);
    // Fresh: serve directly.
    if (hit && now - hit.at < this.ttlMs) return Promise.resolve(hit.data);
    // Stale: serve the old data now, refresh in the background (SWR) — no wait.
    // HANDLED, the same way `DeliveryService.orgRollup` and
    // `IssueBucketsService.getBuckets` handle their identical branch: nobody is
    // waiting on this promise, so a rejection with no `catch` is an unhandled
    // rejection, and Node's default for one is to end the process. An org that
    // cannot be reached rejects it on every open of any board now, because the
    // detail read walks the whole scope rather than one org.
    if (hit) {
      this.refreshDetail(org, number, now).catch((err) =>
        this.logger.warn(`background detail refresh failed for ${org}#${number}: ${(err as Error).message}`),
      );
      return Promise.resolve(hit.data);
    }
    // Cold (never fetched): must wait once; a fetch failure propagates.
    return this.refreshDetail(org, number, now).then((e) => e.data);
  }

  /** Fetch one board's detail and replace its cache entry. Deduped via
   *  `detailInFlightByOrg` so concurrent opens of the same board hit GitHub once
   *  — per org, so one org's open never satisfies another's. */
  private refreshDetail(org: string, number: number, now: number): Promise<DetailEntry> {
    const inFlight = this.boardsOf(this.detailInFlightByOrg, org);
    const running = inFlight.get(number);
    if (running) return running;
    const epoch = this.epoch;
    const p: Promise<DetailEntry> = this.source
      .getProject(org, number)
      .then((data) => {
        const entry: DetailEntry = { at: now, data };
        // Same rule as the rollup: a board read disowned by a write is served
        // to its caller and cached for nobody (#692).
        if (epoch === this.epoch) this.boardsOf(this.detailByOrg, org).set(number, entry);
        return entry;
      })
      // Only its OWN slot, so a read disowned by a drop cannot delete the slot a
      // later reader is waiting on. BELT AND BRACES here, unlike the same check
      // in the four flat caches: `inFlight` is this org's INNER map, closed over
      // when the read went out, and `dropCaches` clears the OUTER one — so a
      // disowned read is already deleting from a map nothing can reach. No test
      // can reach the state where the identity check is what saves it (#692),
      // and it stays because the day this map stops being nested is the day it
      // becomes the only thing standing there.
      .finally(() => {
        if (inFlight.get(number) === p) inFlight.delete(number);
      });
    inFlight.set(number, p);
    return p;
  }

  /** The oldest moment among recorded organisations. Coverage travels with it
   *  in `freshness`, so an absent rollup does not hide the ones we have (#1185). */
  lastSyncedAt(): string | null {
    return this.freshness().syncedAt;
  }

  freshness(): SourceFreshness {
    const scope = this.scopeForRead();
    // Peek keeps a poll about cache coverage from marking the request as a
    // permission-sensitive read of the boards themselves (#1007, #1169).
    const state = this.principalState.peek();
    const rollup = state?.rollupByOrg;
    const built = scope.map((org) => rollup?.get(org)?.at)
      .filter((at): at is number => at !== undefined);
    return {
      syncedAt: built.length ? new Date(Math.min(...built)).toISOString() : null,
      organisations: { recorded: built.length, total: scope.length },
      ...(scope.some((org) => state?.incompleteRollupOrgs.has(org)) ? { incomplete: true } : {}),
    };
  }

  /** Force-refresh the Projects caches (#301, "sync now"): drop the rollup,
   *  memberships, catalog and all per-board detail, then warm the rollup so the
   *  surface is current on return. Open boards re-warm their detail lazily on
   *  next open.
   *
   *  EVERY org in scope, not one (#697). It used to drop `orgForRead()`'s single
   *  org and leave any other alone, on the reasoning that this call is about the
   *  one org a person was looking at when they pressed refresh. What they are
   *  looking at is now the UNION — the rollup carries every configured org's
   *  boards — so dropping one org's slots would refresh part of the page and
   *  leave the rest as stale as it was, which is the one outcome that button
   *  must not have.
   *
   *  `'button'`, and that says both of the things this call does differently:
   *  it drops the picker's catalog, because the button means "I believe
   *  something moved that you cannot see", and its warm is not coalesced with
   *  the writes', because a person is waiting on the answer. See `refill`. */
  resync(): Promise<void> {
    return this.refill('button');
  }

  async resyncWithOutcome(): Promise<'succeeded' | 'degraded' | 'skipped'> {
    if (this.scopeForRead().length === 0) return 'skipped';
    let complete = true;
    await this.refill('button', (value) => { complete = value; });
    return complete ? 'succeeded' : 'degraded';
  }

  /**
   * One org's warm, with at most one walk of Github answerable for it (#713).
   *
   * The cap exists because this lane removed an accidental one. `FreshnessRegistry`
   * fires a warm on every capability-declaring write, never awaits it and debounces
   * nothing; before the disown, each warm joined the board-list latch already
   * running, so a burst collapsed onto roughly one walk per org. That collapsing
   * WAS the bug — the joined read predated the write — and taking it away left N
   * writes costing N walks, at 63 Projects-v2 points each against a 5,000/hour
   * budget.
   *
   * TRAILING, and that is the whole design. A write arriving while a walk is out
   * marks the org and starts nothing; when that walk lands, exactly one more runs
   * if anything marked it. Two properties, and both are needed:
   *
   *  - at most one WARM holding the org's slot at a time, whatever the burst
   *    size. Two things walk outside that and can each be a second walk in
   *    flight for the same org: the button (see `refill`, and the spec that pins
   *    it) and a walk that gave the slot up on the bound below and is still
   *    running;
   *  - the last walk goes out AFTER the last write, so it snapshots the epoch
   *    that write moved and its answer is cacheable.
   *
   * A LEADING join — handing the second write the walk already running — is the
   * shape to avoid, and it is the bug one level up: that read went out before
   * write B's drop, so B's own epoch guard refuses to cache it. It would serve
   * nothing stale; it would simply mean every write after the first in a burst
   * paid a walk that is thrown away, which is worse than doing nothing.
   *
   * BOUNDED, because nothing under it is (#713). The slot is given up after
   * `WARM_WALK_MAX_MS` whether the walk has landed or not — see the constant for
   * why a bound is needed at all and how the number was picked. Without it a
   * single hung read left every later write taking the branch above, marking an
   * org nothing would ever unmark.
   *
   * "Sync now" does NOT come through here — see `refill`.
   */
  private warmOrg(org: string): Promise<void> {
    const running = this.warmInFlightByOrg.get(org);
    // Marked, not joined. The returned promise is the running chain, which does
    // not settle until the trailing walk this just asked for has landed too, so
    // a caller that does await a warm still waits for a walk that covers it.
    if (running) {
      this.warmAgainByOrg.add(org);
      return running;
    }
    // Started before the walk, cleared by it. `unref`, so a bound that outlives
    // the request holds neither the process nor the test runner open.
    const expiry = setTimeout(() => this.expireWarm(org, walk), WARM_WALK_MAX_MS);
    expiry.unref();
    const walk: Promise<void> = this.readRollup(org).then(
      () => {
        clearTimeout(expiry);
        return this.afterWarm(org, walk);
      },
      // A failed walk still releases the slot and still runs the trailing one:
      // a Github that refused write A's warm must not leave the org marked for
      // ever, nor swallow the failure the caller is owed.
      (err) => {
        clearTimeout(expiry);
        // The ORIGINAL failure, whatever the trailing walk does. `.then` alone
        // never ran when that walk rejected too, so during an outage — when it
        // rejects every time — the first and most diagnostic failure was the one
        // nobody saw.
        return this.afterWarm(org, walk)
          .catch((trailing: unknown) =>
            this.logger.warn(
              `projects: ${org}'s trailing warm failed too ` +
                `(${trailing instanceof Error ? trailing.message : String(trailing)})`,
            ),
          )
          .then(() => {
            throw err;
          });
      },
    );
    this.warmInFlightByOrg.set(org, walk);
    return walk;
  }

  /**
   * Give up this org's slot for a walk that has not landed inside the bound
   * (#713), so the next write starts a fresh one.
   *
   * Its OWN slot, the identity check `afterWarm` makes and for a reason this
   * method is what creates: past the bound there can be a LATER walk in the slot,
   * and a hung walk landing after that must not take it — the org would be back
   * to one walk per write for as long as the newer one runs.
   *
   * The mark is left alone. A write that arrived during the hung walk is still a
   * write no completed walk has covered, so `afterWarm` running it when some
   * later walk lands is the right answer rather than a wasted one.
   */
  private expireWarm(org: string, walk: Promise<void>): void {
    if (this.warmInFlightByOrg.get(org) !== walk) return;
    this.warmInFlightByOrg.delete(org);
    this.logger.warn(
      `projects: ${org}'s warm has not answered in ${Math.round(WARM_WALK_MAX_MS / 1000)}s, so the next ` +
        'write may start its own walk rather than waiting on this one for ever (#713).',
    );
  }

  /** Release this org's slot and run the ONE walk a write marked while it was
   *  out. Its OWN slot, the way every in-flight slot in this tree is released
   *  (`repos.service.ts` beginRefresh): a walk disowned by a later one must not
   *  clear the slot that later one has taken. Released BEFORE the trailing walk
   *  is started, so the trailing walk takes the slot rather than being coalesced
   *  into the walk that has just ended. */
  private afterWarm(org: string, walk: Promise<void>): Promise<void> {
    if (this.warmInFlightByOrg.get(org) === walk) this.warmInFlightByOrg.delete(org);
    return this.warmAgainByOrg.delete(org) ? this.warmOrg(org) : Promise.resolve();
  }

  /**
   * Drop every org in scope and warm the rollup back — the body "Sync now" and
   * the re-fill behind a write share, differing in TWO moves (#713).
   *
   * ONE argument for both, rather than a flag each, because they are two answers
   * to the same question — who is asking — and the combinations that do not
   * correspond to a caller are ones this service must never make.
   *
   * THE CATALOG is the first, and it is the whole reason this is a method rather
   * than `warmAfterWrite` calling `resync`. The picker's candidate boards are a
   * BOARD's identity, which no close and no facet write can change, so a write
   * keeps them and only the button drops them — the argument `dropCaches` makes
   * below. While the warm behind a write WAS `resync`, with nothing to tell the
   * two apart, that argument was true of the method and false of the path it sat
   * on: `FreshnessRegistry` calls the drop and then the warm on every write, so
   * every write charged the next picker open the Projects-v2 catalog walk the
   * drop had just declined to charge it.
   *
   * THE WARM is the second. A write's goes through `warmOrg`, which caps the
   * walks a burst can start at one per org; the button's calls `readRollup`
   * directly and is capped by nothing. Both halves of that are deliberate:
   *
   *  - a person pressed the button and is waiting on the answer, and
   *    `SyncController` promises the answer describes a read THIS call made. A
   *    sync that resolved off a warm already in flight would report a clean
   *    `syncedAt` for a walk issued before the button — the same laundering the
   *    retiree is kept out of this path for, and it would survive a Github that
   *    is refusing.
   *  - the button is pressed by a hand. What the cap exists to bound is the
   *    interceptor, which fires on every write with no debounce; a button press
   *    landing on top of a warm costs one extra walk, once.
   *
   * Everything else the two share, unchanged.
   */
  private async refill(caller: 'button' | 'write', report?: (complete: boolean) => void): Promise<void> {
    // Not `mustHaveScope`: a scope that came back empty has nothing to drop and
    // nothing to warm, and "Sync now" is not where anyone should meet that.
    // The read routes still say so, loudly.
    // A mutation used to target a narrower pinned owner set, so it warmed that
    // set alone. `PROJECTS_OWNER` is retired (#1209 part 4), the two sets are
    // one, and both callers warm the owners the reader can see.
    const scope = this.scopeForRead();
    for (const org of scope) {
      // RETIRED, not deleted, for the two that can be (#713): "Sync now" is
      // followed by a cold read exactly as a write is, and a person pressing it
      // during a Github outage should get the boards they were looking at back,
      // not an error where the page was.
      this.retire(this.rollupByOrg, this.retiredRollupByOrg, org);
      this.retire(this.membershipsByOrg, this.retiredMembershipsByOrg, org);
      // Beside them, this person's own last-good copies of the same two, for
      // the reason `dropCaches` gives (#1003 review).
      this.lastGood.forget('boards', org);
      this.lastGood.forget('membership index', org);
      // The one move a write does not make (#713): a board renamed on Github is
      // what "Sync now" is pressed about, and is nothing a write can cause.
      // The held catalog goes with the cached one, and only here: a rename is
      // exactly what a stale name would keep showing.
      if (caller === 'button') { this.catalogByOrg.delete(org); this.catalogInFlightByOrg.delete(org); this.lastGood.forget('catalog', org); }
      this.detailByOrg.delete(org);
      // The same moves the drop makes, org by org. The in-flight boards go, so a caller arriving now starts its own read
      // rather than being handed one that went out before the button was pressed;
      // and the epoch moves, so the reads this call just disowned cannot write
      // what they read into the cache when they land. `rollupBoards` has no
      // in-flight dedupe at all, so without the epoch a rollup issued a moment
      // before "Sync now" could land AFTER the warm below and overwrite it —
      // a sync that ends by putting back the boards it was pressed to replace.
      this.detailInFlightByOrg.delete(org);
      // And the SOURCE's own in-flight board read for this org (#713). The two
      // lines above clear the maps this class holds; this one clears the latch
      // it does not, and without it the warm below is handed the board-list read
      // that went out before the button was pressed — the pre-write boards, past
      // an epoch guard that moved before the read was even issued.
      this.source.disownInFlightReads(org);
    }
    // ONCE, after every org's slots are gone. Moving it inside the loop would
    // let the first org's warm be disowned by the second org's increment.
    this.epoch++;
    // And the catalog's own counter on the button's path alone — the same move
    // as the `delete` above, for reads that were already out when it was
    // pressed (#713). A write does not reach this line.
    if (caller === 'button') this.catalogEpoch++;
    // Warms the RAW rollup of every org in scope — neither caller belongs to
    // anybody in particular, and the cache it fills is viewer-independent by
    // design (#497).
    // Tolerantly, through the same fan-out the read uses: one org that cannot be
    // warmed must not make the button report failure for the orgs that could.
    //
    // `readRollup`, NOT the `rollupBoards` ladder, which is what stops the
    // retiree laundering a clean sync out of an outage. It does not make
    // `SyncController`'s contract — "a source that fails to refresh rejects the
    // request, never a silent no-op" — true on its own: `perOrg` throws only
    // when NOTHING was read (#697), so on a multi-org deployment one org failing
    // is still a warn and a clean `syncedAt`. Warm through the ladder and an outage
    // is answered by what the drop above just retired, `perOrg` sees every org
    // succeed, and the button reports a clean `syncedAt` having refreshed
    // nothing (#713). The retiree belongs to READS. `IssuesCacheService` makes
    // the same split — each awaits its own `refresh()` here rather than the read
    // that falls back.
    // Through `warmOrg` for a write and straight to the read for the button —
    // see the two paragraphs above.
    if (scope.length > 0) {
      let complete = true;
      const read = await this.perOrg(scope, async (org) => {
        if (caller === 'button') await this.readRollup(org, (whole) => { if (!whole) complete = false; });
        else await this.warmOrg(org);
      });
      report?.(complete && read.length === scope.length);
    }
  }

  /** Declare every board out of date (#692) — see `StaleOnWrite`. Closing an
   *  issue moves the counts, the completion ring and both pulse series of every
   *  board that issue is on, and the board's own drill-in with them.
   *
   *  EVERY org's slots — and so does `resync` above, which has covered the whole
   *  scope since the rollup became a union (#697). The org count is therefore not
   *  what tells the two apart; `catalogByOrg` is, and that is the next paragraph.
   *  A write is not asked which org it landed in, and a rollup this service keeps
   *  for an org nobody is reading costs nothing to rebuild — where getting it
   *  wrong means serving a count the board itself made wrong.
   *
   *  `catalogByOrg` is NOT among them, and it is the first of the two moves that
   *  separate a write from the button (`refill` has the other): `resync` drops it, this method and `warmAfterWrite`
   *  keep it (#713). An entry there is a BOARD's identity — node id, number,
   *  board title — with no issue title, body, count or date on it, as the comment
   *  on `listProjectCatalog` says and `projects.controller.spec.ts` pins. No
   *  close and no facet write can change one, so a write that dropped it would
   *  buy nothing and charge a Projects-v2 GraphQL call for it on the next picker
   *  open. "Sync now" drops it because that button means "I believe something
   *  moved that you cannot see", which is exactly the case a board renamed on
   *  Github falls into.
   *
   *  BOTH halves of the write path keep it, which is what makes that a property
   *  of the write rather than of this method: `FreshnessRegistry` calls this drop
   *  and then the re-fill, and the re-fill is `refill('write')` rather than
   *  `resync`, so nothing puts back the call this drop declined.
   *
   *  One write does drop it: making a project (#982), which is the one write
   *  that changes which boards exist. `written` says so, and the catalog then
   *  goes the way the button drops it, so the new project is in the next picker
   *  and the preview strip rather than waiting out the catalog's TTL. */
  dropCaches(written?: readonly Capability[]): void {
    // RETIRED, not cleared (#713): the read that follows a drop is cold by
    // construction, and against a Github that has started refusing it used to
    // 500 a page that would have drawn a slightly stale board a moment earlier.
    // What each org last served is kept beside the entry that goes, and served
    // only from the `catch` in `rollupBoards` / `orgMemberships`.
    this.retire(this.rollupByOrg, this.retiredRollupByOrg);
    this.retire(this.membershipsByOrg, this.retiredMembershipsByOrg);
    // And the person's own last-good copies of the same two (#1003 review).
    // `recall` is asked BEFORE `retired`, so leaving them would answer this
    // writer's next cold read with the payload from before their own write —
    // and for the store's own ceiling rather than the shorter one #713 chose
    // for exactly that copy. The retiree ladder still stands behind this.
    this.lastGood.forget('boards');
    this.lastGood.forget('membership index');
    // `detailByOrg` is NOT among them, and that is a GAP rather than a decision
    // against one. `rawDetail`'s stale-while-revalidate does not cover it: the
    // line below clears the map that branch reads, so a post-drop detail open
    // during an outage takes the cold branch and propagates the failure. The
    // rollup therefore survives an outage that the drill-in still 500s on.
    this.detailByOrg.clear();
    this.detailInFlightByOrg.clear();
    // The catalog's slot goes with them: a walk issued before the drop must not
    // be handed to a caller that arrived after it.
    this.catalogInFlightByOrg.clear();
    // Every org's entry, because a write is not told which org it landed in;
    // the catalog costs one Projects-v2 point per owner to read back. The
    // last-good copy stays: it is served only when the next read fails, and
    // a board list missing the new project beats none at all (#1003).
    if (written?.includes('issue.project.create')) {
      this.catalogByOrg.clear();
      this.catalogEpoch++;
    }
    // EVERY org's in-flight board read at the source, the same way this method
    // treats every other map — no argument means all of them (#713). The epoch
    // below stops a read that predates the write being CACHED; it cannot stop
    // the source handing that same read to the next caller as its own answer,
    // because the epoch is not something the source can see.
    this.source.disownInFlightReads();
    this.epoch++;
  }

  /** Re-fill after a write, in the background (#692) — see `StaleOnWrite`.
   *  Projects-v2 bills against its own GraphQL point budget rather than either
   *  REST limit, and a cold rollup is the multi-second read #304 exists to keep
   *  off the page, so this one is worth warming. It warms the rollup only: an
   *  open board's detail refills on the next open.
   *
   *  `'write'`, and it carries the two moves this does not share with "Sync
   *  now" (#713): the picker's candidate boards stay, for the reason
   *  `dropCaches` above gives, and the warm goes through `warmOrg`, so a burst
   *  of writes costs one walk per org in flight rather than one each. Every
   *  other move is the button's, so this is still the same drop-and-warm and not
   *  a second mechanism: see `refill`. */
  warmAfterWrite(): Promise<void> {
    return this.refill('write');
  }

  /** Per-board issue-URL index for stacking issues by project (#206), across
   *  every org in scope. Cached per org on the same TTL as the rollup — it's the
   *  same list query on the live source.
   *
   *  The JOIN downstream is on issue URL, which is unique across orgs already,
   *  so unioning changes nothing about how it matches; `org` on each entry is
   *  there so a reader can say which board a row belongs to when two orgs number
   *  a board the same (#697). */
  async projectMemberships(org?: string): Promise<ProjectMembership[]> {
    const read = await this.perOrg(this.mustHaveScope(org), (o) => this.orgMemberships(o));
    return read.flatMap(({ org: o, data }) => data.map((m) => ({ ...m, org: o })));
  }

  /** ONE org's membership index for a READ — the same two rungs the rollup has,
   *  and the retiree is the second of them (#713).
   *
   *  `projectMemberships()` is the only caller. The rollup's join reads
   *  `readMemberships` below instead, and that is the whole of the split: a
   *  rollup joined against a retired index is an answer this service cannot
   *  vouch for, and the guard at the end of `readRollup` would cache it for a
   *  full TTL — laundering a copy that is never allowed to be cached into the
   *  cache through the join. Unreachable today, because the live source reads
   *  both off one latch and refuses them together, but the next source that
   *  reads them apart would get exactly that. */
  private async orgMemberships(org: string): Promise<SourceMembership[]> {
    try {
      return await this.readMemberships(org);
    } catch (err) {
      // The same second look the rollup's `catch` takes, for the same race and
      // the same reason (#713): a concurrent read that succeeded has filled this
      // map and deleted what a drop retired, and this read's failure must not
      // cost the union an org whose answer is cached.
      const fresh = this.freshFor(this.membershipsByOrg, org);
      if (fresh) return fresh;
      const held = this.recall<SourceMembership[]>('membership index', org, err);
      if (held) return held.data;
      return this.retired(this.retiredMembershipsByOrg, org, 'membership index', err);
    }
  }

  /** The index itself: this org's entry while it is fresh, otherwise the source.
   *  NO retiree — a failure here propagates, which is what makes the rollup's
   *  join fail with it and what keeps "Sync now" honest. */
  private async readMemberships(org: string): Promise<SourceMembership[]> {
    const cached = this.freshFor(this.membershipsByOrg, org);
    if (cached) return cached;
    const epoch = this.epoch;
    const data = await this.source.projectMemberships(org);
    if (epoch === this.epoch) {
      this.membershipsByOrg.set(org, { at: Date.now(), data });
      // There is a current answer again, so the copy the drop retired has
      // nothing left to stand in for (#713). The next drop retires this one.
      this.retiredMembershipsByOrg.delete(org);
      this.lastGood.keep('membership index', org, data);
    }
    return data;
  }

  /** Every open board's id/number/title (#404) — the add-to-project picker's
   *  candidate list. Cached on the same TTL as the rollup.
   *
   *  No viewer, because nothing on it depends on one: an entry is a BOARD's
   *  identity — node id, number, board title — and carries no issue title, body
   *  or address. `projects.controller.spec.ts` pins that (every catalog title is
   *  a board name), so the day an issue title turns up here the spec fails
   *  rather than the payload quietly leaking. */
  async listProjectCatalog(org?: string): Promise<ProjectCatalogEntry[]> {
    const read = await this.perOrg(this.mustHaveScope(org), (o) => this.orgCatalog(o));
    return read.flatMap(({ org: o, data }) => data.map((e) => ({ ...e, org: o })));
  }

  /** Names for read-only navigation while rollups load, never mutation candidates. */
  async listProjectPreview(org?: string): Promise<ProjectCatalogEntry[]> {
    const read = await this.perOrg(this.mustHaveScope(org), (o) => this.orgCatalog(o));
    return read.flatMap(({ org: o, data }) => data.map((e) => ({ ...e, org: o })));
  }

  /** ONE org's candidate boards, cached under that org. */
  private orgCatalog(org: string): Promise<SourceCatalogEntry[]> {
    const cached = this.freshFor(this.catalogByOrg, org);
    if (cached) return Promise.resolve(cached);
    const running = this.catalogInFlightByOrg.get(org);
    if (running) return running;
    // `catalogEpoch`, not `epoch` — see the field. A write moves the boards'
    // counter twice and this one not at all, so a walk that a write landed on
    // top of is still cached.
    const epoch = this.catalogEpoch;
    const read = this.source
      .listProjectCatalog(org)
      .then((data) => {
        if (epoch === this.catalogEpoch) {
          this.catalogByOrg.set(org, { at: Date.now(), data });
          this.lastGood.keep('catalog', org, data);
        }
        return data;
      })
      // The names this org last answered with, rather than an org missing from
      // the union (#1003). The catalog had no fallback at all: this list is what
      // the preview strip draws while the rollup walks items, so a refused read
      // took the board names off the page as well as the counts.
      .catch((err: unknown) => {
        const fresh = this.freshFor(this.catalogByOrg, org);
        if (fresh) return fresh;
        const held = this.recall<SourceCatalogEntry[]>('catalog', org, err);
        if (held) return held.data;
        throw err;
      })
      // Its OWN slot only, the rule `refreshDetail` states: a walk a drop
      // disowned must not delete the slot a later reader is waiting on.
      .finally(() => { if (this.catalogInFlightByOrg.get(org) === read) this.catalogInFlightByOrg.delete(org); });
    this.catalogInFlightByOrg.set(org, read);
    return read;
  }
}
