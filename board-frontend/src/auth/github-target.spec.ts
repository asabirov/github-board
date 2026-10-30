import { afterEach, describe, expect, it } from 'vitest';
import { installTargets, resolveRouteTarget, targetQuery } from './github-target';
import { DEFAULT_VIEWER, decodeViewer, encodeViewer } from '../issues-viewer/viewer-url';
import { initialRoute, parseRoute, routePath } from '../route';
import { readOrgPref, writeOrgPref } from '../org-scope/org-pref';
import { vi } from 'vitest';
import { boardToken, parseBoardToken } from '../issues-viewer/filter-group';
import { issueItems } from '../search/search-index';
import { repoActionItems } from '../repos/repo-actions';
import { projectViewerKeys } from '../projects/viewer-key';
import { readViewerPrefs } from '../issues-viewer/viewer-prefs';
import { forgetOnRoute } from '../org-scope/org-pref';
import { bindRouteTarget } from './github-target';

const owners = [{ id: 7, login: 'new', type: 'Organization' as const }];
const repositories = [{ id: 42, full_name: 'new/renamed' }];
afterEach(() => installTargets(undefined));
describe('identity-bearing routes', () => {
  it('follows account rename by id', () => {
    installTargets({ owners, repositories });
    expect(resolveRouteTarget({ tab: 'team', org: 'old', ownerId: 7 })).toMatchObject({ org: 'new' });
  });
  it('follows repository rename or transfer', () => {
    installTargets({ owners, repositories });
    expect(resolveRouteTarget({ tab: 'repo', repo: { owner: 'old', name: 'widgets' }, repositoryId: 42 })).toMatchObject({ repo: { owner: 'new', name: 'renamed' } });
  });
  it('refuses a deleted id even if its name is reused', () => {
    installTargets({ owners, repositories: [{ id: 99, full_name: 'old/widgets' }] });
    expect(() => resolveRouteTarget({ tab: 'repo', repo: { owner: 'old', name: 'widgets' }, repositoryId: 42 })).toThrow(/no longer available/);
  });
  it('binds an unambiguous legacy owner name', () => {
    installTargets({ owners, repositories });
    expect(resolveRouteTarget({ tab: 'team', org: 'new' })).toMatchObject({ org: 'new', ownerId: 7 });
  });
  it('generates stable links from deliberate current selections', () => {
    installTargets({ owners, repositories });
    expect(targetQuery({ tab: 'repo', repo: { owner: 'new', name: 'renamed' } })).toBe('repositoryId=42');
  });
});

it('writes repository filters with stable ids, not names', () => {
  installTargets({ owners, repositories });
  expect(encodeViewer({ ...DEFAULT_VIEWER, filters: { ...DEFAULT_VIEWER.filters, repos: ['new/renamed'] } })).toContain('repoId=42');
});
it('retains the id of a deleted filter so it cannot widen the view', () => {
  expect(decodeViewer('?repoId=42').filters?.repos).toEqual(['id:42']);
});

it('remembers an account id across reload and rename without adopting the old name holder', () => {
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) });
  try {
    installTargets({ owners: [{ id: 7, login: 'old' }], repositories });
    writeOrgPref('old');
    installTargets({ owners: [...owners, { id: 99, login: 'old' }], repositories });
    const route = resolveRouteTarget(initialRoute('/', '', readOrgPref()));
    expect(route.org).toBe('new');
    expect(routePath(route)).toBe('/new?ownerId=7');
    expect(resolveRouteTarget(parseRoute('/old', '?ownerId=7')).org).toBe('new');
  } finally { vi.unstubAllGlobals(); }
});
it('never widens a deleted or ambiguous repository filter', () => {
  installTargets({ owners, repositories });
  expect(resolveRouteTarget(parseRoute('/', '?repo=renamed')).viewer?.filters?.repos).toEqual(['id:42']);
  expect(() => resolveRouteTarget(parseRoute('/', '?repoId=99'))).toThrow(/no longer available/);
});

