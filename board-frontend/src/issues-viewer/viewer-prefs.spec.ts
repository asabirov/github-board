import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPrefAction, readViewerPrefs, VIEWER_PREFS_PREFIX, writeViewerPrefs } from './viewer-prefs';
import type { GroupDim } from './filter-group';
import { DASHBOARD_VIEWER_KEY } from '../dashboard/viewer-key';

// The board's test env is `node` — there is no `localStorage`. Every test that
// wants storage installs this minimal stand-in; the "no storage at all" tests
// simply don't install it, which is also the real degraded case (a locked-down
// browser, or Safari private mode where the getter throws).
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  keys() { return [...this.map.keys()]; }
  raw(k: string) { return this.map.get(k); }
}

function install(store: unknown) {
  (globalThis as unknown as { localStorage: unknown }).localStorage = store;
}
function uninstall() {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
}

describe('viewer prefs storage (#463)', () => {
  let store: MemoryStorage;
  beforeEach(() => { store = new MemoryStorage(); install(store); });
  afterEach(uninstall);

  it('reads back nothing for a key never written', () => {
    expect(readViewerPrefs('project:7')).toBeNull();
  });

  it('round-trips the grouping and the view', () => {
    writeViewerPrefs('project:7', { group: 'status', view: 'list' });
    expect(readViewerPrefs('project:7')).toEqual({ group: 'status', view: 'list' });
  });

  it('keeps two keys apart — one project cannot overwrite another', () => {
    writeViewerPrefs('project:7', { group: 'status', view: 'list' });
    writeViewerPrefs('project:9', { group: 'assignee', view: 'board' });
    expect(readViewerPrefs('project:7')).toEqual({ group: 'status', view: 'list' });
    expect(readViewerPrefs('project:9')).toEqual({ group: 'assignee', view: 'board' });
  });

  it('namespaces its keys away from the theme key', () => {
    writeViewerPrefs('project:7', { group: 'status', view: 'list' });
    expect(store.keys()).toEqual([`${VIEWER_PREFS_PREFIX}project:7`]);
    expect(VIEWER_PREFS_PREFIX.startsWith('board_theme')).toBe(false);
  });

  it('stores the grouping and the view ONLY — never the search text', () => {
    writeViewerPrefs('project:7', { group: 'status', view: 'list' });
    const raw = JSON.parse(store.raw(`${VIEWER_PREFS_PREFIX}project:7`)!) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(['group', 'view']);
  });

  it('restores a stored repo grouping (#661)', () => {
    // Nothing in this file names the dimensions: the validator checks against
    // the imported GROUP_DIMS, so a seventh dimension is picked up without an
    // edit here. This test is what proves that, and 'moon' below is what proves
    // the check is not simply waved through.
    store.setItem(`${VIEWER_PREFS_PREFIX}unit`, JSON.stringify({ group: 'repo' }));
    expect(readViewerPrefs('unit')).toEqual({ group: 'repo' });
    writeViewerPrefs('unit:2', { group: 'repo', view: 'board' });
    expect(readViewerPrefs('unit:2')).toEqual({ group: 'repo', view: 'board' });
  });

  it('ignores a stored grouping that is not a known dimension', () => {
    store.setItem(`${VIEWER_PREFS_PREFIX}project:7`, JSON.stringify({ group: 'moon', view: 'board' }));
    expect(readViewerPrefs('project:7')).toEqual({ view: 'board' });
  });

  it('ignores a stored view that is neither list nor board', () => {
    store.setItem(`${VIEWER_PREFS_PREFIX}project:7`, JSON.stringify({ group: 'label', view: 'grid' }));
    expect(readViewerPrefs('project:7')).toEqual({ group: 'label' });
  });

  it('returns null for a stored value that is not viewer prefs at all', () => {
    store.setItem(`${VIEWER_PREFS_PREFIX}project:7`, JSON.stringify({ group: 'moon', view: 'grid' }));
    expect(readViewerPrefs('project:7')).toBeNull();
    store.setItem(`${VIEWER_PREFS_PREFIX}project:8`, 'not json at all');
    expect(readViewerPrefs('project:8')).toBeNull();
    store.setItem(`${VIEWER_PREFS_PREFIX}project:9`, JSON.stringify(['status']));
    expect(readViewerPrefs('project:9')).toBeNull();
  });

  it('reads back nothing once storage is cleared', () => {
    writeViewerPrefs('project:7', { group: 'status', view: 'list' });
    store.removeItem(`${VIEWER_PREFS_PREFIX}project:7`);
    expect(readViewerPrefs('project:7')).toBeNull();
  });

  it('carries arrangements over from the old `lessly_viewer:` prefix once (#1450)', () => {
    store.setItem('lessly_viewer:project:7', JSON.stringify({ group: 'status', view: 'list' }));
    expect(readViewerPrefs('project:7')).toEqual({ group: 'status', view: 'list' });
    expect(store.raw(`${VIEWER_PREFS_PREFIX}project:7`)).toBe(JSON.stringify({ group: 'status', view: 'list' }));
    expect(store.raw('lessly_viewer:project:7')).toBeUndefined();
  });
});

