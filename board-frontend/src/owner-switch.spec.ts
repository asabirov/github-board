import { describe, expect, it } from 'vitest';
import { ownerSwitch, type Route } from './route';

/**
 * Picking a different owner keeps the page you were on (#892 review, F10).
 *
 * The four owner-agnostic tabs mean the same thing about any owner, so they
 * survive. Everything that names one owner's entity does not.
 */
describe('switching Github owner', () => {
  it('keeps each owner-agnostic tab and swaps the owner', () => {
    for (const tab of ['dashboard', 'team', 'projects', 'repos'] as const) {
      expect(ownerSwitch({ tab, org: 'acme' }, 'alice')).toEqual({ tab, org: 'alice' });
    }
  });

  it('drops to all owners when the picker is cleared', () => {
    expect(ownerSwitch({ tab: 'team', org: 'acme' }, null)).toEqual({ tab: 'team' });
  });

  it('drops a board number, which belongs to one owner`s Projects', () => {
    expect(ownerSwitch({ tab: 'projects', org: 'acme', project: 12 }, 'alice')).toEqual({
      tab: 'projects',
      org: 'alice',
    });
  });

  it('drops a board`s viewer state with the board', () => {
    const route: Route = { tab: 'projects', org: 'acme', project: 12, viewer: { q: 'x' } };
    expect(ownerSwitch(route, 'alice')).toEqual({ tab: 'projects', org: 'alice' });
  });

  it('lands a repo page on the map it came from, without the repo', () => {
    const route: Route = { tab: 'repo', repo: { owner: 'acme', name: 'thing' } };
    expect(ownerSwitch(route, 'alice')).toEqual({ tab: 'repos', org: 'alice' });
  });

  it('lands an issue page on Your work, without the issue', () => {
    const route: Route = { tab: 'issue', issue: { owner: 'acme', repo: 'thing', number: 4 } };
    expect(ownerSwitch(route, 'alice')).toEqual({ tab: 'dashboard', org: 'alice' });
  });

  it('never carries a reference to the owner that was left behind', () => {
    const busy: Route = {
      tab: 'issue',
      org: 'acme',
      project: 3,
      issue: { owner: 'acme', repo: 'thing', number: 4 },
      repo: { owner: 'acme', name: 'thing' },
      viewer: { q: 'q' },
    };
    const next = ownerSwitch(busy, 'alice');
    expect(Object.keys(next).sort()).toEqual(['org', 'tab']);
  });
});
