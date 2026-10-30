import { describe, expect, it } from 'vitest';
import dashboardSource from '../dashboard/Dashboard.tsx?raw';
import teamSource from '../team/TeamView.tsx?raw';
import projectsSource from '../projects/ProjectsView.tsx?raw';

/** The `now` prop as written at a call site, or null when none is passed. */
function nowProp(source: string): string | null {
  const call = source.match(/<(?:IssuesViewer|IssueQueue)[\s\S]*?\/?>/)?.[0] ?? '';
  return call.match(/\n\s*now=\{([^}]*)\}/)?.[1]?.trim() ?? null;
}

/**
 * Which lists date their timeframe filters by the PAYLOAD and which by the
 * reader (#1015).
 *
 * `viewerGroups` defaults its anchor to `Date.now()`, and every one of these
 * payloads is served from `localStorage` for up to `PAYLOAD_MAX_AGE_MS` and held
 * on screen through a failed live read. So a viewer left on the reader's clock
 * cuts "closed yesterday" out of rows that were never gathered for yesterday —
 * the same defect the grid had, on the list underneath it.
 *
 * Written against the SOURCE rather than a render because the defect is an
 * absent prop: there is no behaviour to assert on a component that was never
 * told, and a render test passes just as happily with the prop deleted. That is
 * exactly what happened — deleting it left the whole suite green.
 */
describe('every issue list dates its timeframe filters by the payload it drew (#1015)', () => {
  it('Your work anchors on the personal payload’s own snapshot', () => {
    expect(nowProp(dashboardSource)).toContain('mine.computedAt');
  });

  it('Overview anchors on the metrics payload’s own snapshot', () => {
    expect(nowProp(teamSource)).toContain('computedAt');
  });

  it('names the Project drill-in as the one that cannot yet, so it is not quietly forgotten', () => {
    // A KNOWN GAP, recorded rather than fixed: `ProjectDetail` carries no
    // timestamp at all, so there is nothing on that payload to anchor to and
    // closing this needs a new field rather than a prop. It is the one list of
    // the three whose rows carry `stateReason`, so its drill-in already agrees
    // with the counts about WHAT a close is — it can still disagree about WHEN.
    // When the field lands, this expectation flips to the other two's.
    expect(nowProp(projectsSource)).toBeNull();
  });
});
