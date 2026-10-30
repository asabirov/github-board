import { describe, it, expect, vi } from 'vitest';
import { githubContext, githubPrincipal, type GithubPrincipal } from '../auth/github-principal';
import { HIDDEN_FEEDBACK_TITLE } from '../auth/feedback-visibility';
import { IssuesMetricsService } from './issues-metrics.service';
import { IssuesCacheService } from './issues-cache.service';
import { FixtureIssuesSource } from './fixture-issues.source';
import { IIssuesSource, RawIssue } from './issues-metrics.types';
import { ProjectsService } from '../projects/projects.service';
import { FixtureProjectsSource } from '../projects/fixture-projects.source';
import type {
  IProjectsSource,
  ProjectDetailRaw,
  ProjectRollup,
  SourceCatalogEntry,
  SourceMembership,
} from '../projects/project.types';
import { FixtureIdentityRepository } from '../identity/fixture-identity.repository';
import { GithubLoginResolver } from '../identity/github-login.resolver';
import type { IdentityRecord, IdentityRepository } from '../identity/identity.repository';
import { fakeIdentityStore, identityRecordFor } from '../identity/identity.test-double';

/**
 * A ConfigService answering every key with its default, except the two that
 * name the org this file's sample rows are written against: `GITHUB_ORGS` and
 * `FEEDBACK_REPO`.
 *
 * Pinned rather than defaulted (#1166). `acme` was both defaults as well
 * as the sample org, so these cases matched by accident until the organisation
 * was renamed to `acme`; the sample rows are left where they are and the
 * deployment they describe is written down.
 */
/** The board's own repository, which every issue-reading service has to be told
 *  since #1175 took the default away. */
const FEEDBACK_REPO = 'acme/board';

const sampleConfig = () =>
  ({
    get: (k: string, d?: unknown) =>
      k === 'GITHUB_ORGS'
        ? 'acme'
        : k === 'FEEDBACK_REPO'
          ? FEEDBACK_REPO
          : d,
  }) as never;

/** The default store for these specs: no database, so the checked-in alias
 *  table answers — exactly what `githubLoginFor` did before #520's second pass. */
const fileLogins = () => new GithubLoginResolver(new FixtureIdentityRepository());

/** A signed-in teammate — the viewer every pre-#497 assertion below was written
 *  against, now passed explicitly because the read is identity-dependent. */
const HUMAN = { agent: false, email: 'octocat@example.com' };
/** A static `BOARD_AGENT_TOKENS` actor: the `staticAgent` flag JwtAuthGuard sets
 *  on one, which is what `static-agent.ts` reads (#482, #525). The `agent:<name>`
 *  address maps to no person, but it is not what decides. */
const STATIC_AGENT = { agent: true, staticAgent: true, email: 'agent:ci-bot' };

/**
 * The queue's project-name join (#415), wired over the REAL fixture data
 * sources the way local dev/CI actually runs them — not a hand-fed mock
 * `projectsOf` resolver. `groupIssues('project')` on the frontend is correct
 * and already unit-tested (filter-group.spec.ts / viewer-groups.spec.ts); the
 * bug was upstream — `FixtureIssuesSource`'s queue rows (`acme`/`board`
 * issues #100-129) and `FixtureProjectsSource`'s board items (`acme` issues
 * #49/#101/#108/#176/#180/#182/#183/#222/#259/#261) never shared an issue URL,
 * so `membershipIndex()`'s join in `issues-metrics.service.ts` always resolved
 * to `[]` and "Group by Project" had nothing to group in fixture/local-dev
 * mode — exactly the reported symptom.
 */
function svc(): IssuesMetricsService {
  const config = sampleConfig();
  const issuesCache = new IssuesCacheService(new FixtureIssuesSource(), config);
  const projects = new ProjectsService(new FixtureProjectsSource(), config, issuesCache);
  return new IssuesMetricsService(issuesCache, config, projects, fileLogins());
}

describe('IssuesMetricsService — project join over the fixture data (#415)', () => {
  it("getMine: the signed-in user's queue carries a populated `projects` field for at least one issue", async () => {
    const personal = await svc().getMine(HUMAN.email, HUMAN);
    const onABoard = personal.issues.filter((i) => i.projects.length > 0);
    expect(onABoard.length).toBeGreaterThan(0);
  });

  it('getOrgQueue: open issues land on >=2 distinct project boards (multi-board coverage, not a single lucky match)', async () => {
    const queue = await svc().getOrgQueue(HUMAN);
    const onABoard = queue.issues.filter((i) => i.projects.length > 0);
    expect(onABoard.length).toBeGreaterThan(0);
    const distinctProjects = new Set(onABoard.flatMap((i) => i.projects));
    expect(distinctProjects.size).toBeGreaterThanOrEqual(2);
  });

  it('getOrgQueue: at least one issue sits on more than one project board (multi-project case)', async () => {
    const queue = await svc().getOrgQueue(HUMAN);
    expect(queue.issues.some((i) => i.projects.length > 1)).toBe(true);
  });
});

/**
 * #497 — every title-bearing surface off the shared cache, read by a static
 * agent token. A submission's title IS the first line of the message
 * (`submission-footer.ts`), so it has to go; an ordinary team issue in the SAME repo,
 * and a `feedback`-labelled team issue in another repo, both have to stay.
 *
 * Hand-built source rather than the shipped fixture: these three rows are the
 * whole point of the test, and a spec that depends on the fixture happening to
 * hold a submission stops proving anything the day someone edits it.
 */
const DAY_MS = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

const SUBMISSION_TITLE = '[Bug] my weekly report never arrives and the button just spins';
const TEAM_TITLE = 'a static agent token still reads feedback content';
const OTHER_REPO_TITLE = 'Customer: Selgeo weekly digest ask';

