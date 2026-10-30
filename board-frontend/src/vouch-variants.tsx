/**
 * SCRATCH — preview-only (#722). The three answers to "what does a board the
 * source could not read whole show for the numbers it keeps", drawn beside what
 * the board draws today. Rendered by `vouch-preview.tsx`; nothing in the app
 * imports this file.
 *
 * FOUR BOARDS, the same four in every column, because the three states this
 * decision covers cannot live on one board at once:
 *   1 read short WITH closes  — a 44% ring asserting beside "cannot vouch";
 *   2 read short BEFORE any close — "No issues closed yet" above the same
 *     sentence, which is the worst of them and needs `closed === 0`, and
 *     `completionPct` (board-service/src/projects/project-derive.ts) makes that
 *     board's `pct` 0, so it cannot also be the board with the loud ring;
 *   3 read WHOLE — the control, which no treatment may alter;
 *   4 read whole, org-wide JOIN FAILED (`pulseJoined === false`) — the third
 *     state, whose sentence is the same in all three treatments.
 *
 * THE CONTROL IS CHECKED, NOT EYEBALLED. Board 3 goes through the copied markup
 * below in A, B and C exactly as it goes through the real components in TODAY,
 * and the screenshot script asserts the two are the same HTML. So a treatment
 * that reaches a healthy board fails a check rather than waiting to be noticed.
 *
 * WHAT IS COPIED AND WHY. `Ring`, `BLOCK`, `BlockHeader`, `Tip`, the pulse
 * helpers and `formatWeeklyClosed` are imported from the real modules. The class
 * strings and the spark below are COPIES, because they were module-private to
 * `projects/ProjectsView.tsx`, `projects/ProjectBlock.tsx` and `dashboard/
 * Pulse.tsx` and this lane may not edit those files to export them. Every copy
 * carries the file and the name it came from; the board-3 equality check is what
 * catches a copy that has drifted.
 *
 * THE PROJECTSVIEW COPIES NO LONGER HAVE AN ORIGINAL. #785 deleted the
 * `/projects` rollup, and `BoardCard`, `Spark`, `Excluded`, `Delta`, `Recency`
 * and `MovementNote` went with it, so everything marked below as copied from
 * `projects/ProjectsView.tsx` is a frozen copy of code that is gone rather than
 * a duplicate that can drift from its source. Nothing checks it against
 * anything, and the board-3 equality check cannot: the real card it compared
 * against is what was deleted. The `ProjectBlock.tsx` copies still have their
 * originals. The `Pulse.tsx` one has already drifted: `VariantProjectsCard`
 * keeps the `<Tip label="Open Projects"><button>` headline that opened the
 * rollup, and `ProjectsCard` — which no longer has a rollup to open — is a
 * plain div.
 */
import type { ProjectSummary } from './api/projects';
import { BLOCK } from './ui/block';
import { BlockHeader } from './ui/BlockHeader';
import { Ring } from './ui/ring';
import { Tip } from './ui/Tip';
import { relTime } from './ui/rel-time';
import { routePath } from './route';
import { resolvePerson, usePeople } from './people-ctx';
import { contributionSegments, contributorsOf, ringSegments } from './projects/contributors';
import {
  deltaNote,
  excludedNote,
  firstName,
  hasPulse,
  netLastDay,
  noCloseNote,
  quietNote,
  recencyLine,
} from './projects/pulse';
import { formatWeeklyClosed } from './projects/ProjectBlock';
import { ContributionTip } from './projects/ContributionTip';

/** Which column is being drawn. `today` renders the real components. */
export type Treatment = 'A' | 'B' | 'C';

// ── the state each treatment reads ───────────────────────────────────────────
// `=== false` both times, the spelling `itemsComplete` and `pulseJoined` are
// documented with in api.ts: an ABSENT flag is a board-api that predates it and
// makes no claim, and a truthiness test would treat that as the failure.
const readShort = (p: ProjectSummary) => p.itemsComplete === false;
const joinFailed = (p: ProjectSummary) => p.pulseJoined === false;

