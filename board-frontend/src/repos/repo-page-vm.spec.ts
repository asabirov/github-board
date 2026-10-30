import { describe, expect, it } from 'vitest';
import type { RepoCiSpend, RepoPrFlow, RepoPrior, RepoRow } from '../api/repos';
import * as vm from './repo-page-vm';
import {
  ISSUES_UNREADABLE,
  REPO_PAGE_WINDOW,
  change,
  ciSpendCard,
  ciWeekHint,
  ciWeekKind,
  issueAge,
  issueFlowCard,
  missingRepo,
  openIssuesHead,
  prFlowCard,
  readmeCard,
  uncoveredNote,
  usd,
  weekPairHint,
} from './repo-page-vm';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function row(over: Partial<RepoRow> = {}): RepoRow {
  return {
    full: 'acme/board',
    name: 'board',
    key: 'board',
    htmlUrl: 'https://github.com/acme/board',
    description: null,
    weeks: Array.from({ length: 10 }, () => ({ opened: 0, closed: 0 })),
    open: 0,
    owner: null,
    language: null,
    pushedAt: null,
    ...over,
  };
}

describe('the window is named once, and the same way everywhere (#582)', () => {
  it('is ten weeks — the window every chart on this page actually draws', () => {
    // The mockup's CI card said "last 14 days" over a ten-week chart. One
    // window, named once: nothing on the page may name a different one.
    expect(REPO_PAGE_WINDOW).toBe('the last 10 weeks');
  });
});

describe('a chart names the window its totals actually cover (#1240 review)', () => {
  // The PR chart sums the windows the read reached and drops the ones it never
  // did, so on a short read its two totals are four weeks' worth under a name
  // that said ten. A sighted reader gets the correction from the count under
  // the chart; a screen-reader user was told a window they were not getting.
  it('names the page window when every window was read', () => {
    expect(vm.coveredWindow(10, 0)).toBe('the last 10 weeks');
  });

  it('says how many of it the totals are, when some were not', () => {
    expect(vm.coveredWindow(4, 6)).toBe('4 of the last 10 weeks');
    expect(vm.coveredWindow(1, 9)).toBe('1 of the last 10 weeks');
  });

  it('holds its shape at nought, where the chart is empty too', () => {
    // One shape at every count is what keeps this from growing a second
    // spelling of the page's window (#582).
    expect(vm.coveredWindow(0, 10)).toBe('0 of the last 10 weeks');
  });

  it('spells the page window once, here as everywhere', () => {
    expect(vm.coveredWindow(4, 6)).toContain(REPO_PAGE_WINDOW);
  });
});

describe('each flow line has one name, and the page keeps it in one place', () => {
  // The word is said in three places — the key at the line's end, the chart's
  // accessible name, and the sentence a pointer draws. Three spellings of one
  // series is how a chart comes to call the same line "closed" and "merged".
  it('names the two series of each flow chart, hero first', () => {
    expect(vm.ISSUE_SERIES).toEqual({ hero: 'closed', trace: 'opened' });
    expect(vm.PR_SERIES).toEqual({ hero: 'merged', trace: 'opened' });
  });

  it('reads the same words the week hint does', () => {
    expect(weekPairHint(1, 5, vm.ISSUE_SERIES.hero, 4, vm.ISSUE_SERIES.trace))
      .toBe('1 week ago, 5 closed and 4 opened');
  });
});

describe('nothing captions the cards (#1240)', () => {
  // The reporter called the standalone line filler twice, and it goes: both
  // "Last N days, compared with the previous N." and the "Last 10 weeks."
  // that replaced it. What survives is the window WHERE IT QUALIFIES
  // something a reader is already reading — a chart's accessible name, a
  // measured delta's own baseline — and nowhere as a sentence of its own.
  const CAPTION = [/^Last \d+ (days|weeks)\.$/, /compared with the previous/i];

  it('exports no standalone window sentence for a line above the cards', () => {
    for (const [name, value] of Object.entries(vm)) {
      if (typeof value !== 'string') continue;
      for (const shape of CAPTION) expect(value, name).not.toMatch(shape);
    }
  });

  it('keeps the window as a fragment, never a sentence', () => {
    // Lower-case and unstopped, because its only reader is the middle of the
    // chart label "N opened and N closed in the last 10 weeks".
    expect(REPO_PAGE_WINDOW).toBe('the last 10 weeks');
    expect(REPO_PAGE_WINDOW).not.toMatch(/^[A-Z]/);
    expect(REPO_PAGE_WINDOW).not.toMatch(/\.$/);
  });
});

