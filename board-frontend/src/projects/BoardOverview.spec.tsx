import { describe, expect, it, vi } from 'vitest';
// Vite's `?raw`, the route `App.spec.ts` uses: this package carries no node types.
import PROJECTS_VIEW_SOURCE from './ProjectsView.tsx?raw';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardOverview } from './ProjectsView';
import { projectViewerKeys } from './viewer-key';
import type { ViewerIssue } from '../issues-viewer/viewer-issue';
import type { FilterOptions } from '../api/issues';
import type { ProjectDetail } from '../api/projects';
import type { HeldHeader } from './held-header';
import { boardMark } from './projects-last-good';

/**
 * THE VIEWER IS STOOD IN FOR, and it has to be: `useViewerState` reads the URL
 * through `useSyncExternalStore` (`src/location-search.ts`) with no
 * `getServerSnapshot`, and React refuses to server-render that at all — the
 * whole file failed to collect before this mock existed, not one assertion in
 * it. It is also the right line to cut on. What this page owns is WHICH state
 * it draws and what it hands the viewer; what the viewer draws is
 * `IssuesViewer`'s own to prove, and it has its own specs.
 *
 * The stand-in renders its props, so the handover is testable rather than
 * merely unbroken: the titles it was given, and the arrangement keys, default
 * view and source board this page is documented to pass it.
 */
vi.mock('../issues-viewer/IssuesViewer', () => ({
  IssuesViewer: (props: {
    issues: ViewerIssue[];
    defaultView: string;
    persistKey: readonly string[];
    sourceProject?: number;
    sourceProjectOrg?: string;
  }) => (
    <div
      data-viewer="stand-in"
      data-default-view={props.defaultView}
      data-persist-key={props.persistKey.join(' ')}
      data-source-project={String(props.sourceProject)}
      data-source-project-org={String(props.sourceProjectOrg)}
    >
      {props.issues.map((i) => (
        <span key={`${i.repo}#${i.number}`}>{i.title}</span>
      ))}
    </div>
  ),
}));

/**
 * The board page's three states, rendered (#788).
 *
 * WHAT THIS IS FOR. `/projects/:number` is the whole projects tab since #785
 * deleted the rollup, and nothing rendered it: `ProjectsView.spec.tsx` reaches
 * `BoardHeader` and `HeaderSkeleton` and stops there, and
 * `check-phone-overflow.mjs`'s PAGES were `/team` and `/`, so no browser check
 * loaded a board either. A change that blanked the board, dropped its H1 or
 * threw on a board with no issues on it shipped green.
 *
 * The board's test env is `node` (no DOM), so — same rationale as
 * `ProjectBlock.spec.tsx` — render to a static HTML string and assert against
 * the markup rather than pull in jsdom + RTL.
 *
 * WHAT A STATIC RENDER CANNOT SAY, said here rather than left for the reader to
 * find out: no effect fires in this suite, so nothing below
 * proves the page ever REACHES any of these states — that is `Overview`'s
 * fetching, and it is why `BoardOverview` takes the state as props at all. What
 * these do hold is that each state draws what it claims to, which is the half
 * that had nothing on it.
 */

const ITEMS: ProjectDetail['items'] = [
  {
    repo: 'acme/board.example.com',
    number: 741,
    title: 'A dead session behind an open panel says nothing',
    url: 'https://github.com/acme/board.example.com/issues/741',
    status: 'In Progress',
    state: 'open',
    assignees: ['octocat'],
    prs: [],
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-20T09:00:00.000Z',
  },
  {
    repo: 'acme/board.example.com',
    number: 808,
    title: 'The expired-session panel guard has no proof it can refuse',
    url: 'https://github.com/acme/board.example.com/issues/808',
    status: 'Todo',
    state: 'closed',
    closedAt: '2026-08-28T12:00:00.000Z',
    assignees: [],
    prs: [{ number: 810, url: 'https://github.com/acme/board.example.com/pull/810' }],
    createdAt: '2026-08-10T09:00:00.000Z',
    updatedAt: '2026-08-28T12:00:00.000Z',
  },
];

/** One board, as the detail route serves it. `pct` is 50 because one of the two
 *  items above is closed — a fixture whose completion disagrees with its own
 *  items would let the ring assert a number nothing on the page supports. */