// ── the copy, verbatim ───────────────────────────────────────────────────────
const CARD_SENTENCE: Record<Treatment, string> = {
  A: 'The board cannot vouch for this item list. Every count here is a floor, and the share done is left out.',
  B: 'The board cannot vouch for this item list, so its figures are left out until the next read.',
  C: 'The board cannot vouch for this item list, so every figure on this card counts part of it.',
};
const ROW_SENTENCE: Record<Treatment, string> = {
  A: 'The board cannot vouch for these counts',
  B: 'The board cannot vouch for its figures',
  C: 'The board cannot vouch for these figures',
};
/** The join failure's two lines — the same in all three treatments, because it
 *  is not what they differ on. */
const JOIN_CARD = "This week's closes were not read, so movement is left out.";
const JOIN_ROW = "This week's closes were not read";

// ── copied from projects/ProjectsView.tsx, before #785 deleted it ────────────
const CARD_GRID =
  'grid grid-cols-[minmax(0,1fr)_minmax(96px,0.28fr)_130px] items-center gap-x-[22px] gap-y-2.5 p-[20px_24px]';
const CARD_GRID_NARROW = 'max-[1140px]:grid-cols-[minmax(0,1fr)_130px] max-[640px]:grid-cols-1';
const SPARK_CELL =
  'max-[1140px]:hidden max-[640px]:block max-[640px]:row-start-3 max-[640px]:max-w-[200px] max-[640px]:justify-self-end';
const COUNT_CELL =
  'flex flex-col items-end gap-1 max-[640px]:row-start-2 max-[640px]:flex-row max-[640px]:items-baseline max-[640px]:justify-end max-[640px]:gap-x-2';
const SPARK_H = 24;
const BAR_RATIO = 5 / 7;
const MIN_BAR = 2;
const BASELINE_W = 1;
const SPARK_BOX = SPARK_H + BASELINE_W;

/** Copied from projects/ProjectsView.tsx, which #785 deleted. */
function rel(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : relTime(t);
}

/** Copied from projects/ProjectsView.tsx, which #785 deleted. */
function barLen(v: number, scale: number): number {
  return v <= 0 ? 0 : Math.max(MIN_BAR, (v / scale) * SPARK_H);
}

/** Copied from `Spark` in projects/ProjectsView.tsx, which #785 deleted along
 *  with the rollup — this is the only copy of it left. */
function Spark({ p, scale }: { p: ProjectSummary; scale: number }) {
  const closed = p.dailyClosed ?? [];
  const n = Math.max(closed.length, p.dailyOpened?.length ?? 0);
  const step = 100 / n;
  const pct = (v: number) => `${+v.toFixed(3)}%`;
  return (
    <svg width="100%" height={SPARK_BOX} className="block" aria-hidden="true">
      <line
        x1={0}
        y1={SPARK_H + BASELINE_W / 2}
        x2="100%"
        y2={SPARK_H + BASELINE_W / 2}
        stroke="var(--border)"
        strokeWidth={BASELINE_W}
      />
      {[...Array(n).keys()].map((i) => {
        const h = barLen(closed[i] ?? 0, scale);
        if (!h) return null;
        return (
          <rect
            key={i}
            x={pct((i + (1 - BAR_RATIO) / 2) * step)}
            y={+(SPARK_H - h).toFixed(2)}
            width={pct(step * BAR_RATIO)}
            height={+h.toFixed(2)}
            fill="var(--muted)"
          />
        );
      })}
    </svg>
  );
}

/** Copied from `Excluded` in projects/ProjectsView.tsx, which #785 deleted. */
function Excluded({ p }: { p: ProjectSummary }) {
  const note = excludedNote(p.excludedItems);
  if (!note) return null;
  return <div className="mt-1 text-[12px] leading-[1.45] text-muted">{note}</div>;
}

/** Copied from `Delta` in projects/ProjectsView.tsx, which #785 deleted. */
function Delta({ p }: { p: ProjectSummary }) {
  const note = deltaNote(netLastDay(p.dailyOpened ?? [], p.dailyClosed ?? []));
  if (!note) return null;
  return <span className="text-[12px] leading-[1.45] tabular-nums text-muted">{note}</span>;
}

// ── copied from projects/ProjectBlock.tsx ────────────────────────────────────
const ROW =
  'group -mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 no-underline transition-colors hover:bg-elevated';
const boardPath = (p: ProjectSummary) => routePath({ tab: 'projects', org: p.org, project: p.number });