describe('how a figure moved against the previous period (#962)', () => {
  const read = (value: number): RepoPrior => ({ state: 'read', value });

  it('signs the amount, with the minus Org lag draws', () => {
    expect(change(5, read(3))).toEqual({ text: '+2', measured: true });
    expect(change(3, read(5))).toEqual({ text: '−2', measured: true });
  });

  it('says money to the cent, and rounds away float drift before deciding it moved', () => {
    expect(change(15, read(12.5), true)).toEqual({ text: '+$2.50', measured: true });
    expect(change(0.3, read(0.1 + 0.2), true)).toEqual({ text: 'No change', measured: true });
  });

  it('says no change in words, never as a zero', () => {
    expect(change(4, read(4))).toEqual({ text: 'No change', measured: true });
  });

  it('tells a repo too new to compare from a comparison nobody could make', () => {
    expect(change(4, { state: 'none' })).toEqual({ text: 'Too new to compare', measured: false });
    expect(change(4, { state: 'unknown' })).toEqual({ text: 'Couldn’t compare', measured: false });
    // A board-api older than #962 sends none, which is not "no change".
    expect(change(4, undefined)).toEqual({ text: 'Couldn’t compare', measured: false });
  });

  it('rides on every read card, off that card’s own figure', () => {
    const issues = issueFlowCard(row({ open: 3, weeks: [{ opened: 1, closed: 0 }] }), NOW, 'read', read(1));
    expect(issues).toMatchObject({ change: { text: '+2' } });
    const prs = prFlowCard({ state: 'read', open: 1, closedMerged: 0, weeks: [{ opened: 1, merged: 0 }] }, read(4));
    expect(prs).toMatchObject({ change: { text: '−3' } });
    const ci = ciSpendCard({ state: 'read', weeks: [{ minutes: 9, netUsd: 1 }] }, read(1));
    expect(ci).toMatchObject({ change: { text: 'No change' } });
  });
});

describe('the issue flow card (#575)', () => {
  it('leads with the open count and totals the window underneath', () => {
    const card = issueFlowCard(row({ open: 3, weeks: [{ opened: 4, closed: 2 }, { opened: 1, closed: 3 }] }), NOW);
    expect(card).toMatchObject({ kind: 'read', figure: '3', opened: 5, closed: 5 });
    // No unit word rides with the figure: the card's header says what it is,
    // and "3 open" under a header reading "Issues" would say "issue" twice.
    expect(card).not.toHaveProperty('unit');
  });

  it('says what is absent in words when nothing opened or closed all window', () => {
    // Never a flat line through zero: that draws as a measurement, and there
    // was nothing to measure.
    const card = issueFlowCard(row({ pushedAt: ago(14) }), NOW);
    expect(card.kind).toBe('nothing');
    if (card.kind !== 'nothing') return;
    // …and it says the repo is alive, which its empty queue does not (#572).
    expect(card.line).toBe('Nothing opened or closed. Pushed 2 weeks ago.');
  });

  it('leaves the window to the line above the cards (#961)', () => {
    // That line names it for every card on the page. Named here as well, it was
    // drawn two rows under itself, which is the duplication #961 was filed over.
    const card = issueFlowCard(row({ pushedAt: ago(14) }), NOW);
    expect(card.kind !== 'read' && card.line).not.toContain('10 weeks');
  });

  it('says a repo has never been pushed to, which is a fact and not a silence', () => {
    expect(issueFlowCard(row({ pushedAt: null }), NOW)).toEqual({
      kind: 'nothing', line: 'Nothing opened or closed. Never pushed to.',
    });
  });

  it('claims nothing about a push the payload did not answer', () => {
    // board-web routinely ships ahead of board-api, and while it does every row
    // arrives without the field. Silence is the only honest thing to say about
    // a fact you were not sent — the clause is dropped, not guessed.
    const noField = row();
    delete (noField as Partial<RepoRow>).pushedAt;
    expect(issueFlowCard(noField, NOW)).toEqual({
      kind: 'nothing', line: 'Nothing opened or closed.',
    });
  });

  // #837. The Issues tab gained the third answer and this card did not, so the
  // Overview said "Nothing opened or closed in the last 10 weeks" one click away from
  // the tab saying the read failed — about the SAME ingest read, on the same
  // page. Both halves of this card come from that read: an unread repo
  // contributes no rows, so every week is zero for the reason the list is empty.
  it('says the read FAILED rather than reading its zeros as a quiet quarter', () => {
    expect(issueFlowCard(row({ pushedAt: ago(14) }), NOW, 'unreadable')).toEqual({
      kind: 'unreadable', line: ISSUES_UNREADABLE,
    });
  });

  it('says so even where the payload carries counts, because the read is what failed', () => {
    // Belt and braces: `repo.weeks` is rolled up from the ingest that failed, so
    // it reads zero in practice. If it ever does not, a figure drawn off a read
    // that failed is the one thing this card may not do.
    const card = issueFlowCard(row({ open: 3, weeks: [{ opened: 4, closed: 2 }] }), NOW, 'unreadable');
    expect(card.kind).toBe('unreadable');
  });

  it('keeps today’s answer for a payload that carries no state at all', () => {
    // A board-api older than #837 sends no `openIssuesState`, and absent is a
    // fact about the payload rather than about the read. Inventing an outage
    // over every page is the same defect this issue fixes, pointing the other
    // way.
    expect(issueFlowCard(row({ pushedAt: null }), NOW, undefined).kind).toBe('nothing');
    expect(issueFlowCard(row({ open: 3, weeks: [{ opened: 1, closed: 0 }] }), NOW, 'read').kind).toBe('read');
  });
});

