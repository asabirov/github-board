// #697 — the add-to-project picker rendered `c.title` alone over a catalog
// unioned across orgs, so two boards spelled the same were two identical rows
// and the writer picked one by coin flip. The write itself was never ambiguous
// (it goes by ProjectV2 node id); what the reader could not do was tell the two
// apart before choosing.
//
// The menu opens on interaction and the suite has no DOM, so
// the check is on the label the menu is built from.
import { describe, expect, it } from 'vitest';
import type { ProjectCatalogEntry } from '../api/projects';
import { projectPickerLabel } from './facet-editors';

const entry = (o: Partial<ProjectCatalogEntry>): ProjectCatalogEntry =>
  ({ id: 'n1', number: 3, title: 'Delivery', ...o });

describe('the add-to-project picker names which board it means (#697)', () => {
  it('qualifies both rows when two orgs spell a board the same', () => {
    const catalog = [
      entry({ id: 'a', org: 'acme', title: 'Delivery' }),
      entry({ id: 'b', org: 'globex', title: 'Delivery' }),
    ];
    expect(projectPickerLabel(catalog[0], catalog)).toBe('acme/Delivery');
    expect(projectPickerLabel(catalog[1], catalog)).toBe('globex/Delivery');
  });

  it('says the title alone when nothing else in the catalog is spelled that way', () => {
    const catalog = [
      entry({ id: 'a', org: 'acme', title: 'Platform' }),
      entry({ id: 'b', org: 'globex', title: 'Delivery' }),
    ];
    expect(projectPickerLabel(catalog[0], catalog)).toBe('Platform');
    expect(projectPickerLabel(catalog[1], catalog)).toBe('Delivery');
  });

  it('leaves a single-org catalog reading exactly as it did', () => {
    const catalog = [entry({ id: 'a', org: 'acme', title: 'Board hardening' })];
    expect(projectPickerLabel(catalog[0], catalog)).toBe('Board hardening');
  });

  it('says the title alone when the board named no org — there is nothing to qualify it with', () => {
    const catalog = [entry({ id: 'a', title: 'Delivery' }), entry({ id: 'b', title: 'Delivery' })];
    expect(projectPickerLabel(catalog[0], catalog)).toBe('Delivery');
  });
});
