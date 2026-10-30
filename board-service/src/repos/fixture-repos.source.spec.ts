import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureReposSource } from './fixture-repos.source';

const DAY_MS = 86_400_000;
const daysSince = (iso: string) => (Date.now() - Date.parse(iso)) / DAY_MS;

afterEach(() => {
  vi.useRealTimers();
});

describe('FixtureReposSource — last push (#572)', () => {
  it('dates every repo relative to now, so the seed never ages out from under a local run', async () => {
    // The claim is that the seed carries DISTANCES, not dates. A past literal
    // would be in the past too, so "is in the past" proves nothing — only
    // moving the clock does. Read the same seed at two moments a day apart:
    // each repo's push has to move with it, or the date was hardcoded.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));
    const { repos: before } = await new FixtureReposSource().listRepos();
    vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
    const { repos: after } = await new FixtureReposSource().listRepos();

    // Named before the loop, because a loop over an empty seed asserts nothing
    // and would read as green — the shape this pair of specs is here to stop.
    expect(before.length, 'the seed is empty').toBeGreaterThan(0);
    expect(before).toHaveLength(after.length);
    for (const [i, r] of before.entries()) {
      expect(r.pushedAt, `${r.name} has no last push`).not.toBeNull();
      expect(after[i].pushedAt, `${r.name} has no last push`).not.toBeNull();
      expect(
        Date.parse(after[i].pushedAt as string) - Date.parse(r.pushedAt as string),
        `${r.name} did not move with the clock`,
      ).toBe(DAY_MS);
    }
  });

  it('spans both ends: repos pushed this week AND one left alone for months', async () => {
    const { repos } = await new FixtureReposSource().listRepos();
    const ages = repos.map((r) => daysSince(r.pushedAt as string));
    // A seed where every repo is the same age exercises neither end of the
    // signal the map is about to draw off it.
    expect(ages.some((d) => d < 7)).toBe(true);
    expect(ages.some((d) => d > 90)).toBe(true);
    expect(new Set(ages.map(Math.round)).size).toBeGreaterThan(3);
  });
});

describe('FixtureReposSource — default branch (#572)', () => {
  it('names a branch for every repo, and does not name the same one for all of them', async () => {
    // The live source reads CI on each repo's OWN default branch. A seed where
    // every repo said `main` would let a source that hardcoded one name pass
    // locally, which is the bug the scoping exists to prevent — so one repo
    // here is on `master` on purpose, and this is what makes that choice
    // load-bearing rather than decorative.
    const { repos } = await new FixtureReposSource().listRepos();
    for (const r of repos) {
      expect(r.defaultBranch, `${r.name} names no default branch`).toBeTruthy();
    }
    expect(new Set(repos.map((r) => r.defaultBranch)).size).toBeGreaterThan(1);
  });
});