describe('the pull-request card (#575)', () => {
  it('leads with what is open, and names no second window beside it', () => {
    const pr: RepoPrFlow = {
      state: 'read', open: 1, closedMerged: 312,
      weeks: [{ opened: 3, merged: 2 }, { opened: 5, merged: 6 }],
    };
    // ONE window on the card: the header and the totals are both ten weeks, so
    // the all-time closed count does not ride the headline. Only the open count
    // does, and that is a right-now fact rather than a window.
    expect(prFlowCard(pr)).toMatchObject({ kind: 'read', figure: '1' });
    expect(prFlowCard(pr)).not.toHaveProperty('unit');
  });

  it('draws a window the read never reached as unknown, never as zero', () => {
    // A busy repo exhausts the read's cap inside a fortnight, and reporting the
    // rest as zero invents a quiet quarter.
    const pr: RepoPrFlow = { state: 'read', open: 1, closedMerged: 9, weeks: [null, { opened: 5, merged: 6 }] };
    const card = prFlowCard(pr);
    expect(card.kind).toBe('read');
    if (card.kind !== 'read') return;
    expect(card.covered).toEqual([{ opened: 5, merged: 6 }]);
    expect(card.uncovered).toBe(1);
  });

  it('says the unread stretch in a sentence, agreeing in number', () => {
    // The chart draws only the weeks that WERE read, so the ones that were not
    // have to be said somewhere or it quietly means a shorter window than the
    // line above the cards names. A sentence of its own since #961 took away
    // the totals it used to hang off. Both branches live here rather than in
    // the JSX: the page's rule is that a component may choose a class and may
    // not compose a string, and a grammar rule written in a component is a rule
    // this file cannot reach.
    expect(uncoveredNote(1)).toBe('1 earlier week was not read.');
    expect(uncoveredNote(3)).toBe('3 earlier weeks were not read.');
  });

  it('says nothing at all where the read reached the whole window', () => {
    // Not an empty string: the caller renders this straight, and `null` is the
    // clause being absent rather than a clause that came out blank.
    expect(uncoveredNote(0)).toBeNull();
  });

  it('says so in words when the repo has no pull requests at all', () => {
    expect(prFlowCard({ state: 'read', open: 0, closedMerged: 0, weeks: [] })).toEqual({
      kind: 'nothing', line: 'No pull requests in this repo.',
    });
  });

  it('tells a read that failed from a repo that has none', () => {
    // "could not find out" is worth a retry; "there are none" is not.
    expect(prFlowCard({ state: 'unreadable' })).toEqual({
      kind: 'unreadable', line: 'Pull requests couldn’t be read just now.',
    });
  });
});

