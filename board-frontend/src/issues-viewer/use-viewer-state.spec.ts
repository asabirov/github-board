import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gotoPath } from '../route';
import { initViewer, syncViewer, viewerReducer } from './use-viewer-state';
import { DEFAULT_VIEWER } from './viewer-url';

describe('viewerReducer (#376)', () => {
  it('setGroup swaps the grouping dimension', () => {
    const next = viewerReducer(DEFAULT_VIEWER, { type: 'setGroup', group: 'assignee' });
    expect(next.group).toBe('assignee');
  });

  it('setView swaps list/board', () => {
    expect(viewerReducer(DEFAULT_VIEWER, { type: 'setView', view: 'board' }).view).toBe('board');
  });

  it('setQuery updates both the top-level q and filters.q (kept in sync)', () => {
    const next = viewerReducer(DEFAULT_VIEWER, { type: 'setQuery', q: 'auth' });
    expect(next.q).toBe('auth');
    expect(next.filters.q).toBe('auth');
  });

  it('toggleFilter adds a value, then removes it on a second toggle', () => {
    const on = viewerReducer(DEFAULT_VIEWER, { type: 'toggleFilter', dim: 'labels', value: 'bug' });
    expect(on.filters.labels).toEqual(['bug']);
    const off = viewerReducer(on, { type: 'toggleFilter', dim: 'labels', value: 'bug' });
    expect(off.filters.labels).toEqual([]);
  });

  it('setState switches Open/All', () => {
    expect(viewerReducer(DEFAULT_VIEWER, { type: 'setState', state: 'all' }).filters.state).toBe('all');
  });

  it('toggleCustomField adds then removes a value under its slug', () => {
    let s = initViewer('');
    s = viewerReducer(s, { type: 'toggleCustomField', slug: 'priority', value: 'High' });
    expect(s.filters.customFields).toEqual({ priority: ['High'] });
    s = viewerReducer(s, { type: 'toggleCustomField', slug: 'priority', value: 'High' });
    expect(s.filters.customFields.priority ?? []).toEqual([]);
  });

  it('setTimeframe sets the preset', () => {
    const s = viewerReducer(initViewer(''), { type: 'setTimeframe', tf: 'opened-week' });
    expect(s.filters.timeframe).toBe('opened-week');
  });

  it('toggleFilter handles the types dim', () => {
    const s = viewerReducer(initViewer(''), { type: 'toggleFilter', dim: 'types', value: 'bug' });
    expect(s.filters.types).toEqual(['bug']);
  });

  it('toggleUnassigned turns the no-assignee filter on, then off again (#462)', () => {
    const on = viewerReducer(initViewer(''), { type: 'toggleUnassigned' });
    expect(on.filters.unassigned).toBe(true);
    expect(viewerReducer(on, { type: 'toggleUnassigned' }).filters.unassigned).toBe(false);
  });

  it('never mutates the input state', () => {
    const before = JSON.parse(JSON.stringify(DEFAULT_VIEWER));
    viewerReducer(DEFAULT_VIEWER, { type: 'toggleFilter', dim: 'labels', value: 'bug' });
    expect(DEFAULT_VIEWER).toEqual(before);
  });
});

describe('initViewer (#376)', () => {
  it('reads viewer state from a query, falling back to defaults for missing pieces', () => {
    expect(initViewer('')).toEqual(DEFAULT_VIEWER);
    const s = initViewer('?group=label&label=bug&view=board');
    expect(s.group).toBe('label');
    expect(s.view).toBe('board');
    expect(s.filters.labels).toEqual(['bug']);
    expect(s.filters.state).toBe('open');
  });
});

// A host page's own list/board default (#429, the Project page leading with
// board mode) — must win when the URL is silent on `view`, but never override an
// explicit `?view=`.
describe('initViewer: defaultView override (#429)', () => {
  it('applies defaultView when the URL has no view at all', () => {
    expect(initViewer('', 'board').view).toBe('board');
  });

  it('applies defaultView even when OTHER known params are present (regression: '
    + "decodeViewer's own 'list' fallback must not clobber it)", () => {
    expect(initViewer('?label=bug', 'board').view).toBe('board');
  });

  it('an explicit ?view=list still wins over a board defaultView', () => {
    expect(initViewer('?view=list', 'board').view).toBe('list');
  });

  it('an explicit ?view=board still wins over a list defaultView', () => {
    expect(initViewer('?view=board', 'list').view).toBe('board');
  });

  it('no defaultView passed falls back to the app-wide list default, unchanged', () => {
    expect(initViewer('?label=bug').view).toBe('list');
  });
});

