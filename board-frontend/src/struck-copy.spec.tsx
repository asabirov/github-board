/**
 * The strike-through list, as a check (#707, #730).
 *
 * Artur marked up three screenshots of Your work and one of Overview by hand,
 * struck ten phrases and one connector, and wrote one word: slop. The tables in
 * those two issues are the specification, and this file is that specification
 * pointed at the rendered markup of both surfaces at once. #961 added a third
 * surface, the repository Overview, which has a list of its own at the bottom.
 *
 * WHY IT IS HERE RATHER THAN IN EITHER FOLDER. The complaint is one shape spread
 * over features on one surface, and it came back on the second surface three
 * weeks after it was fixed on the first.
 * A per-folder spec cannot see that. This one holds the whole list in one array,
 * so a phrase reintroduced anywhere fails with the phrase named.
 *
 * WHY THE SLOP DETECTOR IS NOT WHAT CATCHES IT, which #707 asks to be recorded.
 * The detector has 28 rules — fourteen visual, eleven textual, three about
 * comments. Every textual rule is a phrase or a density measured over a
 * document: `hedge-opener`, `world-opener`, `vocab-density`, `middot-chain`.
 * None of them can see the thing that is wrong here, because the thing that is
 * wrong is a RELATIONSHIP between two elements a browser lays out — a figure and
 * a phrase explaining how to read it. `scope-template` is the nearest structural
 * rule and it matches "whether you're a X or a Y". So the detector will not grow
 * a rule for this, it was run over these files on 2026-08-26 and reported nothing
 * on the user-visible copy (#731), and this file is what catches it instead.
 *
 * The suite has no DOM, so both surfaces are rendered to a
 * static string and the assertions read what a person reads.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from './ui/kit';
import { FlowStrip } from './flow-strip/FlowStrip';
import { stripModel } from './flow-strip/flow-strip.vm';
import { RepoBody } from './repos/RepoPage';
import { SyncSources } from './topbar/TopBar';
import { SOURCE_NAMES, type SyncOperation } from './sync/sync-operation';
import type { DeliveryView } from './api/delivery';
import type { PersonalIssue, PersonalIssues } from './api/issues';
import type { RepoCiWindow, RepoPageView } from './api/repos';
// The day tooltip is component state, and this environment has no DOM to hover
// with, so the one struck line that lives only inside it is checked against the
// component's own source. Vite's `?raw`, the idiom `DayGrid.spec.tsx` already
// uses for the same reason.
import dayGridSource from './flow-strip/DayGrid.tsx?raw';

/** A Tuesday, so the grid draws a one-day running column and every branch that
 *  depends on the weekday is exercised somewhere. */
const NOW = Date.parse('2026-08-25T12:00:00Z');
const SPAN = 98;

/** Busy on every axis: a figure in each tile, a spark under each, a grid with
 *  something in it. A quiet fixture would pass these assertions by drawing
 *  nothing, which is the way a check like this goes vacuous. */
const busy = (seed: number) =>
  Array.from({ length: SPAN }, (_, i) => (i * seed) % 11);

function issue(number: number): PersonalIssue {
  return {
    number, repo: 'board', owner: 'acme', title: `issue ${number}`,
    htmlUrl: 'https://example.invalid', createdAt: '2026-08-01T00:00:00Z', ageDays: 24,
    labels: [], type: 'chore', blocked: false, assignedToMe: true, assignees: ['a'],
    author: 'a', projects: [], state: 'open', closedAt: null,
  };
}

const MINE: PersonalIssues = {
  updatedAt: '2026-08-25T12:00:00Z',
  login: 'a',
  issues: [issue(1), issue(2), issue(3)],
  throughput: { opened: 4, closed: 6 },
  throughputWeeks: [{ opened: 4, closed: 6 }],
  // `exited` as well as `closed`, or the Issues tile draws no spark: #1014 made
  // the depth walk refuse a payload without it. Left out, the Issues spark and
  // its accessible name were simply never rendered here, so nothing below could
  // see what that name said (#979).
  throughputDays: { opened: busy(3), closed: busy(7), exited: busy(7) },
  // Long enough to fill the 52-week grid (#817), so every cell of it carries a
  // reading. A 98-day series draws thirty-eight empty columns, and this file's
  // assertions are about copy a person can see — over a mostly-blank grid they
  // would be reading an absence.
  closedDays: Array.from({ length: 400 }, (_, i) => (i * 7) % 11),
};

