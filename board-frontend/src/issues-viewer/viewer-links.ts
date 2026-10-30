/**
 * Build a shareable viewer `?query` from a partial filter set (#401) — the
 * Your-work summary tiles use this to drill into a pre-filtered in-board
 * viewer instead of a Github search. Pathname-agnostic: the caller prepends
 * the target path (or passes the result straight to `gotoPath`).
 *
 * It carried a second builder, `bucketViewerQuery`, for the four Overview stat
 * tiles; #752 took that band off the page and the builder went with it. What
 * became of the four drill-ins it built, decided rather than defaulted:
 *
 *  - Open (`?` — the unfiltered queue), Bugs (`?label=bug`) and Feedback
 *    (`?label=feedback`) are DROPPED, with no replacement anywhere. Each was one
 *    press away by hand from the issues list's own filter bar, which is where a
 *    reader who wants that list already goes.
 *  - Unassigned (`?unassigned=1`) is the one worth keeping, and it is the one
 *    with no destination yet: #753 is open on nothing telling anybody that
 *    issues have no owner, and that is where the read belongs. Nothing routes to
 *    it today. The parameter itself is untouched and still parses — see
 *    `viewer-url.ts` and its spec — so whatever #753 builds has a URL to open.
 */
import type { GroupDim, ViewerFilters } from './filter-group';
import { DEFAULT_VIEWER, encodeViewer } from './viewer-url';

export function viewerUrl(filters: Partial<ViewerFilters>, group?: GroupDim): string {
  return encodeViewer({
    ...DEFAULT_VIEWER,
    group: group ?? DEFAULT_VIEWER.group,
    filters: { ...DEFAULT_VIEWER.filters, ...filters },
  });
}
