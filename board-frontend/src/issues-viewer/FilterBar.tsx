import { issueRepositoryFilter, repositoryFilterLabel } from '../auth/github-target';
/**
 * The IssuesViewer's fused search+filter field (#376), to the approved "Take 2"
 * chrome: ONE calm field. Active filters render as small inline tokens at its
 * head; then a "Search or filter…" input. Focusing the field opens a "Filter by"
 * command menu — every row in it names a dimension (Assignee / Project / Repo /
 * State / Type / Timeframe / Label, then the board's own fields) and opens a pane
 * of that dimension's values. Removing a token clears that filter. Zero brand
 * accent at rest.
 *
 * The root pane holds ONE kind of row (#755). Label used to be a value list
 * inlined under the dimensions, which made that pane half navigation and half
 * checkboxes, drawn identically — see the pane below for what that cost.
 *
 * Candidate values are fed by the filter-options endpoint (`options`) unioned with
 * what's present on this board, and annotated with live counts from the loaded
 * issue set — so the list is both complete and relevant, and degrades to the
 * issue-derived set if the endpoint is unavailable.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { FilterOptions, FilterProject } from '../api/issues';
import type { PersonalIssueType } from '../api/types';
import { Avatar } from '../ui/avatar';
import { MENU_LABEL, MENU_PANEL, MENU_ROW, MENU_TRIGGER, MenuOption as Opt, useDismiss } from '../ui/command-menu';
import { PICK_NONE, PickList } from '../ui/pick-list';
import { usePeople, resolvePerson } from '../people-ctx';
import type { FilterDim } from './use-viewer-state';
import { deriveCustomFields, repoKey, titleFromSlug, TYPE_LABEL, TYPE_ORDER, type ViewerFilters } from './filter-group';
import type { ViewerIssue } from './viewer-issue';

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-[15px] flex-none text-muted" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
  </svg>
);
const XIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="size-2.5" aria-hidden="true">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);
const ChevronIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ml-auto size-3 text-muted" aria-hidden="true">
    <path d="m9 18 6-6-6-6" />
  </svg>
);
const BackIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3" aria-hidden="true">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

type Pane = 'root' | 'assignee' | 'project' | 'repo' | 'state' | 'type' | 'timeframe' | 'label' | `cf:${string}`;

interface LabelCand { name: string; count: number }
interface WhoCand { login: string; name: string; count: number }
interface TypeCand { type: PersonalIssueType; label: string; count: number }
interface RepoCand { key: string; count: number }

/** The timeframe rows/chip, in display order (#401). */
const TIMEFRAME_OPTIONS: { value: ViewerFilters['timeframe']; label: string }[] = [
  { value: 'any', label: 'Any time' },
  { value: 'opened-week', label: 'Opened this week' },
  { value: 'closed-week', label: 'Closed this week' },
  { value: 'closed-yesterday', label: 'Closed yesterday' },
  // #478: the same set the Unit page's Oldest-open block counts — the block's
  // "See all N" narrows the queue to this, and the two counts agree by construction.
  { value: 'aging', label: 'Aging (30+ days)' },
];

/**
 * The board NAMES the project pane offers, in the order the endpoint sent them.
 *
 * A name rather than a board, and that is the whole of it: `filters.projects`
 * holds names (`viewer-url.ts`'s `?project=`) and a row matches on
 * `ViewerIssue.projects`, which is a list of names too — so a row IS a name, and
 * two rows spelled alike would toggle one filter between them.
 *
 * The de-dupe used to happen upstream and on the NUMBER, in
 * `/api/issues/filter-options`, which collapsed two orgs' board 3 to whichever
 * came first: a board a reader could see and could not filter to (#697). The
 * endpoint sends both now. Keying on what the row toggles is also why `key`
 * stopped being `p.number` — unique before the union, two children with one key
 * after it.
 *
 * Tolerant of an absent list, and that is not defensive habit: this read used to
 * live inside the Project sub-pane, which most readers never open, and pulling
 * it up into `useCandidates` put it on every render of every page hosting the
 * viewer. `fetchFilterOptions` returns `res.json()` unnarrowed, so a 200 whose
 * body carries no `projects` reaches here — and untolerated that is an
 * ErrorBoundary over the whole page where it used to be an empty sub-pane. Found
 * by driving the built SPA, which is the only place it shows.
 */