it('keys owner-qualified saved board filters on account identity', () => {
  installTargets({ owners, repositories });
  const token = boardToken({ org: 'new', number: 3, name: 'Roadmap' });
  expect(token).toBe('id:7/3/Roadmap');
  expect(parseBoardToken('id:7/3/Roadmap')?.org).toBe('new');
});
it('keeps recent issue selections on the repository id across a rename', () => {
  installTargets({ owners, repositories });
  expect(issueItems([{ owner: 'new', repo: 'renamed', number: 1, title: 'Work' }])[0].id).toBe('issue:id:42#1');
});

describe('legacy target migration', () => {
  it('binds a name-only issue link and a remembered owner', () => {
    installTargets({ owners, repositories });
    expect(resolveRouteTarget(parseRoute('/issue/new/renamed/12', ''))).toMatchObject({ repositoryId: 42 });
    expect(resolveRouteTarget(initialRoute('/', '', 'new'))).toMatchObject({ org: 'new', ownerId: 7 });
  });
  it('refuses duplicate short names but opens the selected repo queue', () => {
    installTargets({ owners, repositories: [{ id: 42, full_name: 'new/docs' }, { id: 99, full_name: 'other/docs' }] });
    expect(() => resolveRouteTarget(parseRoute('/', '?repo=docs'))).toThrow();
    const goto = vi.fn();
    repoActionItems({ key: 'docs', full: 'new/docs', htmlUrl: 'https://github.com/new/docs' }, { goto, openExternal: vi.fn(), copy: vi.fn() }, { queue: true })[0].run();
    expect(goto).toHaveBeenCalledWith('/overview?repoId=42');
  });
  it('retains legacy project arrangement keys behind the numeric key', () => {
    installTargets({ owners, repositories });
    expect(projectViewerKeys(3, 'new')).toEqual(['project:account-id:7/3', 'project:new/3', 'project:3']);
  });
});

it('does not rebind a name known to have changed holders during discovery', () => {
  installTargets({ owners: [{ id: 7, login: 'old' }], repositories: [{ id: 42, full_name: 'old/widgets' }] });
  installTargets({ owners: [{ id: 99, login: 'old' }, { id: 7, login: 'new' }], repositories: [{ id: 99, full_name: 'old/widgets' }, { id: 42, full_name: 'new/widgets' }] });
  expect(() => resolveRouteTarget(parseRoute('/issue/old/widgets/1', ''))).toThrow();
  expect(() => resolveRouteTarget(parseRoute('/old', ''))).toThrow();
  expect(resolveRouteTarget(parseRoute('/issue/old/widgets/1', '?repositoryId=42'))).toMatchObject({ repositoryId: 42, issue: { owner: 'new' } });
});
it('writes a restored project arrangement forward to its stable key', () => {
  installTargets({ owners, repositories });
  const saved = new Map([['board_viewer:project:new/3', JSON.stringify({ group: 'status', view: 'board' })]]);
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
  try {
    expect(readViewerPrefs(projectViewerKeys(3, 'new'))).toEqual({ group: 'status', view: 'board' });
    expect(JSON.parse(saved.get('board_viewer:project:account-id:7/3')!)).toEqual({ group: 'status', view: 'board' });
  } finally { vi.unstubAllGlobals(); }
});

it('retains a remembered numeric owner while discovery is loading without inventing a login', () => {
  const route = initialRoute('/', '', 'id:7');
  expect(route.org).toBeUndefined();
  expect(routePath(route)).toBe('/?ownerId=7');
  expect(forgetOnRoute(route)).toBe(false);
});

it('keeps a known reused name unbound through navigation and link formatting', () => {
  installTargets({ owners: [{ id: 7, login: 'old' }], repositories: [{ id: 42, full_name: 'old/widgets' }] });
  installTargets({ owners: [{ id: 99, login: 'old' }], repositories: [{ id: 99, full_name: 'old/widgets' }] });
  for (const route of [parseRoute('/old', ''), parseRoute('/issue/old/widgets/1', ''), parseRoute('/', '?repo=widgets')]) {
    expect(() => routePath(route)).not.toThrow();
    expect(() => resolveRouteTarget(bindRouteTarget(route))).toThrow();
  }
});