describe('viewer prefs without usable storage (#463)', () => {
  afterEach(uninstall);

  it('reads null and writes without throwing when there is no localStorage', () => {
    uninstall();
    expect(() => writeViewerPrefs('project:7', { group: 'status', view: 'list' })).not.toThrow();
    expect(readViewerPrefs('project:7')).toBeNull();
  });

  it('survives a storage that throws on every access (private-mode Safari)', () => {
    install({
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    });
    expect(() => writeViewerPrefs('project:7', { group: 'status', view: 'list' })).not.toThrow();
    expect(readViewerPrefs('project:7')).toBeNull();
  });
});

// The write moment: only a deliberate grouping/view choice is remembered. Landing
// on a page, typing in the search field, or toggling a filter must not write —
// otherwise arriving through a shared `?group=` link would silently overwrite the
// arrangement this project already had.
describe('which actions persist (#463)', () => {
  it('persists a grouping or a view choice', () => {
    expect(isPrefAction({ type: 'setGroup', group: 'label' })).toBe(true);
    expect(isPrefAction({ type: 'setView', view: 'board' })).toBe(true);
  });

  it('does not persist a search, a filter, a lifecycle switch or a re-hydration', () => {
    expect(isPrefAction({ type: 'setQuery', q: 'auth' })).toBe(false);
    expect(isPrefAction({ type: 'toggleFilter', dim: 'labels', value: 'bug' })).toBe(false);
    expect(isPrefAction({ type: 'setState', state: 'all' })).toBe(false);
    expect(isPrefAction({ type: 'setTimeframe', tf: 'opened-week' })).toBe(false);
    expect(isPrefAction({ type: 'toggleCustomField', slug: 'priority', value: 'High' })).toBe(false);
  });
});