const row = (over: Partial<RawIssue>): RawIssue => ({
  // getMetrics samples its clock before listIssues builds rows; keep aging fixtures past the 30-day boundary.
  owner: 'acme', repo: 'board', number: 1, title: '', state: 'open', createdAt: ago(31), closedAt: null,
  // A synthetic row is told no reason, which is the state that COUNTS — so every
  // assertion written before #1014 keeps meaning what it meant.
  stateReason: null,
  htmlUrl: '', author: 'someone', assignees: ['octocat'], labels: [], labelsComplete: true,
  submission: false, milestone: null, ...over,
});

class ThreeIssuesSource implements IIssuesSource {
  async listIssues(): Promise<RawIssue[]> {
    return [
      // A feedback submission: the form's repo, the form's label.
      row({
        number: 460,
        title: SUBMISSION_TITLE,
        htmlUrl: 'https://github.com/acme/board/issues/460',
        labels: ['feedback', 'bug'],
        createdAt: ago(90),
      }),
      // An ordinary team issue in the very same repo.
      row({
        number: 497,
        title: TEAM_TITLE,
        htmlUrl: 'https://github.com/acme/board/issues/497',
        labels: ['access'],
        createdAt: ago(60),
      }),
      // The team's own words ABOUT a customer, labelled `feedback` but filed
      // elsewhere — not a submission, and the label alone must not hide it.
      row({
        repo: 'acme',
        number: 222,
        title: OTHER_REPO_TITLE,
        htmlUrl: 'https://github.com/acme/acme/issues/222',
        labels: ['feedback'],
        createdAt: ago(45),
      }),
    ];
  }
}

function threeIssueSvc(): IssuesMetricsService {
  const config = sampleConfig();
  const issuesCache = new IssuesCacheService(new ThreeIssuesSource(), config);
  const projects = new ProjectsService(new FixtureProjectsSource(), config, issuesCache);
  return new IssuesMetricsService(issuesCache, config, projects, fileLogins());
}

describe('IssuesMetricsService — a static agent token and feedback titles (#497)', () => {
  it('search-index: the submission’s title is replaced, both team issues keep theirs', async () => {
    const index = await threeIssueSvc().getSearchIndex(STATIC_AGENT);
    expect(index.map((i) => i.title).sort()).toEqual(
      [HIDDEN_FEEDBACK_TITLE, OTHER_REPO_TITLE, TEAM_TITLE].sort(),
    );
  });

  it('metrics stale tile: same — and the submission still counts, so nothing about the numbers moves', async () => {
    const metrics = await threeIssueSvc().getMetrics({}, STATIC_AGENT);
    expect(metrics.stale.map((s) => s.title)).toEqual([HIDDEN_FEEDBACK_TITLE, TEAM_TITLE, OTHER_REPO_TITLE]);
    expect(metrics.totals.open).toBe(3);
  });

  it('org queue: same', async () => {
    const queue = await threeIssueSvc().getOrgQueue(STATIC_AGENT);
    expect(queue.issues.map((i) => i.title).sort()).toEqual(
      [HIDDEN_FEEDBACK_TITLE, OTHER_REPO_TITLE, TEAM_TITLE].sort(),
    );
  });

  // This surface used to be asserted with a static agent paired against a HUMAN's
  // address, which the route cannot produce — `getMine` takes its email from the
  // same `req.user` the viewer comes from, so the two are always one caller. Since
  // #546 a static agent resolves to no login and so has no queue at all, which is
  // the stronger answer for that caller: nothing to redact rather than one title
  // hidden. The redaction WIRING on this surface is pinned by the test below, so
  // nothing that was covered here stopped being covered.
  it('personal queue: a static token has no queue of its own, so there is nothing to hide', async () => {
    const mine = await threeIssueSvc().getMine(STATIC_AGENT.email, STATIC_AGENT);
    expect(mine.login).toBeNull();
    expect(mine.issues).toEqual([]);
  });

  it('personal queue: the titles are still redacted for a caller with no address at all', async () => {
    // `withheldFrom` withholds from an addressless caller as well as a static
    // token, and documents that as the fail-closed case a guard regression would
    // produce. It is the withheld caller this surface can still build a queue for,
    // so it is what keeps `redactFeedbackTitles` wired into `getMine` under test.
    const noAddress = { agent: false };
    const mine = await threeIssueSvc().getMine(HUMAN.email, noAddress);
    expect(mine.issues.map((i) => i.title).sort()).toEqual(
      [HIDDEN_FEEDBACK_TITLE, OTHER_REPO_TITLE, TEAM_TITLE].sort(),
    );
  });

  it('a human session reads every title on every one of those surfaces', async () => {
    const svc = threeIssueSvc();
    const intact = [OTHER_REPO_TITLE, SUBMISSION_TITLE, TEAM_TITLE];
    expect((await svc.getSearchIndex(HUMAN)).map((i) => i.title).sort()).toEqual(intact);
    expect((await svc.getMetrics({}, HUMAN)).stale.map((s) => s.title).sort()).toEqual(intact);
    expect((await svc.getOrgQueue(HUMAN)).issues.map((i) => i.title).sort()).toEqual(intact);
    expect((await svc.getMine(HUMAN.email, HUMAN)).issues.map((i) => i.title).sort()).toEqual(intact);
  });

  it('a personal access token reads them too — it carries its owner’s address', async () => {
    const pat = { agent: true, email: 'octocat@example.com' };
    const index = await threeIssueSvc().getSearchIndex(pat);
    expect(index.map((i) => i.title)).toContain(SUBMISSION_TITLE);
  });

  it('the cache itself is never redacted — one static-agent read does not poison the next human’s', async () => {
    const svc = threeIssueSvc();
    await svc.getSearchIndex(STATIC_AGENT);
    const index = await svc.getSearchIndex(HUMAN);
    expect(index.map((i) => i.title)).toContain(SUBMISSION_TITLE);
  });
});

