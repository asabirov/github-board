import { describe, expect, it } from 'vitest';
import { columnBoardPath } from './column-link';
import { NO_PROJECT_KEY } from './filter-group';

const CATALOG = [
  { org: 'acme', number: 12, name: 'Acme Compliance' },
  { org: 'acme', number: 7, name: 'Acme Go-To-Market' },
];

describe('columnBoardPath — the board a Queue column heads (#1191)', () => {
  it('opens the board the catalog addresses under that name', () => {
    expect(columnBoardPath({ key: 'Acme Compliance' }, 'project', CATALOG))
      .toBe('/acme/projects/12');
  });

  it('leaves every other grouping alone — a label is not a board', () => {
    expect(columnBoardPath({ key: 'Acme Compliance' }, 'label', CATALOG)).toBeNull();
    expect(columnBoardPath({ key: 'board' }, 'repo', CATALOG)).toBeNull();
  });

  it('opens nothing for "No project", which is an absence and has no page', () => {
    expect(columnBoardPath({ key: NO_PROJECT_KEY }, 'project', CATALOG)).toBeNull();
  });

  // A board really called "No project" is a different stack from the catch-all,
  // by the NUL key `filter-group.ts` chose for it — so it links like any other.
  it('still opens a board that is actually named "No project"', () => {
    const catalog = [{ org: 'acme', number: 3, name: 'No project' }];
    expect(columnBoardPath({ key: 'No project' }, 'project', catalog)).toBe('/acme/projects/3');
  });

  it('opens nothing for a name the catalog does not answer for', () => {
    expect(columnBoardPath({ key: 'Rise of Acme' }, 'project', CATALOG)).toBeNull();
  });

  // #782's case, on this surface: the column holds BOTH boards' issues, so
  // there is no one page it could open.
  it('opens nothing when two orgs each hold a board of that name', () => {
    const catalog = [
      { org: 'acme', number: 3, name: 'Roadmap' },
      { org: 'globex', number: 9, name: 'Roadmap' },
    ];
    expect(columnBoardPath({ key: 'Roadmap' }, 'project', catalog)).toBeNull();
  });

  it('reads one board listed twice as one board', () => {
    const catalog = [
      { org: 'acme', number: 3, name: 'Roadmap' },
      { org: 'acme', number: 3, name: 'Roadmap' },
    ];
    expect(columnBoardPath({ key: 'Roadmap' }, 'project', catalog)).toBe('/acme/projects/3');
  });

  // The deploy-window shape `FilterProject.org` being optional describes: the
  // number alone resolves the way `/api/projects/:n` resolves it.
  it('falls back to the unqualified path for a board that named no org', () => {
    expect(columnBoardPath({ key: 'Roadmap' }, 'project', [{ number: 3, name: 'Roadmap' }]))
      .toBe('/projects/3');
  });

  it('opens nothing for a number no board address can be made of', () => {
    for (const number of [0, -1, 1.5, Number.NaN]) {
      expect(columnBoardPath({ key: 'Roadmap' }, 'project', [{ number, name: 'Roadmap' }])).toBeNull();
    }
  });

  // `fetchFilterOptions` returns `res.json()` unnarrowed, so a 200 carrying no
  // `projects` reaches here — the reason `projectFilterNames` is tolerant too.
  it('survives a catalog the endpoint never sent', () => {
    expect(columnBoardPath({ key: 'Acme Compliance' }, 'project', undefined)).toBeNull();
  });
});
