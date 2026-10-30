import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HIDDEN_FEEDBACK_TITLE } from '../auth/feedback-visibility';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { FixtureProjectsSource } from './fixture-projects.source';
import { FixtureIssuesSource } from '../issues-metrics/fixture-issues.source';
import { IssuesCacheService, type SubmissionIndex } from '../issues-metrics/issues-cache.service';
import { completionPct, deriveProjectStatus } from './project-derive';
import { tallyContributors } from './project-contributors';
import type {
  IProjectsSource,
  ProjectCatalogEntry,
  ProjectClose,
  ProjectDetail,
  ProjectDetailRaw,
  ProjectItemRaw,
  ProjectRollup,
  ProjectSummary,
  SourceCatalogEntry,
  SourceMembership,
} from './project.types';

/** A signed-in teammate. */
const HUMAN = { agent: false, email: 'octocat@example.com' };
/** A static `BOARD_AGENT_TOKENS` actor: the `staticAgent` flag JwtAuthGuard sets
 *  on one, which is what `static-agent.ts` reads (#482, #525). The `agent:<name>`
 *  address maps to no person, but it is not what decides. */
const STATIC_AGENT = { agent: true, staticAgent: true, email: 'agent:ci-bot' };
/** A personal access token (#210) carries its owner's real address. */
const PAT = { agent: true, email: 'octocat@example.com' };

// A real ProjectsService over the fixture sources with a stub config (TTL only).
// The weekly-close join (#391) now reads the shared IssuesCacheService, so wrap
// the fixture issues source in a real cache here.
// `submissions` is the recency pick's submission marker (#516). A close carries
// no body, so it comes from the shared index — and the hand-built board below
// holds issue numbers the fixture ingest has never seen, which a real index
// would (correctly) answer `null` for and withhold. These cases are about the
// LABEL and AUTHOR halves of the walk, so the default says "every body read, no
// footer found" and they go on asserting exactly what they always did. The #516
// block at the bottom passes a knowing index instead.
function svc(
  source: IProjectsSource = new FixtureProjectsSource(),
  submissions: SubmissionIndex | null = { lookup: () => false },
): ProjectsService {
  // `GITHUB_ORGS` and `FEEDBACK_REPO` are pinned at the org the fixture sources
  // serve (#1166): they were the defaults too, until the organisation was
  // renamed to `acme` and #1175 took both defaults off. An unpinned config now
  // has no org at all — the resolver refuses an env that names none.
  const config = {
    get: (k: string, d?: unknown) =>
      k === 'GITHUB_ORGS'
        ? 'acme'
        : k === 'FEEDBACK_REPO'
          ? 'acme/board'
          : d,
  } as never;
  const issuesCache = new IssuesCacheService(new FixtureIssuesSource(), config);
  issuesCache.submissionIndex = async () => submissions;
  return new ProjectsService(source, config, issuesCache);
}

/** The controller over a service, with the org its `?org=` gate serves (#648).
 *  `acme` is the owner the fixtures elsewhere in this file are written
 *  against. `PROJECTS_OWNER` named it until #1209 part 4 retired the key, so it
 *  comes from the owner scope now. */
function ctl(projects: ProjectsService, org = 'acme'): ProjectsController {
  return new ProjectsController(projects, new ConfigService({ GITHUB_ORGS: org }));
}

