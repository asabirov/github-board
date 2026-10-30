import { describe, expect, it } from 'vitest';
import { menuPageName } from './page-name';
import { TAB_LABEL, type Tab } from '../route';

// The compact menu's accessible name identifies primary areas; deep pages retain their own titles.

describe('menuPageName (#608)', () => {
  it('names every place the menu itself lights', () => {
    expect(menuPageName({ tab: 'dashboard' })).toBe('My work');
    expect(menuPageName({ tab: 'team' })).toBe('Overview');
    expect(menuPageName({ tab: 'repos' })).toBe('Repos');
  });

  it('says nothing for a page that names a thing rather than a place', () => {
    // These three H1s carry the only copy of the issue's title, the repo's name
    // and the board's name. Hiding them would delete content, not chrome.
    expect(menuPageName({ tab: 'issue', issue: { owner: 'acme', repo: 'acme', number: 1 } })).toBeNull();
    expect(menuPageName({ tab: 'repo', repo: { owner: 'acme', name: 'acme' } })).toBeNull();
    expect(menuPageName({ tab: 'projects', project: 7 })).toBeNull();
    // #785 deleted the rollup, so a projects route with no board names no page
    // at all — the menu had nothing left to speak for on this tab.
    expect(menuPageName({ tab: 'projects' })).toBeNull();
  });

  // The Account and Admin sections had a case each here until #712. They are
  // areas of a panel now, which carries its own rail and its own H1 and is not
  // a page the menu button stands on at all.

  it('answers for every tab there is, so a new page cannot slip through unnamed', () => {
    // A tab added to Route without a decision here would land in this list —
    // and `undefined` (the switch falling through) is not `null`, so a missing
    // case fails rather than reading as a deliberate "no name".
    const undecided = (Object.keys(TAB_LABEL) as Tab[]).filter(
      (tab) => menuPageName({ tab }) === undefined,
    );
    expect(undecided).toEqual([]);
  });
});