/**
 * #497 — a row whose labels the source could not establish. The decision keys on
 * the `feedback` label being PRESENT, so an incomplete set reads as "no feedback
 * label here" and hands the first line over. The queues fail closed instead, and
 * only in the repo where a submission could live.
 */
class UnestablishedLabelsSource implements IIssuesSource {
  async listIssues(): Promise<RawIssue[]> {
    return [
      row({
        number: 462,
        title: SUBMISSION_TITLE,
        htmlUrl: 'https://github.com/acme/board/issues/462',
        labels: ['bug'],
        labelsComplete: false,
        createdAt: ago(90),
      }),
      row({
        repo: 'acme',
        number: 222,
        title: OTHER_REPO_TITLE,
        htmlUrl: 'https://github.com/acme/acme/issues/222',
        labels: ['bug'],
        labelsComplete: false,
        createdAt: ago(45),
      }),
    ];
  }
}

function unestablishedSvc(): IssuesMetricsService {
  const config = sampleConfig();
  const issuesCache = new IssuesCacheService(new UnestablishedLabelsSource(), config);
  const projects = new ProjectsService(new FixtureProjectsSource(), config, issuesCache);
  return new IssuesMetricsService(issuesCache, config, projects, fileLogins());
}

describe('IssuesMetricsService — rows whose label set was never established (#497)', () => {
  it('withholds the words in the feedback repo, and leaves the other repo alone', async () => {
    const index = await unestablishedSvc().getSearchIndex(STATIC_AGENT);
    expect(index.map((i) => i.title).sort()).toEqual([HIDDEN_FEEDBACK_TITLE, OTHER_REPO_TITLE].sort());
  });

  it('a human session reads both', async () => {
    const index = await unestablishedSvc().getSearchIndex(HUMAN);
    expect(index.map((i) => i.title).sort()).toEqual([OTHER_REPO_TITLE, SUBMISSION_TITLE].sort());
  });
});

/**
 * #516 — the same submission after ordinary triage swapped `feedback` for `bug`.
 * Its labels no longer say what it is; the footer the form wrote into its body
 * still does, and the ingest recorded that at fetch time.
 */
class RelabelledSubmissionSource implements IIssuesSource {
  async listIssues(): Promise<RawIssue[]> {
    return [
      row({
        number: 511,
        title: SUBMISSION_TITLE,
        htmlUrl: 'https://github.com/acme/board/issues/511',
        labels: ['bug', 'in progress'],
        submission: true,
        createdAt: ago(90),
      }),
      row({
        number: 497,
        title: TEAM_TITLE,
        htmlUrl: 'https://github.com/acme/board/issues/497',
        labels: ['access'],
        createdAt: ago(60),
      }),
      // An ordinary board-repo issue that GAINED a `feedback` label and has no
      // footer — the guard that the marker did not replace the label term.
      row({
        number: 514,
        title: OTHER_REPO_TITLE,
        htmlUrl: 'https://github.com/acme/board/issues/514',
        labels: ['feedback'],
        createdAt: ago(45),
      }),
    ];
  }
}

function relabelledSvc(): IssuesMetricsService {
  const config = sampleConfig();
  const issuesCache = new IssuesCacheService(new RelabelledSubmissionSource(), config);
  const projects = new ProjectsService(new FixtureProjectsSource(), config, issuesCache);
  return new IssuesMetricsService(issuesCache, config, projects, fileLogins());
}

describe('IssuesMetricsService — a submission after it is relabelled (#516)', () => {
  it('search-index: the relabelled submission’s title is replaced, the team issue keeps its own', async () => {
    const index = await relabelledSvc().getSearchIndex(STATIC_AGENT);
    const titles = index.map((i) => i.title);
    expect(titles).not.toContain(SUBMISSION_TITLE);
    expect(titles).toContain(HIDDEN_FEEDBACK_TITLE);
    expect(titles).toContain(TEAM_TITLE);
  });

  it('metrics stale tile: same, and the row still counts', async () => {
    const metrics = await relabelledSvc().getMetrics({}, STATIC_AGENT);
    const titles = metrics.stale.map((s) => s.title);
    expect(titles).not.toContain(SUBMISSION_TITLE);
    expect(titles).toContain(HIDDEN_FEEDBACK_TITLE);
    expect(metrics.totals.open).toBe(3);
  });

  it('an ordinary issue that merely GAINED a `feedback` label is hidden too — the label term still runs', async () => {
    const index = await relabelledSvc().getSearchIndex(STATIC_AGENT);
    expect(index.map((i) => i.title)).not.toContain(OTHER_REPO_TITLE);
  });

  it('a human session and a personal access token read every title whole', async () => {
    for (const viewer of [HUMAN, { agent: true, email: 'octocat@example.com' }]) {
      const index = await relabelledSvc().getSearchIndex(viewer);
      expect(index.map((i) => i.title).sort()).toEqual(
        [OTHER_REPO_TITLE, SUBMISSION_TITLE, TEAM_TITLE].sort(),
      );
    }
  });
});

/**
 * #520 second cycle — whose work "Your work" shows.
 *
 * The queue is attributed by assignee, so the whole page hangs on one join:
 * signed-in address → Github handle. That answer used to come from the alias
 * table compiled into the build, which meant an admin could correct somebody's
 * handle on the Access page and the page that person opens would not move until
 * the next deploy. It now comes from the roster, with the file underneath.
 */
const NEW_JOINER = 'maria.lopez@example.com';
const ROSTER_HANDLE = 'mlopez';