const DELIVERY: DeliveryView = {
  releases: [], merges: [], unassignedPrs: 2, updatedAt: '2026-08-25T12:00:00Z',
  releaseDays: busy(2), releasesPartial: false, releaseScope: 'acme',
};

const MARKUP = [
  // The strip's sparks hint when they are pointed at (#708), and the board's one
  // styled tooltip needs its provider — the app root holds one (App.tsx), so a
  // component rendered on its own has to bring it.
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(FlowStrip, { model: stripModel({ kind: 'me', mine: MINE, error: null }, DELIVERY, NOW) }))),
].join(' ');

/** Rendered text of everything the two issues marked up, tags dropped, so an
 *  assertion reads what a person reads rather than what a class is called. */
const PAGE = MARKUP.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

/**
 * What a screen reader says that the rendered text does not: every accessible
 * name, description and tooltip in the markup.
 *
 * PAGE alone was never enough, because it drops every tag and a spark's name is
 * an attribute. #752 struck "Issues open" and #817 struck "Closed each day" from
 * the captions, both still stood in the sparks' `aria-label`s, and this file read
 * past them for as long as it read text alone (#979). A phrase struck from the
 * page and still read aloud to somebody who cannot see the page is the worse of
 * the two outcomes, so every struck phrase is looked for here as well.
 */
const SPOKEN_ATTRS = /\s(?:aria-label|aria-description|aria-roledescription|aria-valuetext|title|alt|placeholder)="([^"]*)"/g;
const spoken = (markup: string) => [...markup.matchAll(SPOKEN_ATTRS)].map((m) => m[1]).join(' | ');
const SPOKEN = spoken(MARKUP);

/**
 * Every phrase Artur struck, verbatim, with the surface it stood on.
 *
 * `N waiting` and the two range labels are matched as patterns rather than as
 * strings, because the number in each came from the data: pinning `3 waiting`
 * would pass on a fixture that happened to hold four reports.
 */
const STRUCK: [RegExp, string][] = [
  // #707 — Your work, the three stat tiles
  [/\bopen now\b/, '#707 the Issues unit'],
  [/\bsince yesterday\b/, '#707 the Issues delta'],
  [/\bclosed yesterday\b/, '#707 the Throughput unit, which the caption carried capitalised until #821 took the day off it'],
  [/\bvs the day before\b/, '#707 the Throughput and Releases deltas'],
  [/\breleased yesterday\b/, '#707 the Releases unit (the caption says it now, capitalised)'],
  [/\bacross acme\b/, '#707 the Releases scope line, already gone in #714'],
  [/\b\d+–\d+\b/, '#707 a sparkline printing its own min–max range'],
  // #707 — Your work, the day grid
  [/Whole weeks, ending last Sunday/, '#707 the caption under the grid'],
  [/Shades are quartiles/, '#707 the caption under the grid'],
  // #752 — Overview and Your work, the first tile of the strip
  [/\bIssues open\b/, '#752 the Issues caption, which says the unit no longer'],
  // #817 — Your work and Overview, the caption over the day grid
  [/Closed each day/, '#817 the grid caption, which named the day twice over'],
  // #821 — Your work and Overview, the second tile of the strip
  [/Closed yesterday/, '#821 the Closed caption, which says the day no longer'],
  // #1034 — Your work and Overview, the info icon beside the grid caption
  [/UTC calendar days/, '#1034 the UTC note behind the grid’s info icon'],
  [/How these days are counted/, '#1034 the info icon that opened it'],
];

