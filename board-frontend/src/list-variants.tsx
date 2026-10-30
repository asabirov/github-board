/**
 * SCRATCH — preview-only (#822). The three directions for the issue list, each
 * painting the SAME `RenderGroup[]` the real `ListView` is handed, so the four
 * panels on `list-preview.tsx` differ in treatment and in nothing else. Nothing
 * in the app imports this file.
 *
 * The rows come from `scripts/fixtures/team-api.json` through the real
 * `fromPersonalIssue` + `viewerGroups`, grouped by type — Bugs / Features /
 * Other, the shape the Project page shows.
 *
 * Age is the only colour in all three, on the board's shared thresholds — 60d
 * warning, 90d danger, straight out of `ui/issue-age`, which both the real
 * `ListView` and the "Oldest open" row spend. No second age vocabulary is
 * invented here, and no copy of the two numbers lives in this file.
 */
import { AssigneeCluster } from './ui/AssigneeCluster';
import { StatusChip } from './ui/StatusChip';
import { DEFAULT_FILTERS } from './issues-viewer/filter-group';
import { viewerGroups, type RenderGroup } from './issues-viewer/viewer-groups';
import { fromPersonalIssue, type ViewerIssue } from './issues-viewer/viewer-issue';
import { ageDaysSince, ageToneClass } from './ui/issue-age';
import type { PersonalIssue } from './api/issues';
import fixtureRaw from '../scripts/fixtures/team-api.json?raw';

const DAY = 86_400_000;

// The page reads the clock ONCE, at the start of the current UTC day, and every
// timestamp on it is `ageDays` back from that. So a row's age is exactly the
// fixture's `ageDays` whenever the page is opened, and `relTime` in the Today
// panel still lands on the mixture it lands on in the app (yesterday / 4d ago /
// Jun 23) rather than on one branch of itself. Nothing here is random; the only
// thing that moves between two runs on different days is the absolute date
// `relTime` prints, which is the very thing directions A/B/C drop.
const ANCHOR = (() => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
})();

function fixtureIssues(): ViewerIssue[] {
  const file = JSON.parse(fixtureRaw) as Record<string, { body: unknown }>;
  const raw = file['/api/issues/all'].body;
  const body = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { issues: PersonalIssue[] };
  return body.issues.map((i) => {
    const item = fromPersonalIssue(i);
    const atISO = new Date(ANCHOR - i.ageDays * DAY).toISOString();
    return { ...item, updatedAt: atISO, lastActivity: { type: 'commented' as const, atISO, href: i.htmlUrl } };
  });
}

export const GROUPS: RenderGroup[] = viewerGroups(
  fixtureIssues(),
  { group: 'type', filters: DEFAULT_FILTERS },
  ANCHOR,
);

/** Days since the row's last activity — whole days off the same anchor, so it
 *  is the fixture's `ageDays` back again and never a fraction. The arithmetic is
 *  the app's own, so a preview row cannot be a day out from the row it previews. */
function ageOf(item: ViewerIssue): number {
  return ageDaysSince(item.lastActivity?.atISO ?? item.createdAt, ANCHOR) ?? 0;
}

/** The shared thresholds; the cold rest state is the list's own muted tertiary
 *  rather than the block's secondary, so a young row keeps the contrast it has
 *  today. */
const heatText = (days: number) => ageToneClass(days, 'text-muted');

/** The same three steps as a fill, for C's rail — read off `heatText` rather than
 *  restated, so the two numbers stay in one file. The cold step is a real border
 *  grey rather than a surface fill: the rail has to be a continuous ruled edge
 *  for a warm one to read as a break in it, and `bg-elevated` at 3px was
 *  invisible against the canvas. */
const FILL_FOR: Record<string, string> = {
  'text-danger': 'bg-danger',
  'text-warn': 'bg-warn',
};
function heatFill(days: number): string {
  return FILL_FOR[heatText(days)] ?? 'bg-line-strong';
}

/** One date format down the whole column: always whole days. */
const age = (item: ViewerIssue) => `${ageOf(item)}d`;

/** Blocked and aging as small drawn marks rather than words — quiet, tertiary,
 *  and never coloured, so age keeps the only colour on the row. */
