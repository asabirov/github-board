import {
  ActionsUsageDay,
  ActionsUsageRead,
  DriRead,
  DriSchema,
  IReposSource,
  RepoCi,
  RepoCiRead,
  RepoDescriptor,
  RepoOpenPr,
  RepoPrRead,
  RepoPrRecord,
  RepoReadme,
  RepoSecurity,
  ReposRead,
  SecurityRead,
  UsageMonth,
} from './repo.types';

const DAY_MS = 86_400_000;

/** One seeded PR author: a login, a ghost account (`null`), or a machine.
 *  Declared rather than spelled `dependabot[bot]` and matched on, because the
 *  live read takes the type off `author { __typename }` and a fixture that
 *  encoded it in the name would be exercising a rule the source does not have. */
type PrSeedAuthor = string | null | { login: string; bot: true };

/** The bot every repo in this org actually has (#828). On the live
 *  acme/board all 8 open pull requests are its, which is what
 *  put it second on that repo's own members tab before the exclusion existed. */
const DEPENDABOT = { login: 'dependabot', bot: true } as const;

/** The zero record — most seed repos carry this. A fresh object per call, so
 *  no two rows (or callers) can share and mutate the same instance. */
const clean = (): RepoSecurity => ({
  depHigh: 0,
  depModerate: 0,
  codeScanning: 0,
  secrets: 0,
  secretsUrl: null,
  state: 'read',
});

/**
 * Deterministic in-memory Repos source for local dev + tests (no GitHub creds).
 * Two of these keys ('acme', 'board') join to the issue fixture, so the map
 * shows real trends locally; the rest have empty queues on purpose — an empty
 * repo still belongs on the map (#472), and the names carry the org's
 * `{domain}-{subdomain}` convention so the tree has something to group.
 *
 * `pushedDaysAgo` is a distance, not a date, and is turned into an ISO moment
 * at call time — the same trick the issue fixture uses, so the seed never ages
 * into "everything here is dead" (#572). The spread is deliberate: most repos
 * were pushed this week, one has been untouched for months, and the ages differ
 * from each other, so both ends of the signal are exercised locally.
 */
