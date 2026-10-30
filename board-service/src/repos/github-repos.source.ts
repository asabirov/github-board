import { githubPrincipal, personalOwner, PrincipalState } from '../auth/github-principal';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { githubOrgs } from '../config/github-orgs';
import { buildOctokitClient } from '../sources/github-client';
import { asMsg, classifyGithubError, refusalToHttp } from '../capability/github-refusal';
import { learnRefusal } from '../capability/learn-refusal';
import type { CapabilityRegistry } from '../capability/capability.registry';
import { mapLimit, shortRepoKey } from '../issues-metrics/github-issues.source';
// The payload's own cap on the open-PR list, asked for as a GraphQL variable
// rather than written into the document — see `PR_QUERY`.
import { OPEN_PRS_CAP } from './repo-page';
import {
  ActionsUsageRead,
  DriRead,
  DriSchema,
  IReposSource,
  OwnerWritability,
  ReposRead,
  SecurityRead,
  RepoCi,
  RepoCiRead,
  RepoDescriptor,
  RepoOpenPr,
  RepoPrRead,
  RepoPrRecord,
  RepoReadme,
  RepoSecurity,
  UsageMonth,
} from './repo.types';

/**
 * The `values_editable_by` settings this board understands.
 *
 * Absent and `null` are NOT in here, and are not unknowns either: GitHub
 * declares the field `?: "org_actors" | "org_and_repo_actors" | null` and
 * documents the default when it is unspecified as `org_actors`. So an absent
 * field is a successful read of a real setting, and `driSchema` resolves it
 * before consulting this map. What lands here and misses — an enum GitHub adds
 * later — is a value we genuinely did not read, and only that is `unknown`.
 */
// A Map, not an object literal: the key comes straight out of Github's JSON,
// and against a literal `"constructor"` or `"toString"` would resolve to an
// inherited Object.prototype member — truthy, so the `unknown` fallback would
// never fire, the unrecognised-value warning would never log, and a value that
// is not an `OwnerWritability` at all would travel to the view and the guard.
//
// That used to mean the write went out: the guard matched a list of refusing
// states and let anything unlisted through. Since #649 it does not — the
// writability rung is an exhaustive switch whose default refuses — so what a
// literal would cost now is the ANSWER rather than the write. The board would
// carry a state nobody defined onto `ReposView.ownerWritability`, the surface
// would draw on it, and the guard's fallback 502 would say the schema could not
// be read when it had been read perfectly well. The Map lands on `unknown`
// instead, which is what actually happened, and logs it. A Map has no prototype
// chain to walk into.
const EDITABLE_BY = new Map<string, OwnerWritability>([
  ['org_and_repo_actors', 'writable'],
  ['org_actors', 'restricted'],
]);

/** One row of `GET /orgs/{org}/properties/values` — the shape this source reads. */
interface PropertyValuesRow {
  repository_full_name: string;
  properties?: { property_name: string; value: string | null }[];
}

/** A row from any of the three org-level alert lists — only the fields read. */
interface AlertRow {
  repository?: { full_name?: string };
  security_advisory?: { severity?: string };
  /** The alert's OWN page on Github, as the alert list reports it (#605). Read,
   *  never composed: a tile may only ever point at an address this board was
   *  handed, so a row that carries none leaves the word exactly as inert as it
   *  was. Optional because only the secret-scanning read consults it. */
  html_url?: string;
}

/** Prefer `owner` throughout the migration, falling back to `dri` only when
 * that row is absent. A present null owner is an intentional clear.
 * Names match case-insensitively, and writes use the schema's exact spelling.
 * The board cannot create properties: it has no admin:org scope. Failed
 * schema reads and PATCHes go through writeRefusal and remain loud refusals.
 */
const OWNER_PROPERTY = 'owner';
const LEGACY_OWNER_PROPERTY = 'dri';
const ownershipProperty = <T extends { property_name?: string }>(rows: T[]): T | undefined =>
  rows.find((row) => row?.property_name?.toLowerCase() === OWNER_PROPERTY)
  ?? rows.find((row) => row?.property_name?.toLowerCase() === LEGACY_OWNER_PROPERTY);

/** Every repo starts at zero, so "no alerts" is a fact rather than a gap.
 *  `state: 'read'` for the same reason: every row this source builds came out
 *  of a list it actually read.
 *
 *  It is NOT the last word on whether the zeros beside it were measured. An org
 *  named in `SecurityRead.unreadableOrgs` may well have rows here — one of its
 *  three lists answered and another refused — and the counts behind the refused
 *  one are still zero on this record. Deciding the state per ORG rather than
 *  per row is the consumer's job and is `securityFor` in `repos.service.ts`:
 *  the source knows which list it lost, and one `RepoSecurity` cannot say. */
const noAlerts = (): RepoSecurity => ({
  depHigh: 0,
  depModerate: 0,
  codeScanning: 0,
  secrets: 0,
  secretsUrl: null,
  state: 'read',
});

/** No run to speak of, and so no address either (#605) — a repo whose default
 *  branch was never named, whose read failed, or which has never completed a
 *  run. A factory rather than a shared literal, for the reason `noAlerts` is
 *  one: two repos must never hand back the same record. */
const noRun = (): RepoCiRead => ({ conclusion: null, url: null });

/** Same bound as the issue ingest — the pinned-list path fetches one repo each. */
const FETCH_CONCURRENCY = 8;

/** PRs per GraphQL page — Github's own maximum for a connection. */
const PR_PAGE_SIZE = 100;
/**
 * How many PR pages one repo page may walk. 600 PRs is more than a 10-week
 * window needs on any repo in this org (the busiest merged 312 in its whole
 * life), and it bounds what a page view can cost on a repo that is not.
 * Whatever the cap does not reach is reported as unknown, never as zero.
 */
const PR_PAGE_CAP = 6;

