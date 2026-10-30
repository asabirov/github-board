import { composeIssue, hasSubmissionFooter } from '../auth/submission-footer';
import { isDeliveredClose, type CloseReason } from '../issues-metrics/close-reason';
import { tallyContributors } from './project-contributors';
import { completionPct, deriveIssueType, deriveProjectStatus, isSurfacedProjectName } from './project-derive';
import type {
  ActivityType,
  IProjectsSource,
  ProjectClose,
  ProjectDetailRaw,
  ProjectItemRaw,
  ProjectRollup,
  ProjectStatus,
  SourceCatalogEntry,
  SourceMembership,
} from './project.types';

/**
 * Deterministic in-memory Projects source for local dev + tests (no GitHub
 * creds). Mirrors the GitHub Projects v2 shape: a handful of boards, each with
 * issue rows. Times are relative to `now` so `status`/completion stay realistic.
 */

const now = Date.now();
const ago = (days: number) => new Date(now - days * 86400_000).toISOString();

const PULSE_WEEKS = 10;

/** A submission body exactly as `composeIssue` writes one — built BY it rather
 *  than copied, so this fixture cannot describe a shape the form has stopped
 *  writing (#749 inverted the order and the hand-written copy here went on
 *  claiming the old one). The seeded submissions run through the real matcher
 *  rather than asserting a flag by hand (#516), and that matcher is
 *  position-blind, so the move changes nothing this fixture proves. */
const SUBMISSION_BODY = composeIssue(
  {
    category: 'bug',
    message: [
      'the weekly report never arrives and the button just spins',
      '',
      'I click Send report and the spinner runs forever.',
    ].join('\n'),
    submitterEmail: 'octocat@example.org',
  },
  [],
).body;

/** A plausible 10-week close series for the fixture rollup (#391): buckets the
 *  seed's own closed items by how long ago they closed, so local dev shows a
 *  real trend even though the metrics fixture's issue URLs don't join to these.
 *  ProjectsService keeps this seed when its org-wide join finds no match. */
function seedWeeklyClosed(closedDays: number[]): number[] {
  const series = new Array<number>(PULSE_WEEKS).fill(0);
  for (const d of closedDays) {
    const slot = PULSE_WEEKS - Math.ceil((d || 0.5) / 7);
    if (slot >= 0 && slot < PULSE_WEEKS) series[slot]++;
  }
  return series;
}

interface Seed {
  number: number;
  name: string;
  items: {
    repo: string;
    number: number;
    title: string;
    /** What the board item holds (#517). A board carries pull requests as well
     *  as issues, and every count on this surface covers issues only — so a
     *  seeded pull request is dropped here exactly as the live source drops one,
     *  and shows up only in the board's `excludedItems`. Omit for an issue. */
    kind?: 'issue' | 'pull-request';
    status: string;
    state: 'open' | 'closed';
    assignees: string[];
    prs: number[];
    createdDays: number;
    updatedDays: number;
    closedDays?: number;
    closedBy?: string;
    /** WHY it closed (#1014). Omit for a close the fixture means as delivered
     *  work: an absent reason is the `null` Github sends for an issue closed
     *  before it had reasons, and `null` counts. `not_planned` and `duplicate`
     *  are the two that leave every count on the board. */
    closeReason?: CloseReason;
    /** Github login of whoever OPENED the issue — what the rollup card's recency
     *  pick keys on (#488). Omit for an ordinary team issue: it then falls back
     *  to the first assignee, which is a person on every seeded row, so only the
     *  rows that mean something else have to say so. */
    author?: string;
    /** Most recent event kind (#259); defaults to closed/opened by state. */
    activity?: ActivityType;
    /** Parent issue number for a native sub-issue (#273); omit for top-level. */
    parent?: number;
    /** Label names (#376); omit for none. */
    labels?: string[];
    /** The issue body, when a row needs one. Only the submissions do — the
     *  footer in it is what marks them after triage changes their labels (#516). */
    body?: string;
    /** Enumerable custom-field values (#401), keyed by fieldSlug; omit for none —
     *  seeds the Projects-page viewer's custom-field filters offline. */
    customFields?: Record<string, string[]>;
  }[];
}