const SEED: {
  name: string;
  key: string;
  description: string | null;
  dri: string | null;
  sec: RepoSecurity;
  language: string | null;
  ci: RepoCi;
  /** The address of the run `ci` is the conclusion of (#605), or null for a
   *  repo whose read handed back none. Both cases are seeded on purpose: a word
   *  that reaches its run and a word that stays inert are two different screens,
   *  and only one of them can be built from a seed where every row has an
   *  address. */
  ciUrl: string | null;
  /** Days since the last push. Every seed repo has one: the never-pushed case
   *  is a live-Github shape (an empty repo), covered where the mapping is. */
  pushedDaysAgo: number;
  /** Days since the repo was created, when it is young enough to matter (#962):
   *  a repo younger than twenty weeks has no previous period, and its Overview
   *  has to say so rather than compare with weeks it did not exist in. Absent is
   *  the rest of the seed, which is two years old. */
  createdDaysAgo?: number;
  /** The branch the live source scopes its CI read to (#572). Not uniform here
   *  on purpose — the org's default is usually `main` and one repo below says
   *  otherwise, which is why the read takes each repo's own value. */
  defaultBranch: string;
  /** Which README state this repo draws locally (#575). All three appear in the
   *  seed on purpose: a page that renders "no README" and a page that says the
   *  read failed are different screens, and neither can be built against a seed
   *  where every repo has one. */
  readme: RepoReadme['state'];
  /** Pull requests opened per week. 0 is a repo nobody sends PRs to — the
   *  emptiest state the PR section has to draw. */
  prsPerWeek: number;
  /** The logins the generated PRs are opened by, cycled in order (#828). They
   *  are what the members tab counts `openedPrs` from, so they differ per repo:
   *  a seed where one login opened everything draws the same list on every
   *  page. A `null` entry is a ghost account — Github answers a deleted user's
   *  PR with no author at all, and the row has to draw without one. `DEPENDABOT`
   *  is a machine: its PRs are on the tab and count for nobody. */
  prAuthors: PrSeedAuthor[];
  /** Whether the PR read ANSWERS for this repo (#828). Unreadable on one seed
   *  row on purpose: the PRs tab and the members tab both draw a different
   *  screen when Github would not answer — an empty list and a list that could
   *  not be read are not the same claim — and neither screen can be built
   *  locally against a seed where every read succeeds. The README states above
   *  are seeded across all three for the same reason. */
  prsUnreadable?: true;
  /** Actions minutes per day, and what a minute costs this repo. A cost of 0
   *  over non-zero minutes is the allowance-absorbed case (#582) — the one net
   *  cost alone cannot express. */
  ciMinutesPerDay: number;
  ciUsdPerMinute: number;
}[] = [
  { name: 'acme', key: 'acme', description: 'The product', dri: 'hubot', sec: { state: 'read', depHigh: 6, depModerate: 3, codeScanning: 4, secrets: 0, secretsUrl: null }, language: 'TypeScript', ci: 'success', ciUrl: 'https://github.com/acme/acme/actions/runs/9001', pushedDaysAgo: 0.2, defaultBranch: 'main' , readme: 'present', prsPerWeek: 4, prAuthors: ['hubot', 'monalisa', 'octocat', DEPENDABOT], ciMinutesPerDay: 210, ciUsdPerMinute: 0.008 },
  { name: 'board', key: 'board', description: 'This board', dri: 'octocat', sec: { state: 'read', depHigh: 0, depModerate: 1, codeScanning: 2, secrets: 0, secretsUrl: null }, language: 'TypeScript', ci: 'success', ciUrl: 'https://github.com/acme/board/actions/runs/9002', pushedDaysAgo: 1, defaultBranch: 'main' , readme: 'present', prsPerWeek: 6, prAuthors: ['octocat', 'monalisa', 'hubot', null, DEPENDABOT], ciMinutesPerDay: 190, ciUsdPerMinute: 0.006 },
  { name: 'acme-platform-billing', key: 'acme-platform-billing', description: 'Metering and invoices', dri: 'hubot', sec: { state: 'read', depHigh: 0, depModerate: 0, codeScanning: 0, secrets: 1, secretsUrl: 'https://github.com/acme/acme-platform-billing/security/secret-scanning/3' }, language: 'TypeScript', ci: 'success', ciUrl: 'https://github.com/acme/acme-platform-billing/actions/runs/9003', pushedDaysAgo: 4, defaultBranch: 'main' , readme: 'present', prsPerWeek: 2, prAuthors: ['hubot', 'monalisa'], ciMinutesPerDay: 40, ciUsdPerMinute: 0.006 },
  // The one repo whose main is red — the map's worked example of a CI failure.
  { name: 'acme-platform-deploy', key: 'acme-platform-deploy', description: null, dri: 'monalisa', sec: clean(), language: 'Go', ci: 'failure', ciUrl: 'https://github.com/acme/acme-platform-deploy/actions/runs/9004', pushedDaysAgo: 11, defaultBranch: 'main' , readme: 'absent', prsPerWeek: 1, prAuthors: ['monalisa'], ciMinutesPerDay: 12, ciUsdPerMinute: 0.006 },
  { name: 'acme-mail-extension-app', key: 'acme-mail-extension-app', description: null, dri: null, sec: clean(), language: 'TypeScript', ci: 'success', ciUrl: 'https://github.com/acme/acme-mail-extension-app/actions/runs/9005', pushedDaysAgo: 38, defaultBranch: 'master' , readme: 'present', prsPerWeek: 0, prAuthors: [], ciMinutesPerDay: 0, ciUsdPerMinute: 0 },
  // Shipped nothing since the spring — the quiet end of the range, and the
  // reason the map cannot read liveness off an issue queue alone.
  { name: 'roadmap', key: 'roadmap', description: 'Cycle plans', dri: 'octocat', sec: clean(), language: null, ci: 'success', ciUrl: 'https://github.com/acme/roadmap/actions/runs/9006', pushedDaysAgo: 132, defaultBranch: 'main' , readme: 'present', prsPerWeek: 1, prAuthors: ['hubot'], ciMinutesPerDay: 35, ciUsdPerMinute: 0 },
  // No dri recorded at all — the map has to say "no owner", not guess one. No
  // Actions run has ever completed here either.
  // A red word with NO address behind it (#605): the read brought back a
  // conclusion and no `html_url`. The word has to draw exactly as it drew
  // before addresses existed — same ink, same hint, nothing to click — and a
  // seed where every drawn word is reachable could not show that.
  { name: 'acme-realtime-gateway', key: 'acme-realtime-gateway', description: 'Sockets and presence', dri: 'hubot', sec: clean(), language: 'Go', ci: 'timed_out', ciUrl: null, pushedDaysAgo: 3, createdDaysAgo: 100, defaultBranch: 'main' , readme: 'present', prsPerWeek: 1, prAuthors: ['monalisa'], ciMinutesPerDay: 25, ciUsdPerMinute: 0.006 },
  { name: 'status', key: 'status', description: null, dri: null, sec: clean(), language: null, ci: null, ciUrl: null, pushedDaysAgo: 6, defaultBranch: 'main' , readme: 'unreadable', prsPerWeek: 0, prAuthors: [], prsUnreadable: true, ciMinutesPerDay: 0, ciUsdPerMinute: 0 },
];