const BOARD: ProjectDetail = {
  org: 'acme',
  number: 7,
  name: 'Board hardening',
  url: 'https://github.com/orgs/acme/projects/7',
  status: 'active',
  open: 1,
  closed: 1,
  pct: 50,
  lastClosed: {
    repo: 'acme/board.example.com',
    number: 808,
    title: 'The expired-session panel guard has no proof it can refuse',
    url: 'https://github.com/acme/board.example.com/issues/808',
    by: 'octocat',
    atISO: '2026-08-28T12:00:00.000Z',
  },
  items: ITEMS,
};

const NO_OPTIONS: FilterOptions = { labels: [], assignees: [], projects: [] };

/** The page in one state, as markup. The props are the state — that is the
 *  whole point of the split this file is written against. */
function render(state: {
  detail: ProjectDetail | null; err: string | null; held?: HeldHeader | null; mark?: ReturnType<typeof boardMark>;
}): string {
  return renderToStaticMarkup(
    <BoardOverview number={BOARD.number} org={BOARD.org} options={NO_OPTIONS} {...state} />,
  );
}

/** The words a reader actually sees — attributes and class names stripped out,
 *  so asserting on the page's text is not defeated by a class that happens to
 *  contain it. The same reader `ProjectsView.spec.tsx` uses. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('a board page while its read is still out', () => {
  const LOADING = boardMark('loading', null);
  const html = render({ detail: null, err: null, mark: LOADING });

  it('draws the skeleton, and says so to a reader who is not looking at it', () => {
    // `aria-busy` and the label are the only things on this state a screen
    // reader is handed, so they are the state rather than decoration on it.
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading project"');
  });

  it('says the word too, for the reader who turned the pulse off', () => {
    // #1251 review, F2. `motion-reduce:animate-none` is what a reader who asked
    // for less motion gets, and it leaves this state and the failed one with
    // the same seventeen still placeholders. The word is what separates them
    // when the pulse cannot — which is what #1236's own cards do.
    expect(textOf(html)).toContain('Loading');
    expect(html).toContain('role="status"');
  });

  it('holds the header’s silhouette, so nothing shifts when the board lands', () => {
    // The ring and the title, plus the five shimmering rows under them. The
    // count is the claim `HeaderSkeleton` is written to make — the same two
    // shapes as the header — and a skeleton that stopped standing in for the
    // header would change it.
    expect(html.match(/animate-pulse/g) ?? []).toHaveLength(2 + 5 * 3);
  });

  it('names no board, because it has not been told one yet', () => {
    // The mark and nothing else: no name, no figure, no count. What the page
    // has to say about itself is that it is still reading.
    expect(textOf(html)).toBe('Loading');
  });
});

describe('a board page whose read is still out, on a board the rollup names', () => {
  // #879 — the first open of a board has nothing under its own key, and the
  // boards rollup on disk already carries its name, number, link and
  // completion. `heldHeader` decides whether it may be used; this is what the
  // page does with it once it may.
  const HELD: HeldHeader = { name: BOARD.name, number: BOARD.number, url: BOARD.url, pct: BOARD.pct };
  const html = render({ detail: null, err: null, held: HELD, mark: boardMark('loading', null) });

  it('leads with the board it already knows, rather than a nameless silhouette', () => {
    expect(textOf(html)).toContain(BOARD.name);
    expect(html).toContain(`href="${BOARD.url}"`);
  });

  it('is still loading, and still says so', () => {
    // The header is real and the items are not. A page that stopped saying
    // `aria-busy` here would be telling a screen reader the board had arrived.
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading project"');
  });

  it('shimmers the rows and no longer the header', () => {
    // Fifteen, not the seventeen the nameless state draws: the ring and the
    // title are the two that stop shimmering.
    expect(html.match(/animate-pulse/g) ?? []).toHaveLength(5 * 3);
  });

  it('states the completion it was given, and states it once', () => {
    expect(textOf(html)).toContain(`${BOARD.pct}%`);
    expect(textOf(html).match(new RegExp(`${BOARD.pct}%`, 'g')) ?? []).toHaveLength(1);
  });

  it('says nothing about the issues on the board, having none to say', () => {
    // A synthesized empty list would put "No issues on this board" under the
    // header of every board opened for the first time — the false zero #714
    // took a whole page down for.
    expect(textOf(html)).not.toContain('No issues on this board');
    expect(html).not.toContain('data-viewer="stand-in"');
  });

  it('is dropped the moment the board’s own read fails, so nothing is drawn over the message', () => {
    const failed = render({ detail: null, err: 'projects 500', held: HELD });
    expect(textOf(failed)).toBe("Couldn’t load this board. Reload the page to try again.");
    expect(failed).not.toContain(BOARD.name);
  });

  it('is dropped the moment the board’s own read lands, so the board answers for itself', () => {
    const landed = render({ detail: BOARD, err: null, held: { ...HELD, name: 'A name the rollup went stale on' } });
    expect(textOf(landed)).toContain(BOARD.name);
    expect(textOf(landed)).not.toContain('A name the rollup went stale on');
  });
});

describe('a board page whose read failed', () => {
  const html = render({ detail: null, err: 'projects 500' });

  it("says what could not load and what to do, and never the route or the status (#979)", () => {
    // `err` is api.ts's own string, "projects 500". #1055 took that off the five
    // surfaces that used to end their sentence on it; this page kept it until
    // #979. `logLoadFailure` is where it goes now.
    expect(textOf(html)).toBe("Couldn’t load this board. Reload the page to try again.");
    expect(textOf(html)).not.toContain('projects 500');
  });

  it('draws neither the skeleton nor a board, so nothing states figures nobody has', () => {
    // The state that shipped before #824 drew the previous board's items over a
    // failure. This is the assertion that a failed read is a failed read.
    expect(html).not.toContain('animate-pulse');
    expect(html).not.toContain(BOARD.name);
  });
});

/**
 * Every read that sets `err` also logs it (#1103 review, S1).
 *
 * The page has THREE reads that can fail — the identity load, the 2-minute
 * refresh and the access-epoch re-read — and since #979 none of them draws `err`
 * on the screen: the reader gets `loadFailureText`'s sentence and the route name
 * and status go to the console. Two of the three set `err` without logging, so
 * the detail reached nobody at all.
 *
 * Read off the source rather than driven, and deliberately: the suite has no
 * DOM, so no effect fires here and the only thing a spec can hold
 * about an effect is the shape of the code in it. The source read is the house
 * pattern `App.spec.ts` already uses for a rule no render can reach.
 */