// #697 — a board's key gained its org, and a key that changes is an arrangement
// a person silently loses. A host may therefore hand over the key it wants
// PLUS the keys this page used to be stored under, newest first.
describe('a host key that has been renamed (#697)', () => {
  let store: MemoryStorage;
  beforeEach(() => { store = new MemoryStorage(); install(store); });
  afterEach(uninstall);

  it('finds an arrangement stored under the key the page used to have', () => {
    writeViewerPrefs('project:7', { group: 'assignee', view: 'list' });
    expect(readViewerPrefs(['project:acme/7', 'project:7'])).toEqual({ group: 'assignee', view: 'list' });
  });

  it('prefers the current key once anything is stored under it', () => {
    writeViewerPrefs('project:7', { group: 'assignee', view: 'list' });
    writeViewerPrefs(['project:acme/7', 'project:7'], { group: 'status', view: 'board' });
    expect(readViewerPrefs(['project:acme/7', 'project:7'])).toEqual({ group: 'status', view: 'board' });
  });

  it('writes forward, never back onto the key it fell back to', () => {
    writeViewerPrefs('project:7', { group: 'assignee', view: 'list' });
    writeViewerPrefs(['project:acme/7', 'project:7'], { group: 'status', view: 'board' });
    expect(store.raw(VIEWER_PREFS_PREFIX + 'project:acme/7')).toBe('{"group":"status","view":"board"}');
    // The old entry is left alone rather than migrated or deleted — see the
    // declaration for why a destructive write is the wrong move here.
    expect(store.raw(VIEWER_PREFS_PREFIX + 'project:7')).toBe('{"group":"assignee","view":"list"}');
  });

  it('does not let one org’s board fall back onto another org’s arrangement', () => {
    // The fallback is a RENAME, not a lookup: only the unqualified key is behind
    // these, and neither board may reach the other's entry.
    writeViewerPrefs(['project:acme/3', 'project:3'], { group: 'status', view: 'board' });
    expect(readViewerPrefs(['project:globex/3'])).toBeNull();
  });

  it('still takes a plain string, which is what every other host passes', () => {
    writeViewerPrefs('team:queue', { group: 'type', view: 'list' });
    expect(readViewerPrefs('team:queue')).toEqual({ group: 'type', view: 'list' });
  });
});

