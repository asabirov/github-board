/**
 * The IssuesViewer's list view (#376) — grouped stacks of one-line rows on a
 * shared grid (Issue · Who · Age), sub-issues nested under their parent. Quiet
 * and borderless; a row fills only on hover and opens the in-board issue page.
 * Generalizes BoardBody's status-group list to any RenderGroup.
 *
 * The last column ranks by heat (#822): every row said the same thing in the
 * same weight, so the one number a reader actually compares down the page — how
 * long this has been sitting — is the one thing that varies, and it is the only
 * colour on the row.
 */
import { isTriageLabel } from './triage-labels';
import { TriageValue } from './TriageValue';
import { gotoPath, issuePathFromUrl } from '../route';
import { AssigneeCluster } from '../ui/AssigneeCluster';
import { IssueActions, useAssignedHere } from '../ui/IssueActions';
import { ageDaysSince, ageLabel, ageToneClass } from '../ui/issue-age';
import { StatusChip } from '../ui/StatusChip';
import type { ViewerIssue } from './viewer-issue';
import type { RenderGroup } from './viewer-groups';

// Three columns (Issue · Who · Age), or two when the Who column is dropped (the
// actor avatar then rides in the Age cell). Rows carry a fourth, header-less
// 24px column that holds the ⋮ actions handle (#446) — always present, so
// revealing the handle on hover never shifts the row.
//
// Age needs 72px where the old relative-time phrase needed 176 ("yesterday", a
// month name); the 104px that buys goes back to the title, which is the column a
// reader is trying to read.
const ROW_WHO = 'grid grid-cols-[minmax(0,1fr)_56px_72px_24px] items-center gap-4';
const ROW_TRIAGE = 'grid grid-cols-[minmax(0,1fr)_110px_72px_24px] items-center gap-4';
const ROW_NO_WHO = 'grid grid-cols-[minmax(0,1fr)_72px_24px] items-center gap-4';
// The header grid keeps the same reserved trailing cell so its labels stay
// aligned over the row cells beneath them.
const HEAD_WHO = `${ROW_WHO} pb-2`;
const HEAD_TRIAGE = `${ROW_TRIAGE} pb-2`;
const HEAD_NO_WHO = `${ROW_NO_WHO} pb-2`;

// Where a row's text sits inside its own hover fill. The header, the group chips
// and the rows all carry it, so their text starts on one line.
//
// Housed in the queue region (#447) the list bleeds out by exactly that inset, so
// the text lands on the region's 16px content edge, the line its label and field
// start on, and only the hover fill reaches past it, to 6px from the block's edge.
// That is Feedback's row (`-mx-2.5` over the same padding), and it is what #447
// asked for: one left origin, with the fills running wider. The unhoused list (the
// Project page) has no region to bleed over and keeps its 14px.
const INSET = 'px-3.5';
const HOUSED_INSET = 'px-2.5';
const HOUSED_BLEED = '-mx-2.5';

// The row carries no state glyph — the Open/Closed grouping conveys lifecycle on
// the Project page, and type/status queues are all-open. In a mixed context (an
// `all` filter under a non-lifecycle grouping) a closed issue reads by a dimmed,
// lighter title instead of a colored circle.
function titleClass(depth: number, closed: boolean): string {
  if (closed) return 'truncate text-[13.5px] font-medium text-muted';
  return depth > 0
    ? 'truncate text-[13.5px] font-medium text-dim'
    : 'truncate text-[13.5px] font-semibold text-fg';
}

/** An issue's labels as small muted tags (the row's category signal; caps to
 *  keep a row on one line). */
export function LabelTags({ labels, max = 3 }: { labels: ViewerIssue['labels']; max?: number }) {
  if (!labels.length) return null;
  return (
    <>
      {labels.slice(0, max).map((l) => (
        <span
          key={l.name}
          className="flex-none rounded-[5px] bg-elevated px-[7px] py-[2px] text-[11px] leading-[1.4] text-muted"
        >
          {l.name}
        </span>
      ))}
    </>
  );
}

/** How old the issue is, and where the cell links. The age is whole days since
 *  `createdAt` — the one field both `fromProjectItem` and `fromPersonalIssue`
 *  fill, so a project row and a queue row are aged the same way and the column
 *  compares down the page.
 *
 *  The link is unchanged from when this cell said "last activity": it deep-links
 *  to the event on Github (a comment permalink), falling back to the issue URL
 *  when the event carries no permalink, so it is never dead. A project row
 *  carries a real permalink and that is worth keeping even though the cell now
 *  states an age rather than the moment it points at — which is why this is
 *  named for the age it returns and not for the event the href points at. */