class AssignedIssuesSource implements IIssuesSource {
  constructor(private readonly assignee: string) {}
  async listIssues(): Promise<RawIssue[]> {
    return [
      row({
        number: 520,
        title: 'a queue row assigned to the handle under test',
        htmlUrl: 'https://github.com/acme/board/issues/520',
        assignees: [this.assignee],
        createdAt: ago(10),
      }),
    ];
  }
}

/** The admin-editable half, from records — one array serving both directions. */
function rosterStore(records: IdentityRecord[]): IdentityRepository {
  return fakeIdentityStore(records);
}

/** A roster record for `email` carrying `githubLogin`, boring fields filled in. */
function rostered(email: string, githubLogin: string | null, displayName = 'Somebody'): IdentityRecord {
  return identityRecordFor({ emails: [email], displayName, githubLogin });
}

function svcFor(assignee: string, logins: GithubLoginResolver): IssuesMetricsService {
  const config = sampleConfig();
  const issuesCache = new IssuesCacheService(new AssignedIssuesSource(assignee), config);
  const projects = new ProjectsService(new FixtureProjectsSource(), config, issuesCache);
  return new IssuesMetricsService(issuesCache, config, projects, logins);
}

describe('IssuesMetricsService — which handle "Your work" attributes by (#520)', () => {
  it('a handle set only in the roster attributes the work — no deploy in the loop', async () => {
    const logins = new GithubLoginResolver(rosterStore([rostered(NEW_JOINER, ROSTER_HANDLE, 'Maria Lopez')]));
    const mine = await svcFor(ROSTER_HANDLE, logins).getMine(NEW_JOINER, {
      agent: false,
      email: NEW_JOINER,
    });
    expect(mine.issues.map((i) => i.number)).toEqual([520]);
  });

  it('the roster wins over the checked-in table when the two disagree', async () => {
    const logins = new GithubLoginResolver(rosterStore([rostered(HUMAN.email, 'renamed-handle', 'Octocat')]));
    // Work filed under the roster's handle reaches them…
    const roster = await svcFor('renamed-handle', logins).getMine(HUMAN.email, HUMAN);
    expect(roster.issues.map((i) => i.number)).toEqual([520]);
    // …and work under the stale one in the file no longer does.
    const stale = await svcFor('octocat', logins).getMine(HUMAN.email, HUMAN);
    expect(stale.issues).toEqual([]);
  });

  // #535. The third tier. Unlike board_whoami, "Your work" DOES attribute by a
  // derived handle — attribution is the whole point of the feature.
  it('attributes work to a handle derived from commit authorship', async () => {
    const derived = { loginFor: (e: string) => (e === NEW_JOINER ? 'newbie' : null) };
    const logins = new GithubLoginResolver(rosterStore([]), derived as never);
    const mine = await svcFor('newbie', logins).getMine(NEW_JOINER, { agent: false, email: NEW_JOINER });
    expect(mine.login).toBe('newbie');
    expect(mine.issues.map((i) => i.number)).toEqual([520]);
  });

  it('a derived handle never displaces one the roster carries', async () => {
    const derived = { loginFor: () => 'newbie' };
    const logins = new GithubLoginResolver(
      rosterStore([rostered(HUMAN.email, 'renamed-handle', 'Octocat')]),
      derived as never,
    );
    const mine = await svcFor('renamed-handle', logins).getMine(HUMAN.email, HUMAN);
    expect(mine.login).toBe('renamed-handle');
  });

  it('a person the roster does not know still attributes through the checked-in table', async () => {
    const logins = new GithubLoginResolver(rosterStore([]));
    const mine = await svcFor('octocat', logins).getMine(HUMAN.email, HUMAN);
    expect(mine.issues.map((i) => i.number)).toEqual([520]);
  });

  it('with no database at all, attribution is exactly what the file always gave', async () => {
    const mine = await svcFor('monalisa', fileLogins()).getMine(
      'monalisa@example.com',
      { agent: false, email: 'monalisa@example.com' },
    );
    expect(mine.issues.map((i) => i.number)).toEqual([520]);
  });

  // #546. `login` is an assertion about who the caller is, so this route answers
  // "who am I" as surely as /api/auth/me does — and a static token reaches it,
  // since an undecorated GET takes the read scope every one of them holds. Both
  // must give a static agent the same answer or the board has two.
  it('a static agent is attributed nothing, and the roster is never asked', async () => {
    const asked: string[] = [];
    // A row that WOULD answer for the pseudo-address, mapped to the very handle
    // this service files every issue under — so a lookup that happens hands the
    // token a real person's queue, which is the defect stated as an outcome.
    const base = rosterStore([rostered(STATIC_AGENT.email, 'should-never-be-returned', 'Somebody Real')]);
    const logins = new GithubLoginResolver({
      ...base,
      identityForEmail: async (email: string) => {
        asked.push(email);
        return base.identityForEmail(email);
      },
    });

    const mine = await svcFor('should-never-be-returned', logins).getMine(
      STATIC_AGENT.email,
      STATIC_AGENT,
    );

    expect(asked).toEqual([]);
    expect(mine.login).toBeNull();
    expect(mine.issues).toEqual([]);
    expect(mine.projectContributions).toEqual([]);
  });

  it('a person whose token carries the same scopes is attributed exactly as before', async () => {
    // The short-circuit keys on `staticAgent`, not on `agent`: a personal access
    // token is its owner's, and its owner's work is theirs to see.
    const logins = new GithubLoginResolver(rosterStore([rostered(HUMAN.email, 'renamed-handle')]));
    const pat = { agent: true, email: HUMAN.email, scopes: ['board:read'] };
    const mine = await svcFor('renamed-handle', logins).getMine(HUMAN.email, pat);
    expect(mine.login).toBe('renamed-handle');
    expect(mine.issues.map((i) => i.number)).toEqual([520]);
  });
});

