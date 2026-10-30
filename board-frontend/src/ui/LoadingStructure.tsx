import { Skeleton } from './kit';
import type { CSSProperties } from 'react';
import { BLOCK, CARD_PADDING } from './block';
import { QUEUE_GAP } from './queue-region';
import { BOARD_CARD, BOARD_WELL } from '../issues-viewer/board-shape';

export type LoadingSurface = 'overview' | 'work' | 'queue' | 'repos' | 'project' | 'repo' | 'throughput' | 'project-strip';

/** The tone every placeholder bar on the board is drawn in. Exported because
 *  `ui/ProbeShell.tsx` and `issue/IssueLoading.tsx` draw the same bars and each
 *  had spelled it again, held in step by a comment. */
export const BAR = 'bg-elevated';
/** The issue viewer's field tone, which `app.css` resolves per region (#447). */
const CHROME = 'bg-[var(--queue-chrome)]';
const ROW = `rounded-lg ${BAR}`;
const REPO_GRID = 'mt-[18px] grid grid-cols-[repeat(auto-fill,minmax(236px,1fr))] gap-3';
const REPO_CONTROLS = 'mt-[26px] flex min-h-9 flex-wrap items-center gap-2 max-[900px]:mt-0';

/** Every placeholder bar on the board is the kit's `Skeleton` with its own
 *  animation left alone (#1033). `Guidelines/Lists & rows/Loading cards` is the
 *  guideline #1033 asked whether the kit had, and it does — added to the old UI kit
 *  on 2026-09-09 — but read what it says: "while a card is pending, use
 *  `Skeleton` placeholders matching its loaded geometry: footprint, padding,
 *  and content shapes". It asks for the component and says nothing about
 *  motion. The pulse is the component's, not the guideline's: `Skeleton` ships
 *  `animate-pulse` in its own base class (kit 7.3.0), so keeping it is what
 *  using the kit's placeholder means. #940 had pinned `!animate-none` over it,
 *  because #928's approved direction was static structure; the owner has since
 *  asked for the glow, and the kit's default is it.
 *
 *  `motion-reduce:animate-none` is board's decision, not the kit's, and the kit
 *  has no guideline covering it. The reason is a dead rule: the kit's
 *  reduced-motion block zeroes the `--motion-duration-*` tokens and
 *  `--tw-animation-duration`, and Tailwind v4's `animate-pulse` emits
 *  `animation: var(--animate-pulse)`, a shorthand carrying its own 2s, which
 *  reads neither. So a reader who asked for less motion would get a pulse that
 *  never stops, and board writes the stop itself. `reduced-motion.spec.ts`
 *  holds this to one call site. */
export const PULSE_UNLESS_REDUCED = 'motion-reduce:animate-none';

/** The board's only placeholder bar, and the only thing in the app that touches
 *  the kit's `Skeleton`: `reduced-motion.spec.ts` holds that, so the pulse and
 *  its stop are decided once instead of at every call site.
 *
 *  `still` is for a shape that is not loading: a failed read keeping its place.
 *  A pulse there would say "wait" about something that is not coming.
 *
 *  `style` is for a measurement no Tailwind scale names — a ring sized off a
 *  constant, a bar whose width is computed per row. */
export function Placeholder({ className, still = false, style }: {
  className: string; still?: boolean; style?: CSSProperties;
}) {
  return <Skeleton style={style} className={`${still ? '!animate-none' : PULSE_UNLESS_REDUCED} ${className}`} />;
}

/**
 * The Projects strip's own geometry — a ring, a name, a figure line — with
 * nothing in it.
 *
 * Exported (#1003) because a strip with NO data is drawn twice now and must not
 * be drawn twice differently: once here while the rollup is still walking items,
 * and once by `DisabledProjectStrip` when the read failed and there is no last
 * answer to fall back on either. That second one is not loading and says so, so
 * it passes `still`: same shape, no pulse.
 */
