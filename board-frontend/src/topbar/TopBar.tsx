/**
 * Global search and sync status. Search is centered in the desktop content
 * header; below 900px the menu, search and compact sync share the available row.
 * Owns the command palette and its global keyboard shortcut.
 */

import { useEffect, useId, useState, type RefObject } from 'react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '../ui/kit';
import { Route } from '../route';
import { CommandPalette } from '../search/CommandPalette';
import { SavedDataStatus } from '../auth/SavedDataStatus';
import { SOURCE_NAMES, SOURCE_STATES, SYNC_SOURCES, type BoardFreshness, type SyncOperation } from '../sync/sync-operation';
import { agoLabel, freshnessLabel, sourceSyncedAt, summariseFreshness } from '../sync/board-freshness';
import { useSyncStatus, STALE_AFTER_MS } from '../sync/sync-status';
import { SyncShape } from '../ui/ProbeShell';

/** The three lines a phone's row of chrome is made of (#608). Hoisted so the row
 *  reads as a row and not as three paragraphs of class names. */
const ROW = 'sticky top-0 z-20 grid grid-cols-[minmax(140px,1fr)_minmax(0,340px)_minmax(220px,1fr)] h-16 flex-none items-center gap-4 border-b border-line bg-surface-2 px-7 max-[901px]:grid-cols-[44px_minmax(0,1fr)_auto] max-[901px]:gap-2 max-[901px]:px-3';
const FOCUS = 'focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-accent';
const MENU_BUTTON = `hidden max-[901px]:inline-flex size-11 cursor-pointer justify-self-start items-center justify-center rounded-[9px] text-fg hover:bg-elevated aria-expanded:bg-elevated ${FOCUS}`;
const SEARCH = `col-start-2 h-11 w-full min-w-0 justify-start gap-2 rounded-[9px] border-line bg-field px-[11px] font-normal text-muted hover:border-line-strong hover:bg-field hover:text-muted ${FOCUS}`;

/** The circular-refresh affordance (#301) — the "sync now" click target. Spins
 *  while a sync is in flight. */
function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      className={`flex-none ${spinning ? 'motion-safe:animate-[spin_1.6s_linear_infinite]' : ''}`}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

/** What the sync popover holds (#1036). Its own component so a spec can render
 *  it: the popover portals its content, and a portal draws nothing without a DOM.
 *  With no sync run in this tab there is no status line (#1037); the rows say it.
 *  The `role="status"` box around that line is drawn in every state, empty or not,
 *  because the popover names it in `aria-describedby`, and because a polite live
 *  region has to be in the tree already for a reader to announce the line arriving. */