/**
 * The reverse direction on the surface #541 names: which rows the Unit
 * throughput pulse seeds (#541).
 *
 * `AssignedIssuesSource` files one issue at `ago(10)` with no `closedAt`, and
 * computeMetrics only counts a trailing-7d window, so it bumps nothing. `byMember`
 * under `svcFor` is therefore exactly the seed list, every row at 0/0 — a clean
 * read of `roster.logins` and `roster.names` with no arithmetic in the way.
 */
describe('IssuesMetricsService — whose rows the throughput pulse seeds (#541)', () => {
  const byMemberOf = async (logins: GithubLoginResolver) =>
    (await svcFor('nobody-at-all', logins).getMetrics({}, HUMAN)).byMember;

  it('a member the roster alone knows gets a row on the throughput pulse', async () => {
    const logins = new GithubLoginResolver(
      rosterStore([rostered(NEW_JOINER, ROSTER_HANDLE, 'Maria Lopez')]),
    );
    expect(await byMemberOf(logins)).toContainEqual(
      expect.objectContaining({ login: ROSTER_HANDLE, name: 'Maria Lopez', opened: 0, closed: 0 }),
    );
  });

  // Not an empty store: an empty one passes whether or not the union exists.
  it('a member the checked-in table alone knows still gets a row', async () => {
    const logins = new GithubLoginResolver(
      rosterStore([rostered(NEW_JOINER, ROSTER_HANDLE, 'Maria Lopez')]),
    );
    const rows = await byMemberOf(logins);
    expect(rows.map((m) => m.login)).toContain('octocat');
    expect(rows.map((m) => m.login)).toContain(ROSTER_HANDLE);
  });

  it('a member whose handle an admin cleared leaves the pulse', async () => {
    const logins = new GithubLoginResolver(
      rosterStore([rostered(HUMAN.email, null, 'Octocat')]),
    );
    expect((await byMemberOf(logins)).map((m) => m.login)).not.toContain('octocat');
  });

  // The only service-level assertion on byMember[].name there is. `names` is
  // keyed folded and computeMetrics reports the stored case, so dropping the
  // `.toLowerCase()` on the lookup renders every mixed-case login as a bare
  // handle on the Unit page while the whole suite stays green.
  it('a mixed-case handle still shows the person’s name, not the bare login', async () => {
    const logins = new GithubLoginResolver(rosterStore([]));
    expect(await byMemberOf(logins)).toContainEqual(
      expect.objectContaining({ login: 'hubot', name: 'Hubot', opened: 0, closed: 0 }),
    );
  });

  // Sync now → Unit chart is the exact path #541 is about, and it was the one
  // invalidation call site nothing covered: deleting it left the whole suite
  // green. The assertion is on the roster being re-read, not on a spy of the
  // method, so it still holds if the invalidation is expressed some other way.
  it('resync drops the roster memo, so Sync now does not leave the pulse a minute stale', async () => {
    const base = fakeIdentityStore([]);
    const list = vi.fn(() => base.list());
    const logins = new GithubLoginResolver({ ...base, list });
    const svc = svcFor('nobody-at-all', logins);

    await svc.getMetrics({}, HUMAN);
    expect(list).toHaveBeenCalledTimes(1);
    await svc.resync();
    await svc.getMetrics({}, HUMAN);
    expect(list).toHaveBeenCalledTimes(2);
  });
});

/**
 * #650 — `/api/issues/mine` and `/api/issues/all` are shaped by ONE builder, so
 * a test on either alone proves nothing about the other; both are asserted here.
 * The rows below are the collision the short key cannot express: two live repos
 * called `design-system`, one per org, folding onto the same `repo` value.
 */
class TwoOrgSource implements IIssuesSource {
  async listIssues(): Promise<RawIssue[]> {
    return [
      row({
        owner: 'acme',
        repo: 'design-system',
        number: 11,
        title: 'ours',
        htmlUrl: 'https://github.com/acme/design-system/issues/11',
      }),
      row({
        owner: 'globex',
        repo: 'design-system',
        number: 22,
        title: 'theirs',
        htmlUrl: 'https://github.com/globex/design-system/issues/22',
      }),
    ];
  }
}

function twoOrgSvc(): IssuesMetricsService {
  const config = { get: (k: string, d?: unknown) => k === 'GITHUB_ORGS' ? 'acme,globex' : k === 'FEEDBACK_REPO' ? FEEDBACK_REPO : d } as never;
  const issuesCache = new IssuesCacheService(new TwoOrgSource(), config);
  const projects = new ProjectsService(new FixtureProjectsSource(), config, issuesCache);
  return new IssuesMetricsService(issuesCache, config, projects, fileLogins());
}

describe('IssuesMetricsService — a queue row names the org it came from (#650)', () => {
  // Two DIFFERENT expected owners over one field: no single constant satisfies
  // both, so a row that hardcoded or dropped the org fails these.
  const expected = ['acme/design-system#11', 'globex/design-system#22'];
  const key = (i: { owner: string; repo: string; number: number }) => `${i.owner}/${i.repo}#${i.number}`;

  it('getMine (/api/issues/mine): the two same-short-key repos give two distinguishable rows', async () => {
    const mine = await twoOrgSvc().getMine(HUMAN.email, HUMAN);
    expect(mine.issues.map(key).sort()).toEqual(expected);
  });

  it('getOrgQueue (/api/issues/all): the same, through the other endpoint the builder feeds', async () => {
    const queue = await twoOrgSvc().getOrgQueue(HUMAN);
    expect(queue.issues.map(key).sort()).toEqual(expected);
  });

  it('getMetrics: the aging rows behind Oldest-open name their orgs too', async () => {
    const m = await twoOrgSvc().getMetrics({}, HUMAN);
    expect(m.stale.map(key).sort()).toEqual(expected);
  });
});

