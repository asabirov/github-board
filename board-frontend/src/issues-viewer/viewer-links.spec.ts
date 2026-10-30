import { describe, expect, it } from 'vitest';
import { viewerUrl } from './viewer-links';

describe('viewerUrl (#401)', () => {
  it('builds a shareable viewer query from a filter subset', () => {
    expect(viewerUrl({ assignees: ['me'], state: 'open' })).toBe('?assignee=me');
    expect(viewerUrl({ timeframe: 'opened-week', state: 'all', assignees: ['me'] }))
      .toBe('?assignee=me&state=all&tf=opened-week');
  });

  it('omits filters entirely when the partial is empty (pure defaults)', () => {
    expect(viewerUrl({})).toBe('');
  });

  it('accepts an explicit group dimension', () => {
    expect(viewerUrl({ assignees: ['me'] }, 'assignee')).toBe('?group=assignee&assignee=me');
  });

  it('still builds the unassigned drill-in #752 left without a caller (#753)', () => {
    // The docblock above `viewerUrl` says the Unassigned destination survives the
    // band's removal and is owed to #753. This is that claim as a check: it goes
    // red the day `?unassigned=1` stops being buildable, which is the day the
    // paragraph would quietly become a promise about nothing.
    expect(viewerUrl({ unassigned: true, state: 'open' })).toBe('?unassigned=1');
  });

  it('builds a closed-week drill-in url with assignee (#407)', () => {
    // encodeViewer appends `assignee` before `tf`, and omits the default state:'open'.
    expect(viewerUrl({ assignees: ['octocat'], timeframe: 'closed-week' })).toBe('?assignee=octocat&tf=closed-week');
  });
});