const FENCE = '```';

/** The seed's README text. It carries code blocks (#963) so the repo page's
 *  code block can be looked at locally: a labelled fence the kit highlights,
 *  one it has no grammar for, an unlabelled one, a line far wider than the
 *  page, and inline code in a sentence. */
function fixtureReadme(name: string, description: string | null): string {
  return [
    `# ${name}`,
    '',
    description ?? 'A repo in the seed.',
    '',
    '## Local',
    '',
    'This README comes from the fixture source, not from Github. Run `pnpm start:dev` in `board-service` and it draws on every page.',
    '',
    `${FENCE}bash`,
    'cp board-service/.env.example board-service/.env',
    'cd board-service && pnpm install && pnpm start:dev   # fixtures, no token',
    FENCE,
    '',
    `${FENCE}ts`,
    "import { fetchRepoPage } from './api';",
    '',
    "// One line far wider than the page, so a wide block has something to scroll rather than something to push sideways with.",
    "const view = await fetchRepoPage({ owner: 'acme', name: 'board', section: 'overview', window: 'ten weeks', include: ['issues', 'prs', 'ci', 'readme'], since: '2026-07-01', until: '2026-09-10' });",
    FENCE,
    '',
    `${FENCE}yaml`,
    '# a language the kit has no grammar for',
    'PORT: 3000',
    'ISSUES_SOURCE: fixture',
    FENCE,
    '',
    FENCE,
    'board-frontend/   the SPA',
    'board-service/    the NestJS service',
    FENCE,
    '',
  ].join('\n');
}

export class FixtureReposSource implements IReposSource {
  /** The org every row below already names: each seed repo's `full` and
   *  `htmlUrl` are built from `acme/`, so this states what the file
   *  asserts on every line rather than adding a new fact.
   *
   *  A SET of one, since #718 made the live source's reads span every configured
   *  org. It is one org here whatever a deployment configures — this seed has no
   *  second org's rows to serve, and inventing them would be a local run drawing
   *  a map no live read could produce. That is exactly why the interface asks
   *  the SOURCE which orgs an answer covers instead of asking config: config
   *  would name orgs this source has never heard of. */
  readonly servedOrgs: readonly string[] = ['acme'];

  // Mutated in memory so local dev round-trips a write without a GitHub call —
  // a fresh deep-enough copy per instance, so two instances (e.g. two tests)
  // never share state.
  private readonly seed = SEED.map((s) => ({ ...s }));