describe('the board page keeps the developer’s half of every failed read (#979)', () => {
  const SOURCE: string = PROJECTS_VIEW_SOURCE;

  it('logs the failure’s own words from every read that can swallow one', () => {
    // Anchored on the rejection HANDLER rather than on the line that sets
    // `err` (#1249): two of the three reads set it through `failed` now, so a
    // spec looking for a log within a few lines of the setter would be looking
    // in the wrong function. The rule it was written for is unchanged — a read
    // that swallows a failure writes it to the console — and it is the handler
    // that either keeps or loses the detail.
    const handlers = SOURCE.split('if (!alive || own !== readSequence.current) return;').slice(1);
    expect(handlers, 'three reads, three rejection handlers').toHaveLength(3);
    for (const handler of handlers) expect(handler.slice(0, handler.indexOf('\n    }'))).toContain('logLoadFailure(BOARD_SUBJECT');
    // And the words are never drawn: `loadFailureText` branches on them and
    // writes its own sentence, so the console is the only place they land.
    expect(SOURCE).toContain('loadFailureText(BOARD_SUBJECT, err)');
  });
});

describe('a board page with a board on it', () => {
  const html = render({ detail: BOARD, err: null });

  it('leads with the board: its name, its id, and the link out to Github', () => {
    const h1 = /<h1\b[^>]*>[\s\S]*?<\/h1>/.exec(html)?.[0] ?? '';
    expect(h1).toContain('Board hardening');
    expect(h1).toContain('#7');
    expect(h1).toContain(`href="${BOARD.url}"`);
  });

  it("states the board's completion once, off the board's own pct", () => {
    // One number, from one field — `BoardHeader`'s `pct` is documented as the
    // same field every other ring on the board reads, "so one board can't report
    // two numbers".
    expect(html.match(/50%/g) ?? []).toHaveLength(1);
  });

  it('hands the board’s own items to the viewer, both states of them', () => {
    const text = textOf(html);
    for (const item of ITEMS) expect(text).toContain(item.title);
  });

  it('opens the board in board view, keyed to this board and no other', () => {
    // The three props this page is documented to pass, asserted where they land
    // rather than read back out of the source. `persistKey` is a LIST — the
    // pre-#697 key sits behind the current one so nobody's stored grouping went
    // missing the day the org went into it — and `projectViewerKeys` is asked
    // for it here rather than the shape being retyped.
    expect(html).toContain('data-default-view="board"');
    expect(html).toContain(`data-persist-key="${projectViewerKeys(BOARD.number, BOARD.org).join(' ')}"`);
    expect(html).toContain(`data-source-project="${BOARD.number}"`);
    expect(html).toContain(`data-source-project-org="${BOARD.org}"`);
  });

  it('is not the skeleton and is not an error', () => {
    expect(html).not.toContain('aria-busy="true"');
    expect(textOf(html)).not.toContain("Couldn’t load this board");
  });
});

