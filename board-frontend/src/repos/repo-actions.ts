import { repositoryId } from '../auth/github-target';
/**
 * What a repo row does (#472), kept pure so both halves are unit-tested exactly
 * as they render: where a plain click goes, and what the right-click menu offers.
 *
 * The menu itself is the shared `ActionMenu` shell, and the action list is built
 * the same way as the issue one (`ui/issue-actions.ts`) — effects injected
 * rather than imported, so this module stays DOM-free and each handler is
 * assertable.
 *
 * Both lists order by the same rule: navigate first (in-board before the way
 * out), then copy, then danger. Here that is "Open issue queue", "Open on GitHub",
 * "Copy link", "Copy reference"; on an issue it is "Open on GitHub",
 * "Copy link", "Copy reference", "Close issue…". Same verbs, different nouns.
 */
import { DEFAULT_FILTERS } from '../issues-viewer/filter-group';
import { routePath } from '../route';
import type { MenuAction } from '../ui/ActionMenu';

/** The least a row needs to act on. `RepoRow` satisfies it structurally. */
export interface ActionableRepo {
  /** Short display key. */
  key: string;
  /** Full name used to distinguish repositories and copy references. */
  full: string;
  htmlUrl: string;
}

/** Open the org-wide issue queue narrowed to this repository's identity. */
export function repoQueuePath(key: string): string {
  const id = repositoryId(key);
  return routePath({ tab: 'team', viewer: { filters: { ...DEFAULT_FILTERS, repos: [id ? `id:${id}` : key] } } });
}

/** The side effects the menu fires, injected so each can be asserted. */
export interface RepoActionEffects {
  openExternal: (url: string) => void;
  /** In-board navigation — `gotoPath` at the call site. Separate from
   *  `openExternal` because the queue is a page on this board and Github is not,
   *  and a menu that opened both the same way would be lying about one of them. */
  goto: (path: string) => void;
  /** Put text on the clipboard and say so — `copyToClipboard` at the call site,
   *  which is the board's one flash confirmation and not a second flavour. */
  copy: (text: string, confirm: string) => void;
}

/** Where the menu is being drawn, which is the only thing the two call sites
 *  disagree about (#827).
 *
 *  Required rather than defaulted, so a third surface that opens this menu has
 *  to answer the question rather than inherit whichever answer was written
 *  first. */
export interface RepoActionPlace {
  /** Whether to offer the repo's issue queue.
   *
   *  True on the MAP TILE, where #575 deliberately put it: the tile itself opens
   *  the repo's page now, so the queue moved one step into this menu rather than
   *  away, and it is still the only way to that filtered list from the map.
   *
   *  False on the REPO PAGE (#827). The page already has the queue: the Issues
   *  tab IS this repo's open list, and its own footer links the same filtered
   *  board list through `repoQueuePath`. A menu entry beside a tab that shows
   *  the thing is a second door onto one room, and the menu is where a reader
   *  looks for the ways OUT of a page. */
  queue: boolean;
}

/**
 * The row's menu.
 *
 * The queue leads where it is offered at all (#575, #827). Github ends the
 * navigating: it is the way OUT of the board, and everything above it is a page
 * on it.
 *
 * Then the two copies (#606). The map is the one place you can see all 78 repos
 * at once, and until now a repo's name could not be taken out of it — the issue
 * menu beside it has copied both forms since #446.
 */
export function repoActionItems(
  repo: ActionableRepo,
  fx: RepoActionEffects,
  place: RepoActionPlace,
): MenuAction[] {
  return [
    ...(place.queue
      ? [{ key: 'open-queue', label: 'Open issue queue', run: () => fx.goto(repoQueuePath(repo.full)) }]
      : []),
    { key: 'open-github', label: 'Open on GitHub', run: () => fx.openExternal(repo.htmlUrl) },
    { key: 'copy-link', label: 'Copy link', run: () => fx.copy(repo.htmlUrl, 'Copied repo link') },
    { key: 'copy-reference', label: 'Copy reference', run: () => fx.copy(repo.full, `Copied ${repo.full}`) },
  ];
}