  /** The seed is the whole read, so `unreadableOrgs` is empty and cannot be
   *  otherwise — the same reason `driByRepo` gives. The plural SHAPE is still
   *  what the fixture owes: a consumer written against a bare array here would
   *  compile locally and break on the live source. */
  async listRepos(): Promise<ReposRead> {
    const now = Date.now();
    const repos = this.seed.map((s) => ({
      full: `acme/${s.name}`,
      name: s.name,
      key: s.key,
      htmlUrl: `https://github.com/acme/${s.name}`,
      description: s.description,
      language: s.language,
      pushedAt: new Date(now - s.pushedDaysAgo * DAY_MS).toISOString(),
      createdAt: new Date(now - (s.createdDaysAgo ?? 730) * DAY_MS).toISOString(),
      defaultBranch: s.defaultBranch,
    }));
    return { repos, unreadableOrgs: [] };
  }

  /** `unreadableOrgs` is always empty and cannot be otherwise: the seed is the
   *  whole read, so there is no org here that could fail. The failing-org case
   *  is a live shape, covered where that code is. */
  async driByRepo(): Promise<DriRead> {
    return {
      byRepo: new Map(this.seed.map((s) => [`acme/${s.name}`, s.dri])),
      unreadableOrgs: [],
    };
  }

  /** Every row `state: 'read'`, and nothing unreadable: the seed IS the alert
   *  list, so there is no org here whose posture went unread. */
  async securityByRepo(): Promise<SecurityRead> {
    return {
      byRepo: new Map(this.seed.map((s) => [`acme/${s.name}`, s.sec])),
      unreadableOrgs: [],
    };
  }

  async ciByRepo(): Promise<Map<string, RepoCiRead>> {
    return new Map(this.seed.map((s) => [`acme/${s.name}`, { conclusion: s.ci, url: s.ciUrl }]));
  }

  /** The seed's own schema. A fixture write always succeeds — there is no org
   *  restricting anything, and no read to fail — so it is plainly writable.
   *
   *  `_org` is taken and ignored. Taken because the interface documents a
   *  per-org read and a zero-parameter method would satisfy that signature
   *  silently — the two agree by reading only if this one is written out.
   *  Ignored because there is one seed, every row of it under `servedOrg`, and
   *  no call to scope: answering a second org differently would invent a
   *  behaviour the seed has no data for. */
  async driSchema(_org: string): Promise<DriSchema> {
    return { allowedValues: ['octocat', 'hubot', 'monalisa'], writability: 'writable' };
  }

  /** Mutate the in-memory seed so local dev round-trips a write with no
   *  GitHub call — the same shape a real edit produces, minus the network.
   *  Resolves with what the seed now records, exactly as the live source
   *  resolves with what GitHub now records. */
  async setDri(full: string, login: string | null): Promise<string | null> {
    const name = full.split('/')[1];
    const row = this.seed.find((s) => s.name === name);
    if (row) row.dri = login;
    return row?.dri ?? null;
  }

  /** The seed's README state (#575). All three states appear across the seed —
   *  a repo with one, a repo with none, and a read that failed — because the
   *  page draws a different screen for each and a seed with only the first
   *  leaves two of them unbuildable locally. */
  async readme(full: string): Promise<RepoReadme> {
    const row = this.rowOf(full);
    if (!row || row.readme === 'unreadable') return { state: 'unreadable' };
    if (row.readme === 'absent') return { state: 'absent' };
    return { state: 'present', markdown: fixtureReadme(row.name, row.description) };
  }

