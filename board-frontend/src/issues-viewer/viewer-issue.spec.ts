import { describe, expect, it } from 'vitest';
import { fromPersonalIssue, fromProjectItem } from './viewer-issue';

describe('ViewerIssue adapters (#376)', () => {
  it('adapters normalize both sources', () => {
    const a = fromProjectItem({
      repo: 'board', number: 1, title: 'x', url: 'u', state: 'open',
      assignees: ['al'], status: 'In Progress',
    } as never);
    // A project item maps repo/number/title/state/assignees/status, and — with
    // no labels/projects on it — leaves those defaulted.
    expect(a).toMatchObject({ repo: 'board', number: 1, title: 'x', htmlUrl: 'u', state: 'open', assignees: ['al'], status: 'In Progress', labels: [], projects: [] });

    const b = fromPersonalIssue({
      repo: 'board', number: 2, title: 'y', htmlUrl: 'u', state: 'open',
      labels: ['bug'], type: 'bug', assignees: ['al'], projects: ['P'],
    } as never);
    // A personal (queue) issue carries labels/type/projects/assignees and — being
    // never on a board's Status field — has no `status`.
    expect(b).toMatchObject({ number: 2, type: 'bug', status: undefined, projects: ['P'], assignees: ['al'] });
    expect(b.labels).toEqual([{ name: 'bug', color: '' }]);
  });

  it('drops an empty board Status to undefined so Status-grouping stays clean', () => {
    const a = fromProjectItem({ repo: 'b', number: 3, title: 't', url: 'u', state: 'closed', assignees: [], status: '' } as never);
    expect(a.status).toBeUndefined();
  });

  it('threads customFields from ProjectItem onto ViewerIssue (#401)', () => {
    const item = {
      repo: 'board', number: 4, title: 'custom fields', url: 'u', state: 'open',
      assignees: [], status: '', customFields: { priority: ['High'] },
    } as never;
    const viewer = fromProjectItem(item);
    expect(viewer.customFields).toEqual({ priority: ['High'] });
  });

  it('fromPersonalIssue leaves customFields undefined (#401)', () => {
    const issue = {
      repo: 'board', number: 5, title: 'personal', htmlUrl: 'u',
      labels: [], type: 'chore' as const, assignees: [], projects: [],
    } as never;
    const viewer = fromPersonalIssue(issue);
    expect(viewer.customFields).toBeUndefined();
  });

  it('fromPersonalIssue carries closed state + closedAt (#407)', () => {
    const v = fromPersonalIssue({
      repo: 'board', number: 1, title: 'y', htmlUrl: 'u', state: 'closed',
      closedAt: '2026-08-01T00:00:00.000Z', labels: [], type: 'chore', assignees: [], projects: [],
    } as never);
    expect(v.state).toBe('closed');
    expect(v.closedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('fromPersonalIssue carries the aging flag, and treats its absence as not aging (#478)', () => {
    const base = { repo: 'board', number: 1, title: 'y', htmlUrl: 'u', labels: [], type: 'chore', assignees: [], projects: [] };
    expect(fromPersonalIssue({ ...base, aging: true } as never).aging).toBe(true);
    expect(fromPersonalIssue({ ...base, aging: false } as never).aging).toBe(false);
    // A board-api that predates the field: not aging, never undefined.
    expect(fromPersonalIssue(base as never).aging).toBe(false);
  });

  it('fromPersonalIssue defaults to open when state absent (#407)', () => {
    const v = fromPersonalIssue({
      repo: 'board', number: 2, title: 'y', htmlUrl: 'u', labels: [], type: 'chore', assignees: [], projects: [],
    } as never); // no state field
    expect(v.state).toBe('open');
    expect(v.closedAt).toBeUndefined();
  });

  it('both mappers carry the close reason through, and neither invents one (#1014)', () => {
    // The viewer's two close windows count on this field, and they are the only
    // close counts board-api does not filter first. A mapper that dropped it
    // would leave them counting every close with nothing red — which is why this
    // is pinned per mapper rather than through the filter.
    const item = { repo: 'b', number: 3, title: 't', url: 'u', state: 'closed', assignees: [], status: '' };
    expect(fromProjectItem({ ...item, closedAt: '2026-09-07T00:00:00.000Z', stateReason: 'not_planned' } as never).stateReason).toBe('not_planned');
    expect(fromProjectItem(item as never).stateReason).toBeUndefined();

    const row = { repo: 'board', number: 4, title: 'y', htmlUrl: 'u', labels: [], type: 'chore', assignees: [], projects: [] };
    expect(fromPersonalIssue({ ...row, state: 'closed', closedAt: '2026-09-07T00:00:00.000Z', stateReason: 'duplicate' } as never).stateReason).toBe('duplicate');
    // A board-api that predates the field, and the reason it sends for a close
    // it could not classify: both stay absent-or-null here rather than being
    // read as 'completed', because `deliveredCloseAt` is what decides what those
    // mean and a mapper deciding it first would be the second definition.
    expect(fromPersonalIssue({ ...row, state: 'closed', stateReason: null } as never).stateReason).toBeNull();
    expect(fromPersonalIssue(row as never).stateReason).toBeUndefined();
  });

  it('fromProjectItem carries closedAt (#407)', () => {
    const v = fromProjectItem({
      repo: 'b', number: 3, title: 't', url: 'u', state: 'closed',
      closedAt: '2026-07-30T00:00:00.000Z', assignees: [], status: '',
    } as never);
    expect(v.closedAt).toBe('2026-07-30T00:00:00.000Z');
  });
});