export function ProjectStripShape({ still = false }: { still?: boolean }) {
  return <div className="flex items-center gap-3" aria-hidden="true">
    <Placeholder still={still} className={`size-[30px] shrink-0 rounded-full ${BAR}`} />
    <div className="min-w-0 flex-1 space-y-2">
      <Placeholder still={still} className={`h-3 w-40 max-w-full ${BAR}`} />
      <Placeholder still={still} className={`h-2.5 w-24 max-w-full ${BAR}`} />
    </div>
  </div>;
}

/**
 * The issue viewer's board while it has no rows (#944, #1008): its field, then
 * three columns holding cards, drawn from the same `BOARD_WELL` and `BOARD_CARD`
 * the real board draws, so a card here carries the padding a card there does.
 *
 * `housed` is the viewer's own word for sitting in the queue region under a
 * header (Your work), where the columns follow the field at the region's gap.
 * Unhoused (Queue, #1000) there is no header and the view controls sit beside
 * the field, the way `IssuesViewer` lays them out. The column count is a layout
 * sample, not a claim about how many groups there are.
 */
function QueueShape({ housed }: { housed: boolean }) {
  return <div aria-hidden="true">
    {housed && <div className="mb-2 flex min-h-9 items-center justify-between gap-3">
      <Placeholder className={`h-4 w-24 ${BAR}`} />
      <Placeholder className={`h-7 w-40 ${BAR}`} />
    </div>}
    {/* The field in the tone the real one paints. `BAR` is the step above a
        block, and on Queue there is no block under the field: in light it
        landed on the page's own grey and the field was not there at all. */}
    <div className="flex items-center gap-4">
      <Placeholder className={`h-9 min-w-0 flex-1 rounded-[10px] ${CHROME}`} />
      {!housed && <Placeholder className={`h-9 w-40 shrink-0 ${CHROME}`} />}
    </div>
    <div className={`${housed ? QUEUE_GAP : 'mt-6'} grid grid-cols-[repeat(3,minmax(210px,1fr))] gap-3.5 overflow-hidden`}>
      {[3, 2, 1].map((cards, column) => <div key={column} className={BOARD_WELL}>
        <div className="px-1 pb-1.5 pt-0.5"><Placeholder className={`h-[22px] w-28 rounded-full ${BAR}`} /></div>
        {Array.from({ length: cards }, (_, card) => <div key={card} className={`${BOARD_CARD} bg-surface`}>
          <Placeholder className={`h-[18px] w-4/5 ${BAR}`} />
          <Placeholder className={`h-4 w-1/3 ${BAR}`} />
        </div>)}
      </div>)}
    </div>
  </div>;
}