describe('every phrase struck on Your work and Overview is off the page (#707, #730)', () => {
  // Vacuous unless something was actually drawn: a component that threw, or one
  // rendering its absent state, would pass all fifteen assertions below.
  it('rendered the strip, so the assertions have something to read', () => {
    expect(PAGE).toContain('Issues');
    expect(PAGE).toContain('Issues closed');
    // The grid drew cells rather than its "no daily history" state.
    expect(MARKUP).toContain('data-day="0"');
    // And both sparks drew their names, so the spoken half has something to read.
    expect(SPOKEN.match(/over the \d+ days to/g)?.length).toBe(2);
  });

  // Not in PAGE: the chip is component state and nothing here can hover. So the
  // one line that lived only inside it is checked where it would have to come
  // back — the component's source.
  it('has no second line of attribution policy in the day tooltip (#707)', () => {
    expect(dayGridSource).not.toMatch(/Attributed to whoever holds the issue/);
  });

  it.each(STRUCK)('has no %s', (pattern, where) => {
    expect(PAGE, `${where} — struck by hand on a screenshot and marked "slop"`).not.toMatch(pattern);
  });

  it.each(STRUCK)('says no %s to a screen reader either', (pattern, where) => {
    expect(SPOKEN, `${where} — struck from the page, and still in an accessible name`).not.toMatch(pattern);
  });
});

describe('what a reader can still recover, with every caption gone', () => {
  // The other half of both issues' Done-when: the cuts are only right if the
  // page still says what each figure counts.
  it('names what each of the three tiles counts, in its caption', () => {
    // `The oldest` is the third since #816, where `Released yesterday` was.
    for (const caption of ['Issues', 'Closed', 'The oldest']) {
      expect(PAGE).toContain(caption);
    }
  });

  it('answers a day with its date and its count, which is the grid’s only decoder now', () => {
    // The key went with #709, so the cell's own accessible name is what says
    // what a shade stands for. Read off the MARKUP: an aria-label is an
    // attribute, and PAGE has had every tag stripped out of it.
    // The date carries UTC (#1034), which is also what tells a grid cell from a
    // spark point: the spark sentences name the same days without it.
    expect(MARKUP).toMatch(/aria-label="(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+ [A-Z][a-z]{2}, (nothing closed|\d+ closed)"/);
  });

  /**
   * The other half of #821's Done-when, and the one this whole file is for: the
   * caption said which day the Closed figure counts, the caption no longer says
   * it, so something on that tile has to.
   *
   * WHAT IS ASSERTED IS THE JOIN, not two labels. The chart's own name ends on a
   * date; the tile's last point is dated the same day and carries a closed count.
   * Those two agreeing is what makes the figure datable, because `sparkDays` ends
   * a series on the day its own tile's figure is for (#734) — so the last point
   * IS the figure. Either label alone would pass on a spark that had quietly
   * stopped naming its end.
   *
   * The Closed spark is found by its accessible name and read up to the next
   * chart, so a point label from the Issues tile or from the day grid — which
   * writes the same sentence with UTC after the date — cannot answer for it.
   */
  it('says which day the Closed figure counts, on that tile’s own spark (#821)', () => {
    const chart = /aria-label="Issues closed per day, over the \d+ days to ((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+ [A-Z][a-z]{2})"/;
    const named = MARKUP.match(chart);
    expect(named, 'the Closed spark no longer names the day it ends on').not.toBeNull();
    const after = MARKUP.slice(named!.index! + named![0].length);
    // Cut at the next chart OR the day grid, which has no `role="img"` of its own.
    // Cut at the chart alone, the slice ran on through the Oldest tile and the
    // whole grid, and the grid's last cell answered here, word for word, until
    // #1034 put UTC into it. And only the point sentences: the Oldest tile's
    // "Issue actions" menu still sits between this tile and the grid.
    const ends = [after.indexOf('role="img"'), after.indexOf('data-flow-grid')].filter((i) => i !== -1);
    const tile = ends.length ? after.slice(0, Math.min(...ends)) : after;
    const labels = [...tile.matchAll(/aria-label="((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [^"]+)"/g)].map((m) => m[1]);
    expect(labels.at(-1)).toMatch(new RegExp(`^${named![1]}, (nothing closed|\\d+ closed)$`));
  });
});

