/**
 * Nobody runs two orgs yet, so the only regression anyone would FEEL from #697
 * is one on a board serving one. This is that check, and it is deliberately not
 * a list of assertions about particular pixels: each surface is rendered twice
 * from one fixture — once with the org every board now carries, once with that
 * field stripped, which is byte-for-byte what board-api sent before #697 — and
 * the two are required to be the same markup once the org segment is taken back
 * out of the hrefs.
 *
 * So it fails on any drift the org FIELD causes: a label that gained a prefix, a
 * row the field reordered, a class it moved, a count it changed. The one
 * difference it permits is the one the human partner chose, `/{org}/projects/{n}`,
 * and it permits it only in a link target.
 *
 * What that shape cannot see is a change made unconditionally, which moves both
 * renders together — a re-sort of the Projects block, say. Order is therefore
 * asserted outright beside each render rather than left to the comparison.
 *
 * #785 deleted the Projects rollup, and with it the `BoardCard` grid that was
 * the first surface compared here. What is left is every other surface the org
 * field reaches on a single-org deployment, and the bookmark round trip below
 * them, which #785 did not move.
 *
 * The suite has no DOM, so "the same markup" is what
 * `renderToStaticMarkup` emits. That is a check on what is drawn, not on what
 * happens after a click; the click targets are covered by the round-trip below.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { FilterProject } from './api/issues';
import type { ProjectCatalogEntry, ProjectContribution, ProjectSummary } from './api/projects';
import { blockRowOf, type ProjectBlockRow } from './projects/ProjectBlock';
import { ProjectContributions, ProjectStrip } from './dashboard/ProjectContributions';
import { projectItems } from './search/search-index';
import { projectFilterNames } from './issues-viewer/FilterBar';
import { projectPickerLabel } from './issue/facet-editors';
import { projectViewerKey, projectViewerKeys } from './projects/viewer-key';
import { readViewerPrefs, writeViewerPrefs } from './issues-viewer/viewer-prefs';
import { parseRoute, routePath, type Route } from './route';

const ORG = 'acme';

/** The three boards this deployment serves, in the order the endpoint sends
 *  them — every one of them in the single configured org. */
const BOARDS: ProjectSummary[] = [
  { org: ORG, number: 7, name: 'Board hardening', url: 'https://github.com/orgs/acme/projects/7', status: 'active', open: 3, closed: 5, pct: 62, lastClosed: null, closedThisWeek: 3 },
  { org: ORG, number: 4, name: 'Go-To-Market', url: 'https://github.com/orgs/acme/projects/4', status: 'active', open: 9, closed: 1, pct: 10, lastClosed: null, closedThisWeek: 0 },
  { org: ORG, number: 12, name: 'Compliance rails', url: 'https://github.com/orgs/acme/projects/12', status: 'active', open: 0, closed: 8, pct: 100, lastClosed: null, closedThisWeek: 2 },
];

const CONTRIBUTIONS: ProjectContribution[] = [
  { org: ORG, number: 7, name: 'Board hardening', closed7d: 2, openAssigned: 1, lastClosedAtISO: '2026-08-02T00:00:00.000Z', slipping: false },
  { org: ORG, number: 4, name: 'Go-To-Market', closed7d: 0, openAssigned: 3, lastClosedAtISO: '2026-08-01T00:00:00.000Z', slipping: true },
];

/** The same payload from a board-api that predates the org field — which is
 *  also, exactly, what a single-org deployment used to send. */
const without = <T extends { org?: string }>(rows: T[]): T[] =>
  rows.map(({ org: _org, ...rest }) => rest as T);

/** The one difference this check permits: the org shell in a link target. */
const unshell = (html: string) => html.split(`/${ORG}/projects/`).join('/projects/');

/** The three boards in the order the endpoint sends them — asserted, not
 *  compared, so an unconditional re-sort cannot slip past. */
function inEndpointOrder(html: string) {
  expect(html.indexOf('Board hardening')).toBeGreaterThan(-1);
  expect(html.indexOf('Board hardening')).toBeLessThan(html.indexOf('Go-To-Market'));
  expect(html.indexOf('Go-To-Market')).toBeLessThan(html.indexOf('Compliance rails'));
}

/** Render one surface both ways and require the markup to agree. */
function agrees(surface: (boards: ProjectSummary[], contributions: ProjectContribution[]) => ReactElement) {
  const withOrg = renderToStaticMarkup(surface(BOARDS, CONTRIBUTIONS));
  const asBefore = renderToStaticMarkup(surface(without(BOARDS), without(CONTRIBUTIONS)));
  expect(unshell(withOrg)).toBe(asBefore);
  // Guards the guard: a fixture that rendered nothing would agree with anything.
  expect(withOrg).toContain('Board hardening');
  return withOrg;
}