  /** A deterministic PR history, `prsPerWeek` a week over the last ten weeks,
   *  each merged a day after it opened, and each opened by one of the repo's
   *  own `prAuthors` in turn (#828) — the logins the members tab counts. The
   *  last week's are the ones still open, so `openPrs` is that week and `open`
   *  is its size: the tab's list and the trend card's total describe the same
   *  pull requests. `_since` is ignored because the seed is
   *  generated inside the window rather than paged back to it. `coveredFrom: null`: the seed IS the
   *  whole history, so nothing here is unknown — the unknown case is a live
   *  pagination cap, and it is covered where that code is. */
  async pullRequests(full: string, _since: string): Promise<RepoPrRead> {
    const row = this.rowOf(full);
    if (!row || row.prsUnreadable) return { state: 'unreadable' };
    const now = Date.now();
    const prs: RepoPrRecord[] = [];
    const openPrs: RepoOpenPr[] = [];
    let number = 1;
    for (let week = 0; week < 10; week++) {
      for (let i = 0; i < row.prsPerWeek; i++) {
        const openedAt = now - (week * 7 + i) * DAY_MS - 3_600_000;
        const createdAt = new Date(openedAt).toISOString();
        // Cycled rather than random, so two reads of this seed agree — and by
        // the PR's own number, so a repo's authors do not all land on the same
        // week.
        const seeded = row.prAuthors.length ? row.prAuthors[(number - 1) % row.prAuthors.length] : null;
        const author = typeof seeded === 'object' && seeded !== null ? seeded.login : seeded;
        const authorIsBot = typeof seeded === 'object' && seeded !== null;
        const open = week === 0;
        // The last week's PRs are the ones still open, so the seed draws both
        // an opened and a merged series rather than two identical ones.
        const mergedAt = open ? null : new Date(openedAt + DAY_MS).toISOString();
        prs.push({
          number,
          createdAt,
          mergedAt,
          closedAt: mergedAt,
          author,
          authorIsBot,
        });
        if (open) {
          openPrs.push({
            number,
            title: `${row.name}: seeded pull request #${number}`,
            htmlUrl: `https://github.com/acme/${row.name}/pull/${number}`,
            createdAt,
            author,
            authorIsBot,
            // Every third one, so both a draft and a ready PR are on the seed:
            // the tab marks one and not the other, and a seed where none is a
            // draft leaves that mark undrawable locally.
            draft: i % 3 === 2,
          });
        }
        number++;
      }
    }
    return {
      state: 'read',
      open: row.prsPerWeek,
      closedMerged: Math.max(prs.length - row.prsPerWeek, 0),
      prs,
      coveredFrom: null,
      // Already newest first: week 0 is the open week and its `i` counts
      // BACKWARDS in time, so the list is built in the order the live read asks
      // Github for.
      openPrs,
    };
  }

  /**
   * A deterministic daily usage report for the whole seed org, dated relative
   * to now so it never ages out of the page's window — the same trick
   * `pushedDaysAgo` uses. It reaches back 140 days, the window and the one
   * before it (#962), so the CI card's comparison reads a real previous
   * period locally rather than a quiet one.
   *
   * One seed repo runs real minutes at a cost of zero. That is the state net
   * cost alone cannot express (#582), and without it in the seed a local run
   * can only ever draw "cost money" and "ran nothing".
   */
  async actionsUsage(months: UsageMonth[]): Promise<ActionsUsageRead> {
    const now = Date.now();
    const wanted = new Set(months.map((m) => `${m.year}-${m.month}`));
    const out: ActionsUsageDay[] = [];
    for (let day = 0; day < 140; day++) {
      // Offset off the hour so the seed never lands on midnight even when a
      // test pins the clock there — see the note on `date` below.
      const at = new Date(now - day * DAY_MS - 9_000_000);
      if (!wanted.has(`${at.getUTCFullYear()}-${at.getUTCMonth() + 1}`)) continue;
      // The real moment, NOT a midnight day-stamp: live rows carry the time the
      // usage happened (0 of 1420 measured rows are midnight), and a fixture
      // that squares them off to midnight is a fixture that would hide a
      // boundary bug the live payload can produce.
      const date = at.toISOString();
      for (const s of this.seed) {
        if (s.ciMinutesPerDay <= 0) continue;
        const minutes = s.ciMinutesPerDay;
        out.push({
          full: `acme/${s.name}`,
          date,
          minutes,
          netUsd: Math.round(minutes * s.ciUsdPerMinute * 100) / 100,
        });
      }
    }
    return { days: out, orgs: this.servedOrgs };
  }

  private rowOf(full: string) {
    return this.seed.find((s) => `acme/${s.name}`.toLowerCase() === full.toLowerCase());
  }
}
