import { describe, expect, it, vi } from 'vitest';
import { repoActionItems, repoQueuePath, type ActionableRepo, type RepoActionPlace } from './repo-actions';

const REPO: ActionableRepo = {
  key: 'board',
  full: 'acme/board',
  htmlUrl: 'https://github.com/acme/board',
};

/** The menu with every effect spied, so a handler can be fired and the call it
 *  made asserted — the same shape `ui/issue-actions.spec.ts` uses. */
function menu(repo: ActionableRepo = REPO, place: RepoActionPlace = TILE) {
  const fx = { openExternal: vi.fn(), goto: vi.fn(), copy: vi.fn() };
  return { fx, items: repoActionItems(repo, fx, place) };
}

/** The two places this menu is drawn (#827). The tile keeps the queue; the repo
 *  page does not. */
const TILE: RepoActionPlace = { queue: true };
const PAGE: RepoActionPlace = { queue: false };

const run = (repo: ActionableRepo, label: string) => {
  const { fx, items } = menu(repo);
  items.find((i) => i.label === label)!.run();
  return fx;
};

describe('what a repo row does (#472)', () => {
  it('links to the board’s own issue list, filtered to that repo', () => {
    expect(repoQueuePath('board')).toBe('/overview?repo=board');
  });

  it('offers Open on GitHub on the menu, firing the repo’s canonical URL', () => {
    expect(run(REPO, 'Open on GitHub').openExternal).toHaveBeenCalledWith(
      'https://github.com/acme/board',
    );
  });
});

describe('a repo leaves the board as text (#606)', () => {
  // The map is the one place all 78 repos are visible at once, and until #606 a
  // repo's name could not be taken out of it. The issue menu beside it has
  // copied both forms since #446, on the same shell.

  it('copies the repo’s URL, and says that is what it copied', () => {
    const fx = run(REPO, 'Copy link');
    expect(fx.copy).toHaveBeenCalledWith('https://github.com/acme/board', 'Copied repo link');
  });

  it('copies the org-qualified reference, naming it in the confirmation', () => {
    const fx = run(REPO, 'Copy reference');
    expect(fx.copy).toHaveBeenCalledWith('acme/board', 'Copied acme/board');
  });

  it('copies `owner/name`, never the board’s own short key', () => {
    // `key` is this board's shorthand and means nothing to `gh`, a PR body or a
    // chat message. The two differ on every repo in the org, and on `board` they
    // differ in both halves — which is what makes this assertion discriminate.
    const fx = run(REPO, 'Copy reference');
    const [copied] = fx.copy.mock.calls[0];
    expect(copied).toBe('acme/board');
    expect(copied).not.toBe(REPO.key);
    expect(copied).toContain('/');
  });

  it('copies rather than navigating — neither copy leaves the page', () => {
    for (const label of ['Copy link', 'Copy reference']) {
      const fx = run(REPO, label);
      expect(fx.openExternal, label).not.toHaveBeenCalled();
      expect(fx.goto, label).not.toHaveBeenCalled();
    }
  });

  it('reads the SAME order rule as the issue menu: navigate, then copy', () => {
    // Not the same list — different nouns — but the same rule, which is what
    // makes the two read as one menu. In-board first, the way out last, the
    // copies after both. The issue menu is "Open on GitHub", "Copy link",
    // "Copy reference", "Close issue…", which is this list without a page to
    // go to and with a danger item on the end.
    expect(menu().items.map((i) => i.label)).toEqual([
      'Open issue queue',
      'Open on GitHub',
      'Copy link',
      'Copy reference',
    ]);
  });

  it('offers no danger action — a repo has nothing here to destroy', () => {
    expect(menu().items.some((i) => i.danger)).toBe(false);
  });
});

describe('the queue moves one step away (#575)', () => {
  // The tile's primary click now opens the repo's PAGE. The filtered queue was
  // what it used to open, so it has to stay reachable — and the menu the tile
  // already carries is the one step away #575 asks for.
  it('offers the repo’s issue queue on the menu, above the way out to Github', () => {
    const labels = menu().items.map((i) => i.label);
    expect(labels.indexOf('Open issue queue')).toBeLessThan(labels.indexOf('Open on GitHub'));
    expect(labels[0]).toBe('Open issue queue');
  });

  it('navigates in-board to the filtered queue, rather than opening a window', () => {
    const fx = run(REPO, 'Open issue queue');
    expect(fx.goto).toHaveBeenCalledWith('/overview?repo=acme%2Fboard');
    expect(fx.openExternal).not.toHaveBeenCalled();
  });
});

describe('the queue comes off the Repo page’s menu (#827)', () => {
  // Octocat asked for it to go from the repo page and only from there. The page
  // already IS the queue: the Issues tab draws this repo's open list, and the
  // footer under it links the same filtered board list. What is left on the menu
  // is what it is for — the ways out.
  it('offers no queue entry on the repo page', () => {
    const { items } = menu(REPO, PAGE);
    expect(items.map((i) => i.key)).toEqual(['open-github', 'copy-link', 'copy-reference']);
    expect(items.map((i) => i.label)).not.toContain('Open issue queue');
  });

  it('leaves the map tile’s menu exactly as #575 left it', () => {
    // The tile's own click opens the repo page, so this menu is the map's only
    // way to the filtered list. Removing it in both places would reverse #575.
    expect(menu(REPO, TILE).items.map((i) => i.key)).toEqual([
      'open-queue',
      'open-github',
      'copy-link',
      'copy-reference',
    ]);
  });
});