/**
 * The repository Overview (#961), struck the same way and pinned the same way.
 *
 * Its own list and its own rendered text rather than more rows in the ones
 * above, so the checks already there keep reading only the surfaces they were
 * written for: the repo page draws "Issues" and "closed" too, and the recovery
 * checks above would start passing on the wrong page.
 *
 * Why the detector did not catch these either, which #961 asks to be recorded
 * beside #707's answer. The vendored detector sends a source file to its
 * comments pack alone, so it never reads a string in `src`; pointed at the copy
 * by hand at its strictest level it found nothing, because its text rules are
 * stock phrases and document-wide densities and its em-dash rule skips anything
 * under sixty words. What was struck is redundancy BETWEEN elements: one window
 * caption on three cards, a totals line restating the chart above it, a sentence
 * glossing billing. That is a relation on a page, not a phrase. The copy gate did
 * catch the old CI sentence, for its em dash, and a person excused it with an
 * `accepted.tsv` row that #996 deleted along with the sentence. Neither gate is
 * changing: this file is where a struck phrase is held.
 *
 * Rendered four times. Twice with every card drawn, because the CI card's last
 * line has two branches: a window with free weeks draws their sentence, a window
 * without drew the fallback. Twice more with cards that have nothing to draw,
 * because an empty card says so in a sentence, and until #961's review that
 * sentence named the window a second time, two rows under the line that already
 * had. A check that renders only full cards could not see it.
 */
const repoView = (ci: RepoCiWindow[], quiet: { issues?: true; prs?: true } = {}): RepoPageView => ({
  updatedAt: '2026-08-25T12:00:00Z',
  repo: {
    full: 'acme/board.example.com',
    name: 'board.example.com',
    key: 'board',
    htmlUrl: 'https://github.com/acme/board.example.com',
    description: null,
    weeks: Array.from({ length: 10 }, (_, i) => (
      quiet.issues ? { opened: 0, closed: 0 } : { opened: 2 + (i % 3), closed: 1 + (i % 2) }
    )),
    open: quiet.issues ? 0 : 10,
    owner: null,
    language: 'TypeScript',
    pushedAt: '2026-08-24T12:00:00Z',
  },
  readme: { state: 'absent' },
  pullRequests: quiet.prs
    ? { state: 'read', open: 0, closedMerged: 0, weeks: [], openPrs: [] }
    : {
        state: 'read', open: 3, closedMerged: 40,
        weeks: Array.from({ length: 10 }, () => ({ opened: 2, merged: 2 })),
        openPrs: [],
      },
  ciSpend: { state: 'read', weeks: ci },
  openIssues: [],
  openIssuesState: 'read',
  previous: {
    openIssues: { state: 'read', value: 8 },
    openPrs: { state: 'read', value: 3 },
    ciNetUsd: { state: 'read', value: 2.1 },
  },
});
const billed = { minutes: 400, netUsd: 0.4 };
const free = { minutes: 53, netUsd: 0 };
const idle = { minutes: 0, netUsd: 0 };

const REPO_MARKUP: [string, string][] = ([
  ['every card drawn, some weeks free', repoView([free, free, free, ...Array.from({ length: 7 }, () => billed)])],
  ['every card drawn, no week free', repoView(Array.from({ length: 10 }, () => billed))],
  // The Issues and CI spend cards empty beside a Pull requests card that has a
  // figure, so the line above the cards is drawn and the empty cards sit under it.
  ['two empty cards beside a figure', repoView(Array.from({ length: 10 }, () => idle), { issues: true })],
  // No card has a figure, so nothing is compared, and the window still has to
  // be said somewhere, once.
  ['no card with a figure', repoView(Array.from({ length: 10 }, () => idle), { issues: true, prs: true })],
] as const).map(([name, view]) => [
  name,
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(RepoBody, { view, now: NOW }))),
]);
/** One rendered text per page, named, so a count that has to hold on every page
 *  can say which page broke it. */