// ── copied from dashboard/Pulse.tsx ──────────────────────────────────────────
const BIGNUM = 'text-[34px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-fg';
export const PULSE_ROW = 'grid grid-cols-3 gap-3 max-[900px]:grid-cols-1';

/**
 * The ring with its track and NOTHING else — no arc and no percentage, which is
 * what A and B do to a board read short. `pct` there is a ratio of two
 * undercounts, so unlike a count it can be wrong in either direction and is not
 * a floor.
 *
 * The four geometry lines are copied from `ui/ring.tsx`, which always paints its
 * label; a preview cannot ask it not to, and this lane may not change it. If the
 * real ring's stroke or radius moves, this stops matching — the treatment that
 * ships would delete the label inside `Ring` instead of copying it out.
 */
function TrackOnlyRing({ size = 66 }: { size?: number }) {
  const stroke = Math.max(4, Math.round(size / 9));
  const r = (size - stroke) / 2;
  const c = size / 2;
  return (
    <div className="relative flex-none" style={{ height: size, width: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={c} cy={c} r={r} fill="none" strokeWidth={stroke} stroke="var(--border)" />
      </svg>
    </div>
  );
}

/** Copied from projects/ProjectsView.tsx's `Recency`, with ONE change: the
 *  lifetime "No issues closed yet" is gated on the read, which is what all three
 *  treatments do. Everything else, including the two lines a board with a close
 *  draws, was the original — #785 deleted `Recency`, so what that original said
 *  is now readable only here. */
function VariantRecency({ p }: { p: ProjectSummary }) {
  const people = usePeople();
  const lc = p.lastClosed;
  if (!lc) {
    const note = readShort(p) ? '' : noCloseNote(p.closed);
    return note ? <div className="mt-[5px] text-[13px] leading-[1.45] text-muted">{note}</div> : null;
  }
  const person = lc.by ? resolvePerson(people, lc.by) : null;
  const who = person ? firstName(person.displayName) : lc.by ? firstName(lc.by) : '';
  const line = recencyLine(who, rel(lc.atISO));
  return (
    <>
      <div className="mt-[5px] truncate text-[13px] leading-[1.45] text-dim">{lc.title}</div>
      {line && <div className="mt-1 truncate text-[12px] text-muted">{line}</div>}
    </>
  );
}

/** What the card says about movement — the treatment's sentence on a board read
 *  short, the join sentence on a board whose join did not run, and otherwise
 *  exactly what `MovementNote` said before #785 deleted it. */
function VariantNote({ p, t }: { p: ProjectSummary; t: Treatment }) {
  // `MovementNote`'s two lines as it drew them, with the lifetime note gated on
  // the read the same way `VariantRecency` gates the sentence it stands for.
  // `MovementNote` itself went with the rollup in #785.
  const neverClosed = readShort(p) || p.lastClosed ? '' : noCloseNote(p.closed);
  const quiet = neverClosed ? '' : quietNote(p.dailyClosed ?? []);
  // A board read short AND join-failed is not in the fixture; the item list is
  // the wider claim, so it would win here.
  const note = readShort(p) ? CARD_SENTENCE[t] : joinFailed(p) ? JOIN_CARD : quiet;
  if (!note) return null;
  return <div className="mt-1 text-[12px] leading-[1.45] text-muted">{note}</div>;
}

/**
 * The Projects-page board card under one treatment. Structure copied from
 * `BoardCard`; a board that is neither read short nor join-failed takes every
 * original branch, which is what made board 3 comparable byte for byte — until
 * #785 deleted `BoardCard`, leaving nothing to compare it to. The three
 * treatments are now read against each other and against this description.
 */
export function VariantBoardCard({ p, scale, t }: { p: ProjectSummary; scale: number; t: Treatment }) {
  const people = usePeople();
  const segments = contributionSegments(contributorsOf(p), people);
  const short = readShort(p);
  /** B takes every figure off a board read short. */
  const withholdAll = t === 'B' && short;
  /** A and B stop the ring asserting; C leaves every number as it is today. */
  const mutedRing = short && t !== 'C';
  /** Today's gate on the spark and the delta, unchanged in all three. */
  const withheld = short;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${p.name} board`}
      className={`${BLOCK} ${CARD_GRID} ${CARD_GRID_NARROW} cursor-pointer transition-colors duration-150 hover:bg-elevated`}
    >
      <div className="flex min-w-0 items-center gap-[18px]">
        {mutedRing ? <TrackOnlyRing /> : <Ring pct={p.pct} segments={ringSegments(segments)} />}
        <div className="min-w-0">
          <span className="block truncate text-[17px] font-semibold leading-[1.3] tracking-[-0.01em]">{p.name}</span>
          {!withholdAll && <VariantRecency p={p} />}
          {!withholdAll && <Excluded p={p} />}
          <VariantNote p={p} t={t} />
        </div>
      </div>

      <div className={SPARK_CELL}>
        {!withheld && !withholdAll && hasPulse(p.dailyClosed ?? []) && <Spark p={p} scale={scale} />}
      </div>

      <div className={COUNT_CELL}>
        {!withholdAll && (
          <>
            <span className="text-[26px] font-[650] leading-none tracking-[-0.02em] tabular-nums text-fg">
              {/* A marks every count as a floor, which is the whole of A. */}
              {short && t === 'A' ? `${p.open}+` : p.open}
            </span>
            <span className="text-[12px] text-muted">open</span>
            {!withheld && <Delta p={p} />}
          </>
        )}
      </div>
    </div>
  );
}

/** The dashboard block's row under one treatment. Structure copied from
 *  `ProjectRow` in projects/ProjectBlock.tsx. */
function VariantRow({ p, t }: { p: ProjectSummary; t: Treatment }) {
  const people = usePeople();
  const segments = contributionSegments(contributorsOf(p), people);
  const short = readShort(p);
  const mutedRing = short && t !== 'C';
  const ring = mutedRing ? (
    <TrackOnlyRing size={34} />
  ) : (
    <Ring pct={p.pct} size={34} segments={ringSegments(segments)} />
  );
  const sub = short
    ? ROW_SENTENCE[t]
    : joinFailed(p)
      ? JOIN_ROW
      : formatWeeklyClosed(p.closedThisWeek ?? 0, p.openedThisWeek ?? 0);
  return (
    <a href={boardPath(p)} onClick={(e) => e.preventDefault()} className={ROW}>
      {segments.length > 0 ? (
        <Tip label={<ContributionTip segments={segments} open={p.open} />}>
          <span className="flex-none">{ring}</span>
        </Tip>
      ) : (
        ring
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-fg">{p.name}</span>
        <span className="mt-0.5 block text-[12px] tabular-nums text-muted">{sub}</span>
      </span>
    </a>
  );
}

/**
 * The dashboard's Projects block under one treatment. Structure copied from
 * `ProjectBlock` + `ProjectsCard`, with the one part that is settled rather than
 * offered: the headline leaves boards read short OUT of its sum and says over
 * how many boards it counted. A board whose join failed stays IN — the join says
 * nothing about `open` and `closed`.
 */
export function VariantProjectsCard({ projects, t }: { projects: ProjectSummary[]; t: Treatment }) {
  const counted = projects.filter((p) => !readShort(p));
  const totalOpen = counted.reduce((s, p) => s + p.open, 0);
  const totalClosed = counted.reduce((s, p) => s + p.closed, 0);
  const total = totalOpen + totalClosed;
  const pct = total === 0 ? 0 : Math.round((totalClosed / total) * 100);
  return (
    <div className={`${BLOCK} p-5 col-span-2 max-[900px]:col-span-1`}>
      <BlockHeader label="Projects" />
      <Tip label="Open Projects">
        <button type="button" className="group flex w-full flex-col text-left">
          <div className="flex items-baseline gap-3">
            <span className={`${BIGNUM} transition-colors group-hover:text-accent`}>{pct}%</span>
            <span className="text-[12.5px] text-muted">
              {totalClosed} / {total} issues closed on {counted.length} of {projects.length} boards
            </span>
          </div>
          <div className="mt-3 h-[6px] w-full overflow-hidden rounded-full bg-[var(--board-well)]">
            <span className="block h-full rounded-full bg-accent-strong" style={{ width: `${pct}%` }} />
          </div>
        </button>
      </Tip>
      <div className="mt-3.5 flex flex-col gap-0.5">
        {projects.map((p) => (
          <VariantRow key={`${p.org ?? ''}/${p.number}`} p={p} t={t} />
        ))}
      </div>
    </div>
  );
}