/**
 * The three states a board page can be in when its read did not simply land,
 * and the MARK that tells them apart (#1107, #1249).
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT, because the difference is the whole
 * reason `check-board-copy.mjs` exists beside it. This file renders a prop into
 * markup, so it proves each state draws what it claims to and that no two of
 * them are drawn at once. It cannot prove that the page ever REACHES a state:
 * no effect fires in this suite, and which failures leave a
 * board standing is decided in one. The browser guard drives every answer
 * board-api can give this route and reads the states off a real screen; that is
 * where the behaviour is proved.
 *
 */
describe('a board a failed read left drawn (#1107, #1249)', () => {
  const AT = Date.parse('2026-09-21T12:00:00.000Z');
  const NOW = AT + 12 * 60_000;
  const COPY = boardMark('saved', AT, NOW);
  const UNDATED = boardMark('saved', null, NOW);

  it('marks the board as a copy, and says how old the copy is', () => {
    expect(COPY?.text).toBe('Saved copy 12 minutes ago');
    expect(textOf(render({ detail: BOARD, err: null, mark: COPY }))).toContain('Saved copy 12 minutes ago');
  });

  it('gives a screen reader the same copy age as the visible mark', () => {
    expect(COPY?.label).toBe('Saved copy 12 minutes ago');
    expect(render({ detail: BOARD, err: null, mark: COPY })).toContain(`aria-label="${COPY?.label}"`);
  });

  it('falls back to the undated sentence when no saved record dates the board', () => {
    expect(UNDATED?.text).toBe('Saved copy');
    expect(UNDATED?.label).toBe('Saved copy');
  });

  it('keeps the board it is about, rather than standing in for it', () => {
    const text = textOf(render({ detail: BOARD, err: null, mark: COPY }));
    expect(text).toContain(BOARD.name);
    for (const item of ITEMS) expect(text).toContain(item.title);
  });

  it('is a live region, so a reader who is not watching is told', () => {
    expect(render({ detail: BOARD, err: null, mark: COPY })).toContain('role="status"');
  });

  it('is not drawn over a read that was refused', () => {
    // The state a copy claim would lie in: `err`'s arm returns before the
    // board, so there is no copy on this screen to be showing. Passed here
    // anyway, because a caller confusing the two is the mistake worth catching.
    expect(textOf(render({ detail: null, err: 'projects 503', mark: COPY })))
      .toBe('Couldn’t load this board. Reload the page to try again.');
  });

  it('takes no room on a board whose reads are landing', () => {
    // Always mounted AND always rendered, so the live region is one a screen
    // reader was already watching rather than one inserted when it fills.
    // `display:none` would take it out of the accessibility tree, and a
    // zero-width span would still take the header row's 18px flex gap out of
    // every live board's title, so the empty state cancels that gap instead.
    const html = render({ detail: BOARD, err: null });
    expect(html).toContain('empty:-ml-[18px]');
    expect(html).not.toContain('empty:hidden');
    expect(html).toContain('role="status"');
    expect(textOf(html)).not.toContain('Saved copy');
    expect(textOf(html)).not.toContain('Unavailable');
  });
});

