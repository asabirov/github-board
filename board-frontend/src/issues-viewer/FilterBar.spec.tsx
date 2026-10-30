import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FilterBar, projectFilterNames } from './FilterBar';
import { DEFAULT_FILTERS, type ViewerFilters } from './filter-group';
import { EMPTY_FILTER_OPTIONS, type FilterProject } from '../api/issues';

// The board's test env is `node` (no DOM), so — same rationale as
// ViewerControls.spec.tsx — render to a static HTML string and assert against
// the markup. Only the field's resting state is reachable this way; the
// "Filter by" panel opens on interaction, so the sub-pane row that TURNS the
// filter on is checked in a browser, not here.

function markup(filters: Partial<ViewerFilters>) {
  return renderToStaticMarkup(
    <FilterBar
      q=""
      filters={{ ...DEFAULT_FILTERS, ...filters }}
      options={EMPTY_FILTER_OPTIONS}
      issues={[]}
      onQuery={() => {}}
      onToggle={() => {}}
      onLifecycle={() => {}}
      onToggleCustomField={() => {}}
      onTimeframe={() => {}}
      onToggleUnassigned={() => {}}
    />,
  );
}

describe('FilterBar: the unassigned dimension (#462)', () => {
  it('shows an unassigned filter as a removable token, so a tile drill-in is visible and clearable', () => {
    const html = markup({ unassigned: true });
    expect(html).toContain('unassigned');
    // A token, not just prose: it carries the shared remove control.
    expect(html).toContain('aria-label="Remove filter"');
  });

  it('says nothing when the filter is off', () => {
    expect(markup({})).not.toContain('unassigned');
  });
});

// #697 — `/api/issues/filter-options` used to de-dupe boards on the NUMBER
// alone, so of two orgs' board 3 only the first reached the menu and the other
// was a board a reader could see but could not filter to. The endpoint now
// sends both; this is the menu making use of what it is given.
//
// The pane is not driveable from here — it opens on interaction and the suite
// has no DOM — so the check is on the row set the pane is
// built from, which is the thing that was dropping a board.
describe('the project pane offers every board it is given (#697)', () => {
  const options = (projects: FilterProject[]) => ({ ...EMPTY_FILTER_OPTIONS, projects });

  it('offers a board whose number another org also holds', () => {
    expect(
      projectFilterNames(options([
        { org: 'acme', number: 3, name: 'Platform' },
        { org: 'globex', number: 3, name: 'Delivery' },
      ]).projects),
    ).toEqual(['Platform', 'Delivery']);
  });

  it('offers a shared name once — the filter narrows by name, so two rows would be one row twice', () => {
    expect(
      projectFilterNames([
        { org: 'acme', number: 3, name: 'Delivery' },
        { org: 'globex', number: 8, name: 'Delivery' },
      ]),
    ).toEqual(['Delivery']);
  });

  it('leaves a single-org menu in the order the endpoint sent it', () => {
    expect(
      projectFilterNames([
        { number: 1, name: 'Alpha' },
        { number: 2, name: 'Beta' },
      ]),
    ).toEqual(['Alpha', 'Beta']);
  });
});

// Found by driving the built SPA in a real browser, not by this suite: reading
// the board list is what `projectFilterNames` does, and moving that read out of
// the (rarely opened) Project pane and into `useCandidates` moved it onto EVERY
// render of every page hosting the viewer. `fetchFilterOptions` hands back
// `res.json()` unnarrowed, so a 200 whose body has no `projects` reaches here —
// and what used to be an empty sub-pane became an ErrorBoundary over the whole
// page.
describe('a filter-options body with no boards in it (#697)', () => {
  it('reads as no boards rather than taking the page down', () => {
    expect(projectFilterNames(undefined as unknown as FilterProject[])).toEqual([]);
  });

  it('renders the bar over such a body', () => {
    const html = renderToStaticMarkup(
      <FilterBar
        q=""
        filters={DEFAULT_FILTERS}
        options={{ labels: [], assignees: [] } as unknown as typeof EMPTY_FILTER_OPTIONS}
        issues={[]}
        onQuery={() => {}}
        onToggle={() => {}}
        onLifecycle={() => {}}
        onToggleCustomField={() => {}}
        onTimeframe={() => {}}
        onToggleUnassigned={() => {}}
      />,
    );
    expect(html).toContain('Search or filter issues');
  });
});
