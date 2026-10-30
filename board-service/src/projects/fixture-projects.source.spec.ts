import { describe, it, expect } from 'vitest';
import { FixtureProjectsSource } from './fixture-projects.source';
import { isBotActor } from './bot-actors';
import { isDeliveredClose } from '../issues-metrics/close-reason';

/** The org the fixture's seeds belong to — `FIXTURE_OWNER`. The source takes
 *  the org as an argument since #697, and answers an org it has no seeds for
 *  with nothing rather than with these boards again. */
const OWNER = 'acme';

describe('FixtureProjectsSource', () => {
  const src = new FixtureProjectsSource();

  it('lists focused boards with counts, completion and its closes newest-first', async () => {
    const list = await src.listProjects(OWNER);
    expect(list.length).toBeGreaterThan(0);
    const board = list.find((p) => p.name === 'Acme Go-To-Market');
    expect(board).toBeTruthy();
    expect(board!.pct).toBeGreaterThanOrEqual(0);
    expect(board!.pct).toBeLessThanOrEqual(100);
    // The recency pick walks these in order (#497), so the order is the contract.
    expect(board!.recentCloses.length).toBeGreaterThan(1);
    expect(board!.recentCloses[0].by).toBeTruthy();
    const times = board!.recentCloses.map((c) => Date.parse(c.atISO));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  /**
   * The fixture is what local dev and a live curl read, so it has to hold the
   * case the visibility rule (#497) exists for. Without a real submission on a
   * surfaced board, every Projects read over this data passes whatever the code
   * does — the rule could be deleted and nothing here would notice.
   */
  it('seeds a real feedback submission on a surfaced board, open and closed (#497)', async () => {
    const detail = await src.getProject(OWNER, 7);
    const submissions = detail!.items.filter(
      (i) => i.repo === 'acme/board' && i.labels.some((l) => l.name === 'feedback'),
    );
    expect(submissions.map((i) => i.state).sort()).toEqual(['closed', 'open']);
  });

  /**
   * The card the issue was filed about, seeded exactly as Github holds it:
   * `compliance.example.com#149`, a person at both ends, `dependencies` its only
   * mark. This is the row two green suites did not contain — the fixture's bumps
   * were all bot-authored, a shape this org does not have (dependabot files pull
   * requests here, and the live source's `isIssue` filter drops those), so a
   * suite over them could report a fix that moved nothing in production.
   */
  it('seeds the live card verbatim: a person wrote AND closed it, and only its label says bump (#488)', async () => {
    const board = (await src.listProjects(OWNER)).find((p) => p.name === 'Acme Go-To-Market');
    const live = board!.recentCloses[0];
    expect(live.repo).toBe('acme/compliance.example.com');
    expect(live.number).toBe(149);
    expect(live.author).toBe('octocat');
    expect(live.by).toBe('octocat');
    expect(live.labels).toContain('dependencies');
    // Nothing else about the row would skip it — that is the whole point.
    expect(isBotActor(live.author!)).toBe(false);
    expect(isBotActor(live.by!)).toBe(false);
  });

  /**
   * The three closes the recency walk steps over, in front of the one it names —
   * the live bump (#488), a bot-WRITTEN bump (#488), a submission (#497), then a
   * teammate's close. So local dev and a live curl walk the whole thing, not the
   * easy case where the newest close happens to be nameable.
   *
   * The bot-written bump is closed by a PERSON, which is what the author rule
   * needs to be worth anything: were a bot ever to file an issue here, a teammate
   * would merge it and Github would record the teammate, so a pick keyed on the
   * closer would sail straight past. (Was: this same test, before the live row in
   * front of it — it asserted the bot bump was `recentCloses[0]`, which it no
   * longer is.)
   */
  it('the closes in front of the named one are: the live bump, a bot-written bump, a submission (#488/#497)', async () => {
    const board = (await src.listProjects(OWNER)).find((p) => p.name === 'Acme Go-To-Market');
    const [live, bump, submission] = board!.recentCloses;
    expect(live.labels).toContain('dependencies');
    expect(bump.author).toBe('dependabot[bot]');
    expect(bump.by).toBe('octocat');
    expect(submission.labels).toContain('feedback');
    expect(submission.repo).toBe('acme/board');
    // …and there is an older close behind all three to fall back to: one a person
    // wrote, carrying no `dependencies` label, whose labels the fixture
    // establishes whole (a null here would be a fixture that stopped answering
    // the question the words gate asks).
    expect(
      board!.recentCloses
        .slice(3)
        .some(
          (c) =>
            c.author != null &&
            !isBotActor(c.author) &&
            c.labels != null &&
            !c.labels.includes('feedback') &&
            !c.labels.includes('dependencies'),
        ),
    ).toBe(true);
  });

  /**
   * The decision #488 settles the other way, seeded so a curl sees it: a person
   * wrote the issue and automation closed it on merge. That is still named — the
   * work behind it was somebody's.
   */
  it('seeds a person’s issue that automation closed, which the card still names (#488)', async () => {
    const board = (await src.listProjects(OWNER)).find((p) => p.name === 'Acme Go-To-Market');
    const botMerged = board!.recentCloses.find((c) => c.by === 'github-actions[bot]');
    expect(botMerged).toBeDefined();
    expect(botMerged!.author).toBe('hubot');
  });

  /**
   * The other end of #488: a board where every close is a bump. The card must
   * name nothing there — and must not fall back to "No issues closed yet", which
   * the board's own `closed` count contradicts.
   *
   * The two are skipped for different reasons, so this board covers the OR
   * rather than one rule twice: one automation wrote, one a person wrote AND
   * closed, carrying only the label. (Was: both bot-authored — which asserted the
   * author rule twice and the label rule not at all, so removing the label rule
   * left this board's card unchanged.)
   */
  it('seeds a board whose closes are ALL bumps — one bot-written, one label-only (#488)', async () => {
    const board = (await src.listProjects(OWNER)).find((p) => p.name === 'Acme Compliance');
    expect(board!.closed).toBeGreaterThan(0);
    expect(board!.recentCloses.length).toBe(2);
    // Every close carries the label…
    expect(board!.recentCloses.every((c) => c.labels?.includes('dependencies'))).toBe(true);
    // …and exactly one of them would ALSO be skipped for its author, so the
    // other can only be skipped by its label.
    const byAuthor = board!.recentCloses.filter((c) => c.author != null && isBotActor(c.author));
    expect(byAuthor).toHaveLength(1);
    const labelOnly = board!.recentCloses.find((c) => c.author != null && !isBotActor(c.author))!;
    expect(labelOnly.author).toBe('hubot');
    expect(labelOnly.by).toBe('hubot');
  });

  it('drops the "Acme" umbrella from the rollup while keeping focused boards (#202)', async () => {
    const list = await src.listProjects(OWNER);
    expect(list.some((p) => p.name === 'Acme')).toBe(false);
    expect(list.some((p) => p.name === 'Acme Go-To-Market')).toBe(true);
    // The umbrella's issues still feed the project-stacking join is NOT the claim —
    // memberships drop it too; the Dashboard Issues block (separate search) keeps them.
    const memberships = await src.projectMemberships(OWNER);
    expect(memberships.some((m) => m.name === 'Acme')).toBe(false);
  });

  it('returns a board with its issue rows, sorted newest-updated first', async () => {
    const detail = await src.getProject(OWNER, 7);
    expect(detail).toBeTruthy();
    expect(detail!.items.length).toBeGreaterThan(0);
    const updated = detail!.items.map((i) => Date.parse(i.updatedAt));
    expect(updated).toEqual([...updated].sort((a, b) => b - a));
    const withPr = detail!.items.find((i) => i.prs.length > 0);
    expect(withPr?.prs[0].number).toBeTypeOf('number');
  });

  it('returns null for an unknown board number', async () => {
    expect(await src.getProject(OWNER, 9999)).toBeNull();
  });

  it('returns null when drilling into the "Acme" umbrella (#202)', async () => {
    expect(await src.getProject(OWNER, 4)).toBeNull();
  });

  it('seeds distinct customFields across items so a filter is meaningful (#401)', async () => {
    const detail = await src.getProject(OWNER, 7);
    const byNum = Object.fromEntries(detail!.items.map((i) => [i.number, i.customFields]));
    expect(byNum[180]).toEqual({ priority: ['High'], sprint: ['Sprint 3'] });
    expect(byNum[182]).toEqual({ priority: ['Medium'], sprint: ['Sprint 3'] });
    expect(byNum[183]).toBeUndefined();
  });

  /**
   * A live board can hold pull requests, and the counts cover issues only
   * (#517) — so the fixture has to hold one too, or local dev and CI read data
   * where the difference never arises and the statement on the card is never
   * seen. Dependabot files pull requests in this org, so a bump PR sitting on a
   * board is the ordinary shape, not an invented one.
   */
  it('seeds a board carrying a pull request, which the counts leave out and say so (#517)', async () => {
    const board = (await src.listProjects(OWNER)).find((p) => p.name === 'Acme Compliance')!;
    expect(board.excludedItems).toBe(1);
    // The pull request is in none of the numbers. Since #1014 the board's issue
    // rows no longer add up to `open + closed` on their own: a close that was
    // not delivery is a row on the table and is in neither count, so it is the
    // whole of the difference. Read as an equation rather than as two loose
    // numbers — a row falling out of the table for some other reason would show
    // up right here.
    const detail = (await src.getProject(OWNER, board.number))!;
    const abandoned = detail.items.filter((i) => i.state === 'closed' && !isDeliveredClose(i));
    expect(abandoned).toHaveLength(1);
    expect(detail.items).toHaveLength(board.open + board.closed + abandoned.length);
    expect(detail.excludedItems).toBe(1);
    // …nor in the stacking index, which joins on issue URLs.
    const membership = (await src.projectMemberships(OWNER)).find((m) => m.number === board.number)!;
    expect(membership.issueUrls.every((u) => u.includes('/issues/'))).toBe(true);
    expect(membership.issueUrls).toHaveLength(detail.items.length);
  });

  /**
   * The fixture is what local dev and CI read, so it has to hold the shape the
   * exclusion exists for (#1014) — and hold it beside real closes, or the board
   * would just go quiet and nothing about the difference would be visible.
   */
  it('seeds a close that was not delivery beside ones that were, and counts none of it (#1014)', async () => {
    const board = (await src.listProjects(OWNER)).find((p) => p.name === 'Acme Compliance')!;
    const detail = (await src.getProject(OWNER, board.number))!;

    // It is the NEWEST close on the board, so a rollup that counted it would
    // name it on the card. The recency line names a delivered close instead.
    const closedRows = detail.items.filter((i) => i.state === 'closed');
    const newest = [...closedRows].sort((a, b) => Date.parse(b.closedAt!) - Date.parse(a.closedAt!))[0];
    expect(newest.stateReason).toBe('not_planned');
    expect(board.recentCloses.map((c) => c.number)).not.toContain(newest.number);

    // The row is on the table and in none of the numbers.
    expect(closedRows).toHaveLength(board.closed + 1);
    expect(board.closed).toBe(2);
    expect(board.open).toBe(3);
    expect(board.pct).toBe(40);
    // 50 is what this board reported before the exclusion, and what it would
    // report again the day a count stops asking why an issue closed.
    expect(Math.round(((board.closed + 1) / (board.open + board.closed + 1)) * 100)).toBe(50);
    expect(board.closedThisWeek).toBe(2);

    // The ring's invariant survives it: both runs still sum to `closed`, which
    // they would not if the abandoned close reached one tally and not the other.
    expect(board.contributors.reduce((n, c) => n + c.closed, 0)).toBe(board.closed);
    expect(board.contributorsByAssignee.reduce((n, c) => n + c.closed, 0)).toBe(board.closed);

    // And the seed carries all three answers, not just the two extremes: one
    // close states `completed`, one states `not_planned`, and the rest state
    // nothing at all — the `null` that counts.
    const reasons = closedRows.map((i) => i.stateReason);
    expect(reasons).toContain('completed');
    expect(reasons).toContain('not_planned');
    expect(reasons).toContain(null);
  });

  it('reports nothing excluded for the boards that hold only issues (#517)', async () => {
    const board = (await src.listProjects(OWNER)).find((p) => p.name === 'Acme Go-To-Market');
    expect(board!.excludedItems).toBe(0);
  });

  /** The fixture holds every seeded item in memory, so there is no read to come
   *  up short — it answers the field the live source computes from `totalCount`
   *  (#690) with the only answer it can honestly give, on both read paths. */
  it('reports every board read whole, on the rollup and the board page alike (#690)', async () => {
    for (const board of await src.listProjects(OWNER)) expect(board.itemsComplete).toBe(true);
    expect((await src.getProject(OWNER, 7))!.itemsComplete).toBe(true);
  });

  it('lists a candidate-boards catalog with id/number/title, umbrella excluded (#404)', async () => {
    const catalog = await src.listProjectCatalog(OWNER);
    expect(catalog.length).toBeGreaterThan(0);
    for (const entry of catalog) {
      expect(entry.id).toBeTypeOf('string');
      expect(entry.number).toBeTypeOf('number');
      expect(entry.title).toBeTypeOf('string');
    }
    expect(catalog.some((e) => e.title === 'Acme Go-To-Market')).toBe(true);
    expect(catalog.some((e) => e.title === 'Acme')).toBe(false); // umbrella (#202)
  });
});