/**
 * Both totals, the records and the open list, in one round trip. `states` is not
 * narrowed on `recent` on purpose: a window's OPENED count includes the PRs
 * still open.
 *
 * `recent` is ordered by `UPDATED_AT` and not `CREATED_AT` because the page
 * counts what was OPENED and what was MERGED in each window, and those are two
 * different moments. Walking back through creation dates covers the first and
 * quietly loses the second: a PR opened in January and merged this week sorts
 * by its January date, so a read that stops at the window's edge never sees it,
 * and this week's merge count is short by one with nothing to say it.
 * `updatedAt` is never earlier than `mergedAt` and never earlier than
 * `createdAt`, so ordering by it covers both.
 *
 * `openPRs` therefore cannot be filtered out of `recent`, and asks for its own
 * nodes on the same connection its `totalCount` already came from (#828). That
 * is a second field selection and not a second request. Ordering by CREATED_AT
 * here is the right way round for the same reason it is the wrong way round
 * above: this list is what is open NOW, newest first, and `recent` stops at the
 * window or at `PR_PAGE_CAP` — so an open PR nobody has touched for months is
 * not in it, and a list built from it would quietly omit exactly the stale PRs
 * a person opens the tab to find.
 *
 * `author { __typename }` on both selections is what tells a teammate from a
 * bot. Measured live on acme/board on 2026-09-03: all 8 open
 * PRs are dependabot's, and the last 100 split 91 `User` octocat, 8 `Bot`
 * dependabot, 1 `User` anton-khovanskiy — so a members list counting PR authors
 * without this ranks dependabot second, above a person. GraphQL states the type
 * outright, which is why it is asked for rather than guessed at: a `[bot]`
 * suffix is a naming convention and the team roster would drop every real
 * contributor it does not carry.
 *
 * `$openFirst` is a variable rather than a number written into the document
 * because the cap belongs to the payload and is declared once, as
 * `OPEN_PRS_CAP`. Interpolating it into this string would also widen the
 * constant's type from a string literal to `string`, which the write census
 * reads as a document assembled at run time.
 */
const PR_QUERY = `query($owner:String!,$name:String!,$first:Int!,$openFirst:Int!,$after:String){
  repository(owner:$owner,name:$name){
    openPRs: pullRequests(states:OPEN, first:$openFirst, orderBy:{field:CREATED_AT,direction:DESC}){
      totalCount
      nodes{ number title url createdAt isDraft author{ login __typename } }
    }
    closedPRs: pullRequests(states:[CLOSED,MERGED]){ totalCount }
    recent: pullRequests(first:$first, after:$after, orderBy:{field:UPDATED_AT,direction:DESC}){
      pageInfo{ hasNextPage endCursor }
      nodes{ number createdAt updatedAt mergedAt closedAt author{ login __typename } }
    }
  }
}`;

/** One `author` as GraphQL answers it: the field is nullable for a ghost or
 *  deleted account, and so is every login this file reads off it.
 *
 *  `__typename` is the interface the login belongs to — `User`, `Bot`,
 *  `Organization`, `Mannequin`, `EnterpriseUserAccount`. Only `Bot` is read, and
 *  it is read as itself rather than as "not a User", so a type Github adds later
 *  lands among the people rather than among the machines. */
interface PrAuthor {
  login: string;
  __typename: string;
}

/** The shape `PR_QUERY` answers with — only the fields read. */
interface PrQueryResult {
  repository?: {
    openPRs: {
      totalCount: number;
      nodes?: {
        number: number;
        title: string;
        url: string;
        createdAt: string;
        isDraft: boolean;
        author: PrAuthor | null;
      }[];
    };
    closedPRs: { totalCount: number };
    recent: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes?: {
        number: number;
        createdAt: string;
        updatedAt: string;
        mergedAt: string | null;
        closedAt: string | null;
        author: PrAuthor | null;
      }[];
    };
  };
}

/** Whether a PR's author is a machine (#828). A ghost account — `author: null`,
 *  a deleted user — is a person nobody can name any more, never a bot. Read as
 *  `=== 'Bot'` and not as `!== 'User'`, so a login type Github adds after this
 *  was written is counted as somebody rather than silently dropped. */
const authoredByBot = (author: PrAuthor | null): boolean => author?.__typename === 'Bot';

/** What one org answered a fan-out read with (#718), and what it failed with —
 *  two shapes rather than one with optional halves, so a caller cannot read a
 *  value off a failure without TypeScript stopping it. */
type OrgAnswer<T> = { org: string; value: T };
type OrgFailure = { org: string; error: Error };

/** One row of the org's enhanced billing usage report — only the fields read. */
interface UsageRow {
  date: string;
  product: string;
  unitType: string;
  quantity?: number;
  netAmount?: number;
  organizationName: string;
  repositoryName: string;
}

/**
 * Live source for the Repos map (#472). It supplies only what the issue ingest
 * cannot: which repos exist — including the ones with an empty queue, which
 * never appear in an issue list at all — and each repo's CODEOWNERS text.
 *
 * Scope mirrors GithubIssuesSource exactly, so the map and the metrics always
 * agree on what "the org" means: every repo in EVERY owner the caller can read
 * is enumerated. Archived repos and repos with issues turned off are filtered
 * out. An explicit `ISSUES_METRICS_REPOS` list used to replace that walk, and it
 * is retired (#1209 part 4) along with the second scope path it needed.
 *
 * READS and WRITES answer to the same set of orgs (#718). Every read here fans
 * out over `this.orgs`, which is also the set `repoInOrgs` validates a write
 * against — so a repo this source will write to is one its own map draws. Until
 * #718 the reads took `this.orgs[0]` alone, and a two-org deployment drew one
 * org's map while accepting writes to both.
 *
 * ONE org failing may not cost another org's answer, which is the shape #697
 * merged for the issue ingest and Delivery. Each read below says what it does
 * with a partial answer, and the three dispositions are: name the failing org in
 * the log and carry on (`listRepos`), report it to the caller as well
 * (`driByRepo`, `actionsUsage`), or swallow it entirely because the signal is a
 * decoration (`securityByRepo`). Losing EVERY org is a throw wherever an empty
 * answer would be indistinguishable from a real one.
 */
