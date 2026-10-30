/**
 * SCRATCH — preview-only (#722). Four columns of the same four boards: what the
 * board draws today, and the three answers to what a board the source could not
 * read whole should show for the numbers it keeps. Nothing in the app imports
 * this file.
 *
 * TODAY was the control and was no reproduction: it rendered the real
 * `BoardCard` and the real `ProjectsCard`, against which A, B and C render the
 * copies in `vouch-variants.tsx` — so a column differed from TODAY only where
 * the treatment meant it to, and board 3, which no treatment touches, was
 * asserted identical across all four columns by the screenshot script rather
 * than left to the eye.
 *
 * THE CONTROL IS GONE ON BOTH HALVES. #785 deleted the `/projects` rollup, so
 * `BoardCard` no longer exists and TODAY draws no board cards; the card rows
 * below it are the three treatments with nothing to be identical to. The block
 * row is no better off: the same change rewrote `ProjectsCard`
 * (`dashboard/Pulse.tsx`), whose headline was a `Tip` around a button opening
 * the rollup and is a plain div now, while `VariantProjectsCard` below still
 * carries the button. So TODAY's block row is real but is no longer the same
 * component the variants copy, and the board-3 equality check has nothing left
 * to make. Read A, B and C against each other; nothing here compares a
 * treatment to the app.
 *
 * Same CSS `src/main.tsx` loads and the same theme seed the html carries.
 * `TooltipProvider` because `ProjectsCard` wraps its headline in `Tip`, which
 * throws without one.
 *
 * The columns are `PAGE_RAIL`'s max width — `--grid-container-max`, the
 * container token that `app.css` declares, 1440px today (#783; it was a bare 1180px before
 * that). Written as the same variable the rail is written in, so a column here
 * cannot drift from the measure the Projects page really gives a card. Four of
 * them make the page wider than the viewport on purpose: the card's own
 * breakpoints are VIEWPORT media queries (1140 and 640), so shrinking a column
 * to fit four on a 1440 screen would draw four cards nobody will ever see. The
 * desktop shot scrolls sideways instead, and the phone shot at 390 stacks them.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from './ui/kit';
import '@apliteni/apliteni-ui/tokens';
import '@apliteni/apliteni-ui/accents';
import './app.css';
import type { ProjectSummary } from './api/projects';
import { PAGE_RAIL } from './ui/PageHeading';
import { ProjectsCard } from './dashboard/Pulse';
import { pulseScale } from './projects/pulse';
import { PULSE_ROW, VariantBoardCard, VariantProjectsCard, type Treatment } from './vouch-variants';

try {
  if (localStorage.getItem('board_theme') === null) {
    localStorage.setItem('board_theme', 'dark');
  }
} catch {
  /* storage unavailable — the board is dark by default regardless */
}

/** A close two hours old, computed at load so the recency line reads the same
 *  wording on every run rather than drifting to a date. */
const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();

const ORG = 'acme';
const REPO = 'acme/board.example.com';

/** 1 — READ SHORT, with closes. #722 item 2: a 44% ring asserting beside the
 *  sentence. 7 closed of 16 counted is the issue's own "44% — 7 / 16 issues
 *  closed". */
const READ_SHORT: ProjectSummary = {
  org: ORG,
  number: 7,
  name: 'Board hardening',
  url: 'https://github.com/orgs/acme/projects/7',
  status: 'active',
  open: 9,
  closed: 7,
  pct: 44,
  lastClosed: {
    repo: REPO,
    number: 711,
    title: 'A board header says the board once',
    url: 'https://github.com/acme/board.example.com/issues/711',
    by: 'octocat',
    atISO: twoHoursAgo,
  },
  weeklyClosed: [],
  dailyOpened: [],
  dailyClosed: [],
  itemsComplete: false,
};

/** 2 — READ SHORT BEFORE ANY CLOSE. #722 item 1: "No issues closed yet" printed
 *  directly above "The board cannot vouch for this item list". `closed: 0`
 *  forces `pct: 0` — `completionPct` is `closed / (open + closed)` — which is
 *  why this cannot be the same board as the one above. */
const READ_SHORT_NO_CLOSES: ProjectSummary = {
  org: ORG,
  number: 12,
  name: 'Payments migration',
  url: 'https://github.com/orgs/acme/projects/12',
  status: 'active',
  open: 16,
  closed: 0,
  pct: 0,
  lastClosed: null,
  weeklyClosed: [],
  dailyOpened: [],
  dailyClosed: [],
  itemsComplete: false,
};

/** 3 — READ WHOLE. The control. No treatment may alter this card or this row,
 *  and the screenshot script checks that rather than trusting the drawing. */