/**
 * #697 — the two surfaces that receive the UNIONED board list and key on the
 * board number alone.
 *
 * A Github Projects number is unique only WITHIN an org, so a deployment naming
 * two orgs can hold two different boards both numbered 3. Both orgs below do,
 * with different names, because that is the one shape where dropping the org
 * loses a board outright rather than merely blurring it — and it is invisible on
 * the single-org default, where "board 3" names exactly one thing.
 *
 * Driven through the real `ProjectsService` over the real per-org union, not a
 * hand-fed board list: the union is where the collision is created, so a test
 * that fed the two boards in directly would pass on a build whose union was
 * never wired to these surfaces at all.
 */
const COLLIDING_ORGS = 'org-alpha,org-beta';
/** Both orgs number a board 3. Only the name — and whose issue is on it — differ. */
const BOARD_NAME: Record<string, string> = { 'org-alpha': 'Platform', 'org-beta': 'Delivery' };
const boardIssueUrl = (org: string) => `https://github.com/${org}/repo/issues/3`;

class CollidingProjectsSource implements IProjectsSource {
  async listProjects(org: string): Promise<ProjectRollup[]> {
    return [
      {
        number: 3,
        name: BOARD_NAME[org],
        url: `https://github.com/orgs/${org}/projects/3`,
        status: 'active',
        open: 1,
        closed: 0,
        pct: 0,
        excludedItems: 0,
        itemsComplete: true,
        weeklyClosed: [],
        closedThisWeek: 0,
        openedThisWeek: 0,
        contributors: [],
        contributorsByAssignee: [],
        recentCloses: [],
      },
    ];
  }

  async projectMemberships(org: string): Promise<SourceMembership[]> {
    return [{ number: 3, name: BOARD_NAME[org], issueUrls: [boardIssueUrl(org)] }];
  }

  async getProject(): Promise<ProjectDetailRaw | null> {
    return null;
  }

  async listProjectCatalog(): Promise<SourceCatalogEntry[]> {
    return [];
  }

  /** Nothing in flight to disown — every read above is immediate (#713). */
  disownInFlightReads(): void {}
}

/** One open issue per org, assigned to the caller, sitting on that org's board 3. */
class CollidingIssuesSource implements IIssuesSource {
  async listIssues(): Promise<RawIssue[]> {
    return ['org-alpha', 'org-beta'].map((org) =>
      row({ owner: org, repo: 'repo', number: 3, title: `${org} work`, htmlUrl: boardIssueUrl(org) }),
    );
  }
}

function collidingSvc(): IssuesMetricsService {
  const config = {
    get: (k: string, d?: unknown) => (k === 'GITHUB_ORGS' ? COLLIDING_ORGS : k === 'FEEDBACK_REPO' ? FEEDBACK_REPO : d),
  } as never;
  const issuesCache = new IssuesCacheService(new CollidingIssuesSource(), config);
  const projects = new ProjectsService(new CollidingProjectsSource(), config, issuesCache);
  return new IssuesMetricsService(issuesCache, config, projects, fileLogins());
}

describe('IssuesMetricsService — two orgs numbering a board the same (#697)', () => {
  it('getFilterOptions (/api/issues/filter-options): both boards 3 are offered, each naming its org', async () => {
    const opts = await collidingSvc().getFilterOptions(HUMAN);
    // Sorted by name, as this menu always has been — the assertion is that
    // neither entry was dropped and each says which org it belongs to.
    expect(opts.projects).toEqual([
      { org: 'org-beta', number: 3, name: 'Delivery' },
      { org: 'org-alpha', number: 3, name: 'Platform' },
    ]);
  });

  it('getMine (/api/issues/mine): the two contribution rows can be told apart by org', async () => {
    const mine = await collidingSvc().getMine(HUMAN.email, HUMAN);
    expect((mine.projectContributions ?? []).map((r) => `${r.org}#${r.number} ${r.name}`).sort()).toEqual([
      'org-alpha#3 Platform',
      'org-beta#3 Delivery',
    ]);
  });
});

describe('Org lag scan availability (#843)', () => {
  const metric = async (orgUnreadable: boolean, repoFailed: boolean) => {
    const config = sampleConfig();
    const source = {
      listIssues: async () => [row({ state: 'closed', createdAt: ago(10), closedAt: ago(1) })],
      orgOutcomes: () => [{ org: 'acme', state: orgUnreadable ? 'unreadable' as const : 'read' as const, reason: null, calls: 1 }],
      repoOutcomes: () => [{ full: 'acme/board', ok: !repoFailed }],
    };
    const cache = new IssuesCacheService(source, config);
    const service = new IssuesMetricsService(cache, config, {} as ProjectsService, fileLogins());
    return service.getMetrics({}, HUMAN);
  };

  it.each([[true, false], [false, true], [true, true]])('withholds the mean on an incomplete scan (org=%s, repo=%s)', async (org, repo) => {
    const m = await metric(org, repo);
    expect(m.ttc.readable).toBe(false);
    expect(m.ttc.meanDays).toBeNull();
    expect(m.ttc.comparison).toBeNull();
  });

  it('publishes the mean when the scan is readable', async () => {
    const m = await metric(false, false);
    expect(m.ttc.readable).toBe(true);
    expect(m.ttc.meanDays).toBeCloseTo(9);
    expect(m.ttc.comparison?.weekly).toHaveLength(13);
  });
});

