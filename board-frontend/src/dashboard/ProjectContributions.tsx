/**
 * "Contributions" (#380/#413) — a quiet one-line memory strip on Your work: which
 * GitHub Projects you're working in, most-recently-moved first. Since #413's
 * minimal layout it's a single compact strip (label + inline ring per project)
 * rather than the tall stacked block, so it rides just under the stats without
 * pushing the queue down. Each project still shows the shared completion `Ring`
 * (#419) — the same % Unit reads — so the two surfaces stay one system; only
 * which projects surface, and their order, is personal.
 *
 * Since #750 a ring is a FILTER over the queue below it, not a link away from
 * the page: pressing one narrows Your work's queue to that board, pressing it
 * again clears it, and the selection lives in the URL as `?project=<name>` —
 * the very param the queue's own Project filter writes. `dashboard/project-filter.ts`
 * holds the pure half; this file only draws it. That is #461's move for people,
 * made for boards.
 *
 * The selection is a BOARD and not a name (#782). The rows are keyed on the
 * whole address (#697) and the pressed test was not, so two orgs each holding a
 * "Roadmap" lit as one ring and narrowed as one board. The address travels in
 * `?board=` beside the name now, and `isPressed` is the one predicate deciding
 * which ring wears it — the same one the press clears by, so a ring cannot light
 * for a board its own press would not release.
 *
 * A board lands on the caller's radar when they've moved it this week or still
 * carry open work on it (computed server-side: GET /api/issues/mine →
 * projectContributions); the per-project completion/weekly numbers join in from
 * the same rollup Unit reads (GET /api/projects). Rows are most-recently-you-
 * closed first — ordering carries "active vs quiet" for you personally, even
 * though the ring shows the whole board's completion. Read-only, like the rest
 * of the board.
 */
import { LoadingStructure, ProjectStripShape } from '../ui/LoadingStructure';
import type { ProjectContribution, ProjectSummary } from '../api/projects';
import { ContributionTip } from '../projects/ContributionTip';
import {
  type ContributionSegment,
  contributionSegments,
  contributorsOf,
  ringSegments,
} from '../projects/contributors';
import { ProjectBlockRow, blockRowOf, weeklyClosedLine } from '../projects/ProjectBlock';
import { type BoardAt, type BoardSelection, isPressed } from './project-filter';
import { readShort } from '../projects/pulse';
import { usePeople } from '../people-ctx';
import { BLOCK, CARD_PADDING } from '../ui/block';
import { FOCUS_RING } from '../repos/controls';
import { Ring } from '../ui/ring';
import { Tip } from '../ui/Tip';
import { gotoPath, routePath } from '../route';

/** contributions → shared-block rows: most-recently-you-closed first (ties
 *  broken by who moved it more this week), decorated with the project's own
 *  completion % and weekly-closed count from the rollup. Unmatched rows retain
 *  their identity for filtering; the renderer withholds their progress.
 *  Pure, so the ordering + join is unit-testable without rendering (#419). */
export function contributionRows(
  contributions: ProjectContribution[],
  projects: ProjectSummary[],
): ProjectBlockRow[] {
  // Keyed by the board's whole ADDRESS, not its number (#697). Both sides of
  // this join are unions across every configured org and a Projects v2 number is
  // unique only within one, so `new Map(projects.map((p) => [p.number, p]))`
  // let the last board with that number win — a row showed one org's name over
  // another org's ring and another org's teammates.
  //
  // The number-only map is kept as the FALLBACK, and it is what a board-api
  // predating the field falls to: with no org on either side the address IS the
  // number, which is exactly the join this made before.
  //
  // It holds ONLY the boards that named no org (#714). With independently
  // scoped issue and Projects reads, a contribution in `globex/#7` can miss
  // the address map on `/acme` — and a number-keyed fallback over boards that DID name an org
  // handed it acme's board 7: its ring, its percentage and its
  // contributors, under the globex board's name. That is #697's
  // last-number-wins bug again, reopened by the narrowing. A board that named
  // its org is reachable by its whole address and by nothing else; the fallback
  // is the address-LESS join, and it is available only to boards with no address
  // to miss on.
  const byAddress = new Map(projects.map((p) => [boardKey(p.org, p.number), p]));
  const byNumber = new Map(projects.filter((p) => p.org === undefined).map((p) => [p.number, p]));
  const recency = (c: ProjectContribution): number => (c.lastClosedAtISO ? Date.parse(c.lastClosedAtISO) : 0);
  return [...contributions]
    .sort((a, b) => recency(b) - recency(a) || b.closed7d - a.closed7d)
    .map((c) => {
      const summary = byAddress.get(boardKey(c.org, c.number)) ?? byNumber.get(c.number);
      // Drawn at the CONTRIBUTION's address and filled from whatever the join
      // matched — the one mapper the Projects card uses too (#715), so the week
      // figure is carried rather than coalesced on both surfaces. The renderer
      // checks whether this join matched before drawing any progress.
      return blockRowOf(c, summary);
    });
}