// Which hosts opted in, checked rather than described (#727). The opt-in rule
// above is the whole design of this module, and until now the only record of who
// took it up was prose. The suite has no DOM, so the props a page hands the
// viewer are pinned as source text — the idiom `repos/ReposMap.spec.tsx` uses for
// its own wiring claims.
describe('the hosts that remember, and the ones that must not (#463, #727)', () => {
  const sources = import.meta.glob('../**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
  const of = (suffix: string) => {
    const hit = Object.entries(sources).find(([k]) => k.endsWith(suffix));
    expect(hit, `${suffix} is not among the ${Object.keys(sources).length} sources read`).toBeDefined();
    return hit![1];
  };

  it('is exactly three pages — a fourth that starts remembering is a decision, not a default', () => {
    const opted = Object.keys(sources)
      .filter((k) => !k.includes('.spec.') && /<(?:IssuesViewer|IssueQueue)/.test(sources[k]) && /persistKey=/.test(sources[k]))
      // Anchored: these keys carry ONE leading `../`, and a bare string argument
      // would strip the first one wherever it fell rather than the leading one.
      .map((k) => k.replace(/^\.\.\//, ''))
      .sort();
    expect(opted).toEqual(['dashboard/Dashboard.tsx', 'projects/ProjectsView.tsx', 'team/TeamView.tsx']);
  });

  it('keys Your work and the Unit queue FLAT, with no org in the key', () => {
    // `/api/issues/mine` and `/api/issues/all` take no org, so the issue set
    // behind these two is the same whatever `?org=` the address carries — an org
    // in the key would split one arrangement into several the person cannot tell
    // apart. The Project page is the opposite case and keys on org + number
    // (#697), which is why the brace spelling is what this rules out here.
    //
    // TEAMVIEW IS PINNED AS SOURCE TEXT; YOUR WORK IS PINNED BY VALUE (#750
    // review). They differ because the pages do: TeamView writes its key inline,
    // so a braced `persistKey={...}` there is the tell that somebody started
    // computing one, and the ban below is the whole guard. Dashboard cannot be
    // read that way any more — two things read its key now, the queue and a
    // Contributions ring press, so it moved into `dashboard/viewer-key.ts` the
    // way the Project page has always held its own, and a brace at the call site
    // is now correct rather than suspicious.
    //
    // WHAT REPLACED THE BAN IS STRONGER, not weaker. The ban proved only that the
    // JSX did not compute a key; it said nothing about what the key was. The
    // value assertion says the key IS the flat string, so `dashboard:${org}` —
    // the failure this test exists to prevent — fails it wherever it is written,
    // in the constant, in the JSX, or anywhere in between.
    expect(DASHBOARD_VIEWER_KEY).toBe('dashboard');
    expect(of('team/TeamView.tsx')).toContain('persistKey="team"');
    expect(of('team/TeamView.tsx')).not.toMatch(/persistKey=\{/);
  });

  it('leads both through the shared queue with project, then type', () => {
    expect(of('ui/IssueQueue.tsx')).toMatch(/defaultGroup=\{\['project', 'type'\]\}/);
    for (const host of ['dashboard/Dashboard.tsx', 'team/TeamView.tsx']) {
      expect(of(host)).toContain('<IssueQueue');
      expect(of(host)).not.toContain('<IssuesViewer');
    }
  });

  it('uses My work’s existing key for its viewer and contribution rings', () => {
    const dashboard = of('dashboard/Dashboard.tsx');
    expect(dashboard).toContain('const viewerKey = DASHBOARD_VIEWER_KEY;');
    expect(dashboard).toContain('persistKey={viewerKey}');
    expect(dashboard).toContain('readViewerPrefs(viewerKey)');
  });
});

describe('a remembered triage grouping (#1099)', () => {
  beforeEach(() => { install(new MemoryStorage()); });
  afterEach(uninstall);

  it('is stored and read back', () => {
    writeViewerPrefs('dashboard', { group: 'triage:priority', view: 'list' });
    expect(readViewerPrefs('dashboard')).toEqual({ group: 'triage:priority', view: 'list' });
  });

  it('is validated on the way in and out like every other dimension', () => {
    // A property this page's issues no longer carry is still a valid stored
    // arrangement — `resolveGroupDim` is what lands the page somewhere real.
    writeViewerPrefs('dashboard', { group: 'triage:effort' });
    expect(readViewerPrefs('dashboard')?.group).toBe('triage:effort');
    localStorage.setItem(VIEWER_PREFS_PREFIX + 'dashboard', JSON.stringify({ group: 'triage:' }));
    expect(readViewerPrefs('dashboard')).toBeNull();
  });
});

describe('what a remembered arrangement may hold (#1108)', () => {
  beforeEach(() => { install(new MemoryStorage()); });
  afterEach(uninstall);

  const stored = (key: string) => localStorage.getItem(VIEWER_PREFS_PREFIX + key);

  it('refuses a grouping no `triage:` label could ever name', () => {
    // Reproduced as a crafted `?group=` plus one View-toggle click, which writes
    // whatever the URL put in state. The arrangement that was there survives,
    // because the refused half is simply not written.
    writeViewerPrefs('dashboard', { group: 'triage:size', view: 'board' });
    writeViewerPrefs('dashboard', { group: `triage:${'x'.repeat(50_000)}` as GroupDim, view: 'board' });
    expect(stored('dashboard')).toBe(JSON.stringify({ view: 'board' }));
    expect(readViewerPrefs('dashboard')).toEqual({ view: 'board' });
  });

  it('keeps a grouping right up to the ceiling', () => {
    const longest = `triage:${'x'.repeat(41)}` as GroupDim;
    writeViewerPrefs('dashboard', { group: longest });
    expect(readViewerPrefs('dashboard')?.group).toBe(longest);
  });

  it('stores the one spelling, whatever spelling arrived', () => {
    writeViewerPrefs('dashboard', { group: 'triage:Deadline_Class' as GroupDim });
    expect(readViewerPrefs('dashboard')?.group).toBe('triage:deadline-class');
  });

  it('reads an entry written under another spelling back as the dimension on offer', () => {
    localStorage.setItem(VIEWER_PREFS_PREFIX + 'dashboard', JSON.stringify({ group: 'triage:Deadline-Class' }));
    expect(readViewerPrefs('dashboard')?.group).toBe('triage:deadline-class');
  });
});