@Injectable()
export class GithubReposSource implements IReposSource {
  private readonly ciCache = new PrincipalState(() => ({ at: 0, key: '', value: null as Map<string, RepoCiRead> | null }), true);
  private readonly logger = new Logger(GithubReposSource.name);
  /** Every org this source READS from and may WRITE to, in configured order
   *  (#649, widened to the reads by #718). A write's owner half has to match one
   *  of these; an empty set matches nothing, so it refuses every write rather
   *  than admitting every one — and enumerates nothing, so the map is empty
   *  rather than org-wide. Off for reads and off for writes, from one answer. */
  private get orgs(): string[] { return githubOrgs(this.config); }

  constructor(
    private readonly config: ConfigService,
    /** #584 — optional so the construction sites in this file's spec keep
     *  working unchanged. The `useFactory` provider passes it explicitly. */
    private readonly registry?: CapabilityRegistry,
  ) {
    // ONE derivation, and ONE set (#649, #718). `githubOrgs` owns which orgs
    // these are and what each setting means — including what an unset or empty
    // one answers; this file takes the set as given and asks every question of
    // all of it. There is no second, narrower set any more: the `this.orgs[0]`
    // that used to scope the reads was the whole of #718.
  }

  /** Every org this source's MAP covers, so a caller can tell an answer the
   *  cached view already holds from one that has to be read fresh. */
  get servedOrgs(): readonly string[] {
    return this.orgs;
  }

  async listRepos(): Promise<ReposRead> {
    return this.orgRepos(buildOctokitClient(this.config));
  }

  /**
   * Every configured org's ownership, and the orgs that could not be asked.
   *
   * The throw is narrower than it was and means the same thing. It used to fire
   * on ANY failure, so that a transient outage was never read as "nobody owns
   * anything" — with one org that is the only way to say it, because an empty
   * map is the same value either way. With several, `unreadableOrgs` says it
   * precisely: those orgs' repos are missing for a reason that is not "nobody
   * owns them", and the orgs that answered keep answers they actually gave. So
   * the throw is left for the case where nothing at all was read, which on a
   * one-org deployment is every failure, exactly as before.
   */
  async driByRepo(): Promise<DriRead> {
    if (this.orgs.length === 0) return { byRepo: new Map(), unreadableOrgs: [] };
    const octokit = buildOctokitClient(this.config);
    const { read, failed } = await this.perOrg('Ownership read', (org) =>
      personalOwner(org)
        ? Promise.resolve((githubPrincipal()?.repositories ?? [])
          .filter((repo) => repo.owner.login.toLowerCase() === org.toLowerCase())
          .map((repo) => ({ repository_id: repo.id, repository_name: repo.name, repository_full_name: repo.full_name,
            properties: [{ property_name: OWNER_PROPERTY, value: repo.owner.login }] })))
        : octokit.paginate('GET /orgs/{org}/properties/values', { org, per_page: 100 }),
    );
    if (read.length === 0 && failed.length > 0) throw joinFailures(failed);
    const byRepo = new Map<string, string | null>();
    for (const { value } of read) {
      for (const row of value as PropertyValuesRow[]) {
        const dri = ownershipProperty(row.properties ?? [])?.value ?? null;
        byRepo.set(row.repository_full_name, dri);
      }
    }
    return { byRepo, unreadableOrgs: failed.map((f) => f.org) };
  }

  async securityByRepo(): Promise<SecurityRead> {
    if (this.orgs.length === 0) return { byRepo: new Map(), unreadableOrgs: [] };
    const octokit = buildOctokitClient(this.config);
    const out = new Map<string, RepoSecurity>();
    // Which orgs lost a list, in configured order. A Set because the three
    // reads below run concurrently and any of them may add the same org.
    const lost = new Set<string>();
    const bump = (row: AlertRow, apply: (s: RepoSecurity) => void): void => {
      const full = row.repository?.full_name;
      if (!full) return;
      const entry = out.get(full) ?? noAlerts();
      apply(entry);
      out.set(full, entry);
    };
    // Each list is read independently, in each org: one feature being off or out
    // of scope costs its own signal, not the other two and not the other org.
    // The org loop is INSIDE this helper, so the three call sites below stay
    // three string literals handed to the annotated parameter.
    // The route's TYPE pins the verb (#621). `paginate` takes any route string,
    // so `path: string` left this the one Github call in the tree whose method
    // no reader — and no gate — could settle statically, and the write census
    // has to call what it cannot prove a read a write. The verb is the whole of
    // the fact, so the type says the verb and nothing else: pinning `/orgs/`
    // too would stop the next repo-scoped alert read from compiling for a
    // reason that has nothing to do with the gate.
    const read = async (
      path: `GET /${string}`,
      apply: (row: AlertRow, s: RepoSecurity) => void,
    ): Promise<void> => {
      // Never throws — an empty map at worst, security being a decoration on the
      // map. A failing org goes in `lost`, because absence from `out` is what a
      // clean repo looks like and an unread list must not draw as one (#718).
      await mapLimit(this.orgs.filter((o) => !personalOwner(o)), FETCH_CONCURRENCY, async (org) => {
        try {
          const rows = (await octokit.paginate(path, { org, state: 'open', per_page: 100 })) as AlertRow[];
          for (const row of rows) bump(row, (s) => apply(row, s));
        } catch (err) {
          lost.add(org);
          this.logger.warn(`Security read failed for ${org} ${path}: ${(err as Error).message}`);
        }
      });
    };
    await Promise.all([
      read('GET /orgs/{org}/dependabot/alerts', (row, s) => {
        const sev = row.security_advisory?.severity;
        if (sev === 'high' || sev === 'critical') s.depHigh++;
        else s.depModerate++;
      }),
      read('GET /orgs/{org}/code-scanning/alerts', (_row, s) => { s.codeScanning++; }),
      // The only one of the three that keeps an address (#605): 'Leaked secret'
      // is the word the tile draws off `secrets`, so this is the read whose
      // alert the word has to be able to reach. The FIRST open alert, because
      // the word is singular and the list has no ranking to pick a better one
      // by. The other two reads feed counts nothing draws a word from, so
      // carrying an address for them would be an address with no reader.
      read('GET /orgs/{org}/secret-scanning/alerts', (row, s) => {
        s.secrets++;
        if (s.secretsUrl === null) s.secretsUrl = row.html_url ?? null;
      }),
    ]);
    // Configured order, not the order the failures landed in: the three reads
    // race, so insertion order into `lost` is a timing artefact and would make
    // this answer differ between two identical runs.
    return { byRepo: out, unreadableOrgs: this.orgs.filter((o) => lost.has(o)) };
  }

