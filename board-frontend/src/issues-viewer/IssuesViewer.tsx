import { useResolvedTimezone } from '../account/prefs';
/**
 * The shared, read-only IssuesViewer (#376) — one component that filters, groups,
 * switches list/board, searches, and keeps its state in the URL, so a sliced view
 * is shareable and back-button friendly. Self-contained: it owns its URL state via
 * `useViewerState` and composes the pure foundation (`filterIssues`/`groupIssues`
 * via `viewerGroups`) with the "Take 2" chrome (one fused field + quiet group menu
 * + icon-only view toggle).
 *
 * The component stays GENERAL — full grouping + list/board, used unchanged by
 * Your work, Unit, a member page, and the Project page (#429, board-by-default via
 * `defaultView`). A host CAN still opt into a simpler config via props
 * (`fixedGroup`/`listOnly`/`hideRowLabels`/`hideWho`) when it wants a narrower
 * surface, but none of the current callers lock the view anymore.
 *
 * A host that gives the viewer a `heading` also hands it the whole region (#447):
 * the viewer then renders its own block, header, count and controls, and keeps
 * that shape while it loads, while it's empty and once data arrives. See
 * `ui/queue-region.ts`.
 */
import { useMemo, type ReactNode } from 'react';
import type { FilterOptions } from '../api/issues';
import type { HostKey } from './viewer-prefs';
import type { GroupDim } from './filter-group';
import { useViewerState } from './use-viewer-state';
import { availableGroupDims, resolveGroupDim, viewerGroups, visibleCount } from './viewer-groups';
import type { ViewerIssue } from './viewer-issue';
import { FilterBar } from './FilterBar';
import { ViewerControls } from './ViewerControls';
import { ListView } from './ListView';
import { BoardView } from './BoardView';
import { mayAssignIssue, mayCloseIssue } from '../ui/IssueActions';
import { useMe } from '../use-me';
import { BLOCK, CARD_PADDING } from '../ui/block';
import { BlockHeader } from '../ui/BlockHeader';
import { QUEUE_GAP, QUEUE_REGION } from '../ui/queue-region';

