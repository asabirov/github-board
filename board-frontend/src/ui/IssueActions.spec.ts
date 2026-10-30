/**
 * The close action's session gate (#635 · #653).
 *
 * `Close issue…` performs the write `board-service` declares as
 * `@Writes('issue.close')`. Until this, the menu asked two questions — does this
 * surface allow closing, and is this issue closable — and never the third: has
 * the board's Github credential already been refused `issue.close`? So a session
 * on a refused credential was offered Close on every list row, every board card
 * and every Oldest-open row, and learnt the answer only from the failure that
 * came back after the confirm.
 */
import { describe, expect, it } from 'vitest';
import { meFixture } from '../me-fixture';
import { assigneesShown, mayAssignIssue, mayCloseIssue } from './IssueActions';

// #1009 — what a row draws once an assignment was made from it. The row keeps
// Github's answer only while the viewer still hands it the read that answer
// replaced; a read that says otherwise is newer than the answer, and wins.
describe('assigneesShown — a row after an assignment made from it (#1009)', () => {
  it('draws the read where nothing was assigned from the row', () => {
    expect(assigneesShown(['ann'], null)).toEqual(['ann']);
  });

  it('draws Github’s answer while the row is still handed the read it replaced', () => {
    // A re-read served from a cache that has not caught up yet.
    expect(assigneesShown(['ann'], { over: ['ann'], to: ['ann', 'bob'] })).toEqual(['ann', 'bob']);
  });

  it('gives way to a newer read that says otherwise', () => {
    expect(assigneesShown(['ann', 'carol'], { over: ['ann'], to: ['ann', 'bob'] })).toEqual(['ann', 'carol']);
  });

  it('reads the same set in another order or casing as unchanged', () => {
    expect(assigneesShown(['Bob', 'ann'], { over: ['ann', 'bob'], to: [] })).toEqual([]);
  });
});

const session = meFixture;

describe('mayCloseIssue — the credential half of the close gate', () => {
  it('withholds Close where the board is refused `issue.close`', () => {
    expect(
      mayCloseIssue(session({ writesEnabled: true, capabilities: { 'issue.close': 'refused' } })),
    ).toBe(false);
  });

  it('offers Close where the capability reads available', () => {
    expect(
      mayCloseIssue(session({ writesEnabled: true, capabilities: { 'issue.close': 'available' } })),
    ).toBe(true);
  });

  // Everything that is not `refused` arms the control — `use-me.ts` sets out why
  // at length. `unknown` is what every capability reads after a restart; a key
  // the map does not carry is a write nobody has attempted; and an old
  // board-service sends no map at all. None of the three is a refusal.
  it('offers Close on unknown, on a missing key, and on no map at all', () => {
    expect(
      mayCloseIssue(session({ writesEnabled: true, capabilities: { 'issue.close': 'unknown' } })),
    ).toBe(true);
    expect(
      mayCloseIssue(session({ writesEnabled: true, capabilities: { 'repo.dri': 'available' } })),
    ).toBe(true);
    expect(mayCloseIssue(session({ writesEnabled: true }))).toBe(true);
  });

  /**
   * The regression test for the trap this whole fix could have fallen into.
   *
   * `canWrite` is `writesEnabled` AND no `issue.*` capability refused, so a
   * refused `issue.labels` collapses it — and a close gate reading it would go
   * dark over a refusal that was never about closing, while `issue.close` still
   * reads available and the write would still land. `canWrite` is asserted here
   * beside the verdict because it is exactly what the wrong half would read.
   */
  it('is unmoved by an unrelated refusal (#626 — the session half is `writesEnabled`)', () => {
    const refusedLabels = session({
      writesEnabled: true,
      capabilities: { 'issue.labels': 'refused', 'issue.close': 'available' },
    });
    expect(refusedLabels.canWrite).toBe(false);
    expect(mayCloseIssue(refusedLabels)).toBe(true);
  });

  // Both halves, not either. A `board:read` actor and a switched-off
  // GITHUB_WRITE_ENABLED are refused at the guard and the envelope, and neither
  // leaves a capability refusal behind — so a gate on the map alone would draw
  // Close over a write that 403s.
  it('withholds Close from a session that does not write at all', () => {
    expect(mayCloseIssue(session({ writesEnabled: false }))).toBe(false);
    expect(
      mayCloseIssue(session({ writesEnabled: false, capabilities: { 'issue.close': 'available' } })),
    ).toBe(false);
    expect(mayCloseIssue(null)).toBe(false);
  });
});