/** The board items this surface counts: issues, and nothing else (#517). */
const isIssueItem = (i: Seed['items'][number]) => (i.kind ?? 'issue') === 'issue';

/** A seeded row in the shape the shared close predicate reads (#1014): the
 *  close instant a closed row's `closedDays` stands for, and the reason. An
 *  unstated reason is `null`, which counts as delivery — the same reading the
 *  live sources give an issue Github told them nothing about. */
const closeOf = (i: Seed['items'][number]): { closedAt: string | null; stateReason: CloseReason } => ({
  closedAt: i.state === 'closed' ? ago(i.closedDays ?? 0) : null,
  stateReason: i.closeReason ?? null,
});

const SEEDS: Seed[] = [
  {
    number: 4,
    name: 'Acme',
    items: [
      { repo: 'acme/acme', number: 261, title: 'Rename extensions → components', status: 'Todo', state: 'open', assignees: ['octocat'], prs: [], createdDays: 30, updatedDays: 5, labels: ['chore'] },
      { repo: 'acme/acme', number: 49, title: 'Добавить CHANGELOG.md', status: 'Todo', state: 'open', assignees: ['hubot'], prs: [], createdDays: 60, updatedDays: 8, labels: ['bug', 'blocked'] },
      { repo: 'acme/acme', number: 259, title: 'feat: in-product feedback capture', status: 'Done', state: 'closed', assignees: ['hubot'], prs: [260], createdDays: 30, updatedDays: 1, closedDays: 1, closedBy: 'hubot', labels: ['feedback'] },
      { repo: 'acme/acme', number: 222, title: 'Ship-инфра: jobs + sandboxes', status: 'Done', state: 'closed', assignees: ['octocat'], prs: [231], createdDays: 30, updatedDays: 7, closedDays: 7, closedBy: 'octocat' },
    ],
  },
  {
    number: 7,
    name: 'Acme Go-To-Market',
    items: [
      { repo: 'acme/acme', number: 176, title: '[C3-PRODUCT-2] Waitlist extension', status: 'Done', state: 'closed', assignees: ['octocat'], prs: [177], createdDays: 40, updatedDays: 30, closedDays: 30, closedBy: 'octocat', labels: ['feature'] },
      { repo: 'acme/acme', number: 180, title: 'Landing copy pass', status: 'Todo', state: 'open', assignees: ['octocat'], prs: [], createdDays: 20, updatedDays: 4, activity: 'commented', labels: ['ui'], customFields: { priority: ['High'], sprint: ['Sprint 3'] } },
      { repo: 'acme/acme', number: 182, title: 'Landing hero copy', status: 'In progress', state: 'open', assignees: ['octocat'], prs: [], createdDays: 12, updatedDays: 3, parent: 180, labels: ['ui'], customFields: { priority: ['Medium'], sprint: ['Sprint 3'] } },
      { repo: 'acme/acme', number: 183, title: 'Pricing section copy', status: 'In review', state: 'open', assignees: ['hubot'], prs: [], createdDays: 12, updatedDays: 6, parent: 180, labels: ['docs'] },
      // #415: also carries `acme#101` — the SAME queue issue as "Acme
      // Compliance" below, seeding the queue's "issue on multiple projects"
      // case locally the way the real org's boards do (an issue can sit on
      // more than one C4 objective board).
      { repo: 'acme/acme', number: 101, title: 'Reconcile legacy architecture docs', status: 'Todo', state: 'open', assignees: ['octocat'], prs: [], createdDays: 32, updatedDays: 10, labels: ['discovery'] },
      // #497: two feedback submissions triaged onto a board — the ordinary use
      // of the #404 picker, and the case the whole visibility rule exists for.
      // Their titles are end-user sentences (the old form built a
      // submission's title from the first line of the message), they live in
      // FEEDBACK_REPO, and they carry the form's label. Without them, every
      // Projects spec and every local read runs over data holding no
      // submission at all — passing whatever the code does.
      //
      // The closed one is the board's MOST RECENT close, so local dev and a
      // live read both exercise the recency skip-back rather than only the
      // easy case where the newest close happens to be readable.
      { repo: 'acme/board', number: 461, title: '[Bug] the weekly report never arrives and the button just spins', status: 'Todo', state: 'open', assignees: [], prs: [], createdDays: 6, updatedDays: 2, labels: ['feedback', 'bug'], body: SUBMISSION_BODY },
      { repo: 'acme/board', number: 455, title: '[Idea] let me export the roster as a CSV', status: 'Done', state: 'closed', assignees: ['octocat'], prs: [], createdDays: 9, updatedDays: 2, closedDays: 2, closedBy: 'octocat', labels: ['feedback'], body: SUBMISSION_BODY },
      // #516: a third submission, this one after triage swapped `feedback` for
      // `bug` — which is what the board's own #512 has already started doing.
      // The label rule alone reads this row as an ordinary team issue, so
      // without it every Projects read runs over data where the label half
      // happens to be enough.
      { repo: 'acme/board', number: 462, title: '[Bug] the digest email arrives empty every second week', status: 'In progress', state: 'open', assignees: ['octocat'], prs: [], createdDays: 5, updatedDays: 1, labels: ['bug', 'in progress'], body: SUBMISSION_BODY },
      // #488, THE card the issue was filed about, copied off Github rather than
      // imagined: `compliance.example.com#149`, opened by `octocat`, closed by
      // `octocat`, labelled `dependencies`. A person at both ends — nothing
      // about who was involved marks it as housekeeping, only the label does.
      //
      // This row is why the fixture needs editing at all. Dependabot files no
      // issues in this org (it files pull requests, which the live source's
      // `isIssue` filter drops), so a fixture whose only bumps were bot-authored
      // held the one shape production does not have — and a suite over it went
      // green twice on a fix that could not have moved this card.
      //
      // It is the board's NEWEST close, so a local read and a live curl both
      // walk the skip-back rather than the easy case.
      { repo: 'acme/compliance.example.com', number: 149, title: 'Upgrade @acme/ui from 0.19.1 to 0.26.1', status: 'Done', state: 'closed', assignees: ['octocat'], prs: [], createdDays: 4, updatedDays: 0, closedDays: 0, author: 'octocat', closedBy: 'octocat', labels: ['dependencies'] },
      // #488: the same skip reached the other way — automation WROTE this one,
      // and a person merged it. It fires on nothing live today, but it is what
      // makes a genuine bot-filed issue behave the day one lands, so the fixture
      // carries it too. Note the closer is a person: on a live board dependabot
      // opens the PR and a teammate merges, which is what a closer-keyed skip
      // would sail straight past.
      { repo: 'acme/board', number: 487, title: 'chore(deps): bump @acme/ui from 0.19.1 to 0.26.1', status: 'Done', state: 'closed', assignees: [], prs: [488], createdDays: 1, updatedDays: 1, closedDays: 1, author: 'dependabot[bot]', closedBy: 'octocat', labels: ['dependencies'] },
      // #488, the reverse case: a person wrote it, automation closed it on merge.
      // That IS named — the work behind it was somebody's — so a local read and a
      // live curl both see the decision, not just the skip.
      { repo: 'acme/acme', number: 191, title: 'Waitlist: confirm-email copy pass', status: 'Done', state: 'closed', assignees: ['hubot'], prs: [192], createdDays: 8, updatedDays: 3, closedDays: 3, author: 'hubot', closedBy: 'github-actions[bot]', labels: ['ui'] },
    ],
  },
  {
    number: 12,
    name: 'Acme Compliance',
    // #415: a SECOND surfaced board whose items are drawn from the SAME
    // issue numbers `FixtureIssuesSource` seeds the queue with (`acme`/
    // `board` #100-129) — until this board existed, no fixture project's
    // `issueUrls` ever matched a queue row's `htmlUrl`, so the queue's
    // project-name join (`membershipIndex` in issues-metrics.service.ts)
    // always resolved to `[]` and "Group by Project" had nothing to group in
    // local dev/CI. Two boards + one shared issue (#101, also on "Acme
    // Go-To-Market") exercises both the multi-project and single-project
    // grouping cases against real fixture data, not just hand-fed unit tests.
    items: [
      { repo: 'acme/acme', number: 101, title: 'Reconcile legacy architecture docs', status: 'Todo', state: 'open', assignees: ['octocat'], prs: [], createdDays: 32, updatedDays: 10, labels: ['discovery'] },
      { repo: 'acme/acme', number: 108, title: 'Compliance epic: rails funding', status: 'In progress', state: 'open', assignees: ['octocat'], prs: [], createdDays: 3, updatedDays: 1, labels: ['epic'] },
      { repo: 'acme/board', number: 126, title: 'Command palette: search across all board data', status: 'Todo', state: 'open', assignees: ['octocat'], prs: [], createdDays: 1, updatedDays: 1, labels: ['enhancement'] },
      // #488, the other end: every close on this board is a bump, so the card
      // names nothing at all — and, because `closed` is 2, it must not fall back
      // to "No issues closed yet" either. Without these rows no local read and
      // no curl ever sees that state.
      //
      // The two are skipped for DIFFERENT reasons on purpose, so this board
      // covers the OR rather than one rule twice: #486 because automation wrote
      // it, #490 because of its label alone — a person opened it, a person
      // closed it, and it is only a bump because it says so. The second is the
      // spelling a live board actually has.
      { repo: 'acme/board', number: 486, title: 'chore(deps): bump vite from 7.1.2 to 7.2.0', status: 'Done', state: 'closed', assignees: [], prs: [], createdDays: 2, updatedDays: 2, closedDays: 2, author: 'dependabot[bot]', closedBy: 'dependabot[bot]', labels: ['dependencies'] },
      { repo: 'acme/board', number: 490, title: 'chore(deps): bump vitest from 3.2.1 to 3.2.4', status: 'Done', state: 'closed', assignees: ['hubot'], prs: [], createdDays: 5, updatedDays: 1, closedDays: 1, author: 'hubot', closedBy: 'hubot', labels: ['dependencies'], closeReason: 'completed' },
      // #1014: a close that is NOT delivery — the shape 382 of this org's 3,318
      // closed issues actually have, and which every count on this board used to
      // read as work shipped. Seeded on a board that ALSO has delivered closes,
      // so local dev sees the difference the exclusion makes instead of a board
      // that drops to nothing: `closed` reads 2 rather than 3, `pct` 40 rather
      // than 50, the ring's runs still sum to 2, and the recency line names #490
      // even though THIS is the newest close on the board. Every other closed
      // row here states no reason at all, which is the `null` that counts, so
      // the seed carries all three answers rather than only the two extremes.
      { repo: 'acme/board', number: 494, title: 'Rewrite the roster importer against the v3 API', status: 'Done', state: 'closed', assignees: ['octocat'], prs: [], createdDays: 4, updatedDays: 0, closedDays: 0, author: 'octocat', closedBy: 'octocat', closeReason: 'not_planned', labels: ['enhancement'] },
      // #517: a PULL REQUEST on the board — the one item kind this surface does
      // not count. Dependabot files pull requests in this org and a teammate
      // drags them onto a board, so this is the ordinary shape rather than an
      // invented one. Without it, local dev and CI read data where a board's
      // figures can never disagree with Github's, and the line that explains the
      // difference is never seen.
      { repo: 'acme/board', number: 491, title: 'chore(deps): bump vite from 7.1.2 to 7.2.0', kind: 'pull-request', status: 'In review', state: 'open', assignees: [], prs: [], createdDays: 2, updatedDays: 1, author: 'dependabot[bot]', labels: ['dependencies'] },
    ],
  },
];