describe('a deployment serving one org draws exactly what it drew before (#697)', () => {
  // "draws the Projects rollup grid the same, in the same order" stood here and
  // was deleted with #785: it rendered `BoardCard`, which the rollup was the only
  // page to mount, and both the component and the page are gone. Nothing about
  // the org field it compared is left unwatched — the Projects block below is the
  // same three boards from the same fixture through the same `agrees` comparison.
  it('draws the shared Projects block the same', () => {
    inEndpointOrder(agrees((boards) => (
      <ProjectStrip
        // Through the app's own mapper (#715), so this parity check cannot go on
        // asserting over a row shape the app stopped producing.
        rows={boards.map<ProjectBlockRow>((p) => blockRowOf(p, p))}
      />
    )));
  });

  it('draws Your work’s contribution strip the same, most-recently-closed first', () => {
    const html = agrees((boards, contributions) => (
      <ProjectContributions
        contributions={contributions}
        projects={boards}
        selected={[]}
        onToggle={() => {}}
      />
    ));
    expect(html.indexOf('Board hardening')).toBeLessThan(html.indexOf('Go-To-Market'));
  });

  it('offers the same rows on the filter menu, in the same order', () => {
    const projects: FilterProject[] = BOARDS.map((p) => ({ org: p.org, number: p.number, name: p.name }));
    expect(projectFilterNames(projects)).toEqual(projectFilterNames(without(projects)));
    expect(projectFilterNames(projects)).toEqual(['Board hardening', 'Go-To-Market', 'Compliance rails']);
  });

  it('names every add-to-project row exactly as it named it, with no org prefix', () => {
    const catalog: ProjectCatalogEntry[] = BOARDS.map((p, i) => ({ id: `n${i}`, org: p.org, number: p.number, title: p.name }));
    expect(catalog.map((c) => projectPickerLabel(c, catalog))).toEqual(BOARDS.map((p) => p.name));
  });

  it('lists one palette entry per board, each opening the board it names', () => {
    const items = projectItems(BOARDS);
    expect(items).toHaveLength(BOARDS.length);
    expect(items.map((i) => i.title)).toEqual(BOARDS.map((p) => p.name));
    expect(new Set(items.map((i) => i.id)).size).toBe(BOARDS.length);
    for (const [i, item] of items.entries()) {
      expect(parseRoute(routePath(item.route!))).toEqual({ tab: 'projects', org: ORG, project: BOARDS[i].number });
    }
  });
});

describe('a link a person bookmarked before #697 still opens what it opened', () => {
  it('resolves to the board, with no org for the API to narrow on', () => {
    expect(parseRoute('/projects/7')).toEqual({ tab: 'projects', project: 7 });
    // The bare `/projects` bookmark was the rollup and expected
    // `{ tab: 'projects' }`. #785 deleted that page, so it lands on Your work —
    // the fallback every path that parses but names no page gets. The BOARD
    // bookmark above is the one #697 was about and it has not moved.
    expect(parseRoute('/projects')).toEqual({ tab: 'dashboard' });
  });

  it('keeps the arrangement stored against it — the key is the one it was saved under', () => {
    expect(projectViewerKey(7)).toBe('project:7');
  });

  // The one thing on this page a person had already SET, rather than been shown.
  // The org went into the storage key, and a key that changes is an arrangement
  // silently reverted — on the only kind of deployment anyone is running. This
  // composes the two functions the board page actually uses, so it fails the
  // moment the fallback in `viewer-prefs.ts` or in `projectViewerKeys` goes.
  it('still finds the grouping and view left on this board before #697', () => {
    class MemoryStorage {
      private map = new Map<string, string>();
      getItem(k: string) { return this.map.get(k) ?? null; }
      setItem(k: string, v: string) { this.map.set(k, String(v)); }
      removeItem(k: string) { this.map.delete(k); }
    }
    const g = globalThis as unknown as { localStorage?: unknown };
    g.localStorage = new MemoryStorage();
    try {
      // What the board wrote before the org was part of its key.
      writeViewerPrefs('project:7', { group: 'assignee', view: 'list' });
      // What the board asks for now, on this single-org deployment.
      expect(readViewerPrefs(projectViewerKeys(7, ORG))).toEqual({ group: 'assignee', view: 'list' });
      // And once it is deliberately re-arranged, the write goes forward.
      writeViewerPrefs(projectViewerKeys(7, ORG), { group: 'status', view: 'board' });
      expect(readViewerPrefs(projectViewerKeys(7, ORG))).toEqual({ group: 'status', view: 'board' });
    } finally {
      delete g.localStorage;
    }
  });

  // Was written against `boardRoute(p)`, the helper the rollup's cards used to
  // turn a summary into an address; #785 deleted it with the grid. The address
  // itself is unchanged and is still produced — by `projectItems` for the command
  // palette, asserted above, and by Your work's Contributions rings — so the
  // route shape is written out here and the round trip it has to survive is the
  // same one.
  it('round-trips a board’s own address back to the same board', () => {
    for (const p of BOARDS) {
      const route: Route = { tab: 'projects', org: p.org, project: p.number };
      expect(routePath(route)).toBe(`/${ORG}/projects/${p.number}`);
      expect(parseRoute(routePath(route))).toEqual({ tab: 'projects', org: ORG, project: p.number });
    }
  });
});