/** A board's identity across the two unions this file joins — org and number
 *  together, since neither half is unique on its own (#697). A board that named
 *  no org keys on the number alone, which is the key it always had. */
const boardKey = (org: string | undefined, number: number) => `${org ?? ''}/${number}`;

/**
 * A ring is a CONTROL, and has to look and feel like one (#750 review).
 *
 * It was an `<a href>` until #750, so the pointer cursor and a focus ring came
 * with the element. Turning it into a `<button>` lost both: measured on the
 * built page in headless Chrome, this button computed `cursor: default` while a
 * sibling `.side-item` computed `cursor: pointer`, and focusing it drew Chrome's
 * own `outline: 1px auto` — the 1px navy hairline `repos/controls` was written
 * about, which on this ground is very nearly invisible.
 *
 * `cursor-pointer` is stated rather than inherited: Tailwind v4's preflight
 * stopped giving buttons the pointer, so every button on this board that wants
 * one says so. The ring is `FOCUS_RING` — the board's one focus treatment,
 * imported rather than re-spelled, so this strip cannot drift from the five
 * controls already wearing it.
 */
const ITEM = `group flex min-w-0 max-w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1 text-left transition-colors ${FOCUS_RING}`;
/** Pressed → the queue below is narrowed to this board. The wash is the one the
 *  Crew cards wear when they are the assignee filter (#461), so the two surfaces
 *  say "selected" the same way. */
const ITEM_ON = 'bg-elevated';
const ITEM_OFF = 'hover:bg-elevated';

function ContributionItem({
  p,
  segments,
  active,
  available,
  onToggle,
}: {
  p: ProjectBlockRow;
  segments: ContributionSegment[];
  active: boolean;
  available: boolean;
  onToggle?: () => void;
}) {
  // The third ring drawn off one board's `pct`, withheld on the same gate as the
  // other two (#722): a strip that went on asserting would have the same board
  // report a share here that its card and its row both decline to state.
  const ring = (
    <Ring pct={p.pct} size={30} segments={ringSegments(segments)} withheld={readShort(p.itemsComplete)} />
  );
  const content = <>
      {available && (segments.length > 0 ? (
        <Tip label={<ContributionTip segments={segments} open={p.open} />}>
          <span className="flex-none">{ring}</span>
        </Tip>
      ) : (
        ring
      ))}
      <span className="min-w-0">
        <span className="block truncate text-[13px] text-fg">{p.name}</span>
        <span className="mt-0.5 block text-[11.5px] tabular-nums text-muted">
          {/* The sentence form of the slot's own short vocabulary (#1103 review,
              S5). "Progress not read." was a LABEL with a full stop on it, in a
              slot whose other occupant is a sentence: `weeklyClosedLine` fills
              this same line with "Part of this list was not read." and "This
              week's closes were not read" (`projects/pulse.ts`). The bare form
              belongs where `repos-vm.ts` keeps it, on a chip and a table cell
              with no verb in sight. The verb costs four characters and the
              siblings are longer than either. */}
          {available ? weeklyClosedLine(p) : 'Progress was not read.'}
        </span>
      </span>
  </>;
  const className = `${ITEM} ${active ? ITEM_ON : ITEM_OFF}`;
  if (onToggle) return <button type="button" onClick={onToggle} aria-pressed={active} className={className}>{content}</button>;
  const href = routePath({ tab: 'projects', org: p.org, project: p.number });
  return <a href={href} className={`${className} no-underline`} onClick={(event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault(); gotoPath(href);
  }}>{content}</a>;
}

export function ProjectContributions({
  contributions,
  projects,
  failed = false,
  selected,
  onToggle,
}: {
  contributions: ProjectContribution[];
  /**
   * The Projects rollup (GET /api/projects), joined in for each row's
   * completion % + weekly-closed count, or `null` when that read has not
   * answered yet or no authorized cached answer remains.
   *
   * Null has no figures to draw. A successful empty rollup still cannot
   * establish progress for a membership absent from that rollup, so unmatched
   * boards remain filter controls with an unavailable note.
   */
  projects: ProjectSummary[] | null;
  failed?: boolean;
  /** The BOARDS the queue below is narrowed to, read off the URL by the host
   *  (#750). Never held here: the queue's own Project chip writes the same param,
   *  and a second copy is how the two would come to disagree.
   *
   *  Each carries an address when the URL gave it one (#782). One that did not
   *  presses every ring wearing its name — which is what a name-only URL says,
   *  and what the chip writes. */
  selected: readonly BoardSelection[];
  /** Toggle one board — the whole address, never the name — in and out of that
   *  selection. */
  onToggle: (at: BoardAt) => void;
}) {
  // Quiet by default: with no boards at all, render nothing rather than an empty shell.
  if (contributions.length === 0) return null;
  // The boards are known and their figures are not, which on a return visit is
  // the first frame of every load: the queue seeds off the disk and the rollup
  // has no cached copy to seed from (#824). The block keeps its place rather
  // than appearing under the reader when the read lands, and states nothing
  // until it has something true to state.
  if (projects === null && failed) return <DisabledProjectStrip label="Project progress" note="Project progress couldn’t be read just now." />;
  if (projects === null) return <LoadingStructure surface="project-strip" label="project progress" inset={false} className={`min-h-[70px] ${CARD_PADDING}`} />;

  const rows = contributionRows(contributions, projects);
  const available = new Set(projects.map(p => boardKey(p.org, p.number)));
  return <ProjectStrip rows={rows} selected={selected} onToggle={onToggle}
    available={(p) => available.has(boardKey(p.org, p.number)) || available.has(boardKey(undefined, p.number))} />;
}