function summarize(seed: Seed): ProjectRollup {
  // Issues only, the way the live source counts (#517) — a board's pull requests
  // and drafts are held here but counted nowhere, and `excludedItems` is how
  // many of them there were.
  const issueItems = seed.items.filter(isIssueItem);
  const open = issueItems.filter((i) => i.state === 'open').length;
  // Every DELIVERED closed row (the ring's segments must sum to this), vs. only
  // the ones carrying a close time (which is what the last-closed read and the
  // weekly series can order). A row closed as not-planned or duplicate is out of
  // all of them (#1014) — through the same predicate the live source uses, so
  // the fixture cannot be counting on a rule Github's data is not judged by.
  const closedItems = issueItems.filter((i) => i.state === 'closed' && isDeliveredClose(closeOf(i)));
  const closed = closedItems.length;
  const timedCloses = closedItems
    .filter((i) => i.closedDays != null)
    .sort((a, b) => (a.closedDays ?? 0) - (b.closedDays ?? 0));
  // Newest close first — the candidates the viewer-scoped recency pick walks
  // (#497), not just the newest one.
  const recentCloses: ProjectClose[] = timedCloses.map((i) => ({
    repo: i.repo,
    number: i.number,
    title: i.title,
    url: `https://github.com/${i.repo}/issues/${i.number}`,
    by: i.closedBy ?? null,
    // Who OPENED it (#488) — the fixture's stand-in for the live query's
    // `author{login}`. An unstated author is the row's first assignee, a person
    // on every seeded row, so only rows that mean automation say so.
    author: i.author ?? i.assignees[0] ?? null,
    atISO: ago(i.closedDays ?? 0),
    labels: i.labels ?? [],
  }));
  const status: ProjectStatus = deriveProjectStatus(
    // The abandoned count travels here too, or fixture mode would be the one
    // place a fully-dropped board still chipped "just-started" (#1014).
    { open, closed, lastClosedAtISO: recentCloses[0]?.atISO ?? null, abandoned: closedItems.length - closed },
    now,
  );
  const weeklyClosed = seedWeeklyClosed(timedCloses.map((i) => i.closedDays as number));
  // The open half of the week line's pair (#851), seeded the way the close half
  // is and from the same rows: every seeded item carries a `createdDays`, so
  // this is a count and not an invention. It exists so local dev draws the whole
  // sentence — `readRollup` takes the pair from the join or from the seed and
  // never one of each, and a source seeding only the closes would leave the
  // fallback half-built and the card reading "5 closed, 0 opened".
  const openedThisWeek = issueItems.filter((i) => i.createdDays < 7).length;
  return {
    number: seed.number,
    name: seed.name,
    url: `https://github.com/orgs/acme/projects/${seed.number}`,
    open,
    closed,
    pct: completionPct(open, closed),
    excludedItems: seed.items.length - issueItems.length,
    // A fixture is whole by construction: every seeded item is already in hand,
    // so there is no read to come up short of a `totalCount` (#690).
    itemsComplete: true,
    status,
    recentCloses,
    weeklyClosed,
    closedThisWeek: weeklyClosed[PULSE_WEEKS - 1],
    openedThisWeek,
    // Both ring attributions (#454), from the same seed rows the live source
    // reads from Github: who closed it, and who it was assigned to.
    contributors: tallyContributors(closedItems.map((i) => i.closedBy)),
    contributorsByAssignee: tallyContributors(closedItems.map((i) => i.assignees[0])),
  };
}