describe('FixtureReposSource — the repo page reads (#575)', () => {
  const source = () => new FixtureReposSource();
  /** The window the page asks its PR read for. The seed generates inside the
   *  window rather than paging back to it, so the value only has to be a date. */
  const SINCE = '2026-06-01T00:00:00Z';

  it('seeds all three README states, so a local run can draw each one', async () => {
    const states = await Promise.all(
      (await source().listRepos()).repos.map(async (r) => (await source().readme(r.full)).state),
    );
    expect(states).toContain('present');
    expect(states).toContain('absent');
    expect(states).toContain('unreadable');
  });

  it('covers the whole window for a seed repo, so no window reads as unknown locally', async () => {
    const read = await source().pullRequests('acme/board', '2026-06-01T00:00:00Z');
    expect(read.state).toBe('read');
    if (read.state !== 'read') return;
    expect(read.prs.length).toBeGreaterThan(0);
    expect(read.open + read.closedMerged).toBeGreaterThan(0);
  });

  it('seeds an open PR list whose size is the open total, on every repo (#828)', async () => {
    // The PRs tab draws the list and the trend card draws `open`. A seed where
    // they disagreed would let either one be published from the other and pass
    // locally, which is the one thing this pair must not do.
    const { repos } = await source().listRepos();
    expect(repos.length).toBeGreaterThan(0);
    const reads = await Promise.all(repos.map(async (r) => [r.name, await source().pullRequests(r.full, SINCE)] as const));
    for (const [name, read] of reads) {
      if (read.state !== 'read') continue;
      expect(read.openPrs.length, `${name} lists a different number of open PRs than it counts`).toBe(read.open);
      for (const pr of read.openPrs) {
        expect(pr.htmlUrl, `${name} seeds a PR with no address`).toContain('/pull/');
      }
    }
    // Both ends of the list, so neither screen is unbuildable locally: repos
    // people send PRs to, and a repo nobody does.
    const lists = reads.flatMap(([, read]) => (read.state === 'read' ? [read.openPrs.length] : []));
    expect(lists.some((n) => n > 0)).toBe(true);
    expect(lists.some((n) => n === 0)).toBe(true);
  });

  it('seeds PR authors, a draft and a ghost account, which the tabs draw differently (#828)', async () => {
    const read = await source().pullRequests('acme/board', SINCE);
    if (read.state !== 'read') throw new Error('expected a read');
    // The members tab counts `openedPrs` off these, so a seed where one login
    // opened everything draws the same one-person list on every repo page.
    expect(new Set(read.prs.map((p) => p.author)).size).toBeGreaterThan(1);
    expect(read.openPrs.some((p) => p.draft)).toBe(true);
    expect(read.openPrs.some((p) => !p.draft)).toBe(true);
    // A deleted account has no author at all on the live read, and the row still
    // has to draw.
    expect(read.openPrs.some((p) => p.author === null)).toBe(true);
  });

  it('seeds a bot-authored pull request, so the exclusion is visible locally (#828)', async () => {
    // The members tab counts nobody for these and the PRs tab still lists them.
    // Neither behaviour is visible on a seed where every PR is a person's, and
    // it is the live shape: all 8 open PRs on acme/board are
    // dependabot's (measured 2026-09-03).
    const read = await source().pullRequests('acme/board', SINCE);
    if (read.state !== 'read') throw new Error('expected a read');
    expect(read.openPrs.some((p) => p.authorIsBot)).toBe(true);
    expect(read.openPrs.some((p) => !p.authorIsBot)).toBe(true);
    expect(read.prs.some((p) => p.authorIsBot)).toBe(true);
    // Flagged, not renamed: the seed says what the author IS, the way
    // `__typename` does, rather than spelling a `[bot]` suffix nothing reads.
    expect(read.openPrs.find((p) => p.authorIsBot)?.author).toBe('dependabot');
    // A ghost account is not a machine.
    expect(read.openPrs.filter((p) => p.author === null).every((p) => !p.authorIsBot)).toBe(true);
  });

  it('seeds a repo whose PR read did not answer, so "could not read" is drawable (#828)', async () => {
    // Empty and unreadable are different screens on both the PRs tab and the
    // members tab — `RepoMembers.prsUnreadable` exists to keep them apart — and
    // neither can be built against a seed where every read succeeds. The three
    // README states are seeded across the same rows for the same reason.
    const states = await Promise.all(
      (await source().listRepos()).repos.map(async (r) => (await source().pullRequests(r.full, SINCE)).state),
    );
    expect(states).toContain('read');
    expect(states).toContain('unreadable');
  });

  it('seeds a repo that ran real minutes and was billed nothing (#582)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T12:00:00Z'));
    const read = await source().actionsUsage([{ year: 2026, month: 8 }]);
    expect(read).not.toBeNull();
    // The case net cost alone cannot express: work that the included-minutes
    // allowance absorbed. Without one in the seed, a local run only ever draws
    // "ran and cost money" and "ran nothing", and the third state is untested.
    expect(read.days.some((d) => d.minutes > 0 && d.netUsd === 0)).toBe(true);
    expect(read.days.some((d) => d.minutes > 0 && d.netUsd > 0)).toBe(true);
  });

  it('dates its usage relative to now, so the seed never ages out of the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-13T00:00:00Z'));
    const before = await source().actionsUsage([{ year: 2026, month: 8 }]);
    vi.setSystemTime(new Date('2026-08-14T00:00:00Z'));
    const after = await source().actionsUsage([{ year: 2026, month: 8 }]);
    expect(before.days.length).toBeGreaterThan(0);
    expect(Date.parse(after.days[0].date) - Date.parse(before.days[0].date)).toBe(DAY_MS);
  });
});

/**
 * #718 — the fixture answers the same SHAPES the live source does.
 *
 * It serves one org and always will: every seed row is spelled `acme/…`,
 * so there is no second org here to read. What it owes is the plural shape, and
 * an honest answer inside it — a fixture whose `unreadableOrgs` were the wrong
 * type, or whose `orgs` named nothing, would let a consumer be written against
 * a value the live source never produces and pass every local run.
 */
describe('FixtureReposSource — the org set it serves (#718)', () => {
  const source = () => new FixtureReposSource();

  it('names its one org as a set', () => {
    expect(source().servedOrgs).toEqual(['acme']);
  });

  it('every seed row is under an org the source says it serves', async () => {
    // The claim `servedOrgs` makes, checked against what the seed actually
    // spells rather than restated. A row under any other org would be a repo
    // the map draws and the source disowns.
    const { repos } = await source().listRepos();
    expect(repos.length).toBeGreaterThan(0);
    for (const r of repos) {
      expect(source().servedOrgs).toContain(r.full.split('/')[0]);
    }
  });

  it('reads ownership with nothing unreadable — no seed org can fail', async () => {
    const read = await source().driByRepo();
    expect(read.byRepo.get('acme/board')).toBe('octocat');
    expect(read.unreadableOrgs).toEqual([]);
  });

  it('lists repos with nothing unreadable, in the plural shape', async () => {
    const read = await source().listRepos();
    expect(read.repos.length).toBeGreaterThan(0);
    expect(read.unreadableOrgs).toEqual([]);
  });

  it('every security row says it was READ, so its zeros are measurements', async () => {
    // The seed IS the read here, so nothing can be unreadable — and a fixture
    // that left `state` off would let a consumer be written against a row the
    // live source never produces.
    const read = await source().securityByRepo();
    expect(read.unreadableOrgs).toEqual([]);
    expect([...read.byRepo.values()].every((s) => s.state === 'read')).toBe(true);
    expect(read.byRepo.get('acme/acme')?.depHigh).toBe(6);
  });

  it('reports the org its usage rows are for', async () => {
    const read = await source().actionsUsage([{ year: 2026, month: 8 }]);
    expect(read?.orgs).toEqual(['acme']);
  });
});