export function projectFilterNames(projects: FilterProject[] | undefined): string[] {
  return [...new Set((projects ?? []).map((p) => p.name))];
}

/** Union endpoint + on-board values, counted from the loaded issues, most-used first. */
function useCandidates(issues: ViewerIssue[], options: FilterOptions) {
  const people = usePeople();
  const nameOf = (login: string) => resolvePerson(people, login, null)?.displayName ?? login;
  return useMemo(() => {
    const labelCount = new Map<string, number>();
    const whoCount = new Map<string, number>();
    for (const i of issues) {
      for (const l of i.labels) labelCount.set(l.name, (labelCount.get(l.name) ?? 0) + 1);
      for (const a of i.assignees) whoCount.set(a, (whoCount.get(a) ?? 0) + 1);
    }
    for (const l of options.labels) if (!labelCount.has(l.name)) labelCount.set(l.name, 0);
    for (const a of options.assignees) if (!whoCount.has(a)) whoCount.set(a, 0);

    const labels: LabelCand[] = [...labelCount.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const assignees: WhoCand[] = [...whoCount.entries()]
      .map(([login, count]) => ({ login, name: nameOf(login), count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    // A single board's items carry no cross-board membership (#379) → no Project
    // dimension there; it lights up in Phase 2's cross-board Your-work reuse.
    const projectsPresent = issues.some((i) => i.projects.length > 0);

    const typeCount = new Map<PersonalIssueType, number>();
    for (const i of issues) typeCount.set(i.type, (typeCount.get(i.type) ?? 0) + 1);
    const types: TypeCand[] = TYPE_ORDER.map((t) => ({ type: t, label: TYPE_LABEL[t], count: typeCount.get(t) ?? 0 }));

    // Repos (#472) come only from the loaded set — there is no repo half to the
    // filter-options endpoint, and a queue that spans one repo has nothing to
    // choose between, so the dimension only appears once it can narrow anything.
    const repoCount = new Map<string, number>();
    for (const i of issues) {
      const token = issueRepositoryFilter(i);
      const k = token.startsWith('id:') ? token : repoKey(i.repo);
      if (k) repoCount.set(k, (repoCount.get(k) ?? 0) + 1);
    }
    const repos: RepoCand[] = [...repoCount.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

    return { labels, assignees, projects: projectFilterNames(options.projects), projectsPresent, types, repos };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issues, options, people]);
}

// The panel had four left origins before #755 and this row was the fourth: 8px,
// where the headings were at 10 and the rows at 34. It takes the row's own
// padding and gap now, and puts its chevron in the same 14px slot a `MenuOption`
// gives the check — so the arrow sits in the gutter column and the pane's name
// sits over the values under it.
const BACK_ROW = 'flex w-full cursor-default items-center gap-2.5 px-2.5 py-1.5 text-[11px] font-medium text-muted hover:text-dim';
const OPT_COUNT = 'ml-auto pl-4 text-[11.5px] tabular-nums text-muted';

/** The Back-to-root header atop every sub-pane (Assignee/Project/State/Type/…).
 *  The one row in these panels that is not a `MenuOption`, so it is marked and
 *  taken out of the tab order by hand — otherwise the arrows step over the way
 *  out of the pane they are walking (#739). */
function BackRow({ label, onBack }: { label: ReactNode; onBack: () => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      {...MENU_ROW}
      onMouseDown={(e) => { e.preventDefault(); onBack(); }}
      className={BACK_ROW}
    >
      <span className="flex size-3.5 flex-none items-center justify-center"><BackIcon /></span>
      {label}
    </button>
  );
}

/** A value pane's list (#1021): its search field and rows, bled out to the
 *  panel's edges so the field's rule runs across the whole panel, as it does in
 *  every other picker on the board. The fixed panes (State, Type, Timeframe)
 *  have nothing to search and stay plain rows. */
function PaneList(props: Parameters<typeof PickList>[0]) {
  return (
    <div className="-mx-1.5 -mb-1.5 mt-1 border-t border-line">
      <PickList {...props} />
    </div>
  );
}

/** The field's own fill and inner inset. The fill is the region's chrome tone
 *  (#447), so the field keeps reading as a field whether it sits on the page
 *  canvas or inside a housed queue's block; the 14px inset puts the search icon on
 *  the queue's shared text origin. */
const FIELD = 'flex min-h-9 w-full flex-wrap items-center gap-2 rounded-[10px] bg-[var(--queue-chrome)] px-3.5 py-1';

/** One active filter as a removable token at the head of the field. */
function Token({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return (
    <span className="flex h-6 flex-none items-center gap-1.5 whitespace-nowrap rounded-[7px] bg-[var(--queue-chip)] pl-2 pr-1 text-[12px] text-fg">
      {children}
      <button
        type="button"
        aria-label="Remove filter"
        onMouseDown={(e) => { e.preventDefault(); onRemove(); }}
        className="flex size-4 cursor-pointer items-center justify-center rounded-[5px] text-muted hover:bg-white/10 hover:text-fg"
      >
        <XIcon />
      </button>
    </span>
  );
}

export function FilterBar({
  q, filters, options, issues, showStateFilter = true,
  onQuery, onToggle, onLifecycle, onToggleCustomField, onTimeframe, onToggleUnassigned,
}: {
  q: string;
  filters: ViewerFilters;
  options: FilterOptions;
  issues: ViewerIssue[];
  /** Offer the State (Open/All) filter dimension. Off when the grouping already
   *  splits by lifecycle (Open/Closed), where it would be a no-op. */
  showStateFilter?: boolean;
  onQuery: (q: string) => void;
  onToggle: (dim: FilterDim, value: string) => void;
  onLifecycle: (s: 'open' | 'all') => void;
  /** Toggle a value within a board custom field (Priority, Sprint, …) (#401). */
  onToggleCustomField: (slug: string, value: string) => void;
  /** Set the recency-window filter (#401). */
  onTimeframe: (tf: ViewerFilters['timeframe']) => void;
  /** Turn the no-assignee filter on or off (#462) — it lives at the head of the
   *  Assignee pane, since "nobody" is an answer to the same question. */
  onToggleUnassigned: () => void;
}) {
  const people = usePeople();
  const nameOf = (login: string) => resolvePerson(people, login, null)?.displayName ?? login;
  const { labels, assignees, projects, projectsPresent, types, repos } = useCandidates(issues, options);
  const facets = useMemo(() => deriveCustomFields(issues), [issues]);

  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>('root');
  const wrap = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const activeFacet = pane.startsWith('cf:') ? facets.find((f) => f.slug === pane.slice(3)) : undefined;

  useDismiss(open, wrap, () => { setOpen(false); setPane('root'); });

  // Out of a value pane, by its Back row or by Backspace in its empty field.
  // Focus goes to the filter field: the pane's own field is about to unmount,
  // and left there focus falls to `<body>`, where typing reaches nothing.
  const back = () => {
    setPane('root');
    field.current?.focus();
  };

  // When the grouping already splits by lifecycle (Open/Closed), the State
  // dimension is suppressed — a stale `?state=all` from a shared URL then has no
  // effect on the render, so don't surface it as an inert token either (#376).
  const stateActive = showStateFilter && filters.state === 'all';
  const hasTokens =
    filters.labels.length + filters.assignees.length + filters.projects.length +
      filters.repos.length + filters.types.length > 0 ||
    Object.keys(filters.customFields).length > 0 ||
    filters.timeframe !== 'any' ||
    filters.unassigned ||
    stateActive;

  return (
    <div ref={wrap} className="relative flex min-w-[220px] flex-1">
      <div
        className={FIELD}
        // The input fills only part of this box, so a press on the search icon
        // or the padding used to open the menu and leave focus on `<body>` —
        // a field you have just clicked into that then takes nothing you type.
        // Focusing it here is also what tells the menu a reader is typing rather
        // than walking the rows (#739).
        onClick={() => {
          setOpen(true);
          field.current?.focus();
        }}
      >
        <SearchIcon />
        {filters.labels.map((name) => (
          <Token key={`l-${name}`} onRemove={() => onToggle('labels', name)}>
            <span className="text-muted">label:</span>{name}
          </Token>
        ))}
        {filters.unassigned && (
          <Token onRemove={onToggleUnassigned}>
            <span className="text-muted">assignee:</span>unassigned
          </Token>
        )}
        {filters.assignees.map((login) => (
          <Token key={`a-${login}`} onRemove={() => onToggle('assignees', login)}>
            <Avatar name={nameOf(login)} login={login} px={36} className="pj-av-sm" showTitle={false} />
            {nameOf(login)}
          </Token>
        ))}
        {filters.projects.map((name) => (
          <Token key={`p-${name}`} onRemove={() => onToggle('projects', name)}>
            <span className="text-muted">project:</span>{name}
          </Token>
        ))}
        {filters.repos.map((key) => (
          <Token key={`r-${key}`} onRemove={() => onToggle('repos', key)}>
            <span className="text-muted">repo:</span>{repositoryFilterLabel(key)}
          </Token>
        ))}
        {stateActive && (
          <Token onRemove={() => onLifecycle('open')}>
            <span className="text-muted">state:</span>all
          </Token>
        )}
        {filters.types.map((t) => (
          <Token key={`t-${t}`} onRemove={() => onToggle('types', t)}>
            <span className="text-muted">type:</span>{TYPE_LABEL[t]}
          </Token>
        ))}
        {Object.entries(filters.customFields).flatMap(([slug, values]) =>
          values.map((v) => (
            <Token key={`cf-${slug}-${v}`} onRemove={() => onToggleCustomField(slug, v)}>
              <span className="text-muted">{titleFromSlug(slug).toLowerCase()}:</span>{v}
            </Token>
          )),
        )}
        {filters.timeframe !== 'any' && (
          <Token onRemove={() => onTimeframe('any')}>
            {TIMEFRAME_OPTIONS.find((o) => o.value === filters.timeframe)?.label}
          </Token>
        )}
        <input
          ref={field}
          value={q}
          onChange={(e) => onQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          // The trigger is the field itself (#739), so Escape returns the reader
          // here rather than to <body> — and the arrows enter the menu from here
          // instead of taking focus off a field that is there to be typed in.
          {...MENU_TRIGGER}
          placeholder={hasTokens ? 'Filter…' : 'Search or filter…'}
          aria-label="Search or filter issues"
          autoComplete="off"
          className="min-w-[60px] flex-1 border-none bg-transparent text-[13px] text-fg outline-none placeholder:text-muted"
        />
      </div>

      {open && (
        <div className={`${MENU_PANEL} left-0 top-[calc(100%+6px)] w-[248px]`}>
          {pane === 'root' && (
            <>
              <div className={MENU_LABEL}>Filter by</div>
              <Opt onSelect={() => setPane('assignee')}>Assignee<ChevronIcon /></Opt>
              {projectsPresent && <Opt onSelect={() => setPane('project')}>Project<ChevronIcon /></Opt>}
              {repos.length > 1 && <Opt onSelect={() => setPane('repo')}>Repo<ChevronIcon /></Opt>}
              {showStateFilter && <Opt onSelect={() => setPane('state')}>State<ChevronIcon /></Opt>}
              <Opt onSelect={() => setPane('type')}>Type<ChevronIcon /></Opt>
              <Opt onSelect={() => setPane('timeframe')}>Timeframe<ChevronIcon /></Opt>
              {labels.length > 0 && <Opt onSelect={() => setPane('label')}>Label<ChevronIcon /></Opt>}
              {facets.length > 0 && (
                <>
                  {/* "Project fields", not "Board fields" (#979). These are one
                      GitHub project's own custom fields, and the page drawing
                      them is headed by that project's name; "board" is what this
                      app calls itself everywhere else, so the heading named the
                      wrong thing. Not because the "Project" row above is beside
                      it — it never is (#1101 review, S4). That row needs
                      `projectsPresent`, and only `fromPersonalIssue` fills
                      `projects`, while only `fromProjectItem` carries the
                      `customFields` these facets come from. The two are
                      mutually exclusive by construction. */}
                  <div className={MENU_LABEL}>Project fields</div>
                  {facets.map((f) => (
                    <Opt key={f.slug} onSelect={() => setPane(`cf:${f.slug}`)}>{f.name}<ChevronIcon /></Opt>
                  ))}
                </>
              )}
            </>
          )}

          {/* Label is a dimension like the rest (#755), not a list inlined under
              the others. It was the one value list living in the root pane, and
              it is what made that pane hold two kinds of row: six that navigate
              and can never show a check, and a dozen that toggle and can. Every
              row up there navigates now, so none of them reserves the gutter,
              and the divider and second heading that separated the two kinds
              have nothing left to separate. The cost is a click: a label used to
              be one press from the open panel and is now two. */}
          {pane === 'label' && (
            <>
              <BackRow label="Label" onBack={back} />
              <PaneList
                noun="labels"
                items={labels.map((l) => ({ id: l.name, name: l.name, count: l.count }))}
                selected={filters.labels}
                onPick={(id) => onToggle('labels', id)}
                onEmptyBackspace={back}
              />
            </>
          )}

          {pane === 'assignee' && (
            <>
              <BackRow label="Assignee" onBack={back} />
              {/* "Nobody" is an answer to the same question, so it heads the
                  list rather than becoming a dimension of its own (#462). */}
              <PaneList
                noun="people"
                items={assignees.map((a) => ({
                  id: a.login,
                  name: a.name,
                  count: a.count,
                  mark: <Avatar name={a.name} login={a.login} px={40} className="pj-av-xs" showTitle={false} />,
                }))}
                lead={{ id: PICK_NONE, name: 'Unassigned', count: issues.filter((i) => i.assignees.length === 0).length }}
                selected={filters.unassigned ? [PICK_NONE, ...filters.assignees] : filters.assignees}
                onPick={(id) => (id === PICK_NONE ? onToggleUnassigned() : onToggle('assignees', id))}
                onEmptyBackspace={back}
              />
            </>
          )}

          {pane === 'project' && (
            <>
              <BackRow label="Project" onBack={back} />
              <PaneList
                noun="projects"
                items={projects.map((name) => ({ id: name, name }))}
                selected={filters.projects}
                onPick={(id) => onToggle('projects', id)}
                onEmptyBackspace={back}
              />
            </>
          )}

          {pane === 'repo' && (
            <>
              <BackRow label="Repo" onBack={back} />
              <PaneList
                noun="repos"
                items={repos.map((r) => ({ id: r.key, name: repositoryFilterLabel(r.key), count: r.count }))}
                selected={filters.repos}
                onPick={(id) => onToggle('repos', id)}
                onEmptyBackspace={back}
              />
            </>
          )}

          {pane === 'state' && (
            <>
              <BackRow label="State" onBack={() => setPane('root')} />
              <Opt selected={filters.state === 'open'} onSelect={() => onLifecycle('open')}>Open</Opt>
              <Opt selected={filters.state === 'all'} onSelect={() => onLifecycle('all')}>All</Opt>
            </>
          )}

          {pane === 'type' && (
            <>
              <BackRow label="Type" onBack={() => setPane('root')} />
              {/* A fixed set of words, so no field and no scroller: a scroll box
                  also clips the focus outline held 2px off its first and last
                  rows (#1020). */}
              {types.map((t) => (
                <Opt key={t.type} selected={filters.types.includes(t.type)} onSelect={() => onToggle('types', t.type)}>
                  {t.label}
                  <span className={OPT_COUNT}>{t.count}</span>
                </Opt>
              ))}
            </>
          )}

          {activeFacet && (
            <>
              <BackRow label={activeFacet.name} onBack={back} />
              <PaneList
                noun="values"
                items={activeFacet.values.map((v) => ({ id: v.name, name: v.name, count: v.count }))}
                selected={filters.customFields[activeFacet.slug] ?? []}
                onPick={(id) => onToggleCustomField(activeFacet.slug, id)}
                onEmptyBackspace={back}
              />
            </>
          )}

          {pane === 'timeframe' && (
            <>
              <BackRow label="Timeframe" onBack={() => setPane('root')} />
              {TIMEFRAME_OPTIONS.map((o) => (
                <Opt key={o.value} selected={filters.timeframe === o.value} onSelect={() => onTimeframe(o.value)}>
                  {o.label}
                </Opt>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