/**
 * The org this fixture's boards belong to (#697) — the org its seeded repos and
 * board URLs are written against. It was `DEFAULT_GITHUB_ORGS` too until the
 * organisation was renamed to `acme` (#1166), and since #1175 there is no
 * constant and no default left to agree with: the fixture rows still describe
 * `acme`, and rewriting them to follow a configured org would make a local
 * run draw a map no live read could produce. The consequence is that a fixture
 * deployment naming any other org gets NO boards from here, and one naming no
 * org at all does not boot — which is why `.env.example` and the container
 * command in `CONTRIBUTING.md` both name `acme`.
 *
 * A multi-org fixture deployment sees these boards under `acme` and NO
 * boards under the rest, rather than the same five boards once per org. Board
 * numbers are unique within an org, so serving the seeds for a second org would
 * hand the union two boards numbered 7 that are the same board — a shape the
 * live source can never produce, and the worst thing a fixture can be.
 *
 * Not an error for the other orgs. An org this fixture has nothing for is an org
 * with no boards, which is an honest thing for an org to be; the same reading
 * `fixture-delivery.source.ts` takes.
 */
const FIXTURE_OWNER = 'acme';

export class FixtureProjectsSource implements IProjectsSource {
  async listProjects(org: string): Promise<ProjectRollup[]> {
    if (org !== FIXTURE_OWNER) return [];
    return SEEDS.filter((s) => isSurfacedProjectName(s.name))
      .map(summarize)
      .sort((a, b) => b.open + b.closed - (a.open + a.closed));
  }