describe('selected organization issue scope (#923, #924)', () => {
  it('narrows both queues and metrics by owner, without contaminating the union', async () => {
    const service = twoOrgSvc();
    for (const owner of ['globex', 'acme']) {
      const mine = await service.getMine(HUMAN.email, HUMAN, owner);
      const queue = await service.getOrgQueue(HUMAN, owner);
      const metrics = await service.getMetrics({ org: owner }, HUMAN);
      expect(mine.issues.map(i => i.owner)).toEqual([owner]);
      expect(queue.issues.map(i => i.owner)).toEqual([owner]);
      expect(metrics.stale.map(i => i.owner)).toEqual([owner]);
    }
    expect((await service.getOrgQueue(HUMAN)).issues).toHaveLength(2);
  });
});


describe('selected scope read outcomes and closed reconciliation (#924)', () => {
  function service(state: 'read' | 'unreadable' = 'read', repoOk = true) {
    const config = { get: (k: string, d?: unknown) => k === 'GITHUB_ORGS' ? 'acme,globex,quiet' : k === 'FEEDBACK_REPO' ? FEEDBACK_REPO : d } as never;
    const yesterday = new Date(); yesterday.setUTCHours(12, 0, 0, 0); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const source = {
      listIssues: async () => ['acme', 'globex'].flatMap((owner, index) => [
        row({ owner, htmlUrl: `https://github.com/${owner}/board/issues/1` }),
        ...Array.from({ length: index + 1 }, (_, i) => row({ owner, number: i + 2,
          htmlUrl: `https://github.com/${owner}/board/issues/${i + 2}`, state: 'closed' as const,
          closedAt: yesterday.toISOString(), assignees: ['octocat', 'teammate'] })),
      ]),
      orgOutcomes: () => ['acme', 'globex', 'quiet'].map(org => ({ org,
        state: org === 'globex' ? state : 'read' as const, reason: null, calls: 1 })),
      repoOutcomes: () => [{ full: 'globex/board', ok: repoOk }],
    };
    const cache = new IssuesCacheService(source, config);
    return new IssuesMetricsService(cache, config, { projectMemberships: async () => [] } as never, fileLogins());
  }
  it('reconciles scoped closed lists, daily series and the combined list', async () => {
    const s = service();
    for (const [org, count] of [['acme', 1], ['GLOBEX', 2], [undefined, 3]] as const) {
      const m = await s.getMetrics({ org }, HUMAN);
      expect(m.closedYesterday).toHaveLength(count);
      expect(m.days.closed.at(-2)).toBe(count);
      expect(m.weeks.at(-1)?.closed).toBe(count);
      expect(m.closedYesterday?.every(i => !org || i.owner === org.toLowerCase())).toBe(true);
      expect(m.byMember.find(i => i.login === 'octocat')?.closed).toBe(count);
    }
  });
  it('returns a genuine quiet-org zero and refuses unserved, unreadable and failed-repo scopes distinctly', async () => {
    expect((await service().getOrgQueue(HUMAN, 'quiet')).issues).toEqual([]);
    await expect(service().getOrgQueue(HUMAN, 'outside')).rejects.toMatchObject({ status: 404 });
    await expect(service('unreadable').getMine(HUMAN.email, HUMAN, 'globex')).rejects.toMatchObject({ status: 503 });
    await expect(service('read', false).getMetrics({ org: 'globex' }, HUMAN)).rejects.toMatchObject({ status: 503 });
    expect((await service('unreadable').getOrgQueue(HUMAN, 'acme')).issues).toHaveLength(1);
  });
});

it('keeps one canonical issue in the selected queue when it belongs to two projects (#924)', async () => {
  const config = { get: (k: string, d?: unknown) => k === 'GITHUB_ORGS' ? 'acme,globex' : k === 'FEEDBACK_REPO' ? FEEDBACK_REPO : d } as never;
  const cache = new IssuesCacheService(new TwoOrgSource(), config);
  const projects = { projectMemberships: async () => [
    { org: 'acme', number: 1, name: 'Delivery', issueUrls: ['https://github.com/acme/design-system/issues/11'] },
    { org: 'acme', number: 2, name: 'Maintenance', issueUrls: ['https://github.com/acme/design-system/issues/11'] },
  ] } as never;
  const service = new IssuesMetricsService(cache, config, projects, fileLogins());
  const queue = await service.getOrgQueue(HUMAN, 'acme');
  expect(queue.issues).toHaveLength(1);
  expect(queue.issues[0].projects).toEqual(['Delivery', 'Maintenance']);
  expect((await service.getMetrics({ org: 'acme' }, HUMAN)).totals.open).toBe(1);
});


describe('pinned issue coverage (#923/#924 R1)', () => {
  const principal: GithubPrincipal = {
    key: 'scope-test', email: HUMAN.email, login: 'octocat', token: 'fixture',
    owners: ['acme', 'globex'].map(login => ({ login, type: 'Organization' })),
    repositories: [{ id: 1, full_name: 'acme/board', name: 'board', owner: { login: 'acme' } }],
    cache: new WeakMap(),
  };
  for (const context of ['global', 'person'] as const) {
    it(`uses actual repository reads in the ${context} context`, async () => {
      const check = async () => {
        const config = { get: (k: string, d?: unknown) => ({
          GITHUB_ORGS: 'acme,globex', FEEDBACK_REPO,
        } as Record<string, string>)[k] ?? d } as never;
        for (const repos of [[{ full: 'acme/board', ok: true }], []]) {
          const source = { listIssues: async () => [], orgOutcomes: () => [], repoOutcomes: () => repos };
          const s = new IssuesMetricsService(new IssuesCacheService(source, config), config,
            { projectMemberships: async () => [] } as never, fileLogins());
          const reads = (org?: string) => [
            () => s.getOrgQueue(HUMAN, org), () => s.getMine(HUMAN.email, HUMAN, org),
            () => s.getMetrics({ org }, HUMAN),
          ];
          for (const read of reads('globex')) await expect(read()).rejects.toMatchObject({ status: 404 });
          if (repos.length) {
            expect((await s.getOrgQueue(HUMAN, 'acme')).issues).toEqual([]);
            expect((await s.getMine(HUMAN.email, HUMAN, 'acme')).issues).toEqual([]);
            expect((await s.getMetrics({ org: 'acme' }, HUMAN)).totals.open).toBe(0);
          } else {
            for (const read of reads('acme')) await expect(read()).rejects.toMatchObject({ status: 404 });
          }
          expect((await s.getMetrics({}, HUMAN)).totals.open).toBe(0);
        }
      };
      await (context === 'person' ? githubContext.run({ principal }, check) : check());
    });
  }
});