describe('CI spend — the week that ran for nothing (#582)', () => {
  // The measure is net billed USD, and net cost is $0.00 both for a week that
  // ran nothing AND for a week whose real work the org's included-minutes
  // allowance absorbed. Measured: acme-docs ran 53, 303 and 94 minutes in
  // three consecutive weeks and was billed $0.00 for all three. A dollars-only
  // chart draws those three weeks exactly like three silent ones.
  it('tells the three states of a week apart', () => {
    expect(ciWeekKind({ minutes: 0, netUsd: 0 })).toBe('idle');
    expect(ciWeekKind({ minutes: 53, netUsd: 0 })).toBe('free');
    expect(ciWeekKind({ minutes: 400, netUsd: 4.12 })).toBe('billed');
  });

  it('marks the free weeks, so they cannot draw as silence', () => {
    const spend: RepoCiSpend = {
      state: 'read',
      weeks: [{ minutes: 0, netUsd: 0 }, { minutes: 53, netUsd: 0 }, { minutes: 400, netUsd: 4.12 }],
    };
    const card = ciSpendCard(spend);
    expect(card.kind).toBe('read');
    if (card.kind !== 'read') return;
    // The dollars are the trend; the free weeks are marked ON the baseline the
    // dollars line sits at, at the index they happened.
    expect(card.free).toEqual([1]);
    expect(card.figure).toBe('$4.12');
    expect(card.note).toBe('1 week used the included allowance; $0 was billed for that work');
  });

  it('says nothing about free weeks when every week was billed or idle', () => {
    const card = ciSpendCard({ state: 'read', weeks: [{ minutes: 0, netUsd: 0 }, { minutes: 9, netUsd: 1 }] });
    expect(card.kind).toBe('read');
    if (card.kind !== 'read') return;
    expect(card.free).toEqual([]);
    expect(card.note).toBeNull();
  });

  it('a window that ran only inside the allowance still says it ran', () => {
    // $0.00 total, and the card must NOT read as "no CI" — this is the whole
    // reason minutes travel beside the dollars.
    const card = ciSpendCard({ state: 'read', weeks: [{ minutes: 53, netUsd: 0 }, { minutes: 303, netUsd: 0 }] });
    expect(card.kind).toBe('read');
    if (card.kind !== 'read') return;
    expect(card.figure).toBe('$0.00');
    expect(card.note).toBe('2 weeks used the included allowance; $0 was billed for that work');
  });

  it('says so in words when nothing ran at all', () => {
    expect(ciSpendCard({ state: 'read', weeks: [{ minutes: 0, netUsd: 0 }] })).toEqual({
      kind: 'nothing', line: 'No CI ran.',
    });
  });

  it('tells a billing report that could not be read from a repo with no CI', () => {
    expect(ciSpendCard({ state: 'unreadable' })).toEqual({
      kind: 'unreadable', line: 'CI spend couldn’t be read just now.',
    });
  });

  it('formats money to the cent, because a rounded dollar hides the whole point', () => {
    expect(usd(0)).toBe('$0.00');
    expect(usd(4.125)).toBe('$4.13');
    expect(usd(1383.4)).toBe('$1,383.40');
  });
});

describe('what one week of a repo-page chart reads (#877)', () => {
  /**
   * The board's one chart grammar: WHEN first, a comma, then the hero series
   * before the one it is read against, the pair joined with "and".
   * `dashboard/trend-chart.ts` says the same sentence for Throughput and this
   * page takes `weekAgoLabel` from there rather than spelling "3w ago" its own
   * way, which is the drift #708 found between two charts saying one thing.
   */
  it('says the pair in the board’s one grammar, hero first', () => {
    expect(weekPairHint(3, 11, 'closed', 19, 'opened')).toBe('3 weeks ago, 11 closed and 19 opened');
    expect(weekPairHint(1, 4, 'merged', 6, 'opened')).toBe('1 week ago, 4 merged and 6 opened');
    // The trailing week is "this week", not "0 weeks ago".
    expect(weekPairHint(0, 2, 'closed', 0, 'opened')).toBe('this week, 2 closed and 0 opened');
  });

  /**
   * THE CI CHART'S THREE WEEKS, which is the reason it wanted a pointer at all.
   *
   * A free week and an idle week are the same point on the same baseline, told
   * apart on the chart by a 2x6 tick a reader has to already know the meaning
   * of. In words they are not confusable, and the minutes are a CLAUSE about
   * the one reading rather than a second one — the same reason they are not
   * drawn as a second series.
   */
  it('tells a free week from an idle one in words, not just on the baseline', () => {
    expect(ciWeekHint({ minutes: 400, netUsd: 4.12 }, 2)).toBe('2 weeks ago, $4.12 net billed');
    expect(ciWeekHint({ minutes: 53, netUsd: 0 }, 0))
      .toBe('this week, $0.00 net billed, 53 minutes inside the allowance');
    expect(ciWeekHint({ minutes: 0, netUsd: 0 }, 1)).toBe('1 week ago, no CI ran');
    // One minute is one minute. The plural rule is `plural`'s, shared with the
    // card's own note, so the two cannot disagree.
    expect(ciWeekHint({ minutes: 1, netUsd: 0 }, 4))
      .toBe('4 weeks ago, $0.00 net billed, 1 minute inside the allowance');
  });

  /** ONE reading takes the comma; a PAIR takes "and". That is the one place the
   *  grammar splits, and it splits on how many counts a chart reports — so the
   *  CI sentence must not grow an "and" by being written beside the flow one. */
  it('keeps the comma for the chart that reports one reading', () => {
    expect(ciWeekHint({ minutes: 400, netUsd: 4.12 }, 2)).not.toContain(' and ');
    expect(weekPairHint(2, 1, 'closed', 1, 'opened')).toContain(' and ');
  });
});