const HEALTHY: ProjectSummary = {
  org: ORG,
  number: 3,
  name: 'Acme Go-To-Market',
  url: 'https://github.com/orgs/acme/projects/3',
  status: 'active',
  open: 5,
  closed: 5,
  pct: 50,
  lastClosed: {
    repo: REPO,
    number: 690,
    title: 'Every board reports whether its items were paged to the end',
    url: 'https://github.com/acme/board.example.com/issues/690',
    by: 'octocat',
    atISO: twoHoursAgo,
  },
  weeklyClosed: [1, 0, 2, 3, 1, 4, 2, 0, 3, 4],
  closedThisWeek: 4,
  // 5 closes in the fortnight, 4 of them in the trailing week, so the week
  // figure, the last weekly bucket and the drawn series all agree.
  dailyOpened: [1, 0, 2, 0, 1, 0, 1, 0, 1, 0, 2, 0, 1, 2],
  dailyClosed: [1, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 1],
  itemsComplete: true,
};

/** 4 — READ WHOLE, ORG-WIDE JOIN FAILED. The third state (`pulseJoined`): the
 *  board was read whole, so its ring, its percentage and its open count are
 *  sound, and only the week figure and the day series are missing. Today's
 *  frontend has never heard of the flag, so TODAY's row says "No closes this
 *  week" — a claim about the board where the truth is nobody can say. */
const JOIN_FAILED: ProjectSummary = {
  org: ORG,
  number: 9,
  name: 'Docs revamp',
  url: 'https://github.com/orgs/acme/projects/9',
  status: 'active',
  open: 5,
  closed: 5,
  pct: 50,
  lastClosed: {
    repo: REPO,
    number: 704,
    title: 'The traps file names the guard for every entry',
    url: 'https://github.com/acme/board.example.com/issues/704',
    by: 'octocat',
    atISO: twoHoursAgo,
  },
  weeklyClosed: [],
  dailyOpened: [],
  dailyClosed: [],
  itemsComplete: true,
  pulseJoined: false,
};

const BOARDS = [READ_SHORT, READ_SHORT_NO_CLOSES, HEALTHY, JOIN_FAILED];
/** One scale for every card on the page, as the real rollup does. */
const SCALE = pulseScale(BOARDS);

const COLUMNS: { id: string; cap: string; note: string }[] = [
  {
    id: 'today',
    cap: 'TODAY',
    note: 'The real block, unmodified — board 4 says its week is quiet when nobody read it. Its board cards went with the rollup #785 deleted, and with them board 2 printing its lifetime claim of zero one line above the sentence saying that read cannot be vouched for.',
  },
  {
    id: 'A',
    cap: 'A — FLOORS',
    note: 'Every count stays and is marked as a floor. The ring stops asserting: pct is a ratio of two undercounts and can be wrong high or low, which a count cannot.',
  },
  {
    id: 'B',
    cap: 'B — WITHHOLD',
    note: "The board's name and its state, and nothing else, until the next read.",
  },
  {
    id: 'C',
    cap: 'C — ONE SENTENCE',
    note: 'Every number exactly as today, ring included. One sentence widens from the item list to the whole card.',
  },
];

function Column({ id, cap, note }: { id: string; cap: string; note: string }) {
  const t = id as Treatment;
  return (
    <section data-col={id} className="w-[var(--grid-container-max,1440px)] flex-none max-[1140px]:w-full">
      <div className={PAGE_RAIL}>
        <div className="mb-1 text-[13px] font-semibold tracking-[-0.01em] text-fg">{cap}</div>
        <div className="mb-5 max-w-[560px] text-[12px] leading-[1.5] text-muted">{note}</div>

        <div className="mb-2 text-[11px] text-muted">Projects page — the board cards</div>
        <div data-cards className="flex flex-col gap-3.5">
          {/* TODAY drew the real `BoardCard` from `projects/ProjectsView.tsx`
              here — the control the three copies below were read against. #785
              deleted the `/projects` rollup and `BoardCard` with it, so this
              comparison has lost its control side rather than never having had
              one; A, B and C are now read against each other. The block rows
              below lost theirs in the same change — `ProjectsCard` no longer
              wraps its headline in the `Tip`/button `VariantProjectsCard` still
              draws. */}
          {id !== 'today' &&
            BOARDS.map((p) => <VariantBoardCard key={p.number} p={p} scale={SCALE} t={t} />)}
        </div>

        <div className="mb-2 mt-8 text-[11px] text-muted">Dashboard — the Projects block</div>
        <div data-rows className={PULSE_ROW}>
          {id === 'today' ? <ProjectsCard projects={BOARDS} /> : <VariantProjectsCard projects={BOARDS} t={t} />}
        </div>
      </div>
    </section>
  );
}

function Preview() {
  return (
    <TooltipProvider>
      <div className="min-h-screen bg-surface-2 pb-24 pt-6">
        <div className={`${PAGE_RAIL} mb-8`}>
          <div className="text-[15px] font-semibold text-fg">
            What a board read short shows for the numbers it keeps (#722)
          </div>
          <div className="mt-1.5 max-w-[820px] text-[12.5px] leading-[1.55] text-muted">
            Four boards, the same four in every column: 1 read short with closes, 2 read short before any
            close, 3 read whole and healthy — the control, which must read identically in all four
            columns — and 4 read whole with the org-wide join failed.
          </div>
        </div>
        <div className="flex gap-10 max-[1140px]:flex-col max-[1140px]:gap-14">
          {COLUMNS.map((c) => (
            <Column key={c.id} {...c} />
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