function ageCell(item: ViewerIssue, now: number): { days: number | null; href: string } {
  return { days: ageDaysSince(item.createdAt, now), href: item.lastActivity?.href ?? item.htmlUrl };
}

/** The resting tone every young row wears, and the tone a CLOSED row wears at any
 *  age. Heat says "this has been sitting too long", which is a claim about work
 *  still to do: an issue opened 200 days ago and closed yesterday was drawing the
 *  row's only colour in danger red, so the reddest thing on a Project page was
 *  finished. The title already dims for closed (`titleClass`), and the age dims
 *  with it. */
const AGE_RESTING = 'text-muted';

function ageTone(item: ViewerIssue, days: number | null): string {
  if (item.state === 'closed') return AGE_RESTING;
  return ageToneClass(days, AGE_RESTING);
}

/** Blocked gets a word, in the shape a label wears (#822) — it is rare enough to
 *  cost almost no width, and it survives `hideLabels`, which is how the two
 *  surfaces this matters on draw.
 *
 *  `aging` gets nothing, and that is not the same as being covered. The two
 *  glyphs the earlier render drew — a pause bar and a clock face, both 9-10px —
 *  could not be told apart at that size, so the marker went. The Age column
 *  covers most of what it hinted, but not all of it: `aging` is board-api's own
 *  answer (`issues-metrics/aging.ts`), it starts at 30 days rather than 60, and
 *  it excludes long-lived labels. So a 35-day flow issue is aging and draws like
 *  a 2-day row, and a 400-day AOR is not aging and draws red. The Aging filter
 *  in `FilterBar` is where that set is still readable. */
function BlockedTag({ blocked }: { blocked?: boolean }) {
  if (!blocked) return null;
  return (
    <span className="flex-none rounded-[5px] bg-elevated px-[7px] py-[2px] text-[11px] leading-[1.4] text-muted">
      blocked
    </span>
  );
}

function Row({ showTriage, item, depth, hideLabels, hideWho, inset, now, sourceProject, sourceProjectOrg, mayClose, mayAssign }: {
  showTriage?: boolean;
  item: ViewerIssue; depth: number; hideLabels: boolean; hideWho: boolean;
  /** `INSET` or `HOUSED_INSET` — see there. */
  inset: string;
  /** The instant the ages are read against — see ListView. */
  now: number;
  /** The project board this row renders inside (#422) — see ListView. */
  sourceProject?: number;
  /** #697, see IssuesViewer. */ sourceProjectOrg?: string;
  /** The session's close verdict, resolved once by the viewer (#653). */
  mayClose: boolean;
  /** The session's assign verdict, resolved beside it (#1009). */
  mayAssign: boolean;
}) {
  const path = issuePathFromUrl(item.htmlUrl, sourceProject, sourceProjectOrg);
  const { days, href } = ageCell(item, now);
  // Github's answer to the last assignment made from this row (#1009), as `BoardView`'s card keeps it.
  const [assignees, setAssigned] = useAssignedHere(item.assignees);
  return (
    // The row is a grid, not a wrapping anchor, so the age cell can be
    // its own external link (the issue title stays the in-board link) — no nested
    // anchors. The whole left cell opens the in-board issue page. IssueActions
    // renders the grid itself, so right-clicking anywhere on the row reaches the
    // menu and the ⋮ lands in the row's reserved trailing cell (#446).
    <IssueActions
      issue={item}
      closed={item.state === 'closed'}
      mayClose={mayClose}
      // The same verdict and the same picker as `BoardView`'s card (#1009): the
      // two views are the same rows in two shapes and answer this together.
      mayAssign={mayAssign}
      assignSeveral
      onAssigned={setAssigned}
      className={`${hideWho ? ROW_NO_WHO : showTriage ? ROW_TRIAGE : ROW_WHO} rounded-lg ${inset} py-2 hover:bg-[var(--queue-row-hover)]`}
    >
      <a
        href={path}
        onClick={(e) => { e.preventDefault(); gotoPath(path); }}
        className="flex min-w-0 items-center gap-2 no-underline"
        style={depth ? { paddingLeft: depth * 20 } : undefined}
      >
        {depth > 0 && (
          <span className="relative top-px flex-none text-[12px] leading-none text-muted" aria-hidden="true">└</span>
        )}
        {showTriage && <TriageValue item={item} property="priority" />}
        <span className={titleClass(depth, item.state === 'closed')} title={item.title}>
          {item.title}
        </span>
        <span className="flex-none text-[11.5px] tabular-nums text-muted">#{item.number}</span>
        <BlockedTag blocked={item.blocked} />
        {!hideLabels && <LabelTags labels={showTriage ? item.labels.filter(label => !isTriageLabel(label.name)) : item.labels} />}
      </a>
      {!hideWho && <div className="flex items-center gap-1.5">{showTriage && <TriageValue item={item} property="size" />}<AssigneeCluster logins={assignees} /></div>}
      {/* Age → the last event on Github, new tab; no ↗ glyph (house rule). The
          digits sit against the column's right edge and stay `tabular-nums`, so a
          reader compares them down the page without reading any of them.
          This cell does NOT brighten on hover the way the board's other links do,
          and it is the one place that rule is off: `hover:text-fg` wins
          on specificity over the heat class, so pointing at a hot row erased the
          only colour on it — `IssueListRow` states the same rule for the same
          number ("it must never fade on hover"). The hover/focus underline identifies this
          separate GitHub destination on hover and focus.
          This is the one cell that keeps the BROWSER's context menu: it's a real
          external link, and "open link in new tab" is worth more here than a
          second route to the row's actions. Stopping the synthetic event short of
          the row's trigger (without preventing the default) is what lets Chrome's
          own menu through; right-clicking anywhere else on the row still opens ours. */}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onContextMenu={(e) => e.stopPropagation()}
        className={`flex items-center justify-end gap-2 whitespace-nowrap text-[12px] tabular-nums text-link ${ageTone(item, days)}`}
      >
        {hideWho && <>{showTriage && <TriageValue item={item} property="size" />}<AssigneeCluster logins={assignees} placeholder={false} /></>}
        <span>{ageLabel(days)}</span>
      </a>
    </IssueActions>
  );
}