describe('an open issue row (#575, #826)', () => {
  it('ages the issue by when it was opened, in the one wording every row takes', () => {
    // Every row in this block is open, so there is no closing to choose
    // between: `closed …` is not a sentence this page can print any more.
    expect(issueAge(ago(1), NOW)).toBe('opened yesterday');
    expect(issueAge(ago(2), NOW)).toBe('opened 2 days ago');
  });

  it('reads in hours inside a day, and in weeks past a fortnight', () => {
    expect(issueAge(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('opened 3 hours ago');
    expect(issueAge(ago(21), NOW)).toBe('opened 3 weeks ago');
  });
});

describe('the readme (#575)', () => {
  it('renders what was read', () => {
    expect(readmeCard({ state: 'present', markdown: '# Board' })).toEqual({ kind: 'read', markdown: '# Board' });
  });

  it('a repo with no readme reads as nothing, never as an error', () => {
    expect(readmeCard({ state: 'absent' })).toEqual({ kind: 'nothing', line: 'No readme.' });
  });

  it('a readme that could not be read says which of the two it is', () => {
    expect(readmeCard({ state: 'unreadable' })).toEqual({
      kind: 'unreadable', line: 'The readme couldn’t be read just now.',
    });
  });

  it('an empty file is nothing to render, not a blank block', () => {
    expect(readmeCard({ state: 'present', markdown: '   ' })).toEqual({ kind: 'nothing', line: 'No readme.' });
  });
});

describe('a repo this board does not carry (#575 follow-up)', () => {
  // Not an error page: a repo that is not here. It gets a state — a heading, a
  // sentence, and the way back said as a way back — rather than one line of the
  // page's smallest, dimmest type.
  it('names what happened and offers the way back', () => {
    expect(missingRepo('not-found', 'acme', 'not-a-repo')).toEqual({
      heading: 'Not on this board',
      line: 'acme/not-a-repo isn’t a repo this board carries.',
      back: 'Back to Repos',
    });
  });

  it('tells a repo that is absent from a read that failed', () => {
    // One is permanent and one is worth another go; they must not share words.
    expect(missingRepo('error', 'acme', 'board')).toEqual({
      heading: 'Couldn’t read this repo',
      line: 'acme/board couldn’t be read just now.',
      back: 'Back to Repos',
    });
  });
});

describe('the open-issues block’s count and its way to the rest (#575 DoD, #826)', () => {
  // Measured on `github-runner`: the header read "0 open · Open the issue
  // queue" above "No issues in this repo." — a live link into an empty filtered
  // queue, and the one thing on an empty page promising something.
  it('counts the open ones and offers the rest when the cap hid some', () => {
    // Six open, five drawn: one is behind the row, so the row is worth drawing.
    expect(openIssuesHead(6, 5)).toEqual({ meta: '6 open', showAll: 'Show all 6 open issues' });
  });

  it('offers nothing more when every open issue is already on screen', () => {
    // The count still stands — three open is a fact about the repo — but the
    // row underneath promised three rows to a reader looking at three rows.
    // Shipped that way in #826, where the gate was `open > 0` for both halves.
    expect(openIssuesHead(3, 3)).toEqual({ meta: '3 open', showAll: null });
    expect(openIssuesHead(1, 1)).toEqual({ meta: '1 open', showAll: null });
  });

  it('offers neither when nothing is open', () => {
    // The destination is this board's OPEN-issue queue: with nothing open the
    // count is a zero dressed as a count and the link lands in an empty
    // filtered list.
    expect(openIssuesHead(0, 0)).toEqual({ meta: null, showAll: null });
  });

  it('says it in the singular for one, because the row is a sentence', () => {
    // The count is the repo's whole open count, so the noun agrees with `open`
    // and not with what the cap hid: six drawn of seven open is still plural.
    // Singular therefore needs one open issue and no row drawn for it — which
    // is what a payload carrying no list at all leaves the block holding.
    expect(openIssuesHead(1, 0)).toEqual({ meta: '1 open', showAll: 'Show all 1 open issue' });
    expect(openIssuesHead(7, 6).showAll).toBe('Show all 7 open issues');
  });
});