  /**
   * The word each tile draws, read off the branch the org protects (#572).
   *
   * Two parameters narrow the read, and between them they buy exactly one
   * thing: the latest completed run whose head branch is this repo's default
   * and which no pull request triggered.
   *
   * `branch` alone is not that, which is what this docstring used to claim.
   * It filters on the run's HEAD branch — Github's own wording for it is "the
   * name of the branch of the `push`" — so it does drop a red feature branch
   * and a Dependabot push, both of which run under a branch name of their
   * own. It does NOT drop a pull request opened from a fork whose head branch
   * happens to be called `main` too: that run carries `head_branch: "main"`
   * and passes the filter untouched. `exclude_pull_requests` is what shuts it
   * out, and without it a fork could still hand a repo a "CI failing" nobody
   * at that tile can act on.
   *
   * What survives both filters is still not "the org's own work" — it is any
   * completed run on the default branch, from anyone who can push there. That
   * is the branch the org protects, and that is the whole of the claim.
   *
   * Each repo names its own default — hardcoding one branch name would swap
   * one wrong branch for another.
   *
   * A repo whose default branch the listing did not name is skipped rather
   * than read unscoped: no word at all beats the wrong word, and `null` is
   * already what a repo with no completed run says.
   */
  async ciByRepo(descriptors: RepoDescriptor[]): Promise<Map<string, RepoCiRead>> {
    const key = JSON.stringify(descriptors.map((d) => [d.full, d.defaultBranch]));
    const cached = this.ciCache.current;
    if (githubPrincipal() && cached.value && cached.key === key && Date.now() - cached.at < 600_000) return cached.value;
    const octokit = buildOctokitClient(this.config);
    const pairs = await mapLimit(descriptors, FETCH_CONCURRENCY, async (d) => {
      if (!d.defaultBranch) return [d.full, noRun()] as const;
      const [owner, repo] = d.full.split('/');
      try {
        const { data } = await octokit.actions.listWorkflowRunsForRepo({
          owner,
          repo,
          branch: d.defaultBranch,
          exclude_pull_requests: true,
          status: 'completed',
          per_page: 1,
        });
        // The run object was already here and was thrown away (#605). Its own
        // `html_url` is the only address for it this board can hold: composing
        // one from the repo name would be a guess, and a guess that 404s is
        // worse than a word that goes nowhere.
        const run = data.workflow_runs[0];
        if (!run) return [d.full, noRun()] as const;
        return [d.full, { conclusion: (run.conclusion ?? null) as RepoCi, url: run.html_url ?? null }] as const;
      } catch (err) {
        this.logger.warn(`CI read failed for ${d.full}: ${(err as Error).message}`);
        return [d.full, noRun()] as const;
      }
    });
    const value = new Map(pairs);
    if (githubPrincipal()) Object.assign(cached, { at: Date.now(), key, value });
    return value;
  }