describe('ProjectsController', () => {
  const c = ctl(svc());
  const req = { user: HUMAN };

  it('GET /projects returns the board rollup (without the "Acme" umbrella, #202)', async () => {
    const { projects } = await c.list(req);
    expect(projects.some((p) => p.name === 'Acme Go-To-Market')).toBe(true);
    expect(projects.some((p) => p.name === 'Acme')).toBe(false);
  });

  it('GET /projects/:number returns the board with its issues', async () => {
    const detail = await c.detail(req, '7');
    expect(detail.name).toBe('Acme Go-To-Market');
    expect(detail.items.length).toBeGreaterThan(0);
  });

  it('GET /projects/:number 404s on an unknown board', async () => {
    await expect(c.detail(req, '9999')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('GET /projects/:number 400s on a non-numeric segment', async () => {
    await expect(c.detail(req, 'abc')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('GET /projects/catalog returns the candidate-boards list (#404)', async () => {
    const catalog = await c.catalog();
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.some((e) => e.title === 'Acme Go-To-Market')).toBe(true);
  });

  it('a numeric path still resolves to detail — route order is load-bearing (#404)', async () => {
    // "catalog" is declared before ":number" in the controller; a real numeric
    // segment like "7" must still hit `detail`, not be swallowed by the literal
    // route.
    const detail = await c.detail(req, '7');
    expect(detail.name).toBe('Acme Go-To-Market');
    expect(detail.items.length).toBeGreaterThan(0);
  });
});

/**
 * #497, the Projects half. Projects v2 does not read the shared issues cache —
 * it runs its own GraphQL — so the redaction applied there never reached these
 * three routes, and a submission triaged onto a board handed a static token its
 * first line verbatim.
 *
 * Hand-built source rather than the shipped fixture: these rows are the whole
 * point of the test, and a spec that depends on the fixture happening to hold a
 * submission stops proving anything the day someone edits it. (The fixture is
 * separately asserted to carry one, so local dev and a live curl exercise the
 * same path — see fixture-projects.source.spec.ts.)
 */
const SUBMISSION_TITLE = '[Bug] my weekly report never arrives and the button just spins';
const OLDER_SUBMISSION_TITLE = '[Idea] let me export the roster as a CSV';
const TEAM_TITLE = 'Reconcile legacy architecture docs';
const TEAM_CLOSED_TITLE = '[C3-PRODUCT-2] Waitlist extension';

const FEEDBACK_REPO = 'acme/board';
const iso = (d: string) => `2026-07-${d}T00:00:00Z`;

const item = (over: Partial<ProjectItemRaw>): ProjectItemRaw => ({
  repo: FEEDBACK_REPO,
  number: 1,
  title: TEAM_TITLE,
  url: `https://github.com/${FEEDBACK_REPO}/issues/1`,
  status: 'Todo',
  state: 'open',
  closedAt: null,
  // No reason given, which is the answer that COUNTS as delivery (#1014) —
  // so these rows keep saying what they said before the field existed.
  stateReason: null,
  assignees: ['octocat'],
  prs: [],
  createdAt: iso('01'),
  updatedAt: iso('02'),
  lastActivity: { type: 'opened', atISO: iso('01') },
  parent: null,
  labels: [],
  labelsComplete: true,
  // Placed by their labels here; the footer half is its own block below (#516).
  submission: false,
  type: 'chore',
  ...over,
});

/** One board: an open submission, an open team issue, a closed submission (the
 *  board's most recent close) and an older closed team issue. */
const OPEN_SUBMISSION = item({
  number: 461,
  title: SUBMISSION_TITLE,
  url: `https://github.com/${FEEDBACK_REPO}/issues/461`,
  labels: [{ name: 'feedback', color: '' }, { name: 'bug', color: '' }],
  type: 'bug',
});
const OPEN_TEAM_ISSUE = item({
  number: 101,
  title: TEAM_TITLE,
  url: `https://github.com/${FEEDBACK_REPO}/issues/101`,
  labels: [{ name: 'discovery', color: '' }],
});
const CLOSED_SUBMISSION = item({
  number: 455,
  title: OLDER_SUBMISSION_TITLE,
  url: `https://github.com/${FEEDBACK_REPO}/issues/455`,
  state: 'closed',
  closedAt: iso('30'),
  labels: [{ name: 'feedback', color: '' }],
});
const CLOSED_TEAM_ISSUE = item({
  number: 176,
  title: TEAM_CLOSED_TITLE,
  url: `https://github.com/${FEEDBACK_REPO}/issues/176`,
  state: 'closed',
  closedAt: iso('05'),
  labels: [{ name: 'feature', color: '' }],
});

const ITEMS = [OPEN_SUBMISSION, OPEN_TEAM_ISSUE, CLOSED_SUBMISSION, CLOSED_TEAM_ISSUE];

const closeOf = (i: ProjectItemRaw): ProjectClose => ({
  repo: i.repo,
  number: i.number,
  title: i.title,
  url: i.url,
  by: 'octocat',
  // A person wrote both of these — the #497 walk is about words, not bumps, and
  // a bot author here would move the pick for the wrong reason (#488).
  author: 'octocat',
  atISO: i.closedAt as string,
  labels: i.labelsComplete ? i.labels.map((l) => l.name) : null,
});

function boardSource(): IProjectsSource {
  const open = ITEMS.filter((i) => i.state === 'open').length;
  const closed = ITEMS.filter((i) => i.state === 'closed').length;
  // Newest close first, exactly as a source hands them up.
  const recentCloses = [closeOf(CLOSED_SUBMISSION), closeOf(CLOSED_TEAM_ISSUE)];
  const rollup: ProjectRollup = {
    number: 7,
    name: 'Acme Go-To-Market',
    url: 'https://github.com/orgs/acme/projects/7',
    open,
    closed,
    pct: completionPct(open, closed),
    // Boards of issues alone, like every board we run — nothing left out of
    // the counts, so nothing for the card to say about it (#517).
    excludedItems: 0,
    itemsComplete: true, // read whole, as every board a source hands up is unless it says otherwise (#690)
    status: deriveProjectStatus({ open, closed, lastClosedAtISO: recentCloses[0].atISO }, Date.parse(iso('31'))),
    recentCloses,
    weeklyClosed: [],
    closedThisWeek: 0,
    openedThisWeek: 0,
    contributors: [],
    contributorsByAssignee: [],
  };
  const detail: ProjectDetailRaw = { ...rollup, items: ITEMS };
  return {
    listProjects: async () => [rollup],
    getProject: async (_org: string, n: number) => (n === 7 ? detail : null),
    projectMemberships: async (): Promise<SourceMembership[]> => [
      { number: 7, name: rollup.name, issueUrls: ITEMS.map((i) => i.url) },
    ],
    listProjectCatalog: async (): Promise<SourceCatalogEntry[]> => [
      { id: 'PVT_7', number: 7, title: rollup.name },
    ],
    disownInFlightReads: vi.fn(),
  };
}

const controller = () => ctl(svc(boardSource()));

describe('Projects routes — a static agent token and feedback titles (#497)', () => {
  it('GET /projects/:number — the submissions’ titles are replaced, the team issues keep theirs', async () => {
    const detail = await controller().detail({ user: STATIC_AGENT }, '7');
    expect(detail.items.map((i) => i.title).sort()).toEqual(
      [HIDDEN_FEEDBACK_TITLE, HIDDEN_FEEDBACK_TITLE, TEAM_CLOSED_TITLE, TEAM_TITLE].sort(),
    );
  });

  it('GET /projects/:number — a human session reads every title', async () => {
    const detail = await controller().detail({ user: HUMAN }, '7');
    expect(detail.items.map((i) => i.title).sort()).toEqual(
      [OLDER_SUBMISSION_TITLE, SUBMISSION_TITLE, TEAM_CLOSED_TITLE, TEAM_TITLE].sort(),
    );
  });

  it('GET /projects/:number — a personal access token reads them too', async () => {
    const detail = await controller().detail({ user: PAT }, '7');
    expect(detail.items.map((i) => i.title)).toContain(SUBMISSION_TITLE);
  });

  it('GET /projects/:number — counts, completion and the status chip read the same for both', async () => {
    const c = controller();
    const asAgent = await c.detail({ user: STATIC_AGENT }, '7');
    const asHuman = await c.detail({ user: HUMAN }, '7');
    expect({ open: asAgent.open, closed: asAgent.closed, pct: asAgent.pct, status: asAgent.status }).toEqual({
      open: asHuman.open,
      closed: asHuman.closed,
      pct: asHuman.pct,
      status: asHuman.status,
    });
    // …and every row is still there, in the same order, with everything but the
    // title intact — a hidden title costs the caller a sentence, not a row.
    expect(asAgent.items.map((i) => i.number)).toEqual(asHuman.items.map((i) => i.number));
    expect(asAgent.items.map((i) => ({ ...i, title: '' }))).toEqual(
      asHuman.items.map((i) => ({ ...i, title: '' })),
    );
  });

  it('GET /projects — the recency line skips back to the newest close the caller may read, with its own date', async () => {
    const { projects } = await controller().list({ user: STATIC_AGENT });
    expect(projects[0].lastClosed).toMatchObject({
      number: 176,
      title: TEAM_CLOSED_TITLE,
      atISO: iso('05'),
    });
  });

  it('GET /projects — a human reads the newest close, submission or not', async () => {
    const { projects } = await controller().list({ user: HUMAN });
    expect(projects[0].lastClosed).toMatchObject({ number: 455, title: OLDER_SUBMISSION_TITLE });
  });

  it('GET /projects — the candidates the pick skipped past never reach the payload', async () => {
    const { projects } = await controller().list({ user: STATIC_AGENT });
    expect(projects[0]).not.toHaveProperty('recentCloses');
    expect(JSON.stringify(projects)).not.toContain(OLDER_SUBMISSION_TITLE);
  });

  it('GET /projects/:number — the same, on the detail payload', async () => {
    const detail = await controller().detail({ user: STATIC_AGENT }, '7');
    expect(detail).not.toHaveProperty('recentCloses');
    expect(JSON.stringify(detail)).not.toContain(OLDER_SUBMISSION_TITLE);
    expect(JSON.stringify(detail)).not.toContain(SUBMISSION_TITLE);
  });

  it('GET /projects/catalog — carries board names only, so there is no issue title on it to hide', async () => {
    const c = controller();
    const catalog = await c.catalog();
    const boardNames = new Set((await c.list({ user: HUMAN })).projects.map((p) => p.name));
    expect(catalog.length).toBeGreaterThan(0);
    for (const entry of catalog) expect(boardNames.has(entry.title)).toBe(true);
  });

  it('the caches are never redacted — one static-agent read does not poison the next human’s', async () => {
    const c = controller();
    await c.detail({ user: STATIC_AGENT }, '7');
    await c.list({ user: STATIC_AGENT });
    // Second time round both are served from cache; the human must still get the
    // real titles out of it.
    expect((await c.detail({ user: HUMAN }, '7')).items.map((i) => i.title)).toContain(SUBMISSION_TITLE);
    expect((await c.list({ user: HUMAN })).projects[0].lastClosed?.title).toBe(OLDER_SUBMISSION_TITLE);
  });

  it('a request with no viewer at all is refused the words — a guard regression fails closed', async () => {
    const detail = await controller().detail({}, '7');
    expect(detail.items.map((i) => i.title)).not.toContain(SUBMISSION_TITLE);
  });
});

/**
 * #488, through the routes. The walk that skips somebody else's words skips a
 * bump for its second reason, and everything a bump counts toward — the closed
 * total, the completion percentage, the ring's runs, the board's own status —
 * must be exactly what it was. Hand-built source again: the point is these two
 * boards, and the shipped fixture is asserted separately to carry the same
 * shapes (see fixture-projects.source.spec.ts).
 *
 * Every bump here is closed by a PERSON, because that is the live shape — the
 * bot opens the PR, a teammate merges it. Seeding the bot as the closer instead
 * is what let the first pass at this ship green and change nothing in prod.
 */
const BUMP_TITLE = 'chore(deps): bump @acme/ui from 0.19.1 to 0.26.1';
const NOW_MS = Date.parse(iso('31'));

const closeBy = (over: Partial<ProjectClose>): ProjectClose => ({
  repo: FEEDBACK_REPO,
  number: 1,
  title: TEAM_CLOSED_TITLE,
  url: `https://github.com/${FEEDBACK_REPO}/issues/1`,
  by: 'octocat',
  author: 'octocat',
  atISO: iso('05'),
  labels: [],
  ...over,
});

/** A board of `closes`, counted as the sources count: every close in the total,
 *  every closer in the ring, the status off the newest close whoever it was. */
function boardOf(number: number, name: string, closes: ProjectClose[], open: number): ProjectRollup {
  return {
    number,
    name,
    url: `https://github.com/orgs/acme/projects/${number}`,
    open,
    closed: closes.length,
    pct: completionPct(open, closes.length),
    // Boards of issues alone, like every board we run — nothing left out of
    // the counts, so nothing for the card to say about it (#517).
    excludedItems: 0,
    itemsComplete: true, // read whole, as every board a source hands up is unless it says otherwise (#690)
    status: deriveProjectStatus(
      { open, closed: closes.length, lastClosedAtISO: closes[0]?.atISO ?? null },
      NOW_MS,
    ),
    recentCloses: closes,
    weeklyClosed: [],
    closedThisWeek: 0,
    openedThisWeek: 0,
    contributors: tallyContributors(closes.map((c) => c.by)),
    contributorsByAssignee: [],
  };
}

/**
 * Newest first: a bump dependabot WROTE and Octocat merged, then a person's close
 * a fortnight older. This board isolates the author rule — the bump carries no
 * `dependencies` label, so only who wrote it can skip it.
 *
 * (Was: the same board with `labels: ['dependencies']`, described as "the card
 * the issue quotes". It is not — the real card, `compliance.example.com#149`, was
 * opened AND closed by `octocat`; see `LIVE_BUMP_BOARD`. Carrying both marks at
 * once meant neither rule was tested alone.)
 */
const BUMPED_BOARD = boardOf(
  7,
  'Acme Go-To-Market',
  [
    closeBy({ number: 487, title: BUMP_TITLE, author: 'dependabot[bot]', by: 'octocat', atISO: iso('30'), labels: ['chore'] }),
    closeBy({ number: 176, title: TEAM_CLOSED_TITLE, atISO: iso('16') }),
  ],
  3,
);
/**
 * The live shape, through the routes: `compliance.example.com#149`, opened by a
 * person, closed by a person, and a bump only because it says `dependencies`.
 * Neither the author rule nor the words rule touches this row — the label is the
 * only thing that can skip it, which is what makes this board the one the issue
 * is actually about.
 */
const LIVE_BUMP_TITLE = 'Upgrade @acme/ui from 0.19.1 to 0.26.1';
const LIVE_BUMP_BOARD = boardOf(
  14,
  'Acme Compliance Rails',
  [
    closeBy({
      repo: 'acme/compliance.example.com',
      number: 149,
      title: LIVE_BUMP_TITLE,
      url: 'https://github.com/acme/compliance.example.com/issues/149',
      author: 'octocat',
      by: 'octocat',
      atISO: iso('30'),
      labels: ['dependencies'],
    }),
    closeBy({ number: 176, title: TEAM_CLOSED_TITLE, atISO: iso('16') }),
  ],
  5,
);
/** Nothing a person WROTE has closed here — one bump, merged by a teammate, so
 *  the board is bot-authored without being bot-closed. No `dependencies` label
 *  on it, so this board isolates the author rule at the "names nothing" end. */
const BOT_ONLY_BOARD = boardOf(
  12,
  'Acme Compliance',
  [closeBy({ number: 486, title: BUMP_TITLE, author: 'renovate', by: 'IvanRoslov', atISO: iso('30'), labels: ['chore'] })],
  2,
);
/** Nothing nameable has closed here, and the two closes are skipped by DIFFERENT
 *  rules: one automation wrote, one a person wrote and closed carrying only the
 *  label. The OR, at the end where the card goes quiet. */
const ALL_BUMPS_BOARD = boardOf(
  15,
  'Acme Rails',
  [
    closeBy({ number: 486, title: BUMP_TITLE, author: 'renovate', by: 'IvanRoslov', atISO: iso('30'), labels: ['chore'] }),
    closeBy({ number: 490, title: BUMP_TITLE, author: 'IvanRoslov', by: 'IvanRoslov', atISO: iso('28'), labels: ['dependencies'] }),
  ],
  2,
);
/** A person's issue that automation closed on merge — named, by decision. */
const BOT_MERGED_BOARD = boardOf(
  9,
  'Acme Platform',
  [closeBy({ number: 301, title: TEAM_CLOSED_TITLE, author: 'IvanRoslov', by: 'github-actions[bot]', atISO: iso('30') })],
  4,
);

function botSource(boards: ProjectRollup[]): IProjectsSource {
  return {
    listProjects: async () => boards,
    getProject: async (_org, n) => {
      const b = boards.find((x) => x.number === n);
      return b ? { ...b, items: [] } : null;
    },
    projectMemberships: async (): Promise<SourceMembership[]> =>
      boards.map((b) => ({ number: b.number, name: b.name, issueUrls: [] })),
    listProjectCatalog: async (): Promise<SourceCatalogEntry[]> =>
      boards.map((b) => ({ id: `PVT_${b.number}`, number: b.number, title: b.name })),
    disownInFlightReads: vi.fn(),
  };
}

const botController = (
  boards = [BUMPED_BOARD, BOT_ONLY_BOARD, BOT_MERGED_BOARD, LIVE_BUMP_BOARD, ALL_BUMPS_BOARD],
) => ctl(svc(botSource(boards)));

describe('Projects routes — the recency line names a person’s close, not a bump (#488)', () => {
  it('GET /projects — a bump a PERSON closed is skipped for the human-written close behind it, with its own older date', async () => {
    const { projects } = await botController().list({ user: HUMAN });
    expect(projects.find((p) => p.number === 7)!.lastClosed).toMatchObject({
      number: 176,
      title: TEAM_CLOSED_TITLE,
      atISO: iso('16'),
    });
  });

  it('GET /projects — a board where automation wrote everything that closed names nothing, while still counting it', async () => {
    const board = (await botController().list({ user: HUMAN })).projects.find((p) => p.number === 12)!;
    expect(board.lastClosed).toBeNull();
    // The count is what tells the card apart from a board that has closed
    // nothing at all — so this null must never be read as "never closed".
    expect(board.closed).toBe(1);
    expect(board.pct).toBe(completionPct(2, 1));
  });

  it('GET /projects — the bump’s title never reaches the payload', async () => {
    const { projects } = await botController().list({ user: HUMAN });
    expect(JSON.stringify(projects)).not.toContain(BUMP_TITLE);
  });

  /**
   * The decision recorded, not an accident: a bot CLOSER does not disqualify a
   * close. A merge queue or `github-actions` closing an issue on merge is still
   * a person's work landing, and skipping it would blank the card on any repo
   * that automates closing. The closer is served as recorded — the card says
   * "Closed by …" about whoever pressed the button.
   */
  it('GET /projects — a person’s issue that automation closed is still named, closer and all', async () => {
    const { projects } = await botController().list({ user: HUMAN });
    expect(projects.find((p) => p.number === 9)!.lastClosed).toMatchObject({
      number: 301,
      title: TEAM_CLOSED_TITLE,
      by: 'github-actions[bot]',
    });
  });

  it('GET /projects — the candidate’s author never reaches the payload', async () => {
    const { projects } = await botController().list({ user: HUMAN });
    for (const p of projects) expect(p.lastClosed ?? {}).not.toHaveProperty('author');
  });

  /**
   * The chip answers "did anything close here recently", which a bump genuinely
   * did, and it sits beside the counts that include it (on the board's own
   * header — the rollup card carries no chip). Skipping bumps there would put
   * "Stalled" next to a total that grew last night.
   */
  it('GET /projects/:number — the status chip still reads off the newest close, whoever wrote it', async () => {
    const detail = await botController().detail({ user: HUMAN }, '7');
    expect(detail.status).toBe('active'); // the bump, one day before NOW
    expect(detail.lastClosed?.atISO).toBe(iso('16')); // …the line, a fortnight older
  });

  it('GET /projects — the ring keeps counting bot work: its runs still sum to `closed`', async () => {
    const { projects } = await botController().list({ user: HUMAN });
    for (const p of projects) {
      expect(p.contributors.reduce((n, c) => n + c.closed, 0)).toBe(p.closed);
    }
    // …and the ring still files by CLOSER, untouched by the author-keyed skip:
    // the bump Octocat merged is in Octocat's run, not stripped out of the dial.
    const bumped = projects.find((p) => p.number === 7)!;
    expect(bumped.contributors).toEqual([{ login: 'octocat', closed: 2, kind: 'person' }]);
    // …and a bot CLOSER is still `unattributed` there, as it has always been.
    const botMerged = projects.find((p) => p.number === 9)!;
    expect(botMerged.contributors).toEqual([{ login: '', closed: 1, kind: 'unattributed' }]);
  });

  it('GET /projects — a static agent token walks past the bump too, and gets the same close', async () => {
    const { projects } = await botController().list({ user: STATIC_AGENT });
    expect(projects.find((p) => p.number === 7)!.lastClosed).toMatchObject({ number: 176 });
  });
});

/**
 * #488, the rule that fires on a live board — the `dependencies` label, through
 * the routes.
 *
 * The author rule above is correct and stays, but it moves nothing in this org:
 * dependabot files pull requests here, not issues, and the live source's
 * `isIssue` filter drops those before they can be candidates. The card the issue
 * was filed about — `compliance.example.com#149` — was opened by `octocat` and
 * closed by `octocat`. Its label is the only thing that says "bump", so the
 * label is what has to do the work.
 */
describe('Projects routes — a `dependencies` close is skipped by its label (#488)', () => {
  it('GET /projects — the live card is skipped for the close behind it, with that close’s own date', async () => {
    const { projects } = await botController().list({ user: HUMAN });
    expect(projects.find((p) => p.number === 14)!.lastClosed).toMatchObject({
      number: 176,
      title: TEAM_CLOSED_TITLE,
      atISO: iso('16'),
    });
  });

  it('GET /projects — the bump’s title never reaches the payload', async () => {
    const { projects } = await botController().list({ user: HUMAN });
    expect(JSON.stringify(projects)).not.toContain(LIVE_BUMP_TITLE);
  });

  it('GET /projects — a static agent token gets the same close: this is presentation, not a words rule', async () => {
    const { projects } = await botController().list({ user: STATIC_AGENT });
    expect(projects.find((p) => p.number === 14)!.lastClosed).toMatchObject({ number: 176 });
  });

  it('GET /projects — a personal access token gets it too', async () => {
    const { projects } = await botController().list({ user: PAT });
    expect(projects.find((p) => p.number === 14)!.lastClosed).toMatchObject({ number: 176 });
  });

  /** The board where the two rules meet: one close skipped for its author, the
   *  other for its label, and nothing left to name — while the count says two
   *  things closed, so the card must not claim otherwise. */
  it('GET /projects — a board of nothing but bumps names nothing, and still counts them', async () => {
    const board = (await botController().list({ user: HUMAN })).projects.find((p) => p.number === 15)!;
    expect(board.lastClosed).toBeNull();
    expect(board.closed).toBe(2);
    expect(board.pct).toBe(completionPct(2, 2));
  });

  it('GET /projects — counts, percentage and ring are untouched by the skip on every board', async () => {
    const { projects } = await botController().list({ user: HUMAN });
    for (const p of projects) {
      // The ring's runs still sum to `closed` — a skipped bump is still a close.
      expect(p.contributors.reduce((n, c) => n + c.closed, 0)).toBe(p.closed);
      expect(p.pct).toBe(completionPct(p.open, p.closed));
    }
    // …and specifically on the live-shape board: both closes are Octocat's, and
    // the bump is still in his run rather than stripped out of the dial.
    const live = projects.find((p) => p.number === 14)!;
    expect(live.closed).toBe(2);
    expect(live.contributors).toEqual([{ login: 'octocat', closed: 2, kind: 'person' }]);
  });

  /** The chip answers "did anything close here recently", which a bump genuinely
   *  did, and it sits beside counts that include it. */
  it('GET /projects/:number — the status chip still reads off the newest close, bump or not', async () => {
    const detail = await botController().detail({ user: HUMAN }, '14');
    expect(detail.status).toBe('active'); // the bump, one day before NOW
    expect(detail.lastClosed?.atISO).toBe(iso('16')); // …the line, a fortnight older
  });
});

/**
 * #516 — the same two Projects routes after triage changed a submission's
 * labels, driven through the controller so the wiring is asserted, not assumed.
 *
 * The two halves get their marker from different places on purpose: a board ROW
 * carries it (the detail query reads the issue's body), a CLOSE asks the shared
 * index (the rollup query reads no body).
 */
const RELABELLED_TITLE = '[Bug] the digest email arrives empty every second week';

const RELABELLED_OPEN = item({
  number: 462,
  title: RELABELLED_TITLE,
  url: `https://github.com/${FEEDBACK_REPO}/issues/462`,
  labels: [{ name: 'bug', color: '' }, { name: 'in progress', color: '' }],
  submission: true,
  type: 'bug',
});
const RELABELLED_CLOSED = item({
  number: 463,
  title: RELABELLED_TITLE,
  url: `https://github.com/${FEEDBACK_REPO}/issues/463`,
  state: 'closed',
  closedAt: iso('31'),
  labels: [{ name: 'bug', color: '' }],
  submission: true,
});

function relabelledSource(): IProjectsSource {
  const items = [RELABELLED_OPEN, RELABELLED_CLOSED, OPEN_TEAM_ISSUE, CLOSED_TEAM_ISSUE];
  const open = items.filter((i) => i.state === 'open').length;
  const closed = items.filter((i) => i.state === 'closed').length;
  const recentCloses = [closeOf(RELABELLED_CLOSED), closeOf(CLOSED_TEAM_ISSUE)];
  const rollup: ProjectRollup = {
    number: 7,
    name: 'Acme Go-To-Market',
    url: 'https://github.com/orgs/acme/projects/7',
    open,
    closed,
    pct: completionPct(open, closed),
    // Boards of issues alone, like every board we run — nothing left out of
    // the counts, so nothing for the card to say about it (#517).
    excludedItems: 0,
    itemsComplete: true, // read whole, as every board a source hands up is unless it says otherwise (#690)
    status: deriveProjectStatus({ open, closed, lastClosedAtISO: recentCloses[0].atISO }, Date.parse(iso('31'))),
    recentCloses,
    weeklyClosed: [],
    closedThisWeek: 0,
    openedThisWeek: 0,
    contributors: [],
    contributorsByAssignee: [],
  };
  const detail: ProjectDetailRaw = { ...rollup, items };
  return {
    listProjects: async () => [rollup],
    getProject: async (_org: string, n: number) => (n === 7 ? detail : null),
    projectMemberships: async (): Promise<SourceMembership[]> => [],
    listProjectCatalog: async (): Promise<SourceCatalogEntry[]> => [],
    disownInFlightReads: vi.fn(),
  };
}

/** An index that knows these rows and answers `null` — no row — for the rest. */
const indexOf = (rows: Record<number, boolean>): SubmissionIndex => ({
  lookup: (_owner: string, _repo: string, number: number) => (number in rows ? rows[number] : null),
});

describe('Projects routes — a relabelled submission (#516)', () => {
  const KNOWN = indexOf({ 462: true, 463: true, 101: false, 176: false });

  it('GET /projects/:number — the relabelled row reads hidden, though its labels say `bug`', async () => {
    const detail = await ctl(svc(relabelledSource(), KNOWN)).detail({ user: STATIC_AGENT }, '7');
    expect(detail.items.map((i) => i.title)).not.toContain(RELABELLED_TITLE);
    expect(detail.items.filter((i) => i.title === HIDDEN_FEEDBACK_TITLE)).toHaveLength(2);
    expect(detail.items.map((i) => i.title)).toContain(TEAM_TITLE);
  });

  it('GET /projects/:number — a human session and a personal access token read it whole', async () => {
    for (const user of [HUMAN, PAT]) {
      const detail = await ctl(svc(relabelledSource(), KNOWN)).detail({ user }, '7');
      expect(detail.items.map((i) => i.title)).toContain(RELABELLED_TITLE);
    }
  });

  it('GET /projects/:number — no row carries the marker onward; it decides, it does not serve', async () => {
    const detail = await ctl(svc(relabelledSource(), KNOWN)).detail({ user: HUMAN }, '7');
    for (const row of detail.items) expect(row).not.toHaveProperty('submission');
  });

  it('GET /projects — the recency line skips a relabelled close the index marks', async () => {
    const { projects } = await ctl(svc(relabelledSource(), KNOWN)).list({ user: STATIC_AGENT });
    expect(projects[0].lastClosed).toMatchObject({ number: 176, title: TEAM_CLOSED_TITLE });
  });

  /** With no index at all the pick has nothing to go on, so it names nothing
   *  rather than an end user's sentence. Fail-closed, and bounded to this repo. */
  it('GET /projects — an unavailable index withholds the feedback-repo close rather than naming it', async () => {
    const { projects } = await ctl(svc(relabelledSource(), null)).list({ user: STATIC_AGENT });
    expect(projects[0].lastClosed).toBeNull();
  });

  it('GET /projects — a human still gets the newest close whatever the index says', async () => {
    const { projects } = await ctl(svc(relabelledSource(), null)).list({ user: HUMAN });
    expect(projects[0].lastClosed).toMatchObject({ number: 463 });
  });

  /** The board ROW needs no index — the detail query read its body — so the drill-in
   *  is correct even while the shared index is unavailable. */
  it('GET /projects/:number — the row is placed correctly with no index at all', async () => {
    const detail = await ctl(svc(relabelledSource(), null)).detail({ user: STATIC_AGENT }, '7');
    expect(detail.items.map((i) => i.title)).not.toContain(RELABELLED_TITLE);
    expect(detail.items.map((i) => i.title)).toContain(TEAM_TITLE);
  });
});

/** The three read routes behind the org gate (#648), each with the spy that
 *  proves whether the refusal came before the read or after it — and, since
 *  #697, WHAT the gate handed the service. `args(org)` is the call each route
 *  owes for a given resolved org, so a route that admitted a caller and then
 *  dropped their `?org=` fails here rather than answering the wrong org's boards
 *  under the right org's name. */
function gated(org?: string, env: Record<string, string> = {}) {
  const detail = { number: 7 } as unknown as ProjectDetail;
  const summaries = [] as ProjectSummary[];
  const catalogEntries = [] as ProjectCatalogEntry[];
  const listProjects = vi.fn(async () => summaries);
  const listProjectCatalog = vi.fn(async () => catalogEntries);
  const getProject = vi.fn(async () => detail);
  // `org` names the owner scope, and `env` carries whatever else a case needs.
  // An `org` of undefined leaves the scope to `env`, which is how the two-org
  // cases below set it.
  const config = new ConfigService(org === undefined ? { ...env } : { ...env, GITHUB_ORGS: org });
  const c = new ProjectsController(
    { listProjects, listProjectCatalog, getProject } as unknown as ProjectsService,
    config,
  );
  const req = { user: HUMAN };
  return {
    routes: [
      {
        name: 'GET /projects',
        call: (q?: string) => c.list(req, q),
        spy: listProjects as unknown as ReturnType<typeof vi.fn>,
        answer: (v: unknown) => expect((v as { projects: ProjectSummary[] }).projects).toBe(summaries),
        /** What the service is handed: the caller, and the org the gate
         *  resolved — `undefined` when none was asked, meaning the whole scope. */
        args: (org?: string) => [HUMAN, org],
      },
      {
        name: 'GET /projects/catalog',
        call: (q?: string) => c.catalog(q),
        spy: listProjectCatalog as unknown as ReturnType<typeof vi.fn>,
        answer: (v: unknown) => expect(v).toBe(catalogEntries),
        args: (org?: string) => [org],
      },
      {
        name: 'GET /projects/:number',
        call: (q?: string) => c.detail(req, '7', q),
        spy: getProject as unknown as ReturnType<typeof vi.fn>,
        answer: (v: unknown) => expect(v).toBe(detail),
        args: (org?: string) => [7, HUMAN, org],
      },
    ],
  };
}

describe('ProjectsController org param (#648)', () => {
  it('an org param outside the configured set is refused by the API, not degraded', async () => {
    for (const route of gated('acme').routes) {
      await expect(route.call('other-org'), route.name).rejects.toBeInstanceOf(NotFoundException);
      // The refusal PRECEDES the read — a 404 raised after the Github read had
      // already run would have read a stranger's boards first.
      expect(route.spy, route.name).not.toHaveBeenCalled();
    }
  });

  it('refuses a stranger against the list alone, with no surface pin anywhere', async () => {
    // "Nothing configured" used to mean an empty config: `GITHUB_ORGS` had a
    // default, so the gate still had a scope to refuse against. It has none
    // since #1175, and a board that names no org does not boot. The per-surface
    // pin this case was written around is retired (#1209 part 4), so the list is
    // now the only scope there is.
    for (const route of gated(undefined, { GITHUB_ORGS: 'acme' }).routes) {
      await expect(route.call('other-org'), route.name).rejects.toBeInstanceOf(NotFoundException);
      expect(route.spy, route.name).not.toHaveBeenCalled();
    }
  });

  it('no org param serves the whole configured scope', async () => {
    for (const route of gated('acme').routes) {
      route.answer(await route.call(undefined));
      expect(route.spy, route.name).toHaveBeenCalledTimes(1);
      // `undefined` reaches the service, and that is what "every org" means
      // there — not a first org picked here (#697).
      expect(route.spy.mock.calls[0], route.name).toEqual(route.args(undefined));
    }
  });

  it('a case variant of the configured org is served, in the CONFIGURED spelling', async () => {
    for (const route of gated('acme').routes) {
      route.answer(await route.call('Acme'));
      // Not `Acme`: the service keys its caches and stamps every board's
      // `org` on what it is handed, so the caller's spelling must not travel
      // (#697).
      expect(route.spy.mock.calls[0], route.name).toEqual(route.args('acme'));
    }
  });

  it('a repeated org param is refused, not answered and not crashed', async () => {
    // Express hands `?org=a&org=b` to the handler as an array, so a gate that
    // assumed a string would throw TypeError and answer 500 — and a request
    // naming two orgs at once must be refused, never quietly served as one.
    for (const route of gated('acme').routes) {
      const two = ['acme', 'other-org'] as unknown as string;
      await expect(route.call(two), route.name).rejects.toBeInstanceOf(NotFoundException);
      expect(route.spy, route.name).not.toHaveBeenCalled();
    }
  });

  it('a blank org param is treated as absent', async () => {
    for (const route of gated('acme').routes) {
      route.answer(await route.call('   '));
      expect(route.spy.mock.calls[0], route.name).toEqual(route.args(undefined));
    }
  });
});

/**
 * The gate now MATCHES the owner allow-list, and that is the #697 change.
 *
 * It was deliberately narrower until this lane: `GITHUB_ORGS` named two orgs and
 * the gate admitted only the first, because the three routes called it and then
 * dropped `org` on the floor — so admitting the second org would have answered
 * 200 with the first org's boards under the second one's name. Refusing was the
 * only honest answer a gate could give while that held.
 *
 * It no longer holds. The routes pass the resolved org to the service, and the
 * `args` assertions below are what shows it: each org admitted reaches the
 * service AS ITSELF, so a 200 under a second org's name is that org's boards.
 * `githubOrgs` is the resolver on both sides, which is also what makes this gate
 * agree with `issue-detail.controller.ts`'s `servesOwner`.
 *
 * The pairing is still what makes these honest: an "admits the second org" case
 * alone would pass against a gate that admitted anything, so a stranger org runs
 * beside it on the same config.
 */
describe('ProjectsController org gate matches the owner allow-list (#697)', () => {
  const TWO_ORGS = { GITHUB_ORGS: 'acme,globex' };

  it('admits the SECOND configured org, and narrows the read to it', async () => {
    for (const route of gated(undefined, TWO_ORGS).routes) {
      route.answer(await route.call('globex'));
      expect(route.spy, route.name).toHaveBeenCalledTimes(1);
      expect(route.spy.mock.calls[0], route.name).toEqual(route.args('globex'));
    }
  });

  it('admits the FIRST configured org on that same config, as itself', async () => {
    for (const route of gated(undefined, TWO_ORGS).routes) {
      route.answer(await route.call('acme'));
      expect(route.spy, route.name).toHaveBeenCalledTimes(1);
      expect(route.spy.mock.calls[0], route.name).toEqual(route.args('acme'));
    }
  });

  it('still refuses an org NEITHER entry names, before anything reads', async () => {
    for (const route of gated(undefined, TWO_ORGS).routes) {
      await expect(route.call('stranger-org'), route.name).rejects.toBeInstanceOf(NotFoundException);
      // Before the read, so the refusal cannot be a Github round trip that
      // already fetched somebody's boards.
      expect(route.spy, route.name).not.toHaveBeenCalled();
    }
  });

  it('an owner scope with no org in it refuses every org, rather than admitting all', async () => {
    // A scope that resolved to nothing. `find` on that list is `undefined`, so
    // the gate refuses; a gate that read "no list" as "no constraint" would be
    // the widening direction on exactly the configuration that constrains
    // hardest. `PROJECTS_OWNER=''` used to produce it and is retired (#1209 part
    // 4); what produces it now is a person whose Github App grants cover no
    // owner, and a `ConfigService` a spec built without a usable `GITHUB_ORGS`.
    for (const route of gated('   ').routes) {
      await expect(route.call('acme'), route.name).rejects.toThrow(/GITHUB_ORGS/);
      expect(route.spy, route.name).not.toHaveBeenCalled();
    }
  });
});