/**
 * The Projects strip with nothing behind it — DISABLED, and still on the page
 * (#1003).
 *
 * What stood here was a sentence: `Projects unavailable.` on the Unit page and
 * `Project progress unavailable.` here, both replacing the block rather than
 * being a state of it. Two things were wrong with that. The block's own place in
 * the column went, so everything under it moved the moment a read failed and
 * moved back when one recovered. And a lone line of prose where a control used
 * to be reads as "there are no projects" — the claim about the org that #722
 * exists to stop the board making — rather than "we could not read them".
 *
 * So the block keeps its surface, its padding and its shape, wears the strip's
 * own empty geometry (`ProjectStripShape`, the same one the loading state
 * draws), dims, and says why. `aria-disabled` rather than `aria-busy`: nothing
 * is in flight that this is waiting for, and a screen reader must not be told to
 * expect one. Nothing inside is focusable, so keyboard order skips it exactly as
 * it skipped the sentence.
 *
 * `role="group"` is what makes that `aria-disabled` mean anything (#1003
 * review). A `<section>` carrying an accessible name maps to `region`, and
 * `aria-disabled` is not a global attribute — `region` is not among the roles
 * that support it, so on the default mapping it is inert and the state reaches
 * a screen reader only through the `role="status"` line below. `group` is on
 * that list, and is what this block is.
 *
 * It is reached only when there is NO answer of any kind. This said that the
 * service's `projects-last-good.ts` (#1003) guaranteed one, and it does not: that
 * copy lives in one board-api process, answers only a Github refusal that says
 * "not now", and is empty after every deploy. The browser's own copy was taken
 * off the disk at every page load by the permission wipe, so a reload whose read
 * failed landed here with boards the reader had seen a minute before (#1035).
 * The browser now keeps a saved copy outside that wipe
 * (`projects/projects-last-good.ts`), and a held or saved copy draws the real
 * strip while the shared sync indicator warns about its age.
 */
export function DisabledProjectStrip({ label, note, className = '' }: {
  /** What this block is, said to a reader who cannot see it is the Projects
   *  strip from its contents — because it has none. */
  label: string;
  note: string;
  className?: string;
}) {
  return (
    <section role="group" aria-disabled="true" aria-label={label} className={`${BLOCK} ${CARD_PADDING} ${className}`}>
      {/* The reason keeps full strength and the strip's own secondary weight:
          dimming the whole block dimmed the one thing on it a reader needs, and
          `text-tertiary` at reduced opacity does not clear 4.5:1 on this
          surface. What dims is the shape below, which carries no information —
          it is the block holding its place. `still`, because a pulse would
          say "wait" about a read that is not coming (#1033). */}
      <p role="status" className="mb-1 min-h-4 text-[11.5px] text-dim">{note}</p>
      <div className="opacity-50"><ProjectStripShape still /></div>
    </section>
  );
}

/** Shared compact layout; each page supplies its own population and action.
 *  `note` is the quiet line saying the boards drawn are a copy (#1035). */
export function ProjectStrip({ rows, note = null, selected = [], onToggle, available = () => true, className = '' }: {
  rows: ProjectBlockRow[];
  note?: string | null;
  selected?: readonly BoardSelection[];
  onToggle?: (at: BoardAt) => void;
  available?: (row: ProjectBlockRow) => boolean;
  className?: string;
}) {
  const people = usePeople();
  const segments = rows.map((p) => contributionSegments(contributorsOf(p), people));
  return (
    <div className={`${BLOCK} ${CARD_PADDING} ${className}`}>
      {note && <p role="status" className="mb-1 min-h-4 text-[11.5px] text-muted">
        {note}
      </p>}
      {/* `-ml-2` undoes each item's own `px-2` at the left edge, so the first
          ring on every line starts on the card's 16px line with the text of the
          blocks around it, and only a hover or pressed fill reaches past it
          (#944). The right edge is left alone: the phone guard measures the row
          against the content edge there. */}
      <div className="-ml-2 flex flex-wrap items-center gap-x-5 gap-y-1">
        {rows.length === 0 && <p className="text-[12.5px] text-muted">No projects.</p>}
        {rows.map((p, i) => (
          <ContributionItem key={boardKey(p.org, p.number)} p={p} segments={segments[i]}
            active={isPressed(selected, p)} available={available(p)}
            onToggle={onToggle ? () => onToggle(p) : undefined} />
        ))}
      </div>
    </div>
  );
}