describe('the two stamps on the personal payload answer two different questions (#1015)', () => {
  it('leaves computedAt at the request instant while updatedAt takes the cache’s fetch time', async () => {
    // The promise `issues-metrics.service.ts` makes in a comment and that
    // nothing held: `updatedAt` is overwritten with the raw-issue cache's `at`,
    // and `computedAt` — the clock the day series were bucketed by, and the day
    // the grid dates every cell from — must survive it. Stamping the cache time
    // on the anchor hands the grid a day older than the days it draws.
    const before = Date.now();
    const service = svc();
    // Two reads: the first fills the cache, the second is served from it, so
    // `updatedAt` on this one is the FIRST read's fetch time.
    await service.getMine(HUMAN.email, HUMAN);
    const personal = await service.getMine(HUMAN.email, HUMAN);

    expect(personal.computedAt).toBeDefined();
    const computed = Date.parse(personal.computedAt!);
    expect(Number.isNaN(computed)).toBe(false);
    // The anchor is this request's own clock, never earlier than the call.
    expect(computed).toBeGreaterThanOrEqual(before);
    // And it is at or after the freshness stamp, never behind it — the direction
    // that would misdate the grid.
    expect(computed).toBeGreaterThanOrEqual(Date.parse(personal.updatedAt));
  });
});

it('recomputes viewer days from the same raw cache without leaking the previous zone', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-26T12:00:00Z'));
  try {
    const config = sampleConfig();
    const source = { listIssues: vi.fn(async () => [row({ state: 'closed', assignees: ['octocat'],
      createdAt: '2026-09-25T22:30:00Z', closedAt: '2026-09-25T22:30:00Z' })]) };
    const cache = new IssuesCacheService(source, config);
    const service = new IssuesMetricsService(cache, config,
      new ProjectsService(new FixtureProjectsSource(), config, cache), fileLogins());
    for (const [timeZone, expected] of [
      ['Europe/Berlin', [0, 1]], ['America/Los_Angeles', [1, 0]], ['Europe/Berlin', [0, 1]],
    ] as const) {
      const metrics = await service.getMetrics({ timeZone }, HUMAN);
      const mine = await service.getMine(HUMAN.email, HUMAN, undefined, timeZone);
      expect(metrics.timeZone).toBe(timeZone);
      expect(metrics.days.closed.slice(-2)).toEqual(expected);
      expect(metrics.byMember.find(m => m.login === 'octocat')?.closedDays.slice(-2)).toEqual(expected);
      expect(metrics.closedYesterday).toHaveLength(expected[0]);
      expect(mine.timeZone).toBe(timeZone);
      expect(mine.closedDays?.slice(-2)).toEqual(expected);
    }
    expect(source.listIssues).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

describe('personal metric scope disclosure', () => {
  it('returns scope and freshness for metrics, personal work and the shared queue', async () => {
    const service = svc();
    const answers = await Promise.all([
      service.getMetrics({}, HUMAN), service.getMine(HUMAN.email, HUMAN), service.getOrgQueue(HUMAN),
    ]);
    expect(answers[0].metricScope?.definition).not.toBe(answers[1].metricScope?.definition);
    for (const answer of answers) {
      expect(answer).toHaveProperty('metricScope');
      expect(answer.metricScope).toMatchObject({
        completeness: 'unknown', timeZone: 'UTC',
        sourceUpdatedAt: answer.updatedAt,
      });
      expect(answer.metricScope?.repositoryIds).toBeNull();
    }
  });
});


it('keeps metric repository scope isolated across two viewers and cached rereads', async () => {
  const viewer = (key: string, id: number): GithubPrincipal => ({
    key, email: HUMAN.email, login: key, token: null, cache: new WeakMap(),
    owners: [{ id, login: key, type: 'Organization' }], repositories: [],
  });
  const first = viewer('first', 10);
  const second = viewer('second', 20);
  const source = {
    listIssues: vi.fn(async () => []),
    repoOutcomes: () => [{ id: githubPrincipal()!.owners[0].id, full: `${githubPrincipal()!.login}/work`, ok: true }],
  };
  const config = sampleConfig();
  const service = new IssuesMetricsService(new IssuesCacheService(source, config), config,
    { projectMemberships: async () => [] } as never, fileLogins());
  for (const principal of [first, second, first]) {
    const responses = await githubContext.run({ principal }, async () => [
      await service.getMetrics({}, HUMAN), await service.getMine(HUMAN.email, HUMAN), await service.getOrgQueue(HUMAN),
    ]);
    for (const response of responses) {
      expect(response.metricScope).toMatchObject({
        repositories: [{ id: principal.owners[0].id, name: `${principal.login}/work`, readable: true }],
        ownerIds: [principal.owners[0].id], repositoryIds: [principal.owners[0].id],
      });
    }
  }
  expect(source.listIssues).toHaveBeenCalledTimes(2);
});