function Shape({ surface, reposControls, housed }: { surface: LoadingSurface; reposControls: boolean; housed: boolean }) {
  if (surface === 'project-strip') return <ProjectStripShape />;
  if (surface === 'queue') return <QueueShape housed={housed} />;
  if (surface === 'throughput') {
    return <div aria-hidden="true">
      <Placeholder className={`h-[18.75px] w-24 ${BAR}`} />
      <div className="mt-3 flex gap-5">
        {[0, 1].map((item) => <div key={item} className="flex items-end gap-1.5">
          <Placeholder className={`h-[34px] w-10 ${BAR}`} />
          <Placeholder className={`h-3 w-10 ${BAR}`} />
        </div>)}
      </div>
      <Placeholder className={`mt-6 h-[120px] w-full ${ROW}`} />
    </div>;
  }
  if (surface === 'overview') {
    return (
      <>
        <div className="flex items-center justify-between gap-4">
          <Placeholder className={`h-5 w-32 ${BAR}`} />
          <Placeholder className={`h-4 w-28 ${BAR}`} />
        </div>
        <Placeholder className={`mt-5 h-20 w-full ${ROW}`} />
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((item) => <Placeholder key={item} className={`h-16 w-full ${ROW}`} />)}
        </div>
      </>
    );
  }
  if (surface === 'work') {
    return (
      <>
        <Placeholder className={`h-5 w-28 ${BAR}`} />
        <div className="mt-5 space-y-3">
          {[0, 1, 2, 3].map((item) => <Placeholder key={item} className={`h-12 w-full ${ROW}`} />)}
        </div>
      </>
    );
  }
  if (surface === 'repos') {
    return (
      <>
        {reposControls && <div className={REPO_CONTROLS} aria-hidden="true">
          <Placeholder className={`h-9 w-[248px] max-[560px]:w-full rounded-[10px] ${BAR}`} />
          <Placeholder className={`h-[26px] w-14 rounded-[7px] ${BAR}`} />
          <Placeholder className={`h-[26px] w-20 rounded-[7px] ${BAR}`} />
          <Placeholder className={`h-[26px] w-28 rounded-[7px] ${BAR}`} />
          <div className="ml-1 flex items-center gap-1.5">
            {[0, 1, 2, 3].map((item) => <Placeholder key={item} className={`size-7 rounded-full ${BAR}`} />)}
          </div>
        </div>}
        <div className={REPO_GRID}>
        {/* Layout samples use the real tile geometry and grid rules. Their
            count is deliberately not a claim about how many repos exist. */}
        {Array.from({ length: 8 }, (_, item) => (
          <div key={item} className={`${BLOCK} flex min-h-[112px] w-full flex-col gap-[9px] px-4 pb-3 pt-3.5`} aria-hidden="true">
            <div className="flex h-[18px] items-center gap-2">
              <Placeholder className={`h-4 w-3/5 ${BAR}`} />
              <Placeholder className={`ml-auto h-4 w-7 ${BAR}`} />
            </div>
            <Placeholder className={`h-[26px] w-full ${BAR}`} />
            <Placeholder className={`h-[18px] w-2/5 ${BAR}`} />
          </div>
        ))}
        </div>
      </>
    );
  }
  if (surface === 'project') {
    return (
      <>
        <div className="flex items-center gap-3">
          <Placeholder className={`size-8 rounded-full ${BAR}`} />
          <Placeholder className={`h-5 w-2/5 ${BAR}`} />
        </div>
        <div className="mt-5 space-y-3">
          {[0, 1, 2].map((item) => <Placeholder key={item} className={`h-7 w-full ${ROW}`} />)}
        </div>
      </>
    );
  }
  // `repo` last and unguarded, because it is the only member of the union left
  // by the time the chain reaches here. The arm that used to stand below it was
  // `issue`'s, and #1198 moved the issue page onto its own two-column
  // silhouette in `issue/IssueLoading.tsx` — so the surface, its shape and its
  // spec row went with it rather than staying as coverage over nothing.
  return (
    <>
      <Placeholder className={`h-7 w-2/5 ${BAR}`} />
      <div className="mt-6 grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((item) => <Placeholder key={item} className={`h-36 w-full ${ROW}`} />)}
      </div>
      <Placeholder className={`mt-6 h-28 w-full ${ROW}`} />
    </>
  );
}

/**
 * The inset a skeleton's block carries, which is the inset of the loaded block it
 * stands in for. `work` stands in for the flow strip's tiles, `throughput` for
 * Pulse's `THROUGHPUT_CARD` and `overview` for the Overview page's blocks, and
 * all of those carry the one card padding (#944). The rest stand in for pages
 * #944 and #1008 did not reach and keep the `p-5` they had.
 */
const INSET: Partial<Record<LoadingSurface, string>> = { work: CARD_PADDING, throughput: CARD_PADDING, overview: CARD_PADDING };

export function LoadingStructure({ surface, label, className = '', inset = true, reposControls = true, housed = false }: {
  surface: LoadingSurface;
  label: string;
  className?: string;
  inset?: boolean;
  reposControls?: boolean;
  /** `queue` only: whether the viewer sits in the queue region under a header. */
  housed?: boolean;
}) {
  // `repos` draws tiles and `queue` draws a board, each a set of surfaces of its
  // own rather than one block. The housed queue's region comes in `className`.
  const unblocked = surface === 'repos' || surface === 'queue';
  const innerInset = unblocked || !inset ? '' : INSET[surface] ?? 'p-5';
  return (
    <section aria-busy="true" aria-label={`Loading ${label}`} className={`${unblocked ? '' : BLOCK} ${className}`}>
      <div className={innerInset}>
        <Shape surface={surface} reposControls={reposControls} housed={housed} />
        <p role="status" className="sr-only">Loading {label}…</p>
      </div>
    </section>
  );
}