export function SyncSources({ titleId, statusId, label, syncing, syncError, operation, freshness, requestSync }: {
  titleId: string;
  statusId: string;
  label: string;
  syncing: boolean;
  syncError: boolean;
  operation: SyncOperation | null;
  /** When each source last refreshed, as the server reports it (#1169). */
  freshness: BoardFreshness | null;
  requestSync: () => void;
}) {
  const refreshed = operation ? SYNC_SOURCES.filter((key) => operation.sources[key].state === 'succeeded').length : 0;
  const status = syncing ? label : operation ? `${refreshed} of 5 sources refreshed.` : syncError ? 'Couldn’t check the sync. What each source did is unknown.' : null;
  return (
    <>
      <h2 id={titleId} className="text-[15px] font-semibold text-fg">Board sync</h2>
      <div id={statusId} role="status">{status && <p className="mt-1 text-[12px] text-dim">{status}</p>}</div>
      {/* The live region is for a RUN, and only for a run (#1169). It was added
          so a source settling during a sync is announced as it happens. The rows
          say an AGE now when no run is in flight, and that age is recomputed
          every twenty seconds by the tick in `SyncStamp` — so a panel left open
          would read all four rows aloud every twenty seconds to say that eight
          minutes had become nine. A clock ticking is not news. */}
      <ul className="mt-2 divide-y divide-line text-[12px]" aria-live={operation ? 'polite' : 'off'} aria-atomic="false">
        {SYNC_SOURCES.map((key) => {
          // A run in flight is what this row says, because it is moving and a
          // person pressed the button to watch it. With no run, the row says
          // when this source last refreshed — which is the fact the header chip
          // is also reading (#1169). A missing time may mean a cold cache or
          // incomplete coverage, so point to the sync action without claiming
          // the source has never been read (#1275).
          const state = operation?.sources[key].state;
          const at = sourceSyncedAt(freshness, key);
          const coverage = freshness?.sources[key]?.organisations;
          const reading = !coverage ? null : coverage.total === 1
            ? `${coverage.recorded} of ${coverage.total} organisation, `
            : `${coverage.recorded} of ${coverage.total} organisations, `;
          return <li key={key} className="flex items-center justify-between gap-3 py-2.5">
            <span>{SOURCE_NAMES[key]}</span>
            {state
              ? <span className={state === 'failed' || state === 'degraded' || state === 'unknown' ? 'text-danger' : state === 'succeeded' ? 'text-success' : 'text-dim'}>{SOURCE_STATES[state]}</span>
              : <span className="text-dim" title={at ?? 'No cache time available. Use Sync all four sources below.'}>{reading}<span>{at ? agoLabel(at) : 'Sync to refresh'}</span></span>}
          </li>;
        })}
      </ul>
      <Button type="button" disabled={syncing} onClick={requestSync} className="mt-3 min-h-11 w-full">{syncing ? 'Syncing…' : syncError ? 'Retry sync' : 'Sync all four sources'}</Button>
    </>
  );
}

