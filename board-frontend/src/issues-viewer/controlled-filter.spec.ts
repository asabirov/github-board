import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS } from './filter-group';
import { viewerReducer } from './use-viewer-state';
import { DEFAULT_VIEWER, decodeViewer, encodeViewer } from './viewer-url';
import { toggleValue } from './controlled-filter';

describe('toggleValue', () => {
  it('adds a value when absent', () => {
    expect(toggleValue([], 'octocat')).toEqual(['octocat']);
    expect(toggleValue(['ivan'], 'octocat')).toEqual(['ivan', 'octocat']);
  });

  it('removes a value when present', () => {
    expect(toggleValue(['ivan', 'octocat'], 'ivan')).toEqual(['octocat']);
    expect(toggleValue(['octocat'], 'octocat')).toEqual([]);
  });

  it('does not mutate the input', () => {
    const list = ['ivan'];
    toggleValue(list, 'octocat');
    expect(list).toEqual(['ivan']);
  });
});

describe('an assignee toggle is the viewer’s own, not a host’s (#461)', () => {
  // The Unit page used to own this dimension out of band through
  // `mergeControlledAssignees`, which meant a Crew press never reached `commit`
  // and so never reached the URL. The seam is deleted: a toggle now runs through
  // the same reducer every other dimension does, and lands in the URL for free.
  it('toggles through the viewer’s reducer and survives the encode/decode round-trip', () => {
    const on = viewerReducer(DEFAULT_VIEWER, { type: 'toggleFilter', dim: 'assignees', value: 'IvanRoslov' });
    expect(on.filters.assignees).toEqual(['IvanRoslov']);
    expect(encodeViewer(on)).toBe('?assignee=IvanRoslov');
    expect(decodeViewer(encodeViewer(on)).filters?.assignees).toEqual(['IvanRoslov']);

    const off = viewerReducer(on, { type: 'toggleFilter', dim: 'assignees', value: 'IvanRoslov' });
    expect(off.filters.assignees).toEqual([]);
    expect(encodeViewer(off)).toBe('');
  });

  it('leaves every other dimension where it was', () => {
    const start = { ...DEFAULT_VIEWER, filters: { ...DEFAULT_FILTERS, labels: ['bug'], projects: ['GTM'] } };
    const next = viewerReducer(start, { type: 'toggleFilter', dim: 'assignees', value: 'octocat' });
    expect(next.filters.labels).toEqual(['bug']);
    expect(next.filters.projects).toEqual(['GTM']);
    expect(start.filters.assignees).toEqual([]);
  });
});