  async projectMemberships(org: string): Promise<SourceMembership[]> {
    if (org !== FIXTURE_OWNER) return [];
    return SEEDS.filter((s) => isSurfacedProjectName(s.name)).map((s) => ({
      number: s.number,
      name: s.name,
      // Issue URLs, so a board's pull requests stay out of the join (#517) —
      // the live source filters the same way.
      issueUrls: s.items.filter(isIssueItem).map((i) => `https://github.com/${i.repo}/issues/${i.number}`),
    }));
  }

  async getProject(org: string, number: number): Promise<ProjectDetailRaw | null> {
    if (org !== FIXTURE_OWNER) return null;
    const seed = SEEDS.find((s) => s.number === number);
    // Non-surfaced boards (the "Acme" umbrella, #202) are off the surface
    // everywhere — the rollup, the stacking join, and drill-in by number.
    if (!seed || !isSurfacedProjectName(seed.name)) return null;
    const items: ProjectItemRaw[] = seed.items
      // A board's pull requests are not rows on this table (#517) — same filter
      // the live source's `isIssue` applies to the detail read.
      .filter(isIssueItem)
      .map((i) => ({
        repo: i.repo,
        number: i.number,
        title: i.title,
        url: `https://github.com/${i.repo}/issues/${i.number}`,
        status: i.status,
        state: i.state,
        closedAt: i.state === 'closed' && i.closedDays != null ? ago(i.closedDays) : null,
        // Beside `closedAt` and from the same seed field (#1014), so a fixture
        // row on the drill-in table says the same thing about itself that the
        // board's counts were made on.
        stateReason: i.closeReason ?? null,
        assignees: i.assignees,
        prs: i.prs.map((n) => ({ number: n, url: `https://github.com/${i.repo}/pull/${n}` })),
        createdAt: ago(i.createdDays),
        updatedAt: ago(i.updatedDays),
        lastActivity: {
          type: i.activity ?? (i.state === 'closed' ? 'closed' : 'opened'),
          atISO: ago(i.state === 'closed' && i.closedDays != null ? i.closedDays : i.updatedDays),
        },
        parent: i.parent ?? null,
        labels: (i.labels ?? []).map((name) => ({ name, color: '' })),
        // The fixture IS the source of truth for its own rows, so its label sets
        // are complete by construction (#497).
        labelsComplete: true,
        // Read off the seeded body through the real matcher, the way the live
        // source reads it off `DETAIL_QUERY`'s (#516). The body itself stops
        // here: only this boolean is carried, and `readableItems` drops it
        // before the row is served.
        submission: hasSubmissionFooter(i.body),
        type: deriveIssueType(i.labels ?? []),
        customFields: i.customFields,
      }))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return { ...summarize(seed), items };
  }

  /** Every surfaced board's id/number/title (#404) — the fixture has no real
   *  ProjectV2 node ids, so a stable synthetic one stands in for dev/test.
   *  Rides `listProjects` for the surfaced-board filter rather than
   *  re-deriving it from `SEEDS`. */
  async listProjectCatalog(org: string): Promise<SourceCatalogEntry[]> {
    const boards = await this.listProjects(org);
    return boards.map((b) => ({ id: `PVT_fixture_${b.number}`, number: b.number, title: b.name }));
  }

  /** Nothing is in flight here and nothing can be: every read above answers from
   *  the seeds in this file, synchronously, sharing no promise between callers.
   *  So an empty body is this source's ANSWER to `disownInFlightReads` (#713),
   *  not a member it forgot — and the day this source starts sharing a read, the
   *  place that has to change is right here. */
  disownInFlightReads(): void {}
}