// Remembered per-page arrangement (#463): a host that passes a storage key gets
// its grouping and view back on the next BARE visit, while any URL that names
// viewer state still wins whole — a shared link opens what the sender saw.
describe('initViewer: stored prefs (#463)', () => {
  it('restores a stored grouping and view when the URL carries no viewer state', () => {
    const s = initViewer('', 'board', { group: 'assignee', view: 'list' });
    expect(s.group).toBe('assignee');
    expect(s.view).toBe('list');
  });

  it('restores a stored half, leaving the other on the page default', () => {
    expect(initViewer('', 'board', { group: 'assignee' }).view).toBe('board');
    expect(initViewer('', 'board', { view: 'list' }).group).toBe(DEFAULT_VIEWER.group);
  });

  it('falls back to the page defaults when nothing is stored (never visited, or storage cleared)', () => {
    const s = initViewer('', 'board', null);
    expect(s.group).toBe(DEFAULT_VIEWER.group);
    expect(s.view).toBe('board');
  });

  it('lets an explicit URL win over the stored grouping and view', () => {
    const s = initViewer('?group=label&view=list', 'board', { group: 'assignee', view: 'board' });
    expect(s.group).toBe('label');
    expect(s.view).toBe('list');
  });

  it('drops the stored prefs WHOLE for any viewer URL, so a shared link reads as the sender left it', () => {
    // The sender's own grouping was the default and so is absent from the URL —
    // applying storage here would show the receiver a different board than the
    // link promised.
    const s = initViewer('?label=bug', 'board', { group: 'assignee', view: 'list' });
    expect(s.group).toBe(DEFAULT_VIEWER.group);
    expect(s.view).toBe('board');
    expect(s.filters.labels).toEqual(['bug']);
  });

  it('still restores when the query holds only params the viewer does not own', () => {
    expect(initViewer('?srcProject=7', 'board', { group: 'assignee' }).group).toBe('assignee');
  });
});

// A host page's own grouping (#727, Your work and the Unit queue leading with
// `project`). Same shape as `defaultView` above, and needed for the same reason:
// `decodeViewer` fills `group` with the app-wide 'status' the moment any known
// param is present, so without `hasExplicitGroup` a `/?label=bug` link would
// silently outrank the page's own lead.
describe('initViewer: defaultGroup override (#727)', () => {
  it('applies defaultGroup when the URL names no group at all', () => {
    expect(initViewer('', undefined, null, 'project').group).toBe('project');
  });

  it("applies defaultGroup even when OTHER known params are present (regression: "
    + "decodeViewer's own 'status' fallback must not clobber it)", () => {
    expect(initViewer('?label=bug', undefined, null, 'project').group).toBe('project');
  });

  it('an explicit ?group= still wins over the page default', () => {
    expect(initViewer('?group=label', undefined, null, 'project').group).toBe('label');
  });

  it('a remembered grouping outranks the page default — it is the choice a person made here', () => {
    expect(initViewer('', undefined, { group: 'assignee' }, 'project').group).toBe('assignee');
  });

  it('a viewer URL silences storage but NOT the page default, so a shared '
    + '`?label=bug` link opens the way this page opens', () => {
    expect(initViewer('?label=bug', undefined, { group: 'assignee' }, 'project').group).toBe('project');
  });

  it('no defaultGroup passed leaves the app-wide default exactly as it was', () => {
    expect(initViewer('?label=bug').group).toBe(DEFAULT_VIEWER.group);
    expect(initViewer('').group).toBe(DEFAULT_VIEWER.group);
  });
});