export function ListView({ showTriage, groups, hideLabels = false, hideWho = false, groupDot = true, housed = false, now = Date.now(), sourceProject, sourceProjectOrg, mayClose, mayAssign }: {
  showTriage?: boolean;
  groups: RenderGroup[]; hideLabels?: boolean; hideWho?: boolean; groupDot?: boolean;
  /** Whether the list sits in the queue region (#447), whose padding it bleeds
   *  its rows out over — see `HOUSED_BLEED`. */
  housed?: boolean;
  /** The instant every row's age is measured from, defaulting to the clock —
   *  taken once for the whole list so two rows created a minute apart can never
   *  be aged against two different `now`s, and so a test can pin it (`viewerGroups`
   *  takes its own `now` for the same reason). */
  now?: number;
  /** The project board this list renders inside (#422) — when set, each row's
   *  issue link carries `?srcProject=` so the issue's breadcrumb reflects the board
   *  it was opened from. Only the Project page passes this. */
  sourceProject?: number;
  /** #697, see IssuesViewer. */ sourceProjectOrg?: string;
  /** Whether this session may close an issue (#653) — `IssuesViewer` resolves it
   *  from `/api/auth/me` once and hands it down, rather than a hook per row. */
  mayClose: boolean;
  /** Whether this session may change an issue's assignees (#1009), resolved the same way. */
  mayAssign: boolean;
}) {
  const shown = groups.filter((g) => g.rows.length > 0);
  const inset = housed ? HOUSED_INSET : INSET;
  return (
    // The gap above belongs to the region, not to the list (#447) — the viewer
    // owns the step from the chrome to whichever view is showing.
    <div className={`max-w-5xl ${housed ? HOUSED_BLEED : ''}`}>
      <div className={`${hideWho ? HEAD_NO_WHO : showTriage ? HEAD_TRIAGE : HEAD_WHO} ${inset}`}>
        <span className="text-[11px] font-medium text-muted">Issue</span>
        {!hideWho && <span className="text-[11px] font-medium text-muted">Who</span>}
        <span className="text-right text-[11px] font-medium text-muted">Age</span>
      </div>
      {/* #447: group→group is 10px, under the 12px that separates two whole blocks,
          so proximity reads the groups as parts of one queue rather than as
          sections in their own right. The group chip takes the rows' own text
          origin instead of one of its own. */}
      <div className="mt-1.5 flex flex-col gap-2.5">
        {shown.map((g) => (
          <div key={g.key}>
            <div className={`mb-1.5 flex items-center gap-2.5 ${inset}`}>
              <StatusChip tone={g.tone} label={g.label} dot={groupDot} />
              <span className="text-[12px] tabular-nums text-muted">{g.rows.length}</span>
            </div>
            <div className="flex flex-col gap-[2px]">
              {g.rows.map(({ item, depth }) => (
                <Row
                  showTriage={showTriage}
                  key={item.htmlUrl}
                  item={item}
                  depth={depth}
                  hideLabels={hideLabels}
                  hideWho={hideWho}
                  inset={inset}
                  now={now}
                  sourceProject={sourceProject}
                  sourceProjectOrg={sourceProjectOrg}
                  mayClose={mayClose}
                  mayAssign={mayAssign}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