const REPO_PAGES: [string, string][] = REPO_MARKUP.map(([name, markup]) => [
  name,
  markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '),
]);
const REPO_PAGE = REPO_PAGES.map(([, text]) => text).join(' ');
const REPO_SPOKEN = REPO_MARKUP.map(([, markup]) => spoken(markup)).join(' | ');

const STRUCK_REPO: [RegExp, string][] = [
  [/\bten weeks\b/i, '#961 the window caption, drawn on each of the three cards'],
  [/\bthe last 10 weeks\b/, '#961 the same caption as reworded, on all three cards until #961 and in the empty cards’ sentences until its review'],
  [/\d+ opened, \d+ closed\b/, '#961 the Issues card’s totals, which restated the chart above them'],
  [/\d+ opened, \d+ merged\b/, '#961 the Pull requests totals, the same line on the next card'],
  [/ran inside the included allowance/, '#961 the CI sentence'],
  [/included minutes absorbed/, '#961 the CI sentence'],
  [/billed at nothing/, '#961 the CI sentence'],
  [/\bof it free\b/, '#961 the CI fallback, the same gloss on the branch with no free week'],
  // #1236 struck the line above the cards as well — the reporter called it
  // filler twice, then made it a standing rule for this page: nothing here
  // describes the figures, it only states them.
  [/Last 10 weeks, compared with the previous 10\./, '#1236 the line above the cards'],
  [/Last 10 weeks\./, '#1236 the shorter line that replaced it, struck with it'],
];

/**
 * The struck phrase a repository chart's accessible name still says, on a
 * decision this spec does not get to make.
 *
 * `REPO_PAGE_WINDOW` is "the last 10 weeks". #996 introduced it and its reporter
 * accepted the wording (`scripts/copy-gate/reviewed.tsv`); #961 struck it from
 * the three cards; #1016 took it off the cards and left it in the two flow
 * charts' names, "29 opened and 15 closed in the last 10 weeks". Reading names
 * as well as text is what found it (#979). Whether it comes out of the names
 * too is open, and is the reporter's call rather than a check's.
 */
const SPOKEN_KEPT: RegExp[] = [/\bthe last 10 weeks\b/];

describe('every phrase struck on the repository Overview is off the page (#961)', () => {
  it.each(STRUCK_REPO)('has no %s', (pattern, where) => {
    expect(REPO_PAGE, `${where} — struck by hand on a screenshot and marked "slop"`).not.toMatch(pattern);
  });

  it('draws accessible names, so the spoken check below reads something', () => {
    expect(REPO_SPOKEN.length).toBeGreaterThan(0);
  });

  // Held as a failing fact rather than skipped quietly: the day the chart names
  // stop saying it, this fails and the exemption comes out with it.
  it('still says the one struck phrase it is excused for, so the excuse is still needed', () => {
    for (const kept of SPOKEN_KEPT) expect(REPO_SPOKEN).toMatch(kept);
  });

  it.each(STRUCK_REPO.filter(([p]) => !SPOKEN_KEPT.some((k) => String(k) === String(p))))('says no %s to a screen reader either', (pattern, where) => {
    expect(REPO_SPOKEN, `${where} — struck from the page, and still in an accessible name`).not.toMatch(pattern);
  });
});