  /**
   * The ownership property's schema: the values it allows, and whether this board
   * may set them. Both come out of ONE call, because Github returns
   * `allowed_values` and `values_editable_by` in the same row — so knowing in
   * advance that the write is barred costs nothing.
   *
   * `org` is the org being ASKED ABOUT, not the org this source's map is built
   * from, and the two differ whenever a write is aimed at another configured
   * org (#649). It fills the `{org}` in the address below; both facts the
   * answer carries are per-org, so a read taken against the wrong one would
   * judge a write by a different org's settings and say nothing about it.
   *
   * Each of the three answers is argued next to the line that returns it, and
   * the one invariant across them is that `restricted` and `absent` are claims
   * about the org's settings while `unreadable` is a claim about this token.
   *
   * The read needs no throttle check: a rate limit and a refusal are both
   * `unreadable` here. Only the write has to tell them apart, because only the
   * write answers them differently.
   */
  async driSchema(org: string): Promise<DriSchema> {
    if (personalOwner(org)) return { writability: 'not-applicable', allowedValues: [] };
    const octokit = buildOctokitClient(this.config);
    type SchemaRow = { property_name?: string; allowed_values?: string[] | null; values_editable_by?: string | null };
    let rows: SchemaRow[];
    // Only the CALL is guarded. Picking the row out of the answer must not be
    // able to report `unreadable` for a list that read perfectly well.
    try {
      // The WHOLE list, not `…/schema/dri`. The single-property read this used
      // to call answers 404 for two different worlds and cannot tell them apart
      // — measured against real Github on 2026-08-20, one token, four orgs:
      //
      //   org          list                 …/schema/dri   what is true
      //   acme   200, 1 property      200            the property exists
      //   globex     200, 1 property      200            the property exists
      //   selgeo       200, ZERO properties 404            no such property, org readable
      //   github       404                  404            the org is unreadable to this token
      //
      // The list separates the last two: 200 with neither ownership row is `absent`, a
      // list that will not read at all is `unreadable`. The preferred ownership row is picked
      // out of the answer below.
      const { data } = await octokit.request('GET /orgs/{org}/properties/schema', { org });
      // Inside the try ON PURPOSE. A body that is not a list is the board
      // failing to read, not a fact about the org: `data ?? []` would find no
      // ownership row in it and report `absent`, which is a claim, and anything
      // else would throw `rows.find is not a function` out of a method that
      // could not throw before this call changed — into `refresh`'s
      // `Promise.all`, where a rejection loses the WHOLE repo map.
      if (!Array.isArray(data)) throw new Error(`the schema list answered ${typeof data}, not a list`);
      rows = data as SchemaRow[];
    } catch (err) {
      const status = (err as { status?: number }).status;
      this.logger.warn(`dri schema list read failed (${status ?? 'no status'}): ${(err as Error).message}`);
      // `unreadable`, never `absent`. A 404 on the list is Github's answer to a
      // token that may not see the org — the central diagnosis of #577 — so
      // filing it as `absent` would state the org has no ownership property when the
      // board only knows its token cannot look. That is #577's error inverted,
      // and it is the thing splitting the two states exists to prevent.
      return { allowedValues: [], writability: 'unreadable' };
    }
    const row = ownershipProperty(rows);
    // A list that answered and holds neither ownership row: the org has no such property.
    // Nothing to write, and no retry makes one. `absent` is a second fact about
    // the org and carries the same burden as `restricted` from the other side —
    // it may only ever come from a list that WAS read.
    if (!row) return { allowedValues: [], writability: 'absent' };
    const allowedValues = row.allowed_values ?? [];
    const editableBy = row.values_editable_by;
    // Absent or null is Github's documented default, `org_actors` — a setting
    // that was read, not one that is missing. `restricted` may only ever come
    // from successfully reading a schema that says so: it is the one state that
    // asserts something about the org's SETTINGS, it is cached on the view for
    // the full TTL, it is never re-read, and it takes the owner control off
    // every tile in silence — so it must never be inferred from a read that did
    // not happen. #577 is a catalogue of what follows when it is.
    if (editableBy == null) return { allowedValues, writability: 'restricted' };
    const writability = EDITABLE_BY.get(editableBy) ?? 'unknown';
    if (writability === 'unknown') {
      this.logger.warn(`dri schema reports an unrecognised values_editable_by: ${JSON.stringify(editableBy)}`);
    }
    return { allowedValues, writability };
  }

  /**
   * Write one repo's ownership property, one repo per call (#577).
   *
   * The address is `PATCH /repos/{owner}/{repo}/properties/values`, which
   * GitHub accepts on the `repo` scope this board's shared token already
   * holds. The org-wide batch endpoint this used to call accepts `admin:org`
   * alone, and answers a token without it with a 404 — so every owner the map
   * offered was refused, silently, by a ladder that had already passed it.
   * The picker sets one repo per press, so the batch is nothing given up.
   *
   * `login: null` CLEARS the property, which is how "no owner" is recorded.
   *
   * GitHub's refusal is mapped here rather than left to escape: an Octokit
   * error carries a status and no HTTP meaning, and Nest turns it into a 500 —
   * which tells the person at the tile to retry something that can never work.
   *
   * Resolves with the login GitHub now RECORDS, read back after the write. The
   * write answers 204 with no body, so without the read there is nothing to
   * settle on but the request itself — and a request that was never applied is
   * exactly the failure #577 was. The read-back is one call, on a press.
   */
  async setDri(full: string, login: string | null): Promise<string | null> {
    const target = this.repoInOrgs(full);
    if (personalOwner(target.owner)) throw new NotFoundException(`repo ${full} not found`);
    // The only write among this source's nine clients (#584). The read-back
    // below shares it deliberately: it is this write's own confirmation, and a
    // credential that could not read it back could not have made it.
    const octokit = buildOctokitClient(this.config, 'write');
    let propertyName: string;
    try {
      const { data } = await octokit.request('GET /orgs/{org}/properties/schema', { org: target.owner });
      if (!Array.isArray(data)) throw new Error('Ownership schema did not return a list');
      const property = ownershipProperty(data);
      if (!property?.property_name) throw new Error('No ownership property is defined');
      propertyName = property.property_name;
      // BOTH halves come from `repoInOrgs`, which validated them together. The
      // owner used to be pinned to the map's own org while the name came from
      // the caller, so a press on a repo in another configured org would have
      // PATCHed this org's repo of the same name — a real repository, which
      // answers 204, so nothing below would have noticed. The read-back would
      // then have confirmed the wrong repo too, since it took the same owner.
      await octokit.request('PATCH /repos/{owner}/{repo}/properties/values', {
        owner: target.owner,
        repo: target.repo,
        properties: [{ property_name: propertyName, value: login }],
      });
    } catch (err) {
      throw await this.writeRefusal(full, target, err, octokit);
    }
    // The write landed, so the capability is available — and a stale `refused`
    // at this key is cleared by the same call (#584).
    this.registry?.recordSuccess('repo.dri', full);
    return this.readDri(octokit, target.owner, target.repo, login, propertyName);
  }