/**
 * A READ THAT FAILED WITH NOTHING TO SHOW, which is the state #1216 is about
 * (#1249).
 *
 * The mistake this is written against shipped once already: a Repos card whose
 * issue read failed drew a chart asserting zero activity over ten weeks. On a
 * board page the same mistake is a board drawn at 0% with "No issues on this
 * board" under it. So the rule is that nothing number-shaped is drawn at all —
 * the shape of a board, holding none of its figures, marked `Unavailable`.
 *
 * It is the loading state's own shape on purpose, and `mark` is the whole of
 * what separates them. Same boxes in the same places, so nothing moves if the
 * next read lands; a pulse while a read is running and none when it is not,
 * which is #1236's rule and reads as "wait" against "this is not coming".
 */
describe('a board whose read failed with nothing saved (#1216, #1249)', () => {
  const GONE = boardMark('unreadable', null);
  const html = render({ detail: null, err: null, mark: GONE });

  it('says it is unavailable, and says the whole sentence to a screen reader', () => {
    expect(GONE).toEqual({ text: 'Unavailable', label: 'This board couldn’t be read just now.', pending: false });
    expect(textOf(html)).toContain('Unavailable');
    expect(html).toContain('aria-label="This board couldn’t be read just now."');
  });

  it('states no figure, counts nothing, and does not call the board empty', () => {
    const text = textOf(html);
    expect(text).not.toContain('No issues on this board');
    expect(text).not.toMatch(/\d+%/);
    expect(text).not.toContain(BOARD.name);
  });

  it('is not drawn as a page that is still loading', () => {
    expect(html).not.toContain('aria-busy="true"');
    expect(html).not.toContain('Loading project');
    expect(html, 'the bars hold still, so nothing says wait').toContain('!animate-none');
  });

  it('is the loading state’s own shape, so nothing moves if a read lands', () => {
    const loading = render({ detail: null, err: null, mark: boardMark('loading', null) });
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('Loading project');
    // And told apart by a WORD and not only by the pulse, because the pulse is
    // what a reduced-motion reader does not get (#1251 review, F2). The browser
    // guard drives that setting; this holds the two words distinct.
    expect(textOf(loading)).toContain('Loading');
    expect(textOf(html)).toContain('Unavailable');
    expect(textOf(loading)).not.toContain('Unavailable');
    // The same boxes, in the same order, with the pulse as the difference.
    const shapes = (markup: string) => (markup.match(/class="[^"]*bg-elevated[^"]*"/g) ?? [])
      .map((c) => c.replace('!animate-none ', '').replace('motion-reduce:animate-none ', ''));
    expect(shapes(html)).toEqual(shapes(loading));
  });
});

/**
 * The HEADER a failed read can still prove, out of the rollup's saved copy
 * (#879, #1249 item 2).
 *
 * The one state with a real board name and no board under it. It is marked as a
 * copy, because the name is one; the items are the still placeholders above,
 * because `heldHeader` returns no `items` and nothing synthesizes an empty list.
 */
describe('a board named by the saved rollup (#879)', () => {
  const HELD: HeldHeader = { name: 'Board hardening', number: 7, url: 'https://github.com/orgs/acme/projects/7', pct: 50 };
  const html = render({ detail: null, err: null, held: HELD, mark: boardMark('saved', Date.now() - 60_000) });

  it('names the board it can prove, and marks the name as a copy', () => {
    expect(textOf(html)).toContain('Board hardening');
    expect(textOf(html)).toContain('Saved copy 1 minute ago');
  });

  it('does not call the board empty, and is not drawn as still loading', () => {
    expect(textOf(html)).not.toContain('No issues on this board');
    expect(html).not.toContain('aria-busy="true"');
  });
});

describe('a board with nothing on it', () => {
  // A real state — a board that has just been made, or one whose items are all
  // pull requests and drafts, which this surface does not count. It has to read
  // as an empty board rather than as a board still loading, which is what a
  // page that fell back to its skeleton on an empty list would say.
  const html = render({ detail: { ...BOARD, items: [], open: 0, closed: 0, pct: 0 }, err: null });

  it('says the board is empty, and still names the board', () => {
    expect(textOf(html)).toContain('No issues on this board.');
    expect(textOf(html)).toContain('Board hardening');
  });

  it('does not fall back to the skeleton', () => {
    expect(html).not.toContain('aria-busy="true"');
  });
});