describe('what the repository Overview still says, with the struck copy gone (#961, #962)', () => {
  // Vacuous unless the empty cards were drawn: a page where every card has a
  // figure would pass the count below without ever reaching an empty sentence.
  it('rendered the empty cards, so the checks below read them too', () => {
    expect(REPO_PAGE).toContain('Nothing opened or closed');
    expect(REPO_PAGE).toContain('No CI ran');
    expect(REPO_PAGE).toContain('No pull requests in this repo');
  });

  /**
   * THE WINDOW IS NAMED ONLY WHERE IT QUALIFIES A FIGURE (#1236).
   *
   * #961 replaced the per-card caption with one line above the cards, and
   * #1236 took that line away too. What names the window in visible words now
   * is the baseline half of a measured delta — "+2 vs 10 weeks ago" — which
   * qualifies the one number it sits under. So the count is no longer "once a
   * page": it is once per delta, and a page with no delta never says it.
   */
  it('captions nothing, and says what each figure is compared with instead', () => {
    expect(REPO_PAGE).not.toContain('Last 10 weeks, compared with the previous 10.');
    expect(REPO_PAGE).not.toContain('Last 10 weeks.');
    expect(REPO_PAGE).toContain('vs 10 weeks ago');
    expect(REPO_PAGE).toContain('vs previous 10 weeks');
  });

  it.each(REPO_PAGES)('names the window only inside a delta, on a page with %s', (_, page) => {
    const mentions = page.match(/10 weeks/g)?.length ?? 0;
    const deltas = page.match(/\bvs (?:10 weeks ago|previous 10 weeks)\b/g)?.length ?? 0;
    expect(mentions).toBe(deltas);
  });

  it('draws one delta per card that has a figure, and none for a card that has not', () => {
    // Three on a full page; one on the page whose only figure is the
    // pull-request count; none where no card has a figure at all.
    expect(REPO_PAGES.map(([, page]) => page.match(/\bvs\b/g)?.length ?? 0)).toEqual([3, 3, 1, 0]);
  });

  it('says how each figure moved against that period, with no unit word beside it', () => {
    expect(REPO_PAGE).toContain('10 +2 vs 10 weeks ago');
    expect(REPO_PAGE).toContain('3 No change vs 10 weeks ago');
    expect(REPO_PAGE).toContain('$2.80 +$0.70 vs previous 10 weeks');
    // The card's header is the unit: one number, and nothing spelling it out.
    expect(REPO_PAGE).not.toContain('10 open');
    expect(REPO_PAGE).not.toContain('3 open');
    expect(REPO_PAGE).not.toContain('net billed');
  });

  it('still says which line of each flow chart is which, drawn and spoken', () => {
    // SAID IN WORDS ON THE CARD AGAIN, and this is the guarantee that went
    // missing between #1197 taking the dot legend off and the rework taking
    // off the 34px totals that replaced it: for one commit each flow chart
    // drew two lines of different colour with nothing naming either.
    //
    // What is back is not what was struck. #1197 struck a LEGEND — two
    // swatches in a row under the chart, which a reader has to match by
    // colour — and asked for the series named where the colour already is.
    // Each word now sits at the end of its own line. What stays off the card
    // is the COUNT beside it: `50 closed` was a second window competing with
    // the figure above it, and the totals live in the accessible name.
    expect(REPO_SPOKEN).toMatch(/\d+ opened and \d+ closed in the last 10 weeks/);
    expect(REPO_SPOKEN).toMatch(/\d+ opened and \d+ merged in the last 10 weeks/);
    expect(REPO_PAGE).toMatch(/\bclosed opened\b/);
    expect(REPO_PAGE).toMatch(/\bmerged opened\b/);
    // …and no number joins either of them, on any of the four pages.
    expect(REPO_PAGE).not.toMatch(/\d+ closed \d+ opened/);
    expect(REPO_PAGE).not.toMatch(/\d+ merged \d+ opened/);
    expect(REPO_PAGE).not.toMatch(/\d+ (?:closed|merged|opened)\b/);
  });

  it('still says in words which weeks the allowance absorbed', () => {
    expect(REPO_PAGE).toContain('3 weeks used the included allowance');
  });
});

/**
 * The Board sync popover (#1037), struck the same way. What was struck is the
 * same shape as #961: a sentence over six rows that each already said it, and a
 * foot line restating the list and the button beneath it.
 *
 * `SyncSources` is rendered on its own because the popover portals its content
 * and a portal draws nothing without a DOM. It is rendered in the four states it
 * can open in, since the line under the heading has a branch for each and the
 * struck sentence was the branch for a tab where nothing has run.
 */
