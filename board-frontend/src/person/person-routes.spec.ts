import { describe, expect, it } from 'vitest';
import { parseRoute, routePath, routePathname, ownerSwitch, routeOrg, navTabFor, isReservedSegment } from '../route';
import { initViewer } from '../issues-viewer/use-viewer-state';

describe('person and retired Queue routes', () => {
  it('round trips exact login and org, reserving the route from org interpretation', () => {
    for (const path of ['/people/IvanRoslov', '/acme/people/IvanRoslov']) expect(routePath(parseRoute(path))).toBe(path);
    expect(routeOrg(parseRoute('/acme/people/IvanRoslov'))).toBe('acme');
    expect(isReservedSegment('People')).toBe(true);
    expect(navTabFor('people')).toBe('team');
  });
  it('rejects malformed login routes and retains a person while switching scope', () => {
    for (const path of ['/people', '/people/%ZZ', '/people/name/extra', '/people/-bad']) expect(parseRoute(path).tab).toBe('dashboard');
    expect(ownerSwitch(parseRoute('/acme/people/IvanRoslov'), 'another-org')).toEqual({ tab: 'people', person: 'IvanRoslov', org: 'another-org' });
  });
  it('preserves every encoded viewer dimension from an old Queue link', () => {
    const search = '?q=fix&label=bug&assignee=IvanRoslov&unassigned=1&project=Board&board=acme/7/Board&repo=repo&type=bug&state=all&group=project&view=list&tf=closed-week&cf_priority=High';
    const before = initViewer(search, 'board', null, 'project');
    const path = routePathname(parseRoute('/acme/queue', search)) + search;
    expect(path).toBe('/acme' + search);
    const after = initViewer(path.slice(path.indexOf('?')), 'board', null, 'project');
    expect(before.filters).toMatchObject({ q: 'fix', labels: ['bug'], assignees: ['IvanRoslov'], unassigned: true, projects: ['Board'], repos: ['repo'], types: ['bug'], state: 'all', timeframe: 'closed-week', customFields: { priority: ['High'] } });
    expect(after).toEqual(before);
  });
});
