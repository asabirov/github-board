import { useResponseState } from '../auth/use-response-state';
import { useRenewalSignal, useAccessEpoch } from '../sync/sync-status';
/**
 * ⌘K command palette (#108). People come from the shared context. Results are
 * grouped by kind; the kit's cmdk-based Command owns keyboard nav (arrow keys,
 * Enter, hover-select) and row highlight over our pre-filtered `results` list
 * (`shouldFilter=false` — our own search-index ranking is the source of truth,
 * cmdk just drives selection across whichever CommandItems we render).
 * (Broadening to projects + issues is tracked in #214.)
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  Dialog,
  DialogContent,
  DialogTitle,
} from '../ui/kit';
import { Route } from '../route';
import { usePeople } from '../people-ctx';
import { type SearchIssue, fetchSearchIssues } from '../api/issues';
import { fetchProjects } from '../api/projects';
import { useOrgScope } from '../org-scope/OrgScopeProvider';
import {
  type HeldBoards,
  NOTHING_HELD,
  answered,
  atAddress,
  boardsOf,
  mustRead,
} from './palette-boards';
import {
  KIND_LABEL,
  SearchItem,
  groupByKind,
  issueItems,
  peopleItems,
  projectItems,
  searchItems,
} from './search-index';

const RECENT_KEY = 'board.search.recent.v1';

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}
function pushRecent(id: string): void {
  try {
    const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage disabled — recents just don't persist */
  }
}

/** Highlight the first query token inside a title, case-insensitively. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const token = query.trim().toLowerCase().split(/\s+/)[0];
  if (!token) return <>{text}</>;
  const i = text.toLowerCase().indexOf(token);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent font-bold text-fg">{text.slice(i, i + token.length)}</mark>
      {text.slice(i + token.length)}
    </>
  );
}

export function CommandPalette({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (r: Route) => void;
}) {
  const people = usePeople();
  const [query, setQuery] = useState('');
  // Projects + the open-issue index are fetched lazily the first time the palette
  // opens (people are already in context) and reused across opens.
  const [issues, setIssues] = useState<SearchIssue[]>([]);
  // The org the address narrowed to (#714). `/api/projects` carries it and
  // `/api/search/issues` does not, so the board list below is the scoped half
  // of this index and the issues are the union's, as they have always been.
  const { org } = useOrgScope();
  // The boards, and the org they were read for, as ONE value (#714). They were
  // two — a `projects` list an effect emptied on every org change, and a
  // `loadedFor` latch only the success handler wrote — and on `/acme` →
  // `/globex` → `/acme` they drifted: the list went, the latch stayed on
  // acme, and the guard below then refused to read again. The palette
  // offered no boards at all for the life of the page. `palette-boards.ts` holds
  // the rule and `palette-boards.spec.ts` walks that round trip; a decision left
  // in a `useEffect` cannot be pinned at all, this suite having no DOM.
  const [read, setRead] = useResponseState<HeldBoards>(NOTHING_HELD, NOTHING_HELD);
  // Twice, and they are not the same thing. At RENDER, so an address never draws
  // a list read for another org — not even for the frame between a navigation
  // and the effect below, which is what a palette left open across a browser
  // Back would have shown. In an EFFECT, so the read itself is let go rather
  // than kept aside: returning to an org re-reads it, the way `Dashboard`,
  // `Pulse`, `ProjectsView` and `ReposPage` all re-read on an org change,
  // instead of offering a list from before the navigation. One value goes both
  // times, so there is nothing left behind to disagree with it.
  const held = atAddress(read, org);
  const projects = boardsOf(held);
  useEffect(() => {
    setRead((r) => atAddress(r, org));
  }, [org]);

  const renewal = useRenewalSignal();
  const accessEpoch = useAccessEpoch();
  const checked = useRef(renewal);
  useEffect(() => {
    if (!mustRead(held, org, open) && checked.current === renewal) return;
    if (!open && !held) return;
    checked.current = renewal;
    let alive = true;
    // THE LATCH IS WRITTEN BY THE ANSWER, never by the request (#714 review).
    // `setLoadedFor(org)` used to sit on the line above this read, and the
    // rejection went into `() => {}`: on `/gtm` — an org this board refuses —
    // the palette marked itself loaded on a promise that then failed, so it
    // never asked for gtm again for the life of the page. A read that came back
    // is the only thing that can say an org is loaded; a read that did not
    // leaves the palette holding nothing, and the next open asks again.
    fetchProjects(org ?? undefined).then(
      (r) => { if (alive) setRead(answered(org, r.projects)); },
      () => {},
    );
    fetchSearchIssues().then((r) => { if (alive) setIssues(r); }, () => {});
    return () => { alive = false; };
  }, [open, held, org, renewal, accessEpoch]);

  const index = useMemo(
    () => [...projectItems(projects), ...peopleItems(people), ...issueItems(issues)],
    [people, projects, issues],
  );

  const results = useMemo<SearchItem[]>(() => {
    if (query.trim()) return searchItems(index, query);
    // Empty query → recent picks, resolved against the current index.
    const byId = new Map(index.map((i) => [i.id, i]));
    return loadRecent()
      .map((id) => byId.get(id))
      .filter((x): x is SearchItem => Boolean(x));
  }, [index, query]);

  const groups = useMemo(() => groupByKind(results), [results]);

  // Reset transient state when fully closed.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  function choose(item: SearchItem) {
    pushRecent(item.id);
    onClose();
    if (item.route) onNavigate(item.route);
    else if (item.href) window.open(item.href, '_blank', 'noopener');
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="top-[12vh] flex max-h-[66vh] w-[620px] max-w-[92vw] max-sm:w-auto translate-y-0 flex-col gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Search the board</DialogTitle>
        <Command shouldFilter={false} className="flex-1 overflow-hidden">
          <div className="relative flex-none">
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search projects, people, issues…"
            />
          </div>

          <CommandList label="Search the board" className="max-h-none flex-1">
            {query.trim() && (
              <CommandEmpty>
                No matches for “{query.trim()}”.<br />Try a project, person, or issue.
              </CommandEmpty>
            )}
            {groups.map((g) => (
              <CommandGroup
                key={g.kind}
                heading={query.trim() ? `${KIND_LABEL[g.kind]} (${g.items.length})` : 'Recent'}
              >
                {g.items.map((it) => (
                  <CommandItem key={it.id} value={it.id} onSelect={() => choose(it)}>
                    <span className="grid h-[26px] w-[26px] flex-none place-items-center rounded-[7px] bg-surface-3 text-[11px] font-bold text-muted">
                      {it.chip}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col overflow-hidden">
                      <span className="block truncate text-[13.5px] text-fg">
                        <Highlighted text={it.title} query={query} />
                      </span>
                      <span className="mt-0.5 block truncate text-[11.5px] text-muted">{it.sub}</span>
                    </span>
                    <CommandShortcut>↵</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>

          <div className="flex flex-none items-center gap-4 border-t border-line px-3.5 py-2 text-[11px] text-muted">
            <span>
              <kbd className="rounded border border-line px-1 py-px font-mono">↑</kbd>
              <kbd className="ml-0.5 rounded border border-line px-1 py-px font-mono">↓</kbd>
              {' '}navigate
            </span>
            <span><kbd className="rounded border border-line px-1 py-px font-mono">↵</kbd> open</span>
            <span className="ml-auto">
              <kbd className="rounded border border-line px-1 py-px font-mono">esc</kbd> close
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