/**
 * The assign actions' session gate (#751).
 *
 * `Assign to me` and `Assign to…` perform the write `board-service` declares as
 * `@Writes('issue.assignees')`. It is a DIFFERENT capability from `issue.close`,
 * refused independently of it, so the two verdicts are two questions: a
 * credential may close and not assign, and the menu has to be able to say so.
 */
describe('mayAssignIssue — the credential half of the assign gate', () => {
  it('withholds the assign actions where the board is refused `issue.assignees`', () => {
    expect(
      mayAssignIssue(session({ writesEnabled: true, capabilities: { 'issue.assignees': 'refused' } })),
    ).toBe(false);
  });

  it('offers them where the capability reads available', () => {
    expect(
      mayAssignIssue(session({ writesEnabled: true, capabilities: { 'issue.assignees': 'available' } })),
    ).toBe(true);
  });

  // Same three not-a-refusal states `mayCloseIssue` reads, and for the reasons
  // `use-me.ts` sets out: `unknown` is every capability after a restart, a
  // missing key is a write nobody has attempted, and an old board-service sends
  // no map at all.
  it('offers them on unknown, on a missing key, and on no map at all', () => {
    expect(
      mayAssignIssue(session({ writesEnabled: true, capabilities: { 'issue.assignees': 'unknown' } })),
    ).toBe(true);
    expect(mayAssignIssue(session({ writesEnabled: true, capabilities: { 'repo.dri': 'available' } }))).toBe(true);
    expect(mayAssignIssue(session({ writesEnabled: true }))).toBe(true);
  });

  it('withholds them from a session that does not write at all', () => {
    expect(mayAssignIssue(session({ writesEnabled: false }))).toBe(false);
    expect(
      mayAssignIssue(session({ writesEnabled: false, capabilities: { 'issue.assignees': 'available' } })),
    ).toBe(false);
    expect(mayAssignIssue(null)).toBe(false);
  });

  // The two verdicts are independent, in both directions. A gate that read
  // `canWrite`, or that reused the close verdict, would collapse them into one
  // and take a working control off over somebody else's refusal (#626 · #635).
  it('is not the close verdict wearing another name', () => {
    const noAssign = session({
      writesEnabled: true,
      capabilities: { 'issue.assignees': 'refused', 'issue.close': 'available' },
    });
    expect(mayCloseIssue(noAssign)).toBe(true);
    expect(mayAssignIssue(noAssign)).toBe(false);

    const noClose = session({
      writesEnabled: true,
      capabilities: { 'issue.close': 'refused', 'issue.assignees': 'available' },
    });
    expect(mayCloseIssue(noClose)).toBe(false);
    expect(mayAssignIssue(noClose)).toBe(true);
  });

  // `canWrite` folds in all nine issue refusals, so a gate reading it would go
  // dark over an unrelated `issue.labels` refusal while `issue.assignees` still
  // reads available and the write would still land. It is asserted here because
  // it is exactly what the wrong half would read.
  it('is unmoved by an unrelated refusal (#626 — the session half is `writesEnabled`)', () => {
    const refusedLabels = session({
      writesEnabled: true,
      capabilities: { 'issue.labels': 'refused', 'issue.assignees': 'available' },
    });
    expect(refusedLabels.canWrite).toBe(false);
    expect(mayAssignIssue(refusedLabels)).toBe(true);
  });
});

/**
 * Every mount site answers the question (#635 · #653).
 *
 * `mayClose` is required and has no default, so TypeScript already refuses a
 * mount that stays silent — but the compiler cannot say whether the answer is
 * the session's or a literal `true` typed to make the error go away. That is
 * the shape the fix has to keep out, and it is what these read for.
 *
 * The site list is DISCOVERED rather than declared, so a fifth surface mounting
 * this menu tomorrow joins the set and has to answer like the other four.
 */