  /** Both halves of an `owner/name` key, refused unless the owner half names one
   *  of the orgs this source is configured for.
   *
   *  This is deliberately a SECOND check — callers are expected to have guarded
   *  the owner already — and it repeats because this is the layer that actually
   *  addresses GitHub, so it is the last place a wrong owner can still be
   *  stopped. Before #577 the owner was discarded structurally: the org came
   *  from config and only the name was taken from the argument, so no
   *  request-supplied string could steer a write out of the org whatever the
   *  caller did. Building the URL from both halves gave that up quietly. This
   *  gives it back, and refuses loudly rather than silently redirecting a write
   *  to another org's repo of the same name. 404 rather than 403, so a refusal
   *  here is indistinguishable from a repo that is simply not there.
   *
   *  What #649 changed is how many orgs it may say yes to, not what it does to
   *  the rest: the set has MORE to refuse now, not less, because the org half
   *  is no longer discarded on the way to the request.
   *
   *  The owner returned is the CONFIGURED spelling, matched case-insensitively
   *  against the caller's. A caller is not refused over case; Github is not
   *  addressed under two names for one org either.
   *
   *  An empty set matches nothing, so it refuses everything — the fail-closed
   *  direction, and the only safe reading of "no orgs". */
  private repoInOrgs(full: string): { owner: string; repo: string } {
    const [owner, repo] = full.split('/');
    const configured = this.orgs.find((o) => o.toLowerCase() === owner?.toLowerCase());
    if (!repo || !configured) {
      throw new NotFoundException(`repo ${full} not found`);
    }
    return { owner: configured, repo };
  }

