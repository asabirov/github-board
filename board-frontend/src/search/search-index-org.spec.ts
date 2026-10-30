// The ⌘K palette listed `project:3` twice when two orgs both held a board 3 —
// one id, so `CommandPalette`'s `byId` map kept one of them and both rows went
// to the same board (#697). Kept out of `search-index.spec.ts`, which another
// lane has open right now.
import { describe, expect, it } from 'vitest';
import type { ProjectSummary } from '../api/projects';
import { projectItems } from './search-index';
import { routePath } from '../route';

const board = (o: Partial<ProjectSummary>): ProjectSummary =>
  ({ number: 3, name: 'Delivery', open: 3, closed: 9, pct: 75, ...o }) as ProjectSummary;

describe('two orgs’ board 3 are two entries in the palette (#697)', () => {
  const items = () =>
    projectItems([
      board({ org: 'acme', number: 3, name: 'Platform' }),
      board({ org: 'globex', number: 3, name: 'Delivery' }),
    ]);

  it('gives each one its own id, so neither is dropped from the index', () => {
    const [a, b] = items();
    expect(a.id).not.toBe(b.id);
  });

  it('sends each one to its own board', () => {
    const [a, b] = items();
    expect(a.route).toEqual({ tab: 'projects', org: 'acme', project: 3 });
    expect(b.route).toEqual({ tab: 'projects', org: 'globex', project: 3 });
    expect(routePath(a.route!)).toBe('/acme/projects/3');
    expect(routePath(b.route!)).toBe('/globex/projects/3');
  });

  it('leaves a board that named no org on the id and route it has always had', () => {
    const [item] = projectItems([board({ number: 7, name: 'Go-To-Market' })]);
    expect(item.id).toBe('project:7');
    expect(item.route).toEqual({ tab: 'projects', project: 7 });
    expect(routePath(item.route!)).toBe('/projects/7');
  });
});