const SOURCES = import.meta.glob('../**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const isSpec = (path: string) => /\.spec\.tsx?$/.test(path);
const production = Object.entries(SOURCES).filter(([p]) => !isSpec(p));
const mounts = production.filter(([, src]) => src.includes('<IssueActions')).map(([p]) => p);

describe('the close verdict reaches every menu', () => {
  // A source scan whose glob stops matching passes while proving nothing. These
  // two are that guard: the glob has to find files, and it has to find the
  // component's own module among them.
  it('reads the package sources', () => {
    expect(production.length).toBeGreaterThan(20);
    expect(Object.keys(SOURCES)).toContain('./IssueActions.tsx');
  });

  it('finds the five surfaces that mount the menu', () => {
    // The flow strip's third tile joined in #816, and is the first that is not a
    // row at all: one issue, stated as its age, with the same menu on it.
    expect(mounts.sort()).toEqual([
      '../flow-strip/OldestTile.tsx',
      '../issues-viewer/BoardView.tsx',
      '../issues-viewer/IssueSummaryRows.tsx',
      '../issues-viewer/ListView.tsx',
      './IssueListRow.tsx',
    ]);
  });

  it('every mount states a close verdict', () => {
    const silent = mounts.filter((p) => !SOURCES[p].includes('mayClose'));
    expect(silent).toEqual([]);
  });

  // A literal `true` is the answer that compiles and lies. The real verdict is
  // a boolean the container computed; a flat `false` is honest (the feedback
  // mirror never closes), a flat `true` claims a credential nobody asked.
  it('no surface hardcodes the permissive answer', () => {
    const hardcoded = production
      .filter(([, src]) => /mayClose=\{true\}|mayClose\s*=\s*true\b/.test(src))
      .map(([p]) => p);
    expect(hardcoded).toEqual([]);
  });

  // The same requirement, for the assign verdict (#751). `mayAssign` is required
  // and undefaulted for the reason `mayClose` is — an optional-with-a-default is
  // how the credential half went missing from three of four surfaces, because
  // saying nothing meant yes.
  it('every mount states an assign verdict', () => {
    const silent = mounts.filter((p) => !SOURCES[p].includes('mayAssign'));
    expect(silent).toEqual([]);
  });

  it('no surface hardcodes the permissive assign answer', () => {
    const hardcoded = production
      .filter(([, src]) => /mayAssign=\{true\}|mayAssign\s*=\s*true\b/.test(src))
      .map(([p]) => p);
    expect(hardcoded).toEqual([]);
  });

  // The two containers that own rows resolve the session once and pass it down,
  // the way `ReposPage` feeds `canSetDri(me)` through to its owner pickers —
  // rather than a per-row hook, which would be one `/api/auth/me` per row.
  it('the row containers derive the verdict from the session', () => {
    for (const container of [
      '../issues-viewer/IssuesViewer.tsx',
      // Not a loop, and here for the other half of the same rule (#816). The
      // flow strip's third tile draws ONE issue, so resolving the session on the
      // tile is already one request; what it must not do is default the verdict.
      // `dashboard/OldestOpen.tsx` was the third name on this list until #815
      // took the block off the board.
      '../flow-strip/OldestTile.tsx',
    ]) {
      expect(SOURCES[container], container).toBeTruthy();
      expect(SOURCES[container].includes('mayCloseIssue('), container).toBe(true);
    }
  });

  // #1009 — the viewer's card and row menus change assignees. The suite cannot
  // open a menu or press Save, so what is pinned here is the wiring: the verdict
  // comes from the session, both views pass it down, both ask for the several
  // picker, and both redraw their avatars from Github's answer rather than from
  // the row the viewer was handed. That the redraw happens is read in the browser.
  it('the viewer lights assign on both of its views from the session (#1009)', () => {
    expect(SOURCES['../issues-viewer/IssuesViewer.tsx']).toContain('mayAssignIssue(me)');
    for (const view of ['../issues-viewer/BoardView.tsx', '../issues-viewer/ListView.tsx']) {
      const src = SOURCES[view];
      expect(src, view).toContain('mayAssign={mayAssign}');
      expect(src, view).toContain('assignSeveral');
      expect(src, view).toContain('onAssigned={setAssigned}');
      expect(src, view).toContain('useAssignedHere(item.assignees)');
      expect(src, view).not.toMatch(/AssigneeCluster logins=\{item\.assignees\}/);
    }
  });
});