export function IssuesViewer({
  issues, options, fixedGroup, defaultGroup, defaultView, persistKey, listOnly = false, hideRowLabels = false,
  showTriage = false, hideWho = false, emptyText, sourceProject, sourceProjectOrg, heading, now, timeZone: suppliedTimeZone,
}: {
  showTriage?: boolean;
  now?: number;
  timeZone?: string;
  issues: ViewerIssue[];
  /** The region's label ("Your queue", "Unit queue"). Passing it hands the viewer
   *  the whole region (#447): it draws the block, puts the label, the visible count
   *  and its controls on one header row, and holds that shape across loading, empty
   *  and loaded. A host that IS the queue (the Project page — the viewer is the
   *  whole page there, and it already reads as one thing) omits it and gets the
   *  bare viewer exactly as before. */
  heading?: ReactNode;
  options: FilterOptions;
  /** The GitHub Project (v2) board this viewer instance renders (#422) — set
   *  ONLY by the Project page. Threaded into every row/card's issue link as
   *  `?srcProject=`, so opening an issue from a board carries the board it came
   *  from into the issue page's breadcrumb. Every other host (Your work, Unit,
   *  search) omits this and issue links stay exactly as before. */
  sourceProject?: number;
  /** The org half of `sourceProject` (#697), threaded alongside it as
   *  `?srcProjectOrg=`. A Projects v2 number is unique only within an org, so
   *  without this the issue page's breadcrumb walked back to whichever org holds
   *  the number first — a board the reader may never have been on. */
  sourceProjectOrg?: string;
  /** Lock the grouping dimension and hide the group control (host-simplified). */
  fixedGroup?: GroupDim;
  /** The groupings to lead with before the URL or storage names one, best first
   *  — the first one THIS data supports wins (#727). Your work and the Unit queue
   *  pass `['project', 'type']`: a board is how they read when their issues carry
   *  one, and `type` is what those queues showed before, for a set that carries
   *  none. Without this the viewer would fall to `dims[0]` — whichever dimension
   *  `availableGroupDims` happens to put first for that data. See
   *  `resolveGroupDim`.
   *
   *  A fresh array each render is fine, unlike `persistKey`: this is read during
   *  render and is a dependency of nothing. */
  defaultGroup?: GroupDim | readonly GroupDim[];
  /** The view (list/board) to lead with before the URL names one — the control
   *  still shows and the choice still round-trips through the URL. The Project
   *  page leads with `board` (#429); every other host omits this and keeps the
   *  app-wide `list` default via `DEFAULT_VIEWER`. */
  defaultView?: 'list' | 'board';
  /** Opt this host into remembering its arrangement (#463). Given a key, the
   *  grouping and the view are restored on a bare visit and re-written whenever
   *  either is deliberately changed; the key namespaces one host's memory from
   *  another's, so two Project boards keep separate arrangements. Omitted → no
   *  memory, which is what Your work and the Unit queue want. The search text is
   *  never stored — see `viewer-prefs.ts`. */
  persistKey?: HostKey;
  /** Force the list view and hide the list/board toggle. */
  listOnly?: boolean;
  /** Don't render label tags in the rows (labels still filter). */
  hideRowLabels?: boolean;
  /** Drop the Who column; the actor avatar then rides in the Last-activity cell. */
  hideWho?: boolean;
  /** Shown (in a quiet block) when the caller passes NO issues at all — the
   *  host's own message (e.g. "Nothing assigned to you right now."). Distinct from
   *  the filters-match-nothing state below. Omitted → no special empty surface. */
  /** A node, not a string: the empty queue on Your work is a title over a body
   *  when nobody can be attributed (#535). */
  emptyText?: ReactNode;
}) {
  // The head of the host's list is its page default, handed to the hook so it sits
  // ABOVE the app-wide `DEFAULT_GROUP` in `initViewer` (#727). The rest of the
  // list is the fallback chain below, walked once the data says which dimensions
  // it can actually offer.
  const leadGroup = typeof defaultGroup === 'string' ? defaultGroup : defaultGroup?.[0];
  const { state, setSort, setQuery, setGroup, setView, setFilter, setLifecycle, toggleCustomField, setTimeframe, toggleUnassigned } =
    useViewerState(defaultView, persistKey, leadGroup);

  // Every filter dimension, assignees included, is the viewer's own (#461). The
  // Unit page used to own that one dimension out of band, which kept a Crew
  // selection out of `commit` and so out of the URL; it now reads the selection
  // back from the URL this writes.
  const filters = state.filters;

  // Whether `Close issue…` is offered on this viewer's rows and cards (#653).
  // Resolved HERE, once per viewer, and handed to both views: `useMe` fetches
  // `/api/auth/me` per mount, so asking it inside a row would be one request per
  // issue on screen. Same shape as `ReposPage`, which reads `canSetDri(me)` once
  // and passes it through the map to every tile's owner picker.
  const { me } = useMe();
  const mayClose = mayCloseIssue(me);
  // And whether `Assign to…` is (#1009), resolved beside it for the same reason.
  // A separate verdict, because the two capabilities are refused independently.
  const mayAssign = mayAssignIssue(me);

  const dims = useMemo(() => availableGroupDims(issues), [issues]);
  // A fixed group wins; everything else is `resolveGroupDim`, which is where that
  // decision is tested (#727) — this suite has no DOM, so a ternary written here
  // is a rule no test can reach.
  const group = fixedGroup ?? resolveGroupDim(state.group, dims, defaultGroup);
  const view = listOnly ? 'list' : state.view;

  const preferredTimeZone = useResolvedTimezone();
  const timeZone = suppliedTimeZone ?? preferredTimeZone;
  const groups = useMemo(
    () => viewerGroups(issues, { group, filters, sort: state.sort }, now, timeZone),
    [issues, group, filters, state.sort, now, timeZone],
  );
  const total = visibleCount(groups);

  const showGroupControl = !fixedGroup;
  const showViewToggle = !listOnly;
  // The Open/Closed grouping IS the lifecycle split, so a State filter would be a
  // no-op there — hide it in that mode.
  const showStateFilter = group !== 'openclosed';

  // A heading hands the viewer its whole region (#447) — see `ui/queue-region.ts`.
  const housed = heading != null;
  // The board sits on the page rail like every other block (#849). #783 had it
  // bleed back out of the rail by the rail's own slack, on the grounds that a
  // board is measured in 210px columns and the slack is columns nobody gets to
  // see. What that bought in columns it spent on the page: above about 1688px of
  // window the queue was the one panel on Your work not starting where the rest
  // of them start, with its own header capped back to the rail inside it. A
  // board wider than the rail now scrolls, which it already did.
  const region = housed ? QUEUE_REGION : '';
  // The header's own gap to the field: 8px, under the 12px between whole blocks,
  // so the label reads as part of the queue rather than as a neighbour above it.
  const headerClass = 'mb-2! flex-wrap gap-y-2 [&>span:last-child]:gap-x-6 [&>span:last-child]:flex-wrap [&>span:last-child]:max-w-full';
  // Whatever is drawn at rest starts on the region's own 16px, the edge the label
  // and the field start on (#1008): in board view that is the columns, which are
  // surfaces, and in list view it is the row text, because a row has no surface
  // until it is hovered. `ListView` bleeds its rows back out to do that, the way
  // Feedback's rows do. Before #1008 the region was 4px and everything inside it
  // carried its own inset, which left the board's columns 6px from its edge.
  const contentClass = housed ? QUEUE_GAP : 'mt-6';
  const controls = (showGroupControl || showViewToggle) && (
    <ViewerControls
      sort={state.sort}
      onSort={showTriage ? setSort : undefined}
      group={group}
      dims={dims}
      view={view}
      showGroup={showGroupControl}
      showView={showViewToggle}
      onGroup={setGroup}
      onView={setView}
    />
  );
  const countLabel = `${total} ${total === 1 ? 'issue' : 'issues'}`;


  // No issues at all → the host's own message, no filter chrome over nothing
  // (mirrors the retired IssueQueue's empty block). A housed queue keeps its
  // region and its header here, so the surface doesn't appear and disappear with
  // the data. The filters-match-nothing state (below) is separate: there the field
  // stays so you can widen the filter.
  if (emptyText !== undefined && issues.length === 0) {
    if (!housed) return <div className={`${BLOCK} ${CARD_PADDING} text-[13px] text-muted`}>{emptyText}</div>;
    return (
      <div className={region}>
        <BlockHeader className={headerClass} label={heading} meta="0 issues" />
        <div className="py-2 text-[13px] text-muted">{emptyText}</div>
      </div>
    );
  }

  return (
    <div className={region}>
      {/* Housed, the count and the controls ride the header the way every other
          block's meta does, which also leaves the field the full width of the row
          below instead of sharing it with a second chrome island. */}
      {housed && <BlockHeader className={headerClass} label={heading} meta={countLabel} right={controls || undefined} />}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <FilterBar
          q={state.q}
          filters={filters}
          options={options}
          issues={issues}
          showStateFilter={showStateFilter}
          onQuery={setQuery}
          onToggle={setFilter}
          onLifecycle={setLifecycle}
          onToggleCustomField={toggleCustomField}
          onTimeframe={setTimeframe}
          onToggleUnassigned={toggleUnassigned}
        />
        {!housed && controls}
      </div>

      <div className={contentClass}>
        {total === 0 ? (
          <div className={`${housed ? '' : 'px-0.5'} py-12 text-[13px] text-muted`}>No issues match.</div>
        ) : view === 'list' ? (
          // The Open/Closed split is tone-less, so its group pill drops the (then
          // decorative) dot; real status groups keep it.
          <ListView
            showTriage={showTriage}
            groups={groups}
            mayClose={mayClose}
            mayAssign={mayAssign}
            hideLabels={hideRowLabels}
            hideWho={hideWho}
            groupDot={group !== 'openclosed'}
            housed={housed}
            sourceProject={sourceProject}
            sourceProjectOrg={sourceProjectOrg}
          />
        ) : (
          /* The board catalog goes to the board because a column headed by a
             project name opens that project (#1191), and `options` is where
             this page holds the org and number behind a name. */
          <BoardView showTriage={showTriage} groups={groups} dim={group} boards={options.projects} sourceProject={sourceProject} sourceProjectOrg={sourceProjectOrg} mayClose={mayClose} mayAssign={mayAssign} />
        )}
      </div>
    </div>
  );
}