// Drill-in re-hydration (#401): a summary tile navigates via `gotoPath` to the
// current path + a viewer query; `useViewerState`'s popstate listener then
// re-hydrates via `initViewer(window.location.search)` (see the hook above).
// This repo's vitest environment is 'node' (no jsdom/testing-library), so
// `route.spec.ts` already established the pattern of stubbing a minimal
// `window` rather than rendering — we follow the same idiom here instead of
// pulling in `renderHook`: drive `gotoPath` against a stubbed `window` whose
// `pushState` actually updates `location` (real `history.pushState` does the
// same), then assert (a) a popstate was dispatched — the signal the hook's
// `useEffect` listens for — and (b) `initViewer` on the resulting URL yields
// the drilled-in filters, which is exactly what the listener's callback does.
describe('drill-in re-hydration (#401)', () => {
  const dispatch = vi.fn();
  const pushState = vi.fn((_state: unknown, _title: string, path: string) => {
    const [pathname, search = ''] = path.split('?');
    stub.location.pathname = pathname;
    stub.location.search = search ? `?${search}` : '';
  });
  const stub = {
    location: { pathname: '/', search: '' },
    history: { pushState, replaceState: vi.fn() },
    dispatchEvent: dispatch,
  };

  beforeEach(() => {
    dispatch.mockClear();
    pushState.mockClear();
    stub.location = { pathname: '/', search: '' };
    (globalThis as unknown as { window: typeof stub }).window = stub;
    // The node test env has no DOM PopStateEvent; gotoPath dispatches one.
    (globalThis as unknown as { PopStateEvent: unknown }).PopStateEvent = class {
      type: string;
      constructor(type: string) { this.type = type; }
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    delete (globalThis as unknown as { PopStateEvent?: unknown }).PopStateEvent;
  });

  it('re-hydrates viewer filters from an external URL change (a tile drill-in)', () => {
    gotoPath(stub.location.pathname + '?assignee=me');

    // The synthetic popstate the listener re-hydrates on.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0][0] as { type: string }).type).toBe('popstate');

    // What the listener's callback does with the resulting URL.
    const rehydrated = initViewer(stub.location.search);
    expect(rehydrated.filters.assignees).toEqual(['me']);
  });
});

// The viewer used to hold its URL-borne state in `useState`, seeded once and
// refreshed on popstate alone. That is one navigation short: `App.navigate`
// pushes history and re-renders WITHOUT dispatching a popstate, so the viewer
// kept whatever it had while the URL said something else. `syncViewer` is the
// reconciliation that closes it, held apart from React so the decision is a
// tested fact rather than a claim about a hook.
describe('syncViewer — the viewer against a URL it did not write (#461)', () => {
  const owned = (search: string) => ({ search, state: initViewer(search) });
  const noPrefs = () => null;

  it('re-derives when the URL cleared underneath it — the Unit page’s sidebar item '
    + 'goes through `App.navigate`, which fires no popstate, so the tiles above read '
    + 'the whole unit while the queue below still filtered to one member, with a live '
    + 'assignee token, under a bare URL', () => {
    const own = owned('?assignee=octocat');
    expect(own.state.filters.assignees).toEqual(['octocat']);

    const next = syncViewer(own, '', undefined, noPrefs);
    expect(next.search).toBe('');
    expect(next.state.filters.assignees).toEqual([]);
  });

  it('re-derives every dimension, not only assignees', () => {
    const own = owned('?label=bug&group=label&state=all&tf=aging&q=cache');
    const next = syncViewer(own, '?assignee=IvanRoslov', undefined, noPrefs);
    expect(next.state.filters).toMatchObject({
      labels: [], assignees: ['IvanRoslov'], state: 'open', timeframe: 'any', q: '',
    });
    expect(next.state.group).toBe(DEFAULT_VIEWER.group);
  });

  it('holds exactly what it last wrote, by identity — the URL a commit just wrote '
    + 'comes back as a popstate, and re-deriving there would throw away a choice the '
    + 'codec omits because it equals this host’s default', () => {
    const own = owned('?assignee=octocat');
    expect(syncViewer(own, '?assignee=octocat', undefined, noPrefs)).toBe(own);
  });

  it('reads a remembered arrangement only when it re-derives — the Project page keeps '
    + 'one in storage, and a read per render would be one per keystroke in the search '
    + 'box', () => {
    const reads = vi.fn(() => ({ group: 'label', view: 'list' }) as const);
    syncViewer(owned('?q=a'), '?q=a', 'board', reads);
    expect(reads).not.toHaveBeenCalled();
    syncViewer(owned('?q=a'), '', 'board', reads);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('applies that arrangement when it re-derives onto a bare URL, exactly as a fresh '
    + 'mount would', () => {
    const stored = () => ({ group: 'label', view: 'list' }) as const;
    const next = syncViewer(owned('?q=a'), '', 'board', stored);
    expect(next.state.group).toBe('label');
    expect(next.state.view).toBe('list');
    expect(next.state).toEqual(initViewer('', 'board', stored()));
  });

  it('carries the host\u2019s own grouping through the re-derivation too (#727) \u2014 the '
    + 'queue that leads with `project` still leads with it after a navigation that '
    + 'cleared the URL', () => {
    const next = syncViewer(owned('?q=a'), '', 'board', noPrefs, 'project');
    expect(next.state.group).toBe('project');
  });
});