/** Shared by the header and phone navigation: one provider owns the operation. */
export function SyncStamp({ compactOnPhone = false }: { compactOnPhone?: boolean }) {
  const { freshness, syncing, syncError, operation, requestSync, pageMayBeOutdated } = useSyncStatus();
  // `sync/board-freshness.ts` is where four moments become the handful of
  // characters this chip has, and it is the whole of that decision: which
  // moments count, and which words come out. This file composes none of them —
  // it draws what that module returns — so the rule its docblock sets out, and
  // the two readings ruled out with it, live there and nowhere else (#1169).
  const summary = summariseFreshness(freshness);
  const { syncedAt } = summary;
  const titleId = useId();
  const statusId = useId();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 20_000);
    return () => clearInterval(id);
  }, []);
  const stale = syncedAt ? Date.now() - Date.parse(syncedAt) > STALE_AFTER_MS : false;
  const finished = operation ? SYNC_SOURCES.filter((key) => !['pending', 'running'].includes(operation.sources[key].state)).length : 0;
  const label = syncing ? (operation ? `Syncing, ${finished}/5 finished` : 'Starting sync…')
    : syncError ? (operation?.state === 'failed' ? 'Sync failed' : operation?.state === 'interrupted' || !operation ? 'Sync unconfirmed' : 'Sync incomplete')
    : freshnessLabel(summary);
  const colour = syncError ? 'var(--pink)' : stale || pageMayBeOutdated ? 'var(--amber)' : 'var(--accent)';
  return (
    <div className="flex min-w-0 items-center">
      {/* A popover, not a modal (#1036): the page stays lit and live behind it,
          and an outside click, Escape or the chevron closes it. It stays open when
          a sync finishes, so the row that failed is still in front of the reader.
          It keeps at least a 12px gutter from every screen edge, and scrolls
          inside itself when the screen is shorter than the list. */}
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" aria-label="View sync sources" aria-description={pageMayBeOutdated ? `${label}. This page may be showing out-of-date data.` : label} title="View sync sources" className={`flex min-w-0 cursor-pointer items-center gap-1 rounded-[6px] hover:bg-surface-3 ${FOCUS}`}>
            {pageMayBeOutdated ? (
              <span role="img" aria-label="This page may be showing out-of-date data." title="This page may be showing out-of-date data." style={{ color: colour }} className="flex size-7 shrink-0 items-center justify-center rounded-md text-lg font-semibold max-sm:size-11">!</span>
            ) : (
              <span aria-hidden="true" style={{ color: colour }} className="flex size-7 shrink-0 items-center justify-center rounded-md max-sm:size-11"><RefreshIcon spinning={syncing} /></span>
            )}
            <span title={label} className={`min-w-0 max-w-[160px] truncate text-[12px] text-dim ${compactOnPhone ? 'max-[901px]:hidden' : ''}`}>{label}</span>
            <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-md max-sm:size-11 text-dim"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg></span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} collisionPadding={12} aria-labelledby={titleId} aria-describedby={statusId} className="max-h-[var(--radix-popover-content-available-height)] w-[340px] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain rounded-[12px]">
          <SyncSources titleId={titleId} statusId={statusId} label={label} syncing={syncing} syncError={syncError} operation={operation} freshness={freshness} requestSync={requestSync} />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** The menu glyph — three rules, the one shape a phone reads as "the rest of the
 *  app is behind this". Local, beside RefreshIcon, for the same reason: it is
 *  this bar's own furniture and nothing else draws it. */
function MenuGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" className="flex-none" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function TopBar({
  onNavigate,
  pageName,
  menuOpen,
  onMenuToggle,
  menuButtonRef,
  savedData = false,
  probing = false,
}: {
  route: Route;
  onNavigate: (r: Route) => void;
  /** The page's own name when the menu already says it (#608) — else null. */
  pageName: string | null;
  menuOpen: boolean;
  onMenuToggle: () => void;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
  /** A page is showing its last successful data while a new read runs. */
  savedData?: boolean;
  /** The identity probe has not answered yet (#1229 step 1). The bar is drawn —
   *  it is furniture, and the search it carries is the reader's way out of a
   *  wrong route — but the sync chip is a placeholder, because its own read is
   *  held until the probe speaks. */
  probing?: boolean;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Global ⌘K / Ctrl-K toggles the palette (ignored inside inputs other than
  // the palette's own, which handles its keys locally).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className={ROW}>
      {/* The phone's menu (#608): everything the sidebar holds — the five tabs,
          the account, the theme — is one tap behind this, so the shell costs one
          row instead of four bands. Never rendered above 900px. */}
      <button
        type="button"
        ref={menuButtonRef}
        onClick={onMenuToggle}
        aria-expanded={menuOpen}
        aria-controls="shell-menu"
        aria-label={pageName ? `${pageName} — menu` : 'Menu'}
        className={MENU_BUTTON}
      >
        <MenuGlyph />

      </button>

      <Button
        type="button"
        variant="outline"
        onClick={() => setPaletteOpen(true)}
        aria-label="Search the board"
        className={SEARCH}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-none opacity-80">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3-3" />
        </svg>
        {/* The marker beside this box draws its words at every width now
            (#1410), so under 340px what is left for this word is narrower than
            the word. A clipped "S…" names nothing, so below that width the
            magnifier stands alone and `aria-label` names the control. */}
        <span className="min-w-0 flex-1 truncate text-left text-[13px] max-[339px]:hidden">Search…</span>
        <kbd className="rounded border border-line bg-surface-2 px-[5px] py-px font-mono text-[10.5px] font-semibold text-muted max-[901px]:hidden">
          ⌘K
        </kbd>
      </Button>

      {/* The one global sync stamp, pinned far-right. Below 900px it keeps the
          freshness dot and the refresh glyph and drops the words, which the menu
          sheet spells out in full. */}
      {/* Its glyph lands on the page's own 12px gutter below 900px; the padding
          that keeps the tap target comfortable hangs off the end. */}
      {/* The access re-check sits left of it (#1063). `max-w-full` holds the
          pair inside the column, so a long sync label truncates rather than
          pushing either one under the search box. */}
      <div className="col-start-3 justify-self-end flex min-w-0 max-w-full flex-none items-center">
        <SavedDataStatus savedData={savedData} />
        {probing ? <SyncShape /> : <SyncStamp compactOnPhone />}
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={onNavigate}
      />
    </header>
  );
}