const RUNNING: SyncOperation = {
  operationId: 'op-1', state: 'running', startedAt: '2026-09-11T08:00:00Z', expiresAt: '2026-09-11T08:02:00Z',
  sources: {
    issues: { state: 'succeeded' }, issueBuckets: { state: 'running' },
    projects: { state: 'failed' }, repos: { state: 'pending' },
  },
};
const syncMarkup = (props: Partial<Parameters<typeof SyncSources>[0]>) => renderToStaticMarkup(createElement(SyncSources, {
  titleId: 'sync-title', statusId: 'sync-status', label: 'Sync now', syncing: false, syncError: false, operation: null, freshness: null, requestSync: () => {}, ...props,
}));
const SYNC_PANELS: [string, string][] = [
  ['nothing run in this tab', syncMarkup({})],
  ['a sync starting', syncMarkup({ syncing: true, label: 'Starting sync…' })],
  ['a sync part-way through', syncMarkup({ syncing: true, label: 'Syncing · 2/4 finished', operation: RUNNING })],
  ['progress that could not be read', syncMarkup({ syncError: true, label: 'Sync unconfirmed' })],
];
const syncText = (markup: string) => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

const STRUCK_SYNC: [RegExp, string][] = [
  [/No manual sync is recorded/, '#1037 the line under the heading, over five rows that each said Not recorded'],
  [/Sync refreshes these five sources/, '#1037 the foot line, which restated the list and the button under it'],
  [/Background reads finish separately/, '#1037 the second half of the same foot line'],
];

describe('every phrase struck on the Board sync popover is off it (#1037)', () => {
  // Vacuous unless the rows were drawn: a component that threw, or rendered
  // nothing, would pass every absence below.
  it.each(SYNC_PANELS)('drew all four rows with %s', (_, markup) => {
    for (const name of Object.values(SOURCE_NAMES)) expect(syncText(markup)).toContain(name);
  });

  it.each(STRUCK_SYNC)('has no %s', (pattern, where) => {
    for (const [state, markup] of SYNC_PANELS) {
      expect(syncText(markup), `${where}, with ${state} — struck by hand on a screenshot and marked "slop"`).not.toMatch(pattern);
    }
  });
});

describe('what the Board sync popover still says, with the struck copy gone (#1037)', () => {
  const idle = syncText(SYNC_PANELS[0][1]);

  // No source time is available in these fixtures. Point to the existing sync
  // action; recorded ages are covered by board-sync-panel.spec.tsx (#1275).
  it('names itself and points missing-time rows to the sync action', () => {
    expect(idle).toContain('Board sync');
    expect(idle.match(/Sync to refresh/g)?.length).toBe(4);
    expect(idle).toContain('Sync all four sources');
  });

  it('draws no line under the heading before a sync, and one in every other state', () => {
    expect(SYNC_PANELS[0][1]).not.toContain('<p');
    for (const [, markup] of SYNC_PANELS.slice(1)) expect(markup.match(/<p[ >]/g)?.length).toBe(1);
  });

  it('reports each source’s own state part-way through a sync', () => {
    const running = syncText(SYNC_PANELS[2][1]);
    for (const state of ['Refreshed', 'Refreshing', 'Waiting', 'Failed']) expect(running).toContain(state);
  });

  it('is labelled by its own heading', () => {
    expect(SYNC_PANELS[0][1]).toContain('<h2 id="sync-title"');
  });

  // Markup only: the popover's `aria-describedby` is on `PopoverContent`, which
  // portals and so draws nothing here. What a reader hears was read off Chrome's
  // accessibility tree for #1043, not proved by this.
  it('keeps the status line inside a polite status box in every state, empty before a sync', () => {
    for (const [, markup] of SYNC_PANELS) expect(markup).toContain('<div id="sync-status" role="status">');
    expect(SYNC_PANELS[0][1]).toContain('<div id="sync-status" role="status"></div>');
    expect(SYNC_PANELS[1][1]).toContain('<div id="sync-status" role="status"><p');
  });
});