  /** One repo's recorded owner, read straight after a write. A cleared property
   *  is simply absent from the list, which reads as nobody. A failed read-back
   *  falls back to the login just written: the write landed (204), and
   *  rejecting here would roll the tile back to an owner GitHub no longer has —
   *  a lie in the opposite direction. */
  private async readDri(
    octokit: ReturnType<typeof buildOctokitClient>,
    owner: string,
    repo: string,
    wrote: string | null,
    propertyName: string,
  ): Promise<string | null> {
    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/properties/values', { owner, repo });
      const rows = data as { property_name: string; value: string | null }[];
      return rows.find((p) => p.property_name.toLowerCase() === propertyName.toLowerCase())?.value ?? null;
    } catch (err) {
      this.logger.warn(`dri read-back failed for ${owner}/${repo}: ${(err as Error).message}`);
      return wrote;
    }
  }

  /** #584 — one interpreter, and the write's one chance to learn. `setDri`
   *  addresses a repo whose OWNER half `repoInOrgs` validated and whose NAME
   *  nothing has checked, so the 404 is not reinterpreted here either:
   *  `learnRefusal` re-reads the repo and earns the answer, or earns nothing and
   *  the absence stands.
   *
   *  `target` is the validated pair, so the re-read asks about the repository
   *  the write was actually sent to. Re-splitting `full` here would ask about a
   *  string nothing checked, and the answer would decide what the refusal meant.
   *  `full` stays alongside it because it is what this method passes as the
   *  refusal's `target`, unchanged from what the caller asked for. */
  private async writeRefusal(
    full: string,
    target: { owner: string; repo: string },
    err: unknown,
    octokit: ReturnType<typeof buildOctokitClient>,
  ): Promise<Error> {
    const { owner, repo } = target;
    const refusal = await learnRefusal({
      registry: this.registry,
      capability: 'repo.dri',
      target: full,
      refusal: classifyGithubError(err, { capability: 'repo.dri', target: full }),
      // The first thing on this path that actually asks Github whether this
      // repository is there: `repoInOrgs` validated the OWNER half only.
      reread: async () => {
        try {
          await octokit.repos.get({ owner, repo });
          return true;
        } catch (e) {
          if (classifyGithubError(e, { capability: 'repo.dri' }).reason === 'not-found') return false;
          throw e;
        }
      },
    });
    // `missingPermission` is Github naming the permission the endpoint wanted,
    // and the log is the only place it may appear — never the response body,
    // where it would describe the board's credential to a client. This one line
    // is what #577 spent a week without: the answer was in a response header
    // nothing read.
    const wanted = refusal.missingPermission ? `, wanted ${refusal.missingPermission}` : '';
    this.logger.warn(
      `dri write refused for ${full} (${refusal.reason}, ${refusal.status ?? 'no status'}${wanted}): ${asMsg(err)}`,
    );
    return refusalToHttp(refusal);
  }

  /** Enumerate EVERY configured org's repos, filtered exactly as the issue
   *  ingest filters them: non-archived, non-fork, issues enabled. The scopes
   *  have to match — the map's counts come from that ingest, so a repo the
   *  ingest skips could only ever draw an empty queue, which would be a lie
   *  rather than a fact. Each row is described under the org it actually came
   *  from, so `full` is `owner/name` and right for every org.
   *
   *  ONE org failing is logged and REPORTED in `unreadableOrgs`, the rest kept;
   *  EVERY org failing throws, carrying each org's own reason (#718). */
  private async orgRepos(octokit: ReturnType<typeof buildOctokitClient>): Promise<ReposRead> {
    const person = githubPrincipal();
    if (person) return { repos: person.repositories.filter((r) => this.orgs.some((o) => o.toLowerCase() === r.owner.login.toLowerCase()) && this.inScope(r)).map((r) => this.describe(r.owner.login, r as Parameters<GithubReposSource['describe']>[1])), unreadableOrgs: [] };
    const { read, failed } = await this.perOrg('Repo listing', (org) =>
      octokit.paginate(octokit.repos.listForOrg, { org, type: 'all', per_page: 100 }),
    );
    const repos = read.flatMap(({ org, value }) =>
      value.filter((r) => this.inScope(r)).map((r) => this.describe(org, r)),
    );
    // NO ORG ANSWERED, not "no repo came back". The two part company the moment
    // there is a second org: an org that answered and has nothing in scope — a
    // new org, or one whose every repo is archived — contributes no rows, and
    // testing the ROWS would let it stand in for an org that failed and throw
    // the whole map away over a read that succeeded. `driByRepo` tests the
    // orgs for exactly this reason, and so does `resolveScope` in the ingest.
    if (read.length === 0 && failed.length > 0) throw joinFailures(failed);
    return { repos, unreadableOrgs: failed.map((f) => f.org) };
  }

  /**
   * Ask every configured org the same question, and keep both answers: what was
   * read, and which orgs could not be (#718). A per-org failure is recorded
   * against the ORG and logged here rather than raised, so what a partial answer
   * means is each caller's own to state.
   *
   * `mapLimit`'s bound is PER LEVEL, not shared: `actionsUsage` nests a
   * per-month pool inside this per-org one and peaks at
   * `min(8, orgs) * min(8, months)` requests in flight, not 8.
   */
  private async perOrg<T>(
    what: string,
    read: (org: string) => Promise<T>,
  ): Promise<{ read: OrgAnswer<T>[]; failed: OrgFailure[] }> {
    const settled = await mapLimit(
      this.orgs,
      FETCH_CONCURRENCY,
      async (org): Promise<OrgAnswer<T> | OrgFailure> => {
        try {
          return { org, value: await read(org) };
        } catch (err) {
          this.logger.warn(`${what} failed for ${org}: ${(err as Error).message}`);
          return { org, error: err as Error };
        }
      },
    );
    return {
      read: settled.filter((r): r is OrgAnswer<T> => 'value' in r),
      failed: settled.filter((r): r is OrgFailure => 'error' in r),
    };
  }

  /** The one membership rule the walk applies. */
  private inScope(r: { archived?: boolean; fork?: boolean; has_issues?: boolean }): boolean {
    return !r.archived && !r.fork && !!r.has_issues;
  }

  private describe(
    owner: string,
    r: {
      name: string;
      html_url?: string | null;
      description?: string | null;
      language?: string | null;
      pushed_at?: string | null;
      created_at?: string | null;
      default_branch?: string | null;
    },
  ): RepoDescriptor {
    const full = `${owner}/${r.name}`;
    return {
      full,
      name: r.name,
      // The join key into the ingested issues — the ingest stores the short key,
      // not the repo name, so the map has to derive it the same way.
      key: shortRepoKey(full),
      htmlUrl: r.html_url ?? `https://github.com/${full}`,
      description: r.description ?? null,
      language: r.language ?? null,
      // Free: it rides on the listing above, and on the pinned path's own
      // lookup. A repo's last push costs no call of its own (#572).
      pushedAt: r.pushed_at ?? null,
      // Free on the same response, and what tells the repo page whether there is
      // a previous period to compare with (#962).
      createdAt: r.created_at ?? null,
      // Free on the same response, and the reason `ciByRepo` can name a branch
      // without a second read per repo (#572).
      defaultBranch: r.default_branch ?? null,
    };
  }

  /**
   * The repo's README, raw (#575).
   *
   * `GET /repos/{owner}/{repo}/readme` resolves whatever the repo actually
   * named the file — `README.md`, `readme.markdown`, `docs/README.rst`. A
   * hardcoded `README.md` path would report a repo that named it anything else
   * as having none, which is the absence rule failing in the quietest possible
   * way: a wrong fact, stated confidently.
   *
   * 404 is `absent` — a fact about the repo. Every other failure is
   * `unreadable`, which claims nothing about whether a README exists and is
   * worth retrying. So is a body Github declined to encode: over ~1 MB it
   * answers `encoding: "none"` with an empty `content`, and taking that at face
   * value draws a long README as a blank one.
   */
  async readme(full: string): Promise<RepoReadme> {
    const [owner, repo] = full.split('/');
    const octokit = buildOctokitClient(this.config);
    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/readme', { owner, repo });
      const file = data as { content?: string; encoding?: string };
      if (typeof file.content !== 'string' || file.encoding !== 'base64') {
        this.logger.warn(`README for ${full} came back encoded as ${file.encoding ?? 'nothing'}`);
        return { state: 'unreadable' };
      }
      return { state: 'present', markdown: Buffer.from(file.content, 'base64').toString('utf8') };
    } catch (err) {
      if ((err as { status?: number }).status === 404) return { state: 'absent' };
      this.logger.warn(`README read failed for ${full}: ${(err as Error).message}`);
      return { state: 'unreadable' };
    }
  }

  /**
   * One repo's pull-request flow (#575) — both totals and the records the
   * windows are bucketed from, in one GraphQL query per page. Measured at 0.7 s
   * for the first page against the live org.
   *
   * When the page cap stops the read before the window is covered, `coveredFrom`
   * names how far it got, and the derivation reports the windows beyond it as
   * unknown rather than as zero (#582).
   *
   * Never throws: a refused read is `unreadable`, and costs this section alone.
   */
  async pullRequests(full: string, since: string): Promise<RepoPrRead> {
    const [owner, name] = full.split('/');
    const octokit = buildOctokitClient(this.config);
    const sinceMs = Date.parse(since);
    const prs: RepoPrRecord[] = [];
    let after: string | null = null;
    let open = 0;
    let closedMerged = 0;
    let openPrs: RepoOpenPr[] = [];
    let oldest: string | null = null;
    try {
      // 100 PRs reaches only two weeks back on board, so one page
      // does not cover a 10-week window on a busy repo and pagination is not
      // optional. The cap is what stops a repo with thousands of PRs walking its
      // history on a page view.
      for (let page = 0; page < PR_PAGE_CAP; page++) {
        const res = (await octokit.graphql(PR_QUERY, {
          owner,
          name,
          first: PR_PAGE_SIZE,
          openFirst: OPEN_PRS_CAP,
          after,
        })) as PrQueryResult;
        const repository = res.repository;
        if (!repository) return { state: 'unreadable' };
        open = repository.openPRs.totalCount;
        closedMerged = repository.closedPRs.totalCount;
        // The open list rides every page of the walk below, because it hangs
        // off a connection that has nothing to do with the pagination. Taking
        // the latest is the same list each time; taking the first page's would
        // need a branch that says nothing more.
        openPrs = (repository.openPRs.nodes ?? []).map((node) => ({
          number: node.number,
          title: node.title,
          htmlUrl: node.url,
          createdAt: node.createdAt,
          author: node.author?.login ?? null,
          authorIsBot: authoredByBot(node.author),
          draft: node.isDraft,
        }));
        for (const node of repository.recent.nodes ?? []) {
          prs.push({
            number: node.number,
            createdAt: node.createdAt,
            mergedAt: node.mergedAt ?? null,
            closedAt: node.closedAt ?? null,
            author: node.author?.login ?? null,
            authorIsBot: authoredByBot(node.author),
          });
          oldest = node.updatedAt;
        }
        // Nothing further to read: the whole history is in hand, so no window
        // is beyond this read's reach.
        if (!repository.recent.pageInfo.hasNextPage) {
          return { state: 'read', open, closedMerged, prs, coveredFrom: null, openPrs };
        }
        // Past the window's start, so every window is covered and the rest of
        // the history is nothing this page draws.
        if (oldest && Date.parse(oldest) < sinceMs) break;
        after = repository.recent.pageInfo.endCursor;
      }
    } catch (err) {
      this.logger.warn(`Pull-request read failed for ${full}: ${(err as Error).message}`);
      return { state: 'unreadable' };
    }
    return { state: 'read', open, closedMerged, prs, coveredFrom: oldest, openPrs };
  }

  /**
   * Every repo's daily Actions usage for the named months, ORG-WIDE (#575).
   *
   * The enhanced billing report answers with a row per repo per day per SKU for
   * the whole organization, so one call covers one month for all 72 repos and a
   * repo page never triggers a billing read of its own. The page asks for its
   * window and the one before it (#962), twenty weeks, which touch five
   * calendar months on 145 days of 2026 and six on the other 220 —
   * `monthsSpanning` decides how many, and this read asks for what it is given
   * rather than assuming a count.
   *
   * Rows are filtered to `product: "actions"` AND `unitType: "Minutes"`: the
   * same payload carries Actions storage in GigabyteHours and GHAS in
   * UserMonths, neither of which is CI spend, and summing them would report a
   * repo's disk as its pipeline.
   *
   * `netAmount` is what the org was actually billed — gross less whatever the
   * included allowance absorbed — and it is the measure the page draws. The
   * minutes travel beside it so a $0.00 week that RAN can be told from a week
   * that ran nothing (#582).
   *
   * ── Everything unexpected here is `null`, and that is not defensiveness ────
   * The page draws zero minutes as "nothing ran". So every way this read can
   * come back short has to leave as `null` — the CI section saying it could not
   * find out — rather than as a smaller number that reads as a fact:
   *
   * - one month failing takes that ORG's whole answer (#718). A total missing a
   *   month is not a smaller total, it is a wrong one, and a wrong one is
   *   indistinguishable from a quiet month. The rule is per-org because the
   *   totals are: rows are keyed `org/repo`, so one org's July going missing
   *   corrupts one org's numbers and leaves the other org's exactly right.
   *   An org that lost a month is absent from `orgs`, and `null` is left for the
   *   case where no org answered at all.
   * - a 200 whose body has no `usageItems` array is NOT an empty month. An
   *   absent key means the shape moved under us; `[]` would cache as a good
   *   read and draw the whole org as having run nothing, for a whole TTL,
   *   silently.
   * - a `Link` header means Github has started paginating this endpoint and we
   *   are holding page one. Verified live today that it does not: no `Link`,
   *   and `per_page`/`page` are ignored, one call returning one whole month
   *   (873 rows for the largest month measured). That is why no pagination is
   *   written here — and this check is what makes that a stated invariant
   *   rather than an assumption that would fail as a silent undercount.
   * - a row whose `quantity` or `netAmount` is not a number is the same
   *   problem one row down. Never seen live (0 of 1420 rows), which is exactly
   *   why coalescing it to 0 would never be noticed.
   */
  async actionsUsage(months: UsageMonth[]): Promise<ActionsUsageRead | null> {
    const octokit = buildOctokitClient(this.config);
    // `perOrg` catches per org, and every rule above throws, so the all-or-
    // nothing month rule stays exactly as written — it now bounds one org's
    // report rather than the whole answer.
    const { read } = await this.perOrg('Actions usage read', async (org) => {
      const perMonth = await mapLimit(months, FETCH_CONCURRENCY, async (m) => {
        const res = await octokit.request('GET /organizations/{org}/settings/billing/usage', {
          org,
          year: m.year,
          month: m.month,
        });
        const rows = (res.data as { usageItems?: unknown }).usageItems;
        if (!Array.isArray(rows)) {
          throw new Error(`${m.year}-${m.month} answered 200 with no usageItems array`);
        }
        const link = (res.headers as Record<string, string> | undefined)?.link;
        if (link) {
          throw new Error(`${m.year}-${m.month} is paginated (Link: ${link}) and this read holds page one`);
        }
        return (rows as UsageRow[])
          .filter((r) => r.product === 'actions' && r.unitType === 'Minutes')
          .map((r) => {
            if (typeof r.quantity !== 'number' || typeof r.netAmount !== 'number') {
              throw new Error(`${m.year}-${m.month} has a row for ${r.repositoryName} with no numbers on it`);
            }
            return {
              full: `${r.organizationName}/${r.repositoryName}`,
              date: r.date,
              minutes: r.quantity,
              netUsd: r.netAmount,
            };
          });
      });
      return perMonth.flat();
    });
    if (read.length === 0) return null;
    return { days: read.flatMap((r) => r.value), orgs: read.map((r) => r.org) };
  }
}

/** Every org's own reason in one error, the first as `cause` — the shape #697
 *  settled for a read that lost every org it asked. Not the first error
 *  re-raised: with several orgs there are several reasons, and picking one to
 *  report would name whichever failed first as though it were the whole story. */
function joinFailures(failed: OrgFailure[]): Error {
  return new Error(failed.map((f) => f.error.message).join('; '), { cause: failed[0].error });
}