function Marks({ item }: { item: ViewerIssue }) {
  if (!item.blocked && !item.aging) return null;
  return (
    <span className="flex flex-none items-center gap-[5px] text-muted">
      {item.blocked && (
        <svg width="9" height="9" viewBox="0 0 10 10" role="img" aria-label="Blocked">
          <rect x="1.5" y="1" width="2.5" height="8" rx="1" fill="currentColor" />
          <rect x="6" y="1" width="2.5" height="8" rx="1" fill="currentColor" />
        </svg>
      )}
      {item.aging && (
        <svg width="10" height="10" viewBox="0 0 10 10" role="img" aria-label="Aging">
          <circle cx="5" cy="5" r="3.9" fill="none" stroke="currentColor" strokeWidth="1.1" />
          <path d="M5 2.6V5h2" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}

/** Labels as the board draws them, with a real Github colour where the source
 *  carries one — queue rows carry `color: ''` and fall back to the muted tag. */
function Labels({ labels, max = 3 }: { labels: ViewerIssue['labels']; max?: number }) {
  if (!labels.length) return null;
  return (
    <>
      {labels.slice(0, max).map((l) => (
        <span
          key={l.name}
          className="flex-none rounded-[5px] bg-elevated px-[7px] py-[2px] text-[11px] leading-[1.4] text-muted"
          style={l.color ? { color: `#${l.color}` } : undefined}
        >
          {l.name}
        </span>
      ))}
    </>
  );
}

/**
 * What every direction takes. `hideLabels` is the real `ListView` prop under its
 * own name: the two surfaces this issue is about — the Dashboard's "Your queue"
 * and Overview's "Open issues" — share `IssueQueue`, which sets `hideRowLabels`.
 * The row a reader meets there carries no label chips at all. A direction
 * leaning on them has to be seen without them.
 */
interface Variant { groups: RenderGroup[]; hideLabels?: boolean }

/** The group chip + count, identical to the one `ListView` draws, so the panels
 *  differ in the rows and nowhere else. */
function Groups({ groups, head, row }: {
  groups: RenderGroup[];
  head: React.ReactNode;
  row: (item: ViewerIssue) => React.ReactNode;
}) {
  return (
    <div className="max-w-5xl">
      {head}
      <div className="mt-1.5 flex flex-col gap-2.5">
        {groups.filter((g) => g.rows.length).map((g) => (
          <div key={g.key}>
            <div className="mb-1.5 flex items-center gap-2.5 px-3.5">
              <StatusChip tone={g.tone} label={g.label} />
              <span className="text-[12px] tabular-nums text-muted">{g.rows.length}</span>
            </div>
            <div className="flex flex-col gap-[2px]">
              {g.rows.map(({ item }) => (
                <div key={`${item.repo}#${item.number}`}>{row(item)}</div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── A — rank by heat ────────────────────────────────────────────────────────
// Today's row, at today's density. The age column carries colour and one format;
// `#id` leaves the title's side for a quiet column of its own at the right of the
// cell, where it stops competing with the words.
const A_GRID = 'grid grid-cols-[minmax(0,1fr)_56px_64px] items-center gap-4';

export function VariantA({ groups, hideLabels = false }: Variant) {
  return (
    <Groups
      groups={groups}
      head={
        <div className={`${A_GRID} px-3.5 pb-2 text-[11px] font-medium text-muted`}>
          <span>Issue</span>
          <span>Who</span>
          <span className="text-right">Age</span>
        </div>
      }
      row={(item) => (
        <div className={`${A_GRID} rounded-lg px-3.5 py-2 hover:bg-[var(--queue-row-hover)]`}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold text-fg">{item.title}</span>
            <Marks item={item} />
            {!hideLabels && <Labels labels={item.labels} />}
            <span className="ml-auto flex-none pl-3 text-[11px] tabular-nums text-muted/70">
              #{item.number}
            </span>
          </span>
          <AssigneeCluster logins={item.assignees} />
          <span className={`text-right text-[12px] tabular-nums ${heatText(ageOf(item))}`}>{age(item)}</span>
        </div>
      )}
    />
  );
}

// ── B — two-line row ────────────────────────────────────────────────────────
// The title keeps the line to itself; everything that qualified it moves under it
// in small type. Half as many rows reach the fold, which is the trade this panel
// is here to show.
export function VariantB({ groups, hideLabels = false }: Variant) {
  return (
    <Groups
      groups={groups}
      head={<div className="px-3.5 pb-2 text-[11px] font-medium text-muted">Issue</div>}
      row={(item) => (
        <div className="rounded-lg px-3.5 py-2 hover:bg-[var(--queue-row-hover)]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold text-fg">{item.title}</span>
            <Marks item={item} />
          </div>
          <div className="mt-[5px] flex items-center gap-3 text-[11.5px] text-muted">
            <span className="flex-none tabular-nums">{item.repo}#{item.number}</span>
            {!hideLabels && <Labels labels={item.labels} max={2} />}
            <AssigneeCluster logins={item.assignees} />
            <span className={`ml-auto flex-none tabular-nums ${heatText(ageOf(item))}`}>{age(item)}</span>
          </div>
        </div>
      )}
    />
  );
}

// ── C — left rail ───────────────────────────────────────────────────────────
// The scan runs down the left edge — a stripe and a number, both on the heat
// scale — and the title is the only other thing at full strength. Everything
// right of it waits for the pointer.
const C_GRID = 'group grid grid-cols-[3px_30px_minmax(0,1fr)_auto] items-center gap-3';

export function VariantC({ groups, hideLabels = false }: Variant) {
  return (
    <Groups
      groups={groups}
      head={
        <div className={`${C_GRID} px-3.5 pb-2 text-[11px] font-medium text-muted`}>
          <span />
          <span className="text-right">Age</span>
          <span>Issue</span>
          <span />
        </div>
      }
      row={(item) => (
        <div className={`${C_GRID} rounded-lg px-3.5 py-[7px] hover:bg-[var(--queue-row-hover)]`}>
          <span className={`h-[18px] w-[3px] rounded-full ${heatFill(ageOf(item))}`} aria-hidden="true" />
          <span className={`text-right text-[12px] tabular-nums ${heatText(ageOf(item))}`}>{ageOf(item)}</span>
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold text-fg">{item.title}</span>
            <Marks item={item} />
          </span>
          <span className="flex flex-none items-center gap-2 opacity-30 transition-opacity group-hover:opacity-100">
            {!hideLabels && <Labels labels={item.labels} max={2} />}
            <span className="text-[11px] tabular-nums text-muted">#{item.number}</span>
            <AssigneeCluster logins={item.assignees} />
          </span>
        </div>
      )}
    />
  );
}
